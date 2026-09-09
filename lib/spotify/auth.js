// Spotify Client Credentials flow.

const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';

// Refresh this far before nominal expiry, so a request that starts just under
// the wire cannot arrive just over it.
const EXPIRY_SKEW_MS = 60_000;

/**
 * Authentication failure.
 *
 * The message is always constructed here from the status code, never passed
 * through from an underlying error. That is deliberate: an error thrown by
 * fetch or Headers can carry request details, and this is the one place in the
 * program holding a credential, so a leak here would be the bug with
 * consequences outside the process.
 */
export class AuthError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'AuthError';
        this.status = status;
    }
}

/**
 * Create a token provider for the app-only (Client Credentials) flow.
 *
 * The token lives in memory for the lifetime of the process and is never
 * written to disk: it is a live bearer credential granting the app's full
 * access for up to an hour, and it costs a single ~200ms request to obtain, so
 * persisting it would buy nothing measurable while creating a file that could
 * be committed, read by another user, or go confusingly stale.
 *
 * @param {object} options
 * @param {string} options.clientId
 * @param {string} options.clientSecret
 * @param {Function} [options.fetch] Injectable for testing without a network.
 * @param {Function} [options.now]   Injectable so expiry can be tested without waiting.
 */
export function createTokenProvider({
    clientId,
    clientSecret,
    fetch: fetchImpl = globalThis.fetch,
    now = Date.now
} = {}) {
    let token = null;
    let expiresAt = 0;
    let inFlight = null;

    const requestToken = async () => {
        // Basic auth, so the secret travels in a header and can never end up
        // in a URL, a log line, or the review report.
        const authorization = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

        let response;
        try {
            response = await fetchImpl(TOKEN_ENDPOINT, {
                method: 'POST',
                headers: {
                    Authorization: `Basic ${authorization}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
                signal: AbortSignal.timeout(20_000)
            });
        } catch {
            // Note the bare catch: the underlying error is deliberately not
            // interpolated, in case it echoes the request.
            throw new AuthError('Could not reach the Spotify token endpoint. Check your connection.');
        }

        if (!response.ok) {
            const detail = response.status === 400 || response.status === 401
                ? 'Spotify rejected the client ID/secret. Check the values in your .env file.'
                : `Spotify token request failed with HTTP ${response.status}.`;
            throw new AuthError(detail, response.status);
        }

        let payload;
        try {
            payload = await response.json();
        } catch {
            throw new AuthError('Spotify returned an unreadable token response.', response.status);
        }

        if (!payload?.access_token) {
            throw new AuthError('Spotify returned a token response with no access token.', response.status);
        }

        token = payload.access_token;
        expiresAt = now() + (Number(payload.expires_in) || 3600) * 1000 - EXPIRY_SKEW_MS;
        return token;
    };

    return {
        /**
         * Current access token, fetching or refreshing as needed.
         *
         * Single-flight: with several workers running, a cold start has all of
         * them calling this in the same tick. Sharing the in-flight promise
         * means one token request instead of one per worker - which also
         * avoids self-inflicting a rate limit on the accounts endpoint.
         */
        async getToken() {
            if (token && now() < expiresAt) return token;
            if (inFlight) return inFlight;

            inFlight = requestToken().finally(() => { inFlight = null; });
            return inFlight;
        },

        /** Drop the cached token, forcing a refresh on the next call. */
        invalidate() {
            token = null;
            expiresAt = 0;
        },

        /** Exposed for tests and --verbose diagnostics. Never the token itself. */
        get expiresAt() {
            return expiresAt;
        }
    };
}
