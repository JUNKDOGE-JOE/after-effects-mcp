// Tests for auth-token helpers and that the server wires the token header into
// /exec (401 without, 200 with). Uses node --test plus Node's built-in http to
// drive the real Express app on an ephemeral loopback port — no supertest.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const authToken = require('./auth-token');

// ---- tokenMatches (pure helper) ----

test('tokenMatches: equal strings match', () => {
    assert.strictEqual(authToken.tokenMatches('abc123', 'abc123'), true);
});

test('tokenMatches: different same-length strings do not match', () => {
    assert.strictEqual(authToken.tokenMatches('abc123', 'abc124'), false);
});

test('tokenMatches: different-length strings do not match (no throw)', () => {
    assert.strictEqual(authToken.tokenMatches('short', 'longertoken'), false);
});

test('tokenMatches: non-string inputs do not match', () => {
    assert.strictEqual(authToken.tokenMatches(undefined, 'x'), false);
    assert.strictEqual(authToken.tokenMatches('x', undefined), false);
    assert.strictEqual(authToken.tokenMatches(null, null), false);
});

// ---- ensureToken (filesystem) ----

test('ensureToken generates a 64-char hex token and is idempotent', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-tok-'));
    t.mock.method(os, 'homedir', () => tmp);

    const tok1 = authToken.ensureToken();
    assert.match(tok1, /^[0-9a-f]{64}$/);
    assert.ok(fs.existsSync(path.join(tmp, '.ae-mcp', 'auth-token')));

    // Second call returns the same token (does not regenerate).
    const tok2 = authToken.ensureToken();
    assert.strictEqual(tok2, tok1);

    fs.rmSync(tmp, { recursive: true, force: true });
});

test('regenerate writes a fresh 64-char hex token', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-regen-'));
    t.mock.method(os, 'homedir', () => tmp);

    const tok1 = authToken.ensureToken();
    const tok2 = authToken.regenerate();

    assert.match(tok2, /^[0-9a-f]{64}$/);
    assert.notStrictEqual(tok2, tok1);
    assert.strictEqual(fs.readFileSync(path.join(tmp, '.ae-mcp', 'auth-token'), 'utf8'), tok2);

    fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- /exec auth wiring via the real Express app ----

function startApp() {
    delete require.cache[require.resolve('./server')];
    delete require.cache[require.resolve('./jsx-bridge')];
    const server = require('./server');
    server.activity._reset();
    server.setPaused(false);
    // Inject a known token and a stub CSInterface so /exec can "run".
    server._setExecToken('known-secret-token');
    server.setCSInterface({
        evalScript: function (jsx, cb) { cb('{"ok":true,"result":"stub-result"}'); },
    });
    const app = server.buildApp();
    return new Promise((resolve) => {
        const srv = app.listen(0, '127.0.0.1', () => {
            resolve({ srv: srv, port: srv.address().port });
        });
    });
}

function decodeTransportEnvelope(result) {
    return JSON.parse(result).result;
}

function get(port, pathname, headers) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port: port,
            path: pathname,
            method: 'GET',
            headers: headers || {},
        }, (res) => {
            let chunks = '';
            res.on('data', (c) => { chunks += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(chunks || '{}') }));
        });
        req.on('error', reject);
        req.end();
    });
}

function post(port, pathname, headers, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request({
            host: '127.0.0.1',
            port: port,
            path: pathname,
            method: 'POST',
            headers: Object.assign(
                { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
                headers || {}
            ),
        }, (res) => {
            let chunks = '';
            res.on('data', (c) => { chunks += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(chunks || '{}') }));
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

test('/exec returns 401 without a token', async () => {
    const { srv, port } = await startApp();
    try {
        const r = await post(port, '/exec', {}, { code: '1' });
        assert.strictEqual(r.status, 401);
        assert.strictEqual(r.body.ok, false);
        assert.strictEqual(r.body.error, 'unauthorized');
    } finally {
        srv.close();
    }
});

test('/exec returns 401 with a wrong token', async () => {
    const { srv, port } = await startApp();
    try {
        const r = await post(port, '/exec', { 'X-AE-MCP-Token': 'wrong' }, { code: '1' });
        assert.strictEqual(r.status, 401);
        assert.strictEqual(r.body.error, 'unauthorized');
    } finally {
        srv.close();
    }
});

test('/exec returns 200 with the correct token', async () => {
    const { srv, port } = await startApp();
    try {
        const r = await post(port, '/exec', { 'X-AE-MCP-Token': 'known-secret-token' }, { code: '1' });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.ok, true);
        assert.strictEqual(r.body.result, 'stub-result');
    } finally {
        srv.close();
    }
});

test('/exec decodes the evalScript transport envelope before responding', async () => {
    delete require.cache[require.resolve('./server')];
    delete require.cache[require.resolve('./jsx-bridge')];
    const server = require('./server');
    server.activity._reset();
    server.setPaused(false);
    server._setExecToken('known-secret-token');
    server.setCSInterface({
        evalScript: function (jsx, cb) {
            assert.ok(/^[\x00-\x7f]*$/.test(jsx), 'transport wrapper must be ASCII-only');
            cb('{"ok":true,"result":"\\u6e90\\u6587\\u672c"}');
        },
    });
    const app = server.buildApp();
    const srv = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
        const r = await post(
            srv.address().port,
            '/exec',
            { 'X-AE-MCP-Token': 'known-secret-token' },
            { code: '"源文本"' }
        );
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.ok, true);
        assert.strictEqual(r.body.result, '源文本');
    } finally {
        srv.close();
    }
});

