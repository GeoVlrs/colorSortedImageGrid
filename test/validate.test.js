import test from 'node:test';
import assert from 'node:assert/strict';

import { ruleError, checkGridArgs, VALIDATED_FLAGS } from '../lib/validate.js';
import { buildParser } from '../lib/cli.js';

test('an unset value is not an error', () => {
    assert.equal(ruleError('pxPerImage', undefined), undefined);
    assert.equal(ruleError('pxPerImage', ''), undefined);
    assert.equal(ruleError('pxPerImage', null), undefined);
});

test('a flag with no rule is left alone', () => {
    assert.equal(ruleError('borderColor', 'nonsense'), undefined);
});

test('positive rules reject zero and below', () => {
    assert.equal(ruleError('numRows', 4), undefined);
    assert.match(ruleError('numRows', 0), /positive number \(got 0\)/);
    assert.match(ruleError('concurrency', -4), /positive number \(got -4\)/);
});

test('bounded rules accept their endpoints', () => {
    for (const value of [1, 5, 10]) assert.equal(ruleError('hilbertBits', value), undefined);
    assert.equal(ruleError('hilbertBits', 11), '--hilbertBits must be between 1 and 10.');
    assert.equal(ruleError('hilbertBits', 0), '--hilbertBits must be between 1 and 10.');

    // 0.9 is the documented maximum, so it must not be rejected as "too much".
    assert.equal(ruleError('morphStagger', 0.9), undefined);
    assert.equal(ruleError('morphStagger', 0), undefined);
    assert.equal(ruleError('morphStagger', 1.2), '--morphStagger must be between 0 and 0.9.');
});

test('zero is allowed where the rule is only non-negative', () => {
    assert.equal(ruleError('padding', 0), undefined);
    assert.equal(ruleError('animateHoldMs', 0), undefined);
    assert.equal(ruleError('borderWidth', -1), '--padding and --borderWidth cannot be negative.');
});

test('a value that is not a number at all is reported as such', () => {
    // A prompt hands over whatever was typed, so this path is reached by the
    // wizard far more often than by the parser.
    assert.equal(ruleError('padding', 'abc'), '--padding must be a number (got abc).');
});

test('strings that look like numbers are accepted, since prompts return strings', () => {
    assert.equal(ruleError('numRows', '4'), undefined);
    assert.match(ruleError('numRows', '-4'), /positive number/);
});

test('checkGridArgs throws the message ruleError would have returned', () => {
    assert.throws(
        () => checkGridArgs({ hilbertBits: 42 }),
        { message: '--hilbertBits must be between 1 and 10.' }
    );
    assert.equal(checkGridArgs({ numRows: 4, padding: 0 }), true);
});

test('every validated flag is a real CLI flag', () => {
    // Guards against a rule quietly applying to nothing after a rename. Cannot
    // just look for the key in parsed args: options with no default (--numRows,
    // --pxPerImage) are absent until someone passes them. `.strict()` gives a
    // better signal - an unknown flag is rejected by name.
    for (const flag of VALIDATED_FLAGS) {
        try {
            buildParser([`--${flag}`, '5'], { exitOnError: false }).parseSync();
        } catch (error) {
            assert.doesNotMatch(
                error.message, /Unknown argument/,
                `--${flag} has a rule but is not a parser option`
            );
        }
    }
});

test('the parser still rejects what it rejected before the extraction', () => {
    for (const args of [
        ['--numRows', '0'],
        ['--concurrency', '-4'],
        ['--padding', '-1'],
        ['--hilbertBits', '99'],
        ['--morphStagger', '1.2'],
        ['--animateHoldMs', '-1']
    ]) {
        assert.throws(
            () => buildParser(args, { exitOnError: false }).parseSync(),
            `expected ${args.join(' ')} to be rejected`
        );
    }
});

test('--watch and an animation are no longer silently combined', () => {
    // index.js dispatches to the animator first, so the watch was being dropped.
    assert.throws(
        () => buildParser(['--watch', '--animateMode', 'build'], { exitOnError: false }).parseSync(),
        /--watch cannot be combined/
    );
    assert.throws(
        () => buildParser(['--watch', '--animate'], { exitOnError: false }).parseSync(),
        /--watch cannot be combined/
    );
});
