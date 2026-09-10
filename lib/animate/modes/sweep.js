// Sweep mode: hard-cut between values of one setting.
//
// This is the original animation behaviour, ported behind the frame seam. Its
// output is deliberately unchanged - same frames, same per-frame palettes, same
// filename - so the documented `--animate --animateOver sortMethod` keeps
// working exactly as before.

import Jimp from 'jimp';

import { RunError } from '../../errors.js';
import { sortImages, SORT_METHODS, SORT_KEYS } from '../../sort.js';
import { computeGridDimensions, composeGrid } from '../../grid.js';
import { processImages } from '../../process.js';
import { ANIMATE_DIMENSIONS } from '../constants.js';

/** Sensible sweeps when `--animateValues` is not given. */
const DEFAULT_VALUES = {
    [ANIMATE_DIMENSIONS.SORT_PARAMETER]: ['hue', 'saturation', 'value', 'luma'],
    [ANIMATE_DIMENSIONS.SORT_METHOD]: Object.values(SORT_METHODS),
    [ANIMATE_DIMENSIONS.VISUALIZATION_MODE]: ['normal', '4x4', 'dominant']
};

/**
 * Work out what value each frame should use.
 *
 * Sort-parameter values are validated against the real key list so a typo
 * fails fast with a helpful message instead of silently producing an empty or
 * identical frame.
 */
export function resolveFrameValues(options) {
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

/** Downscale a frame so the GIF stays a sane size. Mutates in place. */
function fitFrame(image, maxWidth) {
    if (!maxWidth || image.bitmap.width <= maxWidth) return image;
    const scale = maxWidth / image.bitmap.width;
    return image.resize(maxWidth, Math.max(1, Math.round(image.bitmap.height * scale)), Jimp.RESIZE_BILINEAR);
}

export function estimate(ctx, options) {
    return {
        frames: resolveFrameValues(options).length,
        width: Math.min(options.animateWidth, ctx.geometry.width),
        height: ctx.geometry.height
    };
}

export function describe(ctx, options) {
    const values = resolveFrameValues(options);
    return `Animating ${values.length} frames over ${options.animateOver}: ${values.join(' -> ')}`;
}

/** Sweep quantizes per frame, as it always has. */
export function preparePalette() {
    return { palette: null, transparentIndex: null, fallbackIndex: 0 };
}

export async function* frames(ctx, options, timing, logger) {
    const values = resolveFrameValues(options);

    // Sweeping the visualisation mode changes the tiles themselves, so those
    // frames need a fresh render each time. Sort sweeps reuse one analysis.
    const reanalysePerFrame = options.animateOver === ANIMATE_DIMENSIONS.VISUALIZATION_MODE;

    let sharedItems = ctx.items;
    let sharedPx = options.pxPerImage ?? ctx.geometry.tileSize - options.borderWidth * 2;

    let expected = null;

    for (let frameIndex = 0; frameIndex < values.length; frameIndex++) {
        const value = values[frameIndex];
        const frameOptions = { ...options, [options.animateOver]: value };

        if (options.animateOver === ANIMATE_DIMENSIONS.SORT_PARAMETER) {
            frameOptions.sortKeys = [value];
        }

        let items = sharedItems;

        if (reanalysePerFrame) {
            // Pin the tile size after the first frame so every frame matches.
            const processed = await processImages(
                ctx.filePaths, { ...frameOptions, pxPerImage: sharedPx }, ctx.cache, logger
            );
            if (processed.items.length === 0) throw new RunError('Every input image failed to process.');
            items = processed.items;
            sharedPx = sharedPx || processed.pxPerImage;
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

        // frameOptions, not options: a visualisation-mode sweep can change how
        // many items survive, and the grid has to follow.
        const { numRows, numColumns } = computeGridDimensions(sorted.length, frameOptions);
        const { image } = await composeGrid(sorted.map((item) => item.tile), {
            numRows,
            numColumns,
            pxPerImage: sharedPx,
            sortOrder: frameOptions.sortOrder,
            padding: options.padding,
            borderWidth: options.borderWidth,
            background: ctx.background,
            borderColor: options.borderColor
        });

        const frame = fitFrame(image, options.animateWidth);

        // Every frame must match the first, or writeFrame would receive a data
        // length that disagrees with the dimensions it is told. The old code
        // pinned the dimensions and carried on, which silently corrupted the
        // output instead of reporting it.
        expected ??= { width: frame.bitmap.width, height: frame.bitmap.height };
        if (frame.bitmap.width !== expected.width || frame.bitmap.height !== expected.height) {
            throw new RunError(
                `Frame ${frameIndex + 1} came out ${frame.bitmap.width}x${frame.bitmap.height}, ` +
                `but frame 1 was ${expected.width}x${expected.height}. ` +
                `Set --pxPerImage so every frame has the same geometry.`
            );
        }

        logger.detail(`frame ${frameIndex + 1}/${values.length}: ${options.animateOver}=${value}`);

        yield {
            // A fresh copy: gifenc needs a full-buffer Uint8Array, and Jimp's
            // bitmap.data is a Buffer that may be a view into a pool.
            data: new Uint8Array(frame.bitmap.data),
            width: frame.bitmap.width,
            height: frame.bitmap.height,
            dirty: null,
            index: frameIndex,
            holdMs: options.animateDelay,
            keyframe: true
        };
    }
}
