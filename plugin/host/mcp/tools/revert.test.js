'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { call, revertToCheckpoint } = require('./revert');
const { buildTools } = require('../tools');
const vm = require('node:vm');
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
    assert.equal(reopen.result.structuredContent.disposition, 'uncertain');
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

test('bound revert and recovery run through the public tool guard and continue on the restored generation', async t => {
    for (const tool of ['ae_revert', 'ae_execRecover']) {
        const f = fixture();
        t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
        const app = {};
        function project(file) {
            return { file, rootFolder: {}, numItems: file ? 1 : 0, dirty: false, revision: 1,
                close() { app.project = project(null); return true; } };
        }
        app.project = project({ fsName: f.project });
        app.open = file => (app.project = project(file));
        const $ = { global: { __aemcpProjectSerial: 1,
            __aemcpObservedProject: { root: app.project.rootFolder, generation: 1 } } };
        const scope = vm.createContext({ app, $, CloseOptions: { DO_NOT_SAVE_CHANGES: 0 },
            File: function (file) { this.fsName = path.resolve(file); this.exists = fs.existsSync(this.fsName); },
            isValid: root => root === app.project.rootFolder });
        const bound = { ...context(null), contextId: 'writer', projectPath: f.project, projectGeneration: 1,
            acceptRestoredProject: restored => restored };
        const tools = buildTools({
            getCheckpointStore: () => f.store,
            getRecoveryStore: () => ({ lookup: () => ({}), appendAttempt() {},
                readMeta: () => ({ sourceProjectPath: f.project, checkpointId: 'saved', args: {}, attempts: [] }),
                readScript: () => '$.global.recoveryRan=true;JSON.stringify({ok:true})' }),
            routeTool: (_params, _context, invoke) => invoke(bound),
            executeJsx: async input => {
                assert.equal(input.projectRestorePhase, undefined);
                if (/CloseOptions|app\.open\(f\)/.test(input.code)) assert.equal(input.nativeProjectGraphEffect, 'invalidate');
                return { payload: { ok: true, resultType: 'string', result: vm.runInContext(input.code, scope) } };
            },
        });
        const result = await tools.call({ name: tool, arguments: tool === 'ae_revert'
            ? { checkpoint_id: 'saved' } : { recoveryId: 'abc123', retryMode: 'restore' } }, context(null));
        assert.equal(result.result.structuredContent.ok, true, JSON.stringify(result.result));
        assert.equal(bound.projectGeneration, 2);
        assert.equal(app.project.file.fsName, f.project);
        assert.equal(fs.readFileSync(f.project, 'utf8'), 'checkpoint');
        if (tool === 'ae_execRecover') assert.equal($.global.recoveryRan, true);
    }
});

test('failed replace and reopen retain an uncertain result; a cancelled close never replaces the file', async t => {
    for (const failure of ['cancel', 'replace', 'open', 'timeout']) {
        const f = fixture();
        t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
        const result = await revertToCheckpoint('saved', { projectPath: f.project }, context(null), {
            getCheckpointStore: () => f.store,
            atomicReplace: () => { if (failure === 'replace') throw new Error('copy failed'); },
            executeJsx: async input => {
                if (input.projectRestorePhase === 'close') {
                    if (failure === 'timeout') throw Object.assign(new Error('timeout'), { disposition: 'uncertain' });
                    return reply(failure === 'cancel' ? { ok: false, error: 'cancelled' } : { ok: true, closed: true });
                }
                return reply({ ok: false, error: 'open failed' });
            },
        });
        assert.equal(result.ok, false);
        assert.equal(result.disposition, failure === 'cancel' ? undefined : 'uncertain');
        assert.equal(result.stage, failure === 'replace' ? 'replace' : failure === 'open' ? 'reopen' : 'close');
        assert.equal(fs.readFileSync(f.project, 'utf8'), 'changed');
    }
});

test('revertToCheckpoint is the shared result path and viewer restoration stays best-effort', async function () {
    const f = fixture();
    f.store.readMeta = function () {
        return { id: 'saved', activeCompId: '7', currentTime: 2.5 };
    };
    const codes = [];
    const deps = {
        getCheckpointStore: function () { return f.store; },
        executeJsx: async function (input) {
            codes.push(input.code);
            if (/app\.project\.file/.test(input.code)) return reply({ ok: true, path: f.project });
            if (/CloseOptions\.DO_NOT_SAVE_CHANGES/.test(input.code)) return reply({ ok: true, closed: true });
            if (/app\.open\(f\)/.test(input.code)) return reply({ ok: true, openedPath: f.project });
            if (/itemByID/.test(input.code)) throw new Error('viewer unavailable');
            throw new Error('unexpected JSX');
        },
    };
    const direct = await revertToCheckpoint('saved', {}, context(null), deps);
    assert.equal(direct.ok, true);
    assert.equal(direct.viewerRestored, false);
    assert.ok(codes.some(function (code) { return /itemByID\(7\)/.test(code); }));

    fs.writeFileSync(f.project, 'changed-again');
    codes.length = 0;
    const wrapped = await call({ checkpoint_id: 'saved' }, context(null), deps);
    assert.deepEqual(wrapped.result.structuredContent, direct);
    fs.rmSync(f.root, { recursive: true, force: true });
});
