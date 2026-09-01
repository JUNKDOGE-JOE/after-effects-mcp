'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const prune = require('./preview-prune');

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-preview-prune-test-')); }

function file(root, session, name, size, mtimeMs) {
    const directory = path.join(root, session);
    fs.mkdirSync(directory, { recursive: true });
    const target = path.join(directory, name);
    fs.writeFileSync(target, Buffer.alloc(1));
    fs.truncateSync(target, size);
    fs.utimesSync(target, mtimeMs / 1000, mtimeMs / 1000);
    return target;
}

test('preview pruning removes expired PNGs but preserves current-session and non-PNG files', () => {
    const root = tempDir();
    const now = Date.now();
    const expired = file(root, 'old-session', 'expired.png', 10, now - prune.MAX_AGE_MS - 1);
    const fresh = file(root, 'old-session', 'fresh.png', 10, now - 1000);
    const nonPng = file(root, 'old-session', 'keep.txt', 10, now - prune.MAX_AGE_MS - 1);
    const current = file(root, 'current', 'expired.png', 10, now - prune.MAX_AGE_MS - 1);
    prune.prunePreviewRoot(root, 'current', { now: now });
    assert.equal(fs.existsSync(expired), false);
    assert.equal(fs.existsSync(fresh), true);
    assert.equal(fs.existsSync(nonPng), true);
    assert.equal(fs.existsSync(current), true);
});

test('preview pruning enforces 300 MiB oldest-first without deleting the current session', () => {
    const root = tempDir();
    const now = Date.now();
    const oldest = file(root, 'session-a', 'oldest.png', 160, now - 3000);
    const newer = file(root, 'session-b', 'newer.png', 160, now - 2000);
    const current = file(root, 'current', 'current.png', 1, now - 4000);
    assert.equal(prune.MAX_TOTAL_BYTES, 300 * 1024 * 1024);
    prune.prunePreviewRoot(root, 'current', { now: now, maxTotalBytes: 300 });
    assert.equal(fs.existsSync(oldest), false);
    assert.equal(fs.existsSync(newer), true);
    assert.equal(fs.existsSync(current), true);
});

test('preview pruning removes empty session directories and tolerates a missing root', () => {
    const root = tempDir();
    const now = Date.now();
    const directory = path.join(root, 'expired-session');
    file(root, 'expired-session', 'only.png', 1, now - prune.MAX_AGE_MS - 1);
    prune.prunePreviewRoot(root, 'current', { now: now });
    assert.equal(fs.existsSync(directory), false);
    assert.doesNotThrow(function () { prune.prunePreviewRoot(path.join(root, 'missing'), 'current'); });
});

test('preview pruning runs once for each host-session root', () => {
    const root = tempDir();
    const now = Date.now();
    prune.prunePreviewRootOnce(root, 'current', { now: now });
    const expired = file(root, 'old-session', 'late.png', 1, now - prune.MAX_AGE_MS - 1);
    prune.prunePreviewRootOnce(root, 'current', { now: now });
    assert.equal(fs.existsSync(expired), true);
});
