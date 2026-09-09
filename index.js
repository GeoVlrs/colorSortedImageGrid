#!/usr/bin/env node
//
// colorSortedImageGrid - sort a folder of images by colour and composite them
// into a single grid image, and fetch the album cover art that fills it.
//
// The grid tool is originally by Zach Fox
// (https://github.com/zfox23/colorSortedImageGrid); this version reorganises
// the original single file into lib/ modules and adds several sorting
// strategies, an analysis cache, animation, watch and interactive modes, plus
// a Spotify cover-art fetcher. Run `node index.js --help` for the full surface.

import { buildParser, resolveOptions, resolveFetchOptions, isFetchCommand } from './lib/cli.js';
import { createLogger } from './lib/log.js';
import { runOnce, RunError } from './lib/run.js';
import { runAnimation } from './lib/animate.js';
import { runWatch } from './lib/watch.js';
import { InputDirectoryError } from './lib/files.js';
import { AuthError } from './lib/spotify/auth.js';

async function main() {
    const args = buildParser().parseSync();
    const logger = createLogger({ quiet: args.quiet, verbose: args.verbose });

    // Lazily imported so the grid path never pays to load the fetcher - the
    // same pattern the interactive mode already uses.
    if (isFetchCommand(args)) {
        const { runFetch } = await import('./lib/spotify/fetch.js');
        return runFetch(resolveFetchOptions(args), logger);
    }

    let options = resolveOptions(args);

    if (options.interactive) {
        const { runInteractive } = await import('./lib/interactive.js');
        options = await runInteractive(options);
    }

    if (options.animate) return runAnimation(options, logger);
    if (options.watch) return runWatch(options, logger);
    return runOnce(options, logger);
}

main().catch((error) => {
    // Problems the user can act on get a clean message; anything else is a bug
    // and keeps its stack. Either way the exit code is non-zero, which the
    // original never set even when it failed.
    const logger = createLogger({});

    if (error instanceof RunError || error instanceof InputDirectoryError || error instanceof AuthError) {
        logger.error(error.message);
    } else {
        logger.error(`Unexpected failure: ${error?.message ?? error}`);
        if (process.env.DEBUG) console.error(error);
        else logger.error('Re-run with DEBUG=1 for the full stack trace.');
    }

    process.exitCode = 1;
});
