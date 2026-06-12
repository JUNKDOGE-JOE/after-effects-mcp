import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAUDE_MODELS, APPROVAL_MODES, costTier,
  claudeSubDescriptor, byokStaticDescriptor, mergeByokModels,
  codexStaticDescriptor, codexDescriptorFromModels,
} from '../src/lib/backendCapabilities.js';

test('claude-sub descriptor lists the full family with effort levels', () => {
  const d = claudeSubDescriptor();
  assert.equal(d.id, 'claude-sub');
  const ids = d.models.map((m) => m.id);
  assert.deepEqual(ids, [
    'claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001',
  ]);
  const sonnet = d.models.find((m) => m.id === 'claude-sonnet-4-6');
  assert.deepEqual(sonnet.effortLevels, ['low', 'medium', 'high', 'max']);
  const fable = d.models.find((m) => m.id === 'claude-fable-5');
  assert.deepEqual(fable.effortLevels, ['low', 'medium', 'high', 'xhigh', 'max']);
  const haiku = d.models.find((m) => m.id === 'claude-haiku-4-5-20251001');
  // effort 真机已证可用（2026-06-12 探针），adaptive thinking 未验证 → 解耦
  assert.deepEqual(haiku.effortLevels, ['low', 'medium', 'high']);
  assert.equal(haiku.adaptive, false);
  assert.equal(fable.adaptive, true);
  assert.equal(d.defaultModelId, 'claude-sonnet-4-6');
  assert.equal(d.defaultEffort, 'high');
  assert.equal(d.supportsFast('claude-opus-4-8'), false);
});

test('byok descriptor enables fast only for opus models', () => {
  const d = byokStaticDescriptor();
  assert.equal(d.supportsFast('claude-opus-4-8'), true);
  assert.equal(d.supportsFast('claude-sonnet-4-6'), false);
});

test('cost tiers derive from the price map', () => {
  assert.equal(costTier('claude-haiku-4-5-20251001'), 1);
  assert.equal(costTier('claude-fable-5'), 4);
});

test('approval modes are the four annotated tiers', () => {
  assert.deepEqual(APPROVAL_MODES.map((m) => m.id), ['readonly', 'manual', 'auto', 'none']);
});

test('mergeByokModels keeps curated metadata and admits unknown claude models', () => {
  const merged = mergeByokModels(byokStaticDescriptor(), [
    { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
    { id: 'claude-next-9', display_name: 'Claude Next 9' },
  ]);
  const ids = merged.models.map((m) => m.id);
  assert.ok(ids.includes('claude-sonnet-4-6'));
  assert.ok(ids.includes('claude-next-9'));
  assert.ok(!ids.includes('claude-fable-5'));
  const next = merged.models.find((m) => m.id === 'claude-next-9');
  assert.deepEqual(next.effortLevels, []);
  assert.equal(next.cost, 2);
});

test('mergeByokModels with null list returns the static descriptor unchanged', () => {
  const d = byokStaticDescriptor();
  assert.equal(mergeByokModels(d, null), d);
});

test('codexDescriptorFromModels maps live model/list metadata', () => {
  const descriptor = codexDescriptorFromModels({
    models: [
      {
        id: 'gpt-5.5',
        displayName: 'GPT-5.5',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low' },
          { reasoningEffort: 'medium' },
          { reasoningEffort: 'high' },
          { reasoningEffort: 'xhigh' },
        ],
        defaultReasoningEffort: 'medium',
        additionalSpeedTiers: ['fast'],
        serviceTiers: [{ id: 'priority', name: 'Fast' }],
        isDefault: true,
        hidden: false,
      },
      {
        id: 'hidden-model',
        displayName: 'Hidden',
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
        hidden: true,
      },
      {
        id: 'gpt-5.4',
        displayName: 'GPT-5.4',
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
        defaultReasoningEffort: 'low',
        hidden: false,
      },
    ],
  });

  assert.equal(descriptor.id, 'codex');
  assert.equal(descriptor.label, 'Codex');
  assert.deepEqual(descriptor.models, [
    { id: 'gpt-5.5', label: 'GPT-5.5', effortLevels: ['low', 'medium', 'high', 'xhigh'], cost: 2, adaptive: false },
    { id: 'gpt-5.4', label: 'GPT-5.4', effortLevels: ['low'], cost: 2, adaptive: false },
  ]);
  assert.equal(descriptor.defaultModelId, 'gpt-5.5');
  assert.equal(descriptor.defaultEffort, 'medium');
  assert.equal(descriptor.supportsFast('gpt-5.5'), true);
  assert.equal(descriptor.supportsFast('gpt-5.4'), false);
  assert.equal(descriptor.approvalModes, APPROVAL_MODES);
  assert.equal(descriptor.perTurnModelSwitch, true);
});

test('codexDescriptorFromModels falls back to static descriptor for empty input', () => {
  const fallback = codexDescriptorFromModels(null);
  const staticDescriptor = codexStaticDescriptor();
  assert.equal(fallback.id, staticDescriptor.id);
  assert.equal(fallback.label, staticDescriptor.label);
  assert.deepEqual(fallback.models.map((m) => m.id), ['gpt-5.5', 'gpt-5.4']);
  assert.equal(fallback.defaultEffort, 'medium');
  assert.equal(fallback.supportsFast('gpt-5.5'), true);
});
