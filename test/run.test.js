import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { outputPathsFor } from '../lib/run.js';
import { buildParser, resolveOptions } from '../lib/cli.js';

test('outputPathsFor covers every write target', () => {
    assert.deepEqual(
        outputPathsFor({ outputFilename: './out/grid.png' }),
        [path.resolve('./out/grid.png')]
    );
    // "files" mode and the default both write into ./output.
    assert.deepEqual(outputPathsFor({ outputFilename: 'files' }), [path.resolve('./output')]);
    assert.deepEqual(outputPathsFor({}), [path.resolve('./output')]);
});

test('regression: watch mode must not treat its own output as an input', () => {
    // Writing the grid into the folder being watched used to make each render
    // trigger the next one, because the output .png looked like a new input.
    const outputs = outputPathsFor({ outputFilename: './images/test/grid.png' });
    const candidate = path.resolve('./images/test/grid.png');
    assert.ok(outputs.some((o) => candidate === o || candidate.startsWith(o + path.sep)));
});

test('CLI defaults match the documented behaviour', () => {
    const options = resolveOptions(buildParser([]).parseSync());

    assert.equal(options.inputDirectory, './images');
    assert.equal(options.sortMethod, 'numeric');
    assert.deepEqual(options.sortKeys, ['hue']);
    assert.equal(options.sortOrder, 'column-major');
    assert.equal(options.visualizationMode, 'normal');
    assert.equal(options.colorMethod, 'average');
    assert.equal(options.cache, true);
    assert.equal(options.descending, false);
});

test('CLI parses the new sorting flags', () => {
    const options = resolveOptions(
        buildParser(['--sortMethod', 'banded', '-p', 'hue,luma', '-d', '--sortBands', '6']).parseSync()
    );

    assert.equal(options.sortMethod, 'banded');
    assert.deepEqual(options.sortKeys, ['hue', 'luma']);
    assert.equal(options.descending, true);
    assert.equal(options.sortBands, 6);
});

test('dateTaken is only requested when it is actually sorted on', () => {
    assert.equal(resolveOptions(buildParser([]).parseSync()).needsDateTaken, false);
    assert.equal(
        resolveOptions(buildParser(['-p', 'dateTaken']).parseSync()).needsDateTaken,
        true
    );
});

test('invalid options are rejected rather than silently accepted', () => {
    for (const args of [
        ['-p', 'nonsense'],
        ['--sortSecondary', 'nonsense'],
        ['--numRows', '0'],
        ['--concurrency', '-4'],
        ['--padding', '-1'],
        ['--hilbertBits', '99']
    ]) {
        assert.throws(
            () => buildParser(args, { exitOnError: false }).parseSync(),
            `expected ${args.join(' ')} to be rejected`
        );
    }
});
