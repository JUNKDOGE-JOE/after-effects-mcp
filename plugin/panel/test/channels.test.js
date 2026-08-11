import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  claudeChannels,
  codexChannels,
  zcodeChannels,
  migrateBackendPref,
} from '../src/lib/channels.js';

test('claudeChannels: subscription reflects probe, api reflects provider entry', () => {
  const probing = claudeChannels({ probe: null, apiProvider: null });
  assert.equal(probing[0].channel, 'subscription');
  assert.equal(probing[0].checking, true);
  const ready = claudeChannels({ probe: { nodeOk: true, loggedIn: true }, apiProvider: null });
  assert.equal(ready[0].ok, true);
  assert.equal(ready[1].channel, 'api');
  assert.equal(ready[1].ok, false);
  assert.match(ready[1].fixHint.zh, /Provider 管理/);
  const withApi = claudeChannels({
    probe: { nodeOk: true, loggedIn: false },
    apiProvider: { baseUrl: 'https://r', auth: { model: { kind: 'x-api-key', valueRef: { kind: 'secret', reference: 'aemcp-secret://provider/5eb75f05-5d9e-5d9c-85af-f0893e8b90c2/auth-model/v1', revision: 1 } } } },
    providerAvailable: true,
  });
  assert.equal(withApi[0].ok, false);
  assert.match(withApi[0].fixHint.zh, /自定义 Provider/);
  assert.equal(withApi[1].ok, true);
  assert.equal(withApi[1].canPreflight, true);
  assert.equal(withApi[1].selected, true);
});

test('claudeChannels fails a custom Provider closed when the shared Agent SDK runtime is unavailable', () => {
  const provider = {
    baseUrl: 'https://r',
    auth: {
      model: {
        kind: 'x-api-key',
        valueRef: {
          kind: 'secret',
          reference: 'aemcp-secret://provider/5eb75f05-5d9e-5d9c-85af-f0893e8b90c2/auth-model/v1',
          revision: 1,
        },
      },
    },
  };
  const channels = claudeChannels({
    probe: { nodeOk: false, loggedIn: false },
    apiProvider: provider,
    providerAvailable: true,
  });
  assert.equal(channels[1].ok, false);
  assert.equal(channels[1].canPreflight, false);
  assert.match(channels[1].fixHint.zh, /Node 运行时/);
  assert.match(channels[1].fixHint.en, /Node runtime/);
});

test('codexChannels: cli login state + custom provider channel', () => {
  const list = codexChannels({ codexProbe: { loggedIn: true, runtimeOk: true, cliPath: 'C:\codex.exe', cliVersion: '1.2' }, customProvider: null });
  assert.equal(list[0].channel, 'cli');
  assert.equal(list[0].ok, true);
  assert.match(list[0].detail, /codex\.exe/);
  assert.equal(list[2].channel, 'custom');
  assert.equal(list[2].ok, false);
  const custom = codexChannels({ codexProbe: { loggedIn: false, runtimeOk: true }, customProvider: { baseUrl: 'https://r' }, customProviderAvailable: true, customProviderCredentialResolverReady: true });
  assert.equal(custom.find((c) => c.channel === 'custom').ok, true);
  assert.match(codexChannels({ codexProbe: { loggedIn: false } }).find((c) => c.channel === 'cli').fixHint.zh, /AE_MCP_CODEX_CLI/);
});

