import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildComposerChips, costBadge } from '../src/lib/composerOptions.js';
import { byokStaticDescriptor, claudeSubDescriptor, mergeByokModels } from '../src/lib/backendCapabilities.js';

test('costBadge renders $ per tier', () => {
  assert.equal(costBadge(1), '$');
  assert.equal(costBadge(4), '$$$$');
});

test('chips hide effort for models without levels and fast when unsupported', () => {
  // 未知动态模型不冒认档位（haiku 自 2026-06-12 真机探针后已有三档）
  const descriptor = mergeByokModels(byokStaticDescriptor(), [
    { id: 'claude-next-9', display_name: 'Claude Next 9' },
  ]);
  const chips = buildComposerChips({
    descriptor,
    modelId: 'claude-next-9',
    effort: null, fast: false, permissionMode: 'manual', lang: 'zh',
  });
  assert.equal(chips.effort, null);
  assert.equal(chips.fast, null);
  assert.equal(chips.model.current, 'Claude Next 9');
  assert.equal(chips.approval.items.length, 4);
});

test('haiku shows the probed three-step effort ladder on subscription', () => {
  const chips = buildComposerChips({
    descriptor: claudeSubDescriptor(),
    modelId: 'claude-haiku-4-5-20251001',
    effort: 'high', fast: false, permissionMode: 'manual', lang: 'zh',
  });
  assert.deepEqual(chips.effort.items.map((i) => i.id), ['low', 'medium', 'high']);
  assert.equal(chips.fast, null);
});

test('byok opus shows fast toggle and full effort ladder', () => {
  const chips = buildComposerChips({
    descriptor: byokStaticDescriptor(),
    modelId: 'claude-opus-4-8',
    effort: 'high', fast: true, permissionMode: 'auto', lang: 'zh',
  });
  assert.deepEqual(chips.effort.items.map((i) => i.id), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(chips.fast.active, true);
});
