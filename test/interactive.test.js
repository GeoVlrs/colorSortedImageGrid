import test from 'node:test';
import assert from 'node:assert/strict';

import { buildParser, resolveOptions } from '../lib/cli.js';
import { SORT_KEYS } from '../lib/constants.js';
import { ANIMATE_DIMENSIONS } from '../lib/animate/constants.js';
import { EASING_NAMES } from '../lib/animate/easing.js';
import { toFlagArgs, toCommandLine, toConfigObject, MAPPED_OPTIONS } from '../lib/interactive/summary.js';
import { PROMPTS, SORT_KEY_INFO, EASING_INFO, ANIMATE_OVER_INFO } from '../lib/interactive/index.js';
import { SECTIONS, SPINE, promptsFor, allSectionOptions, orderSections } from '../lib/interactive/sections.js';

/** The options the pipeline gets when nothing at all is passed. */
function defaultOptions() {
    return resolveOptions(buildParser([], { exitOnError: false }).parseSync());
}

/**
 * Feed the wizard's own output back through the parser.
 *
 * This is the test that matters: any option the wizard can set but the
 * descriptor table has fallen behind on fails here, which is precisely the
 * drift that left `--dryRun` unprintable.
 */
function roundTrip(options) {
    const defaults = defaultOptions();
    const args = toFlagArgs(options, defaults);
    return resolveOptions(buildParser(args, { exitOnError: false }).parseSync());
}

test('defaults produce no flags at all', () => {
    const defaults = defaultOptions();
    assert.deepEqual(toFlagArgs(defaults, defaults), []);
    assert.equal(toCommandLine(defaults, defaults), 'node index.js');
});

test('a fully configured sweep run round-trips through the parser', () => {
    const options = {
        ...defaultOptions(),
        inputDirectory: './images/test',
        recursive: true,
        outputFilename: './output/grid.png',
        exportPalette: './output/palette.css',
        numRows: 4,
        numColumns: 6,
        pxPerImage: 128,
        sortOrder: 'row-major',
        padding: 12,
        borderWidth: 3,
        borderColor: '#ffffff',
        background: 'white',
        sortMethod: 'banded',
        sortKeys: ['hue', 'luma'],
        descending: true,
        sortBands: 8,
        sortSecondary: 'labL',
        serpentine: true,
        hilbertBits: 6,
        visualizationMode: 'dominant',
        colorMethod: 'dominant',
        sampleSize: 32,
        greyscale: true,
        dryRun: true,
        animate: true,
        animateOver: 'sortMethod',
        animateValues: 'hilbert,perceptual',
        animateDelay: 400,
        animateWidth: 720,
        animateOutput: './output/sweep.gif',
        concurrency: 3,
        cache: false,
        cacheFile: './.cache.json',
        preview: false,
        quiet: true,
        needsDateTaken: false
    };

    assert.deepEqual(roundTrip(options), options);
});

test('a build run round-trips, and does not also emit --animate', () => {
    const options = {
        ...defaultOptions(),
        animate: true,
        animateMode: 'build',
        animateWidth: 600,
        animateFps: 20,
        animateHoldMs: 1500,
        animateEasing: 'linear',
        revealPerFrame: 2
    };

    const args = toFlagArgs(options, defaultOptions());
    assert.ok(!args.includes('--animate'), '--animateMode already implies --animate');
    assert.deepEqual(roundTrip(options), options);
});

test('a morph run round-trips', () => {
    const options = {
        ...defaultOptions(),
        animate: true,
        animateMode: 'morph',
        morphSeconds: 5,
        morphStagger: 0.6,
        morphHoldMs: 300
    };

    assert.deepEqual(roundTrip(options), options);
});

test('a bare sweep still emits --animate, since no mode flag carries it', () => {
    const defaults = defaultOptions();
    assert.deepEqual(toFlagArgs({ ...defaults, animate: true }, defaults), ['--animate']);
});

test('regression: --dryRun is printed', () => {
    // The whole point of the printed command is that it reproduces the run.
    // This one was set by the wizard and never emitted, so copying the command
    // would have rendered for real.
    const defaults = defaultOptions();
    assert.match(toCommandLine({ ...defaults, dryRun: true }, defaults), /--dryRun/);
});

