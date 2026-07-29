import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CAPABILITY_DESCRIPTORS, NATIVE_EXEC_INPUT_SCHEMA, NATIVE_EXEC_REGISTRY_DIGEST, PRIMITIVES,
} from './native_exec.generated.mjs';
import {
  ERROR_POLICIES, LIMITS, decodeFrame, encodeFrame, schemaAccepts, selectWireVersion,
  strictParseJson,
} from './conformance.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(fs.readFileSync(path.join(here, 'aegp-rpc.schema.json'), 'utf8'));
const sessionId = '11111111-1111-4111-8111-111111111111';
const locator = {
  kind: 'composition', hostInstanceId: '22222222-2222-4222-8222-222222222222',
  sessionId, projectId: '44444444-4444-4444-8444-444444444444', generation: 1,
  objectId: '66666666-6666-4666-8666-666666666666',
};

function nativeRequest(argumentsValue) {
  return {
    wireVersion: 1, kind: 'request', sessionId, requestId: 'native-program', method: 'invoke',
    params: { capabilityId: 'ae.native.exec', capabilityVersion: 1, arguments: argumentsValue },
  };
}

test('native program is the sole invoke wire shape', () => {
  const valid = nativeRequest({
    operations: [{ op: 'composition.resolve', args: { locator }, saveAs: 'composition' }],
  });
  assert.equal(schemaAccepts(schema.$defs.request, valid, schema), true);
  const legacy = nativeRequest({});
  legacy.params.capabilityId = 'ae.layer.track-matte.set';
  assert.equal(schemaAccepts(schema.$defs.request, legacy, schema), false);
  const unknown = nativeRequest({ operations: [{ op: 'unknown.op', args: {} }] });
  assert.equal(schemaAccepts(schema.$defs.request, unknown, schema), false);
});

test('generated primitive projection is the reference-typing source', () => {
  assert.equal(PRIMITIVES.length, 23);
  const layerResolve = PRIMITIVES.find(({ id }) => id === 'layer.resolve');
  const layerProperties = PRIMITIVES.find(({ id }) => id === 'layer.properties.list');
  assert.deepEqual(layerResolve.referenceArguments.composition,
    { kind: 'CompositionHandle', required: true });
  assert.deepEqual(layerProperties.referenceArguments.parentProperty,
    { kind: 'PropertyHandle', required: false });
  assert.equal(NATIVE_EXEC_INPUT_SCHEMA.properties.operations.maxItems, 64);
});

test('native program schema rejects extra envelope and operation fields', () => {
  const valid = nativeRequest({
    operations: [{ op: 'composition.resolve', args: { locator }, saveAs: 'composition' }],
  });
  const extraEnvelope = structuredClone(valid);
  extraEnvelope.params.arguments.extra = true;
  assert.equal(schemaAccepts(schema.$defs.request, extraEnvelope, schema), false);
  const extraOperation = structuredClone(valid);
  extraOperation.params.arguments.operations[0].loop = true;
  assert.equal(schemaAccepts(schema.$defs.request, extraOperation, schema), false);
});

test('framing and independent control-plane schemas remain closed', () => {
  const hello = { wireVersion: 1, kind: 'request', requestId: 'hello-1', method: 'hello',
    params: { supportedWireVersions: { minimum: 1, maximum: 1 },
      client: { component: 'core-broker', version: 'test', instanceId: sessionId },
      nonce: 'abcdefghijklmnopqrstuvwxyzABCDEF' } };
  assert.equal(decodeFrame(encodeFrame(hello)).params.client.component, 'core-broker');
  assert.equal(schemaAccepts(schema.$defs.cancelParams, { targetRequestId: 'request-1' }, schema), true);
  assert.equal(schemaAccepts(schema.$defs.invalidateGraphParams, { reason: 'cep-jsx' }, schema), true);
  assert.equal(schemaAccepts(schema.$defs.capabilitiesParams, { detail: 'summary', limit: 1 }, schema), true);
  const cancel = { wireVersion: 1, kind: 'request', sessionId, requestId: 'cancel-1', method: 'cancel',
    params: { targetRequestId: 'native-program' } };
  const invalidate = { wireVersion: 1, kind: 'request', sessionId, requestId: 'invalidate-1',
    method: 'invalidateGraph', params: { reason: 'cep-jsx' } };
  assert.equal(schemaAccepts(schema.$defs.request, cancel, schema), true);
  assert.equal(schemaAccepts(schema.$defs.request, invalidate, schema), true);
  assert.equal(schemaAccepts(schema.$defs.request, {
    ...cancel, params: { ...cancel.params, extra: true },
  }, schema), false);
  assert.equal(schemaAccepts(schema.$defs.request, {
    ...invalidate, params: { ...invalidate.params, extra: true },
  }, schema), false);
  assert.equal(schemaAccepts(schema.$defs.request, {
    ...nativeRequest({ operations: [{ op: 'project.items.list', args: { offset: 0, limit: 1 } }] }),
    sessionId: undefined,
  }, schema), false);
  assert.equal(schemaAccepts(schema.$defs.request, {
    ...cancel, deadlineUnixMs: 0,
  }, schema), false);
  assert.equal(schemaAccepts(schema.$defs.capabilitiesParams, { limit: 101 }, schema), false);
});

