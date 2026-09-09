// Orchestrates a cover-art fetch: resolve input, search, match, download, report.

import fs from 'node:fs/promises';
import path from 'node:path';

import { RunError } from '../errors.js';
import { mapWithConcurrency } from '../pool.js';
import { createProgressBar, renderOutputBanner, renderSummary } from '../log.js';

import { loadCredentials } from './env.js';
import { createTokenProvider, AuthError } from './auth.js';
import { createSpotifyClient } from './client.js';
import { pickBestMatch, MATCH_TIERS } from './match.js';
import {
    buildFilename, buildExistingIndex, findNearDuplicates,
    DUPLICATE_CERTAIN, DUPLICATE_POSSIBLE
} from './naming.js';
import { downloadCoverArt, pickLargestImage } from './download.js';
import { decodeInputBuffer, parseAlbumRequests } from './input.js';
import { buildReport, writeReport, renderReportSummary, STATUSES } from './report.js';

/** Resolve the album list from --artist/--album or --input. */
async function resolveRequests(options) {
    if (options.input) {
        let buffer;
        try {
            buffer = await fs.readFile(options.input);
        } catch (error) {
            throw new RunError(
                error?.code === 'ENOENT'
                    ? `Input file not found: ${path.resolve(options.input)}`
                    : `Could not read ${options.input}: ${error.message}`
            );
        }

        const text = decodeInputBuffer(buffer, path.basename(options.input));
        return parseAlbumRequests(text, { format: options.format, defaultArtist: options.artist });
    }

    if (!options.album) {
        throw new RunError(
            'Nothing to fetch.\n' +
            '  Give an album:   colorgrid fetch --artist "Radiohead" --album "Kid A"\n' +
            '  Or a list:       colorgrid fetch --input albums.csv'
        );
    }

    return {
        requests: [{
            artist: options.artist ?? '',
            album: options.album,
            lineNumber: 1,
            sourceLine: `${options.artist ?? ''} - ${options.album}`
        }],
        parseErrors: [],
        format: 'inline'
    };
}

/** Optional map of album title -> filename already on disk, for hand-abbreviated names. */
async function loadAliases(aliasPath) {
    if (!aliasPath) return new Map();
    try {
        const parsed = JSON.parse(await fs.readFile(aliasPath, 'utf8'));
        return new Map(Object.entries(parsed).map(([album, file]) => [album.toLowerCase(), file]));
    } catch (error) {
        throw new RunError(`Could not read the alias file ${aliasPath}: ${error.message}`);
    }
}

/** Trim a Spotify album object down to what the report needs. */
function summariseAlbum(album, image) {
    return {
        albumId: album.id,
        name: album.name,
        artists: (album.artists ?? []).map((artist) => artist.name),
        releaseDate: album.release_date,
        albumType: album.album_type,
        totalTracks: album.total_tracks,
        spotifyUrl: album.external_urls?.spotify,
        imageWidth: image?.width ?? null,
        imageUrl: image?.url ?? null
    };
}

/**
 * Handle one album end to end.
 *
 * Returns a report entry rather than throwing wherever the outcome is a
 * *result* (not found, already have it, low confidence). Genuine failures do
 * throw, and the worker pool isolates them so the batch continues.
 */
async function fetchOne(request, context) {
    const { client, options, existingIndex, aliases, logger } = context;
    const base = { input: request, status: null, tier: null, confidence: null };

    // Check what we already have *before* spending an API call on it.
    if (!options.force && options.onDuplicate !== 'ignore') {
        const alias = aliases.get(String(request.album).toLowerCase());
        if (alias) {
            return { ...base, status: STATUSES.SKIPPED_EXISTING, duplicateOf: { existingFile: alias, score: 1 } };
        }

        const existing = findNearDuplicates(request.album, existingIndex, { threshold: DUPLICATE_CERTAIN });
        if (existing) {
            logger.detail(`skipping ${request.album}; already have ${existing.file}`);
            return {
                ...base,
                status: STATUSES.SKIPPED_EXISTING,
                duplicateOf: { existingFile: existing.file, score: existing.score }
            };
        }
    }

    const { items, queryUsed } = await client.searchAlbums(request, {
        market: options.market,
        limit: options.searchLimit
    });

    if (items.length === 0) {
        return { ...base, status: STATUSES.NOT_FOUND, queryUsed, tier: MATCH_TIERS.NONE, confidence: 0 };
    }

    const decision = pickBestMatch(request, items, { minConfidence: options.minConfidence });

    if (!decision.match) {
        return {
            ...base,
            status: STATUSES.LOW_CONFIDENCE,
            queryUsed,
            tier: decision.tier,
            confidence: decision.confidence,
            rejectedBest: decision.rejectedBest ? summariseAlbum(decision.rejectedBest, null) : null,
            alternatives: decision.alternatives
        };
    }

    const image = pickLargestImage(decision.match.images);
    const matched = summariseAlbum(decision.match, image);
    const common = {
        ...base,
        queryUsed,
        tier: decision.tier,
        confidence: decision.confidence,
        matched,
        alternatives: decision.tier === MATCH_TIERS.EXACT ? [] : decision.alternatives
    };

    if (!image?.url) {
        return { ...common, status: STATUSES.NO_IMAGES };
    }

    // Weaker duplicate signal: worth flagging, but a redundant download is far
    // cheaper than silently omitting an album from the grid, so it proceeds.
    const possible = options.onDuplicate === 'ignore' || options.force
        ? null
        : findNearDuplicates(decision.match.name, existingIndex, { threshold: DUPLICATE_POSSIBLE });

    const stem = buildFilename(options.filenameTemplate, {
        artist: matched.artists[0] ?? request.artist,
        album: decision.match.name,
        year: String(decision.match.release_date ?? '').slice(0, 4),
        albumId: decision.match.id
    });

    if (options.dryRun) {
        return {
            ...common,
            status: STATUSES.DRY_RUN,
            file: { path: path.join(options.destination, `${stem}.jpg`), planned: true },
            duplicateOf: possible ? { existingFile: possible.file, score: possible.score } : undefined
        };
    }

    const file = await downloadCoverArt(image.url, options.destination, stem, {
        maxBytes: options.maxImageBytes
    });
    logger.detail(`saved ${path.basename(file.path)}`);

    return {
        ...common,
        status: possible ? STATUSES.POSSIBLE_DUPLICATE : STATUSES.DOWNLOADED,
        file,
        duplicateOf: possible ? { existingFile: possible.file, score: possible.score } : undefined
    };
}

