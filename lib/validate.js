// Range rules for numeric options, shared by the flag parser and the wizard.
//
// This file deliberately imports NOTHING, for the same reason as lib/constants.js
// and lib/animate/constants.js: lib/cli.js depends on it, and `colorgrid --help`
// must not drag in Jimp and the rest of the render pipeline to reject a flag.
//
// The rules used to live inline in cli.js's `.check()`, which meant the
// interactive wizard - which never goes through yargs - enforced whatever subset
// its prompts happened to hand-roll. `--sortBands -5` was accepted there and
// rejected on the command line. One table now serves both: `checkGridArgs` for
// the parser, `ruleError` for a prompt's `validate` callback.

/**
 * Keyed by FLAG name (`sortDescending`, not `descending`), because both callers
 * speak flags: yargs hands us `args`, and the wizard reports errors the user can
 * act on by re-running with a flag.
 *
 * `message` is spelled out where the original wording named two flags at once.
 * Those pairs are always set or unset together, so a single shared sentence is
 * still accurate at whichever of the two the value came from.
 */
const RULES = {
    numRows: { positive: true },
    numColumns: { positive: true },
    pxPerImage: { positive: true },
    sortBands: { positive: true },
    concurrency: { positive: true },
    sampleSize: { positive: true },
    animateWidth: { positive: true },
    animateFps: { positive: true },
    revealPerFrame: { positive: true },
    morphSeconds: { positive: true },

    padding: { min: 0, message: '--padding and --borderWidth cannot be negative.' },
    borderWidth: { min: 0, message: '--padding and --borderWidth cannot be negative.' },

    hilbertBits: { min: 1, max: 10, message: '--hilbertBits must be between 1 and 10.' },
    morphStagger: { min: 0, max: 0.9, message: '--morphStagger must be between 0 and 0.9.' },

    animateHoldMs: { min: 0, message: '--animateHoldMs and --morphHoldMs cannot be negative.' },
    morphHoldMs: { min: 0, message: '--animateHoldMs and --morphHoldMs cannot be negative.' }
};

/** Every flag with a rule, in the order the parser checks them. */
export const VALIDATED_FLAGS = Object.freeze(Object.keys(RULES));

/**
 * Check one value against its rule.
 *
 * Returns the error message rather than throwing, because that is exactly the
 * contract `@clack/prompts` wants from a `validate` callback - so a prompt can
 * pass this straight through and reject bad input in place, with the same
 * wording the command line would have used.
 *
 * An unset value is not an error: several of these options legitimately have no
 * default (`--pxPerImage` is derived from the images, `--revealPerFrame` from
 * the frame budget), and "unset" is how that is expressed.
 *
 * @param {string} flag
 * @param {unknown} value
 * @returns {string|undefined} The message, or undefined if the value is fine.
 */
export function ruleError(flag, value) {
    const rule = RULES[flag];
    if (!rule) return undefined;
    if (value === undefined || value === null || value === '') return undefined;

    const number = typeof value === 'number' ? value : Number(value);

    if (!Number.isFinite(number)) return `--${flag} must be a number (got ${value}).`;
    if (rule.positive && number <= 0) return `--${flag} must be a positive number (got ${number}).`;
    if (rule.min !== undefined && number < rule.min) return rule.message;
    if (rule.max !== undefined && number > rule.max) return rule.message;

    return undefined;
}

/**
 * Validate every numeric grid option at once, throwing on the first failure.
 *
 * A plain `Error`, not a `RunError`: this runs inside yargs' `.check()`, which
 * has its own failure formatting, and RunError's contract is "a problem the user
 * can act on, printed without a stack" - which is what yargs already does here.
 *
 * @param {Record<string, unknown>} args Parsed yargs arguments.
 * @returns {true}
 */
export function checkGridArgs(args) {
    for (const flag of VALIDATED_FLAGS) {
        const error = ruleError(flag, args[flag]);
        if (error) throw new Error(error);
    }
    return true;
}
