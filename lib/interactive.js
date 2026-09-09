// Interactive mode: build a run by answering prompts instead of memorising flags.
//
// Deliberately additive. Every answer maps onto an ordinary flag, and the
// equivalent command line is printed at the end, so this doubles as a way to
// learn the CLI rather than a separate way of using the tool.

import * as clack from '@clack/prompts';
import pc from 'picocolors';

import { SORT_METHODS, SORT_ORDERS, SORT_KEYS } from './sort.js';
import { VISUALIZATION_MODES } from './process.js';
import { COLOR_METHODS } from './color.js';

/** Abort cleanly on Ctrl+C at any prompt. */
function guard(value) {
    if (clack.isCancel(value)) {
        clack.cancel('Cancelled.');
        process.exit(0);
    }
    return value;
}

/** Reconstruct the flags equivalent to the answers given. */
function toCommandLine(options, defaults) {
    const flags = [];
    const add = (flag, value, fallback) => {
        if (value !== undefined && value !== '' && value !== fallback) flags.push(`${flag} ${value}`);
    };

    add('-i', JSON.stringify(options.inputDirectory), defaults.inputDirectory);
    add('--sortMethod', options.sortMethod, defaults.sortMethod);
    add('-p', options.sortKeys.join(','), defaults.sortKeys.join(','));
    add('-v', options.visualizationMode, defaults.visualizationMode);
    add('-s', options.sortOrder, defaults.sortOrder);
    add('--colorMethod', options.colorMethod, defaults.colorMethod);
    add('--pxPerImage', options.pxPerImage, undefined);
    add('--sortBands', options.sortBands, defaults.sortBands);
    if (options.greyscale) flags.push('-g');
    if (options.descending) flags.push('-d');

    return `node index.js ${flags.join(' ')}`.trim();
}

/**
 * Prompt for the interesting options, layered over whatever was already passed
 * on the command line.
 *
 * @returns {Promise<object>} The updated options object.
 */
export async function runInteractive(baseOptions) {
    const defaults = { ...baseOptions };

    clack.intro(pc.bgCyan(pc.black(' colorSortedImageGrid ')));

    const inputDirectory = guard(await clack.text({
        message: 'Which folder holds your images?',
        placeholder: baseOptions.inputDirectory,
        defaultValue: baseOptions.inputDirectory
    }));

    const sortMethod = guard(await clack.select({
        message: 'How should the images be ordered?',
        initialValue: baseOptions.sortMethod,
        options: [
            { value: SORT_METHODS.NUMERIC, label: 'numeric', hint: 'straight sort on one or more colour keys' },
            { value: SORT_METHODS.BANDED, label: 'banded', hint: 'group into colour bands - smoother than a plain hue sort' },
            { value: SORT_METHODS.HILBERT, label: 'hilbert', hint: 'space-filling curve through Lab - smoothest overall' },
            { value: SORT_METHODS.PERCEPTUAL, label: 'perceptual', hint: 'nearest-neighbour walk - smoothest neighbours' }
        ]
    }));

    // Hilbert and perceptual derive their own ordering from Lab, so asking for
    // a sort key there would be misleading.
    let sortKeys = baseOptions.sortKeys;
    if (sortMethod === SORT_METHODS.NUMERIC || sortMethod === SORT_METHODS.BANDED) {
        const chosen = guard(await clack.select({
            message: sortMethod === SORT_METHODS.BANDED ? 'Which key defines the bands?' : 'Which colour key drives the sort?',
            initialValue: baseOptions.sortKeys[0],
            options: SORT_KEYS.filter((k) => k !== 'filename').map((key) => ({ value: key, label: key }))
        }));
        sortKeys = [chosen];
    }

    let sortBands = baseOptions.sortBands;
    if (sortMethod === SORT_METHODS.BANDED) {
        const answer = guard(await clack.text({
            message: 'How many bands?',
            placeholder: String(baseOptions.sortBands),
            defaultValue: String(baseOptions.sortBands),
            validate: (v) => (v && !Number.isInteger(Number(v))) ? 'Enter a whole number.' : undefined
        }));
        sortBands = Number(answer) || baseOptions.sortBands;
    }

    const visualizationMode = guard(await clack.select({
        message: 'What should each cell look like?',
        initialValue: baseOptions.visualizationMode,
        options: [
            { value: VISUALIZATION_MODES.NORMAL, label: 'normal', hint: 'the photograph, cropped square' },
            { value: VISUALIZATION_MODES.FOURBYFOUR, label: '4x4', hint: 'blocky 4x4 mosaic' },
            { value: VISUALIZATION_MODES.DOMINANT, label: 'dominant', hint: 'flat swatch of the extracted colour' }
        ]
    }));

    const colorMethod = guard(await clack.select({
        message: 'How should each image\'s colour be measured?',
        initialValue: baseOptions.colorMethod,
        options: [
            { value: COLOR_METHODS.AVERAGE, label: 'average', hint: 'fast; blends everything together' },
            { value: COLOR_METHODS.DOMINANT, label: 'dominant', hint: 'slower; the colour that actually covers the most area' }
        ]
    }));

    const sortOrder = guard(await clack.select({
        message: 'Fill the grid in which direction?',
        initialValue: baseOptions.sortOrder,
        options: [
            { value: SORT_ORDERS.COLUMN_MAJOR, label: 'column-major', hint: 'top-to-bottom, then across' },
            { value: SORT_ORDERS.ROW_MAJOR, label: 'row-major', hint: 'left-to-right, then down' }
        ]
    }));

    const extras = guard(await clack.multiselect({
        message: 'Anything else?',
        required: false,
        options: [
            { value: 'greyscale', label: 'Convert everything to greyscale first' },
            { value: 'descending', label: 'Reverse the sort' },
            { value: 'dryRun', label: 'Dry run (show the plan, write nothing)' }
        ],
        initialValues: []
    }));

    const options = {
        ...baseOptions,
        inputDirectory,
        sortMethod,
        sortKeys,
        sortBands,
        visualizationMode,
        colorMethod,
        sortOrder,
        greyscale: extras.includes('greyscale'),
        descending: extras.includes('descending'),
        dryRun: extras.includes('dryRun')
    };

    clack.note(toCommandLine(options, defaults), 'Same run, as a command');

    const proceed = guard(await clack.confirm({ message: 'Render it?', initialValue: true }));
    if (!proceed) {
        clack.cancel('Nothing rendered.');
        process.exit(0);
    }

    clack.outro('Off we go.');
    return options;
}
