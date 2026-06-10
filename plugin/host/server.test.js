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

// ---- /exec auth wiring via the real Express app ----

function startApp() {
    delete require.cache[require.resolve('./server')];
    delete require.cache[require.resolve('./jsx-bridge')];
    const server = require('./server');
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
