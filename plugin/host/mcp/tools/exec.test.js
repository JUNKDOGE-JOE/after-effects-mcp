'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CheckpointStore } = require('../checkpoint-store');
const { RecoveryStore } = require('../recovery-store');
const { ToolLibrary } = require('../tool-library');
const { PROJECT_PATH_CODE } = require('../checkpoint-ops');
const execTool = require('./exec');
const execRecoverTool = require('./exec-recover');

function context(tier) {
    return {
        session: { id: 'session', clientName: 'test-client', conversationId: 'conversation' },
        policy: { approvalTier: tier === undefined ? null : tier },
    };
}

function reply(value) {
    return { payload: { ok: true, resultType: 'string', result: JSON.stringify(value) } };
}

function success(value, extras) {
    return {
        payload: Object.assign({
            ok: true,
            resultType: 'json',
            result: JSON.stringify(value || { ok: true }),
        }, extras || {}),
    };
}

function failed(error, extras, disposition) {
    const value = disposition || 'failed';
    return {
        disposition: value,
        payload: Object.assign({ ok: false, error, disposition: value }, extras || {}),
    };
}

function value(output) {
    return output.result.structuredContent;
}

function fixture() {
    execTool._resetRecentProjectPathForTest();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-exec-tool-'));
    const project = path.join(root, 'project.aep');
    fs.writeFileSync(project, 'current-project', 'utf8');
    const checkpointStore = new CheckpointStore({ root: path.join(root, 'checkpoints') });
    const recoveryStore = new RecoveryStore({ checkpointStore });
    const toolLibrary = new ToolLibrary({
        toolRoot: path.join(root, 'tools'),
        skillRoot: path.join(root, 'skills'),
        bundledRoot: path.join(__dirname, '..', 'skills_bundled'),
    });
    const calls = [];
    let userHandler = async function () { return success({ ok: true }); };
    const deps = {
        getCheckpointStore: function () { return checkpointStore; },
        getRecoveryStore: function () { return recoveryStore; },
        getToolLibrary: function () { return toolLibrary; },
        setUserHandler: function (handler) { userHandler = handler; },
        executeJsx: async function (input) {
            if (input.code === PROJECT_PATH_CODE) {
                calls.push('resolve');
                return reply({ ok: true, path: project });
            }
            if (/ae\.checkpoint create/.test(input.code)) {
                calls.push('checkpoint');
                const match = input.code.match(/var dstPath = (".*");/);
                const destination = JSON.parse(match[1]);
                fs.mkdirSync(path.dirname(destination), { recursive: true });
                fs.writeFileSync(destination, 'checkpoint-project', 'utf8');
                return reply({ ok: true, sizeBytes: 18, activeCompId: '7', currentTime: 1.5 });
            }
            if (/CloseOptions\.DO_NOT_SAVE_CHANGES/.test(input.code)) {
                calls.push('close');
                return reply({ ok: true, closed: true });
            }
            if (/app\.open\(f\)/.test(input.code)) {
                calls.push('open');
                return reply({ ok: true, openedPath: project });
            }
            if (/itemByID/.test(input.code)) {
                calls.push('viewer');
                return reply({ ok: true, viewerRestored: true });
            }
            calls.push('user:' + input.code);
            return userHandler(input);
        },
    };
    return {
        root,
        project,
        checkpointStore,
        recoveryStore,
        toolLibrary,
        calls,
        deps,
        close: function () { fs.rmSync(root, { recursive: true, force: true }); },
    };
}

