'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');
const mountMcp = require('../index');
const { VERB_ANNOTATIONS } = require('../annotations');
const {
    CAPABILITY_ID,
    invokeRequestDigest,
    nativeProgramPostconditionDigest,
} = require('../native-program');
const { definition, VALIDATION_MESSAGE } = require('./native-exec');

const NEGOTIATION = {
    selectedWireVersion: 1,
    pluginVersion: '0.9.6-test',
    compiledSdkVersion: 'AEGP-test-sdk',
    sourceCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    hostInstanceId: '22222222-2222-4222-8222-222222222222',
    hostPlatform: 'windows-x64',
    sessionId: '11111111-1111-4111-8111-111111111111',
    sessionGeneration: 1,
    capabilitiesDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
};
const LOCATOR = {
    kind: 'composition',
    hostInstanceId: NEGOTIATION.hostInstanceId,
    sessionId: NEGOTIATION.sessionId,
    projectId: '33333333-3333-4333-8333-333333333333',
    generation: 1,
    objectId: '44444444-4444-4444-8444-444444444444',
};

function readArguments() {
    return { operations: [{ op: 'project.items.list', args: { offset: 0, limit: 1 } }] };
}

function writeArguments() {
    return {
        operationKey: 'native-operation-key-0001',
        undoGroup: 'Native write',
        operations: [
            { op: 'composition.resolve', args: { locator: LOCATOR }, saveAs: 'composition' },
            {
                op: 'composition.time.set',
                args: { composition: { ref: 'composition' }, targetTime: { value: 0, scale: 24 } },
            },
        ],
    };
}

function fakeInvoke(request) {
    const operations = request.arguments.operations.map(function (operation, index) {
        return { index, op: operation.op, status: 'completed' };
    });
    const outputs = {};
    const result = {
        capabilityId: CAPABILITY_ID,
        outputs,
        operations,
        evidence: {
            engine: 'native-aegp',
            hostInstanceId: NEGOTIATION.hostInstanceId,
            sessionId: NEGOTIATION.sessionId,
            requestId: request.requestId,
            capabilityId: CAPABILITY_ID,
            capabilityVersion: 1,
            startedAtUnixMs: Date.now() - 1,
            completedAtUnixMs: Date.now(),
            effect: request.arguments.operationKey ? 'committed' : 'none',
            postcondition: {
                verified: true,
                kind: 'native-program',
                algorithm: 'sha256-rfc8785-jcs-v1',
                digest: nativeProgramPostconditionDigest(outputs, operations),
            },
            requestDigest: invokeRequestDigest(request, NEGOTIATION),
        },
        undo: request.arguments.operationKey
            ? { available: true, verified: false, groupLabel: request.arguments.undoGroup }
            : { available: false, verified: false },
        replayed: false,
    };
    if (request.arguments.operationKey) result.operationKey = request.arguments.operationKey;
    return Promise.resolve(result);
}

function request(port, path, body, headers) {
    return new Promise(function (resolve, reject) {
        const text = JSON.stringify(body);
        const req = http.request({
            host: '127.0.0.1', port, path, method: 'POST', agent: false,
            headers: Object.assign({
                Connection: 'close', 'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(text),
            }, headers || {}),
        }, function (res) {
            let data = '';
            res.on('data', function (chunk) { data += chunk; });
            res.on('end', function () {
                resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null });
            });
        });
        req.on('error', reject);
        req.write(text);
        req.end();
    });
}

async function fixture(options) {
    const app = express();
    app.use(express.json());
    const input = options || {};
    const getStatus = function () { return { ok: true, pluginVersion: '0.9.6-test' }; };
    getStatus.nativeNegotiate = input.nativeNegotiate || async function () { return NEGOTIATION; };
    getStatus.nativeInvoke = input.nativeInvoke || fakeInvoke;
    const mounted = mountMcp(app, Object.assign({
        version: '0.9.6-test',
        getStatus,
        executeJsx: async function () { return { payload: { ok: true, result: '{}' } }; },
    }, input));
    const listener = await new Promise(function (resolve) {
        const value = app.listen(0, '127.0.0.1', function () { resolve(value); });
    });
    return { listener, port: listener.address().port, mounted };
}

async function initialize(host, conversationPath) {
    const response = await request(host.port, conversationPath || '/mcp', {
        jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'native-test' } },
    });
    return response.headers['mcp-session-id'];
}

