// Colour extraction and colour-space conversion.

import Jimp from 'jimp';
import quantize from 'quantize';
import exifr from 'exifr';
import * as culori from 'culori';

export const COLOR_METHODS = Object.freeze({ AVERAGE: 'average', DOMINANT: 'dominant' });

const toLab = culori.converter('lab');
const ciede2000 = culori.differenceCiede2000();

/**
 * RGB (0-255) to HSV, plus HSL lightness.
 *
 * Worth knowing if you are comparing against the original script: it called its
 * output "HSV" but actually computed HSL — `value` was `(max + min) / 2`
 * (lightness) and `saturation` used the HSL formula. Both are now correct for
 * their names, and HSL's lightness is still available as its own `lightness`
 * key, so nothing is lost. Sorting by `value` therefore gives slightly
 * different (correct) results than it used to.
 */
export function rgbToHsv({ r, g, b }) {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;

    const cmax = Math.max(rn, gn, bn);
    const cmin = Math.min(rn, gn, bn);
    const delta = cmax - cmin;

    let hue;
    if (delta === 0) hue = 0;
    else if (cmax === rn) hue = ((gn - bn) / delta) % 6;
    else if (cmax === gn) hue = (bn - rn) / delta + 2;
    else hue = (rn - gn) / delta + 4;

    hue = Math.round(hue * 60);
    if (hue < 0) hue += 360;

    return {
        hue,
        saturation: cmax === 0 ? 0 : (delta / cmax) * 100, // true HSV saturation
        value: cmax * 100,                                  // true HSV value
        lightness: ((cmax + cmin) / 2) * 100                // HSL lightness
    };
}

/** Rec. 601 luma. (The original used rounded 0.3/0.59/0.11 weights.) */
export function rec601Luma({ r, g, b }) {
    return 0.299 * r + 0.587 * g + 0.114 * b;
}

export function toHex({ r, g, b }) {
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Build the full colour record for one RGB triple.
 *
 * Every sort key the tool understands is derived here, so the sorters never
 * need to know anything about colour maths.
 */
export function buildColorInfo(rgb) {
    const { hue, saturation, value, lightness } = rgbToHsv(rgb);
    const hex = toHex(rgb);
    const lab = toLab(hex) ?? { l: 0, a: 0, b: 0 };

    return {
        r: rgb.r,
        g: rgb.g,
        b: rgb.b,
        hex,
        hue,
        saturation,
        value,
        lightness,
        luma: rec601Luma(rgb),
        labL: lab.l ?? 0,
        labA: lab.a ?? 0,
        labB: lab.b ?? 0
    };
}

/** Perceptual distance between two colour records (CIEDE2000). */
export function colorDistance(a, b) {
    return ciede2000(a.hex, b.hex);
}

/**
 * The "average" colour: collapse the image to a single pixel and read it.
 *
 * Note this reads the pixel through `Jimp.intToRGBA` rather than the original's
 * manual hex-string slicing, which silently corrupted the red and green
 * channels whenever the average red byte was below 16 (a pure blue image, for
 * instance, was read as `(80, 15, 255)` instead of `(5, 0, 255)`).
 */
function extractAverageColor(image) {
    const pixel = image.clone().resize(1, 1, Jimp.RESIZE_BICUBIC).getPixelColor(0, 0);
    const { r, g, b } = Jimp.intToRGBA(pixel);
    return { r, g, b };
}

/**
 * The genuinely dominant colour: median-cut quantise a downsampled copy, then
 * pick the palette entry that the most pixels actually map to.
 *
 * This is what the `dominant` visualisation mode always claimed to do. Averaging
 * a half-red, half-blue image gives muddy purple — a colour that appears
 * nowhere in the source. Quantising gives back red or blue, which is what you
 * would point at if asked "what colour is this picture?".
 */
function extractDominantColor(image, sampleSize) {
    const sample = image.clone().resize(sampleSize, sampleSize, Jimp.RESIZE_BILINEAR);

    const pixels = [];
    sample.scan(0, 0, sample.bitmap.width, sample.bitmap.height, function (x, y, idx) {
        const alpha = this.bitmap.data[idx + 3];
        if (alpha < 128) return; // ignore effectively transparent pixels
        pixels.push([this.bitmap.data[idx], this.bitmap.data[idx + 1], this.bitmap.data[idx + 2]]);
    });

    if (pixels.length === 0) return { r: 0, g: 0, b: 0 };

    const colorMap = quantize(pixels, 8);
    if (!colorMap) return extractAverageColor(image);

    // quantize orders its palette by vbox volume*count, which is not the same
    // as "most pixels". Count actual membership so `dominant` means dominant.
    const counts = new Map();
    for (const pixel of pixels) {
        const mapped = colorMap.map(pixel);
        const key = mapped.join(',');
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    let bestKey = null;
    let bestCount = -1;
    for (const [key, count] of counts) {
        if (count > bestCount) {
            bestCount = count;
            bestKey = key;
        }
    }

    const [r, g, b] = bestKey.split(',').map(Number);
    return { r, g, b };
}

/**
 * @param {import('jimp')} image
 * @param {{method: string, sampleSize: number}} options
 */
export function extractColor(image, { method = COLOR_METHODS.AVERAGE, sampleSize = 64 } = {}) {
    return method === COLOR_METHODS.DOMINANT
        ? extractDominantColor(image, sampleSize)
        : extractAverageColor(image);
}

/**
 * Capture date for `--sortParameter dateTaken`.
 *
 * Jimp's JPEG decoder does not expose EXIF at all, hence `exifr`. PNGs
 * generally carry no EXIF, so file mtime is the documented fallback — without
 * it a PNG-heavy folder would have nothing to sort by at all.
 *
 * @returns {Promise<number>} Epoch milliseconds.
 */
export async function readDateTaken(filePath, stats) {
    try {
        const exif = await exifr.parse(filePath, ['DateTimeOriginal', 'CreateDate']);
        const taken = exif?.DateTimeOriginal ?? exif?.CreateDate;
        if (taken instanceof Date && !Number.isNaN(taken.getTime())) return taken.getTime();
    } catch {
        // Unparseable or EXIF-free file: fall through to mtime.
    }
    return stats?.mtimeMs ?? 0;
}
