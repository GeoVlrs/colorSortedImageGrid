import test from 'node:test';
import assert from 'node:assert/strict';
import Jimp from 'jimp';

import * as build from '../lib/animate/modes/build.js';
import * as morph from '../lib/animate/modes/morph.js';
import { createGifSink } from '../lib/animate/gifSink.js';
import { buildGlobalPalette } from '../lib/animate/palette.js';
import { computeGridDimensions, computeCanvasGeometry, composeGrid } from '../lib/grid.js';

const TILE = 8;
const PADDING = 0;
const BACKGROUND = '#ffffff';

/**
 * A context with synthetic tiles.
 *
 * `new Jimp(w, h, int)` is synchronous, so this needs no fixtures and no disk -
 * which is what keeps these tests fast enough to run on every change.
 */
function fakeContext(count, { sortedOrder } = {}) {
    const items = Array.from({ length: count }, (_, i) => ({
        filename: `${String(i).padStart(2, '0')}.png`,
        // A distinct flat colour per tile, so a misplaced tile is detectable.
        // `>>> 0` because shifting into bit 31 otherwise produces a negative
        // number, which Jimp rejects.
        tile: new Jimp(TILE, TILE, (((i * 37 + 20) << 24) | ((i * 91 + 40) << 16) | ((i * 53 + 60) << 8) | 0xff) >>> 0)
    }));

    const grid = computeGridDimensions(count, {});
    const geometry = computeCanvasGeometry({
        ...grid, pxPerImage: TILE, padding: PADDING, borderWidth: 0
    });

    return {
        items,
        sorted: sortedOrder ? sortedOrder.map((i) => items[i]) : [...items].reverse(),
        grid,
        geometry,
        background: BACKGROUND,
        cache: { hits: 0 },
        filePaths: items.map((item) => item.filename),
        gridSpec: {
            sortOrder: 'column-major',
            numRows: grid.numRows,
            numColumns: grid.numColumns,
            tileSize: geometry.tileSize,
            padding: PADDING
        }
    };
}

const TIMING = { fps: 25, delayMs: 40, holdMs: 2000 };

async function collect(generator) {
    const frames = [];
    for await (const frame of generator) {
        // The buffer is borrowed and mutated before the next yield, so anything
        // kept for later comparison must be copied here.
        frames.push({ ...frame, data: Uint8Array.from(frame.data) });
    }
    return frames;
}

// --- the seam ------------------------------------------------------------

test('every frame is a full-buffer RGBA array starting at offset zero', async () => {
    // gifenc reads frames as `new Uint32Array(rgba.buffer)`, ignoring
    // byteOffset. A pooled Buffer or a subarray view would silently encode the
    // wrong bytes, so this precondition is asserted rather than assumed.
    const ctx = fakeContext(9);

    for (const mode of [build, morph]) {
        for await (const frame of mode.frames(ctx, {}, TIMING)) {
            assert.equal(frame.data.byteOffset, 0, `${mode === build ? 'build' : 'morph'} yielded a view`);
            assert.equal(frame.data.length, frame.width * frame.height * 4);
            assert.equal(frame.width, ctx.geometry.width);
        }
    }
});

test('both modes end by holding on the result', async () => {
    const ctx = fakeContext(9);
    for (const mode of [build, morph]) {
        const frames = await collect(mode.frames(ctx, {}, TIMING));
        assert.equal(frames.at(-1).holdMs, TIMING.holdMs);
    }
});

// --- build ---------------------------------------------------------------

test('build emits one empty frame then one per tile', async () => {
    const ctx = fakeContext(9);
    const frames = await collect(build.frames(ctx, {}, TIMING));

    assert.equal(frames.length, 10);
    assert.equal(frames.length, build.estimate(ctx, {}).frames, 'estimate must match reality');
});

