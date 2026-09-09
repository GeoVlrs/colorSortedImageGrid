import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseEnvFile, loadCredentials } from '../lib/spotify/env.js';
import { createTokenProvider, AuthError } from '../lib/spotify/auth.js';
import { createSpotifyClient, computeRetryDelay, HttpError } from '../lib/spotify/client.js';
import { pickLargestImage, sniffImageExtension, downloadCoverArt } from '../lib/spotify/download.js';
import { RunError } from '../lib/errors.js';

const SECRET = 'super-secret-value-9876';

const jsonResponse = (body, init = {}) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init
});

/** A token provider that never touches the network. */
const stubTokenProvider = () => ({
    calls: 0,
    async getToken() { this.calls++; return 'test-token'; },
    invalidate() { this.invalidated = true; }
});

// --- .env parsing -------------------------------------------------------

test('parseEnvFile handles the shapes a real .env takes', () => {
    const parsed = parseEnvFile([
        '# a comment',
        '',
        'SPOTIFY_CLIENT_ID=abc123',
        'export SPOTIFY_CLIENT_SECRET="quoted-secret"',
        "SINGLE='single quoted'",
        'WITH_EQUALS=a=b=c',
        'SPACED  =  padded  ',
        'no_equals_line'
    ].join('\n'));

    assert.equal(parsed.SPOTIFY_CLIENT_ID, 'abc123');
    assert.equal(parsed.SPOTIFY_CLIENT_SECRET, 'quoted-secret');
    assert.equal(parsed.SINGLE, 'single quoted');
    assert.equal(parsed.WITH_EQUALS, 'a=b=c', 'only the first = separates key from value');
    assert.equal(parsed.SPACED, 'padded');
    assert.equal(parsed.no_equals_line, undefined);
});

test('escapes are interpreted only inside double quotes, as in sh', () => {
    assert.equal(parseEnvFile('A="line\\nbreak"').A, 'line\nbreak');
    assert.equal(parseEnvFile("A='line\\nbreak'").A, 'line\\nbreak');
});

