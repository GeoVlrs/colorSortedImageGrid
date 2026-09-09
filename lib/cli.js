// Command-line surface.

import os from 'node:os';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { SORT_METHODS, SORT_ORDERS, SORT_KEYS, parseSortKeys } from './sort.js';
import { VISUALIZATION_MODES } from './process.js';
import { COLOR_METHODS } from './color.js';
import { ANIMATE_DIMENSIONS } from './animate.js';
import { DEFAULT_FILENAME_TEMPLATE } from './spotify/naming.js';
import { DEFAULT_MIN_CONFIDENCE } from './spotify/match.js';

const DEFAULT_CONCURRENCY = Math.min(8, Math.max(1, os.cpus().length));

// The API is the bottleneck when fetching, not the local CPU, so this is
// deliberately a different (and lower) default from the grid's.
const DEFAULT_FETCH_CONCURRENCY = 4;

/**
 * Every grid option, exactly as before this file grew a second command.
 *
 * These live in the default command's builder rather than globally so that
 * `.strict()` applies per command: `--sortMethod` is rejected under `fetch`,
 * and `--artist` is rejected here. The `.check()` at the end in particular
 * *must* stay local - it reads `args.sortParameter` unconditionally, so as a
 * global check it would throw the moment anyone ran `colorgrid fetch`.
 */
