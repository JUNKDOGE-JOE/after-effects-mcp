'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    CAPABILITY_ID,
    buildNativeProgramRequest,
    canonicalJson,
    invokeNativeProgram,
    invokeRequestDigest,
    nativeErrorPayload,
    nativeProgramResponse,
    nativeProgramPostconditionDigest,
    sha256ClosedJson,
    validateInvokeErrorBinding,
    validateNativeProgramFailureDetails,
} = require('./native-program');

const HOST_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const LOCATOR = {
    kind: 'composition',
    hostInstanceId: HOST_ID,
    sessionId: SESSION_ID,
    projectId: '33333333-3333-4333-8333-333333333333',
    generation: 1,
    objectId: '44444444-4444-4444-8444-444444444444',
};
const NEGOTIATION = {
    selectedWireVersion: 1,
    pluginVersion: '0.9.6',
    compiledSdkVersion: 'AEGP-test-sdk',
    sourceCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    hostInstanceId: HOST_ID,
    hostPlatform: 'windows-x64',
    sessionId: SESSION_ID,
    sessionGeneration: 1,
    capabilitiesDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
};

function readArgs() {
    return {
        operations: [{
            op: 'project.items.list',
            args: { offset: 0, limit: 1 },
            returnAs: 'items',
        }],
    };
}

function writeArgs() {
    return {
        operationKey: 'native-operation-key-0001',
        undoGroup: 'Set exact time',
        operations: [
            { op: 'composition.resolve', args: { locator: LOCATOR }, saveAs: 'composition' },
            {
                op: 'composition.time.set',
                args: {
                    composition: { ref: 'composition' },
                    targetTime: { value: 24, scale: 24 },
                },
            },
        ],
    };
}

function validItems() {
    return {
        projectLocator: Object.assign({}, LOCATOR, { kind: 'project' }),
        total: 0,
        offset: 0,
        limit: 1,
        returned: 0,
        hasMore: false,
        nextOffset: null,
        items: [],
    };
}

function resultFor(request, negotiation, overrides) {
    const input = overrides || {};
    const operations = input.operations || request.arguments.operations.map(function (operation, index) {
        return { index, op: operation.op, status: 'completed' };
    });
    const outputs = input.outputs === undefined
        ? (request.arguments.operations[0].returnAs ? { items: validItems() } : {})
        : input.outputs;
    const result = {
        capabilityId: input.capabilityId || CAPABILITY_ID,
        outputs,
        operations,
        evidence: {
            engine: 'native-aegp',
            hostInstanceId: input.hostInstanceId || negotiation.hostInstanceId,
            sessionId: input.sessionId || negotiation.sessionId,
            requestId: input.requestId || request.requestId,
            capabilityId: CAPABILITY_ID,
            capabilityVersion: 1,
            startedAtUnixMs: input.startedAtUnixMs || Date.now(),
            completedAtUnixMs: input.completedAtUnixMs || Date.now(),
            effect: input.effect || (request.arguments.operationKey ? 'committed' : 'none'),
            postcondition: {
                verified: true,
                kind: 'native-program',
                algorithm: 'sha256-rfc8785-jcs-v1',
                digest: input.postconditionDigest || nativeProgramPostconditionDigest(outputs, operations),
            },
            requestDigest: input.requestDigest || invokeRequestDigest(request, negotiation),
        },
        undo: input.undo || {
            available: request.arguments.operationKey !== undefined,
            verified: false,
            ...(request.arguments.operationKey ? { groupLabel: request.arguments.undoGroup } : {}),
        },
        replayed: input.replayed === undefined ? false : input.replayed,
    };
    if (request.arguments.operationKey && input.operationKey !== null) {
        result.operationKey = input.operationKey || request.arguments.operationKey;
    }
    if (input.operationKey === null) delete result.operationKey;
    return result;
}

async function run(args, mutateResult) {
    const requestId = 'mcp-11111111111111111111111111111111';
    const deadlineUnixMs = Date.now() + 5000;
    return invokeNativeProgram({
        requestId,
        args,
        deadlineUnixMs,
        nativeNegotiate: async function () { return NEGOTIATION; },
        nativeInvoke: async function (request) {
            const result = resultFor(request, NEGOTIATION);
            if (mutateResult) mutateResult(result, request);
            return result;
        },
    });
}

function rejectsWithCode(promise, code) {
    return assert.rejects(promise, function (error) {
        assert.equal(error.code, code);
        return true;
    });
}

