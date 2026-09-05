import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROVAL_MODES,
  CLAUDE_MODELS,
  CLAUDE_PRICE_USD_PER_MTOK,
  claudeSubDescriptor,
  codexDescriptorFromModels,
  codexStaticDescriptor,
  costTier,
  openCodeDescriptorFromModels,
  resolveEffectiveEffort,
} from '../src/lib/backendCapabilities.js';

test('Claude subscription descriptor exposes the curated models and approval modes', () => {
  const descriptor = claudeSubDescriptor();
  assert.equal(descriptor.id, 'claude-sub');
  assert.equal(descriptor.defaultModelId, 'claude-opus-5');
  assert.equal(descriptor.models.length, CLAUDE_MODELS.length);
  assert.equal(descriptor.approvalModes, APPROVAL_MODES);
  assert.equal(descriptor.supportsFast('claude-opus-5'), false);
});

test('Claude ids are current API aliases and the default is selectable', () => {
  const ids = CLAUDE_MODELS.map((model) => model.id);
  assert.deepEqual(ids, ['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']);
  for (const id of ids) {
    assert.doesNotMatch(id, /-\d{8}$/, id + ' must be an alias, not a dated snapshot');
    assert.ok(CLAUDE_PRICE_USD_PER_MTOK[id], id + ' needs a price entry for its cost tier');
  }
  assert.ok(ids.includes(claudeSubDescriptor().defaultModelId));
});

test('only Fable 5.1 declares its minimum Claude CLI version', () => {
  assert.equal(CLAUDE_MODELS.find((model) => model.id === 'claude-fable-5-1').minCliVersion, '2.1.251');
  for (const model of CLAUDE_MODELS.filter((model) => model.id !== 'claude-fable-5-1')) {
    assert.equal(Object.hasOwn(model, 'minCliVersion'), false, model.id);
  }
});

test('cost tiers derive from the Claude price map', () => {
  assert.equal(costTier('claude-haiku-4-5'), 1);
  assert.equal(costTier('claude-sonnet-5'), 2);
  assert.equal(costTier('claude-opus-5'), 3);
  assert.equal(costTier('claude-fable-5-1'), 4);
  assert.equal(costTier('unknown'), 2);
});

test('Codex static fallback mirrors the official login inventory', () => {
  const descriptor = codexStaticDescriptor();
  assert.equal(descriptor.defaultModelId, 'gpt-5.6-sol');
  assert.ok(descriptor.models.some((model) => model.id === descriptor.defaultModelId));
  assert.deepEqual(
    descriptor.models.map((model) => model.id),
    ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark'],
  );
  assert.equal(descriptor.supportsFast('gpt-5.6-sol'), true);
  assert.equal(descriptor.supportsFast('gpt-5.5'), true);
  assert.equal(descriptor.supportsFast('gpt-5.4-mini'), false);
  assert.equal(descriptor.supportsFast('gpt-5.3-codex-spark'), false);
  assert.equal(descriptor.catalogVerified, false);
});

test('Codex model-list data preserves capability metadata', () => {
  const descriptor = codexDescriptorFromModels({
    models: [{
      id: 'gpt-5.6-terra',
      displayName: 'Terra',
      isDefault: true,
      defaultReasoningEffort: 'high',
      additionalSpeedTiers: ['fast'],
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
    }],
  });
  assert.equal(descriptor.defaultModelId, 'gpt-5.6-terra');
  assert.equal(descriptor.defaultEffort, 'high');
  assert.equal(descriptor.supportsFast('gpt-5.6-terra'), true);
  assert.deepEqual(descriptor.models[0].effortLevels, ['low', 'high']);
});

