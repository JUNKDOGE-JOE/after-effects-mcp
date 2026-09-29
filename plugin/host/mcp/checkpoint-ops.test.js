'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { atomicReplace, autoCheckpoint, createCheckpoint } = require('./checkpoint-ops');
function reply(value) {
    return { payload: { ok: true, result: JSON.stringify(value) } };
}
test('atomicReplace uses a sibling temp file and leaves no temporary file or directory', function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-atomic-'));
    const src = path.join(root, 'source.aep');
    const dst = path.join(root, 'target.aep');
    fs.writeFileSync(src, 'new');
    fs.writeFileSync(dst, 'old');
    try {
        atomicReplace(src, dst);
        assert.equal(fs.readFileSync(dst, 'utf8'), 'new');
        assert.deepEqual(fs.readdirSync(root).sort(), ['source.aep', 'target.aep']);

        fs.writeFileSync(dst, 'old-again');
        const failing = Object.assign({}, fs, {
            copyFileSync: function () {
                throw new Error('disk full');
            },
        });
        assert.throws(function () {
            atomicReplace(src, dst, failing);
        }, /disk full/);
        assert.equal(fs.readFileSync(dst, 'utf8'), 'old-again');
        assert.deepEqual(fs.readdirSync(root).sort(), ['source.aep', 'target.aep']);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
test('createCheckpoint and autoCheckpoint share the same successful persistence path', async function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-ops-'));
    const project = path.join(root, 'p.aep');
    const checkpoint = path.join(root, 'c.aep');
    fs.writeFileSync(project, 'p');
    let id = 0;
    const writes = [];
    const deps = {
        getCheckpointStore: function () {
            return {
                makeId: function () {
                    id += 1;
                    return 'id' + id;
                },
                aepPath: function () {
                    return checkpoint;
                },
                writeMeta: function (x) {
                    writes.push(x);
                },
                prune: function () {},
            };
        },
        executeJsx: async function (input) {
            return /app\.project\.file/.test(input.code)
                ? reply({ ok: true, path: project })
                : reply({ ok: true, sizeBytes: 0 });
        },
    };
    const ctx = { session: { clientName: 'test' } };
    assert.equal((await createCheckpoint({ label: 'one' }, ctx, deps)).ok, true);
    const automatic = await autoCheckpoint({ checkpoint_label: 'two' }, ctx, deps);
    assert.equal(automatic.skipped, null);
    assert.equal(automatic.checkpoint.ok, true);
    assert.equal(automatic.checkpoint.id, 'id2');
    assert.equal(writes.length, 2);
    fs.rmSync(root, { recursive: true, force: true });
});


test('workspace checkpoint saves and copies the named source before registering an external file', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-workspace-checkpoint-'));
    t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
    const { CheckpointStore } = require('./checkpoint-store');
    const store = new CheckpointStore({ root: path.join(root, 'index') });
    const project = path.join(root, 'Main.aep');
    fs.writeFileSync(project, 'unsaved-before');
    const context = { contextId: 'ctx', workDir: root, session: { clientName: 'test' } };
    const deps = { getCheckpointStore: () => store, executeJsx: async (input) => {
        if (input.code.indexOf('app.project.save();') < 0) return reply({ ok: true, path: project });
        assert.equal(/^\s*app\.project\.save\(File/m.test(input.code), false);
        const destination = JSON.parse(/var dstPath = (.+);/.exec(input.code)[1]);
        fs.writeFileSync(project, 'saved-current');
        fs.copyFileSync(project, destination);
        return reply({ ok: true, sourceProjectPath: project, sizeBytes: 13 });
    } };
    const result = await createCheckpoint({ label: 'before' }, context, deps);
    assert.equal(result.ok, true);
    assert.equal(result.projectPath, project);
    assert.equal(result.placementSource, 'session-workdir');
    assert.equal(fs.readFileSync(result.path, 'utf8'), 'saved-current');
    assert.equal(store.lookupAep(project, result.id), result.path);
    assert.equal(store.readMeta(project, result.id).checkpointPath, result.path);
    const failedDeps = { ...deps,
        executeJsx: async (input) => input.code.indexOf('app.project.save();') < 0
            ? reply({ ok: true, path: project }) : reply({ ok: false, error: 'save failed' }),
    };
    const failed = await createCheckpoint({ label: 'failed' }, context, failedDeps);
    assert.equal(failed.ok, false);
    assert.equal(store.list(project).length, 1);
    const automaticFailure = await autoCheckpoint({ checkpoint_label: 'failed' }, context, failedDeps);
    assert.equal(automaticFailure.requiresAuthorization, true);
    assert.equal(automaticFailure.contextId, context.contextId);
    assert.equal(typeof automaticFailure.failureId, 'string');
    assert.equal(automaticFailure.checkpoint.ok, false);
    await assert.rejects(createCheckpoint({ projectPath: project }, { ...context, workDir: undefined }, deps), /workDir/);
});
