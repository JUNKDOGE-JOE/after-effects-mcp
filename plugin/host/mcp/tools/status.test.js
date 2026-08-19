'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const status = require('./status');

function deps(result) {
    return {
        getStatus: function () { return { ok: true, pluginVersion: '0.9.6-test', port: 11488, jsxBridge: { state: 'idle' } }; },
        getNativeStatus: function () { return { state: 'connected' }; },
        getClients: function () { return [{ label: 'cursor', blocked: false }, { label: 'bad', blocked: true }]; },
        isPaused: function () { return true; },
        sessionCount: function () { return 3; },
        executeJsx: async function () { return result; },
    };
}

const context = { port: 11488, session: { clientName: 'test', protocolVersion: '2025-06-18' } };

test('ae_status ping echoes expect and identifies CEP host', async () => {
    const output = await status.call({ depth: 'ping', expect: 'hello' }, context, deps());
    assert.deepEqual(output.result.structuredContent, { ok: true, pong: 'hello', server: 'cep-host', pluginVersion: '0.9.6-test', port: 11488 });
});

test('ae_status status retains MCP sessions and host-only fields', async () => {
    const output = await status.call({}, context, deps());
    const value = output.result.structuredContent;
    assert.equal(value.mcp.sessions, 3);
    assert.deepEqual(value.nativeExecutionPlane, { available: true, adapter: 'native-aegp', engine: 'native-aegp' });
    assert.deepEqual(value.clients, [{ name: 'cursor', blocked: false }, { name: 'bad', blocked: true }]);
    assert.equal(value.python, null);
    assert.equal(value.paused, true);
});

test('ae_status diagnose reports responsive AE and keeps overall status on failures', async () => {
    const good = await status.call({ depth: 'diagnose' }, context, deps({ payload: { ok: true, result: '{"ok":true,"aeVersion":"25.0","projectFile":"test.aep"}' } }));
    assert.deepEqual(good.result.structuredContent.ae, { responsive: true, aeVersion: '25.0', projectFile: 'test.aep' });
    assert.equal(good.result.structuredContent.ok, true);
    const failing = deps();
    failing.executeJsx = async function () { throw new Error('timeout'); };
    const bad = await status.call({ depth: 'diagnose' }, context, failing);
    assert.equal(bad.result.structuredContent.ok, true);
    assert.deepEqual(bad.result.structuredContent.ae, { responsive: false, error: 'timeout' });
});
