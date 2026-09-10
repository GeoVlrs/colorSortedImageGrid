import test from 'node:test';
import assert from 'node:assert/strict';
import Jimp from 'jimp';

import { buildGlobalPalette, clampReserved, sampleFromTiles, PALETTE_FORMAT } from '../lib/animate/palette.js';
import { applyPalette } from '../lib/animate/gifenc.js';

/** A flat RGBA buffer of `count` pixels cycling through `colors`. */
function sampleOf(colors, count = 256) {
    const data = new Uint8Array(count * 4);
    for (let i = 0; i < count; i++) {
        const [r, g, b] = colors[i % colors.length];
        data.set([r, g, b, 255], i * 4);
    }
    return data;
}

test('reserving a transparent slot puts it at index 0', () => {
    // Index 0 and not the end: quantize may return fewer colours than asked
    // for, so a trailing sentinel's index would depend on the input - the kind
    // of thing that works on a test folder and breaks on a real collection.
    const { palette, transparentIndex, fallbackIndex } = buildGlobalPalette(
        sampleOf([[10, 20, 30], [200, 100, 50]]),
        { reserveTransparent: true }
    );

    assert.equal(transparentIndex, 0);
    assert.ok(palette.length <= 256);
    assert.ok(fallbackIndex >= 1, 'the fallback must be a real colour, not the sentinel');
    assert.ok(fallbackIndex < palette.length);
});

test('without a reservation there is no transparent index', () => {
    const { transparentIndex } = buildGlobalPalette(sampleOf([[1, 2, 3]]), { reserveTransparent: false });
    assert.equal(transparentIndex, null);
});

test('a palette shorter than requested still reserves index 0', () => {
    // Two distinct colours in, so quantize returns nowhere near 256.
    const { palette, transparentIndex } = buildGlobalPalette(
        sampleOf([[0, 0, 0], [255, 255, 255]]),
        { reserveTransparent: true }
    );
    assert.ok(palette.length < 256, `expected a short palette, got ${palette.length}`);
    assert.equal(transparentIndex, 0);
});

test('regression: a pixel nearest the sentinel never encodes as transparent', () => {
    // The reserved slot is a real palette entry, and gifenc's nearest-colour
    // search has no notion of "reserved" - any pixel with no closer entry will
    // select it and be written as transparent, punching a hole through the
    // frame. Here the palette is built from dark greens with no magenta in it,
    // so a magenta pixel really does land on the sentinel.
    const { palette, transparentIndex, fallbackIndex } = buildGlobalPalette(
        sampleOf([[0, 90, 0], [10, 40, 10], [0, 20, 0]]),
        { reserveTransparent: true }
    );

    const frame = sampleOf([[255, 0, 255], [0, 90, 0]], 32);
    const raw = applyPalette(frame, palette, PALETTE_FORMAT);

    assert.ok(
        Array.from(raw).includes(transparentIndex),
        'this test is pointless unless the raw output really does hit the reserved slot'
    );

    const clamped = clampReserved(Uint8Array.from(raw), transparentIndex, fallbackIndex);
    assert.ok(!Array.from(clamped).includes(transparentIndex), 'the reserved index leaked through');
});

test('clampReserved leaves everything else alone', () => {
    const indices = Uint8Array.from([0, 1, 2, 0, 3]);
    const result = clampReserved(indices, 0, 7);
    assert.deepEqual(Array.from(result), [7, 1, 2, 7, 3]);
});

test('clampReserved is a no-op when nothing is reserved', () => {
    const indices = Uint8Array.from([0, 1, 2]);
    assert.deepEqual(Array.from(clampReserved(indices, null, 9)), [0, 1, 2]);
});

test('the tile sample is contiguous and starts at offset zero', () => {
    // quantize does `new Uint32Array(rgba.buffer)`, ignoring byteOffset, so a
    // view into a larger buffer would quantize the wrong bytes entirely.
    const tiles = [new Jimp(4, 4, 0xff0000ff), new Jimp(4, 4, 0x00ff00ff)];
    const sample = sampleFromTiles(tiles);

    assert.equal(sample.byteOffset, 0);
    assert.equal(sample.length, 2 * 4 * 4 * 4);
    assert.equal(sample.buffer.byteLength, sample.length, 'must own its buffer exactly');
});
