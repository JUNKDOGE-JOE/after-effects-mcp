import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectProviderDialect, effectiveProviderDialect } from '../src/cep/providerDetect.js';

function providerFixture(overrides = {}) {
  return Object.assign({
    id: 'provider-1',
    credentialId: '5eb75f05-5d9e-5d9c-85af-f0893e8b90c2',
    name: 'Provider 1',
    protocol: 'openai-compatible',
    baseUrl: 'https://provider.example/v1',
    allowInsecureHttp: false,
    authProfileRevision: 1,
    auth: { model: { kind: 'none' }, probe: { kind: 'inherit-model' } },
    headers: [],
    dialect: { override: null, detected: null },
    probedModels: [],
    probedAt: 0,
  }, overrides);
}

function jsonResult(status, value, headers = { 'content-type': 'application/json' }) {
  return { status, headers, body: JSON.stringify(value) };
}

function sequenceRequest(results) {
  const queue = results.slice();
  const calls = [];
  const request = async (input) => {
    calls.push(input);
    if (queue.length === 0) throw new Error('unexpected provider request');
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  request.calls = calls;
  return request;
}

function resolvedProfiles({ probeSecret = 'probe-value', modelSecret = 'model-value' } = {}) {
  return async (provider, { scope }) => ({
    providerId: provider.id,
    baseUrl: provider.baseUrl,
    allowInsecureHttp: provider.allowInsecureHttp,
    auth: scope === 'probe'
      ? { kind: 'header', name: 'x-probe-token', value: probeSecret }
      : { kind: 'header', name: 'Authorization', value: `Bearer ${modelSecret}` },
    extraHeaders: scope === 'probe'
      ? [{ name: 'x-probe-feature', value: 'probe-enabled', source: 'literal' }]
      : [{ name: 'x-model-feature', value: 'model-enabled', source: 'literal' }],
    authProfileRevision: provider.authProfileRevision,
  });
}

test('generic JSON 400 is not Responses evidence', async () => {
  const requestImpl = sequenceRequest([
    jsonResult(200, { data: [{ id: 'model-1' }] }),
    jsonResult(400, { error: { message: 'unsupported parameter' } }),
    jsonResult(422, { error: { param: 'messages', code: 'missing_required_parameter' } }),
  ]);
  const result = await detectProviderDialect({
    provider: providerFixture(),
    resolveRequestProfile: resolvedProfiles(),
    requestImpl,
    now: () => 1000,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.dialect, {
    wireApi: 'chat',
    baseUrl: 'https://provider.example/v1',
    authProfileRevision: 1,
    detectedAt: 1000,
    evidence: 'chat-missing-messages',
  });
  assert.equal(requestImpl.calls.length, 3);
});

test('accepts only schema-specific Responses and Chat success objects', async () => {
  const responsesRequest = sequenceRequest([
    jsonResult(200, { data: [{ id: 'model-r' }] }),
    jsonResult(200, { id: 'resp_1', object: 'response', output: [] }),
  ]);
  const responses = await detectProviderDialect({
    provider: providerFixture(),
    resolveRequestProfile: resolvedProfiles(),
    requestImpl: responsesRequest,
    now: () => 2000,
  });
  assert.equal(responses.ok, true);
  assert.equal(responses.dialect.wireApi, 'responses');
  assert.equal(responses.dialect.evidence, 'responses-success-schema');

  const chatRequest = sequenceRequest([
    jsonResult(200, { data: [{ id: 'model-c' }] }),
    jsonResult(404, { error: { message: 'missing' } }),
    jsonResult(200, { id: 'chatcmpl_1', object: 'chat.completion', choices: [] }),
  ]);
  const chat = await detectProviderDialect({
    provider: providerFixture(),
    resolveRequestProfile: resolvedProfiles(),
    requestImpl: chatRequest,
    now: () => 3000,
  });
  assert.equal(chat.ok, true);
  assert.equal(chat.dialect.wireApi, 'chat');
  assert.equal(chat.dialect.evidence, 'chat-success-schema');
});

test('recognizes only endpoint-specific missing input and messages errors', async () => {
  const responsesRequest = sequenceRequest([
    jsonResult(200, { data: [{ id: 'model-r' }] }),
    jsonResult(400, { error: { param: 'input', code: 'missing_required_parameter' } }),
  ]);
  const responses = await detectProviderDialect({
    provider: providerFixture(),
    resolveRequestProfile: resolvedProfiles(),
    requestImpl: responsesRequest,
  });
  assert.equal(responses.ok, true);
  assert.equal(responses.dialect.evidence, 'responses-missing-input');

  const chatRequest = sequenceRequest([
    jsonResult(200, { data: [{ id: 'model-c' }] }),
    jsonResult(400, { error: { param: 'other' } }),
    jsonResult(400, { error: { param: 'messages', code: 'missing_required_parameter' } }),
  ]);
  const chat = await detectProviderDialect({
    provider: providerFixture(),
    resolveRequestProfile: resolvedProfiles(),
    requestImpl: chatRequest,
  });
  assert.equal(chat.ok, true);
  assert.equal(chat.dialect.evidence, 'chat-missing-messages');
});

test('HTML, WAF-shaped errors, and redirects remain dialect-incompatible', async () => {
  for (const endpointResults of [
    [
      { status: 400, headers: { 'content-type': 'text/html' }, body: '<html>bad request</html>' },
      { status: 404, headers: { 'content-type': 'text/plain' }, body: 'missing' },
    ],
    [
      jsonResult(400, { error: { message: 'request blocked by policy' } }),
      jsonResult(503, { error: { message: 'upstream unavailable' } }),
    ],
    [
      { status: 302, headers: { location: 'https://login.example/' }, body: '' },
      { status: 307, headers: { location: 'https://login.example/' }, body: '' },
    ],
  ]) {
    const requestImpl = sequenceRequest([
      jsonResult(200, { data: [{ id: 'model-1' }] }),
      ...endpointResults,
    ]);
    const result = await detectProviderDialect({
      provider: providerFixture(),
      resolveRequestProfile: resolvedProfiles(),
      requestImpl,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'dialect-incompatible');
  }
});

test('classifies model authentication, path, configuration, and network failures', async () => {
  for (const status of [401, 403]) {
    const requestImpl = sequenceRequest([jsonResult(status, { error: { message: 'denied' } })]);
    const result = await detectProviderDialect({
      provider: providerFixture(),
      resolveRequestProfile: resolvedProfiles(),
      requestImpl,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'authentication');
    assert.equal(requestImpl.calls.length, 1);
  }

  const missing = await detectProviderDialect({
    provider: providerFixture(),
    resolveRequestProfile: resolvedProfiles(),
    requestImpl: sequenceRequest([jsonResult(404, { error: { message: 'missing' } })]),
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'path-unsupported');

  const networkSecret = 'network-secret-that-must-not-escape';
  const network = await detectProviderDialect({
    provider: providerFixture(),
    resolveRequestProfile: resolvedProfiles(),
    requestImpl: sequenceRequest([new Error(`ECONNRESET ${networkSecret}`)]),
  });
  assert.equal(network.ok, false);
  assert.equal(network.reason, 'network');
  assert.equal(JSON.stringify(network).includes(networkSecret), false);

  const configurationSecret = 'configuration-secret-that-must-not-escape';
  const configuration = await detectProviderDialect({
    provider: providerFixture(),
    resolveRequestProfile: async () => { throw new Error(configurationSecret); },
    requestImpl: sequenceRequest([]),
  });
  assert.equal(configuration.ok, false);
  assert.equal(configuration.reason, 'configuration');
  assert.equal(JSON.stringify(configuration).includes(configurationSecret), false);
});

test('uses probe auth for models and model auth for endpoint semantics without returning values', async () => {
  const probeSecret = 'probe-secret-exact';
  const modelSecret = 'model-secret-exact';
  const requestImpl = sequenceRequest([
    jsonResult(200, { data: [{ id: 'model-1' }] }),
    jsonResult(422, { error: { param: 'input', code: 'missing_required_parameter' } }),
  ]);
  const result = await detectProviderDialect({
    provider: providerFixture(),
    resolveRequestProfile: resolvedProfiles({ probeSecret, modelSecret }),
    requestImpl,
    now: () => 4000,
  });

  assert.equal(requestImpl.calls[0].headers['x-probe-token'], probeSecret);
  assert.equal(requestImpl.calls[0].headers['x-probe-feature'], 'probe-enabled');
  assert.equal(requestImpl.calls[1].headers.authorization, `Bearer ${modelSecret}`);
  assert.equal(requestImpl.calls[1].headers['x-model-feature'], 'model-enabled');
  assert.equal(JSON.stringify(result).includes(probeSecret), false);
  assert.equal(JSON.stringify(result).includes(modelSecret), false);
  assert.deepEqual(result.tried.map((entry) => entry.headerNames), [
    ['x-probe-feature', 'x-probe-token'],
    ['authorization', 'content-type', 'x-model-feature'],
  ]);
});

test('rejects non-openai-compatible providers without resolving credentials', async () => {
  let resolves = 0;
  const result = await detectProviderDialect({
    provider: providerFixture({ protocol: 'anthropic' }),
    resolveRequestProfile: async () => { resolves += 1; },
    requestImpl: sequenceRequest([]),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'configuration');
  assert.equal(resolves, 0);
});

test('effectiveProviderDialect prefers override and validates detected cache identity and age', () => {
  const nowMs = 100_000_000;
  const detected = {
    wireApi: 'chat',
    baseUrl: 'https://provider.example/v1/',
    authProfileRevision: 1,
    detectedAt: nowMs - 86_400_000,
    evidence: 'chat-success-schema',
  };
  const base = providerFixture({ dialect: { override: null, detected } });

  assert.equal(effectiveProviderDialect(base, { now: () => nowMs }), 'chat');
  assert.equal(effectiveProviderDialect({ ...base, baseUrl: 'https://other.example/v1' }, { now: () => nowMs }), null);
  assert.equal(effectiveProviderDialect({ ...base, authProfileRevision: 2 }, { now: () => nowMs }), null);
  assert.equal(effectiveProviderDialect({
    ...base,
    dialect: { override: null, detected: { ...detected, detectedAt: nowMs + 1 } },
  }, { now: () => nowMs }), null);
  assert.equal(effectiveProviderDialect({
    ...base,
    dialect: { override: null, detected: { ...detected, detectedAt: nowMs - 86_400_001 } },
  }, { now: () => nowMs }), null);

  const overridden = providerFixture({
    baseUrl: 'https://changed.example/v1',
    authProfileRevision: 9,
    dialect: {
      override: { wireApi: 'responses', source: 'manual', updatedAt: 1 },
      detected,
    },
  });
  assert.equal(effectiveProviderDialect(overridden, { now: () => nowMs }), 'responses');
});
