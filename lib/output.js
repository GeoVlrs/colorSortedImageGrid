// Writing results to disk.

import fs from 'node:fs/promises';
import path from 'node:path';

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

/** The auto-generated output filename, when `--outputFilename` is not given. */
export function defaultOutputFilename(options) {
    const parts = [
        Date.now(),
        `${options.numColumns}x${options.numRows}`,
        options.sortOrder,
        options.sortMethod,
        options.sortKeys.join('-'),
        options.visualizationMode
    ];
    return path.join('./output', `${parts.join('_')}.png`);
}
