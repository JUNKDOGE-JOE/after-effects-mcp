import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  AdmissionController,
  ERROR_POLICIES,
  FrameDecoder,
  LIMITS,
  RequestLedger,
  assertJsonLimits,
  canonicalize,
  capabilityDigest,
  capabilityQueryDigest,
  classifyRequest,
  decodeAndClassifyRequest,
  decodeAndValidateProgressEvent,
  decodeAndValidateResponse,
  decodeFrame,
  encodeFrame,
  materializeDeadline,
  nativeCapabilityRegistry,
  postconditionDigest,
  projectBitDepthReadDescriptor,
  projectBitDepthSetDescriptor,
  projectSummaryContractDigest,
  projectSummaryDescriptor,
  schemaAccepts as productSchemaAccepts,
  selectWireVersion,
  sha256Jcs,
  strictParseJson,
  unicodeScalarLength,
  validateCancelResult,
  validateCancelExchange,
  validateCapabilitiesExchange,
  validateCapabilityDescriptor,
  validateErrorPolicy,
  validateFailureExchange,
  validateHelloFailure,
  validateHelloExchange,
  validateIdempotencyContract,
  validateLocator,
  validateProgressEvent,
  validateRequestComposite,
  validateResponseShape,
  validateTranscript,
} from './conformance.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');
const schema = readJson(path.join(here, 'aegp-rpc.schema.json'));
const SESSION = '11111111-1111-4111-8111-111111111111';
const HOST = '22222222-2222-4222-8222-222222222222';
const PROJECT = '44444444-4444-4444-8444-444444444444';
const OBJECT = '55555555-5555-4555-8555-555555555555';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function schemaAccepts(candidate, value, root = schema) {
  return productSchemaAccepts(candidate, value, root);
}

