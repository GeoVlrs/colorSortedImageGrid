// The one-shot pipeline: discover -> analyse -> sort -> compose -> write.

import path from 'node:path';
import pc from 'picocolors';

import { RunError } from './errors.js';
import { discoverImages } from './files.js';
import { ColorCache } from './cache.js';
import { processImages } from './process.js';
import { sortImages } from './sort.js';
import { computeGridDimensions, composeGrid, computeCanvasGeometry } from './grid.js';
import {
    writeGridImage, writeNumberedFiles, exportPalette, defaultOutputFilename, ensureUniquePath
} from './output.js';
import {
    renderSwatchStrip, renderColorTable, renderOutputBanner, renderSummary
} from './log.js';

// Re-exported so existing importers of `lib/run.js` keep working unchanged.
export { RunError } from './errors.js';

/**
 * Paths this run is going to write to.
 *
 * Needed because the output is often a `.png` sitting in a folder we may also
 * be reading from. Without this, pointing `--outputFilename` inside the input
 * directory makes the grid swallow its own previous output — and under
 * `--watch` that becomes an endless render loop, since each write looks like a
 * new input image.
 */
export function outputPathsFor(options) {
    if (options.outputFilename === 'files') return [path.resolve('./output')];
    if (options.outputFilename) return [path.resolve(options.outputFilename)];
    return [path.resolve('./output')];
}

/** Drop anything we are about to write from the list of inputs. */
function excludeOwnOutput(filePaths, options, logger) {
    const outputs = outputPathsFor(options);
    const isOwnOutput = (filePath) => {
        const resolved = path.resolve(filePath);
        return outputs.some(
            (output) => resolved === output || resolved.startsWith(output + path.sep)
        );
    };

    const kept = filePaths.filter((filePath) => !isOwnOutput(filePath));
    const removed = filePaths.length - kept.length;
    if (removed > 0) {
        logger.detail(`Ignored ${removed} file${removed === 1 ? '' : 's'} that this run writes to.`);
    }
    return kept;
}

/**
 * Report the plan without doing any of the expensive work.
 * Notably it calls out images that will not fit, which the original silently
 * dropped on the floor.
 */
function reportDryRun(filePaths, options, logger) {
    const { numRows, numColumns } = computeGridDimensions(filePaths.length, options);
    const capacity = numRows * numColumns;
    const surplus = Math.max(0, filePaths.length - capacity);

    logger.step('Dry run - nothing will be written');
    logger.info(`  input directory : ${path.resolve(options.inputDirectory)}`);
    logger.info(`  images found    : ${filePaths.length}`);
    logger.info(`  grid            : ${numColumns} columns x ${numRows} rows (${capacity} cells)`);
    logger.info(`  sort            : ${options.sortMethod} on ${options.sortKeys.join(', ')}${options.descending ? ' (descending)' : ''}`);
    logger.info(`  fill order      : ${options.sortOrder}`);
    logger.info(`  visualization   : ${options.visualizationMode}`);
    logger.info(`  colour source   : ${options.colorMethod}`);

    if (options.pxPerImage) {
        const { width, height } = computeCanvasGeometry({
            numRows, numColumns,
            pxPerImage: options.pxPerImage,
            padding: options.padding,
            borderWidth: options.borderWidth
        });
        logger.info(`  tile size       : ${options.pxPerImage}px`);
        logger.info(`  output canvas   : ${width} x ${height}px`);
    } else {
        logger.info('  tile size       : auto (smallest input dimension - requires decoding)');
    }

    if (surplus > 0) {
        logger.warn(`${surplus} image${surplus === 1 ? '' : 's'} will not fit in this grid and would be dropped.`);
        logger.info(pc.dim('    Give --numRows/--numColumns more room, or let them default to a square.'));
    }

    return { dryRun: true, imageCount: filePaths.length, numRows, numColumns, surplus };
}

