import test from 'node:test';
import assert from 'node:assert/strict';

import { placementFor, computeGridDimensions, computeCanvasGeometry, parseColor } from '../lib/grid.js';
import { SORT_ORDERS } from '../lib/sort.js';

test('column-major fills top-to-bottom, then across', () => {
    const grid = { sortOrder: SORT_ORDERS.COLUMN_MAJOR, numRows: 2, numColumns: 3 };
    assert.deepEqual(placementFor(0, grid), { row: 0, col: 0 });
    assert.deepEqual(placementFor(1, grid), { row: 1, col: 0 });
    assert.deepEqual(placementFor(2, grid), { row: 0, col: 1 });
    assert.deepEqual(placementFor(5, grid), { row: 1, col: 2 });
});

test('row-major fills left-to-right, then down', () => {
    const grid = { sortOrder: SORT_ORDERS.ROW_MAJOR, numRows: 2, numColumns: 3 };
    assert.deepEqual(placementFor(0, grid), { row: 0, col: 0 });
    assert.deepEqual(placementFor(1, grid), { row: 0, col: 1 });
    assert.deepEqual(placementFor(3, grid), { row: 1, col: 0 });
    assert.deepEqual(placementFor(5, grid), { row: 1, col: 2 });
});

test('regression: row-major and column-major actually differ', () => {
    // The original always iterated x on the outside and only swapped the loop
    // *bounds*, so on a square grid the two orders produced byte-identical
    // output and on a non-square grid row-major ran off the canvas.
    const square = { numRows: 3, numColumns: 3 };
    const differs = [0, 1, 2, 3, 4, 5, 6, 7, 8].some((i) => {
        const a = placementFor(i, { ...square, sortOrder: SORT_ORDERS.ROW_MAJOR });
        const b = placementFor(i, { ...square, sortOrder: SORT_ORDERS.COLUMN_MAJOR });
        return a.row !== b.row || a.col !== b.col;
    });
    assert.ok(differs, 'row-major must not be a no-op on a square grid');
});

test('every placement stays inside a non-square grid', () => {
    for (const sortOrder of Object.values(SORT_ORDERS)) {
        const grid = { sortOrder, numRows: 2, numColumns: 5 };
        const seen = new Set();
        for (let i = 0; i < 10; i++) {
            const { row, col } = placementFor(i, grid);
            assert.ok(row >= 0 && row < 2, `row ${row} out of range for ${sortOrder}`);
            assert.ok(col >= 0 && col < 5, `col ${col} out of range for ${sortOrder}`);
            seen.add(`${row},${col}`);
        }
        assert.equal(seen.size, 10, `${sortOrder} reused a cell`);
    }
});

test('grid dimensions follow the documented rules', () => {
    assert.deepEqual(computeGridDimensions(9, {}), { numRows: 3, numColumns: 3 });
    assert.deepEqual(computeGridDimensions(10, {}), { numRows: 4, numColumns: 4 });
    assert.deepEqual(computeGridDimensions(10, { numRows: 2 }), { numRows: 2, numColumns: 5 });
    assert.deepEqual(computeGridDimensions(10, { numColumns: 4 }), { numRows: 3, numColumns: 4 });
    assert.deepEqual(computeGridDimensions(10, { numRows: 2, numColumns: 9 }), { numRows: 2, numColumns: 9 });
});

test('canvas geometry accounts for padding and borders', () => {
    const plain = computeCanvasGeometry({ numRows: 2, numColumns: 3, pxPerImage: 100, padding: 0, borderWidth: 0 });
    assert.deepEqual(plain, { tileSize: 100, width: 300, height: 200 });

    const spaced = computeCanvasGeometry({ numRows: 2, numColumns: 3, pxPerImage: 100, padding: 10, borderWidth: 5 });
    assert.equal(spaced.tileSize, 110);
    assert.equal(spaced.width, 10 + 3 * 120);
    assert.equal(spaced.height, 10 + 2 * 120);
});

test('parseColor accepts CSS colour syntax', () => {
    assert.equal(typeof parseColor('#ff0000'), 'number');
    assert.equal(parseColor('#ff0000'), parseColor('red'));
    assert.notEqual(parseColor('white'), parseColor('black'));
    assert.throws(() => parseColor('definitely-not-a-colour'));
});
