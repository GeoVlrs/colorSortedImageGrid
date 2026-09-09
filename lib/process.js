// Load images, analyse their colour, and render each one's grid tile.

import fs from 'node:fs/promises';
import path from 'node:path';
import Jimp from 'jimp';

import { mapWithConcurrency } from './pool.js';
import { ColorCache } from './cache.js';
import { buildColorInfo, extractColor, readDateTaken, COLOR_METHODS } from './color.js';
import { createProgressBar } from './log.js';

export const VISUALIZATION_MODES = Object.freeze({
    NORMAL: 'normal',
    DOMINANT: 'dominant',
    FOURBYFOUR: '4x4'
});

/**
 * Analyse every input image.
 *
 * Runs through a bounded worker pool, keeps results in input order, and
 * isolates failures: one unreadable file is reported and skipped instead of
 * aborting the whole batch the way the original's shared `reject()` did.
 */
async function analyseImages(filePaths, options, cache, logger) {
    const { colorMethod, sampleSize, greyscale, needsDateTaken, visualizationMode, pxPerImage } = options;

    // If we already know the tile size and the output is flat colour swatches,
    // a cached colour means the file never has to be decoded at all.
    const canSkipDecode =
        visualizationMode === VISUALIZATION_MODES.DOMINANT && Boolean(pxPerImage);

    const progress = createProgressBar(logger, 'analysed');
    progress.start(filePaths.length);

    const results = await mapWithConcurrency(
        filePaths,
        options.concurrency,
        async (filePath) => {
            const stats = await fs.stat(filePath);
            const cacheKey = ColorCache.keyFor(filePath, stats, { colorMethod, greyscale, sampleSize });
            const cachedColor = cache.get(cacheKey);

            let image = null;
            let colorInfo = cachedColor;

            if (!cachedColor || !canSkipDecode) {
                image = await Jimp.read(filePath);
                if (greyscale) image.greyscale();

                if (!cachedColor) {
                    colorInfo = buildColorInfo(extractColor(image, { method: colorMethod, sampleSize }));
                    cache.set(cacheKey, colorInfo);
                }
            }

            logger.detail(`analysed ${path.basename(filePath)} -> ${colorInfo.hex}`);

            return {
                filePath,
                filename: path.basename(filePath),
                colorInfo,
                dateTaken: needsDateTaken ? await readDateTaken(filePath, stats) : stats.mtimeMs,
                width: image?.bitmap.width ?? null,
                height: image?.bitmap.height ?? null,
                image
            };
        },
        (done) => progress.update(done)
    );

    progress.stop();

    const items = [];
    const failures = [];
    results.forEach((result, index) => {
        if (result.status === 'fulfilled') items.push(result.value);
        else failures.push({ filePath: filePaths[index], error: result.reason });
    });

    return { items, failures };
}

/**
 * Resolve the tile size.
 *
 * When the user did not pick one, use the smallest dimension across all inputs
 * so nothing is upscaled. Folded into a single pass over data already in
 * memory, rather than the original's separate second `forEach`.
 */
export function resolvePxPerImage(items, requested) {
    if (requested) return requested;

    let smallest = Infinity;
    for (const item of items) {
        if (item.width && item.height) smallest = Math.min(smallest, item.width, item.height);
    }
    return Number.isFinite(smallest) ? smallest : 256;
}

/** Render one image's tile, then release the full-resolution decode. */
async function renderTile(item, { visualizationMode, pxPerImage }) {
    let tile;

    switch (visualizationMode) {
        case VISUALIZATION_MODES.DOMINANT: {
            const { r, g, b } = item.colorInfo;
            tile = await Jimp.create(pxPerImage, pxPerImage, Jimp.rgbaToInt(r, g, b, 255));
            break;
        }
        case VISUALIZATION_MODES.FOURBYFOUR:
            tile = item.image
                .resize(4, 4, Jimp.RESIZE_BICUBIC)
                .resize(pxPerImage, pxPerImage, Jimp.RESIZE_NEAREST_NEIGHBOR);
            break;
        case VISUALIZATION_MODES.NORMAL:
        default:
            // `cover` crops to fill the square so no tile is letterboxed.
            tile = item.image.cover(pxPerImage, pxPerImage);
            break;
    }

    // Drop the reference to the full decode. The original kept the original
    // image, a clone, and the tile alive in one array for the whole run.
    item.image = null;
    return tile;
}

/**
 * Full pipeline: analyse, size, and render tiles for every input file.
 *
 * @returns {Promise<{items: Array, failures: Array, pxPerImage: number}>}
 */
export async function processImages(filePaths, options, cache, logger) {
    logger.step(`Analysing ${filePaths.length} image${filePaths.length === 1 ? '' : 's'}...`);
    const { items, failures } = await analyseImages(filePaths, options, cache, logger);

    for (const failure of failures) {
        logger.warn(`Skipped ${path.basename(failure.filePath)}: ${failure.error?.message ?? failure.error}`);
    }

    if (items.length === 0) {
        return { items, failures, pxPerImage: 0 };
    }

    const pxPerImage = resolvePxPerImage(items, options.pxPerImage);
    logger.info(
        options.pxPerImage
            ? `Tile size: ${pxPerImage}px (from --pxPerImage)`
            : `Tile size: ${pxPerImage}px (smallest dimension across all inputs)`
    );

    logger.step('Rendering tiles...');
    const progress = createProgressBar(logger, 'rendered');
    progress.start(items.length);

    const rendered = await mapWithConcurrency(
        items,
        options.concurrency,
        (item) => renderTile(item, { visualizationMode: options.visualizationMode, pxPerImage }),
        (done) => progress.update(done)
    );
    progress.stop();

    const usable = [];
    rendered.forEach((result, index) => {
        if (result.status === 'fulfilled') {
            items[index].tile = result.value;
            usable.push(items[index]);
        } else {
            failures.push({ filePath: items[index].filePath, error: result.reason });
            logger.warn(`Could not render ${items[index].filename}: ${result.reason?.message ?? result.reason}`);
        }
    });

    return { items: usable, failures, pxPerImage };
}

export { COLOR_METHODS };
