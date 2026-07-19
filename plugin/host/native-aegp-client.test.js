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
const projectCompositionContracts = require('./native-project-composition-contract');

const CAPABILITIES_VECTOR = JSON.parse(fs.readFileSync(path.join(
    __dirname,
    '../../native/ae-plugin/protocol/fixtures/capabilities.json',
), 'utf8')).response.result;
const PROJECT_ITEMS_VECTOR = JSON.parse(fs.readFileSync(path.join(
    __dirname,
    '../../native/ae-plugin/protocol/fixtures/invoke-project-items-list.json',
), 'utf8'));
const COMPOSITION_LAYERS_VECTOR = JSON.parse(fs.readFileSync(path.join(
    __dirname,
    '../../native/ae-plugin/protocol/fixtures/invoke-composition-layers-list.json',
), 'utf8'));
const COMPOSITION_SELECTED_LAYERS_VECTOR = JSON.parse(fs.readFileSync(path.join(
    __dirname,
    '../../native/ae-plugin/protocol/fixtures/invoke-composition-selected-layers-list.json',
), 'utf8'));
const COMPOSITION_TIME_VECTOR = JSON.parse(fs.readFileSync(path.join(
    __dirname,
    '../../native/ae-plugin/protocol/fixtures/invoke-composition-time-read.json',
), 'utf8'));
const COMPOSITION_TIME_SET_VECTOR = JSON.parse(fs.readFileSync(path.join(
    __dirname,
    '../../native/ae-plugin/protocol/fixtures/invoke-composition-time-set.json',
), 'utf8'));
const COMPOSITION_CREATE_VECTOR = JSON.parse(fs.readFileSync(path.join(
    __dirname,
    '../../native/ae-plugin/protocol/fixtures/invoke-composition-create.json',
), 'utf8'));
const COMPOSITION_LAYER_CREATE_VECTOR = JSON.parse(fs.readFileSync(path.join(
    __dirname,
    '../../native/ae-plugin/protocol/fixtures/invoke-composition-layer-create.json',
), 'utf8'));
const LAYER_EFFECT_APPLY_VECTOR = JSON.parse(fs.readFileSync(path.join(
    __dirname,
    '../../native/ae-plugin/protocol/fixtures/invoke-layer-effect-apply.json',
), 'utf8'));
const LAYER_PROPERTIES_VECTOR = JSON.parse(fs.readFileSync(path.join(
    __dirname,
    '../../native/ae-plugin/protocol/fixtures/invoke-layer-properties-list.json',
), 'utf8'));
const LAYER_PROPERTY_KEYFRAMES_VECTOR = JSON.parse(fs.readFileSync(path.join(
    __dirname,
    '../../native/ae-plugin/protocol/fixtures/invoke-layer-property-keyframes-list.json',
), 'utf8'));
const LAYER_PROPERTY_SET_VECTOR = JSON.parse(fs.readFileSync(path.join(
    __dirname,
    '../../native/ae-plugin/protocol/fixtures/invoke-layer-property-set.json',
), 'utf8'));
const PROJECT_COMPOSITION_VECTOR_FILES = [
    'invoke-project-context-read.json',
    'invoke-project-item-metadata-read.json',
    'invoke-composition-settings-read.json',
    'invoke-composition-work-area-set.json',
    'invoke-project-item-name-set.json',
    'invoke-project-item-comment-set.json',
    'invoke-project-item-label-set.json',
    'invoke-composition-duplicate.json',
    'invoke-layer-details-read.json',
    'invoke-layer-name-set.json',
    'invoke-layer-range-set.json',
    'invoke-layer-start-time-set.json',
    'invoke-layer-stretch-set.json',
    'invoke-layer-order-set.json',
    'invoke-layer-parent-set.json',
    'invoke-layer-duplicate.json',
];
const PROJECT_COMPOSITION_VECTORS = new Map(PROJECT_COMPOSITION_VECTOR_FILES.map(function (name) {
    const vector = JSON.parse(fs.readFileSync(path.join(
        __dirname,
        '../../native/ae-plugin/protocol/fixtures',
        name,
    ), 'utf8'));
    return [vector.request.params.capabilityId, vector];
}));
const HOST = '22222222-2222-4222-8222-222222222222';
const SESSION = '11111111-1111-4111-8111-111111111111';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const SOURCE = 'a'.repeat(40);
const DIGEST = CAPABILITIES_VECTOR.capabilitiesDigest;
const BIT_DEPTH_READ_DIGEST = CAPABILITIES_VECTOR.items.find(function (item) {
    return item.id === 'ae.project.bit-depth.read';
}).contractDigest;
const BIT_DEPTH_SET_DIGEST = CAPABILITIES_VECTOR.items.find(function (item) {
    return item.id === 'ae.project.bit-depth.set';
}).contractDigest;

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
    return jcsDigest(request);
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

function jcsDigest(value) {
    return crypto.createHash('sha256')
        .update(JSON.stringify(canonicalize(value)), 'utf8').digest('hex');
}

function rebindPostcondition(result) {
    result.evidence.postcondition.digest = jcsDigest({
        capabilityId: result.capabilityId,
        capabilityVersion: result.capabilityVersion,
        value: result.value,
    });
}

function bitDepthReadPostconditionDigest(value) {
    const canonical = {
        capabilityId: 'ae.project.bit-depth.read',
        capabilityVersion: 1,
        value: {
            bitsPerChannel: value.bitsPerChannel,
        },
    };
    return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

function bitDepthSetPostconditionDigest(value) {
    const canonical = {
        capabilityId: 'ae.project.bit-depth.set',
        capabilityVersion: 1,
        value: {
            afterBitsPerChannel: value.afterBitsPerChannel,
            beforeBitsPerChannel: value.beforeBitsPerChannel,
            changed: value.changed,
        },
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
                        limits: { maxFrameBytes: 524288 },
                        capabilitiesDigest: DIGEST,
                        clientNonce: request.params.nonce,
                    };
                } else if (request.method === 'capabilities') {
                    result = {
                        detail: request.params.detail || 'summary',
                        capabilitiesDigest: DIGEST,
                        queryDigest: capabilitiesRequestDigest(request),
                        nextCursor: null,
                        items: CAPABILITIES_VECTOR.items,
                    };
                } else if (request.method === 'invalidateGraph') {
                    result = input.invalidateResult || {
                        generation: 8,
                        invalidated: true,
                    };
                } else if (input.projectCompositionVectors?.has(
                    request.params.capabilityId,
                )) {
                    const vector = input.projectCompositionVectors.get(
                        request.params.capabilityId,
                    );
                    result = structuredClone(vector.response.result);
                    if (!input.preserveProjectCompositionFixtureEvidence) {
                        result.evidence.requestId = request.requestId;
                        result.evidence.requestDigest = invokeRequestDigest(request);
                        rebindPostcondition(result);
                    }
                    if (input.mutateInvoke) input.mutateInvoke(result, request);
                } else if (request.params.capabilityId === 'ae.composition.create') {
                    result = structuredClone(COMPOSITION_CREATE_VECTOR.response.result);
                    result.evidence.requestId = request.requestId;
                    result.evidence.requestDigest = invokeRequestDigest(request);
                    result.evidence.postcondition.digest = jcsDigest({
                        capabilityId: result.capabilityId,
                        capabilityVersion: result.capabilityVersion,
                        value: result.value,
                    });
                    if (input.mutateInvoke) input.mutateInvoke(result, request);
                } else if (request.params.capabilityId === 'ae.composition.layer.create') {
                    result = structuredClone(COMPOSITION_LAYER_CREATE_VECTOR.response.result);
                    result.evidence.requestId = request.requestId;
                    result.evidence.requestDigest = invokeRequestDigest(request);
                    result.evidence.postcondition.digest = jcsDigest({
                        capabilityId: result.capabilityId,
                        capabilityVersion: result.capabilityVersion,
                        value: result.value,
                    });
                    if (input.mutateInvoke) input.mutateInvoke(result, request);
                } else if (request.params.capabilityId === 'ae.layer.effect.apply') {
                    result = structuredClone(LAYER_EFFECT_APPLY_VECTOR.response.result);
                    result.evidence.requestId = request.requestId;
                    result.evidence.requestDigest = invokeRequestDigest(request);
                    result.evidence.postcondition.digest = jcsDigest({
                        capabilityId: result.capabilityId,
                        capabilityVersion: result.capabilityVersion,
                        value: result.value,
                    });
                    if (input.mutateInvoke) input.mutateInvoke(result, request);
                } else if (request.params.capabilityId === 'ae.composition.time.set') {
                    result = structuredClone(COMPOSITION_TIME_SET_VECTOR.response.result);
                    result.evidence.requestId = request.requestId;
                    result.evidence.requestDigest = invokeRequestDigest(request);
                    result.evidence.postcondition.digest = jcsDigest({
                        capabilityId: result.capabilityId,
                        capabilityVersion: result.capabilityVersion,
                        value: result.value,
                    });
                    if (input.mutateInvoke) input.mutateInvoke(result, request);
                } else if (request.params.capabilityId === 'ae.layer.property.set') {
                    result = structuredClone(LAYER_PROPERTY_SET_VECTOR.response.result);
                    result.evidence.requestId = request.requestId;
                    result.evidence.requestDigest = invokeRequestDigest(request);
                    result.evidence.postcondition.digest = jcsDigest({
                        capabilityId: result.capabilityId,
                        capabilityVersion: result.capabilityVersion,
                        value: result.value,
                    });
                    if (input.mutateInvoke) input.mutateInvoke(result, request);
                } else if (request.params.capabilityId
                    === 'ae.layer.property.keyframes.list') {
                    result = structuredClone(
                        LAYER_PROPERTY_KEYFRAMES_VECTOR.response.result,
                    );
                    result.evidence.requestId = request.requestId;
                    result.evidence.requestDigest = invokeRequestDigest(request);
                    result.evidence.postcondition.digest = jcsDigest({
                        capabilityId: result.capabilityId,
                        capabilityVersion: result.capabilityVersion,
                        value: result.value,
                    });
                    if (input.mutateInvoke) input.mutateInvoke(result, request);
                } else if (request.params.capabilityId === 'ae.project.items.list'
                    || request.params.capabilityId === 'ae.composition.layers.list'
                    || request.params.capabilityId === 'ae.composition.selected-layers.list'
                    || request.params.capabilityId === 'ae.composition.time.read'
                    || request.params.capabilityId === 'ae.layer.properties.list') {
                    const vector = request.params.capabilityId === 'ae.project.items.list'
                        ? PROJECT_ITEMS_VECTOR
                        : request.params.capabilityId === 'ae.composition.layers.list'
                            ? COMPOSITION_LAYERS_VECTOR
                            : request.params.capabilityId
                                === 'ae.composition.selected-layers.list'
                                ? COMPOSITION_SELECTED_LAYERS_VECTOR
                            : request.params.capabilityId === 'ae.composition.time.read'
                                ? COMPOSITION_TIME_VECTOR : LAYER_PROPERTIES_VECTOR;
                    result = structuredClone(vector.response.result);
                    result.evidence.requestId = request.requestId;
                    result.evidence.requestDigest = invokeRequestDigest(request);
                    result.evidence.postcondition.digest = jcsDigest({
                        capabilityId: result.capabilityId,
                        capabilityVersion: result.capabilityVersion,
                        value: result.value,
                    });
                    if (input.mutateInvoke) input.mutateInvoke(result, request);
                } else if (request.params.capabilityId === 'ae.project.bit-depth.set') {
                    const value = {
                        changed: true,
                        beforeBitsPerChannel: 8,
                        afterBitsPerChannel: request.params.arguments.targetDepth,
                    };
                    result = {
                        capabilityId: 'ae.project.bit-depth.set',
                        capabilityVersion: 1,
                        engine: 'native-aegp',
                        outcome: 'succeeded',
                        evidence: {
                            engine: 'native-aegp',
                            hostInstanceId: HOST,
                            sessionId: SESSION,
                            requestId: request.requestId,
                            capabilityId: 'ae.project.bit-depth.set',
                            capabilityVersion: 1,
                            startedAtUnixMs: 1900000000000,
                            completedAtUnixMs: 1900000000001,
                            effect: 'committed',
                            requestDigest: invokeRequestDigest(request),
                            postcondition: {
                                verified: true,
                                kind: 'project-bit-depth-set',
                                algorithm: 'sha256-rfc8785-jcs-v1',
                                digest: bitDepthSetPostconditionDigest(value),
                            },
                            undo: { available: true, verified: false },
                        },
                        value,
                    };
                    if (input.mutateInvoke) input.mutateInvoke(result, request);
                } else if (request.params.capabilityId === 'ae.project.bit-depth.read') {
                    const value = { bitsPerChannel: 8 };
                    result = {
                        capabilityId: 'ae.project.bit-depth.read',
                        capabilityVersion: 1,
                        engine: 'native-aegp',
                        outcome: 'succeeded',
                        evidence: {
                            engine: 'native-aegp',
                            hostInstanceId: HOST,
                            sessionId: SESSION,
                            requestId: request.requestId,
                            capabilityId: 'ae.project.bit-depth.read',
                            capabilityVersion: 1,
                            startedAtUnixMs: 1900000000000,
                            completedAtUnixMs: 1900000000001,
                            effect: 'none',
                            requestDigest: invokeRequestDigest(request),
                            postcondition: {
                                verified: true,
                                kind: 'project-bit-depth-read',
                                algorithm: 'sha256-rfc8785-jcs-v1',
                                digest: bitDepthReadPostconditionDigest(value),
                            },
                        },
                        value,
                    };
                    if (input.mutateInvoke) input.mutateInvoke(result, request);
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
                const responseError = request.method === 'invoke'
                    ? input.invokeError
                    : request.method === 'invalidateGraph'
                        ? input.invalidateError : null;
                const replayed = responseError
                    ? input.errorReplayed === true
                    : (request.method === 'invoke'
                        && request.params.capabilityId === 'ae.composition.create'
                        && request.requestId === input.compositionCreateReplayedRequestId)
                        || (request.method === 'invoke'
                        && request.params.capabilityId === 'ae.composition.layer.create'
                        && request.requestId === input.createReplayedRequestId)
                        || (request.method === 'invoke'
                        && request.params.capabilityId === 'ae.layer.effect.apply'
                        && request.requestId === input.effectApplyReplayedRequestId)
                        || (request.method === 'invoke'
                            && request.params.capabilityId === 'ae.project.summary'
                            && input.summaryReplayed === true);
                socket.write(frame({
                    wireVersion: 1,
                    kind: 'response',
                    sessionId: SESSION,
                    requestId: request.requestId,
                    method: request.method,
                    ok: responseError ? false : true,
                    replayed,
                    ...(responseError ? { error: responseError } : { result }),
                }));
            }
        }
    });
    return { authorize, requests };
}

