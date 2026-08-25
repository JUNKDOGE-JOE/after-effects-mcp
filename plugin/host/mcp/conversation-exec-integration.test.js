'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const mountMcp = require('./index');
const { CheckpointStore } = require('./checkpoint-store');
const { READONLY_DENIED } = require('./approval-gate');

function start(options) {
    const input = options || {};
    const ownedStoreRoot = input.checkpointStore
        ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-conversation-store-'));
    const checkpointStore = input.checkpointStore
        || new CheckpointStore({ root: ownedStoreRoot });
    const app = express();
    app.use(express.json());
    const mounted = mountMcp(app, {
        version: '0.9.6-test',
        getStatus: function () { return { ok: true }; },
        executeJsx: input.executeJsx,
        checkpointStore,
        recoveryStore: input.recoveryStore,
        progressIntervalMs: input.progressIntervalMs,
        approvalTimeoutMs: input.approvalTimeoutMs,
    });
    return new Promise(function (resolve) {
        const listener = app.listen(0, '127.0.0.1', function () {
            resolve({ listener, port: listener.address().port, mounted, ownedStoreRoot });
        });
    });
}

function request(port, method, route, headers, body) {
    return new Promise(function (resolve, reject) {
        const text = body === undefined ? null : JSON.stringify(body);
        const req = http.request({
            host: '127.0.0.1', port, path: route, method, agent: false,
            headers: Object.assign({ Connection: 'close' }, text === null ? {} : {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(text),
            }, headers || {}),
        }, function (res) {
            let data = '';
            res.on('data', function (chunk) { data += chunk; });
            res.on('end', function () {
                const contentType = String(res.headers['content-type'] || '');
                const parsed = data && contentType.indexOf('application/json') !== -1
                    ? JSON.parse(data) : null;
                resolve({ status: res.statusCode, headers: res.headers, text: data, body: parsed });
            });
        });
        req.on('error', reject);
        if (text !== null) req.write(text);
        req.end();
    });
}

async function initialize(fixture, route, name, withClientInfo) {
    const params = withClientInfo === false ? {} : { clientInfo: { name: name } };
    const response = await request(fixture.port, 'POST', route, {}, {
        jsonrpc: '2.0', id: 1, method: 'initialize', params,
    });
    return { response, session: response.headers['mcp-session-id'] };
}

function toolCall(id, code, extra, meta) {
    return {
        jsonrpc: '2.0', id, method: 'tools/call',
        params: Object.assign({
            name: 'ae_exec',
            arguments: Object.assign({ code }, extra || {}),
        }, meta ? { _meta: meta } : {}),
    };
}

async function closeFixture(fixture) {
    await new Promise(function (resolve) { fixture.listener.close(resolve); });
    if (fixture.ownedStoreRoot) {
        fs.rmSync(fixture.ownedStoreRoot, { recursive: true, force: true });
    }
}

