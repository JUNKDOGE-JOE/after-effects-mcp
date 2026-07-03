import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeChannels, codexChannels, zcodeChannels, pickChannel, migrateBackendPref } from '../src/lib/channels.js';

test('claudeChannels: subscription reflects probe, api reflects provider entry', () => {
  const probing = claudeChannels({ probe: null, apiProvider: null });
  assert.equal(probing[0].channel, 'subscription');
  assert.equal(probing[0].checking, true);
  const ready = claudeChannels({ probe: { nodeOk: true, loggedIn: true }, apiProvider: null });
  assert.equal(ready[0].ok, true);
  assert.equal(ready[1].channel, 'api');
  assert.equal(ready[1].ok, false);
  assert.match(ready[1].fixHint.zh, /Provider 管理/);
  const withApi = claudeChannels({ probe: { nodeOk: true, loggedIn: false }, apiProvider: { baseUrl: 'https://r', apiKey: 'k' } });
  assert.equal(withApi[0].ok, false);
  assert.match(withApi[0].fixHint.zh, /API 直连/);
  assert.equal(withApi[1].ok, true);
});

test('codexChannels: cli login state + custom provider channel', () => {
  const list = codexChannels({ codexProbe: { loggedIn: true, runtimeOk: true, cliPath: 'C:\codex.exe', cliVersion: '1.2' }, customProvider: null });
  assert.equal(list[0].channel, 'cli');
  assert.equal(list[0].ok, true);
  assert.match(list[0].detail, /codex\.exe/);
  assert.equal(list[2].channel, 'custom');
  assert.equal(list[2].ok, false);
  const custom = codexChannels({ codexProbe: { loggedIn: false, runtimeOk: true }, customProvider: { baseUrl: 'https://r', apiKey: 'k' } });
  assert.equal(custom.find((c) => c.channel === 'custom').ok, true);
  assert.match(codexChannels({ codexProbe: { loggedIn: false } }).find((c) => c.channel === 'cli').fixHint.zh, /AE_MCP_CODEX_CLI/);
});

test('codexChannels: cli-config channel is positioned between cli and custom', () => {
  const withProviderAndKey = codexChannels({
    codexProbe: { loggedIn: false, runtimeOk: true },
    customProvider: null,
    cliConfig: { model: 'gpt-5.5', providerId: 'mediastorm_glm', provider: { name: 'MediaStorm GLM', baseUrl: 'https://token.mediastorm.studio/v1', envKey: 'MEDIASTORM_GLM_API_KEY', wireApi: 'responses' } },
    cliConfigApiKey: 'from-env-or-store',
  });
  assert.deepEqual(withProviderAndKey.map((c) => c.channel), ['cli', 'cli-config', 'custom']);
  const cliConfigChannel = withProviderAndKey[1];
  assert.equal(cliConfigChannel.ok, true);
  assert.match(cliConfigChannel.source.zh, /继承自 Codex CLI 配置/);
  assert.match(cliConfigChannel.source.en, /Inherited from Codex CLI config/);

  const noKey = codexChannels({
    codexProbe: { loggedIn: false, runtimeOk: true },
    customProvider: null,
    cliConfig: { model: 'gpt-5.5', providerId: 'mediastorm_glm', provider: { name: 'MediaStorm GLM', baseUrl: 'https://token.mediastorm.studio/v1', envKey: 'MEDIASTORM_GLM_API_KEY', wireApi: 'responses' } },
    cliConfigApiKey: '',
  });
  assert.equal(noKey[1].ok, false);
  assert.match(noKey[1].fixHint.zh, /粘贴/);
  assert.match(noKey[1].fixHint.en, /codex-key/);

  const noConfig = codexChannels({ codexProbe: { loggedIn: false, runtimeOk: true }, customProvider: null, cliConfig: null, cliConfigApiKey: '' });
  assert.equal(noConfig[1].ok, false);
  assert.match(noConfig[1].fixHint.zh, /Codex CLI/);

  const runtimeNotOk = codexChannels({
    codexProbe: { loggedIn: false, runtimeOk: false },
    customProvider: null,
    cliConfig: { model: 'gpt-5.5', providerId: 'mediastorm_glm', provider: { name: 'MediaStorm GLM', baseUrl: 'https://token.mediastorm.studio/v1', envKey: 'MEDIASTORM_GLM_API_KEY', wireApi: 'responses' } },
    cliConfigApiKey: 'k',
  });
  assert.equal(runtimeNotOk[1].ok, false);
});