test('only the opening frame is a full repaint; the rest are single tiles', async () => {
    // This is what makes the GIF small: everything after frame 0 encodes one
    // tile's worth of pixels instead of the whole canvas.
    const ctx = fakeContext(9);
    const frames = await collect(build.frames(ctx, {}, TIMING));

    assert.equal(frames[0].dirty, null);
    assert.equal(frames[0].keyframe, true);

    const seen = new Set();
    for (const frame of frames.slice(1)) {
        assert.ok(frame.dirty, 'a revealing frame must report its dirty rect');
        assert.equal(frame.dirty.w, TILE);
        assert.equal(frame.dirty.h, TILE);
        seen.add(`${frame.dirty.x},${frame.dirty.y}`);
    }
    assert.equal(seen.size, 9, 'every cell is revealed exactly once');
});

test('regression: the accumulated canvas converges on the real grid', async () => {
    // The strongest check available: after every tile has been revealed, the
    // canvas must be byte-identical to what composeGrid produces directly. If
    // blitting, cell geometry or reveal order drifts, this fails.
    const ctx = fakeContext(9);
    const frames = await collect(build.frames(ctx, {}, TIMING));

    const { image } = await composeGrid(ctx.sorted.map((item) => item.tile), {
        numRows: ctx.grid.numRows,
        numColumns: ctx.grid.numColumns,
        pxPerImage: TILE,
        sortOrder: 'column-major',
        padding: PADDING,
        borderWidth: 0,
        background: BACKGROUND
    });

    assert.deepEqual(
        Buffer.from(frames.at(-1).data),
        Buffer.from(image.bitmap.data),
        'the final build frame differs from a directly composed grid'
    );
});

test('revealPerFrame keeps large collections to a watchable length', async () => {
    assert.equal(build.revealPerFrameFor(100), 1);
    assert.equal(build.revealPerFrameFor(240), 1);
    assert.equal(build.revealPerFrameFor(481), 3);
    assert.equal(build.revealPerFrameFor(1000, 7), 7, 'an explicit value wins');

    const ctx = fakeContext(9);
    const frames = await collect(build.frames(ctx, { revealPerFrame: 3 }, TIMING));
    assert.equal(frames.length, 4, 'one empty frame plus three batches');
    // A batch of three adjacent cells in one column unions into one tall rect.
    assert.equal(frames[1].dirty.h, TILE * 3);
});

// --- morph ---------------------------------------------------------------

test('morph starts on the unsorted layout and ends on the sorted one', async () => {
    // Two buffer comparisons that pin the entire mode: whatever happens in
    // between, it must begin and end at the right arrangements.
    const ctx = fakeContext(9);
    const frames = await collect(morph.frames(ctx, { morphSeconds: 1 }, TIMING));

    const gridOf = async (items) => {
        const { image } = await composeGrid(items.map((item) => item.tile), {
            numRows: ctx.grid.numRows,
            numColumns: ctx.grid.numColumns,
            pxPerImage: TILE,
            sortOrder: 'column-major',
            padding: PADDING,
            borderWidth: 0,
            background: BACKGROUND
        });
        return Buffer.from(image.bitmap.data);
    };

    assert.deepEqual(Buffer.from(frames[0].data), await gridOf(ctx.items), 'first frame is not the unsorted grid');
    assert.deepEqual(Buffer.from(frames.at(-1).data), await gridOf(ctx.sorted), 'last frame is not the sorted grid');
});

test('morph opens with a pause before anything moves', async () => {
    const ctx = fakeContext(9);
    const frames = await collect(morph.frames(ctx, { morphSeconds: 1, morphHoldMs: 900 }, TIMING));
    assert.equal(frames[0].holdMs, 900);
});

test('morph frame count follows morphSeconds and matches its estimate', async () => {
    const ctx = fakeContext(9);
    const options = { morphSeconds: 2 };
    const frames = await collect(morph.frames(ctx, options, TIMING));

    assert.equal(frames.length, morph.estimate(ctx, options, TIMING).frames);
    assert.equal(frames.length, 1 + 2 * TIMING.fps);
});

test('morph repaints in full, so no frame claims a dirty rect', async () => {
    const ctx = fakeContext(9);
    for await (const frame of morph.frames(ctx, { morphSeconds: 1 }, TIMING)) {
        assert.equal(frame.dirty, null);
    }
});

// --- the GIF sink --------------------------------------------------------