function buildGridCommand(y) {
    return y
        .option('inputDirectory', {
            alias: 'i', type: 'string', default: './images',
            describe: 'Folder containing the input images'
        })
        .option('recursive', {
            alias: 'R', type: 'boolean', default: false,
            describe: 'Also search subfolders of the input directory'
        })
        .option('outputFilename', {
            alias: 'o', type: 'string',
            describe: 'Output path (must include the extension). Use "files" to write each sorted image separately into ./output/'
        })
        .option('exportPalette', {
            type: 'string',
            describe: 'Also write the extracted colours to this path (.json or .css)'
        })
        .group(['inputDirectory', 'recursive', 'outputFilename', 'exportPalette'], 'Input and output:')

        .option('numRows', { alias: 'r', type: 'number', describe: 'Rows in the output grid' })
        .option('numColumns', { alias: 'c', type: 'number', describe: 'Columns in the output grid' })
        .option('pxPerImage', {
            alias: 'px', type: 'number',
            describe: 'Pixels per side for each cell. Defaults to the smallest input dimension. Setting it explicitly also lowers peak memory'
        })
        .option('sortOrder', {
            alias: 's', type: 'string', choices: Object.values(SORT_ORDERS), default: SORT_ORDERS.COLUMN_MAJOR,
            describe: 'Direction the sorted images are laid into the grid'
        })
        .option('padding', { type: 'number', default: 0, describe: 'Gap between cells and around the grid, in pixels' })
        .option('borderWidth', { type: 'number', default: 0, describe: 'Border drawn around each cell, in pixels' })
        .option('borderColor', { type: 'string', default: '#000000', describe: 'Any CSS colour' })
        .option('background', { type: 'string', default: 'transparent', describe: 'Canvas background: any CSS colour, or "transparent"' })
        .group(['numRows', 'numColumns', 'pxPerImage', 'sortOrder', 'padding', 'borderWidth', 'borderColor', 'background'], 'Grid and canvas:')

        .option('sortMethod', {
            type: 'string', choices: Object.values(SORT_METHODS), default: SORT_METHODS.NUMERIC,
            describe: 'numeric: plain sort on the key(s). banded: group into colour bands. hilbert: space-filling curve through Lab. perceptual: nearest-neighbour walk'
        })
        .option('sortParameter', {
            alias: 'p', type: 'string', default: 'hue',
            describe: `Sort key, or comma-separated keys for tiebreaks (${SORT_KEYS.join(', ')})`
        })
        .option('sortDescending', { alias: 'd', type: 'boolean', default: false, describe: 'Reverse the final order' })
        .option('sortBands', { type: 'number', default: 12, describe: 'Number of bands for --sortMethod banded' })
        .option('sortSecondary', { type: 'string', default: 'luma', describe: 'Key sorted within each band' })
        .option('serpentine', { type: 'boolean', default: false, describe: 'Alternate band direction so the gradient flows continuously' })
        .option('hilbertBits', { type: 'number', default: 8, describe: 'Precision per axis for --sortMethod hilbert' })
        .group(['sortMethod', 'sortParameter', 'sortDescending', 'sortBands', 'sortSecondary', 'serpentine', 'hilbertBits'], 'Sorting:')

        .option('visualizationMode', {
            alias: 'v', type: 'string', choices: Object.values(VISUALIZATION_MODES), default: VISUALIZATION_MODES.NORMAL,
            describe: 'What each cell shows'
        })
        .option('colorMethod', {
            type: 'string', choices: Object.values(COLOR_METHODS), default: COLOR_METHODS.AVERAGE,
            describe: 'average: one blended colour per image. dominant: median-cut quantisation, the colour covering the most area'
        })
        .option('sampleSize', { type: 'number', default: 64, describe: 'Sampling resolution for --colorMethod dominant' })
        .option('greyscale', { alias: 'g', type: 'boolean', default: false, describe: 'Convert inputs to greyscale before analysis' })
        .group(['visualizationMode', 'colorMethod', 'sampleSize', 'greyscale'], 'Colour:')

        .option('interactive', { type: 'boolean', default: false, describe: 'Choose options through prompts' })
        .option('watch', { alias: 'w', type: 'boolean', default: false, describe: 'Re-render whenever the input folder changes' })
        .option('dryRun', { type: 'boolean', default: false, describe: 'Report the plan and exit without writing' })
        .group(['interactive', 'watch', 'dryRun'], 'Modes:')

        .option('animate', { type: 'boolean', default: false, describe: 'Render an animated GIF that sweeps one setting' })
        .option('animateOver', {
            type: 'string', choices: Object.values(ANIMATE_DIMENSIONS), default: ANIMATE_DIMENSIONS.SORT_PARAMETER,
            describe: 'Which setting varies between frames'
        })
        .option('animateValues', { type: 'string', describe: 'Comma-separated values to step through (defaults to all valid ones)' })
        .option('animateDelay', { type: 'number', default: 600, describe: 'Milliseconds per frame' })
        .option('animateWidth', { type: 'number', default: 900, describe: 'Maximum GIF width in pixels' })
        .option('animateOutput', { type: 'string', describe: 'Output path for the GIF' })
        .group(['animate', 'animateOver', 'animateValues', 'animateDelay', 'animateWidth', 'animateOutput'], 'Animation:')

        .option('concurrency', { type: 'number', default: DEFAULT_CONCURRENCY, describe: 'Images processed in parallel' })
        .option('cache', { type: 'boolean', default: true, describe: 'Reuse colour analysis between runs (--no-cache to disable)' })
        .option('cacheFile', { type: 'string', default: './.colorgrid-cache.json', describe: 'Where the analysis cache lives' })
        .option('preview', { type: 'boolean', default: true, describe: 'Print the sorted colours as a terminal strip (--no-preview to disable)' })
        .group(['concurrency', 'cache', 'cacheFile', 'preview'], 'Performance and output:')

        .example('$0', 'Sort ./images by hue into a square grid')
        .example('$0 -i ./photos --sortMethod hilbert', 'Smoothest overall gradient (Lab space-filling curve)')
        .example('$0 --sortMethod banded --sortBands 12', 'Band by hue, brightness within each band')
        .example('$0 -v dominant --colorMethod dominant', 'Flat swatches of the true dominant colour')
        .example('$0 --dryRun', 'Show the plan without writing anything')

        .check((args) => {
            parseSortKeys(args.sortParameter); // throws with a helpful message
            if (!SORT_KEYS.includes(args.sortSecondary)) {
                throw new Error(`--sortSecondary must be one of: ${SORT_KEYS.join(', ')}`);
            }
            for (const key of ['numRows', 'numColumns', 'pxPerImage', 'sortBands', 'concurrency', 'sampleSize', 'animateWidth']) {
                if (args[key] !== undefined && (!Number.isFinite(args[key]) || args[key] <= 0)) {
                    throw new Error(`--${key} must be a positive number (got ${args[key]}).`);
                }
            }
            if (args.padding < 0 || args.borderWidth < 0) {
                throw new Error('--padding and --borderWidth cannot be negative.');
            }
            if (args.hilbertBits < 1 || args.hilbertBits > 10) {
                throw new Error('--hilbertBits must be between 1 and 10.');
            }
            return true;
        });
}

