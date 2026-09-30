'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { assertPatternDescriptions, buildTools, noTopLevelCombinator, TOOL_MODULES } = require('./tools');

test('MCP input-schema patterns must explain their value constraint', () => {
    assert.doesNotThrow(function () {
        assertPatternDescriptions({
            type: 'object',
            properties: { id: { type: 'string', pattern: '^[a-z]+$', description: 'Lowercase ID.' } },
        }, 'fixture', 'inputSchema');
    });
    assert.throws(function () {
        assertPatternDescriptions({
            type: 'object',
            properties: { id: { type: 'string', pattern: '^[a-z]+$' } },
        }, 'fixture', 'inputSchema');
    }, /inputSchema\.properties\.id/);
});

test('tools/list uses top-level JSON-schema object forms only', () => {
    const registry = buildTools({
        getStatus: function () { return { ok: true }; },
        executeJsx: async function () {
            return { payload: { ok: true, resultType: 'string', result: '' } };
        },
        sessionCount: function () { return 1; },
    });
    const tools = registry.list();
    assert.deepEqual(tools.map(function (tool) { return tool.name; }), [
        'ae_status', 'ae_exec', 'ae_execRecover', 'ae_previewFrame', 'ae_read', 'ae_checkpoint',
        'ae_revert', 'ae_validateExpressions', 'ae_nativeExec', 'ae_toolSearch',
        'ae_toolUse', 'ae_toolSave', 'ae_skillUse',
        'ae_instances', 'ae_workspace', 'ae_readJob',
    ]);
    tools.forEach(function (tool) {
        assert.equal(tool.inputSchema.type, 'object');
        assert.equal(noTopLevelCombinator(tool.inputSchema), true);
    });
    assert.ok(
        Buffer.byteLength(JSON.stringify(tools), 'utf8') < 24000,
        'the complete advertised tool surface must fit the provider replay budget',
    );
    const exec = tools.find(function (tool) { return tool.name === 'ae_exec'; });
    const recover = tools.find(function (tool) { return tool.name === 'ae_execRecover'; });
    assert.deepEqual(exec.inputSchema.required, ['code']);
    assert.equal(Object.prototype.hasOwnProperty.call(exec.inputSchema.properties, 'recoveryId'), false);
    assert.deepEqual(recover.inputSchema.required, ['recoveryId']);
    assert.deepEqual(exec.outputSchema.properties.contentType.enum, ['text', 'json']);
    assert.match(exec.description, /contentType/);
    assert.match(tools.find(function (tool) { return tool.name === 'ae_toolSearch'; }).description,
        /before repeating an operation/);
    assert.match(tools.find(function (tool) { return tool.name === 'ae_toolUse'; }).description,
        /Prefer it over rewriting a script/);
    assert.match(tools.find(function (tool) { return tool.name === 'ae_toolSave'; }).description,
        /promote a captured candidate/);
    assert.match(tools.find(function (tool) { return tool.name === 'ae_skillUse'; }).description,
        /prompt skills you saved/);
});

test('ae_exec surfaces explicit contentType and never sniffs JSON-like text', async () => {
    const registry = buildTools({
        getStatus: function () { return { ok: true }; },
        executeJsx: async function (request) {
            if (request.code === 'object') {
                return {
                    payload: {
                        ok: true,
                        resultType: 'json',
                        result: '{"ok":true,"n":42}',
                    },
                };
            }
            return {
                payload: {
                    ok: true,
                    resultType: 'string',
                    result: '{"broken":',
                },
            };
        },
        sessionCount: function () { return 1; },
    });
    const context = {
        session: { clientName: 'test', protocolVersion: '2025-06-18' },
        port: 1,
    };
    const structured = await registry.call({
        name: 'ae_exec', arguments: { code: 'object' },
    }, context);
    assert.deepEqual(structured.result.structuredContent, {
        ok: true,
        content: '{"ok":true,"n":42}',
        contentType: 'json',
    });
    const text = await registry.call({
        name: 'ae_exec', arguments: { code: 'json-like text' },
    }, context);
    assert.equal(text.result.isError, undefined);
    assert.deepEqual(text.result.structuredContent, {
        ok: true,
        content: '{"broken":',
        contentType: 'text',
    });
});

test('ae_exec preserves bridge disposition in structured tool errors', async () => {
    const registry = buildTools({
        getStatus: function () { return { ok: true }; },
        executeJsx: async function () {
            return {
                payload: { ok: false, error: 'pending ExtendScript result' },
                disposition: 'possibly-side-effecting',
            };
        },
        sessionCount: function () { return 1; },
    });
    const output = await registry.call({
        name: 'ae_exec', arguments: { code: 'app.project.activeItem' },
    }, { session: { clientName: 'test', protocolVersion: '2025-06-18' }, port: 1 });
    assert.equal(output.result.isError, true);
    assert.deepEqual(output.result.structuredContent, {
        ok: false,
        error: 'pending ExtendScript result',
        disposition: 'possibly-side-effecting',
    });
});

