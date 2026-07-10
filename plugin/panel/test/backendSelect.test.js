import { pickBackend, deriveToolMeta, shouldResetOnBackendChange } from '../src/lib/backendSelect.js';
import { claudeChannels, codexChannels, zcodeChannels } from '../src/lib/channels.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

function ch(channel, ok, fixHint = { zh: 'zh-fix', en: 'en-fix' }, checking = false) {
  return { channel, ok, checking, detail: '', source: { zh: 's', en: 's' }, fixHint };
}

test('pickBackend: claude subscription channel wins when ok', () => {
  const result = pickBackend({ pref: 'subscription', channels: { claude: [ch('subscription', true), ch('api', false)] } });
  assert.deepEqual(result, { backend: 'subscription', reason: 'ok', channel: 'subscription', fixHint: null });
});

test('pickBackend: every custom Claude API channel stays on the secret-redacting direct loop', () => {
  const channels = { claude: [ch('subscription', false), ch('api', true)] };
  assert.equal(pickBackend({ pref: 'subscription', channels, nodeOk: true }).backend, 'byok');
  assert.equal(pickBackend({ pref: 'subscription', channels, nodeOk: false }).backend, 'byok');
});

test('pickBackend keeps non-official Anthropic-compatible providers on direct HTTP', () => {
  const direct = { ...ch('api', true), directHttp: true };
  assert.equal(
    pickBackend({ pref: 'subscription', channels: { claude: [ch('subscription', false), direct] }, nodeOk: true }).backend,
    'byok',
  );
});

test('pickBackend: probing and no-channel states carry reason + fixHint', () => {
  const probing = pickBackend({ pref: 'codex', channels: { codex: [ch('cli', false, undefined, true)] } });
  assert.deepEqual(probing, { backend: 'none', reason: 'codex-probing', channel: null, fixHint: null });
  const dead = pickBackend({ pref: 'zcode', channels: { zcode: [ch('cli-config', false), ch('desktop', false)] } });
  assert.equal(dead.backend, 'none');
  assert.equal(dead.reason, 'zcode-no-channel');
  assert.equal(dead.fixHint.zh, 'zh-fix');
});

test('pickBackend: locked channel is respected; a locked-but-broken channel surfaces its own fixHint', () => {
  const channels = { codex: [ch('cli', true), ch('custom', true)] };
  assert.equal(pickBackend({ pref: 'codex', channels, lockedChannel: 'custom' }).channel, 'custom');
  const brokenLock = pickBackend({ pref: 'codex', channels: { codex: [ch('cli', true), ch('custom', false, { zh: '配 provider', en: 'add provider' })] }, lockedChannel: 'custom' });
  assert.equal(brokenLock.backend, 'none');
  assert.equal(brokenLock.fixHint.zh, '配 provider');
});

test('pickBackend integrates with real channel builders end to end', () => {
  const channels = {
    claude: claudeChannels({ probe: { nodeOk: true, loggedIn: true }, apiProvider: null }),
    codex: codexChannels({ codexProbe: null }),
    zcode: zcodeChannels({ zcodeProbe: { runtimeOk: true }, configSummary: { startPlan: { providerId: 'builtin:zai-start-plan', hasCredential: false } } }),
  };
  assert.equal(pickBackend({ pref: 'subscription', channels }).backend, 'subscription');
  assert.equal(pickBackend({ pref: 'codex', channels }).reason, 'codex-probing');
  const zc = pickBackend({ pref: 'zcode', channels });
  assert.equal(zc.backend, 'none', 'keyless start-plan never becomes the default');
});

test('deriveToolMeta maps AE tools for Claude Agent SDK metadata', () => {
  const meta = deriveToolMeta([
    { name: 'overview', annotations: { readOnlyHint: true } },
    { name: 'deleteLayer', annotations: { destructiveHint: true } },
    { name: 'newText' },
  ]);

  assert.deepEqual(meta.allowedTools, ['mcp__ae__overview']);
  assert.deepEqual(meta.annotations, {
    mcp__ae__overview: { readOnly: true, destructive: false },
    mcp__ae__deleteLayer: { readOnly: false, destructive: true },
    mcp__ae__newText: { readOnly: false, destructive: false },
  });
});

test('shouldResetOnBackendChange ignores none and resets only on real backend changes', () => {
  const run = (sequence) => {
    let prevReal = null;
    const resets = [];
    for (const next of sequence) {
      const decision = shouldResetOnBackendChange(prevReal, next);
      if (decision.nextReal) prevReal = decision.nextReal;
      if (decision.reset) resets.push(next);
    }
    return resets;
  };

  assert.deepEqual(run(['subscription', 'none', 'subscription']), []);
  assert.deepEqual(run(['subscription', 'none', 'byok']), ['byok']);
  assert.deepEqual(run(['subscription', 'none', 'codex']), ['codex']);
  assert.deepEqual(run(['codex', 'none', 'codex']), []);
  assert.deepEqual(run(['codex', 'byok']), ['byok']);
  assert.deepEqual(run(['none', 'subscription']), []);
  assert.deepEqual(run(['none', 'byok', 'subscription']), ['subscription']);
});
