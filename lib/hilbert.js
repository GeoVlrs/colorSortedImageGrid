// 3D Hilbert curve indexing, used by `--sortMethod hilbert`.
//
// Sorting colours along a single axis (hue, luma, ...) throws away two of the
// three dimensions, which is why naive colour sorts look streaky. A Hilbert
// curve threads a single continuous path through the whole 3D colour cube while
// keeping nearby points nearby, so ordering images by their position along that
// path gives a much smoother gradient than any one-axis sort can.
//
// This is Skilling's "AxestoTranspose" algorithm (Skilling, J. 2004,
// "Programming the Hilbert curve", AIP Conf. Proc. 707, 381), which is the
// standard compact way to do this for arbitrary dimensions. Hand-rolled
// deliberately: the npm options for *3D* Hilbert indexing are niche and
// unmaintained, and this is ~30 lines with a strong correctness test
// (see test/hilbert.test.js) rather than a supply-chain risk.

/**
 * Convert an n-dimensional integer coordinate to its distance along the
 * Hilbert curve.
 *
 * @param {number[]} coords Integer coordinates, each in [0, 2**bits).
 * @param {number} bits     Bits of precision per axis.
 * @returns {number} Index along the curve, in [0, 2**(bits*n)).
 */
export function hilbertIndex(coords, bits = 8) {
    const n = coords.length;
    const max = (1 << bits) - 1;
    // Copy so we never mutate the caller's array, and clamp defensively.
    const X = coords.map((v) => Math.max(0, Math.min(max, Math.round(v))) | 0);

    const M = 1 << (bits - 1);

    // Inverse undo of the excess work: walk the bit planes from the top down,
    // reflecting/rotating the sub-cubes into a canonical orientation.
    for (let Q = M; Q > 1; Q >>= 1) {
        const P = Q - 1;
        for (let i = 0; i < n; i++) {
            if (X[i] & Q) {
                X[0] ^= P; // invert
            } else {
                const t = (X[0] ^ X[i]) & P; // exchange
                X[0] ^= t;
                X[i] ^= t;
            }
        }
    }

    // Gray encode.
    for (let i = 1; i < n; i++) X[i] ^= X[i - 1];

    let t = 0;
    for (let Q = M; Q > 1; Q >>= 1) {
        if (X[n - 1] & Q) t ^= Q - 1;
    }
    for (let i = 0; i < n; i++) X[i] ^= t;

    // X now holds the index in "transposed" form (one bit plane per axis).
    // Interleave those bits, most significant plane first, into a single scalar.
    let index = 0;
    for (let b = bits - 1; b >= 0; b--) {
        for (let i = 0; i < n; i++) {
            index = index * 2 + ((X[i] >>> b) & 1);
        }
    }
    return index;
}

/**
 * Map a CIE Lab colour onto the Hilbert curve.
 *
 * Lab is used rather than RGB because Lab is roughly perceptually uniform, so
 * "close along the curve" corresponds to "looks similar" far better than it
 * would in RGB. Axis ranges are the usual practical bounds: L in [0, 100],
 * a and b in [-128, 127].
 *
 * @param {{labL: number, labA: number, labB: number}} colorInfo
 * @param {number} bits
 */
export function hilbertIndexForLab(colorInfo, bits = 8) {
    const scale = (1 << bits) - 1;
    const l = (colorInfo.labL / 100) * scale;
    const a = ((colorInfo.labA + 128) / 255) * scale;
    const b = ((colorInfo.labB + 128) / 255) * scale;
    return hilbertIndex([l, a, b], bits);
}
