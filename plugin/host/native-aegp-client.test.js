'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const {
    createNativeAegpClient,
    discoverNativeEndpoints,
    endpointDescriptor,
    parseAuthPending,
    parseAuthDecision,
} = require('./native-aegp-client');

const HOST = '22222222-2222-4222-8222-222222222222';
const SESSION = '11111111-1111-4111-8111-111111111111';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const SOURCE = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);

function descriptor(socketName) {
    return [
        'AEMCP_NATIVE_ENDPOINT_V1',
        'host=' + HOST,
        'pid=4242',
        'startSeconds=1700000000',
        'startMicros=123456',
        'socket=' + socketName,
        'wire=1',
        'source=' + SOURCE,
        '',
    ].join('\n');
}

function pendingMessage() {
    const result = Buffer.alloc(57);
    result.write('AEMCP-P1', 0, 'ascii');
    result.write('12AB-34CD', 8, 'ascii');
    result.writeUInt32BE(60000, 17);
    result.write(HOST, 21, 'ascii');
    return result;
}

function decisionMessage(code, sessionId, generation) {
    const result = Buffer.alloc(49);
    result.write('AEMCP-D1', 0, 'ascii');
    result[8] = code;
    result.write(sessionId || '00000000-0000-0000-0000-000000000000', 9, 'ascii');
    result.writeUInt32BE(generation || 0, 45);
    return result;
}

function frame(value) {
    const body = Buffer.from(JSON.stringify(value), 'utf8');
    const result = Buffer.alloc(body.length + 4);
    result.writeUInt32BE(body.length, 0);
    body.copy(result, 4);
    return result;
}