test('real environment variables win over the .env file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'csig-env-'));
    try {
        await fs.writeFile(
            path.join(dir, '.env'),
            'SPOTIFY_CLIENT_ID=from-file\nSPOTIFY_CLIENT_SECRET=from-file\n'
        );

        const credentials = await loadCredentials({
            cwd: dir,
            env: { SPOTIFY_CLIENT_ID: 'from-env', SPOTIFY_CLIENT_SECRET: 'from-env' }
        });

        assert.equal(credentials.clientId, 'from-env');
        assert.equal(credentials.source, 'environment');
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('the .env file fills in what the environment lacks', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'csig-env-'));
    try {
        await fs.writeFile(path.join(dir, '.env'), 'SPOTIFY_CLIENT_SECRET=from-file\n');
        const credentials = await loadCredentials({
            cwd: dir,
            env: { SPOTIFY_CLIENT_ID: 'from-env' }
        });
        assert.equal(credentials.clientId, 'from-env');
        assert.equal(credentials.clientSecret, 'from-file');
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('missing credentials produce an actionable RunError, not a stack trace', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'csig-env-'));
    try {
        await assert.rejects(
            () => loadCredentials({ cwd: dir, env: {} }),
            (error) => {
                assert.ok(error instanceof RunError, 'must be the class index.js prints cleanly');
                assert.match(error.message, /SPOTIFY_CLIENT_ID/);
                assert.match(error.message, /developer\.spotify\.com/);
                return true;
            }
        );
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

// --- auth ---------------------------------------------------------------

test('regression: concurrent callers share one token request', async () => {
    // Several workers start in the same tick. Without single-flight each would
    // fetch its own token, wasting requests and risking a self-inflicted rate
    // limit on the accounts endpoint.
    let calls = 0;
    const provider = createTokenProvider({
        clientId: 'id',
        clientSecret: SECRET,
        fetch: async () => {
            calls++;
            await new Promise((resolve) => setTimeout(resolve, 10));
            return jsonResponse({ access_token: 'token-1', expires_in: 3600 });
        }
    });

    const tokens = await Promise.all(Array.from({ length: 6 }, () => provider.getToken()));
    assert.equal(calls, 1);
    assert.deepEqual(new Set(tokens), new Set(['token-1']));
});

test('a cached token is reused until it approaches expiry', async () => {
    let calls = 0;
    let clock = 1_000_000;
    const provider = createTokenProvider({
        clientId: 'id',
        clientSecret: SECRET,
        now: () => clock,
        fetch: async () => {
            calls++;
            return jsonResponse({ access_token: `token-${calls}`, expires_in: 3600 });
        }
    });

    assert.equal(await provider.getToken(), 'token-1');
    clock += 1000;
    assert.equal(await provider.getToken(), 'token-1', 'still fresh');
    assert.equal(calls, 1);

    // Past expiry minus the 60s safety skew.
    clock += 3600 * 1000;
    assert.equal(await provider.getToken(), 'token-2');
    assert.equal(calls, 2);
});

test('invalidate forces a refresh', async () => {
    let calls = 0;
    const provider = createTokenProvider({
        clientId: 'id',
        clientSecret: SECRET,
        fetch: async () => jsonResponse({ access_token: `token-${++calls}`, expires_in: 3600 })
    });

    await provider.getToken();
    provider.invalidate();
    await provider.getToken();
    assert.equal(calls, 2);
});

test('regression: the client secret never appears in an auth error', async () => {
    // This is the one bug in this module with consequences outside the
    // program, so it is asserted directly rather than trusted to review.
    for (const failure of [
        async () => { throw new Error(`connect failed for secret ${SECRET}`); },
        async () => jsonResponse({ error: SECRET }, { status: 401 }),
        async () => new Response('not json', { status: 200 })
    ]) {
        const provider = createTokenProvider({ clientId: 'id', clientSecret: SECRET, fetch: failure });
        await assert.rejects(() => provider.getToken(), (error) => {
            assert.ok(error instanceof AuthError);
            assert.doesNotMatch(error.message, new RegExp(SECRET), 'secret leaked into the message');
            return true;
        });
    }
});

// --- retry policy -------------------------------------------------------

test('a 429 obeys Retry-After exactly', () => {
    assert.equal(computeRetryDelay({ status: 429, retryAfter: '3' }), 3000);
    assert.equal(computeRetryDelay({ status: 429, retryAfter: '1' }), 1000);
});

test('a 429 with no header falls back to a sane wait', () => {
    assert.equal(computeRetryDelay({ status: 429 }), 5000);
    assert.equal(computeRetryDelay({ status: 429, retryAfter: 'nonsense' }), 5000);
});

test('regression: an unreasonable Retry-After gives up instead of parking the run', () => {
    // Sleeping five minutes mid-batch is worse than reporting the album and
    // letting the user re-run it.
    assert.equal(computeRetryDelay({ status: 429, retryAfter: '300' }), null);
    assert.equal(computeRetryDelay({ status: 429, retryAfter: '300', maxRetryDelay: 600_000 }), 300_000);
});

test('server errors back off exponentially, with a cap and jitter', () => {
    const noJitter = { random: () => 0.5 };
    assert.equal(computeRetryDelay({ status: 503, attempt: 1, ...noJitter }), 500);
    assert.equal(computeRetryDelay({ status: 503, attempt: 2, ...noJitter }), 1000);
    assert.equal(computeRetryDelay({ status: 500, attempt: 4, ...noJitter }), 4000);
    assert.equal(computeRetryDelay({ status: 502, attempt: 9, ...noJitter }), 8000, 'capped at 8s');

    const low = computeRetryDelay({ status: 503, attempt: 3, random: () => 0 });
    const high = computeRetryDelay({ status: 503, attempt: 3, random: () => 0.999 });
    assert.ok(low >= 1500 && low <= 2000, `jitter floor was ${low}`);
    assert.ok(high > low && high <= 3000, `jitter ceiling was ${high}`);
});

test('client errors are never retried', () => {
    assert.equal(computeRetryDelay({ status: 404 }), null);
    assert.equal(computeRetryDelay({ status: 400 }), null);
});

test('a network failure with no status is retryable', () => {
    assert.ok(computeRetryDelay({ attempt: 1, random: () => 0.5 }) > 0);
});

// --- client behaviour ---------------------------------------------------

test('a 429 is retried after the requested delay and then succeeds', async () => {
    const slept = [];
    let call = 0;

    const client = createSpotifyClient({
        tokenProvider: stubTokenProvider(),
        sleep: async (ms) => { slept.push(ms); },
        fetch: async () => {
            call++;
            if (call === 1) {
                return new Response('{}', { status: 429, headers: { 'retry-after': '2' } });
            }
            return jsonResponse({ albums: { items: [{ name: 'Kid A' }] } });
        }
    });

    const result = await client.searchAlbums({ artist: 'Radiohead', album: 'Kid A' });
    assert.equal(result.items[0].name, 'Kid A');
    assert.deepEqual(slept, [2000], 'slept exactly what the server asked for');
});

test('regression: a 429 pauses every worker, not just the one that hit it', async () => {
    // Per-request handling would have each worker sleep its own timer, which
    // reacts to the rate limit without ever honouring it.
    const slept = [];
    let clock = 0;
    let call = 0;

    const client = createSpotifyClient({
        tokenProvider: stubTokenProvider(),
        now: () => clock,
        sleep: async (ms) => { slept.push(ms); clock += ms; },
        fetch: async () => {
            call++;
            if (call === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '4' } });
            return jsonResponse({ albums: { items: [] } });
        }
    });

    // First request trips the limit and sets the shared gate.
    await client.searchAlbums({ artist: 'A', album: 'B' });
    const afterFirst = slept.length;

    // A later request must wait on that same gate rather than going straight out.
    clock = 0; // pretend a second worker arrives while the pause is still live
    await client.searchAlbums({ artist: 'C', album: 'D' });

    assert.ok(slept.length > afterFirst, 'the second request also waited on the shared gate');
});

