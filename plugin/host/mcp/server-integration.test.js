'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');

function request(port, headers, body) {
    return new Promise(function (resolve, reject) {
        const text = JSON.stringify(body);
        const req = http.request({
            host: '127.0.0.1', port, path: '/mcp', method: 'POST', agent: false,
            headers: Object.assign({
                Connection: 'close',
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(text),
            }, headers || {}),
        }, function (res) {
            let data = '';
            res.on('data', function (chunk) { data += chunk; });
            res.on('end', function () {
                resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null });
            });
        });
        req.on('error', reject);
        req.write(text);
        req.end();
    });
}

async function fixture() {
    delete require.cache[require.resolve('../server')];
    const server = require('../server');
    server.setRuntimeDependencies({ express });
    server.activity._reset();
    server.setPaused(false);
    server.setCSInterface({
        evalScript: function (_jsx, callback) { callback('{"ok":true,"resultType":"string","result":"bridge-ok"}'); },
    });
    const app = server.buildApp();
    assert.equal(typeof server.mcp.conversations.create, 'function');
    assert.equal(typeof server.mcp.approvals.resolve, 'function');
    const listener = await new Promise(function (resolve) {
        const value = app.listen(0, '127.0.0.1', function () { resolve(value); });
    });
    return { server, listener, port: listener.address().port };
}

async function initialize(port, name) {
    const result = await request(port, {}, {
        jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name } },
    });
    return result.headers['mcp-session-id'];
}

test('MCP ae_exec shares paused/blocked gates and activity records with /exec', async () => {
    const host = await fixture();
    try {
        const client = 'mcp-exec-integration';
        const session = await initialize(host.port, client);
        const headers = { 'Mcp-Session-Id': session };
        const success = await request(host.port, headers, {
            jsonrpc: '2.0', id: 2, method: 'tools/call',
            params: { name: 'ae_exec', arguments: { code: '1 + 1', undo_group_name: 'MCP test' } },
        });
        assert.deepEqual(success.body.result.structuredContent, {
            ok: true,
            content: 'bridge-ok',
            contentType: 'text',
        });
        const invalidParams = await request(host.port, headers, {
            jsonrpc: '2.0', id: 21, method: 'tools/call', params: {},
        });
        assert.equal(invalidParams.status, 200);
        assert.equal(invalidParams.body.error.code, -32602);
        host.server.setClientBlocked(client, true);
        const blocked = await request(host.port, headers, {
            jsonrpc: '2.0', id: 3, method: 'tools/call',
            params: { name: 'ae_exec', arguments: { code: '1 + 1' } },
        });
        assert.equal(blocked.body.error.code, -32003);
        assert.equal(blocked.body.error.data.code, 'CLIENT_BLOCKED');
        assert.match(blocked.body.error.message, /blocked/);
        host.server.setClientBlocked(client, false);
        host.server.setPaused(true);
        const paused = await request(host.port, headers, {
            jsonrpc: '2.0', id: 4, method: 'tools/call',
            params: { name: 'ae_exec', arguments: { code: '1 + 1' } },
        });
        assert.equal(paused.body.error.code, -32004);
        assert.equal(paused.body.error.data.code, 'ACTIONS_PAUSED');
        assert.match(paused.body.error.message, /paused/);
        assert.equal(host.server.activity.list().filter(function (event) {
            return event.client === client;
        }).length, 3);
    } finally {
        host.server.setPaused(false);
        await new Promise(function (resolve) { host.listener.close(resolve); });
    }
});