test('codexChannels: cli-config channel is positioned between cli and custom', () => {
  const withProviderAndKey = codexChannels({
    codexProbe: { loggedIn: false, runtimeOk: true },
    customProvider: null,
    cliConfig: { model: 'gpt-5.5', providerId: 'mediastorm_glm', provider: { name: 'MediaStorm GLM', baseUrl: 'https://api.example.com/v1', envKey: 'MEDIASTORM_GLM_API_KEY', wireApi: 'responses' } },
    cliCredentialAvailable: true,
  });
  assert.deepEqual(withProviderAndKey.map((c) => c.channel), ['cli', 'cli-config', 'custom']);
  const cliConfigChannel = withProviderAndKey[1];
  assert.equal(cliConfigChannel.ok, true);
  assert.match(cliConfigChannel.source.zh, /继承自 Codex CLI 配置/);
  assert.match(cliConfigChannel.source.en, /Inherited from Codex CLI config/);

  const noKey = codexChannels({
    codexProbe: { loggedIn: false, runtimeOk: true },
    customProvider: null,
    cliConfig: { model: 'gpt-5.5', providerId: 'mediastorm_glm', provider: { name: 'MediaStorm GLM', baseUrl: 'https://api.example.com/v1', envKey: 'MEDIASTORM_GLM_API_KEY', wireApi: 'responses' } },
    cliCredentialAvailable: false,
  });
  assert.equal(noKey[1].ok, false);
  assert.match(noKey[1].fixHint.zh, /凭据/);
  assert.match(noKey[1].fixHint.en, /credential/i);

  const noConfig = codexChannels({ codexProbe: { loggedIn: false, runtimeOk: true }, customProvider: null, cliConfig: null, cliCredentialAvailable: false });
  assert.equal(noConfig[1].ok, false);
  assert.match(noConfig[1].fixHint.zh, /Codex CLI/);

  const runtimeNotOk = codexChannels({
    codexProbe: { loggedIn: false, runtimeOk: false },
    customProvider: null,
    cliConfig: { model: 'gpt-5.5', providerId: 'mediastorm_glm', provider: { name: 'MediaStorm GLM', baseUrl: 'https://api.example.com/v1', envKey: 'MEDIASTORM_GLM_API_KEY', wireApi: 'responses' } },
    cliCredentialAvailable: true,
  });
  assert.equal(runtimeNotOk[1].ok, false);
});

test('codexChannels: display order is fixed regardless of which rows are ok (#229)', () => {
  const list = codexChannels({
    codexProbe: { loggedIn: false, runtimeOk: true },
    customProvider: { baseUrl: 'https://custom.example/v1' },
    customProviderAvailable: true,
    customProviderCredentialResolverReady: true,
    cliConfig: { model: 'gpt-5.5', providerId: 'mediastorm_glm', provider: { name: 'MediaStorm GLM', baseUrl: 'https://api.example.com/v1', envKey: 'MEDIASTORM_GLM_API_KEY', wireApi: 'responses' } },
    cliCredentialAvailable: true,
  });
  assert.deepEqual(list.map((c) => c.channel), ['cli', 'cli-config', 'custom']);
  assert.equal(list.find((c) => c.channel === 'custom').ok, true);
  assert.equal(list.find((c) => c.channel === 'cli-config').ok, true);
});

test('codex custom provider stays unavailable until the credential Helper is ready', () => {
  const custom = codexChannels({
    codexProbe: { loggedIn: false, runtimeOk: true },
    customProvider: { baseUrl: 'https://custom.example/v1' },
    customProviderAvailable: true,
    customProviderCredentialResolverReady: false,
  }).find((channel) => channel.channel === 'custom');
  assert.equal(custom.ok, false);
  assert.match(custom.fixHint.en, /credential store|Helper/i);
});

test('codex custom provider can preflight before its per-model protocol route is known', () => {
  const custom = codexChannels({
    codexProbe: { loggedIn: false, runtimeOk: true },
    customProvider: { baseUrl: 'https://custom.example/v1' },
    customProviderAvailable: true,
    customProviderCredentialResolverReady: true,
  }).find((channel) => channel.channel === 'custom');
  assert.equal(custom.ok, true);
  assert.equal(custom.canPreflight, true);
  assert.doesNotMatch(JSON.stringify(custom), /dialect/i);
});

test('provider channels use non-secret availability and can stay checking during migration', () => {
  const provider = { baseUrl: 'https://relay.example', auth: { model: { kind: 'bearer', valueRef: { kind: 'secret', reference: 'aemcp-secret://provider/5eb75f05-5d9e-5d9c-85af-f0893e8b90c2/auth-model/v1', revision: 1 } } } };
  const checkingClaude = claudeChannels({ probe: { loggedIn: false }, apiProvider: provider, providerChecking: true, providerAvailable: false });
  assert.equal(checkingClaude[1].checking, true);
  assert.equal(checkingClaude[1].ok, false);
  const unavailable = codexChannels({ codexProbe: { runtimeOk: true }, customProvider: provider, customProviderAvailable: false });
  assert.equal(unavailable.find((channel) => channel.channel === 'custom').ok, false);
  assert.equal(JSON.stringify([...checkingClaude, ...unavailable]).includes('aemcp-secret://'), false);
});

