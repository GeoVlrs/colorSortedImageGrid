import test from 'node:test';
import assert from 'node:assert/strict';

import { EASINGS, EASING_NAMES, resolveEasing, clamp01, lerp } from '../lib/animate/easing.js';
import {
    cellOriginFor, morphPlan, morphPositionsAt, tileSizeForWidth
} from '../lib/animate/geometry.js';
import { computeCanvasGeometry, placementFor } from '../lib/grid.js';
import { RunError } from '../lib/errors.js';

const GRID = { sortOrder: 'column-major', numRows: 3, numColumns: 3, tileSize: 10, padding: 2 };

test('every easing is anchored at both ends and monotonic', () => {
    // Anchoring is not cosmetic: a morph whose easing misses 1 would stop
    // fractionally short, leaving every tile a pixel or two out of place in
    // the final frame. Written as a property over all easings so future
    // additions are covered without new tests.
    for (const name of EASING_NAMES) {
        const ease = EASINGS[name];
        assert.equal(ease(0), 0, `${name} must start at 0`);
        assert.equal(ease(1), 1, `${name} must end at 1`);

        let previous = -Infinity;
        for (let i = 0; i <= 100; i++) {
            const value = ease(i / 100);
            assert.ok(value >= previous - 1e-12, `${name} went backwards at t=${i / 100}`);
            assert.ok(value >= -1e-9 && value <= 1 + 1e-9, `${name} left [0,1] at t=${i / 100}`);
            previous = value;
        }
    }
});

test('an unknown easing names the valid ones', () => {
    assert.throws(() => resolveEasing('bouncy'), (error) => {
        assert.ok(error instanceof RunError);
        assert.match(error.message, /easeInOutCubic/);
        return true;
    });
});

test('clamp01 and lerp behave at the boundaries', () => {
    assert.equal(clamp01(-3), 0);
    assert.equal(clamp01(3), 1);
    assert.equal(clamp01(0.25), 0.25);
    assert.equal(lerp(10, 20, 0), 10);
    assert.equal(lerp(10, 20, 1), 20);
    assert.equal(lerp(10, 20, 0.5), 15);
});

test('cellOriginFor agrees with the grid module it wraps', () => {
    // The whole point of the wrapper is that an animated frame can never
    // disagree with the still grid about where a tile belongs.
    const geometry = computeCanvasGeometry({
        numRows: 3, numColumns: 3, pxPerImage: 10, padding: 2, borderWidth: 0
    });

    for (let index = 0; index < 9; index++) {
        const { row, col } = placementFor(index, GRID);
        const origin = cellOriginFor(index, { ...GRID, tileSize: geometry.tileSize });
        assert.equal(origin.x, 2 + col * (geometry.tileSize + 2));
        assert.equal(origin.y, 2 + row * (geometry.tileSize + 2));
    }
});

const fakeItems = (n) => Array.from({ length: n }, (_, i) => ({ filename: `${i}.png` }));

test('regression: an already-sorted input morphs to a standstill', () => {
    // If from and to coincide for every tile, frames at t=0 and t=1 must be
    // identical - the natural guard against the plan quietly permuting things.
    const items = fakeItems(9);
    const plan = morphPlan(items, items, GRID);

    for (const entry of plan) {
        assert.deepEqual(entry.from, entry.to);
        assert.equal(entry.distance, 0);
    }
});

test('a reversed sort sends every tile somewhere different', () => {
    const items = fakeItems(9);
    const plan = morphPlan(items, [...items].reverse(), GRID);

    const destinations = new Set(plan.map((e) => `${e.to.x},${e.to.y}`));
    assert.equal(destinations.size, 9, 'no two tiles may share a destination');
    // Only the middle tile of a 9-cell reversal keeps its place.
    assert.equal(plan.filter((e) => e.distance === 0).length, 1);
});

test('every tile arrives exactly at T=1, staggered or not', () => {
    // The (1 - stagger) divisor is what makes this true. Getting it wrong
    // leaves the most-delayed tile short of its destination in the last frame,
    // which is subtle enough to miss by eye.
    const items = fakeItems(9);
    const plan = morphPlan(items, [...items].reverse(), GRID);

    for (const stagger of [0, 0.3, 0.9]) {
        const positions = morphPositionsAt(plan, 1, { stagger, easing: EASINGS.easeInOutCubic });
        for (const position of positions) {
            assert.equal(position.progress, 1, `stagger ${stagger} left a tile at ${position.progress}`);
            assert.equal(position.x, position.entry.to.x);
            assert.equal(position.y, position.entry.to.y);
        }
    }
});

test('at T=0 nothing has moved', () => {
    const items = fakeItems(9);
    const plan = morphPlan(items, [...items].reverse(), GRID);
    const positions = morphPositionsAt(plan, 0, { stagger: 0.3, easing: EASINGS.easeInOutCubic });

    for (const position of positions) {
        assert.equal(position.x, position.entry.from.x);
        assert.equal(position.y, position.entry.from.y);
    }
});

test('stagger delays later tiles rather than moving everything at once', () => {
    const items = fakeItems(9);
    const plan = morphPlan(items, [...items].reverse(), GRID);

    const together = morphPositionsAt(plan, 0.3, { stagger: 0, easing: EASINGS.linear });
    const wave = morphPositionsAt(plan, 0.3, { stagger: 0.9, easing: EASINGS.linear });

    const progressOf = (positions, unsortedIndex) =>
        positions.find((p) => p.entry.unsortedIndex === unsortedIndex).progress;

    // Without stagger every tile shares one progress value.
    assert.equal(progressOf(together, 0), progressOf(together, 8));
    // With it, the last tile is still waiting while the first is under way.
    assert.ok(progressOf(wave, 0) > progressOf(wave, 8));
    assert.equal(progressOf(wave, 8), 0, 'the last tile has not started yet');
});

test('tiles still travelling are drawn before tiles that have landed', () => {
    // Painter's order: arrived tiles must end up on top, or the finished grid
    // would have in-flight tiles buried under it.
    const items = fakeItems(9);
    const plan = morphPlan(items, [...items].reverse(), GRID);
    const positions = morphPositionsAt(plan, 0.5, { stagger: 0.5, easing: EASINGS.linear });

    for (let i = 1; i < positions.length; i++) {
        assert.ok(
            positions[i - 1].remaining >= positions[i].remaining,
            'draw order must run from most to least remaining travel'
        );
    }
});

test('a single tile does not divide by zero', () => {
    const items = fakeItems(1);
    const plan = morphPlan(items, items, GRID);
    const positions = morphPositionsAt(plan, 0.5, { stagger: 0.3, easing: EASINGS.linear });
    assert.equal(positions.length, 1);
    assert.ok(Number.isFinite(positions[0].x));
});

test('tileSizeForWidth inverts the canvas geometry it targets', () => {
    const padding = 4;
    const numColumns = 12;
    const tile = tileSizeForWidth({ numColumns, targetWidth: 720, padding, borderWidth: 0 });

    const { width } = computeCanvasGeometry({
        numRows: 12, numColumns, pxPerImage: tile, padding, borderWidth: 0
    });

    assert.ok(width <= 720, `got ${width}, which overshoots the target`);
    assert.ok(width > 720 - (tile + padding), 'should be within one tile of the target');
});

test('tileSizeForWidth never returns a degenerate tile', () => {
    assert.ok(tileSizeForWidth({ numColumns: 500, targetWidth: 100, padding: 0 }) >= 8);
});
