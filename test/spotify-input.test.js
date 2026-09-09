import test from 'node:test';
import assert from 'node:assert/strict';

import { parseAlbumRequests, parseCsv, detectFormat, decodeInputBuffer } from '../lib/spotify/input.js';
import { buildParser, resolveFetchOptions, resolveOptions, isFetchCommand } from '../lib/cli.js';
import { RunError } from '../lib/errors.js';

const parse = (text, options) => parseAlbumRequests(text, options);

// --- CSV ----------------------------------------------------------------

test('regression: commas inside quoted fields do not split the row', () => {
    // The reason this is a character scanner and not text.split(',').
    const rows = parseCsv('Radiohead,"Kid A, Vol. 2"');
    assert.deepEqual(rows, [['Radiohead', 'Kid A, Vol. 2']]);
});

test('doubled quotes inside a quoted field are literal', () => {
    assert.deepEqual(parseCsv('A,"say ""hi"" now"'), [['A', 'say "hi" now']]);
});

test('headerless CSV assumes artist,album', () => {
    const { requests } = parse('Radiohead,Kid A\nTool,Lateralus');
    assert.deepEqual(requests.map((r) => `${r.artist}|${r.album}`), ['Radiohead|Kid A', 'Tool|Lateralus']);
});

test('a header row is detected and mapped by name, even reversed', () => {
    const { requests } = parse('album,artist\nKid A,Radiohead');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].artist, 'Radiohead');
    assert.equal(requests[0].album, 'Kid A');
});

test('a row with no album is collected as a parse error, not thrown', () => {
    // One bad line among a hundred must not abort the run.
    const { requests, parseErrors } = parse('Radiohead,Kid A\nTool,\nPink Floyd,Animals');
    assert.equal(requests.length, 2);
    assert.equal(parseErrors.length, 1);
    assert.match(parseErrors[0].reason, /no album/i);
});

// --- plain text ---------------------------------------------------------

test('regression: only the first separator splits artist from album', () => {
    // "Radiohead - Kid A - Remastered" must keep the second hyphen.
    const { requests } = parse('Radiohead - Kid A - Remastered');
    assert.equal(requests[0].artist, 'Radiohead');
    assert.equal(requests[0].album, 'Kid A - Remastered');
});

test('a line with no separator errors, unless --artist supplies one', () => {
    const without = parse('Kid A');
    assert.equal(without.requests.length, 0);
    assert.match(without.parseErrors[0].reason, /Artist - Album/);

    // This combination is the natural way to fetch one discography.
    const withArtist = parse('Kid A\nAmnesiac', { defaultArtist: 'Radiohead' });
    assert.deepEqual(withArtist.requests.map((r) => r.album), ['Kid A', 'Amnesiac']);
    assert.ok(withArtist.requests.every((r) => r.artist === 'Radiohead'));
});

test('blank lines and comments are skipped', () => {
    const { requests } = parse('# a list\n\nRadiohead - Kid A\n\n# done\n');
    assert.equal(requests.length, 1);
});

// --- JSON ---------------------------------------------------------------

test('JSON accepts objects and pairs', () => {
    const objects = parse('[{"artist":"Tool","album":"Lateralus"}]');
    assert.equal(objects.requests[0].album, 'Lateralus');

    const pairs = parse('[["Tool","Lateralus"]]');
    assert.equal(pairs.requests[0].artist, 'Tool');
});

test('malformed JSON is a clean RunError', () => {
    assert.throws(() => parse('[{"artist":'), RunError);
});

// --- detection and encoding --------------------------------------------

test('formats are detected from content', () => {
    assert.equal(detectFormat('[{"album":"x"}]'), 'json');
    assert.equal(detectFormat('Radiohead,Kid A'), 'csv');
    assert.equal(detectFormat('Radiohead - Kid A'), 'txt');
});

test('a UTF-8 BOM is stripped', () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Radiohead - Kid A')]);
    const { requests } = parse(decodeInputBuffer(withBom));
    assert.equal(requests[0].artist, 'Radiohead');
});

