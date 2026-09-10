// Interactive mode: build a run by answering prompts instead of memorising flags.
//
// Deliberately additive. Every answer maps onto an ordinary flag, and the
// equivalent command line is printed at the end, so this doubles as a way to
// learn the CLI rather than a separate way of using the tool.
//
// The shape is a short spine - the handful of questions every run needs - and
// then a section picker for everything else. That is what lets the wizard reach
// all forty-odd options without turning a plain run into a forty-question
// interrogation: skip the picker and it is as short as it ever was.
//
// This file is orchestration and wording only. Which questions apply lives in
// sections.js, what the answers mean as flags lives in summary.js, and the range
// rules come from lib/validate.js - the same ones yargs enforces, so a value
// rejected here would have been rejected on the command line too.

import fs from 'node:fs/promises';
import path from 'node:path';

import * as clack from '@clack/prompts';
import pc from 'picocolors';

import { SORT_METHODS, SORT_ORDERS, SORT_KEYS, VISUALIZATION_MODES, COLOR_METHODS } from '../constants.js';
import { ANIMATE_MODES, ANIMATE_DIMENSIONS } from '../animate/constants.js';
import { EASING_NAMES } from '../animate/easing.js';
import { ruleError } from '../validate.js';
import { buildParser, resolveOptions } from '../cli.js';

import { SECTIONS, promptsFor, orderSections } from './sections.js';
import { toCommandLine, toConfigObject } from './summary.js';

/** Abort cleanly on Ctrl+C at any prompt. */
function guard(value) {
    if (clack.isCancel(value)) {
        clack.cancel('Cancelled.');
        process.exit(0);
    }
    return value;
}

/**
 * Build a `{value, label, hint}` option list from raw values plus a table of
 * descriptions.
 *
 * Every option list in the wizard goes through here, so none of them can show a
 * bare value name. That is not just polish: the values are flag values, chosen
 * to be typed, and several are indistinguishable without a gloss (`value` vs
 * `lightness`, `easeInOutQuad` vs `easeInOutCubic`). A test asserts each table
 * below covers every value it is paired with, so a new easing or sort key
 * cannot ship undescribed.
 *
 * `label` is only worth setting where the raw value reads oddly as a prompt
 * option; otherwise the value speaks for itself and doubles as the thing you
 * would pass on the command line.
 */
function optionsFrom(values, info) {
    return values.map((value) => ({
        value,
        label: info[value]?.label ?? value,
        hint: info[value]?.hint
    }));
}

/**
 * What each sort key actually means. Without this, someone who doesn't already
 * know the difference between `value` and `lightness` (both "brightness", one
 * HSV and one HSL - see lib/color.js) is picking blind.
 *
 * `dateTaken` gets a label because it is camelCase for being a flag name, not
 * because anyone says it that way.
 */
export const SORT_KEY_INFO = {
    hue: { hint: 'position on the colour wheel' },
    saturation: { hint: 'colour intensity, grey to vivid' },
    value: { hint: 'brightness, HSV' },
    lightness: { hint: 'brightness, HSL' },
    luma: { hint: 'perceived brightness, Rec. 601' },
    labL: { hint: 'CIE Lab lightness' },
    labA: { hint: 'CIE Lab green-red axis' },
    labB: { hint: 'CIE Lab blue-yellow axis' },
    dateTaken: { label: 'date taken', hint: 'EXIF capture date, falls back to file time' },
    filename: { hint: 'alphabetical' }
};

/**
 * What each easing actually looks like in motion.
 *
 * The CLI leaves `--animateEasing` unset and morph falls back to
 * `DEFAULT_EASING` internally, so this hint is the only place that tells anyone
 * which one they get by default.
 */
export const EASING_INFO = {
    linear: { hint: 'constant speed - reads as mechanical' },
    easeInOutCubic: { hint: 'default; accelerates away, settles into place' },
    easeOutCubic: { hint: 'starts fast, glides to a stop' },
    easeInOutSine: { hint: 'gentlest ease at both ends' },
    easeInOutQuad: { hint: 'like cubic, softer' }
};

/** What a sweep varies from frame to frame. */
export const ANIMATE_OVER_INFO = {
    sortParameter: { hint: 'one frame per colour key - hue, luma, labL...' },
    sortMethod: { hint: 'one frame per method - numeric, banded, hilbert, perceptual' },
    visualizationMode: { hint: 'one frame per cell style - normal, 4x4, dominant' }
};

/**
 * Every question the section picker can reach, keyed by option name.
 *
 * Wording only - whether a question is asked at all is sections.js's decision.
 * `placeholder` is what an option with no default looks like: several of these
 * are legitimately unset (`--pxPerImage` is derived from the images), and
 * "leave blank" is how that is offered.
 */
