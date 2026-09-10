// Animation constants.
//
// This file deliberately imports NOTHING. lib/cli.js needs ANIMATE_DIMENSIONS
// to declare its flag choices, and it used to get them from lib/animate.js -
// which meant `colorgrid --help` loaded Jimp, gifenc, culori and exifr just to
// read three strings. Keeping the constants import-free fixes that.

/** What the `sweep` mode varies between frames. */
export const ANIMATE_DIMENSIONS = Object.freeze({
    SORT_PARAMETER: 'sortParameter',
    SORT_METHOD: 'sortMethod',
    VISUALIZATION_MODE: 'visualizationMode'
});

export const ANIMATE_MODES = Object.freeze({
    /** Hard-cut between values of one setting (the original behaviour). */
    SWEEP: 'sweep',
    /** Reveal one tile at a time until the grid is assembled. */
    BUILD: 'build',
    /** Tween tiles from unsorted order into sorted order. */
    MORPH: 'morph'
});

// GIF stores frame delay in centiseconds, so everything is a multiple of 10ms.
export const GIF_DELAY_STEP_MS = 10;

// Below roughly this, browsers clamp the delay to their own default and the
// animation plays at a speed nobody asked for. Better to refuse than to lie.
export const GIF_MIN_DELAY_MS = 20;

// 25fps, not 24: 1000/25 = 40ms lands exactly on the 10ms grid, whereas 24fps
// (41.67ms) would silently snap to the same 40ms anyway.
export const DEFAULT_FPS = 25;

/**
 * Refuse to encode beyond this many frame-pixels.
 *
 * A morph at full width over a large collection can quietly reach hundreds of
 * megabytes; failing fast with a number beats discovering it minutes later.
 */
export const GIF_PIXEL_BUDGET = 3e8;