test('wrapForEvalScriptTransport returns an ASCII-only envelope for localized results', () => {
    delete require.cache[require.resolve('./server')];
    const server = require('./server');
    const wrapped = server.wrapForEvalScriptTransport('"源文本"');

    assert.ok(/^[\x00-\x7f]*$/.test(wrapped), 'wrapper source must be ASCII-only');
    assert.match(wrapped, /\\u6e90\\u6587\\u672c/);

    const payload = eval(wrapped); // eslint-disable-line no-eval
    assert.ok(/^[\x00-\x7f]*$/.test(payload), 'evalScript payload must be ASCII-only');
    assert.strictEqual(decodeTransportEnvelope(payload), '源文本');
});

test('wrapForEvalScriptTransport returns an error envelope for thrown ExtendScript errors', () => {
    delete require.cache[require.resolve('./server')];
    const server = require('./server');
    const wrapped = server.wrapForEvalScriptTransport('throw new Error("boom")');

    assert.ok(/^[\x00-\x7f]*$/.test(wrapped), 'wrapper source must be ASCII-only');
    const payload = eval(wrapped); // eslint-disable-line no-eval
    assert.ok(/^[\x00-\x7f]*$/.test(payload), 'evalScript payload must be ASCII-only');
    assert.throws(
        () => server.decodeEvalScriptTransportResult(payload),
        /ExtendScript error: Error: boom/
    );
});

test('/exec reports empty evalScript output as no output', async () => {
    delete require.cache[require.resolve('./server')];
    delete require.cache[require.resolve('./jsx-bridge')];
    const server = require('./server');
    server.activity._reset();
    server.setPaused(false);
    server._setExecToken('known-secret-token');
    server.setCSInterface({
        evalScript: function (jsx, cb) { cb(''); },
    });
    const app = server.buildApp();
    const srv = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
        const r = await post(
            srv.address().port,
            '/exec',
            { 'X-AE-MCP-Token': 'known-secret-token' },
            { code: 'throw new Error("boom")' }
        );
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.ok, false);
        assert.match(r.body.error, /no output/);
    } finally {
        srv.close();
    }
});

test('/exec reports decoded ExtendScript transport errors', async () => {
    delete require.cache[require.resolve('./server')];
    delete require.cache[require.resolve('./jsx-bridge')];
    const server = require('./server');
    server.activity._reset();
    server.setPaused(false);
    server._setExecToken('known-secret-token');
    server.setCSInterface({
        evalScript: function (jsx, cb) { cb('{"ok":false,"error":"\\u7206\\u70b8"}'); },
    });
    const app = server.buildApp();
    const srv = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
        const r = await post(
            srv.address().port,
            '/exec',
            { 'X-AE-MCP-Token': 'known-secret-token' },
            { code: 'throw new Error("boom")' }
        );
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.ok, false);
        assert.match(r.body.error, /爆炸/);
    } finally {
        srv.close();
    }
});

test('/exec returns 503 while paused and resumes after unpause', async () => {
    const { srv, port } = await startApp();
    const server = require('./server');
    try {
        server.setPaused(true);
        const paused = await post(port, '/exec', { 'X-AE-MCP-Token': 'known-secret-token' }, { code: '1' });
        assert.strictEqual(paused.status, 503);
        assert.strictEqual(paused.body.ok, false);
        assert.match(paused.body.error, /paused/);

        server.setPaused(false);
        const resumed = await post(port, '/exec', { 'X-AE-MCP-Token': 'known-secret-token' }, { code: '1' });
        assert.strictEqual(resumed.status, 200);
        assert.strictEqual(resumed.body.ok, true);
    } finally {
        server.setPaused(false);
        srv.close();
    }
});

