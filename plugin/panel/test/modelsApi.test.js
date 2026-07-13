import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAnthropicModels, cachedByokModels } from '../src/cep/modelsApi.js';

function fakeHttps(status, body) {
  const calls = [];
  return {
    calls,
    request(options, onRes) {
      calls.push(options);
      const handlers = {};
      const res = {
        statusCode: status,
        on(evt, cb) { handlers[evt] = cb; return res; },
      };
      setImmediate(() => {
        onRes(res);
        if (handlers.data) handlers.data(Buffer.from(JSON.stringify(body)));
        if (handlers.end) handlers.end();
      });
      return { on() {}, end() {}, setTimeout() {} };
    },
  };
}

test('fetchAnthropicModels parses and filters claude models', async () => {
  const https = fakeHttps(200, { data: [
    { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' },
    { id: 'gpt-other', display_name: 'Not ours' },
  ] });
  const models = await fetchAnthropicModels({ requestProfile: { baseUrl: 'https://api.anthropic.com', auth: { kind: 'header', name: 'x-api-key', value: 'resolved-only-for-request' }, extraHeaders: [] }, httpsImpl: https });
  assert.deepEqual(models.map((m) => m.id), ['claude-opus-4-8']);
  assert.equal(https.calls[0].headers['x-api-key'], 'resolved-only-for-request');
});

test('fetchAnthropicModels supports an Anthropic-compatible base URL', async () => {
  const https = fakeHttps(200, { data: [{ id: 'claude-proxy-1', display_name: 'Claude Proxy' }] });
  const models = await fetchAnthropicModels({
    requestProfile: { baseUrl: 'https://proxy.example/anthropic/', auth: { kind: 'header', name: 'x-api-key', value: 'resolved-only-for-request' }, extraHeaders: [] },
    httpsImpl: https,
  });

  assert.deepEqual(models.map((m) => m.id), ['claude-proxy-1']);
  assert.equal(https.calls[0].hostname, 'proxy.example');
  assert.equal(https.calls[0].path, '/anthropic/v1/models?limit=100');
});

test('fetchAnthropicModels preserves UTF-8 metadata split across response chunks', async () => {
  const body = Buffer.from(JSON.stringify({
    data: [{ id: 'claude-模型-😀', display_name: 'Claude 模型 😀' }],
  }), 'utf8');
  const emojiOffset = body.indexOf(Buffer.from('😀', 'utf8'));
  const https = {
    request(options, onRes) {
      const handlers = {};
      const res = {
        statusCode: 200,
        on(event, handler) { handlers[event] = handler; return this; },
      };
      return {
        on() { return this; },
        setTimeout() {},
        end() {
          onRes(res);
          handlers.data(body.subarray(0, emojiOffset + 1));
          handlers.data(body.subarray(emojiOffset + 1));
          handlers.end();
        },
      };
    },
  };

  const models = await fetchAnthropicModels({
    requestProfile: {
      baseUrl: 'https://api.anthropic.com',
      auth: { kind: 'header', name: 'x-api-key', value: 'resolved-only-for-request' },
      extraHeaders: [],
    },
    httpsImpl: https,
  });

  assert.deepEqual(models, [{ id: 'claude-模型-😀', display_name: 'Claude 模型 😀' }]);
});

test('fetchAnthropicModels aborts sustained chunked responses above 512 KiB', async () => {
  let requestDestroyed = 0;
  let responseDestroyed = 0;
  const https = {
    request(options, onRes) {
      const handlers = {};
      const res = {
        statusCode: 200,
        on(event, handler) { handlers[event] = handler; return this; },
        destroy() { responseDestroyed += 1; },
      };
      return {
        on() { return this; },
        setTimeout() {},
        destroy() { requestDestroyed += 1; },
        end() {
          onRes(res);
          for (let index = 0; index < 140; index += 1) {
            handlers.data(Buffer.alloc(4096, 120));
            if (index === 128) {
              assert.equal(requestDestroyed, 1);
              assert.equal(responseDestroyed, 1);
            }
          }
          handlers.end();
        },
      };
    },
  };

  const models = await fetchAnthropicModels({
    requestProfile: {
      baseUrl: 'https://api.anthropic.com',
      auth: { kind: 'header', name: 'x-api-key', value: 'resolved-only-for-request' },
      extraHeaders: [],
    },
    httpsImpl: https,
  });

  assert.equal(models, null);
  assert.equal(requestDestroyed, 1);
  assert.equal(responseDestroyed, 1);
});

test('fetchAnthropicModels aborts both streams when the request times out', async () => {
  let requestDestroyed = 0;
  let responseDestroyed = 0;
  const https = {
    request(options, onRes) {
      const res = {
        statusCode: 200,
        on() { return this; },
        destroy() { responseDestroyed += 1; },
      };
      let timeoutHandler = null;
      return {
        on() { return this; },
        setTimeout(timeoutMs, handler) { timeoutHandler = handler; },
        destroy() { requestDestroyed += 1; },
        end() {
          onRes(res);
          timeoutHandler();
        },
      };
    },
  };

  const models = await fetchAnthropicModels({
    requestProfile: {
      baseUrl: 'https://api.anthropic.com',
      auth: { kind: 'header', name: 'x-api-key', value: 'resolved-only-for-request' },
      extraHeaders: [],
    },
    httpsImpl: https,
  });

  assert.equal(models, null);
  assert.equal(requestDestroyed, 1);
  assert.equal(responseDestroyed, 1);
});

test('cachedByokModels hits cache inside TTL and refetches after expiry', async () => {
  let fetchCount = 0;
  const fetcher = async () => { fetchCount += 1; return [{ id: 'claude-sonnet-4-6', display_name: 'S' }]; };
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) || null, setItem: (k, v) => store.set(k, v) };
  let nowMs = 1000;
  const opts = { providerId: 'relay', baseUrl: 'https://relay.example', authProfileRevision: 1, fetcher, storage, now: () => nowMs };
  await cachedByokModels(opts);
  await cachedByokModels(opts);
  assert.equal(fetchCount, 1);
  nowMs += 25 * 60 * 60 * 1000;
  await cachedByokModels(opts);
  assert.equal(fetchCount, 2);
});

