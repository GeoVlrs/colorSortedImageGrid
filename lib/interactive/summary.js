// Turning a finished set of answers back into flags.
//
// Pure: no prompts, no I/O, no Jimp. Everything here is a function of the
// answers and the parser's defaults, which is what makes it testable without a
// TTY - and the wizard's flag reconstruction was previously untested and had
// already drifted (choosing "dry run" printed a command that would have
// rendered for real, because `dryRun` was set but never emitted).
//
// One descriptor table drives both consumers, so the command line printed at the
// end and the preset written to disk cannot disagree about what a run was.

/**
 * The internal option name is not always the flag name: the pipeline works in
 * `sortKeys` and `descending`, the CLI in `--sortParameter` and
 * `--sortDescending`. This is the only place that mapping lives.
 *
 * - `kind: 'list'` is comma-joined, matching `parseSortKeys`.
 * - `negatable` marks a boolean that defaults to true, so turning it off means
 *   `--no-cache` rather than `--cache false`.
 * - `alias` is used only for the printed command line, where brevity is the
 *   point; a saved preset always uses full names.
 *
 * `interactive` is deliberately absent. Emitting it would make a saved preset
 * re-enter the wizard every time it was loaded.
 */
const FLAGS = [
    { option: 'inputDirectory', flag: 'inputDirectory', alias: 'i', kind: 'string' },
    { option: 'recursive', flag: 'recursive', alias: 'R', kind: 'boolean' },
    { option: 'outputFilename', flag: 'outputFilename', alias: 'o', kind: 'string' },
    { option: 'exportPalette', flag: 'exportPalette', kind: 'string' },

    { option: 'numRows', flag: 'numRows', alias: 'r', kind: 'number' },
    { option: 'numColumns', flag: 'numColumns', alias: 'c', kind: 'number' },
    { option: 'pxPerImage', flag: 'pxPerImage', kind: 'number' },
    { option: 'sortOrder', flag: 'sortOrder', alias: 's', kind: 'string' },
    { option: 'padding', flag: 'padding', kind: 'number' },
    { option: 'borderWidth', flag: 'borderWidth', kind: 'number' },
    { option: 'borderColor', flag: 'borderColor', kind: 'string' },
    { option: 'background', flag: 'background', kind: 'string' },

    { option: 'sortMethod', flag: 'sortMethod', kind: 'string' },
    { option: 'sortKeys', flag: 'sortParameter', alias: 'p', kind: 'list' },
    { option: 'descending', flag: 'sortDescending', alias: 'd', kind: 'boolean' },
    { option: 'sortBands', flag: 'sortBands', kind: 'number' },
    { option: 'sortSecondary', flag: 'sortSecondary', kind: 'string' },
    { option: 'serpentine', flag: 'serpentine', kind: 'boolean' },
    { option: 'hilbertBits', flag: 'hilbertBits', kind: 'number' },

    { option: 'visualizationMode', flag: 'visualizationMode', alias: 'v', kind: 'string' },
    { option: 'colorMethod', flag: 'colorMethod', kind: 'string' },
    { option: 'sampleSize', flag: 'sampleSize', kind: 'number' },
    { option: 'greyscale', flag: 'greyscale', alias: 'g', kind: 'boolean' },

    { option: 'watch', flag: 'watch', alias: 'w', kind: 'boolean' },
    { option: 'dryRun', flag: 'dryRun', kind: 'boolean' },

    // `--animateMode build` already implies `--animate` (see resolveOptions), so
    // emitting both would be noise. Bare `--animate` still has to be emitted for
    // a sweep, which is the one case where no mode flag carries the intent.
    {
        option: 'animate', flag: 'animate', kind: 'boolean',
        redundantWhen: (options) => options.animateMode !== undefined && options.animateMode !== 'sweep'
    },
    { option: 'animateMode', flag: 'animateMode', kind: 'string' },
    { option: 'animateOver', flag: 'animateOver', kind: 'string' },
    { option: 'animateValues', flag: 'animateValues', kind: 'string' },
    { option: 'animateDelay', flag: 'animateDelay', kind: 'number' },
    { option: 'animateWidth', flag: 'animateWidth', kind: 'number' },
    { option: 'animateOutput', flag: 'animateOutput', kind: 'string' },
    { option: 'animateFps', flag: 'animateFps', kind: 'number' },
    { option: 'animateHoldMs', flag: 'animateHoldMs', kind: 'number' },
    { option: 'animateEasing', flag: 'animateEasing', kind: 'string' },
    { option: 'revealPerFrame', flag: 'revealPerFrame', kind: 'number' },
    { option: 'morphSeconds', flag: 'morphSeconds', kind: 'number' },
    { option: 'morphStagger', flag: 'morphStagger', kind: 'number' },
    { option: 'morphHoldMs', flag: 'morphHoldMs', kind: 'number' },

    { option: 'concurrency', flag: 'concurrency', kind: 'number' },
    { option: 'cache', flag: 'cache', kind: 'boolean', negatable: true },
    { option: 'cacheFile', flag: 'cacheFile', kind: 'string' },
    { option: 'preview', flag: 'preview', kind: 'boolean', negatable: true },
    { option: 'quiet', flag: 'quiet', alias: 'q', kind: 'boolean' },
    { option: 'verbose', flag: 'verbose', kind: 'boolean' }
];

