'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    createNativeAegpClient,
    discoverNativeEndpoints,
    discoverWindowsEndpoints,
    endpointDescriptor,
    parseAuthChallenge,
    parseAuthDecision,
    validNativeProgramArguments,
} = require('./native-aegp-client');

const PRIMITIVE_IDS = require(
    '../../native/ae-plugin/protocol/native-primitives.json'
).primitives.map((primitive) => primitive.id);

const FULL_REGISTRY = require(
    '../../native/ae-plugin/protocol/fixtures/capability-registry-full.json'
);
const SUMMARY_ITEM = require(
    '../../native/ae-plugin/protocol/fixtures/capabilities.json'
).response.result.items[0];

const HOST = '22222222-2222-4222-8222-222222222222';
const SESSION = '11111111-1111-4111-8111-111111111111';
const PROJECT = '44444444-4444-4444-8444-444444444444';
const COMPOSITION = '55555555-5555-4555-8555-555555555555';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const SOURCE = 'a'.repeat(40);
const DIGEST = FULL_REGISTRY.capabilitiesDigest;

function unixSocketTestOptions(platform) {
    return platform === 'win32'
        ? { skip: 'requires Unix-domain socket filesystem semantics' }
        : {};
}

const UNIX_SOCKET_TEST = unixSocketTestOptions(process.platform);

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

function challengeMessage() {
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

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
        return Object.keys(value).sort().reduce(function (result, key) {
            result[key] = canonicalize(value[key]);
            return result;
        }, {});
    }
    return value;
}

function digest(value) {
    return crypto.createHash('sha256')
        .update(JSON.stringify(canonicalize(value)), 'utf8')
        .digest('hex');
}

function capabilitiesRequestDigest(request) {
    return digest({
        detail: request.params.detail || 'summary',
        ids: Object.hasOwn(request.params, 'ids') ? request.params.ids : null,
        limit: request.params.limit === undefined ? 50 : request.params.limit,
        sessionId: request.sessionId,
    });
}

function requestDigest(request) {
    return digest(request);
}

function postconditionDigest(operations, outputs) {
    return digest({ operations, outputs });
}

function compositionLocator() {
    return {
        kind: 'composition',
        hostInstanceId: HOST,
        sessionId: SESSION,
        projectId: PROJECT,
        generation: 1,
        objectId: COMPOSITION,
    };
}

function readProgram() {
    return {
        operations: [{
            op: 'project.items.list',
            args: { offset: 0, limit: 1 },
            returnAs: 'items',
        }],
    };
}

function writeProgram() {
    return {
        operationKey: 'native-program-write-0001',
        undoGroup: 'Native program write',
        operations: [
            {
                op: 'composition.resolve',
                args: { locator: compositionLocator() },
                saveAs: 'composition',
            },
            {
                op: 'composition.time.set',
                args: {
                    composition: { ref: 'composition' },
                    targetTime: { value: 24, scale: 24 },
                },
                returnAs: 'updated',
            },
        ],
    };
}

