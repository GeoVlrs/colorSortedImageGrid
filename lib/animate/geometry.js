// Where tiles sit, and where they are mid-tween.

import { placementFor } from '../grid.js';
import { clamp01, lerp } from './easing.js';

/**
 * Pixel origin of the cell at `index`.
 *
 * A thin wrapper over `placementFor` from lib/grid.js rather than its own copy
 * of the arithmetic, so an animated frame can never disagree with the still
 * grid about where a tile belongs.
 */
export function cellOriginFor(index, { sortOrder, numRows, numColumns, tileSize, padding }) {
    const { row, col } = placementFor(index, { sortOrder, numRows, numColumns });
    return {
        x: padding + col * (tileSize + padding),
        y: padding + row * (tileSize + padding)
    };
}

/**
 * Plan the unsorted-to-sorted journey for every tile.
 *
 * `unsortedItems` is discovery order (which `discoverImages` sorts by
 * filename, so it is deterministic but visually random with respect to
 * colour - exactly the chaos the morph resolves).
 *
 * @returns {Array<{item, from: {x,y}, to: {x,y}, unsortedIndex: number, distance: number}>}
 */
export function morphPlan(unsortedItems, sortedItems, gridSpec) {
    const sortedIndexOf = new Map(sortedItems.map((item, index) => [item, index]));

    return unsortedItems.map((item, unsortedIndex) => {
        const sortedIndex = sortedIndexOf.get(item);
        const from = cellOriginFor(unsortedIndex, gridSpec);
        const to = cellOriginFor(sortedIndex, gridSpec);

        return {
            item,
            from,
            to,
            unsortedIndex,
            sortedIndex,
            distance: Math.hypot(to.x - from.x, to.y - from.y)
        };
    });
}

/**
 * Where every tile is at overall progress `T`, and in what order to draw them.
 *
 * Stagger delays each tile's start by its position in the *unsorted* layout, so
 * the motion reads as a wave crossing the grid rather than every tile lurching
 * at once. The `(1 - stagger)` divisor is what guarantees the last tile - the
 * most delayed one - still reaches exactly 1 when T does; without it the
 * animation would stop fractionally short of the sorted layout.
 *
 * Draw order is by descending remaining travel, so tiles still in flight are
 * painted first and tiles that have arrived land on top. The result reads as
 * settling into place rather than being buried.
 */
export function morphPositionsAt(plan, T, { stagger = 0, easing }) {
    const count = plan.length;
    const spread = count > 1 ? stagger : 0;
    const span = 1 - spread;

    const positions = plan.map((entry) => {
        const delay = count > 1 ? spread * (entry.unsortedIndex / (count - 1)) : 0;
        const local = clamp01(span > 0 ? (T - delay) / span : T >= 1 ? 1 : 0);
        const eased = easing(local);

        return {
            entry,
            x: Math.round(lerp(entry.from.x, entry.to.x, eased)),
            y: Math.round(lerp(entry.from.y, entry.to.y, eased)),
            progress: eased,
            remaining: (1 - eased) * entry.distance
        };
    });

    positions.sort((a, b) => b.remaining - a.remaining);
    return positions;
}

/**
 * Tile size that makes a grid come out at roughly `targetWidth`.
 *
 * Inverts `computeCanvasGeometry`, so the grid is composed at output
 * resolution and never has to be downscaled per frame - which is about a third
 * of the naive per-frame cost.
 */
export function tileSizeForWidth({ numColumns, targetWidth, padding = 0, borderWidth = 0 }) {
    const tileSize = Math.floor((targetWidth - padding) / numColumns) - padding;
    return Math.max(8, tileSize - borderWidth * 2);
}
