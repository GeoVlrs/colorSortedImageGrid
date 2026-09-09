// Normalising album/artist names and picking the best Spotify candidate.

import { diceCoefficient } from './similarity.js';

export const MATCH_TIERS = Object.freeze({
    EXACT: 'exact',
    EXACT_CORE: 'exact-core',
    FUZZY: 'fuzzy',
    NONE: 'none'
});

export const DEFAULT_MIN_CONFIDENCE = 0.72;

// Below this, a candidate is thrown out no matter how well the album title
// scores. Without the gate, an identically-titled album by an unrelated artist
// scores 0.65 on album weight alone and can win outright - the single most
// valuable correctness rule in this module.
export const ARTIST_GATE = 0.45;

// Characters NFKD will not decompose for us, so they need spelling out.
const CHARACTER_FOLDS = new Map(Object.entries({
    'æ': 'ae', 'œ': 'oe', 'ø': 'o', 'ð': 'd', 'þ': 'th',
    'ß': 'ss', 'ł': 'l', 'đ': 'd', 'ħ': 'h', 'ı': 'i',
    'ς': 'σ' // Greek final sigma, so word-final and word-medial sigma match
}));

/**
 * Fold a title down to a comparable form.
 *
 * The accented "Agaetis byrjun" must reach "agaetis byrjun", and "AC/DC" must
 * reach "ac dc", so that neither diacritics nor punctuation can make two
 * spellings of the same record look like different ones.
 */
export function normalizeTitle(value) {
    if (value === undefined || value === null) return '';

    let text = String(value)
        // NFKD splits accented letters into base + combining mark, which we
        // then drop. It also folds full-width and typographic look-alikes.
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLowerCase();

    let folded = '';
    for (const character of text) folded += CHARACTER_FOLDS.get(character) ?? character;
    text = folded;

    text = text
        .replace(/[‘’‛]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/[‐-―]/g, '-')
        .replace(/&/g, ' and ')
        .replace(/(\w)\s*\+\s*(\w)/g, '$1 and $2')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return text;
}

/** Word-order-insensitive form, so "Beatles, The" matches "The Beatles". */
function sortTokens(value) {
    return value.split(' ').filter(Boolean).sort().join(' ');
}

/**
 * Similarity of two already-normalised strings.
 *
 * Takes the better of the direct and token-sorted comparisons so that word
 * reordering does not penalise an otherwise identical title.
 */
export function similarity(a, b) {
    if (!a || !b) return 0;
    return Math.max(diceCoefficient(a, b), diceCoefficient(sortTokens(a), sortTokens(b)));
}

// Words that mark a *pressing* of a record rather than a different record.
// "live" is deliberately absent: a live album is its own release with its own
// artwork, so stripping it would match the wrong cover.
const VARIANT_VOCABULARY = /\b(?:remaster(?:ed)?|deluxe|expanded|edition|version|anniversary|reissue|bonus\s+track(?:s)?|explicit|clean|mono|stereo|legacy|special|digital|disc\s*\d+|feat\.?|featuring)\b/i;
const BARE_YEAR = /^\s*\d{4}\s*$/;

const TRAILING_GROUP = /\s*[([]([^()[\]]*)[)\]]\s*$/;
const TRAILING_DASH = /\s+[-–—]\s+([^-–—]*)$/;

function isVariantContent(content) {
    const trimmed = String(content).trim();
    if (trimmed === '') return false;
    return VARIANT_VOCABULARY.test(trimmed) || BARE_YEAR.test(trimmed);
}

/**
 * Split "Album (Deluxe Edition)" into its core title and the variant marker.
 *
 * Three guards keep this from eating real titles:
 *   - only *trailing* groups are considered, so a leading parenthetical (as in
 *     the Oasis album that opens with one) survives intact;
 *   - the content must match the variant vocabulary, so "(Take 2)" survives,
 *     because a different take is a different recording;
 *   - it never strips a title down to nothing.
 *
 * @returns {{core: string, variant: string|null}}
 */
export function stripVariantSuffix(value) {
    let core = String(value ?? '').trim();
    const variants = [];

    for (;;) {
        const group = core.match(TRAILING_GROUP);
        const dash = core.match(TRAILING_DASH);
        const match = group ?? dash;
        if (!match) break;
        if (!isVariantContent(match[1])) break;

        const remainder = core.slice(0, match.index).trim();
        // Never strip everything away: "(Remastered)" alone stays as it is.
        if (remainder === '') break;

        variants.unshift(match[1].trim());
        core = remainder;
    }

    return { core, variant: variants.length > 0 ? variants.join(' / ') : null };
}

const ALBUM_TYPE_RANK = { album: 0, compilation: 1, single: 2 };

