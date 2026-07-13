const assert = require('node:assert/strict');
const test = require('node:test');

const {
    DEFAULT_MAX_MESSAGE_BYTES,
    DEFAULT_REQUEST_TIMEOUT_MS,
    HELPER_METHODS,
    createPlatformHelperClient,
} = require('./platform-helper-client');

const METHODS = [
    'capabilities',
    'secret.get',
    'secret.set',
    'secret.delete',
    'window.find',
    'window.describe',
    'window.capture',
];

const REFERENCE = 'aemcp-secret://provider/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/api/v1';

function validResult(method) {
    if (method === 'capabilities') {
        return {
            protocolVersion: 1,
            platform: 'macos-arm64',
            helperVersion: '0.1.0',
            secretBackend: 'keychain',
            captureBackend: 'screen-capture-kit',
            authenticatedCaller: true,
            maxMessageBytes: 65536,
            methods: METHODS,
        };
    }
    if (method === 'secret.get') return { reference: REFERENCE, value: 'secret', revision: 1 };
    if (method === 'secret.set') return { reference: REFERENCE, revision: 2 };
    if (method === 'secret.delete') return { reference: REFERENCE, deleted: true, revision: null };
    const window = {
        reference: 'ae-window://main/42',
        application: 'after-effects',
        ownerBundleId: 'com.adobe.AfterEffects.application',
        ownerTeamId: 'JQ525L2MZD',
        processId: 42,
        title: 'After Effects',
        frame: { x: 0, y: 0, width: 1920, height: 1080 },
        scale: 2,
        capturable: true,
    };
    if (method === 'window.find') return [window];
    if (method === 'window.describe') return window;
    return {
        captureId: 'capture-1',
        reference: window.reference,
        spoolPath: '/private/tmp/ae-mcp/capture-1.png',
        width: 1920,
        height: 1080,
        scale: 2,
        method: 'ScreenCaptureKit',
        sha256: 'a'.repeat(64),
    };
}

function echoSuccess(requests, result) {
    return {
        request: async function (jsonUtf8) {
            const request = JSON.parse(jsonUtf8);
            requests.push(request);
            return JSON.stringify({
                protocolVersion: 1,
                id: request.id,
                ok: true,
                result: result === undefined ? validResult(request.method) : result,
            });
        },
        close: async function () {},
    };
}

test('client rejects oversized messages before transport and exposes no enumeration surface', async () => {
    let calls = 0;
    const client = createPlatformHelperClient({
        maxMessageBytes: 64,
        transport: {
            request: async function () { calls += 1; return '{}'; },
            close: async function () {},
        },
    });
    await assert.rejects(
        client.secretSet({
            reference: 'aemcp-secret://provider/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/api/v1',
            value: 'x'.repeat(128),
            expectedRevision: null,
        }),
        { code: 'MESSAGE_TOO_LARGE' },
    );
    assert.equal(calls, 0);
    assert.equal(Object.hasOwn(client, 'secretList'), false);
    assert.equal(Object.hasOwn(client, 'request'), false);
    assert.deepEqual(Object.keys(client).sort(), [
        'capabilities',
        'close',
        'secretDelete',
        'secretGet',
        'secretSet',
        'windowCapture',
        'windowDescribe',
        'windowFind',
    ]);
});

test('client rejects non-object params before transport', async () => {
    let calls = 0;
    const client = createPlatformHelperClient({
        transport: {
            request: async function () { calls += 1; return '{}'; },
            close: async function () {},
        },
    });
    await assert.rejects(client.secretSet(undefined), { code: 'INVALID_REQUEST' });
    await assert.rejects(client.windowFind(null), { code: 'INVALID_REQUEST' });
    await assert.rejects(client.windowCapture([]), { code: 'INVALID_REQUEST' });
    assert.equal(calls, 0);
});

test('client rejects method-specific invalid params before transport', async () => {
    let calls = 0;
    const client = createPlatformHelperClient({
        transport: {
            request: async function () { calls += 1; return '{}'; },
            close: async function () {},
        },
    });
    await assert.rejects(client.secretGet('forged'), { code: 'INVALID_REFERENCE' });
    await assert.rejects(client.secretSet({
        reference: REFERENCE,
        value: 'secret',
        expectedRevision: null,
        unexpected: true,
    }), { code: 'INVALID_REQUEST' });
    await assert.rejects(client.secretDelete({ reference: REFERENCE, expectedRevision: 0 }), {
        code: 'INVALID_REQUEST',
    });
    await assert.rejects(client.windowFind({ target: 'anything' }), { code: 'INVALID_REQUEST' });
    await assert.rejects(client.windowCapture({ captureId: 'capture-1' }), {
        code: 'INVALID_REQUEST',
    });
    assert.equal(calls, 0);
});