async function readyNativeClient(t, protocolOptions) {
    const endpoint = await endpointFixture(t);
    const protocol = installProtocol(endpoint.server, protocolOptions);
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
    await client.capabilities({ detail: 'full', limit: 100 });
    return { client, protocol };
}

test('CEP client negotiates and verifies all sixteen frozen #150/#155 native contracts', {
    skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
}, async (t) => {
    const { client, protocol } = await readyNativeClient(t, {
        projectCompositionVectors: PROJECT_COMPOSITION_VECTORS,
    });
    let index = 0;
    for (const [capabilityId, vector] of PROJECT_COMPOSITION_VECTORS) {
        index += 1;
        let result;
        try {
            result = await client.invoke({
                requestId: 'issue150-success-' + index,
                capabilityId,
                capabilityVersion: 1,
                arguments: structuredClone(vector.request.params.arguments),
                deadlineUnixMs: 1900000005000,
            });
        } catch (error) {
            error.message = capabilityId + ': ' + error.message;
            throw error;
        }
        assert.deepEqual(result.value, vector.response.result.value, capabilityId);
        assert.equal(result.replayed, false, capabilityId);
    }
    assert.deepEqual(
        client.status().projectCompositionContractDigests,
        Object.fromEntries(Array.from(PROJECT_COMPOSITION_VECTORS).map(function (entry) {
            return [entry[0], projectCompositionContracts.getContract(entry[0]).digest];
        })),
    );
    assert.deepEqual(
        protocol.requests.filter(function (request) { return request.method === 'invoke'; })
            .map(function (request) { return request.params.capabilityId; }),
        Array.from(PROJECT_COMPOSITION_VECTORS.keys()),
    );
});

test('CEP client accepts the shared comment fixture without rebinding native evidence', {
    skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
}, async (t) => {
    const { client } = await readyNativeClient(t, {
        projectCompositionVectors: PROJECT_COMPOSITION_VECTORS,
        preserveProjectCompositionFixtureEvidence: true,
    });
    const vector = PROJECT_COMPOSITION_VECTORS.get('ae.project.item.comment.set');
    const result = await client.invoke({
        requestId: vector.request.requestId,
        capabilityId: vector.request.params.capabilityId,
        capabilityVersion: vector.request.params.capabilityVersion,
        arguments: structuredClone(vector.request.params.arguments),
        deadlineUnixMs: vector.request.deadlineUnixMs,
    });
    assert.equal(
        result.evidence.requestDigest,
        vector.response.result.evidence.requestDigest,
    );
    assert.deepEqual(result.value, vector.response.result.value);
});

test('CEP client rejects tampered #150 read evidence as a contract mismatch', {
    skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
}, async (t) => {
    const { client } = await readyNativeClient(t, {
        projectCompositionVectors: PROJECT_COMPOSITION_VECTORS,
        mutateInvoke: function (result, request) {
            if (request.params.capabilityId === 'ae.project.context.read') {
                result.value.unadvertised = true;
            }
        },
    });
    const vector = PROJECT_COMPOSITION_VECTORS.get('ae.project.context.read');
    await assert.rejects(
        client.invoke({
            requestId: 'issue150-read-tamper',
            capabilityId: 'ae.project.context.read',
            capabilityVersion: 1,
            arguments: structuredClone(vector.request.params.arguments),
            deadlineUnixMs: 1900000005000,
        }),
        { code: 'NATIVE_CONTRACT_MISMATCH', retryable: false, sideEffect: 'not-started' },
    );
});

test('CEP client treats tampered #150 write evidence as side-effect uncertain', {
    skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
}, async (t) => {
    const { client } = await readyNativeClient(t, {
        projectCompositionVectors: PROJECT_COMPOSITION_VECTORS,
        mutateInvoke: function (result, request) {
            if (request.params.capabilityId === 'ae.project.item.comment.set') {
                result.value.afterComment = result.value.beforeComment;
            }
        },
    });
    const vector = PROJECT_COMPOSITION_VECTORS.get('ae.project.item.comment.set');
    await assert.rejects(
        client.invoke({
            requestId: 'issue150-write-tamper',
            capabilityId: 'ae.project.item.comment.set',
            capabilityVersion: 1,
            arguments: structuredClone(vector.request.params.arguments),
            deadlineUnixMs: 1900000005000,
        }),
        function (error) {
            assert.equal(error.code, 'POSSIBLY_SIDE_EFFECTING_FAILURE');
            assert.equal(error.retryable, false);
            assert.equal(error.sideEffect, 'may-have-occurred');
            assert.equal(error.recovery.action, 'inspect-state');
            assert.deepEqual(error.details, {
                capabilityId: 'ae.project.item.comment.set',
            });
            return true;
        },
    );
});

test('CEP client rejects tampered #155 read and write results with correct side-effect semantics', {
    skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
}, async (t) => {
    const { client } = await readyNativeClient(t, {
        projectCompositionVectors: PROJECT_COMPOSITION_VECTORS,
        mutateInvoke: function (result, request) {
            if (request.params.capabilityId === 'ae.layer.details.read') {
                result.value.unadvertised = true;
            } else if (request.params.capabilityId.startsWith('ae.layer.')) {
                result.evidence.undo.verified = true;
            }
        },
    });
    const readVector = PROJECT_COMPOSITION_VECTORS.get('ae.layer.details.read');
    await assert.rejects(client.invoke({
        requestId: 'issue155-read-tamper',
        capabilityId: 'ae.layer.details.read',
        capabilityVersion: 1,
        arguments: structuredClone(readVector.request.params.arguments),
        deadlineUnixMs: 1900000005000,
    }), { code: 'NATIVE_CONTRACT_MISMATCH', retryable: false, sideEffect: 'not-started' });

    for (const capabilityId of [
        'ae.layer.name.set',
        'ae.layer.range.set',
        'ae.layer.start-time.set',
        'ae.layer.stretch.set',
        'ae.layer.order.set',
        'ae.layer.parent.set',
        'ae.layer.duplicate',
    ]) {
        const vector = PROJECT_COMPOSITION_VECTORS.get(capabilityId);
        await assert.rejects(client.invoke({
            requestId: 'issue155-write-tamper-' + capabilityId,
            capabilityId,
            capabilityVersion: 1,
            arguments: structuredClone(vector.request.params.arguments),
            deadlineUnixMs: 1900000005000,
        }), {
            code: 'POSSIBLY_SIDE_EFFECTING_FAILURE',
            retryable: false,
            sideEffect: 'may-have-occurred',
        }, capabilityId);
    }
});

