'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { call } = require('./checkpoint');

function context(tier) {
    return { session: { id: 's', clientName: 'test', conversationId: 'c' }, policy: { approvalTier: tier } };
}
function reply(value) {
    return { payload: { ok: true, result: JSON.stringify(value) } };
}
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-checkpoint-tool-'));
    const project = path.join(root, 'project.aep');
    const checkpoint = path.join(root, 'checkpoint.aep');
    fs.writeFileSync(project, 'project-bytes');
    const writes = [];
    let id = 0;
    return {
        root,
        project,
        checkpoint,
        writes,
        store: {
            makeId: function () {
                id += 1;
                return 'cp-' + id;
            },
            aepPath: function () {
                return checkpoint;
            },
            writeMeta: function (value) {
                writes.push(value);
            },
            prune: function () {},
            list: function () {
                return [];
            },
        },
    };
}
test('ae_checkpoint create probes path, renders the template, and persists metadata', async function () {
    const f = fixture();
    const calls = [];
    const result = await call({ action: 'create', label: 'before-edit' }, context(null), {
        getCheckpointStore: function () {
            return f.store;
        },
        executeJsx: async function (input) {
            calls.push(input);
            return calls.length === 1
                ? reply({ ok: true, path: f.project })
                : reply({ ok: true, sizeBytes: 0, activeCompId: '17', currentTime: 1.5 });
        },
    });
    assert.equal(calls.length, 2);
    assert.match(calls[0].code, /app\.project\.file/);
    assert.match(calls[1].code, /checkpoint\.aep/);
    assert.deepEqual(result.result.structuredContent, {
        ok: true,
        id: 'cp-1',
        label: 'before-edit',
        path: f.checkpoint,
        sizeBytes: 13,
        projectPath: f.project,
        activeCompId: '17',
        currentTime: 1.5,
    });
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].label, 'before-edit');
    assert.equal(fs.readFileSync(f.checkpoint, 'utf8'), 'project-bytes');
    fs.rmSync(f.root, { recursive: true, force: true });
});
test('ae_checkpoint create reports untitled and a failed template result explicitly', async function () {
    const f = fixture();
    const untitled = await call({ action: 'create' }, context(null), {
        getCheckpointStore: function () {
            return f.store;
        },
        executeJsx: async function () {
            return reply({ ok: true, path: null });
        },
    });
    assert.deepEqual(untitled.result.structuredContent, {
        ok: false,
        error: 'untitled-project',
        projectPath: null,
    });
    let step = 0;
    const failed = await call({ action: 'create' }, context(null), {
        getCheckpointStore: function () {
            return f.store;
        },
        executeJsx: async function () {
            step += 1;
            return step === 1
                ? reply({ ok: true, path: f.project })
                : reply({ ok: false, error: 'save failed' });
        },
    });
    assert.equal(failed.result.isError, true);
    assert.equal(failed.result.structuredContent.error, 'checkpoint-failed: bad-result');
    fs.rmSync(f.root, { recursive: true, force: true });
});
test('ae_checkpoint list uses the store order and limit, and approval tiers gate writes', async function () {
    const f = fixture();
    const entries = [{ id: 'new' }, { id: 'old' }];
    let calls = 0;
    f.store.list = function (project, options) {
        assert.equal(project, f.project);
        assert.equal(options.limit, 1);
        return entries.slice(0, options.limit);
    };
    const listed = await call({ limit: 1 }, context(null), {
        getCheckpointStore: function () {
            return f.store;
        },
        executeJsx: async function () {
            calls += 1;
            return reply({ ok: true, path: f.project });
        },
    });
    assert.deepEqual(listed.result.structuredContent, { ok: true, checkpoints: [{ id: 'new' }], total: 1 });
    const readonly = await call({ action: 'create' }, context('readonly'), {
        getCheckpointStore: function () {
            return f.store;
        },
        executeJsx: async function () {
            throw new Error('must not run');
        },
    });
    assert.match(readonly.result.structuredContent.error, /read-only approval tier/);
    let approved = false;
    const manual = await call({ action: 'create' }, context('manual'), {
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
            calls += 1;
            return calls % 2 === 0 ? reply({ ok: true, path: f.project }) : reply({ ok: true, sizeBytes: 0 });
        },
    });
    assert.equal(approved, true);
    assert.equal(manual.result.structuredContent.ok, true);
    fs.rmSync(f.root, { recursive: true, force: true });
});