async function endpointFixture(t) {
    const temporaryRoot = process.platform === 'darwin' ? '/private/tmp' : os.tmpdir();
    const root = fs.realpathSync(fs.mkdtempSync(path.join(
        temporaryRoot,
        'aemcp-native-client-',
    )));
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

function installProtocol(server, options) {
    const input = options || {};
    const requests = [];
    server.on('connection', function (socket) {
        let bytes = Buffer.alloc(0);
        let authenticated = false;
        socket.on('data', function (chunk) {
            bytes = Buffer.concat([bytes, chunk]);
            if (!authenticated) {
                if (bytes.length < 24) return;
                assert.equal(bytes.subarray(0, 8).toString('ascii'), 'AEMCP-A1');
                bytes = bytes.subarray(24);
                socket.write(Buffer.concat([
                    challengeMessage(),
                    decisionMessage(1, SESSION, 7),
                ]));
                authenticated = true;
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
                if (input.suppressHello && request.method === 'hello') continue;
                if (input.disconnectInvoke && request.method === 'invoke') {
                    socket.destroy();
                    continue;
                }
                let result;
                let error = null;
                if (request.method === 'hello') {
                    result = {
                        selectedWireVersion: 1,
                        pluginVersion: '0.1.0-dev',
                        compiledSdk: {
                            version: '25.6.61',
                            build: 61,
                            architecture: 'arm64',
                        },
                        host: {
                            application: 'after-effects',
                            version: '26.3.0',
                            build: 87,
                            platform: 'macos-arm64',
                            instanceId: HOST,
                        },
                        sessionId: SESSION,
                        sessionGeneration: 7,
                        limits: { maxFrameBytes: 524288 },
                        capabilitiesDigest: DIGEST,
                        clientNonce: request.params.nonce,
                    };
                } else if (request.method === 'capabilities') {
                    const source = request.params.detail === 'full'
                        ? FULL_REGISTRY.items[0] : SUMMARY_ITEM;
                    const items = request.params.ids === undefined
                        || request.params.ids.includes('ae.native.exec')
                        ? [structuredClone(source)] : [];
                    if (input.appendLegacyDescriptor) {
                        items.push({
                            ...structuredClone(SUMMARY_ITEM),
                            id: 'ae.project.summary',
                        });
                    }
                    result = {
                        detail: request.params.detail || 'summary',
                        items,
                        nextCursor: null,
                        queryDigest: capabilitiesRequestDigest(request),
                        capabilitiesDigest: DIGEST,
                    };
                } else if (request.method === 'invalidateGraph') {
                    result = input.invalidateResult || {
                        generation: 8,
                        invalidated: true,
                    };
                } else if (request.method === 'cancel') {
                    result = input.cancelResult || {
                        targetRequestId: request.params.targetRequestId,
                        state: 'running-not-cancellable',
                        terminalResponseExpected: true,
                    };
                } else if (request.method === 'invoke') {
                    if (input.invokeError) {
                        error = typeof input.invokeError === 'function'
                            ? input.invokeError(request) : input.invokeError;
                    } else {
                        const mutating = Object.hasOwn(
                            request.params.arguments,
                            'operationKey',
                        );
                        const operations = request.params.arguments.operations.map(
                            function (operation, index) {
                                return { index, op: operation.op, status: 'completed' };
                            },
                        );
                        const outputs = { result: { value: 12, scale: 24 } };
                        result = {
                            capabilityId: 'ae.native.exec',
                            ...(mutating ? {
                                operationKey: request.params.arguments.operationKey,
                            } : {}),
                            outputs,
                            operations,
                            evidence: {
                                engine: 'native-aegp',
                                hostInstanceId: HOST,
                                sessionId: SESSION,
                                requestId: request.requestId,
                                capabilityId: 'ae.native.exec',
                                capabilityVersion: 1,
                                startedAtUnixMs: 1900000000000,
                                completedAtUnixMs: 1900000000001,
                                effect: mutating ? 'committed' : 'none',
                                requestDigest: requestDigest(request),
                                postcondition: {
                                    verified: true,
                                    kind: 'native-program',
                                    algorithm: 'sha256-rfc8785-jcs-v1',
                                    digest: postconditionDigest(operations, outputs),
                                },
                            },
                            undo: mutating ? {
                                available: true,
                                verified: false,
                                groupLabel: request.params.arguments.undoGroup,
                            } : {
                                available: false,
                                verified: false,
                            },
                        };
                        if (input.mutateInvokeResult) {
                            input.mutateInvokeResult(result, request);
                        }
                    }
                } else {
                    throw new Error('unexpected test protocol method: ' + request.method);
                }
                if (input.emitProgress && request.method === 'invoke') {
                    socket.write(frame({
                        wireVersion: 1,
                        kind: 'event',
                        sessionId: SESSION,
                        requestId: request.requestId,
                        event: 'progress',
                        sequence: 1,
                        progress: {
                            phase: 'queued',
                            fraction: 0,
                            message: 'Queued for the AE main thread.',
                        },
                    }));
                }
                const response = {
                    wireVersion: 1,
                    kind: 'response',
                    sessionId: SESSION,
                    requestId: request.requestId,
                    method: request.method,
                    ok: error === null,
                    replayed: false,
                    ...(error === null ? { result } : { error }),
                };
                if (input.mutateEnvelope) input.mutateEnvelope(response, request);
                socket.write(frame(response));
            }
        }
    });
    return requests;
}

function makeClient(root, options) {
    return createNativeAegpClient({
        runtime: { platform: 'darwin', arch: 'arm64' },
        runtimeRoot: root,
        clientInstanceId: CLIENT,
        requestTimeoutMs: options?.requestTimeoutMs || 1000,
    });
}

async function connectedFixture(t, options) {
    const fixture = await endpointFixture(t);
    const requests = installProtocol(fixture.server, options);
    const client = makeClient(fixture.root, options);
    await client.connect(Date.now() + 5000);
    t.after(function () { return client.close(); });
    return { client, requests };
}

function invoke(client, requestId, argumentsValue) {
    return client.invoke({
        requestId,
        capabilityId: 'ae.native.exec',
        capabilityVersion: 1,
        arguments: argumentsValue,
        deadlineUnixMs: Date.now() + 5000,
    });
}

function safeWriteFailure(request) {
    const completedOperations = [{
        index: 0,
        op: request.params.arguments.operations[0].op,
        status: 'completed',
    }];
    const outputs = {};
    return {
        code: 'PRECONDITION_FAILED',
        message: 'write adapter rejected before mutation',
        retryable: false,
        sideEffect: 'completed',
        recovery: {
            action: 'inspect-state',
            hint: 'Inspect the completed native program operations.',
        },
        details: {
            capabilityId: 'ae.native.exec',
            operationKey: request.params.arguments.operationKey,
            disposition: 'completed',
            completedOperations,
            failedOperation: {
                index: 1,
                op: request.params.arguments.operations[1].op,
                status: 'failed',
            },
            outputs,
            evidence: {
                engine: 'native-aegp',
                hostInstanceId: HOST,
                sessionId: SESSION,
                requestId: request.requestId,
                capabilityId: 'ae.native.exec',
                capabilityVersion: 1,
                startedAtUnixMs: 1900000000000,
                completedAtUnixMs: 1900000000001,
                effect: 'none',
                requestDigest: requestDigest(request),
                postcondition: {
                    verified: false,
                    kind: 'native-program',
                    algorithm: 'sha256-rfc8785-jcs-v1',
                    digest: postconditionDigest(completedOperations, outputs),
                },
            },
            undo: {
                available: true,
                verified: false,
                groupLabel: request.params.arguments.undoGroup,
            },
        },
    };
}

test('descriptor and fixed transport messages are strict and closed', () => {
    assert.deepEqual(unixSocketTestOptions('win32'), {
        skip: 'requires Unix-domain socket filesystem semantics',
    });
    assert.deepEqual(unixSocketTestOptions('darwin'), {});
    assert.deepEqual(endpointDescriptor(descriptor('s-123456abcdef.sock')), {
        hostInstanceId: HOST,
        pid: 4242,
        startSeconds: 1700000000,
        startMicros: 123456,
        socketName: 's-123456abcdef.sock',
        wireVersion: 1,
        sourceCommit: SOURCE,
    });
    assert.equal(endpointDescriptor(descriptor('s-123456abcdef.sock') + 'extra=x\n'), null);
    assert.equal(parseAuthChallenge(challengeMessage()).hostInstanceId, HOST);
    assert.deepEqual(parseAuthDecision(decisionMessage(1, SESSION, 7)), {
        code: 'authorized',
        sessionId: SESSION,
        sessionGeneration: 7,
    });
});

test('discovery accepts the private descriptor and socket owned by this user', UNIX_SOCKET_TEST, async (t) => {
    const fixture = await endpointFixture(t);
    assert.deepEqual(discoverNativeEndpoints({ runtimeRoot: fixture.root }), [{
        descriptorPath: path.join(
            fixture.root,
            'aemcp-n1',
            'd-' + HOST + '.endpoint',
        ),
        socketPath: fixture.socketPath,
        hostInstanceId: HOST,
        pid: 4242,
        startSeconds: 1700000000,
        startMicros: 123456,
        socketName: 's-123456abcdef.sock',
        wireVersion: 1,
        sourceCommit: SOURCE,
    }]);
});

// Issue #86: Windows endpoint discovery reads the same descriptor format
// from %LOCALAPPDATA%\AfterEffectsMCP\aemcp-n1 and returns the full named
// pipe path. No uid/mode checks apply — the per-user profile and the
// same-user pipe ACL are the boundary (#88 NOT_PLANNED).
const PIPE = '\\\\.\\pipe\\aemcp-n1-123456abcdef';

async function windowsEndpointFixture(t, options) {
    const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'ae-mcp-win-endpoint-'),
    );
    t.after(() => fs.promises.rm(root, { force: true, recursive: true }));
    const directory = path.join(root, 'aemcp-n1');
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(
        path.join(directory, 'd-' + HOST + '.endpoint'),
        descriptor(PIPE),
    );
    for (const stale of options?.stale || []) {
        await fs.promises.writeFile(path.join(directory, stale.name), stale.text);
    }
    return { root, directory };
}

