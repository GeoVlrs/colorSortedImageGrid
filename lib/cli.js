// Command-line surface.

import os from 'node:os';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { SORT_METHODS, SORT_ORDERS, SORT_KEYS, parseSortKeys } from './sort.js';
import { VISUALIZATION_MODES } from './process.js';
import { COLOR_METHODS } from './color.js';
import { ANIMATE_DIMENSIONS } from './animate.js';

const DEFAULT_CONCURRENCY = Math.min(8, Math.max(1, os.cpus().length));

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
            `$0 [options]\n\n` +
            `Sort a folder of images by colour and composite them into one grid image.\n` +
            `With no options, sorts ./images by hue into a square grid.`
        )
        .example('$0', 'Sort ./images by hue into a square grid')
        .example('$0 -i ./photos --sortMethod hilbert', 'Smoothest overall gradient (Lab space-filling curve)')
        .example('$0 --sortMethod banded --sortBands 12', 'Band by hue, brightness within each band')
        .example('$0 -v dominant --colorMethod dominant', 'Flat swatches of each image\'s true dominant colour')
        .example('$0 --dryRun', 'Show the plan (grid size, dropped images) without writing anything')
        .example('$0 --interactive', 'Pick the options through prompts')
        .example('$0 --animate --animateOver sortMethod', 'One GIF sweeping through every sort method')

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
        .option('quiet', { alias: 'q', type: 'boolean', default: false, describe: 'Only errors and the output path' })
        .option('verbose', { type: 'boolean', default: false, describe: 'Per-image detail and the full analysis table' })
        .option('preview', { type: 'boolean', default: true, describe: 'Print the sorted colours as a terminal strip (--no-preview to disable)' })
        .group(['concurrency', 'cache', 'cacheFile', 'quiet', 'verbose', 'preview'], 'Performance and output:')

        .config('config', 'Read options from a JSON file (flags still win)')

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
        })

        .epilog(
            'Tips:\n' +
            '  --sortMethod hilbert usually gives the smoothest looking grid.\n' +
            '  --dryRun tells you if images will not fit before you wait for a render.\n' +
            '  Repeat runs over the same folder reuse the colour cache, so trying\n' +
            '  different sorts is fast.\n\n' +
            'Originally by Zach Fox: https://github.com/zfox23/colorSortedImageGrid'
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

/** Flatten parsed argv into the single options object the pipeline uses. */
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