test('a 500 is retried up to the attempt cap, then reported', async () => {
    // Exercised via request() directly: searchAlbums makes a second (plain
    // text) request on any failure, which would double-count attempts here.
    const slept = [];
    let calls = 0;

    const client = createSpotifyClient({
        tokenProvider: stubTokenProvider(),
        sleep: async (ms) => { slept.push(ms); },
        fetch: async () => { calls++; return new Response('{}', { status: 500 }); }
    });

    await assert.rejects(
        () => client.request('/search', { searchParams: { q: 'x' } }),
        (error) => {
            assert.ok(error instanceof HttpError);
            assert.equal(error.attempts, 3, 'one initial attempt plus two retries');
            return true;
        }
    );
    assert.equal(calls, 3);
    assert.equal(slept.length, 2);
});

test('a 404 fails immediately with no sleeping at all', async () => {
    const slept = [];
    let calls = 0;

    const client = createSpotifyClient({
        tokenProvider: stubTokenProvider(),
        sleep: async (ms) => { slept.push(ms); },
        fetch: async () => { calls++; return new Response('{}', { status: 404 }); }
    });

    await assert.rejects(() => client.request('/search', { searchParams: { q: 'x' } }), HttpError);
    assert.equal(calls, 1);
    assert.deepEqual(slept, []);
});

test('regression: an HTTP error carries Spotify\'s own error message', async () => {
    // "Spotify returned HTTP 400" alone is undiagnosable; the body normally
    // names the exact malformed parameter, so it must survive into the error.
    const client = createSpotifyClient({
        tokenProvider: stubTokenProvider(),
        sleep: async () => {},
        fetch: async () => new Response(
            JSON.stringify({ error: { status: 400, message: 'invalid filter value' } }),
            { status: 400 }
        )
    });

    await assert.rejects(
        () => client.request('/search', { searchParams: { q: 'x' } }),
        (error) => {
            assert.match(error.message, /invalid filter value/);
            assert.equal(error.apiMessage, 'invalid filter value');
            return true;
        }
    );
});

