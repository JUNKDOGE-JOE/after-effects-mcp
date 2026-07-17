// Tests for auth-token helpers and that the server wires the token header into
// /exec (401 without, 200 with). Uses node --test plus Node's built-in http to
// drive the real Express app on an ephemeral loopback port — no supertest.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bundledExpressFixture = require('express');
const brokerFailureFixtures = Object.values(require(
    '../../native/ae-plugin/protocol/fixtures/broker-http-errors.json'
));
const nativeCapabilitiesFixture = require(
    '../../native/ae-plugin/protocol/fixtures/capabilities.json'
).response.result;
const projectItemsFixture = require(
    '../../native/ae-plugin/protocol/fixtures/invoke-project-items-list.json'
).response.result;
const compositionLayersFixture = require(
    '../../native/ae-plugin/protocol/fixtures/invoke-composition-layers-list.json'
).response.result;
const compositionSelectedLayersFixture = require(
    '../../native/ae-plugin/protocol/fixtures/invoke-composition-selected-layers-list.json'
).response.result;
const compositionTimeFixture = require(
    '../../native/ae-plugin/protocol/fixtures/invoke-composition-time-read.json'
).response.result;
const compositionTimeSetVector = require(
    '../../native/ae-plugin/protocol/fixtures/invoke-composition-time-set.json'
);
const compositionTimeSetFixture = compositionTimeSetVector.response.result;
const compositionCreateVector = require(
    '../../native/ae-plugin/protocol/fixtures/invoke-composition-create.json'
);
const compositionCreateFixture = compositionCreateVector.response.result;
const compositionLayerCreateVector = require(
    '../../native/ae-plugin/protocol/fixtures/invoke-composition-layer-create.json'
);
const compositionLayerCreateFixture = compositionLayerCreateVector.response.result;
const layerEffectApplyVector = require(
    '../../native/ae-plugin/protocol/fixtures/invoke-layer-effect-apply.json'
);
const layerEffectApplyFixture = layerEffectApplyVector.response.result;
const layerPropertiesVector = require(
    '../../native/ae-plugin/protocol/fixtures/invoke-layer-properties-list.json'
);
const layerPropertiesFixture = layerPropertiesVector.response.result;
const layerPropertyKeyframesVector = require(
    '../../native/ae-plugin/protocol/fixtures/invoke-layer-property-keyframes-list.json'
);
const layerPropertyKeyframesFixture = layerPropertyKeyframesVector.response.result;
const layerPropertySetVector = require(
    '../../native/ae-plugin/protocol/fixtures/invoke-layer-property-set.json'
);
const layerPropertySetFixture = layerPropertySetVector.response.result;

const authToken = require('./auth-token');

function bindRuntimeDependencies(server) {
    server.setRuntimeDependencies({ express: bundledExpressFixture });
    return server;
}

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

test('server requires explicit Express injection even when ambient local dependencies exist', () => {
    delete require.cache[require.resolve('./server')];
    const server = require('./server');
    assert.strictEqual(typeof server.setRuntimeDependencies, 'function');
    assert.throws(
        () => server.buildApp(),
        (error) => error && error.code === 'HOST_RUNTIME_DEPENDENCIES_UNAVAILABLE',
    );
});