test('client sends only protocol v1 requests with unique positive integer IDs', async () => {
    const requests = [];
    const client = createPlatformHelperClient({ transport: echoSuccess(requests) });
    await Promise.all([
        client.capabilities(),
        client.secretGet('aemcp-secret://provider/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/api/v1'),
        client.secretSet({
            reference: 'aemcp-secret://provider/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/api/v1',
            value: 'secret',
            expectedRevision: null,
        }),
        client.secretDelete({
            reference: 'aemcp-secret://provider/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/api/v1',
        }),
        client.windowFind(),
        client.windowDescribe('ae-window://main/42'),
        client.windowCapture({ target: 'after-effects-main', captureId: 'capture-1' }),
    ]);

    assert.deepEqual(requests.map((request) => request.method), METHODS);
    assert.deepEqual(requests.map((request) => request.params), [
        {},
        { reference: REFERENCE },
        { reference: REFERENCE, value: 'secret', expectedRevision: null },
        { reference: REFERENCE },
        {},
        { reference: 'ae-window://main/42' },
        { target: 'after-effects-main', captureId: 'capture-1' },
    ]);
    assert.deepEqual(requests.map((request) => request.id), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(new Set(requests.map((request) => request.id)).size, requests.length);
    for (const request of requests) {
        assert.equal(request.protocolVersion, 1);
        assert.equal(Number.isInteger(request.id) && request.id > 0, true);
        assert.equal(HELPER_METHODS.includes(request.method), true);
        assert.equal(typeof request.params, 'object');
    }
});

test('client uses the exact Task 6 UUID and bounded slot grammar', async () => {
    let calls = 0;
    const client = createPlatformHelperClient({
        transport: {
            request: async function () { calls += 1; return '{}'; },
            close: async function () {},
        },
    });
    for (const reference of [
        'aemcp-secret://provider/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/Api/v1',
        'aemcp-secret://provider/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/1api/v1',
        'aemcp-secret://provider/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/api.key/v1',
        `aemcp-secret://provider/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/${'a'.repeat(33)}/v1`,
    ]) {
        await assert.rejects(client.secretGet(reference), function (error) {
            assert.equal(error.code, 'INVALID_REFERENCE');
            assert.equal(`${error.message}\n${error.stack}`.includes(reference), false);
            return true;
        });
    }
    assert.equal(calls, 0);
});

test('client fails closed when a legal success envelope carries another method result', async () => {
    const sentinel = 'never-expose-cross-method-secret';
    const invocations = [
        ['capabilities', (client) => client.capabilities()],
        ['secret.get', (client) => client.secretGet(REFERENCE)],
        ['secret.set', (client) => client.secretSet({
            reference: REFERENCE,
            value: sentinel,
            expectedRevision: null,
        })],
        ['secret.delete', (client) => client.secretDelete({ reference: REFERENCE })],
        ['window.find', (client) => client.windowFind()],
        ['window.describe', (client) => client.windowDescribe('ae-window://main/42')],
        ['window.capture', (client) => client.windowCapture({
            target: 'after-effects-main',
            captureId: 'capture-1',
        })],
    ];
    for (const [method, invoke] of invocations) {
        const wrongResult = method === 'secret.set'
            ? { reference: REFERENCE, value: sentinel, revision: 1 }
            : validResult(method === 'capabilities' ? 'secret.set' : 'capabilities');
        const client = createPlatformHelperClient({
            transport: {
                request: async function (jsonUtf8) {
                    const request = JSON.parse(jsonUtf8);
                    return JSON.stringify({
                        protocolVersion: 1,
                        id: request.id,
                        ok: true,
                        result: wrongResult,
                    });
                },
                close: async function () {},
            },
        });
        await assert.rejects(invoke(client), function (error) {
            assert.equal(error.code, 'INVALID_REQUEST');
            const text = `${error.message}\n${error.stack}`;
            assert.equal(text.includes(sentinel), false);
            assert.equal(text.includes(REFERENCE), false);
            return true;
        }, method);
    }
});

test('client enforces 65,536-byte request and response defaults', async () => {
    assert.equal(DEFAULT_MAX_MESSAGE_BYTES, 65536);
    const requests = [];
    const client = createPlatformHelperClient({
        transport: {
            request: async function (jsonUtf8) {
                requests.push(JSON.parse(jsonUtf8));
                return 'x'.repeat(DEFAULT_MAX_MESSAGE_BYTES + 1);
            },
            close: async function () {},
        },
    });
    await assert.rejects(client.capabilities(), { code: 'MESSAGE_TOO_LARGE' });
    assert.equal(requests.length, 1);
});

test('client enforces a 10,000 ms default timeout and a configurable bounded timeout', async () => {
    assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 10000);
    const client = createPlatformHelperClient({
        requestTimeoutMs: 15,
        transport: {
            request: async function () { return new Promise(function () {}); },
            close: async function () {},
        },
    });
    await assert.rejects(client.capabilities(), { code: 'HELPER_UNAVAILABLE', retryable: true });
});

