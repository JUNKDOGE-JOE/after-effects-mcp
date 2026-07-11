import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProviderManagerProbe } from '../src/app/providerProbeFlow.js';

function providerFixture(overrides = {}) {
  return Object.assign({
    id: 'provider-1',
    credentialId: '5eb75f05-5d9e-5d9c-85af-f0893e8b90c2',
    name: 'Provider 1',
    protocol: 'openai-compatible',
    baseUrl: 'https://provider.example/v1',
    allowInsecureHttp: false,
    authProfileRevision: 1,
    auth: { model: { kind: 'none' }, probe: { kind: 'inherit-model' } },
    headers: [],
    dialect: { override: null, detected: null },
    probedModels: [],
    probedAt: 0,
  }, overrides);
}

function resolvedProfile(provider, scope, secret = `${scope}-secret`) {
  return {
    providerId: provider.id,
    baseUrl: provider.baseUrl,
    allowInsecureHttp: provider.allowInsecureHttp,
    auth: { kind: 'header', name: scope === 'probe' ? 'x-probe-token' : 'Authorization', value: secret },
    extraHeaders: [],
    authProfileRevision: provider.authProfileRevision,
  };
}

function fakeStore(provider, revision = 7) {
  let current = provider;
  let stateRevision = revision;
  const writes = [];
  return {
    writes,
    current: () => current,
    readState: () => ({ revision: stateRevision }),
    get: (id) => (id === current.id ? current : null),
    upsert(entry, options = {}) {
      writes.push({ entry, options });
      if (options.expectedRevision !== stateRevision) {
        const error = new Error('Provider store revision conflict');
        error.code = 'PROVIDER_STORE_CONFLICT';
        throw error;
      }
      current = entry;
      stateRevision += 1;
      return { entry, stateRevision };
    },
    bumpRevision() { stateRevision += 1; },
  };
}

test('detects into nested V2 state and persists with the pre-request store revision', async () => {
  const provider = providerFixture();
  const store = fakeStore(provider, 11);
  const resolver = async (entry, { scope }) => resolvedProfile(entry, scope);
  const detected = {
    wireApi: 'chat',
    baseUrl: provider.baseUrl,
    authProfileRevision: provider.authProfileRevision,
    detectedAt: 123,
    evidence: 'chat-missing-messages',
  };
  const result = await runProviderManagerProbe(provider, {
    store,
    now: () => 123,
    resolveRequestProfile: resolver,
    detectProviderDialectImpl: async (args) => {
      assert.deepEqual(args.provider, provider);
      assert.equal(args.resolveRequestProfile, resolver);
      assert.equal(Object.hasOwn(args, 'apiKey'), false);
      return { ok: true, dialect: detected, models: [{ id: 'model-1', label: 'Model 1' }], tried: [] };
    },
    probeProviderModelsImpl: async () => { throw new Error('separate probe must not run'); },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.entry.dialect, { override: null, detected });
  assert.deepEqual(result.entry.probedModels, [{ id: 'model-1', label: 'Model 1' }]);
  assert.equal(result.entry.probedAt, 123);
  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0].options.expectedRevision, 11);
});

