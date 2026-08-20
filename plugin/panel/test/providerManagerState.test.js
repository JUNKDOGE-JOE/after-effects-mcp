import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  draftFromEntry,
  draftToEntry,
  emptyDraft,
  validateDraft,
} from '../src/lib/providerManagerState.js';

test('Provider Manager draft is the OpenCode configuration shape', () => {
  assert.deepEqual(emptyDraft(), {
    id: '',
    name: '',
    baseUrl: '',
    allowInsecureHttp: false,
    modelId: '',
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
    protocol: 'anthropic',
  });
});

test('draft validation requires a name and HTTP(S) base URL', () => {
  assert.match(validateDraft(emptyDraft()), /name is required/i);
  assert.match(validateDraft({ ...emptyDraft(), name: 'Example', baseUrl: 'not-a-url' }), /http/i);
  assert.equal(
    validateDraft({ ...emptyDraft(), name: 'Example', baseUrl: 'https://example.test' }),
    '',
  );
});

test('draftToEntry derives a stable provider id', () => {
  assert.equal(draftToEntry({ ...emptyDraft(), name: 'Example Provider' }).id, 'example-provider');
});

test('draft protocol round-trips and defaults to anthropic', () => {
  assert.equal(draftFromEntry({ protocol: 'openai' }).protocol, 'openai');
  assert.equal(draftFromEntry({ protocol: 'weird' }).protocol, 'anthropic');
  assert.equal(draftToEntry({ name: 'x', protocol: 'openai' }).protocol, 'openai');
});
