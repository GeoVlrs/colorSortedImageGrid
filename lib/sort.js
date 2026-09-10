// Sorting strategies.
//
// The original was a single line: `a.colorInfo[param] - b.colorInfo[param]`.
// One key, ascending only, no tiebreak. Everything here is built around that
// same data, just used more thoroughly.

import { colorDistance } from './color.js';
import { hilbertIndexForLab } from './hilbert.js';

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

// Theoretical ranges, used to divide a key into bands. Deliberately *not*
// derived from the data: fixed ranges mean `--sortBands 12` carves hue into the
// same twelve buckets every run, so results stay comparable between folders.
const KEY_RANGES = {
    hue: [0, 360],
    saturation: [0, 100],
    value: [0, 100],
    lightness: [0, 100],
    luma: [0, 255],
    labL: [0, 100],
    labA: [-128, 127],
    labB: [-128, 127]
};

/** Parse a comma-separated `--sortParameter` value into validated keys. */
export function parseSortKeys(raw) {
    const keys = String(raw)
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean);

    if (keys.length === 0) throw new Error('--sortParameter needs at least one key.');

    for (const key of keys) {
        if (!SORT_KEYS.includes(key)) {
            throw new Error(`Unknown sort key "${key}". Valid keys: ${SORT_KEYS.join(', ')}`);
        }
    }
    return keys;
}

/** Read one sort key off an item, wherever it happens to live. */
export function sortValue(item, key) {
    if (key === 'filename') return item.filename;
    if (key === 'dateTaken') return item.dateTaken ?? 0;
    return item.colorInfo[key];
}

/**
 * Compare two sort-key values, whichever key produced them.
 *
 * Almost every key is numeric (hue, luma, ...), but `filename` is a string,
 * so both are handled here rather than assuming subtraction always works.
 */
function compareValues(a, b) {
    if (typeof a === 'string' || typeof b === 'string') {
        return String(a).localeCompare(String(b));
    }
    return a - b;
}

/**
 * Multi-key comparator with a guaranteed final tiebreak on filename.
 *
 * The tiebreak is not cosmetic: without it, images with identical colours could
 * land in a different order on every run.
 */
export function createComparator(keys) {
    return (a, b) => {
        for (const key of keys) {
            const result = compareValues(sortValue(a, key), sortValue(b, key));
            if (result !== 0) return result;
        }
        return String(a.filename).localeCompare(String(b.filename));
    };
}

/**
 * Banded ("step") sort.
 *
 * Quantise the primary key into N bands, then sort within each band by a
 * secondary key. This is the standard trick for making a hue sort stop looking
 * streaky: strict hue ordering interleaves dark and light images of similar
 * hue, whereas banding groups the hue family together and lets brightness run
 * smoothly inside it.
 *
 * With `serpentine`, every other band runs backwards, so the secondary value
 * flows continuously across band boundaries instead of snapping back.
 */
export function bandedSort(items, { keys, bands, secondaryKey, serpentine }) {
    const primaryKey = keys[0];
    const [min, max] = KEY_RANGES[primaryKey] ?? [0, 1];
    const span = max - min || 1;

    const bandOf = (item) => {
        const value = sortValue(item, primaryKey);
        const normalised = (Number(value) - min) / span;
        return Math.min(bands - 1, Math.max(0, Math.floor(normalised * bands)));
    };

    const withinBand = createComparator([secondaryKey, ...keys.slice(1)]);

    return [...items].sort((a, b) => {
        const bandA = bandOf(a);
        const bandB = bandOf(b);
        if (bandA !== bandB) return bandA - bandB;

        const result = withinBand(a, b);
        return serpentine && bandA % 2 === 1 ? -result : result;
    });
}

/**
 * Order images along a 3D Hilbert curve through CIE Lab space.
 *
 * Deterministic, O(n log n), and keeps all three colour dimensions in play.
 * This is the one to reach for when you want the grid to read as a smooth
 * two-dimensional colour field rather than a set of stripes.
 */
export function hilbertSort(items, { bits = 8 } = {}) {
    return [...items]
        .map((item) => ({ item, index: hilbertIndexForLab(item.colorInfo, bits) }))
        .sort((a, b) => a.index - b.index || String(a.item.filename).localeCompare(String(b.item.filename)))
        .map(({ item }) => item);
}

/**
 * Greedy nearest-neighbour walk through Lab space using CIEDE2000.
 *
 * Gives the smoothest *adjacent* transitions of any method here, because that
 * is literally what it optimises for. The trade-off is that it is a greedy
 * heuristic for a path-TSP: it can strand outliers, so the last few images may
 * jump. O(n^2), which is fine for the hundreds-of-images scale this tool works
 * at. Starts from the darkest image so runs are reproducible.
 */
export function perceptualSort(items) {
    if (items.length <= 2) return [...items];

    const remaining = [...items].sort(
        (a, b) => a.colorInfo.labL - b.colorInfo.labL ||
            String(a.filename).localeCompare(String(b.filename))
    );

    const ordered = [remaining.shift()];

    while (remaining.length > 0) {
        const current = ordered[ordered.length - 1];
        let bestIndex = 0;
        let bestDistance = Infinity;

        for (let i = 0; i < remaining.length; i++) {
            const distance = colorDistance(current.colorInfo, remaining[i].colorInfo);
            if (distance < bestDistance) {
                bestDistance = distance;
                bestIndex = i;
            }
        }

        ordered.push(remaining.splice(bestIndex, 1)[0]);
    }

    return ordered;
}

/**
 * Sort `items` according to the resolved options.
 *
 * `descending` is applied as a final reversal for every method, so it means the
 * same thing regardless of which strategy produced the ordering.
 *
 * @param {Array} items
 * @param {{method: string, keys: string[], descending?: boolean, bands?: number,
 *          secondaryKey?: string, serpentine?: boolean, hilbertBits?: number}} options
 */
export function sortImages(items, options) {
    const {
        method = SORT_METHODS.NUMERIC,
        keys = ['hue'],
        descending = false,
        bands = 12,
        secondaryKey = 'luma',
        serpentine = false,
        hilbertBits = 8
    } = options;

    let sorted;
    switch (method) {
        case SORT_METHODS.BANDED:
            sorted = bandedSort(items, { keys, bands, secondaryKey, serpentine });
            break;
        case SORT_METHODS.HILBERT:
            sorted = hilbertSort(items, { bits: hilbertBits });
            break;
        case SORT_METHODS.PERCEPTUAL:
            sorted = perceptualSort(items);
            break;
        case SORT_METHODS.NUMERIC:
        default:
            sorted = [...items].sort(createComparator(keys));
            break;
    }

    return descending ? sorted.reverse() : sorted;
}
