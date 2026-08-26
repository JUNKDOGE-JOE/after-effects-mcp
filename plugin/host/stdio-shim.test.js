'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

function collectLines(child) {
    return new Promise(function (resolve, reject) {
        let text = '';
        const lines = [];
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', function (chunk) {
            text += chunk;
            const parts = text.split(/\r?\n/);
            text = parts.pop();
            parts.forEach(function (line) {
                if (line.trim()) lines.push(JSON.parse(line));
            });
        });
        child.on('error', reject);
        child.on('close', function (code) {
            if (code !== 0) reject(new Error('stdio shim exited with ' + code));
            else resolve(lines);
        });
    });
}

function collectText(stream, child) {
    return new Promise(function (resolve, reject) {
        let text = '';
        stream.setEncoding('utf8');
        stream.on('data', function (chunk) { text += chunk; });
        child.on('error', reject);
        child.on('close', function () { resolve(text); });
    });
}

test('stdio shim bridges JSON lines to Streamable HTTP and forwards SSE', async () => {
    const requests = [];
    const server = http.createServer(function (req, res) {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', function (chunk) { body += chunk; });
        req.on('end', function () {
            const message = JSON.parse(body);
            requests.push({ message, headers: req.headers });
            res.setHeader('Mcp-Session-Id', 'session-from-host');
            if (message.method === 'initialize') {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({
                    jsonrpc: '2.0',
                    id: message.id,
                    result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: {} },
                }));
                return;
            }
            if (message.method === 'tools/list') {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [] } }));
                return;
            }
            res.setHeader('Content-Type', 'text/event-stream');
            res.write('event: message\ndata: ' + JSON.stringify({
                jsonrpc: '2.0', id: message.id, method: 'notifications/progress', params: { progress: 1 },
            }) + '\n\n');
            res.end('data: ' + JSON.stringify({
                jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok' }] },
            }) + '\n\n');
        });
    });
    await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    const child = spawn(process.execPath, [path.join(__dirname, 'stdio-shim.js')], {
        env: Object.assign({}, process.env, { AE_MCP_HTTP_URL: 'http://127.0.0.1:' + port + '/mcp' }),
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = collectLines(child);
    child.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'test', version: '1' } },
    }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
    child.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ae_status', arguments: {} },
    }) + '\n');
    child.stdin.end();
    try {
        const lines = await output;
        assert.equal(lines.length, 4);
        assert.equal(lines[0].result.protocolVersion, '2025-06-18');
        assert.deepEqual(lines[1].result.tools, []);
        assert.equal(lines[2].method, 'notifications/progress');
        assert.equal(lines[3].result.content[0].text, 'ok');
        assert.equal(requests.length, 3);
        assert.equal(requests[1].headers['mcp-session-id'], 'session-from-host');
        assert.equal(requests[1].headers['mcp-protocol-version'], '2025-06-18');
        assert.equal(requests[2].headers['mcp-session-id'], 'session-from-host');
    } finally {
        if (!child.killed) child.kill();
        await new Promise(function (resolve) { server.close(resolve); });
    }
});

test('stdio shim survives a failed request and keeps serving later lines', async () => {
    let calls = 0;
    const server = http.createServer(function (req, res) {
        calls += 1;
        if (calls === 1) {
            req.socket.destroy();
            return;
        }
        let body = '';
        req.setEncoding('utf8');
        req.on('data', function (chunk) { body += chunk; });
        req.on('end', function () {
            const message = JSON.parse(body);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [] } }));
        });
    });
    await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    const child = spawn(process.execPath, [path.join(__dirname, 'stdio-shim.js')], {
        env: Object.assign({}, process.env, { AE_MCP_HTTP_URL: 'http://127.0.0.1:' + port + '/mcp' }),
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = collectLines(child);
    const errors = collectText(child.stderr, child);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
    child.stdin.end();
    try {
        const [lines, stderr] = await Promise.all([output, errors]);
        assert.equal(lines.length, 2);
        assert.equal(lines[0].id, 1);
        assert.equal(typeof lines[0].error.message, 'string');
        assert.match(lines[0].error.message, /stdio-shim/);
        assert.match(lines[0].error.message, new RegExp(
            'After Effects panel is not reachable at http://127\\.0\\.0\\.1:' + port + '/mcp',
        ));
        assert.match(stderr, /install the ae-mcp extension from GitHub Releases/);
        assert.match(stderr, /Window > Extensions > ae-mcp open/);
        assert.equal(lines[1].id, 2);
        assert.deepEqual(lines[1].result.tools, []);
    } finally {
        if (!child.killed) child.kill();
        await new Promise(function (resolve) { server.close(resolve); });
    }
});
