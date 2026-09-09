// Output grid geometry and compositing.

import Jimp from 'jimp';
import * as culori from 'culori';
import { SORT_ORDERS } from './sort.js';

const toRgb = culori.converter('rgb');

/**
 * Parse any CSS colour string into a Jimp integer colour.
 * Accepts hex, named colours, `rgb()`, `transparent`, and so on.
 */
export function parseColor(input, fallback = 0x00000000) {
    if (input === undefined || input === null || input === '') return fallback;

    const parsed = toRgb(String(input));
    if (!parsed) throw new Error(`Could not parse colour "${input}".`);

    const to255 = (v) => Math.round(Math.max(0, Math.min(1, v ?? 0)) * 255);
    return Jimp.rgbaToInt(
        to255(parsed.r),
        to255(parsed.g),
        to255(parsed.b),
        to255(parsed.alpha ?? 1)
    );
}

/**
 * Decide the grid shape.
 *
 * Both given: honoured as-is. One given: the other is derived. Neither: the
 * nearest square. (Same rules as the original, just returned rather than
 * written back onto the global argv object.)
 */
export function computeGridDimensions(imageCount, { numRows, numColumns } = {}) {
    if (numRows && numColumns) return { numRows, numColumns };
    if (numRows) return { numRows, numColumns: Math.ceil(imageCount / numRows) };
    if (numColumns) return { numRows: Math.ceil(imageCount / numColumns), numColumns };

    const side = Math.ceil(Math.sqrt(imageCount));
    return { numRows: side, numColumns: side };
}

/**
 * Where does the image at sorted position `index` belong?
 *
 * This replaces the original's nested x/y loop with its `xLimiter`/`yLimiter`
 * swap. That loop always iterated x on the outside, so it always filled
 * column-by-column no matter what `--sortOrder` said: for a square grid
 * `row-major` and `column-major` produced byte-identical output, and for a
 * non-square grid `row-major` walked past the edge of the canvas. Deriving the
 * cell directly from the index is correct for both orders by construction.
 */
export function placementFor(index, { sortOrder, numRows, numColumns }) {
    if (sortOrder === SORT_ORDERS.ROW_MAJOR) {
        return { row: Math.floor(index / numColumns), col: index % numColumns };
    }
    return { row: index % numRows, col: Math.floor(index / numRows) };
}

/**
 * Pixel geometry of the finished canvas.
 *
 * `padding` is applied as an outer margin *and* as the gap between tiles;
 * `borderWidth` frames each tile individually.
 */
export function computeCanvasGeometry({ numRows, numColumns, pxPerImage, padding, borderWidth }) {
    const tileSize = pxPerImage + borderWidth * 2;
    return {
        tileSize,
        width: padding + numColumns * (tileSize + padding),
        height: padding + numRows * (tileSize + padding)
    };
}

/**
 * Composite the sorted images into one grid image.
 *
 * @param {Array<import('jimp')>} images Pre-resized, in final sorted order.
 * @returns {Promise<{image: import('jimp'), placed: number, dropped: number}>}
 */
export async function composeGrid(images, options) {
    const {
        numRows,
        numColumns,
        pxPerImage,
        sortOrder = SORT_ORDERS.COLUMN_MAJOR,
        padding = 0,
        borderWidth = 0,
        background = 'transparent',
        borderColor = '#000000'
    } = options;

    const backgroundInt = parseColor(background);
    const { tileSize, width, height } = computeCanvasGeometry({
        numRows, numColumns, pxPerImage, padding, borderWidth
    });

    const canvas = await Jimp.create(width, height, backgroundInt);

    // One reusable tile for the border frame; compositing reads the source
    // without mutating it, so the same instance serves every cell.
    const borderTile = borderWidth > 0
        ? await Jimp.create(tileSize, tileSize, parseColor(borderColor))
        : null;

    const capacity = numRows * numColumns;
    let placed = 0;

    for (let index = 0; index < images.length; index++) {
        if (index >= capacity) break; // grid is full; caller reports the surplus

        const { row, col } = placementFor(index, { sortOrder, numRows, numColumns });
        const tileX = padding + col * (tileSize + padding);
        const tileY = padding + row * (tileSize + padding);

        if (borderTile) canvas.composite(borderTile, tileX, tileY);
        canvas.composite(images[index], tileX + borderWidth, tileY + borderWidth);
        placed++;
    }

    return { image: canvas, placed, dropped: Math.max(0, images.length - capacity) };
}
