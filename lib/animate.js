// Animated GIF output: sweep one setting across frames and stitch the result.
//
// The upstream project's own example GIF was assembled by hand from three
// separate runs, because Jimp can decode GIFs but cannot encode multi-frame
// ones. This automates that: pick a setting to vary, get one GIF out.
//
// Where it can, this analyses the images once and only re-sorts and
// re-composites per frame, which is what makes a sweep much cheaper than
// running the tool N times.

import Jimp from 'jimp';
import gifenc from 'gifenc';
import path from 'node:path';
import fs from 'node:fs/promises';

import { discoverImages } from './files.js';
import { ColorCache } from './cache.js';
import { processImages } from './process.js';
import { sortImages, SORT_METHODS, SORT_KEYS } from './sort.js';
import { computeGridDimensions, composeGrid } from './grid.js';
import { renderOutputBanner, renderSummary, createProgressBar } from './log.js';
import { RunError } from './run.js';

const { GIFEncoder, quantize: gifQuantize, applyPalette } = gifenc;

export const ANIMATE_DIMENSIONS = Object.freeze({
    SORT_PARAMETER: 'sortParameter',
    SORT_METHOD: 'sortMethod',
    VISUALIZATION_MODE: 'visualizationMode'
});

/** Sensible sweeps when `--animateValues` is not given. */
const DEFAULT_VALUES = {
    [ANIMATE_DIMENSIONS.SORT_PARAMETER]: ['hue', 'saturation', 'value', 'luma'],
    [ANIMATE_DIMENSIONS.SORT_METHOD]: Object.values(SORT_METHODS),
    [ANIMATE_DIMENSIONS.VISUALIZATION_MODE]: ['normal', '4x4', 'dominant']
};

function resolveFrameValues(options) {
    const values = options.animateValues
        ? String(options.animateValues).split(',').map((v) => v.trim()).filter(Boolean)
        : DEFAULT_VALUES[options.animateOver];

    if (!values?.length) throw new RunError(`Nothing to animate over for "${options.animateOver}".`);

    if (options.animateOver === ANIMATE_DIMENSIONS.SORT_PARAMETER) {
        for (const value of values) {
            if (!SORT_KEYS.includes(value)) {
                throw new RunError(`"${value}" is not a valid sort key. Valid: ${SORT_KEYS.join(', ')}`);
            }
        }
    }
    return values;
}

/** Downscale a frame so the GIF stays a sane size. */
function fitFrame(image, maxWidth) {
    if (!maxWidth || image.bitmap.width <= maxWidth) return image;
    const scale = maxWidth / image.bitmap.width;
    return image.resize(maxWidth, Math.max(1, Math.round(image.bitmap.height * scale)), Jimp.RESIZE_BILINEAR);
}

/**
 * Render every frame and encode the GIF.
 */
export async function runAnimation(options, logger) {
    const startedAt = Date.now();
    const values = resolveFrameValues(options);

    logger.step(`Animating ${values.length} frames over ${options.animateOver}: ${values.join(' -> ')}`);

    const filePaths = await discoverImages(options.inputDirectory, { recursive: options.recursive });
    if (filePaths.length === 0) {
        throw new RunError(`No supported images found in ${path.resolve(options.inputDirectory)}.`);
    }

    const cache = new ColorCache(options.cacheFile, options.cache);
    await cache.load();

    // Sweeping the visualisation mode changes the tiles themselves, so those
    // frames need a fresh render each time. Sort sweeps can reuse one analysis.
    const reanalysePerFrame = options.animateOver === ANIMATE_DIMENSIONS.VISUALIZATION_MODE;

    let sharedItems = null;
    let sharedPx = options.pxPerImage;
    if (!reanalysePerFrame) {
        const processed = await processImages(filePaths, options, cache, logger);
        if (processed.items.length === 0) throw new RunError('Every input image failed to process.');
        sharedItems = processed.items;
        sharedPx = processed.pxPerImage;
    }

    const encoder = GIFEncoder();
    const progress = createProgressBar(logger, 'frames');
    progress.start(values.length);

    let frameWidth = null;
    let frameHeight = null;

    for (let frameIndex = 0; frameIndex < values.length; frameIndex++) {
        const value = values[frameIndex];
        const frameOptions = { ...options, [options.animateOver]: value };

        if (options.animateOver === ANIMATE_DIMENSIONS.SORT_PARAMETER) {
            frameOptions.sortKeys = [value];
        }

        let items = sharedItems;
        let pxPerImage = sharedPx;

        if (reanalysePerFrame) {
            // Pin the tile size after the first frame so every frame matches.
            const processed = await processImages(
                filePaths, { ...frameOptions, pxPerImage: sharedPx }, cache, logger
            );
            if (processed.items.length === 0) throw new RunError('Every input image failed to process.');
            items = processed.items;
            pxPerImage = processed.pxPerImage;
            sharedPx = sharedPx || pxPerImage;
        }

        const sorted = sortImages(items, {
            method: frameOptions.sortMethod,
            keys: frameOptions.sortKeys,
            descending: frameOptions.descending,
            bands: frameOptions.sortBands,
            secondaryKey: frameOptions.sortSecondary,
            serpentine: frameOptions.serpentine,
            hilbertBits: frameOptions.hilbertBits
        });

        const { numRows, numColumns } = computeGridDimensions(sorted.length, options);
        const { image } = await composeGrid(sorted.map((item) => item.tile), {
            numRows,
            numColumns,
            pxPerImage,
            sortOrder: frameOptions.sortOrder,
            padding: options.padding,
            borderWidth: options.borderWidth,
            // GIF has no partial alpha, so a transparent canvas would dither
            // badly. Fall back to solid white unless the user chose otherwise.
            background: options.background === 'transparent' ? '#ffffff' : options.background,
            borderColor: options.borderColor
        });

        const frame = fitFrame(image, options.animateWidth);
        frameWidth ??= frame.bitmap.width;
        frameHeight ??= frame.bitmap.height;

        const rgba = new Uint8Array(frame.bitmap.data);
        const palette = gifQuantize(rgba, 256);
        encoder.writeFrame(applyPalette(rgba, palette), frameWidth, frameHeight, {
            palette,
            delay: options.animateDelay
        });

        logger.detail(`frame ${frameIndex + 1}/${values.length}: ${options.animateOver}=${value}`);
        progress.update(frameIndex + 1);
    }

    progress.stop();
    encoder.finish();

    const target = options.animateOutput ||
        path.join('./output', `${Date.now()}_animated_${options.animateOver}.gif`);
    await fs.mkdir(path.dirname(path.resolve(target)), { recursive: true });
    await fs.writeFile(target, Buffer.from(encoder.bytes()));
    await cache.save();

    renderOutputBanner(target, logger);
    renderSummary({
        processed: values.length,
        skipped: 0,
        failed: 0,
        cacheHits: cache.hits,
        elapsedMs: Date.now() - startedAt
    }, logger);

    return { outputPath: path.resolve(target), frames: values.length };
}
