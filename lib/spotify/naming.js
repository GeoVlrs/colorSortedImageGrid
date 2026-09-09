// Turning a matched album into a safe filename, and spotting art we already have.

import fs from 'node:fs/promises';
import path from 'node:path';

import { diceCoefficient } from './similarity.js';
import { normalizeTitle } from './match.js';

export const DEFAULT_FILENAME_TEMPLATE = '{artist} - {album}';

// Above this, two titles are treated as the same album.
export const DUPLICATE_CERTAIN = 0.9;
// Above this, worth flagging for a human to glance at, but not worth skipping.
export const DUPLICATE_POSSIBLE = 0.72;

// Windows refuses these as filenames regardless of extension.
const RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const MAX_STEM_LENGTH = 120;

/**
 * Make a string safe as a Windows filename without flattening it.
 *
 * Substitution is character-aware rather than a blanket underscore, because
 * the point is to produce names that sit naturally beside the hand-typed ones
 * already in the folder: a human writing "Vol 1: Part 2" as a filename writes
 * "Vol 1 - Part 2", not "Vol 1_ Part 2".
 *
 * Non-ASCII is deliberately preserved - the existing folder contains Icelandic
 * and Greek filenames that work fine. The one Unicode class that is stripped is
 * \p{C} (control and format characters), which includes not just the obvious
 * control bytes but things like directionality marks that are invisible in a
 * file listing yet part of the name.
 */
export function sanitizeFilename(value, fallback = 'untitled') {
    let stem = String(value ?? '')
        .replace(/:/g, ' -')
        .replace(/[/\\]/g, '-')
        .replace(/"/g, "'")
        // Substituted with a space, not deleted: removing them outright would
        // weld neighbouring words together ("<yes>|no|" -> "yesno"). The
        // collapse and trim below tidy up whatever this leaves behind.
        .replace(/[?*<>|]/g, ' ')
        .replace(/\p{C}/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (stem.length > MAX_STEM_LENGTH) {
        const clipped = stem.slice(0, MAX_STEM_LENGTH);
        const lastSpace = clipped.lastIndexOf(' ');
        // Prefer a word boundary, but not if it throws most of the name away.
        stem = (lastSpace > MAX_STEM_LENGTH * 0.6 ? clipped.slice(0, lastSpace) : clipped).trim();
    }

    // Windows silently discards trailing dots and spaces, so a file written as
    // "Album .jpg" ends up with a name that does not match what was asked for.
    stem = stem.replace(/[. ]+$/g, '');

    if (stem === '') return fallback;
    if (RESERVED_NAMES.test(stem)) return `${stem}_`;
    return stem;
}

/**
 * Render a filename stem from a template.
 *
 * The extension is appended later by the download step, once the actual image
 * format is known, and is never part of the template.
 */
export function buildFilename(template, tokens) {
    const values = {
        artist: tokens.artist ?? '',
        album: tokens.album ?? '',
        year: tokens.year ?? '',
        albumId: tokens.albumId ?? ''
    };

    const rendered = String(template ?? DEFAULT_FILENAME_TEMPLATE)
        .replace(/\{(artist|album|year|albumId)\}/g, (_, key) => values[key])
        // A missing token can leave a dangling separator behind.
        .replace(/\s*-\s*$/, '')
        .replace(/^\s*-\s*/, '');

    return sanitizeFilename(rendered, values.albumId || 'untitled');
}

/** Comparable form of a filename stem. */
export function normalizeStem(stem) {
    const name = String(stem ?? '');
    return normalizeTitle(path.basename(name, path.extname(name)));
}

/**
 * Index the destination folder so we can tell what is already downloaded.
 *
 * Uses a plain readdir rather than `discoverImages` from lib/files.js on
 * purpose: that helper filters to decodable image extensions, which would drop
 * extensionless entries and leave gaps in the index. Here we want to know
 * about everything that occupies a name.
 *
 * Each file contributes more than one comparison key, and that matters a great
 * deal. The existing collection is named by album alone ("Kid A.jpg") while
 * new downloads default to "Artist - Album.jpg". Comparing whole filenames
 * would score "radiohead kid a" against "kid a" at roughly 0.44 and so miss
 * almost every album already owned, quietly filling the grid with duplicate
 * covers. So a stem containing " - " is also indexed by the portion after the
 * first separator, and matching is done against the album title alone.
 */
export async function buildExistingIndex(directory) {
    let entries;
    try {
        entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
        return []; // A destination that does not exist yet simply has nothing in it.
    }

    return entries
        .filter((entry) => entry.isFile())
        .map((entry) => {
            const stem = path.basename(entry.name, path.extname(entry.name));
            const keys = new Set([normalizeTitle(stem)]);

            const separator = stem.indexOf(' - ');
            if (separator !== -1) {
                keys.add(normalizeTitle(stem.slice(separator + 3)));
            }

            return { file: entry.name, stem, keys: [...keys].filter(Boolean) };
        });
}

/**
 * Find an existing file that looks like the same album.
 *
 * Compares the album *title* against every indexed key, so it works whichever
 * naming convention a given file on disk happens to use.
 *
 * @returns {{file: string, score: number}|null} The strongest match, if any.
 */
export function findNearDuplicates(albumTitle, index, { threshold = DUPLICATE_POSSIBLE } = {}) {
    const target = normalizeTitle(albumTitle);
    if (!target) return null;

    let best = null;
    for (const entry of index) {
        for (const key of entry.keys) {
            const score = key === target ? 1 : diceCoefficient(target, key);
            if (score >= threshold && (!best || score > best.score)) {
                best = { file: entry.file, score: Number(score.toFixed(3)) };
            }
        }
    }
    return best;
}
