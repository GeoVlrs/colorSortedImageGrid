// Easing curves for tweened animation.

import { RunError } from '../errors.js';

export const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value);

export const lerp = (from, to, t) => from + (to - from) * t;

/**
 * Every easing here maps [0,1] onto [0,1] with f(0)===0 and f(1)===1.
 *
 * That is not decoration: the modes rely on it. A morph whose easing does not
 * land exactly on 1 would stop just short of the sorted layout, leaving every
 * tile a pixel or two out of place in the final frame.
 */
export const EASINGS = Object.freeze({
    linear: (t) => t,

    // The default for motion. Accelerates away and decelerates into place,
    // which reads as deliberate; linear motion reads as mechanical.
    easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),

    easeOutCubic: (t) => 1 - Math.pow(1 - t, 3),

    // Written as (1 - cos) rather than -(cos - 1) so that t=0 yields +0.
    // The negated form returns -0, which is numerically equal but not the
    // same value, and would trip any strict comparison downstream.
    easeInOutSine: (t) => (1 - Math.cos(Math.PI * t)) / 2,

    easeInOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)
});

export const EASING_NAMES = Object.freeze(Object.keys(EASINGS));

/** Look up an easing by name, failing with a listing rather than `undefined`. */
export function resolveEasing(name) {
    const easing = EASINGS[name];
    if (!easing) {
        throw new RunError(`Unknown easing "${name}". Valid: ${EASING_NAMES.join(', ')}`);
    }
    return easing;
}