test('windows discovery parses the pipe descriptor and ignores stale names', async (t) => {
    const fixture = await windowsEndpointFixture(t, {
        stale: [
            // Wrong host instance id in the file name.
            { name: 'd-99999999-9999-4999-8999-999999999999.endpoint', text: descriptor(PIPE) },
            // Unparseable descriptor.
            { name: 'd-88888888-8888-4888-8888-888888888888.endpoint', text: 'garbage\n' },
            // Not an endpoint file at all.
            { name: 'notes.txt', text: descriptor(PIPE) },
        ],
    });
    assert.deepEqual(discoverWindowsEndpoints({ runtimeRoot: fixture.root }), [{
        descriptorPath: path.join(fixture.directory, 'd-' + HOST + '.endpoint'),
        socketPath: PIPE,
        pipePath: PIPE,
        hostInstanceId: HOST,
        pid: 4242,
        startSeconds: 1700000000,
        startMicros: 123456,
        socketName: PIPE,
        wireVersion: 1,
        sourceCommit: SOURCE,
    }]);
});

test('windows discovery rejects socket values that are not aemcp pipes', async (t) => {
    const fixture = await windowsEndpointFixture(t, {
        stale: [],
    });
    await fs.promises.writeFile(
        path.join(fixture.directory, 'd-' + HOST + '.endpoint'),
        descriptor('\\\\.\\pipe\\other-prefix-123456abcdef'),
    );
    assert.deepEqual(discoverWindowsEndpoints({ runtimeRoot: fixture.root }), []);
    await fs.promises.writeFile(
        path.join(fixture.directory, 'd-' + HOST + '.endpoint'),
        descriptor('s-123456abcdef.sock'),
    );
    assert.deepEqual(discoverWindowsEndpoints({ runtimeRoot: fixture.root }), []);
});