/** Options for `colorgrid fetch`. */
function buildFetchCommand(y) {
    return y
        .option('artist', { alias: 'a', type: 'string', describe: 'Artist name' })
        .option('album', { alias: 'A', type: 'string', describe: 'Album name' })
        .option('input', {
            alias: 'f', type: 'string',
            describe: 'File of albums: CSV, JSON, or lines of "Artist - Album"'
        })
        .option('format', {
            type: 'string', choices: ['auto', 'csv', 'txt', 'json'], default: 'auto',
            describe: 'Force an input format instead of detecting it'
        })
        .group(['artist', 'album', 'input', 'format'], 'What to fetch:')

        .option('destination', {
            alias: 'o', type: 'string', default: './images',
            describe: 'Where the covers are written'
        })
        .option('filenameTemplate', {
            type: 'string', default: DEFAULT_FILENAME_TEMPLATE,
            describe: 'Filename pattern. Tokens: {artist} {album} {year} {albumId}'
        })
        .option('force', { type: 'boolean', default: false, describe: 'Re-download even if the cover is already there' })
        .option('onDuplicate', {
            type: 'string', choices: ['warn', 'skip', 'ignore'], default: 'warn',
            describe: 'What to do when an album looks like one already on disk'
        })
        .option('aliases', {
            type: 'string',
            describe: 'JSON map of album title to an existing filename, for hand-abbreviated names'
        })
        .group(['destination', 'filenameTemplate', 'force', 'onDuplicate', 'aliases'], 'Output:')

        .option('minConfidence', {
            type: 'number', default: DEFAULT_MIN_CONFIDENCE,
            describe: 'Below this match score nothing is downloaded and the album is reported instead'
        })
        .option('market', { type: 'string', describe: 'ISO country code. Unset by default, since it can hide valid albums' })
        .option('searchLimit', { type: 'number', default: 20, describe: 'Candidates to consider per album' })
        .group(['minConfidence', 'market', 'searchLimit'], 'Matching:')

        .option('report', {
            type: 'string', default: './output/spotify-fetch-report.json',
            describe: 'Where the review report is written (.json or .md)'
        })
        .option('dryRun', { type: 'boolean', default: false, describe: 'Search and match, but download nothing' })
        .option('concurrency', { type: 'number', default: DEFAULT_FETCH_CONCURRENCY, describe: 'Albums fetched in parallel' })
        .option('maxRetryDelay', { type: 'number', default: 60000, describe: 'Give up rather than waiting longer than this after a 429, in ms' })
        .option('maxImageBytes', { type: 'number', default: 10485760, describe: 'Reject images larger than this' })
        .option('envFile', { type: 'string', describe: 'Path to the .env holding the Spotify credentials' })
        .group(['report', 'dryRun', 'concurrency', 'maxRetryDelay', 'maxImageBytes', 'envFile'], 'Run:')

        .example('$0 fetch -a "Radiohead" -A "Kid A"', 'Fetch one cover')
        .example('$0 fetch -f albums.csv --dryRun', 'Check what a batch matches before downloading')
        .example('$0 fetch -f albums.csv', 'Fetch a whole list')
        .example('$0 fetch -a "Tool" -f discography.txt', 'One artist, album titles one per line')

        .check((args) => {
            if (!args.album && !args.input) {
                throw new Error('Give either --album (with --artist) or --input <file>.');
            }
            if (args.minConfidence < 0 || args.minConfidence > 1) {
                throw new Error('--minConfidence must be between 0 and 1.');
            }
            for (const key of ['concurrency', 'searchLimit', 'maxImageBytes', 'maxRetryDelay']) {
                if (!Number.isFinite(args[key]) || args[key] <= 0) {
                    throw new Error(`--${key} must be a positive number (got ${args[key]}).`);
                }
            }
            if (args.concurrency > 8) {
                throw new Error('--concurrency above 8 is not polite to the Spotify API.');
            }
            return true;
        });
}

