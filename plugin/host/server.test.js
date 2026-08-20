'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const FULL_REGISTRY = require(
    '../../native/ae-plugin/protocol/fixtures/capability-registry-full.json'
);
const authToken = require('./auth-token');

const HOST = '22222222-2222-4222-8222-222222222222';
const SESSION = '11111111-1111-4111-8111-111111111111';
const SOURCE = 'a'.repeat(40);
const TOKEN = 'known-secret-token';
const HEADERS = {
    'X-AE-MCP-Token': TOKEN,
    'x-ae-mcp-client': 'stdio-mcp/test',
};

function readProgram() {
    return {
        operations: [{
            op: 'project.items.list',
            args: { offset: 0, limit: 1 },
            returnAs: 'items',
        }],
    };
}

function nativeInvokeBody() {
    return {
        requestId: 'native-program-http-0001',
        capabilityId: 'ae.native.exec',
        capabilityVersion: 1,
        arguments: readProgram(),
        deadlineUnixMs: Date.now() + 10000,
    };
}

function bindRuntimeDependencies(server) {
    server.setRuntimeDependencies({ express });
    return server;
}

function loadServer() {
    delete require.cache[require.resolve('./server')];
    const server = bindRuntimeDependencies(require('./server'));
    server.activity._reset();
    server.setPaused(false);
    server._setExecToken(TOKEN);
    return server;
}

function evaluateTransportEnvelope(server, code) {
    const wrapped = server.wrapForEvalScriptTransport(code);
    const encoded = Function('return ' + wrapped)();
    return { wrapped, encoded, payload: JSON.parse(encoded) };
}

function fakeNativeClient(overrides) {
    let state = 'disconnected';
    let closed = 0;
    const calls = [];
    const client = {
        connect: async function (deadlineUnixMs) {
            calls.push(['connect', deadlineUnixMs]);
            state = 'connected';
            return {};
        },
        negotiate: async function (options) {
            calls.push(['negotiate', options]);
            return {
                selectedWireVersion: 1,
                pluginVersion: '0.1.0-dev',
                compiledSdk: {
                    version: '25.6.61',
                    build: 61,
                    architecture: 'arm64',
                },
                sourceCommit: SOURCE,
                host: {
                    application: 'after-effects',
                    instanceId: HOST,
                    platform: 'macos-arm64',
                },
                sessionId: SESSION,
                sessionGeneration: 7,
                capabilitiesDigest: FULL_REGISTRY.capabilitiesDigest,
            };
        },
        capabilities: async function (options) {
            calls.push(['capabilities', options]);
            return {
                detail: 'full',
                items: structuredClone(FULL_REGISTRY.items),
                nextCursor: null,
                queryDigest: 'b'.repeat(64),
                capabilitiesDigest: FULL_REGISTRY.capabilitiesDigest,
            };
        },
        invoke: async function (request) {
            calls.push(['invoke', request]);
            return {
                capabilityId: 'ae.native.exec',
                outputs: { items: [] },
                operations: [{
                    index: 0,
                    op: 'project.items.list',
                    status: 'completed',
                }],
                evidence: {
                    requestId: request.requestId,
                    capabilityId: 'ae.native.exec',
                    effect: 'none',
                    postcondition: { verified: true },
                },
                undo: { available: false, verified: false },
                replayed: false,
            };
        },
        cancel: async function (request) {
            calls.push(['cancel', request]);
            return {
                targetRequestId: request.targetRequestId,
                state: 'running-not-cancellable',
                terminalResponseExpected: true,
            };
        },
        invalidateProjectGraph: async function (options) {
            calls.push(['invalidateProjectGraph', options]);
            return { generation: 8, invalidated: true };
        },
        status: function () {
            return {
                state,
                hostInstanceId: HOST,
                sourceCommit: SOURCE,
                sessionId: state === 'connected' ? SESSION : null,
                sessionGeneration: state === 'connected' ? 7 : null,
                capabilitiesDigest: FULL_REGISTRY.capabilitiesDigest,
                nativeExecContractDigest: FULL_REGISTRY.items[0].contractDigest,
            };
        },
        close: async function () {
            closed += 1;
            state = 'closed';
        },
        calls,
        closed: function () { return closed; },
    };
    return Object.assign(client, overrides || {});
}