test('client factory accepts windows x64 and still rejects unsupported runtimes', () => {
    assert.equal(typeof createNativeAegpClient({
        runtime: { platform: 'win32', arch: 'x64' },
        runtimeRoot: os.tmpdir(),
        clientInstanceId: CLIENT,
    }), 'object');
    assert.throws(() => createNativeAegpClient({
        runtime: { platform: 'linux', arch: 'x64' },
        runtimeRoot: os.tmpdir(),
        clientInstanceId: CLIENT,
    }), /supports macOS arm64 and Windows x64 only/u);
});

test('invoke validation accepts every generated primitive id including camelCase ops', () => {
    // Regression for the OP_PATTERN lowercase-segment bug that rejected
    // composition.selectedLayers.list, composition.frameRate.set,
    // composition.pixelAspectRatio.set, composition.displayStartTime.set,
    // and property.keyframe.temporalEase.set before dispatch.
    assert.ok(PRIMITIVE_IDS.length >= 23, 'primitive registry fixture is loaded');
    for (const op of PRIMITIVE_IDS) {
        const valid = validNativeProgramArguments({
            operations: [{ op, args: {} }],
        });
        assert.equal(valid, true, `generated op rejected by invoke validation: ${op}`);
    }
    assert.equal(validNativeProgramArguments({
        operations: [
            { op: 'composition.resolve', args: {}, saveAs: 'comp' },
            { op: 'composition.selectedLayers.list', args: { composition: { ref: 'comp' } } },
        ],
    }), true);
});

