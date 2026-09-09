// String similarity, used for both album matching and duplicate detection.

/**
 * Character bigrams of a string, as a multiset.
 *
 * A multiset rather than a Set: "banana" contains "an" twice, and collapsing
 * that to one occurrence would overstate its similarity to "ban".
 */
export function bigrams(value) {
    const text = String(value);
    const counts = new Map();
    for (let i = 0; i < text.length - 1; i++) {
        const gram = text.slice(i, i + 2);
        counts.set(gram, (counts.get(gram) ?? 0) + 1);
    }
    return counts;
}

/**
 * Sorensen-Dice coefficient over character bigrams, in [0, 1].
 *
 * Chosen over the obvious alternatives for reasons specific to this problem:
 *
 * - Token/Jaccard overlap on whole words is transposition-proof but scores
 *   "nevermind" against "neverming" at exactly 0. The image folder this tool
 *   feeds is full of hand-typed titles with typos, so a word-set metric is
 *   disqualified outright.
 * - Levenshtein handles typos but is O(n*m), needs separate length
 *   normalisation to become a 0-1 confidence, and punishes word reordering.
 *
 * Dice is O(n), returns a value usable directly as a confidence score with no
 * further normalisation, and degrades gracefully on typos: the "nevermind" /
 * "neverming" pair shares 7 of 8 bigrams each way, giving 2*7/16 = 0.875.
 */
export function diceCoefficient(a, b) {
    const left = String(a ?? '');
    const right = String(b ?? '');

    if (left === right) return left.length === 0 ? 0 : 1;
    // A single character has no bigrams, so the metric is undefined for it.
    if (left.length < 2 || right.length < 2) return 0;

    const leftGrams = bigrams(left);
    const rightGrams = bigrams(right);

    let shared = 0;
    let leftSize = 0;
    let rightSize = 0;

    for (const count of leftGrams.values()) leftSize += count;
    for (const count of rightGrams.values()) rightSize += count;
    for (const [gram, count] of leftGrams) {
        const other = rightGrams.get(gram);
        if (other) shared += Math.min(count, other);
    }

    return (2 * shared) / (leftSize + rightSize);
}