/** Every option name the wizard is able to express. Exported for the tests. */
export const MAPPED_OPTIONS = Object.freeze(FLAGS.map((entry) => entry.option));

/** Comparable form of a value, so a list can be diffed against its default. */
function normalize(value, kind) {
    if (value === undefined || value === null) return undefined;
    return kind === 'list' ? [...value].join(',') : value;
}

/**
 * Which options differ from the parser's defaults, in table order.
 *
 * Diffing against the *parser's* defaults rather than the options the wizard
 * started from matters: if someone ran `--interactive --sortMethod hilbert`,
 * hilbert is already in `baseOptions`, and diffing against that would drop it
 * from the printed command - which would then no longer reproduce the run.
 */
function* changedEntries(options, defaults) {
    for (const entry of FLAGS) {
        if (entry.redundantWhen?.(options)) continue;

        const value = normalize(options[entry.option], entry.kind);
        const fallback = normalize(defaults[entry.option], entry.kind);

        if (value === undefined || value === '') continue;
        if (value === fallback) continue;

        yield [entry, value];
    }
}

/**
 * The answers as an argv array.
 *
 * Array rather than a string so it can be fed straight back through
 * `buildParser` - which is exactly what the round-trip test does, and the only
 * way to be sure the table above has not fallen behind the CLI.
 *
 * @returns {string[]}
 */
export function toFlagArgs(options, defaults) {
    const args = [];

    for (const [entry, value] of changedEntries(options, defaults)) {
        const name = entry.alias ? `-${entry.alias}` : `--${entry.flag}`;

        if (entry.kind === 'boolean') {
            if (value === true) args.push(name);
            else if (entry.negatable) args.push(`--no-${entry.flag}`);
            continue;
        }
        args.push(name, String(value));
    }

    return args;
}

/** Quote an argv entry only when a shell would otherwise mangle it. */
function shellQuote(value) {
    return /^[\w./:@=+,-]+$/.test(value) ? value : JSON.stringify(value);
}

/**
 * The answers as a command someone can copy, paste and re-run.
 *
 * This is why the wizard prints a summary at all: it doubles as a way to learn
 * the flags rather than being a separate way of using the tool.
 */
export function toCommandLine(options, defaults) {
    const args = toFlagArgs(options, defaults).map(shellQuote);
    return `node index.js ${args.join(' ')}`.trim();
}

/**
 * The answers as a `--config` preset.
 *
 * `.config('config', ...)` in lib/cli.js already reads exactly this shape - a
 * JSON object keyed by flag name - so saving a preset needs no loading code at
 * all. Full flag names, never aliases: a file is read far more often than it is
 * typed.
 *
 * @returns {Record<string, string|number|boolean>}
 */
export function toConfigObject(options, defaults) {
    const config = {};
    for (const [entry, value] of changedEntries(options, defaults)) {
        config[entry.flag] = value;
    }
    return config;
}