async function callTool(host, session, name, argumentsValue, conversationPath) {
    return request(host.port, conversationPath || '/mcp', {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name, arguments: argumentsValue },
    }, { 'Mcp-Session-Id': session });
}

test('ae_nativeExec advertises the API-safe schema and central destructive annotation', () => {
    assert.equal(definition.name, 'ae_nativeExec');
    assert.equal(definition.inputSchema.type, 'object');
    ['allOf', 'anyOf', 'oneOf'].forEach(function (key) {
        assert.equal(Object.prototype.hasOwnProperty.call(definition.inputSchema, key), false, key);
    });
    assert.deepEqual(
        {
            readOnlyHint: definition.annotations.readOnlyHint,
            destructiveHint: definition.annotations.destructiveHint,
            idempotentHint: definition.annotations.idempotentHint,
        },
        VERB_ANNOTATIONS.ae_nativeExec,
    );
});

test('real Express MCP route runs ae_nativeExec through fake negotiate/invoke', async () => {
    const host = await fixture();
    try {
        const session = await initialize(host);
        const response = await callTool(host, session, 'ae_nativeExec', readArguments());
        assert.equal(response.status, 200);
        const content = response.body.result.structuredContent;
        assert.equal(content.ok, true, JSON.stringify(content));
        assert.equal(content.evidence.engine, 'native-aegp');
        assert.equal(content.provenance.sessionId, NEGOTIATION.sessionId);
        assert.equal(content.audit.capabilityId, CAPABILITY_ID);
        assert.equal(content.audit.undoAvailable, false);
    } finally {
        await new Promise(function (resolve) { host.listener.close(resolve); });
    }
});

test('ae_nativeExec returns generated-schema errors before approval or native dispatch', async () => {
    let invoked = false;
    const host = await fixture({ nativeInvoke: async function () { invoked = true; return fakeInvoke.apply(null, arguments); } });
    try {
        const session = await initialize(host);
        const response = await callTool(host, session, 'ae_nativeExec', { operations: [] });
        assert.equal(response.body.result.isError, true);
        assert.equal(response.body.result.structuredContent.error, VALIDATION_MESSAGE);
        assert.ok(Array.isArray(response.body.result.structuredContent.errors));
        assert.equal(invoked, false);
    } finally {
        await new Promise(function (resolve) { host.listener.close(resolve); });
    }
});

test('native errors retain the structured payload and approval gate blocks readonly writes / queues manual writes', async () => {
    let negotiateCalls = 0;
    let approvalCalls = 0;
    const nativeFailure = Object.assign(new Error('native unavailable'), {
        code: 'NATIVE_UNAVAILABLE', retryable: true, sideEffect: 'not-started',
        recovery: { action: 'reconnect', hint: 'Reconnect native.' },
    });
    const host = await fixture({
        nativeNegotiate: async function () {
            negotiateCalls += 1;
            throw nativeFailure;
        },
        approvals: { request: async function () { approvalCalls += 1; return 'accept'; } },
    });
    try {
        const readonlyConversation = host.mounted.conversations.create({
            label: 'readonly', policy: { approvalTier: 'readonly' },
        });
        const readonlySession = await initialize(host, readonlyConversation.path);
        const blocked = await callTool(host, readonlySession, 'ae_nativeExec', writeArguments(), readonlyConversation.path);
        assert.equal(blocked.body.result.isError, true);
        assert.match(blocked.body.result.structuredContent.error, /read-only approval tier/, JSON.stringify(blocked.body.result.structuredContent));
        assert.equal(negotiateCalls, 0);

        const manualConversation = host.mounted.conversations.create({
            label: 'manual', policy: { approvalTier: 'manual' },
        });
        const manualSession = await initialize(host, manualConversation.path);
        const failed = await callTool(host, manualSession, 'ae_nativeExec', writeArguments(), manualConversation.path);
        assert.equal(failed.body.result.isError, true);
        assert.equal(failed.body.result.structuredContent.code, 'NATIVE_UNAVAILABLE');
        assert.equal(failed.body.result.structuredContent.error, 'native unavailable');
        assert.equal(failed.body.result.structuredContent.sideEffect, 'not-started');
        assert.equal(approvalCalls, 1);
        assert.equal(negotiateCalls, 1);
    } finally {
        await new Promise(function (resolve) { host.listener.close(resolve); });
    }
});