test('regression: UTF-16 input is refused with an actionable message', () => {
    // Excel exports UTF-16 by default. Decoding it as UTF-8 produces mojibake
    // that then silently fails to match anything - much harder to diagnose
    // than being told to re-save the file.
    const utf16 = Buffer.from([0xff, 0xfe, 0x52, 0x00, 0x61, 0x00]);
    assert.throws(() => decodeInputBuffer(utf16, 'albums.csv'), (error) => {
        assert.ok(error instanceof RunError);
        assert.match(error.message, /UTF-16/);
        assert.match(error.message, /re-save/i);
        return true;
    });
});

test('CRLF line endings work', () => {
    const { requests } = parse('Radiohead - Kid A\r\nTool - Lateralus\r\n');
    assert.equal(requests.length, 2);
    assert.equal(requests[1].album, 'Lateralus');
});

test('duplicate entries are dropped and noted', () => {
    const { requests, parseErrors } = parse('Tool - Lateralus\ntool - lateralus');
    assert.equal(requests.length, 1);
    assert.match(parseErrors[0].reason, /duplicate/i);
});

test('entries keep their line number so a failure maps back to the input', () => {
    const { requests } = parse('Radiohead - Kid A\nTool - Lateralus');
    assert.deepEqual(requests.map((r) => r.lineNumber), [1, 2]);
});

// --- CLI routing --------------------------------------------------------

test('regression: grid defaults are unchanged by the fetch subcommand', () => {
    // The grid was the whole CLI before fetch existed; adding a command must
    // not shift a single default or require a positional argument.
    const options = resolveOptions(buildParser([], { exitOnError: false }).parseSync());

    assert.equal(options.inputDirectory, './images');
    assert.equal(options.sortMethod, 'numeric');
    assert.deepEqual(options.sortKeys, ['hue']);
    assert.equal(options.sortOrder, 'column-major');
    assert.equal(options.visualizationMode, 'normal');
    assert.equal(options.colorMethod, 'average');
    assert.equal(options.cache, true);
    assert.equal(options.descending, false);
});

test('the default command still routes grid flags', () => {
    const args = buildParser(['-i', './photos', '--sortMethod', 'hilbert'], { exitOnError: false }).parseSync();
    assert.equal(isFetchCommand(args), false);
    assert.equal(resolveOptions(args).inputDirectory, './photos');
});

test('fetch flags resolve, with their own concurrency default', () => {
    const args = buildParser(['fetch', '-a', 'Radiohead', '-A', 'Kid A'], { exitOnError: false }).parseSync();
    assert.equal(isFetchCommand(args), true);

    const options = resolveFetchOptions(args);
    assert.equal(options.artist, 'Radiohead');
    assert.equal(options.album, 'Kid A');
    assert.equal(options.destination, './images');
    assert.equal(options.filenameTemplate, '{artist} - {album}');
    // Lower than the grid's CPU-count default: the API is the bottleneck.
    assert.equal(options.concurrency, 4);
});

test('strict mode now catches nonsense combinations, per command', () => {
    // The point of making this a subcommand rather than a --fetch flag.
    assert.throws(
        () => buildParser(['fetch', '-A', 'Kid A', '--sortMethod', 'hilbert'], { exitOnError: false }).parseSync(),
        /Unknown argument/i
    );
    assert.throws(
        () => buildParser(['--artist', 'Radiohead'], { exitOnError: false }).parseSync(),
        /Unknown argument/i
    );
});

test('fetch requires something to fetch', () => {
    assert.throws(
        () => buildParser(['fetch'], { exitOnError: false }).parseSync(),
        /--album|--input/
    );
});

test('fetch rejects out-of-range values', () => {
    for (const args of [
        ['fetch', '-A', 'x', '--minConfidence', '1.5'],
        ['fetch', '-A', 'x', '--concurrency', '50'],
        ['fetch', '-A', 'x', '--searchLimit', '0']
    ]) {
        assert.throws(() => buildParser(args, { exitOnError: false }).parseSync(), `expected ${args.join(' ')} to fail`);
    }
});
