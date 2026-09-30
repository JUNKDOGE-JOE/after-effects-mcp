'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { PassThrough } = require('node:stream');

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

test('generic stdio entry initializes without AE and keeps same-connection project calls independent', async () => {
    const { run } = require('./multi-instance-stdio');
    const source = new PassThrough();
    const replies = [];
    let releaseA;
    const waitingA = new Promise(resolve => { releaseA = resolve; });
    const calls = [];
    const service = {
        instances: async () => ({ ok: true, instances: [] }),
        target: async args => args.instance_id,
        router: { async call(instance, params) {
            calls.push({ instance, context: params.arguments.context_id });
            if (instance === 'A') await waitingA;
            if (instance === 'B') releaseA();
            return { content: [{ type: 'text', text: instance }], structuredContent: { ok: true, instance } };
        } },
    };
    const completed = run(source, { write: line => replies.push(JSON.parse(line)) }, { write() {} }, { service });
    [
        { id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
        { id: 2, method: 'tools/list' },
        { id: 3, method: 'tools/call', params: { name: 'ae_read', arguments: { context_id: 'A:context' } } },
        { id: 4, method: 'tools/call', params: { name: 'ae_read', arguments: { context_id: 'B:context' } } },
        { id: 5, method: 'tools/call', params: { name: 'ae_read', arguments: {} } },
    ].forEach(message => source.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'));
    source.end();
    await completed;
    assert.equal(replies.find(reply => reply.id === 1).result.protocolVersion, '2025-03-26');
    assert.ok(replies.find(reply => reply.id === 2).result.tools.some(tool => tool.name === 'ae_workspace'));
    assert.equal(replies.find(reply => reply.id === 5).result.structuredContent.code, 'WORKSPACE_REQUIRED');
    assert.deepEqual(calls, [{ instance: 'A', context: 'A:context' }, { instance: 'B', context: 'B:context' }]);
    assert.equal(replies.filter(reply => [3, 4].includes(reply.id)).length, 2);
});

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

(() => {
'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { WorkspaceRouter } = require('./mcp/workspace-router');

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

async function host(t, name, onCall) {
    const requests = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
            const message = JSON.parse(body);
            requests.push({ message, headers: req.headers });
            function reply(result) {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
            }
            if (message.method === 'initialize') {
                res.setHeader('Mcp-Session-Id', 'session-' + name);
                reply({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name } });
            } else if (message.method === 'notifications/initialized') {
                res.writeHead(202); res.end();
            } else {
                try {
                    if (onCall) await onCall(req, res, message);
                    if (!res.destroyed && !res.writableEnded) reply({ host: name, args: message.params.arguments });
                } catch (error) {
                    res.destroy(error);
                }
            }
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
    return { requests, record: { instanceId: name, state: 'running', endpoint: 'http://127.0.0.1:' + server.address().port + '/mcp' } };
}

function routerFor(...hosts) {
    return new WorkspaceRouter({ get: async (id) => {
        const target = hosts.find((value) => value.record.instanceId === id);
        return target ? target.record : null;
    } });
}
function call(router, name, value) {
    return router.call(name, { name: 'ae_read', arguments: { context_id: name + ':context', value } });
}

test('loopback routing overlaps hosts and initializes exactly one independent MCP session per host', { timeout: 5000 }, async (t) => {
    const entered = deferred();
    const finish = deferred();
    const first = await host(t, 'first', async (_req, _res, message) => {
        if (message.params.arguments.value === 'hold') { entered.resolve(); await finish.promise; }
    });
    const second = await host(t, 'second');
    const router = routerFor(first, second);
    let firstFinished = false;
    const held = call(router, 'first', 'hold').then((value) => { firstFinished = true; return value; });
    let timer;
    try {
        await entered.promise;
        const result = await Promise.race([
            call(router, 'second', 'parallel'),
            new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('second host was blocked')), 1500); }),
        ]);
        assert.equal(result.host, 'second');
        assert.equal(firstFinished, false);
    } finally { clearTimeout(timer); finish.resolve(); await held; }
    await Promise.all([call(router, 'first', 'again'), call(router, 'first', 'concurrent'), call(router, 'second', 'again')]);
    for (const entry of [first, second]) {
        const initializes = entry.requests.filter((item) => item.message.method === 'initialize');
        assert.equal(initializes.length, 1);
        assert.equal(initializes[0].headers['mcp-session-id'], undefined);
        const followups = entry.requests.filter((item) => item.message.method !== 'initialize');
        assert.ok(followups.length >= 3);
        followups.forEach((item) => {
            assert.equal(item.headers['mcp-session-id'], 'session-' + entry.record.instanceId);
            assert.equal(item.headers['mcp-protocol-version'], '2025-06-18');
        });
    }
});

test('simultaneous first calls share one initialization handshake', async (t) => {
    const peer = await host(t, 'shared');
    const router = routerFor(peer);
    const results = await Promise.all([call(router, 'shared', 1), call(router, 'shared', 2)]);
    assert.deepEqual(results.map((result) => result.args.value), [1, 2]);
    assert.equal(peer.requests.filter((item) => item.message.method === 'initialize').length, 1);
    assert.equal(peer.requests.filter((item) => item.message.method === 'notifications/initialized').length, 1);
});

test('a connection loss after dispatch is returned once without reconnect or replay', async (t) => {
    const peer = await host(t, 'failed', (req) => { req.socket.destroy(); });
    const router = routerFor(peer);
    await assert.rejects(call(router, 'failed', 'write-like-dispatch'), { code: 'ECONNRESET' });
    assert.deepEqual(peer.requests.map((item) => item.message.method), [
        'initialize', 'notifications/initialized', 'tools/call',
    ]);
});

test('closed registry records block dispatch even when a cached MCP peer is ready', async (t) => {
    const peer = await host(t, 'closed');
    const router = routerFor(peer);
    peer.record.state = 'closed';
    await assert.rejects(call(router, 'closed', 1), { code: 'INSTANCE_NOT_READY' });
    assert.equal(peer.requests.length, 0);
    peer.record.state = 'running';
    await call(router, 'closed', 2);
    const count = peer.requests.length;
    peer.record.state = 'closed';
    await assert.rejects(call(router, 'closed', 3), { code: 'INSTANCE_NOT_READY' });
    assert.equal(peer.requests.length, count);
});

})();
