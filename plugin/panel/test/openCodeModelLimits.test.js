import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeOpenCodeContextWindow,
  openCodeOutputLimit,
} from '../src/lib/openCodeModelLimits.js';

test('OpenCode context window accepts only safe integer boundaries', () => {
  assert.equal(normalizeOpenCodeContextWindow(32000), 32000);
  assert.equal(normalizeOpenCodeContextWindow(2000000), 2000000);
  for (const invalid of [0, -1, 31999, 2000001, 64000.5, NaN, Infinity, 'nope']) {
    assert.throws(() => normalizeOpenCodeContextWindow(invalid), RangeError);
  }
});

test('OpenCode output reserve always leaves most of the context for history', () => {
  for (const [context, output] of [
    [32000, 8000],
    [64000, 16000],
    [128000, 32000],
    [200000, 32000],
    [2000000, 32000],
  ]) {
    assert.equal(openCodeOutputLimit(context), output);
    assert.ok(output > 0);
    assert.ok(output < context);
  }
});