/**
 * @param {string[]} argv
 * @param {{exitOnError?: boolean}} [options] Set `exitOnError: false` to make
 *   validation failures throw instead of printing help and exiting, which is
 *   what tests (and any embedding code) need.
 */
export function buildParser(argv = hideBin(process.argv), { exitOnError = true } = {}) {
    const parser = yargs(argv)
        .scriptName('colorgrid')
        .usage(
            `$0 [options]\n$0 fetch [options]\n\n` +
            `Sort a folder of images by colour into one grid image.\n` +
            `The fetch command downloads the album covers that fill it.`
        )
        .command('$0', 'Sort images into a colour-sorted grid (default)', buildGridCommand)
        .command('fetch', 'Download album cover art from Spotify', buildFetchCommand)

        // Global, so a config file or --quiet works for either command.
        .option('quiet', { alias: 'q', type: 'boolean', default: false, describe: 'Only errors and the output path' })
        .option('verbose', { type: 'boolean', default: false, describe: 'Per-item detail and the full analysis table' })
        .config('config', 'Read options from a JSON file (flags still win)')

        .epilog(
            'Tips:\n' +
            '  --sortMethod hilbert usually gives the smoothest looking grid.\n' +
            '  colorgrid fetch --dryRun checks a batch matches before downloading.\n' +
            '  Repeat runs reuse the colour cache, so trying different sorts is fast.\n\n' +
            'Grid tool originally by Zach Fox: https://github.com/zfox23/colorSortedImageGrid'
        )
        .wrap(Math.min(110, process.stdout.columns || 110))
        .strict()
        .help()
        .alias('help', 'h')
        .version(false);

    if (!exitOnError) {
        parser.exitProcess(false).fail((message, error) => {
            throw error ?? new Error(message);
        });
    }

    return parser;
}

/** True when the parsed arguments asked for the fetch command. */
export function isFetchCommand(args) {
    return args._?.[0] === 'fetch';
}

/** Flatten parsed argv into the single options object the grid pipeline uses. */
export function resolveOptions(args) {
    const sortKeys = parseSortKeys(args.sortParameter);

    return {
        inputDirectory: args.inputDirectory,
        recursive: args.recursive,
        outputFilename: args.outputFilename,
        exportPalette: args.exportPalette,

        numRows: args.numRows,
        numColumns: args.numColumns,
        pxPerImage: args.pxPerImage,
        sortOrder: args.sortOrder,
        padding: args.padding,
        borderWidth: args.borderWidth,
        borderColor: args.borderColor,
        background: args.background,

        sortMethod: args.sortMethod,
        sortKeys,
        descending: args.sortDescending,
        sortBands: args.sortBands,
        sortSecondary: args.sortSecondary,
        serpentine: args.serpentine,
        hilbertBits: args.hilbertBits,
        needsDateTaken: sortKeys.includes('dateTaken'),

        visualizationMode: args.visualizationMode,
        colorMethod: args.colorMethod,
        sampleSize: args.sampleSize,
        greyscale: args.greyscale,

        interactive: args.interactive,
        watch: args.watch,
        dryRun: args.dryRun,

        animate: args.animate,
        animateOver: args.animateOver,
        animateValues: args.animateValues,
        animateDelay: args.animateDelay,
        animateWidth: args.animateWidth,
        animateOutput: args.animateOutput,

        concurrency: args.concurrency,
        cache: args.cache,
        cacheFile: args.cacheFile,
        quiet: args.quiet,
        verbose: args.verbose,
        preview: args.preview
    };
}

/** Flatten parsed argv into the options object the fetcher uses. */
export function resolveFetchOptions(args) {
    return {
        artist: args.artist ?? '',
        album: args.album ?? '',
        input: args.input,
        format: args.format,

        destination: args.destination,
        filenameTemplate: args.filenameTemplate,
        force: args.force,
        onDuplicate: args.onDuplicate,
        aliases: args.aliases,

        minConfidence: args.minConfidence,
        market: args.market,
        searchLimit: args.searchLimit,

        report: args.report,
        dryRun: args.dryRun,
        concurrency: args.concurrency,
        maxRetryDelay: args.maxRetryDelay,
        maxImageBytes: args.maxImageBytes,
        envFile: args.envFile,

        quiet: args.quiet,
        verbose: args.verbose
    };
}
