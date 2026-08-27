'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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
const { createStatePaths } = require('./state-paths');

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

const stateRoots = [];
test.after(function () {
    stateRoots.forEach(function (root) { fs.rmSync(root, { recursive: true, force: true }); });
});

function isolatedStatePaths() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-server-state-'));
    stateRoots.push(root);
    return createStatePaths({
        stateDir: root,
        homedir: function () { throw new Error('server tests must not resolve the real home'); },
    });
}

function bindRuntimeDependencies(server) {
    server.setRuntimeDependencies({ express, statePaths: isolatedStatePaths() });
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

function evaluateTransportEnvelope(server, code, options) {
    const wrapped = server.wrapForEvalScriptTransport(code, options);
    const encoded = Function('return ' + wrapped)();
    const outer = JSON.parse(encoded);
    let payload = outer;
    if (outer && Object.hasOwn(outer, 'inner') && outer.diag) {
        payload = outer.inner === null ? { ok: false, error: outer.diag.fatal } : outer.inner;
        ['projectPath', 'revision', 'logs', 'logsTruncated'].forEach(function (field) {
            if (Object.hasOwn(outer.diag, field)) payload[field] = outer.diag[field];
        });
        if (payload.ok !== true) {
            ['line', 'touched'].forEach(function (field) {
                if (Object.hasOwn(outer.diag, field)) payload[field] = outer.diag[field];
            });
        }
    }
    return { wrapped, encoded, outer, payload };
}

const DIAGNOSTIC_GLOBALS = [
    'CompItem', '$', 'app', '__diagnosticComp', '__diagnosticMakeLayer', '__diagnosticProject',
];

function withDiagnosticGlobals(values, run) {
    const prior = {};
    DIAGNOSTIC_GLOBALS.forEach(function (name) {
        prior[name] = Object.getOwnPropertyDescriptor(global, name) || null;
        delete global[name];
    });
    Object.keys(values || {}).forEach(function (name) { global[name] = values[name]; });
    try {
        return run();
    } finally {
        DIAGNOSTIC_GLOBALS.forEach(function (name) {
            delete global[name];
            if (prior[name]) Object.defineProperty(global, name, prior[name]);
        });
    }
}

function diagnosticSnapshotFakes(layerCount) {
    function makeLayer(name, index, id, opacity) {
        const transform = {
            'ADBE Anchor Point': { value: [0, 0] },
            'ADBE Position': { value: [index * 10, index * 20] },
            'ADBE Scale': { value: [100, 100] },
            'ADBE Rotate Z': { value: 0 },
            'ADBE Opacity': { value: opacity },
        };
        return {
            id,
            index,
            name,
            enabled: true,
            solo: false,
            shy: false,
            locked: false,
            label: 1,
            inPoint: 0,
            outPoint: 5,
            startTime: 0,
            stretch: 100,
            parent: null,
            blendingMode: 'NORMAL',
            threeDLayer: false,
            property: function (matchName) {
                if (matchName === 'ADBE Transform Group') {
                    return { property: function (name2) { return transform[name2] || null; } };
                }
                if (matchName === 'ADBE Effect Parade') return { numProperties: 1 };
                if (matchName === 'ADBE Mask Parade') return { numProperties: 0 };
                return null;
            },
        };
    }
    function CompItem(id, name, layers) {
        this.id = id;
        this.name = name;
        this.typeName = 'Composition';
        this._layers = layers || [];
    }
    Object.defineProperty(CompItem.prototype, 'numLayers', {
        get: function () { return this._layers.length; },
    });
    CompItem.prototype.layer = function (index) { return this._layers[index - 1] || null; };
    const layers = [];
    const total = layerCount === undefined ? 1 : layerCount;
    for (let index = 1; index <= total; index += 1) {
        layers.push(makeLayer('Layer ' + index, index, 100 + index, 100));
    }
    const comp = new CompItem(41, 'Comp', layers);
    const projectItems = [comp];
    const items = {
        item: function (index) { return projectItems[index - 1] || null; },
        push: function (item) { projectItems.push(item); },
    };
    Object.defineProperty(items, 'length', { get: function () { return projectItems.length; } });
    const project = {
        revision: 10,
        file: { fsName: 'C:/project.aep' },
        activeItem: comp,
        items,
        itemByID: function (id) {
            return projectItems.find(function (item) { return item.id === id; }) || null;
        },
    };
    Object.defineProperty(project, 'numItems', { get: function () { return projectItems.length; } });
    const writes = [];
    return {
        globals: {
            CompItem,
            app: { project },
            $: { writeln: function (value) { writes.push(String(value)); } },
            __diagnosticComp: comp,
            __diagnosticMakeLayer: makeLayer,
            __diagnosticProject: project,
        },
        CompItem,
        comp,
        project,
        writes,
    };
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
    const statePaths = createStatePaths({ stateDir: root });
    const first = authToken.ensureToken({ statePaths });
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(authToken.ensureToken({ statePaths }), first);
    const second = authToken.regenerate({ statePaths });
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

test('default ExtendScript transport remains byte-identical to its fixed baseline', () => {
    const server = loadServer();
    const wrapped = server.wrapForEvalScriptTransport('1 + 1');
    assert.doesNotMatch(wrapped, /[^\x00-\x7f]/);
    assert.equal(Buffer.byteLength(wrapped), 4963);
    assert.equal(
        crypto.createHash('sha256').update(wrapped).digest('hex'),
        'fb30f61841ee2fc9a55710498a70ca3e6ed8d302c373c4930eeb8ab635ed0b36',
    );
});

test('ExtendScript quote fast and regexp paths remain byte-identical to the character loop', () => {
    const server = loadServer();
    let codePointRange = '';
    for (let codePoint = 0; codePoint <= 0x02ff; codePoint += 1) {
        codePointRange += String.fromCharCode(codePoint);
    }
    let latin1Range = '';
    for (let codePoint = 0x0080; codePoint <= 0x00ff; codePoint += 1) {
        latin1Range += String.fromCharCode(codePoint);
    }
    const boundarySurrogate = 'a'.repeat(8191) + '\ud83d\ude00' + 'b';
    const boundaryChinese = 'a'.repeat(8188) + ('中文').repeat(8) + 'b';
    const denseUnit = 'abcdefghijklm"\\';
    const quoteDense = denseUnit.repeat((600 * 1024) / denseUnit.length);
    const cases = [
        ['U+0000 through U+02FF', codePointRange],
        ['U+0080 through U+00FF', latin1Range],
        ['surrogate pair', '\ud83d\ude00'],
        ['surrogate pair across 8192 boundary', boundarySurrogate],
        ['Chinese run across 8192 boundary', boundaryChinese],
        ['mixed escapes', 'quote:" slash:\\ control:\u0001'],
        ['replacement tokens', '$& $1 $$ 100% \u4e2d'],
        ['300 KB ASCII', 'a'.repeat(300 * 1024)],
        ['300 KB with Chinese', ('中文').repeat(150 * 1024)],
        ['600 KB quote-dense ASCII', quoteDense],
    ];
    function quoteByCharacter(value) {
        const text = String(value);
        let output = '"';
        for (let index = 0; index < text.length; index += 1) {
            const code = text.charCodeAt(index);
            if (code === 8) output += '\\b';
            else if (code === 9) output += '\\t';
            else if (code === 10) output += '\\n';
            else if (code === 12) output += '\\f';
            else if (code === 13) output += '\\r';
            else if (code === 34) output += '\\"';
            else if (code === 92) output += '\\\\';
            else if (code < 32 || code > 126) {
                output += '\\u' + ('0000' + code.toString(16)).slice(-4);
            } else {
                output += text.charAt(index);
            }
        }
        return output + '"';
    }
    cases.forEach(function (entry) {
        const evaluated = evaluateTransportEnvelope(server, JSON.stringify(entry[1]));
        const expected = '{"ok":true,"resultType":"string","result":'
            + quoteByCharacter(entry[1]) + '}';
        assert.doesNotMatch(evaluated.wrapped, /[^\x00-\x7f]/, entry[0] + ' wrapper');
        assert.doesNotMatch(evaluated.encoded, /[^\x00-\x7f]/, entry[0] + ' envelope');
        assert.equal(evaluated.encoded, expected, entry[0] + ' encoded');
        assert.deepEqual(
            server.decodeEvalScriptTransportResult(evaluated.encoded),
            { resultType: 'string', result: entry[1] },
            entry[0] + ' decoded',
        );
    });

    const escapedCases = [
        ['\u0001', '\\u0001'],
        ['\u007f', '\\u007f'],
        ['\u4e2d', '\\u4e2d'],
        ['\ud83d\ude00', '\\ud83d\\ude00'],
        ['\b\t\n\f\r"\\', '\\b\\t\\n\\f\\r\\"\\\\'],
    ];
    escapedCases.forEach(function (entry) {
        const evaluated = evaluateTransportEnvelope(server, JSON.stringify(entry[0]));
        assert.equal(
            evaluated.encoded,
            '{"ok":true,"resultType":"string","result":"' + entry[1] + '"}',
        );
    });

    const shortObjects = [];
    for (let index = 0; index < 20000; index += 1) {
        shortObjects.push({ i: index, name: 'x' });
    }
    const shortObjectsJson = JSON.stringify(shortObjects);
    const evaluatedObjects = evaluateTransportEnvelope(server, shortObjectsJson);
    assert.equal(
        evaluatedObjects.encoded,
        '{"ok":true,"resultType":"json","result":'
            + quoteByCharacter(shortObjectsJson) + '}',
    );
    assert.deepEqual(JSON.parse(evaluatedObjects.payload.result), shortObjects);
});

test('ExtendScript quote self-check falls back when regexp replacement is unavailable', () => {
    const server = loadServer();
    const value = 'ascii \u0001 中文 \ud83d\ude00 " \\ \b\t\n\f\r';
    const wrapped = server.wrapForEvalScriptTransport(JSON.stringify(value));
    const normal = Function('return ' + wrapped)();
    const fallback = Function(
        'var __r=String.prototype.replace;'
        + 'String.prototype.replace=function(){throw new Error("no replace");};'
        + 'try{return ' + wrapped + ';}finally{String.prototype.replace=__r;}',
    )();
    assert.equal(fallback, normal);
    assert.deepEqual(
        server.decodeEvalScriptTransportResult(fallback),
        { resultType: 'string', result: value },
    );
});

test('ExtendScript quote self-check falls back when global escape is unavailable', () => {
    const server = loadServer();
    const value = 'ascii \u0001 \u00e9 \u4e2d \ud83d\ude00';
    const wrapped = server.wrapForEvalScriptTransport(JSON.stringify(value));
    const normal = Function('return ' + wrapped)();
    const fallback = Function(
        'var __e=escape;escape=undefined;'
        + 'try{return ' + wrapped + ';}finally{escape=__e;}',
    )();
    assert.equal(fallback, normal);
    assert.deepEqual(
        server.decodeEvalScriptTransportResult(fallback),
        { resultType: 'string', result: value },
    );
});

test('diagnostic transport embeds string and JSON results without re-escaping them', () => {
    const server = loadServer();
    const fakes = diagnosticSnapshotFakes();
    const expected = 'quote:" slash:\\ newline:\n中文 </script>';
    withDiagnosticGlobals(fakes.globals, function () {
        const stringResult = evaluateTransportEnvelope(
            server,
            '$.writeln("success");' + JSON.stringify(expected),
            { diagnostics: true },
        );
        assert.doesNotMatch(stringResult.wrapped, /[^\x00-\x7f]/);
        assert.equal(stringResult.outer.inner.resultType, 'string');
        assert.equal(stringResult.outer.inner.result, expected);
        assert.deepEqual(server.decodeEvalScriptTransportResult(stringResult.encoded), {
            resultType: 'string',
            result: expected,
            logs: ['success'],
            revision: { before: 10, after: 10 },
            projectPath: 'C:/project.aep',
        });
        assert.doesNotMatch(
            stringResult.wrapped,
            /__aemcp_quote\(__aemcp_payload\.result\)/,
        );

        const jsonResult = evaluateTransportEnvelope(
            server,
            '({text:"中文",items:[1,"two",{ok:true}]})',
            { diagnostics: true },
        );
        const decodedJson = server.decodeEvalScriptTransportResult(jsonResult.encoded);
        assert.equal(decodedJson.resultType, 'json');
        assert.deepEqual(JSON.parse(decodedJson.result), {
            text: '中文',
            items: [1, 'two', { ok: true }],
        });
    });
});

test('diagnostic decoder classifies an outer fatal error as a dispatched failure', () => {
    const server = loadServer();
    const fakes = diagnosticSnapshotFakes();
    withDiagnosticGlobals(fakes.globals, function () {
        const nativeEval = global.eval;
        global.eval = function () { throw new Error('outer failed'); };
        try {
            const evaluated = evaluateTransportEnvelope(server, '42', { diagnostics: true });
            assert.equal(evaluated.outer.inner, null);
            assert.match(evaluated.outer.diag.fatal, /outer failed/);
            assert.throws(
                function () { server.decodeEvalScriptTransportResult(evaluated.encoded); },
                function (error) {
                    return error.disposition === 'failed'
                        && /outer failed/.test(error.message)
                        && error.projectPath === 'C:/project.aep';
                },
            );
        } finally {
            global.eval = nativeEval;
        }
    });
});

test('diagnostic transport reports bounded layer snapshot differences', () => {
    const server = loadServer();
    const fakes = diagnosticSnapshotFakes();
    withDiagnosticGlobals(fakes.globals, function () {
        const originalWriteln = fakes.globals.$.writeln;
        const evaluated = evaluateTransportEnvelope(
            server,
            '$.writeln("captured");\n'
                + '__diagnosticComp._layers.push(__diagnosticMakeLayer("Added",2,102,100));\n'
                + '__diagnosticComp.layer(1).property("ADBE Transform Group").property("ADBE Opacity").value=42;\n'
                + 'app.project.revision=11;\n'
                + '(function(){var e=new Error("boom");e.line=5;throw e;})()',
            { diagnostics: true },
        );
        assert.equal(evaluated.payload.ok, false);
        assert.equal(evaluated.payload.line, 5);
        assert.equal(evaluated.payload.touched.level, 'layer_diff');
        assert.equal(evaluated.payload.touched.method, 'snapshot-diff');
        assert.equal(Object.hasOwn(evaluated.payload.touched, 'recorder'), false);
        assert.equal(Object.hasOwn(evaluated.payload.touched, 'mutations'), false);
        assert.deepEqual(evaluated.payload.touched.comp, { id: 41, name: 'Comp' });
        assert.ok(evaluated.payload.touched.layersAdded.some(function (layer) {
            return layer.name === 'Added' && layer.id === 102;
        }));
        assert.ok(evaluated.payload.touched.layersChanged[0].changes.some(function (change) {
            return change.field === 'transform.opacity'
                && change.before === '100' && change.after === '42';
        }));
        assert.deepEqual(evaluated.payload.logs, ['captured']);
        assert.deepEqual(evaluated.payload.revision, { before: 10, after: 11 });
        assert.equal(evaluated.payload.projectPath, 'C:/project.aep');
        assert.equal(fakes.globals.$.writeln, originalWriteln);
        assert.throws(
            function () { server.decodeEvalScriptTransportResult(evaluated.encoded); },
            function (error) {
                return error.disposition === 'failed'
                    && error.line === 5
                    && error.touched.level === 'layer_diff'
                    && error.logs[0] === 'captured';
            },
        );
    });
});

test('diagnostic layer differences ignore index shifts and use stable parent identity', () => {
    const server = loadServer();
    const fakes = diagnosticSnapshotFakes(2);
    const layerA = fakes.comp._layers[0];
    const layerB = fakes.comp._layers[1];
    layerA.name = 'A';
    layerA.id = 1;
    layerB.name = 'B';
    layerB.id = 2;
    layerB.parent = layerA;
    withDiagnosticGlobals(fakes.globals, function () {
        const evaluated = evaluateTransportEnvelope(
            server,
            'var c=__diagnosticMakeLayer("C",1,3,100);'
                + '__diagnosticComp._layers.unshift(c);'
                + 'for(var i=0;i<__diagnosticComp._layers.length;i++)'
                + '{__diagnosticComp._layers[i].index=i+1;}'
                + '__diagnosticComp.layer(3).property("ADBE Transform Group")'
                + '.property("ADBE Opacity").value=42;'
                + '(function(){var e=new Error("expected");e.line=7;throw e;})()',
            { diagnostics: true },
        );
        assert.deepEqual(evaluated.payload.touched.layersAdded, [{ index: 1, name: 'C', id: 3 }]);
        assert.equal(evaluated.payload.touched.layersChanged.length, 1);
        assert.deepEqual(evaluated.payload.touched.layersChanged[0], {
            layer: { index: 3, name: 'B', id: 2 },
            changes: [{ field: 'transform.opacity', before: '100', after: '42' }],
        });
    });
});

test('diagnostic transport reports project item additions without layer changes', () => {
    const server = loadServer();
    const fakes = diagnosticSnapshotFakes();
    withDiagnosticGlobals(fakes.globals, function () {
        const evaluated = evaluateTransportEnvelope(
            server,
            'var added=new CompItem(52,"Added Comp",[]);'
                + '__diagnosticProject.items.push(added);app.project.activeItem=added;'
                + 'app.project.revision=12;'
                + '(function(){var e=new Error("boom");e.line=2;throw e;})()',
            { diagnostics: true },
        );
        assert.equal(evaluated.payload.touched.level, 'item_diff');
        assert.deepEqual(evaluated.payload.touched.itemsAdded, [{
            id: 52,
            name: 'Added Comp',
            type: 'Composition',
        }]);
        assert.deepEqual(evaluated.payload.touched.layersAdded, []);
        assert.deepEqual(evaluated.payload.touched.layersChanged, []);
        assert.deepEqual(evaluated.payload.touched.activeCompChanged, {
            from: { id: 41, name: 'Comp' },
            to: { id: 52, name: 'Added Comp' },
        });
    });
});

test('diagnostic transport fails open without an active comp or app', () => {
    const server = loadServer();
    const fakes = diagnosticSnapshotFakes();
    fakes.project.activeItem = null;
    withDiagnosticGlobals(fakes.globals, function () {
        const evaluated = evaluateTransportEnvelope(
            server,
            '(function(){var e=new Error("expected");e.line=4;throw e;})()',
            { diagnostics: true },
        );
        assert.equal(evaluated.payload.touched.level, 'none');
        assert.equal(evaluated.payload.touched.comp, null);
    });
    withDiagnosticGlobals({}, function () {
        const failed = evaluateTransportEnvelope(
            server,
            '(function(){var e=new Error("expected");e.line=2;throw e;})()',
            { diagnostics: true },
        );
        assert.equal(failed.payload.touched.level, 'none');
        assert.equal(failed.payload.touched.comp, null);
        const succeeded = evaluateTransportEnvelope(server, '6*7', { diagnostics: true });
        assert.equal(succeeded.payload.ok, true);
        assert.equal(succeeded.payload.result, '42');
    });
});

test('diagnostic transport limits active comp snapshots to 200 layers', () => {
    const server = loadServer();
    const fakes = diagnosticSnapshotFakes(250);
    withDiagnosticGlobals(fakes.globals, function () {
        const evaluated = evaluateTransportEnvelope(
            server,
            '__diagnosticComp.layer(201).property("ADBE Transform Group")'
                + '.property("ADBE Opacity").value=42;'
                + '(function(){var e=new Error("expected");e.line=4;throw e;})()',
            { diagnostics: true },
        );
        assert.equal(evaluated.payload.touched.level, 'none');
        assert.equal(evaluated.payload.touched.truncated, true);
        assert.deepEqual(evaluated.payload.touched.layersAdded, []);
        assert.deepEqual(evaluated.payload.touched.layersRemoved, []);
    });
});

test('diagnostic transport marks truncated writeln output', () => {
    const server = loadServer();
    const fakes = diagnosticSnapshotFakes();
    withDiagnosticGlobals(fakes.globals, function () {
        const evaluated = evaluateTransportEnvelope(
            server,
            'for(var i=0;i<250;i++){$.writeln("line "+i);}'
                + '(function(){var e=new Error("expected");e.line=2;throw e;})()',
            { diagnostics: true },
        );
        assert.equal(evaluated.payload.logs.length, 200);
        assert.equal(evaluated.outer.diag.logsTruncated, true);
        assert.equal(evaluated.payload.logsTruncated, true);
        assert.equal(evaluated.payload.touched.truncated, true);
    });
});

test('diagnostic transport restores writeln after repeated successful calls', () => {
    const server = loadServer();
    const fakes = diagnosticSnapshotFakes();
    const originalWriteln = fakes.globals.$.writeln;
    withDiagnosticGlobals(fakes.globals, function () {
        for (let index = 0; index < 20; index += 1) {
            const evaluated = evaluateTransportEnvelope(server, '"ok"', { diagnostics: true });
            assert.equal(evaluated.payload.ok, true);
            assert.equal(global.$.writeln, originalWriteln);
        }
    });
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

test('diagnostic decoder and executeJsx preserve optional success and failure evidence', async () => {
    const touched = {
        level: 'layer_diff',
        method: 'snapshot-diff',
        layersChanged: [{ layer: { id: 1 }, changes: [] }],
    };
    let invocation = 0;
    const fixture = await startApp({
        evalScript: function (jsx, callback) {
            assert.match(jsx, /__aemcp_snapshot/);
            invocation += 1;
            if (invocation === 1) {
                callback(JSON.stringify({
                    ok: true,
                    resultType: 'string',
                    result: 'done',
                    projectPath: 'C:/project.aep',
                    revision: { before: 1, after: 2 },
                    logs: ['hello'],
                    logsTruncated: true,
                }));
                return;
            }
            callback(JSON.stringify({
                ok: false,
                error: 'Error: bad (line 4)',
                line: 4,
                projectPath: 'C:/project.aep',
                revision: { before: 2, after: 3 },
                logs: ['before bad'],
                logsTruncated: true,
                touched,
            }));
        },
    });
    try {
        const successOutput = await fixture.server.executeJsx({
            code: '"done"', client: 'test', diagnostics: true,
        });
        assert.deepEqual(successOutput.payload, {
            ok: true,
            resultType: 'string',
            result: 'done',
            projectPath: 'C:/project.aep',
            revision: { before: 1, after: 2 },
            logs: ['hello'],
            logsTruncated: true,
        });
        const failedOutput = await fixture.server.executeJsx({
            code: 'throw new Error("bad")', client: 'test', diagnostics: true,
        });
        assert.equal(failedOutput.payload.disposition, 'failed');
        assert.equal(failedOutput.payload.errorLine, 4);
        assert.deepEqual(failedOutput.payload.touched, touched);
        assert.deepEqual(failedOutput.payload.logs, ['before bad']);
        assert.equal(failedOutput.payload.logsTruncated, true);
        assert.deepEqual(failedOutput.payload.revision, { before: 2, after: 3 });
        assert.equal(failedOutput.payload.projectPath, 'C:/project.aep');
    } finally {
        await closeFixture(fixture);
    }
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

test('/exec activity attributes direct HTTP failures and preserves bounded script evidence', async () => {
    const fixture = await startApp({
        evalScript: function (_jsx, callback) {
            callback('{"ok":false,"error":"Error: boom (line 1)"}');
        },
    });
    try {
        const code = 'var value = 1;\nthrow new Error("boom");';
        const response = await post(fixture.port, '/exec', { 'X-AE-MCP-Token': TOKEN }, { code });
        assert.equal(response.body.ok, false);
        const event = fixture.server.activity.list().find(function (item) { return item.ok === false; });
        assert.equal(event.client, 'http-direct');
        assert.equal(event.tool, 'exec-http');
        assert.equal(event.transport, 'http');
        assert.equal(event.scriptChars, code.length);
        assert.equal(event.scriptHead, 'var value = 1; throw new Error("boom");');
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
