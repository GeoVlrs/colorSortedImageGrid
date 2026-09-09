import test from 'node:test';
import assert from 'node:assert/strict';

import { diceCoefficient, bigrams } from '../lib/spotify/similarity.js';
import {
    normalizeTitle, stripVariantSuffix, similarity, scoreCandidate, pickBestMatch, MATCH_TIERS
} from '../lib/spotify/match.js';

const album = (name, artist, extra = {}) => ({
    name,
    artists: [{ name: artist }],
    album_type: 'album',
    total_tracks: 10,
    release_date: '2000-01-01',
    ...extra
});

// --- similarity ---------------------------------------------------------

test('bigrams counts repeats rather than collapsing them', () => {
    // "banana" contains "an" twice; treating bigrams as a set would overstate
    // its similarity to shorter strings.
    assert.equal(bigrams('banana').get('an'), 2);
    assert.equal(bigrams('a').size, 0);
});

test('dice handles the typo case that disqualified token-overlap metrics', () => {
    // The images folder contains hand-typed titles with typos, so the metric
    // has to survive a single wrong character. Word-set overlap scores this 0.
    assert.equal(diceCoefficient('nevermind', 'neverming'), 0.875);
});

test('dice is bounded, symmetric, and safe on degenerate input', () => {
    assert.equal(diceCoefficient('kid a', 'kid a'), 1);
    assert.equal(diceCoefficient('abc', 'xyz'), 0);
    assert.equal(diceCoefficient('', ''), 0);
    assert.equal(diceCoefficient('a', 'a'), 1);
    assert.equal(diceCoefficient('ab', 'a'), 0, 'a single char has no bigrams');
    assert.equal(diceCoefficient('lateralus', 'laterulas'), diceCoefficient('laterulas', 'lateralus'));
});

// --- normalisation ------------------------------------------------------

test('normalisation folds diacritics and ligatures', () => {
    assert.equal(normalizeTitle('Ágætis byrjun'), 'agaetis byrjun');
    assert.equal(normalizeTitle('Björk'), 'bjork');
    assert.equal(normalizeTitle('Blue Öyster Cult'), 'blue oyster cult');
    assert.equal(normalizeTitle('Motörhead'), 'motorhead');
});

test('normalisation keeps non-Latin scripts intact', () => {
    // The existing folder has Greek filenames that must still match.
    assert.equal(normalizeTitle('Γινόμενο'), 'γινομενο');
});