export const PROMPTS = {
    // Asked by the spine rather than a section, since a banded sort is
    // meaningless without it.
    sortBands: {
        type: 'number', message: 'How many bands?',
        placeholder: 'more = smoother, fewer = more distinct; typically 8-16, default 12'
    },

    recursive: { type: 'confirm', message: 'Search subfolders as well?' },
    outputFilename: {
        type: 'text', message: 'Where should the result go?',
        placeholder: 'blank for an auto-named file in ./output'
    },
    exportPalette: {
        type: 'text', message: 'Also write the extracted palette somewhere?',
        placeholder: 'blank to skip; .json or .css'
    },

    numRows: { type: 'number', message: 'How many rows?', placeholder: 'blank to fit automatically' },
    numColumns: { type: 'number', message: 'How many columns?', placeholder: 'blank to fit automatically' },
    pxPerImage: {
        type: 'number', message: 'Pixels per cell?',
        placeholder: 'blank to use the smallest input dimension'
    },
    padding: { type: 'number', message: 'Gap between cells, in pixels?' },
    borderWidth: { type: 'number', message: 'Border around each cell, in pixels?' },
    borderColor: { type: 'text', message: 'Border colour?' },
    background: { type: 'text', message: 'Canvas background? (a CSS colour, or "transparent")' },

    sortKeys: { type: 'tiebreaks', message: 'Any tiebreak keys, applied after the first?' },
    sortSecondary: {
        type: 'select', message: 'Which key sorts within each band?',
        options: () => optionsFrom(SORT_KEYS, SORT_KEY_INFO)
    },
    serpentine: { type: 'confirm', message: 'Alternate band direction, so the gradient flows continuously?' },
    hilbertBits: { type: 'number', message: 'Curve precision per axis, 1-10?' },
    descending: { type: 'confirm', message: 'Reverse the final order?' },

    greyscale: { type: 'confirm', message: 'Convert everything to greyscale first?' },
    sampleSize: { type: 'number', message: 'Sampling resolution for the dominant-colour pass?' },

    animateMode: {
        type: 'select', message: 'What kind of animation?',
        options: () => [
            { value: ANIMATE_MODES.BUILD, label: 'build', hint: 'the grid assembles one tile at a time' },
            { value: ANIMATE_MODES.MORPH, label: 'morph', hint: 'tiles fly from filename order into colour order' },
            { value: ANIMATE_MODES.SWEEP, label: 'sweep', hint: 'hard cuts between values of one setting' }
        ]
    },
    animateOver: {
        type: 'select', message: 'Which setting should vary between frames?',
        options: () => optionsFrom(Object.values(ANIMATE_DIMENSIONS), ANIMATE_OVER_INFO)
    },
    animateValues: {
        type: 'text', message: 'Which values should it step through?',
        placeholder: 'comma-separated; blank for all of them'
    },
    animateDelay: { type: 'number', message: 'Milliseconds per frame?' },
    revealPerFrame: {
        type: 'number', message: 'Tiles revealed per frame?',
        placeholder: 'blank to stay under 240 frames'
    },
    morphSeconds: { type: 'number', message: 'How long should the tween last, in seconds?' },
    morphStagger: { type: 'number', message: 'How much should tiles trail each other? 0-0.9, 0 moves them together' },
    morphHoldMs: { type: 'number', message: 'Pause on the unsorted layout first, in milliseconds?' },
    animateEasing: {
        type: 'select', message: 'Motion curve?',
        options: () => optionsFrom(EASING_NAMES, EASING_INFO)
    },
    animateFps: { type: 'number', message: 'Frames per second? GIF snaps this to 10ms steps' },
    animateHoldMs: { type: 'number', message: 'How long to hold the finished result, in milliseconds?' },
    animateWidth: { type: 'number', message: 'Maximum GIF width, in pixels?' },
    animateOutput: {
        type: 'text', message: 'Where should the GIF go?',
        placeholder: 'blank for an auto-named file in ./output'
    },

    watch: { type: 'confirm', message: 'Re-render whenever the folder changes?' },
    dryRun: { type: 'confirm', message: 'Dry run - report the plan and write nothing?' },

    concurrency: { type: 'number', message: 'How many images at a time?' },
    cache: { type: 'confirm', message: 'Reuse colour analysis between runs?' },
    cacheFile: { type: 'text', message: 'Where should the cache live?' },
    preview: { type: 'confirm', message: 'Print the sorted colours as a terminal strip?' },
    verbose: { type: 'confirm', message: 'Verbose - per-item detail and the full analysis table?' },
    quiet: { type: 'confirm', message: 'Quiet - only errors and the output path?' }
};

/**
 * Ask one question, defaulting to whatever the option already holds.
 *
 * Pressing Enter always keeps the current value, including keeping it unset -
 * which is why the numeric branch treats an empty string as "unchanged" rather
 * than as zero.
 */
