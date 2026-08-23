import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeOpenCodeProviderModels } from '../src/cep/openCodeModelProbe.js';

function harness(response) {
  const calls = [];
  return {
    calls,
    adapter: { async requestJson(request) {
      calls.push(request);
      if (response instanceof Error) throw response;
      return response;
    } },
  };
}

const draft = (baseUrl, extra = {}) => ({ baseUrl, protocol: 'openai', ...extra });
const ok = (json) => ({ ok: true, status: 200, json, text: JSON.stringify(json) });

test('builds one canonical /v1/models URL across base URL variants', async () => {
  for (const [baseUrl, expected] of [
    ['https://relay.test', 'https://relay.test/v1/models'],
    ['https://relay.test/', 'https://relay.test/v1/models'],
    ['https://relay.test/v1', 'https://relay.test/v1/models'],
    ['https://relay.test/v1/', 'https://relay.test/v1/models'],
  ]) {
    const h = harness(ok({ data: [] }));
    assert.equal((await probeOpenCodeProviderModels({ draft: draft(baseUrl), adapter: h.adapter })).ok, true);
    assert.equal(h.calls[0].url, expected);
  }
});

test('refuses insecure HTTP unless explicitly allowed and rejects invalid URLs', async () => {
  const blocked = harness(ok([]));
  assert.equal((await probeOpenCodeProviderModels({ draft: draft('http://relay.test'), adapter: blocked.adapter })).ok, false);
  assert.equal(blocked.calls.length, 0);
  const allowed = harness(ok([]));
  assert.equal((await probeOpenCodeProviderModels({
    draft: draft('http://relay.test', { allowInsecureHttp: true }), adapter: allowed.adapter,
  })).ok, true);
  assert.equal((await probeOpenCodeProviderModels({ draft: draft('bad-url'), adapter: allowed.adapter })).ok, false);
});

test('sends dialect-specific authentication and Anthropic pagination headers', async () => {
  const openai = harness(ok([]));
  await probeOpenCodeProviderModels({ draft: draft('https://relay.test'), apiKey: 'key-a', adapter: openai.adapter });
  assert.deepEqual(openai.calls[0].headers, { accept: 'application/json', Authorization: 'Bearer key-a' });

  const anthropic = harness(ok([]));
  await probeOpenCodeProviderModels({
    draft: draft('https://relay.test', { protocol: 'anthropic' }), apiKey: 'key-b', adapter: anthropic.adapter,
  });
  assert.deepEqual(anthropic.calls[0].headers, {
    accept: 'application/json', 'x-api-key': 'key-b', 'anthropic-version': '2023-06-01',
  });
  assert.equal(anthropic.calls[0].url, 'https://relay.test/v1/models?limit=1000');

  const openRelay = harness(ok([]));
  await probeOpenCodeProviderModels({ draft: draft('https://relay.test'), apiKey: '', adapter: openRelay.adapter });
  assert.deepEqual(openRelay.calls[0].headers, { accept: 'application/json' });
});

test('parses data and bare-array shapes with stable deduplication', async () => {
  const data = await probeOpenCodeProviderModels({
    draft: draft('https://relay.test'), adapter: harness(ok({ data: [{ id: ' a ' }, { id: 'b' }, { id: 'a' }, {}] })).adapter,
  });
  assert.deepEqual(data, { ok: true, models: ['a', 'b'], total: 2 });
  const bare = await probeOpenCodeProviderModels({
    draft: draft('https://relay.test'), adapter: harness(ok(['x', { id: ' y ' }, 'x'])).adapter,
  });
  assert.deepEqual(bare, { ok: true, models: ['x', 'y'], total: 2 });
});

test('filters unsafe catalog ids and caps the model rows returned to the panel', async () => {
  const valid = Array.from({ length: 205 }, (_value, index) => ({ id: `model-${index}` }));
  const result = await probeOpenCodeProviderModels({
    draft: draft('https://relay.test'),
    adapter: harness(ok({ data: [
      { id: 'bad model' },
      { id: '<script>' },
      ...valid,
      { id: 'model-0' },
    ] })).adapter,
  });
  assert.equal(result.ok, true);
  assert.equal(result.models.length, 200);
  assert.equal(result.total, 205);
  assert.equal(result.models[0], 'model-0');
  assert.equal(result.models.at(-1), 'model-199');
});

test('rejects a successful model response that reflects a credential', async () => {
  const key = 'sk-test-REFLECTED-SECRET';
  const result = await probeOpenCodeProviderModels({
    draft: draft('https://relay.test'),
    apiKey: key,
    adapter: harness(ok({ data: [{ id: key }] })).adapter,
  });
  assert.equal(result.ok, false);
  assert.equal(result.detail.includes(key), false);
  assert.match(result.detail, /rejected/i);
});

test('reports HTTP, non-JSON, timeout and socket failures without leaking keys', async () => {
  const key = 'sk-test-SECRET-123';
  const cases = [
    harness({ ok: false, status: 401, json: null, text: `denied ${key} ${'x'.repeat(150)}` }).adapter,
    harness({ ok: true, status: 200, json: null, text: '<html>' }).adapter,
    harness(new Error(`timeout for ${key}`)).adapter,
    harness(new Error(`socket closed ${key}`)).adapter,
  ];
  const results = [];
  for (const adapter of cases) {
    const result = await probeOpenCodeProviderModels({ draft: draft('https://relay.test'), apiKey: key, adapter });
    assert.equal(result.ok, false);
    assert.equal(result.detail.includes(key), false);
    results.push(result.detail);
  }
  assert.match(results[0], /^HTTP 401/);
  assert.match(results[1], /non-JSON/);
  assert.match(results[2], /timeout/);
  assert.match(results[3], /socket/);
});
