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
test('atomicReplace uses a sibling temp file, replaces atomically, and cleans a failed copy', function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-atomic-'));
    const src = path.join(root, 'source.aep');
    const dst = path.join(root, 'target.aep');
    fs.writeFileSync(src, 'new');
    fs.writeFileSync(dst, 'old');
    let temporary = '';
    const io = Object.assign({}, fs, {
        mkdtempSync: function (prefix) {
            assert.equal(path.dirname(prefix), root);
            temporary = fs.mkdtempSync(prefix);
            return temporary;
        },
    });
    atomicReplace(src, dst, io);
    assert.equal(fs.readFileSync(dst, 'utf8'), 'new');
    assert.equal(fs.existsSync(temporary + '.aep.tmp'), false);
    fs.writeFileSync(dst, 'old-again');
    const failing = Object.assign({}, fs, {
        mkdtempSync: fs.mkdtempSync,
        copyFileSync: function () {
            throw new Error('disk full');
        },
    });
    assert.throws(function () {
        atomicReplace(src, dst, failing);
    }, /disk full/);
    assert.equal(fs.readFileSync(dst, 'utf8'), 'old-again');
    fs.rmSync(root, { recursive: true, force: true });
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