test('registry passes the MCP tool identity to the execution dependency', async () => {
    let request;
    const registry = buildTools({
        getStatus: function () { return { ok: true }; },
        executeJsx: async function (value) {
            request = value;
            return { payload: { ok: true, resultType: 'string', result: 'ok' } };
        },
        sessionCount: function () { return 1; },
    });
    await registry.call({ name: 'ae_exec', arguments: { code: '1 + 1' } }, {
        session: { clientName: 'cursor' },
        port: 1,
    });
    assert.equal(request.tool, 'ae_exec');
    assert.equal(request.transport, 'mcp');
});

test('tool calls returning no output are converted to a structured tool error', async () => {
    const tool = TOOL_MODULES.find(function (item) { return item.definition.name === 'ae_status'; });
    const originalCall = tool.call;
    tool.call = async function () { return undefined; };
    try {
        const registry = buildTools({ sessionCount: function () { return 1; } });
        const output = await registry.call({ name: 'ae_status', arguments: {} }, {
            session: { clientName: 'test', protocolVersion: '2025-06-18' },
            port: 1,
        });
        assert.equal(output.result.isError, true);
        assert.deepEqual(output.result.structuredContent, {
            ok: false,
            error: 'tool returned no result',
        });
    } finally {
        tool.call = originalCall;
    }
});


test('checkpoint failure continuation is bound to one unchanged operation and excludes uncertain saves', async (t) => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { CheckpointStore } = require('./checkpoint-store');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-checkpoint-confirm-'));
    t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
    const projectPath = path.join(root, 'Main.aep');
    const store = new CheckpointStore({ root: path.join(root, 'index') });
    let edits = 0;
    let checkpointMode = 'copy-failed';
    const registry = buildTools({
        getCheckpointStore: () => store,
        routeTool: (params, context, invoke) => invoke({ ...context,
            contextId: params.arguments.context_id || 'writer-one', projectPath, workDir: root,
            checkpointContinue: params.arguments.checkpoint_continue,
        }),
        executeJsx: async (request) => {
            if (request.code.includes('app.project.save();')) {
                if (checkpointMode === 'uncertain') return { status: 504,
                    payload: { ok: false, error: 'save timed out', code: 'JSX_TIMEOUT', disposition: 'uncertain' } };
                return { status: 200, payload: { ok: true, result: JSON.stringify({ ok: false,
                    error: 'copy blocked', code: 'CHECKPOINT_COPY_FAILED', stage: 'copy',
                    disposition: 'not_dispatched', saveCompleted: true }) } };
            }
            if (request.code.includes('path: app.project.file')) return {
                payload: { ok: true, result: JSON.stringify({ ok: true, path: projectPath }) },
            };
            edits += 1;
            return { payload: { ok: true, resultType: 'json', result: '{"ok":true}' } };
        },
    });
    async function call(extra = {}) {
        return (await registry.call({ name: 'ae_exec', arguments: {
            code: 'edit-one', checkpoint_label: 'before', ...extra,
        } }, { session: { clientName: 'test' } })).result.structuredContent;
    }
    const blocked = await call();
    assert.equal(blocked.code, 'CHECKPOINT_FAILED');
    assert.equal(blocked.disposition, 'not_dispatched');
    assert.equal(blocked.checkpoint.stage, 'copy');
    assert.equal(edits, 0);
    const confirmation = { failure_id: blocked.checkpoint_failure_id, confirm: true };
    assert.equal(typeof confirmation.failure_id, 'string');
    for (const extra of [
        { checkpoint_continue: { ...confirmation, confirm: false } },
        { checkpoint_continue: { ...confirmation, failure_id: 'incorrect' } },
        { checkpoint_continue: confirmation, code: 'different-edit' },
        { checkpoint_continue: confirmation, context_id: 'writer-two' },
    ]) assert.equal((await call(extra)).code, 'CHECKPOINT_CONFIRMATION_REQUIRED');
    assert.equal(edits, 0);
    const continued = await call({ checkpoint_continue: confirmation });
    assert.equal(continued.ok, true);
    assert.equal(typeof continued.checkpointSkipped, 'string');
    assert.equal(edits, 1);
    assert.equal((await call({ checkpoint_continue: confirmation })).code, 'CHECKPOINT_CONFIRMATION_REQUIRED');
    assert.equal(edits, 1);
    checkpointMode = 'uncertain';
    const unknown = await call();
    assert.equal(unknown.disposition, 'uncertain');
    assert.equal(unknown.checkpoint.code, 'JSX_TIMEOUT');
    assert.equal(unknown.checkpoint.status, 504);
    const denied = await call({ checkpoint_continue: { failure_id: unknown.checkpoint_failure_id, confirm: true } });
    assert.equal(denied.code, 'CHECKPOINT_RESULT_UNKNOWN');
    assert.equal(edits, 1);
});
