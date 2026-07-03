import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectDescriptor, isClaudeApiBackend, reconcileModelPref } from '../src/lib/descriptorSelect.js';
import { byokStaticDescriptor, codexStaticDescriptor, zcodeStaticDescriptor } from '../src/lib/backendCapabilities.js';

const probedProvider = { id: 'relay', probedModels: [{ id: 'glm-5.2', label: 'GLM 5.2' }, { id: 'deepseek-v4', label: 'Deepseek V4' }] };

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

test('claude-api without probed models falls back to fetched /v1/models list, then to curated base', () => {
  const base = byokStaticDescriptor();
  const fetched = selectDescriptor({ effectiveBackend: 'claude-api', baseDescriptor: base, byokApiModels: [{ id: 'claude-sonnet-5' }, { id: 'gw-custom' }] });
  assert.ok(fetched.models.some((m) => m.id === 'gw-custom'));
  assert.equal(selectDescriptor({ effectiveBackend: 'claude-api', baseDescriptor: base }), base, 'no provider facts -> curated fallback');
});

test('probed models take precedence over cached codex list; no provider -> cached; neither -> base', () => {
  const base = codexStaticDescriptor();
  const cached = [{ id: 'gpt-5.5', displayName: 'GPT-5.5' }];
  const probed = selectDescriptor({ effectiveBackend: 'codex', backendPref: 'codex', baseDescriptor: base, codexCustomProvider: probedProvider, codexCachedModels: cached });
  assert.equal(probed.defaultModelId, 'glm-5.2');
  const fromCache = selectDescriptor({ effectiveBackend: 'codex', backendPref: 'codex', baseDescriptor: base, codexCachedModels: cached });
  assert.deepEqual(fromCache.models.map((m) => m.id), ['gpt-5.5']);
  assert.equal(selectDescriptor({ effectiveBackend: 'codex', backendPref: 'codex', baseDescriptor: base }), base);
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

test('selectDescriptor prefers session data over probed models when both are present', () => {
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
    effectiveBackend: 'zcode',
    backendPref: 'zcode',
    baseDescriptor,
    zcodeSessionModels: sessionResult,
    zcodeProbedModels: { cliModel: 'mediastorm_glm/deepseek-v4-flash', providerId: 'mediastorm_glm', probedModels: [{ id: 'deepseek-v4-flash' }] },
  });
  assert.deepEqual(descriptor.models.map((m) => m.id), ['bigmodel-start-plan/GLM-5.2']);
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
