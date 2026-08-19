'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CheckpointStore, isWindowsProjectPath } = require('./checkpoint-store');

function withStore(options, run) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-checkpoints-'));
    const store = new CheckpointStore(Object.assign({ root }, options || {}));
    try {
        return run(store, root);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

function touchAep(filePath, size) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.alloc(size === undefined ? 1024 : size));
}

function writeMeta(filePath, fields) {
    const meta = Object.assign({
        id: fields.id,
        label: '',
        ts: fields.ts,
        sourceProjectPath: 'C:/p.aep',
        activeCompId: null,
        currentTime: 0,
        sizeBytes: 1024,
    }, fields);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(meta), 'utf8');
}

test('default root is AE_MCP_HOME/checkpoints and keep honors its env override', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-home-'));
    try {
        const store = new CheckpointStore({
            env: { AE_MCP_HOME: home, AE_MCP_CHECKPOINT_KEEP: '2' }, home: path.join(home, 'unused'),
        });
        assert.equal(store.root, path.join(home, 'checkpoints'));
        assert.equal(store.keep, 2);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test('project keys use the full normalized path and stable Windows semantics', () => {
    withStore({}, function (store) {
        const first = store._dirFor('C:/a/project.aep');
        const second = store._dirFor('C:/b/project.aep');
        assert.notEqual(first, second);
        assert.match(path.basename(first), /^project_[0-9a-f]{12}$/);
        assert.equal(store._dirFor('C:/projects/Same.aep'), store._dirFor('C:\\projects\\Same.aep'));
        assert.equal(store._dirFor(null), path.join(store.root, '_untitled'));
        assert.equal(isWindowsProjectPath('/tmp/project.aep'), false);
        assert.equal(isWindowsProjectPath('C:/tmp/project.aep'), true);
        assert.equal(isWindowsProjectPath('\\\\server\\share\\project.aep'), true);
    });
});

test('makeId is unique, lexicographically sortable, and carries eight random hex chars', () => {
    withStore({}, function (store) {
        const ids = [];
        for (let i = 0; i < 5; i += 1) ids.push(store.makeId());
        assert.equal(new Set(ids).size, 5);
        ids.forEach(function (id) { assert.match(id, /^\d+_[0-9a-f]{8}$/); });
        assert.deepEqual(ids, ids.slice().sort());
    });
});

test('writeMeta, list, latest, lookup, and checkpoint-file canonicalization round trip', () => {
    withStore({}, function (store) {
        const source = 'C:/projects/p.aep';
        const directory = store._dirFor(source);
        touchAep(path.join(directory, 'old.aep'), 1024);
        writeMeta(path.join(directory, 'old.json'), {
            id: 'old', ts: '2026-04-27T10:00:00Z', sourceProjectPath: source,
        });
        touchAep(path.join(directory, 'new.aep'), 2048);
        const metaPath = store.writeMeta({
            sourceProjectPath: source,
            id: 'new',
            label: 'hello',
            activeCompId: '12',
            currentTime: 1.5,
            sizeBytes: 2048,
        });
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        assert.equal(meta.label, 'hello');
        assert.equal(meta.activeCompId, '12');
        assert.match(meta.ts, /Z$/);
        assert.deepEqual(store.list(source, { limit: 10 }).map(function (entry) { return entry.id; }), ['new', 'old']);
        assert.deepEqual(store.list(source, { limit: 1 }).map(function (entry) { return entry.id; }), ['new']);
        assert.equal(store.latest(source).id, 'new');
        assert.equal(store.lookupAep(source, 'new'), path.join(directory, 'new.aep'));
        assert.equal(store.lookupAep(source, 'missing'), null);
        assert.equal(store.lookupAep(path.join(directory, 'new.aep'), 'new'), path.join(directory, 'new.aep'));
    });
});

test('list filters mismatched projects and cleans orphan metadata', () => {
    withStore({}, function (store) {
        const source = 'C:/a/project.aep';
        const directory = store._dirFor(source);
        touchAep(path.join(directory, 'good.aep'));
        writeMeta(path.join(directory, 'good.json'), {
            id: 'good', ts: '2026-04-27T10:00:00Z', sourceProjectPath: source,
        });
        touchAep(path.join(directory, 'stray.aep'));
        writeMeta(path.join(directory, 'stray.json'), {
            id: 'stray', ts: '2026-04-27T11:00:00Z', sourceProjectPath: 'C:/elsewhere/project.aep',
        });
        writeMeta(path.join(directory, 'orphan.json'), {
            id: 'orphan', ts: '2026-04-27T12:00:00Z', sourceProjectPath: source,
        });
        assert.deepEqual(store.list(source, { limit: 10 }).map(function (entry) { return entry.id; }), ['good']);
        assert.equal(fs.existsSync(path.join(directory, 'orphan.json')), false);
    });
});

test('prune and remove affect only the selected project', () => {
    withStore({ keep: 2 }, function (store) {
        const source = 'C:/a/project.aep';
        const other = 'C:/b/project.aep';
        const directory = store._dirFor(source);
        for (let i = 0; i < 4; i += 1) {
            const id = 'id-' + i;
            touchAep(path.join(directory, id + '.aep'));
            writeMeta(path.join(directory, id + '.json'), {
                id, ts: '2026-04-27T10:00:0' + i + 'Z', sourceProjectPath: source,
            });
        }
        const otherDirectory = store._dirFor(other);
        touchAep(path.join(otherDirectory, 'other.aep'));
        writeMeta(path.join(otherDirectory, 'other.json'), {
            id: 'other', ts: '2026-04-27T10:00:00Z', sourceProjectPath: other,
        });
        assert.deepEqual(store.prune(source), ['id-1', 'id-0']);
        assert.deepEqual(store.list(source, { limit: 10 }).map(function (entry) { return entry.id; }), ['id-3', 'id-2']);
        assert.equal(store.latest(other).id, 'other');
        assert.equal(store.remove(other, 'other'), true);
        assert.equal(store.remove(other, 'other'), false);
    });
});
