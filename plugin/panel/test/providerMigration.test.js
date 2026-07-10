import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { migrateProviderStoreSecrets } from '../src/cep/providerMigration.js';
import { createSecretMigrationRunner } from '../src/cep/platform/secret-migration.js';

const NAMESPACE_ID = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function uuidBytes(value) {
  return Buffer.from(value.replaceAll('-', ''), 'hex');
}

function expectedUuidV5(name, namespace) {
  const digest = createHash('sha1')
    .update(Buffer.concat([uuidBytes(namespace), Buffer.from(name, 'utf8')]))
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function makeHarness({ initialPhase = null } = {}) {
  const marker = 'sk-legacy-marker';
  const anthropicMarker = 'sk-ant-legacy-marker';
  const legacyState = {
    version: 1,
    migratedLegacy: true,
    providers: [{
      id: 'legacy-relay',
      name: 'Legacy Relay',
      protocol: 'openai-compatible',
      baseUrl: 'https://relay.example/openai/',
      apiKey: marker,
      probedModels: [{ id: 'legacy-model', label: 'Legacy model' }],
      probedAt: 1783612800000,
    }, {
      id: 'legacy-anthropic',
      name: 'Legacy Anthropic',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: anthropicMarker,
      probedModels: [],
      probedAt: 0,
    }],
  };
  let legacyInput = {
    sourceRevision: 'mtime:1783612800000:size:412',
    state: clone(legacyState),
  };
  const journalEntries = legacyState.providers.map((provider) => {
    const credentialId = expectedUuidV5(provider.id, NAMESPACE_ID);
    return {
      id: `${provider.id}:auth-model`,
      reference: `aemcp-secret://provider/${credentialId}/auth-model/v1`,
      revision: 1,
    };
  });
  let journal = initialPhase === null ? null : {
    schemaVersion: 1,
    migrationId: 'provider-store-v1-to-v2',
    sourceRevision: legacyInput.sourceRevision,
    phase: initialPhase,
    entries: initialPhase === 'pending' ? [] : clone(journalEntries),
    updatedAt: 1783612800050,
  };
  let redactedBackup = null;
  let committedState = null;
  let backupPolicy = null;
  let cleanupCalls = 0;
  let backupCalls = 0;
  let commitCalls = 0;
  const records = new Map();
  if (initialPhase !== null && initialPhase !== 'pending') {
    legacyState.providers.forEach((provider, index) => {
      records.set(journalEntries[index].reference, { value: provider.apiKey, revision: 1 });
    });
  }

  const journalStore = {
    async read() { return journal ? clone(journal) : null; },
    async writeAtomic(next) { journal = clone(next); },
    snapshot() { return journal ? clone(journal) : null; },
  };
  const secretStore = {
    async set(input) {
      assert.equal(input.expectedRevision, null);
      if (records.has(input.reference)) {
        const error = new Error('already exists');
        error.code = 'SECRET_CONFLICT';
        throw error;
      }
      records.set(input.reference, { value: input.value, revision: 1 });
      return { reference: input.reference, revision: 1 };
    },
    async get(reference) {
      const record = records.get(reference);
      if (!record) {
        const error = new Error('missing');
        error.code = 'SECRET_NOT_FOUND';
        throw error;
      }
      return { reference, value: record.value, revision: record.revision };
    },
    async secretGet(reference) {
      const record = records.get(reference);
      if (!record) {
        const error = new Error('missing');
        error.code = 'SECRET_NOT_FOUND';
        throw error;
      }
      return { reference, value: record.value, revision: record.revision };
    },
  };
  const store = {
    readLegacyMigrationInput() { return legacyInput ? clone(legacyInput) : null; },
    async writeRedactedBackup(state, policy) {
      backupCalls += 1;
      redactedBackup = clone(state);
      backupPolicy = clone(policy);
    },
    replaceState(state) {
      commitCalls += 1;
      committedState = clone(state);
      legacyInput = null;
      return { stateRevision: state.revision };
    },
  };
  const legacyKeyStore = {
    readKey() { return ''; },
    async cleanupCommittedProviderSecrets() { cleanupCalls += 1; },
  };
  const runner = createSecretMigrationRunner({
    journalStore,
    secretStore,
    now: (() => {
      let clock = 1783612800100;
      return () => clock++;
    })(),
  });

  return {
    marker,
    anthropicMarker,
    legacyState,
    journalStore,
    secretStore,
    store,
    legacyKeyStore,
    runner,
    redactedBackup: () => redactedBackup,
    committedState: () => committedState,
    backupPolicy: () => backupPolicy,
    cleanupCalls: () => cleanupCalls,
    backupCalls: () => backupCalls,
    commitCalls: () => commitCalls,
  };
}

test('provider migration uses UUIDv5 references and persists only redacted backup, state, and journal', async () => {
  const harness = makeHarness();

  const result = await migrateProviderStoreSecrets({
    store: harness.store,
    legacyKeyStore: harness.legacyKeyStore,
    runner: harness.runner,
    secretStore: harness.secretStore,
    now: () => 1783612800200,
    legacyCredentialId: NAMESPACE_ID,
  });

  assert.deepEqual(result, { status: 'committed', written: 2, resumedFrom: 'pending' });
  assert.match(JSON.stringify(harness.legacyState), /sk-legacy-marker/);
  assert.match(JSON.stringify(harness.legacyState), /sk-ant-legacy-marker/);
  for (const marker of [harness.marker, harness.anthropicMarker]) {
    assert.equal(JSON.stringify(harness.redactedBackup()).includes(marker), false);
    assert.equal(JSON.stringify(harness.committedState()).includes(marker), false);
    assert.equal(JSON.stringify(harness.journalStore.snapshot()).includes(marker), false);
    const hash = createHash('sha256').update(marker).digest('hex');
    assert.equal(JSON.stringify(harness.redactedBackup()).includes(hash), false);
    assert.equal(JSON.stringify(harness.committedState()).includes(hash), false);
    assert.equal(JSON.stringify(harness.journalStore.snapshot()).includes(hash), false);
  }
  const markerHash = createHash('sha256').update(harness.marker).digest('hex');

  assert.deepEqual(harness.backupPolicy(), { keep: 3, maxAgeDays: 30 });
  assert.deepEqual(harness.redactedBackup(), harness.committedState());
  assert.equal(harness.committedState().version, 2);
  assert.equal(harness.committedState().migratedLegacy, true);
  assert.deepEqual(harness.committedState().pendingSecretDeletes, []);
  assert.deepEqual(Object.keys(harness.committedState()).sort(), [
    'migratedLegacy', 'pendingSecretDeletes', 'providers', 'revision', 'version',
  ]);
  assert.equal(harness.committedState().providers[0].auth.model.valueRef.kind, 'secret');
  assert.equal(harness.committedState().providers[0].auth.model.valueRef.revision, 1);
  assert.equal(harness.committedState().providers[0].baseUrl, 'https://relay.example/openai');
  assert.equal(harness.committedState().providers[0].auth.model.kind, 'bearer');
  assert.equal(harness.committedState().providers[1].auth.model.kind, 'x-api-key');
  assert.equal(harness.cleanupCalls(), 1);

  const expectedCredentialId = expectedUuidV5('legacy-relay', NAMESPACE_ID);
  assert.equal(harness.committedState().providers[0].credentialId, expectedCredentialId);
  assert.equal(
    harness.committedState().providers[0].auth.model.valueRef.reference,
    `aemcp-secret://provider/${expectedCredentialId}/auth-model/v1`,
  );
  assert.equal(harness.journalStore.snapshot().sourceRevision, 'mtime:1783612800000:size:412');
  assert.notEqual(harness.journalStore.snapshot().sourceRevision, markerHash);

  const second = await migrateProviderStoreSecrets({
    store: harness.store,
    legacyKeyStore: harness.legacyKeyStore,
    runner: harness.runner,
    secretStore: harness.secretStore,
    legacyCredentialId: NAMESPACE_ID,
  });
  assert.deepEqual(second, { status: 'already-committed', written: 0, resumedFrom: 'committed' });
});

test('provider migration validates source revision before invoking the generic runner', async () => {
  let ran = false;
  const store = {
    readLegacyMigrationInput() {
      return { sourceRevision: '', state: { version: 1, providers: [] } };
    },
  };

  await assert.rejects(
    migrateProviderStoreSecrets({
      store,
      legacyKeyStore: { cleanupCommittedProviderSecrets: async () => {} },
      runner: { async run() { ran = true; } },
      secretStore: {},
      legacyCredentialId: NAMESPACE_ID,
    }),
    (error) => error instanceof Error && error.code === 'INVALID_PROVIDER_MIGRATION',
  );
  assert.equal(ran, false);
});

test('provider migration reports every exact generic runner initial phase without persisting the observer', async () => {
  for (const phase of ['pending', 'secrets-written', 'state-committed', 'committed']) {
    const harness = makeHarness({ initialPhase: phase });
    const result = await migrateProviderStoreSecrets({
      store: harness.store,
      legacyKeyStore: harness.legacyKeyStore,
      runner: harness.runner,
      secretStore: harness.secretStore,
      legacyCredentialId: NAMESPACE_ID,
    });

    assert.deepEqual(result, { status: 'committed', written: 2, resumedFrom: phase });
    assert.deepEqual(Reflect.ownKeys(harness.runner), ['run']);
    assert.deepEqual(Object.getOwnPropertySymbols(harness.journalStore.snapshot()), []);
    assert.equal(JSON.stringify(harness.journalStore.snapshot()).includes('initial-phase'), false);
    for (const marker of [harness.marker, harness.anthropicMarker]) {
      assert.equal(JSON.stringify(harness.journalStore.snapshot()).includes(marker), false);
    }

    const expectedCalls = {
      pending: [1, 1, 1],
      'secrets-written': [1, 1, 1],
      'state-committed': [0, 0, 1],
      committed: [0, 0, 0],
    }[phase];
    assert.deepEqual(
      [harness.backupCalls(), harness.commitCalls(), harness.cleanupCalls()],
      expectedCalls,
    );
  }
});
