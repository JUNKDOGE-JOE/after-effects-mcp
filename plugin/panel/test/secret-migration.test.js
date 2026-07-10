import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSecretMigrationRunner } from '../src/cep/platform/secret-migration.js';

const MIGRATION_ID = 'provider-secrets-v2';
const SOURCE_REVISION = '4f15f251b51f06e4b449afd6558f8d47e7721f48ca578e8cbcc8f641f17703c4';
const PROVIDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REFERENCE = `aemcp-secret://provider/${PROVIDER_ID}/api-key/v1`;
const INITIAL_PHASE_OBSERVER = Symbol.for(
  'com.junkdoge.ae-mcp.secret-migration.initial-phase',
);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function crashError(phase, timing) {
  const error = new Error(`simulated ${timing}-persist crash at ${phase}`);
  error.code = 'SIMULATED_CRASH';
  return error;
}

function makeMigrationHarness({
  failAfterPhase = null,
  failBeforePhase = null,
  failBeforePendingWriteNumber = null,
  secret = 'never-write-this',
  initialSecret,
  readbackValue,
  initialJournal = null,
  initialPhaseObserver = null,
} = {}) {
  let journal = initialJournal ? clone(initialJournal) : null;
  let failed = false;
  let pendingWriteCount = 0;
  let clock = 1783612800000;
  let legacyPresent = true;
  const journalWrites = [];
  const backupCalls = [];
  const stateCalls = [];
  const cleanupCalls = [];
  const callbackReceiverText = [];
  const logs = [];
  const setCalls = [];
  const getCalls = [];
  const records = new Map();

  if (initialSecret !== undefined) {
    records.set(REFERENCE, { value: initialSecret, revision: 1 });
  }

  const journalStore = {
    async read(migrationId) {
      assert.equal(migrationId, MIGRATION_ID);
      return journal ? clone(journal) : null;
    },
    async writeAtomic(next) {
      if (next.phase === 'pending') pendingWriteCount += 1;
      const failBefore = !failed && (
        next.phase === failBeforePhase
        || (next.phase === 'pending' && pendingWriteCount === failBeforePendingWriteNumber)
      );
      if (failBefore) {
        failed = true;
        throw crashError(next.phase, 'before');
      }

      const persisted = clone(next);
      journal = persisted;
      journalWrites.push(JSON.stringify(persisted));
      if (!failed && next.phase === failAfterPhase) {
        failed = true;
        throw crashError(next.phase, 'after');
      }
    },
  };

  const secretStore = {
    async get(reference) {
      getCalls.push(reference);
      const record = records.get(reference);
      if (!record) {
        const error = new Error('Secret is unavailable');
        error.code = 'SECRET_NOT_FOUND';
        throw error;
      }
      return {
        reference,
        value: readbackValue === undefined ? record.value : readbackValue,
        revision: record.revision,
      };
    },
    async set(input) {
      setCalls.push(clone(input));
      assert.equal(input.expectedRevision, null);
      if (records.has(input.reference)) {
        const error = new Error('Secret already exists');
        error.code = 'SECRET_CONFLICT';
        throw error;
      }
      const record = { value: input.value, revision: 1 };
      records.set(input.reference, record);
      return { reference: input.reference, revision: record.revision };
    },
    async delete({ reference, expectedRevision } = {}) {
      const record = records.get(reference);
      if (!record) return { deleted: false, revision: null };
      if (expectedRevision !== undefined && expectedRevision !== record.revision) {
        const error = new Error('Secret revision conflict');
        error.code = 'SECRET_CONFLICT';
        throw error;
      }
      records.delete(reference);
      return { deleted: true, revision: record.revision };
    },
  };

  const plan = {
    migrationId: MIGRATION_ID,
    sourceRevision: SOURCE_REVISION,
    entries: [{ id: `${PROVIDER_ID}:api-key`, reference: REFERENCE, legacyValue: secret }],
    async writeRedactedBackup(...args) {
      callbackReceiverText.push(this === undefined ? '' : JSON.stringify(this));
      backupCalls.push({ argumentCount: args.length, kind: 'redacted-backup' });
      logs.push('redacted backup written');
    },
    async commitRedactedState(entries, ...rest) {
      callbackReceiverText.push(this === undefined ? '' : JSON.stringify(this));
      stateCalls.push({
        argumentCount: 1 + rest.length,
        entries: clone(entries),
      });
      logs.push('redacted state committed');
    },
    async cleanupLegacyState(...args) {
      callbackReceiverText.push(this === undefined ? '' : JSON.stringify(this));
      const deleted = legacyPresent;
      legacyPresent = false;
      cleanupCalls.push({ argumentCount: args.length, deleted });
      logs.push(deleted ? 'legacy state deleted' : 'legacy state already absent');
    },
  };
  if (initialPhaseObserver) plan[INITIAL_PHASE_OBSERVER] = initialPhaseObserver;

  const runner = createSecretMigrationRunner({
    journalStore,
    secretStore,
    now: () => clock++,
  });

  return {
    plan,
    runner,
    journalWrites,
    backupCalls,
    stateCalls,
    cleanupCalls,
    callbackReceiverText,
    logs,
    setCalls,
    getCalls,
    records,
    firstRun: () => runner.run(plan),
    secondRun: () => runner.run(plan),
    currentJournal: () => (journal ? clone(journal) : null),
    allPersistedText() {
      return JSON.stringify({
        journalWrites,
        backupCalls,
        stateCalls,
        cleanupCalls,
        callbackReceiverText,
        logs,
      });
    },
  };
}

