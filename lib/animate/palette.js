// Building one global GIF palette, and reserving a slot for transparency.

import { quantize } from './gifenc.js';

// Magenta. Chosen so that if a reserved pixel ever leaks into the output it is
// unmistakable on sight, rather than blending in the way black or white would.
const SENTINEL = [255, 0, 255];

// rgb444 uses 4096 histogram bins instead of rgb565's 65536. Both quantize()
// and applyPalette() build a cache sized to that, per call - across hundreds of
// frames the smaller one is markedly less work and much less GC pressure.
export const PALETTE_FORMAT = 'rgb444';

/** Squared RGB distance; only used to rank, so the square root is pointless. */
function distanceSquared(a, b) {
    const dr = a[0] - b[0];
    const dg = a[1] - b[1];
    const db = a[2] - b[2];
    return dr * dr + dg * dg + db * db;
}

/**
 * Quantize a representative sample into one palette for the whole animation.
 *
 * Quantizing once rather than per frame is both a large speed win (~138ms per
 * frame) and a correctness one: a palette that shifts between frames makes
 * flat colour areas crawl.
 *
 * @param {Uint8Array} sampleRGBA Must be a full-buffer array - gifenc reads it
 *   as `new Uint32Array(rgba.buffer)` and ignores byteOffset, so a subarray
 *   view would quantize the wrong bytes.
 * @param {{maxColors?: number, reserveTransparent?: boolean}} [options]
 * @returns {{palette: number[][], transparentIndex: number|null, fallbackIndex: number}}
 */
export function buildGlobalPalette(sampleRGBA, { maxColors = 256, reserveTransparent = false } = {}) {
    if (!reserveTransparent) {
        return {
            palette: quantize(sampleRGBA, maxColors, { format: PALETTE_FORMAT }),
            transparentIndex: null,
            fallbackIndex: 0
        };
    }

    const colors = quantize(sampleRGBA, maxColors - 1, { format: PALETTE_FORMAT });

    // The sentinel goes FIRST, so the transparent index is always 0.
    // Putting it last would make its index depend on how many colours quantize
    // actually returned - it may return fewer than asked for - which is the
    // kind of thing that works on a test folder and breaks on a real one.
    const palette = [SENTINEL, ...colors];

    // Where a pixel that maps to the sentinel should go instead. Offset by one
    // because `colors` sits at palette index 1 onwards.
    let fallbackIndex = 1;
    let best = Infinity;
    for (let i = 0; i < colors.length; i++) {
        const d = distanceSquared(SENTINEL, colors[i]);
        if (d < best) {
            best = d;
            fallbackIndex = i + 1;
        }
    }

    return { palette, transparentIndex: 0, fallbackIndex };
}

/**
 * Force a reserved index out of a run of palette indices.
 *
 * This is required, not defensive. gifenc's nearest-colour search compares
 * with `>`, so a later entry at equal distance still wins - a reserved slot
 * cannot be protected by its position in the palette. Any genuinely
 * sentinel-coloured pixel would otherwise be encoded as transparent and punch
 * a hole through the frame.
 */
export function clampReserved(indices, reservedIndex, fallbackIndex) {
    if (reservedIndex === null) return indices;
    for (let i = 0; i < indices.length; i++) {
        if (indices[i] === reservedIndex) indices[i] = fallbackIndex;
    }
    return indices;
}

/**
 * Concatenate tile bitmaps into one contiguous sample buffer.
 *
 * Used when no single frame contains every colour the animation will show.
 */
export function sampleFromTiles(tiles) {
    let total = 0;
    for (const tile of tiles) total += tile.bitmap.data.length;

    const sample = new Uint8Array(total);
    let offset = 0;
    for (const tile of tiles) {
        sample.set(tile.bitmap.data, offset);
        offset += tile.bitmap.data.length;
    }
    return sample;
}
