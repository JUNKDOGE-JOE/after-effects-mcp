'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildTools, noTopLevelCombinator } = require('./tools');

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
        'ae_status', 'ae_exec', 'ae_previewFrame', 'ae_read', 'ae_checkpoint',
        'ae_revert', 'ae_validateExpressions', 'ae_nativeExec', 'ae_toolSearch',
        'ae_toolUse', 'ae_skillUse',
    ]);
    tools.forEach(function (tool) {
        assert.equal(tool.inputSchema.type, 'object');
        assert.equal(noTopLevelCombinator(tool.inputSchema), true);
    });
    const exec = tools.find(function (tool) { return tool.name === 'ae_exec'; });
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