async function ask(option, current, answers) {
    const spec = PROMPTS[option];
    const message = spec.message;

    if (spec.type === 'confirm') {
        return guard(await clack.confirm({ message, initialValue: Boolean(current) }));
    }

    if (spec.type === 'select') {
        return guard(await clack.select({ message, initialValue: current, options: spec.options() }));
    }

    if (spec.type === 'tiebreaks') {
        // Layered on top of the primary key chosen in the spine, rather than
        // replacing it, so this reads as "and then by...".
        const primary = answers.sortKeys[0];
        const chosen = guard(await clack.multiselect({
            message: `${message} (after ${pc.cyan(primary)})`,
            required: false,
            initialValues: answers.sortKeys.slice(1),
            options: optionsFrom(SORT_KEYS.filter((key) => key !== primary), SORT_KEY_INFO)
        }));
        return [primary, ...chosen];
    }

    const raw = guard(await clack.text({
        message,
        placeholder: spec.placeholder ?? (current === undefined ? '' : String(current)),
        defaultValue: current === undefined ? '' : String(current),
        // The parser's own rules, so nothing is accepted here that the command
        // line would have rejected.
        validate: spec.type === 'number' ? (value) => ruleError(option, value) : undefined
    }));

    const trimmed = String(raw).trim();
    if (trimmed === '') return current;
    return spec.type === 'number' ? Number(trimmed) : trimmed;
}

/**
 * Work through one section, re-deciding what to ask after every answer.
 *
 * Not a fixed list, because a section can change shape as it goes: the
 * animation section asks for a mode first and everything after that depends on
 * the answer.
 */
async function runSection(sectionId, answers) {
    const asked = new Set();

    for (;;) {
        const next = promptsFor(sectionId, answers).find((option) => !asked.has(option));
        if (!next) return;

        asked.add(next);
        answers[next] = await ask(next, answers[next], answers);
    }
}

/** The spine: the questions every run needs, asked before the picker. */
async function runSpine(answers) {
    answers.inputDirectory = guard(await clack.text({
        message: 'Which folder holds your images?',
        placeholder: answers.inputDirectory,
        defaultValue: answers.inputDirectory
    }));

    answers.sortMethod = guard(await clack.select({
        message: 'How should the images be ordered?',
        initialValue: answers.sortMethod,
        options: [
            { value: SORT_METHODS.NUMERIC, label: 'numeric', hint: 'straight sort on one or more colour keys' },
            { value: SORT_METHODS.BANDED, label: 'banded', hint: 'group into colour bands - smoother than a plain hue sort' },
            { value: SORT_METHODS.HILBERT, label: 'hilbert', hint: 'space-filling curve through Lab - smoothest overall' },
            { value: SORT_METHODS.PERCEPTUAL, label: 'perceptual', hint: 'nearest-neighbour walk - smoothest neighbours' }
        ]
    }));

    // Hilbert and perceptual derive their own ordering from Lab, so asking for
    // a sort key there would be misleading.
    if (answers.sortMethod === SORT_METHODS.NUMERIC || answers.sortMethod === SORT_METHODS.BANDED) {
        const chosen = guard(await clack.select({
            message: answers.sortMethod === SORT_METHODS.BANDED
                ? 'Which key defines the bands?'
                : 'Which colour key drives the sort?',
            initialValue: answers.sortKeys[0],
            options: optionsFrom(SORT_KEYS.filter((key) => key !== 'filename'), SORT_KEY_INFO)
        }));
        answers.sortKeys = [chosen];
    }

    if (answers.sortMethod === SORT_METHODS.BANDED) {
        answers.sortBands = await ask('sortBands', answers.sortBands, answers);
    }

    answers.visualizationMode = guard(await clack.select({
        message: 'What should each cell look like?',
        initialValue: answers.visualizationMode,
        options: [
            { value: VISUALIZATION_MODES.NORMAL, label: 'normal', hint: 'the photograph, cropped square' },
            { value: VISUALIZATION_MODES.FOURBYFOUR, label: '4x4', hint: 'blocky 4x4 mosaic' },
            { value: VISUALIZATION_MODES.DOMINANT, label: 'dominant', hint: 'flat swatch of the extracted colour' }
        ]
    }));

    answers.colorMethod = guard(await clack.select({
        message: 'How should each image\'s colour be measured?',
        initialValue: answers.colorMethod,
        options: [
            { value: COLOR_METHODS.AVERAGE, label: 'average', hint: 'fast; blends everything together' },
            { value: COLOR_METHODS.DOMINANT, label: 'dominant', hint: 'slower; the colour that actually covers the most area' }
        ]
    }));

    answers.sortOrder = guard(await clack.select({
        message: 'Fill the grid in which direction?',
        initialValue: answers.sortOrder,
        options: [
            { value: SORT_ORDERS.COLUMN_MAJOR, label: 'column-major', hint: 'top-to-bottom, then across' },
            { value: SORT_ORDERS.ROW_MAJOR, label: 'row-major', hint: 'left-to-right, then down' }
        ]
    }));
}

