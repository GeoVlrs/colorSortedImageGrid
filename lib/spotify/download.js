// Fetching the cover image and writing it to disk safely.

import fs from 'node:fs/promises';
import path from 'node:path';

import { SUPPORTED_EXTENSIONS } from '../files.js';
import { HttpError } from './client.js';

export const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const CONTENT_TYPE_EXTENSIONS = new Map([
    ['image/jpeg', '.jpg'],
    ['image/jpg', '.jpg'],
    ['image/png', '.png'],
    ['image/webp', '.webp'],
    ['image/gif', '.gif'],
    ['image/bmp', '.bmp'],
    ['image/tiff', '.tiff']
]);

/**
 * Largest available image.
 *
 * Spotify conventionally returns 640/300/64 in descending order, but that
 * ordering is not contractual, and dimensions are occasionally null - so pick
 * explicitly rather than trusting `images[0]`.
 */
export function pickLargestImage(images) {
    const list = Array.isArray(images) ? images.filter(Boolean) : [];
    if (list.length === 0) return null;

    return list.reduce((best, image) => (
        (image.width ?? 0) > (best.width ?? 0) ? image : best
    ), list[0]);
}

/**
 * Work out the file extension for downloaded bytes.
 *
 * The URL is useless here - Spotify serves from i.scdn.co with no extension at
 * all - so this trusts Content-Type first and falls back to the file's own
 * magic bytes.
 */
export function sniffImageExtension(buffer, contentType) {
    const declared = CONTENT_TYPE_EXTENSIONS.get(
        String(contentType ?? '').split(';')[0].trim().toLowerCase()
    );
    if (declared) return declared;

    const bytes = buffer ?? new Uint8Array();
    const startsWith = (...signature) =>
        signature.every((byte, index) => bytes[index] === byte);

    if (startsWith(0xff, 0xd8, 0xff)) return '.jpg';
    if (startsWith(0x89, 0x50, 0x4e, 0x47)) return '.png';
    if (startsWith(0x47, 0x49, 0x46, 0x38)) return '.gif';
    if (startsWith(0x42, 0x4d)) return '.bmp';
    if (startsWith(0x49, 0x49, 0x2a, 0x00) || startsWith(0x4d, 0x4d, 0x00, 0x2a)) return '.tiff';
    // "RIFF....WEBP"
    if (startsWith(0x52, 0x49, 0x46, 0x46) &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
        return '.webp';
    }

    return '.jpg';
}

/**
 * Download one cover image to `${destinationDirectory}/${stem}${extension}`.
 *
 * Written to a temporary file and renamed into place. Rename is atomic within
 * a volume, so an interrupted run can never leave a truncated JPEG behind for
 * the colour sorter to choke on later. (On Windows, rename replaces an
 * existing destination, so overwriting needs no separate unlink.)
 *
 * @returns {Promise<{path: string, bytes: number, extension: string}>}
 */
export async function downloadCoverArt(url, destinationDirectory, stem, {
    fetch: fetchImpl = globalThis.fetch,
    maxBytes = DEFAULT_MAX_IMAGE_BYTES
} = {}) {
    let response;
    try {
        response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
    } catch (error) {
        throw new HttpError(`Could not download the cover image: ${error?.message ?? error}`, { kind: 'network' });
    }

    if (!response.ok) {
        throw new HttpError(`Cover image download failed with HTTP ${response.status}.`, {
            status: response.status,
            kind: 'download'
        });
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (buffer.length === 0) {
        throw new HttpError('Cover image download returned an empty file.', { kind: 'download' });
    }
    if (buffer.length > maxBytes) {
        throw new HttpError(
            `Cover image is ${buffer.length} bytes, over the ${maxBytes}-byte limit.`,
            { kind: 'too-large' }
        );
    }

    const extension = sniffImageExtension(buffer, response.headers?.get?.('content-type'));

    // The grid pipeline decodes these with Jimp. Refusing a format it cannot
    // read here is what stops a .webp being written into the images folder and
    // breaking the next render instead of this one.
    if (!SUPPORTED_EXTENSIONS.includes(extension)) {
        throw new HttpError(
            `Spotify returned a ${extension} image, which the grid renderer cannot read.`,
            { kind: 'unsupported-format' }
        );
    }

    await fs.mkdir(destinationDirectory, { recursive: true });

    const finalPath = path.join(destinationDirectory, `${stem}${extension}`);
    const temporaryPath = `${finalPath}.part-${process.pid}-${Date.now()}`;

    try {
        await fs.writeFile(temporaryPath, buffer);
        await fs.rename(temporaryPath, finalPath);
    } catch (error) {
        await fs.rm(temporaryPath, { force: true });
        throw error;
    }

    return { path: finalPath, bytes: buffer.length, extension };
}