test('conversation tiers isolate calls, external calls bypass, updates are live, and unknown tokens 404', async () => {
    const calls = [];
    const fixture = await start({
        executeJsx: async function (requestValue) {
            calls.push(requestValue);
            if (requestValue.code === 'plain') {
                return { payload: { ok: true, resultType: 'string', result: 'hi' } };
            }
            if (requestValue.code === 'empty') {
                return { payload: { ok: true, resultType: 'string', result: '' } };
            }
            return {
                payload: {
                    ok: true,
                    resultType: 'json',
                    result: JSON.stringify({ ok: true, n: 1 }),
                },
            };
        },
    });
    try {
        const none = fixture.mounted.conversations.create({
            label: 'chat-none', policy: { approvalTier: 'none', expertGuidance: true },
        });
        const readonly = fixture.mounted.conversations.create({
            label: 'chat-readonly', policy: { approvalTier: 'readonly', expertGuidance: true },
        });
        const noneSession = await initialize(fixture, none.path, 'claude');
        const readonlySession = await initialize(fixture, readonly.path, 'codex');
        const allowed = await request(fixture.port, 'POST', none.path, {
            'Mcp-Session-Id': noneSession.session,
        }, toolCall(2, 'json'));
        assert.deepEqual(allowed.body.result.structuredContent, {
            ok: true,
            content: '{"ok":true,"n":1}',
            contentType: 'json',
        });
        assert.equal(calls[0].client, 'claude@chat-none');

        const blocked = await request(fixture.port, 'POST', readonly.path, {
            'Mcp-Session-Id': readonlySession.session,
        }, toolCall(3, 'json'));
        assert.equal(blocked.body.result.isError, true);
        assert.deepEqual(blocked.body.result.structuredContent, { ok: false, error: READONLY_DENIED });
        assert.equal(calls.length, 1);

        const external = await initialize(fixture, '/mcp', 'cursor');
        const externalResult = await request(fixture.port, 'POST', '/mcp', {
            'Mcp-Session-Id': external.session,
        }, toolCall(4, 'plain'));
        assert.deepEqual(externalResult.body.result.structuredContent, {
            ok: true,
            content: 'hi',
            contentType: 'text',
        });
        assert.equal(calls[1].client, 'cursor');

        const empty = await request(fixture.port, 'POST', '/mcp', {
            'Mcp-Session-Id': external.session,
        }, toolCall(5, 'empty'));
        assert.equal(empty.body.result.isError, true);
        assert.equal(empty.body.result.structuredContent.ok, false);
        assert.match(empty.body.result.structuredContent.error, /^jsx returned no value \(empty output\)/);
        assert.equal(empty.body.result.structuredContent.raw, '');
        assert.match(empty.body.result.structuredContent.recoveryId, /^[a-z0-9]{6}$/);
        assert.equal(fs.existsSync(empty.body.result.structuredContent.scriptPath), true);

        fixture.mounted.conversations.update(none.id, { approvalTier: 'readonly' });
        const updated = await request(fixture.port, 'POST', none.path, {
            'Mcp-Session-Id': noneSession.session,
        }, toolCall(6, 'json'));
        assert.equal(updated.body.result.isError, true);
        assert.equal(calls.length, 3);

        const unknown = await request(fixture.port, 'POST', '/mcp/c/not-a-token', {}, {
            jsonrpc: '2.0', id: 7, method: 'initialize', params: {},
        });
        assert.equal(unknown.status, 404);

        const wrongRoute = await request(fixture.port, 'POST', '/mcp', {
            'Mcp-Session-Id': readonlySession.session,
        }, { jsonrpc: '2.0', id: 8, method: 'ping', params: {} });
        assert.equal(wrongRoute.status, 404);
    } finally {
        await closeFixture(fixture);
    }
});

test('manual conversation approval accepts with progress and declines without execution', async () => {
    const calls = [];
    const fixture = await start({
        executeJsx: async function (requestValue) {
            calls.push(requestValue);
            return {
                payload: {
                    ok: true,
                    resultType: 'json',
                    result: '{"ok":true,"approved":true}',
                },
            };
        },
        progressIntervalMs: 5,
    });
    try {
        const conversation = fixture.mounted.conversations.create({
            label: 'chat-manual', policy: { approvalTier: 'manual', expertGuidance: true },
        });
        const initialized = await initialize(fixture, conversation.path, 'claude');
        fixture.mounted.approvals.once('request', function (item) {
            assert.equal(calls.length, 0);
            assert.equal(item.conversationId, conversation.id);
            assert.equal(item.summary.code, 'approved-code');
            setTimeout(function () {
                fixture.mounted.approvals.resolve(item.id, 'accept');
            }, 12);
        });
        const accepted = await request(fixture.port, 'POST', conversation.path, {
            'Mcp-Session-Id': initialized.session,
            Accept: 'text/event-stream',
        }, toolCall(2, 'approved-code', {}, { progressToken: 'approval-progress' }));
        assert.equal(accepted.status, 200);
        const frames = accepted.text.split('\n').filter(function (line) {
            return line.indexOf('data: ') === 0;
        }).map(function (line) { return JSON.parse(line.slice(6)); });
        assert.ok(frames.some(function (frame) {
            return frame.method === 'notifications/progress'
                && frame.params.progressToken === 'approval-progress';
        }));
        const terminal = frames.find(function (frame) { return frame.id === 2; });
        assert.deepEqual(terminal.result.structuredContent, {
            ok: true,
            content: '{"ok":true,"approved":true}',
            contentType: 'json',
        });
        assert.equal(calls.length, 1);

        fixture.mounted.approvals.once('request', function (item) {
            assert.equal(calls.length, 1);
            fixture.mounted.approvals.resolve(item.id, 'decline');
        });
        const declined = await request(fixture.port, 'POST', conversation.path, {
            'Mcp-Session-Id': initialized.session,
        }, toolCall(3, 'declined-code'));
        assert.equal(declined.body.result.isError, true);
        assert.deepEqual(declined.body.result.structuredContent, {
            ok: false, error: 'User denied this action.',
        });
        assert.equal(calls.length, 1);
    } finally {
        await closeFixture(fixture);
    }
});

