'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createStatePaths } = require('../state-paths');
const mountMcp = require('./index');

function request(port, route) {
    return new Promise(function (resolve, reject) {
        const body = JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { clientInfo: { name: 'test', version: '1' } },
        });
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                path: route,
                method: 'POST',
                headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
            },
            function (res) {
                let text = '';
                res.on('data', function (part) {
                    text += part;
                });
                res.on('end', function () {
                    resolve(JSON.parse(text));
                });
            },
        );
        req.on('error', reject);
        req.end(body);
    });
}
test('initialize uses conversation expertGuidance while external sessions retain the expert addendum', async function () {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-instructions-state-'));
    const app = express();
    app.use(express.json());
    const mounted = mountMcp(app, {
        version: 'test',
        getStatus: function () {
            return {};
        },
        executeJsx: async function () {
            return { payload: { ok: true, result: '{}' } };
        },
        statePaths: createStatePaths({
            stateDir: stateRoot,
            homedir: function () { throw new Error('MCP instructions tests must not resolve the real home'); },
        }),
    });
    const server = await new Promise(function (resolve) {
        const next = app.listen(0, '127.0.0.1', function () {
            resolve(next);
        });
    });
    try {
        const port = server.address().port;
        const external = await request(port, '/mcp');
        assert.match(external.result.instructions, /EXTENDSCRIPT EXPERT GUARDRAILS/);
        const conversation = mounted.conversations.create({
            label: 'lean',
            policy: { expertGuidance: false },
        });
        const lean = await request(port, conversation.path);
        assert.doesNotMatch(lean.result.instructions, /EXTENDSCRIPT EXPERT GUARDRAILS/);
        assert.match(
            lean.result.instructions,
            /This CEP-hosted server currently exposes: ae_status, ae_exec, ae_execRecover/,
        );
    } finally {
        await new Promise(function (resolve) {
            server.close(resolve);
        });
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
});