test('CEP client rejects stale #155 layer locators before native dispatch', {
    skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
}, async (t) => {
    const { client, protocol } = await readyNativeClient(t, {
        projectCompositionVectors: PROJECT_COMPOSITION_VECTORS,
    });
    const vector = PROJECT_COMPOSITION_VECTORS.get('ae.layer.details.read');
    const argumentsValue = structuredClone(vector.request.params.arguments);
    argumentsValue.layerLocator.sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const invokeCount = protocol.requests.filter(function (request) {
        return request.method === 'invoke';
    }).length;
    await assert.rejects(client.invoke({
        requestId: 'issue155-stale-layer',
        capabilityId: 'ae.layer.details.read',
        capabilityVersion: 1,
        arguments: argumentsValue,
        deadlineUnixMs: 1900000005000,
    }), function (error) {
        assert.equal(error.code, 'STALE_LOCATOR');
        assert.deepEqual(error.details, {
            field: 'params.arguments.layerLocator',
            capabilityId: 'ae.layer.details.read',
        });
        assert.equal(error.recovery.action, 'refresh-locator');
        assert.match(error.recovery.hint, /ae_listCompositionLayers/);
        return true;
    });
    assert.equal(protocol.requests.filter(function (request) {
        return request.method === 'invoke';
    }).length, invokeCount);
});

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

    const layerPropertiesDescriptor = CAPABILITIES_VECTOR.items.find(function (item) {
        return item.id === 'ae.layer.properties.list';
    });
    const valueVariants = layerPropertiesDescriptor.resultSchema.properties
        .properties.items.properties.value.oneOf;
    const scalarSchema = valueVariants.find(function (variant) {
        return variant.properties?.kind?.const === 'scalar';
    });
    const vectorSchema = valueVariants.find(function (variant) {
        return variant.properties?.kind?.const === 'vector';
    });
    assert.deepEqual(vectorSchema.properties.components, {
        type: 'array',
        minItems: 2,
        maxItems: 3,
        items: scalarSchema.properties.value,
    });
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

test('CEP client sends the closed internal project-graph invalidation contract', {
    skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
}, async (t) => {
    const ready = await readyNativeClient(t);
    const result = await ready.client.invalidateProjectGraph({
        deadlineUnixMs: 1900000002000,
    });

    assert.deepEqual(result, { generation: 8, invalidated: true });
    const request = ready.protocol.requests.at(-1);
    assert.equal(request.method, 'invalidateGraph');
    assert.deepEqual(request.params, { reason: 'cep-jsx' });
    assert.equal(request.sessionId, SESSION);
    assert.equal(request.deadlineUnixMs, 1900000002000);
    assert.deepEqual(Object.keys(request).sort(), [
        'deadlineUnixMs', 'kind', 'method', 'params', 'requestId', 'sessionId', 'wireVersion',
    ]);
});

test('CEP client rejects an open project-graph invalidation result', {
    skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
}, async (t) => {
    const ready = await readyNativeClient(t, {
        invalidateResult: { generation: 8, invalidated: true, extra: 'open-contract' },
    });

    await assert.rejects(
        ready.client.invalidateProjectGraph({ deadlineUnixMs: 1900000002000 }),
        (error) => error?.code === 'NATIVE_CONTRACT_MISMATCH'
            && /invalidation result was malformed/.test(error.message),
    );
});

test('CEP client rejects inconsistent project-graph invalidation evidence', {
    skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
}, async (t) => {
    for (const invalidateResult of [
        { generation: 0, invalidated: true },
        { generation: 8, invalidated: false },
    ]) {
        const ready = await readyNativeClient(t, { invalidateResult });
        await assert.rejects(
            ready.client.invalidateProjectGraph({ deadlineUnixMs: 1900000002000 }),
            (error) => error?.code === 'NATIVE_CONTRACT_MISMATCH'
                && /invalidation result was malformed/.test(error.message),
        );
        await ready.client.close();
    }
});

test('CEP client verifies native project summary and bit-depth read/write capabilities', {
    skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
}, async (t) => {
    const fixture = await endpointFixture(t);
    const protocol = installProtocol(fixture.server, { summaryReplayed: true });
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
    assert.equal(summary.replayed, true);
    assert.equal(summary.evidence.postcondition.verified, true);
    assert.equal(
        client.status().projectSummaryContractDigest,
        CAPABILITIES_VECTOR.items[0].contractDigest,
    );
    assert.equal(client.status().projectBitDepthReadContractDigest, BIT_DEPTH_READ_DIGEST);
    assert.equal(client.status().projectBitDepthSetContractDigest, BIT_DEPTH_SET_DIGEST);
    assert.equal(
        client.status().projectItemsListContractDigest,
        CAPABILITIES_VECTOR.items.find(function (item) {
            return item.id === 'ae.project.items.list';
        }).contractDigest,
    );
    assert.equal(
        client.status().compositionLayersListContractDigest,
        CAPABILITIES_VECTOR.items.find(function (item) {
            return item.id === 'ae.composition.layers.list';
        }).contractDigest,
    );
    assert.equal(
        client.status().compositionSelectedLayersListContractDigest,
        CAPABILITIES_VECTOR.items.find(function (item) {
            return item.id === 'ae.composition.selected-layers.list';
        }).contractDigest,
    );
    assert.equal(
        client.status().compositionTimeReadContractDigest,
        CAPABILITIES_VECTOR.items.find(function (item) {
            return item.id === 'ae.composition.time.read';
        }).contractDigest,
    );
    assert.equal(
        client.status().compositionTimeSetContractDigest,
        CAPABILITIES_VECTOR.items.find(function (item) {
            return item.id === 'ae.composition.time.set';
        }).contractDigest,
    );
    assert.equal(
        client.status().layerPropertiesListContractDigest,
        CAPABILITIES_VECTOR.items.find(function (item) {
            return item.id === 'ae.layer.properties.list';
        }).contractDigest,
    );
    assert.equal(
        client.status().layerPropertyKeyframesListContractDigest,
        CAPABILITIES_VECTOR.items.find(function (item) {
            return item.id === 'ae.layer.property.keyframes.list';
        }).contractDigest,
    );
    assert.deepEqual(protocol.requests.map(function (request) { return request.method; }), [
        'hello', 'capabilities', 'invoke',
    ]);
    assert.equal(Object.hasOwn(protocol.requests[1].params, 'ids'), false);
    assert.equal(protocol.requests[1].params.limit, 100);
    assert.equal(protocol.requests[2].requestId, 'core-project-summary-1');
    assert.equal(protocol.requests[2].deadlineUnixMs, 1900000002000);
    assert.equal(summary.evidence.requestDigest, invokeRequestDigest(protocol.requests[2]));

    const bitDepthRead = await client.invoke({
        requestId: 'core-bit-depth-read-1',
        capabilityId: 'ae.project.bit-depth.read',
        capabilityVersion: 1,
        arguments: {},
        deadlineUnixMs: 1900000002000,
    });
    assert.equal(bitDepthRead.replayed, false);
    assert.deepEqual(bitDepthRead.value, { bitsPerChannel: 8 });
    assert.equal(bitDepthRead.evidence.effect, 'none');
    assert.equal(bitDepthRead.evidence.undo, undefined);
    assert.equal(bitDepthRead.evidence.requestDigest, invokeRequestDigest(protocol.requests[3]));

    const bitDepthSet = await client.invoke({
        requestId: 'core-bit-depth-set-1',
        capabilityId: 'ae.project.bit-depth.set',
        capabilityVersion: 1,
        arguments: {
            targetDepth: 16,
            idempotencyKey: 'bit-depth-intent-0001',
        },
        deadlineUnixMs: 1900000002000,
    });
    assert.equal(bitDepthSet.replayed, false);
    assert.deepEqual(bitDepthSet.value, {
        changed: true,
        beforeBitsPerChannel: 8,
        afterBitsPerChannel: 16,
    });
    assert.deepEqual(bitDepthSet.evidence.undo, { available: true, verified: false });
    assert.equal(bitDepthSet.evidence.requestDigest, invokeRequestDigest(protocol.requests[4]));
    assert.deepEqual(protocol.requests[4].params.arguments, {
        targetDepth: 16, idempotencyKey: 'bit-depth-intent-0001',
    });

    const projectItems = await client.invoke({
        requestId: 'core-project-items-1',
        capabilityId: 'ae.project.items.list',
        capabilityVersion: 1,
        arguments: { offset: 0, limit: 25 },
        deadlineUnixMs: 1900000002000,
    });
    assert.equal(projectItems.replayed, false);
    assert.equal(projectItems.value.returned, 2);
    const compositionLocator = projectItems.value.items.find(function (item) {
        return item.type === 'composition';
    }).locator;
    assert.equal(projectItems.evidence.requestDigest, invokeRequestDigest(protocol.requests[5]));

    const compositionLayers = await client.invoke({
        requestId: 'core-composition-layers-1',
        capabilityId: 'ae.composition.layers.list',
        capabilityVersion: 1,
        arguments: { compositionLocator, offset: 0, limit: 25 },
        deadlineUnixMs: 1900000002000,
    });
    assert.equal(compositionLayers.replayed, false);
    assert.equal(compositionLayers.value.layers[0].locked, false);
    assert.equal(
        compositionLayers.evidence.requestDigest,
        invokeRequestDigest(protocol.requests[6]),
    );
    const compositionSelectedLayers = await client.invoke({
        requestId: 'core-composition-selected-layers-1',
        capabilityId: 'ae.composition.selected-layers.list',
        capabilityVersion: 1,
        arguments: { compositionLocator, offset: 0, limit: 25 },
        deadlineUnixMs: 1900000002000,
    });
    assert.equal(compositionSelectedLayers.replayed, false);
    assert.deepEqual(
        compositionSelectedLayers.value.layers.map(function (layer) {
            return layer.stackIndex;
        }),
        [1, 3],
    );
    assert.equal(
        compositionSelectedLayers.evidence.requestDigest,
        invokeRequestDigest(protocol.requests[7]),
    );
    const compositionTime = await client.invoke({
        requestId: 'core-composition-time-1',
        capabilityId: 'ae.composition.time.read',
        capabilityVersion: 1,
        arguments: { compositionLocator },
        deadlineUnixMs: 1900000002000,
    });
    assert.equal(compositionTime.replayed, false);
    assert.deepEqual(compositionTime.value, {
        compositionLocator,
        currentTime: {
            value: 3003,
            scale: 1000,
            secondsRational: '3003/1000',
        },
    });
    assert.equal(Object.hasOwn(compositionTime.value, 'compositionName'), false);
    assert.equal(compositionTime.evidence.effect, 'none');
    assert.equal(compositionTime.evidence.undo, undefined);
    assert.equal(
        compositionTime.evidence.requestDigest,
        invokeRequestDigest(protocol.requests[8]),
    );
    const layerProperties = await client.invoke({
        requestId: 'core-layer-properties-1',
        capabilityId: 'ae.layer.properties.list',
        capabilityVersion: 1,
        arguments: structuredClone(LAYER_PROPERTIES_VECTOR.request.params.arguments),
        deadlineUnixMs: 1900000002000,
    });
    assert.equal(layerProperties.replayed, false);
    assert.deepEqual(
        layerProperties.value.parentPropertyLocator,
        LAYER_PROPERTIES_VECTOR.request.params.arguments.parentPropertyLocator,
    );
    assert.equal(layerProperties.value.properties[0].propertyIndex, 1);
    assert.equal(
        layerProperties.evidence.requestDigest,
        invokeRequestDigest(protocol.requests[9]),
    );
    const layerPropertyKeyframes = await client.invoke({
        requestId: 'core-layer-property-keyframes-1',
        capabilityId: 'ae.layer.property.keyframes.list',
        capabilityVersion: 1,
        arguments: structuredClone(
            LAYER_PROPERTY_KEYFRAMES_VECTOR.request.params.arguments,
        ),
        deadlineUnixMs: 1900000002000,
    });
    assert.equal(layerPropertyKeyframes.replayed, false);
    assert.equal(layerPropertyKeyframes.value.keyframes[1].time.value, 5);
    assert.equal(layerPropertyKeyframes.value.keyframes[1].time.scale, 2);
    assert.equal(
        layerPropertyKeyframes.value.keyframes[1].outInterpolation,
        'hold',
    );
    assert.equal(
        layerPropertyKeyframes.evidence.requestDigest,
        invokeRequestDigest(protocol.requests[10]),
    );
    assert.deepEqual(protocol.requests.map(function (request) { return request.method; }), [
        'hello', 'capabilities', 'invoke', 'invoke', 'invoke', 'invoke', 'invoke', 'invoke',
        'invoke', 'invoke', 'invoke',
    ]);
});