test('client negotiates and validates the sole native program descriptor', UNIX_SOCKET_TEST, async (t) => {
    const { client } = await connectedFixture(t);
    const result = await client.capabilities({ detail: 'full', limit: 100 });
    assert.deepEqual(result.items.map(function (item) { return item.id; }), [
        'ae.native.exec',
    ]);
    assert.equal(result.items[0].primitiveCount, 23);
    assert.equal(result.items[0].requiredSkill, 'builtin:skill:ae-execution-guide');
    assert.equal(client.status().nativeExecContractDigest, result.items[0].contractDigest);
});

test('client rejects a capability page that reintroduces a legacy invoke descriptor', UNIX_SOCKET_TEST, async (t) => {
    const { client } = await connectedFixture(t, { appendLegacyDescriptor: true });
    await assert.rejects(
        client.capabilities({ detail: 'summary', limit: 100 }),
        function (error) {
            return error.code === 'NATIVE_CONTRACT_MISMATCH';
        },
    );
});

test('client sends and verifies one read-only native program', UNIX_SOCKET_TEST, async (t) => {
    const { client, requests } = await connectedFixture(t);
    const result = await invoke(client, 'native-program-read-0001', readProgram());
    assert.equal(result.capabilityId, 'ae.native.exec');
    assert.equal(result.operationKey, undefined);
    assert.deepEqual(result.undo, { available: false, verified: false });
    const request = requests.find(function (entry) {
        return entry.requestId === 'native-program-read-0001';
    });
    assert.equal(request.method, 'invoke');
    assert.deepEqual(request.params, {
        capabilityId: 'ae.native.exec',
        capabilityVersion: 1,
        arguments: readProgram(),
    });
});

test('client accepts associated progress before the native terminal', UNIX_SOCKET_TEST, async (t) => {
    const { client } = await connectedFixture(t, { emitProgress: true });
    const result = await invoke(client, 'request-progress-12345678', readProgram());
    assert.equal(result.operations.length, 1);
    assert.deepEqual(result.outputs.result, { value: 12, scale: 24 });
});

test('client preserves write identity and one common Undo terminal', UNIX_SOCKET_TEST, async (t) => {
    const { client } = await connectedFixture(t);
    const program = writeProgram();
    const result = await invoke(client, 'native-program-write-0001', program);
    assert.equal(result.operationKey, program.operationKey);
    assert.deepEqual(result.undo, {
        available: true,
        verified: false,
        groupLabel: program.undoGroup,
    });
    assert.equal(result.evidence.effect, 'committed');
});

test('client rejects operation-specific invoke IDs before native dispatch', UNIX_SOCKET_TEST, async (t) => {
    const { client, requests } = await connectedFixture(t);
    await assert.rejects(client.invoke({
        requestId: 'legacy-project-summary',
        capabilityId: 'ae.project.summary',
        capabilityVersion: 1,
        arguments: {},
        deadlineUnixMs: Date.now() + 5000,
    }), function (error) {
        return error.code === 'INVALID_ARGUMENT'
            && error.sideEffect === undefined;
    });
    assert.equal(requests.some(function (request) {
        return request.requestId === 'legacy-project-summary';
    }), false);
});

test('client preserves a request-bound completed write failure', UNIX_SOCKET_TEST, async (t) => {
    const { client } = await connectedFixture(t, {
        invokeError: safeWriteFailure,
    });
    await assert.rejects(
        invoke(client, 'native-program-safe-failure', writeProgram()),
        function (error) {
            return error.code === 'PRECONDITION_FAILED'
                && error.sideEffect === 'completed'
                && error.details.operationKey === 'native-program-write-0001'
                && error.details.undo.available === true
                && error.details.undo.verified === false;
        },
    );
});

test('client classifies an open write terminal as possibly side-effecting', UNIX_SOCKET_TEST, async (t) => {
    const { client } = await connectedFixture(t, {
        mutateInvokeResult: function (result) {
            delete result.undo;
        },
    });
    await assert.rejects(
        invoke(client, 'native-program-open-terminal', writeProgram()),
        function (error) {
            return error.code === 'POSSIBLY_SIDE_EFFECTING_FAILURE'
                && error.sideEffect === 'may-have-occurred'
                && error.details.operationKey === 'native-program-write-0001';
        },
    );
});

