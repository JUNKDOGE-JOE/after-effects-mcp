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
                Connection: 'close', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text),
            }, headers || {}),
        }, function (res) {
            let data = '';
            res.on('data', function (chunk) { data += chunk; });
            res.on('end', function () { resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null }); });
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
    server.setPaused(false);
    server.setCSInterface({
        evalScript: function (_jsx, callback) {
            const result = {
                ok: true,
                compositionLocator: { locatorKind: 'jsx', itemId: '10' },
                compositionName: 'Integration',
                total: 1,
                offset: 0,
                limit: 50,
                returned: 1,
                hasMore: false,
                nextOffset: null,
                layers: [{
                    locatorKind: 'jsx', locator: { locatorKind: 'jsx', layerIndex: 1, layerId: '20' },
                    layerIndex: 1, layerId: '20', stackIndex: 1, name: 'Layer', type: 'av', videoEnabled: true,
                    isThreeD: false, locked: false, parentLocator: null, sourceItemLocator: null,
                }],
            };
            callback(JSON.stringify({
                ok: true,
                resultType: 'string',
                result: JSON.stringify(result),
            }));
        },
    });
    const app = server.buildApp();
    const listener = await new Promise(function (resolve) { resolve(app.listen(0, '127.0.0.1')); });
    await new Promise(function (resolve) { listener.once('listening', resolve); });
    return { server, listener, port: listener.address().port };
}

async function initialize(port) {
    const result = await request(port, {}, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'read-integration' } } });
    return result.headers['mcp-session-id'];
}

test('MCP exposes ae_read through the real /mcp tools/call route', async () => {
    const host = await fixture();
    try {
        const session = await initialize(host.port);
        const headers = { 'Mcp-Session-Id': session };
        const listed = await request(host.port, headers, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        assert.ok(listed.body.result.tools.some(function (tool) { return tool.name === 'ae_read'; }));
        const called = await request(host.port, headers, {
            jsonrpc: '2.0', id: 3, method: 'tools/call',
            params: { name: 'ae_read', arguments: { target: 'layers', comp: { id: '10' }, page: { limit: 1 } } },
        });
        assert.equal(called.status, 200);
        assert.equal(called.body.result.isError, undefined);
        assert.equal(called.body.result.structuredContent.layers[0].name, 'Layer');
    } finally {
        await new Promise(function (resolve) { host.listener.close(resolve); });
    }
});
