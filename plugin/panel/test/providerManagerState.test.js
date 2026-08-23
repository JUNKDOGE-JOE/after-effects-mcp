import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  draftFromEntry,
  draftToEntry,
  emptyDraft,
  mergeProbedModelIds,
  providerDraftModelIds,
  reconcileDraftModelContexts,
  validateDraft,
} from '../src/lib/providerManagerState.js';

test('Provider Manager draft is the OpenCode configuration shape', () => {
  assert.deepEqual(emptyDraft(), {
    id: '',
    name: '',
    baseUrl: '',
    allowInsecureHttp: false,
    modelId: '',
    modelContexts: {},
    protocol: 'anthropic',
  });
});

test('draftFromEntry joins OpenCode model ids for editing', () => {
  assert.deepEqual(draftFromEntry({
    id: 'aemcp-example',
    name: 'Example',
    baseUrl: 'https://example.test/v1',
    modelIds: ['model-a', 'model-b'],
  }), {
    id: 'aemcp-example',
    name: 'Example',
    baseUrl: 'https://example.test/v1',
    allowInsecureHttp: false,
    modelId: 'model-a, model-b',
    modelContexts: { 'model-a': 128000, 'model-b': 128000 },
    protocol: 'anthropic',
  });
});

test('draft validation requires a name and HTTP(S) base URL', () => {
  assert.match(validateDraft(emptyDraft()), /name is required/i);
  assert.match(validateDraft({ ...emptyDraft(), name: 'Example', baseUrl: 'not-a-url' }), /http/i);
  assert.match(
    validateDraft({ ...emptyDraft(), name: 'Example', baseUrl: 'https://example.test' }),
    /at least one model/i,
  );
  assert.equal(
    validateDraft({
      ...emptyDraft(), name: 'Example', baseUrl: 'https://example.test', modelId: 'model-a',
    }),
    '',
  );
  assert.match(validateDraft({
    ...emptyDraft(),
    name: 'Example',
    baseUrl: 'https://example.test',
    modelId: '<script>',
  }), /model id is invalid/i);
});

test('draftToEntry derives a stable provider id', () => {
  assert.equal(draftToEntry({ ...emptyDraft(), name: 'Example Provider' }).id, 'example-provider');
});

test('draft protocol round-trips and defaults to anthropic', () => {
  assert.equal(draftFromEntry({ protocol: 'openai' }).protocol, 'openai');
  assert.equal(draftFromEntry({ protocol: 'weird' }).protocol, 'anthropic');
  assert.equal(draftToEntry({ name: 'x', protocol: 'openai' }).protocol, 'openai');
});

test('model context drafts default, preserve per-model values, and drop removed models', () => {
  assert.deepEqual(providerDraftModelIds('model-a, model-b model-a'), ['model-a', 'model-b']);
  assert.deepEqual(reconcileDraftModelContexts('model-a, model-b', { 'model-a': 64000 }), {
    'model-a': 64000,
    'model-b': 128000,
  });
  assert.deepEqual(draftToEntry({
    ...emptyDraft(),
    name: 'x',
    modelId: 'model-a, model-b',
    modelContexts: { 'model-a': '100000', stale: 32000 },
  }).modelContexts, {
    'model-a': 100000,
    'model-b': 128000,
  });
});

test('prototype-like model ids remain ordinary per-model context keys', () => {
  const modelId = '__proto__, constructor, toString';
  const current = Object.fromEntries([
    ['__proto__', 32000],
    ['constructor', 64000],
    ['toString', 200000],
  ]);
  const contexts = reconcileDraftModelContexts(modelId, current);
  assert.deepEqual(Object.keys(contexts), ['__proto__', 'constructor', 'toString']);
  assert.equal(contexts.__proto__, 32000);
  assert.equal(contexts.constructor, 64000);
  assert.equal(contexts.toString, 200000);
  assert.equal(Object.prototype.hasOwnProperty.call(contexts, '__proto__'), true);
});

test('draft validation rejects unsafe custom context windows', () => {
  const base = {
    ...emptyDraft(),
    name: 'Example',
    baseUrl: 'https://example.test',
    modelId: 'model-a',
  };
  assert.match(validateDraft({ ...base, modelContexts: { 'model-a': 31999 } }), /Context window/);
  assert.match(validateDraft({ ...base, modelContexts: { 'model-a': 2000001 } }), /Context window/);
  assert.match(validateDraft({ ...base, modelContexts: { 'model-a': 'nope' } }), /Context window/);
  assert.equal(validateDraft({ ...base, modelContexts: { 'model-a': 32000 } }), '');
  assert.equal(validateDraft({ ...base, modelContexts: { 'model-a': 200000 } }), '');
  assert.equal(validateDraft({ ...base, modelContexts: { 'model-a': 2000000 } }), '');
});

test('probed model ids append after existing ids without duplicates', () => {
  assert.deepEqual(mergeProbedModelIds('old, shared', ['shared', 'new']), {
    modelId: 'old, shared, new', added: 1,
  });
});
