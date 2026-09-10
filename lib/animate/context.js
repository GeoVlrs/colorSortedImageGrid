// The shared prologue every animation mode needs: discover, analyse, sort.

import path from 'node:path';
import Jimp from 'jimp';

import { RunError } from '../errors.js';
import { discoverImages } from '../files.js';
import { ColorCache } from '../cache.js';
import { processImages } from '../process.js';
import { sortImages } from '../sort.js';
import { computeGridDimensions, computeCanvasGeometry, parseColor } from '../grid.js';
import { tileSizeForWidth } from './geometry.js';

/**
 * Give every tile its border baked in.
 *
 * The fast blit path overwrites rather than blends, so it needs each tile to
 * already be the full cell size. Compositing the border once here, rather than
 * per cell per frame like `composeGrid` does, keeps that path usable.
 */
function applyBorders(items, { tileSize, borderWidth, borderColor }) {
    const borderInt = parseColor(borderColor);

    for (const item of items) {
        const framed = new Jimp(tileSize, tileSize, borderInt);
        framed.composite(item.tile, borderWidth, borderWidth);
        item.tile = framed;
    }
}

/**
 * Prepare everything the modes share.
 *
 * Tile size is derived from `--animateWidth` up front so the grid is composed
 * at output resolution. The alternative - composing large and downscaling every
 * frame - costs ~128ms per frame, roughly a third of the naive per-frame budget.
 */
export async function prepareAnimation(options, logger) {
    const filePaths = await discoverImages(options.inputDirectory, { recursive: options.recursive });
    if (filePaths.length === 0) {
        throw new RunError(`No supported images found in ${path.resolve(options.inputDirectory)}.`);
    }

    // Sizing needs the column count, which needs a count of images - use the
    // discovered count, then recompute the layout below from what actually
    // survived processing.
    const provisional = computeGridDimensions(filePaths.length, options);
    const pxPerImage = options.pxPerImage ?? tileSizeForWidth({
        numColumns: provisional.numColumns,
        targetWidth: options.animateWidth,
        padding: options.padding,
        borderWidth: options.borderWidth
    });

    const cache = new ColorCache(options.cacheFile, options.cache);
    await cache.load();

    const processed = await processImages(filePaths, { ...options, pxPerImage }, cache, logger);
    if (processed.items.length === 0) throw new RunError('Every input image failed to process.');
    await cache.save();

    const items = processed.items;
    const sorted = sortImages(items, {
        method: options.sortMethod,
        keys: options.sortKeys,
        descending: options.descending,
        bands: options.sortBands,
        secondaryKey: options.sortSecondary,
        serpentine: options.serpentine,
        hilbertBits: options.hilbertBits
    });

    const grid = computeGridDimensions(items.length, options);
    const geometry = computeCanvasGeometry({
        ...grid,
        pxPerImage: processed.pxPerImage,
        padding: options.padding,
        borderWidth: options.borderWidth
    });

    if (options.borderWidth > 0) {
        applyBorders(items, {
            tileSize: geometry.tileSize,
            borderWidth: options.borderWidth,
            borderColor: options.borderColor
        });
    }

    // GIF has no partial alpha, so a transparent canvas would dither badly.
    const background = options.background === 'transparent' ? '#ffffff' : options.background;

    return {
        filePaths,
        items,
        sorted,
        cache,
        grid,
        geometry,
        background,
        // Everything cellOriginFor needs, in one object.
        gridSpec: {
            sortOrder: options.sortOrder,
            numRows: grid.numRows,
            numColumns: grid.numColumns,
            tileSize: geometry.tileSize,
            padding: options.padding
        }
    };
}

/** Background colour as an RGBA tuple, for FrameCanvas. */
export function backgroundRGBA(background) {
    const int = parseColor(background);
    return [(int >>> 24) & 0xff, (int >>> 16) & 0xff, (int >>> 8) & 0xff, int & 0xff];
}
