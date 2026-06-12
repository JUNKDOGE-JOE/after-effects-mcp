import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildComposerChips, costBadge } from '../src/lib/composerOptions.js';
import { byokStaticDescriptor, claudeSubDescriptor } from '../src/lib/backendCapabilities.js';

test('costBadge renders $ per tier', () => {
  assert.equal(costBadge(1), '$');
  assert.equal(costBadge(4), '$$$$');
});

test('chips hide effort for models without levels and fast when unsupported', () => {
  const chips = buildComposerChips({
    descriptor: claudeSubDescriptor(),
    modelId: 'claude-haiku-4-5-20251001',
    effort: 'high', fast: false, permissionMode: 'manual', lang: 'zh',
  });
  assert.equal(chips.effort, null);
  assert.equal(chips.fast, null);
  assert.equal(chips.model.current, 'Haiku 4.5');
  assert.equal(chips.approval.items.length, 4);
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