test('Codex model-list accepts the app-server data envelope', () => {
  const descriptor = codexDescriptorFromModels({
    data: [{
      id: 'gpt-5.6-luna',
      displayName: 'Luna',
      isDefault: true,
      defaultReasoningEffort: 'medium',
      additionalSpeedTiers: ['fast'],
      supportedReasoningEfforts: [
        { reasoningEffort: 'low' },
        { reasoningEffort: 'medium' },
        { reasoningEffort: 'high' },
      ],
    }],
  });
  assert.equal(descriptor.defaultModelId, 'gpt-5.6-luna');
  assert.deepEqual(descriptor.models.map((model) => model.id), ['gpt-5.6-luna']);
  assert.equal(descriptor.supportsFast('gpt-5.6-luna'), true);
});

test('Astra is preferred only when visible, with reasoning and Fast from the CLI', () => {
  const astra = { id: 'gpt-6-astra', displayName: 'GPT-6 Astra', defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['low', 'high', 'ultra'].map((reasoningEffort) => ({ reasoningEffort })),
    serviceTiers: [{ id: 'priority' }] };
  const d = codexDescriptorFromModels([{ id: 'gpt-5.6-sol', isDefault: true }, astra]);
  assert.equal(d.defaultModelId, astra.id);
  assert.equal(d.defaultEffort, 'high');
  assert.equal(d.models[1].label, 'GPT-6 Astra');
  assert.deepEqual(d.models[1].effortLevels, ['low', 'high', 'ultra']);
  assert.equal(d.supportsFast(astra.id), true);
  assert.equal(codexDescriptorFromModels([{ ...astra, serviceTiers: [] }]).supportsFast(astra.id), false);
  const hidden = codexDescriptorFromModels([{ ...astra, hidden: true }]);
  assert.deepEqual(hidden.models, []);
  assert.equal(hidden.defaultModelId, '');
  assert.equal(hidden.catalogVerified, true);
  assert.deepEqual(codexDescriptorFromModels([]).models, []);
});

test('OpenCode descriptor qualifies third-party models with their provider id', () => {
  const descriptor = openCodeDescriptorFromModels({
    'aemcp-example': {
      id: 'aemcp-example',
      models: { 'model-a': { name: 'Model A' } },
    },
  });
  assert.equal(descriptor.models[0].id, 'aemcp-example/model-a');
  assert.equal(descriptor.models[0].label, 'Model A');
});

test('effective effort stays compatible with the selected model', () => {
  const model = { effortLevels: ['low', 'medium', 'high'] };
  assert.equal(
    resolveEffectiveEffort({ requested: 'high', model, defaultEffort: 'medium' }),
    'high',
  );
  assert.equal(
    resolveEffectiveEffort({ requested: 'ultra', model, defaultEffort: 'medium' }),
    'high',
  );
  assert.equal(
    resolveEffectiveEffort({ requested: null, model, defaultEffort: 'medium' }),
    'medium',
  );
  assert.equal(resolveEffectiveEffort({ requested: 'high', model: { effortLevels: [] } }), null);
});

import { cliIdentity, cliUpdateGuide, compareVersions, createCliUpdateChecker, codexCatalogNotice } from '../src/lib/cliUpdates.js';

test('stable versions compare numerically and unknown or prerelease stays unknown', () => {
  assert.equal(compareVersions('0.99.9', '0.153.4'), -1);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.4', '1.2.3'), 1);
  for (const value of ['', 'unknown', '1.2.3-beta.1', '1.2', 'codex 1.2.3']) {
    assert.equal(compareVersions(value, '1.2.3'), null);
  }
});

test('update checks cache only successful stable results and recheck bypasses cache', async () => {
  let calls = 0, version = '0.153.4', now = 100;
  const check = createCliUpdateChecker({ now: () => now, requestJson: async (request) => {
    calls += 1;
    assert.equal(request.url, 'https://registry.npmjs.org/@openai/codex/latest');
    return { ok: true, json: { version } };
  } });
  assert.equal((await check('codex', { version: '0.144.1' })).status, 'update');
  assert.equal((await check('codex', { version: '0.153.4' })).status, 'current');
  assert.equal(calls, 1);
  version = '0.154.0';
  assert.equal((await check('codex', { version: '0.153.4' }, { force: true })).latest, version);
  assert.equal(calls, 2);
  now += 86400000;
  assert.equal((await check('codex', { version: '0.155.0' })).status, 'current');
  assert.equal(calls, 3);
  assert.equal((await check('codex', { version: '' })).status, 'unknown');
});

