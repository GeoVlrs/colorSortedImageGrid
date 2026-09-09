// Loading Spotify credentials from the environment or a .env file.

import fs from 'node:fs/promises';
import path from 'node:path';

import { RunError } from '../errors.js';

/**
 * Parse a .env file.
 *
 * Hand-rolled rather than using `process.loadEnvFile()` / `util.parseEnv()`,
 * which only exist from Node 20.12 while this package declares `node >=18`.
 * Branching on version would mean two code paths where only one is ever
 * exercised on a given machine, and the built-in's quoting rules differ subtly
 * from this one - so the same file could behave differently for two users.
 */
export function parseEnvFile(text) {
    const values = {};

    for (const rawLine of String(text ?? '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line === '' || line.startsWith('#')) continue;

        const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
        const separator = withoutExport.indexOf('=');
        if (separator === -1) continue;

        const key = withoutExport.slice(0, separator).trim();
        if (key === '') continue;

        let value = withoutExport.slice(separator + 1).trim();

        const quote = value[0];
        if ((quote === '"' || quote === "'") && value.at(-1) === quote && value.length >= 2) {
            value = value.slice(1, -1);
            // Escapes are only interpreted inside double quotes, matching sh.
            if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
        }

        values[key] = value;
    }

    return values;
}

/**
 * Resolve the client credentials.
 *
 * Real environment variables win over the .env file, which is the convention
 * every tool follows and is what lets a shell override or CI secret take
 * effect without editing a file.
 *
 * @returns {Promise<{clientId: string, clientSecret: string, source: string}>}
 */
export async function loadCredentials({ cwd = process.cwd(), env = process.env, envFile } = {}) {
    let clientId = env.SPOTIFY_CLIENT_ID?.trim() || '';
    let clientSecret = env.SPOTIFY_CLIENT_SECRET?.trim() || '';
    let source = 'environment';

    if (!clientId || !clientSecret) {
        const file = envFile ? path.resolve(envFile) : path.join(cwd, '.env');
        try {
            const parsed = parseEnvFile(await fs.readFile(file, 'utf8'));
            if (!clientId && parsed.SPOTIFY_CLIENT_ID) {
                clientId = parsed.SPOTIFY_CLIENT_ID.trim();
                source = file;
            }
            if (!clientSecret && parsed.SPOTIFY_CLIENT_SECRET) {
                clientSecret = parsed.SPOTIFY_CLIENT_SECRET.trim();
                source = file;
            }
        } catch {
            // No .env is a perfectly normal state; the error below covers it.
        }
    }

    if (!clientId || !clientSecret) {
        const missing = [
            clientId ? null : 'SPOTIFY_CLIENT_ID',
            clientSecret ? null : 'SPOTIFY_CLIENT_SECRET'
        ].filter(Boolean).join(' and ');

        throw new RunError(
            `Spotify credentials not found (missing ${missing}).\n` +
            `  Set them as environment variables, or in a .env file beside package.json:\n\n` +
            `    SPOTIFY_CLIENT_ID=your-client-id\n` +
            `    SPOTIFY_CLIENT_SECRET=your-client-secret\n\n` +
            `  Create an app at https://developer.spotify.com/dashboard to get them.\n` +
            `  Copy .env.example to .env to start. Keep .env out of version control -\n` +
            `  it is already listed in .gitignore.`
        );
    }

    return { clientId, clientSecret, source };
}
