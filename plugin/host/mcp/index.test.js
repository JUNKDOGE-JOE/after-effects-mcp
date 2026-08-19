'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');
const mountMcp = require('./index');

function start(options) {
    const app = express();
    app.use(express.json());
    const mounted = mountMcp(app, {
        version: '0.9.6-test',
        getStatus: function (port) { return { ok: true, pluginVersion: '0.9.6-test', port }; },
        executeJsx: options && options.executeJsx || async function () {
            return { status: 200, payload: { ok: true, result: 'ok' } };
        },
        progressIntervalMs: options && options.progressIntervalMs,
        sseOptions: options && options.sseOptions,
    });
    return new Promise(function (resolve) {
        const listener = app.listen(0, '127.0.0.1', function () {
            resolve({ listener, port: listener.address().port, mounted });
        });
    });
}

function request(port, method, path, headers, body) {
    return new Promise(function (resolve, reject) {
        const text = body === undefined ? null : JSON.stringify(body);
        const req = http.request({
            host: '127.0.0.1', port, path, method, agent: false,
            headers: Object.assign({ Connection: 'close' }, text === null ? {} : {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(text),
            }, headers || {}),
        }, function (res) {
            let data = '';
            res.on('data', function (chunk) { data += chunk; });
            res.on('end', function () {
                resolve({ status: res.statusCode, headers: res.headers, text: data, body: data ? JSON.parse(data) : null });
            });
        });
        req.on('error', reject);
        if (text !== null) req.write(text);
        req.end();
    });
}

async function initialize(port, name) {
    const response = await request(port, 'POST', '/mcp', {}, {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { clientInfo: { name: name || 'mcp-unit' } },
    });
    return { response, session: response.headers['mcp-session-id'] };
}

test('MCP initializes, enforces loopback Origin/Host, and supports session lifecycle', async () => {
    const fixture = await start();
    try {
        const initial = await initialize(fixture.port);
        assert.equal(initial.response.status, 200);
        assert.match(initial.session, /^[0-9a-f]{32}$/);
        assert.equal(initial.response.headers['cache-control'], 'no-store');
        const headers = { 'Mcp-Session-Id': initial.session };
        const initialized = await request(fixture.port, 'POST', '/mcp', headers, {
            jsonrpc: '2.0', method: 'notifications/initialized', params: {},
        });
        assert.equal(initialized.status, 202);
        const malformed = await request(fixture.port, 'POST', '/mcp', headers, {
            jsonrpc: '2.0', id: 91,
        });
        assert.equal(malformed.status, 200);
        assert.equal(malformed.body.error.code, -32600);
        const invalidParams = await request(fixture.port, 'POST', '/mcp', headers, {
            jsonrpc: '2.0', id: 92, method: 'tools/call', params: {},
        });
        assert.equal(invalidParams.status, 200);
        assert.equal(invalidParams.body.error.code, -32602);
        const responseOnly = await request(fixture.port, 'POST', '/mcp', headers, {
            jsonrpc: '2.0', id: 99, result: {},
        });
        assert.equal(responseOnly.status, 202);
        const listed = await request(fixture.port, 'POST', '/mcp', headers, {
            jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
        });
        assert.deepEqual(listed.body.result.tools.map(function (tool) { return tool.name; }), ['ae_status', 'ae_exec', 'ae_previewFrame']);
        const status = await request(fixture.port, 'POST', '/mcp', headers, {
            jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ae_status', arguments: {} },
        });
        assert.equal(status.body.result.structuredContent.mcp.sessions, 1);
        const unknown = await request(fixture.port, 'POST', '/mcp', { 'Mcp-Session-Id': 'missing' }, {
            jsonrpc: '2.0', id: 4, method: 'ping',
        });
        assert.equal(unknown.status, 404);
        const badOrigin = await request(fixture.port, 'POST', '/mcp', { Origin: 'http://example.test:99' }, {
            jsonrpc: '2.0', id: 5, method: 'initialize', params: {},
        });
        assert.equal(badOrigin.status, 403);
        const deleted = await request(fixture.port, 'DELETE', '/mcp', headers);
        assert.equal(deleted.status, 204);
    } finally {
        await new Promise(function (resolve) { fixture.listener.close(resolve); });
    }
});

test('progress notifications retain their token and report elapsed seconds', () => {
    assert.deepEqual(mountMcp.progressMessage('progress-1', 1000, 6200), {
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken: 'progress-1', progress: 5, message: 'ae_exec is still running' },
    });
});
