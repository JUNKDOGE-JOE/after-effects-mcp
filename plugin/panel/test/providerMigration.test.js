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

function makeHarness({
  initialPhase = null,
  failBeforeJournalPhase = null,
  failAfterJournalPhase = null,
  embedLegacySecretOutsideSecret = false,
  embeddedLegacySecretValue = null,
  marker = 'sk-legacy-marker',
  anthropicMarker = 'sk-ant-legacy-marker',
} = {}) {
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
  if (embedLegacySecretOutsideSecret) {
    legacyState.providers[0].name = marker;
    legacyState.providers[0].probedModels[0].label = marker;
  }
  if (embeddedLegacySecretValue !== null) {
    legacyState.providers[0].name = embeddedLegacySecretValue(marker);
    legacyState.providers[0].probedModels[0].label = embeddedLegacySecretValue(marker);
  }
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
  let replaceOptions = null;
  let failed = false;
  const secretSetCalls = [];
  const secretGetCalls = [];
  const records = new Map();
  if (initialPhase !== null && initialPhase !== 'pending') {
    legacyState.providers.forEach((provider, index) => {
      records.set(journalEntries[index].reference, { value: provider.apiKey, revision: 1 });
    });
  }

  const journalStore = {
    async read() { return journal ? clone(journal) : null; },
    async writeAtomic(next) {
      if (!failed && next.phase === failBeforeJournalPhase) {
        failed = true;
        const error = new Error(`simulated crash before ${next.phase}`);
        error.code = 'SIMULATED_CRASH';
        throw error;
      }
      journal = clone(next);
      if (!failed && next.phase === failAfterJournalPhase) {
        failed = true;
        const error = new Error(`simulated crash after ${next.phase}`);
        error.code = 'SIMULATED_CRASH';
        throw error;
      }
    },
    snapshot() { return journal ? clone(journal) : null; },
    setSnapshot(next) { journal = next ? clone(next) : null; },
  };
  const secretStore = {
    async set(input) {
      secretSetCalls.push(clone(input));
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
      secretGetCalls.push(reference);
      const record = records.get(reference);
      if (!record) {
        const error = new Error('missing');
        error.code = 'SECRET_NOT_FOUND';
        throw error;
      }
      return { reference, value: record.value, revision: record.revision };
    },
    async secretGet(reference) {
      secretGetCalls.push(reference);
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
    readState() {
      if (!committedState) throw new Error('provider v2 state is unavailable');
      return clone(committedState);
    },
    async writeRedactedBackup(state, policy) {
      backupCalls += 1;
      redactedBackup = clone(state);
      backupPolicy = clone(policy);
    },
    replaceState(state, options) {
      commitCalls += 1;
      replaceOptions = options === undefined ? null : clone(options);
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
    replaceOptions: () => (replaceOptions === null ? null : clone(replaceOptions)),
    secretSetCalls: () => clone(secretSetCalls),
    secretGetCalls: () => clone(secretGetCalls),
    mutateCommittedState(mutator) {
      const next = clone(committedState);
      mutator(next);
      committedState = next;
    },
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
  assert.deepEqual(harness.replaceOptions(), { expectedSourceRevision: 'mtime:1783612800000:size:412' });
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

test('provider migration resumes cleanup when v2 state won the crash race against the generic journal', async () => {
  for (const crash of [
    { failBeforeJournalPhase: 'state-committed', expectedPhase: 'secrets-written' },
    { failAfterJournalPhase: 'state-committed', expectedPhase: 'state-committed' },
  ]) {
    const harness = makeHarness(crash);
    await assert.rejects(
      migrateProviderStoreSecrets({
        store: harness.store,
        legacyKeyStore: harness.legacyKeyStore,
        runner: harness.runner,
        secretStore: harness.secretStore,
        legacyCredentialId: NAMESPACE_ID,
      }),
      (error) => error.code === 'SIMULATED_CRASH',
    );
    assert.equal(harness.journalStore.snapshot().phase, crash.expectedPhase);
    const secretReadsBeforeRecovery = harness.secretGetCalls().length;
    const secretWritesBeforeRecovery = harness.secretSetCalls().length;
    const backupCallsBeforeRecovery = harness.backupCalls();
    const commitCallsBeforeRecovery = harness.commitCalls();

    const resumed = await migrateProviderStoreSecrets({
      store: harness.store,
      legacyKeyStore: harness.legacyKeyStore,
      runner: harness.runner,
      secretStore: harness.secretStore,
      legacyCredentialId: NAMESPACE_ID,
    });

    assert.deepEqual(resumed, {
      status: 'committed',
      written: 2,
      resumedFrom: crash.expectedPhase,
    });
    assert.equal(harness.journalStore.snapshot().phase, 'committed');
    assert.equal(harness.cleanupCalls(), 1);
    assert.equal(harness.backupCalls(), backupCallsBeforeRecovery);
    assert.equal(harness.commitCalls(), commitCallsBeforeRecovery);
    assert.equal(harness.secretGetCalls().length, secretReadsBeforeRecovery);
    assert.equal(harness.secretSetCalls().length, secretWritesBeforeRecovery);
    for (const marker of [harness.marker, harness.anthropicMarker]) {
      const serialized = JSON.stringify({
        journal: harness.journalStore.snapshot(),
        state: harness.committedState(),
        resumed,
      });
      assert.equal(serialized.includes(marker), false);
      assert.equal(serialized.includes(createHash('sha256').update(marker).digest('hex')), false);
    }
  }
});

test('provider crash recovery fails closed for pending journals and v2 reference mismatches', async () => {
  const pending = makeHarness({ failBeforeJournalPhase: 'state-committed' });
  await assert.rejects(migrateProviderStoreSecrets({
    store: pending.store,
    legacyKeyStore: pending.legacyKeyStore,
    runner: pending.runner,
    secretStore: pending.secretStore,
    legacyCredentialId: NAMESPACE_ID,
  }), { code: 'SIMULATED_CRASH' });
  pending.journalStore.setSnapshot({
    ...pending.journalStore.snapshot(),
    phase: 'pending',
    entries: [],
  });
  await assert.rejects(
    migrateProviderStoreSecrets({
      store: pending.store,
      legacyKeyStore: pending.legacyKeyStore,
      runner: pending.runner,
      secretStore: pending.secretStore,
      legacyCredentialId: NAMESPACE_ID,
    }),
    (error) => {
      assert.equal(error.code, 'INVALID_PROVIDER_MIGRATION');
      assert.equal(error.message.includes(pending.marker), false);
      return true;
    },
  );
  assert.equal(pending.cleanupCalls(), 0);

  const mismatch = makeHarness({ failBeforeJournalPhase: 'state-committed' });
  await assert.rejects(migrateProviderStoreSecrets({
    store: mismatch.store,
    legacyKeyStore: mismatch.legacyKeyStore,
    runner: mismatch.runner,
    secretStore: mismatch.secretStore,
    legacyCredentialId: NAMESPACE_ID,
  }), { code: 'SIMULATED_CRASH' });
  mismatch.mutateCommittedState((state) => {
    state.providers[0].auth.model.valueRef.revision += 1;
  });
  await assert.rejects(
    migrateProviderStoreSecrets({
      store: mismatch.store,
      legacyKeyStore: mismatch.legacyKeyStore,
      runner: mismatch.runner,
      secretStore: mismatch.secretStore,
      legacyCredentialId: NAMESPACE_ID,
    }),
    (error) => {
      assert.equal(error.code, 'INVALID_PROVIDER_MIGRATION');
      assert.equal(error.message.includes(mismatch.marker), false);
      return true;
    },
  );
  assert.equal(mismatch.journalStore.snapshot().phase, 'secrets-written');
  assert.equal(mismatch.cleanupCalls(), 0);
});

test('a committed journal accepts any subsequently edited strict v2 state without comparing migration entries', async () => {
  const mutations = [
    (state) => {
      const provider = state.providers[0];
      const oldRef = clone(provider.auth.model.valueRef);
      provider.name = 'Edited after migration';
      provider.authProfileRevision += 1;
      provider.auth.model.valueRef = {
        kind: 'secret',
        reference: `aemcp-secret://provider/${provider.credentialId}/auth-model-edited/v1`,
        revision: 2,
      };
      state.pendingSecretDeletes = [oldRef];
      state.revision += 1;
    },
    (state) => {
      const credentialId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      state.providers.push({
        ...clone(state.providers[0]),
        id: 'added-after-migration',
        credentialId,
        name: 'Added after migration',
        auth: {
          model: {
            kind: 'bearer',
            valueRef: {
              kind: 'secret',
              reference: `aemcp-secret://provider/${credentialId}/auth-model-added/v1`,
              revision: 1,
            },
          },
          probe: { kind: 'inherit-model' },
        },
      });
      state.revision += 1;
    },
    (state) => {
      const removed = state.providers.pop();
      state.pendingSecretDeletes = [removed.auth.model.valueRef];
      state.revision += 1;
    },
  ];

  for (const mutate of mutations) {
    const harness = makeHarness();
    await migrateProviderStoreSecrets({
      store: harness.store,
      legacyKeyStore: harness.legacyKeyStore,
      runner: harness.runner,
      secretStore: harness.secretStore,
      legacyCredentialId: NAMESPACE_ID,
    });
    harness.mutateCommittedState(mutate);
    const cleanupBeforeRestart = harness.cleanupCalls();
    const result = await migrateProviderStoreSecrets({
      store: harness.store,
      legacyKeyStore: harness.legacyKeyStore,
      runner: harness.runner,
      secretStore: harness.secretStore,
      legacyCredentialId: NAMESPACE_ID,
    });
    assert.deepEqual(result, { status: 'already-committed', written: 0, resumedFrom: 'committed' });
    assert.equal(harness.cleanupCalls(), cleanupBeforeRestart);
  }
});

test('a committed journal only reads strict v2 state and does not require a cleanup callback', async () => {
  const harness = makeHarness();
  await migrateProviderStoreSecrets({
    store: harness.store,
    legacyKeyStore: harness.legacyKeyStore,
    runner: harness.runner,
    secretStore: harness.secretStore,
    legacyCredentialId: NAMESPACE_ID,
  });
  const result = await migrateProviderStoreSecrets({
    store: harness.store,
    legacyKeyStore: {},
    runner: harness.runner,
    secretStore: harness.secretStore,
    legacyCredentialId: NAMESPACE_ID,
  });
  assert.deepEqual(result, { status: 'already-committed', written: 0, resumedFrom: 'committed' });
});

test('a committed journal validates v2 through the schema-migration reader when public readState is v3-only', async () => {
  const harness = makeHarness();
  await migrateProviderStoreSecrets({
    store: harness.store,
    legacyKeyStore: harness.legacyKeyStore,
    runner: harness.runner,
    secretStore: harness.secretStore,
    legacyCredentialId: NAMESPACE_ID,
  });
  let publicReads = 0;
  const store = {
    ...harness.store,
    readState() {
      publicReads += 1;
      const error = new Error('Provider store migration is required');
      error.code = 'PROVIDER_STORE_MIGRATION_REQUIRED';
      throw error;
    },
    readSchemaMigrationInput() {
      return { sourceRevision: 'v2-file-identity', state: harness.committedState() };
    },
  };
  const result = await migrateProviderStoreSecrets({
    store,
    legacyKeyStore: {},
    runner: harness.runner,
    secretStore: harness.secretStore,
    legacyCredentialId: NAMESPACE_ID,
  });
  assert.deepEqual(result, { status: 'already-committed', written: 0, resumedFrom: 'committed' });
  assert.equal(publicReads, 0);
});

test('provider migration rejects an exact legacy secret copied into any non-secret persisted field', async () => {
  const harness = makeHarness({ embedLegacySecretOutsideSecret: true });
  await assert.rejects(
    migrateProviderStoreSecrets({
      store: harness.store,
      legacyKeyStore: harness.legacyKeyStore,
      runner: harness.runner,
      secretStore: harness.secretStore,
      legacyCredentialId: NAMESPACE_ID,
    }),
    (error) => error.code === 'SECRET_CONFLICT' || error.code === 'INVALID_PROVIDER_MIGRATION',
  );
  assert.equal(harness.cleanupCalls(), 0);
  assert.equal(JSON.stringify(harness.redactedBackup()).includes(harness.marker), false);
  assert.equal(JSON.stringify(harness.committedState()).includes(harness.marker), false);
});

test('provider migration rejects raw substring and bounded percent-encoded legacy-secret embeddings', async () => {
  const encoders = [
    (secret) => `display-${secret}-suffix`,
    (secret) => `display-${Array.from(Buffer.from(secret, 'utf8'), (byte) => `%${byte.toString(16).padStart(2, '0')}`).join('')}-suffix`,
    (secret) => `display-${Array.from(Buffer.from(encodeURIComponent(secret), 'utf8'), (byte) => `%25${byte.toString(16).padStart(2, '0')}`).join('')}-suffix`,
  ];
  for (const embeddedLegacySecretValue of encoders) {
    const harness = makeHarness({ embeddedLegacySecretValue });
    await assert.rejects(
      migrateProviderStoreSecrets({
        store: harness.store,
        legacyKeyStore: harness.legacyKeyStore,
        runner: harness.runner,
        secretStore: harness.secretStore,
        legacyCredentialId: NAMESPACE_ID,
      }),
      (error) => {
        assert.ok(error.code === 'SECRET_CONFLICT' || error.code === 'INVALID_PROVIDER_MIGRATION');
        assert.equal(error.message.includes(harness.marker), false);
        return true;
      },
    );
    assert.equal(harness.commitCalls(), 0);
    assert.equal(harness.cleanupCalls(), 0);
  }
});

test('provider migration does not treat every occurrence of a short legacy secret as an embedded credential', async () => {
  const harness = makeHarness({ marker: 'a', anthropicMarker: 'b' });
  const result = await migrateProviderStoreSecrets({
    store: harness.store,
    legacyKeyStore: harness.legacyKeyStore,
    runner: harness.runner,
    secretStore: harness.secretStore,
    legacyCredentialId: NAMESPACE_ID,
  });
  assert.equal(result.status, 'committed');
  assert.equal(harness.committedState().providers[0].name, 'Legacy Relay');
  assert.equal(harness.committedState().providers[1].name, 'Legacy Anthropic');
});

test('provider migration still rejects an exact short secret copied into a persisted field', async () => {
  const harness = makeHarness({
    marker: 'a',
    anthropicMarker: 'b',
    embedLegacySecretOutsideSecret: true,
  });
  await assert.rejects(
    migrateProviderStoreSecrets({
      store: harness.store,
      legacyKeyStore: harness.legacyKeyStore,
      runner: harness.runner,
      secretStore: harness.secretStore,
      legacyCredentialId: NAMESPACE_ID,
    }),
    (error) => error.code === 'SECRET_CONFLICT' || error.code === 'INVALID_PROVIDER_MIGRATION',
  );
});

test('provider migration measures the embedded-secret threshold in UTF-8 bytes', async () => {
  const marker = '密钥密钥';
  const harness = makeHarness({
    marker,
    anthropicMarker: 'another-safe-secret',
    embeddedLegacySecretValue: (secret) => `display-${secret}-suffix`,
  });
  await assert.rejects(
    migrateProviderStoreSecrets({
      store: harness.store,
      legacyKeyStore: harness.legacyKeyStore,
      runner: harness.runner,
      secretStore: harness.secretStore,
      legacyCredentialId: NAMESPACE_ID,
    }),
    (error) => error.code === 'SECRET_CONFLICT' || error.code === 'INVALID_PROVIDER_MIGRATION',
  );
});
