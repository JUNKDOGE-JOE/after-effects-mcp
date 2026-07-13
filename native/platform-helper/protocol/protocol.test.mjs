import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(here, 'platform-helper.schema.json');
const fixtureRoot = path.join(here, 'fixtures');

const METHODS = [
  'capabilities',
  'secret.get',
  'secret.set',
  'secret.delete',
  'window.find',
  'window.describe',
  'window.capture',
];

const ERROR_CODES = [
  'HELPER_UNAUTHORIZED',
  'HELPER_UNAVAILABLE',
  'PROTOCOL_VERSION_UNSUPPORTED',
  'INVALID_REQUEST',
  'INVALID_REFERENCE',
  'MESSAGE_TOO_LARGE',
  'SECRET_NOT_FOUND',
  'SECRET_CONFLICT',
  'SECRET_STORE_UNAVAILABLE',
  'SCREEN_RECORDING_PERMISSION_REQUIRED',
  'AE_WINDOW_NOT_FOUND',
  'AE_WINDOW_NOT_CAPTURABLE',
  'CAPTURE_FAILED',
];

const REFERENCE = 'aemcp-secret://provider/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/api/v1';
const VALID_PARAMS = {
  capabilities: {},
  'secret.get': { reference: REFERENCE },
  'secret.set': { reference: REFERENCE, value: 'secret', expectedRevision: null },
  'secret.delete': { reference: REFERENCE, expectedRevision: 1 },
  'window.find': { target: 'after-effects-main' },
  'window.describe': { reference: 'ae-window://main/42' },
  'window.capture': {
    reference: 'ae-window://main/42',
    captureId: 'capture-1',
    method: 'auto',
  },
};

const WINDOW_DESCRIPTION = {
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

const VALID_RESULTS = {
  capabilities: {
    protocolVersion: 1,
    platform: 'macos-arm64',
    helperVersion: '0.1.0',
    secretBackend: 'keychain',
    captureBackend: 'screen-capture-kit',
    authenticatedCaller: true,
    maxMessageBytes: 65536,
    methods: METHODS,
  },
  'secret.get': { reference: REFERENCE, value: 'secret', revision: 1 },
  'secret.set': { reference: REFERENCE, revision: 2 },
  'secret.delete': { reference: REFERENCE, deleted: true, revision: null },
  'window.find': [WINDOW_DESCRIPTION],
  'window.describe': WINDOW_DESCRIPTION,
  'window.capture': {
    captureId: 'capture-1',
    reference: WINDOW_DESCRIPTION.reference,
    spoolPath: '/private/tmp/ae-mcp/capture-1.png',
    width: 1920,
    height: 1080,
    scale: 2,
    method: 'ScreenCaptureKit',
    sha256: 'a'.repeat(64),
  },
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveRef(root, reference) {
  assert.match(reference, /^#\//, `unsupported external schema reference: ${reference}`);
  return reference.slice(2).split('/').reduce((value, segment) => (
    value[segment.replaceAll('~1', '/').replaceAll('~0', '~')]
  ), root);
}

function typeMatches(type, value) {
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'null') return value === null;
  return typeof value === type;
}

// The protocol intentionally uses a small, portable JSON Schema subset so each
// native implementation can enforce the same contract without a JS dependency.
function schemaAccepts(schema, value, root) {
  if (schema === true) return true;
  if (schema === false || !schema || typeof schema !== 'object') return false;
  if (schema.$ref) return schemaAccepts(resolveRef(root, schema.$ref), value, root);
  if (schema.const !== undefined && !Object.is(schema.const, value)) return false;
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) return false;
  if (schema.oneOf) {
    if (schema.oneOf.filter((part) => schemaAccepts(part, value, root)).length !== 1) return false;
  }
  if (schema.anyOf && !schema.anyOf.some((part) => schemaAccepts(part, value, root))) return false;
  if (schema.allOf && !schema.allOf.every((part) => schemaAccepts(part, value, root))) return false;
  if (schema.type && !typeMatches(schema.type, value)) return false;
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return false;
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) return false;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return false;
    if (schema.pattern && !(new RegExp(schema.pattern)).test(value)) return false;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      return false;
    }
    if (schema.items && !value.every((item) => schemaAccepts(schema.items, item, root))) return false;
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (schema.required && !schema.required.every((key) => Object.hasOwn(value, key))) return false;
    if (schema.properties) {
      for (const [key, member] of Object.entries(schema.properties)) {
        if (Object.hasOwn(value, key) && !schemaAccepts(member, value[key], root)) return false;
      }
    }
    if (schema.additionalProperties === false
        && keys.some((key) => !Object.hasOwn(schema.properties ?? {}, key))) return false;
  }
  return true;
}

function uniqueRequestIds(schema, requests) {
  if (!requests.every((request) => schemaAccepts(schema.$defs.request, request, schema))) return false;
  return new Set(requests.map((request) => request.id)).size === requests.length;
}

test('schema locks protocol v1 to the seven non-enumerating methods and bounded messages', () => {
  const schema = readJson(schemaPath);
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema['x-maxMessageBytes'], 65536);
  assert.equal(schema.$defs.protocolVersion.const, 1);
  assert.equal(schema.$defs.positiveId.minimum, 1);
  assert.deepEqual(schema.$defs.helperMethod.enum, METHODS);
  assert.deepEqual(schema.$defs.helperErrorCode.enum, ERROR_CODES);
  assert.equal(schema.$defs.platformCapabilities.properties.maxMessageBytes.const, 65536);
  assert.doesNotMatch(JSON.stringify(schema), /secret\.list|secretList|enumerat/i);
});