test('secret helper capabilities are not exposed over HTTP routes', () => {
    const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    assert.doesNotMatch(source, /\.(?:get|post|put|delete|patch|use)\s*\(\s*['"]\/[^'"]*(?:secret|credential|helper)/i);
});

// ---- /exec auth wiring via the real Express app ----

function startApp() {
    delete require.cache[require.resolve('./server')];
    delete require.cache[require.resolve('./jsx-bridge')];
    const server = bindRuntimeDependencies(require('./server'));
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

async function startNativeApp(nativeClient) {
    delete require.cache[require.resolve('./server')];
    const server = bindRuntimeDependencies(require('./server'));
    server.activity._reset();
    server.setPaused(false);
    server._setExecToken('known-secret-token');
    server.setCSInterface({
        evalScript: function () {
            throw new Error('native HTTP routes must never call evalScript');
        },
    });
    server._setNativeAegpClientForTest(nativeClient);
    const app = server.buildApp();
    const srv = await new Promise((resolve) => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    return { server, srv, port: srv.address().port };
}

async function startExecAppWithNative(nativeClient, evalScript) {
    delete require.cache[require.resolve('./server')];
    delete require.cache[require.resolve('./jsx-bridge')];
    const server = bindRuntimeDependencies(require('./server'));
    server.activity._reset();
    server.setPaused(false);
    server._setExecToken('known-secret-token');
    server.setCSInterface({ evalScript });
    server._setNativeAegpClientForTest(nativeClient);
    const app = server.buildApp();
    const srv = await new Promise((resolve) => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    return { server, srv, port: srv.address().port };
}

function fakeNativeClient() {
    let state = 'disconnected';
    let closed = 0;
    const calls = [];
    const pending = {
        fingerprint: '12AB-34CD',
        expiresInMs: 60000,
        hostInstanceId: '22222222-2222-4222-8222-222222222222',
        sourceCommit: 'a'.repeat(40),
    };
    const sessionId = '11111111-1111-4111-8111-111111111111';
    return {
        beginPairing: async function () { calls.push('pair'); state = 'pairing-decision'; return pending; },
        waitUntilConnected: async function (deadlineUnixMs) {
            calls.push(['wait', deadlineUnixMs]);
            state = 'connected';
            return {};
        },
        negotiate: async function (options) {
            calls.push(['negotiate', options]);
            return {
                selectedWireVersion: 1,
                pluginVersion: '0.1.0-dev',
                compiledSdk: { version: '25.6.61' },
                sourceCommit: pending.sourceCommit,
                host: { instanceId: pending.hostInstanceId, platform: 'macos-arm64' },
                sessionId,
                sessionGeneration: 7,
                capabilitiesDigest: nativeCapabilitiesFixture.capabilitiesDigest,
            };
        },
        capabilities: async function (options) {
            calls.push(['capabilities', options]);
            return nativeCapabilitiesFixture;
        },
        invoke: async function (request) {
            calls.push(['invoke', request]);
            if (request.capabilityId === 'ae.composition.create') {
                const result = structuredClone(compositionCreateFixture);
                result.replayed = false;
                result.evidence.requestId = request.requestId;
                return result;
            }
            if (request.capabilityId === 'ae.composition.time.set') {
                const result = structuredClone(compositionTimeSetFixture);
                result.replayed = false;
                result.evidence.requestId = request.requestId;
                return result;
            }
            if (request.capabilityId === 'ae.composition.layer.create') {
                const result = structuredClone(compositionLayerCreateFixture);
                result.replayed = false;
                result.evidence.requestId = request.requestId;
                return result;
            }
            if (request.capabilityId === 'ae.layer.effect.apply') {
                const result = structuredClone(layerEffectApplyFixture);
                result.replayed = false;
                result.evidence.requestId = request.requestId;
                return result;
            }
            if (request.capabilityId === 'ae.layer.property.set') {
                const result = structuredClone(layerPropertySetFixture);
                result.replayed = false;
                result.evidence.requestId = request.requestId;
                return result;
            }
            if (request.capabilityId === 'ae.layer.property.keyframes.list') {
                const result = structuredClone(layerPropertyKeyframesFixture);
                result.replayed = false;
                result.evidence.requestId = request.requestId;
                return result;
            }
            if (request.capabilityId === 'ae.project.items.list'
                || request.capabilityId === 'ae.composition.layers.list'
                || request.capabilityId === 'ae.composition.selected-layers.list'
                || request.capabilityId === 'ae.composition.time.read'
                || request.capabilityId === 'ae.layer.properties.list') {
                const result = structuredClone(
                    request.capabilityId === 'ae.project.items.list'
                        ? projectItemsFixture
                        : request.capabilityId === 'ae.composition.layers.list'
                            ? compositionLayersFixture
                            : request.capabilityId
                                === 'ae.composition.selected-layers.list'
                                ? compositionSelectedLayersFixture
                            : request.capabilityId === 'ae.composition.time.read'
                                ? compositionTimeFixture : layerPropertiesFixture,
                );
                result.replayed = false;
                result.evidence.requestId = request.requestId;
                return result;
            }
            if (request.capabilityId === 'ae.project.bit-depth.set') {
                return {
                    capabilityId: 'ae.project.bit-depth.set',
                    capabilityVersion: 1,
                    engine: 'native-aegp',
                    replayed: false,
                    evidence: {
                        requestId: request.requestId,
                        requestDigest: 'b'.repeat(64),
                        effect: 'committed',
                        postcondition: { verified: true, digest: 'c'.repeat(64) },
                        undo: { available: true, verified: false },
                    },
                    value: {
                        changed: true,
                        beforeBitsPerChannel: 8,
                        afterBitsPerChannel: request.arguments.targetDepth,
                    },
                };
            }
            if (request.capabilityId === 'ae.project.bit-depth.read') {
                return {
                    capabilityId: 'ae.project.bit-depth.read',
                    capabilityVersion: 1,
                    engine: 'native-aegp',
                    replayed: false,
                    evidence: {
                        requestId: request.requestId,
                        requestDigest: 'b'.repeat(64),
                        effect: 'none',
                        postcondition: { verified: true, digest: 'c'.repeat(64) },
                    },
                    value: { bitsPerChannel: 8 },
                };
            }
            return {
                capabilityId: 'ae.project.summary',
                capabilityVersion: 1,
                engine: 'native-aegp',
                replayed: false,
                evidence: {
                    requestId: request.requestId,
                    requestDigest: 'b'.repeat(64),
                    postcondition: { verified: true, digest: 'c'.repeat(64) },
                },
                value: { projectOpen: true, projectName: 'Fixture.aep', itemCount: 2 },
            };
        },
        invalidateProjectGraph: async function (options) {
            calls.push(['invalidateProjectGraph', options]);
            return { generation: 8, invalidated: true };
        },
        status: function () {
            return {
                state,
                hostInstanceId: pending.hostInstanceId,
                sourceCommit: pending.sourceCommit,
                sessionId: state === 'connected' ? sessionId : null,
                sessionGeneration: state === 'connected' ? 7 : null,
                capabilitiesDigest: nativeCapabilitiesFixture.capabilitiesDigest,
                projectSummaryContractDigest: nativeCapabilitiesFixture.items[0].contractDigest,
                projectBitDepthReadContractDigest:
                    nativeCapabilitiesFixture.items[1].contractDigest,
                projectBitDepthSetContractDigest:
                    nativeCapabilitiesFixture.items[2].contractDigest,
                projectItemsListContractDigest:
                    nativeCapabilitiesFixture.items[3].contractDigest,
                compositionLayersListContractDigest:
                    nativeCapabilitiesFixture.items[4].contractDigest,
                compositionSelectedLayersListContractDigest:
                    nativeCapabilitiesFixture.items.find(function (item) {
                        return item.id === 'ae.composition.selected-layers.list';
                    })?.contractDigest || null,
                compositionTimeReadContractDigest:
                    nativeCapabilitiesFixture.items.find(function (item) {
                        return item.id === 'ae.composition.time.read';
                    })?.contractDigest || null,
                layerPropertiesListContractDigest:
                    nativeCapabilitiesFixture.items.find(function (item) {
                        return item.id === 'ae.layer.properties.list';
                    })?.contractDigest || null,
                layerPropertyKeyframesListContractDigest:
                    nativeCapabilitiesFixture.items.find(function (item) {
                        return item.id === 'ae.layer.property.keyframes.list';
                    })?.contractDigest || null,
            };
        },
        close: async function () { closed += 1; state = 'closed'; },
        authorize: function () { state = 'connected'; },
        authenticate: function () { state = 'authenticating'; },
        calls,
        closed: function () { return closed; },
    };
}

test('native routes require the shared token and reject an open-ended invoke envelope', async () => {
    const nativeClient = fakeNativeClient();
    const { server, srv, port } = await startNativeApp(nativeClient);
    try {
        const unauthorized = await post(port, '/native/invoke', {}, {
            capabilityId: 'ae.project.summary', capabilityVersion: 1, arguments: {},
        });
        assert.strictEqual(unauthorized.status, 401);
        assert.strictEqual(unauthorized.body.error.code, 'UNAUTHORIZED');
        assert.strictEqual(unauthorized.body.error.sideEffect, 'not-started');
        assert.strictEqual(unauthorized.body.error.recovery.action, 'reconnect');

        const arbitrary = await post(port, '/native/invoke', {
            'X-AE-MCP-Token': 'known-secret-token',
        }, {
            capabilityId: 'ae.project.summary',
            capabilityVersion: 1,
            arguments: { jsx: 'app.project.close()' },
        });
        assert.strictEqual(arbitrary.status, 400);
        assert.strictEqual(arbitrary.body.error.code, 'INVALID_ARGUMENT');

        const explicitNullIds = await post(port, '/native/capabilities', {
            'X-AE-MCP-Token': 'known-secret-token',
        }, {
            ids: null,
            detail: 'full',
            limit: 100,
            deadlineUnixMs: Date.now() + 10000,
        });
        assert.strictEqual(explicitNullIds.status, 400);
        assert.strictEqual(explicitNullIds.body.error.code, 'INVALID_ARGUMENT');

        const oversizedRequestId = await post(port, '/native/invoke', {
            'X-AE-MCP-Token': 'known-secret-token',
        }, {
            requestId: 'r'.repeat(65),
            capabilityId: 'ae.project.summary',
            capabilityVersion: 1,
            arguments: {},
            deadlineUnixMs: Date.now() + 10000,
        });
        assert.strictEqual(oversizedRequestId.status, 400);
        assert.strictEqual(oversizedRequestId.body.error.code, 'INVALID_ARGUMENT');
        const invalidBitDepth = await post(port, '/native/invoke', {
            'X-AE-MCP-Token': 'known-secret-token',
        }, {
            requestId: 'core-bit-depth-invalid',
            capabilityId: 'ae.project.bit-depth.set',
            capabilityVersion: 1,
            arguments: {
                targetDepth: 24,
                idempotencyKey: 'bit-depth-intent-0002',
            },
            deadlineUnixMs: Date.now() + 10000,
        });
        assert.strictEqual(invalidBitDepth.status, 400);
        assert.strictEqual(invalidBitDepth.body.error.code, 'INVALID_ARGUMENT');
        const invalidProjectPage = await post(port, '/native/invoke', {
            'X-AE-MCP-Token': 'known-secret-token',
        }, {
            requestId: 'core-project-items-invalid',
            capabilityId: 'ae.project.items.list',
            capabilityVersion: 1,
            arguments: { offset: 1, limit: 25 },
            deadlineUnixMs: Date.now() + 10000,
        });
        assert.strictEqual(invalidProjectPage.status, 400);
        assert.strictEqual(invalidProjectPage.body.error.code, 'INVALID_ARGUMENT');
        const invalidLayerPage = await post(port, '/native/invoke', {
            'X-AE-MCP-Token': 'known-secret-token',
        }, {
            requestId: 'core-composition-layers-invalid',
            capabilityId: 'ae.composition.layers.list',
            capabilityVersion: 1,
            arguments: {
                compositionLocator: {
                    ...compositionLayersFixture.value.compositionLocator,
                    kind: 'layer',
                },
                offset: 0,
                limit: 25,
            },
            deadlineUnixMs: Date.now() + 10000,
        });
        assert.strictEqual(invalidLayerPage.status, 400);
        assert.strictEqual(invalidLayerPage.body.error.code, 'INVALID_ARGUMENT');
        const invalidSelectedLayerPage = await post(port, '/native/invoke', {
            'X-AE-MCP-Token': 'known-secret-token',
        }, {
            requestId: 'core-composition-selected-layers-invalid',
            capabilityId: 'ae.composition.selected-layers.list',
            capabilityVersion: 1,
            arguments: {
                compositionLocator:
                    compositionSelectedLayersFixture.value.compositionLocator,
                offset: 0,
                limit: 25,
                includeProperties: true,
            },
            deadlineUnixMs: Date.now() + 10000,
        });
        assert.strictEqual(invalidSelectedLayerPage.status, 400);
        assert.strictEqual(invalidSelectedLayerPage.body.error.code, 'INVALID_ARGUMENT');
        const invalidCompositionTime = await post(port, '/native/invoke', {
            'X-AE-MCP-Token': 'known-secret-token',
        }, {
            requestId: 'core-composition-time-invalid',
            capabilityId: 'ae.composition.time.read',
            capabilityVersion: 1,
            arguments: {
                compositionLocator: compositionTimeFixture.value.compositionLocator,
                compositionName: 'not-allowed',
            },
            deadlineUnixMs: Date.now() + 10000,
        });
        assert.strictEqual(invalidCompositionTime.status, 400);
        assert.strictEqual(invalidCompositionTime.body.error.code, 'INVALID_ARGUMENT');
        const invalidCompositionTimeSet = await post(port, '/native/invoke', {
            'X-AE-MCP-Token': 'known-secret-token',
        }, {
            requestId: 'core-composition-time-set-invalid',
            capabilityId: 'ae.composition.time.set',
            capabilityVersion: 1,
            arguments: {
                compositionLocator: compositionTimeFixture.value.compositionLocator,
                targetTime: { value: 1, scale: 0 },
                idempotencyKey: 'composition-time-intent-0002',
            },
            deadlineUnixMs: Date.now() + 10000,
        });
        assert.strictEqual(invalidCompositionTimeSet.status, 400);
        assert.strictEqual(invalidCompositionTimeSet.body.error.code, 'INVALID_ARGUMENT');
        const invalidLayerEffectApply = await post(port, '/native/invoke', {
            'X-AE-MCP-Token': 'known-secret-token',
        }, {
            requestId: 'core-layer-effect-apply-invalid',
            capabilityId: 'ae.layer.effect.apply',
            capabilityVersion: 1,
            arguments: {
                ...structuredClone(layerEffectApplyVector.request.params.arguments),
                effectMatchName: 'x'.repeat(48),
            },
            deadlineUnixMs: Date.now() + 10000,
        });
        assert.strictEqual(invalidLayerEffectApply.status, 400);
        assert.strictEqual(invalidLayerEffectApply.body.error.code, 'INVALID_ARGUMENT');
        const invalidPropertyPage = await post(port, '/native/invoke', {
            'X-AE-MCP-Token': 'known-secret-token',
        }, {
            requestId: 'core-layer-properties-invalid',
            capabilityId: 'ae.layer.properties.list',
            capabilityVersion: 1,
            arguments: {
                layerLocator: {
                    ...layerPropertiesFixture.value.layerLocator,
                    kind: 'composition',
                },
                offset: 0,
                limit: 25,
            },
            deadlineUnixMs: Date.now() + 10000,
        });
        assert.strictEqual(invalidPropertyPage.status, 400);
        assert.strictEqual(invalidPropertyPage.body.error.code, 'INVALID_ARGUMENT');
        const overLimitPropertyPage = await post(port, '/native/invoke', {
            'X-AE-MCP-Token': 'known-secret-token',
        }, {
            requestId: 'core-layer-properties-over-limit',
            capabilityId: 'ae.layer.properties.list',
            capabilityVersion: 1,
            arguments: {
                layerLocator: layerPropertiesFixture.value.layerLocator,
                offset: 0,
                limit: 26,
            },
            deadlineUnixMs: Date.now() + 10000,
        });
        assert.strictEqual(overLimitPropertyPage.status, 400);
        assert.strictEqual(overLimitPropertyPage.body.error.code, 'INVALID_ARGUMENT');
        const invalidKeyframePage = await post(port, '/native/invoke', {
            'X-AE-MCP-Token': 'known-secret-token',
        }, {
            requestId: 'core-layer-property-keyframes-invalid',
            capabilityId: 'ae.layer.property.keyframes.list',
            capabilityVersion: 1,
            arguments: {
                ...structuredClone(
                    layerPropertyKeyframesVector.request.params.arguments,
                ),
                limit: 26,
            },
            deadlineUnixMs: Date.now() + 10000,
        });
        assert.strictEqual(invalidKeyframePage.status, 400);
        assert.strictEqual(invalidKeyframePage.body.error.code, 'INVALID_ARGUMENT');
        assert.doesNotMatch(JSON.stringify(server.activity.list()), /r{65}/);
        assert.deepStrictEqual(nativeClient.calls, []);
    } finally {
        srv.close();
        server.stop();
    }
});

test('native routes expose pairing then preserve Core negotiation, registry, and invoke fields', async () => {
    const nativeClient = fakeNativeClient();
    const { server, srv, port } = await startNativeApp(nativeClient);
    const headers = {
        'X-AE-MCP-Token': 'known-secret-token',
        'x-ae-mcp-client': 'stdio-mcp/test',
    };
    try {
        const deadlineUnixMs = Date.now() + 10000;
        const pairing = await post(port, '/native/negotiate', headers, {
            deadlineUnixMs,
        });
        assert.strictEqual(pairing.status, 409);
        assert.strictEqual(pairing.body.error.code, 'NATIVE_PAIRING_REQUIRED');
        assert.strictEqual(pairing.body.error.recovery.action, 'approve-pairing');
        assert.deepStrictEqual(pairing.body.error.details, {
            pairingFingerprint: '12AB-34CD',
            pairingExpiresInMs: 60000,
            hostInstanceId: '22222222-2222-4222-8222-222222222222',
            sourceCommit: 'a'.repeat(40),
        });
        assert.strictEqual(pairing.body.pairing.fingerprint, '12AB-34CD');
        assert.strictEqual(pairing.body.pairing.sourceCommit, 'a'.repeat(40));
        assert.doesNotMatch(JSON.stringify(server.activity.list()), /12AB-34CD/);

        nativeClient.authorize();
        const negotiated = await post(port, '/native/negotiate', headers, {
            deadlineUnixMs,
        });
        assert.strictEqual(negotiated.status, 200);
        assert.strictEqual(negotiated.body.result.sourceCommit, 'a'.repeat(40));
        assert.strictEqual(negotiated.body.result.compiledSdkVersion, '25.6.61');

        const capabilities = await post(port, '/native/capabilities', headers, {
            detail: 'full', limit: 100, deadlineUnixMs,
        });
        assert.strictEqual(capabilities.status, 200);
        assert.strictEqual(capabilities.body.result.sessionId, '11111111-1111-4111-8111-111111111111');
        assert.deepStrictEqual(
            capabilities.body.result.items.map((item) => item.id),
            [
                'ae.project.summary',
                'ae.project.bit-depth.read',
                'ae.project.bit-depth.set',
                'ae.project.items.list',
                'ae.composition.layers.list',
                'ae.composition.selected-layers.list',
                'ae.composition.time.read',
                'ae.composition.time.set',
                'ae.composition.create',
                'ae.composition.layer.create',
                'ae.layer.effect.apply',
                'ae.layer.properties.list',
                'ae.layer.property.keyframes.list',
                'ae.layer.property.set',
            ],
        );

        const invoked = await post(port, '/native/invoke', headers, {
            requestId: 'core-project-summary-1',
            capabilityId: 'ae.project.summary',
            capabilityVersion: 1,
            arguments: {},
            deadlineUnixMs,
        });
        assert.strictEqual(invoked.status, 200);
        assert.strictEqual(invoked.body.result.value.itemCount, 2);
        assert.strictEqual(invoked.body.result.evidence.postcondition.verified, true);
        const bitDepthReadRequest = {
            requestId: 'core-bit-depth-read-1',
            capabilityId: 'ae.project.bit-depth.read',
            capabilityVersion: 1,
            arguments: {},
            deadlineUnixMs,
        };
        const bitDepthRead = await post(port, '/native/invoke', headers, bitDepthReadRequest);
        assert.strictEqual(bitDepthRead.status, 200);
        assert.strictEqual(bitDepthRead.body.result.value.bitsPerChannel, 8);
        assert.strictEqual(bitDepthRead.body.result.evidence.effect, 'none');
        const bitDepthSetRequest = {
            requestId: 'core-bit-depth-set-1',
            capabilityId: 'ae.project.bit-depth.set',
            capabilityVersion: 1,
            arguments: {
                targetDepth: 16,
                idempotencyKey: 'bit-depth-intent-0001',
            },
            deadlineUnixMs,
        };
        const bitDepthSet = await post(port, '/native/invoke', headers, bitDepthSetRequest);
        assert.strictEqual(bitDepthSet.status, 200);
        assert.strictEqual(bitDepthSet.body.result.replayed, false);
        assert.deepStrictEqual(bitDepthSet.body.result.value, {
            changed: true, beforeBitsPerChannel: 8, afterBitsPerChannel: 16,
        });
        assert.strictEqual(bitDepthSet.body.result.evidence.effect, 'committed');
        assert.deepStrictEqual(bitDepthSet.body.result.evidence.undo, {
            available: true, verified: false,
        });
        const projectItemsRequest = {
            requestId: 'core-project-items-1',
            capabilityId: 'ae.project.items.list',
            capabilityVersion: 1,
            arguments: { offset: 0, limit: 25 },
            deadlineUnixMs,
        };
        const projectItems = await post(
            port, '/native/invoke', headers, projectItemsRequest,
        );
        assert.strictEqual(projectItems.status, 200);
        assert.strictEqual(projectItems.body.result.value.returned, 2);
        const compositionLayersRequest = {
            requestId: 'core-composition-layers-1',
            capabilityId: 'ae.composition.layers.list',
            capabilityVersion: 1,
            arguments: {
                compositionLocator: compositionLayersFixture.value.compositionLocator,
                offset: 0,
                limit: 25,
            },
            deadlineUnixMs,
        };
        const compositionLayers = await post(
            port, '/native/invoke', headers, compositionLayersRequest,
        );
        assert.strictEqual(compositionLayers.status, 200);
        assert.strictEqual(compositionLayers.body.result.value.layers[0].locked, false);
        const compositionSelectedLayersRequest = {
            requestId: 'core-composition-selected-layers-1',
            capabilityId: 'ae.composition.selected-layers.list',
            capabilityVersion: 1,
            arguments: {
                compositionLocator:
                    compositionSelectedLayersFixture.value.compositionLocator,
                offset: 0,
                limit: 25,
            },
            deadlineUnixMs,
        };
        const compositionSelectedLayers = await post(
            port, '/native/invoke', headers, compositionSelectedLayersRequest,
        );
        assert.strictEqual(compositionSelectedLayers.status, 200);
        assert.deepStrictEqual(
            compositionSelectedLayers.body.result.value.layers.map((layer) => layer.stackIndex),
            [1, 3],
        );
        assert.strictEqual(
            compositionSelectedLayers.body.result.evidence.postcondition.kind,
            'composition-selected-layers-list',
        );
        const expectedSelectedEvidence = structuredClone(
            compositionSelectedLayersFixture.evidence,
        );
        expectedSelectedEvidence.requestId = compositionSelectedLayersRequest.requestId;
        assert.deepStrictEqual(
            compositionSelectedLayers.body.result.evidence,
            expectedSelectedEvidence,
        );
        const compositionTimeRequest = {
            requestId: 'core-composition-time-1',
            capabilityId: 'ae.composition.time.read',
            capabilityVersion: 1,
            arguments: {
                compositionLocator: compositionTimeFixture.value.compositionLocator,
            },
            deadlineUnixMs,
        };
        const compositionTime = await post(
            port, '/native/invoke', headers, compositionTimeRequest,
        );
        assert.strictEqual(compositionTime.status, 200);
        assert.deepStrictEqual(compositionTime.body.result.value.currentTime, {
            value: 3003,
            scale: 1000,
            secondsRational: '3003/1000',
        });
        assert.strictEqual(
            Object.hasOwn(compositionTime.body.result.value, 'compositionName'),
            false,
        );
        const compositionTimeSetRequest = {
            requestId: 'core-composition-time-set-1',
            capabilityId: 'ae.composition.time.set',
            capabilityVersion: 1,
            arguments: structuredClone(compositionTimeSetVector.request.params.arguments),
            deadlineUnixMs,
        };
        const compositionTimeSet = await post(
            port, '/native/invoke', headers, compositionTimeSetRequest,
        );
        assert.strictEqual(compositionTimeSet.status, 200);
        assert.deepStrictEqual(compositionTimeSet.body.result.value.afterTime, {
            value: 1, scale: 1, secondsRational: '1',
        });
        assert.strictEqual(compositionTimeSet.body.result.evidence.effect, 'committed');
        assert.deepStrictEqual(compositionTimeSet.body.result.evidence.undo, {
            available: true, verified: false,
        });
        const compositionCreateRequest = {
            requestId: 'core-composition-create-1',
            capabilityId: 'ae.composition.create',
            capabilityVersion: 1,
            arguments: structuredClone(compositionCreateVector.request.params.arguments),
            deadlineUnixMs,
        };
        const nulCompositionCreateRequest = structuredClone(compositionCreateRequest);
        nulCompositionCreateRequest.requestId = 'core-composition-create-nul';
        nulCompositionCreateRequest.arguments.name = 'SYNTHETIC\u0000COMP';
        const nulCompositionCreate = await post(
            port, '/native/invoke', headers, nulCompositionCreateRequest,
        );
        assert.strictEqual(nulCompositionCreate.status, 400);
        assert.strictEqual(nulCompositionCreate.body.error.code, 'INVALID_ARGUMENT');
        assert.strictEqual(nulCompositionCreate.body.error.sideEffect, 'not-started');
        assert.strictEqual(
            nulCompositionCreate.body.error.recovery.action,
            'change-arguments',
        );
        const compositionCreate = await post(
            port, '/native/invoke', headers, compositionCreateRequest,
        );
        assert.strictEqual(compositionCreate.status, 200);
        assert.strictEqual(compositionCreate.body.result.value.name, 'SYNTHETIC_COMP');
        assert.strictEqual(compositionCreate.body.result.value.projectItemCountAfter, 2);
        assert.strictEqual(compositionCreate.body.result.evidence.effect, 'committed');
        assert.deepStrictEqual(compositionCreate.body.result.evidence.undo, {
            available: true, verified: false,
        });
        const compositionLayerCreateRequest = {
            requestId: 'core-composition-layer-create-1',
            capabilityId: 'ae.composition.layer.create',
            capabilityVersion: 1,
            arguments: structuredClone(
                compositionLayerCreateVector.request.params.arguments,
            ),
            deadlineUnixMs,
        };
        const compositionLayerCreate = await post(
            port, '/native/invoke', headers, compositionLayerCreateRequest,
        );
        assert.strictEqual(compositionLayerCreate.status, 200);
        assert.strictEqual(compositionLayerCreate.body.result.value.kind, 'solid');
        assert.strictEqual(compositionLayerCreate.body.result.value.layerCountAfter, 1);
        assert.strictEqual(compositionLayerCreate.body.result.evidence.effect, 'committed');
        assert.deepStrictEqual(compositionLayerCreate.body.result.evidence.undo, {
            available: true, verified: false,
        });
        const layerEffectApplyRequest = {
            requestId: 'core-layer-effect-apply-1',
            capabilityId: 'ae.layer.effect.apply',
            capabilityVersion: 1,
            arguments: structuredClone(layerEffectApplyVector.request.params.arguments),
            deadlineUnixMs,
        };
        const layerEffectApply = await post(
            port, '/native/invoke', headers, layerEffectApplyRequest,
        );
        assert.strictEqual(layerEffectApply.status, 200);
        assert.strictEqual(layerEffectApply.body.result.value.matchName, 'ADBE Slider Control');
        assert.strictEqual(layerEffectApply.body.result.value.effectCountAfter, 1);
        assert.strictEqual(layerEffectApply.body.result.evidence.effect, 'committed');
        assert.deepStrictEqual(layerEffectApply.body.result.evidence.undo, {
            available: true, verified: false,
        });
        const layerPropertiesRequest = {
            requestId: 'core-layer-properties-1',
            capabilityId: 'ae.layer.properties.list',
            capabilityVersion: 1,
            arguments: structuredClone(layerPropertiesVector.request.params.arguments),
            deadlineUnixMs,
        };
        const layerProperties = await post(
            port, '/native/invoke', headers, layerPropertiesRequest,
        );
        assert.strictEqual(layerProperties.status, 200);
        assert.strictEqual(layerProperties.body.result.value.properties[1].value.value, '73.5');
        const layerPropertyKeyframesRequest = {
            requestId: 'core-layer-property-keyframes-1',
            capabilityId: 'ae.layer.property.keyframes.list',
            capabilityVersion: 1,
            arguments: structuredClone(
                layerPropertyKeyframesVector.request.params.arguments,
            ),
            deadlineUnixMs,
        };
        const layerPropertyKeyframes = await post(
            port, '/native/invoke', headers, layerPropertyKeyframesRequest,
        );
        assert.strictEqual(layerPropertyKeyframes.status, 200);
        assert.strictEqual(
            layerPropertyKeyframes.body.result.value.keyframes[1].time.value,
            5,
        );
        assert.strictEqual(
            layerPropertyKeyframes.body.result.value.keyframes[1].outInterpolation,
            'hold',
        );
        const layerPropertySetRequest = {
            requestId: 'core-layer-property-set-1',
            capabilityId: 'ae.layer.property.set',
            capabilityVersion: 1,
            arguments: structuredClone(layerPropertySetVector.request.params.arguments),
            deadlineUnixMs,
        };
        const layerPropertySet = await post(
            port, '/native/invoke', headers, layerPropertySetRequest,
        );
        assert.strictEqual(layerPropertySet.status, 200);
        assert.strictEqual(layerPropertySet.body.result.value.changed, true);
        assert.strictEqual(layerPropertySet.body.result.evidence.effect, 'committed');
        assert.deepStrictEqual(nativeClient.calls, [
            'pair',
            ['negotiate', { deadlineUnixMs }],
            ['capabilities', { detail: 'full', limit: 100, deadlineUnixMs }],
            ['invoke', {
                requestId: 'core-project-summary-1',
                capabilityId: 'ae.project.summary',
                capabilityVersion: 1,
                arguments: {},
                deadlineUnixMs,
            }],
            ['invoke', bitDepthReadRequest],
            ['invoke', bitDepthSetRequest],
            ['invoke', projectItemsRequest],
            ['invoke', compositionLayersRequest],
            ['invoke', compositionSelectedLayersRequest],
            ['invoke', compositionTimeRequest],
            ['invoke', compositionTimeSetRequest],
            ['invoke', compositionCreateRequest],
            ['invoke', compositionLayerCreateRequest],
            ['invoke', layerEffectApplyRequest],
            ['invoke', layerPropertiesRequest],
            ['invoke', layerPropertyKeyframesRequest],
            ['invoke', layerPropertySetRequest],
        ]);
    } finally {
        srv.close();
        server.stop();
    }
});

test('native routes preserve panel pause and client-block controls and close the session on stop', async () => {
    const nativeClient = fakeNativeClient();
    nativeClient.authorize();
    const { server, srv, port } = await startNativeApp(nativeClient);
    const body = { capabilityId: 'ae.project.summary', capabilityVersion: 1, arguments: {} };
    try {
        server.setPaused(true);
        const paused = await post(port, '/native/invoke', {
            'X-AE-MCP-Token': 'known-secret-token',
        }, body);
        assert.strictEqual(paused.status, 503);
        assert.strictEqual(paused.body.error.code, 'ACTIONS_PAUSED');
        assert.strictEqual(paused.body.error.sideEffect, 'not-started');
        assert.strictEqual(paused.body.error.recovery.action, 'retry');
        server.setPaused(false);

        server.setClientBlocked('blocked/test', true);
        const blocked = await post(port, '/native/invoke', {
            'X-AE-MCP-Token': 'known-secret-token',
            'x-ae-mcp-client': 'blocked/test',
        }, body);
        assert.strictEqual(blocked.status, 403);
        assert.strictEqual(blocked.body.error.code, 'CLIENT_BLOCKED');
        assert.strictEqual(blocked.body.error.sideEffect, 'not-started');
        assert.strictEqual(blocked.body.error.recovery.action, 'none');
        assert.deepStrictEqual(nativeClient.calls, []);
    } finally {
        server.setPaused(false);
        server.setClientBlocked('blocked/test', false);
        srv.close();
        server.stop();
    }
    assert.strictEqual(nativeClient.closed(), 1);
});

test('native invoke preserves complete structured native failures over HTTP', async () => {
    const nativeClient = fakeNativeClient();
    nativeClient.authorize();
    nativeClient.invoke = async function () {
        const error = new Error('project summary failed');
        error.code = 'CAPABILITY_FAILED';
        error.retryable = false;
        error.sideEffect = 'not-started';
        error.recovery = { action: 'inspect-state', hint: 'Inspect the project state.' };
        error.details = { capabilityId: 'ae.project.summary' };
        throw error;
    };
    const { server, srv, port } = await startNativeApp(nativeClient);
    try {
        const response = await post(port, '/native/invoke', {
            'X-AE-MCP-Token': 'known-secret-token',
        }, {
            requestId: 'core-project-summary-error',
            capabilityId: 'ae.project.summary',
            capabilityVersion: 1,
            arguments: {},
            deadlineUnixMs: Date.now() + 10000,
        });
        assert.strictEqual(response.status, 503);
        assert.deepStrictEqual(response.body.error, {
            code: 'CAPABILITY_FAILED',
            message: 'project summary failed',
            retryable: false,
            sideEffect: 'not-started',
            recovery: { action: 'inspect-state', hint: 'Inspect the project state.' },
            details: { capabilityId: 'ae.project.summary' },
        });
    } finally {
        srv.close();
        server.stop();
    }
});

test('native invoke preserves uncertain layer-property mutation failures over HTTP', async () => {
    const nativeClient = fakeNativeClient();
    nativeClient.authorize();
    nativeClient.invoke = async function () {
        const error = new Error('mutation error envelope could not be verified');
        error.code = 'POSSIBLY_SIDE_EFFECTING_FAILURE';
        error.retryable = false;
        error.sideEffect = 'may-have-occurred';
        error.recovery = {
            action: 'inspect-state',
            hint: 'Inspect After Effects state and the Undo stack before retrying.',
        };
        error.details = { capabilityId: 'ae.layer.property.set' };
        throw error;
    };
    const { server, srv, port } = await startNativeApp(nativeClient);
    try {
        const response = await post(port, '/native/invoke', {
            'X-AE-MCP-Token': 'known-secret-token',
        }, {
            requestId: 'core-layer-property-uncertain',
            capabilityId: 'ae.layer.property.set',
            capabilityVersion: 1,
            arguments: structuredClone(layerPropertySetVector.request.params.arguments),
            deadlineUnixMs: Date.now() + 10000,
        });
        assert.strictEqual(response.status, 503);
        assert.deepStrictEqual(response.body.error, {
            code: 'POSSIBLY_SIDE_EFFECTING_FAILURE',
            message: 'mutation error envelope could not be verified',
            retryable: false,
            sideEffect: 'may-have-occurred',
            recovery: {
                action: 'inspect-state',
                hint: 'Inspect After Effects state and the Undo stack before retrying.',
            },
            details: { capabilityId: 'ae.layer.property.set' },
        });
    } finally {
        srv.close();
        server.stop();
    }
});

for (const failureFixture of brokerFailureFixtures.concat([
    {
        name: 'actual native INVALID_REQUEST',
        status: 503,
        body: {
            ok: false,
            error: {
                code: 'INVALID_REQUEST',
                message: 'native request was invalid',
                retryable: false,
                sideEffect: 'not-started',
                recovery: { action: 'none', hint: 'Do not retry this request.' },
            },
        },
    },
])) {
    test('native invoke preserves ' + failureFixture.name + ' over HTTP', async () => {
        const expectedError = failureFixture.body.error;
        const nativeClient = fakeNativeClient();
        nativeClient.authorize();
        nativeClient.invoke = async function () {
            const error = new Error(expectedError.message);
            error.code = expectedError.code;
            error.retryable = expectedError.retryable;
            error.sideEffect = expectedError.sideEffect;
            error.recovery = expectedError.recovery;
            throw error;
        };
        const { server, srv, port } = await startNativeApp(nativeClient);
        try {
            const response = await post(port, '/native/invoke', {
                'X-AE-MCP-Token': 'known-secret-token',
            }, {
                requestId: 'core-error-classification',
                capabilityId: 'ae.project.summary',
                capabilityVersion: 1,
                arguments: {},
                deadlineUnixMs: Date.now() + 10000,
            });
            assert.strictEqual(response.status, failureFixture.status);
            assert.deepStrictEqual(response.body, failureFixture.body);
        } finally {
            srv.close();
            server.stop();
        }
    });
}

test('native negotiation forwards the Core deadline while authentication is pending', async () => {
    const nativeClient = fakeNativeClient();
    nativeClient.authenticate();
    const { server, srv, port } = await startNativeApp(nativeClient);
    const deadlineUnixMs = Date.now() + 10000;
    try {
        const response = await post(port, '/native/negotiate', {
            'X-AE-MCP-Token': 'known-secret-token',
        }, { deadlineUnixMs });
        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(nativeClient.calls, [
            ['wait', deadlineUnixMs],
            ['negotiate', { deadlineUnixMs }],
        ]);
    } finally {
        srv.close();
        server.stop();
    }
});

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

test('/exec awaits connected native project-graph invalidation before evalScript', async () => {
    const events = [];
    let invalidationOptions;
    const nativeClient = {
        status: function () { return { state: 'connected' }; },
        invalidateProjectGraph: async function (options) {
            invalidationOptions = options;
            events.push('invalidate:start');
            await Promise.resolve();
            events.push('invalidate:ack');
            return { generation: 8, invalidated: true };
        },
        close: async function () {},
    };
    const running = await startExecAppWithNative(nativeClient, function (_jsx, cb) {
        events.push('evalScript');
        cb('{"ok":true,"result":"stub-result"}');
    });
    try {
        const response = await post(
            running.port,
            '/exec',
            { 'X-AE-MCP-Token': 'known-secret-token' },
            { code: '1', timeoutMs: 60000 },
        );
        assert.equal(response.status, 200);
        assert.equal(response.body.ok, true);
        assert.deepEqual(events, ['invalidate:start', 'invalidate:ack', 'evalScript']);
        assert.deepEqual(Object.keys(invalidationOptions), ['deadlineUnixMs']);
        assert.equal(Number.isSafeInteger(invalidationOptions.deadlineUnixMs), true);
        assert.equal(invalidationOptions.deadlineUnixMs > 0, true);
        assert.equal(invalidationOptions.deadlineUnixMs > Date.now(), true);
        assert.equal(invalidationOptions.deadlineUnixMs <= Date.now() + 30000, true);
    } finally {
        running.srv.close();
        running.server._setNativeAegpClientForTest(null);
    }
});

test('/exec fails closed before evalScript when connected native invalidation fails', async () => {
    let evalCalls = 0;
    const nativeClient = {
        status: function () { return { state: 'connected' }; },
        invalidateProjectGraph: async function () {
            const error = new Error('native graph fence failed');
            error.code = 'NATIVE_UNAVAILABLE';
            throw error;
        },
        close: async function () {},
    };
    const running = await startExecAppWithNative(nativeClient, function (_jsx, cb) {
        evalCalls += 1;
        cb('{"ok":true,"result":"must-not-run"}');
    });
    try {
        const response = await post(
            running.port,
            '/exec',
            { 'X-AE-MCP-Token': 'known-secret-token' },
            { code: 'app.project.close();' },
        );
        assert.equal(response.status, 200);
        assert.equal(response.body.ok, false);
        assert.match(response.body.error, /native graph fence failed/);
        assert.equal(evalCalls, 0);
    } finally {
        running.srv.close();
        running.server._setNativeAegpClientForTest(null);
    }
});

test('/exec keeps legacy evalScript behavior when the existing native client is disconnected', async () => {
    let invalidationCalls = 0;
    let evalCalls = 0;
    const nativeClient = {
        status: function () { return { state: 'disconnected' }; },
        invalidateProjectGraph: async function () { invalidationCalls += 1; },
        close: async function () {},
    };
    const running = await startExecAppWithNative(nativeClient, function (_jsx, cb) {
        evalCalls += 1;
        cb('{"ok":true,"result":"legacy-result"}');
    });
    try {
        const response = await post(
            running.port,
            '/exec',
            { 'X-AE-MCP-Token': 'known-secret-token' },
            { code: '1' },
        );
        assert.equal(response.status, 200);
        assert.deepEqual(response.body, { ok: true, result: 'legacy-result' });
        assert.equal(invalidationCalls, 0);
        assert.equal(evalCalls, 1);
    } finally {
        running.srv.close();
        running.server._setNativeAegpClientForTest(null);
    }
});

test('/exec decodes the evalScript transport envelope before responding', async () => {
    delete require.cache[require.resolve('./server')];
    delete require.cache[require.resolve('./jsx-bridge')];
    const server = bindRuntimeDependencies(require('./server'));
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
    const server = bindRuntimeDependencies(require('./server'));
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
    const server = bindRuntimeDependencies(require('./server'));
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
    const server = bindRuntimeDependencies(require('./server'));
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

test('start and restart retain normalized frozen platform roots while legacy two-argument calls still work', async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-platform-roots-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    t.mock.method(os, 'homedir', () => tmp);
    delete require.cache[require.resolve('./server')];
    const server = bindRuntimeDependencies(require('./server'));
    t.after(() => new Promise((resolve) => server.stop(resolve)));
    const listen = (method, roots, explicitRoots) => new Promise((resolve, reject) => {
        const callback = (error) => error ? reject(error) : resolve();
        if (explicitRoots) server[method](0, callback, roots);
        else server[method](0, callback);
    });
    const stop = () => new Promise((resolve) => server.stop(resolve));

    await listen('start');
    assert.strictEqual(server._getPlatformRootsForTest(), null);
    await stop();

    const rootsA = {
        extensionRoot: path.join(tmp, 'extension', '..', 'extension'),
        runtimeRoot: path.join(tmp, '.ae-mcp', 'runtime', '..', 'runtime'),
    };
    await listen('start', rootsA, true);
    const normalizedA = server._getPlatformRootsForTest();
    assert.deepStrictEqual(normalizedA, {
        extensionRoot: path.resolve(rootsA.extensionRoot),
        runtimeRoot: path.resolve(rootsA.runtimeRoot),
    });
    assert.strictEqual(Object.isFrozen(normalizedA), true);

    await listen('restart');
    assert.deepStrictEqual(server._getPlatformRootsForTest(), normalizedA);

    const rootsB = {
        extensionRoot: path.join(tmp, 'other-extension'),
        runtimeRoot: path.join(tmp, 'other-runtime'),
    };
    await listen('restart', rootsB, true);
    assert.deepStrictEqual(server._getPlatformRootsForTest(), {
        extensionRoot: path.resolve(rootsB.extensionRoot),
        runtimeRoot: path.resolve(rootsB.runtimeRoot),
    });
    await stop();
});