test('canonicalJson matches the Python closed-json expression for fixed values', () => {
    assert.equal(canonicalJson({ z: 1, a: [true, null, '中文', { b: 2, a: 1 }], empty: [], object: {} }),
        '{"a":[true,null,"中文",{"a":1,"b":2}],"empty":[],"object":{},"z":1}');
    assert.equal(canonicalJson({ '\u4e2d文': '值', a: 1, '10': 'ten', '2': 'two' }),
        '{"10":"ten","2":"two","a":1,"中\u6587":"值"}'.replace('\\u6587', '文'));
    assert.equal(canonicalJson({ whole: 2, decimal: 1.5, fraction: 0.5, emoji: '😀' }),
        '{"decimal":1.5,"emoji":"😀","fraction":0.5,"whole":2}');
    assert.throws(function () { canonicalJson({ decimal: 0.00001 }); }, /cross-runtime spelling/);
    assert.equal(sha256ClosedJson({ nested: ['中文', {}, []] }),
        'd52f6b380f9a49d04358787b3b3f5c78995cbd1717df70b4d90bbe7098020969');
});

test('request and postcondition digests are built from the Python-shaped objects', async () => {
    const execution = await run(readArgs());
    const expectedRequest = buildNativeProgramRequest({
        requestId: execution.request.requestId,
        args: readArgs(),
        deadlineUnixMs: execution.request.deadlineUnixMs,
    });
    assert.deepEqual(Object.keys(execution.request), [
        'requestId', 'capabilityId', 'capabilityVersion', 'arguments', 'deadlineUnixMs',
    ]);
    assert.equal(execution.request.programDigest, sha256ClosedJson(expectedRequest.arguments));
    assert.equal(execution.result.evidence.requestDigest, invokeRequestDigest(execution.request, NEGOTIATION));
    assert.equal(execution.result.evidence.postcondition.digest,
        nativeProgramPostconditionDigest(execution.result.outputs, execution.result.operations));
});

test('valid read and write program results map to the Python response shape', async () => {
    const read = await run(readArgs());
    assert.equal(read.result.evidence.effect, 'none');
    assert.equal(read.result.undo.available, false);
    const write = await run(writeArgs());
    assert.equal(write.result.evidence.effect, 'committed');
    assert.equal(write.result.undo.available, true);
    assert.equal(write.result.undo.groupLabel, 'Set exact time');
});

test('outward responses omit wire-only Undo verification from result and audit', async () => {
    const read = await run(readArgs());
    const readResponse = nativeProgramResponse(read);
    assert.deepEqual(readResponse.undo, { available: false });
    assert.equal(Object.hasOwn(readResponse.audit, 'undoVerified'), false);

    const write = await run(writeArgs());
    const writeResponse = nativeProgramResponse(write);
    assert.deepEqual(writeResponse.undo, { available: true, groupLabel: 'Set exact time' });
    assert.equal(Object.hasOwn(writeResponse.audit, 'undoVerified'), false);
    assert.deepEqual(write.result.undo, {
        available: true,
        verified: false,
        groupLabel: 'Set exact time',
    });
});

test('each native result binding check rejects its own mismatch', async () => {
    const cases = [
        ['capabilityId', function (result) { result.capabilityId = 'ae.other'; }],
        ['operationKey', function (result) { result.operationKey = 'native-operation-key-0002'; }],
        ['requestId', function (result) { result.evidence.requestId = 'mcp-22222222222222222222222222222222'; }],
        ['hostInstanceId', function (result) { result.evidence.hostInstanceId = '33333333-3333-4333-8333-333333333333'; }],
        ['sessionId', function (result) { result.evidence.sessionId = '44444444-4444-4444-8444-444444444444'; }],
        ['requestDigest', function (result) { result.evidence.requestDigest = 'c'.repeat(64); }],
        ['completedAtUnixMs', function (result, request) { result.evidence.completedAtUnixMs = request.deadlineUnixMs + 1; }],
        ['operations', function (result) { result.operations[0].op = 'composition.settings.read'; }],
        ['outputs', function (result) { result.outputs.items = { invalid: true }; }],
        ['postcondition', function (result) { result.evidence.postcondition.digest = 'd'.repeat(64); }],
        ['undo.available', function (result) { result.undo.available = true; result.undo.groupLabel = 'unexpected'; }],
        ['undo.groupLabel', function (result) { result.undo.groupLabel = 'unexpected'; }],
        ['replayed', function (result) { result.replayed = true; }],
    ];
    for (const [label, mutate] of cases) {
        const args = label === 'operationKey' || label.indexOf('undo.') === 0
            ? writeArgs() : readArgs();
        await rejectsWithCode(run(args, mutate), args.operationKey ? 'POSSIBLY_SIDE_EFFECTING_FAILURE' : 'NATIVE_CONTRACT_MISMATCH');
    }
});

