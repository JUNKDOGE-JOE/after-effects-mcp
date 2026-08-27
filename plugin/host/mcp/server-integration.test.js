'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const { createStatePaths } = require('../state-paths');

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

async function fixture(options) {
    const input = options || {};
    const stateRoot = input.stateRoot
        || fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-server-integration-'));
    delete require.cache[require.resolve('../server')];
    const server = require('../server');
    server.setRuntimeDependencies({
        express,
        statePaths: createStatePaths({
            stateDir: stateRoot,
            home: input.home,
            homedir: function () { throw new Error('integration tests must not resolve the real home'); },
        }),
    });
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
    return { server, listener, port: listener.address().port, stateRoot };
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
        const successfulExec = success.body.result.structuredContent;
        assert.match(successfulExec.artifactId, /^user:/);
        assert.deepEqual(Object.assign({}, successfulExec, { artifactId: undefined }), {
            ok: true,
            content: 'bridge-ok',
            contentType: 'text',
            artifactId: undefined,
        });
        const artifactId = successfulExec.artifactId;
        const listed = await request(host.port, headers, {
            jsonrpc: '2.0', id: 22, method: 'tools/call',
            params: { name: 'ae_toolSearch', arguments: {} },
        });
        assert.equal(listed.body.result.structuredContent.artifacts.some(function (item) {
            return item.id === artifactId;
        }), false);
        const inspected = await request(host.port, headers, {
            jsonrpc: '2.0', id: 23, method: 'tools/call',
            params: { name: 'ae_toolSearch', arguments: { name: artifactId } },
        });
        assert.equal(inspected.body.result.structuredContent.artifact.id, artifactId);
        const used = await request(host.port, headers, {
            jsonrpc: '2.0', id: 24, method: 'tools/call',
            params: { name: 'ae_toolUse', arguments: { name: artifactId } },
        });
        assert.equal(used.body.result.structuredContent.ok, true);
        assert.equal(used.body.result.structuredContent.content, 'bridge-ok');
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
        }).length, 6);
    } finally {
        host.server.setPaused(false);
        await new Promise(function (resolve) { host.listener.close(resolve); });
        fs.rmSync(host.stateRoot, { recursive: true, force: true });
    }
});

test('initialize rejects a client listed in the injected blocked-clients file', async () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-blocked-state-'));
    fs.writeFileSync(
        path.join(stateRoot, 'blocked-clients.json'),
        JSON.stringify(['mcp-exec-integration']),
        'utf8',
    );
    const host = await fixture({ stateRoot });
    try {
        const rejected = await request(host.port, {}, {
            jsonrpc: '2.0', id: 10, method: 'initialize',
            params: { clientInfo: { name: 'mcp-exec-integration' } },
        });
        assert.equal(rejected.status, 200);
        assert.equal(rejected.headers['mcp-session-id'], undefined);
        assert.equal(rejected.body.error.data.code, 'CLIENT_BLOCKED');
    } finally {
        await new Promise(function (resolve) { host.listener.close(resolve); });
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
});

test('a polluted fake user home cannot affect an injected clean state root', async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-polluted-home-'));
    const pollutedState = path.join(fakeHome, '.ae-mcp');
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-clean-state-'));
    fs.mkdirSync(pollutedState, { recursive: true });
    fs.writeFileSync(
        path.join(pollutedState, 'blocked-clients.json'),
        JSON.stringify(['mcp-exec-integration']),
        'utf8',
    );
    const host = await fixture({ stateRoot, home: fakeHome });
    try {
        const initialized = await request(host.port, {}, {
            jsonrpc: '2.0', id: 11, method: 'initialize',
            params: { clientInfo: { name: 'mcp-exec-integration' } },
        });
        assert.equal(initialized.status, 200);
        assert.match(initialized.headers['mcp-session-id'], /^[0-9a-f]{32}$/);
        assert.deepEqual(JSON.parse(fs.readFileSync(
            path.join(pollutedState, 'blocked-clients.json'),
            'utf8',
        )), ['mcp-exec-integration']);
    } finally {
        await new Promise(function (resolve) { host.listener.close(resolve); });
        fs.rmSync(stateRoot, { recursive: true, force: true });
        fs.rmSync(fakeHome, { recursive: true, force: true });
    }
});
