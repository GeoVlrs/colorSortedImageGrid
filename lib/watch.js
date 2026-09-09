// Watch mode: re-render whenever the input folder changes.

import chokidar from 'chokidar';
import pc from 'picocolors';
import path from 'node:path';

import { isSupportedImage } from './files.js';
import { runOnce, outputPathsFor } from './run.js';

/**
 * Watch `inputDirectory` and re-run on any image add/change/removal.
 *
 * Runs are debounced (bulk copies fire a burst of events) and never overlap: a
 * change arriving mid-render queues exactly one follow-up rather than stacking.
 *
 * @returns {Promise<never>} Resolves only when the watcher is closed.
 */
export async function runWatch(options, logger) {
    const directory = path.resolve(options.inputDirectory);

    // Anything this run writes must not itself count as a change, or every
    // render would immediately trigger the next one.
    const ownOutputs = [...outputPathsFor(options), path.resolve(options.cacheFile)];
    const isOwnOutput = (filePath) => {
        const resolved = path.resolve(filePath);
        return ownOutputs.some((o) => resolved === o || resolved.startsWith(o + path.sep));
    };

    if (ownOutputs.some((o) => o === directory || o.startsWith(directory + path.sep))) {
        logger.warn(
            'The output path is inside the folder being watched. Renders are ignored as inputs, ' +
            'but older output files already in there will be picked up - consider writing elsewhere.'
        );
    }

    const render = async () => {
        try {
            await runOnce(options, logger);
        } catch (error) {
            // A failed render must not kill the watcher.
            logger.error(error?.message ?? String(error));
        }
    };

    logger.step(`Watching ${directory} for changes...`);
    await render();

    let timer = null;
    let running = false;
    let queued = false;

    const trigger = async () => {
        if (running) {
            queued = true;
            return;
        }
        running = true;
        do {
            queued = false;
            logger.info(pc.dim('\n--- change detected, re-rendering ---'));
            await render();
        } while (queued);
        running = false;
        logger.info(pc.dim(`\nWatching ${directory}... (Ctrl+C to stop)`));
    };

    const watcher = chokidar.watch(directory, {
        ignoreInitial: true,
        depth: options.recursive ? undefined : 0,
        ignored: (filePath) => isOwnOutput(filePath),
        awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }
    });

    for (const event of ['add', 'change', 'unlink']) {
        watcher.on(event, (filePath) => {
            if (!isSupportedImage(filePath) || isOwnOutput(filePath)) return;
            logger.detail(`${event}: ${path.basename(filePath)}`);
            clearTimeout(timer);
            timer = setTimeout(trigger, 400);
        });
    }

    watcher.on('error', (error) => logger.error(`Watcher error: ${error?.message ?? error}`));

    logger.info(pc.dim(`\nWatching ${directory}... (Ctrl+C to stop)`));

    return new Promise((resolve) => {
        const shutdown = async () => {
            clearTimeout(timer);
            await watcher.close();
            logger.info('\nStopped watching.');
            resolve();
        };
        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
    });
}
