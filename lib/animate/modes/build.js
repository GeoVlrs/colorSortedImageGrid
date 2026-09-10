// Build mode: reveal one tile at a time until the grid is assembled.

import { FrameCanvas, unionRect } from '../canvas.js';
import { cellOriginFor } from '../geometry.js';
import { backgroundRGBA } from '../context.js';
import { buildGlobalPalette } from '../palette.js';

/** Keep any collection down to a watchable number of frames. */
export function revealPerFrameFor(count, requested) {
    if (requested) return requested;
    return Math.max(1, Math.ceil(count / 240));
}

export function estimate(ctx, options) {
    const perFrame = revealPerFrameFor(ctx.sorted.length, options.revealPerFrame);
    return {
        // One empty frame, then one per batch of revealed tiles.
        frames: 1 + Math.ceil(ctx.sorted.length / perFrame),
        width: ctx.geometry.width,
        height: ctx.geometry.height
    };
}

export function describe(ctx, options) {
    const perFrame = revealPerFrameFor(ctx.sorted.length, options.revealPerFrame);
    const tiles = perFrame === 1 ? 'one tile' : `${perFrame} tiles`;
    return `Building a ${ctx.grid.numColumns}x${ctx.grid.numRows} grid, ${tiles} per frame`;
}

/**
 * The palette must come from the FINISHED grid.
 *
 * Every pixel that will ever appear is present in the completed image, so one
 * quantize pass over it covers the whole animation. A transparent slot is
 * reserved because every frame after the first is a partial one.
 */
export function preparePalette(ctx, options) {
    const canvas = new FrameCanvas(ctx.geometry.width, ctx.geometry.height);
    canvas.fill(backgroundRGBA(ctx.background));

    ctx.sorted.forEach((item, index) => {
        const { x, y } = cellOriginFor(index, ctx.gridSpec);
        canvas.blitOpaque(item.tile.bitmap.data, item.tile.bitmap.width, item.tile.bitmap.height, x, y);
    });

    return buildGlobalPalette(canvas.data, { reserveTransparent: true });
}

/**
 * Frames: an empty canvas, then the same canvas with tiles added.
 *
 * The canvas is persistent and only the newly revealed cells are repainted, so
 * `dirty` stays one tile wide. That is what lets the GIF sink encode a few
 * thousand pixels per frame instead of the whole canvas.
 */
export async function* frames(ctx, options, timing) {
    const canvas = new FrameCanvas(ctx.geometry.width, ctx.geometry.height);
    canvas.fill(backgroundRGBA(ctx.background));

    const perFrame = revealPerFrameFor(ctx.sorted.length, options.revealPerFrame);
    let index = 0;

    // Frame 0 is the empty grid. It must be a full frame - it carries the
    // global colour table, and a fully transparent first frame renders
    // differently across decoders.
    yield {
        data: canvas.data,
        width: canvas.width,
        height: canvas.height,
        dirty: null,
        index: index++,
        holdMs: timing.delayMs,
        keyframe: true
    };

    for (let start = 0; start < ctx.sorted.length; start += perFrame) {
        const batch = ctx.sorted.slice(start, start + perFrame);
        let dirty = null;

        batch.forEach((item, offset) => {
            const { x, y } = cellOriginFor(start + offset, ctx.gridSpec);
            const { width: tw, height: th } = item.tile.bitmap;
            canvas.blitOpaque(item.tile.bitmap.data, tw, th, x, y);
            dirty = unionRect(dirty, { x, y, w: tw, h: th });
        });

        const isLast = start + perFrame >= ctx.sorted.length;

        yield {
            data: canvas.data,
            width: canvas.width,
            height: canvas.height,
            dirty,
            index: index++,
            // The finished grid lingers, and costs exactly one frame to do so
            // because the hold is expressed as a delay rather than repeats.
            holdMs: isLast ? timing.holdMs : timing.delayMs,
            keyframe: false
        };
    }
}
