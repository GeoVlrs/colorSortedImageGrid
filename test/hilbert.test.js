import test from 'node:test';
import assert from 'node:assert/strict';

import { hilbertIndex, hilbertIndexForLab } from '../lib/hilbert.js';

const BITS = 3;
const SIDE = 1 << BITS; // 8 -> 512 points

test('hilbertIndex is a bijection over the whole cube', () => {
    const seen = new Set();
    for (let x = 0; x < SIDE; x++) {
        for (let y = 0; y < SIDE; y++) {
            for (let z = 0; z < SIDE; z++) {
                seen.add(hilbertIndex([x, y, z], BITS));
            }
        }
    }
    // Every one of the 512 cells must get its own index in [0, 512).
    assert.equal(seen.size, SIDE ** 3);
    assert.equal(Math.min(...seen), 0);
    assert.equal(Math.max(...seen), SIDE ** 3 - 1);
});

test('consecutive Hilbert indices are adjacent in space', () => {
    // This is the property that makes the curve useful for colour sorting:
    // stepping one place along the ordering only ever moves one unit in one
    // axis, so neighbouring images are neighbouring colours.
    const points = [];
    for (let x = 0; x < SIDE; x++) {
        for (let y = 0; y < SIDE; y++) {
            for (let z = 0; z < SIDE; z++) {
                points.push({ p: [x, y, z], i: hilbertIndex([x, y, z], BITS) });
            }
        }
    }
    points.sort((a, b) => a.i - b.i);

    for (let i = 1; i < points.length; i++) {
        const manhattan = points[i].p.reduce(
            (sum, value, axis) => sum + Math.abs(value - points[i - 1].p[axis]),
            0
        );
        assert.equal(manhattan, 1, `step ${i} jumped ${manhattan} units`);
    }
});

test('hilbertIndex clamps out-of-range input instead of producing garbage', () => {
    assert.equal(hilbertIndex([-5, 0, 0], BITS), hilbertIndex([0, 0, 0], BITS));
    assert.equal(hilbertIndex([999, 0, 0], BITS), hilbertIndex([SIDE - 1, 0, 0], BITS));
});

test('hilbertIndexForLab maps the Lab range without collapsing', () => {
    const black = hilbertIndexForLab({ labL: 0, labA: 0, labB: 0 });
    const white = hilbertIndexForLab({ labL: 100, labA: 0, labB: 0 });
    const blue = hilbertIndexForLab({ labL: 30, labA: 68, labB: -112 });

    assert.notEqual(black, white);
    assert.notEqual(black, blue);
    for (const index of [black, white, blue]) {
        assert.ok(Number.isInteger(index) && index >= 0);
    }
});
