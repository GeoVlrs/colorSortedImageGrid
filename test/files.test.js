import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isSupportedImage, discoverImages, InputDirectoryError } from '../lib/files.js';
import { mapWithConcurrency } from '../lib/pool.js';

test('regression: .jpeg files are recognised', () => {
    // The original filtered with `name.indexOf('.jpg') > -1`, and ".jpg" is not
    // a substring of ".jpeg", so every .jpeg file was silently dropped.
    assert.ok(isSupportedImage('photo.jpeg'));
    assert.ok(isSupportedImage('photo.jpg'));
});

test('extension matching is case-insensitive and anchored to the extension', () => {
    assert.ok(isSupportedImage('PHOTO.JPG'));
    assert.ok(isSupportedImage('photo.PNG'));
    // Substring matching used to accept this; a real extension check does not.
    assert.equal(isSupportedImage('notes.jpg.txt'), false);
    assert.equal(isSupportedImage('readme.md'), false);
});

test('formats Jimp already bundles are supported', () => {
    for (const name of ['a.bmp', 'a.tif', 'a.tiff', 'a.gif']) {
        assert.ok(isSupportedImage(name), `${name} should be supported`);
    }
});

test('discoverImages finds images, skips other files, and sorts results', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'csig-'));
    try {
        await fs.writeFile(path.join(dir, 'b.png'), '');
        await fs.writeFile(path.join(dir, 'a.jpeg'), '');
        await fs.writeFile(path.join(dir, 'notes.txt'), '');
        await fs.mkdir(path.join(dir, 'nested'));
        await fs.writeFile(path.join(dir, 'nested', 'c.png'), '');

        const flat = await discoverImages(dir);
        assert.deepEqual(flat.map((p) => path.basename(p)), ['a.jpeg', 'b.png']);

        const deep = await discoverImages(dir, { recursive: true });
        assert.deepEqual(deep.map((p) => path.basename(p)).sort(), ['a.jpeg', 'b.png', 'c.png']);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('a missing input directory raises a friendly error', async () => {
    await assert.rejects(
        () => discoverImages(path.join(os.tmpdir(), 'definitely-not-here-12345')),
        (error) => {
            assert.ok(error instanceof InputDirectoryError);
            assert.match(error.message, /not found/);
            return true;
        }
    );
});

test('the worker pool preserves input order and isolates failures', async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await mapWithConcurrency(items, 2, async (n) => {
        if (n === 3) throw new Error('bad item');
        // Reverse the natural completion order to prove ordering is by input.
        await new Promise((resolve) => setTimeout(resolve, (6 - n) * 5));
        return n * 10;
    });

    assert.equal(results.length, 5);
    assert.deepEqual(results.map((r) => r.status), [
        'fulfilled', 'fulfilled', 'rejected', 'fulfilled', 'fulfilled'
    ]);
    assert.deepEqual(
        results.filter((r) => r.status === 'fulfilled').map((r) => r.value),
        [10, 20, 40, 50]
    );
    assert.match(results[2].reason.message, /bad item/);
});

test('the worker pool respects its concurrency ceiling', async () => {
    let active = 0;
    let peak = 0;

    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
    });

    assert.ok(peak <= 3, `peak concurrency was ${peak}, expected at most 3`);
});
