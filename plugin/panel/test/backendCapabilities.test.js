import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAUDE_MODELS, APPROVAL_MODES, costTier,
  claudeSubDescriptor, byokStaticDescriptor, mergeByokModels,
  codexStaticDescriptor, codexDescriptorFromModels,
  descriptorWithCustomModel,
  zcodeStaticDescriptor, zcodeDescriptorFromModels, zcodeDescriptorFromProbedModels,
} from '../src/lib/backendCapabilities.js';

test('claude-sub descriptor lists the full family with effort levels', () => {
  const d = claudeSubDescriptor();
  assert.equal(d.id, 'claude-sub');
  const ids = d.models.map((m) => m.id);
  assert.deepEqual(ids, [
    'claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001',
  ]);
  const sonnet5 = d.models.find((m) => m.id === 'claude-sonnet-5');
  assert.deepEqual(sonnet5.effortLevels, ['low', 'medium', 'high', 'xhigh']);
  assert.equal(sonnet5.effortLevels.includes('max'), false);
  const sonnet = d.models.find((m) => m.id === 'claude-sonnet-4-6');
  assert.deepEqual(sonnet.effortLevels, ['low', 'medium', 'high', 'max']);
  const fable = d.models.find((m) => m.id === 'claude-fable-5');
  assert.deepEqual(fable.effortLevels, ['low', 'medium', 'high', 'xhigh', 'max']);
  const haiku = d.models.find((m) => m.id === 'claude-haiku-4-5-20251001');
  // effort 真机已证可用（2026-06-12 探针），adaptive thinking 未验证 → 解耦
  assert.deepEqual(haiku.effortLevels, ['low', 'medium', 'high']);
  assert.equal(haiku.adaptive, false);
  assert.equal(fable.adaptive, true);
  assert.equal(d.defaultModelId, 'claude-sonnet-5');
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
  assert.equal(costTier('claude-sonnet-5'), 2);
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
  assert.deepEqual(fallback.models.map((m) => m.id), ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']);
  assert.deepEqual(fallback.models.find((m) => m.id === 'gpt-5.4-mini'), {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 mini',
    effortLevels: ['low', 'medium', 'high', 'xhigh'],
    cost: 1,
    adaptive: false,
  });
  assert.equal(fallback.defaultEffort, 'medium');
  assert.equal(fallback.supportsFast('gpt-5.5'), true);
});

test('descriptorWithCustomModel promotes a user-supplied model id without losing the base list', () => {
  const descriptor = descriptorWithCustomModel(codexStaticDescriptor(), 'provider/custom-model');

  assert.equal(descriptor.defaultModelId, 'provider/custom-model');
  assert.equal(descriptor.models[0].id, 'provider/custom-model');
  assert.deepEqual(descriptor.models.slice(1).map((m) => m.id), ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']);
});

test('zcodeStaticDescriptor keeps model metadata but does not advertise per-turn model switching', () => {
  const descriptor = zcodeStaticDescriptor();
  assert.equal(descriptor.id, 'zcode');
  assert.equal(descriptor.defaultModelId, 'builtin:bigmodel-start-plan/GLM-5.2');
  assert.deepEqual(descriptor.models.map((m) => m.id), [
    'builtin:bigmodel-start-plan/GLM-5.2',
    'builtin:bigmodel-start-plan/GLM-5-Turbo',
  ]);
  assert.ok(descriptor.models.length > 0);
  assert.equal(descriptor.perTurnModelSwitch, false);
});

test('zcodeDescriptorFromModels keeps live model metadata but does not advertise per-turn model switching', () => {
  const descriptor = zcodeDescriptorFromModels({
    settings: {
      model: {
        available: [
          { label: 'GLM-5.2', ref: { modelId: 'glm-5.2', providerId: 'mediastorm_glm' } },
          { label: 'Deepseek V4', ref: { modelId: 'deepseek-v4-pro', providerId: 'mediastorm_glm' } },
        ],
        current: { modelId: 'glm-5.2', providerId: 'mediastorm_glm' },
      },
    },
  });
  assert.equal(descriptor.defaultModelId, 'mediastorm_glm/glm-5.2');
  assert.deepEqual(descriptor.models.map((m) => m.id), [
    'mediastorm_glm/glm-5.2',
    'mediastorm_glm/deepseek-v4-pro',
  ]);
  assert.equal(descriptor.perTurnModelSwitch, false);
});

test('zcodeDescriptorFromProbedModels maps probed models to providerId/modelId and pins the CLI model as default', () => {
  const descriptor = zcodeDescriptorFromProbedModels({
    cliModel: 'mediastorm_glm/deepseek-v4-flash',
    providerId: 'mediastorm_glm',
    probedModels: [
      { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
      { id: 'glm-5.2', label: 'GLM-5.2' },
    ],
  });
  assert.equal(descriptor.id, 'zcode');
  assert.equal(descriptor.defaultModelId, 'mediastorm_glm/deepseek-v4-flash');
  assert.deepEqual(descriptor.models.map((m) => m.id), [
    'mediastorm_glm/deepseek-v4-flash',
    'mediastorm_glm/glm-5.2',
  ]);
  assert.equal(descriptor.perTurnModelSwitch, false);
});

test('zcodeDescriptorFromProbedModels dedupes when CLI model is already in the probed list, keeping it first', () => {
  const descriptor = zcodeDescriptorFromProbedModels({
    cliModel: 'mediastorm_glm/glm-5.2',
    providerId: 'mediastorm_glm',
    probedModels: [
      { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
      { id: 'glm-5.2', label: 'GLM-5.2' },
    ],
  });
  assert.deepEqual(descriptor.models.map((m) => m.id), [
    'mediastorm_glm/glm-5.2',
    'mediastorm_glm/deepseek-v4-flash',
  ]);
  assert.equal(descriptor.defaultModelId, 'mediastorm_glm/glm-5.2');
});

test('zcodeDescriptorFromProbedModels falls back to null when probe is empty or missing cliModel', () => {
  assert.equal(zcodeDescriptorFromProbedModels({ cliModel: '', providerId: 'p', probedModels: [{ id: 'a' }] }), null);
  assert.equal(zcodeDescriptorFromProbedModels({ cliModel: 'p/a', providerId: 'p', probedModels: [] }), null);
  assert.equal(zcodeDescriptorFromProbedModels({ cliModel: 'p/a', providerId: 'p', probedModels: null }), null);
});

test('descriptorFromProbedModels replaces curated models for custom-provider channels', async () => {
  const { byokStaticDescriptor, descriptorFromProbedModels } = await import('../src/lib/backendCapabilities.js');
  const base = byokStaticDescriptor();
  const probed = descriptorFromProbedModels(base, [{ id: 'glm-5.2', label: 'GLM 5.2' }, { id: 'claude-sonnet-5', label: 'x' }]);
  assert.equal(probed.models.length, 2);
  assert.equal(probed.models[0].id, 'glm-5.2');
  assert.equal(probed.models[0].label, 'GLM 5.2');
  assert.equal(probed.models[1].label, 'Sonnet 5', 'curated metadata reused when ids match');
  assert.equal(probed.defaultModelId, 'glm-5.2');
  assert.equal(descriptorFromProbedModels(base, []), base, 'empty probe keeps descriptor (manual model id fallback)');
  assert.equal(descriptorFromProbedModels(base, null), base);
});
