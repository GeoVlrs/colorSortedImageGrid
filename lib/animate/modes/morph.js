// Morph mode: tiles travel from unsorted order into sorted order.

import { FrameCanvas } from '../canvas.js';
import { cellOriginFor, morphPlan, morphPositionsAt } from '../geometry.js';
import { backgroundRGBA } from '../context.js';
import { buildGlobalPalette } from '../palette.js';
import { resolveEasing } from '../easing.js';

const DEFAULT_EASING = 'easeInOutCubic';

export function tweenFrameCount(options, fps) {
    return Math.max(2, Math.round((options.morphSeconds ?? 3) * fps));
}

export function estimate(ctx, options, timing) {
    // One opening hold on the unsorted layout, then the tween. The closing
    // hold rides on the final tween frame rather than adding one.
    return {
        frames: tweenFrameCount(options, timing.fps) + 1,
        width: ctx.geometry.width,
        height: ctx.geometry.height
    };
}

export function describe(ctx, options) {
    // For a numeric sort the keys are the meaningful description ("hue"), not
    // the method name, which is just "numeric".
    const target = options.sortMethod === 'numeric'
        ? options.sortKeys.join(' then ')
        : options.sortMethod;
    return `Morphing ${ctx.items.length} tiles from filename order into ${target} order`;
}

/**
 * Sample the palette from the sorted layout.
 *
 * Position does not introduce colours - the same tiles appear in every frame,
 * only in different places - so the final arrangement contains everything.
 * No transparent slot: every frame here is a full repaint.
 */
export function preparePalette(ctx) {
    const canvas = new FrameCanvas(ctx.geometry.width, ctx.geometry.height);
    canvas.fill(backgroundRGBA(ctx.background));

    ctx.sorted.forEach((item, index) => {
        const { x, y } = cellOriginFor(index, ctx.gridSpec);
        canvas.blitOpaque(item.tile.bitmap.data, item.tile.bitmap.width, item.tile.bitmap.height, x, y);
    });

    return buildGlobalPalette(canvas.data, { reserveTransparent: false });
}

/** Hold, tween, hold. Every tile moves, so every frame is a full repaint. */
export async function* frames(ctx, options, timing) {
    const canvas = new FrameCanvas(ctx.geometry.width, ctx.geometry.height);
    const background = backgroundRGBA(ctx.background);
    const easing = resolveEasing(options.animateEasing ?? DEFAULT_EASING);
    const stagger = options.morphStagger ?? 0.3;

    const plan = morphPlan(ctx.items, ctx.sorted, ctx.gridSpec);
    const tweenFrames = tweenFrameCount(options, timing.fps);

    let index = 0;

    const paint = (T) => {
        canvas.fill(background);
        for (const { entry, x, y } of morphPositionsAt(plan, T, { stagger, easing })) {
            const { width: tw, height: th } = entry.item.tile.bitmap;
            canvas.blitOpaque(entry.item.tile.bitmap.data, tw, th, x, y);
        }
    };

    const emit = (holdMs) => ({
        data: canvas.data,
        width: canvas.width,
        height: canvas.height,
        dirty: null,
        index: index++,
        holdMs,
        keyframe: false
    });

    // Settle on the unsorted layout before anything moves, so the viewer sees
    // what it started from.
    paint(0);
    yield emit(options.morphHoldMs ?? 700);

    // Skip T=0, already emitted above.
    for (let step = 1; step <= tweenFrames; step++) {
        paint(step / tweenFrames);
        // The last tween frame IS the sorted layout, so it carries the hold
        // rather than emitting a duplicate frame for it.
        yield emit(step === tweenFrames ? timing.holdMs : timing.delayMs);
    }
}