test('client keeps a disconnected dispatched write possibly side-effecting', UNIX_SOCKET_TEST, async (t) => {
    const { client } = await connectedFixture(t, { disconnectInvoke: true });
    await assert.rejects(
        invoke(client, 'native-program-disconnected', writeProgram()),
        function (error) {
            return error.code === 'POSSIBLY_SIDE_EFFECTING_FAILURE'
                && error.details.operationKey === 'native-program-write-0001';
        },
    );
});

test('client sends the closed project-graph invalidation control request', UNIX_SOCKET_TEST, async (t) => {
    const { client, requests } = await connectedFixture(t);
    assert.deepEqual(await client.invalidateProjectGraph({
        deadlineUnixMs: Date.now() + 5000,
    }), {
        generation: 8,
        invalidated: true,
    });
    const request = requests.find(function (entry) {
        return entry.method === 'invalidateGraph';
    });
    assert.deepEqual(request.params, { reason: 'cep-jsx' });
});

test('client binds native cancellation to one request identity and session', UNIX_SOCKET_TEST, async (t) => {
    const { client, requests } = await connectedFixture(t);
    const result = await client.cancel({
        requestId: 'cancel-control-0001',
        targetRequestId: 'native-program-target-0001',
        deadlineUnixMs: Date.now() + 5000,
    });
    assert.deepEqual(result, {
        targetRequestId: 'native-program-target-0001',
        state: 'running-not-cancellable',
        terminalResponseExpected: true,
    });
    const request = requests.find(function (entry) {
        return entry.requestId === 'cancel-control-0001';
    });
    assert.equal(request.method, 'cancel');
    assert.equal(request.sessionId, SESSION);
    assert.deepEqual(request.params, {
        targetRequestId: 'native-program-target-0001',
    });
});

test('client rejects an open project-graph invalidation result', UNIX_SOCKET_TEST, async (t) => {
    const { client } = await connectedFixture(t, {
        invalidateResult: {
            generation: 8,
            invalidated: true,
            legacyCapabilityId: 'ae.project.summary',
        },
    });
    await assert.rejects(
        client.invalidateProjectGraph({ deadlineUnixMs: Date.now() + 5000 }),
        function (error) {
            return error.code === 'NATIVE_CONTRACT_MISMATCH';
        },
    );
});

test('client rejects a response rebound to another native session', UNIX_SOCKET_TEST, async (t) => {
    const { client } = await connectedFixture(t, {
        mutateEnvelope: function (response, request) {
            if (request.method === 'invoke') {
                response.sessionId = '99999999-9999-4999-8999-999999999999';
            }
        },
    });
    await assert.rejects(
        invoke(client, 'native-program-wrong-session', readProgram()),
        function (error) {
            return error.code === 'NATIVE_CONTRACT_MISMATCH';
        },
    );
});

test('client surfaces a duplicate request id as a typed error, not a contract mismatch', UNIX_SOCKET_TEST, async (t) => {
    const { client } = await connectedFixture(t);
    const first = await invoke(client, 'native-program-dup-0001', readProgram());
    assert.equal(first.ok ?? first.result?.ok ?? true, true);
    // The duplicate carries no native-program failure details; it must pass
    // through as the typed DUPLICATE_REQUEST error instead of tripping the
    // program-failure validator.
    await assert.rejects(
        invoke(client, 'native-program-dup-0001', readProgram()),
        function (error) {
            return error.code === 'DUPLICATE_REQUEST';
        },
    );
});

test('client bounds an authenticating wait by the absolute deadline', UNIX_SOCKET_TEST, async (t) => {
    const fixture = await endpointFixture(t);
    installProtocol(fixture.server, { suppressHello: true });
    const client = makeClient(fixture.root, { requestTimeoutMs: 200 });
    await assert.rejects(
        client.connect(Date.now() + 120),
        function (error) {
            return error.code === 'DEADLINE_EXCEEDED';
        },
    );
    await client.close();
});