test('CEP graph reads count Unicode scalars rather than UTF-16 code units', {
    skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
}, async (t) => {
    const astral = '😀'.repeat(1024);
    const ready = await readyNativeClient(t, {
        mutateInvoke: function (result) {
            if (result.capabilityId === 'ae.project.items.list') {
                result.value.items.forEach(function (item) { item.name = astral; });
            } else if (result.capabilityId === 'ae.composition.layers.list') {
                result.value.compositionName = astral;
                result.value.layers.forEach(function (layer) { layer.name = astral; });
            } else if (result.capabilityId === 'ae.layer.properties.list') {
                result.value.layerName = astral;
                result.value.properties.forEach(function (property) { property.name = astral; });
            }
            rebindPostcondition(result);
        },
    });
    const project = await ready.client.invoke({
        requestId: 'unicode-project-items',
        capabilityId: 'ae.project.items.list',
        capabilityVersion: 1,
        arguments: { offset: 0, limit: 25 },
        deadlineUnixMs: 1900000002000,
    });
    assert.equal(Array.from(project.value.items[0].name).length, 1024);
    const layers = await ready.client.invoke({
        requestId: 'unicode-composition-layers',
        capabilityId: 'ae.composition.layers.list',
        capabilityVersion: 1,
        arguments: {
            compositionLocator: COMPOSITION_LAYERS_VECTOR.request.params.arguments.compositionLocator,
            offset: 0,
            limit: 25,
        },
        deadlineUnixMs: 1900000002000,
    });
    assert.equal(Array.from(layers.value.compositionName).length, 1024);
    assert.equal(Array.from(layers.value.layers[0].name).length, 1024);
    const properties = await ready.client.invoke({
        requestId: 'unicode-layer-properties',
        capabilityId: 'ae.layer.properties.list',
        capabilityVersion: 1,
        arguments: structuredClone(LAYER_PROPERTIES_VECTOR.request.params.arguments),
        deadlineUnixMs: 1900000002000,
    });
    assert.equal(Array.from(properties.value.layerName).length, 1024);
    assert.equal(Array.from(properties.value.properties[0].name).length, 1024);
});

test('CEP selected-layer reads accept sparse stack order and reject open results', {
    skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
}, async (t) => {
    const ready = await readyNativeClient(t, {
        mutateInvoke: function (result, request) {
            if (result.capabilityId !== 'ae.composition.selected-layers.list') return;
            if (request.requestId === 'selected-layers-empty') {
                result.value.total = 0;
                result.value.returned = 0;
                result.value.layers = [];
            } else if (request.requestId === 'selected-layers-page-1') {
                result.value.offset = 0;
                result.value.limit = 1;
                result.value.returned = 1;
                result.value.hasMore = true;
                result.value.nextOffset = 1;
                result.value.layers = [result.value.layers[0]];
            } else if (request.requestId === 'selected-layers-page-2') {
                result.value.offset = 1;
                result.value.limit = 1;
                result.value.returned = 1;
                result.value.hasMore = false;
                result.value.nextOffset = null;
                result.value.layers = [result.value.layers[1]];
            } else if (request.requestId === 'selected-layers-reversed') {
                result.value.layers.reverse();
            } else if (request.requestId === 'selected-layers-extra-field') {
                result.value.layers[0].selected = true;
            } else if (request.requestId === 'selected-layers-wrong-kind') {
                result.evidence.postcondition.kind = 'composition-layers-list';
            }
            rebindPostcondition(result);
        },
    });
    const argumentsValue = structuredClone(
        COMPOSITION_SELECTED_LAYERS_VECTOR.request.params.arguments,
    );
    const accepted = await ready.client.invoke({
        requestId: 'selected-layers-sparse',
        capabilityId: 'ae.composition.selected-layers.list',
        capabilityVersion: 1,
        arguments: argumentsValue,
        deadlineUnixMs: 1900000002000,
    });
    assert.deepEqual(accepted.value.layers.map(function (layer) {
        return layer.stackIndex;
    }), [1, 3]);
    assert.equal(accepted.evidence.effect, 'none');
    assert.equal(accepted.evidence.undo, undefined);
    const firstPage = await ready.client.invoke({
        requestId: 'selected-layers-page-1',
        capabilityId: 'ae.composition.selected-layers.list',
        capabilityVersion: 1,
        arguments: { ...argumentsValue, offset: 0, limit: 1 },
        deadlineUnixMs: 1900000002000,
    });
    assert.deepEqual(firstPage.value.layers.map(function (layer) {
        return layer.stackIndex;
    }), [1]);
    assert.equal(firstPage.value.returned, 1);
    assert.equal(firstPage.value.hasMore, true);
    assert.equal(firstPage.value.nextOffset, 1);
    const firstPageRequest = ready.protocol.requests.at(-1);
    assert.equal(firstPage.evidence.requestDigest, invokeRequestDigest(firstPageRequest));

    const secondPage = await ready.client.invoke({
        requestId: 'selected-layers-page-2',
        capabilityId: 'ae.composition.selected-layers.list',
        capabilityVersion: 1,
        arguments: { ...argumentsValue, offset: 1, limit: 1 },
        deadlineUnixMs: 1900000002000,
    });
    assert.deepEqual(secondPage.value.layers.map(function (layer) {
        return layer.stackIndex;
    }), [3]);
    assert.equal(secondPage.value.returned, 1);
    assert.equal(secondPage.value.hasMore, false);
    assert.equal(secondPage.value.nextOffset, null);
    const secondPageRequest = ready.protocol.requests.at(-1);
    assert.equal(secondPage.evidence.requestDigest, invokeRequestDigest(secondPageRequest));
    assert.notEqual(firstPage.evidence.requestDigest, secondPage.evidence.requestDigest);
    const empty = await ready.client.invoke({
        requestId: 'selected-layers-empty',
        capabilityId: 'ae.composition.selected-layers.list',
        capabilityVersion: 1,
        arguments: argumentsValue,
        deadlineUnixMs: 1900000002000,
    });
    assert.equal(empty.value.total, 0);
    assert.deepEqual(empty.value.layers, []);

    for (const requestId of [
        'selected-layers-reversed',
        'selected-layers-extra-field',
        'selected-layers-wrong-kind',
    ]) {
        await assert.rejects(ready.client.invoke({
            requestId,
            capabilityId: 'ae.composition.selected-layers.list',
            capabilityVersion: 1,
            arguments: argumentsValue,
            deadlineUnixMs: 1900000002000,
        }), { code: 'NATIVE_CONTRACT_MISMATCH', retryable: false });
    }

    const beforeInvalidInput = ready.protocol.requests.length;
    await assert.rejects(ready.client.invoke({
        requestId: 'selected-layers-extra-input',
        capabilityId: 'ae.composition.selected-layers.list',
        capabilityVersion: 1,
        arguments: { ...argumentsValue, includeProperties: true },
        deadlineUnixMs: 1900000002000,
    }), { code: 'INVALID_ARGUMENT', retryable: false });
    assert.equal(ready.protocol.requests.length, beforeInvalidInput);
});