/**
 * Fetch cover art for one album or a whole list.
 *
 * @param {object} options Resolved CLI options.
 * @param {object} logger
 */
export async function runFetch(options, logger) {
    const startedAt = Date.now();

    const { requests, parseErrors, format } = await resolveRequests(options);
    if (requests.length === 0) {
        throw new RunError(
            parseErrors.length > 0
                ? `No usable albums found in ${options.input}. First problem: ${parseErrors[0].reason}`
                : `No albums found in ${options.input}.`
        );
    }

    const credentials = await loadCredentials({ envFile: options.envFile });
    logger.detail(`credentials loaded from ${credentials.source}`);

    const client = createSpotifyClient({
        tokenProvider: createTokenProvider(credentials),
        logger,
        maxRetryDelay: options.maxRetryDelay
    });

    const [existingIndex, aliases] = await Promise.all([
        buildExistingIndex(options.destination),
        loadAliases(options.aliases)
    ]);

    logger.step(
        `Fetching cover art for ${requests.length} album${requests.length === 1 ? '' : 's'}` +
        `${format === 'inline' ? '' : ` (${format} input)`}...`
    );
    if (existingIndex.length > 0) {
        logger.info(`${existingIndex.length} file(s) already in ${path.resolve(options.destination)}.`);
    }
    if (options.dryRun) logger.info('Dry run - matching only, nothing will be downloaded.');

    for (const problem of parseErrors) {
        logger.warn(`line ${problem.lineNumber}: ${problem.reason}`);
    }

    const progress = createProgressBar(logger, 'albums');
    progress.start(requests.length);

    const context = { client, options, existingIndex, aliases, logger };
    const settled = await mapWithConcurrency(
        requests,
        options.concurrency,
        (request) => fetchOne(request, context),
        (done) => progress.update(done)
    );
    progress.stop();

    // Input order is preserved by the pool, which is what lets a user map a
    // report entry back to a line in their input file.
    const entries = settled.map((result, index) => {
        if (result.status === 'fulfilled') return result.value;

        const reason = result.reason;
        return {
            input: requests[index],
            status: STATUSES.FAILED,
            tier: null,
            confidence: null,
            error: {
                kind: reason?.kind ?? reason?.name ?? 'error',
                message: reason?.message ?? String(reason),
                httpStatus: reason?.status,
                attempts: reason?.attempts
            }
        };
    });

    const report = buildReport({
        entries, parseErrors, options, elapsedMs: Date.now() - startedAt
    });

    // Written in a finally-style position so an interrupted run still leaves
    // something reviewable behind.
    let reportPath = null;
    try {
        reportPath = await writeReport(report, options.report);
    } catch (error) {
        logger.warn(`Could not write the report: ${error.message}`);
    }

    renderReportSummary(report, logger);

    if (report.summary.downloaded > 0 || report.summary.possibleDuplicates > 0) {
        renderOutputBanner(options.destination, logger);
    }
    if (reportPath) logger.info(`Report: ${reportPath}`);

    renderSummary({
        processed: report.summary.downloaded + report.summary.possibleDuplicates + report.summary.dryRun,
        skipped: report.summary.skippedExisting,
        failed: report.summary.failed + report.summary.notFound +
            report.summary.lowConfidence + report.summary.noImages,
        cacheHits: 0,
        elapsedMs: report.summary.elapsedMs
    }, logger);

    // A run where nothing at all succeeded should not look like success to a
    // calling script.
    if (report.summary.downloaded === 0 && report.summary.dryRun === 0 &&
        report.summary.skippedExisting === 0 && report.summary.possibleDuplicates === 0) {
        process.exitCode = 1;
    }

    if (client.aborted) {
        throw new AuthError('Spotify authentication failed; the remaining albums were not attempted.');
    }

    return report;
}