test('offline, rate limits, malformed versions and hung requests cannot claim current', async () => {
  for (const requestJson of [
    async () => { throw new Error('offline'); },
    async () => ({ ok: false, status: 429 }),
    async () => ({ ok: true, json: { version: '0.154.0-beta.1' } }),
    () => new Promise(() => {}),
  ]) {
    const check = createCliUpdateChecker({ requestJson, timeoutMs: 10 });
    assert.equal((await check('codex', { version: '0.144.1' })).status, 'unknown');
  }
});

test('update guidance follows the launched executable, including materialized npm shims', () => {
  const cli = cliIdentity({ ok: true, path: 'C:/node.exe', displayPath: 'C:/npm/codex.cmd',
    version: '0.144.1', argsPrefix: ['C:/npm/node_modules/@openai/codex/bin/codex.js'] });
  assert.equal(cli.path, 'C:/npm/codex.cmd');
  assert.equal(cli.launchPath, 'C:/node.exe');
  assert.equal(cliUpdateGuide('codex', cli).command, 'npm install -g @openai/codex@latest');
  const mac = cliIdentity({ ok: true, path: '/opt/homebrew/bin/node', argsPrefix: ['/opt/homebrew/bin/codex'] }, {
    realpathSync: (path) => path.endsWith('/codex') ? '/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js'
      : '/opt/homebrew/Cellar/node/24.6.0/bin/node',
  });
  assert.equal(cliUpdateGuide('codex', mac).command, 'npm install -g @openai/codex@latest');
  const cases = [
    ['subscription', '/opt/homebrew/Caskroom/claude-code/2.1.1/claude', 'homebrew', 'brew upgrade claude-code'],
    ['subscription', 'C:/Microsoft/WinGet/Packages/Anthropic.ClaudeCode/claude.exe', 'winget', 'winget upgrade Anthropic.ClaudeCode'],
    ['subscription', '/home/test/.local/share/claude/versions/2.1.1', 'native', 'claude update'],
    ['codex', 'C:/OpenAI/Codex/bin/123/codex.exe', 'desktop', ''],
    ['opencode', '/home/test/.opencode/bin/opencode', 'native', 'opencode upgrade'],
    ['codex', '/custom/tools/codex', 'standalone', ''],
  ];
  for (const [backend, path, source, command] of cases) {
    const result = cliUpdateGuide(backend, { path });
    assert.equal(result.source, source);
    assert.equal(result.command, command);
  }
  const bundled = cliUpdateGuide('opencode', { source: 'runtime', path: '/panel/runtime/opencode' }, 'en');
  assert.equal(bundled.command, '');
  assert.match(bundled.detail, /same panel version does not upgrade/);
  assert.match(bundled.url, /after-effects-mcp\/releases$/);
});

test('Astra absence distinguishes old CLI, account/route and failed catalog', () => {
  assert.match(codexCatalogNotice({ catalogStatus: 'failed', cliVersion: '0.144.1' }, 'en'), /check failed/);
  assert.match(codexCatalogNotice({ catalogStatus: 'complete', models: [], cliVersion: '0.144.1' }, 'en'), /old CLI/);
  assert.match(codexCatalogNotice({ catalogStatus: 'complete', models: [], cliVersion: '0.153.4' }, 'en'), /account or route/);
  assert.equal(codexCatalogNotice({ catalogStatus: 'complete', models: [{ id: 'gpt-6-astra' }] }), '');
});