/** Spotify dates vary in precision ("1973", "1973-03", "1973-03-01"). */
function sortableReleaseDate(candidate) {
    const raw = String(candidate?.release_date ?? '9999');
    const [year = '9999', month = '00', day = '00'] = raw.split('-');
    return `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/**
 * Score one Spotify album against the requested artist/album.
 *
 * Album carries more weight than artist because it is what the user named and
 * what the filename becomes; the artist is the disambiguator.
 */
export function scoreCandidate(request, candidate) {
    const requestedAlbum = normalizeTitle(request.album);
    const requestedArtist = normalizeTitle(request.artist);

    const candidateAlbum = normalizeTitle(candidate?.name);
    const requestedCore = normalizeTitle(stripVariantSuffix(request.album).core);
    const candidateCore = normalizeTitle(stripVariantSuffix(candidate?.name ?? '').core);

    // The 0.97 factor is a deliberate nudge: an exact full-title match should
    // outrank a core-only match against a deluxe edition, without excluding
    // that edition when it is the only pressing available.
    const albumSimilarity = Math.max(
        similarity(requestedAlbum, candidateAlbum),
        0.97 * similarity(requestedCore, candidateCore)
    );

    // Maxing across artists matters for collaborations and compilations.
    const artistNames = (candidate?.artists ?? []).map((artist) => normalizeTitle(artist?.name));
    const artistSimilarity = requestedArtist
        ? Math.max(0, ...artistNames.map((name) => similarity(requestedArtist, name)))
        : 1;

    const disqualified = Boolean(requestedArtist) && artistSimilarity < ARTIST_GATE;
    const score = 0.65 * albumSimilarity + 0.35 * artistSimilarity;

    const albumsEqual = candidateAlbum !== '' && candidateAlbum === requestedAlbum;
    const coresEqual = candidateCore !== '' && candidateCore === requestedCore;
    const artistsEqual = !requestedArtist || artistNames.includes(requestedArtist) || artistSimilarity >= 0.9;

    let tier = MATCH_TIERS.FUZZY;
    if (albumsEqual && artistsEqual) tier = MATCH_TIERS.EXACT;
    else if (coresEqual && artistsEqual) tier = MATCH_TIERS.EXACT_CORE;

    return { candidate, score, albumSimilarity, artistSimilarity, disqualified, tier };
}

/** Order two equally-scoring candidates. Lower sorts first. */
function tieBreak(a, b) {
    const typeA = ALBUM_TYPE_RANK[a.candidate?.album_type] ?? 3;
    const typeB = ALBUM_TYPE_RANK[b.candidate?.album_type] ?? 3;
    if (typeA !== typeB) return typeA - typeB;

    // A full-length release beats a stub of the same name.
    const substantialA = (a.candidate?.total_tracks ?? 0) >= 5 ? 0 : 1;
    const substantialB = (b.candidate?.total_tracks ?? 0) >= 5 ? 0 : 1;
    if (substantialA !== substantialB) return substantialA - substantialB;

    // Originals over reissues.
    const dateA = sortableReleaseDate(a.candidate);
    const dateB = sortableReleaseDate(b.candidate);
    if (dateA !== dateB) return dateA < dateB ? -1 : 1;

    const popularityA = a.candidate?.popularity ?? -1;
    const popularityB = b.candidate?.popularity ?? -1;
    if (popularityA !== popularityB) return popularityB - popularityA;

    // Stable: Spotify's own relevance ranking gets the last word.
    return a.index - b.index;
}

/**
 * Pick the best album from a candidate list.
 *
 * Always returns a decision rather than throwing, so a batch never blocks:
 * when nothing clears `minConfidence` the result carries `tier: 'none'` and
 * the best rejected candidate, for the review report.
 */
export function pickBestMatch(request, candidates, { minConfidence = DEFAULT_MIN_CONFIDENCE } = {}) {
    const scored = (candidates ?? [])
        .map((candidate, index) => ({ ...scoreCandidate(request, candidate), index }));

    const eligible = scored.filter((entry) => !entry.disqualified);
    const ranked = [...eligible].sort((a, b) => (b.score - a.score) || tieBreak(a, b));

    // Re-rank only the candidates that are effectively tied, so a tie-breaker
    // can never override a genuinely better score.
    if (ranked.length > 1) {
        const top = ranked[0].score;
        const contenders = ranked.filter((entry) => top - entry.score <= 0.02).sort(tieBreak);
        ranked.splice(0, contenders.length, ...contenders);
    }

    const best = ranked[0];
    const alternatives = ranked.slice(1, 4).map((entry) => ({
        name: entry.candidate?.name,
        artists: (entry.candidate?.artists ?? []).map((artist) => artist?.name),
        releaseDate: entry.candidate?.release_date,
        albumType: entry.candidate?.album_type,
        score: Number(entry.score.toFixed(3))
    }));

    if (!best) {
        const rejected = [...scored].sort((a, b) => b.score - a.score)[0];
        return {
            tier: MATCH_TIERS.NONE,
            confidence: rejected ? Number(rejected.score.toFixed(3)) : 0,
            match: null,
            rejectedBest: rejected?.candidate ?? null,
            alternatives: []
        };
    }

    if (best.tier === MATCH_TIERS.EXACT) {
        return { tier: MATCH_TIERS.EXACT, confidence: 1, match: best.candidate, alternatives };
    }
    if (best.tier === MATCH_TIERS.EXACT_CORE) {
        return { tier: MATCH_TIERS.EXACT_CORE, confidence: 0.95, match: best.candidate, alternatives };
    }
    if (best.score >= minConfidence) {
        return {
            tier: MATCH_TIERS.FUZZY,
            confidence: Number(best.score.toFixed(3)),
            match: best.candidate,
            alternatives
        };
    }

    return {
        tier: MATCH_TIERS.NONE,
        confidence: Number(best.score.toFixed(3)),
        match: null,
        rejectedBest: best.candidate,
        alternatives
    };
}
