// The review report: what matched, what did not, and what to look at.

import fs from 'node:fs/promises';
import path from 'node:path';

export const REPORT_VERSION = 1;

export const STATUSES = Object.freeze({
    DOWNLOADED: 'downloaded',
    SKIPPED_EXISTING: 'skipped-existing',
    POSSIBLE_DUPLICATE: 'possible-duplicate',
    DRY_RUN: 'dry-run',
    NOT_FOUND: 'not-found',
    LOW_CONFIDENCE: 'low-confidence',
    NO_IMAGES: 'no-images',
    FAILED: 'failed'
});

/**
 * Assemble the report.
 *
 * Entries stay in input order (guaranteed by the worker pool), which is what
 * makes "line 47 failed, fix it and re-run just that one" workable.
 *
 * Only public catalogue data and local paths go in here - never credentials,
 * never request headers.
 */
export function buildReport({ entries, parseErrors = [], options = {}, elapsedMs = 0 }) {
    const count = (status) => entries.filter((entry) => entry.status === status).length;

    return {
        version: REPORT_VERSION,
        generatedAt: new Date().toISOString(),
        options: {
            destination: options.destination,
            filenameTemplate: options.filenameTemplate,
            minConfidence: options.minConfidence,
            market: options.market ?? null,
            force: Boolean(options.force),
            onDuplicate: options.onDuplicate,
            dryRun: Boolean(options.dryRun)
        },
        summary: {
            requested: entries.length,
            downloaded: count(STATUSES.DOWNLOADED),
            skippedExisting: count(STATUSES.SKIPPED_EXISTING),
            possibleDuplicates: count(STATUSES.POSSIBLE_DUPLICATE),
            dryRun: count(STATUSES.DRY_RUN),
            notFound: count(STATUSES.NOT_FOUND),
            lowConfidence: count(STATUSES.LOW_CONFIDENCE),
            noImages: count(STATUSES.NO_IMAGES),
            failed: count(STATUSES.FAILED),
            parseErrors: parseErrors.length,
            elapsedMs
        },
        parseErrors,
        entries
    };
}

/** Statuses a human should actually look at. */
const NEEDS_REVIEW = new Set([
    STATUSES.POSSIBLE_DUPLICATE, STATUSES.NOT_FOUND,
    STATUSES.LOW_CONFIDENCE, STATUSES.NO_IMAGES, STATUSES.FAILED
]);

function renderMarkdown(report) {
    const lines = [
        '# Spotify cover art fetch report',
        '',
        `Generated ${report.generatedAt}`,
        '',
        '## Summary',
        ''
    ];

    for (const [key, value] of Object.entries(report.summary)) {
        if (value) lines.push(`- **${key}**: ${value}`);
    }

    const review = report.entries.filter((entry) => NEEDS_REVIEW.has(entry.status) || entry.tier !== 'exact');
    lines.push('', '## Needs a look', '');

    if (review.length === 0) {
        lines.push('Nothing - every album was an exact match.');
    } else {
        lines.push('| Input | Status | Tier | Confidence | Matched | Note |');
        lines.push('| --- | --- | --- | --- | --- | --- |');
        for (const entry of review) {
            const matched = entry.matched ? `${entry.matched.name} - ${entry.matched.artists?.join(', ')}` : '';
            const note = entry.duplicateOf
                ? `duplicate of ${entry.duplicateOf.existingFile} (${entry.duplicateOf.score})`
                : entry.error?.message ?? '';
            lines.push(
                `| ${entry.input.artist} - ${entry.input.album} | ${entry.status} | ${entry.tier ?? ''} ` +
                `| ${entry.confidence ?? ''} | ${matched} | ${note} |`
            );
        }
    }

    return `${lines.join('\n')}\n`;
}

/**
 * Write the report.
 *
 * Format follows the file extension, mirroring how `exportPalette` in
 * lib/output.js behaves.
 */
export async function writeReport(report, outputPath) {
    const target = path.resolve(outputPath);
    await fs.mkdir(path.dirname(target), { recursive: true });

    const contents = path.extname(target).toLowerCase() === '.md'
        ? renderMarkdown(report)
        : `${JSON.stringify(report, null, 2)}\n`;

    await fs.writeFile(target, contents, 'utf8');
    return target;
}

/** One-line-per-problem terminal summary of what needs attention. */
export function renderReportSummary(report, logger) {
    const review = report.entries.filter((entry) => NEEDS_REVIEW.has(entry.status));
    if (review.length === 0) return;

    logger.info('');
    for (const entry of review.slice(0, 15)) {
        const label = `${entry.input.artist} - ${entry.input.album}`;
        const detail = entry.duplicateOf
            ? `already have ${entry.duplicateOf.existingFile}`
            : entry.error?.message ?? entry.status;
        logger.warn(`${label}: ${detail}`);
    }
    if (review.length > 15) {
        logger.info(`  ...and ${review.length - 15} more; see the report.`);
    }
}
