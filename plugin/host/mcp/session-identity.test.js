'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const { createClientBlocklist } = require('./client-blocklist');

function request(port, method, pathname, headers, body) {
    return new Promise(function (resolve, reject) {
        const text = body === undefined ? '' : JSON.stringify(body);
        const req = http.request({
            host: '127.0.0.1',
            port,
            path: pathname,
            method,
            agent: false,
            headers: Object.assign({
                Connection: 'close',
                ...(text ? {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(text),
                } : {}),
            }, headers || {}),
        }, function (res) {
            let data = '';
            res.on('data', function (chunk) { data += chunk; });
            res.on('end', function () {
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: data ? JSON.parse(data) : null,
                });
            });
        });
        req.on('error', reject);
        if (text) req.write(text);
        req.end();
    });
}

function initializeMessage(id, name, version) {
    return {
        jsonrpc: '2.0',
        id,
        method: 'initialize',
        params: { clientInfo: { name, version } },
    };
}

async function fixture() {
    delete require.cache[require.resolve('../server')];
    const server = require('../server');
    const blocked = new Set();
    server._setClientBlocklistForTest({
        list: function () { return Array.from(blocked); },
        has: function (name) { return blocked.has(name); },
        set: function (name, value) {
            if (value) blocked.add(name);
            else blocked.delete(name);
            return true;
        },
    });
    server.setRuntimeDependencies({ express });
    server.setPaused(false);
    server.setCSInterface({
        evalScript: function (_jsx, callback) { callback('{"ok":true,"resultType":"string","result":"identity-ok"}'); },
    });
    const app = server.buildApp();
    const listener = await new Promise(function (resolve) {
        resolve(app.listen(0, '127.0.0.1'));
    });
    await new Promise(function (resolve) { listener.once('listening', resolve); });
    return { server, listener, port: listener.address().port };
}

async function closeFixture(host) {
    await new Promise(function (resolve) { host.listener.close(resolve); });
    host.server.setPaused(false);
}

test('MCP identity blocks existing and new sessions, then restores after unblock', async () => {
    const host = await fixture();
    try {
        const initialized = await request(
            host.port,
            'POST',
            '/mcp',
            {},
            initializeMessage(1, 'cursor', '1.2.3'),
        );
        const sessionId = initialized.headers['mcp-session-id'];
        assert.equal(initialized.status, 200);
        assert.match(sessionId, /^[0-9a-f]{32}$/);
        assert.deepEqual(host.server.getMcpSessions()[0].clientInfo, { name: 'cursor', version: '1.2.3' });
        assert.equal(host.server.getMcpSessions()[0].sessionId, sessionId);
        assert.equal(host.server.getMcpSessions()[0].source, 'external');

        const headers = { 'Mcp-Session-Id': sessionId };
        host.server.setClientBlocked('cursor', true);
        assert.equal(host.server.getMcpSessions()[0].blocked, true);
        const blocked = await request(host.port, 'POST', '/mcp', headers, {
            jsonrpc: '2.0', id: 2, method: 'tools/call',
            params: { name: 'ae_exec', arguments: { code: '1 + 1' } },
        });
        assert.equal(blocked.body.error.code, -32003);
        assert.equal(blocked.body.error.data.code, 'CLIENT_BLOCKED');
        assert.equal(blocked.body.error.data.clientInfo.name, 'cursor');
        assert.equal(blocked.body.error.data.sessionId, sessionId);

        host.server.setClientBlocked('cursor', false);
        assert.equal(host.server.getMcpSessions()[0].blocked, false);
        const restored = await request(host.port, 'POST', '/mcp', headers, {
            jsonrpc: '2.0', id: 3, method: 'tools/call',
            params: { name: 'ae_exec', arguments: { code: '1 + 1' } },
        });
        assert.deepEqual(restored.body.result.structuredContent, {
            ok: true,
            content: 'identity-ok',
            contentType: 'text',
        });

        host.server.setClientBlocked('cursor', true);
        const rejected = await request(host.port, 'POST', '/mcp', {}, initializeMessage(4, 'cursor', '2.0'));
        assert.equal(rejected.body.error.code, -32003);
        assert.equal(rejected.headers['mcp-session-id'], undefined);

        const conversation = host.server.mcp.conversations.create({ label: 'chat-1' });
        const panel = await request(
            host.port,
            'POST',
            conversation.path,
            {},
            initializeMessage(7, 'panel-client', '9.0'),
        );
        const panelSession = host.server.getMcpSessions().find(function (item) {
            return item.sessionId === panel.headers['mcp-session-id'];
        });
        assert.equal(panelSession.source, 'panel');
        assert.equal(panelSession.conversationToken, conversation.token);
    } finally {
        await closeFixture(host);
    }
});

test('MCP kill switch returns a structured JSON-RPC error for an established session', async () => {
    const host = await fixture();
    try {
        const initialized = await request(
            host.port,
            'POST',
            '/mcp',
            {},
            initializeMessage(5, 'claude-code', '0.1'),
        );
        host.server.setPaused(true);
        const paused = await request(host.port, 'POST', '/mcp', {
            'Mcp-Session-Id': initialized.headers['mcp-session-id'],
        }, {
            jsonrpc: '2.0', id: 6, method: 'tools/call',
            params: { name: 'ae_status', arguments: {} },
        });
        assert.equal(paused.body.error.code, -32004);
        assert.equal(paused.body.error.data.code, 'ACTIONS_PAUSED');
    } finally {
        await closeFixture(host);
    }
});

test('blocked client names persist atomically and corrupt files fail open with a host log', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-blocklist-'));
    const filePath = path.join(root, '.ae-mcp', 'blocked-clients.json');
    const events = [];
    try {
        const first = createClientBlocklist({ filePath, logger: function (event) { events.push(event); } });
        assert.equal(first.set('claude-desktop', true), true);
        assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), ['claude-desktop']);
        const second = createClientBlocklist({ filePath, logger: function (event) { events.push(event); } });
        assert.equal(second.has('claude-desktop'), true);

        fs.writeFileSync(filePath, '{not-json', 'utf8');
        const corrupt = createClientBlocklist({ filePath, logger: function (event) { events.push(event); } });
        assert.deepEqual(corrupt.list(), []);
        assert.equal(events.some(function (event) { return event.source === 'mcp-client-blocklist'; }), true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('/exec continues to attribute the legacy x-ae-mcp-client header', async () => {
    const host = await fixture();
    try {
        const response = await request(host.port, 'POST', '/exec', {
            'X-AE-MCP-Token': 'not-used-by-this-test',
            'x-ae-mcp-client': 'legacy-header-client',
        }, { code: '1 + 1' });
        assert.equal(response.status, 401);
        host.server._setExecToken('test-token');
        const accepted = await request(host.port, 'POST', '/exec', {
            'X-AE-MCP-Token': 'test-token',
            'x-ae-mcp-client': 'legacy-header-client',
        }, { code: '1 + 1' });
        assert.equal(accepted.status, 200);
        assert.equal(host.server.activity.list().some(function (event) {
            return event.client === 'legacy-header-client';
        }), true);
    } finally {
        await closeFixture(host);
    }
});