test('client rejects mismatched versions, IDs, and malformed error envelopes', async () => {
    const responses = [
        function (request) { return { protocolVersion: 2, id: request.id, ok: true, result: {} }; },
        function (request) { return { protocolVersion: 1, id: request.id + 1, ok: true, result: {} }; },
        function (request) {
            return {
                protocolVersion: 1,
                id: request.id,
                ok: false,
                error: { code: 'HELPER_UNAVAILABLE', message: 'offline' },
            };
        },
    ];
    for (const makeResponse of responses) {
        const client = createPlatformHelperClient({
            transport: {
                request: async function (jsonUtf8) {
                    return JSON.stringify(makeResponse(JSON.parse(jsonUtf8)));
                },
                close: async function () {},
            },
        });
        const expectedCode = makeResponse({ id: 1 }).protocolVersion === 2
            ? 'PROTOCOL_VERSION_UNSUPPORTED'
            : 'INVALID_REQUEST';
        await assert.rejects(client.capabilities(), { code: expectedCode });
    }
});

test('client rejects method-specific malformed success results', async () => {
    const calls = [
        (client) => client.capabilities(),
        (client) => client.secretGet(REFERENCE),
        (client) => client.secretSet({ reference: REFERENCE, value: 'secret', expectedRevision: null }),
        (client) => client.secretDelete({ reference: REFERENCE }),
        (client) => client.windowFind(),
        (client) => client.windowDescribe('ae-window://main/42'),
        (client) => client.windowCapture({ target: 'after-effects-main', captureId: 'capture-1' }),
    ];
    for (const invoke of calls) {
        const client = createPlatformHelperClient({ transport: echoSuccess([], {}) });
        await assert.rejects(invoke(client), { code: 'INVALID_REQUEST' });
    }
});

test('client preserves sanitized lifecycle failures raised by the transport boundary', async () => {
    for (const code of ['HELPER_START_FAILED', 'PLATFORM_HELPER_REPAIR_REQUIRED']) {
        const client = createPlatformHelperClient({
            transport: {
                request: async function () {
                    const error = new Error('sensitive native detail');
                    error.code = code;
                    error.retryable = code === 'HELPER_START_FAILED';
                    throw error;
                },
                close: async function () {},
            },
        });
        await assert.rejects(client.capabilities(), function (error) {
            assert.equal(error.code, code);
            assert.equal(error.retryable, code === 'HELPER_START_FAILED');
            assert.doesNotMatch(error.message, /sensitive native detail/);
            return true;
        });
    }
});

test('client errors never expose request secrets, helper messages, or transport causes', async () => {
    const sentinel = 'never-log-this-secret';
    const inputs = [
        {
            request: async function () { return sentinel; },
            expectedCode: 'INVALID_REQUEST',
        },
        {
            request: async function (jsonUtf8) {
                const request = JSON.parse(jsonUtf8);
                return JSON.stringify({
                    protocolVersion: 1,
                    id: request.id,
                    ok: false,
                    error: { code: 'SECRET_CONFLICT', message: sentinel, retryable: false },
                });
            },
            expectedCode: 'SECRET_CONFLICT',
        },
        {
            request: async function () { throw new Error(sentinel); },
            expectedCode: 'HELPER_UNAVAILABLE',
        },
    ];
    for (const input of inputs) {
        const client = createPlatformHelperClient({
            transport: { request: input.request, close: async function () {} },
        });
        await assert.rejects(client.secretSet({
            reference: REFERENCE,
            value: sentinel,
            expectedRevision: null,
        }), function (error) {
            assert.equal(error.code, input.expectedCode);
            assert.equal(Object.hasOwn(error, 'cause'), false);
            assert.doesNotMatch(`${error.message}\n${error.stack}`, new RegExp(sentinel));
            return true;
        });
    }
});

test('client enforces the schema error-message bound without exposing the message', async () => {
    const client = createPlatformHelperClient({
        transport: {
            request: async function (jsonUtf8) {
                const request = JSON.parse(jsonUtf8);
                return JSON.stringify({
                    protocolVersion: 1,
                    id: request.id,
                    ok: false,
                    error: {
                        code: 'HELPER_UNAVAILABLE',
                        message: 'x'.repeat(4097),
                        retryable: true,
                    },
                });
            },
            close: async function () {},
        },
    });
    await assert.rejects(client.capabilities(), { code: 'INVALID_REQUEST' });
});

test('helper failures preserve their bounded error contract and close is idempotent', async () => {
    let closes = 0;
    let calls = 0;
    const client = createPlatformHelperClient({
        transport: {
            request: async function (jsonUtf8) {
                calls += 1;
                const request = JSON.parse(jsonUtf8);
                return JSON.stringify({
                    protocolVersion: 1,
                    id: request.id,
                    ok: false,
                    error: { code: 'SECRET_NOT_FOUND', message: 'missing', retryable: false },
                });
            },
            close: async function () { closes += 1; },
        },
    });
    await assert.rejects(client.secretGet(
        'aemcp-secret://provider/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/api/v1',
    ), { code: 'SECRET_NOT_FOUND', retryable: false });
    await Promise.all([client.close(), client.close()]);
    assert.equal(closes, 1);
    await assert.rejects(client.capabilities(), { code: 'HELPER_UNAVAILABLE' });
    assert.equal(calls, 1);
});