async function endpointFixture(t) {
    const temporaryRoot = process.platform === 'darwin' ? '/private/tmp' : os.tmpdir();
    const root = fs.realpathSync(fs.mkdtempSync(path.join(temporaryRoot, 'aemcp-native-client-')));
    fs.chmodSync(root, 0o700);
    const directory = path.join(root, 'aemcp-n1');
    fs.mkdirSync(directory, { mode: 0o700 });
    const socketName = 's-123456abcdef.sock';
    const socketPath = path.join(directory, socketName);
    const server = net.createServer();
    const openSockets = new Set();
    server.on('connection', function (socket) {
        openSockets.add(socket);
        socket.once('close', function () { openSockets.delete(socket); });
    });
    await new Promise(function (resolve, reject) {
        server.once('error', reject);
        server.listen(socketPath, resolve);
    });
    fs.chmodSync(socketPath, 0o600);
    const descriptorPath = path.join(directory, 'd-' + HOST + '.endpoint');
    fs.writeFileSync(descriptorPath, descriptor(socketName), { mode: 0o600 });
    fs.chmodSync(descriptorPath, 0o600);
    t.after(async function () {
        for (const socket of openSockets) socket.destroy();
        await new Promise(function (resolve) { server.close(resolve); });
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { root, server, socketPath };
}

function invokeRequestDigest(request) {
    const canonical = {
        deadlineUnixMs: request.deadlineUnixMs,
        kind: request.kind,
        method: request.method,
        params: {
            arguments: request.params.arguments,
            capabilityId: request.params.capabilityId,
            capabilityVersion: request.params.capabilityVersion,
        },
        requestId: request.requestId,
        sessionId: request.sessionId,
        wireVersion: request.wireVersion,
    };
    return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

function capabilitiesRequestDigest(request) {
    const canonical = {
        detail: request.params.detail || 'summary',
        ids: Object.hasOwn(request.params, 'ids') ? request.params.ids : null,
        limit: request.params.limit === undefined ? 50 : request.params.limit,
        sessionId: request.sessionId,
    };
    return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

function installProtocol(server, options) {
    const input = options || {};
    let authorize;
    const authorized = new Promise(function (resolve) { authorize = resolve; });
    const requests = [];
    server.on('connection', function (socket) {
        let bytes = Buffer.alloc(0);
        let authenticated = false;
        socket.on('data', function (chunk) {
            bytes = Buffer.concat([bytes, chunk]);
            if (!authenticated) {
                if (bytes.length < 24) return;
                assert.equal(bytes.subarray(0, 8).toString('ascii'), 'AEMCP-A1');
                assert.notDeepEqual(bytes.subarray(8, 24), Buffer.alloc(16));
                bytes = bytes.subarray(24);
                socket.write(pendingMessage());
                authorized.then(function () {
                    authenticated = true;
                    socket.write(decisionMessage(1, SESSION, 7));
                    consume();
                });
                return;
            }
            consume();
        });

        function consume() {
            while (authenticated && bytes.length >= 4) {
                const length = bytes.readUInt32BE(0);
                if (bytes.length < length + 4) return;
                const request = JSON.parse(bytes.toString('utf8', 4, length + 4));
                bytes = bytes.subarray(length + 4);
                requests.push(request);
                let result;
                if (request.method === 'hello') {
                    result = {
                        selectedWireVersion: 1,
                        pluginVersion: '0.1.0-dev',
                        compiledSdk: { version: '25.6.61', build: 61, architecture: 'arm64' },
                        host: {
                            application: 'after-effects', version: '26.3.0', build: 87,
                            platform: 'macos-arm64', instanceId: HOST,
                        },
                        sessionId: SESSION,
                        sessionGeneration: 7,
                        limits: { maxFrameBytes: 65536 },
                        capabilitiesDigest: DIGEST,
                        clientNonce: request.params.nonce,
                    };
                } else if (request.method === 'capabilities') {
                    result = {
                        detail: request.params.detail || 'summary',
                        capabilitiesDigest: DIGEST,
                        queryDigest: capabilitiesRequestDigest(request),
                        nextCursor: null,
                        items: [{
                            id: 'ae.project.summary',
                            version: 1,
                            detail: 'full',
                            contractDigest: 'd'.repeat(64),
                        }],
                    };
                } else {
                    result = {
                        capabilityId: 'ae.project.summary',
                        capabilityVersion: 1,
                        engine: 'native-aegp',
                        outcome: 'succeeded',
                        evidence: {
                            engine: 'native-aegp',
                            hostInstanceId: HOST,
                            sessionId: SESSION,
                            requestId: request.requestId,
                            capabilityId: 'ae.project.summary',
                            capabilityVersion: 1,
                            startedAtUnixMs: 1900000000000,
                            completedAtUnixMs: 1900000000001,
                            effect: 'none',
                            requestDigest: invokeRequestDigest(request),
                            postcondition: {
                                verified: true,
                                kind: 'project-summary',
                                algorithm: 'sha256-rfc8785-jcs-v1',
                                digest: '7b5277171cf2d6478d7c95bd99cf25765afac71f8f003c5bf7604f495d7eb4a2',
                            },
                        },
                        value: { projectOpen: true, projectName: 'Fixture.aep', itemCount: 3 },
                    };
                    if (input.mutateInvoke) input.mutateInvoke(result, request);
                }
                if (input.suppressHello && request.method === 'hello') continue;
                const responseError = request.method === 'invoke' ? input.invokeError : null;
                socket.write(frame({
                    wireVersion: 1,
                    kind: 'response',
                    sessionId: SESSION,
                    requestId: request.requestId,
                    method: request.method,
                    ok: responseError ? false : true,
                    replayed: false,
                    ...(responseError ? { error: responseError } : { result }),
                }));
            }
        }
    });
    return { authorize, requests };
}

test('descriptor and fixed transport messages are strict and closed', () => {
    assert.equal(endpointDescriptor(descriptor('s-123456abcdef.sock')).hostInstanceId, HOST);
    assert.equal(endpointDescriptor(descriptor('../escape.sock')), null);
    assert.equal(endpointDescriptor(descriptor('s-123456abcdef.sock') + 'extra=1\n'), null);
    assert.deepEqual(parseAuthPending(pendingMessage()), {
        fingerprint: '12AB-34CD', expiresInMs: 60000, hostInstanceId: HOST,
    });
    assert.deepEqual(parseAuthDecision(decisionMessage(1, SESSION, 7)), {
        code: 'authorized', sessionId: SESSION, sessionGeneration: 7,
    });
    assert.equal(parseAuthPending(Buffer.alloc(57)), null);
    assert.equal(parseAuthDecision(decisionMessage(1, SESSION, 0)), null);
});

test('discovery accepts only a private descriptor and socket owned by this user', {
    skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
}, async (t) => {
    const fixture = await endpointFixture(t);
    const endpoints = discoverNativeEndpoints({ runtimeRoot: fixture.root });
    assert.equal(endpoints.length, 1);
    assert.equal(endpoints[0].hostInstanceId, HOST);
    assert.equal(endpoints[0].sourceCommit, SOURCE);

    fs.chmodSync(path.join(fixture.root, 'aemcp-n1', 'd-' + HOST + '.endpoint'), 0o644);
    assert.deepEqual(discoverNativeEndpoints({ runtimeRoot: fixture.root }), []);
});

test('CEP client completes pairing, hello, capabilities, and verified native project summary', {
    skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
}, async (t) => {
    const fixture = await endpointFixture(t);
    const protocol = installProtocol(fixture.server);
    const deterministic = Buffer.from('00112233445566778899aabbccddeeff0011223344556677', 'hex');
    const client = createNativeAegpClient({
        runtime: { platform: 'darwin', arch: 'arm64' },
        runtimeRoot: fixture.root,
        clientInstanceId: CLIENT,
        randomBytes: function (size) {
            return Buffer.concat([deterministic, Buffer.alloc(size)]).subarray(0, size);
        },
        requestTimeoutMs: 2000,
        now: function () { return 1900000000000; },
    });
    t.after(function () { return client.close(); });

    const pending = await client.beginPairing();
    assert.deepEqual(pending, {
        fingerprint: '12AB-34CD',
        expiresInMs: 60000,
        hostInstanceId: HOST,
        sourceCommit: SOURCE,
    });
    assert.equal(client.status().state, 'pairing-decision');

    protocol.authorize();
    const hello = await client.waitUntilConnected();
    assert.equal(hello.host.instanceId, HOST);
    assert.equal(client.status().state, 'connected');
    const negotiation = await client.negotiate({ deadlineUnixMs: 1900000005000 });
    assert.equal(negotiation.sourceCommit, SOURCE);
    const capabilities = await client.capabilities({
        ids: null,
        detail: 'full',
        limit: 100,
        deadlineUnixMs: 1900000005000,
    });
    assert.equal(capabilities.items[0].id, 'ae.project.summary');
    const summary = await client.invoke({
        requestId: 'core-project-summary-1',
        capabilityId: 'ae.project.summary',
        capabilityVersion: 1,
        arguments: {},
        deadlineUnixMs: 1900000002000,
    });
    assert.deepEqual(summary.value, {
        projectOpen: true, projectName: 'Fixture.aep', itemCount: 3,
    });
    assert.equal(summary.engine, 'native-aegp');
    assert.equal(summary.evidence.postcondition.verified, true);
    assert.equal(client.status().projectSummaryContractDigest, 'd'.repeat(64));
    assert.deepEqual(protocol.requests.map(function (request) { return request.method; }), [
        'hello', 'capabilities', 'invoke',
    ]);
    assert.equal(Object.hasOwn(protocol.requests[1].params, 'ids'), false);
    assert.equal(protocol.requests[1].params.limit, 100);
    assert.equal(protocol.requests[2].requestId, 'core-project-summary-1');
    assert.equal(protocol.requests[2].deadlineUnixMs, 1900000002000);
    assert.equal(summary.evidence.requestDigest, invokeRequestDigest(protocol.requests[2]));
});

test('CEP client preserves the complete structured native error contract', {
    skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
}, async (t) => {
    const fixture = await endpointFixture(t);
    const protocol = installProtocol(fixture.server, {
        invokeError: {
            code: 'CAPABILITY_FAILED',
            message: 'project summary failed',
            retryable: false,
            sideEffect: 'not-started',
            recovery: { action: 'inspect-state', hint: 'Inspect the project state.' },
            details: { capabilityId: 'ae.project.summary' },
        },
    });
    const client = createNativeAegpClient({
        runtime: { platform: 'darwin', arch: 'arm64' },
        runtimeRoot: fixture.root,
        clientInstanceId: CLIENT,
        requestTimeoutMs: 2000,
        now: function () { return 1900000000000; },
    });
    t.after(function () { return client.close(); });
    await client.beginPairing();
    protocol.authorize();
    await client.waitUntilConnected();
    await client.capabilities({ detail: 'full', limit: 100 });
    await assert.rejects(
        client.invoke({
            requestId: 'core-project-summary-error',
            capabilityId: 'ae.project.summary',
            capabilityVersion: 1,
            arguments: {},
            deadlineUnixMs: 1900000002000,
        }),
        function (error) {
            assert.equal(error.code, 'CAPABILITY_FAILED');
            assert.equal(error.message, 'project summary failed');
            assert.equal(error.retryable, false);
            assert.equal(error.sideEffect, 'not-started');
            assert.deepEqual(error.recovery, {
                action: 'inspect-state', hint: 'Inspect the project state.',
            });
            assert.deepEqual(error.details, { capabilityId: 'ae.project.summary' });
            return true;
        },
    );
});

for (const errorFixture of [
    {
        name: 'keeps an actual native INVALID_REQUEST distinct',
        error: {
            code: 'INVALID_REQUEST',
            message: 'native request was invalid',
            retryable: false,
            sideEffect: 'not-started',
            recovery: { action: 'none', hint: 'Do not retry this request.' },
        },
        expectedCode: 'INVALID_REQUEST',
        expectedAction: 'none',
    },
    {
        name: 'labels a malformed native error as a broker contract mismatch',
        error: {
            code: 'INVALID_REQUEST',
            message: 'missing recovery fields',
            retryable: false,
            sideEffect: 'not-started',
        },
        expectedCode: 'NATIVE_CONTRACT_MISMATCH',
        expectedAction: 'refresh-capabilities',
    },
]) {
    test('CEP client ' + errorFixture.name, {
        skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
    }, async (t) => {
        const fixture = await endpointFixture(t);
        const protocol = installProtocol(fixture.server, { invokeError: errorFixture.error });
        const client = createNativeAegpClient({
            runtime: { platform: 'darwin', arch: 'arm64' },
            runtimeRoot: fixture.root,
            clientInstanceId: CLIENT,
            requestTimeoutMs: 2000,
            now: function () { return 1900000000000; },
        });
        t.after(function () { return client.close(); });
        await client.beginPairing();
        protocol.authorize();
        await client.waitUntilConnected();
        await client.capabilities({ detail: 'full', limit: 100 });
        await assert.rejects(
            client.invoke({
                requestId: 'core-error-classification',
                capabilityId: 'ae.project.summary',
                capabilityVersion: 1,
                arguments: {},
                deadlineUnixMs: 1900000002000,
            }),
            function (error) {
                assert.equal(error.code, errorFixture.expectedCode);
                assert.equal(error.retryable, false);
                assert.equal(error.sideEffect, 'not-started');
                assert.equal(error.recovery.action, errorFixture.expectedAction);
                return true;
            },
        );
    });
}

test('CEP client bounds an authenticating wait by the Core absolute deadline', {
    skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
}, async (t) => {
    const fixture = await endpointFixture(t);
    const protocol = installProtocol(fixture.server, { suppressHello: true });
    const client = createNativeAegpClient({
        runtime: { platform: 'darwin', arch: 'arm64' },
        runtimeRoot: fixture.root,
        clientInstanceId: CLIENT,
        requestTimeoutMs: 2000,
    });
    t.after(function () { return client.close(); });
    await client.beginPairing();
    protocol.authorize();
    while (!protocol.requests.some(function (request) { return request.method === 'hello'; })) {
        await new Promise(function (resolve) { setImmediate(resolve); });
    }
    assert.equal(client.status().state, 'authenticating');
    await assert.rejects(
        client.negotiate({ deadlineUnixMs: Date.now() + 40 }),
        { code: 'DEADLINE_EXCEEDED', retryable: true },
    );
    assert.equal(client.status().state, 'authenticating');
});

test('CEP client bounds the initial pairing challenge by the Core absolute deadline', {
    skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
}, async (t) => {
    const fixture = await endpointFixture(t);
    const client = createNativeAegpClient({
        runtime: { platform: 'darwin', arch: 'arm64' },
        runtimeRoot: fixture.root,
        clientInstanceId: CLIENT,
        requestTimeoutMs: 2000,
    });
    t.after(function () { return client.close(); });
    await assert.rejects(
        client.beginPairing(Date.now() + 40),
        { code: 'DEADLINE_EXCEEDED', retryable: true },
    );
    assert.equal(client.status().state, 'pairing-pending');
});

for (const fixture of [
    {
        name: 'request digest',
        mutate: function (result) { result.evidence.requestDigest = '0'.repeat(64); },
    },
    {
        name: 'postcondition value',
        mutate: function (result) { result.value.itemCount += 1; },
    },
]) {
    test('client rejects tampered native ' + fixture.name + ' evidence', {
        skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
    }, async (t) => {
        const endpoint = await endpointFixture(t);
        const protocol = installProtocol(endpoint.server, { mutateInvoke: fixture.mutate });
        const client = createNativeAegpClient({
            runtime: { platform: 'darwin', arch: 'arm64' },
            runtimeRoot: endpoint.root,
            clientInstanceId: CLIENT,
            requestTimeoutMs: 2000,
            now: function () { return 1900000000000; },
        });
        t.after(function () { return client.close(); });
        await client.beginPairing();
        protocol.authorize();
        await client.waitUntilConnected();
        await client.capabilities();
        await assert.rejects(client.projectSummary(), function (error) {
            assert.equal(error.code, 'NATIVE_CONTRACT_MISMATCH');
            assert.equal(error.retryable, false);
            assert.equal(error.sideEffect, 'not-started');
            assert.deepEqual(error.recovery, {
                action: 'refresh-capabilities',
                hint: 'Refresh the authenticated native contract before retrying.',
            });
            return true;
        });
    });
}

test('client does not bypass explicit pairing rejection', {
    skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
}, async (t) => {
    const fixture = await endpointFixture(t);
    let rejectPairing;
    fixture.server.on('connection', function (socket) {
        socket.once('data', function () {
            socket.write(pendingMessage());
            rejectPairing = function () { socket.write(decisionMessage(2)); };
        });
    });
    const client = createNativeAegpClient({
        runtime: { platform: 'darwin', arch: 'arm64' },
        runtimeRoot: fixture.root,
        clientInstanceId: CLIENT,
    });
    t.after(function () { return client.close(); });
    await client.beginPairing();
    rejectPairing();
    await assert.rejects(client.waitUntilConnected(), { code: 'AUTH_REQUIRED', retryable: false });
});

test('closing after the pairing response does not create an unhandled connected rejection', {
    skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
}, async (t) => {
    const fixture = await endpointFixture(t);
    fixture.server.on('connection', function (socket) {
        socket.once('data', function () { socket.write(pendingMessage()); });
    });
    const client = createNativeAegpClient({
        runtime: { platform: 'darwin', arch: 'arm64' },
        runtimeRoot: fixture.root,
        clientInstanceId: CLIENT,
    });
    const unhandled = [];
    const capture = function (reason) { unhandled.push(reason); };
    process.on('unhandledRejection', capture);
    t.after(function () { process.off('unhandledRejection', capture); });

    await client.beginPairing();
    await client.close();
    await new Promise(function (resolve) { setImmediate(resolve); });
    assert.deepEqual(unhandled, []);
});

test('late events from a failed socket cannot tear down its replacement', async () => {
    class FakeSocket extends EventEmitter {
        write(bytes, callback) { if (callback) callback(); return bytes.length > 0; }
        destroy() { this.destroyed = true; }
    }
    const sockets = [];
    const client = createNativeAegpClient({
        runtime: { platform: 'darwin', arch: 'arm64' },
        clientInstanceId: CLIENT,
        discoverEndpoints: function () {
            return [{
                hostInstanceId: HOST,
                sourceCommit: SOURCE,
                socketPath: '/synthetic/aemcp.sock',
            }];
        },
        netImpl: {
            createConnection: function () {
                const socket = new FakeSocket();
                sockets.push(socket);
                return socket;
            },
        },
    });

    const first = client.beginPairing();
    sockets[0].emit('error', Object.assign(new Error('first failed'), { code: 'ECONNRESET' }));
    await assert.rejects(first, { code: 'NATIVE_UNAVAILABLE', retryable: true });

    const second = client.beginPairing();
    sockets[0].emit('data', Buffer.alloc(100));
    sockets[0].emit('close');
    assert.equal(client.status().state, 'pairing-pending');
    sockets[1].emit('connect');
    sockets[1].emit('data', pendingMessage());
    assert.equal((await second).fingerprint, '12AB-34CD');
    assert.equal(client.status().state, 'pairing-decision');
    await client.close();
});