test('CEP forwards same-session forged selected-layer locators and preserves native stale recovery', {
    skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
}, async (t) => {
    const ready = await readyNativeClient(t, {
        invokeError: {
            code: 'STALE_LOCATOR',
            message: 'compositionLocator does not identify the open composition',
            retryable: true,
            sideEffect: 'not-started',
            recovery: {
                action: 'refresh-locator',
                hint: 'Discard the stale locator and call ae_listProjectItems again.',
            },
            details: {
                field: 'params.arguments.compositionLocator',
                capabilityId: 'ae.composition.selected-layers.list',
            },
        },
    });
    const baseArguments = structuredClone(
        COMPOSITION_SELECTED_LAYERS_VECTOR.request.params.arguments,
    );
    const forgedArguments = [
        {
            ...baseArguments,
            compositionLocator: {
                ...baseArguments.compositionLocator,
                objectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            },
        },
        {
            ...baseArguments,
            compositionLocator: {
                ...baseArguments.compositionLocator,
                generation: baseArguments.compositionLocator.generation + 1,
            },
        },
    ];

    for (let index = 0; index < forgedArguments.length; index += 1) {
        const before = ready.protocol.requests.length;
        await assert.rejects(ready.client.invoke({
            requestId: 'selected-layers-forged-' + String(index + 1),
            capabilityId: 'ae.composition.selected-layers.list',
            capabilityVersion: 1,
            arguments: forgedArguments[index],
            deadlineUnixMs: 1900000002000,
        }), function (error) {
            assert.equal(error.code, 'STALE_LOCATOR');
            assert.equal(error.retryable, true);
            assert.equal(error.sideEffect, 'not-started');
            assert.deepEqual(error.recovery, {
                action: 'refresh-locator',
                hint: 'Discard the stale locator and call ae_listProjectItems again.',
            });
            assert.deepEqual(error.details, {
                field: 'params.arguments.compositionLocator',
                capabilityId: 'ae.composition.selected-layers.list',
            });
            return true;
        });
        assert.equal(ready.protocol.requests.length, before + 1);
        assert.deepEqual(
            ready.protocol.requests.at(-1).params.arguments,
            forgedArguments[index],
        );
    }
});

test('CEP composition-time read enforces exact rational and closed native evidence', {
    skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
}, async (t) => {
    const ready = await readyNativeClient(t, {
        mutateInvoke: function (result, request) {
            if (result.capabilityId !== 'ae.composition.time.read') return;
            if (request.requestId === 'composition-time-int32-min') {
                result.value.currentTime = {
                    value: -2147483648,
                    scale: 4294967295,
                    secondsRational: '-2147483648/4294967295',
                };
            } else if (request.requestId === 'composition-time-unreduced') {
                result.value.currentTime = {
                    value: 60,
                    scale: 24,
                    secondsRational: '60/24',
                };
            } else if (request.requestId === 'composition-time-extra-field') {
                result.value.compositionName = 'Main';
            } else if (request.requestId === 'composition-time-out-of-range') {
                result.value.currentTime.value = 2147483648;
                result.value.currentTime.secondsRational = '2147483648/1000';
            }
            rebindPostcondition(result);
        },
    });
    const argumentsValue = structuredClone(COMPOSITION_TIME_VECTOR.request.params.arguments);
    const accepted = await ready.client.invoke({
        requestId: 'composition-time-int32-min',
        capabilityId: 'ae.composition.time.read',
        capabilityVersion: 1,
        arguments: argumentsValue,
        deadlineUnixMs: 1900000002000,
    });
    assert.deepEqual(accepted.value.currentTime, {
        value: -2147483648,
        scale: 4294967295,
        secondsRational: '-2147483648/4294967295',
    });

    for (const requestId of [
        'composition-time-unreduced',
        'composition-time-extra-field',
        'composition-time-out-of-range',
    ]) {
        await assert.rejects(ready.client.invoke({
            requestId,
            capabilityId: 'ae.composition.time.read',
            capabilityVersion: 1,
            arguments: argumentsValue,
            deadlineUnixMs: 1900000002000,
        }), { code: 'NATIVE_CONTRACT_MISMATCH', retryable: false });
    }

    const beforeInvalidInput = ready.protocol.requests.length;
    await assert.rejects(ready.client.invoke({
        requestId: 'composition-time-extra-input',
        capabilityId: 'ae.composition.time.read',
        capabilityVersion: 1,
        arguments: { ...argumentsValue, compositionName: 'Main' },
        deadlineUnixMs: 1900000002000,
    }), { code: 'INVALID_ARGUMENT', retryable: false });
    assert.equal(ready.protocol.requests.length, beforeInvalidInput);
});

for (const invalidUnicode of [
    { name: '1025 astral scalars', value: '😀'.repeat(1025) },
    { name: 'a lone surrogate', value: '\ud800' },
]) {
    test('CEP graph reads reject ' + invalidUnicode.name, {
        skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
    }, async (t) => {
        const ready = await readyNativeClient(t, {
            mutateInvoke: function (result) {
                if (result.capabilityId === 'ae.project.items.list') {
                    result.value.items[0].name = invalidUnicode.value;
                    rebindPostcondition(result);
                }
            },
        });
        await assert.rejects(ready.client.invoke({
            requestId: 'invalid-unicode-project-items',
            capabilityId: 'ae.project.items.list',
            capabilityVersion: 1,
            arguments: { offset: 0, limit: 25 },
            deadlineUnixMs: 1900000002000,
        }), { code: 'NATIVE_CONTRACT_MISMATCH', retryable: false });
    });
}

test('CEP graph reads reject non-advancing pages for all paged native capabilities', {
    skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
}, async (t) => {
    const ready = await readyNativeClient(t, {
        mutateInvoke: function (result) {
            if (![
                'ae.project.items.list', 'ae.composition.layers.list',
                'ae.composition.selected-layers.list',
                'ae.layer.properties.list',
                'ae.layer.property.keyframes.list',
            ].includes(
                result.capabilityId,
            )) return;
            const member = result.capabilityId === 'ae.project.items.list'
                ? 'items' : result.capabilityId === 'ae.composition.layers.list'
                    || result.capabilityId === 'ae.composition.selected-layers.list'
                    ? 'layers' : result.capabilityId
                        === 'ae.layer.property.keyframes.list'
                        ? 'keyframes' : 'properties';
            result.value.total = 1;
            result.value.returned = 0;
            result.value.hasMore = true;
            result.value.nextOffset = 0;
            result.value[member] = [];
            rebindPostcondition(result);
        },
    });
    await assert.rejects(ready.client.invoke({
        requestId: 'stalled-project-items',
        capabilityId: 'ae.project.items.list',
        capabilityVersion: 1,
        arguments: { offset: 0, limit: 25 },
        deadlineUnixMs: 1900000002000,
    }), { code: 'NATIVE_CONTRACT_MISMATCH' });
    await assert.rejects(ready.client.invoke({
        requestId: 'stalled-composition-layers',
        capabilityId: 'ae.composition.layers.list',
        capabilityVersion: 1,
        arguments: {
            compositionLocator: COMPOSITION_LAYERS_VECTOR.request.params.arguments.compositionLocator,
            offset: 0,
            limit: 25,
        },
        deadlineUnixMs: 1900000002000,
    }), { code: 'NATIVE_CONTRACT_MISMATCH' });
    await assert.rejects(ready.client.invoke({
        requestId: 'stalled-composition-selected-layers',
        capabilityId: 'ae.composition.selected-layers.list',
        capabilityVersion: 1,
        arguments: structuredClone(
            COMPOSITION_SELECTED_LAYERS_VECTOR.request.params.arguments,
        ),
        deadlineUnixMs: 1900000002000,
    }), { code: 'NATIVE_CONTRACT_MISMATCH' });
    await assert.rejects(ready.client.invoke({
        requestId: 'stalled-layer-properties',
        capabilityId: 'ae.layer.properties.list',
        capabilityVersion: 1,
        arguments: structuredClone(LAYER_PROPERTIES_VECTOR.request.params.arguments),
        deadlineUnixMs: 1900000002000,
    }), { code: 'NATIVE_CONTRACT_MISMATCH' });
    await assert.rejects(ready.client.invoke({
        requestId: 'stalled-layer-property-keyframes',
        capabilityId: 'ae.layer.property.keyframes.list',
        capabilityVersion: 1,
        arguments: structuredClone(
            LAYER_PROPERTY_KEYFRAMES_VECTOR.request.params.arguments,
        ),
        deadlineUnixMs: 1900000002000,
    }), { code: 'NATIVE_CONTRACT_MISMATCH' });
});

test('CEP keyframe reads enforce exact order, time, primitive type, and interpolation', {
    skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
}, async (t) => {
    const mutations = new Map([
        ['keyframe-bad-index', function (value) {
            value.keyframes[1].keyframeIndex = 3;
        }],
        ['keyframe-bad-time', function (value) {
            value.keyframes[1].time = { value: 0, scale: 24, mode: 'comp-time' };
        }],
        ['keyframe-bad-type', function (value) {
            value.keyframes[0].value = { kind: 'vector', components: ['1', '2'] };
        }],
        ['keyframe-bad-interpolation', function (value) {
            value.keyframes[0].inInterpolation = 'auto';
        }],
        ['keyframe-locator-drift', function (value) {
            value.propertyLocator.objectId =
                '99999999-9999-4999-8999-999999999999';
        }],
        ['keyframe-bad-pagination', function (value) {
            value.nextOffset = 1;
        }],
    ]);
    const ready = await readyNativeClient(t, {
        mutateInvoke: function (result, request) {
            if (result.capabilityId !== 'ae.layer.property.keyframes.list') return;
            const mutate = mutations.get(request.requestId);
            if (mutate) mutate(result.value);
            rebindPostcondition(result);
        },
    });
    const argumentsValue = structuredClone(
        LAYER_PROPERTY_KEYFRAMES_VECTOR.request.params.arguments,
    );
    const accepted = await ready.client.invoke({
        requestId: 'keyframe-good',
        capabilityId: 'ae.layer.property.keyframes.list',
        capabilityVersion: 1,
        arguments: argumentsValue,
        deadlineUnixMs: 1900000002000,
    });
    assert.equal(accepted.value.keyframes[1].outInterpolation, 'hold');

    for (const requestId of mutations.keys()) {
        await assert.rejects(ready.client.invoke({
            requestId,
            capabilityId: 'ae.layer.property.keyframes.list',
            capabilityVersion: 1,
            arguments: argumentsValue,
            deadlineUnixMs: 1900000002000,
        }), { code: 'NATIVE_CONTRACT_MISMATCH', retryable: false });
    }

    const beforeInvalid = ready.protocol.requests.length;
    await assert.rejects(ready.client.invoke({
        requestId: 'keyframe-extra-input',
        capabilityId: 'ae.layer.property.keyframes.list',
        capabilityVersion: 1,
        arguments: { ...argumentsValue, layerLocator: argumentsValue.propertyLocator },
        deadlineUnixMs: 1900000002000,
    }), { code: 'INVALID_ARGUMENT', retryable: false });
    assert.equal(ready.protocol.requests.length, beforeInvalid);
});

