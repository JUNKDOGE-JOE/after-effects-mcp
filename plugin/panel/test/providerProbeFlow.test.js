import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProviderManagerProbe } from '../src/app/providerProbeFlow.js';

const PROVIDER = {
  id: 'p1',
  name: 'Provider',
  protocol: 'openai-compatible',
  baseUrl: 'https://provider.example',
  apiKey: 'sk',
};

test('runProviderManagerProbe detects and persists dialect before probing openai-compatible providers without dialect', async () => {
  const calls = [];
  const result = await runProviderManagerProbe(PROVIDER, {
    now: () => 123,
    detectProviderDialectImpl: async (args) => {
      calls.push(['detect', args.protocol]);
      return {
        ok: true,
        dialect: { wireApi: 'chat', authScheme: 'x-api-key', source: 'detected', updatedAt: 123 },
        models: [{ id: 'glm-5.2', label: 'GLM-5.2' }],
        tried: [],
      };
    },
    probeProviderModelsImpl: async () => {
      calls.push(['probe']);
      return { ok: true, status: 200, models: [] };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [['detect', 'openai-compatible']]);
  assert.deepEqual(result.entry.dialect, { wireApi: 'chat', authScheme: 'x-api-key', source: 'detected', updatedAt: 123 });
  assert.deepEqual(result.entry.probedModels, [{ id: 'glm-5.2', label: 'GLM-5.2' }]);
  assert.equal(result.entry.probedAt, 123);
});

test('runProviderManagerProbe falls back to bearer probe and reports detection detail when both fail', async () => {
  const calls = [];
  const result = await runProviderManagerProbe(PROVIDER, {
    detectProviderDialectImpl: async () => {
      calls.push('detect');
      return { ok: false, reason: 'wire-undetected', detail: 'Provider did not accept supported wire APIs', tried: [] };
    },
    probeProviderModelsImpl: async (args) => {
      calls.push(['probe', args.dialect || null]);
      return { ok: false, status: 401, models: [], detail: 'HTTP 401 from provider' };
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(calls, ['detect', ['probe', null]]);
  assert.match(result.detail, /HTTP 401 from provider/);
  assert.match(result.detail, /wire-undetected/);
  assert.match(result.detail, /Provider did not accept supported wire APIs/);
});

test('runProviderManagerProbe re-detects stale dialect after auth failure', async () => {
  const provider = {
    ...PROVIDER,
    dialect: { wireApi: 'responses', authScheme: 'bearer', source: 'manual', updatedAt: 1 },
  };
  const calls = [];
  const result = await runProviderManagerProbe(provider, {
    now: () => 456,
    probeProviderModelsImpl: async (args) => {
      calls.push(['probe', args.dialect]);
      return { ok: false, status: 403, models: [], detail: 'HTTP 403 from provider' };
    },
    detectProviderDialectImpl: async () => {
      calls.push(['detect']);
      return {
        ok: true,
        dialect: { wireApi: 'chat', authScheme: 'x-api-key', source: 'detected', updatedAt: 456 },
        models: [{ id: 'm2', label: 'm2' }],
        tried: [],
      };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [['probe', provider.dialect], ['detect']]);
  assert.deepEqual(result.entry.dialect, { wireApi: 'chat', authScheme: 'x-api-key', source: 'detected', updatedAt: 456 });
  assert.deepEqual(result.entry.probedModels, [{ id: 'm2', label: 'm2' }]);
});
