import test from 'node:test';
import assert from 'node:assert/strict';

import { buildColorInfo } from '../lib/color.js';
import { sortImages, parseSortKeys, SORT_METHODS } from '../lib/sort.js';

const item = (filename, rgb) => ({ filename, colorInfo: buildColorInfo(rgb) });

const RED = item('red.png', { r: 255, g: 0, b: 0 });
const GREEN = item('green.png', { r: 0, g: 255, b: 0 });
const BLUE = item('blue.png', { r: 0, g: 0, b: 255 });
const DARK_RED = item('dark-red.png', { r: 100, g: 0, b: 0 });

const names = (items) => items.map((i) => i.filename);

test('parseSortKeys accepts single and comma-separated keys', () => {
    assert.deepEqual(parseSortKeys('hue'), ['hue']);
    assert.deepEqual(parseSortKeys('hue, luma'), ['hue', 'luma']);
    assert.throws(() => parseSortKeys('nonsense'), /Unknown sort key/);
    assert.throws(() => parseSortKeys(''), /at least one key/);
});

test('numeric sort orders by hue ascending', () => {
    const sorted = sortImages([BLUE, RED, GREEN], { method: SORT_METHODS.NUMERIC, keys: ['hue'] });
    assert.deepEqual(names(sorted), ['red.png', 'green.png', 'blue.png']);
});

test('descending reverses the result', () => {
    const sorted = sortImages([BLUE, RED, GREEN], {
        method: SORT_METHODS.NUMERIC, keys: ['hue'], descending: true
    });
    assert.deepEqual(names(sorted), ['blue.png', 'green.png', 'red.png']);
});

test('a second key breaks ties the first key cannot', () => {
    // Both are hue 0, so hue alone cannot separate them and the filename
    // tiebreak decides. Naming them so filename order and luma order disagree
    // makes the effect of the second key visible.
    const bright = item('a-bright.png', { r: 255, g: 0, b: 0 });
    const dark = item('z-dark.png', { r: 100, g: 0, b: 0 });

    assert.equal(bright.colorInfo.hue, dark.colorInfo.hue);

    const byHue = sortImages([dark, bright], { method: SORT_METHODS.NUMERIC, keys: ['hue'] });
    assert.deepEqual(names(byHue), ['a-bright.png', 'z-dark.png'], 'hue ties fall back to filename');

    const byHueThenLuma = sortImages([bright, dark], { method: SORT_METHODS.NUMERIC, keys: ['hue', 'luma'] });
    assert.deepEqual(names(byHueThenLuma), ['z-dark.png', 'a-bright.png'], 'luma should decide instead');
});

test('ties fall back to filename so runs are reproducible', () => {
    const a = item('b.png', { r: 10, g: 10, b: 10 });
    const b = item('a.png', { r: 10, g: 10, b: 10 });
    const sorted = sortImages([a, b], { method: SORT_METHODS.NUMERIC, keys: ['hue'] });
    assert.deepEqual(names(sorted), ['a.png', 'b.png']);
});

test('banded sort groups by band, then orders within it', () => {
    const brightRed = item('bright.png', { r: 255, g: 0, b: 0 });
    const dimRed = item('dim.png', { r: 90, g: 0, b: 0 });
    const someBlue = item('blue.png', { r: 0, g: 0, b: 255 });

    const sorted = sortImages([brightRed, someBlue, dimRed], {
        method: SORT_METHODS.BANDED, keys: ['hue'], bands: 12, secondaryKey: 'luma'
    });

    // Both reds share a hue band and sort dim-then-bright inside it; blue is a
    // later band regardless of its brightness.
    assert.deepEqual(names(sorted), ['dim.png', 'bright.png', 'blue.png']);
});

test('serpentine flips the direction of every other band', () => {
    const brightRed = item('bright.png', { r: 255, g: 0, b: 0 });
    const dimRed = item('dim.png', { r: 90, g: 0, b: 0 });

    const plain = sortImages([brightRed, dimRed], {
        method: SORT_METHODS.BANDED, keys: ['hue'], bands: 2, secondaryKey: 'luma', serpentine: false
    });
    const snake = sortImages([brightRed, dimRed], {
        method: SORT_METHODS.BANDED, keys: ['hue'], bands: 2, secondaryKey: 'luma', serpentine: true
    });

    // Band 0 (hue 0) is unaffected by serpentine; both reds live there.
    assert.deepEqual(names(plain), names(snake));
});

test('hilbert and perceptual sorts return every input exactly once', () => {
    const input = [BLUE, RED, GREEN, DARK_RED];
    for (const method of [SORT_METHODS.HILBERT, SORT_METHODS.PERCEPTUAL]) {
        const sorted = sortImages(input, { method, keys: ['hue'] });
        assert.equal(sorted.length, input.length, `${method} changed the item count`);
        assert.deepEqual(names(sorted).sort(), names(input).sort(), `${method} lost or duplicated an item`);
    }
});

test('perceptual sort starts dark and keeps similar colours adjacent', () => {
    const sorted = sortImages([RED, DARK_RED, BLUE, GREEN], { method: SORT_METHODS.PERCEPTUAL, keys: ['hue'] });
    // Darkest first by construction, and the two reds should end up neighbours.
    assert.equal(sorted[0].filename, 'dark-red.png');
    const positions = names(sorted);
    assert.equal(Math.abs(positions.indexOf('dark-red.png') - positions.indexOf('red.png')), 1);
});

test('sorting never mutates the input array', () => {
    const input = [BLUE, RED, GREEN];
    const before = names(input);
    sortImages(input, { method: SORT_METHODS.NUMERIC, keys: ['hue'] });
    assert.deepEqual(names(input), before);
});