/** Run one section, announcing it first. */
async function enterSection(sectionId, answers) {
    // Choosing the animation section is what asks for an animation; there is no
    // separate "do you want one?" question. Set before the section runs, so the
    // run section knows not to offer --watch alongside it.
    if (sectionId === 'animation') answers.animate = true;

    clack.note(SECTIONS.find((section) => section.id === sectionId).label, 'Section');
    await runSection(sectionId, answers);
}

/**
 * Ask which extra areas to configure, then configure them.
 *
 * A checkbox list, because seven areas on one screen beats seven questions -
 * but with a fallback, because a checkbox list has a failure mode that looks
 * exactly like success. Space checks a box and Enter submits whatever is
 * checked; arrowing onto an option and pressing Enter submits *nothing*, and an
 * optional list accepts that silently. From the outside that is
 * indistinguishable from "picking anything here just skips to the end", which is
 * precisely how it was reported.
 *
 * Making the list `required` would turn that into clack's own "press space to
 * select" error, which teaches the key at the moment of the mistake - but it
 * would also strand anyone whose terminal never delivers Space at all, with no
 * way forward. So instead an empty result is treated as "that probably wasn't
 * what you meant" and falls through to plain yes/no questions, which need
 * nothing but Enter. Fast path when Space works, still usable when it doesn't.
 */
async function pickAndRunSections(answers) {
    const wantsMore = guard(await clack.confirm({
        message: 'Configure anything else?',
        initialValue: false
    }));
    if (!wantsMore) return;

    const checked = guard(await clack.multiselect({
        message: `Which areas? ${pc.dim('(space to check, a for all, enter to confirm)')}`,
        required: false,
        initialValues: [],
        options: SECTIONS.map(({ id, label, hint }) => ({ value: id, label, hint }))
    }));

    if (checked.length > 0) {
        // Checkbox order is press order, not list order - and the sections are
        // order-dependent. See orderSections in sections.js.
        for (const sectionId of orderSections(checked)) {
            await enterSection(sectionId, answers);
        }
        return;
    }

    clack.log.warn('Nothing was checked - asking one area at a time instead.');

    // Each area is configured immediately after its own yes, rather than
    // collecting every answer first: the point of saying yes is to get to those
    // questions, and holding them back to the end loses that connection.
    for (const section of SECTIONS) {
        const wants = guard(await clack.confirm({
            message: `${section.label}? ${pc.dim(`(${section.hint})`)}`,
            initialValue: false
        }));
        if (wants) await enterSection(section.id, answers);
    }
}

/** Offer to write the answers out as something `--config` can load. */
async function offerPreset(options, defaults) {
    const save = guard(await clack.confirm({
        message: 'Save these settings as a preset?',
        initialValue: false
    }));
    if (!save) return;

    const target = guard(await clack.text({
        message: 'Save it where?',
        placeholder: './preset.json',
        defaultValue: './preset.json'
    }));

    const resolved = path.resolve(String(target).trim() || './preset.json');
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, `${JSON.stringify(toConfigObject(options, defaults), null, 2)}\n`, 'utf8');

    clack.log.success(`Saved. Re-run it with ${pc.cyan(`--config ${target}`)} (flags still win).`);
}

/**
 * Prompt for the options, layered over whatever was already passed on the
 * command line.
 *
 * @returns {Promise<object>} The updated options object.
 */
export async function runInteractive(baseOptions) {
    // The parser's defaults, not the options we started from. If someone ran
    // `--interactive --sortMethod hilbert`, hilbert is already in baseOptions,
    // and diffing the summary against that would drop it from the printed
    // command - which would then no longer reproduce the run.
    const defaults = resolveOptions(buildParser([], { exitOnError: false }).parseSync());

    clack.intro(pc.bgCyan(pc.black(' colorSortedImageGrid ')));

    const answers = { ...baseOptions };
    await runSpine(answers);

    await pickAndRunSections(answers);

    const options = { ...answers, needsDateTaken: answers.sortKeys.includes('dateTaken') };

    clack.note(toCommandLine(options, defaults), 'Same run, as a command');
    await offerPreset(options, defaults);

    const proceed = guard(await clack.confirm({ message: 'Render it?', initialValue: true }));
    if (!proceed) {
        clack.cancel('Nothing rendered.');
        process.exit(0);
    }

    clack.outro('Off we go.');
    return options;
}