test('CEP layer-property reads enforce the closed locator and decimal value union', {
    skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
}, async (t) => {
    const mutations = new Map([
        ['decimal-wide-valid', function (value) {
            value.properties[1].value.value = '0.20000000000000001';
        }],
        ['vector-three-d-valid', function (value) {
            value.properties[0].valueType = 'three-d';
            value.properties[0].value.components.push('30');
        }],
        ['root-parent-omitted', function (value) {
            value.parentPropertyLocator = null;
        }],
        ['root-parent-null', function (value) {
            value.parentPropertyLocator = null;
        }],
        ['decimal-negative-zero', function (value) {
            value.properties[1].value.value = '-0.0';
        }],
        ['decimal-underflow', function (value) {
            value.properties[1].value.value = '1e-999';
        }],
        ['decimal-non-finite', function (value) {
            value.properties[1].value.value = '1e999';
        }],
        ['vector-wrong-dimension', function (value) {
            value.properties[0].value.components = ['10'];
        }],
        ['two-d-three-components', function (value) {
            value.properties[0].value.components.push('30');
        }],
        ['three-d-two-components', function (value) {
            value.properties[0].valueType = 'three-d';
        }],
        ['unsupported-has-value', function (value) {
            value.properties[2].value = { kind: 'scalar', value: '1' };
        }],
        ['property-context-drift', function (value) {
            value.properties[0].propertyLocator.projectId =
                'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
        }],
        ['duplicate-property-locator', function (value) {
            value.properties[1].propertyLocator = structuredClone(
                value.properties[0].propertyLocator,
            );
        }],
        ['property-index-drift', function (value) {
            value.properties[0].propertyIndex = 2;
        }],
        ['sample-time-scale-zero', function (value) {
            value.sampleTime.scale = 0;
        }],
        ['group-carries-sample', function (value) {
            value.properties[0].groupingType = 'named-group';
            value.properties[0].childCount = 1;
        }],
    ]);
    const ready = await readyNativeClient(t, {
        mutateInvoke: function (result, request) {
            if (result.capabilityId !== 'ae.layer.properties.list') return;
            const mutate = mutations.get(request.requestId);
            if (mutate) mutate(result.value);
            rebindPostcondition(result);
        },
    });
    const argumentsValue = structuredClone(
        LAYER_PROPERTIES_VECTOR.request.params.arguments,
    );
    const accepted = await ready.client.invoke({
        requestId: 'decimal-wide-valid',
        capabilityId: 'ae.layer.properties.list',
        capabilityVersion: 1,
        arguments: argumentsValue,
        deadlineUnixMs: 1900000002000,
    });
    assert.equal(accepted.value.properties[1].value.value, '0.20000000000000001');
    const acceptedThreeD = await ready.client.invoke({
        requestId: 'vector-three-d-valid',
        capabilityId: 'ae.layer.properties.list',
        capabilityVersion: 1,
        arguments: argumentsValue,
        deadlineUnixMs: 1900000002000,
    });
    assert.deepEqual(
        acceptedThreeD.value.properties[0].value.components,
        ['10', '20', '30'],
    );
    const rootArguments = structuredClone(argumentsValue);
    delete rootArguments.parentPropertyLocator;
    const rootPage = await ready.client.invoke({
        requestId: 'root-parent-omitted',
        capabilityId: 'ae.layer.properties.list',
        capabilityVersion: 1,
        arguments: rootArguments,
        deadlineUnixMs: 1900000002000,
    });
    assert.equal(rootPage.value.parentPropertyLocator, null);
    const omittedParentRequest = ready.protocol.requests.at(-1);
    assert.equal(
        Object.hasOwn(omittedParentRequest.params.arguments, 'parentPropertyLocator'),
        false,
    );
    const explicitNullArguments = structuredClone(argumentsValue);
    explicitNullArguments.parentPropertyLocator = null;
    const explicitNullPage = await ready.client.invoke({
        requestId: 'root-parent-null',
        capabilityId: 'ae.layer.properties.list',
        capabilityVersion: 1,
        arguments: explicitNullArguments,
        deadlineUnixMs: 1900000002000,
    });
    assert.equal(explicitNullPage.value.parentPropertyLocator, null);
    const explicitNullRequest = ready.protocol.requests.at(-1);
    assert.equal(
        Object.hasOwn(explicitNullRequest.params.arguments, 'parentPropertyLocator'),
        false,
    );
    const comparableOmittedRequest = structuredClone(omittedParentRequest);
    comparableOmittedRequest.requestId = explicitNullRequest.requestId;
    assert.deepEqual(explicitNullRequest, comparableOmittedRequest);
    assert.equal(
        explicitNullPage.evidence.requestDigest,
        invokeRequestDigest(explicitNullRequest),
    );

    for (const requestId of Array.from(mutations.keys()).slice(4)) {
        await assert.rejects(ready.client.invoke({
            requestId,
            capabilityId: 'ae.layer.properties.list',
            capabilityVersion: 1,
            arguments: argumentsValue,
            deadlineUnixMs: 1900000002000,
        }), { code: 'NATIVE_CONTRACT_MISMATCH', retryable: false });
    }
});

test('CEP layer-property mutation preserves typed native evidence and idempotency', {
    skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
}, async (t) => {
    const ready = await readyNativeClient(t, {
        mutateInvoke: function (result, request) {
            if (request.requestId === 'layer-property-set-client-uncertain') {
                result.evidence.postcondition.digest = '0'.repeat(64);
            } else if (request.requestId === 'layer-property-set-client-vector') {
                result.value.valueType = 'two-d';
                result.value.beforeValue = { components: ['10', '20'], kind: 'vector' };
                result.value.afterValue = { components: ['40', '50'], kind: 'vector' };
                result.evidence.postcondition.digest = jcsDigest({
                    capabilityId: result.capabilityId,
                    capabilityVersion: result.capabilityVersion,
                    value: result.value,
                });
            } else if (request.requestId === 'layer-property-set-client-color') {
                result.value.valueType = 'color';
                result.value.beforeValue = {
                    alpha: '1', blue: '0.1', green: '0.1', kind: 'color', red: '0.1',
                };
                result.value.afterValue = {
                    alpha: '1', blue: '0.3', green: '0.2', kind: 'color', red: '0.1',
                };
                result.evidence.postcondition.digest = jcsDigest({
                    capabilityId: result.capabilityId,
                    capabilityVersion: result.capabilityVersion,
                    value: result.value,
                });
            }
        },
    });
    const argumentsValue = structuredClone(
        LAYER_PROPERTY_SET_VECTOR.request.params.arguments,
    );
    const result = await ready.client.invoke({
        requestId: 'layer-property-set-client-1',
        capabilityId: 'ae.layer.property.set',
        capabilityVersion: 1,
        arguments: argumentsValue,
        deadlineUnixMs: 1900000002000,
    });
    assert.equal(result.value.changed, true);
    assert.deepEqual(result.value.afterValue, argumentsValue.value);
    assert.deepEqual(result.evidence.undo, {
        available: true,
        verified: false,
    });
    const sent = ready.protocol.requests.at(-1);
    assert.equal(sent.params.arguments.idempotencyKey, argumentsValue.idempotencyKey);
    assert.equal(result.evidence.requestDigest, invokeRequestDigest(sent));

    for (const [requestId, value] of [
        ['layer-property-set-client-vector', {
            kind: 'vector', components: ['4e1', '50.0'],
        }],
        ['layer-property-set-client-color', {
            kind: 'color', alpha: '1.0', red: '0.10', green: '2e-1', blue: '0.30',
        }],
    ]) {
        const typedArguments = structuredClone(argumentsValue);
        typedArguments.value = value;
        typedArguments.idempotencyKey = requestId + '-intent';
        const typedResult = await ready.client.invoke({
            requestId,
            capabilityId: 'ae.layer.property.set',
            capabilityVersion: 1,
            arguments: typedArguments,
            deadlineUnixMs: 1900000002000,
        });
        assert.equal(typedResult.value.afterValue.kind, value.kind);
    }

    const uncertainArguments = structuredClone(argumentsValue);
    uncertainArguments.idempotencyKey = 'synthetic-property-uncertain-0001';
    await assert.rejects(ready.client.invoke({
        requestId: 'layer-property-set-client-uncertain',
        capabilityId: 'ae.layer.property.set',
        capabilityVersion: 1,
        arguments: uncertainArguments,
        deadlineUnixMs: 1900000002000,
    }), {
        code: 'POSSIBLY_SIDE_EFFECTING_FAILURE',
        retryable: false,
        sideEffect: 'may-have-occurred',
    });
});

test('CEP composition-time mutation preserves exact rational intent and uncertain failures', {
    skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
}, async (t) => {
    const ready = await readyNativeClient(t, {
        mutateInvoke: function (result, request) {
            if (request.requestId === 'composition-time-set-client-uncertain') {
                result.evidence.postcondition.digest = '0'.repeat(64);
            }
        },
    });
    const argumentsValue = structuredClone(
        COMPOSITION_TIME_SET_VECTOR.request.params.arguments,
    );
    const result = await ready.client.invoke({
        requestId: 'composition-time-set-client-1',
        capabilityId: 'ae.composition.time.set',
        capabilityVersion: 1,
        arguments: argumentsValue,
        deadlineUnixMs: 1900000002000,
    });
    assert.equal(result.value.changed, true);
    assert.deepEqual(result.value.afterTime, {
        value: 1, scale: 1, secondsRational: '1',
    });
    assert.deepEqual(result.evidence.undo, {
        available: true,
        verified: false,
    });
    const sent = ready.protocol.requests.at(-1);
    assert.deepEqual(sent.params.arguments.targetTime, { value: 1, scale: 1 });
    assert.equal(sent.params.arguments.idempotencyKey, argumentsValue.idempotencyKey);
    assert.equal(result.evidence.requestDigest, invokeRequestDigest(sent));

    const requestCount = ready.protocol.requests.length;
    const invalidArguments = structuredClone(argumentsValue);
    invalidArguments.targetTime.scale = 0;
    await assert.rejects(ready.client.invoke({
        requestId: 'composition-time-set-client-invalid',
        capabilityId: 'ae.composition.time.set',
        capabilityVersion: 1,
        arguments: invalidArguments,
        deadlineUnixMs: 1900000002000,
    }), { code: 'INVALID_ARGUMENT', retryable: false });
    assert.equal(ready.protocol.requests.length, requestCount);

    const uncertainArguments = structuredClone(argumentsValue);
    uncertainArguments.idempotencyKey = 'synthetic-comp-time-uncertain-0001';
    await assert.rejects(ready.client.invoke({
        requestId: 'composition-time-set-client-uncertain',
        capabilityId: 'ae.composition.time.set',
        capabilityVersion: 1,
        arguments: uncertainArguments,
        deadlineUnixMs: 1900000002000,
    }), {
        code: 'POSSIBLY_SIDE_EFFECTING_FAILURE',
        retryable: false,
        sideEffect: 'may-have-occurred',
    });
});