test('one v3 Provider is preflightable by both Claude and Codex without a Provider-level protocol', () => {
  const provider = {
    id: 'universal',
    baseUrl: 'https://relay.example/root',
    credential: {
      preferredAuth: { scheme: 'auto', headerName: null },
      valueRef: null,
    },
  };
  assert.equal(Object.hasOwn(provider, 'protocol'), false);
  const claude = claudeChannels({
    probe: { loggedIn: false, nodeOk: true },
    apiProvider: provider,
    providerAvailable: true,
  }).find((channel) => channel.channel === 'api');
  const codex = codexChannels({
    codexProbe: { loggedIn: false, runtimeOk: true },
    customProvider: provider,
    customProviderAvailable: true,
    customProviderCredentialResolverReady: true,
  }).find((channel) => channel.channel === 'custom');
  assert.equal(claude.canPreflight, true);
  assert.equal(claude.ok, true);
  assert.equal(codex.canPreflight, true);
  assert.equal(codex.ok, true);
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


test('migrateBackendPref maps legacy prefs and locks onto explicit per-backend channel choices (#229)', () => {
  function storage(init) {
    const map = new Map(Object.entries(init));
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, v),
      removeItem: (k) => map.delete(k),
      map,
    };
  }
  const byok = storage({ ae_mcp_backend: 'byok' });
  assert.deepEqual(migrateBackendPref(byok), {
    pref: 'subscription',
    channelChoices: { claude: 'api', codex: 'cli' },
  });
  assert.equal(byok.map.get('ae_mcp_backend'), 'subscription');
  assert.equal(byok.map.get('ae_mcp_channel_claude'), 'api');
  const oc = storage({ ae_mcp_backend: 'opencode' });
  assert.deepEqual(migrateBackendPref(oc).channelChoices, { claude: 'subscription', codex: 'cli' });
  const zcode = storage({ ae_mcp_backend: 'zcode' });
  assert.equal(migrateBackendPref(zcode).pref, 'subscription');
  assert.equal(zcode.map.get('ae_mcp_backend'), 'subscription');

  // A legacy custom lock or a previously selected codex provider both migrate
  // onto the codex custom choice, and the lock key is retired.
  const lockedCustom = storage({ ae_mcp_backend: 'codex', ae_mcp_channel_lock: 'custom' });
  assert.deepEqual(migrateBackendPref(lockedCustom), {
    pref: 'codex',
    channelChoices: { claude: 'subscription', codex: 'custom' },
  });
  assert.equal(lockedCustom.map.has('ae_mcp_channel_lock'), false);
  assert.equal(lockedCustom.map.get('ae_mcp_channel_codex'), 'custom');
  const providerSelected = storage({ ae_mcp_backend: 'codex', ae_mcp_codex_provider: 'token-' });
  assert.equal(migrateBackendPref(providerSelected).channelChoices.codex, 'custom');
  const lockedApi = storage({ ae_mcp_channel_lock: 'api' });
  assert.equal(migrateBackendPref(lockedApi).channelChoices.claude, 'api');

  // Already-migrated explicit choices win over any legacy leftovers.
  const explicit = storage({
    ae_mcp_backend: 'codex',
    ae_mcp_channel_codex: 'cli',
    ae_mcp_codex_provider: 'token-',
    ae_mcp_channel_claude: 'api',
  });
  assert.deepEqual(migrateBackendPref(explicit).channelChoices, { claude: 'api', codex: 'cli' });
  assert.deepEqual(migrateBackendPref(storage({})), {
    pref: 'subscription',
    channelChoices: { claude: 'subscription', codex: 'cli' },
  });
});