test('a non-JSON error body does not itself throw, and is still surfaced', async () => {
    const client = createSpotifyClient({
        tokenProvider: stubTokenProvider(),
        sleep: async () => {},
        fetch: async () => new Response('<html>Bad Gateway</html>', { status: 400 })
    });

    await assert.rejects(
        () => client.request('/search', { searchParams: { q: 'x' } }),
        /Bad Gateway/
    );
});

test('regression: a failure in the filtered search pass still tries plain text', async () => {
    // A malformed field-filter query (an unusual title, a stray colon) should
    // not cost the whole album when the plain-text pass could have found it.
    const queries = [];

    const client = createSpotifyClient({
        tokenProvider: stubTokenProvider(),
        sleep: async () => {},
        fetch: async (url) => {
            const q = new URL(url).searchParams.get('q');
            queries.push(q);
            if (q.includes('album:')) return new Response('{}', { status: 400 });
            return jsonResponse({ albums: { items: [{ name: 'Found via fallback' }] } });
        }
    });

    const result = await client.searchAlbums({ artist: 'A', album: 'B' });
    assert.equal(result.queryUsed, 'plaintext');
    assert.equal(result.items[0].name, 'Found via fallback');
    assert.equal(queries.length, 2);
});

test('regression: a fatal auth failure skips the plain-text fallback', async () => {
    // Once the client is aborted, every further request is doomed - there is
    // no point trying a second query before giving up.
    let calls = 0;
    const client = createSpotifyClient({
        tokenProvider: stubTokenProvider(),
        sleep: async () => {},
        fetch: async () => { calls++; return new Response('{}', { status: 401 }); }
    });

    await assert.rejects(() => client.searchAlbums({ artist: 'A', album: 'B' }), AuthError);
    // Two 401s (initial + one replay) for the filtered pass, and no more.
    assert.equal(calls, 2);
});

test('when both search passes fail, the more informative error wins', async () => {
    let calls = 0;
    const client = createSpotifyClient({
        tokenProvider: stubTokenProvider(),
        sleep: async () => {},
        fetch: async () => {
            calls++;
            // Filtered pass gives a reason; plain-text pass gives none.
            return calls === 1
                ? new Response(JSON.stringify({ error: { message: 'bad field filter' } }), { status: 400 })
                : new Response('{}', { status: 400 });
        }
    });

    await assert.rejects(
        () => client.searchAlbums({ artist: 'A', album: 'B' }),
        /bad field filter/
    );
});

test('a 401 refreshes the token and replays once', async () => {
    const provider = stubTokenProvider();
    let calls = 0;

    const client = createSpotifyClient({
        tokenProvider: provider,
        sleep: async () => {},
        fetch: async () => {
            calls++;
            if (calls === 1) return new Response('{}', { status: 401 });
            // Non-empty, so the plain-text fallback pass does not also fire
            // and make this look like an extra retry.
            return jsonResponse({ albums: { items: [{ name: 'Found' }] } });
        }
    });

    await client.searchAlbums({ artist: 'A', album: 'B' });
    assert.equal(provider.invalidated, true);
    assert.equal(calls, 2, 'one 401 plus one replay - the auth retry is not a retry-budget attempt');
});

test('a second 401 aborts the whole run rather than firing doomed requests', async () => {
    const client = createSpotifyClient({
        tokenProvider: stubTokenProvider(),
        sleep: async () => {},
        fetch: async () => new Response('{}', { status: 401 })
    });

    await assert.rejects(() => client.searchAlbums({ artist: 'A', album: 'B' }), AuthError);
    assert.equal(client.aborted, true);
    // Every later album fails instantly instead of making a request.
    await assert.rejects(() => client.searchAlbums({ artist: 'C', album: 'D' }), AuthError);
});

test('search falls back to plain text when the field filter finds nothing', async () => {
    const queries = [];

    const client = createSpotifyClient({
        tokenProvider: stubTokenProvider(),
        fetch: async (url) => {
            queries.push(new URL(url).searchParams.get('q'));
            return jsonResponse({
                albums: { items: queries.length === 1 ? [] : [{ name: 'Found' }] }
            });
        }
    });

    const result = await client.searchAlbums({ artist: 'Sigur Ros', album: 'Agaetis byrjun' });
    assert.equal(result.queryUsed, 'plaintext');
    assert.equal(result.items[0].name, 'Found');
    assert.match(queries[0], /album:/, 'first pass uses field filters');
    assert.doesNotMatch(queries[1], /album:/, 'second pass is plain text');
});

