import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAUDE_MODELS, APPROVAL_MODES, costTier,
  claudeSubDescriptor, byokStaticDescriptor, mergeByokModels,
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
