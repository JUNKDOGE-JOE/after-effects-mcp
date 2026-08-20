'use strict';

// Deliberately avoids the Node test runner, built-in-module prefixes, fetch, and
// fake timers: this is the CEP 11 / Node 15 compatibility gate.
require('../cep-runtime-compat.js');
const assert = require('assert');
const http = require('http');
const express = require('express');
const server = require('../server.js');

function request(port, method, path, headers, body) {
    return new Promise(function (resolve, reject) {
        const text = body === undefined ? null : JSON.stringify(body);
        const req = http.request({
            host: '127.0.0.1',
            port,
            path,
            method,
            agent: false,
            headers: Object.assign({ Connection: 'close' }, text === null ? {} : {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(text),
            }, headers || {}),
        }, function (res) {
            let responseText = '';
            res.on('data', function (chunk) { responseText += chunk; });
            res.on('end', function () {
                resolve({ status: res.statusCode, headers: res.headers, text: responseText });
            });
        });
        req.on('error', reject);
        if (text !== null) req.write(text);
        req.end();
    });
}

function openSse(port, session) {
    return new Promise(function (resolve, reject) {
        const req = http.request({
            host: '127.0.0.1', port, path: '/mcp', method: 'GET', agent: false,
            headers: { Accept: 'text/event-stream', 'Mcp-Session-Id': session, Connection: 'close' },
        }, function (res) {
            let text = '';
            let opened = false;
            res.on('data', function (chunk) {
                text += chunk;
                if (opened) return;
                opened = true;
                resolve({
                    request: req,
                    response: res,
                    first: text,
                    text: function () { return text; },
                });
            });
        });
        req.on('error', reject);
        req.end();
    });
}

function close(listener) {
    return new Promise(function (resolve) { listener.close(resolve); });
}

async function main() {
    server.setRuntimeDependencies({ express });
    server.activity._reset();
    server.setPaused(false);
    server.setCSInterface({
        evalScript: function (jsx, callback) {
            if (jsx.indexOf('NODE15_LONG_CALL') !== -1) {
                setTimeout(function () {
                    callback('{"ok":true,"resultType":"string","result":"long-result"}');
                }, 31000);
                return;
            }
            callback('{"ok":true,"resultType":"string","result":"bridge-result"}');
        },
    });
    const app = server.buildApp();
    const listener = await new Promise(function (resolve) {
        const value = app.listen(0, '127.0.0.1', function () { resolve(value); });
    });
    const port = listener.address().port;
    try {
        const initialized = await request(port, 'POST', '/mcp', {}, {
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { clientInfo: { name: 'node15-spike' } },
        });
        assert.strictEqual(initialized.status, 200);
        const initBody = JSON.parse(initialized.text);
        assert.strictEqual(initBody.result.protocolVersion, '2025-03-26');
        const session = initialized.headers['mcp-session-id'];
        assert(/^[0-9a-f]{32}$/.test(session));
        const headers = { 'Mcp-Session-Id': session };

        const notify = await request(port, 'POST', '/mcp', headers, {
            jsonrpc: '2.0', method: 'notifications/initialized', params: {},
        });
        assert.strictEqual(notify.status, 202);
        const listed = await request(port, 'POST', '/mcp', headers, {
            jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
        });
        const tools = JSON.parse(listed.text).result.tools;
        assert.deepStrictEqual(tools.map(function (tool) { return tool.name; }), [
            'ae_status', 'ae_exec', 'ae_previewFrame', 'ae_read', 'ae_checkpoint',
            'ae_revert', 'ae_validateExpressions', 'ae_nativeExec', 'ae_toolSearch',
            'ae_toolUse', 'ae_skillUse',
        ]);
        tools.forEach(function (tool) {
            assert.strictEqual(Object.prototype.hasOwnProperty.call(tool.inputSchema, 'oneOf'), false);
            assert.strictEqual(Object.prototype.hasOwnProperty.call(tool.inputSchema, 'allOf'), false);
            assert.strictEqual(Object.prototype.hasOwnProperty.call(tool.inputSchema, 'anyOf'), false);
        });
        const status = await request(port, 'POST', '/mcp', headers, {
            jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ae_status', arguments: {} },
        });
        assert.strictEqual(JSON.parse(status.text).result.structuredContent.ok, true);

        const stream = await openSse(port, session);
        assert.strictEqual(stream.response.statusCode, 200);
        assert(/keepalive/.test(stream.first));

        const longCall = await request(port, 'POST', '/mcp', headers, {
            jsonrpc: '2.0', id: 4, method: 'tools/call',
            params: {
                name: 'ae_exec',
                arguments: { code: '/* NODE15_LONG_CALL */ 1 + 1', timeout_sec: 45 },
                _meta: { progressToken: 'node15-long-call' },
            },
        });
        assert.strictEqual(longCall.status, 200);
        assert(/^text\/event-stream/.test(longCall.headers['content-type']));
        assert((longCall.text.match(/notifications\/progress/g) || []).length >= 3);
        assert(/"id":4/.test(longCall.text));
        assert(/long-result/.test(longCall.text));
        // The standalone GET stream must stay alive (keepalives) but must not
        // echo another request's progress notifications.
        assert(/keepalive/.test(stream.text()));
        assert.strictEqual(/notifications\/progress/.test(stream.text()), false);

        const unknown = await request(port, 'POST', '/mcp', { 'Mcp-Session-Id': 'not-a-session' }, {
            jsonrpc: '2.0', id: 5, method: 'ping',
        });
        assert.strictEqual(unknown.status, 404);
        const badOrigin = await request(port, 'POST', '/mcp', { Origin: 'http://example.invalid:7777' }, {
            jsonrpc: '2.0', id: 6, method: 'initialize', params: {},
        });
        assert.strictEqual(badOrigin.status, 403);
        const deleted = await request(port, 'DELETE', '/mcp', headers);
        assert.strictEqual(deleted.status, 204);
        stream.response.destroy();
        process.stdout.write('Node 15 MCP spike passed on ' + process.version + '\n');
    } finally {
        server.setPaused(false);
        await close(listener);
    }
}

main().catch(function (error) {
    process.stderr.write((error && error.stack) || String(error));
    process.stderr.write('\n');
    process.exitCode = 1;
});
