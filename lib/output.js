// Writing results to disk.

import fs from 'node:fs/promises';
import path from 'node:path';

import { SORT_METHODS, SORT_ORDERS } from './sort.js';

/**
 * Ensure a file's directory exists before writing into it.
 *
 * The original assumed `./output/` was already there — it is in a fresh clone,
 * but not after the folder is cleaned, and the resulting failure was silent.
 */
async function ensureDirectoryFor(filePath) {
    await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
}

/** Write a single composed grid image. */
export async function writeGridImage(image, outputPath) {
    await ensureDirectoryFor(outputPath);
    await image.writeAsync(outputPath);
    return path.resolve(outputPath);
}

/**
 * Write each sorted tile as its own numbered file.
 * (`--outputFilename files`, kept for compatibility with the original.)
 */
export async function writeNumberedFiles(tiles, outputDirectory) {
    await fs.mkdir(path.resolve(outputDirectory), { recursive: true });
    const width = String(tiles.length).length;

    for (let i = 0; i < tiles.length; i++) {
        const name = `${String(i + 1).padStart(width, '0')}.png`;
        await tiles[i].writeAsync(path.join(outputDirectory, name));
    }

    return path.resolve(outputDirectory);
}

/**
 * Export the extracted palette in sorted order.
 *
 * Format follows the file extension: `.css` emits custom properties, anything
 * else emits JSON. The data is already in memory, so this is pure
 * serialisation.
 */
export async function exportPalette(items, outputPath) {
    await ensureDirectoryFor(outputPath);
    const extension = path.extname(outputPath).toLowerCase();

    let contents;
    if (extension === '.css') {
        const properties = items
            .map((item, index) => `  --color-${index + 1}: ${item.colorInfo.hex}; /* ${item.filename} */`)
            .join('\n');
        contents = `:root {\n${properties}\n}\n`;
    } else {
        contents = `${JSON.stringify(
            items.map((item) => ({
                filename: item.filename,
                hex: item.colorInfo.hex,
                rgb: { r: item.colorInfo.r, g: item.colorInfo.g, b: item.colorInfo.b },
                hsv: {
                    hue: item.colorInfo.hue,
                    saturation: Number(item.colorInfo.saturation.toFixed(2)),
                    value: Number(item.colorInfo.value.toFixed(2))
                },
                lab: {
                    L: Number(item.colorInfo.labL.toFixed(2)),
                    a: Number(item.colorInfo.labA.toFixed(2)),
                    b: Number(item.colorInfo.labB.toFixed(2))
                },
                luma: Number(item.colorInfo.luma.toFixed(2))
            })),
            null,
            2
        )}\n`;
    }

    await fs.writeFile(outputPath, contents, 'utf8');
    return path.resolve(outputPath);
}

/**
 * `YYYY-MM-DD_HH-MM-SS` in local time.
 *
 * Local, not UTC or a raw epoch number: the point is that someone looking at
 * their own file listing can read it directly against their own clock,
 * without doing epoch-millisecond arithmetic in their head.
 */
export function timestampSlug(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
        `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

/**
 * How each cell was rendered, for the filename.
 *
 * Deliberately not the raw `--visualizationMode` value: it is literally the
 * string `"4x4"`, which next to a `4x4` *grid-dimensions* segment (a 2x2 grid
 * rendered in mosaic mode, say) would put two unrelated "4x4"s side by side in
 * the same filename. `normal` - by far the common case - is omitted entirely,
 * so a plain photo grid gets a plain filename.
 */
const VISUALIZATION_LABELS = { '4x4': 'mosaic', dominant: 'dominant' };

/**
 * Describe the sort for the filename.
 *
 * For a numeric sort the keys ARE the description ("hue", "hue-luma"); for the
 * other methods the key list is either meaningless (hilbert/perceptual derive
 * their own ordering from Lab) or secondary to the method name (banded), so
 * the method name is used instead.
 */
function describeSort({ sortMethod, sortKeys, descending }) {
    const base = sortMethod === SORT_METHODS.NUMERIC ? sortKeys.join('-') : sortMethod;
    return descending ? `${base}-desc` : base;
}

/**
 * If `candidatePath` already exists, find a free name next to it by appending
 * " (2)", " (3)", and so on - the same convention a desktop file manager uses
 * on a save conflict. Only meant for auto-generated names: an explicit
 * `--outputFilename` is a deliberate choice and is written as given,
 * overwriting if that is what already exists there.
 */
export async function ensureUniquePath(candidatePath) {
    const extension = path.extname(candidatePath);
    const base = candidatePath.slice(0, candidatePath.length - extension.length);

    let attempt = 0;
    let current = candidatePath;
    for (;;) {
        try {
            await fs.access(current);
        } catch {
            return current; // Nothing there: this name is free.
        }
        attempt++;
        current = `${base} (${attempt})${extension}`;
    }
}

/**
 * The auto-generated output filename, when `--outputFilename` is not given.
 *
 * Descriptive parts first, timestamp last: runs with the same settings sort
 * next to each other in a file listing (useful when comparing a few takes on
 * the same folder), rather than being scattered by the moment they happened
 * to be generated.
 */
export function defaultOutputFilename(options, now = new Date()) {
    const modeLabel = VISUALIZATION_LABELS[options.visualizationMode];

    const parts = [
        `${options.numColumns}x${options.numRows}`,
        describeSort(options),
        options.sortOrder === SORT_ORDERS.ROW_MAJOR ? 'row' : 'col'
    ];
    if (modeLabel) parts.push(modeLabel);
    if (options.greyscale) parts.push('grey');
    parts.push(timestampSlug(now));

    return path.join('./output', `${parts.join('_')}.png`);
}

/**
 * The auto-generated filename for an animation.
 *
 * Sweep keeps its historical `<whatWasSwept>-sweep_<timestamp>.gif` name, since
 * that is what the README documents and what existing output is called. The
 * newer modes are named after themselves plus what they sorted by, which is the
 * part that actually distinguishes two runs over the same folder.
 */
export function defaultAnimationFilename(options, now = new Date()) {
    const label = options.animateMode === 'sweep' || !options.animateMode
        ? `${options.animateOver}-sweep`
        : `${options.animateMode}_${describeSort(options)}`;

    return path.join('./output', `${label}_${timestampSlug(now)}.gif`);
}