test('a fresh effective dialect uses the resolved probe profile without detecting again', async () => {
  const nowMs = 90_000_000;
  const provider = providerFixture({
    dialect: {
      override: null,
      detected: {
        wireApi: 'responses',
        baseUrl: 'https://provider.example/v1',
        authProfileRevision: 1,
        detectedAt: nowMs - 1,
        evidence: 'responses-success-schema',
      },
    },
  });
  const store = fakeStore(provider);
  const probeSecret = 'resolved-probe-secret';
  let detectCalls = 0;
  const result = await runProviderManagerProbe(provider, {
    store,
    now: () => nowMs,
    resolveRequestProfile: async (entry, { scope }) => {
      assert.equal(scope, 'probe');
      return resolvedProfile(entry, scope, probeSecret);
    },
    detectProviderDialectImpl: async () => { detectCalls += 1; },
    probeProviderModelsImpl: async (args) => {
      assert.equal(Object.hasOwn(args, 'apiKey'), false);
      assert.equal(args.requestProfile.auth.value, probeSecret);
      return { ok: true, status: 200, models: [{ id: 'cached-wire-model', label: 'Cached Wire Model' }], detail: '' };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(detectCalls, 0);
  assert.deepEqual(result.entry.dialect, provider.dialect);
  assert.deepEqual(result.entry.probedModels, [{ id: 'cached-wire-model', label: 'Cached Wire Model' }]);
  assert.equal(JSON.stringify(result).includes(probeSecret), false);
});

test('force detection preserves an explicit override and only refreshes detected cache', async () => {
  const provider = providerFixture({
    dialect: {
      override: { wireApi: 'responses', source: 'ccswitch-import', updatedAt: 5 },
      detected: null,
    },
  });
  const detected = {
    wireApi: 'chat',
    baseUrl: provider.baseUrl,
    authProfileRevision: 1,
    detectedAt: 10,
    evidence: 'chat-success-schema',
  };
  const result = await runProviderManagerProbe(provider, {
    forceDetect: true,
    now: () => 10,
    resolveRequestProfile: async (entry, { scope }) => resolvedProfile(entry, scope),
    detectProviderDialectImpl: async () => ({ ok: true, dialect: detected, models: [], tried: [] }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.entry.dialect, {
    override: provider.dialect.override,
    detected,
  });
});

test('detection failure leaves the prior nested dialect and store untouched', async () => {
  const provider = providerFixture({
    dialect: {
      override: null,
      detected: {
        wireApi: 'responses',
        baseUrl: 'https://old.example/v1',
        authProfileRevision: 1,
        detectedAt: 1,
        evidence: 'responses-success-schema',
      },
    },
  });
  const store = fakeStore(provider);
  const result = await runProviderManagerProbe(provider, {
    store,
    forceDetect: true,
    resolveRequestProfile: async (entry, { scope }) => resolvedProfile(entry, scope),
    detectProviderDialectImpl: async () => ({
      ok: false,
      reason: 'dialect-incompatible',
      detail: 'Provider did not expose a verified wire API',
      tried: [],
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'dialect-incompatible');
  assert.deepEqual(store.current().dialect, provider.dialect);
  assert.equal(store.writes.length, 0);
});

test('anthropic providers skip dialect detection and probe with their resolved profile', async () => {
  const provider = providerFixture({ protocol: 'anthropic' });
  const store = fakeStore(provider);
  const probeSecret = 'anthropic-probe-secret';
  let detectCalls = 0;
  const result = await runProviderManagerProbe(provider, {
    store,
    now: () => 500,
    resolveRequestProfile: async (entry, { scope }) => resolvedProfile(entry, scope, probeSecret),
    detectProviderDialectImpl: async () => { detectCalls += 1; },
    probeProviderModelsImpl: async ({ requestProfile }) => {
      assert.equal(requestProfile.auth.value, probeSecret);
      return { ok: true, status: 200, models: [{ id: 'claude-model', label: 'Claude Model' }], detail: '' };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(detectCalls, 0);
  assert.equal(JSON.stringify(result).includes(probeSecret), false);
  assert.deepEqual(result.entry.probedModels, [{ id: 'claude-model', label: 'Claude Model' }]);
});

test('a concurrent store mutation fails CAS instead of overwriting provider configuration', async () => {
  const provider = providerFixture();
  const store = fakeStore(provider, 3);
  await assert.rejects(
    runProviderManagerProbe(provider, {
      store,
      resolveRequestProfile: async (entry, { scope }) => resolvedProfile(entry, scope),
      detectProviderDialectImpl: async () => {
        store.bumpRevision();
        return {
          ok: true,
          dialect: {
            wireApi: 'responses',
            baseUrl: provider.baseUrl,
            authProfileRevision: 1,
            detectedAt: 20,
            evidence: 'responses-success-schema',
          },
          models: [],
          tried: [],
        };
      },
    }),
    (error) => error?.code === 'PROVIDER_STORE_CONFLICT',
  );
});
