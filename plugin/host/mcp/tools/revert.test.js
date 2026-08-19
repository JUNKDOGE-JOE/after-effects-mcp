'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { call } = require('./revert');
function reply(value) {
    return { payload: { ok: true, result: JSON.stringify(value) } };
}
function context(tier) {
    return { session: { id: 's', clientName: 'test', conversationId: 'c' }, policy: { approvalTier: tier } };
}
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-revert-'));
    const project = path.join(root, 'project.aep');
    const saved = path.join(root, 'saved.aep');
    fs.writeFileSync(project, 'changed');
    fs.writeFileSync(saved, 'checkpoint');
    return {
        root,
        project,
        saved,
        store: {
            lookupAep: function () {
                return saved;
            },
            makeId: function () {
                return 'branch';
            },
            aepPath: function () {
                return path.join(root, 'branch.aep');
            },
            writeMeta: function () {},
            prune: function () {},
        },
    };
}
test('ae_revert closes, atomically replaces, opens, and returns the Python-shaped result', async function () {
    const f = fixture();
    const codes = [];
    let n = 0;
    const output = await call({ checkpoint_id: 'saved' }, context(null), {
        getCheckpointStore: function () {
            return f.store;
        },
        executeJsx: async function (input) {
            codes.push(input.code);
            n += 1;
            if (n === 1) return reply({ ok: true, path: f.project });
            if (n === 2) return reply({ ok: true, closed: true });
            return reply({ ok: true, openedPath: f.project });
        },
    });
    assert.equal(fs.readFileSync(f.project, 'utf8'), 'checkpoint');
    assert.match(codes[1], /CloseOptions\.DO_NOT_SAVE_CHANGES/);
    assert.match(codes[2], /project\.aep/);
    assert.deepEqual(output.result.structuredContent, {
        ok: true,
        reverted: true,
        openedPath: f.project,
        restoredTo: f.project,
        branchedFromId: null,
    });
    fs.rmSync(f.root, { recursive: true, force: true });
});
test('ae_revert branches before close and reports missing, replace, reopen, and approval failures', async function () {
    const f = fixture();
    const codes = [];
    let n = 0;
    const branch = await call({ checkpoint_id: 'saved', branch_before_revert: true }, context(null), {
        getCheckpointStore: function () {
            return f.store;
        },
        executeJsx: async function (input) {
            codes.push(input.code);
            n += 1;
            if (n === 1) return reply({ ok: true, path: f.project });
            if (n === 2) return reply({ ok: true, sizeBytes: 0 });
            if (n === 3) return reply({ ok: true, closed: true });
            return reply({ ok: true, openedPath: f.project });
        },
    });
    assert.equal(branch.result.structuredContent.branchedFromId, 'branch');
    assert.match(codes[1], /ae\.checkpoint create/);
    const missing = await call({ checkpoint_id: 'nope' }, context(null), {
        getCheckpointStore: function () {
            return Object.assign({}, f.store, {
                lookupAep: function () {
                    return null;
                },
            });
        },
        executeJsx: async function () {
            return reply({ ok: true, path: f.project });
        },
    });
    assert.match(missing.result.structuredContent.error, /checkpoint not found/);
    n = 0;
    const replace = await call({ checkpoint_id: 'saved' }, context(null), {
        getCheckpointStore: function () {
            return f.store;
        },
        atomicReplace: function () {
            throw new Error('copy failed');
        },
        executeJsx: async function () {
            n += 1;
            return n === 1
                ? reply({ ok: true, path: f.project })
                : n === 2
                  ? reply({ ok: true })
                  : reply({ ok: true, openedPath: f.project });
        },
    });
    assert.equal(replace.result.structuredContent.stage, 'replace');
    assert.equal(replace.result.structuredContent.recoveredOriginal, true);
    n = 0;
    const reopen = await call({ checkpoint_id: 'saved' }, context(null), {
        getCheckpointStore: function () {
            return f.store;
        },
        executeJsx: async function () {
            n += 1;
            return n === 1
                ? reply({ ok: true, path: f.project })
                : n === 2
                  ? reply({ ok: true })
                  : reply({ ok: false, error: 'open failed' });
        },
    });
    assert.equal(reopen.result.structuredContent.stage, 'reopen');
    assert.equal(reopen.result.structuredContent.reverted, true);
    const readonly = await call({ checkpoint_id: 'saved' }, context('readonly'), {
        getCheckpointStore: function () {
            return f.store;
        },
        executeJsx: async function () {
            throw new Error('must not run');
        },
    });
    assert.match(readonly.result.structuredContent.error, /read-only approval tier/);
    let approved = false;
    const manual = await call({ checkpoint_id: 'saved' }, context('manual'), {
        getCheckpointStore: function () {
            return f.store;
        },
        approvals: {
            request: async function () {
                approved = true;
                return 'accept';
            },
        },
        executeJsx: async function () {
            n += 1;
            return n % 3 === 1
                ? reply({ ok: true, path: f.project })
                : n % 3 === 2
                  ? reply({ ok: true })
                  : reply({ ok: true, openedPath: f.project });
        },
    });
    assert.equal(approved, true);
    assert.equal(manual.result.structuredContent.ok, true);
    fs.rmSync(f.root, { recursive: true, force: true });
});