/** Walk a GIF's blocks and report what was actually written. */
function inspectGif(bytes) {
    let p = 6;
    const lsdPacked = bytes[p + 4];
    const hasGlobalTable = (lsdPacked & 0x80) !== 0;
    p += 7 + (hasGlobalTable ? 3 * 2 ** ((lsdPacked & 7) + 1) : 0);

    const skipSubBlocks = () => { while (bytes[p] !== 0) p += 1 + bytes[p]; p += 1; };
    const result = { hasGlobalTable, frames: 0, localTables: 0, disposals: [], transparent: 0, delays: [] };

    while (p < bytes.length && bytes[p] !== 0x3b) {
        if (bytes[p] === 0x21) {
            if (bytes[p + 1] === 0xf9) {
                const packed = bytes[p + 3];
                result.disposals.push((packed >> 2) & 7);
                if (packed & 1) result.transparent++;
                result.delays.push(bytes.readUInt16LE(p + 4) * 10);
            }
            p += 2;
            skipSubBlocks();
        } else if (bytes[p] === 0x2c) {
            result.frames++;
            const packed = bytes[p + 9];
            if (packed & 0x80) result.localTables++;
            p += 10 + ((packed & 0x80) ? 3 * 2 ** ((packed & 7) + 1) : 0) + 1;
            skipSubBlocks();
        } else break;
    }
    return result;
}

test('the sink writes one global colour table and no local ones', async () => {
    // Passing the palette on every frame would emit a redundant 768-byte local
    // table each time, which for a 145-frame build is over 100KB of pure waste.
    const ctx = fakeContext(9);
    const frames = await collect(build.frames(ctx, {}, TIMING));
    const { palette, transparentIndex, fallbackIndex } = build.preparePalette(ctx, {});

    const sink = createGifSink({ palette, transparentIndex, fallbackIndex });
    for (const frame of frames) sink.write(frame);
    const { bytes } = sink.end();

    const gif = inspectGif(bytes);
    assert.equal(gif.hasGlobalTable, true);
    assert.equal(gif.localTables, 0);
    assert.equal(gif.frames, frames.length);
});

test('regression: accumulating frames keep the previous frame on screen', async () => {
    // gifenc forces disposal method 2 (clear) whenever `transparent` is set.
    // Without the explicit dispose:1 override, the build animation would show
    // one lone tile blinking on an empty canvas instead of a grid filling up.
    const ctx = fakeContext(9);
    const frames = await collect(build.frames(ctx, {}, TIMING));
    const { palette, transparentIndex, fallbackIndex } = build.preparePalette(ctx, {});

    const sink = createGifSink({ palette, transparentIndex, fallbackIndex });
    for (const frame of frames) sink.write(frame);

    const gif = inspectGif(sink.end().bytes);
    assert.deepEqual([...new Set(gif.disposals)], [1], 'every frame must be do-not-dispose');
    assert.equal(gif.transparent, frames.length - 1, 'all but the opening frame are partial');
});

test('the final hold costs one frame, not sixty', async () => {
    // Expressing duration as a delay rather than repeated frames is what keeps
    // a 2.5s hold from adding 60 near-identical frames to the file.
    const ctx = fakeContext(9);
    const frames = await collect(build.frames(ctx, {}, TIMING));
    const { palette, transparentIndex, fallbackIndex } = build.preparePalette(ctx, {});

    const sink = createGifSink({ palette, transparentIndex, fallbackIndex });
    for (const frame of frames) sink.write(frame);

    const gif = inspectGif(sink.end().bytes);
    assert.equal(gif.delays.at(-1), TIMING.holdMs);
    assert.equal(gif.delays.filter((d) => d === TIMING.holdMs).length, 1);
});

test('the legacy per-frame palette path still emits local tables', async () => {
    // Sweep quantizes each frame independently, as it always has. Its output
    // is deliberately unchanged, which means local colour tables are expected.
    const ctx = fakeContext(4);
    const frames = await collect(morph.frames(ctx, { morphSeconds: 0.2 }, TIMING));

    const sink = createGifSink({ palette: null });
    for (const frame of frames) sink.write(frame);

    const gif = inspectGif(sink.end().bytes);
    assert.equal(gif.localTables, gif.frames - 1, 'only the first frame uses the global table');
});