async function startApp(options) {
    const input = options || {};
    const server = loadServer();
    const nativeClient = input.nativeClient || fakeNativeClient();
    server._setNativeAegpClientForTest(nativeClient);
    server.setCSInterface({
        evalScript: input.evalScript || function (_jsx, callback) {
            callback('{"ok":true,"resultType":"string","result":"stub-result"}');
        },
    });
    const app = server.buildApp();
    const instance = await new Promise(function (resolve) {
        const listener = app.listen(0, '127.0.0.1', function () {
            resolve(listener);
        });
    });
    return {
        server,
        nativeClient,
        instance,
        port: instance.address().port,
    };
}

function request(port, method, pathname, headers, body) {
    return new Promise(function (resolve, reject) {
        const data = body === undefined ? null : JSON.stringify(body);
        const req = http.request({
            host: '127.0.0.1',
            port,
            path: pathname,
            method,
            headers: {
                ...(data === null ? {} : {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data),
                }),
                ...(headers || {}),
            },
        }, function (res) {
            let chunks = '';
            res.on('data', function (chunk) { chunks += chunk; });
            res.on('end', function () {
                resolve({
                    status: res.statusCode,
                    body: JSON.parse(chunks || '{}'),
                });
            });
        });
        req.on('error', reject);
        if (data !== null) req.write(data);
        req.end();
    });
}

function post(port, pathname, headers, body) {
    return request(port, 'POST', pathname, headers, body);
}

function get(port, pathname, headers) {
    return request(port, 'GET', pathname, headers);
}

async function closeFixture(fixture) {
    await new Promise(function (resolve) { fixture.instance.close(resolve); });
    fixture.server.stop();
}

test('token matching is exact and rejects non-string input', () => {
    assert.equal(authToken.tokenMatches('abc123', 'abc123'), true);
    assert.equal(authToken.tokenMatches('abc123', 'abc124'), false);
    assert.equal(authToken.tokenMatches('short', 'longer'), false);
    assert.equal(authToken.tokenMatches(undefined, 'x'), false);
});

test('token creation is idempotent and regeneration replaces it', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-token-'));
    t.mock.method(os, 'homedir', function () { return root; });
    const first = authToken.ensureToken();
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(authToken.ensureToken(), first);
    const second = authToken.regenerate();
    assert.match(second, /^[0-9a-f]{64}$/);
    assert.notEqual(second, first);
    fs.rmSync(root, { recursive: true, force: true });
});

test('server requires explicit Express injection', () => {
    delete require.cache[require.resolve('./server')];
    const server = require('./server');
    assert.throws(
        function () { server.buildApp(); },
        function (error) {
            return error?.code === 'HOST_RUNTIME_DEPENDENCIES_UNAVAILABLE';
        },
    );
});

test('native invoke requires auth and accepts only the native program root', async () => {
    const fixture = await startApp();
    const programBody = nativeInvokeBody();
    try {
        const unauthorized = await post(
            fixture.port,
            '/native/invoke',
            {},
            programBody,
        );
        assert.equal(unauthorized.status, 401);
        assert.equal(unauthorized.body.error.code, 'UNAUTHORIZED');

        const legacy = await post(fixture.port, '/native/invoke', HEADERS, {
            requestId: 'legacy-project-summary',
            capabilityId: 'ae.project.summary',
            capabilityVersion: 1,
            arguments: {},
            deadlineUnixMs: Date.now() + 10000,
        });
        assert.equal(legacy.status, 400);
        assert.equal(legacy.body.error.code, 'INVALID_ARGUMENT');

        const invoked = await post(
            fixture.port,
            '/native/invoke',
            HEADERS,
            programBody,
        );
        assert.equal(invoked.status, 200);
        assert.equal(invoked.body.result.capabilityId, 'ae.native.exec');
        assert.deepEqual(
            fixture.nativeClient.calls.filter(function (entry) {
                return entry[0] === 'invoke';
            }),
            [['invoke', programBody]],
        );
    } finally {
        await closeFixture(fixture);
    }
});

