// Which questions belong to which section, and which of them apply right now.
//
// Pure, and deliberately separate from the prompts themselves. The wizard has to
// reach roughly forty-five options without asking forty-five questions, so most
// of them live behind a section picker - and the interesting logic is not the
// prompting, it is deciding what is even relevant given the answers so far
// (`--hilbertBits` means nothing outside a hilbert sort). Keeping that here
// makes it testable without a TTY.
//
// The sections mirror the `.group()` headings in lib/cli.js on purpose: someone
// who has read `--help` should recognise them, and vice versa.

import { SORT_METHODS, COLOR_METHODS, VISUALIZATION_MODES } from '../constants.js';
import { ANIMATE_MODES } from '../animate/constants.js';

/**
 * The section picker's own options, in the order they are offered.
 *
 * Ordered roughly by how often they are wanted, not by the order the pipeline
 * consumes them.
 */
export const SECTIONS = Object.freeze([
    { id: 'output', label: 'Input and output', hint: 'where images come from and where results go' },
    { id: 'grid', label: 'Grid and canvas', hint: 'dimensions, cell size, padding, borders, background' },
    { id: 'sorting', label: 'Sorting details', hint: 'tiebreaks, direction, and the method-specific knobs' },
    { id: 'colour', label: 'Colour', hint: 'greyscale, and how finely colour is sampled' },
    { id: 'animation', label: 'Animation', hint: 'render an animated GIF instead of a still' },
    { id: 'run', label: 'Run mode', hint: 'watch the folder, or plan without writing' },
    { id: 'performance', label: 'Performance and terminal output', hint: 'concurrency, cache, verbosity' }
]);

/** Options prompted before the section picker, so the picker never repeats them. */
export const SPINE = Object.freeze([
    'inputDirectory', 'sortMethod', 'sortKeys', 'sortBands', 'visualizationMode', 'colorMethod', 'sortOrder'
]);

/**
 * Each section's questions, in asking order.
 *
 * A `when` predicate reads the answers gathered so far - including answers given
 * earlier in the same section, which is what lets the animation section ask for
 * a mode and then branch on it.
 */
const SECTION_PROMPTS = {
    output: [
        { option: 'recursive' },
        { option: 'outputFilename' },
        { option: 'exportPalette' }
    ],

    grid: [
        { option: 'numRows' },
        { option: 'numColumns' },
        { option: 'pxPerImage' },
        { option: 'padding' },
        { option: 'borderWidth' },
        // Pointless unless something is actually drawn in that colour.
        { option: 'borderColor', when: (a) => Number(a.borderWidth) > 0 },
        { option: 'background' }
    ],

    sorting: [
        // Only a numeric sort consults more than one key; banded takes its
        // secondary key separately, and hilbert and perceptual derive their own
        // ordering from Lab, so extra keys there would be a lie.
        { option: 'sortKeys', when: (a) => a.sortMethod === SORT_METHODS.NUMERIC },
        { option: 'sortSecondary', when: (a) => a.sortMethod === SORT_METHODS.BANDED },
        { option: 'serpentine', when: (a) => a.sortMethod === SORT_METHODS.BANDED },
        { option: 'hilbertBits', when: (a) => a.sortMethod === SORT_METHODS.HILBERT },
        { option: 'descending' }
    ],

    colour: [
        { option: 'greyscale' },
        // Sampling resolution is only read by the median-cut extractor, which
        // runs when either the measurement or the cell rendering asks for it.
        {
            option: 'sampleSize',
            when: (a) => a.colorMethod === COLOR_METHODS.DOMINANT
                || a.visualizationMode === VISUALIZATION_MODES.DOMINANT
        }
    ],

    animation: [
        { option: 'animateMode' },

        // Sweep predates the tweened modes and keeps its own pacing flag; the
        // parser rejects these three outside sweep, so offering them would be
        // offering a guaranteed error.
        { option: 'animateOver', when: (a) => isSweep(a) },
        { option: 'animateValues', when: (a) => isSweep(a) },
        { option: 'animateDelay', when: (a) => isSweep(a) },

        { option: 'revealPerFrame', when: (a) => a.animateMode === ANIMATE_MODES.BUILD },
        { option: 'morphSeconds', when: (a) => a.animateMode === ANIMATE_MODES.MORPH },
        { option: 'morphStagger', when: (a) => a.animateMode === ANIMATE_MODES.MORPH },
        { option: 'morphHoldMs', when: (a) => a.animateMode === ANIMATE_MODES.MORPH },
        // Only the tweened modes ease anything; a hard cut has nothing to ease.
        { option: 'animateEasing', when: (a) => a.animateMode === ANIMATE_MODES.MORPH },

        { option: 'animateFps', when: (a) => !isSweep(a) },
        { option: 'animateHoldMs', when: (a) => !isSweep(a) },
        { option: 'animateWidth' },
        { option: 'animateOutput' }
    ],

    run: [
        // index.js dispatches to the animator before it looks at watch, and the
        // parser now rejects the combination outright.
        { option: 'watch', when: (a) => !a.animate },
        { option: 'dryRun' }
    ],

    performance: [
        { option: 'concurrency' },
        { option: 'cache' },
        { option: 'cacheFile', when: (a) => a.cache !== false },
        { option: 'preview' },
        { option: 'verbose' },
        { option: 'quiet', when: (a) => !a.verbose }
    ]
};

function isSweep(answers) {
    return (answers.animateMode ?? ANIMATE_MODES.SWEEP) === ANIMATE_MODES.SWEEP;
}

/**
 * The options a section should ask about, given the answers so far.
 *
 * Call it again after each answer: the animation section in particular changes
 * shape the moment `animateMode` is known.
 *
 * @param {string} sectionId
 * @param {Record<string, unknown>} answers
 * @returns {string[]} Option names, in asking order.
 */
export function promptsFor(sectionId, answers = {}) {
    return (SECTION_PROMPTS[sectionId] ?? [])
        .filter((prompt) => !prompt.when || prompt.when(answers))
        .map((prompt) => prompt.option);
}

/** Every option any section can reach. Exported so the tests can prove coverage. */
export function allSectionOptions() {
    return Object.values(SECTION_PROMPTS).flatMap((prompts) => prompts.map((p) => p.option));
}
