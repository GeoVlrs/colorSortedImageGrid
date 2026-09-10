import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { timestampSlug, defaultOutputFilename, ensureUniquePath } from '../lib/output.js';

test('timestampSlug reads directly against a wall clock', () => {
    const slug = timestampSlug(new Date(2026, 8, 10, 14, 5, 9)); // month is 0-indexed
    assert.equal(slug, '2026-09-10_14-05-09');
});

test('a numeric sort is described by its keys, not the word "numeric"', () => {
    const name = defaultOutputFilename({
        numColumns: 4, numRows: 4, sortMethod: 'numeric', sortKeys: ['hue'],
        sortOrder: 'column-major', visualizationMode: 'normal', greyscale: false
    }, new Date(2026, 8, 10, 14, 5, 9));

    assert.equal(name, path.join('./output', '4x4_hue_col_2026-09-10_14-05-09.png'));
});

test('multi-key numeric sorts and descending order both show up', () => {
    const name = defaultOutputFilename({
        numColumns: 4, numRows: 4, sortMethod: 'numeric', sortKeys: ['hue', 'luma'],
        sortOrder: 'row-major', visualizationMode: 'normal', greyscale: false, descending: true
    }, new Date(2026, 8, 10, 14, 5, 9));

    assert.equal(name, path.join('./output', '4x4_hue-luma-desc_row_2026-09-10_14-05-09.png'));
});

test('non-numeric methods are named by method, not by their (irrelevant) sort key', () => {
    for (const method of ['hilbert', 'perceptual', 'banded']) {
        const name = defaultOutputFilename({
            numColumns: 3, numRows: 3, sortMethod: method, sortKeys: ['hue'],
            sortOrder: 'column-major', visualizationMode: 'normal', greyscale: false
        }, new Date(2026, 0, 1, 0, 0, 0));
        assert.match(name, new RegExp(`3x3_${method}_col_`));
    }
});

test('regression: mosaic mode does not produce a filename with two unrelated "4x4"s', () => {
    // A 4x4 grid rendered in --visualizationMode 4x4 must not read as
    // "4x4_..._4x4_..." - the second one is relabelled to "mosaic".
    const name = defaultOutputFilename({
        numColumns: 4, numRows: 4, sortMethod: 'numeric', sortKeys: ['hue'],
        sortOrder: 'column-major', visualizationMode: '4x4', greyscale: false
    }, new Date(2026, 0, 1, 0, 0, 0));

    assert.equal((name.match(/4x4/g) ?? []).length, 1, `expected one "4x4", got: ${name}`);
    assert.match(name, /mosaic/);
});

test('the common case (normal mode, no greyscale) omits both from the filename', () => {
    const name = defaultOutputFilename({
        numColumns: 2, numRows: 2, sortMethod: 'numeric', sortKeys: ['hue'],
        sortOrder: 'column-major', visualizationMode: 'normal', greyscale: false
    }, new Date(2026, 0, 1, 0, 0, 0));

    assert.doesNotMatch(name, /normal/);
    assert.doesNotMatch(name, /grey/);
});

test('dominant mode and greyscale are named when they apply', () => {
    const name = defaultOutputFilename({
        numColumns: 2, numRows: 2, sortMethod: 'numeric', sortKeys: ['hue'],
        sortOrder: 'column-major', visualizationMode: 'dominant', greyscale: true
    }, new Date(2026, 0, 1, 0, 0, 0));

    assert.match(name, /dominant/);
    assert.match(name, /grey/);
});

test('ensureUniquePath passes through a free name untouched', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'csig-unique-'));
    try {
        const candidate = path.join(dir, 'grid.png');
        assert.equal(await ensureUniquePath(candidate), candidate);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('regression: a name collision gets " (2)", not a silent overwrite', async () => {
    // Easy to hit in practice: comparing a few takes on the same folder with
    // identical settings, run within the same second.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'csig-unique-'));
    try {
        await fs.writeFile(path.join(dir, 'grid.png'), 'first');
        await fs.writeFile(path.join(dir, 'grid (1).png'), 'second');

        const resolved = await ensureUniquePath(path.join(dir, 'grid.png'));
        assert.equal(path.basename(resolved), 'grid (2).png');

        // And the originals are untouched.
        assert.equal(await fs.readFile(path.join(dir, 'grid.png'), 'utf8'), 'first');
        assert.equal(await fs.readFile(path.join(dir, 'grid (1).png'), 'utf8'), 'second');
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});
