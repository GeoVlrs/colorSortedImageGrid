// Input file discovery.

import fs from 'node:fs/promises';
import path from 'node:path';

// Every format the bundled Jimp 0.22 decoders can actually read.
//
// The original filter was `name.indexOf('.jpg') > -1 || name.indexOf('.png') > -1`,
// which is a *substring* test. Three things were wrong with that: `.jpeg` files
// were silently dropped (".jpg" is not a substring of ".jpeg"), uppercase
// `.JPG` was dropped too, and a file called `notes.jpg.txt` would have been
// picked up. Jimp already ships bmp/gif/tiff decoders, so widening the list
// costs nothing.
export const SUPPORTED_EXTENSIONS = Object.freeze([
    '.jpg', '.jpeg', '.png', '.bmp', '.tif', '.tiff', '.gif'
]);

/**
 * True extension check via `path.extname`, lower-cased.
 *
 * The original used `name.indexOf('.jpg') > -1`, a substring test: it missed
 * every `.jpeg` and uppercase file, and would false-positive on a name that
 * merely contained ".jpg" anywhere (e.g. "notes.jpg.txt").
 */
export function isSupportedImage(filePath) {
    return SUPPORTED_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

/** Raised when the input directory is missing or unreadable. */
export class InputDirectoryError extends Error {
    constructor(directory, cause) {
        super(
            cause?.code === 'ENOENT'
                ? `Input directory not found: ${directory}`
                : `Could not read input directory "${directory}": ${cause?.message ?? cause}`
        );
        this.name = 'InputDirectoryError';
        this.directory = directory;
        this.cause = cause;
    }
}

/**
 * Find every supported image in `directory`.
 *
 * Results are sorted by path so a run is reproducible regardless of what order
 * the filesystem hands entries back.
 *
 * @param {string} directory
 * @param {{recursive?: boolean}} [options]
 * @returns {Promise<string[]>} Absolute paths.
 */
export async function discoverImages(directory, { recursive = false } = {}) {
    const absoluteRoot = path.resolve(directory);
    const found = [];

    const walk = async (dir) => {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch (error) {
            // Only the top-level failure is worth surfacing as fatal; an
            // unreadable subdirectory during a recursive walk is skipped.
            if (dir === absoluteRoot) throw new InputDirectoryError(directory, error);
            return;
        }

        for (const entry of entries) {
            const entryPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (recursive) await walk(entryPath);
            } else if (entry.isFile() && isSupportedImage(entryPath)) {
                found.push(entryPath);
            }
        }
    };

    await walk(absoluteRoot);
    found.sort((a, b) => a.localeCompare(b));
    return found;
}