test('codexChannels: custom provider outranks cli-config in pickChannel when both are ok', () => {
  const list = codexChannels({
    codexProbe: { loggedIn: false, runtimeOk: true },
    customProvider: { baseUrl: 'https://custom.example/v1', apiKey: 'ck' },
    cliConfig: { model: 'gpt-5.5', providerId: 'mediastorm_glm', provider: { name: 'MediaStorm GLM', baseUrl: 'https://token.mediastorm.studio/v1', envKey: 'MEDIASTORM_GLM_API_KEY', wireApi: 'responses' } },
    cliConfigApiKey: 'k',
  });
  const custom = list.find((c) => c.channel === 'custom');
  const cliConfig = list.find((c) => c.channel === 'cli-config');
  assert.equal(custom.ok, true);
  assert.equal(cliConfig.ok, true);
  assert.equal(pickChannel(list).channel, 'custom', 'explicit custom provider must outrank inherited cli-config when both are ok');
});

test('zcodeChannels: cli-config first, desktop second, start-plan never ok without credentials', () => {
  const summary = {
    cli: { providerId: 'mediastorm_glm', model: 'mediastorm_glm/glm-5.2', apiKeyEnv: 'MEDIASTORM_GLM_API_KEY', hasCredential: true, keySource: 'env' },
    desktop: { providerId: 'builtin:zai-start-plan' },
    startPlan: { providerId: 'builtin:zai-start-plan', hasCredential: false },
  };
  const list = zcodeChannels({ zcodeProbe: { loggedIn: true, runtimeOk: true }, configSummary: summary });
  assert.deepEqual(list.map((c) => c.channel), ['cli-config', 'desktop', 'start-plan']);
  assert.equal(list[0].ok, true);
  assert.equal(list[2].ok, false, 'keyless start-plan must never be selectable (spec B1)');
  assert.match(list[2].fixHint.zh, /验证码/);
  const noKey = zcodeChannels({
    zcodeProbe: { loggedIn: true, runtimeOk: true },
    configSummary: { ...summary, cli: { ...summary.cli, hasCredential: false, keySource: '' } },
  });
  assert.equal(noKey[0].ok, false);
  assert.match(noKey[0].fixHint.zh, /粘贴/);
  assert.match(noKey[0].fixHint.en, /MEDIASTORM_GLM_API_KEY/);
});

test('pickChannel: first ok wins; explicit lock is honored even when not ok', () => {
  const channels = [
    { channel: 'a', ok: false },
    { channel: 'b', ok: true },
    { channel: 'c', ok: true },
  ];
  assert.equal(pickChannel(channels).channel, 'b');
  assert.equal(pickChannel(channels, 'c').channel, 'c');
  assert.equal(pickChannel(channels, 'a').channel, 'a');
  assert.equal(pickChannel([]), null);
});

test('migrateBackendPref maps legacy byok/opencode prefs onto the 3-way model', () => {
  function storage(init) {
    const map = new Map(Object.entries(init));
    return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), map };
  }
  const byok = storage({ ae_mcp_backend: 'byok' });
  assert.deepEqual(migrateBackendPref(byok), { pref: 'subscription', lockedChannel: 'api' });
  assert.equal(byok.map.get('ae_mcp_backend'), 'subscription');
  assert.equal(byok.map.get('ae_mcp_channel_lock'), 'api');
  const oc = storage({ ae_mcp_backend: 'opencode' });
  assert.deepEqual(migrateBackendPref(oc), { pref: 'subscription', lockedChannel: '' });
  const keep = storage({ ae_mcp_backend: 'codex', ae_mcp_channel_lock: 'cli' });
  assert.deepEqual(migrateBackendPref(keep), { pref: 'codex', lockedChannel: 'cli' });
  assert.deepEqual(migrateBackendPref(storage({})), { pref: 'subscription', lockedChannel: '' });
});