test('options that default to on are turned off with their --no- form', () => {
    const defaults = defaultOptions();
    const args = toFlagArgs({ ...defaults, cache: false, preview: false }, defaults);
    assert.deepEqual(args, ['--no-cache', '--no-preview']);
});

test('values needing quoting get it, and values that do not are left bare', () => {
    const defaults = defaultOptions();
    const line = toCommandLine({ ...defaults, inputDirectory: './my images', sortBands: 6 }, defaults);

    assert.match(line, /-i "\.\/my images"/);
    assert.match(line, /--sortBands 6/);
});

test('diffing is against the parser defaults, not the options passed in', () => {
    // `--interactive --sortMethod hilbert` starts the wizard with hilbert
    // already set. Diffing against that would drop it from the printed command,
    // which would then no longer reproduce the run.
    const defaults = defaultOptions();
    const preset = { ...defaults, sortMethod: 'hilbert', greyscale: true };

    assert.deepEqual(toFlagArgs(preset, defaults), ['--sortMethod', 'hilbert', '-g']);
});

test('a preset is keyed by flag name and never re-enters the wizard', () => {
    const defaults = defaultOptions();
    const config = toConfigObject(
        { ...defaults, sortKeys: ['hue', 'luma'], descending: true, interactive: true },
        defaults
    );

    assert.deepEqual(config, { sortParameter: 'hue,luma', sortDescending: true });
    assert.ok(!('interactive' in config), 'a saved preset must not re-enter the wizard');
    assert.ok(!('sortKeys' in config), 'config keys are flag names, not internal option names');
});

test('every option the pipeline uses is expressible as a flag', () => {
    // Derived (needsDateTaken) and wizard-only (interactive) options aside, an
    // option the wizard cannot express is an option the wizard cannot honestly
    // summarise - so adding one to resolveOptions must fail here until the
    // descriptor table catches up.
    const derived = new Set(['needsDateTaken', 'interactive']);
    const missing = Object.keys(defaultOptions())
        .filter((key) => !derived.has(key) && !MAPPED_OPTIONS.includes(key));

    assert.deepEqual(missing, []);
});

test('every section in the picker has questions behind it', () => {
    for (const section of SECTIONS) {
        assert.ok(promptsFor(section.id).length > 0, `${section.id} offers nothing`);
    }
});

test('between the spine and the sections, every flag is reachable', () => {
    // The point of the whole exercise: no option should be flags-only.
    const reachable = new Set([...SPINE, ...allSectionOptions()]);

    // `animate` is the one exception, and deliberately so: entering the
    // animation section is what turns it on, so asking would be asking twice.
    reachable.add('animate');

    const unreachable = MAPPED_OPTIONS.filter((option) => !reachable.has(option));
    assert.deepEqual(unreachable, []);
});

test('the picker never repeats a question the spine already asked', () => {
    const overlap = allSectionOptions().filter((option) => SPINE.includes(option));

    // sortKeys is the one option asked twice, and it is a different question
    // each time: the spine takes the primary key, the sorting section adds
    // tiebreaks on top of it.
    assert.deepEqual(overlap, ['sortKeys']);
});

test('method-specific sorting knobs appear only under their method', () => {
    assert.deepEqual(promptsFor('sorting', { sortMethod: 'hilbert' }), ['hilbertBits', 'descending']);
    assert.deepEqual(promptsFor('sorting', { sortMethod: 'banded' }), ['sortSecondary', 'serpentine', 'descending']);
    assert.deepEqual(promptsFor('sorting', { sortMethod: 'numeric' }), ['sortKeys', 'descending']);
    assert.deepEqual(promptsFor('sorting', { sortMethod: 'perceptual' }), ['descending']);
});

test('animation asks for a mode first, then only that mode', () => {
    assert.equal(promptsFor('animation', {})[0], 'animateMode');

    const sweep = promptsFor('animation', { animateMode: 'sweep' });
    const build = promptsFor('animation', { animateMode: 'build' });
    const morph = promptsFor('animation', { animateMode: 'morph' });

    // Sweep keeps its own pacing flag; the parser rejects it elsewhere.
    assert.ok(sweep.includes('animateDelay') && !sweep.includes('animateFps'));
    assert.ok(build.includes('animateFps') && !build.includes('animateDelay'));

    assert.ok(build.includes('revealPerFrame') && !morph.includes('revealPerFrame'));
    assert.ok(morph.includes('morphStagger') && !build.includes('morphStagger'));

    // Nothing eases a hard cut.
    assert.ok(morph.includes('animateEasing') && !sweep.includes('animateEasing'));

    for (const prompts of [sweep, build, morph]) {
        assert.ok(prompts.includes('animateWidth'), 'width applies to every mode');
    }
});