function assertJournalShape(serialized) {
  const journal = JSON.parse(serialized);
  assert.deepEqual(Object.keys(journal).sort(), [
    'entries', 'migrationId', 'phase', 'schemaVersion', 'sourceRevision', 'updatedAt',
  ]);
  assert.equal(journal.schemaVersion, 1);
  assert.equal(journal.migrationId, MIGRATION_ID);
  assert.equal(journal.sourceRevision, SOURCE_REVISION);
  for (const entry of journal.entries) {
    assert.deepEqual(Object.keys(entry).sort(), ['id', 'reference', 'revision']);
  }
}

function assertNoSecretPersistence(harness, ...secrets) {
  const persisted = harness.allPersistedText();
  for (const secret of secrets) {
    assert.doesNotMatch(persisted, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(persisted.includes(digest(secret)), false);
  }
  for (const journal of harness.journalWrites) assertJournalShape(journal);
}

test('migration resumes every persisted phase without serializing a secret or secret hash', async () => {
  for (const phase of ['pending', 'secrets-written', 'state-committed', 'committed']) {
    const secret = `never-write-this-${phase}`;
    const observerSecret = `observer-secret-${phase}`;
    const observedInitialPhases = [];
    const harness = makeMigrationHarness({
      failAfterPhase: phase,
      secret,
      initialPhaseObserver: (initialPhase) => {
        assert.equal(observerSecret.startsWith('observer-secret-'), true);
        observedInitialPhases.push(initialPhase);
      },
    });

    assert.deepEqual(Reflect.ownKeys(harness.runner), ['run']);

    await assert.rejects(harness.firstRun(), { code: 'SIMULATED_CRASH' });
    const resumed = await harness.secondRun();

    assert.equal(resumed.status, 'committed');
    assert.equal(resumed.migrationId, MIGRATION_ID);
    assert.deepEqual(resumed.entries, [{
      id: `${PROVIDER_ID}:api-key`,
      reference: REFERENCE,
      revision: 1,
    }]);
    assert.equal(harness.currentJournal().phase, 'committed');
    assert.equal(harness.backupCalls.every((call) => call.argumentCount === 0), true);
    assert.equal(harness.stateCalls.every((call) => call.argumentCount === 1), true);
    assert.equal(harness.cleanupCalls.every((call) => call.argumentCount === 0), true);
    assert.deepEqual(observedInitialPhases, ['pending', phase]);
    assert.deepEqual(Object.getOwnPropertySymbols(harness.currentJournal()), []);
    assertNoSecretPersistence(harness, secret, observerSecret);
  }
});

test('a crash after create-only write resumes through exact protected-value readback', async () => {
  const secret = 'create-then-crash-secret';
  const harness = makeMigrationHarness({
    failBeforePendingWriteNumber: 2,
    secret,
  });

  await assert.rejects(harness.firstRun(), { code: 'SIMULATED_CRASH' });
  const resumed = await harness.secondRun();

  assert.equal(resumed.status, 'committed');
  assert.equal(harness.setCalls.length, 2);
  assert.equal(harness.setCalls.every((call) => call.expectedRevision === null), true);
  assert.equal(harness.getCalls.length, 2);
  assertNoSecretPersistence(harness, secret);
});

test('a create-only conflict resumes only when the protected value exactly matches memory', async () => {
  const matching = makeMigrationHarness({
    secret: 'same-in-memory-value',
    initialSecret: 'same-in-memory-value',
  });
  const result = await matching.firstRun();
  assert.equal(result.status, 'committed');
  assert.equal(matching.setCalls.length, 1);
  assert.equal(matching.getCalls.length, 1);
  assertNoSecretPersistence(matching, 'same-in-memory-value');

  const stale = makeMigrationHarness({
    secret: 'new-in-memory-value',
    initialSecret: 'stale-protected-value',
  });
  await assert.rejects(
    stale.firstRun(),
    (error) => {
      assert.equal(error.code, 'SECRET_CONFLICT');
      const text = JSON.stringify({ name: error.name, code: error.code, message: error.message });
      assert.equal(text.includes('new-in-memory-value'), false);
      assert.equal(text.includes('stale-protected-value'), false);
      assert.equal(text.includes(digest('new-in-memory-value')), false);
      assert.equal(text.includes(digest('stale-protected-value')), false);
      return true;
    },
  );
  assert.equal(stale.backupCalls.length, 0);
  assert.equal(stale.stateCalls.length, 0);
  assert.equal(stale.cleanupCalls.length, 0);
  assertNoSecretPersistence(stale, 'new-in-memory-value', 'stale-protected-value');
});

test('every successful create is read back and a mismatched value fails closed', async () => {
  const harness = makeMigrationHarness({
    secret: 'expected-protected-value',
    readbackValue: 'unexpected-protected-value',
  });

  await assert.rejects(
    harness.firstRun(),
    (error) => error instanceof Error && error.code === 'SECRET_CONFLICT',
  );
  assert.equal(harness.setCalls.length, 1);
  assert.equal(harness.getCalls.length, 1);
  assert.equal(harness.currentJournal().phase, 'pending');
  assert.deepEqual(harness.currentJournal().entries, []);
  assert.equal(harness.backupCalls.length, 0);
  assertNoSecretPersistence(harness, 'expected-protected-value', 'unexpected-protected-value');
});

test('legacy cleanup is safe to retry when the committed marker write crashes', async () => {
  const secret = 'cleanup-retry-secret';
  const harness = makeMigrationHarness({ failBeforePhase: 'committed', secret });

  await assert.rejects(harness.firstRun(), { code: 'SIMULATED_CRASH' });
  assert.equal(harness.currentJournal().phase, 'state-committed');
  const resumed = await harness.secondRun();

  assert.equal(resumed.status, 'committed');
  assert.deepEqual(harness.cleanupCalls.map((call) => call.deleted), [true, false]);
  assert.equal(harness.currentJournal().phase, 'committed');
  assertNoSecretPersistence(harness, secret);
});

test('a journal for another source revision fails closed before any secret or state access', async () => {
  const harness = makeMigrationHarness({
    initialJournal: {
      schemaVersion: 1,
      migrationId: MIGRATION_ID,
      sourceRevision: 'different-source-revision',
      phase: 'pending',
      entries: [],
      updatedAt: 1,
    },
  });

  await assert.rejects(
    harness.firstRun(),
    (error) => error instanceof Error && error.code === 'INVALID_MIGRATION_JOURNAL',
  );
  assert.equal(harness.setCalls.length, 0);
  assert.equal(harness.getCalls.length, 0);
  assert.equal(harness.backupCalls.length, 0);
  assert.equal(harness.stateCalls.length, 0);
  assert.equal(harness.cleanupCalls.length, 0);
});