test('native routes preserve negotiation and the single descriptor query', async () => {
    const fixture = await startApp();
    const deadlineUnixMs = Date.now() + 10000;
    try {
        const negotiated = await post(
            fixture.port,
            '/native/negotiate',
            HEADERS,
            { deadlineUnixMs },
        );
        assert.equal(negotiated.status, 200);
        assert.equal(negotiated.body.result.sourceCommit, SOURCE);
        assert.equal(negotiated.body.result.compiledSdkVersion, '25.6.61');

        const capabilities = await post(
            fixture.port,
            '/native/capabilities',
            HEADERS,
            {
                ids: ['ae.native.exec'],
                detail: 'full',
                limit: 100,
                deadlineUnixMs,
            },
        );
        assert.equal(capabilities.status, 200);
        assert.equal(capabilities.body.result.sessionId, SESSION);
        assert.deepEqual(
            capabilities.body.result.items.map(function (item) { return item.id; }),
            ['ae.native.exec'],
        );
        assert.deepEqual(
            fixture.nativeClient.calls.find(function (entry) {
                return entry[0] === 'capabilities';
            }),
            ['capabilities', {
                ids: ['ae.native.exec'],
                detail: 'full',
                limit: 100,
                deadlineUnixMs,
            }],
        );
    } finally {
        await closeFixture(fixture);
    }
});

test('native cancel is a closed control route bound to request identity', async () => {
    const fixture = await startApp();
    const body = {
        requestId: 'cancel-control-http-0001',
        targetRequestId: 'native-program-target-0001',
        deadlineUnixMs: Date.now() + 10000,
    };
    try {
        const cancelled = await post(
            fixture.port,
            '/native/cancel',
            HEADERS,
            body,
        );
        assert.equal(cancelled.status, 200);
        assert.deepEqual(cancelled.body.result, {
            targetRequestId: body.targetRequestId,
            state: 'running-not-cancellable',
            terminalResponseExpected: true,
        });
        assert.deepEqual(
            fixture.nativeClient.calls.find(function (entry) {
                return entry[0] === 'cancel';
            }),
            ['cancel', body],
        );

        const open = await post(
            fixture.port,
            '/native/cancel',
            HEADERS,
            { ...body, legacyCapabilityId: 'ae.project.summary' },
        );
        assert.equal(open.status, 400);
    } finally {
        await closeFixture(fixture);
    }
});

test('native invoke preserves structured uncertain-write failures', async () => {
    const failure = Object.assign(
        new Error('Native write may have completed.'),
        {
            code: 'POSSIBLY_SIDE_EFFECTING_FAILURE',
            retryable: false,
            sideEffect: 'may-have-occurred',
            recovery: {
                action: 'inspect-state',
                hint: 'Inspect AE state before retrying.',
            },
            details: {
                capabilityId: 'ae.native.exec',
                operationKey: 'native-program-write-0001',
            },
        },
    );
    const fixture = await startApp({
        nativeClient: fakeNativeClient({
            invoke: async function () { throw failure; },
        }),
    });
    try {
        const body = nativeInvokeBody();
        body.arguments = {
            ...body.arguments,
            operationKey: 'native-program-write-0001',
            undoGroup: 'Native program write',
        };
        const response = await post(
            fixture.port,
            '/native/invoke',
            HEADERS,
            body,
        );
        assert.equal(response.status, 503);
        assert.deepEqual(response.body.error, {
            code: 'POSSIBLY_SIDE_EFFECTING_FAILURE',
            message: 'Native write may have completed.',
            retryable: false,
            sideEffect: 'may-have-occurred',
            recovery: {
                action: 'inspect-state',
                hint: 'Inspect AE state before retrying.',
            },
            details: {
                capabilityId: 'ae.native.exec',
                operationKey: 'native-program-write-0001',
            },
        });
    } finally {
        await closeFixture(fixture);
    }
});

