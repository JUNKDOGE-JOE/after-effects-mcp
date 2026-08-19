'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildTools, noTopLevelCombinator } = require('./tools');

test('tools/list uses top-level JSON-schema object forms only', () => {
    const registry = buildTools({
        getStatus: function () { return { ok: true }; },
        executeJsx: async function () { return { payload: { ok: true, result: '' } }; },
        sessionCount: function () { return 1; },
    });
    const tools = registry.list();
    assert.deepEqual(tools.map(function (tool) { return tool.name; }), ['ae_status', 'ae_exec', 'ae_previewFrame', 'ae_read']);
    tools.forEach(function (tool) {
        assert.equal(tool.inputSchema.type, 'object');
        assert.equal(noTopLevelCombinator(tool.inputSchema), true);
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