test('/health is not affected by pause', async () => {
    const { srv, port } = await startApp();
    const server = require('./server');
    try {
        server.setPaused(true);
        const r = await get(port, '/health', {});
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.ok, true);
    } finally {
        server.setPaused(false);
        srv.close();
    }
});

test('/health without python identity does not record a health probe time', async () => {
    const { srv, port } = await startApp();
    const server = require('./server');
    try {
        const r = await get(port, '/health', {});
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.ok, true);
        assert.strictEqual(server.getConnectionInfo().lastHealthAt, null);
        // /health echoes the (absent) python handshake state as null.
        assert.strictEqual(r.body.pythonVersion, null);
        assert.strictEqual(r.body.pythonLastSeenAt, null);
    } finally {
        srv.close();
    }
});

test('/health with python identity records the last health probe time and version', async () => {
    const { srv, port } = await startApp();
    const server = require('./server');
    try {
        const before = Date.now();
        const r = await get(port, '/health', { 'x-ae-mcp-python': '0.3.2-test' });
        const after = Date.now();
        assert.strictEqual(r.status, 200);
        const info = server.getConnectionInfo();
        assert.ok(info.lastHealthAt >= before);
        assert.ok(info.lastHealthAt <= after);
        assert.strictEqual(info.pythonVersion, '0.3.2-test');
        // /health echoes the recorded python handshake state back to the caller.
        assert.strictEqual(r.body.pythonVersion, '0.3.2-test');
        assert.ok(r.body.pythonLastSeenAt >= before);
        assert.ok(r.body.pythonLastSeenAt <= after);
    } finally {
        srv.close();
    }
});

test('/activity requires token', async () => {
    const { srv, port } = await startApp();
    try {
        const r = await get(port, '/activity', {});
        assert.strictEqual(r.status, 401);
        assert.strictEqual(r.body.ok, false);
    } finally {
        srv.close();
    }
});

test('/exec success is recorded in /activity with client label', async () => {
    const { srv, port } = await startApp();
    try {
        await post(
            port,
            '/exec',
            { 'X-AE-MCP-Token': 'known-secret-token', 'x-ae-mcp-client': 'Claude Desktop/1.2' },
            { code: '1', undoGroup: 'unit' }
        );
        const r = await get(port, '/activity', { 'X-AE-MCP-Token': 'known-secret-token' });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.ok, true);
        assert.strictEqual(r.body.events.length, 1);
        assert.strictEqual(r.body.events[0].ok, true);
        assert.strictEqual(r.body.events[0].client, 'Claude Desktop/1.2');
        assert.strictEqual(r.body.events[0].undoGroup, 'unit');
    } finally {
        srv.close();
    }
});

test('/exec records emptyResult when the decoded result is empty', async () => {
    delete require.cache[require.resolve('./server')];
    delete require.cache[require.resolve('./jsx-bridge')];
    const server = require('./server');
    server.activity._reset();
    server.setPaused(false);
    server._setExecToken('known-secret-token');
    server.setCSInterface({
        evalScript: function (jsx, cb) { cb('{"ok":true,"result":""}'); },
    });
    const app = server.buildApp();
    const srv = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
        const r = await post(
            srv.address().port,
            '/exec',
            { 'X-AE-MCP-Token': 'known-secret-token', 'x-ae-mcp-client': 'Claude Desktop/1.2' },
            { code: 'undefined', undoGroup: 'unit' }
        );
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.ok, true);
        assert.strictEqual(r.body.result, '');

        const events = server.activity.list();
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].ok, true);
        assert.strictEqual(events[0].emptyResult, true);
    } finally {
        srv.close();
    }
});

test('/exec feeds client registry and python version into connection info', async () => {
    const { srv, port } = await startApp();
    const server = require('./server');
    try {
        const before = Date.now();
        await post(
            port,
            '/exec',
            {
                'X-AE-MCP-Token': 'known-secret-token',
                'x-ae-mcp-client': 'Cursor/0.45',
                'x-ae-mcp-python': '0.3.2',
            },
            { code: '1' }
        );
        const clients = server.getClients();
        assert.deepStrictEqual(clients.map((c) => c.label), ['Cursor/0.45']);
        assert.strictEqual(clients[0].blocked, false);
        assert.ok(clients[0].lastSeen >= before);

        const info = server.getConnectionInfo();
        assert.strictEqual(info.hostVersion, require('./package.json').version);
        assert.strictEqual(info.pythonVersion, '0.3.2');
        assert.ok(info.lastClientSeenAt >= before);
        assert.ok(Object.prototype.hasOwnProperty.call(info, 'port'));
    } finally {
        srv.close();
    }
});