test('native routes preserve panel pause and client blocking', async () => {
    const fixture = await startApp();
    try {
        fixture.server.setPaused(true);
        const paused = await post(
            fixture.port,
            '/native/invoke',
            HEADERS,
            nativeInvokeBody(),
        );
        assert.equal(paused.status, 503);
        assert.equal(paused.body.error.code, 'ACTIONS_PAUSED');

        fixture.server.setPaused(false);
        fixture.server.setClientBlocked('stdio-mcp/test', true);
        const blocked = await post(
            fixture.port,
            '/native/invoke',
            HEADERS,
            nativeInvokeBody(),
        );
        assert.equal(blocked.status, 403);
        assert.equal(blocked.body.error.code, 'CLIENT_BLOCKED');
    } finally {
        fixture.server.setClientBlocked('stdio-mcp/test', false);
        await closeFixture(fixture);
    }
});

test('/exec requires auth and invalidates a connected native graph before JSX', async () => {
    const order = [];
    const nativeClient = fakeNativeClient({
        invalidateProjectGraph: async function (options) {
            order.push(['invalidate', options]);
            return { generation: 8, invalidated: true };
        },
    });
    await nativeClient.connect(Date.now() + 10000);
    const fixture = await startApp({
        nativeClient,
        evalScript: function (_jsx, callback) {
            order.push(['eval']);
            callback('{"ok":true,"resultType":"string","result":"jsx-result"}');
        },
    });
    try {
        const unauthorized = await post(
            fixture.port,
            '/exec',
            {},
            { code: '1 + 1' },
        );
        assert.equal(unauthorized.status, 401);
        const response = await post(
            fixture.port,
            '/exec',
            HEADERS,
            { code: '1 + 1' },
        );
        assert.equal(response.status, 200);
        assert.deepEqual(response.body, {
            ok: true,
            resultType: 'string',
            result: 'jsx-result',
        });
        assert.equal(order[0][0], 'invalidate');
        assert.equal(order[1][0], 'eval');
    } finally {
        await closeFixture(fixture);
    }
});

test('/exec preserves the graph only when explicitly requested', async () => {
    const nativeClient = fakeNativeClient();
    await nativeClient.connect(Date.now() + 10000);
    const fixture = await startApp({ nativeClient });
    try {
        const response = await post(fixture.port, '/exec', HEADERS, {
            code: '1 + 1',
            nativeProjectGraphEffect: 'preserve',
        });
        assert.equal(response.body.ok, true);
        assert.equal(nativeClient.calls.some(function (entry) {
            return entry[0] === 'invalidateProjectGraph';
        }), false);
        const invalid = await post(fixture.port, '/exec', HEADERS, {
            code: '1 + 1',
            nativeProjectGraphEffect: 'legacy',
        });
        assert.equal(invalid.status, 400);
    } finally {
        await closeFixture(fixture);
    }
});

test('/exec fails closed when connected graph invalidation fails', async () => {
    let evaluated = false;
    const nativeClient = fakeNativeClient({
        invalidateProjectGraph: async function () {
            throw new Error('invalidation failed');
        },
    });
    await nativeClient.connect(Date.now() + 10000);
    const fixture = await startApp({
        nativeClient,
        evalScript: function () { evaluated = true; },
    });
    try {
        const response = await post(
            fixture.port,
            '/exec',
            HEADERS,
            { code: '1 + 1' },
        );
        assert.equal(response.body.ok, false);
        assert.match(response.body.error, /invalidation failed/);
        assert.equal(response.body.disposition, 'not_dispatched');
        assert.equal(evaluated, false);
    } finally {
        await closeFixture(fixture);
    }
});

test('ExtendScript transport serializes typed primitive and structured results as ASCII', () => {
    const server = loadServer();
    const cases = [
        ['string', '"hello"', 'string', 'hello'],
        ['plain object', '({ok:true,n:42})', 'json', '{"ok":true,"n":42}'],
        ['nested object', '({a:{b:[1,{c:true}]}})', 'json', '{"a":{"b":[1,{"c":true}]}}'],
        ['array', '[1,2,3]', 'json', '[1,2,3]'],
        ['mixed array', '[1,"two",{three:3}]', 'json', '[1,"two",{"three":3}]'],
        ['number', '6*7', 'json', '42'],
        ['boolean', 'true', 'json', 'true'],
        ['null', 'null', 'json', 'null'],
        ['undefined', 'var x=1;', 'string', 'undefined'],
    ];
    cases.forEach(function (entry) {
        const evaluated = evaluateTransportEnvelope(server, entry[1]);
        assert.doesNotMatch(evaluated.wrapped, /[^\x00-\x7f]/, entry[0] + ' wrapper');
        assert.doesNotMatch(evaluated.encoded, /[^\x00-\x7f]/, entry[0] + ' envelope');
        assert.deepEqual(
            server.decodeEvalScriptTransportResult(evaluated.encoded),
            { resultType: entry[2], result: entry[3] },
            entry[0],
        );
    });
});

