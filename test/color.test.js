import test from 'node:test';
import assert from 'node:assert/strict';
import Jimp from 'jimp';

import { rgbToHsv, buildColorInfo, toHex, extractColor, colorDistance, COLOR_METHODS } from '../lib/color.js';

test('regression: colours with a very low red channel are read correctly', async () => {
    // The original derived the colour with
    //   getPixelColor(0,0).toString(16).substr(0,6).padStart(6,'0')
    // which drops leading zero *nibbles* from the whole 32-bit value, so the
    // slice was misaligned whenever red was below 16. (5, 0, 255) came back as
    // (80, 15, 255) - a completely different colour, silently.
    const image = await Jimp.create(8, 8, Jimp.rgbaToInt(5, 0, 255, 255));

    const legacyHex = image.getPixelColor(0, 0).toString(16).substr(0, 6).padStart(6, '0');
    assert.notEqual(legacyHex, '0500ff', 'the legacy approach should be demonstrably wrong here');

    const extracted = extractColor(image, { method: COLOR_METHODS.AVERAGE });
    assert.deepEqual(extracted, { r: 5, g: 0, b: 255 });
});

test('average colour of a solid image is that colour', async () => {
    const image = await Jimp.create(16, 16, Jimp.rgbaToInt(12, 200, 7, 255));
    assert.deepEqual(extractColor(image, { method: COLOR_METHODS.AVERAGE }), { r: 12, g: 200, b: 7 });
});

test('dominant colour picks the majority region, not the blend', async () => {
    // Three quarters red, one quarter blue. The average is a muddy purple that
    // appears nowhere in the image; the dominant colour should be red.
    const image = await Jimp.create(16, 16, Jimp.rgbaToInt(255, 0, 0, 255));
    image.scan(0, 0, 16, 4, function (x, y, idx) {
        this.bitmap.data[idx] = 0;
        this.bitmap.data[idx + 1] = 0;
        this.bitmap.data[idx + 2] = 255;
    });

    const average = extractColor(image, { method: COLOR_METHODS.AVERAGE });
    const dominant = extractColor(image, { method: COLOR_METHODS.DOMINANT, sampleSize: 32 });

    assert.ok(average.b > 30, 'the average should be contaminated by the blue quarter');
    assert.ok(dominant.r > 200 && dominant.b < 60, `expected a red-ish dominant colour, got ${JSON.stringify(dominant)}`);
});

test('HSV conversion matches its name', () => {
    // The original called this HSV but computed HSL: value was (max+min)/2.
    // For pure red, HSV value is 100 and HSL lightness is 50.
    const red = rgbToHsv({ r: 255, g: 0, b: 0 });
    assert.equal(red.hue, 0);
    assert.equal(Math.round(red.saturation), 100);
    assert.equal(Math.round(red.value), 100);
    assert.equal(Math.round(red.lightness), 50);

    assert.equal(rgbToHsv({ r: 0, g: 255, b: 0 }).hue, 120);
    assert.equal(rgbToHsv({ r: 0, g: 0, b: 255 }).hue, 240);

    const grey = rgbToHsv({ r: 128, g: 128, b: 128 });
    assert.equal(grey.hue, 0);
    assert.equal(grey.saturation, 0);
});

test('hex formatting zero-pads every channel', () => {
    assert.equal(toHex({ r: 5, g: 0, b: 255 }), '#0500ff');
    assert.equal(toHex({ r: 0, g: 0, b: 0 }), '#000000');
    assert.equal(toHex({ r: 255, g: 255, b: 255 }), '#ffffff');
});

test('colour records carry every sort key', () => {
    const info = buildColorInfo({ r: 5, g: 0, b: 255 });
    for (const key of ['hue', 'saturation', 'value', 'lightness', 'luma', 'labL', 'labA', 'labB', 'hex']) {
        assert.ok(info[key] !== undefined, `missing ${key}`);
    }
    assert.equal(info.hex, '#0500ff');
});

test('perceptual distance ranks similar colours closer', () => {
    const blue = buildColorInfo({ r: 0, g: 0, b: 255 });
    const nearlyBlue = buildColorInfo({ r: 5, g: 0, b: 250 });
    const yellow = buildColorInfo({ r: 255, g: 255, b: 0 });

    assert.ok(colorDistance(blue, nearlyBlue) < colorDistance(blue, yellow));
});
