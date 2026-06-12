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
  const models = await fetchAnthropicModels({ apiKey: 'sk-x', httpsImpl: https });
  assert.deepEqual(models.map((m) => m.id), ['claude-opus-4-8']);
  assert.equal(https.calls[0].headers['x-api-key'], 'sk-x');
});

test('cachedByokModels hits cache inside TTL and refetches after expiry', async () => {
  let fetchCount = 0;
  const fetcher = async () => { fetchCount += 1; return [{ id: 'claude-sonnet-4-6', display_name: 'S' }]; };
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) || null, setItem: (k, v) => store.set(k, v) };
  let nowMs = 1000;
  const opts = { apiKey: 'sk-x', fetcher, storage, now: () => nowMs };
  await cachedByokModels(opts);
  await cachedByokModels(opts);
  assert.equal(fetchCount, 1);
  nowMs += 25 * 60 * 60 * 1000;
  await cachedByokModels(opts);
  assert.equal(fetchCount, 2);
});

test('fetchAnthropicModels returns null on http error', async () => {
  const models = await fetchAnthropicModels({ apiKey: 'sk-x', httpsImpl: fakeHttps(500, {}) });
  assert.equal(models, null);
});
