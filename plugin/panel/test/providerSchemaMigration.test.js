import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProviderStateV3FromV2,
  migrateProviderStoreV2ToV3,
} from '../src/cep/providerSchemaMigration.js';

const CREDENTIAL_ID = '5eb75f05-5d9e-5d9c-85af-f0893e8b90c2';

function secretRef(slot, revision = 1) {
  return {
    kind: 'secret',
    reference: `aemcp-secret://provider/${CREDENTIAL_ID}/${slot}/v1`,
    revision,
  };
}

function providerV2(overrides = {}) {
  return Object.assign({
    id: 'relay',
    credentialId: CREDENTIAL_ID,
    name: 'Relay',
    protocol: 'openai-compatible',
    baseUrl: 'https://relay.example/openai',
    allowInsecureHttp: false,
    authProfileRevision: 4,
    auth: {
      model: { kind: 'bearer', valueRef: secretRef('auth-model', 7) },
      probe: { kind: 'inherit-model' },
    },
    headers: [],
    dialect: {
      override: { wireApi: 'chat', source: 'manual', updatedAt: 100 },
      detected: [{
        modelId: 'model-a',
        wireApi: 'chat',
        baseUrl: 'https://relay.example/openai',
        authProfileRevision: 4,
        detectedAt: 200,
        evidence: 'chat-success-schema',
      }],
    },
    probedModels: [{ id: 'model-a', label: 'Model A' }],
    probedAt: 300,
  }, overrides);
}

function stateV2(provider = providerV2()) {
  return {
    version: 2,
    revision: 9,
    migratedLegacy: true,
    pendingSecretDeletes: [],
    providers: [provider],
  };
}

test('v2 to v3 migration reuses opaque refs and downgrades legacy dialect to a probe preference', () => {
  const source = stateV2();
  const next = buildProviderStateV3FromV2(source);
  const provider = next.providers[0];

  assert.equal(next.version, 3);
  assert.equal(next.revision, 10);
  assert.equal(provider.requestProfileRevision, 4);
  assert.deepEqual(provider.credential.valueRef, source.providers[0].auth.model.valueRef);
  assert.equal(provider.probeAuthOverride, null);
  assert.equal(provider.probePreference, 'chat');
  assert.deepEqual(provider.modelCapabilities, []);
  assert.deepEqual(provider.routeOverrides, []);
  assert.equal(provider.modelList.apiRoot, 'https://relay.example/openai/v1');
  assert.equal(provider.modelList.auth.scheme, 'bearer');
  assert.equal(provider.modelList.validUntil, 3_600_300);
  assert.deepEqual(provider.modelList.models, [{
    id: 'model-a',
    label: 'Model A',
    metadata: {
      task: null,
      inputModalities: [],
      outputModalities: [],
      capabilities: [],
    },
  }]);
  assert.equal(Object.hasOwn(provider, 'protocol'), false);
  assert.equal(Object.hasOwn(provider, 'dialect'), false);
});

test('v2 to v3 migration preserves a distinct probe ref without resolving or copying it', async () => {
  const modelRef = secretRef('auth-model', 7);
  const probeRef = secretRef('auth-probe', 3);
  const source = stateV2(providerV2({
    auth: {
      model: { kind: 'bearer', valueRef: modelRef },
      probe: { kind: 'x-api-key', valueRef: probeRef },
    },
  }));
  let backup = null;
  let committed = null;
  let replaceOptions = null;
  const store = {
    readSchemaMigrationInput() {
      return { sourceRevision: 'file-identity-v2', state: structuredClone(source) };
    },
    async writeRedactedBackup(state, policy) {
      backup = { state: structuredClone(state), policy: structuredClone(policy) };
    },
    replaceState(state, options) {
      committed = structuredClone(state);
      replaceOptions = structuredClone(options);
      return { stateRevision: state.revision };
    },
  };

  const result = await migrateProviderStoreV2ToV3({ store });
  assert.deepEqual(result, {
    status: 'committed', migrated: 1, fromVersion: 2, toVersion: 3,
  });
  assert.deepEqual(backup.policy, { keep: 3, maxAgeDays: 30 });
  assert.equal(backup.state.version, 2);
  assert.deepEqual(replaceOptions, {
    expectedSourceRevision: 'file-identity-v2', expectedSourceVersion: 2,
  });
  assert.deepEqual(committed.providers[0].credential.valueRef, modelRef);
  assert.deepEqual(committed.providers[0].probeAuthOverride.valueRef, probeRef);
});

test('v2 to v3 migration rejects pending refs that are still active', () => {
  const source = stateV2();
  source.pendingSecretDeletes = [source.providers[0].auth.model.valueRef];
  assert.throws(
    () => buildProviderStateV3FromV2(source),
    (error) => error?.code === 'INVALID_PROVIDER_MIGRATION',
  );
});

test('v2 to v3 migration is idempotent when the store is already v3', async () => {
  const result = await migrateProviderStoreV2ToV3({
    store: {
      readSchemaMigrationInput: () => null,
      writeRedactedBackup: async () => { throw new Error('must not write'); },
      replaceState: () => { throw new Error('must not replace'); },
    },
  });
  assert.deepEqual(result, {
    status: 'already-committed', migrated: 0, fromVersion: 3, toVersion: 3,
  });
});
