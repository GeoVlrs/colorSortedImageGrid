// HTTP access to the Spotify Web API: retries, rate limiting, album search.

import { AuthError } from './auth.js';

const API_BASE = 'https://api.spotify.com/v1';

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/** A non-retryable or exhausted HTTP failure for a single request. */
export class HttpError extends Error {
    constructor(message, { status, attempts, kind } = {}) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
        this.attempts = attempts;
        this.kind = kind ?? 'http';
    }
}

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long to wait before retrying, or null to give up.
 *
 * Pure and exported so every branch can be tested exhaustively without a
 * network or a real clock.
 *
 * "No aggressive retry loops" concretely means: the server's own Retry-After
 * is obeyed rather than second-guessed; a 4xx that is not 429 is never
 * retried; and a Retry-After longer than the cap is refused outright rather
 * than parking the run for minutes - that album is reported instead, so it can
 * be re-run later.
 */
export function computeRetryDelay({
    status,
    retryAfter,
    attempt = 1,
    random = Math.random,
    maxRetryDelay = DEFAULT_MAX_RETRY_DELAY_MS
} = {}) {
    if (status === 429) {
        const requested = Number(retryAfter);
        const delay = (Number.isFinite(requested) && requested > 0 ? requested : 5) * 1000;
        if (delay > maxRetryDelay) return null;
        return Math.max(1000, delay);
    }

    // Network-level failure (no status) or a retryable server error.
    if (status === undefined || RETRYABLE_STATUSES.has(status)) {
        const base = Math.min(8000, 500 * 2 ** (attempt - 1));
        return Math.round(base * (0.75 + random() * 0.5)); // +/-25% jitter
    }

    return null;
}

/**
 * Create an API client.
 *
 * Every dependency that touches the outside world is injectable, so the whole
 * retry ladder can be tested offline with no credentials and no waiting.
 */
export function createSpotifyClient({
    tokenProvider,
    fetch: fetchImpl = globalThis.fetch,
    sleep = sleepFor,
    now = Date.now,
    random = Math.random,
    logger,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    maxRetryDelay = DEFAULT_MAX_RETRY_DELAY_MS
} = {}) {
    // Shared across all workers on purpose. If each request handled its own
    // 429, four concurrent workers would each discover the limit and sleep
    // their own timer - reacting to the rate limit without ever honouring it.
    // One worker hitting a 429 pauses the entire batch.
    let pausedUntil = 0;

    // Set when a failure makes every further request pointless (bad
    // credentials, revoked app). Without it a batch of 147 albums would fire
    // 146 more doomed requests.
    let fatal = null;

    const waitForGate = async () => {
        const remaining = pausedUntil - now();
        if (remaining > 0) await sleep(remaining);
    };

    async function request(pathname, { searchParams, retryOnAuthFailure = true } = {}) {
        if (fatal) throw fatal;

        const url = new URL(`${API_BASE}${pathname}`);
        if (searchParams) {
            for (const [key, value] of Object.entries(searchParams)) {
                if (value !== undefined && value !== null && value !== '') {
                    url.searchParams.set(key, String(value));
                }
            }
        }

        let attempt = 0;

        for (;;) {
            attempt++;
            await waitForGate();

            const token = await tokenProvider.getToken();

            let response;
            try {
                response = await fetchImpl(url.toString(), {
                    headers: { Authorization: `Bearer ${token}` },
                    // Without a timeout a hung connection never settles, the
                    // pool worker never returns, and the batch stalls forever
                    // behind a progress bar frozen short of the end.
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
                });
            } catch (error) {
                const delay = attempt >= maxAttempts
                    ? null
                    : computeRetryDelay({ attempt, random, maxRetryDelay });
                if (delay === null) {
                    throw new HttpError(
                        `Network request failed after ${attempt} attempt(s): ${error?.message ?? error}`,
                        { attempts: attempt, kind: 'network' }
                    );
                }
                logger?.detail(`network error, retrying in ${delay}ms`);
                await sleep(delay);
                continue;
            }

            logger?.detail(`${response.status} ${url.pathname}`);

            if (response.ok) return response.json();

            // A 401 mid-batch means the token expired or was revoked. Refresh
            // and replay exactly once; this does not count against the retry
            // budget, because it is a different kind of failure.
            if (response.status === 401 && retryOnAuthFailure) {
                tokenProvider.invalidate();
                return request(pathname, { searchParams, retryOnAuthFailure: false });
            }

            if (response.status === 401 || response.status === 403) {
                fatal = new AuthError(
                    response.status === 403
                        ? 'Spotify refused the request (403). The app may be restricted or the credentials revoked.'
                        : 'Spotify rejected the access token twice. Check your client ID and secret.',
                    response.status
                );
                throw fatal;
            }

            const delay = attempt >= maxAttempts
                ? null
                : computeRetryDelay({
                    status: response.status,
                    retryAfter: response.headers?.get?.('retry-after'),
                    attempt,
                    random,
                    maxRetryDelay
                });

            if (delay === null) {
                const retryAfter = response.headers?.get?.('retry-after');
                throw new HttpError(
                    response.status === 429
                        ? `Rate limited by Spotify (retry-after ${retryAfter ?? 'unknown'}s).`
                        : `Spotify returned HTTP ${response.status}.`,
                    { status: response.status, attempts: attempt, kind: response.status === 429 ? 'rate-limited' : 'http' }
                );
            }

            if (response.status === 429) {
                // Hold the shared gate so every worker waits, not just this
                // one, then loop straight back round. The wait itself happens
                // in waitForGate() at the top - sleeping here as well would
                // make the worker that tripped the limit wait twice over.
                pausedUntil = Math.max(pausedUntil, now() + delay);
                logger?.detail(`rate limited; pausing all requests for ${delay}ms`);
                continue;
            }

            await sleep(delay);
        }
    }

    return {
        request,

        /** True once a failure has made further requests pointless. */
        get aborted() {
            return Boolean(fatal);
        },

        /**
         * Search for an album, in two passes.
         *
         * The field-filtered query is tried first because it is precise. It
         * does near-exact token matching, though, so it returns nothing for
         * stylised titles, typos and unusual punctuation - in which case the
         * plain-text query is tried, which hits Spotify's own fuzzy relevance
         * index and is often better than anything we could score ourselves.
         *
         * Which pass produced the result is reported, since "the filter found
         * nothing" is useful signal when reviewing a batch.
         */
        async searchAlbums({ artist, album }, { market, limit = 20 } = {}) {
            const runQuery = async (q) => {
                const payload = await request('/search', {
                    searchParams: { q, type: 'album', limit, market }
                });
                return payload?.albums?.items ?? [];
            };

            const filtered = [
                album ? `album:${album}` : '',
                artist ? `artist:${artist}` : ''
            ].filter(Boolean).join(' ');

            const items = await runQuery(filtered);
            if (items.length > 0) return { items, queryUsed: 'filtered' };

            const plain = [artist, album].filter(Boolean).join(' ');
            return { items: await runQuery(plain), queryUsed: 'plaintext' };
        }
    };
}
