// Animation dispatcher: pick a mode, drive its frames into the GIF sink.

import fs from 'node:fs/promises';
import path from 'node:path';

import { RunError } from '../errors.js';
import { createProgressBar, renderOutputBanner, renderSummary } from '../log.js';
import { ensureUniquePath, defaultAnimationFilename } from '../output.js';

import { ANIMATE_MODES, GIF_PIXEL_BUDGET } from './constants.js';
import { prepareAnimation } from './context.js';
import { resolveTiming } from './timing.js';
import { createGifSink } from './gifSink.js';

import * as sweep from './modes/sweep.js';
import * as build from './modes/build.js';
import * as morph from './modes/morph.js';

const MODES = {
    [ANIMATE_MODES.SWEEP]: sweep,
    [ANIMATE_MODES.BUILD]: build,
    [ANIMATE_MODES.MORPH]: morph
};

/**
 * Refuse to start something that would take minutes and produce a file nobody
 * wants, rather than letting the user discover that after the fact.
 */
function guardSize(estimate, mode) {
    const pixels = estimate.frames * estimate.width * estimate.height;
    if (pixels <= GIF_PIXEL_BUDGET) return;

    throw new RunError(
        `That would be ${estimate.frames} frames at ${estimate.width}x${estimate.height} ` +
        `(${(pixels / 1e6).toFixed(0)} megapixels of GIF), which will be slow and enormous.\n` +
        `  Try a smaller --animateWidth` +
        (mode === ANIMATE_MODES.MORPH ? ', or a shorter --morphSeconds.' : '.')
    );
}

/**
 * Render an animated GIF.
 *
 * @param {object} options Resolved CLI options.
 * @param {object} logger
 */
export async function runAnimation(options, logger) {
    const startedAt = Date.now();

    const modeId = options.animateMode ?? ANIMATE_MODES.SWEEP;
    const mode = MODES[modeId];
    if (!mode) {
        throw new RunError(
            `Unknown animation mode "${modeId}". Valid: ${Object.values(ANIMATE_MODES).join(', ')}`
        );
    }

    const timing = resolveTiming(options);
    for (const notice of timing.notices) logger.info(notice);

    const ctx = await prepareAnimation(options, logger);

    const estimate = mode.estimate(ctx, options, timing);
    guardSize(estimate, modeId);

    logger.step(`${mode.describe(ctx, options)} (${estimate.frames} frames)`);

    const { palette, transparentIndex, fallbackIndex } = mode.preparePalette(ctx, options);
    const sink = createGifSink({ palette, transparentIndex, fallbackIndex, estimate });

    const progress = createProgressBar(logger, 'frames');
    progress.start(estimate.frames);

    let written = 0;
    for await (const frame of mode.frames(ctx, options, timing, logger)) {
        sink.write(frame);
        progress.update(++written);
    }
    progress.stop();

    const { bytes, frames } = sink.end();

    const target = options.animateOutput
        ? options.animateOutput
        : await ensureUniquePath(defaultAnimationFilename({ ...options, animateMode: modeId }));

    await fs.mkdir(path.dirname(path.resolve(target)), { recursive: true });
    await fs.writeFile(target, bytes);

    renderOutputBanner(target, logger);
    logger.info(`${frames} frames, ${(bytes.length / 1024).toFixed(0)} KB`);
    renderSummary({
        processed: frames,
        skipped: 0,
        failed: 0,
        cacheHits: ctx.cache.hits,
        elapsedMs: Date.now() - startedAt
    }, logger);

    return { outputPath: path.resolve(target), frames };
}
