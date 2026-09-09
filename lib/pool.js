// A tiny bounded-concurrency worker pool.
//
// The original script fired every `Jimp.read()` at once via `forEach(async ...)`
// and tracked completion by comparing array lengths inside each callback. That
// worked by accident, had no concurrency ceiling, and let a single bad file
// reject the whole batch. This replaces it with something bounded, order-
// preserving and error-isolating.

/**
 * Map over `items` with at most `limit` workers in flight.
 *
 * Results are returned in *input* order (not completion order), each as a
 * `{ status: 'fulfilled', value }` or `{ status: 'rejected', reason }` record,
 * mirroring `Promise.allSettled`. Preserving input order matters: it keeps runs
 * reproducible, which the original could not guarantee.
 *
 * @param {Array} items
 * @param {number} limit           Maximum concurrent workers.
 * @param {(item: any, index: number) => Promise<any>} worker
 * @param {(done: number, total: number) => void} [onProgress] Called after each settle.
 * @returns {Promise<Array<{status: string, value?: any, reason?: any}>>}
 */
export async function mapWithConcurrency(items, limit, worker, onProgress) {
    const results = new Array(items.length);
    const workerCount = Math.max(1, Math.min(limit, items.length));
    let nextIndex = 0;
    let completed = 0;

    const runner = async () => {
        while (true) {
            const index = nextIndex++;
            if (index >= items.length) return;

            try {
                results[index] = { status: 'fulfilled', value: await worker(items[index], index) };
            } catch (reason) {
                results[index] = { status: 'rejected', reason };
            }

            completed++;
            if (onProgress) onProgress(completed, items.length);
        }
    };

    await Promise.all(Array.from({ length: workerCount }, runner));
    return results;
}