test('ExtendScript transport applies JSON semantics and guards property access', () => {
    const server = loadServer();
    const objectResult = evaluateTransportEnvelope(
        server,
        '(function(){var o={safe:1,skip:undefined,fn:function(){},nan:NaN,infinity:Infinity};'
            + 'Object.defineProperty(o,"throwing",{enumerable:true,get:function(){throw new Error("getter");}});'
            + 'return o;})()',
    );
    assert.equal(objectResult.payload.resultType, 'json');
    assert.deepEqual(JSON.parse(objectResult.payload.result), {
        safe: 1,
        nan: null,
        infinity: null,
    });

    const arrayResult = evaluateTransportEnvelope(
        server,
        '(function(){var a=[1,undefined,function(){},NaN];'
            + 'Object.defineProperty(a,"4",{enumerable:true,get:function(){throw new Error("getter");}});'
            + 'return a;})()',
    );
    assert.deepEqual(JSON.parse(arrayResult.payload.result), [1, null, null, null, null]);
});

test('ExtendScript transport escapes non-ASCII JSON values and treats host-like objects as leaves', () => {
    const server = loadServer();
    const localized = evaluateTransportEnvelope(server, '({message:"你好",nested:["é"]})');
    assert.doesNotMatch(localized.wrapped, /[^\x00-\x7f]/);
    assert.doesNotMatch(localized.encoded, /[^\x00-\x7f]/);
    assert.deepEqual(JSON.parse(localized.payload.result), { message: '你好', nested: ['é'] });

    const hostLike = evaluateTransportEnvelope(
        server,
        '(function(){function CompItem(){}'
            + 'CompItem.prototype.toString=function(){return "[object CompItem]";};'
            + 'var item=new CompItem();'
            + 'Object.defineProperty(item,"throwing",{enumerable:true,get:function(){throw new Error("must not walk");}});'
            + 'return item;})()',
    );
    assert.equal(hostLike.payload.resultType, 'json');
    assert.equal(JSON.parse(hostLike.payload.result), '[object CompItem]');
});

test('ExtendScript transport fails deterministically for cycles and serialization caps', () => {
    const server = loadServer();
    const cases = [
        [
            '(function(){var value={};value.self=value;return value;})()',
            /cyclic plain Object or Array/,
        ],
        [
            '(function(){var root={},cursor=root;for(var i=0;i<13;i++){cursor.next={};cursor=cursor.next;}return root;})()',
            /maximum serialization depth of 12/,
        ],
        [
            '({value:Array(1000002).join("x")})',
            /1000000 character serialization limit/,
        ],
    ];
    cases.forEach(function (entry) {
        const evaluated = evaluateTransportEnvelope(server, entry[0]);
        assert.equal(evaluated.payload.ok, false);
        assert.match(evaluated.payload.error, entry[1]);
        assert.match(evaluated.payload.error, /return a smaller projection/);
        assert.throws(
            function () { server.decodeEvalScriptTransportResult(evaluated.encoded); },
            entry[1],
        );
    });
});

test('evalScript transport decoder requires typed successes and preserves error envelopes', () => {
    const server = loadServer();
    assert.deepEqual(
        server.decodeEvalScriptTransportResult(
            '{"ok":true,"resultType":"string","result":"你好"}',
        ),
        { resultType: 'string', result: '你好' },
    );
    assert.deepEqual(
        server.decodeEvalScriptTransportResult(
            '{"ok":true,"resultType":"json","result":"{\\"n\\":42}"}',
        ),
        { resultType: 'json', result: '{"n":42}' },
    );
    assert.throws(
        function () {
            server.decodeEvalScriptTransportResult('{"ok":true,"result":"legacy"}');
        },
        /resultType/,
    );
    assert.throws(
        function () {
            server.decodeEvalScriptTransportResult(
                '{"ok":true,"resultType":"binary","result":"legacy"}',
            );
        },
        /resultType/,
    );
    let legacyError;
    try {
        server.decodeEvalScriptTransportResult('{"ok":false,"error":"boom"}');
    } catch (error) {
        legacyError = error;
    }
    assert.match(legacyError.message, /boom/);
    assert.equal(legacyError.disposition, 'failed');
});