// --- download -----------------------------------------------------------

test('the largest image is chosen regardless of array order', () => {
    assert.equal(pickLargestImage([
        { width: 64, url: 'small' },
        { width: 640, url: 'big' },
        { width: 300, url: 'medium' }
    ]).url, 'big');

    assert.equal(pickLargestImage([{ width: null, url: 'only' }]).url, 'only');
    assert.equal(pickLargestImage([]), null);
    assert.equal(pickLargestImage(undefined), null);
});

test('the file format comes from Content-Type, then magic bytes', () => {
    assert.equal(sniffImageExtension(Buffer.from([0]), 'image/png'), '.png');
    assert.equal(sniffImageExtension(Buffer.from([0]), 'image/jpeg; charset=binary'), '.jpg');

    // The URL has no extension, so an absent Content-Type means sniffing.
    assert.equal(sniffImageExtension(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), '.jpg');
    assert.equal(sniffImageExtension(Buffer.from([0x89, 0x50, 0x4e, 0x47])), '.png');
    assert.equal(sniffImageExtension(Buffer.from([0x47, 0x49, 0x46, 0x38])), '.gif');
    assert.equal(
        sniffImageExtension(Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])),
        '.webp'
    );
    assert.equal(sniffImageExtension(Buffer.from([1, 2, 3])), '.jpg', 'falls back to jpg');
});

test('a cover downloads to a predictable path', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'csig-dl-'));
    try {
        const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
        const result = await downloadCoverArt('https://i.scdn.co/image/abc', dir, 'Radiohead - Kid A', {
            fetch: async () => new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } })
        });

        assert.equal(path.basename(result.path), 'Radiohead - Kid A.jpg');
        assert.equal(result.bytes, jpeg.length);
        assert.deepEqual(await fs.readFile(result.path), jpeg);

        const leftovers = (await fs.readdir(dir)).filter((name) => name.includes('.part-'));
        assert.deepEqual(leftovers, [], 'no temporary file left behind');
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('regression: a failed write leaves neither a partial nor a final file', async () => {
    // An interrupted download must never leave a truncated image for the
    // colour sorter to fail on later.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'csig-dl-'));
    try {
        await assert.rejects(() => downloadCoverArt('https://i.scdn.co/image/abc', dir, 'Broken', {
            fetch: async () => { throw new Error('connection reset'); }
        }), HttpError);

        assert.deepEqual(await fs.readdir(dir), []);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('regression: a format the grid cannot decode is refused', async () => {
    // Jimp 0.22 cannot read webp. Catching it here fails this download, rather
    // than silently breaking the next render.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'csig-dl-'));
    try {
        await assert.rejects(
            () => downloadCoverArt('https://i.scdn.co/image/abc', dir, 'Webp', {
                fetch: async () => new Response(Buffer.from([1, 2, 3]), {
                    status: 200, headers: { 'content-type': 'image/webp' }
                })
            }),
            (error) => {
                assert.equal(error.kind, 'unsupported-format');
                return true;
            }
        );
        assert.deepEqual(await fs.readdir(dir), []);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('empty and oversized responses are rejected', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'csig-dl-'));
    try {
        await assert.rejects(() => downloadCoverArt('u', dir, 'Empty', {
            fetch: async () => new Response(Buffer.alloc(0), { status: 200, headers: { 'content-type': 'image/jpeg' } })
        }), /empty/i);

        await assert.rejects(() => downloadCoverArt('u', dir, 'Huge', {
            maxBytes: 4,
            fetch: async () => new Response(Buffer.alloc(64), { status: 200, headers: { 'content-type': 'image/jpeg' } })
        }), /limit/i);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('an HTTP failure on the image itself is reported', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'csig-dl-'));
    try {
        await assert.rejects(() => downloadCoverArt('u', dir, 'Gone', {
            fetch: async () => new Response('', { status: 404 })
        }), /HTTP 404/);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});
