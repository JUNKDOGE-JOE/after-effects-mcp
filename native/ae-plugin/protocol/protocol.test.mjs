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
  keyframeAuthoringDescriptors,
  layerTimelineDescriptors,
  projectCompositionDescriptors,
  postconditionDigest,
  compositionLayersListContractDigest,
  compositionLayersListDescriptor,
  compositionSelectedLayersListContractDigest,
  compositionSelectedLayersListDescriptor,
  compositionTimeReadContractDigest,
  compositionTimeReadDescriptor,
  compositionTimeSetContractDigest,
  compositionTimeSetDescriptor,
  compositionCreateContractDigest,
  compositionCreateDescriptor,
  compositionLayerCreateContractDigest,
  compositionLayerCreateDescriptor,
  layerEffectApplyContractDigest,
  layerEffectApplyDescriptor,
  layerPropertiesListContractDigest,
  layerPropertiesListDescriptor,
  layerPropertyKeyframesListContractDigest,
  layerPropertyKeyframesListDescriptor,
  layerPropertySetContractDigest,
  layerPropertySetDescriptor,
  projectBitDepthReadDescriptor,
  projectBitDepthSetDescriptor,
  projectItemsListContractDigest,
  projectItemsListDescriptor,
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
  validateInvalidateGraphExchange,
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
  const protocolReadme = fs.readFileSync(path.join(here, 'README.md'), 'utf8');
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.deepEqual(schema['x-framing'], {
    lengthPrefixBytes: 4,
    byteOrder: 'big-endian',
    encoding: 'utf-8',
    maxFrameBytes: 524288,
    maxJsonDepth: 32,
    maxJsonNodes: 32768,
    maxStringLength: 8192,
    stringLengthUnit: 'unicode-scalar-values',
    duplicateObjectKeys: 'reject',
  });
  assert.equal([...protocolReadme.matchAll(/524,288 bytes/gu)].length, 2);
  assert.doesNotMatch(protocolReadme, /65,536 bytes/u);
  assert.equal(schema['x-lifecycle'].defaultDeadlineMs, 5000);
  assert.equal(schema['x-lifecycle'].maximumDeadlineMs, 30000);
  assert.equal(schema['x-lifecycle'].pagination, 'capability-owned-offset-limit-v1');
  assert.equal(schema['x-lifecycle'].terminalObservationClockToleranceMs, 0);
  assert.equal(schema['x-digests'].propertyNameSort, 'utf-16-code-units');
  assert.deepEqual(schema.$defs.method.enum, [
    'hello', 'capabilities', 'invoke', 'invalidateGraph', 'cancel',
  ]);
  assert.equal(
    schema['x-lifecycle'].graphInvalidation,
    'authenticated-internal-cep-jsx-boundary',
  );
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
    'invoke-project-items-list.json',
    'invoke-composition-layers-list.json',
    'invoke-composition-selected-layers-list.json',
    'invoke-composition-time-read.json',
    'invoke-composition-time-set.json',
    'invoke-composition-create.json',
    'invoke-composition-layer-create.json',
    'invoke-layer-effect-apply.json',
    'invoke-layer-properties-list.json',
    'invoke-layer-property-keyframes-list.json',
    'invoke-layer-property-set.json',
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
    'invalidate-graph.json',
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
    'invoke-project-items-list.json',
    'invoke-composition-layers-list.json',
    'invoke-composition-selected-layers-list.json',
    'invoke-composition-time-read.json',
    'invoke-composition-time-set.json',
    'invoke-composition-create.json',
    'invoke-composition-layer-create.json',
    'invoke-layer-effect-apply.json',
    'invoke-layer-properties-list.json',
    'invoke-layer-property-keyframes-list.json',
    'invoke-layer-property-set.json',
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
    'invalidate-graph.json',
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

  const boundedItems = Array.from(
    { length: 63 }, () => 'x'.repeat(LIMITS.maxStringLength),
  );
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
  assert.throws(() => strictParseJson(`${'['.repeat(33)}0${']'.repeat(33)}`), { code: 'INVALID_REQUEST' });
  assert.throws(() => strictParseJson(`[${'0,'.repeat(32768)}0]`), { code: 'INVALID_REQUEST' });
  assert.throws(() => strictParseJson(JSON.stringify('x'.repeat(8193))), { code: 'INVALID_REQUEST' });
  assert.throws(() => strictParseJson('{"n":9007199254740993}'), { code: 'INVALID_REQUEST' });
});