test('checkpoint success probes, snapshots, persists metadata, then executes user JSX', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-checkpoint-integration-'));
    const source = path.join(root, 'source.aep');
    fs.writeFileSync(source, 'source-project', 'utf8');
    const checkpointStore = new CheckpointStore({ root: path.join(root, 'checkpoints') });
    const calls = [];
    const fixture = await start({
        checkpointStore,
        executeJsx: async function (requestValue) {
            calls.push(requestValue);
            if (calls.length === 1) {
                return {
                    payload: {
                        ok: true,
                        resultType: 'string',
                        result: JSON.stringify({ ok: true, path: source }),
                    },
                };
            }
            if (calls.length === 2) {
                const match = requestValue.code.match(/var dstPath = (".*");/);
                assert.ok(match, 'rendered checkpoint script must contain a JSON destination');
                const destination = JSON.parse(match[1]);
                fs.mkdirSync(path.dirname(destination), { recursive: true });
                fs.writeFileSync(destination, 'checkpoint', 'utf8');
                return {
                    payload: {
                        ok: true,
                        resultType: 'string',
                        result: JSON.stringify({
                            ok: true, sizeBytes: 10, activeCompId: '7', currentTime: 1.25,
                        }),
                    },
                };
            }
            return {
                payload: {
                    ok: true,
                    resultType: 'json',
                    result: '{"ok":true,"edited":true}',
                },
            };
        },
    });
    try {
        const external = await initialize(fixture, '/mcp', 'cursor');
        const response = await request(fixture.port, 'POST', '/mcp', {
            'Mcp-Session-Id': external.session,
        }, toolCall(2, 'user-edit-code', {
            checkpoint_label: 'Before edit', undo_group_name: 'Edit', timeout_sec: 45,
        }));
        assert.deepEqual(response.body.result.structuredContent, {
            ok: true,
            content: '{"ok":true,"edited":true}',
            contentType: 'json',
        });
        assert.equal(calls.length, 3);
        assert.match(calls[0].code, /app\.project\.file/);
        assert.ok(calls[1].code.indexOf('${dst_path}') === -1);
        assert.equal(calls[2].code, 'user-edit-code');
        assert.equal(calls[2].checkpointLabel, 'Before edit');
        assert.equal(calls[2].timeoutMs, 45000);
        assert.equal(checkpointStore.list(source, { limit: 10 }).length, 1);
    } finally {
        await closeFixture(fixture);
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('untitled and failed checkpoints annotate the result but never block user JSX', async () => {
    async function runCase(pathResult, checkpointFailure) {
        const calls = [];
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-checkpoint-case-'));
        const store = new CheckpointStore({ root: path.join(root, 'checkpoints') });
        const fixture = await start({
            checkpointStore: store,
            executeJsx: async function (requestValue) {
                calls.push(requestValue);
                if (calls.length === 1) {
                    return {
                        payload: {
                            ok: true,
                            resultType: 'string',
                            result: JSON.stringify({ ok: true, path: pathResult }),
                        },
                    };
                }
                if (checkpointFailure && calls.length === 2) throw new Error('snapshot boom');
                return {
                    payload: {
                        ok: true,
                        resultType: 'json',
                        result: '{"ok":true,"edited":true}',
                    },
                };
            },
        });
        try {
            const external = await initialize(fixture, '/mcp', 'cursor');
            const response = await request(fixture.port, 'POST', '/mcp', {
                'Mcp-Session-Id': external.session,
            }, toolCall(2, 'user-edit', { checkpoint_label: 'Before edit' }));
            return { result: response.body.result.structuredContent, calls };
        } finally {
            await closeFixture(fixture);
            fs.rmSync(root, { recursive: true, force: true });
        }
    }

    const untitled = await runCase(null, false);
    assert.deepEqual(untitled.result, {
        ok: true,
        content: '{"ok":true,"edited":true}',
        contentType: 'json',
        checkpointSkipped: 'untitled-project',
    });
    assert.equal(untitled.calls.length, 2);
    assert.equal(untitled.calls[1].code, 'user-edit');

    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-source-case-'));
    const source = path.join(sourceRoot, 'source.aep');
    fs.writeFileSync(source, 'project', 'utf8');
    try {
        const failed = await runCase(source, true);
        assert.match(failed.result.checkpointSkipped, /^checkpoint-failed:/);
        assert.equal(failed.calls.length, 3);
        assert.equal(failed.calls[2].code, 'user-edit');
    } finally {
        fs.rmSync(sourceRoot, { recursive: true, force: true });
    }
});
