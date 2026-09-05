import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectDescriptor, reconcileModelPref } from '../src/lib/descriptorSelect.js';
import {
  LEGACY_MODEL_PREF_KEY,
  modelPreferenceKey,
  resolveModelPreference,
} from '../src/lib/modelPreference.js';
import {
  claudeSubDescriptor,
  codexStaticDescriptor,
  openCodeStaticDescriptor,
} from '../src/lib/backendCapabilities.js';

test('Codex uses its CLI model inventory when it is available', () => {
  const descriptor = selectDescriptor({
    effectiveBackend: 'codex',
    backendPref: 'codex',
    baseDescriptor: codexStaticDescriptor(),
    codexCachedModels: [{ id: 'gpt-live', isDefault: true }],
  });
  assert.equal(descriptor.defaultModelId, 'gpt-live');
  assert.deepEqual(descriptor.models.map((m) => m.id), ['gpt-live']);
});

test('saved Codex choice survives missing facts and falls back only on a complete catalog', () => {
  const input = { backendPref: 'codex', preferredModel: 'gpt-6-astra', baseDescriptor: codexStaticDescriptor() };
  const unverified = selectDescriptor(input);
  assert.equal(reconcileModelPref(input.preferredModel, unverified), 'gpt-6-astra');
  assert.equal(unverified.supportsFast(input.preferredModel), false);
  const complete = selectDescriptor({ ...input, codexCachedModels: [{ id: 'gpt-5.6-sol' }] });
  assert.equal(reconcileModelPref(input.preferredModel, complete), 'gpt-5.6-sol');
  const upgraded = selectDescriptor({ ...input, codexCachedModels: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-6-astra' }] });
  assert.equal(reconcileModelPref('', upgraded), 'gpt-6-astra');
  assert.equal(reconcileModelPref('gpt-5.6-sol', upgraded), 'gpt-5.6-sol');
});

test('an empty Codex preference uses the offline Codex default then visible Astra', () => {
  const pref = resolveModelPreference({ channelValue: null, legacyValue: null, fallback: '' });
  const input = { backendPref: 'codex', preferredModel: pref.value, baseDescriptor: codexStaticDescriptor() };
  const offline = selectDescriptor(input);
  assert.equal(reconcileModelPref(pref.value, offline), 'gpt-5.6-sol');
  assert.equal(offline.models.some((m) => m.id.startsWith('claude-')), false);
  const live = selectDescriptor({ ...input, codexCachedModels: [{ id: 'gpt-6-astra' }] });
  assert.equal(reconcileModelPref(pref.value, live), 'gpt-6-astra');
});

test('OpenCode derives models from the Provider Manager registry', () => {
  const descriptor = selectDescriptor({
    effectiveBackend: 'opencode',
    backendPref: 'opencode',
    baseDescriptor: openCodeStaticDescriptor(),
    openCodeProviders: [{
      id: 'aemcp-example',
      name: 'Example',
      modelIds: ['model-a'],
      needsApiKey: false,
    }],
  });
  assert.deepEqual(descriptor.models.map((model) => model.id), ['aemcp-example/model-a']);
});

test('subscription keeps its base descriptor', () => {
  const base = claudeSubDescriptor();
  assert.equal(selectDescriptor({ baseDescriptor: base }), base);
});

test('reconcileModelPref resets stale models but waits for pending facts', () => {
  const descriptor = { models: [{ id: 'a' }, { id: 'b' }], defaultModelId: 'a' };
  assert.equal(reconcileModelPref('b', descriptor), 'b');
  assert.equal(reconcileModelPref('missing', descriptor), 'a');
  assert.equal(
    reconcileModelPref('missing', descriptor, { providerFactsPending: true }),
    'missing',
  );
});

test('model preferences use independent channel keys and migrate legacy storage once', () => {
  assert.equal(modelPreferenceKey('subscription'), 'ae_mcp_model_subscription');
  assert.equal(modelPreferenceKey('codex'), 'ae_mcp_model_codex');
  assert.equal(modelPreferenceKey('opencode'), 'ae_mcp_model_opencode');
  assert.equal(LEGACY_MODEL_PREF_KEY, 'ae_mcp_model');
  assert.deepEqual(resolveModelPreference({
    channelValue: '',
    legacyValue: 'claude-fable-5-1',
    fallback: 'claude-opus-5',
  }), {
    value: 'claude-fable-5-1',
    migrateLegacy: true,
  });
  assert.deepEqual(resolveModelPreference({
    channelValue: 'gpt-5.6-sol',
    legacyValue: 'claude-fable-5-1',
    fallback: 'claude-opus-5',
  }), {
    value: 'gpt-5.6-sol',
    migrateLegacy: false,
  });
});

test('reconcileModelPref preserves Codex preferences while live facts are pending', () => {
  assert.equal(reconcileModelPref('gpt-live-only', {
    defaultModelId: 'gpt-5.6-sol',
    models: [{ id: 'gpt-5.6-sol' }],
  }, { providerFactsPending: true }), 'gpt-live-only');
});