test('native error binding accepts matching details and rejects rebound failures', async () => {
    const request = buildNativeProgramRequest({ requestId: 'mcp-33333333333333333333333333333333', args: writeArgs(), deadlineUnixMs: Date.now() + 5000 });
    const matching = Object.assign(new Error('precondition'), {
        code: 'PRECONDITION_FAILED', retryable: false, sideEffect: 'not-started',
        details: { capabilityId: CAPABILITY_ID, operationKey: request.arguments.operationKey },
    });
    assert.doesNotThrow(function () { validateInvokeErrorBinding(matching, request); });
    const rebound = Object.assign(new Error('precondition'), {
        code: 'PRECONDITION_FAILED', retryable: false, sideEffect: 'not-started',
        details: { capabilityId: 'ae.other', operationKey: request.arguments.operationKey },
    });
    assert.throws(function () { validateInvokeErrorBinding(rebound, request); }, function (error) {
        assert.equal(error.code, 'POSSIBLY_SIDE_EFFECTING_FAILURE');
        return true;
    });
    const passThrough = Object.assign(new Error('disconnected'), { code: 'NATIVE_UNAVAILABLE', retryable: true });
    assert.doesNotThrow(function () { validateInvokeErrorBinding(passThrough, request); });
});

test('native failure details bind the completed prefix and reject a rebound prefix', () => {
    const request = buildNativeProgramRequest({
        requestId: 'mcp-44444444444444444444444444444444',
        args: writeArgs(),
        deadlineUnixMs: Date.now() + 5000,
    });
    const completedOperations = [{ index: 0, op: 'composition.resolve', status: 'completed' }];
    const outputs = {};
    const startedAtUnixMs = Date.now();
    const details = {
        capabilityId: CAPABILITY_ID,
        operationKey: request.arguments.operationKey,
        disposition: 'possibly-side-effecting',
        completedOperations,
        failedOperation: { index: 1, op: 'composition.time.set', status: 'failed' },
        outputs,
        evidence: {
            engine: 'native-aegp',
            hostInstanceId: NEGOTIATION.hostInstanceId,
            sessionId: NEGOTIATION.sessionId,
            requestId: request.requestId,
            capabilityId: CAPABILITY_ID,
            capabilityVersion: 1,
            startedAtUnixMs,
            completedAtUnixMs: startedAtUnixMs,
            effect: 'may-have-occurred',
            postcondition: {
                verified: false,
                kind: 'native-program',
                algorithm: 'sha256-rfc8785-jcs-v1',
                digest: nativeProgramPostconditionDigest(outputs, completedOperations),
            },
            requestDigest: invokeRequestDigest(request, NEGOTIATION),
        },
        undo: { available: false, verified: false },
    };
    assert.doesNotThrow(function () {
        validateNativeProgramFailureDetails(details, request, NEGOTIATION);
    });
    const rebound = Object.assign({}, details, {
        completedOperations: [{ index: 0, op: 'composition.settings.read', status: 'completed' }],
    });
    assert.throws(function () {
        validateNativeProgramFailureDetails(rebound, request, NEGOTIATION);
    }, function (error) {
        assert.equal(error.code, 'POSSIBLY_SIDE_EFFECTING_FAILURE');
        return true;
    });
});

test('native errors retain the structured Python-aligned fields', () => {
    const payload = nativeErrorPayload(Object.assign(new Error('native unavailable'), {
        code: 'NATIVE_UNAVAILABLE', retryable: true, sideEffect: 'not-started',
        recovery: { action: 'reconnect', hint: 'Reconnect.' }, details: { capabilityId: CAPABILITY_ID },
    }));
    assert.deepEqual(payload, {
        ok: false,
        error: 'native unavailable',
        code: 'NATIVE_UNAVAILABLE',
        retryable: true,
        sideEffect: 'not-started',
        recovery: { action: 'reconnect', hint: 'Reconnect.' },
        details: { capabilityId: CAPABILITY_ID },
    });
});
