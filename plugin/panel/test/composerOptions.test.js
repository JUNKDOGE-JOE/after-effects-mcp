import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildComposerChips, costBadge } from '../src/lib/composerOptions.js';
import {
  claudeSubDescriptor,
  openCodeStaticDescriptor,
} from '../src/lib/backendCapabilities.js';

test('costBadge renders $ per tier', () => {
  assert.equal(costBadge(1), '$');
  assert.equal(costBadge(4), '$$$$');
});

test('OpenCode models omit unsupported effort and fast controls', () => {
  const descriptor = openCodeStaticDescriptor();
  const chips = buildComposerChips({
    descriptor,
    modelId: descriptor.defaultModelId,
    effort: null,
    fast: false,
    permissionMode: 'manual',
    lang: 'zh',
  });
  assert.equal(chips.effort, null);
  assert.equal(chips.fast, null);
  assert.equal(chips.model.current, 'HY 3 Free');
  assert.equal(chips.approval.items.length, 4);
});

test('subscription Haiku exposes its three supported effort levels', () => {
  const chips = buildComposerChips({
    descriptor: claudeSubDescriptor(),
    modelId: 'claude-haiku-4-5-20251001',
    effort: 'high',
    fast: false,
    permissionMode: 'manual',
    lang: 'zh',
  });
  assert.deepEqual(chips.effort.items.map((item) => item.id), ['low', 'medium', 'high']);
  assert.equal(chips.fast, null);
});
