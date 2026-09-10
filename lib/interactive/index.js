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

import { SECTIONS, promptsFor } from './sections.js';
import { toCommandLine, toConfigObject } from './summary.js';

/** Abort cleanly on Ctrl+C at any prompt. */
function guard(value) {
    if (clack.isCancel(value)) {
        clack.cancel('Cancelled.');
        process.exit(0);
    }
    return value;
}

/** Plain `{value, label}` list, for the options that are just a set of strings. */
function choices(values) {
    return values.map((value) => ({ value, label: value }));
}

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
    sortBands: { type: 'number', message: 'How many bands?' },

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
        options: () => choices(SORT_KEYS)
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
        options: () => choices(Object.values(ANIMATE_DIMENSIONS))
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
        options: () => choices(EASING_NAMES)
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
            options: SORT_KEYS.filter((key) => key !== primary).map((key) => ({ value: key, label: key }))
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
            options: SORT_KEYS.filter((key) => key !== 'filename').map((key) => ({ value: key, label: key }))
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

    const sections = guard(await clack.multiselect({
        message: 'Configure anything else?',
        required: false,
        initialValues: [],
        options: SECTIONS.map(({ id, label, hint }) => ({ value: id, label, hint }))
    }));

    for (const sectionId of sections) {
        // Choosing the animation section is what asks for an animation; there is
        // no separate "do you want one?" question. Set before the section runs,
        // so the run section knows not to offer --watch alongside it.
        if (sectionId === 'animation') answers.animate = true;

        clack.note(SECTIONS.find((section) => section.id === sectionId).label, 'Section');
        await runSection(sectionId, answers);
    }

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
