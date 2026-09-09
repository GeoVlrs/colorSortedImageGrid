// Terminal presentation: verbosity-aware logging, progress, colour swatches.
//
// Everything that writes to the terminal goes through here, so `--quiet` and
// `--verbose` actually mean something and the colour handling lives in one
// place instead of being sprinkled through the pipeline.

import pc from 'picocolors';
import cliProgress from 'cli-progress';
import AsciiTable from 'ascii-table';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const LOG_LEVELS = { QUIET: 0, NORMAL: 1, VERBOSE: 2 };

const isTTY = () => Boolean(process.stdout.isTTY);
const terminalWidth = () => process.stdout.columns || 80;

/**
 * @param {{quiet?: boolean, verbose?: boolean}} options
 */
export function createLogger({ quiet = false, verbose = false } = {}) {
    const level = quiet ? LOG_LEVELS.QUIET : verbose ? LOG_LEVELS.VERBOSE : LOG_LEVELS.NORMAL;

    // `cli-progress`'s SingleBar redraws itself with a bare `\r` (return to
    // column 0, no clear), so any console.log/warn firing while it is active
    // lands on top of the bar's own text instead of a fresh line - the two
    // interleave into unreadable garbage. Whoever owns the active bar
    // registers it here; every write below clears that line first with a raw
    // ANSI "clear entire line" sequence, so the bar simply restarts cleanly
    // below the interrupting message rather than corrupting it.
    let activeBar = null;

    const clearBarLine = () => {
        if (activeBar && isTTY()) process.stdout.write('\x1b[2K\r');
    };

    const write = (minLevel, text) => {
        if (level >= minLevel) {
            clearBarLine();
            console.log(text);
        }
    };

    return {
        level,
        isQuiet: level === LOG_LEVELS.QUIET,
        isVerbose: level === LOG_LEVELS.VERBOSE,

        /** Section heading. */
        step: (text) => write(LOG_LEVELS.NORMAL, `\n${pc.bold(pc.cyan(text))}`),
        /** Ordinary progress narration. */
        info: (text) => write(LOG_LEVELS.NORMAL, text),
        /** Detail only wanted under --verbose (per-image chatter lives here). */
        detail: (text) => write(LOG_LEVELS.VERBOSE, pc.dim(text)),
        success: (text) => write(LOG_LEVELS.NORMAL, pc.green(text)),
        /** Warnings survive --quiet: a skipped file is something you must see. */
        warn: (text) => { clearBarLine(); console.warn(pc.yellow(`! ${text}`)); },
        error: (text) => { clearBarLine(); console.error(pc.red(`x ${text}`)); },
        /** Bypasses --quiet. Used for the final output path. */
        always: (text) => { clearBarLine(); console.log(text); },

        /** Internal: used only by createProgressBar, to know when to clear its line first. */
        _setActiveBar: (bar) => { activeBar = bar; }
    };
}

/**
 * A progress bar that quietly disables itself when it would be noise
 * (non-interactive stdout, or --quiet).
 */
export function createProgressBar(logger, label) {
    if (logger.isQuiet || !isTTY()) {
        return { start() {}, update() {}, stop() {} };
    }

    const bar = new cliProgress.SingleBar(
        {
            format: `  ${pc.cyan('{bar}')} {percentage}% | {value}/{total} ${label}`,
            barCompleteChar: '█',
            barIncompleteChar: '░',
            hideCursor: true,
            clearOnComplete: true
        },
        cliProgress.Presets.shades_classic
    );

    return {
        start: (total) => { logger._setActiveBar?.(bar); bar.start(total, 0); },
        update: (value) => bar.update(value),
        stop: () => { bar.stop(); logger._setActiveBar?.(null); }
    };
}

/**
 * Render the sorted colours as a strip of true-colour terminal blocks.
 *
 * This is the fastest possible "did that sort actually produce a smooth
 * gradient?" check — no need to open the output file at all. Silently skipped
 * when stdout is not a TTY so piped output stays clean.
 *
 * @param {Array<{r: number, g: number, b: number}>} colors
 */
export function renderSwatchStrip(colors, logger) {
    if (logger.isQuiet || !isTTY() || colors.length === 0) return;

    const width = Math.max(20, terminalWidth() - 2);
    // Two terminal cells per swatch reads better than one; fall back to one
    // cell (and finally to sampling) when there are more images than room.
    const cellWidth = colors.length * 2 <= width ? 2 : 1;
    const capacity = Math.floor(width / cellWidth);

    let shown = colors;
    let truncated = false;
    if (colors.length > capacity) {
        // Sample evenly across the sequence rather than truncating the tail, so
        // the strip still represents the whole gradient.
        shown = Array.from({ length: capacity }, (_, i) =>
            colors[Math.floor((i * colors.length) / capacity)]
        );
        truncated = true;
    }

    const strip = shown
        .map(({ r, g, b }) => `\x1b[48;2;${r};${g};${b}m${' '.repeat(cellWidth)}\x1b[0m`)
        .join('');

    console.log(`\n${strip}`);
    console.log(
        pc.dim(
            truncated
                ? `  sorted colour sequence (${colors.length} images, evenly sampled to fit)`
                : `  sorted colour sequence (${colors.length} images)`
        )
    );
}

/**
 * The per-image data table. Keys named in `activeKeys` get a `*` marker so it
 * is obvious which columns actually drove the ordering.
 */
export function renderColorTable(items, activeKeys, logger) {
    if (logger.level < LOG_LEVELS.VERBOSE) return;

    const columns = ['hex', 'hue', 'saturation', 'value', 'lightness', 'luma'];
    const table = new AsciiTable('Per-image colour analysis');
    table.setHeading(
        'filename',
        ...columns.map((c) => (activeKeys.includes(c) ? `${c}*` : c))
    );

    for (const item of items) {
        const c = item.colorInfo;
        table.addRow(
            item.filename,
            c.hex,
            Math.round(c.hue),
            c.saturation.toFixed(1),
            c.value.toFixed(1),
            c.lightness.toFixed(1),
            c.luma.toFixed(1)
        );
    }

    console.log(table.toString());
}

/**
 * The "here's your file" banner. The original built this inline in two places
 * with slightly different text; this is the single version.
 */
export function renderOutputBanner(outputPath, logger) {
    const absolute = path.resolve(outputPath);
    const border = '*'.repeat(absolute.length + 4);
    logger.always(`\n${pc.green(border)}`);
    logger.always(`${pc.green('*')} ${pc.bold(absolute)} ${pc.green('*')}`);
    logger.always(`${pc.green(border)}`);
    logger.always(pc.dim(pathToFileURL(absolute).href));
}

/** End-of-run stats. */
export function renderSummary({ processed, skipped, failed, cacheHits, elapsedMs }, logger) {
    if (logger.isQuiet) return;

    const parts = [
        pc.green(`${processed} processed`),
        skipped ? pc.yellow(`${skipped} skipped`) : null,
        failed ? pc.red(`${failed} failed`) : null,
        cacheHits ? pc.dim(`${cacheHits} from cache`) : null,
        pc.dim(`${(elapsedMs / 1000).toFixed(2)}s`)
    ].filter(Boolean);

    console.log(`\n${parts.join(pc.dim(' | '))}`);
}