test('strict framing and JSON limits remain independently covered', () => {
  assert.throws(() => decodeFrame(Buffer.from([0, 0, 0, 0])));
  assert.throws(() => strictParseJson('{"x":1,"x":2}'));
  assert.throws(() => strictParseJson('{"x":"\ud800"}'));
  assert.equal(LIMITS.maxFrameBytes, 524288);
});

test('hello/session/version negotiation remains closed independently of invoke', () => {
  const hello = { wireVersion: 1, kind: 'request', requestId: 'hello-1', method: 'hello',
    params: { supportedWireVersions: { minimum: 1, maximum: 1 },
      client: { component: 'core-broker', version: 'test', instanceId: sessionId },
      nonce: 'abcdefghijklmnopqrstuvwxyzABCDEF' } };
  assert.equal(schemaAccepts(schema.$defs.helloRequest, hello, schema), true);
  assert.equal(schemaAccepts(schema.$defs.helloRequest, { ...hello, sessionId }, schema), false);
  assert.equal(selectWireVersion({ minimum: 1, maximum: 1 }, { minimum: 1, maximum: 1 }), 1);
});

test('generated capabilities summary/full and generic error policy remain valid', () => {
  for (const detail of ['summary', 'full']) {
    for (const descriptor of CAPABILITY_DESCRIPTORS[detail]) {
      assert.equal(schemaAccepts(schema.$defs.nativePrimitiveDescriptor, descriptor, schema), true);
    }
    const result = { detail, items: CAPABILITY_DESCRIPTORS[detail],
      nextCursor: null, queryDigest: 'a'.repeat(64), capabilitiesDigest: NATIVE_EXEC_REGISTRY_DIGEST };
    const response = { wireVersion: 1, kind: 'response', ok: true, method: 'capabilities',
      requestId: `capabilities-${detail}`, sessionId, replayed: false, result };
    assert.equal(schemaAccepts(schema.$defs.capabilitiesResult, result, schema), true, detail);
    assert.equal(schemaAccepts(schema.$defs.response, response, schema), true, detail);
    result.items = CAPABILITY_DESCRIPTORS[detail === 'summary' ? 'full' : 'summary'];
    assert.equal(schemaAccepts(schema.$defs.capabilitiesResult, result, schema), false, `${detail} binding`);
  }
  const retryableError = {
    code: 'NATIVE_UNAVAILABLE', message: 'executor absent', retryable: true,
    sideEffect: 'not-started', recovery: { action: 'reconnect', hint: 'native executor is unavailable' },
  };
  assert.equal(schemaAccepts(schema.$defs.rpcError, retryableError, schema), true);
  assert.equal(schemaAccepts(schema.$defs.rpcError, { ...retryableError, extra: true }, schema), false);
  assert.equal(schemaAccepts(schema.$defs.cancelResult, {
    targetRequestId: 'native-program', state: 'queued-cancelled', terminalResponseExpected: true,
  }, schema), true);
  assert.equal(schemaAccepts(schema.$defs.invalidateGraphResult, { generation: 1, invalidated: true }, schema), true);
  for (const [code, [retryable, sideEffect, action]] of Object.entries(ERROR_POLICIES)) {
    assert.equal(typeof retryable, 'boolean', code);
    assert.ok(['not-started', 'completed', 'possibly-side-effecting', 'may-have-occurred'].includes(sideEffect), code);
    assert.equal(typeof action, 'string', code);
  }
});