test('normalisation folds punctuation and ampersands', () => {
    assert.equal(normalizeTitle('AC/DC'), 'ac dc');
    assert.equal(normalizeTitle('Arrows & Anchors'), 'arrows and anchors');
    assert.equal(normalizeTitle('Rock ’n’ Roll'), "rock 'n' roll".replace(/'/g, ' ').replace(/\s+/g, ' ').trim());
    assert.equal(normalizeTitle('  Spaced   Out  '), 'spaced out');
});

test('normalisation is null-safe', () => {
    assert.equal(normalizeTitle(null), '');
    assert.equal(normalizeTitle(undefined), '');
});

test('word order does not defeat similarity', () => {
    assert.equal(similarity(normalizeTitle('Beatles, The'), normalizeTitle('The Beatles')), 1);
});

// --- variant suffixes ---------------------------------------------------

test('variant suffixes are stripped', () => {
    assert.equal(stripVariantSuffix('Lateralus (Deluxe Edition)').core, 'Lateralus');
    assert.equal(stripVariantSuffix('Nevermind - Remastered 2011').core, 'Nevermind');
    assert.equal(stripVariantSuffix('Aenima [Explicit]').core, 'Aenima');
    assert.equal(stripVariantSuffix('Ten (Legacy Edition)').core, 'Ten');
});

test('regression: a leading parenthetical is never stripped', () => {
    // Only *trailing* groups are candidates. Oasis would otherwise lose half
    // its title, and the remaining fragment would match the wrong record.
    const title = "(What's the Story) Morning Glory?";
    assert.equal(stripVariantSuffix(title).core, title);
});

test('regression: suffixes that change identity are kept', () => {
    // A different take, and a live record, are different recordings with
    // different artwork - stripping these would fetch the wrong cover.
    assert.equal(stripVariantSuffix('Blood on the Tracks (Take 2)').core, 'Blood on the Tracks (Take 2)');
    assert.equal(stripVariantSuffix('Live at Leeds (Live)').core, 'Live at Leeds (Live)');
});

test('a title made only of a variant marker is left alone', () => {
    // Stripping would leave nothing at all to match on.
    assert.equal(stripVariantSuffix('(Remastered)').core, '(Remastered)');
});

// --- scoring and selection ---------------------------------------------

test('regression: the artist gate rejects a same-titled album by someone else', () => {
    // Album weight alone is 0.65, enough to clear the confidence floor, so
    // without the gate a tribute act could beat the real band.
    const wrong = scoreCandidate({ artist: 'Tool', album: 'Lateralus' }, album('Lateralus', 'A Tribute Band'));
    assert.equal(wrong.disqualified, true);

    const right = pickBestMatch({ artist: 'Tool', album: 'Lateralus' }, [
        album('Lateralus', 'A Tribute Band'),
        album('Lateralus', 'Tool')
    ]);
    assert.equal(right.match.artists[0].name, 'Tool');
    assert.equal(right.tier, MATCH_TIERS.EXACT);
    assert.equal(right.confidence, 1);
});

test('an exact title and artist is tier exact with full confidence', () => {
    const result = pickBestMatch({ artist: 'Tool', album: 'Lateralus' }, [album('Lateralus', 'Tool')]);
    assert.equal(result.tier, MATCH_TIERS.EXACT);
    assert.equal(result.confidence, 1);
});

test('a deluxe edition of the right album is tier exact-core, not exact', () => {
    // Worth distinguishing: a deluxe reissue often carries different artwork,
    // so it belongs in the review report even though it is the right record.
    const result = pickBestMatch(
        { artist: 'Tool', album: 'Lateralus' },
        [album('Lateralus (Deluxe Edition)', 'Tool')]
    );
    assert.equal(result.tier, MATCH_TIERS.EXACT_CORE);
    assert.equal(result.confidence, 0.95);
});

test('nothing plausible yields tier none and downloads nothing', () => {
    const result = pickBestMatch(
        { artist: 'Tool', album: 'Lateralus' },
        [album('Something Else Entirely', 'Tool')]
    );
    assert.equal(result.tier, MATCH_TIERS.NONE);
    assert.equal(result.match, null);
    assert.ok(result.rejectedBest, 'the best rejected candidate is kept for the report');
});

test('minConfidence is the boundary between fuzzy and none', () => {
    const request = { artist: 'Tool', album: 'Lateralis' }; // deliberate typo
    const candidates = [album('Lateralus', 'Tool')];

    const lenient = pickBestMatch(request, candidates, { minConfidence: 0.5 });
    assert.equal(lenient.tier, MATCH_TIERS.FUZZY);
    assert.ok(lenient.confidence > 0.5 && lenient.confidence < 1);

    const strict = pickBestMatch(request, candidates, { minConfidence: 0.99 });
    assert.equal(strict.tier, MATCH_TIERS.NONE);
});

test('tie-break prefers the original release over a reissue', () => {
    const result = pickBestMatch({ artist: 'Pink Floyd', album: 'The Dark Side of the Moon' }, [
        album('The Dark Side of the Moon', 'Pink Floyd', { release_date: '2011-09-26' }),
        album('The Dark Side of the Moon', 'Pink Floyd', { release_date: '1973-03-01' })
    ]);
    assert.equal(result.match.release_date, '1973-03-01');
});

test('tie-break prefers an album over a single of the same name', () => {
    const result = pickBestMatch({ artist: 'Tool', album: 'Schism' }, [
        album('Schism', 'Tool', { album_type: 'single', total_tracks: 1 }),
        album('Schism', 'Tool')
    ]);
    assert.equal(result.match.album_type, 'album');
});

test('variable-precision release dates sort correctly', () => {
    // Spotify returns "1973", "1973-03" or "1973-03-01" depending on the record.
    const result = pickBestMatch({ artist: 'Band', album: 'Record' }, [
        album('Record', 'Band', { release_date: '1999' }),
        album('Record', 'Band', { release_date: '1980' })
    ]);
    assert.equal(result.match.release_date, '1980');
});

test('alternatives are reported for review but capped at three', () => {
    const result = pickBestMatch({ artist: 'Tool', album: 'Lateralus' }, [
        album('Lateralus', 'Tool'),
        album('Lateralus (Deluxe Edition)', 'Tool'),
        album('Lateralus (Remastered)', 'Tool'),
        album('Lateralus (Live)', 'Tool'),
        album('Lateralus (Mono)', 'Tool')
    ]);
    assert.ok(result.alternatives.length <= 3);
    assert.ok(result.alternatives.every((entry) => typeof entry.score === 'number'));
});

test('an empty candidate list does not throw', () => {
    const result = pickBestMatch({ artist: 'Tool', album: 'Lateralus' }, []);
    assert.equal(result.tier, MATCH_TIERS.NONE);
    assert.equal(result.match, null);
});

test('a missing artist skips the gate rather than failing everything', () => {
    // Batch input is allowed to be album-only.
    const result = pickBestMatch({ artist: '', album: 'Lateralus' }, [album('Lateralus', 'Tool')]);
    assert.equal(result.tier, MATCH_TIERS.EXACT);
});
