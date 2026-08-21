'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CheckpointStore } = require('./checkpoint-store');
const { RecoveryStore } = require('./recovery-store');

function fixture(keep) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-recovery-'));
    const checkpointStore = new CheckpointStore({ root, keep: keep || 50 });
    return {
        root,
        checkpointStore,
        store: new RecoveryStore({ checkpointStore, keep: keep || 50 }),
    };
}

test('RecoveryStore creates editable script and metadata and finds it across project directories', () => {
    const f = fixture();
    try {
        const source = 'C:/projects/a.aep';
        const entry = f.store.create({
            sourceProjectPath: source,
            code: 'var value = 1;\nvalue;',
            meta: { checkpointId: 'cp-1', attempts: [] },
        });
        assert.match(entry.recoveryId, /^[a-z0-9]{6}$/);
        assert.equal(path.isAbsolute(entry.scriptPath), true);
        assert.equal(path.basename(path.dirname(entry.scriptPath)), 'recovery');
        assert.equal(f.store.readScript(entry), 'var value = 1;\nvalue;');
        const direct = f.store.lookup(entry.recoveryId, source);
        assert.deepEqual(direct, entry);
        const scanned = f.store.lookup(entry.recoveryId, 'C:/projects/other.aep');
        assert.deepEqual(scanned, entry);
        const meta = f.store.readMeta(entry);
        assert.equal(meta.recoveryId, entry.recoveryId);
        assert.equal(meta.sourceProjectPath, source);
        assert.equal(meta.scriptPath, entry.scriptPath);
        assert.equal(meta.checkpointId, 'cp-1');
    } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
    }
});

test('RecoveryStore edits scripts, appends attempts, and rejects traversal ids', () => {
    const f = fixture();
    try {
        const entry = f.store.create({ sourceProjectPath: null, code: 'old', meta: {} });
        f.store.writeScript(entry, 'fixed');
        assert.equal(f.store.readScript(entry), 'fixed');
        const attempt = f.store.appendAttempt(entry, { ok: true, retryMode: 'continue' });
        assert.equal(attempt.n, 1);
        assert.deepEqual(f.store.readMeta(entry).attempts, [{ n: 1, ok: true, retryMode: 'continue' }]);
        assert.throws(function () { f.store.lookup('../x', null); }, /invalid recoveryId/);
        assert.throws(function () {
            f.store.readScript(Object.assign({}, entry, { recoveryId: '../x' }));
        }, /invalid recoveryId/);
    } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
    }
});

test('RecoveryStore uses _untitled and checkpoint listing leaves recovery metadata intact', () => {
    const f = fixture();
    try {
        const entry = f.store.create({ sourceProjectPath: null, code: '1', meta: {} });
        assert.equal(path.dirname(path.dirname(entry.scriptPath)), path.join(f.root, '_untitled'));
        assert.deepEqual(f.checkpointStore.list(null, { limit: 20 }), []);
        assert.equal(fs.existsSync(entry.metaPath), true);
        assert.equal(fs.existsSync(entry.scriptPath), true);
    } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
    }
});

test('RecoveryStore prunes both files by createdAt and keeps the newest entries', () => {
    const f = fixture(2);
    try {
        const source = 'C:/projects/prune.aep';
        const entries = [
            f.store.create({ sourceProjectPath: source, code: 'old', meta: { createdAt: '2026-01-01T00:00:00Z' } }),
            f.store.create({ sourceProjectPath: source, code: 'middle', meta: { createdAt: '2026-01-02T00:00:00Z' } }),
            f.store.create({ sourceProjectPath: source, code: 'new', meta: { createdAt: '2026-01-03T00:00:00Z' } }),
        ];
        f.store.prune(source);
        assert.equal(f.store.lookup(entries[0].recoveryId, source), null);
        assert.ok(f.store.lookup(entries[1].recoveryId, source));
        assert.ok(f.store.lookup(entries[2].recoveryId, source));
    } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
    }
});
