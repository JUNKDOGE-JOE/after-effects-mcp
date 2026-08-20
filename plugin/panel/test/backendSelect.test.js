import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveToolMeta, pickBackend, shouldResetOnBackendChange } from '../src/lib/backendSelect.js';

function channel(id, ok = true, checking = false) {
  return { channel: id, ok, checking, detail: '', source: {}, fixHint: { zh: 'fix', en: 'fix' } };
}

test('pickBackend routes a configured provider through OpenCode', () => {
  assert.deepEqual(pickBackend({
    pref: 'opencode',
    channels: { opencode: [channel('provider')] },
    channelChoices: { opencode: 'provider' },
  }), {
    backend: 'opencode', reason: 'ok', channel: 'provider', fixHint: null,
  });
});

test('pickBackend keeps unavailable channels disabled', () => {
  const selected = pickBackend({
    pref: 'codex',
    channels: { codex: [channel('cli', false)] },
    channelChoices: { codex: 'cli' },
  });
  assert.equal(selected.backend, 'none');
  assert.equal(selected.reason, 'codex-no-channel');
});

test('deriveToolMeta maps AE annotations', () => {
  assert.deepEqual(deriveToolMeta([
    { name: 'status', annotations: { readOnlyHint: true } },
    { name: 'exec', annotations: { destructiveHint: true } },
  ]), {
    allowedTools: ['mcp__ae__status'],
    annotations: {
      mcp__ae__status: { readOnly: true, destructive: false },
      mcp__ae__exec: { readOnly: false, destructive: true },
    },
  });
});

test('shouldResetOnBackendChange only resets between supported backends', () => {
  assert.deepEqual(shouldResetOnBackendChange('codex', 'opencode'), {
    reset: true,
    nextReal: 'opencode',
  });
  assert.deepEqual(shouldResetOnBackendChange('codex', 'none'), {
    reset: false,
    nextReal: 'codex',
  });
});