test('/exec blocks a client, records denied activity, then resumes after unblock', async () => {
    const { srv, port } = await startApp();
    const server = require('./server');
    try {
        server.setClientBlocked('Claude Desktop/1.2', true);
        const blocked = await post(
            port,
            '/exec',
            { 'X-AE-MCP-Token': 'known-secret-token', 'x-ae-mcp-client': 'Claude Desktop/1.2' },
            { code: '1' }
        );
        assert.strictEqual(blocked.status, 403);
        assert.strictEqual(blocked.body.ok, false);
        assert.match(blocked.body.error, /blocked/);

        const activity = await get(port, '/activity', { 'X-AE-MCP-Token': 'known-secret-token' });
        assert.strictEqual(activity.body.events.length, 1);
        assert.strictEqual(activity.body.events[0].client, 'Claude Desktop/1.2');
        assert.strictEqual(activity.body.events[0].denied, 'blocked');

        assert.strictEqual(server.getClients()[0].blocked, true);
        server.setClientBlocked('Claude Desktop/1.2', false);
        const resumed = await post(
            port,
            '/exec',
            { 'X-AE-MCP-Token': 'known-secret-token', 'x-ae-mcp-client': 'Claude Desktop/1.2' },
            { code: '1' }
        );
        assert.strictEqual(resumed.status, 200);
        assert.strictEqual(resumed.body.ok, true);
        assert.strictEqual(server.getClients()[0].blocked, false);
    } finally {
        srv.close();
    }
});

test('regenerateToken swaps the live /exec token', async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-live-regen-'));
    t.mock.method(os, 'homedir', () => tmp);
    const { srv, port } = await startApp();
    const server = require('./server');
    try {
        let newToken = null;
        server.regenerateToken((err, token) => {
            assert.ifError(err);
            newToken = token;
        });
        assert.match(newToken, /^[0-9a-f]{64}$/);
        assert.notStrictEqual(newToken, 'known-secret-token');

        const oldDenied = await post(port, '/exec', { 'X-AE-MCP-Token': 'known-secret-token' }, { code: '1' });
        assert.strictEqual(oldDenied.status, 401);

        const newAllowed = await post(port, '/exec', { 'X-AE-MCP-Token': newToken }, { code: '1' });
        assert.strictEqual(newAllowed.status, 200);
        assert.strictEqual(newAllowed.body.ok, true);
    } finally {
        srv.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('/exec paused denial is recorded in /activity', async () => {
    const { srv, port } = await startApp();
    const server = require('./server');
    try {
        server.setPaused(true);
        await post(port, '/exec', { 'X-AE-MCP-Token': 'known-secret-token' }, { code: '1' });
        const r = await get(port, '/activity', { 'X-AE-MCP-Token': 'known-secret-token' });
        assert.strictEqual(r.body.events.length, 1);
        assert.strictEqual(r.body.events[0].ok, false);
        assert.strictEqual(r.body.events[0].denied, 'paused');
        assert.strictEqual(r.body.events[0].client, 'unknown');
    } finally {
        server.setPaused(false);
        srv.close();
    }
});

test('/exec invalid request is recorded in /activity after auth', async () => {
    const { srv, port } = await startApp();
    try {
        const denied = await post(port, '/exec', { 'X-AE-MCP-Token': 'known-secret-token' }, { code: '' });
        assert.strictEqual(denied.status, 400);
        const r = await get(port, '/activity', { 'X-AE-MCP-Token': 'known-secret-token' });
        assert.strictEqual(r.body.events.length, 1);
        assert.strictEqual(r.body.events[0].ok, false);
        assert.strictEqual(r.body.events[0].denied, 'invalid_request');
    } finally {
        srv.close();
    }
});

test('panel-internal diagnostic probes stay out of the client registry', async () => {
    const { srv, port } = await startApp();
    const server = require('./server');
    try {
        const r = await post(port, '/exec', { 'X-AE-MCP-Token': 'known-secret-token', 'x-ae-mcp-client': 'panel-diagnostics/internal' }, { code: '1' });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(server.getConnectionInfo().lastClientSeenAt, null);
        assert.deepStrictEqual(server.getClients(), []);
        const events = server.activity.list();
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].client, 'panel-diagnostics/internal');
    } finally {
        srv.close();
    }
});
