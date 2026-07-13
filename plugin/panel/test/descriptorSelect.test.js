import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectDescriptor, isClaudeApiBackend, reconcileModelPref } from '../src/lib/descriptorSelect.js';
import { byokStaticDescriptor, codexStaticDescriptor, zcodeStaticDescriptor } from '../src/lib/backendCapabilities.js';

const probedProvider = { id: 'relay', probedModels: [{ id: 'glm-5.2', label: 'GLM 5.2' }, { id: 'deepseek-v4', label: 'Deepseek V4' }] };
const v3Provider = {
  id: 'relay-v3',
  modelList: {
    status: 'supported',
    models: [{ id: 'glm-5.2', label: 'GLM 5.2' }, { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' }],
  },
};

test('isClaudeApiBackend covers claude-api and node-broken byok, nothing else', () => {
  assert.equal(isClaudeApiBackend('claude-api'), true);
  assert.equal(isClaudeApiBackend('byok'), true);
  assert.equal(isClaudeApiBackend('subscription'), false);
  assert.equal(isClaudeApiBackend('none'), false);
});

test('claude-api + provider probedModels drives the descriptor (regression: was gated on unreachable backendPref===byok)', () => {
  const base = byokStaticDescriptor();
  const d = selectDescriptor({ effectiveBackend: 'claude-api', backendPref: 'subscription', baseDescriptor: base, claudeApiProvider: probedProvider });
  assert.deepEqual(d.models.map((m) => m.id), ['glm-5.2', 'deepseek-v4']);
  assert.equal(d.defaultModelId, 'glm-5.2');
});

test('node-broken byok backend uses the same probed-models path', () => {
  const base = byokStaticDescriptor();
  const d = selectDescriptor({ effectiveBackend: 'byok', backendPref: 'subscription', baseDescriptor: base, claudeApiProvider: probedProvider });
  assert.equal(d.defaultModelId, 'glm-5.2');
});

test('one v3 Provider model inventory drives both Claude and Codex descriptors', () => {
  const expected = ['glm-5.2', 'gemini-3.5-flash'];
  const claude = selectDescriptor({
    effectiveBackend: 'claude-api',
    baseDescriptor: byokStaticDescriptor(),
    claudeApiProvider: v3Provider,
  });
  const codex = selectDescriptor({
    effectiveBackend: 'codex',
    effectiveChannel: 'custom',
    backendPref: 'codex',
    baseDescriptor: codexStaticDescriptor(),
    codexCustomProvider: v3Provider,
    customProviderCredentialResolverReady: true,
  });
  assert.deepEqual(claude.models.map((model) => model.id), expected);
  assert.deepEqual(codex.models.map((model) => model.id), expected);
});

test('claude-api without probed models falls back to fetched /v1/models list, then to curated base', () => {
  const base = byokStaticDescriptor();
  const fetched = selectDescriptor({ effectiveBackend: 'claude-api', baseDescriptor: base, byokApiModels: [{ id: 'claude-sonnet-5' }, { id: 'gw-custom' }] });
  assert.ok(fetched.models.some((m) => m.id === 'gw-custom'));
  assert.equal(selectDescriptor({ effectiveBackend: 'claude-api', baseDescriptor: base }), base, 'no provider facts -> curated fallback');
});

test('probed models take precedence over cached codex list; no provider -> cached; neither -> base', () => {
  const base = codexStaticDescriptor();
  const cached = [{ id: 'gpt-5.5', displayName: 'GPT-5.5' }];
  const probed = selectDescriptor({
    effectiveBackend: 'codex',
    effectiveChannel: 'custom',
    customProviderCredentialResolverReady: true,
    backendPref: 'codex',
    baseDescriptor: base,
    codexCustomProvider: probedProvider,
    codexCachedModels: cached,
  });
  assert.equal(probed.defaultModelId, 'glm-5.2');
  const fromCache = selectDescriptor({ effectiveBackend: 'codex', backendPref: 'codex', baseDescriptor: base, codexCachedModels: cached });
  assert.deepEqual(fromCache.models.map((m) => m.id), ['gpt-5.5']);
  assert.equal(selectDescriptor({ effectiveBackend: 'codex', backendPref: 'codex', baseDescriptor: base }), base);
});

test('official codex CLI fills missing GPT-5.6 models without polluting provider channels', () => {
  const base = codexStaticDescriptor();
  const cached = [
    { id: 'gpt-5.5', displayName: 'GPT-5.5' },
    { id: 'gpt-5.6-sol', displayName: 'Live Sol', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
  ];
  const official = selectDescriptor({
    effectiveBackend: 'codex',
    effectiveChannel: 'cli',
    backendPref: 'codex',
    baseDescriptor: base,
    codexCachedModels: cached,
  });

  assert.deepEqual(official.models.map((model) => model.id), [
    'gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
  ]);
  assert.equal(official.models.find((model) => model.id === 'gpt-5.6-sol').label, 'Live Sol');
  assert.deepEqual(official.models.find((model) => model.id === 'gpt-5.6-terra').effortLevels, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(official.models.find((model) => model.id === 'gpt-5.6-luna').effortLevels, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(official.supportsFast('gpt-5.6-sol'), true);
  assert.equal(official.supportsFast('gpt-5.6-terra'), true);
  assert.equal(official.supportsFast('gpt-5.6-luna'), true);

  const officialFallback = selectDescriptor({
    effectiveBackend: 'codex',
    effectiveChannel: 'cli',
    backendPref: 'codex',
    baseDescriptor: base,
  });
  assert.deepEqual(officialFallback.models.map((model) => model.id), [
    'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
  ]);

  for (const effectiveChannel of ['custom', 'cli-config', null]) {
    const provider = selectDescriptor({
      effectiveBackend: 'codex',
      effectiveChannel,
      backendPref: 'codex',
      baseDescriptor: base,
      codexCachedModels: cached,
    });
    assert.deepEqual(provider.models.map((model) => model.id), ['gpt-5.5', 'gpt-5.6-sol']);

    const providerFallback = selectDescriptor({
      effectiveBackend: 'codex',
      effectiveChannel,
      backendPref: 'codex',
      baseDescriptor: base,
    });
    assert.deepEqual(providerFallback.models.map((model) => model.id), ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']);
  }
});

test('codex descriptor exposes provider models while dialect is pending but keeps the resolver gate', () => {
  const base = codexStaticDescriptor();
  const cached = [{ id: 'gpt-5.5', displayName: 'GPT-5.5' }];
  for (const effectiveChannel of ['cli-config', 'custom', null]) {
    const descriptor = selectDescriptor({
      effectiveBackend: 'codex',
      backendPref: 'codex',
      baseDescriptor: base,
      codexCustomProvider: probedProvider,
      codexCachedModels: cached,
      effectiveChannel,
      customProviderCredentialResolverReady: true,
    });
    assert.deepEqual(descriptor.models.map((model) => model.id), ['glm-5.2', 'deepseek-v4']);
  }
  const gated = selectDescriptor({
    effectiveBackend: 'codex',
    backendPref: 'codex',
    baseDescriptor: base,
    codexCustomProvider: probedProvider,
    codexCachedModels: cached,
    effectiveChannel: 'custom',
    customProviderCredentialResolverReady: false,
  });
  assert.deepEqual(gated.models.map((model) => model.id), ['gpt-5.5']);
});

test('custom model id is honored on claude-api and codex paths', () => {
  const base = byokStaticDescriptor();
  const d = selectDescriptor({ effectiveBackend: 'claude-api', baseDescriptor: base, claudeApiProvider: probedProvider, customModel: 'my-model' });
  assert.equal(d.defaultModelId, 'my-model');
});

test('subscription / none backends keep the base descriptor untouched', () => {
  const base = byokStaticDescriptor();
  assert.equal(selectDescriptor({ effectiveBackend: 'subscription', backendPref: 'subscription', baseDescriptor: base, claudeApiProvider: probedProvider }), base);
  assert.equal(selectDescriptor({ effectiveBackend: 'none', backendPref: 'subscription', baseDescriptor: base }), base);
});

// --- zcode branch (regression) ---
// zcodeDescriptorFromModels lost all call sites in a refactor, so the live
// model list from session/create never reached the composer descriptor and
// the model chip disappeared entirely. selectDescriptor must build a live
// zcode descriptor from session data when present, and fall back to the
// static/base descriptor otherwise.

test('selectDescriptor uses zcodeSessionModels to build a live descriptor when backend is zcode', () => {
  const baseDescriptor = zcodeStaticDescriptor();
  const sessionResult = {
    settings: {
      model: {
        available: [
          { label: 'GLM-5.2', ref: { modelId: 'GLM-5.2', providerId: 'bigmodel-start-plan' } },
          { label: 'GLM-5 Turbo', ref: { modelId: 'GLM-5-Turbo', providerId: 'bigmodel-start-plan' } },
        ],
        current: { modelId: 'GLM-5.2', providerId: 'bigmodel-start-plan' },
      },
    },
  };
  const descriptor = selectDescriptor({
    effectiveBackend: 'zcode',
    backendPref: 'zcode',
    baseDescriptor,
    zcodeSessionModels: sessionResult,
  });
  assert.equal(descriptor.id, 'zcode');
  assert.equal(descriptor.models.length, 2);
  assert.equal(descriptor.defaultModelId, 'bigmodel-start-plan/GLM-5.2');
});

test('selectDescriptor falls back to baseDescriptor for zcode when there is no session data yet', () => {
  const baseDescriptor = zcodeStaticDescriptor();
  const descriptor = selectDescriptor({
    effectiveBackend: 'zcode',
    backendPref: 'zcode',
    baseDescriptor,
    zcodeSessionModels: null,
  });
  assert.equal(descriptor, baseDescriptor);
});

test('selectDescriptor zcode branch also triggers off backendPref when effectiveBackend differs (probing states)', () => {
  const baseDescriptor = zcodeStaticDescriptor();
  const sessionResult = {
    settings: {
      model: {
        available: [{ label: 'GLM-5.2', ref: { modelId: 'GLM-5.2', providerId: 'bigmodel-start-plan' } }],
        current: { modelId: 'GLM-5.2', providerId: 'bigmodel-start-plan' },
      },
    },
  };
  const descriptor = selectDescriptor({
    effectiveBackend: 'none',
    backendPref: 'zcode',
    baseDescriptor,
    zcodeSessionModels: sessionResult,
  });
  assert.equal(descriptor.id, 'zcode');
  assert.equal(descriptor.models.length, 1);
});

// --- zcode probe-driven fallback (custom openai-compatible providers where
// session/create's settings.model.available is empty) ---

test('selectDescriptor uses zcodeProbedModels when session data is absent', () => {
  const baseDescriptor = zcodeStaticDescriptor();
  const descriptor = selectDescriptor({
    effectiveBackend: 'zcode',
    backendPref: 'zcode',
    baseDescriptor,
    zcodeSessionModels: null,
    zcodeProbedModels: { cliModel: 'mediastorm_glm/deepseek-v4-flash', providerId: 'mediastorm_glm', probedModels: [{ id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' }, { id: 'glm-5.2', label: 'GLM-5.2' }] },
  });
  assert.equal(descriptor.id, 'zcode');
  assert.deepEqual(descriptor.models.map((m) => m.id), ['mediastorm_glm/deepseek-v4-flash', 'mediastorm_glm/glm-5.2']);
  assert.equal(descriptor.defaultModelId, 'mediastorm_glm/deepseek-v4-flash');
});

test('selectDescriptor prefers session data over probed models when the session lists more than one model', () => {
  const baseDescriptor = zcodeStaticDescriptor();
  const sessionResult = {
    settings: {
      model: {
        available: [
          { label: 'GLM-5.2', ref: { modelId: 'GLM-5.2', providerId: 'bigmodel-start-plan' } },
          { label: 'GLM-5 Turbo', ref: { modelId: 'GLM-5-Turbo', providerId: 'bigmodel-start-plan' } },
        ],
        current: { modelId: 'GLM-5.2', providerId: 'bigmodel-start-plan' },
      },
    },
  };
  const descriptor = selectDescriptor({
    effectiveBackend: 'zcode',
    backendPref: 'zcode',
    baseDescriptor,
    zcodeSessionModels: sessionResult,
    zcodeProbedModels: { cliModel: 'mediastorm_glm/deepseek-v4-flash', providerId: 'mediastorm_glm', probedModels: [{ id: 'deepseek-v4-flash' }] },
  });
  assert.deepEqual(descriptor.models.map((m) => m.id), ['bigmodel-start-plan/GLM-5.2', 'bigmodel-start-plan/GLM-5-Turbo']);
});

// Regression (real-panel CDP finding): on panel load, runZcodeProbe ->
// probeAccount -> ensureSession emits 'zcode-session-created' with a TRUTHY
// result whose settings.model.available only names the single current model
// (custom openai-compatible providers have no session-side enumeration).
// The session branch used to win on truthiness alone, producing a 1-model
// descriptor that masked the cached probed models -> Settings stayed locked
// even with a fresh 16-model probe cache sitting in localStorage.
test('selectDescriptor lets probed models beat a session result that only lists the single current model', () => {
  const baseDescriptor = zcodeStaticDescriptor();
  const sessionResult = {
    settings: {
      model: {
        available: [{ label: 'deepseek-v4-flash', ref: { modelId: 'deepseek-v4-flash', providerId: 'mediastorm_glm' } }],
        current: { modelId: 'deepseek-v4-flash', providerId: 'mediastorm_glm' },
      },
    },
  };
  const descriptor = selectDescriptor({
    effectiveBackend: 'zcode',
    backendPref: 'zcode',
    baseDescriptor,
    zcodeSessionModels: sessionResult,
    zcodeProbedModels: {
      cliModel: 'mediastorm_glm/deepseek-v4-flash',
      providerId: 'mediastorm_glm',
      probedModels: [{ id: 'deepseek-v4-flash' }, { id: 'glm-5.2' }, { id: 'glm-5-turbo' }],
    },
  });
  assert.equal(descriptor.models.length, 3);
  assert.equal(descriptor.defaultModelId, 'mediastorm_glm/deepseek-v4-flash');
});

test('selectDescriptor lets probed models beat a session result with an empty available list', () => {
  const baseDescriptor = zcodeStaticDescriptor();
  const sessionResult = { settings: { model: { available: [], current: null } } };
  const descriptor = selectDescriptor({
    effectiveBackend: 'zcode',
    backendPref: 'zcode',
    baseDescriptor,
    zcodeSessionModels: sessionResult,
    zcodeProbedModels: { cliModel: 'mediastorm_glm/deepseek-v4-flash', providerId: 'mediastorm_glm', probedModels: [{ id: 'deepseek-v4-flash' }, { id: 'glm-5.2' }] },
  });
  // Must be the probed list, NOT zcodeDescriptorFromModels' static builtin
  // fallback (which also happens to have 2 entries).
  assert.deepEqual(descriptor.models.map((m) => m.id), [
    'mediastorm_glm/deepseek-v4-flash',
    'mediastorm_glm/glm-5.2',
  ]);
});

test('selectDescriptor keeps the session-derived descriptor when a thin session result has no probed backup', () => {
  const baseDescriptor = zcodeStaticDescriptor();
  const sessionResult = {
    settings: {
      model: {
        available: [{ label: 'only', ref: { modelId: 'only', providerId: 'p' } }],
        current: { modelId: 'only', providerId: 'p' },
      },
    },
  };
  const descriptor = selectDescriptor({
    effectiveBackend: 'zcode',
    backendPref: 'zcode',
    baseDescriptor,
    zcodeSessionModels: sessionResult,
    zcodeProbedModels: null,
  });
  assert.deepEqual(descriptor.models.map((m) => m.id), ['p/only']);
});

test('selectDescriptor falls back to baseDescriptor for zcode when probe also has nothing', () => {
  const baseDescriptor = zcodeStaticDescriptor();
  const descriptor = selectDescriptor({
    effectiveBackend: 'zcode',
    backendPref: 'zcode',
    baseDescriptor,
    zcodeSessionModels: null,
    zcodeProbedModels: { cliModel: '', providerId: '', probedModels: [] },
  });
  assert.equal(descriptor, baseDescriptor);
});

// --- reconcileModelPref (bug 2) ---
// A stale localStorage model id (e.g. an old glm-5.2 id) that is not in the
// new descriptor's model list silently wins over the CLI-provided
// defaultModelId. reconcileModelPref resets to the descriptor default when
// the current model isn't present in the descriptor's model list, except for
// the custom-model exemption where the model legitimately isn't curated.

test('reconcileModelPref resets to defaultModelId when current model is not in the descriptor', () => {
  const descriptor = { defaultModelId: 'mediastorm_glm/deepseek-v4-flash', models: [{ id: 'mediastorm_glm/deepseek-v4-flash' }, { id: 'other/model' }] };
  const result = reconcileModelPref('glm-5.2', descriptor);
  assert.equal(result, 'mediastorm_glm/deepseek-v4-flash');
});

test('reconcileModelPref keeps the current model when it is present in the descriptor', () => {
  const descriptor = { defaultModelId: 'mediastorm_glm/deepseek-v4-flash', models: [{ id: 'mediastorm_glm/deepseek-v4-flash' }, { id: 'other/model' }] };
  const result = reconcileModelPref('other/model', descriptor);
  assert.equal(result, 'other/model');
});

test('reconcileModelPref preserves a selected provider model while provider facts are loading', () => {
  const descriptor = { defaultModelId: 'gpt-5.5', models: [{ id: 'gpt-5.5' }] };
  const result = reconcileModelPref('claude-sonnet-5', descriptor, { providerFactsPending: true });
  assert.equal(result, 'claude-sonnet-5');
});

test('reconcileModelPref is a no-op when the descriptor has no models (custom model path)', () => {
  const descriptor = { defaultModelId: '', models: [] };
  const result = reconcileModelPref('my-custom-model-id', descriptor);
  assert.equal(result, 'my-custom-model-id');
});

test('reconcileModelPref exempts custom models even when the descriptor has a curated list', () => {
  const descriptor = { defaultModelId: 'mediastorm_glm/deepseek-v4-flash', models: [{ id: 'mediastorm_glm/deepseek-v4-flash' }] };
  const result = reconcileModelPref('my-custom-model-id', descriptor, { isCustom: true });
  assert.equal(result, 'my-custom-model-id');
});

test('reconcileModelPref handles empty model by returning defaultModelId', () => {
  const descriptor = { defaultModelId: 'mediastorm_glm/deepseek-v4-flash', models: [{ id: 'mediastorm_glm/deepseek-v4-flash' }] };
  const result = reconcileModelPref('', descriptor);
  assert.equal(result, 'mediastorm_glm/deepseek-v4-flash');
});
