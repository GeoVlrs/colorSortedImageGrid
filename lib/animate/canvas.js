// A raw RGBA frame buffer with fast, clipped blitting.
//
// Jimp's `composite` allocates three objects and does four float divisions per
// pixel, which costs ~142ms for a 144-tile grid. Copying rows straight between
// buffers does the same work in ~7ms. Since every tile here is opaque, none of
// composite's blending is needed.

import Jimp from 'jimp';

export class FrameCanvas {
    constructor(width, height) {
        this.width = width;
        this.height = height;

        // `new Uint8Array` and NOT Buffer.allocUnsafe: gifenc's quantize() and
        // applyPalette() both do `new Uint32Array(rgba.buffer)`, which ignores
        // byteOffset. A pooled Buffer would have a nonzero offset and they
        // would silently read the wrong bytes.
        this.data = new Uint8Array(width * height * 4);
        this.rowScratch = new Uint8Array(width * 4);
    }

    /** Fill a rectangle with one RGBA colour, clipped to the canvas. */
    fillRect(x, y, w, h, [r, g, b, a = 255]) {
        const x0 = Math.max(0, x);
        const y0 = Math.max(0, y);
        const x1 = Math.min(this.width, x + w);
        const y1 = Math.min(this.height, y + h);
        if (x1 <= x0 || y1 <= y0) return;

        // Build one row, then stamp it down the rectangle. Endian-independent,
        // unlike the Uint32Array trick, and one `set()` per row is fast enough.
        const rowBytes = (x1 - x0) * 4;
        const row = this.rowScratch;
        for (let i = 0; i < rowBytes; i += 4) {
            row[i] = r;
            row[i + 1] = g;
            row[i + 2] = b;
            row[i + 3] = a;
        }
        const rowView = row.subarray(0, rowBytes);

        for (let py = y0; py < y1; py++) {
            this.data.set(rowView, (this.width * py + x0) * 4);
        }
    }

    /** Fill the whole canvas. */
    fill(rgba) {
        this.fillRect(0, 0, this.width, this.height, rgba);
    }

    /**
     * Copy an opaque RGBA source onto the canvas at (dx, dy).
     *
     * Clipped on all four edges, so partially off-canvas positions are safe -
     * which is what lets morph tiles travel past the border mid-tween without
     * the caller bounds-checking every frame.
     *
     * Only correct for fully opaque sources: this overwrites rather than
     * blends. Every tile the grid produces (`cover`, `4x4`, `dominant`) is
     * opaque, and borders are pre-composited into the tile before it gets here.
     */
    blitOpaque(srcData, srcWidth, srcHeight, dx, dy) {
        const sx0 = Math.max(0, -dx);
        const sy0 = Math.max(0, -dy);
        const sx1 = Math.min(srcWidth, this.width - dx);
        const sy1 = Math.min(srcHeight, this.height - dy);
        if (sx1 <= sx0 || sy1 <= sy0) return;

        const copyBytes = (sx1 - sx0) * 4;

        for (let sy = sy0; sy < sy1; sy++) {
            const srcStart = (srcWidth * sy + sx0) * 4;
            const dstStart = (this.width * (dy + sy) + dx + sx0) * 4;
            // subarray is a view, so this is one memcpy with no allocation.
            this.data.set(srcData.subarray(srcStart, srcStart + copyBytes), dstStart);
        }
    }

    /** Copy a rectangle out into a tightly packed RGBA buffer. */
    readRect({ x, y, w, h }, target) {
        const out = target ?? new Uint8Array(w * h * 4);
        const rowBytes = w * 4;
        for (let row = 0; row < h; row++) {
            const from = (this.width * (y + row) + x) * 4;
            out.set(this.data.subarray(from, from + rowBytes), row * rowBytes);
        }
        return out;
    }

    /**
     * A Jimp view of the current pixels, for code that still wants one.
     *
     * `new Jimp({data, width, height})` is synchronous, unlike `Jimp.create`,
     * which is an alias for `Jimp.read` and always costs a promise plus a
     * timer tick.
     */
    asJimp() {
        return new Jimp({ data: Buffer.from(this.data), width: this.width, height: this.height });
    }
}

/** Smallest rectangle containing both inputs. */
export function unionRect(a, b) {
    if (!a) return b;
    if (!b) return a;
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return {
        x,
        y,
        w: Math.max(a.x + a.w, b.x + b.w) - x,
        h: Math.max(a.y + a.h, b.y + b.h) - y
    };
}
