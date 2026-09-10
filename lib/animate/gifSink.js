// Turns a stream of frames into GIF bytes.
//
// Kept free of file I/O so it can be driven from a test with a few 16x16
// frames and the resulting bytes inspected directly.

import { GIFEncoder, quantize, applyPalette } from './gifenc.js';
import { clampReserved, PALETTE_FORMAT } from './palette.js';
import { quantizeGifDelay } from './timing.js';

/**
 * @param {object} options
 * @param {number[][]|null} options.palette One global palette written as the
 *   GCT. Pass null for the legacy per-frame path (see below).
 * @param {number|null} options.transparentIndex Reserved slot, or null when
 *   the animation has no accumulating frames.
 * @param {number} [options.fallbackIndex] Where sentinel-coloured pixels go.
 * @param {{frames: number, width: number, height: number}} [options.estimate]
 */
export function createGifSink({ palette = null, transparentIndex = null, fallbackIndex = 0, estimate }) {
    // The output stream reallocates and copies its whole contents every time it
    // grows. Guessing high once is far cheaper than 40 doublings; 6% of raw
    // pixel count is a reasonable guess for LZW over indexed data.
    const guess = estimate
        ? estimate.frames * estimate.width * estimate.height * 0.06
        : 1 << 20;
    const initialCapacity = Math.min(1 << 28, Math.max(1 << 20, Math.round(guess)));

    const encoder = GIFEncoder({ initialCapacity });

    // When no global palette is supplied, each frame is quantized on its own
    // and carries its own colour table. That is what the sweep mode did before
    // this refactor, and sweep is only a handful of frames, so keeping the
    // legacy path costs nothing and keeps its output unchanged.
    const perFramePalette = palette === null;

    let wroteGlobalTable = false;
    let frameCount = 0;

    let indexBuffer = null;
    const scratchByLength = new Map();

    /**
     * applyPalette does `new Uint32Array(rgba.buffer)`, ignoring both
     * byteOffset and length, so it must be handed a buffer that is exactly the
     * region of interest. A subarray of a larger scratch would silently encode
     * whatever trailing bytes happened to follow.
     */
    const scratchFor = (byteLength) => {
        let scratch = scratchByLength.get(byteLength);
        if (!scratch) {
            scratch = new Uint8Array(byteLength);
            scratchByLength.set(byteLength, scratch);
        }
        return scratch;
    };

    const writeFull = (frame, delay) => {
        if (perFramePalette) {
            const framePalette = quantize(frame.data, 256);
            encoder.writeFrame(applyPalette(frame.data, framePalette), frame.width, frame.height, {
                palette: framePalette,
                delay
            });
            wroteGlobalTable = true;
            return;
        }

        const indices = clampReserved(
            applyPalette(frame.data, palette, PALETTE_FORMAT),
            transparentIndex,
            fallbackIndex
        );

        encoder.writeFrame(indices, frame.width, frame.height, {
            // Both of these are read from the FIRST frame only. `palette` here
            // becomes the Global Color Table; passing it again on later frames
            // would emit a redundant 768-byte local table every time.
            ...(wroteGlobalTable ? {} : { palette, repeat: 0 }),
            delay,
            transparent: false,
            // Only meaningful when later frames will draw on top of this one.
            // Omitted otherwise so a plain animation's bytes stay minimal.
            ...(transparentIndex === null ? {} : { dispose: 1 })
        });

        wroteGlobalTable = true;
    };

    const writePartial = (frame, delay) => {
        const { x, y, w, h } = frame.dirty;

        if (!indexBuffer || indexBuffer.length !== frame.width * frame.height) {
            indexBuffer = new Uint8Array(frame.width * frame.height);
        }
        // Everything outside the dirty rect is transparent, so the decoder
        // leaves the previous frame's pixels alone. LZW collapses these long
        // identical runs to almost nothing, which is what makes the build
        // mode's GIF a few hundred KB rather than tens of megabytes.
        indexBuffer.fill(transparentIndex);

        // Copy the dirty region out tightly packed.
        const rect = scratchFor(w * h * 4);
        const rowBytes = w * 4;
        for (let row = 0; row < h; row++) {
            const from = (frame.width * (y + row) + x) * 4;
            rect.set(frame.data.subarray(from, from + rowBytes), row * rowBytes);
        }

        const rectIndices = clampReserved(
            applyPalette(rect, palette, PALETTE_FORMAT),
            transparentIndex,
            fallbackIndex
        );

        for (let row = 0; row < h; row++) {
            indexBuffer.set(
                rectIndices.subarray(row * w, (row + 1) * w),
                frame.width * (y + row) + x
            );
        }

        encoder.writeFrame(indexBuffer, frame.width, frame.height, {
            delay,
            transparent: true,
            transparentIndex,
            // MANDATORY. gifenc forces disposal method 2 (restore to
            // background) whenever `transparent` is set - see its
            // encodeGraphicControlExt. Without this explicit override every
            // frame would clear the canvas first, and the animation would show
            // one lone tile blinking on an empty grid instead of accumulating.
            dispose: 1
        });
    };

    return {
        format: 'gif',

        write(frame) {
            const delay = quantizeGifDelay(frame.holdMs);
            // A partial frame is only legal once something is already on screen
            // for it to draw over.
            const canAccumulate = frame.dirty && transparentIndex !== null && wroteGlobalTable;

            if (canAccumulate) writePartial(frame, delay);
            else writeFull(frame, delay);

            frameCount++;
        },

        end() {
            encoder.finish();
            return { bytes: Buffer.from(encoder.bytes()), frames: frameCount };
        }
    };
}