test('input and output codecs enforce the same exact JSON limits', () => {
  const depth32 = Array.from({ length: 31 }).reduce((value) => [value], 0);
  const depth33 = [depth32];
  assert.equal(assertJsonLimits(depth32), true);
  assert.doesNotThrow(() => encodeFrame(depth32));
  assert.throws(() => assertJsonLimits(depth33), { code: 'INVALID_REQUEST' });
  assert.throws(() => encodeFrame(depth33), { code: 'INVALID_REQUEST' });

  const nodes32768 = Array.from({ length: 32767 }, () => 0);
  assert.equal(assertJsonLimits(nodes32768), true);
  assert.throws(() => assertJsonLimits([...nodes32768, 0]), { code: 'INVALID_REQUEST' });
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

test('keyframe write argument fingerprints match the cross-language JCS vectors', () => {
  const locator = (kind, objectId) => ({
    kind,
    hostInstanceId: HOST,
    sessionId: SESSION,
    projectId: '44444444-4444-4444-8444-444444444444',
    generation: 8,
    objectId,
  });
  const common = {
    idempotencyKey: 'synthetic-keyframe-0001',
    layerLocator: locator('layer', '88888888-8888-4888-8888-888888888888'),
    propertyLocator: locator('stream', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
    time: { value: 1, scale: 2 },
  };
  assert.equal(sha256Jcs({
    ...common,
    inInterpolation: 'bezier',
    outInterpolation: 'hold',
  }), 'a8fea9f4e84c865ff0922670b5bcc6a96b9ab56987507565b67f4bb2803573ba');
  assert.equal(sha256Jcs({
    ...common,
    dimensions: [{
      dimension: 0,
      inEase: { speed: '0', influence: '33' },
      outEase: { speed: '1', influence: '67' },
    }],
  }), 'a71cd2b9726d538d8ced25917fadacf9ed917ce58067299eed1c4cc01c0fcbc9');
  assert.equal(sha256Jcs({
    ...common,
    behavior: 'temporal-continuous',
    enabled: true,
  }), 'b17ceeb349ace335f9cb6bdf883af411acd510e43198b57e2ce3ff737150f7be');
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
    golden('invoke-project-items-list.json').request,
    golden('invoke-composition-layers-list.json').request,
    golden('invoke-composition-selected-layers-list.json').request,
    golden('invoke-composition-time-read.json').request,
    golden('invoke-composition-time-set.json').request,
    golden('invoke-composition-create.json').request,
    golden('invoke-composition-layer-create.json').request,
    golden('invoke-layer-effect-apply.json').request,
    golden('invoke-layer-properties-list.json').request,
    golden('invoke-layer-property-set.json').request,
    golden('invalidate-graph.json').request,
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

test('graph invalidation is an exact authenticated internal lifecycle exchange', () => {
  const hello = golden('hello.json');
  const fixture = golden('invalidate-graph.json');
  assert.equal(validateInvalidateGraphExchange(
    hello, fixture.request, fixture.response, schema,
  ), true);

  const noSession = structuredClone(fixture.request);
  delete noSession.sessionId;
  assert.equal(schemaAccepts(schema.$defs.request, noSession), false);
  assert.deepEqual(classifyRequest(noSession), { ok: false, errorCode: 'SESSION_STALE' });

  const wrongReason = structuredClone(fixture.request);
  wrongReason.params.reason = 'manual';
  const extraParam = structuredClone(fixture.request);
  extraParam.params.extra = true;
  const missingReason = structuredClone(fixture.request);
  delete missingReason.params.reason;
  for (const request of [wrongReason, extraParam, missingReason]) {
    assert.equal(schemaAccepts(schema.$defs.request, request), false);
    assert.deepEqual(classifyRequest(request), { ok: false, errorCode: 'INVALID_ARGUMENT' });
  }

  const noActiveNamespace = structuredClone(fixture.response);
  noActiveNamespace.result = { generation: 0, invalidated: false };
  assert.equal(validateInvalidateGraphExchange(
    hello, fixture.request, noActiveNamespace, schema,
  ), true);

  const wrongSession = structuredClone(fixture.response);
  wrongSession.sessionId = '77777777-7777-4777-8777-777777777777';
  const replayed = { ...fixture.response, replayed: true };
  const negativeGeneration = structuredClone(fixture.response);
  negativeGeneration.result.generation = -1;
  const unsafeGeneration = structuredClone(fixture.response);
  unsafeGeneration.result.generation = 9007199254740992;
  const zeroInvalidationGeneration = structuredClone(fixture.response);
  zeroInvalidationGeneration.result.generation = 0;
  const nonzeroNoopGeneration = structuredClone(noActiveNamespace);
  nonzeroNoopGeneration.result.generation = 9;
  const extraResult = structuredClone(fixture.response);
  extraResult.result.extra = true;
  const missingInvalidated = structuredClone(fixture.response);
  delete missingInvalidated.result.invalidated;
  for (const response of [
    wrongSession, replayed, negativeGeneration, unsafeGeneration, zeroInvalidationGeneration,
    nonzeroNoopGeneration, extraResult, missingInvalidated,
  ]) {
    assert.equal(validateInvalidateGraphExchange(
      hello, fixture.request, response, schema,
    ), false);
  }

  assert.equal(nativeCapabilityRegistry(schema).length, 37);
  assert.doesNotMatch(JSON.stringify(golden('capabilities.json')), /invalidateGraph/u);
  const disguisedInvoke = structuredClone(golden('invoke-project-summary.json').request);
  disguisedInvoke.params.capabilityId = 'ae.invalidateGraph';
  assert.equal(schemaAccepts(schema.$defs.request, disguisedInvoke), false);
  assert.deepEqual(classifyRequest(disguisedInvoke), {
    ok: false, errorCode: 'INVALID_ARGUMENT',
  });
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
  const projectItemsDescriptor = projectItemsListDescriptor(schema);
  const compositionLayersDescriptor = compositionLayersListDescriptor(schema);
  const compositionSelectedLayersDescriptor = compositionSelectedLayersListDescriptor(schema);
  const compositionTimeDescriptor = compositionTimeReadDescriptor(schema);
  const compositionTimeSetCapability = compositionTimeSetDescriptor(schema);
  const compositionCreateCapability = compositionCreateDescriptor(schema);
  const compositionLayerCreateCapability = compositionLayerCreateDescriptor(schema);
  const layerEffectApplyCapability = layerEffectApplyDescriptor(schema);
  const layerPropertiesDescriptor = layerPropertiesListDescriptor(schema);
  const layerPropertyKeyframesDescriptor = layerPropertyKeyframesListDescriptor(schema);
  const layerPropertyDescriptor = layerPropertySetDescriptor(schema);
  const projectCompositionCapabilities = projectCompositionDescriptors(schema);
  const layerTimelineCapabilities = layerTimelineDescriptors(schema);
  const keyframeAuthoringCapabilities = keyframeAuthoringDescriptors(schema);
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
  assert.equal(projectItemsDescriptor.contractDigest,
    '64e87abb4beec44bf6ad3223002602222f1efcd6c1dc4f27383c617dfa2d444e');
  assert.equal(compositionLayersDescriptor.contractDigest,
    '3bd877e708d62ca1003e65498ebd86a8143cf0f11616fc0467a3e2ba68c8db75');
  assert.equal(compositionSelectedLayersDescriptor.contractDigest,
    '3bd877e708d62ca1003e65498ebd86a8143cf0f11616fc0467a3e2ba68c8db75');
  assert.equal(compositionSelectedLayersDescriptor.contractDigest,
    compositionSelectedLayersListContractDigest(schema));
  assert.deepEqual(compositionSelectedLayersDescriptor.inputSchema,
    compositionLayersDescriptor.inputSchema);
  assert.deepEqual(compositionSelectedLayersDescriptor.resultSchema,
    compositionLayersDescriptor.resultSchema);
  assert.equal(compositionTimeDescriptor.contractDigest,
    'fda1027148fb5bd49cba6bc6f2b4b3264d38d9b8958a6cb34a19ec14048b8acd');
  assert.equal(compositionTimeSetCapability.contractDigest,
    '724a779959a13e56fc679d3a9ad961708fadd535e3fbbf88abd33393530d3308');
  assert.equal(compositionTimeSetCapability.contractDigest,
    compositionTimeSetContractDigest(schema));
  assert.equal(compositionCreateCapability.contractDigest,
    '0e65175a0d85640eda3eb58b08d4cabc0aa9f085068225e1b44f9cf01467310d');
  assert.equal(compositionCreateCapability.contractDigest,
    compositionCreateContractDigest(schema));
  assert.equal(compositionLayerCreateCapability.contractDigest,
    'd48b5c0fcf9871ee579bf518679bc36277e2fd5194e70d9cc6fa1b2c573edeee');
  assert.equal(compositionLayerCreateCapability.contractDigest,
    compositionLayerCreateContractDigest(schema));
  assert.equal(layerEffectApplyCapability.contractDigest,
    '5de12c7cd4ede09122a837c85ff2e589f695dd5377490b97b9de9d975ce00d77');
  assert.equal(layerEffectApplyCapability.contractDigest,
    layerEffectApplyContractDigest(schema));
  assert.equal(layerPropertiesDescriptor.contractDigest,
    'a687dc451eec34cc7425c382750bccb9882aa257785dd538a26d61a5689cf0ba');
  assert.equal(layerPropertyKeyframesDescriptor.contractDigest,
    'f089d4cd1d35f492df660cbd83667968b2add70b5353172253691e33758e42bb');
  assert.equal(layerPropertyKeyframesDescriptor.contractDigest,
    layerPropertyKeyframesListContractDigest(schema));
  assert.equal(layerPropertyDescriptor.contractDigest,
    '5cb9b24ac33125823b08d1dcc43839bf1b568fd02da22b8fb3c30bb3c722689c');
  assert.equal(layerPropertyDescriptor.contractDigest,
    layerPropertySetContractDigest(schema));
  assert.equal(capabilityDigest([
    descriptor,
    bitDepthReadDescriptor,
    bitDepthSetDescriptor,
    projectItemsDescriptor,
    compositionLayersDescriptor,
    compositionSelectedLayersDescriptor,
    compositionTimeDescriptor,
    compositionTimeSetCapability,
    compositionCreateCapability,
    compositionLayerCreateCapability,
    layerEffectApplyCapability,
    layerPropertiesDescriptor,
    layerPropertyKeyframesDescriptor,
    layerPropertyDescriptor,
    ...projectCompositionCapabilities,
    ...layerTimelineCapabilities,
    ...keyframeAuthoringCapabilities,
  ]), capabilityDigest(nativeCapabilityRegistry(schema)));
  assert.equal(projectCompositionCapabilities.length, 8);
  for (const descriptor of projectCompositionCapabilities) {
    assert.equal(validateCapabilityDescriptor(descriptor, schema), true, descriptor.id);
    const stem = descriptor.id.replace(/^ae\./u, '').replaceAll('.', '-');
    assert.equal(descriptor.contractDigest, sha256Jcs({
      inputSchema: descriptor.inputSchema,
      resultSchema: descriptor.resultSchema,
    }), stem);
  }
  assert.equal(layerTimelineCapabilities.length, 8);
  for (const timelineDescriptor of layerTimelineCapabilities) {
    assert.equal(validateCapabilityDescriptor(timelineDescriptor, schema), true,
      timelineDescriptor.id);
    assert.equal(timelineDescriptor.contractDigest, sha256Jcs({
      inputSchema: timelineDescriptor.inputSchema,
      resultSchema: timelineDescriptor.resultSchema,
    }));
  }
  assert.equal(keyframeAuthoringCapabilities.length, 7);
  for (const keyframeDescriptor of keyframeAuthoringCapabilities) {
    assert.equal(validateCapabilityDescriptor(keyframeDescriptor, schema), true,
      keyframeDescriptor.id);
    assert.equal(keyframeDescriptor.contractDigest, sha256Jcs({
      inputSchema: keyframeDescriptor.inputSchema,
      resultSchema: keyframeDescriptor.resultSchema,
    }));
  }
  assert.ok(Buffer.byteLength(canonicalize(descriptor), 'utf8') < LIMITS.maxFrameBytes);
});

test('keyframe authoring matrix binds all seven strict typed contracts', () => {
  const matrix = golden('keyframe-authoring-matrix.json');
  const descriptors = keyframeAuthoringDescriptors(schema);
  assert.equal(capabilityDigest(nativeCapabilityRegistry(schema)), matrix.expectedRegistryDigest);
  assert.deepEqual(descriptors.map(({ id }) => id), matrix.cases.map(({ capabilityId }) => capabilityId));

  const layerLocator = {
    kind: 'layer', hostInstanceId: HOST, sessionId: SESSION, projectId: PROJECT,
    generation: 8, objectId: '88888888-8888-4888-8888-888888888888',
  };
  const propertyLocator = {
    kind: 'stream', hostInstanceId: HOST, sessionId: SESSION, projectId: PROJECT,
    generation: 8, objectId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  };
  const time = { value: 1, scale: 1 };
  const exactTime = { ...time, secondsRational: '1' };
  const details = (overrides = {}) => ({
    propertyLocator, time: exactTime, temporalDimensionality: 1, valueType: 'one-d',
    value: { kind: 'scalar', value: '50' }, inInterpolation: 'linear',
    outInterpolation: 'linear',
    temporalEaseDimensions: [{ dimension: 0, inEase: { speed: '0', influence: '33.333' },
      outEase: { speed: '0', influence: '33.333' } }],
    behaviors: { temporalContinuous: false, temporalAutoBezier: false,
      spatialContinuous: false, spatialAutoBezier: false, roving: false },
    ...overrides,
  });
  const common = { layerLocator, propertyLocator, time };
  const argsById = {
    'ae.layer.property.keyframe.details.read': { propertyLocator, time },
    'ae.layer.property.keyframe.add': { ...common, idempotencyKey: 'synthetic-keyframe-add-0001',
      value: { kind: 'scalar', value: '50' } },
    'ae.layer.property.keyframe.value.set': { ...common,
      idempotencyKey: 'synthetic-keyframe-value-0001', value: { kind: 'scalar', value: '50' } },
    'ae.layer.property.keyframe.interpolation.set': { ...common,
      idempotencyKey: 'synthetic-keyframe-interp-0001', inInterpolation: 'bezier',
      outInterpolation: 'bezier' },
    'ae.layer.property.keyframe.temporal-ease.set': { ...common,
      idempotencyKey: 'synthetic-keyframe-ease-0001', dimensions: [{ dimension: 0,
        inEase: { speed: '0', influence: '50' }, outEase: { speed: '0', influence: '50' } }] },
    'ae.layer.property.keyframe.behavior.set': { ...common,
      idempotencyKey: 'synthetic-keyframe-behavior-0001', behavior: 'temporal-continuous',
      enabled: true },
    'ae.layer.property.keyframe.delete': { ...common,
      idempotencyKey: 'synthetic-keyframe-delete-0001' },
  };
  const before = details({ value: { kind: 'scalar', value: '25' } });
  const after = details();
  const mutation = (beforeKeyframe, afterKeyframe, keyframeCountBefore = 1,
    keyframeCountAfter = 1) => ({ changed: true, layerLocator, propertyLocator,
    time: exactTime, keyframeCountBefore, keyframeCountAfter, beforeKeyframe, afterKeyframe });
  const valuesById = {
    'ae.layer.property.keyframe.details.read': after,
    'ae.layer.property.keyframe.add': mutation(null, after, 0, 1),
    'ae.layer.property.keyframe.value.set': mutation(before, after),
    'ae.layer.property.keyframe.interpolation.set': mutation(
      details(), details({ inInterpolation: 'bezier', outInterpolation: 'bezier' }),
    ),
    'ae.layer.property.keyframe.temporal-ease.set': mutation(details(), details({
      temporalEaseDimensions: argsById['ae.layer.property.keyframe.temporal-ease.set'].dimensions,
    })),
    'ae.layer.property.keyframe.behavior.set': mutation(details(), details({
      behaviors: { ...details().behaviors, temporalContinuous: true },
    })),
    'ae.layer.property.keyframe.delete': mutation(after, null, 1, 0),
  };
  const base = golden('invoke-layer-property-set.json');
  const hello = golden('hello.json');
  const now = 1900000000000;
  for (const entry of matrix.cases) {
    const descriptor = descriptors.find(({ id }) => id === entry.capabilityId);
    assert.equal(descriptor.contractDigest, entry.contractDigest, entry.capabilityId);
    const request = structuredClone(base.request);
    request.requestId = `invoke-${entry.capabilityId.replaceAll('.', '-')}-1`;
    request.params = { capabilityId: entry.capabilityId, capabilityVersion: 1,
      arguments: argsById[entry.capabilityId] };
    assert.equal(validateRequestComposite(request, schema).ok, true, entry.capabilityId);
    assert.deepEqual(classifyRequest(request), { ok: true }, entry.capabilityId);
    assert.equal(schemaAccepts(descriptor.inputSchema, request.params.arguments,
      descriptor.inputSchema), true, entry.capabilityId);
    assert.equal(schemaAccepts(descriptor.resultSchema, valuesById[entry.capabilityId],
      descriptor.resultSchema), true, entry.capabilityId);
    const response = structuredClone(base.response);
    response.requestId = request.requestId;
    response.result.capabilityId = entry.capabilityId;
    response.result.value = valuesById[entry.capabilityId];
    Object.assign(response.result.evidence, {
      requestId: request.requestId, capabilityId: entry.capabilityId,
      effect: entry.mutating ? 'committed' : 'none', requestDigest: sha256Jcs(request),
    });
    if (entry.mutating) response.result.evidence.undo = { available: true, verified: false };
    else delete response.result.evidence.undo;
    response.result.evidence.postcondition.kind = entry.postconditionKind;
    response.result.evidence.postcondition.digest = postconditionDigest(response.result);
    const events = base.events.map((event) => ({ ...event, requestId: request.requestId }));
    assert.equal(validateTranscript({ hello, descriptor, schema, brokerSendUnixMs: now,
      effectiveDeadlineUnixMs: request.deadlineUnixMs, terminalObservedUnixMs: now + 30 },
    request, [...events, response]), true, entry.capabilityId);

    const extra = structuredClone(request);
    extra.params.arguments.unexpected = true;
    assert.deepEqual(classifyRequest(extra), { ok: false, errorCode: 'INVALID_ARGUMENT' });
  }
  const badEase = structuredClone(argsById['ae.layer.property.keyframe.temporal-ease.set']);
  badEase.dimensions[0].dimension = 1;
  const badRequest = structuredClone(base.request);
  badRequest.params = { capabilityId: 'ae.layer.property.keyframe.temporal-ease.set',
    capabilityVersion: 1, arguments: badEase };
  assert.deepEqual(classifyRequest(badRequest), { ok: false, errorCode: 'INVALID_ARGUMENT' });
});

test('v1 capability discovery is single-page, fail-closed, and never replayed', () => {
  const hello = golden('hello.json');
  const exchange = golden('capabilities.json');
  assert.equal(exchange.request.params.limit, 100);
  assert.equal(Object.hasOwn(exchange.request.params, 'ids'), false);
  assert.equal(exchange.response.result.items.length, 37);
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

test('property-locator preconditions use bounded capability-specific recovery', () => {
  for (const capabilityId of [
    'ae.layer.property.set',
    'ae.layer.property.keyframes.list',
  ]) {
    const error = errorVector('PRECONDITION_FAILED');
    error.details = {
      capabilityId,
      field: 'params.arguments.propertyLocator',
    };
    error.recovery.action = 'change-arguments';
    assert.equal(validateErrorPolicy(error, schema), true, capabilityId);
  }

  const wrongField = errorVector('PRECONDITION_FAILED');
  wrongField.details = {
    capabilityId: 'ae.layer.property.keyframes.list',
    field: 'params.arguments.offset',
  };
  wrongField.recovery.action = 'change-arguments';
  assert.equal(validateErrorPolicy(wrongField, schema), false);
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

test('project and composition package vectors bind all eight frozen contracts', () => {
  const names = [
    'invoke-project-context-read.json',
    'invoke-project-item-metadata-read.json',
    'invoke-composition-settings-read.json',
    'invoke-composition-work-area-set.json',
    'invoke-project-item-name-set.json',
    'invoke-project-item-comment-set.json',
    'invoke-project-item-label-set.json',
    'invoke-composition-duplicate.json',
  ];
  const descriptors = new Map(
    projectCompositionDescriptors(schema).map((descriptor) => [descriptor.id, descriptor]),
  );
  for (const name of names) {
    const fixture = golden(name);
    const descriptor = descriptors.get(fixture.request.params.capabilityId);
    const context = {
      hello: golden('hello.json'),
      descriptor,
      schema,
      brokerSendUnixMs: 1900000000000,
      effectiveDeadlineUnixMs: fixture.request.deadlineUnixMs,
      terminalObservedUnixMs: 1900000000030,
    };
    assert.equal(fixture.response.result.evidence.requestDigest,
      sha256Jcs(fixture.request), `${name} request digest`);
    assert.equal(fixture.response.result.evidence.postcondition.digest,
      postconditionDigest(fixture.response.result), `${name} postcondition digest`);
    assert.equal(validateTranscript(
      context, fixture.request, [...fixture.events, fixture.response],
    ), true, name);
  }

  const settings = golden('invoke-composition-settings-read.json');
  const oversizedName = structuredClone([...settings.events, settings.response]);
  oversizedName.at(-1).result.value.name = 'x'.repeat(1025);
  oversizedName.at(-1).result.evidence.postcondition.digest =
    postconditionDigest(oversizedName.at(-1).result);
  assert.equal(validateTranscript({
    hello: golden('hello.json'),
    descriptor: descriptors.get(settings.request.params.capabilityId), schema,
    brokerSendUnixMs: 1900000000000,
    effectiveDeadlineUnixMs: settings.request.deadlineUnixMs,
    terminalObservedUnixMs: 1900000000030,
  }, settings.request, oversizedName), false);

  const duplicate = golden('invoke-composition-duplicate.json');
  const duplicateContext = {
    hello: golden('hello.json'),
    descriptor: descriptors.get(duplicate.request.params.capabilityId), schema,
    brokerSendUnixMs: 1900000000000,
    effectiveDeadlineUnixMs: duplicate.request.deadlineUnixMs,
    terminalObservedUnixMs: 1900000000030,
  };
  const duplicateIsValid = (transcript) => validateTranscript(
    duplicateContext, duplicate.request, transcript,
  );
  const staleSource = structuredClone([...duplicate.events, duplicate.response]);
  staleSource.at(-1).result.value.sourceCompositionLocator.generation =
    duplicate.request.params.arguments.compositionLocator.generation;
  staleSource.at(-1).result.evidence.postcondition.digest =
    postconditionDigest(staleSource.at(-1).result);
  assert.equal(duplicateIsValid(staleSource), false);

  const staleProject = structuredClone([...duplicate.events, duplicate.response]);
  staleProject.at(-1).result.value.sourceCompositionLocator.projectId =
    duplicate.request.params.arguments.compositionLocator.projectId;
  staleProject.at(-1).result.evidence.postcondition.digest =
    postconditionDigest(staleProject.at(-1).result);
  assert.equal(duplicateIsValid(staleProject), false);

  const sharedObjectIdentity = structuredClone([...duplicate.events, duplicate.response]);
  sharedObjectIdentity.at(-1).result.value.sourceCompositionLocator.objectId =
    sharedObjectIdentity.at(-1).result.value.newCompositionLocator.objectId;
  sharedObjectIdentity.at(-1).result.evidence.postcondition.digest =
    postconditionDigest(sharedObjectIdentity.at(-1).result);
  assert.equal(duplicateIsValid(sharedObjectIdentity), false);

  const splitFreshContext = structuredClone([...duplicate.events, duplicate.response]);
  splitFreshContext.at(-1).result.value.newCompositionLocator.projectId =
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  splitFreshContext.at(-1).result.evidence.postcondition.digest =
    postconditionDigest(splitFreshContext.at(-1).result);
  assert.equal(duplicateIsValid(splitFreshContext), false);
});

test('layer timeline package vectors bind all eight frozen contracts', () => {
  const names = [
    'invoke-layer-details-read.json',
    'invoke-layer-name-set.json',
    'invoke-layer-range-set.json',
    'invoke-layer-start-time-set.json',
    'invoke-layer-stretch-set.json',
    'invoke-layer-order-set.json',
    'invoke-layer-parent-set.json',
    'invoke-layer-duplicate.json',
  ];
  const descriptors = new Map(
    layerTimelineDescriptors(schema).map((descriptor) => [descriptor.id, descriptor]),
  );
  const transcriptFor = (fixture) => ({
    hello: golden('hello.json'),
    descriptor: descriptors.get(fixture.request.params.capabilityId),
    schema,
    brokerSendUnixMs: 1900000000000,
    effectiveDeadlineUnixMs: fixture.request.deadlineUnixMs,
    terminalObservedUnixMs: 1900000000030,
  });
  for (const name of names) {
    const fixture = golden(name);
    assert.equal(fixture.response.result.evidence.requestDigest,
      sha256Jcs(fixture.request), `${name} request digest`);
    assert.equal(fixture.response.result.evidence.postcondition.digest,
      postconditionDigest(fixture.response.result), `${name} postcondition digest`);
    assert.equal(validateTranscript(
      transcriptFor(fixture), fixture.request, [...fixture.events, fixture.response],
    ), true, name);
  }

  const invalidRequests = [];
  const range = golden('invoke-layer-range-set.json').request;
  invalidRequests.push({ ...range, params: { ...range.params, arguments: {
    ...range.params.arguments, inPoint: { value: 1, scale: 1, secondsRational: '1' },
  } } });
  const stretch = golden('invoke-layer-stretch-set.json').request;
  invalidRequests.push({ ...stretch, params: { ...stretch.params, arguments: {
    ...stretch.params.arguments, stretch: { num: 0, den: 1 },
  } } });
  const order = golden('invoke-layer-order-set.json').request;
  invalidRequests.push({ ...order, params: { ...order.params, arguments: {
    ...order.params.arguments, targetStackIndex: 0,
  } } });
  const parent = golden('invoke-layer-parent-set.json').request;
  invalidRequests.push({ ...parent, params: { ...parent.params, arguments: {
    ...parent.params.arguments, parentLayerLocator: parent.params.arguments.layerLocator,
  } } });
  const duplicate = golden('invoke-layer-duplicate.json').request;
  const missingName = structuredClone(duplicate);
  delete missingName.params.arguments.newName;
  invalidRequests.push(missingName);
  for (const [index, request] of invalidRequests.entries()) {
    assert.equal(schemaAccepts(schema.$defs.request, request), index === 3,
      'self-parenting is the one cross-field invariant left to composite validation');
    assert.deepEqual(classifyRequest(request), { ok: false, errorCode: 'INVALID_ARGUMENT' });
  }

  const details = golden('invoke-layer-details-read.json');
  const noncanonicalStretch = structuredClone([...details.events, details.response]);
  noncanonicalStretch.at(-1).result.value.stretch.rational = '2/2';
  noncanonicalStretch.at(-1).result.evidence.postcondition.digest =
    postconditionDigest(noncanonicalStretch.at(-1).result);
  assert.equal(validateTranscript(
    transcriptFor(details), details.request, noncanonicalStretch,
  ), false);

  const rangeFixture = golden('invoke-layer-range-set.json');
  const wrongRange = structuredClone([...rangeFixture.events, rangeFixture.response]);
  wrongRange.at(-1).result.value.afterDuration = {
    value: 3, scale: 1, secondsRational: '3',
  };
  wrongRange.at(-1).result.evidence.postcondition.digest =
    postconditionDigest(wrongRange.at(-1).result);
  assert.equal(validateTranscript(
    transcriptFor(rangeFixture), rangeFixture.request, wrongRange,
  ), false);

  const duplicateFixture = golden('invoke-layer-duplicate.json');
  const staleDuplicate = structuredClone([
    ...duplicateFixture.events, duplicateFixture.response,
  ]);
  staleDuplicate.at(-1).result.value.sourceLayerLocator.generation =
    duplicateFixture.request.params.arguments.layerLocator.generation;
  staleDuplicate.at(-1).result.evidence.postcondition.digest =
    postconditionDigest(staleDuplicate.at(-1).result);
  assert.equal(validateTranscript(
    transcriptFor(duplicateFixture), duplicateFixture.request, staleDuplicate,
  ), false);
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

test('layer property set binds fresh locators, typed values, Undo, and postcondition', () => {
  const fixture = golden('invoke-layer-property-set.json');
  const descriptor = layerPropertySetDescriptor(schema);
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
    context, fixture.request, [...fixture.events, fixture.response],
  ), true);

  const verifiedUndo = structuredClone(fixture.response);
  verifiedUndo.result.evidence.undo.verified = true;
  assert.equal(validateTranscript(
    context, fixture.request, [...fixture.events, verifiedUndo],
  ), false);

  const wrongTarget = structuredClone(fixture.response);
  wrongTarget.result.value.afterValue.value = '41';
  wrongTarget.result.evidence.postcondition.digest = postconditionDigest(wrongTarget.result);
  assert.equal(validateTranscript(
    context, fixture.request, [...fixture.events, wrongTarget],
  ), false);

  const noChange = structuredClone(fixture.response);
  noChange.result.value.beforeValue = structuredClone(noChange.result.value.afterValue);
  noChange.result.evidence.postcondition.digest = postconditionDigest(noChange.result);
  assert.equal(validateTranscript(
    context, fixture.request, [...fixture.events, noChange],
  ), false);
});

test('composition time read binds one locator to an exact reduced rational', () => {
  const fixture = golden('invoke-composition-time-read.json');
  const descriptor = compositionTimeReadDescriptor(schema);
  const context = {
    hello: golden('hello.json'),
    descriptor,
    schema,
    brokerSendUnixMs: 1900000000000,
    effectiveDeadlineUnixMs: fixture.request.deadlineUnixMs,
    terminalObservedUnixMs: 1900000000030,
  };
  assert.equal(descriptor.contractDigest, compositionTimeReadContractDigest(schema));
  assert.equal(descriptor.contractDigest,
    'fda1027148fb5bd49cba6bc6f2b4b3264d38d9b8958a6cb34a19ec14048b8acd');
  assert.deepEqual(descriptor.inputSchema.required, ['compositionLocator']);
  assert.deepEqual(descriptor.resultSchema.required, ['compositionLocator', 'currentTime']);
  assert.equal(Object.hasOwn(descriptor.resultSchema.properties, 'compositionName'), false);
  assert.equal(fixture.response.result.evidence.requestDigest, sha256Jcs(fixture.request));
  assert.equal(fixture.response.result.evidence.postcondition.digest,
    postconditionDigest(fixture.response.result));
  assert.equal(validateTranscript(
    context, fixture.request, [...fixture.events, fixture.response],
  ), true);

  for (const mutate of [
    (request) => { delete request.params.arguments.compositionLocator; },
    (request) => { request.params.arguments.compositionLocator.kind = 'layer'; },
    (request) => { request.params.arguments.extra = true; },
  ]) {
    const malformed = structuredClone(fixture.request);
    mutate(malformed);
    assert.equal(schemaAccepts(schema.$defs.request, malformed), false);
    assert.deepEqual(classifyRequest(malformed), { ok: false, errorCode: 'INVALID_ARGUMENT' });
  }

  const int32Minimum = structuredClone(fixture.response);
  int32Minimum.result.value.currentTime = {
    value: -2147483648,
    scale: 4294967295,
    secondsRational: '-2147483648/4294967295',
  };
  int32Minimum.result.evidence.postcondition.digest = postconditionDigest(int32Minimum.result);
  assert.equal(validateTranscript(
    context, fixture.request, [...fixture.events, int32Minimum],
  ), true, 'INT32_MIN is reduced without signed-overflow ambiguity');

  for (const mutate of [
    (value) => { value.currentTime.value = 3004; },
    (value) => { value.currentTime.scale = 2000; },
    (value) => { value.currentTime.secondsRational = '6006/2000'; },
    (value) => { value.currentTime.secondsRational = '3003/1'; },
    (value) => { value.currentTime.value = 2147483648; },
    (value) => { value.currentTime.value = -2147483649; },
    (value) => { value.currentTime.scale = 0; },
    (value) => { value.currentTime.scale = 4294967296; },
    (value) => { value.currentTime.secondsRational = '-0'; },
    (value) => { value.compositionName = 'SYNTHETIC_COMPOSITION'; },
  ]) {
    const malformed = structuredClone(fixture.response);
    mutate(malformed.result.value);
    malformed.result.evidence.postcondition.digest = postconditionDigest(malformed.result);
    assert.equal(validateTranscript(
      context, fixture.request, [...fixture.events, malformed],
    ), false);
  }

  const stale = structuredClone(golden('errors.json').responses.staleLocator);
  stale.requestId = fixture.request.requestId;
  stale.error.details.capabilityId = fixture.request.params.capabilityId;
  stale.error.details.field = 'params.arguments.compositionLocator';
  assert.equal(validateFailureExchange(
    golden('hello.json'), fixture.request, stale, descriptor, schema,
  ), true);
  stale.error.details.field = 'params.arguments.layerLocator';
  assert.equal(validateFailureExchange(
    golden('hello.json'), fixture.request, stale, descriptor, schema,
  ), false);
});

test('composition time set binds exact rational state, Undo, and postcondition', () => {
  const fixture = golden('invoke-composition-time-set.json');
  const descriptor = compositionTimeSetDescriptor(schema);
  const context = {
    hello: golden('hello.json'),
    descriptor,
    schema,
    brokerSendUnixMs: 1900000000000,
    effectiveDeadlineUnixMs: fixture.request.deadlineUnixMs,
    terminalObservedUnixMs: 1900000000030,
  };
  assert.equal(descriptor.contractDigest, compositionTimeSetContractDigest(schema));
  assert.equal(descriptor.contractDigest,
    '724a779959a13e56fc679d3a9ad961708fadd535e3fbbf88abd33393530d3308');
  assert.deepEqual(descriptor.inputSchema.required,
    ['compositionLocator', 'targetTime', 'idempotencyKey']);
  assert.deepEqual(descriptor.resultSchema.required,
    ['changed', 'compositionLocator', 'beforeTime', 'afterTime']);
  assert.equal(fixture.response.result.evidence.requestDigest, sha256Jcs(fixture.request));
  assert.equal(fixture.response.result.evidence.postcondition.digest,
    postconditionDigest(fixture.response.result));
  assert.equal(validateTranscript(
    context, fixture.request, [...fixture.events, fixture.response],
  ), true);

  for (const mutate of [
    (request) => { delete request.params.arguments.targetTime.scale; },
    (request) => { request.params.arguments.targetTime.scale = 0; },
    (request) => { request.params.arguments.targetTime.value = 2147483648; },
    (request) => { request.params.arguments.idempotencyKey = 'short'; },
    (request) => { request.params.arguments.extra = true; },
  ]) {
    const malformed = structuredClone(fixture.request);
    mutate(malformed);
    assert.equal(schemaAccepts(schema.$defs.request, malformed), false);
    assert.deepEqual(classifyRequest(malformed), { ok: false, errorCode: 'INVALID_ARGUMENT' });
  }

  for (const mutate of [
    (value) => { value.afterTime = structuredClone(value.beforeTime); },
    (value) => { value.afterTime = { value: 2, scale: 1, secondsRational: '2' }; },
    (value) => { value.afterTime.secondsRational = '2/2'; },
    (value) => { value.compositionLocator.kind = 'layer'; },
  ]) {
    const malformed = structuredClone(fixture.response);
    mutate(malformed.result.value);
    malformed.result.evidence.postcondition.digest = postconditionDigest(malformed.result);
    assert.equal(validateTranscript(
      context, fixture.request, [...fixture.events, malformed],
    ), false);
  }
  const falselyVerifiedUndo = structuredClone(fixture.response);
  falselyVerifiedUndo.result.evidence.undo.verified = true;
  assert.equal(validateTranscript(
    context, fixture.request, [...fixture.events, falselyVerifiedUndo],
  ), false);

  const stale = structuredClone(golden('errors.json').responses.staleLocator);
  stale.requestId = fixture.request.requestId;
  stale.error.details.capabilityId = fixture.request.params.capabilityId;
  stale.error.details.field = 'params.arguments.compositionLocator';
  assert.equal(validateFailureExchange(
    golden('hello.json'), fixture.request, stale, descriptor, schema,
  ), true);
});

test('composition create binds exact settings, root project growth, Undo, and provenance', () => {
  const fixture = golden('invoke-composition-create.json');
  const descriptor = compositionCreateDescriptor(schema);
  const context = {
    hello: golden('hello.json'),
    descriptor,
    schema,
    brokerSendUnixMs: 1900000000000,
    effectiveDeadlineUnixMs: fixture.request.deadlineUnixMs,
    terminalObservedUnixMs: 1900000000030,
  };
  assert.equal(descriptor.contractDigest, compositionCreateContractDigest(schema));
  assert.equal(fixture.response.result.evidence.requestDigest, sha256Jcs(fixture.request));
  assert.equal(fixture.response.result.evidence.postcondition.digest,
    postconditionDigest(fixture.response.result));
  assert.equal(validateTranscript(
    context, fixture.request, [...fixture.events, fixture.response],
  ), true);

  for (const mutate of [
    (request) => { request.params.arguments.name = 'SYNTHETIC\u0000COMP'; },
    (request) => { request.params.arguments.duration.value = 0; },
    (request) => { request.params.arguments.frameRate.denominator = 0; },
    (request) => { request.params.arguments.pixelAspectRatio.numerator = 0; },
    (request) => { request.params.arguments.width = 0; },
    (request) => { request.params.arguments.idempotencyKey = 'short'; },
  ]) {
    const malformed = structuredClone(fixture.request);
    mutate(malformed);
    assert.equal(schemaAccepts(schema.$defs.request, malformed), false);
    assert.equal(validateRequestComposite(malformed, schema).ok, false);
  }

  const unicodeName = structuredClone(fixture.request);
  unicodeName.params.arguments.name = '合成😀';
  assert.equal(schemaAccepts(schema.$defs.request, unicodeName), true);
  assert.equal(validateRequestComposite(unicodeName, schema).ok, true);

  for (const mutate of [
    (value) => { value.projectItemCountAfter = value.projectItemCountBefore; },
    (value) => { value.layerCount = 1; },
    (value) => { value.frameRate.rational = '24/1'; },
    (value) => { value.width = 1280; },
    (value) => { value.compositionLocator.kind = 'layer'; },
  ]) {
    const malformed = structuredClone(fixture.response);
    mutate(malformed.result.value);
    malformed.result.evidence.postcondition.digest = postconditionDigest(malformed.result);
    assert.equal(validateTranscript(
      context, fixture.request, [...fixture.events, malformed],
    ), false);
  }
});

test('composition layer create binds native state, fresh locators, Undo, and solid metadata', () => {
  const fixture = golden('invoke-composition-layer-create.json');
  const descriptor = compositionLayerCreateDescriptor(schema);
  const context = {
    hello: golden('hello.json'),
    descriptor,
    schema,
    brokerSendUnixMs: 1900000000000,
    effectiveDeadlineUnixMs: fixture.request.deadlineUnixMs,
    terminalObservedUnixMs: 1900000000030,
  };
  assert.equal(descriptor.contractDigest, compositionLayerCreateContractDigest(schema));
  assert.equal(fixture.response.result.evidence.requestDigest, sha256Jcs(fixture.request));
  assert.equal(fixture.response.result.evidence.postcondition.digest,
    postconditionDigest(fixture.response.result));
  assert.equal(validateTranscript(
    context, fixture.request, [...fixture.events, fixture.response],
  ), true);

  for (const mutate of [
    (request) => { request.params.arguments.kind = 'null'; },
    (request) => { request.params.arguments.color.red = 256; },
    (request) => { request.params.arguments.width = 0; },
    (request) => { request.params.arguments.name = ''; },
    (request) => { request.params.arguments.idempotencyKey = 'short'; },
  ]) {
    const malformed = structuredClone(fixture.request);
    mutate(malformed);
    assert.equal(validateRequestComposite(malformed, schema).ok, false);
  }

  for (const mutate of [
    (value) => { value.layerCountAfter += 1; },
    (value) => { value.compositionLocator.generation = 8; },
    (value) => { value.layerLocator.projectId = '44444444-4444-4444-8444-444444444444'; },
    (value) => { value.solid.color.red = 13; },
    (value) => { value.projectItemCountAfter = value.projectItemCountBefore; },
  ]) {
    const malformed = structuredClone(fixture.response);
    mutate(malformed.result.value);
    malformed.result.evidence.postcondition.digest = postconditionDigest(malformed.result);
    assert.equal(validateTranscript(
      context, fixture.request, [...fixture.events, malformed],
    ), false);
  }
});

test('layer effect apply binds exact installed match, fresh locator, counts, and Undo', () => {
  const fixture = golden('invoke-layer-effect-apply.json');
  const descriptor = layerEffectApplyDescriptor(schema);
  const context = {
    hello: golden('hello.json'),
    descriptor,
    schema,
    brokerSendUnixMs: 1900000000000,
    effectiveDeadlineUnixMs: fixture.request.deadlineUnixMs,
    terminalObservedUnixMs: 1900000000030,
  };
  assert.equal(descriptor.contractDigest, layerEffectApplyContractDigest(schema));
  assert.equal(fixture.response.result.evidence.requestDigest, sha256Jcs(fixture.request));
  assert.equal(fixture.response.result.evidence.postcondition.digest,
    postconditionDigest(fixture.response.result));
  assert.equal(validateTranscript(
    context, fixture.request, [...fixture.events, fixture.response],
  ), true);

  for (const mutate of [
    (request) => { request.params.arguments.effectMatchName = ''; },
    (request) => { request.params.arguments.effectMatchName = 'x'.repeat(48); },
    (request) => { request.params.arguments.idempotencyKey = 'short'; },
    (request) => { request.params.arguments.extra = true; },
  ]) {
    const malformed = structuredClone(fixture.request);
    mutate(malformed);
    assert.equal(validateRequestComposite(malformed, schema).ok, false);
  }

  for (const mutate of [
    (value) => { value.effectCountAfter += 1; },
    (value) => { value.matchingEffectCountAfter += 1; },
    (value) => { value.matchName = 'ADBE Point Control'; },
    (value) => { value.effectIndex = 2; },
    (value) => { value.layerLocator.generation = 8; },
  ]) {
    const malformed = structuredClone(fixture.response);
    mutate(malformed.result.value);
    malformed.result.evidence.postcondition.digest = postconditionDigest(malformed.result);
    assert.equal(validateTranscript(
      context, fixture.request, [...fixture.events, malformed],
    ), false);
  }
});

test('native project navigation vectors bind bounded pagination and locator provenance', () => {
  for (const [name, descriptor] of [
    ['invoke-project-items-list.json', projectItemsListDescriptor(schema)],
    ['invoke-composition-layers-list.json', compositionLayersListDescriptor(schema)],
    ['invoke-composition-selected-layers-list.json',
      compositionSelectedLayersListDescriptor(schema)],
    ['invoke-composition-time-read.json', compositionTimeReadDescriptor(schema)],
    ['invoke-layer-properties-list.json', layerPropertiesListDescriptor(schema)],
    ['invoke-layer-property-keyframes-list.json',
      layerPropertyKeyframesListDescriptor(schema)],
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

  const project = golden('invoke-project-items-list.json');
  assert.equal(projectItemsListDescriptor(schema).contractDigest,
    projectItemsListContractDigest(schema));
  assert.deepEqual(projectItemsListDescriptor(schema).inputSchema.required, ['offset', 'limit']);
  assert.equal(projectItemsListDescriptor(schema).inputSchema.properties.limit.default, 25);
  assert.equal(projectItemsListDescriptor(schema).inputSchema.properties.limit.maximum, 50);
  const unknownItem = structuredClone(project.response.result.value);
  unknownItem.items[0].type = 'unknown';
  assert.equal(schemaAccepts(
    projectItemsListDescriptor(schema).resultSchema,
    unknownItem,
    projectItemsListDescriptor(schema).resultSchema,
  ), true);

  const secondPage = structuredClone(project.request);
  secondPage.requestId = 'invoke-project-items-2';
  secondPage.params.arguments = {
    projectLocator: project.response.result.value.projectLocator,
    offset: 1,
    limit: 25,
  };
  assert.equal(schemaAccepts(schema.$defs.request, secondPage), true);
  assert.deepEqual(validateRequestComposite(secondPage, schema), { ok: true });
  for (const mutate of [
    (request) => { delete request.params.arguments.offset; },
    (request) => { delete request.params.arguments.limit; },
    (request) => { request.params.arguments.offset = -1; },
    (request) => { request.params.arguments.limit = 0; },
    (request) => { request.params.arguments.limit = 51; },
    (request) => { request.params.arguments.offset = 1; delete request.params.arguments.projectLocator; },
    (request) => { request.params.arguments.projectLocator.kind = 'layer'; },
  ]) {
    const malformed = structuredClone(secondPage);
    mutate(malformed);
    assert.equal(schemaAccepts(schema.$defs.request, malformed), false);
    assert.deepEqual(classifyRequest(malformed), { ok: false, errorCode: 'INVALID_ARGUMENT' });
  }

  const projectContext = {
    hello: golden('hello.json'),
    descriptor: projectItemsListDescriptor(schema),
    schema,
    brokerSendUnixMs: 1900000000000,
    effectiveDeadlineUnixMs: project.request.deadlineUnixMs,
    terminalObservedUnixMs: 1900000000030,
  };
  for (const mutate of [
    (value) => { value.returned = 1; },
    (value) => { value.hasMore = true; },
    (value) => { value.nextOffset = 2; },
    (value) => { value.offset = 1; },
    (value) => { value.limit = 24; },
    (value) => { value.total = 1; },
    (value) => { value.items[1].locator.objectId = value.items[0].locator.objectId; },
    (value) => { value.items[0].parentLocator.sessionId = '33333333-3333-4333-8333-333333333333'; },
  ]) {
    const malformed = structuredClone(project.response);
    mutate(malformed.result.value);
    malformed.result.evidence.postcondition.digest = postconditionDigest(malformed.result);
    assert.equal(validateTranscript(
      projectContext, project.request, [...project.events, malformed],
    ), false);
  }

  const layers = golden('invoke-composition-layers-list.json');
  assert.equal(compositionLayersListDescriptor(schema).contractDigest,
    compositionLayersListContractDigest(schema));
  const layersContext = {
    hello: golden('hello.json'),
    descriptor: compositionLayersListDescriptor(schema),
    schema,
    brokerSendUnixMs: 1900000000000,
    effectiveDeadlineUnixMs: layers.request.deadlineUnixMs,
    terminalObservedUnixMs: 1900000000030,
  };
  for (const mutate of [
    (value) => { value.compositionLocator.objectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; },
    (value) => { value.layers[1].stackIndex = 1; },
    (value) => { value.layers[1].locator.objectId = value.layers[0].locator.objectId; },
    (value) => { value.layers[1].sourceItemLocator.kind = 'layer'; },
    (value) => { value.layers[1].parentLocator.generation = 9; },
    (value) => { delete value.layers[0].locked; },
  ]) {
    const malformed = structuredClone(layers.response);
    mutate(malformed.result.value);
    malformed.result.evidence.postcondition.digest = postconditionDigest(malformed.result);
    assert.equal(validateTranscript(
      layersContext, layers.request, [...layers.events, malformed],
    ), false);
  }

  const selectedLayers = golden('invoke-composition-selected-layers-list.json');
  assert.equal(compositionSelectedLayersListDescriptor(schema).contractDigest,
    compositionSelectedLayersListContractDigest(schema));
  assert.deepEqual(
    selectedLayers.response.result.value.layers.map((layer) => layer.stackIndex),
    [1, 3],
    'selected layers preserve strictly ascending, non-contiguous stack indices',
  );
  const selectedLayersContext = {
    hello: golden('hello.json'),
    descriptor: compositionSelectedLayersListDescriptor(schema),
    schema,
    brokerSendUnixMs: 1900000000000,
    effectiveDeadlineUnixMs: selectedLayers.request.deadlineUnixMs,
    terminalObservedUnixMs: 1900000000030,
  };
  for (const mutate of [
    (value) => { value.layers[1].stackIndex = value.layers[0].stackIndex; },
    (value) => { value.layers[1].stackIndex = value.layers[0].stackIndex - 1; },
    (value) => { value.layers[1].locator.objectId = value.layers[0].locator.objectId; },
  ]) {
    const malformed = structuredClone(selectedLayers.response);
    mutate(malformed.result.value);
    malformed.result.evidence.postcondition.digest = postconditionDigest(malformed.result);
    assert.equal(validateTranscript(
      selectedLayersContext,
      selectedLayers.request,
      [...selectedLayers.events, malformed],
    ), false);
  }

  const properties = golden('invoke-layer-properties-list.json');
  assert.equal(layerPropertiesListDescriptor(schema).contractDigest,
    layerPropertiesListContractDigest(schema));
  const propertiesContext = {
    hello: golden('hello.json'),
    descriptor: layerPropertiesListDescriptor(schema),
    schema,
    brokerSendUnixMs: 1900000000000,
    effectiveDeadlineUnixMs: properties.request.deadlineUnixMs,
    terminalObservedUnixMs: 1900000000030,
  };
  const explicitRoot = structuredClone(properties.request);
  explicitRoot.requestId = 'invoke-layer-properties-root';
  explicitRoot.params.arguments.parentPropertyLocator = null;
  assert.equal(schemaAccepts(schema.$defs.request, explicitRoot), true);
  assert.deepEqual(validateRequestComposite(explicitRoot, schema), { ok: true });
  const unknownUnsupported = structuredClone(properties.response);
  unknownUnsupported.result.value.properties[2].valueType = 'unknown';
  unknownUnsupported.result.evidence.postcondition.digest = postconditionDigest(
    unknownUnsupported.result,
  );
  assert.equal(validateTranscript(
    propertiesContext,
    properties.request,
    [...properties.events, unknownUnsupported],
  ), true);
  for (const mutate of [
    (value) => { value.layerLocator.objectId = '99999999-9999-4999-8999-999999999999'; },
    (value) => { value.parentPropertyLocator.objectId = '99999999-9999-4999-8999-999999999999'; },
    (value) => { value.sampleTime.scale = 0; },
    (value) => { value.properties[1].propertyIndex = 1; },
    (value) => { value.properties[0].propertyLocator.objectId = value.parentPropertyLocator.objectId; },
    (value) => { value.properties[1].propertyLocator.objectId = value.properties[0].propertyLocator.objectId; },
    (value) => { value.properties[0].value.components.push('30'); },
    (value) => { value.properties[1].value.value = '-0'; },
    (value) => { value.properties[1].value.value = '1e-999'; },
    (value) => { value.properties[1].canVaryOverTime = null; },
    (value) => {
      value.properties[2].valueStatus = 'no-data';
      value.properties[2].valueType = 'marker';
    },
  ]) {
    const malformed = structuredClone(properties.response);
    mutate(malformed.result.value);
    malformed.result.evidence.postcondition.digest = postconditionDigest(malformed.result);
    assert.equal(validateTranscript(
      propertiesContext, properties.request, [...properties.events, malformed],
    ), false);
  }

  const stale = structuredClone(golden('errors.json').responses.staleLocator);
  stale.requestId = layers.request.requestId;
  stale.error.details.capabilityId = layers.request.params.capabilityId;
  stale.error.details.field = 'params.arguments.compositionLocator';
  assert.equal(validateFailureExchange(
    golden('hello.json'), layers.request, stale, compositionLayersListDescriptor(schema), schema,
  ), true);
  const omittedGeneration = structuredClone(stale);
  delete omittedGeneration.error.details.currentGeneration;
  assert.equal(validateFailureExchange(
    golden('hello.json'), layers.request, omittedGeneration,
    compositionLayersListDescriptor(schema), schema,
  ), true);
  for (const invalidGeneration of [0, 1.5, 9007199254740992, '8']) {
    const malformed = structuredClone(omittedGeneration);
    malformed.error.details.currentGeneration = invalidGeneration;
    assert.equal(validateFailureExchange(
      golden('hello.json'), layers.request, malformed,
      compositionLayersListDescriptor(schema), schema,
    ), false, `invalid currentGeneration: ${String(invalidGeneration)}`);
  }
  stale.error.details.field = 'arguments.layer';
  assert.equal(validateFailureExchange(
    golden('hello.json'), layers.request, stale, compositionLayersListDescriptor(schema), schema,
  ), false);

  const projectStale = structuredClone(omittedGeneration);
  projectStale.requestId = secondPage.requestId;
  projectStale.error.details.capabilityId = secondPage.params.capabilityId;
  projectStale.error.details.field = 'params.arguments.projectLocator';
  assert.equal(validateFailureExchange(
    golden('hello.json'), secondPage, projectStale, projectItemsListDescriptor(schema), schema,
  ), true);

  const propertyStale = structuredClone(omittedGeneration);
  propertyStale.requestId = properties.request.requestId;
  propertyStale.error.details.capabilityId = properties.request.params.capabilityId;
  propertyStale.error.details.field = 'params.arguments.parentPropertyLocator';
  assert.equal(validateFailureExchange(
    golden('hello.json'), properties.request, propertyStale,
    layerPropertiesListDescriptor(schema), schema,
  ), true);
  propertyStale.error.details.field = 'params.arguments.layerLocator';
  assert.equal(validateFailureExchange(
    golden('hello.json'), properties.request, propertyStale,
    layerPropertiesListDescriptor(schema), schema,
  ), true);
});

test('native keyframe pages bind exact time, order, primitive type, and pagination', () => {
  const fixture = golden('invoke-layer-property-keyframes-list.json');
  const context = {
    hello: golden('hello.json'),
    descriptor: layerPropertyKeyframesListDescriptor(schema),
    schema,
    brokerSendUnixMs: 1900000000000,
    effectiveDeadlineUnixMs: fixture.request.deadlineUnixMs,
    terminalObservedUnixMs: 1900000000030,
  };
  assert.equal(context.descriptor.contractDigest,
    layerPropertyKeyframesListContractDigest(schema));
  assert.equal(validateTranscript(
    context, fixture.request, [...fixture.events, fixture.response],
  ), true);

  for (const mutate of [
    (value) => { value.propertyLocator.objectId = '99999999-9999-4999-8999-999999999999'; },
    (value) => { value.keyframes[1].keyframeIndex = 3; },
    (value) => { value.keyframes[1].time = { value: 0, scale: 24, mode: 'comp-time' }; },
    (value) => { value.keyframes[0].value = { kind: 'vector', components: ['1', '2'] }; },
    (value) => { value.keyframes[0].inInterpolation = 'auto'; },
    (value) => { value.returned = 1; },
    (value) => { value.nextOffset = 1; },
  ]) {
    const malformed = structuredClone(fixture.response);
    mutate(malformed.result.value);
    malformed.result.evidence.postcondition.digest = postconditionDigest(malformed.result);
    assert.equal(validateTranscript(
      context, fixture.request, [...fixture.events, malformed],
    ), false);
  }
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
