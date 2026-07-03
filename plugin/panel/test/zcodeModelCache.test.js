import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZCODE_PROBED_MODELS_CACHE_KEY, readCachedZcodeProbedModels, writeCachedZcodeProbedModels } from '../src/lib/zcodeModelCache.js';

function fakeStorage(initial = {}) {
  const store = { ...initial };
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    _store: store,
  };
}

test('ZCODE_PROBED_MODELS_CACHE_KEY is the documented localStorage key', () => {
  assert.equal(ZCODE_PROBED_MODELS_CACHE_KEY, 'ae_mcp_zcode_probed_models');
});

test('writeCachedZcodeProbedModels then readCachedZcodeProbedModels round-trips within TTL', () => {
  const storage = fakeStorage();
  const entry = { cliModel: 'mediastorm_glm/deepseek-v4-flash', providerId: 'mediastorm_glm', probedModels: [{ id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' }] };
  writeCachedZcodeProbedModels(storage, entry);
  const read = readCachedZcodeProbedModels(storage);
  assert.equal(read.cliModel, entry.cliModel);
  assert.equal(read.providerId, entry.providerId);
  assert.deepEqual(read.probedModels, entry.probedModels);
});

test('readCachedZcodeProbedModels returns null when nothing is cached', () => {
  const storage = fakeStorage();
  assert.equal(readCachedZcodeProbedModels(storage), null);
});

test('readCachedZcodeProbedModels returns null past the 1 hour TTL', () => {
  const storage = fakeStorage();
  const entry = { cliModel: 'mediastorm_glm/deepseek-v4-flash', providerId: 'mediastorm_glm', probedModels: [{ id: 'deepseek-v4-flash' }] };
  writeCachedZcodeProbedModels(storage, entry);
  const raw = JSON.parse(storage.getItem(ZCODE_PROBED_MODELS_CACHE_KEY));
  raw.probedAt = Date.now() - (60 * 60 * 1000 + 1000); // 1h + 1s ago
  storage.setItem(ZCODE_PROBED_MODELS_CACHE_KEY, JSON.stringify(raw));
  assert.equal(readCachedZcodeProbedModels(storage), null);
});

test('readCachedZcodeProbedModels still returns entry just under the 1 hour TTL', () => {
  const storage = fakeStorage();
  const entry = { cliModel: 'mediastorm_glm/deepseek-v4-flash', providerId: 'mediastorm_glm', probedModels: [{ id: 'deepseek-v4-flash' }] };
  writeCachedZcodeProbedModels(storage, entry);
  const raw = JSON.parse(storage.getItem(ZCODE_PROBED_MODELS_CACHE_KEY));
  raw.probedAt = Date.now() - (60 * 60 * 1000 - 1000); // just under 1h ago
  storage.setItem(ZCODE_PROBED_MODELS_CACHE_KEY, JSON.stringify(raw));
  const read = readCachedZcodeProbedModels(storage);
  assert.ok(read);
  assert.equal(read.cliModel, entry.cliModel);
});

test('readCachedZcodeProbedModels tolerates malformed JSON and missing fields', () => {
  const storage = fakeStorage({ [ZCODE_PROBED_MODELS_CACHE_KEY]: 'not json' });
  assert.equal(readCachedZcodeProbedModels(storage), null);
  const storage2 = fakeStorage({ [ZCODE_PROBED_MODELS_CACHE_KEY]: JSON.stringify({ probedAt: Date.now() }) });
  assert.equal(readCachedZcodeProbedModels(storage2), null);
});

test('writeCachedZcodeProbedModels is a no-op (best-effort) when storage throws', () => {
  const storage = { getItem: () => { throw new Error('nope'); }, setItem: () => { throw new Error('nope'); } };
  assert.doesNotThrow(() => writeCachedZcodeProbedModels(storage, { cliModel: 'x', providerId: 'y', probedModels: [{ id: 'a' }] }));
  assert.equal(readCachedZcodeProbedModels(storage), null);
});
