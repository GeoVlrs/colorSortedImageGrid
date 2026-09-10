import test from 'node:test';
import assert from 'node:assert/strict';

import {
    quantizeGifDelay, snapFpsForGif, holdToFrames, resolveTiming
} from '../lib/animate/timing.js';
import { GIF_MIN_DELAY_MS } from '../lib/animate/constants.js';
import { RunError } from '../lib/errors.js';

test('delays are rounded onto the 10ms grid GIF actually stores', () => {
    // gifenc does Math.round(delay / 10) and the format stores centiseconds,
    // so anything finer is silently lost.
    assert.equal(quantizeGifDelay(1000 / 24), 40, '24fps cannot be represented');
    assert.equal(quantizeGifDelay(40), 40);
    assert.equal(quantizeGifDelay(600), 600);
    assert.equal(quantizeGifDelay(2000), 2000);
    assert.equal(quantizeGifDelay(44), 40);
    assert.equal(quantizeGifDelay(46), 50);
});

test('regression: delays below the floor are raised, not passed through', () => {
    // Browsers clamp very short delays to their own default, so a 5ms request
    // would play at a speed nobody asked for. Better to be visibly slower than
    // invisibly wrong.
    assert.equal(quantizeGifDelay(5), GIF_MIN_DELAY_MS);
    assert.equal(quantizeGifDelay(0), GIF_MIN_DELAY_MS);
});

test('snapFpsForGif reports when a frame rate could not be honoured', () => {
    const snapped = snapFpsForGif(24);
    assert.equal(snapped.delayMs, 40);
    assert.equal(snapped.fps, 25);
    assert.equal(snapped.snapped, true, '24fps must be reported as adjusted');

    for (const exact of [20, 25, 50]) {
        assert.equal(snapFpsForGif(exact).snapped, false, `${exact}fps lands on the grid exactly`);
    }
});

test('the default frame rate needs no adjustment', () => {
    // The reason the default is 25 rather than the more familiar 24: it is
    // exact, so a normal run never prints a snap notice.
    const { notices } = resolveTiming({});
    assert.deepEqual(notices, []);
});

test('an unrepresentable frame rate is refused with an actionable message', () => {
    assert.throws(() => resolveTiming({ animateFps: 200 }), (error) => {
        assert.ok(error instanceof RunError);
        assert.match(error.message, /below the 20ms floor/);
        assert.match(error.message, /--animateFps 50 or lower/);
        return true;
    });
});

test('a snapped frame rate is reported once, not silently applied', () => {
    const { fps, delayMs, notices } = resolveTiming({ animateFps: 24 });
    assert.equal(delayMs, 40);
    assert.equal(fps, 25);
    assert.equal(notices.length, 1);
    assert.match(notices[0], /24fps was snapped to 25fps/);
});

test('a non-positive frame rate is rejected', () => {
    assert.throws(() => resolveTiming({ animateFps: 0 }), RunError);
    assert.throws(() => resolveTiming({ animateFps: -5 }), RunError);
});

test('holds never collapse to zero frames', () => {
    assert.equal(holdToFrames(2000, 25), 50);
    assert.equal(holdToFrames(40, 25), 1);
    assert.equal(holdToFrames(0, 25), 1, 'a zero hold is still one frame, not none');
});
