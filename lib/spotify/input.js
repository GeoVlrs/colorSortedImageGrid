// Reading album lists from CSV, plain text or JSON.

import { RunError } from '../errors.js';

// Column names recognised in a CSV header row, mapped to the field they fill.
const HEADER_ALIASES = new Map(Object.entries({
    artist: 'artist',
    artists: 'artist',
    band: 'artist',
    album: 'album',
    album_name: 'album',
    albumname: 'album',
    title: 'album',
    name: 'album'
}));

/**
 * Decode a file that was read as raw bytes.
 *
 * Excel on Windows exports UTF-16 by default. Decoding that as UTF-8 produces
 * mojibake that then quietly fails to match anything on Spotify - a far harder
 * failure to diagnose than being told up front, so it is refused outright.
 */
export function decodeInputBuffer(buffer, filename = 'the input file') {
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '');

    if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
        throw new RunError(
            `${filename} looks like UTF-16 (it starts with a UTF-16 byte order mark).\n` +
            `  Re-save it as UTF-8 - in Excel, choose "CSV UTF-8" when saving.`
        );
    }

    return bytes.toString('utf8').replace(/^﻿/, '');
}

/**
 * Split CSV text into rows of fields.
 *
 * A character scanner rather than `.split(',')`, so quoted fields containing
 * commas survive: `Radiohead,"Kid A, Vol. 2"` is two fields, not three.
 */
export function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
        const character = text[i];

        if (inQuotes) {
            if (character === '"') {
                // A doubled quote inside a quoted field is a literal quote.
                if (text[i + 1] === '"') {
                    field += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                field += character;
            }
            continue;
        }

        if (character === '"') {
            inQuotes = true;
        } else if (character === ',') {
            row.push(field);
            field = '';
        } else if (character === '\n') {
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
        } else if (character !== '\r') {
            field += character;
        }
    }

    if (field !== '' || row.length > 0) {
        row.push(field);
        rows.push(row);
    }

    return rows.map((cells) => cells.map((cell) => cell.trim()));
}

/** Guess which of the three supported shapes this text is. */
export function detectFormat(text) {
    const trimmed = text.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) return 'json';

    const meaningful = trimmed
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'));

    if (meaningful.some((line) => parseCsv(line)[0]?.length >= 2)) return 'csv';
    return 'txt';
}

/**
 * Parse `[{artist, album}]` (or `{albums: [...]}}`), or `[[artist, album]]` pairs.
 *
 * Malformed JSON itself is fatal (there is no line-by-line notion of "one bad
 * entry" once the whole document fails to parse), but an individual entry
 * that is neither an object nor a pair is collected as a parse error and
 * skipped, consistent with the CSV and plain-text parsers below.
 */
function fromJson(text, parseErrors) {
    let payload;
    try {
        payload = JSON.parse(text);
    } catch (error) {
        throw new RunError(`The input file is not valid JSON: ${error.message}`);
    }

    const list = Array.isArray(payload) ? payload : payload?.albums;
    if (!Array.isArray(list)) {
        throw new RunError('JSON input must be an array, or an object with an "albums" array.');
    }

    return list.map((entry, index) => {
        if (Array.isArray(entry)) return { artist: entry[0] ?? '', album: entry[1] ?? '' };
        if (entry && typeof entry === 'object') {
            return { artist: entry.artist ?? '', album: entry.album ?? entry.name ?? '' };
        }
        parseErrors.push({ lineNumber: index + 1, line: String(entry), reason: 'not an object or pair' });
        return null;
    }).filter(Boolean);
}

/**
 * Parse comma-separated rows into {artist, album} records.
 *
 * A row missing an album is a parse error rather than a thrown exception, so
 * one malformed row in a hundred does not abort the batch - the caller
 * decides what to do with `parseErrors` (report it, keep going).
 */
function fromCsv(text, parseErrors) {
    const rows = parseCsv(text).filter((row) => row.some((cell) => cell !== '') && !row[0].startsWith('#'));
    if (rows.length === 0) return [];

    // A header row is detected by name, which also copes with reversed columns.
    const headerCandidate = rows[0].map((cell) => cell.toLowerCase());
    const isHeader = headerCandidate.length >= 2 && headerCandidate.every((cell) => HEADER_ALIASES.has(cell));

    const columns = isHeader
        ? headerCandidate.map((cell) => HEADER_ALIASES.get(cell))
        : ['artist', 'album'];

    return rows.slice(isHeader ? 1 : 0).map((row, index) => {
        const record = { artist: '', album: '' };
        columns.forEach((field, column) => {
            if (field && row[column] !== undefined) record[field] = row[column];
        });

        if (!record.album) {
            parseErrors.push({
                lineNumber: index + 1 + (isHeader ? 1 : 0),
                line: row.join(','),
                reason: 'no album name in this row'
            });
            return null;
        }
        return record;
    }).filter(Boolean);
}

/** Parse lines of "Artist - Album" (or bare album titles, given a default artist). */
function fromText(text, parseErrors, defaultArtist) {
    return text.split(/\r?\n/).map((rawLine, index) => {
        const line = rawLine.trim();
        if (line === '' || line.startsWith('#')) return null;

        // Split on the FIRST separator only, so "Radiohead - Kid A - Remastered"
        // keeps the second hyphen as part of the album title.
        const separator = line.indexOf(' - ');
        if (separator === -1) {
            // With --artist supplied, a bare line is just an album title, which
            // makes bulk-fetching one discography convenient.
            if (defaultArtist) return { artist: defaultArtist, album: line };
            parseErrors.push({
                lineNumber: index + 1,
                line,
                reason: 'expected "Artist - Album", or pass --artist to treat the line as an album title'
            });
            return null;
        }

        return { artist: line.slice(0, separator).trim(), album: line.slice(separator + 3).trim() };
    }).filter(Boolean);
}

/**
 * Parse an album list.
 *
 * Parse errors are collected rather than thrown: one malformed line among a
 * hundred must not abort the whole run, and the report tells the user exactly
 * which lines to fix.
 *
 * @returns {{requests: Array<{artist: string, album: string, lineNumber: number}>, parseErrors: Array}}
 */
export function parseAlbumRequests(text, { format = 'auto', defaultArtist = '' } = {}) {
    const parseErrors = [];
    const chosen = format === 'auto' ? detectFormat(text) : format;

    let records;
    if (chosen === 'json') records = fromJson(text, parseErrors);
    else if (chosen === 'csv') records = fromCsv(text, parseErrors);
    else records = fromText(text, parseErrors, defaultArtist);

    const seen = new Set();
    const requests = [];

    records.forEach((record, index) => {
        const artist = String(record.artist ?? '').trim() || defaultArtist;
        const album = String(record.album ?? '').trim();
        if (!album) return;

        const key = `${artist.toLowerCase()}|${album.toLowerCase()}`;
        if (seen.has(key)) {
            parseErrors.push({ lineNumber: index + 1, line: `${artist} - ${album}`, reason: 'duplicate entry, skipped' });
            return;
        }
        seen.add(key);

        requests.push({ artist, album, lineNumber: index + 1, sourceLine: `${artist} - ${album}` });
    });

    return { requests, parseErrors, format: chosen };
}
