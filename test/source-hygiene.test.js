import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.git', 'output', 'images', '.claude']);

function sourceFiles(dir = root) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (SKIP.has(entry.name)) return [];
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return sourceFiles(full);
        return /\.(js|mjs|json|md)$/.test(entry.name) ? [full] : [];
    });
}

test('no source file contains a NUL byte', () => {
    // This has bitten twice now, both times from a string literal written by
    // tooling that turned a character into 0x00. It runs fine - both sides of a
    // comparison hold the same constant - so nothing fails until git decides the
    // file is binary and stops producing diffs for it. Cheap to check, invisible
    // otherwise.
    const offenders = sourceFiles()
        .filter((file) => fs.readFileSync(file).includes(0))
        .map((file) => path.relative(root, file));

    assert.deepEqual(offenders, []);
});
