// The vocabulary the CLI is built from: option values, and the one helper
// that validates them.
//
// Like lib/animate/constants.js, this file imports nothing heavy on purpose.
// lib/cli.js needs these values to declare its flag choices, and it used to
// get them from sort.js, process.js and color.js - which meant every
// `colorgrid --help`, and every rejected flag, first loaded Jimp, culori,
// quantize and exifr. That cost about 600ms before printing a line of text.
//
// The modules that own the behaviour re-export these, so `import { SORT_KEYS }
// from './sort.js'` keeps working for everything downstream.

import { RunError } from './errors.js';

export const SORT_METHODS = Object.freeze({
    NUMERIC: 'numeric',
    BANDED: 'banded',
    HILBERT: 'hilbert',
    PERCEPTUAL: 'perceptual'
});

export const SORT_ORDERS = Object.freeze({ ROW_MAJOR: 'row-major', COLUMN_MAJOR: 'column-major' });

/** Every key `--sortParameter` accepts. */
export const SORT_KEYS = Object.freeze([
    'hue', 'saturation', 'value', 'lightness', 'luma',
    'labL', 'labA', 'labB',
    'dateTaken', 'filename'
]);

/** What each grid cell shows. */
export const VISUALIZATION_MODES = Object.freeze({
    NORMAL: 'normal',
    DOMINANT: 'dominant',
    FOURBYFOUR: '4x4'
});

/** How each image's representative colour is measured. */
export const COLOR_METHODS = Object.freeze({ AVERAGE: 'average', DOMINANT: 'dominant' });

/** Parse a comma-separated `--sortParameter` value into validated keys. */
export function parseSortKeys(raw) {
    const keys = String(raw)
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean);

    if (keys.length === 0) throw new RunError('--sortParameter needs at least one key.');

    for (const key of keys) {
        if (!SORT_KEYS.includes(key)) {
            throw new RunError(`Unknown sort key "${key}". Valid keys: ${SORT_KEYS.join(', ')}`);
        }
    }
    return keys;
}