test('health and activity expose only authenticated operational state', async () => {
    const fixture = await startApp();
    try {
        const health = await get(fixture.port, '/health');
        assert.equal(health.status, 200);
        assert.equal(health.body.jsxBridge.state, 'ok');
        assert.equal(health.body.jsxBridge.degradedSinceMs, null);
        assert.equal(typeof health.body.jsxBridge.pendingCalls, 'number');
        const denied = await get(fixture.port, '/activity', {});
        assert.equal(denied.status, 401);
        await post(fixture.port, '/exec', HEADERS, { code: '1 + 1' });
        const activity = await get(fixture.port, '/activity', HEADERS);
        assert.equal(activity.status, 200);
        assert.equal(activity.body.events.some(function (event) {
            return event.client === 'stdio-mcp/test' && event.ok === true;
        }), true);
        assert.equal(Object.hasOwn(health.body, 'pythonVersion'), false);
        assert.equal(Object.hasOwn(health.body, 'pythonLastSeenAt'), false);
        assert.equal(Object.hasOwn(fixture.server.getConnectionInfo(), 'pythonVersion'), false);
    } finally {
        await closeFixture(fixture);
    }
});

test('/exec reports a completed ExtendScript error as failed, not uncertain', async () => {
    const fixture = await startApp({
        evalScript: function (jsx, callback) {
            // The transport envelope catches the JSX exception itself and
            // returns a well-formed ok:false payload (what real AE does).
            callback('{"ok":false,"error":"Error: boom (line 1)"}');
        },
    });
    try {
        const response = await post(fixture.port, '/exec', HEADERS, { code: 'throw new Error("boom")' });
        assert.equal(response.body.ok, false);
        assert.match(response.body.error, /^ExtendScript error: Error: boom/);
        assert.equal(response.body.disposition, 'failed');
        assert.equal(response.body.jsxBridge.state, 'ok');
    } finally {
        await closeFixture(fixture);
    }
});

test('/exec distinguishes uncertain timeout from a queued not_dispatched call', async () => {
    const evalCalls = [];
    let sentinelCallback = null;
    const fixture = await startApp({
        evalScript: function (jsx, callback) {
            evalCalls.push(jsx);
            if (/endUndoGroup/.test(jsx) && !/beginUndoGroup/.test(jsx)) {
                sentinelCallback = callback;
            }
        },
    });
    try {
        const first = await post(fixture.port, '/exec', HEADERS, {
            code: 'slowWrite()',
            timeoutMs: 5,
        });
        assert.equal(first.body.ok, false);
        assert.match(first.body.error, /^JSX timeout after 5ms/);
        assert.equal(first.body.disposition, 'uncertain');
        assert.equal(first.body.jsxBridge.state, 'degraded');

        const second = await post(fixture.port, '/exec', HEADERS, {
            code: 'mustNotRun()',
            timeoutMs: 10,
        });
        assert.equal(second.body.ok, false);
        assert.equal(second.body.disposition, 'not_dispatched');
        assert.equal(second.body.jsxBridge.state, 'degraded');
        assert.equal(evalCalls.length, 2, 'only the first real script and one sentinel are dispatched');
        assert.equal(evalCalls.some(function (jsx) { return /mustNotRun/.test(jsx); }), false);

        const activityResponse = await get(fixture.port, '/activity', HEADERS);
        const dispositions = activityResponse.body.events.map(function (event) {
            return event.disposition;
        }).filter(Boolean);
        assert.deepEqual(dispositions, ['uncertain', 'not_dispatched']);
    } finally {
        if (sentinelCallback) sentinelCallback('2');
        await closeFixture(fixture);
    }
});