test('CEP composition create verifies settings, replay, and uncertain failures', {
    skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
}, async (t) => {
    const ready = await readyNativeClient(t, {
        compositionCreateReplayedRequestId: 'composition-create-client-replay',
        mutateInvoke: function (result, request) {
            if (request.requestId === 'composition-create-client-uncertain') {
                result.evidence.postcondition.digest = '0'.repeat(64);
            }
        },
    });
    const argumentsValue = structuredClone(
        COMPOSITION_CREATE_VECTOR.request.params.arguments,
    );
    const created = await ready.client.invoke({
        requestId: 'composition-create-client-1',
        capabilityId: 'ae.composition.create',
        capabilityVersion: 1,
        arguments: argumentsValue,
        deadlineUnixMs: 1900000005000,
    });
    assert.equal(created.replayed, false);
    assert.equal(created.value.name, 'SYNTHETIC_COMP');
    assert.equal(created.value.projectItemCountAfter, 2);
    assert.deepEqual(created.value.duration, {
        value: 5, scale: 1, secondsRational: '5',
    });
    assert.deepEqual(created.value.frameRate, {
        numerator: 24, denominator: 1, rational: '24',
    });
    assert.deepEqual(created.evidence.undo, { available: true, verified: false });
    const sent = ready.protocol.requests.at(-1);
    assert.deepEqual(sent.params.arguments, argumentsValue);
    assert.equal(created.evidence.requestDigest, invokeRequestDigest(sent));

    const replayed = await ready.client.invoke({
        requestId: 'composition-create-client-replay',
        capabilityId: 'ae.composition.create',
        capabilityVersion: 1,
        arguments: argumentsValue,
        deadlineUnixMs: 1900000005000,
    });
    assert.equal(replayed.replayed, true);
    assert.deepEqual(replayed.value, created.value);

    const requestCount = ready.protocol.requests.length;
    const invalidArguments = structuredClone(argumentsValue);
    invalidArguments.duration.value = 0;
    await assert.rejects(ready.client.invoke({
        requestId: 'composition-create-client-invalid',
        capabilityId: 'ae.composition.create',
        capabilityVersion: 1,
        arguments: invalidArguments,
        deadlineUnixMs: 1900000005000,
    }), { code: 'INVALID_ARGUMENT', retryable: false });
    assert.equal(ready.protocol.requests.length, requestCount);

    const nulNameArguments = structuredClone(argumentsValue);
    nulNameArguments.name = 'SYNTHETIC\u0000COMP';
    await assert.rejects(ready.client.invoke({
        requestId: 'composition-create-client-nul',
        capabilityId: 'ae.composition.create',
        capabilityVersion: 1,
        arguments: nulNameArguments,
        deadlineUnixMs: 1900000005000,
    }), { code: 'INVALID_ARGUMENT', retryable: false });
    assert.equal(ready.protocol.requests.length, requestCount);

    const uncertainArguments = structuredClone(argumentsValue);
    uncertainArguments.idempotencyKey = 'synthetic-comp-create-uncertain-0001';
    await assert.rejects(ready.client.invoke({
        requestId: 'composition-create-client-uncertain',
        capabilityId: 'ae.composition.create',
        capabilityVersion: 1,
        arguments: uncertainArguments,
        deadlineUnixMs: 1900000005000,
    }), {
        code: 'POSSIBLY_SIDE_EFFECTING_FAILURE',
        retryable: false,
        sideEffect: 'may-have-occurred',
    });
});

test('CEP composition-layer create verifies options, replay, and uncertain failures', {
    skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
}, async (t) => {
    const ready = await readyNativeClient(t, {
        createReplayedRequestId: 'composition-layer-create-client-replay',
        mutateInvoke: function (result, request) {
            if (request.requestId === 'composition-layer-create-client-uncertain') {
                result.evidence.postcondition.digest = '0'.repeat(64);
            }
        },
    });
    const argumentsValue = structuredClone(
        COMPOSITION_LAYER_CREATE_VECTOR.request.params.arguments,
    );
    const created = await ready.client.invoke({
        requestId: 'composition-layer-create-client-1',
        capabilityId: 'ae.composition.layer.create',
        capabilityVersion: 1,
        arguments: argumentsValue,
        deadlineUnixMs: 1900000005000,
    });
    assert.equal(created.replayed, false);
    assert.equal(created.value.kind, 'solid');
    assert.deepEqual(created.value.solid, {
        color: { red: 12, green: 34, blue: 56, alpha: 255 },
        width: 640,
        height: 360,
        duration: { value: 5, scale: 1, secondsRational: '5' },
    });
    assert.deepEqual(created.evidence.undo, { available: true, verified: false });
    const sent = ready.protocol.requests.at(-1);
    assert.deepEqual(sent.params.arguments, argumentsValue);
    assert.equal(created.evidence.requestDigest, invokeRequestDigest(sent));

    const replayed = await ready.client.invoke({
        requestId: 'composition-layer-create-client-replay',
        capabilityId: 'ae.composition.layer.create',
        capabilityVersion: 1,
        arguments: argumentsValue,
        deadlineUnixMs: 1900000005000,
    });
    assert.equal(replayed.replayed, true);
    assert.deepEqual(replayed.value, created.value);

    const requestCount = ready.protocol.requests.length;
    const invalidArguments = {
        compositionLocator: argumentsValue.compositionLocator,
        kind: 'null',
        name: 'Invalid Null',
        width: 640,
        idempotencyKey: 'synthetic-null-invalid-0001',
    };
    await assert.rejects(ready.client.invoke({
        requestId: 'composition-layer-create-client-invalid',
        capabilityId: 'ae.composition.layer.create',
        capabilityVersion: 1,
        arguments: invalidArguments,
        deadlineUnixMs: 1900000005000,
    }), { code: 'INVALID_ARGUMENT', retryable: false });
    assert.equal(ready.protocol.requests.length, requestCount);

    const uncertainArguments = structuredClone(argumentsValue);
    uncertainArguments.idempotencyKey = 'synthetic-layer-create-uncertain-0001';
    await assert.rejects(ready.client.invoke({
        requestId: 'composition-layer-create-client-uncertain',
        capabilityId: 'ae.composition.layer.create',
        capabilityVersion: 1,
        arguments: uncertainArguments,
        deadlineUnixMs: 1900000005000,
    }), {
        code: 'POSSIBLY_SIDE_EFFECTING_FAILURE',
        retryable: false,
        sideEffect: 'may-have-occurred',
    });
});

test('CEP layer-effect apply verifies identity, replay, and uncertain failures', {
    skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
}, async (t) => {
    const ready = await readyNativeClient(t, {
        effectApplyReplayedRequestId: 'layer-effect-apply-client-replay',
        mutateInvoke: function (result, request) {
            if (request.requestId === 'layer-effect-apply-client-uncertain') {
                result.evidence.postcondition.digest = '0'.repeat(64);
            }
        },
    });
    const argumentsValue = structuredClone(
        LAYER_EFFECT_APPLY_VECTOR.request.params.arguments,
    );
    const applied = await ready.client.invoke({
        requestId: 'layer-effect-apply-client-1',
        capabilityId: 'ae.layer.effect.apply',
        capabilityVersion: 1,
        arguments: argumentsValue,
        deadlineUnixMs: 1900000005000,
    });
    assert.equal(applied.replayed, false);
    assert.equal(applied.value.matchName, 'ADBE Slider Control');
    assert.equal(applied.value.effectCountAfter, applied.value.effectCountBefore + 1);
    assert.equal(
        applied.value.matchingEffectCountAfter,
        applied.value.matchingEffectCountBefore + 1,
    );
    assert.deepEqual(applied.evidence.undo, { available: true, verified: false });
    const sent = ready.protocol.requests.at(-1);
    assert.deepEqual(sent.params.arguments, argumentsValue);
    assert.equal(applied.evidence.requestDigest, invokeRequestDigest(sent));

    const replayed = await ready.client.invoke({
        requestId: 'layer-effect-apply-client-replay',
        capabilityId: 'ae.layer.effect.apply',
        capabilityVersion: 1,
        arguments: argumentsValue,
        deadlineUnixMs: 1900000005000,
    });
    assert.equal(replayed.replayed, true);
    assert.deepEqual(replayed.value, applied.value);

    const requestCount = ready.protocol.requests.length;
    const invalidArguments = structuredClone(argumentsValue);
    invalidArguments.effectMatchName = 'x'.repeat(48);
    await assert.rejects(ready.client.invoke({
        requestId: 'layer-effect-apply-client-invalid',
        capabilityId: 'ae.layer.effect.apply',
        capabilityVersion: 1,
        arguments: invalidArguments,
        deadlineUnixMs: 1900000005000,
    }), { code: 'INVALID_ARGUMENT', retryable: false });
    assert.equal(ready.protocol.requests.length, requestCount);

    const uncertainArguments = structuredClone(argumentsValue);
    uncertainArguments.idempotencyKey = 'synthetic-effect-apply-uncertain-0001';
    await assert.rejects(ready.client.invoke({
        requestId: 'layer-effect-apply-client-uncertain',
        capabilityId: 'ae.layer.effect.apply',
        capabilityVersion: 1,
        arguments: uncertainArguments,
        deadlineUnixMs: 1900000005000,
    }), {
        code: 'POSSIBLY_SIDE_EFFECTING_FAILURE',
        retryable: false,
        sideEffect: 'may-have-occurred',
    });
});

