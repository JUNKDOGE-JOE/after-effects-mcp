import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveToolMeta, pickBackend, shouldResetOnBackendChange } from '../src/lib/backendSelect.js';

function channel(id, ok, checking = false) {
  return { channel: id, ok, checking, detail: '', source: {}, fixHint: { zh: 'fix', en: 'fix' } };
}

test('pickBackend routes a configured provider through OpenCode', () => {
  const selected = pickBackend({
    pref: 'opencode',
    channels: { opencode: [channel('provider', true)] },
    channelChoices: { opencode: 'provider' },
  });
  assert.deepEqual(selected, {
    backend: 'opencode', reason: 'ok', channel: 'provider', fixHint: null,
  });
});

test('pickBackend keeps unavailable OpenCode providers fail-closed with their re-entry hint', () => {
  const selected = pickBackend({
    pref: 'opencode',
    channels: { opencode: [channel('provider', false)] },
    channelChoices: { opencode: 'provider' },
  });
  assert.equal(selected.backend, 'none');
  assert.equal(selected.channel, 'provider');
  assert.equal(selected.fixHint.zh, 'fix');
});

test('pickBackend does not expose removed Claude/Codex custom channels', () => {
  const claude = pickBackend({
    pref: 'subscription',
    channels: { claude: [channel('subscription', true)] },
    channelChoices: { claude: 'api' },
  });
  assert.equal(claude.backend, 'subscription');
  assert.equal(claude.channel, 'subscription');

  const codex = pickBackend({
    pref: 'codex',
    channels: { codex: [channel('cli', true), channel('cli-config', false)] },
    channelChoices: { codex: 'custom' },
  });
  assert.equal(codex.backend, 'codex');
  assert.equal(codex.channel, 'cli');
});

test('deriveToolMeta maps AE tool annotations', () => {
  assert.deepEqual(deriveToolMeta([{ name: 'overview', annotations: { readOnlyHint: true } }]), {
    allowedTools: ['mcp__ae__overview'],
    annotations: { mcp__ae__overview: { readOnly: true, destructive: false } },
  });
});

test('shouldResetOnBackendChange resets only between real backends', () => {
  assert.deepEqual(shouldResetOnBackendChange('codex', 'opencode'), {
    reset: true, nextReal: 'opencode',
  });
  assert.deepEqual(shouldResetOnBackendChange('opencode', 'none'), {
    reset: false, nextReal: 'opencode',
  });
});