/**
 * Execute one full render.
 *
 * @param {object} options Fully resolved options (see lib/cli.js).
 * @param {object} logger
 * @returns {Promise<object>} Summary of what happened.
 */
export async function runOnce(options, logger) {
    const startedAt = Date.now();

    logger.step(`Looking for images in ${path.resolve(options.inputDirectory)}...`);
    const discovered = await discoverImages(options.inputDirectory, { recursive: options.recursive });
    const filePaths = excludeOwnOutput(discovered, options, logger);

    if (filePaths.length === 0) {
        throw new RunError(
            `No supported images found in ${path.resolve(options.inputDirectory)}.\n` +
            `  Supported formats: .jpg .jpeg .png .bmp .tif .tiff .gif` +
            (options.recursive ? '' : '\n  Try --recursive if your images are in subfolders.')
        );
    }
    logger.info(`Found ${filePaths.length} image${filePaths.length === 1 ? '' : 's'}.`);

    if (options.dryRun) return reportDryRun(filePaths, options, logger);

    const cache = new ColorCache(options.cacheFile, options.cache);
    await cache.load();

    const { items, failures, pxPerImage } = await processImages(filePaths, options, cache, logger);
    await cache.save();

    if (items.length === 0) {
        throw new RunError('Every input image failed to process. See the warnings above.');
    }

    logger.step(`Sorting (${options.sortMethod} on ${options.sortKeys.join(', ')})...`);
    const sorted = sortImages(items, {
        method: options.sortMethod,
        keys: options.sortKeys,
        descending: options.descending,
        bands: options.sortBands,
        secondaryKey: options.sortSecondary,
        serpentine: options.serpentine,
        hilbertBits: options.hilbertBits
    });

    renderColorTable(sorted, options.sortKeys, logger);
    if (options.preview) renderSwatchStrip(sorted.map((item) => item.colorInfo), logger);

    if (options.exportPalette) {
        const palettePath = await exportPalette(sorted, options.exportPalette);
        logger.success(`Palette written to ${palettePath}`);
    }

    // Recomputed from what actually succeeded, not from the raw file count.
    const { numRows, numColumns } = computeGridDimensions(sorted.length, options);

    let outputPath;
    if (options.outputFilename === 'files') {
        logger.step('Writing numbered files...');
        outputPath = await writeNumberedFiles(sorted.map((item) => item.tile), './output');
    } else {
        logger.step(`Compositing ${numColumns}x${numRows} grid in ${options.sortOrder} order...`);
        const { image, dropped } = await composeGrid(sorted.map((item) => item.tile), {
            numRows,
            numColumns,
            pxPerImage,
            sortOrder: options.sortOrder,
            padding: options.padding,
            borderWidth: options.borderWidth,
            background: options.background,
            borderColor: options.borderColor
        });

        if (dropped > 0) {
            logger.warn(`${dropped} image${dropped === 1 ? '' : 's'} did not fit in the ${numColumns}x${numRows} grid and were left out.`);
        }

        // An explicit --outputFilename is a deliberate choice and is written
        // as given, overwriting if that path exists. The auto-generated name
        // gets a collision check instead, so two renders with identical
        // settings in the same second (easy to hit while comparing sorts)
        // don't silently clobber each other.
        const target = options.outputFilename
            ? options.outputFilename
            : await ensureUniquePath(defaultOutputFilename({ ...options, numRows, numColumns }));
        logger.info(`Writing ${image.bitmap.width}x${image.bitmap.height}px image...`);
        outputPath = await writeGridImage(image, target);
    }

    renderOutputBanner(outputPath, logger);
    renderSummary({
        processed: sorted.length,
        skipped: 0,
        failed: failures.length,
        cacheHits: cache.hits,
        elapsedMs: Date.now() - startedAt
    }, logger);

    return { outputPath, imageCount: sorted.length, failures: failures.length, numRows, numColumns };
}