test('CEP stale-locator preflight reports the exact field without inventing generation', {
    skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
}, async (t) => {
    const ready = await readyNativeClient(t);
    const staleSession = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const overLimitArguments = structuredClone(
        LAYER_PROPERTIES_VECTOR.request.params.arguments,
    );
    overLimitArguments.limit = 26;
    await assert.rejects(ready.client.invoke({
        requestId: 'over-limit-layer-properties',
        capabilityId: 'ae.layer.properties.list',
        capabilityVersion: 1,
        arguments: overLimitArguments,
        deadlineUnixMs: 1900000002000,
    }), { code: 'INVALID_ARGUMENT', retryable: false });
    const projectLocator = structuredClone(
        PROJECT_ITEMS_VECTOR.response.result.value.projectLocator,
    );
    projectLocator.sessionId = staleSession;
    await assert.rejects(ready.client.invoke({
        requestId: 'stale-project-locator',
        capabilityId: 'ae.project.items.list',
        capabilityVersion: 1,
        arguments: { projectLocator, offset: 1, limit: 25 },
        deadlineUnixMs: 1900000002000,
    }), function (error) {
        assert.equal(error.code, 'STALE_LOCATOR');
        assert.deepEqual(error.details, {
            field: 'params.arguments.projectLocator',
            capabilityId: 'ae.project.items.list',
        });
        assert.equal(Object.hasOwn(error.details, 'currentGeneration'), false);
        return true;
    });

    const compositionLocator = structuredClone(
        COMPOSITION_LAYERS_VECTOR.request.params.arguments.compositionLocator,
    );
    compositionLocator.sessionId = staleSession;
    await assert.rejects(ready.client.invoke({
        requestId: 'stale-composition-locator',
        capabilityId: 'ae.composition.layers.list',
        capabilityVersion: 1,
        arguments: { compositionLocator, offset: 0, limit: 25 },
        deadlineUnixMs: 1900000002000,
    }), function (error) {
        assert.equal(error.code, 'STALE_LOCATOR');
        assert.deepEqual(error.details, {
            field: 'params.arguments.compositionLocator',
            capabilityId: 'ae.composition.layers.list',
        });
        assert.equal(Object.hasOwn(error.details, 'currentGeneration'), false);
        return true;
    });
    await assert.rejects(ready.client.invoke({
        requestId: 'stale-selected-composition-locator',
        capabilityId: 'ae.composition.selected-layers.list',
        capabilityVersion: 1,
        arguments: { compositionLocator, offset: 0, limit: 25 },
        deadlineUnixMs: 1900000002000,
    }), function (error) {
        assert.equal(error.code, 'STALE_LOCATOR');
        assert.deepEqual(error.details, {
            field: 'params.arguments.compositionLocator',
            capabilityId: 'ae.composition.selected-layers.list',
        });
        assert.equal(Object.hasOwn(error.details, 'currentGeneration'), false);
        return true;
    });
    await assert.rejects(ready.client.invoke({
        requestId: 'stale-composition-time-locator',
        capabilityId: 'ae.composition.time.read',
        capabilityVersion: 1,
        arguments: { compositionLocator },
        deadlineUnixMs: 1900000002000,
    }), function (error) {
        assert.equal(error.code, 'STALE_LOCATOR');
        assert.deepEqual(error.details, {
            field: 'params.arguments.compositionLocator',
            capabilityId: 'ae.composition.time.read',
        });
        assert.equal(Object.hasOwn(error.details, 'currentGeneration'), false);
        return true;
    });

    const staleLayerArguments = structuredClone(
        LAYER_PROPERTIES_VECTOR.request.params.arguments,
    );
    staleLayerArguments.layerLocator.sessionId = staleSession;
    staleLayerArguments.parentPropertyLocator.sessionId = staleSession;
    await assert.rejects(ready.client.invoke({
        requestId: 'stale-layer-locator',
        capabilityId: 'ae.layer.properties.list',
        capabilityVersion: 1,
        arguments: staleLayerArguments,
        deadlineUnixMs: 1900000002000,
    }), function (error) {
        assert.equal(error.code, 'STALE_LOCATOR');
        assert.deepEqual(error.details, {
            field: 'params.arguments.layerLocator',
            capabilityId: 'ae.layer.properties.list',
        });
        return true;
    });

    const crossLayerArguments = structuredClone(
        LAYER_PROPERTIES_VECTOR.request.params.arguments,
    );
    crossLayerArguments.parentPropertyLocator.projectId =
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    await assert.rejects(ready.client.invoke({
        requestId: 'cross-layer-parent-locator',
        capabilityId: 'ae.layer.properties.list',
        capabilityVersion: 1,
        arguments: crossLayerArguments,
        deadlineUnixMs: 1900000002000,
    }), function (error) {
        assert.equal(error.code, 'STALE_LOCATOR');
        assert.deepEqual(error.details, {
            field: 'params.arguments.parentPropertyLocator',
            capabilityId: 'ae.layer.properties.list',
        });
        return true;
    });
    assert.deepEqual(
        ready.protocol.requests.map(function (request) { return request.method; }),
        ['hello', 'capabilities'],
    );
});

test('CEP client preserves the bit-depth no-op INVALID_ARGUMENT contract', {
    skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
}, async (t) => {
    const fixture = await endpointFixture(t);
    const protocol = installProtocol(fixture.server, {
        invokeError: {
            code: 'INVALID_ARGUMENT',
            message: 'targetDepth already matches the open project.',
            retryable: false,
            sideEffect: 'not-started',
            recovery: {
                action: 'change-arguments',
                hint: 'Choose a targetDepth that differs from the current project bit depth.',
            },
            details: { field: 'params.arguments.targetDepth' },
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
            requestId: 'core-bit-depth-no-op',
            capabilityId: 'ae.project.bit-depth.set',
            capabilityVersion: 1,
            arguments: {
                targetDepth: 16,
                idempotencyKey: 'bit-depth-intent-no-op',
            },
            deadlineUnixMs: 1900000002000,
        }),
        function (error) {
            assert.equal(error.code, 'INVALID_ARGUMENT');
            assert.equal(error.retryable, false);
            assert.equal(error.sideEffect, 'not-started');
            assert.equal(error.recovery.action, 'change-arguments');
            assert.deepEqual(error.details, { field: 'params.arguments.targetDepth' });
            return true;
        },
    );
});

test('CEP client treats unverifiable bit-depth write evidence as side-effect uncertain', {
    skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
}, async (t) => {
    const fixture = await endpointFixture(t);
    const protocol = installProtocol(fixture.server, {
        mutateInvoke: function (result, request) {
            if (request.params.capabilityId === 'ae.project.bit-depth.set') {
                result.value.beforeBitsPerChannel = result.value.afterBitsPerChannel;
            }
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
            requestId: 'core-bit-depth-unverifiable',
            capabilityId: 'ae.project.bit-depth.set',
            capabilityVersion: 1,
            arguments: {
                targetDepth: 16,
                idempotencyKey: 'bit-depth-intent-bad-evidence',
            },
            deadlineUnixMs: 1900000002000,
        }),
        function (error) {
            assert.equal(error.code, 'POSSIBLY_SIDE_EFFECTING_FAILURE');
            assert.equal(error.retryable, false);
            assert.equal(error.sideEffect, 'may-have-occurred');
            assert.equal(error.recovery.action, 'inspect-state');
            assert.deepEqual(error.details, { capabilityId: 'ae.project.bit-depth.set' });
            return true;
        },
    );
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

test('CEP client preserves actionable keyframe property precondition recovery', {
    skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
}, async (t) => {
    const fixture = await endpointFixture(t);
    const protocol = installProtocol(fixture.server, {
        invokeError: {
            code: 'PRECONDITION_FAILED',
            message: 'property must be a keyframeable primitive leaf stream',
            retryable: false,
            sideEffect: 'not-started',
            recovery: {
                action: 'change-arguments',
                hint: 'Copy a keyframeable primitive scalar, vector, or color leaf locator from ae_listLayerProperties.',
            },
            details: {
                capabilityId: 'ae.layer.property.keyframes.list',
                field: 'params.arguments.propertyLocator',
            },
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
            requestId: 'core-keyframe-precondition',
            capabilityId: 'ae.layer.property.keyframes.list',
            capabilityVersion: 1,
            arguments: structuredClone(
                LAYER_PROPERTY_KEYFRAMES_VECTOR.request.params.arguments,
            ),
            deadlineUnixMs: 1900000002000,
        }),
        function (error) {
            assert.equal(error.code, 'PRECONDITION_FAILED');
            assert.equal(error.retryable, false);
            assert.equal(error.sideEffect, 'not-started');
            assert.equal(error.recovery.action, 'change-arguments');
            assert.equal(error.recovery.hint,
                'Copy a keyframeable primitive scalar, vector, or color leaf locator from ae_listLayerProperties.');
            assert.deepEqual(error.details, {
                capabilityId: 'ae.layer.property.keyframes.list',
                field: 'params.arguments.propertyLocator',
            });
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
    {
        name: 'rejects replayed failure envelopes as a broker contract mismatch',
        error: {
            code: 'INVALID_REQUEST',
            message: 'native request was invalid',
            retryable: false,
            sideEffect: 'not-started',
            recovery: { action: 'none', hint: 'Do not retry this request.' },
        },
        errorReplayed: true,
        expectedCode: 'NATIVE_CONTRACT_MISMATCH',
        expectedAction: 'refresh-capabilities',
    },
]) {
    test('CEP client ' + errorFixture.name, {
        skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
    }, async (t) => {
        const fixture = await endpointFixture(t);
        const protocol = installProtocol(fixture.server, {
            invokeError: errorFixture.error,
            errorReplayed: errorFixture.errorReplayed,
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

test('CEP client treats a malformed mutation error as side-effect uncertain', {
    skip: process.platform === 'win32' ? 'Unix-domain sockets are not available on Windows CI' : false,
}, async (t) => {
    const fixture = await endpointFixture(t);
    const protocol = installProtocol(fixture.server, {
        invokeError: {
            code: 'PRECONDITION_FAILED',
            message: 'missing recovery fields',
            retryable: false,
            sideEffect: 'not-started',
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
    await assert.rejects(client.invoke({
        requestId: 'layer-property-malformed-error',
        capabilityId: 'ae.layer.property.set',
        capabilityVersion: 1,
        arguments: structuredClone(LAYER_PROPERTY_SET_VECTOR.request.params.arguments),
        deadlineUnixMs: 1900000002000,
    }), {
        code: 'POSSIBLY_SIDE_EFFECTING_FAILURE',
        retryable: false,
        sideEffect: 'may-have-occurred',
    });
});

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
