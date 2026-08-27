'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { assertPatternDescriptions, buildTools, noTopLevelCombinator } = require('./tools');

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
    ]);
    tools.forEach(function (tool) {
        assert.equal(tool.inputSchema.type, 'object');
        assert.equal(noTopLevelCombinator(tool.inputSchema), true);
    });
    assert.ok(
        Buffer.byteLength(JSON.stringify(tools), 'utf8') < 20000,
        'the complete advertised tool surface must fit the provider replay budget',
    );
    const exec = tools.find(function (tool) { return tool.name === 'ae_exec'; });
    const recover = tools.find(function (tool) { return tool.name === 'ae_execRecover'; });
    assert.deepEqual(exec.inputSchema.required, ['code']);
    assert.equal(Object.prototype.hasOwnProperty.call(exec.inputSchema.properties, 'recoveryId'), false);
    assert.deepEqual(recover.inputSchema.required, ['recoveryId']);
    assert.deepEqual(exec.outputSchema.properties.contentType.enum, ['text', 'json']);
    assert.match(exec.description, /contentType/);
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