test('fixtures accept valid requests and responses and return INVALID_REQUEST for secret.list', () => {
  const schema = readJson(schemaPath);
  for (const name of ['capabilities.json', 'secret-get.json', 'window-capture.json']) {
    const fixture = readJson(path.join(fixtureRoot, name));
    assert.equal(schemaAccepts(schema.$defs.request, fixture.request, schema), true, `${name} request`);
    assert.equal(schemaAccepts(schema.$defs.response, fixture.response, schema), true, `${name} response`);
    assert.equal(fixture.response.id, fixture.request.id);
  }

  const unknown = readJson(path.join(fixtureRoot, 'invalid-unknown-method.json'));
  assert.equal(schemaAccepts(schema.$defs.request, unknown.request, schema), false);
  assert.equal(schemaAccepts(schema.$defs.response, unknown.response, schema), true);
  assert.equal(unknown.response.error.code, 'INVALID_REQUEST');
});

test('all seven methods are accepted while missing versions and duplicate request IDs are rejected', () => {
  const schema = readJson(schemaPath);
  const requests = METHODS.map((method, index) => ({
    protocolVersion: 1,
    id: index + 1,
    method,
    params: VALID_PARAMS[method],
  }));
  assert.equal(uniqueRequestIds(schema, requests), true);
  assert.equal(schemaAccepts(schema.$defs.request, { ...requests[0], protocolVersion: undefined }, schema), false);
  const missingVersion = { ...requests[0] };
  delete missingVersion.protocolVersion;
  assert.equal(schemaAccepts(schema.$defs.request, missingVersion, schema), false);
  assert.equal(uniqueRequestIds(schema, [requests[0], { ...requests[1], id: requests[0].id }]), false);
});

test('schema enforces exact method params and typed success results', () => {
  const schema = readJson(schemaPath);
  const base = { protocolVersion: 1, id: 1 };
  assert.equal(schemaAccepts(schema.$defs.request, {
    ...base,
    method: 'secret.get',
    params: {},
  }, schema), false);
  assert.equal(schemaAccepts(schema.$defs.request, {
    ...base,
    method: 'secret.set',
    params: { ...VALID_PARAMS['secret.set'], unexpected: true },
  }, schema), false);
  assert.equal(schemaAccepts(schema.$defs.request, {
    ...base,
    method: 'window.capture',
    params: { captureId: 'capture-1' },
  }, schema), false);

  assert.equal(schemaAccepts(schema.$defs.response, {
    ...base,
    ok: true,
    result: { reference: REFERENCE, value: 'secret', revision: 1 },
  }, schema), true);
  assert.equal(schemaAccepts(schema.$defs.response, {
    ...base,
    ok: true,
    result: {},
  }, schema), false);
});

test('schema binds each of the seven methods to its exact params and success result', () => {
  const schema = readJson(schemaPath);
  assert.ok(schema.$defs.methodContract, 'methodContract schema is required');
  assert.equal(schema.$defs.methodContract.oneOf.length, METHODS.length);
  for (const [index, method] of METHODS.entries()) {
    const contract = {
      method,
      params: VALID_PARAMS[method],
      successResult: VALID_RESULTS[method],
    };
    assert.equal(
      schemaAccepts(schema.$defs.methodContract, contract, schema),
      true,
      `${method} contract`,
    );
    const wrongMethod = METHODS[(index + 1) % METHODS.length];
    assert.equal(
      schemaAccepts(schema.$defs.methodContract, {
        ...contract,
        successResult: VALID_RESULTS[wrongMethod],
      }, schema),
      false,
      `${method} rejects ${wrongMethod} result`,
    );
  }
});

test('secret references use the exact Task 6 UUID and bounded slot grammar', () => {
  const schema = readJson(schemaPath);
  const accepts = (reference) => schemaAccepts(
    schema.$defs.secretReference,
    reference,
    schema,
  );
  assert.equal(accepts(REFERENCE), true);
  assert.equal(accepts(
    `aemcp-secret://provider/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/${'a'.repeat(32)}/v1`,
  ), true);
  for (const reference of [
    'aemcp-secret://provider/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/Api/v1',
    'aemcp-secret://provider/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/1api/v1',
    'aemcp-secret://provider/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/api.key/v1',
    `aemcp-secret://provider/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/${'a'.repeat(33)}/v1`,
  ]) {
    assert.equal(accepts(reference), false, reference);
  }
});

test('malformed error envelopes are rejected', () => {
  const schema = readJson(schemaPath);
  const valid = {
    protocolVersion: 1,
    id: 9,
    ok: false,
    error: { code: 'HELPER_UNAVAILABLE', message: 'offline', retryable: true },
  };
  assert.equal(schemaAccepts(schema.$defs.response, valid, schema), true);
  assert.equal(schemaAccepts(schema.$defs.response, {
    ...valid,
    error: { code: 'HELPER_UNAVAILABLE', message: 'offline' },
  }, schema), false);
  assert.equal(schemaAccepts(schema.$defs.response, { ...valid, result: {} }, schema), false);
  assert.equal(schemaAccepts(schema.$defs.response, {
    ...valid,
    error: { ...valid.error, code: 'SHELL_FAILED' },
  }, schema), false);
});
