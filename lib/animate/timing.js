// Frame timing, and reconciling "N fps" with what GIF can actually store.

import { RunError } from '../errors.js';
import { DEFAULT_FPS, GIF_DELAY_STEP_MS, GIF_MIN_DELAY_MS } from './constants.js';

/**
 * Round a duration onto GIF's 10ms grid.
 *
 * GIF stores delay in centiseconds and `gifenc` does `Math.round(delay / 10)`,
 * so anything finer is lost. The floor exists because browsers clamp very
 * short delays to their own default - a 5ms request would silently play at
 * ~10fps rather than the 200fps it asks for.
 */
export function quantizeGifDelay(ms) {
    const stepped = Math.round(ms / GIF_DELAY_STEP_MS) * GIF_DELAY_STEP_MS;
    return Math.max(GIF_MIN_DELAY_MS, stepped);
}

/**
 * The delay and true frame rate a GIF will actually play at.
 *
 * `snapped` is true when the request could not be represented, so the caller
 * can say so once rather than letting the user wonder why their 24fps looks
 * like 25fps.
 */
export function snapFpsForGif(fps) {
    const requestedMs = 1000 / fps;
    const delayMs = quantizeGifDelay(requestedMs);
    return {
        delayMs,
        fps: 1000 / delayMs,
        snapped: Math.abs(delayMs - requestedMs) > 1e-9
    };
}

/**
 * How many frames a hold of `holdMs` occupies at `fps`.
 *
 * Only meaningful for sinks that cannot express duration per frame. The GIF
 * sink does not use this - it writes one frame with a long delay instead,
 * which is why a 2.5s final hold costs one frame rather than sixty.
 */
export function holdToFrames(holdMs, fps) {
    return Math.max(1, Math.round((holdMs * fps) / 1000));
}

/**
 * Resolve the timing for a run, and report anything the user should know.
 *
 * @returns {{fps: number, delayMs: number, holdMs: number, notices: string[]}}
 */
export function resolveTiming(options) {
    const requestedFps = options.animateFps ?? DEFAULT_FPS;

    if (!Number.isFinite(requestedFps) || requestedFps <= 0) {
        throw new RunError(`--animateFps must be a positive number (got ${requestedFps}).`);
    }

    const { delayMs, fps, snapped } = snapFpsForGif(requestedFps);
    const notices = [];

    // A request faster than the floor cannot be honoured at all, and the
    // result would play at a speed the user never asked for.
    if (1000 / requestedFps < GIF_MIN_DELAY_MS - 1e-9) {
        throw new RunError(
            `--animateFps ${requestedFps} needs a ${(1000 / requestedFps).toFixed(1)}ms frame delay, ` +
            `below the ${GIF_MIN_DELAY_MS}ms floor GIF can play reliably.\n` +
            `  Use --animateFps ${Math.floor(1000 / GIF_MIN_DELAY_MS)} or lower.`
        );
    }

    if (snapped) {
        notices.push(
            `GIF delays are stored in 10ms steps, so ${requestedFps}fps was snapped to ` +
            `${fps.toFixed(fps % 1 ? 2 : 0)}fps (${delayMs}ms per frame).`
        );
    }

    return { fps, delayMs, holdMs: options.animateHoldMs ?? 2000, notices };
}