test('cachedByokModels separates cache entries by base URL', async () => {
  let fetchCount = 0;
  const fetcher = async () => {
    fetchCount += 1;
    return [{ id: 'claude-sonnet-4-6', display_name: 'S' }];
  };
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) || null, setItem: (k, v) => store.set(k, v) };
  const now = () => 1000;

  await cachedByokModels({ providerId: 'relay', baseUrl: 'https://a.example', authProfileRevision: 1, fetcher, storage, now });
  await cachedByokModels({ providerId: 'relay', baseUrl: 'https://a.example', authProfileRevision: 1, fetcher, storage, now });
  await cachedByokModels({ providerId: 'relay', baseUrl: 'https://b.example', authProfileRevision: 1, fetcher, storage, now });

  assert.equal(fetchCount, 2);
});

test('fetchAnthropicModels returns null on http error', async () => {
  const models = await fetchAnthropicModels({ requestProfile: { baseUrl: 'https://api.anthropic.com', auth: { kind: 'header', name: 'x-api-key', value: 'resolved-only-for-request' }, extraHeaders: [] }, httpsImpl: fakeHttps(500, {}) });
  assert.equal(models, null);
});

test('cachedByokModels cache identity excludes API key material and includes auth revision', async () => {
  let fetchCount = 0;
  const storageMap = new Map();
  const storage = { getItem: (key) => storageMap.get(key) || null, setItem: (key, value) => storageMap.set(key, value) };
  const fetcher = async () => { fetchCount += 1; return [{ id: 'claude-model' }]; };
  await cachedByokModels({ providerId: 'relay', baseUrl: 'https://relay.example/', authProfileRevision: 1, fetcher, storage, now: () => 10 });
  await cachedByokModels({ providerId: 'relay', baseUrl: 'https://relay.example', authProfileRevision: 1, fetcher, storage, now: () => 10 });
  await cachedByokModels({ providerId: 'relay', baseUrl: 'https://relay.example', authProfileRevision: 2, fetcher, storage, now: () => 10 });
  assert.equal(fetchCount, 2);
  const serialized = Array.from(storageMap.values()).join('\n');
  assert.equal(serialized.includes('resolved-only-for-request'), false);
  assert.equal(serialized.includes('apiKey'), false);
});

test('cachedByokModels rejects upstream model metadata that echoes a resolved credential', async () => {
  const storageMap = new Map();
  const storage = { getItem: (key) => storageMap.get(key) || null, setItem: (key, value) => storageMap.set(key, value) };
  const models = await cachedByokModels({
    providerId: 'relay',
    baseUrl: 'https://relay.example',
    authProfileRevision: 1,
    requestProfile: {
      baseUrl: 'https://relay.example',
      auth: { kind: 'header', name: 'Authorization', value: 'Bearer resolved-only-for-request' },
      extraHeaders: [],
    },
    fetcher: async () => [{ id: 'resolved-only-for-request', display_name: 'echo' }],
    storage,
  });
  assert.equal(models, null);
  assert.equal(Array.from(storageMap.values()).join('').includes('resolved-only-for-request'), false);
});

test('cachedByokModels rejects JSON-escaped credentials in model ids and labels', async () => {
  for (const secret of ['opaque"provider-secret', 'opaque\\provider-secret']) {
    const storageMap = new Map();
    const storage = { getItem: (key) => storageMap.get(key) || null, setItem: (key, value) => storageMap.set(key, value) };
    const models = await cachedByokModels({
      providerId: 'relay',
      baseUrl: 'https://relay.example',
      authProfileRevision: 1,
      requestProfile: {
        baseUrl: 'https://relay.example',
        auth: { kind: 'header', name: 'Authorization', value: `Bearer ${secret}` },
        extraHeaders: [],
      },
      fetcher: async () => [{ id: secret, display_name: `label ${secret}` }],
      storage,
    });
    assert.equal(models, null);
    assert.equal(storageMap.size, 0);
  }
});
