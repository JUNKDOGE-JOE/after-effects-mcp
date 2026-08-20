import { pickBackend, deriveToolMeta, shouldResetOnBackendChange } from '../src/lib/backendSelect.js';
import { claudeChannels, codexChannels, zcodeChannels } from '../src/lib/channels.js';
import { BACKENDS } from '../src/cep/backends/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

function ch(channel, ok, fixHint = { zh: 'zh-fix', en: 'en-fix' }, checking = false) {
  return { channel, ok, checking, detail: '', source: { zh: 's', en: 's' }, fixHint };
}

test('pickBackend: the claude choice defaults to subscription and never auto-switches (#229)', () => {
  const channels = { claude: [ch('subscription', true), ch('api', false)] };
  const result = pickBackend({ pref: 'subscription', channels });
  assert.deepEqual(result, { backend: 'subscription', reason: 'ok', channel: 'subscription', fixHint: null });

  // A usable api sibling never overrides a broken enabled subscription channel.
  const brokenChoice = pickBackend({
    pref: 'subscription',
    channels: { claude: [ch('subscription', false, { zh: '去登录', en: 'log in' }), ch('api', true)] },
  });
  assert.equal(brokenChoice.backend, 'none');
  assert.equal(brokenChoice.channel, 'subscription');
  assert.equal(brokenChoice.fixHint.zh, '去登录');
});

test('pickBackend routes the enabled custom Claude API channel through the Claude CLI transport', () => {
  const channels = { claude: [ch('subscription', false), ch('api', true)] };
  const selected = pickBackend({ pref: 'subscription', channels, channelChoices: { claude: 'api' } });
  assert.deepEqual(selected, {
    backend: 'claude-api',
    reason: 'ok',
    channel: 'api',
    fixHint: null,
  });
  assert.equal(BACKENDS[selected.backend].attachmentTransport, 'manifest+read-rule');
});

test('pickBackend keeps non-official Anthropic-compatible providers on the Claude CLI local route', () => {
  const direct = { ...ch('api', true), directHttp: true };
  const selected = pickBackend({
    pref: 'subscription',
    channels: { claude: [ch('subscription', false), direct] },
    channelChoices: { claude: 'api' },
  });
  assert.equal(selected.backend, 'claude-api');
  assert.equal(BACKENDS[selected.backend].attachmentTransport, 'manifest+read-rule');
});

test('pickBackend: probing and no-channel states carry reason + fixHint', () => {
  const probing = pickBackend({ pref: 'codex', channels: { codex: [ch('cli', false, undefined, true)] } });
  assert.deepEqual(probing, { backend: 'none', reason: 'codex-probing', channel: null, fixHint: null });
  const dead = pickBackend({ pref: 'zcode', channels: { zcode: [ch('cli-config', false), ch('desktop', false)] } });
  assert.equal(dead.backend, 'none');
  assert.equal(dead.reason, 'zcode-no-channel');
  assert.equal(dead.fixHint.zh, 'zh-fix');
});

test('pickBackend: the enabled channel is followed exactly; a broken choice surfaces its own fixHint', () => {
  const channels = { codex: [ch('cli', true), ch('custom', true)] };
  assert.equal(pickBackend({ pref: 'codex', channels, channelChoices: { codex: 'custom' } }).channel, 'custom');
  const brokenChoice = pickBackend({
    pref: 'codex',
    channels: { codex: [ch('cli', true), ch('custom', false, { zh: '配 provider', en: 'add provider' })] },
    channelChoices: { codex: 'custom' },
  });
  assert.equal(brokenChoice.backend, 'none');
  assert.equal(brokenChoice.fixHint.zh, '配 provider');
});

test('pickBackend: only the enabled channel gates on probing; checking siblings are ignored (#229)', () => {
  const channels = { codex: [ch('cli', false, undefined, true), ch('cli-config', true), ch('custom', true)] };
  const result = pickBackend({ pref: 'codex', channels, channelChoices: { codex: 'custom' } });
  assert.deepEqual(result, { backend: 'codex', reason: 'ok', channel: 'custom', fixHint: null });
});

test('pickBackend keeps the enabled custom provider on Codex while its exact model needs preflight', () => {
  const custom = { ...ch('custom', false), selected: true, canPreflight: true };
  const result = pickBackend({
    pref: 'codex',
    channels: { codex: [ch('cli', false, undefined, true), ch('cli-config', true), custom] },
    channelChoices: { codex: 'custom' },
  });
  assert.deepEqual(result, {
    backend: 'codex',
    reason: 'provider-preflight',
    channel: 'custom',
    fixHint: null,
  });
});

test('pickBackend never falls through an enabled but unusable custom provider to CLI', () => {
  const custom = { ...ch('custom', false, { zh: '修复 provider', en: 'repair provider' }), selected: true, canPreflight: false };
  const result = pickBackend({
    pref: 'codex',
    channels: { codex: [ch('cli', true), ch('cli-config', true), custom] },
    channelChoices: { codex: 'custom' },
  });
  assert.equal(result.backend, 'none');
  assert.equal(result.channel, 'custom');
  assert.equal(result.fixHint.en, 'repair provider');
});

test('pickBackend and codexChannels route the enabled custom channel even with a logged-in CLI', () => {
  const list = codexChannels({
    codexProbe: { loggedIn: true, runtimeOk: true },
    customProvider: { id: 'custom-1', baseUrl: 'https://custom.example/v1' },
    customProviderSelected: true,
    customProviderAvailable: true,
    customProviderCredentialResolverReady: true,
  });
  const result = pickBackend({ pref: 'codex', channels: { codex: list }, channelChoices: { codex: 'custom' } });
  assert.equal(result.backend, 'codex');
  assert.equal(result.channel, 'custom');
  assert.equal(result.reason, 'ok');

  // A configured provider no longer hijacks routing: with the CLI channel
  // enabled, the CLI is what runs.
  const cliResult = pickBackend({ pref: 'codex', channels: { codex: list }, channelChoices: { codex: 'cli' } });
  assert.equal(cliResult.backend, 'codex');
  assert.equal(cliResult.channel, 'cli');
});

test('pickBackend and codexChannels fail closed for a stale enabled provider id', () => {
  const list = codexChannels({
    codexProbe: { loggedIn: true, runtimeOk: true },
    customProvider: null,
    customProviderSelected: true,
    customProviderAvailable: false,
    customProviderCredentialResolverReady: true,
  });
  const result = pickBackend({ pref: 'codex', channels: { codex: list }, channelChoices: { codex: 'custom' } });
  assert.equal(result.backend, 'none');
  assert.equal(result.channel, 'custom');
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

test('deriveToolMeta maps AE tools for Claude CLI approval metadata', () => {
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