test('watch is not offered once an animation is chosen', () => {
    assert.deepEqual(promptsFor('run', { animate: false }), ['watch', 'dryRun']);
    assert.deepEqual(promptsFor('run', { animate: true }), ['dryRun']);
});

test('sampleSize is offered only when something actually quantises', () => {
    assert.ok(!promptsFor('colour', { colorMethod: 'average', visualizationMode: 'normal' }).includes('sampleSize'));
    assert.ok(promptsFor('colour', { colorMethod: 'dominant', visualizationMode: 'normal' }).includes('sampleSize'));
    assert.ok(promptsFor('colour', { colorMethod: 'average', visualizationMode: 'dominant' }).includes('sampleSize'));
});

test('follow-up questions are skipped when their setting is off', () => {
    assert.ok(!promptsFor('grid', { borderWidth: 0 }).includes('borderColor'));
    assert.ok(promptsFor('grid', { borderWidth: 3 }).includes('borderColor'));
    assert.ok(!promptsFor('performance', { cache: false }).includes('cacheFile'));
    assert.ok(!promptsFor('performance', { verbose: true }).includes('quiet'));
});

test('an unknown section is empty rather than an error', () => {
    assert.deepEqual(promptsFor('nope'), []);
});

test('every question a section can reach has wording to ask it with', () => {
    // Without this, a section listing an option the prompt table has never
    // heard of throws mid-wizard - after the user has already answered ten
    // questions. Cheaper to catch here.
    const missing = [...allSectionOptions(), 'sortBands'].filter((option) => !(option in PROMPTS));
    assert.deepEqual(missing, []);
});

test('no question is asked about an option that is not a flag', () => {
    const strays = Object.keys(PROMPTS).filter((option) => !MAPPED_OPTIONS.includes(option));
    assert.deepEqual(strays, []);
});

test('every select offers parser-valid values, each with a description', () => {
    for (const [option, spec] of Object.entries(PROMPTS)) {
        if (spec.type !== 'select') continue;

        for (const { value, hint } of spec.options()) {
            const flag = option === 'sortKeys' ? 'sortParameter' : option;
            assert.doesNotThrow(
                () => buildParser([`--${flag}`, String(value)], { exitOnError: false }).parseSync(),
                `${option} offers "${value}", which the parser rejects`
            );
            assert.ok(hint, `${option} offers "${value}" with no description`);
        }
    }
});

test('chosen sections are ordered by the list, not by when they were checked', () => {
    // A checkbox list hands back press order. Animation must run before run
    // mode, or the run section offers --watch before `animate` is set and the
    // parser rejects the pair.
    assert.deepEqual(orderSections(['run', 'animation']), ['animation', 'run']);
    assert.deepEqual(orderSections(['performance', 'output']), ['output', 'performance']);
    assert.deepEqual(orderSections([]), []);
    assert.deepEqual(orderSections(['nope', 'grid']), ['grid']);
});

test('every value in a described set has a description', () => {
    // The tables are the only reason these lists are readable, and a new easing
    // or sort key would otherwise ship as a bare identifier. Fail here instead.
    const missing = [];
    for (const [name, values, info] of [
        ['SORT_KEY_INFO', SORT_KEYS, SORT_KEY_INFO],
        ['EASING_INFO', EASING_NAMES, EASING_INFO],
        ['ANIMATE_OVER_INFO', Object.values(ANIMATE_DIMENSIONS), ANIMATE_OVER_INFO]
    ]) {
        for (const value of values) {
            if (!info[value]?.hint) missing.push(`${name}.${value}`);
        }
        for (const key of Object.keys(info)) {
            if (!values.includes(key)) missing.push(`${name}.${key} describes nothing`);
        }
    }
    assert.deepEqual(missing, []);
});