test('ae_exec accepts only new executions and ae_execRecover owns the compact recovery form', async () => {
    assert.equal(Object.prototype.hasOwnProperty.call(execTool.definition.inputSchema, 'oneOf'), false);
    assert.deepEqual(execTool.definition.inputSchema.required, ['code']);
    assert.equal(Object.prototype.hasOwnProperty.call(execTool.definition.inputSchema.properties, 'recoveryId'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(execTool.definition.inputSchema.properties, 'retryMode'), false);
    assert.deepEqual(execRecoverTool.definition.inputSchema.required, ['recoveryId']);
    assert.equal(execRecoverTool.definition.inputSchema.properties.recoveryId.minLength, 6);
    assert.equal(execRecoverTool.definition.inputSchema.properties.recoveryId.maxLength, 6);
    assert.match(execRecoverTool.definition.inputSchema.properties.recoveryId.description, /Never invent|exact/i);
    assert.deepEqual(execRecoverTool.definition.inputSchema.properties.retryMode.enum, ['restore', 'continue']);
    assert.equal(execTool.definition.outputSchema.properties.artifactId.type, 'string');
    assert.ok(Buffer.byteLength(JSON.stringify(execRecoverTool.definition), 'utf8') < 2500);
    const missing = value(await execTool.call({}, context(null), {}));
    assert.equal(missing.error, 'missing or empty `code`');
    const misplacedRecovery = value(await execTool.call({
        code: '1', retryMode: 'continue',
    }, context(null), {}));
    assert.equal(misplacedRecovery.error, 'recovery fields are only accepted by `ae_execRecover`');
    const missingRecoveryId = value(await execRecoverTool.call({ code: 'fixed' }, context(null), {}));
    assert.match(missingRecoveryId.error, /recoveryId.*must match/);
});

test('successful execution returns a captured artifact id while capture errors leave success unchanged', async () => {
    const f = fixture();
    try {
        const captured = value(await execTool.call({
            code: 'app.project.activeItem;', undo_group_name: 'Inspect project',
        }, context(null), f.deps));
        assert.equal(captured.ok, true);
        assert.match(captured.artifactId, /^user:/);
        const artifact = f.toolLibrary.getArtifact(captured.artifactId);
        assert.equal(artifact.name, 'Inspect project');
        assert.equal(artifact.source.provenance.tool, 'ae_exec');

        f.deps.getToolLibrary = function () { throw new Error('capture unavailable'); };
        const uncaptured = value(await execTool.call({ code: '2 + 2' }, context(null), f.deps));
        assert.equal(uncaptured.ok, true);
        assert.equal(Object.prototype.hasOwnProperty.call(uncaptured, 'artifactId'), false);
    } finally {
        f.close();
    }
});

test('initial dispatched failure writes byte-identical recovery script and attempt metadata', async () => {
    const f = fixture();
    try {
        const code = 'var x = 1;\nthrow new Error("bad");';
        f.deps.setUserHandler(async function (input) {
            assert.equal(input.diagnostics, true);
            return failed('ExtendScript error: bad (line 2)', {
                errorLine: 2,
                touched: { level: 'layer_diff', layersChanged: [{ layer: { name: 'Layer' } }] },
                logs: ['before failure'],
                revision: { before: 10, after: 11 },
                projectPath: f.project,
            });
        });
        const output = await execTool.call({
            code,
            checkpoint_label: 'before failure',
            undo_group_name: 'Failure',
            timeout_sec: 45,
        }, context(null), f.deps);
        const result = value(output);
        assert.equal(output.result.isError, true);
        assert.match(result.recoveryId, /^[a-z0-9]{6}$/);
        assert.equal(fs.readFileSync(result.scriptPath, 'utf8'), code);
        assert.equal(typeof result.checkpointId, 'string');
        assert.equal(result.errorLine, 2);
        assert.equal(result.errorSource, 'throw new Error("bad");');
        assert.equal(result.touched.level, 'layer_diff');
        const entry = f.recoveryStore.lookup(result.recoveryId, f.project);
        const meta = f.recoveryStore.readMeta(entry);
        assert.equal(meta.checkpointId, result.checkpointId);
        assert.equal(meta.args.undo_group_name, 'Failure');
        assert.equal(meta.args.checkpoint_label, 'before failure');
        assert.equal(meta.client, 'test-client');
        assert.equal(meta.conversationId, 'conversation');
        assert.equal(meta.attempts.length, 1);
        assert.equal(meta.attempts[0].n, 1);
        assert.equal(meta.attempts[0].errorLine, 2);
        assert.equal(meta.attempts[0].errorSource, 'throw new Error("bad");');
        assert.equal(meta.attempts[0].touchedLevel, 'layer_diff');
        assert.equal(f.toolLibrary.list({ statuses: ['candidate'] }).length, 0);
    } finally {
        f.close();
    }
});

test('uncertain execution gets recovery while not_dispatched does not', async () => {
    const f = fixture();
    try {
        f.deps.setUserHandler(async function () { return { disposition: 'uncertain' }; });
        const uncertain = value(await execTool.call({ code: 'uncertain-code' }, context(null), f.deps));
        assert.match(uncertain.recoveryId, /^[a-z0-9]{6}$/);
        assert.equal(fs.readFileSync(uncertain.scriptPath, 'utf8'), 'uncertain-code');
        f.deps.setUserHandler(async function () { return failed('invalidation failed', {}, 'not_dispatched'); });
        const denied = value(await execTool.call({ code: 'never-dispatched' }, context(null), f.deps));
        assert.equal(denied.disposition, 'not_dispatched');
        assert.equal(Object.prototype.hasOwnProperty.call(denied, 'recoveryId'), false);
    } finally {
        f.close();
    }
});

test('retry restores checkpoint, restores viewer, checkpoints again, then runs edited disk script', async () => {
    const f = fixture();
    try {
        f.deps.setUserHandler(async function () {
            return failed('boom', {
                revision: { before: 1, after: 2 },
                projectPath: f.project,
            });
        });
        const first = value(await execTool.call({
            code: 'broken', checkpoint_label: 'before',
        }, context(null), f.deps));
        const entry = f.recoveryStore.lookup(first.recoveryId, f.project);
        f.recoveryStore.writeScript(entry, 'fixed');
        f.calls.length = 0;
        let approvals = 0;
        f.deps.approvals = {
            request: async function () {
                approvals += 1;
                return 'accept';
            },
        };
        f.deps.setUserHandler(async function (input) {
            assert.equal(input.code, 'fixed');
            return success({ ok: true, fixed: true }, {
                revision: { before: 1, after: 2 }, projectPath: f.project,
            });
        });
        const retried = value(await execRecoverTool.call({ recoveryId: first.recoveryId }, context('manual'), f.deps));
        assert.equal(retried.ok, true);
        assert.equal(retried.recoveryId, first.recoveryId);
        assert.equal(retried.attempt, 2);
        assert.equal(retried.restored, 'checkpoint');
        assert.match(retried.artifactId, /^user:/);
        assert.equal(f.toolLibrary.getArtifact(retried.artifactId).source.provenance.tool, 'ae_execRecover');
        assert.equal(approvals, 1);
        assert.deepEqual(f.calls, [
            'resolve', 'close', 'open', 'viewer', 'resolve', 'checkpoint', 'user:fixed',
        ]);
        const meta = f.recoveryStore.readMeta(entry);
        assert.equal(meta.attempts.length, 2);
        assert.notEqual(meta.checkpointId, first.checkpointId);
        assert.equal(meta.attempts[1].checkpointId, meta.checkpointId);
    } finally {
        f.close();
    }
});

test('continue skips restore and inline code replaces the recovery script', async () => {
    const f = fixture();
    try {
        f.deps.setUserHandler(async function () {
            return failed('boom', { revision: { before: 1, after: 2 }, projectPath: f.project });
        });
        const first = value(await execTool.call({ code: 'broken' }, context(null), f.deps));
        let lookupHint = null;
        const originalLookup = f.recoveryStore.lookup.bind(f.recoveryStore);
        f.recoveryStore.lookup = function (recoveryId, sourcePathHint) {
            lookupHint = sourcePathHint;
            return originalLookup(recoveryId, sourcePathHint);
        };
        f.calls.length = 0;
        f.deps.setUserHandler(async function () { return success({ ok: true }); });
        const retried = value(await execRecoverTool.call({
            recoveryId: first.recoveryId,
            retryMode: 'continue',
            code: 'inline-fixed',
        }, context(null), f.deps));
        assert.equal(retried.restored, 'skipped');
        assert.equal(lookupHint, f.project);
        assert.deepEqual(f.calls, ['user:inline-fixed']);
        const entry = f.recoveryStore.lookup(first.recoveryId, f.project);
        assert.equal(f.recoveryStore.readScript(entry), 'inline-fixed');
    } finally {
        f.close();
    }
});

test('retry rejects unknown ids, project mismatch, and changed projects without checkpoints', async () => {
    const f = fixture();
    try {
        assert.match(
            value(await execRecoverTool.call({ recoveryId: 'abc123' }, context(null), f.deps)).error,
            /unknown recoveryId/,
        );
        f.deps.setUserHandler(async function () {
            return failed('boom', { revision: { before: 3, after: 4 }, projectPath: f.project });
        });
        const noCheckpoint = value(await execTool.call({ code: 'changed' }, context(null), f.deps));
        const unavailable = value(await execRecoverTool.call({ recoveryId: noCheckpoint.recoveryId }, context(null), f.deps));
        assert.equal(unavailable.code, 'RECOVERY_RESTORE_UNAVAILABLE');

        const withCheckpoint = value(await execTool.call({
            code: 'changed-with-checkpoint', checkpoint_label: 'before',
        }, context(null), f.deps));
        const other = path.join(f.root, 'other.aep');
        fs.writeFileSync(other, 'other', 'utf8');
        const originalExecute = f.deps.executeJsx;
        f.deps.executeJsx = async function (input) {
            if (input.code === PROJECT_PATH_CODE) return reply({ ok: true, path: other });
            return originalExecute(input);
        };
        const mismatch = value(await execRecoverTool.call({ recoveryId: withCheckpoint.recoveryId }, context(null), f.deps));
        assert.equal(mismatch.code, 'RECOVERY_PROJECT_MISMATCH');
        assert.equal(f.calls.some(function (entry) { return entry === 'close'; }), false);
    } finally {
        f.close();
    }
});

test('malformed or unknown recovery ids never execute accompanying code', async () => {
    const f = fixture();
    try {
        const malformed = value(await execRecoverTool.call({ recoveryId: 'BAD-ID', code: 'must-not-run' }, context(null), f.deps));
        assert.match(malformed.error, /must match/);
        assert.match(malformed.error, /code was not executed/);
        assert.match(malformed.error, /exact id returned by ae_exec/);

        const unknown = value(await execRecoverTool.call({ recoveryId: 'abc123', code: 'must-not-run' }, context(null), f.deps));
        assert.match(unknown.error, /unknown recoveryId/);
        assert.match(unknown.error, /code was not executed/);
        assert.match(unknown.error, /exact id returned by ae_exec/);
        assert.deepEqual(f.calls, []);
    } finally {
        f.close();
    }
});

test('unchanged revision retries without a checkpoint and repeated failure reuses the id', async () => {
    const f = fixture();
    try {
        let failAgain = false;
        f.deps.setUserHandler(async function () {
            return failed('boom', { revision: { before: 5, after: 5 }, projectPath: f.project });
        });
        const first = value(await execTool.call({ code: 'broken' }, context(null), f.deps));
        f.deps.setUserHandler(async function () {
            return failAgain
                ? failed('still broken', {
                    errorLine: 2,
                    revision: { before: 5, after: 5 },
                    projectPath: f.project,
                })
                : success({ ok: true }, { revision: { before: 5, after: 5 }, projectPath: f.project });
        });
        const successful = value(await execRecoverTool.call({
            recoveryId: first.recoveryId, code: 'fixed',
        }, context(null), f.deps));
        assert.equal(successful.restored, 'not-needed');

        f.deps.setUserHandler(async function () {
            return failed('boom2', {
                errorLine: 2,
                revision: { before: 8, after: 8 },
                projectPath: f.project,
            });
        });
        const second = value(await execTool.call({ code: 'broken-again' }, context(null), f.deps));
        failAgain = true;
        const failedRetry = value(await execRecoverTool.call({
            recoveryId: second.recoveryId, code: 'line1\nstill-broken',
        }, context(null), f.deps));
        assert.equal(failedRetry.recoveryId, second.recoveryId);
        assert.equal(failedRetry.attempt, 2);
        assert.equal(failedRetry.errorSource, 'still-broken');
        const entry = f.recoveryStore.lookup(second.recoveryId, f.project);
        const meta = f.recoveryStore.readMeta(entry);
        assert.equal(meta.attempts.length, 2);
        assert.equal(meta.attempts[1].errorSource, 'still-broken');
    } finally {
        f.close();
    }
});

test('retry uses one ae_execRecover approval with complete code and recovery summary fields', async () => {
    const f = fixture();
    try {
        const code = 'x'.repeat(250);
        const entry = f.recoveryStore.create({
            sourceProjectPath: f.project,
            code,
            meta: {
                checkpointId: null,
                args: { undo_group_name: null, checkpoint_label: null, timeout_sec: null },
                attempts: [{ n: 1, revision: { before: 1, after: 1 } }],
            },
        });
        const readonly = value(await execRecoverTool.call({ recoveryId: entry.recoveryId }, context('readonly'), f.deps));
        assert.match(readonly.error, /read-only approval tier/);
        let requested = null;
        f.deps.approvals = {
            request: async function (item) {
                requested = item;
                return 'accept';
            },
        };
        f.deps.setUserHandler(async function () { return success({ ok: true }); });
        const approved = value(await execRecoverTool.call({ recoveryId: entry.recoveryId }, context('manual'), f.deps));
        assert.equal(approved.ok, true);
        assert.equal(requested.tool, 'ae_execRecover');
        assert.equal(requested.summary.code, code.slice(0, 200));
        assert.equal(requested.summary.recoveryId, entry.recoveryId);
        assert.equal(requested.summary.retryMode, 'restore');
        assert.equal(requested.summary.restoreCheckpointId, null);
    } finally {
        f.close();
    }
});

test('history-guard placeholder code is rejected before execution and never overwrites a stored recovery script', async () => {
    const f = fixture();
    try {
        const freshMarker = '/* ae-mcp: script body hidden from history to save tokens. Never send this comment back as code. */';
        const rejected = value(await execTool.call({ code: freshMarker }, context(null), f.deps));
        assert.equal(rejected.ok, false);
        assert.match(rejected.error, /redaction placeholder/);
        assert.doesNotMatch(rejected.error, /Recent successful scripts/);
        assert.equal(f.calls.length, 0);

        f.deps.setUserHandler(async function () {
            return failed('ExtendScript error: bad (line 2)', { errorLine: 2 });
        });
        const failure = value(await execTool.call({ code: 'var broken = 1;\nthrow new Error("bad");' }, context(null), f.deps));
        assert.ok(failure.recoveryId);
        const stored = fs.readFileSync(failure.scriptPath, 'utf8');

        f.deps.setUserHandler(async function () { return success({ ok: true }); });
        const captured = value(await execTool.call({ code: 'captured-success' }, context(null), f.deps));

        const callsBefore = f.calls.length;
        const blocked = value(await execRecoverTool.call({
            recoveryId: failure.recoveryId,
            code: '/* executed AE script omitted from prior model history */',
        }, context(null), f.deps));
        assert.equal(blocked.ok, false);
        assert.match(blocked.error, /redaction placeholder/);
        assert.match(blocked.error, /omit `code`/);
        assert.match(blocked.error, new RegExp(captured.artifactId));
        assert.match(blocked.error, /chars=16/);
        assert.equal(f.calls.length, callsBefore);
        assert.equal(fs.readFileSync(failure.scriptPath, 'utf8'), stored);
    } finally {
        f.close();
    }
});

test('a thrown ExtendScript error reaches the tool result with an appended hint', async () => {
    const f = fixture();
    try {
        f.deps.setUserHandler(async function () {
            return failed('ExtendScript error: TypeError: null 不是对象 (line 3)', { errorLine: 3 });
        });
        const failure = value(await execTool.call({ code: 'var v = comp.layer(99);\nv.name;\nv.x;' }, context(null), f.deps));
        assert.equal(failure.ok, false);
        assert.match(failure.error, /\[hint\]/);
        assert.match(failure.error, /lookup returned null/);
    } finally {
        f.close();
    }
});