function frameFromText(text) {
  const body = Buffer.from(text, 'utf8');
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

function golden(name) {
  return readJson(path.join(fixtures, name));
}

function errorVector(code) {
  const [retryable, sideEffect, action] = ERROR_POLICIES[code];
  const vector = {
    code,
    message: `Synthetic ${code} vector.`,
    retryable,
    sideEffect,
    recovery: {
      action,
      hint: 'Synthetic bounded recovery guidance.',
      ...(code === 'QUEUE_FULL' ? { retryAfterMs: 250 } : {}),
    },
  };
  if (code === 'WIRE_VERSION_MISMATCH') {
    vector.details = { supportedWireVersions: { minimum: 1, maximum: 1 } };
  }
  if (['NATIVE_UNSUPPORTED', 'PRECONDITION_FAILED', 'STALE_LOCATOR', 'CAPABILITY_FAILED',
    'POSSIBLY_SIDE_EFFECTING_FAILURE'].includes(code)) {
    vector.details = { capabilityId: 'ae.project.summary' };
  }
  return vector;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function randomJson(random, depth = 0) {
  const variant = depth >= 4 ? Math.floor(random() * 4) : Math.floor(random() * 6);
  if (variant === 0) return null;
  if (variant === 1) return random() >= 0.5;
  if (variant === 2) return Math.floor(random() * 2000000) - 1000000;
  if (variant === 3) return `s-${Math.floor(random() * 1000000)}-合成`;
  if (variant === 4) {
    return Array.from({ length: Math.floor(random() * 5) }, () => randomJson(random, depth + 1));
  }
  const result = {};
  for (let index = 0; index < Math.floor(random() * 5); index += 1) {
    result[`k${depth}-${index}`] = randomJson(random, depth + 1);
  }
  return result;
}

function successForRequest(request, startedAtUnixMs) {
  const response = structuredClone(golden('invoke-project-summary.json').response);
  response.requestId = request.requestId;
  response.sessionId = request.sessionId;
  response.replayed = false;
  response.result.evidence.sessionId = request.sessionId;
  response.result.evidence.requestId = request.requestId;
  response.result.evidence.startedAtUnixMs = startedAtUnixMs;
  response.result.evidence.completedAtUnixMs = startedAtUnixMs + 25;
  response.result.evidence.requestDigest = sha256Jcs(request);
  return response;
}

function strictTerminalValidator(request, response, timing) {
  const hello = golden('hello.json');
  const descriptor = projectSummaryDescriptor(schema);
  if (response.ok === false) {
    return validateFailureExchange(hello, request, response, descriptor, schema);
  }
  return validateTranscript({
    hello,
    descriptor,
    schema,
    brokerSendUnixMs: timing.brokerSendUnixMs,
    effectiveDeadlineUnixMs: timing.effectiveDeadlineUnixMs,
    terminalObservedUnixMs: timing.terminalObservedUnixMs,
  }, request, [response]);
}

test('schema locks strict framing, bounded defaults, rate limits, and native provenance', () => {
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.deepEqual(schema['x-framing'], {
    lengthPrefixBytes: 4,
    byteOrder: 'big-endian',
    encoding: 'utf-8',
    maxFrameBytes: 65536,
    maxJsonDepth: 16,
    maxJsonNodes: 2048,
    maxStringLength: 8192,
    stringLengthUnit: 'unicode-scalar-values',
    duplicateObjectKeys: 'reject',
  });
  assert.equal(schema['x-lifecycle'].defaultDeadlineMs, 5000);
  assert.equal(schema['x-lifecycle'].maximumDeadlineMs, 30000);
  assert.equal(schema['x-lifecycle'].pagination, 'unsupported-in-v1');
  assert.equal(schema['x-lifecycle'].terminalObservationClockToleranceMs, 0);
  assert.equal(schema['x-digests'].propertyNameSort, 'utf-16-code-units');
  assert.deepEqual(schema.$defs.method.enum, ['hello', 'capabilities', 'invoke', 'cancel']);
  assert.equal(schema.$defs.executionEvidence.properties.engine.const, 'native-aegp');
  assert.equal(schema.$defs.negotiatedLimits.required.includes('maxRequestsPerSecond'), true);
  assert.equal(schema.$defs.negotiatedLimits.required.includes('maxBurst'), true);
  assert.equal(schema.$defs.negotiatedLimits.required.includes('maxControlRequestsPerSecond'), true);
  assert.equal(schema.$defs.negotiatedLimits.required.includes('maxControlBurst'), true);
  assert.equal(schema.$defs.negotiatedLimits.required.includes('maxTerminalCacheEntries'), true);
  assert.equal(schema.$defs.capabilitiesParams.properties.detail.default, 'summary');
  assert.equal(schema.$defs.capabilitiesParams.properties.limit.default, 50);
  assert.equal(schema.$defs.capabilitiesParams.properties.cursor, undefined);
  assert.deepEqual(schema.$defs.capabilitiesResultBase.properties.nextCursor, { type: 'null' });
});

test('repository CI executes this contract on Windows, Linux, and stacked PR bases', () => {
  const ci = fs.readFileSync(path.join(here, '..', '..', '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /\n  pull_request: \{\}\n/);
  const command = 'node --test native/ae-plugin/protocol/protocol.test.mjs';
  assert.equal(ci.split(command).length - 1, 2);
  assert.match(ci, /runs-on: windows-2022/);
  assert.match(ci, /runs-on: ubuntu-24\.04/);
});

test('all checked-in vectors are synthetic and contain no host or Adobe suite claim', () => {
  for (const name of [
    'hello.json',
    'capabilities.json',
    'invoke-project-summary.json',
    'invoke-project-bit-depth-read.json',
    'invoke-project-bit-depth-set.json',
    'cancel.json',
    'errors.json',
    'negative-corpus.json',
    'framing-corpus.json',
    'version-negotiation.json',
  ]) {
    const fixture = golden(name);
    assert.deepEqual(fixture._fixture, {
      classification: 'synthetic-contract-vector',
      runtimeEvidence: false,
      compatibilityEvidence: false,
    });
  }
  const publicText = [
    fs.readFileSync(path.join(here, 'README.md'), 'utf8'),
    fs.readFileSync(path.join(here, 'aegp-rpc.schema.json'), 'utf8'),
    fs.readFileSync(path.join(fixtures, 'capabilities.json'), 'utf8'),
  ].join('\n');
  assert.doesNotMatch(publicText, /25\.6\.61|26\.3\.0|AEGP_[A-Za-z0-9_]*Suite/u);
  assert.match(publicText, /product-owned/);
  assert.match(publicText, /not.*evidence/isu);
});

test('golden requests, events, responses, and bound error policies validate', () => {
  for (const name of [
    'hello.json',
    'capabilities.json',
    'invoke-project-summary.json',
    'invoke-project-bit-depth-read.json',
    'invoke-project-bit-depth-set.json',
    'cancel.json',
  ]) {
    const fixture = golden(name);
    assert.equal(schemaAccepts(schema.$defs.request, fixture.request), true, `${name} request`);
    for (const event of fixture.events ?? []) {
      assert.equal(schemaAccepts(schema.$defs.progressEvent, event), true, `${name} event`);
    }
    assert.equal(schemaAccepts(schema.$defs.response, fixture.response), true, `${name} response`);
    assert.equal(fixture.response.requestId, fixture.request.requestId);
    assert.equal(fixture.response.method, fixture.request.method);
  }
  for (const [name, response] of Object.entries(golden('errors.json').responses)) {
    assert.equal(schemaAccepts(schema.$defs.response, response), true, name);
    assert.equal(validateErrorPolicy(response.error, schema), true, name);
  }
});

test('invalid requests are rejected with their exact bounded error classification', () => {
  for (const seed of golden('negative-corpus.json').vectors) {
    assert.equal(schemaAccepts(schema.$defs.request, seed.message), false, seed.name);
    assert.deepEqual(classifyRequest(seed.message), {
      ok: false,
      errorCode: seed.expectedErrorCode,
    }, seed.name);
  }
});

test('strict framing handles UTF-8, fragments, multiple frames, and malformed JSON safely', () => {
  const first = { message: '合成向量', value: 1 };
  const second = { message: 'second', value: 2 };
  const firstFrame = encodeFrame(first);
  assert.equal(firstFrame.readUInt32BE(0), firstFrame.length - 4);
  assert.equal(canonicalize(decodeFrame(firstFrame)), canonicalize(first));

  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(firstFrame.subarray(0, 2)), []);
  assert.deepEqual(decoder.push(firstFrame.subarray(2, 7)), []);
  assert.equal(canonicalize(decoder.push(firstFrame.subarray(7))[0]), canonicalize(first));
  assert.deepEqual(decoder.finalize(), []);
  const combined = Buffer.concat([firstFrame, encodeFrame(second)]);
  assert.deepEqual(new FrameDecoder().push(combined).map(canonicalize), [
    canonicalize(first), canonicalize(second),
  ]);

  const boundedItems = Array.from({ length: 1000 }, () => 'x'.repeat(58));
  const emptyPadLength = Buffer.byteLength(canonicalize({ items: boundedItems, pad: '' }), 'utf8');
  const exactMaximum = { items: boundedItems, pad: 'x'.repeat(LIMITS.maxFrameBytes - emptyPadLength) };
  const maximumFrame = encodeFrame(exactMaximum);
  assert.equal(maximumFrame.readUInt32BE(0), LIMITS.maxFrameBytes);
  assert.equal(canonicalize(decodeFrame(maximumFrame)), canonicalize(exactMaximum));
  assert.throws(() => encodeFrame({ ...exactMaximum, pad: `${exactMaximum.pad}x` }), {
    code: 'INVALID_REQUEST',
  });

  for (let length = 0; length < firstFrame.length; length += 1) {
    assert.throws(() => decodeFrame(firstFrame.subarray(0, length)), { code: 'INVALID_REQUEST' });
  }

  for (const seed of golden('framing-corpus.json').vectors) {
    assert.throws(() => decodeFrame(Buffer.from(seed.hex, 'hex')), { code: seed.expectedErrorCode }, seed.name);
  }
  assert.throws(() => decodeFrame(frameFromText('{"a":1,"a":2}')), { code: 'INVALID_REQUEST' });
  assert.throws(() => strictParseJson(`${'['.repeat(17)}0${']'.repeat(17)}`), { code: 'INVALID_REQUEST' });
  assert.throws(() => strictParseJson(`[${'0,'.repeat(2048)}0]`), { code: 'INVALID_REQUEST' });
  assert.throws(() => strictParseJson(JSON.stringify('x'.repeat(8193))), { code: 'INVALID_REQUEST' });
  assert.throws(() => strictParseJson('{"n":9007199254740993}'), { code: 'INVALID_REQUEST' });
});

test('input and output codecs enforce the same exact JSON limits', () => {
  const depth16 = Array.from({ length: 15 }).reduce((value) => [value], 0);
  const depth17 = [depth16];
  assert.equal(assertJsonLimits(depth16), true);
  assert.doesNotThrow(() => encodeFrame(depth16));
  assert.throws(() => assertJsonLimits(depth17), { code: 'INVALID_REQUEST' });
  assert.throws(() => encodeFrame(depth17), { code: 'INVALID_REQUEST' });

  const nodes2048 = Array.from({ length: 2047 }, () => 0);
  assert.equal(assertJsonLimits(nodes2048), true);
  assert.throws(() => assertJsonLimits([...nodes2048, 0]), { code: 'INVALID_REQUEST' });
  assert.doesNotThrow(() => encodeFrame('x'.repeat(8192)));
  assert.throws(() => encodeFrame('x'.repeat(8193)), { code: 'INVALID_REQUEST' });
  assert.throws(() => encodeFrame({ ['x'.repeat(8193)]: true }), { code: 'INVALID_REQUEST' });
  assert.throws(() => encodeFrame('\ud800'), { code: 'INVALID_REQUEST' });
});

test('Unicode bounds count scalar values and reject lone surrogates symmetrically', () => {
  const atLimit = '😀'.repeat(LIMITS.maxStringLength);
  const overLimit = `${atLimit}😀`;
  assert.equal(unicodeScalarLength('😀'), 1);
  assert.equal(unicodeScalarLength(atLimit), LIMITS.maxStringLength);
  assert.equal(strictParseJson(JSON.stringify(atLimit)), atLimit);
  assert.doesNotThrow(() => encodeFrame(atLimit));
  assert.throws(() => strictParseJson(JSON.stringify(overLimit)), { code: 'INVALID_REQUEST' });
  assert.throws(() => encodeFrame(overLimit), { code: 'INVALID_REQUEST' });
  assert.doesNotThrow(() => encodeFrame({ [atLimit]: true }));
  assert.throws(() => encodeFrame({ [overLimit]: true }), { code: 'INVALID_REQUEST' });
  for (const value of ['\ud800', '\udc00', `valid😀\ud800`]) {
    assert.throws(() => unicodeScalarLength(value), { code: 'INVALID_REQUEST' });
    assert.throws(() => strictParseJson(JSON.stringify(value)), { code: 'INVALID_REQUEST' });
    assert.throws(() => canonicalize(value), { code: 'INVALID_REQUEST' });
  }

  const resultSchema = projectSummaryDescriptor(schema).resultSchema;
  assert.equal(schemaAccepts(resultSchema, {
    projectOpen: true,
    projectName: '😀'.repeat(1024),
    itemCount: 1,
  }, resultSchema), true);
  assert.equal(schemaAccepts(resultSchema, {
    projectOpen: true,
    projectName: '😀'.repeat(1025),
    itemCount: 1,
  }, resultSchema), false);
});

test('RFC 8785 canonicalization covers Unicode and the safe numeric subset', () => {
  assert.equal(canonicalize(-0), '0');
  assert.equal(canonicalize(333333333.33333329), '333333333.3333333');
  assert.equal(JSON.stringify(1e30), '1e+30',
    'RFC 8785 delegates numeric spelling to ECMAScript');
  assert.throws(() => canonicalize(1e30), { code: 'INVALID_REQUEST' },
    'the wire contract deliberately rejects unsafe integral doubles before JCS');
  assert.equal(canonicalize(4.5), '4.5');
  assert.equal(canonicalize(2e-3), '0.002');
  assert.equal(canonicalize(1e-27), '1e-27');
  assert.equal(canonicalize({ accent: 'é', emoji: '😀' }), '{"accent":"é","emoji":"😀"}');
  assert.equal(canonicalize({ '\ue000': 1, '😀': 2 }), '{"😀":2,"\ue000":1}',
    'RFC 8785 sorts property names by UTF-16 code units, not Unicode code points');
});

test('fixed-seed framing property fuzz round-trips chunks and rejects EOF truncation', () => {
  const random = seededRandom(0xaee07201);
  for (let iteration = 0; iteration < 384; iteration += 1) {
    const value = randomJson(random);
    const frame = encodeFrame(value);
    const decoder = new FrameDecoder();
    const decoded = [];
    for (let offset = 0; offset < frame.length;) {
      const width = 1 + Math.floor(random() * Math.min(31, frame.length - offset));
      decoded.push(...decoder.push(frame.subarray(offset, offset + width)));
      offset += width;
    }
    decoder.finalize();
    assert.equal(decoded.length, 1, `iteration ${iteration}`);
    assert.equal(canonicalize(decoded[0]), canonicalize(value), `iteration ${iteration}`);

    const cut = 1 + Math.floor(random() * (frame.length - 1));
    const truncated = new FrameDecoder();
    truncated.push(frame.subarray(0, cut));
    assert.throws(() => truncated.finalize(), { code: 'INVALID_REQUEST' }, `iteration ${iteration}`);
  }
});

test('wire negotiation, hello nonce/session, and platform architecture are cross-bound', () => {
  assert.equal(selectWireVersion({ minimum: 1, maximum: 3 }, { minimum: 1, maximum: 2 }), 2);
  assert.equal(selectWireVersion({ minimum: 1, maximum: 1 }, { minimum: 2, maximum: 4 }), null);
  assert.throws(() => selectWireVersion({ minimum: 2, maximum: 1 }, { minimum: 1, maximum: 1 }), {
    code: 'INVALID_ARGUMENT',
  });
  const fixture = golden('hello.json');
  assert.equal(validateHelloExchange(fixture.request, fixture.response, schema), true);
  assert.equal(validateHelloExchange(fixture.request, {
    ...fixture.response,
    sessionId: '44444444-4444-4444-8444-444444444444',
  }, schema), false);
  assert.equal(validateHelloExchange(fixture.request, {
    ...fixture.response,
    result: { ...fixture.response.result, clientNonce: 'Z'.repeat(32) },
  }, schema), false);
  assert.equal(validateHelloExchange(fixture.request, {
    ...fixture.response,
    result: {
      ...fixture.response.result,
      compiledSdk: { ...fixture.response.result.compiledSdk, architecture: 'x86_64' },
    },
  }, schema), false);

  const mismatchRequest = {
    ...fixture.request,
    requestId: 'hello-2',
    params: {
      ...fixture.request.params,
      supportedWireVersions: { minimum: 2, maximum: 3 },
    },
  };
  const mismatch = golden('errors.json').responses.wireVersionMismatch;
  assert.equal(validateHelloFailure(mismatchRequest, mismatch, schema), true);
  assert.equal(validateHelloFailure(
    mismatchRequest, { ...mismatch, sessionId: SESSION }, schema,
  ), false);
});

test('schema shape and composite request validation have an explicit differential boundary', () => {
  const validRequests = [
    golden('hello.json').request,
    golden('capabilities.json').request,
    golden('invoke-project-summary.json').request,
    golden('invoke-project-bit-depth-read.json').request,
    golden('invoke-project-bit-depth-set.json').request,
    golden('cancel.json').request,
  ];
  for (const request of validRequests) {
    assert.equal(schemaAccepts(schema.$defs.request, request), true);
    assert.deepEqual(validateRequestComposite(request, schema), { ok: true });
    const decoded = decodeAndClassifyRequest(encodeFrame(request), schema);
    assert.equal(decoded.ok, true);
    assert.equal(canonicalize(decoded.message), canonicalize(request));
  }

  const hello = golden('hello.json').request;
  const tooHighWire = structuredClone(hello);
  tooHighWire.params.supportedWireVersions.maximum = 65536;
  const missingNonce = structuredClone(hello);
  delete missingNonce.params.nonce;
  const capabilities = golden('capabilities.json').request;
  const longCapabilityId = structuredClone(capabilities);
  longCapabilityId.params.ids = [`ae.${'a'.repeat(94)}`];
  const duplicateIds = structuredClone(capabilities);
  duplicateIds.params.ids = ['ae.project.summary', 'ae.project.summary'];
  for (const candidate of [tooHighWire, missingNonce, longCapabilityId, duplicateIds]) {
    assert.equal(schemaAccepts(schema.$defs.request, candidate), false);
    assert.equal(validateRequestComposite(candidate, schema).ok, false);
  }

  const reversedRange = structuredClone(hello);
  reversedRange.params.supportedWireVersions = { minimum: 2, maximum: 1 };
  assert.equal(schemaAccepts(schema.$defs.request, reversedRange), true,
    'Draft 2020-12 intentionally ignores the documented x-invariant');
  assert.deepEqual(validateRequestComposite(reversedRange, schema), {
    ok: false, errorCode: 'INVALID_ARGUMENT',
  });
  assert.deepEqual(decodeAndClassifyRequest(encodeFrame(reversedRange), schema), {
    ok: false, errorCode: 'INVALID_ARGUMENT',
  });
  assert.deepEqual(decodeAndClassifyRequest(Buffer.from([0]), schema), {
    ok: false, errorCode: 'INVALID_REQUEST',
  });

  const invoke = golden('invoke-project-summary.json');
  for (const event of invoke.events) {
    assert.equal(schemaAccepts(schema.$defs.progressEvent, event), true);
    assert.equal(validateProgressEvent(event, invoke.request, schema), true);
  }
  const missingMessage = structuredClone(invoke.events[0]);
  delete missingMessage.progress.message;
  const longMessage = structuredClone(invoke.events[0]);
  longMessage.progress.message = '😀'.repeat(161);
  const wrongKind = structuredClone(invoke.events[0]);
  wrongKind.kind = 'response';
  for (const event of [missingMessage, longMessage, wrongKind]) {
    assert.equal(schemaAccepts(schema.$defs.progressEvent, event), false);
    assert.equal(validateProgressEvent(event, invoke.request, schema), false);
  }
  const wrongSession = structuredClone(invoke.events[0]);
  wrongSession.sessionId = '77777777-7777-4777-8777-777777777777';
  assert.equal(schemaAccepts(schema.$defs.progressEvent, wrongSession), true);
  assert.equal(validateProgressEvent(wrongSession, invoke.request, schema), false,
    'composite validation adds request/session binding');
});

test('response and event decode composites enforce closed root shapes before semantics', () => {
  const hello = golden('hello.json');
  const invoke = golden('invoke-project-summary.json');
  const decodedResponse = decodeAndValidateResponse(encodeFrame(hello.response), schema);
  assert.equal(decodedResponse.ok, true);
  assert.equal(validateResponseShape(decodedResponse.message, schema), true);
  const decodedEvent = decodeAndValidateProgressEvent(encodeFrame(invoke.events[0]), schema);
  assert.equal(decodedEvent.ok, true);

  const extraEnvelope = { ...hello.response, unexpected: true };
  const missingHelloField = structuredClone(hello.response);
  delete missingHelloField.result.pluginVersion;
  const overBoundLimit = structuredClone(hello.response);
  overBoundLimit.result.limits.maxInFlight = 65;
  for (const candidate of [extraEnvelope, missingHelloField, overBoundLimit]) {
    assert.equal(validateResponseShape(candidate, schema), false);
    assert.deepEqual(decodeAndValidateResponse(encodeFrame(candidate), schema), {
      ok: false, errorCode: 'INVALID_REQUEST',
    });
    assert.equal(validateHelloExchange(hello.request, candidate, schema), false);
  }

  const capabilities = golden('capabilities.json');
  const extraResult = structuredClone(capabilities.response);
  extraResult.result.unexpected = true;
  const missingDigest = structuredClone(capabilities.response);
  delete missingDigest.result.queryDigest;
  const invalidDetail = structuredClone(capabilities.response);
  invalidDetail.result.detail = 'verbose';
  for (const candidate of [extraResult, missingDigest, invalidDetail]) {
    assert.equal(validateResponseShape(candidate, schema), false);
    assert.equal(validateCapabilitiesExchange(
      hello, capabilities.request, candidate, schema,
    ), false);
  }

  const malformedFailure = structuredClone(golden('errors.json').responses.wireVersionMismatch);
  delete malformedFailure.error.message;
  assert.equal(validateHelloFailure({
    ...hello.request,
    requestId: malformedFailure.requestId,
    params: {
      ...hello.request.params,
      supportedWireVersions: { minimum: 2, maximum: 3 },
    },
  }, malformedFailure, schema), false);

  const malformedEvent = structuredClone(invoke.events[0]);
  malformedEvent.progress.extra = true;
  assert.deepEqual(decodeAndValidateProgressEvent(encodeFrame(malformedEvent), schema), {
    ok: false, errorCode: 'INVALID_REQUEST',
  });
  assert.equal(productSchemaAccepts({
    type: 'array', uniqueItems: true,
  }, [{ id: 'same', version: 1 }, { version: 1, id: 'same' }]), false,
  'uniqueItems uses JSON deep equality rather than property insertion order');
});

test('v1 framing and hello remain the permanent negotiation bootstrap in both directions', () => {
  assert.deepEqual(schema['x-bootstrap'], {
    framingVersion: 1,
    helloEnvelopeVersion: 1,
    permanent: true,
    futureImplementations: 'must-parse-v1-framing-and-hello-before-negotiation',
  });
  for (const vector of golden('version-negotiation.json').vectors) {
    assert.equal(schemaAccepts(schema.$defs.request, vector.request), true, vector.name);
    assert.equal(schemaAccepts(schema.$defs.response, vector.response), true, vector.name);
    assert.equal(validateHelloFailure(vector.request, vector.response, schema), true, vector.name);
    assert.equal(selectWireVersion(
      vector.request.params.supportedWireVersions,
      vector.response.error.details.supportedWireVersions,
    ), null, vector.name);
  }
  const malformed = structuredClone(golden('version-negotiation.json').vectors[0].response);
  malformed.error.details.supportedWireVersions = { minimum: 3, maximum: 2 };
  assert.equal(schemaAccepts(schema.$defs.response, malformed), true,
    'range order is a composite invariant, not expressible by this Draft schema');
  assert.doesNotThrow(() => validateHelloFailure(
    golden('version-negotiation.json').vectors[0].request, malformed, schema,
  ));
  assert.equal(validateHelloFailure(
    golden('version-negotiation.json').vectors[0].request, malformed, schema,
  ), false);
});

test('session failures bind method, session, request, and capability-specific details', () => {
  const request = {
    ...golden('invoke-project-summary.json').request,
    requestId: 'invoke-stale-1',
  };
  const response = structuredClone(golden('errors.json').responses.staleLocator);
  response.error.details.capabilityId = request.params.capabilityId;
  assert.equal(validateFailureExchange(
    golden('hello.json'), request, response, projectSummaryDescriptor(schema), schema,
  ), true);
  response.error.details.capabilityId = 'ae.layer.inspect';
  assert.equal(validateFailureExchange(
    golden('hello.json'), request, response, projectSummaryDescriptor(schema), schema,
  ), false);
  assert.equal(validateFailureExchange(
    golden('hello.json'), request, { ...response, requestId: 'wrong' },
    projectSummaryDescriptor(schema), schema,
  ), false);
});

test('deadline omission materializes to 5 seconds and invalid windows fail before dispatch', () => {
  const request = structuredClone(golden('invoke-project-summary.json').request);
  delete request.deadlineUnixMs;
  const now = 1900000000000;
  assert.equal(schemaAccepts(schema.$defs.request, request), true);
  assert.equal(materializeDeadline(request, now), now + LIMITS.defaultDeadlineMs);
  assert.throws(() => materializeDeadline({ ...request, deadlineUnixMs: now }, now), {
    code: 'DEADLINE_EXCEEDED',
  });
  assert.throws(() => materializeDeadline({ ...request, deadlineUnixMs: now + 30001 }, now), {
    code: 'INVALID_ARGUMENT',
  });
  assert.deepEqual(classifyRequest({ ...request, deadlineUnixMs: Number.MAX_SAFE_INTEGER + 1 }), {
    ok: false, errorCode: 'INVALID_ARGUMENT',
  });
});

test('capability discovery uses real canonical digests and keeps compatibility unverified', () => {
  const hello = golden('hello.json');
  const exchange = golden('capabilities.json');
  const capabilities = exchange.response;
  const descriptor = capabilities.result.items[0];
  assert.deepEqual(capabilities.result.items, nativeCapabilityRegistry(schema));
  assert.equal(descriptor.contractDigest, projectSummaryContractDigest(schema));
  assert.deepEqual(descriptor, projectSummaryDescriptor(schema));
  assert.equal(capabilities.result.capabilitiesDigest, capabilityDigest(nativeCapabilityRegistry(schema)));
  assert.equal(capabilities.result.queryDigest, capabilityQueryDigest(exchange.request));
  assert.equal(validateCapabilitiesExchange(hello, exchange.request, capabilities, schema), true);
  assert.equal(validateCapabilityDescriptor(descriptor, schema), true);
  assert.equal(descriptor.compatibility.status, 'unverified');
  assert.equal(validateCapabilitiesExchange(hello, exchange.request, {
    ...capabilities,
    result: { ...capabilities.result, capabilitiesDigest: '0'.repeat(64) },
  }, schema), false);
  assert.equal(validateCapabilitiesExchange(hello, exchange.request, {
    ...capabilities,
    requestId: 'wrong-request',
  }, schema), false);
  assert.equal(validateCapabilitiesExchange(hello, {
    ...exchange.request,
    params: { ...exchange.request.params, ids: ['ae.layer.inspect'] },
  }, capabilities, schema), false);
  assert.deepEqual(classifyRequest({
    ...exchange.request,
    params: { ...exchange.request.params, cursor: 'unsupported-v1-cursor' },
  }), { ok: false, errorCode: 'INVALID_ARGUMENT' });
  assert.equal(validateCapabilityDescriptor({ ...descriptor, mutability: 'mutating' }, schema), false);
  assert.equal(validateCapabilityDescriptor({
    ...descriptor,
    examples: descriptor.examples.filter((example) => example.kind === 'positive'),
  }, schema), false);
  assert.equal(validateCapabilityDescriptor({
    ...descriptor,
    compatibility: {
      status: 'verified', intendedPlatforms: ['macos-arm64'], minimumHostMajor: 27, maximumHostMajor: 26,
    },
  }, schema), false);
});

test('full descriptors are bounded, self-contained direct-run contracts', () => {
  const descriptor = projectSummaryDescriptor(schema);
  const bitDepthReadDescriptor = projectBitDepthReadDescriptor(schema);
  const bitDepthSetDescriptor = projectBitDepthSetDescriptor(schema);
  const containsRef = (value) => {
    if (Array.isArray(value)) return value.some(containsRef);
    if (value === null || typeof value !== 'object') return false;
    return Object.hasOwn(value, '$ref') || Object.values(value).some(containsRef);
  };
  assert.equal(schemaAccepts(schema.$defs.capabilityFull, descriptor), true);
  assert.equal(containsRef(descriptor.inputSchema), false);
  assert.equal(containsRef(descriptor.resultSchema), false);
  assert.deepEqual(descriptor.inputSchema, {
    type: 'object', additionalProperties: false, required: [], properties: {},
  });
  assert.equal(schemaAccepts(descriptor.inputSchema, {}, descriptor.inputSchema), true);
  assert.equal(schemaAccepts(descriptor.inputSchema, { jsx: 'forbidden' }, descriptor.inputSchema), false);
  const value = { projectOpen: true, projectName: 'SYNTHETIC_PROJECT', itemCount: 2 };
  assert.equal(schemaAccepts(descriptor.resultSchema, value, descriptor.resultSchema), true);
  assert.equal(schemaAccepts(descriptor.resultSchema, { projectOpen: true }, descriptor.resultSchema), false);
  assert.equal(descriptor.contractDigest, sha256Jcs({
    inputSchema: descriptor.inputSchema,
    resultSchema: descriptor.resultSchema,
  }));
  assert.deepEqual(bitDepthReadDescriptor.resultSchema.properties.bitsPerChannel.enum,
    [8, 16, 32]);
  assert.deepEqual(bitDepthSetDescriptor.inputSchema.properties.targetDepth.enum,
    [8, 16, 32]);
  assert.equal(bitDepthReadDescriptor.contractDigest,
    '936b86f89c99418bb570b9671569951ee10177efa70e8f4b72303a01dba0db6e');
  assert.equal(bitDepthSetDescriptor.contractDigest,
    'd5d11180b22293db667353e0861485e1633c2881ed96891744fd94d69910d80a');
  assert.equal(capabilityDigest([descriptor, bitDepthReadDescriptor, bitDepthSetDescriptor]),
    '0fda4e1bfbc8657bcd0c676fb802aecc97ba2ee6268cc115ff6d12b74758c042');
  assert.ok(Buffer.byteLength(canonicalize(descriptor), 'utf8') < LIMITS.maxFrameBytes);
});

test('v1 capability discovery is single-page, fail-closed, and never replayed', () => {
  const hello = golden('hello.json');
  const exchange = golden('capabilities.json');
  assert.equal(exchange.request.params.limit, 100);
  assert.equal(Object.hasOwn(exchange.request.params, 'ids'), false);
  assert.equal(exchange.response.result.items.length, 3);
  assert.equal(validateCapabilitiesExchange(hello, exchange.request, exchange.response, schema), true);

  const zeroLimit = structuredClone(exchange.request);
  zeroLimit.params.limit = 0;
  assert.equal(schemaAccepts(schema.$defs.request, zeroLimit), false);
  assert.equal(validateCapabilitiesExchange(hello, zeroLimit, exchange.response, schema), false);

  const unknownRequest = structuredClone(exchange.request);
  unknownRequest.requestId = 'capabilities-unknown';
  unknownRequest.params.ids = ['ae.project.unknown'];
  const unknownResponse = structuredClone(exchange.response);
  unknownResponse.requestId = unknownRequest.requestId;
  unknownResponse.result.items = [];
  unknownResponse.result.queryDigest = capabilityQueryDigest(unknownRequest);
  assert.equal(validateCapabilitiesExchange(hello, unknownRequest, unknownResponse, schema), true,
    'an unknown explicit ID yields an empty, digest-bound single page');

  const lowLimitRequest = structuredClone(exchange.request);
  lowLimitRequest.requestId = 'capabilities-low-limit';
  lowLimitRequest.params.limit = 1;
  const lowLimitResponse = structuredClone(exchange.response);
  lowLimitResponse.requestId = lowLimitRequest.requestId;
  lowLimitResponse.result.items = [projectSummaryDescriptor(schema)];
  lowLimitResponse.result.queryDigest = capabilityQueryDigest(lowLimitRequest);
  assert.equal(validateCapabilitiesExchange(
    hello,
    lowLimitRequest,
    lowLimitResponse,
    schema,
  ), false, 'v1 refuses truncation when the requested limit is smaller than matching entries');

  const replayed = { ...exchange.response, replayed: true };
  assert.equal(schemaAccepts(schema.$defs.response, replayed), false);
  assert.equal(validateCapabilitiesExchange(hello, exchange.request, replayed, schema), false);
  const replayedCancel = { ...golden('cancel.json').response, replayed: true };
  assert.equal(schemaAccepts(schema.$defs.response, replayedCancel), false);
});

test('invoke is a closed capability-specific allowlist, including nested executable aliases', () => {
  const request = golden('invoke-project-summary.json').request;
  assert.equal(schemaAccepts(schema.$defs.request, request), true);
  for (const argumentsValue of [
    { jsx: 'synthetic' },
    { Code: 'synthetic' },
    { payload: { commandLine: 'synthetic', jsx: 'synthetic' } },
    { source: 'synthetic' },
  ]) {
    const candidate = { ...request, params: { ...request.params, arguments: argumentsValue } };
    assert.equal(schemaAccepts(schema.$defs.request, candidate), false);
    assert.deepEqual(classifyRequest(candidate), { ok: false, errorCode: 'INVALID_ARGUMENT' });
  }
  assert.equal(validateIdempotencyContract({ idempotency: 'idempotency-key' }, {
    arguments: { idempotencyKey: 'synthetic-key-0001' },
  }), true);
  assert.equal(validateIdempotencyContract({ idempotency: 'idempotency-key' }, { arguments: {} }), false);
  assert.equal(validateIdempotencyContract({ idempotency: 'idempotent' }, {
    arguments: { idempotencyKey: 'synthetic-key-0001' },
  }), false);
});

test('every error code has one safe retry/side-effect/recovery tuple', () => {
  for (const code of Object.keys(ERROR_POLICIES)) {
    const valid = errorVector(code);
    assert.equal(schemaAccepts(schema.$defs.rpcError, valid), true, code);
    assert.equal(validateErrorPolicy(valid, schema), true, code);
    assert.equal(schemaAccepts(schema.$defs.rpcError, { ...valid, retryable: !valid.retryable }), false, code);
    assert.equal(schemaAccepts(schema.$defs.rpcError, {
      ...valid,
      recovery: { ...valid.recovery, action: valid.recovery.action === 'retry' ? 'none' : 'retry' },
    }), false, code);
  }
  const queue = errorVector('QUEUE_FULL');
  delete queue.recovery.retryAfterMs;
  assert.equal(schemaAccepts(schema.$defs.rpcError, queue), false);
  const cancelled = errorVector('CANCELLED');
  cancelled.recovery.retryAfterMs = 250;
  assert.equal(schemaAccepts(schema.$defs.rpcError, cancelled), false);
  assert.equal(validateErrorPolicy(cancelled, schema), false);
});

test('request ledger resists poisoning and only replays verified, live, identical reads', () => {
  const now = 1900000000000;
  const request = golden('invoke-project-summary.json').request;
  const response = successForRequest(request, now);
  const ledger = new RequestLedger({
    maxActiveEntries: 2,
    maxTerminalEntries: 2,
    terminalTtlMs: 1000,
    terminalValidator: strictTerminalValidator,
  });
  assert.deepEqual(ledger.accept(request, now), {
    state: 'accepted', effectiveDeadlineUnixMs: request.deadlineUnixMs,
  });
  assert.deepEqual(ledger.accept(request, now), {
    state: 'rejected', errorCode: 'DUPLICATE_REQUEST',
  });
  const poisonedRequest = { ...request, deadlineUnixMs: request.deadlineUnixMs - 1 };
  assert.throws(() => ledger.complete(poisonedRequest, response, now + 30), {
    code: 'INVALID_REQUEST',
  });
  assert.deepEqual(ledger.snapshot(), { active: 1, terminal: 0 });
  ledger.complete(request, response, now + 30);
  const replay = ledger.accept(request, now + 40);
  assert.equal(replay.state, 'replayed');
  assert.equal(replay.response.replayed, true);
  assert.equal(validateTranscript({
    hello: golden('hello.json'),
    descriptor: projectSummaryDescriptor(schema),
    schema,
    brokerSendUnixMs: now + 40,
    effectiveDeadlineUnixMs: request.deadlineUnixMs,
    replayReceipt: replay.replayReceipt,
  }, request, [replay.response]), true);
  assert.equal(validateTranscript({
    hello: golden('hello.json'),
    descriptor: projectSummaryDescriptor(schema),
    schema,
    brokerSendUnixMs: now + 40,
    effectiveDeadlineUnixMs: request.deadlineUnixMs,
    replayReceipt: { ...replay.replayReceipt },
  }, request, [replay.response]), false, 'forged replay receipt is rejected');
  assert.deepEqual(ledger.accept(request, request.deadlineUnixMs), {
    state: 'rejected', errorCode: 'DEADLINE_EXCEEDED',
  });

  const unverified = new RequestLedger({ maxActiveEntries: 1, maxTerminalEntries: 1 });
  unverified.accept(request, now);
  assert.throws(() => unverified.complete(request, response, now + 30), {
    code: 'INVALID_REQUEST',
  });
  assert.deepEqual(unverified.snapshot(), { active: 1, terminal: 0 });

  const shapeFirst = new RequestLedger({
    maxActiveEntries: 1, maxTerminalEntries: 1, terminalValidator: strictTerminalValidator,
  });
  shapeFirst.accept(request, now);
  const malformedTerminal = { ...response, unexpected: true };
  assert.equal(validateResponseShape(malformedTerminal, schema), false);
  assert.throws(() => shapeFirst.complete(request, malformedTerminal, now + 30), {
    code: 'INVALID_REQUEST',
  });
  assert.deepEqual(shapeFirst.snapshot(), { active: 1, terminal: 0 });

  const capacity = new RequestLedger({
    maxActiveEntries: 1, maxTerminalEntries: 1, terminalValidator: strictTerminalValidator,
  });
  assert.equal(capacity.accept(request, now).state, 'accepted');
  assert.deepEqual(capacity.accept({ ...request, requestId: 'capacity-full' }, now), {
    state: 'rejected', errorCode: 'QUEUE_FULL',
  });

  const failureLedger = new RequestLedger({
    maxActiveEntries: 2, maxTerminalEntries: 2, terminalValidator: strictTerminalValidator,
  });
  const failed = { ...request, requestId: 'failed-1' };
  const failedResponse = {
    ...golden('errors.json').responses.duplicateRequest,
    requestId: failed.requestId,
  };
  assert.equal(failureLedger.accept(failed, now).state, 'accepted');
  failureLedger.complete(failed, failedResponse, now + 1);
  assert.deepEqual(failureLedger.accept(failed, now + 2), {
    state: 'rejected', errorCode: 'DUPLICATE_REQUEST',
  });

  const ttl = new RequestLedger({
    maxActiveEntries: 2,
    maxTerminalEntries: 1,
    terminalTtlMs: 100,
    terminalValidator: strictTerminalValidator,
  });
  assert.equal(ttl.accept(request, now).state, 'accepted');
  ttl.complete(request, response, now + 30);
  assert.equal(ttl.accept(request, now + 129).state, 'replayed');
  assert.equal(ttl.accept(request, now + 131).state, 'accepted', 'expired tombstone is not replayed');
  ttl.purgeSession(request.sessionId);
  assert.deepEqual(ttl.snapshot(), { active: 0, terminal: 0 });

  const futureEvidence = new RequestLedger({
    maxActiveEntries: 1, maxTerminalEntries: 1, terminalValidator: strictTerminalValidator,
  });
  futureEvidence.accept(request, now);
  assert.throws(() => futureEvidence.complete(request, response, now + 20), {
    code: 'INVALID_REQUEST',
  });
  assert.deepEqual(futureEvidence.snapshot(), { active: 1, terminal: 0 });

  const expiryCapacity = new RequestLedger({
    maxActiveEntries: 1, maxTerminalEntries: 2, terminalValidator: strictTerminalValidator,
  });
  const short = { ...request, requestId: 'short-active', deadlineUnixMs: now + 10 };
  assert.equal(expiryCapacity.accept(short, now).state, 'accepted');
  assert.equal(expiryCapacity.accept({ ...request, requestId: 'after-expiry' }, now + 10).state,
    'accepted', 'expired active entries release capacity and leave a tombstone');
  assert.deepEqual(expiryCapacity.accept(short, now + 10), {
    state: 'rejected', errorCode: 'DEADLINE_EXCEEDED',
  });

  const omitted = structuredClone(request);
  omitted.requestId = 'omitted-deadline';
  delete omitted.deadlineUnixMs;
  const omittedResponse = successForRequest(omitted, now);
  const omittedLedger = new RequestLedger({
    maxActiveEntries: 1, maxTerminalEntries: 1, terminalValidator: strictTerminalValidator,
  });
  const omittedAccepted = omittedLedger.accept(omitted, now);
  omittedLedger.complete(omitted, omittedResponse, now + 30);
  const omittedReplay = omittedLedger.accept(omitted, now + 40);
  assert.equal(omittedReplay.effectiveDeadlineUnixMs, omittedAccepted.effectiveDeadlineUnixMs);
  assert.equal(validateTranscript({
    hello: golden('hello.json'),
    descriptor: projectSummaryDescriptor(schema),
    schema,
    brokerSendUnixMs: now + 40,
    effectiveDeadlineUnixMs: omittedReplay.effectiveDeadlineUnixMs,
    replayReceipt: omittedReplay.replayReceipt,
  }, omitted, [omittedReplay.response]), true);

  const otherSession = { ...request, sessionId: '44444444-4444-4444-8444-444444444444' };
  const sessions = new RequestLedger({
    maxActiveEntries: 2, maxTerminalEntries: 1, terminalValidator: strictTerminalValidator,
  });
  assert.equal(sessions.accept(request, now).state, 'accepted');
  assert.equal(sessions.accept(otherSession, now).state, 'accepted');
  sessions.purgeSession(otherSession.sessionId);
  assert.deepEqual(sessions.snapshot(), { active: 1, terminal: 0 });
  assert.equal(golden('errors.json').responses.duplicateRequest.error.code, 'DUPLICATE_REQUEST');
});

test('admission controller enforces burst, rate, in-flight, queue, and recovery', () => {
  const now = 1900000000000;
  const base = golden('invoke-project-summary.json').request;
  const request = (requestId, extra = {}) => ({ ...base, requestId, ...extra });
  const limits = (overrides = {}) => ({
    maxInFlight: 8,
    maxQueueDepth: 8,
    maxDeadlineMs: 30000,
    maxRequestsPerSecond: 100,
    maxBurst: 100,
    maxControlInFlight: 1,
    maxControlRequestsPerSecond: 20,
    maxControlBurst: 4,
    maxTerminalCacheEntries: 128,
    ...overrides,
  });
  const rate = new AdmissionController(limits({
    maxInFlight: 8, maxQueueDepth: 8, maxRequestsPerSecond: 2, maxBurst: 2,
  }));
  assert.equal(rate.admit(request('rate-1'), now).state, 'dispatched');
  assert.equal(rate.admit(request('rate-2'), now).state, 'dispatched');
  assert.deepEqual(rate.admit(request('rate-3'), now), {
    state: 'rejected', errorCode: 'QUEUE_FULL', reason: 'rate-limit', retryAfterMs: 500,
  });
  assert.equal(rate.admit(request('rate-4'), now + 500).state, 'dispatched');

  const capacity = new AdmissionController(limits({
    maxInFlight: 1, maxQueueDepth: 2, maxRequestsPerSecond: 100, maxBurst: 10,
  }));
  const work1 = request('work-1');
  const work2 = request('work-2');
  const work3 = request('work-3');
  assert.equal(capacity.admit(work1, now).state, 'dispatched');
  assert.equal(capacity.admit(work2, now).state, 'queued');
  assert.equal(capacity.admit(work3, now).state, 'queued');
  assert.deepEqual(capacity.admit(request('work-4'), now), {
    state: 'rejected', errorCode: 'QUEUE_FULL', reason: 'queue-capacity', retryAfterMs: 1,
  });

  const cancel = {
    ...golden('cancel.json').request,
    requestId: 'cancel-control-1',
    params: { targetRequestId: 'work-2' },
  };
  assert.equal(capacity.admit(cancel, now).state, 'control-dispatched');
  assert.deepEqual(capacity.admit({ ...cancel, requestId: 'cancel-control-2' }, now), {
    state: 'rejected', errorCode: 'QUEUE_FULL', reason: 'control-capacity', retryAfterMs: 1,
  });
  const promotion = capacity.complete(work1, now + 1);
  assert.equal(promotion.state, 'promoted');
  assert.equal(promotion.completed.requestId, 'work-1');
  assert.equal(promotion.promoted.requestId, 'work-2');
  assert.equal(capacity.complete(cancel, now + 1).state, 'control-released');
  assert.equal(capacity.complete(work2, now + 2).state, 'promoted');
  assert.equal(capacity.complete(work3, now + 3).state, 'released');

  const sessions = new AdmissionController(limits());
  const sameIdOtherSession = request('shared-id', {
    sessionId: '44444444-4444-4444-8444-444444444444',
  });
  assert.equal(sessions.admit(request('shared-id'), now).state, 'dispatched');
  assert.equal(sessions.admit(sameIdOtherSession, now).state, 'dispatched');

  const expiry = new AdmissionController(limits({ maxInFlight: 1, maxQueueDepth: 3 }));
  const active = request('expiry-active');
  const expiredQueued = request('expiry-queued', { deadlineUnixMs: now + 10 });
  const liveQueued = request('expiry-live', { deadlineUnixMs: now + 100 });
  expiry.admit(active, now);
  expiry.admit(expiredQueued, now);
  expiry.admit(liveQueued, now);
  const expiryPromotion = expiry.complete(active, now + 20);
  assert.equal(expiryPromotion.promoted.requestId, 'expiry-live');
  assert.deepEqual(expiryPromotion.expired.map((item) => item.request.requestId), ['expiry-queued']);

  const controlRate = new AdmissionController(limits({
    maxControlRequestsPerSecond: 1, maxControlBurst: 4,
  }));
  let controlAccepted = 0;
  let controlLimited = 0;
  for (let index = 0; index < 100; index += 1) {
    const candidate = { ...cancel, requestId: `cancel-burst-${index}` };
    const result = controlRate.admit(candidate, now);
    if (result.state === 'control-dispatched') {
      controlAccepted += 1;
      controlRate.complete(candidate, now);
    } else if (result.reason === 'control-rate-limit') {
      controlLimited += 1;
    }
  }
  assert.equal(controlAccepted, 4);
  assert.equal(controlLimited, 96);
});

test('admission constructor enforces every negotiated schema maximum', () => {
  const valid = {
    maxInFlight: 64,
    maxQueueDepth: 256,
    maxDeadlineMs: 30000,
    maxRequestsPerSecond: 100,
    maxBurst: 100,
    maxControlInFlight: 8,
    maxControlRequestsPerSecond: 100,
    maxControlBurst: 100,
    maxTerminalCacheEntries: 4096,
  };
  assert.doesNotThrow(() => new AdmissionController(valid));
  for (const [key, value] of Object.entries({
    maxInFlight: 65,
    maxQueueDepth: 257,
    maxDeadlineMs: 30001,
    maxRequestsPerSecond: 101,
    maxBurst: 101,
    maxControlInFlight: 9,
    maxControlRequestsPerSecond: 101,
    maxControlBurst: 101,
    maxTerminalCacheEntries: 4097,
  })) {
    assert.throws(() => new AdmissionController({ ...valid, [key]: value }), {
      code: 'INVALID_ARGUMENT',
    }, key);
  }
});

test('invoke transcript binds progress order, one terminal result, identities, time, and digests', () => {
  const fixture = golden('invoke-project-summary.json');
  const context = {
    hello: golden('hello.json'),
    descriptor: projectSummaryDescriptor(schema),
    schema,
    brokerSendUnixMs: 1900000000000,
    effectiveDeadlineUnixMs: fixture.request.deadlineUnixMs,
    terminalObservedUnixMs: 1900000000030,
  };
  const messages = [...fixture.events, fixture.response];
  assert.equal(fixture.response.result.evidence.requestDigest, sha256Jcs(fixture.request));
  assert.equal(fixture.response.result.evidence.postcondition.digest, postconditionDigest(fixture.response.result));
  assert.equal(validateTranscript(context, fixture.request, messages), true);

  const badSequence = structuredClone(messages);
  badSequence[1].sequence = 4;
  assert.equal(validateTranscript(context, fixture.request, badSequence), false);
  assert.equal(validateTranscript(context, fixture.request, [...messages, fixture.response]), false);
  assert.equal(validateTranscript(context, fixture.request, [fixture.response, fixture.events[0]]), false);
  const wrongIdentity = structuredClone(messages);
  wrongIdentity.at(-1).result.evidence.sessionId = '44444444-4444-4444-8444-444444444444';
  assert.equal(validateTranscript(context, fixture.request, wrongIdentity), false);
  const wrongHost = structuredClone(messages);
  wrongHost.at(-1).result.evidence.hostInstanceId = '77777777-7777-4777-8777-777777777777';
  assert.equal(validateTranscript(context, fixture.request, wrongHost), false);
  const reversedTime = structuredClone(messages);
  reversedTime.at(-1).result.evidence.completedAtUnixMs = 1;
  assert.equal(validateTranscript(context, fixture.request, reversedTime), false);
  const beforeBrokerSend = structuredClone(messages);
  beforeBrokerSend.at(-1).result.evidence.startedAtUnixMs = context.brokerSendUnixMs - 1;
  assert.equal(validateTranscript(context, fixture.request, beforeBrokerSend), false);
  const afterDeadline = structuredClone(messages);
  afterDeadline.at(-1).result.evidence.completedAtUnixMs = fixture.request.deadlineUnixMs + 1;
  assert.equal(validateTranscript(context, fixture.request, afterDeadline), false);
  const wrongDigest = structuredClone(messages);
  wrongDigest.at(-1).result.evidence.postcondition.digest = '0'.repeat(64);
  assert.equal(validateTranscript(context, fixture.request, wrongDigest), false);
  for (const mutate of [
    (terminal) => { terminal.result.extra = true; },
    (terminal) => { terminal.result.evidence.extra = true; },
    (terminal) => { terminal.result.evidence.postcondition.extra = true; },
    (terminal) => { delete terminal.result.value.projectName; },
    (terminal) => { terminal.result.value.extra = true; },
  ]) {
    const malformedShape = structuredClone(messages);
    mutate(malformedShape.at(-1));
    assert.equal(validateResponseShape(malformedShape.at(-1), schema), false);
    assert.equal(validateTranscript(context, fixture.request, malformedShape), false);
  }
  const decreasingProgress = structuredClone(messages);
  decreasingProgress[0].progress.fraction = 0.4;
  decreasingProgress[1].progress.fraction = 0.3;
  assert.equal(validateTranscript(context, fixture.request, decreasingProgress), false);
  const backwardsPhase = structuredClone(messages);
  backwardsPhase[1].progress.phase = 'running';
  backwardsPhase[2].progress.phase = 'dispatched';
  assert.equal(validateTranscript(context, fixture.request, backwardsPhase), false);
  const readEffect = structuredClone(messages);
  readEffect.at(-1).result.evidence.effect = 'committed';
  assert.equal(validateTranscript(context, fixture.request, readEffect), false);
  const readUndo = structuredClone(messages);
  readUndo.at(-1).result.evidence.undo = { available: true, verified: true, groupId: 'synthetic' };
  assert.equal(validateTranscript(context, fixture.request, readUndo), false);
  assert.equal(validateTranscript({ ...context, descriptor: { ...context.descriptor, version: 2 } },
    fixture.request, messages), false);
  const unverified = structuredClone(fixture.response);
  unverified.result.evidence.postcondition.verified = false;
  assert.equal(schemaAccepts(schema.$defs.response, unverified), false);
});

test('bit-depth invoke vectors bind native read and undoable set semantics', () => {
  for (const [name, descriptor] of [
    ['invoke-project-bit-depth-read.json', projectBitDepthReadDescriptor(schema)],
    ['invoke-project-bit-depth-set.json', projectBitDepthSetDescriptor(schema)],
  ]) {
    const fixture = golden(name);
    const context = {
      hello: golden('hello.json'),
      descriptor,
      schema,
      brokerSendUnixMs: 1900000000000,
      effectiveDeadlineUnixMs: fixture.request.deadlineUnixMs,
      terminalObservedUnixMs: 1900000000030,
    };
    assert.equal(fixture.response.result.evidence.requestDigest, sha256Jcs(fixture.request));
    assert.equal(
      fixture.response.result.evidence.postcondition.digest,
      postconditionDigest(fixture.response.result),
    );
    assert.equal(validateTranscript(
      context,
      fixture.request,
      [...fixture.events, fixture.response],
    ), true, name);
  }

  const read = golden('invoke-project-bit-depth-read.json');
  const readWithUndo = structuredClone(read.response);
  readWithUndo.result.evidence.undo = { available: true, verified: false };
  assert.equal(validateTranscript({
    hello: golden('hello.json'),
    descriptor: projectBitDepthReadDescriptor(schema),
    schema,
    brokerSendUnixMs: 1900000000000,
    effectiveDeadlineUnixMs: read.request.deadlineUnixMs,
    terminalObservedUnixMs: 1900000000030,
  }, read.request, [...read.events, readWithUndo]), false);

  const set = golden('invoke-project-bit-depth-set.json');
  const setContext = {
    hello: golden('hello.json'),
    descriptor: projectBitDepthSetDescriptor(schema),
    schema,
    brokerSendUnixMs: 1900000000000,
    effectiveDeadlineUnixMs: set.request.deadlineUnixMs,
    terminalObservedUnixMs: 1900000000030,
  };
  const setWithVerifiedUndo = structuredClone(set.response);
  setWithVerifiedUndo.result.evidence.undo.verified = true;
  assert.equal(validateTranscript(
    setContext,
    set.request,
    [...set.events, setWithVerifiedUndo],
  ), false);
  const noChange = structuredClone(set.response);
  noChange.result.value.beforeBitsPerChannel = noChange.result.value.afterBitsPerChannel;
  noChange.result.evidence.postcondition.digest = postconditionDigest(noChange.result);
  assert.equal(validateTranscript(setContext, set.request, [...set.events, noChange]), false);
  const wrongTarget = structuredClone(set.response);
  wrongTarget.result.value.afterBitsPerChannel = 8;
  wrongTarget.result.evidence.postcondition.digest = postconditionDigest(wrongTarget.result);
  assert.equal(validateTranscript(setContext, set.request, [...set.events, wrongTarget]), false);
});

test('server-issued locators reject pointer shapes and stale host/session/project/generation', () => {
  const locator = {
    kind: 'layer',
    hostInstanceId: HOST,
    sessionId: SESSION,
    projectId: PROJECT,
    generation: 8,
    objectId: OBJECT,
  };
  const context = {
    hostInstanceId: HOST, sessionId: SESSION, projectId: PROJECT, generation: 8,
  };
  assert.equal(schemaAccepts(schema.$defs.locator, locator), true);
  assert.equal(validateLocator(locator, context, schema), true);
  assert.equal(schemaAccepts(schema.$defs.locator, { ...locator, objectId: '0x0000000100abcdef' }), false);
  assert.equal(validateLocator(locator, { ...context, generation: 9 }, schema), false);
  assert.equal(validateLocator(locator, {
    ...context, sessionId: '66666666-6666-4666-8666-666666666666',
  }, schema), false);
});

test('cancel states distinguish queued, running, terminal, and missing targets', () => {
  const fixture = golden('cancel.json');
  assert.equal(schemaAccepts(schema.$defs.response, fixture.response), true);
  assert.equal(validateCancelResult(fixture.response.result, schema), true);
  for (const [state, terminalResponseExpected] of Object.entries({
    'queued-cancelled': true,
    'running-cancel-requested': true,
    'running-not-cancellable': true,
    'already-terminal': false,
    'not-found': false,
  })) {
    assert.equal(validateCancelResult({
      targetRequestId: 'target-1', state, terminalResponseExpected,
    }, schema), true);
    assert.equal(validateCancelResult({
      targetRequestId: 'target-1', state, terminalResponseExpected: !terminalResponseExpected,
    }, schema), false);
  }
  const now = 1900000000000;
  const limits = {
    maxInFlight: 1,
    maxQueueDepth: 2,
    maxDeadlineMs: 30000,
    maxRequestsPerSecond: 100,
    maxBurst: 10,
    maxControlInFlight: 1,
    maxControlRequestsPerSecond: 20,
    maxControlBurst: 4,
    maxTerminalCacheEntries: 128,
  };
  const descriptor = projectSummaryDescriptor(schema);
  const registryFor = (capabilityDescriptor) => nativeCapabilityRegistry(schema).map((item) => (
    item.id === capabilityDescriptor.id && item.version === capabilityDescriptor.version
      ? capabilityDescriptor : item
  ));
  const helloFor = (capabilityDescriptor) => {
    const hello = structuredClone(golden('hello.json'));
    hello.response.result.capabilitiesDigest = capabilityDigest(registryFor(capabilityDescriptor));
    return hello;
  };
  const responseFor = (request, state, terminalResponseExpected) => ({
    ...fixture.response,
    requestId: request.requestId,
    result: {
      targetRequestId: request.params.targetRequestId,
      state,
      terminalResponseExpected,
    },
  });
  const contextFor = (decision, capabilityDescriptor, targetRequest, hello = helloFor(capabilityDescriptor)) => ({
    hello,
    descriptor: capabilityDescriptor,
    registry: registryFor(capabilityDescriptor),
    schema,
    cancelDecision: decision.decisionReceipt,
    targetTranscriptContext: targetRequest ? {
      brokerSendUnixMs: now,
      effectiveDeadlineUnixMs: targetRequest.deadlineUnixMs ?? now + LIMITS.defaultDeadlineMs,
      terminalObservedUnixMs: now + 30,
    } : undefined,
  });

  const queuedAdmission = new AdmissionController(limits);
  queuedAdmission.admit(golden('invoke-project-summary.json').request, now);
  queuedAdmission.admit(fixture.targetRequest, now);
  queuedAdmission.admit(fixture.request, now);
  const beforeRejectedCancel = structuredClone(queuedAdmission.snapshot());
  assert.throws(() => queuedAdmission.decideCancel(
    fixture.request, { ...descriptor, id: 'ae.project.wrong' },
  ), { code: 'INVALID_ARGUMENT' });
  assert.deepEqual(queuedAdmission.snapshot(), beforeRejectedCancel,
    'a rejected cancellation decision must preserve all admission state');
  const queuedDecision = queuedAdmission.decideCancel(fixture.request, descriptor);
  const queuedContext = contextFor(queuedDecision, descriptor, fixture.targetRequest);
  assert.equal(queuedDecision.state, 'queued-cancelled');
  assert.equal(validateCancelExchange(
    queuedContext, fixture.request, fixture.response, fixture.targetRequest, [],
  ), false);
  assert.equal(validateCancelExchange(
    queuedContext,
    fixture.request,
    { ...fixture.response, replayed: true },
    fixture.targetRequest,
    fixture.targetMessages,
  ), false);
  assert.equal(validateCancelExchange(
    queuedContext, fixture.request, fixture.response, fixture.targetRequest, fixture.targetMessages,
  ), true);
  assert.equal(validateCancelExchange(
    queuedContext, fixture.request, fixture.response, fixture.targetRequest, fixture.targetMessages,
  ), false, 'an atomic cancellation decision is consumed exactly once');
  assert.equal(validateCancelExchange(
    { ...queuedContext, cancelDecision: { ...queuedDecision.decisionReceipt } },
    fixture.request,
    fixture.response,
    fixture.targetRequest,
    fixture.targetMessages,
  ), false, 'a copied decision receipt has no authority');

  const runningFixture = golden('invoke-project-summary.json');
  const runningAdmission = new AdmissionController(limits);
  runningAdmission.admit(runningFixture.request, now);
  const runningRequest = {
    ...fixture.request,
    requestId: 'cancel-running',
    params: { targetRequestId: runningFixture.request.requestId },
  };
  const runningResponse = {
    ...fixture.response,
    requestId: runningRequest.requestId,
    result: {
      targetRequestId: runningFixture.request.requestId,
      state: 'running-not-cancellable',
      terminalResponseExpected: true,
    },
  };
  runningAdmission.admit(runningRequest, now);
  const runningDecision = runningAdmission.decideCancel(runningRequest, descriptor);
  const runningContext = contextFor(runningDecision, descriptor, runningFixture.request);
  assert.equal(validateCancelExchange(
    runningContext,
    runningRequest,
    {
      ...runningResponse,
      result: { ...runningResponse.result, state: 'running-cancel-requested' },
    },
    runningFixture.request,
    [...runningFixture.events, runningFixture.response],
  ), false, 'before-dispatch capability cannot request running cancellation');
  assert.equal(validateCancelExchange(
    runningContext,
    runningRequest,
    runningResponse,
    runningFixture.request,
    [...runningFixture.events, runningFixture.response],
  ), true);

  const terminalAdmission = new AdmissionController(limits);
  terminalAdmission.admit(runningFixture.request, now);
  terminalAdmission.complete(runningFixture.request, now + 1);
  const terminalCancel = { ...runningRequest, requestId: 'cancel-terminal' };
  terminalAdmission.admit(terminalCancel, now + 1);
  const terminalDecision = terminalAdmission.decideCancel(terminalCancel, descriptor);
  const alreadyTerminal = {
    ...runningResponse,
    requestId: terminalCancel.requestId,
    result: {
      ...runningResponse.result,
      state: 'already-terminal',
      terminalResponseExpected: false,
    },
  };
  assert.equal(validateCancelExchange(
    contextFor(terminalDecision, descriptor, runningFixture.request),
    terminalCancel,
    alreadyTerminal,
    runningFixture.request,
    [],
  ), true);

  const unknownAdmission = new AdmissionController(limits);
  const unknownRequest = { ...runningRequest, requestId: 'cancel-unknown' };
  unknownAdmission.admit(unknownRequest, now);
  const unknownDecision = unknownAdmission.decideCancel(unknownRequest, descriptor);
  const unknownResponse = responseFor(unknownRequest, 'not-found', false);
  assert.equal(validateCancelExchange(
    contextFor(unknownDecision, descriptor, null), unknownRequest, unknownResponse,
    runningFixture.request, [],
  ), false, 'a not-found decision cannot be rebound to a supplied target request');
  assert.equal(validateCancelExchange(
    contextFor(unknownDecision, descriptor, null), unknownRequest, unknownResponse, null, [],
  ), true);

  const otherSessionAdmission = new AdmissionController(limits);
  const otherSessionTarget = {
    ...runningFixture.request,
    sessionId: '44444444-4444-4444-8444-444444444444',
  };
  otherSessionAdmission.admit(otherSessionTarget, now);
  const crossSessionCancel = { ...runningRequest, requestId: 'cancel-cross-session' };
  otherSessionAdmission.admit(crossSessionCancel, now);
  const crossSessionDecision = otherSessionAdmission.decideCancel(crossSessionCancel, descriptor);
  assert.equal(crossSessionDecision.state, 'not-found',
    'target identity is scoped by the cancel request session');

  const cooperativeDescriptor = { ...descriptor, cancellation: 'cooperative' };
  const cooperativeAdmission = new AdmissionController(limits);
  cooperativeAdmission.admit(runningFixture.request, now);
  const cooperativeCancel = { ...runningRequest, requestId: 'cancel-cooperative' };
  cooperativeAdmission.admit(cooperativeCancel, now);
  const cooperativeDecision = cooperativeAdmission.decideCancel(
    cooperativeCancel, cooperativeDescriptor,
  );
  assert.equal(cooperativeDecision.state, 'running-cancel-requested');
  const cooperativeResponse = responseFor(cooperativeCancel, 'running-cancel-requested', true);
  const cancelledTerminal = structuredClone(fixture.targetMessages[0]);
  cancelledTerminal.requestId = runningFixture.request.requestId;
  assert.equal(validateCancelExchange(
    contextFor(cooperativeDecision, cooperativeDescriptor, runningFixture.request),
    cooperativeCancel,
    cooperativeResponse,
    runningFixture.request,
    [cancelledTerminal],
  ), true, 'cooperative running cancellation permits a fully validated CANCELLED terminal');
});

test('public semantic validators fail closed without throwing on malformed values', () => {
  const validators = [
    () => validateCapabilitiesExchange(golden('hello.json'), golden('capabilities.json').request, {}, schema),
    () => validateCapabilitiesExchange({}, {}, {}, {}),
    () => validateTranscript({}, {}, []),
    () => validateTranscript({ hello: golden('hello.json') }, null, [{}]),
    () => validateCancelExchange({}, {}, {}, {}, []),
    () => validateCapabilityDescriptor({ detail: 'full', compatibility: {}, examples: {} }, schema),
    () => validateHelloFailure(golden('hello.json').request, {
      ...golden('errors.json').responses.wireVersionMismatch,
      error: {
        ...golden('errors.json').responses.wireVersionMismatch.error,
        details: { supportedWireVersions: { minimum: 3, maximum: 2 } },
      },
    }, schema),
  ];
  for (const validate of validators) {
    assert.doesNotThrow(validate);
    assert.equal(validate(), false);
  }
});
