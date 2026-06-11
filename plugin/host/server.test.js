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
        evalScript: function (jsx, cb) { cb('stub-result'); },
    });
    const app = server.buildApp();
    return new Promise((resolve) => {
        const srv = app.listen(0, '127.0.0.1', () => {
            resolve({ srv: srv, port: srv.address().port });
        });
    });
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

test('/health records the last health probe time', async () => {
    const { srv, port } = await startApp();
    const server = require('./server');
    try {
        const before = Date.now();
        const r = await get(port, '/health', {});
        const after = Date.now();
        assert.strictEqual(r.status, 200);
        const info = server.getConnectionInfo();
        assert.ok(info.lastHealthAt >= before);
        assert.ok(info.lastHealthAt <= after);
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
