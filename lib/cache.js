// On-disk cache of per-image colour analysis.
//
// Extracting a colour means fully decoding the image, and the whole premise of
// this tool is re-running it over the same folder to try different sorts. The
// cache keys on cheap filesystem metadata (size + mtime) rather than hashing
// file contents, which is the usual trade: a hair less strict, dramatically
// cheaper.
//
// Only the colour analysis is cached. Rendering the grid still needs the real
// pixels, so the big win is on `--dryRun` and sort experimentation, not on
// repeated full renders.

import fs from 'node:fs/promises';
import path from 'node:path';

const CACHE_VERSION = 2;

export class ColorCache {
    /**
     * @param {string} cacheFile Path to the JSON cache file.
     * @param {boolean} enabled  When false, every method is a no-op.
     */
    constructor(cacheFile, enabled = true) {
        this.cacheFile = cacheFile;
        this.enabled = enabled;
        this.entries = new Map();
        this.hits = 0;
        this.misses = 0;
        this.dirty = false;
    }

    /** Read the cache file, if there is a usable one. Never throws. */
    async load() {
        if (!this.enabled) return;
        try {
            const raw = JSON.parse(await fs.readFile(this.cacheFile, 'utf8'));
            // A version mismatch (e.g. after CACHE_VERSION bumps) is treated
            // the same as a missing file, rather than trying to migrate old
            // entries whose shape we no longer control.
            if (raw?.version === CACHE_VERSION && raw.entries) {
                this.entries = new Map(Object.entries(raw.entries));
            }
        } catch {
            // A missing or corrupt cache is not an error: start empty.
        }
    }

    /**
     * Build the cache key. Anything that changes the *extracted colour* has to
     * be part of it, otherwise a `--colorMethod dominant` run would read back
     * an average colour cached by an earlier run.
     */
    static keyFor(filePath, stats, { colorMethod, greyscale, sampleSize }) {
        return [
            path.resolve(filePath),
            stats.size,
            Math.round(stats.mtimeMs),
            colorMethod,
            greyscale ? 'grey' : 'colour',
            sampleSize
        ].join('|');
    }

    /** Look up a cached colour record. Tracks hit/miss counts for the run summary. */
    get(key) {
        if (!this.enabled) return undefined;
        const hit = this.entries.get(key);
        if (hit) this.hits++;
        else this.misses++;
        return hit;
    }

    /** Record a colour result. Kept in memory; `save()` persists it. */
    set(key, colorInfo) {
        if (!this.enabled) return;
        this.entries.set(key, colorInfo);
        this.dirty = true;
    }

    /** Write the cache back, but only if something actually changed. */
    async save() {
        if (!this.enabled || !this.dirty) return;
        try {
            await fs.mkdir(path.dirname(path.resolve(this.cacheFile)), { recursive: true });
            await fs.writeFile(
                this.cacheFile,
                JSON.stringify({ version: CACHE_VERSION, entries: Object.fromEntries(this.entries) }),
                'utf8'
            );
            this.dirty = false;
        } catch {
            // Failing to persist the cache must never fail the run.
        }
    }
}
