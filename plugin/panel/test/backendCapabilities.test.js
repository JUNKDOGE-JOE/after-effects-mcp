import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROVAL_MODES,
  CLAUDE_MODELS,
  CLAUDE_PRICE_USD_PER_MTOK,
  claudeSubDescriptor,
  codexDescriptorFromModels,
  codexStaticDescriptor,
  costTier,
  mergeCodexOfficialLoginModels,
  openCodeDescriptorFromModels,
  resolveEffectiveEffort,
} from '../src/lib/backendCapabilities.js';

test('Claude subscription descriptor exposes the curated models and approval modes', () => {
  const descriptor = claudeSubDescriptor();
  assert.equal(descriptor.id, 'claude-sub');
  assert.equal(descriptor.defaultModelId, 'claude-opus-5');
  assert.equal(descriptor.models.length, CLAUDE_MODELS.length);
  assert.equal(descriptor.approvalModes, APPROVAL_MODES);
  assert.equal(descriptor.supportsFast('claude-opus-5'), false);
});

test('Claude ids are current API aliases and the default is selectable', () => {
  const ids = CLAUDE_MODELS.map((model) => model.id);
  assert.deepEqual(ids, ['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']);
  for (const id of ids) {
    assert.doesNotMatch(id, /-\d{8}$/, id + ' must be an alias, not a dated snapshot');
    assert.ok(CLAUDE_PRICE_USD_PER_MTOK[id], id + ' needs a price entry for its cost tier');
  }
  assert.ok(ids.includes(claudeSubDescriptor().defaultModelId));
});

test('cost tiers derive from the Claude price map', () => {
  assert.equal(costTier('claude-haiku-4-5'), 1);
  assert.equal(costTier('claude-sonnet-5'), 2);
  assert.equal(costTier('claude-opus-5'), 3);
  assert.equal(costTier('claude-fable-5-1'), 4);
  assert.equal(costTier('unknown'), 2);
});

test('Codex static fallback mirrors the official login inventory', () => {
  const descriptor = codexStaticDescriptor();
  assert.equal(descriptor.defaultModelId, 'gpt-5.6-sol');
  assert.ok(descriptor.models.some((model) => model.id === descriptor.defaultModelId));
  assert.deepEqual(
    descriptor.models.map((model) => model.id),
    ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark'],
  );
  assert.equal(descriptor.supportsFast('gpt-5.6-sol'), true);
  assert.equal(descriptor.supportsFast('gpt-5.5'), true);
  assert.equal(descriptor.supportsFast('gpt-5.4-mini'), false);
  assert.equal(descriptor.supportsFast('gpt-5.3-codex-spark'), false);
  // Merging the official models into the static list must not duplicate them.
  const merged = mergeCodexOfficialLoginModels(descriptor);
  assert.equal(merged.models.length, descriptor.models.length);
});

test('Codex model-list data preserves capability metadata', () => {
  const descriptor = codexDescriptorFromModels({
    models: [{
      id: 'gpt-5.6-terra',
      displayName: 'Terra',
      isDefault: true,
      defaultReasoningEffort: 'high',
      additionalSpeedTiers: ['fast'],
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
    }],
  });
  assert.equal(descriptor.defaultModelId, 'gpt-5.6-terra');
  assert.equal(descriptor.defaultEffort, 'high');
  assert.equal(descriptor.supportsFast('gpt-5.6-terra'), true);
  assert.deepEqual(descriptor.models[0].effortLevels, ['low', 'high']);
});

test('Codex model-list accepts the app-server data envelope', () => {
  const descriptor = codexDescriptorFromModels({
    data: [{
      id: 'gpt-5.6-luna',
      displayName: 'Luna',
      isDefault: true,
      defaultReasoningEffort: 'medium',
      additionalSpeedTiers: ['fast'],
      supportedReasoningEfforts: [
        { reasoningEffort: 'low' },
        { reasoningEffort: 'medium' },
        { reasoningEffort: 'high' },
      ],
    }],
  });
  assert.equal(descriptor.defaultModelId, 'gpt-5.6-luna');
  assert.deepEqual(descriptor.models.map((model) => model.id), ['gpt-5.6-luna']);
  assert.equal(descriptor.supportsFast('gpt-5.6-luna'), true);
});

test('Codex login descriptor fills the official 5.6 models', () => {
  const merged = mergeCodexOfficialLoginModels(codexStaticDescriptor());
  assert.ok(merged.models.some((model) => model.id === 'gpt-5.6-terra'));
  assert.equal(merged.supportsFast('gpt-5.6-terra'), true);
});

test('OpenCode descriptor qualifies third-party models with their provider id', () => {
  const descriptor = openCodeDescriptorFromModels({
    'aemcp-example': {
      id: 'aemcp-example',
      models: { 'model-a': { name: 'Model A' } },
    },
  });
  assert.equal(descriptor.models[0].id, 'aemcp-example/model-a');
  assert.equal(descriptor.models[0].label, 'Model A');
});

test('effective effort stays compatible with the selected model', () => {
  const model = { effortLevels: ['low', 'medium', 'high'] };
  assert.equal(
    resolveEffectiveEffort({ requested: 'high', model, defaultEffort: 'medium' }),
    'high',
  );
  assert.equal(
    resolveEffectiveEffort({ requested: 'ultra', model, defaultEffort: 'medium' }),
    'high',
  );
  assert.equal(
    resolveEffectiveEffort({ requested: null, model, defaultEffort: 'medium' }),
    'medium',
  );
  assert.equal(resolveEffectiveEffort({ requested: 'high', model: { effortLevels: [] } }), null);
});
