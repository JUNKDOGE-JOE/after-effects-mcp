// End-to-end pure-function chain test for the probe-driven zcode model list,
// mirroring the real-panel scenario measured over CDP: localStorage holds a
// fresh ae_mcp_zcode_probed_models entry (16 models, matching cliModel), no
// usable session enumeration, and the Settings screen must end up UNLOCKED
// with 17 options (CLI model pinned first + 16 probed).
// Chain under test: readCachedZcodeProbedModels -> selectDescriptor ->
// descriptor.models -> modelOptions mapping -> zcodeDefaultModelLocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCachedZcodeProbedModels, ZCODE_PROBED_MODELS_CACHE_KEY } from '../src/lib/zcodeModelCache.js';
import { selectDescriptor } from '../src/lib/descriptorSelect.js';
import { zcodeDefaultModelLocked } from '../src/lib/settingsState.js';
import { zcodeStaticDescriptor } from '../src/lib/backendCapabilities.js';

const CLI_MODEL = 'mediastorm_glm/deepseek-v4-flash';
const PROVIDER_ID = 'mediastorm_glm';

function realWorldCacheJson() {
  // 16 probed models, one of which is the CLI-configured model itself.
  const probedModels = [
    { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
    ...Array.from({ length: 15 }, (_, i) => ({ id: 'model-' + i, label: 'Model ' + i })),
  ];
  return JSON.stringify({ cliModel: CLI_MODEL, providerId: PROVIDER_ID, probedModels, probedAt: Date.now() });
}

function storageWith(json) {
  const store = { [ZCODE_PROBED_MODELS_CACHE_KEY]: json };
  return { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
}

function settingsModelOptions(descriptor) {
  // Mirrors App.jsx: modelOptions = descriptor.models.map(m => ({value, label})).
  return descriptor.models.map((m) => ({ value: m.id, label: m.label }));
}

test('cached 16-model probe unlocks Settings with 17 options when there is no session data', () => {
  const cached = readCachedZcodeProbedModels(storageWith(realWorldCacheJson()));
  assert.ok(cached, 'fresh cache entry must be readable');
  assert.equal(cached.probedModels.length, 16);

  const descriptor = selectDescriptor({
    effectiveBackend: 'zcode',
    backendPref: 'zcode',
    baseDescriptor: zcodeStaticDescriptor(),
    zcodeSessionModels: null,
    zcodeProbedModels: cached,
  });

  const modelOptions = settingsModelOptions(descriptor);
  // CLI model pinned first (dedup: 'deepseek-v4-flash' from the probe maps to
  // the same providerId/modelId id as the CLI model) + 15 remaining probed.
  assert.equal(modelOptions.length, 16);
  assert.equal(modelOptions[0].value, CLI_MODEL);
  assert.equal(descriptor.defaultModelId, CLI_MODEL);
  assert.equal(zcodeDefaultModelLocked({ backend: 'zcode', models: modelOptions }), false);
});

test('cached probe of 16 models NOT containing the CLI model yields 17 options (CLI pinned + 16 probed)', () => {
  const probedModels = Array.from({ length: 16 }, (_, i) => ({ id: 'model-' + i, label: 'Model ' + i }));
  const json = JSON.stringify({ cliModel: CLI_MODEL, providerId: PROVIDER_ID, probedModels, probedAt: Date.now() });
  const cached = readCachedZcodeProbedModels(storageWith(json));
  assert.ok(cached);

  const descriptor = selectDescriptor({
    effectiveBackend: 'zcode',
    backendPref: 'zcode',
    baseDescriptor: zcodeStaticDescriptor(),
    zcodeSessionModels: null,
    zcodeProbedModels: cached,
  });

  const modelOptions = settingsModelOptions(descriptor);
  assert.equal(modelOptions.length, 17);
  assert.equal(modelOptions[0].value, CLI_MODEL);
  assert.equal(zcodeDefaultModelLocked({ backend: 'zcode', models: modelOptions }), false);
});

// The exact failure the CDP test surfaced: probeAccount runs on panel load,
// session/create returns a truthy result whose available list only names the
// single current model, and that thin session data must NOT re-lock the UI
// when a fresh probe cache exists.
test('a thin single-model session result does not mask the cached probe (regression: locked after reload)', () => {
  const cached = readCachedZcodeProbedModels(storageWith(realWorldCacheJson()));
  const thinSessionResult = {
    settings: {
      model: {
        available: [{ label: 'deepseek-v4-flash', ref: { modelId: 'deepseek-v4-flash', providerId: PROVIDER_ID } }],
        current: { modelId: 'deepseek-v4-flash', providerId: PROVIDER_ID },
      },
    },
  };

  const descriptor = selectDescriptor({
    effectiveBackend: 'zcode',
    backendPref: 'zcode',
    baseDescriptor: zcodeStaticDescriptor(),
    zcodeSessionModels: thinSessionResult,
    zcodeProbedModels: cached,
  });

  const modelOptions = settingsModelOptions(descriptor);
  assert.equal(modelOptions.length, 16);
  assert.equal(zcodeDefaultModelLocked({ backend: 'zcode', models: modelOptions }), false);
});

test('expired cache keeps the locked fallback (1 CLI model) end to end', () => {
  const raw = JSON.parse(realWorldCacheJson());
  raw.probedAt = Date.now() - (60 * 60 * 1000 + 1000);
  const cached = readCachedZcodeProbedModels(storageWith(JSON.stringify(raw)));
  assert.equal(cached, null);

  const baseDescriptor = {
    ...zcodeStaticDescriptor(),
    models: [{ id: CLI_MODEL, label: 'deepseek-v4-flash', effortLevels: [], cost: 2, adaptive: false }],
    defaultModelId: CLI_MODEL,
  };
  const descriptor = selectDescriptor({
    effectiveBackend: 'zcode',
    backendPref: 'zcode',
    baseDescriptor,
    zcodeSessionModels: null,
    zcodeProbedModels: cached,
  });
  const modelOptions = settingsModelOptions(descriptor);
  assert.equal(modelOptions.length, 1);
  assert.equal(zcodeDefaultModelLocked({ backend: 'zcode', models: modelOptions }), true);
});
