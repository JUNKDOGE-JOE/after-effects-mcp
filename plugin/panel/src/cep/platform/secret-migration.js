import { parseProviderSecretReference } from './secret-reference.js';

const PHASES = new Set(['pending', 'secrets-written', 'state-committed', 'committed']);
const JOURNAL_KEYS = ['entries', 'migrationId', 'phase', 'schemaVersion', 'sourceRevision', 'updatedAt'];
const ENTRY_KEYS = ['id', 'reference', 'revision'];
const INITIAL_PHASE_OBSERVER = Symbol.for(
  'com.junkdoge.ae-mcp.secret-migration.initial-phase',
);
const JOURNAL_STORES_BY_RUNNER = new WeakMap();

function migrationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function invalidPlan() {
  return migrationError('INVALID_MIGRATION_PLAN', 'Secret migration plan is invalid');
}

function invalidJournal() {
  return migrationError('INVALID_MIGRATION_JOURNAL', 'Secret migration journal is invalid');
}

function secretConflict() {
  return migrationError('SECRET_CONFLICT', 'Secret migration conflict');
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function validRevision(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function normalizeJournalShape(value, migrationId) {
  if (!hasExactKeys(value, JOURNAL_KEYS)) throw invalidJournal();
  if (value.schemaVersion !== 1 || value.migrationId !== migrationId) throw invalidJournal();
  if (typeof value.sourceRevision !== 'string' || !value.sourceRevision) throw invalidJournal();
  if (!PHASES.has(value.phase)) throw invalidJournal();
  if (!Number.isFinite(value.updatedAt) || value.updatedAt < 0) throw invalidJournal();
  if (!Array.isArray(value.entries)) throw invalidJournal();

  const ids = new Set();
  const references = new Set();
  const entries = value.entries.map((entry) => {
    if (!hasExactKeys(entry, ENTRY_KEYS)) throw invalidJournal();
    if (typeof entry.id !== 'string' || !entry.id || !validRevision(entry.revision)) {
      throw invalidJournal();
    }
    try { parseProviderSecretReference(entry.reference); } catch { throw invalidJournal(); }
    if (ids.has(entry.id) || references.has(entry.reference)) throw invalidJournal();
    ids.add(entry.id);
    references.add(entry.reference);
    return { id: entry.id, reference: entry.reference, revision: entry.revision };
  });

  return {
    schemaVersion: 1,
    migrationId: value.migrationId,
    sourceRevision: value.sourceRevision,
    phase: value.phase,
    entries,
    updatedAt: value.updatedAt,
  };
}

function normalizePlan(plan) {
  if (!plan || typeof plan !== 'object') throw invalidPlan();
  if (typeof plan.migrationId !== 'string' || !plan.migrationId) throw invalidPlan();
  if (typeof plan.sourceRevision !== 'string' || !plan.sourceRevision) throw invalidPlan();
  if (!Array.isArray(plan.entries)) throw invalidPlan();
  for (const callback of ['writeRedactedBackup', 'commitRedactedState', 'cleanupLegacyState']) {
    if (typeof plan[callback] !== 'function') throw invalidPlan();
  }
  if (
    plan[INITIAL_PHASE_OBSERVER] !== undefined
    && typeof plan[INITIAL_PHASE_OBSERVER] !== 'function'
  ) {
    throw invalidPlan();
  }

  const ids = new Set();
  const references = new Set();
  const entries = plan.entries.map((entry) => {
    if (!entry || typeof entry !== 'object') throw invalidPlan();
    if (typeof entry.id !== 'string' || !entry.id) throw invalidPlan();
    if (typeof entry.reference !== 'string' || typeof entry.legacyValue !== 'string') throw invalidPlan();
    parseProviderSecretReference(entry.reference);
    if (ids.has(entry.id) || references.has(entry.reference)) throw invalidPlan();
    ids.add(entry.id);
    references.add(entry.reference);
    return {
      id: entry.id,
      reference: entry.reference,
      legacyValue: entry.legacyValue,
    };
  });

  return {
    migrationId: plan.migrationId,
    sourceRevision: plan.sourceRevision,
    entries,
  };
}

function validateJournal(value, plan) {
  const normalized = normalizeJournalShape(value, plan.migrationId);
  if (normalized.sourceRevision !== plan.sourceRevision) throw invalidJournal();
  if (normalized.entries.length > plan.entries.length) throw invalidJournal();
  if (normalized.phase !== 'pending' && normalized.entries.length !== plan.entries.length) {
    throw invalidJournal();
  }

  const entries = normalized.entries.map((entry, index) => {
    const planned = plan.entries[index];
    if (!planned || entry.id !== planned.id || entry.reference !== planned.reference) {
      throw invalidJournal();
    }
    return {
      id: entry.id,
      reference: entry.reference,
      revision: entry.revision,
    };
  });

  return {
    schemaVersion: 1,
    migrationId: normalized.migrationId,
    sourceRevision: normalized.sourceRevision,
    phase: normalized.phase,
    entries,
    updatedAt: normalized.updatedAt,
  };
}

function timestamp(now) {
  const value = now();
  if (!Number.isFinite(value) || value < 0) throw invalidPlan();
  return value;
}

async function persistJournal({ journalStore, now, plan, phase, entries }) {
  const journal = {
    schemaVersion: 1,
    migrationId: plan.migrationId,
    sourceRevision: plan.sourceRevision,
    phase,
    entries: entries.map((entry) => ({
      id: entry.id,
      reference: entry.reference,
      revision: entry.revision,
    })),
    updatedAt: timestamp(now),
  };
  await journalStore.writeAtomic(journal);
  return journal;
}

function verifiedReadback(record, expected) {
  if (!record || typeof record !== 'object') throw secretConflict();
  if (record.value !== expected.legacyValue || !validRevision(record.revision)) {
    throw secretConflict();
  }
  if (expected.revision !== undefined && record.revision !== expected.revision) {
    throw secretConflict();
  }
  if (record.reference !== undefined && record.reference !== expected.reference) {
    throw secretConflict();
  }
  return record.revision;
}

function publicEntries(entries) {
  return Object.freeze(entries.map((entry) => Object.freeze({
    id: entry.id,
    reference: entry.reference,
    revision: entry.revision,
  })));
}

function committedResult(plan, entries) {
  return Object.freeze({
    migrationId: plan.migrationId,
    status: 'committed',
    entries: publicEntries(entries),
  });
}

function readonlyJournal(value) {
  const entries = Object.freeze(value.entries.map((entry) => Object.freeze({ ...entry })));
  return Object.freeze({ ...value, entries });
}

export async function readSecretMigrationJournalSnapshot(runner, migrationId) {
  const journalStore = JOURNAL_STORES_BY_RUNNER.get(runner);
  if (!journalStore || typeof migrationId !== 'string' || !migrationId) throw invalidJournal();
  let stored;
  try {
    stored = await journalStore.read(migrationId);
  } catch {
    throw invalidJournal();
  }
  if (stored === null) return null;
  return readonlyJournal(normalizeJournalShape(stored, migrationId));
}

export function createSecretMigrationRunner(input = {}) {
  const { journalStore, secretStore, now = Date.now } = input;
  if (!journalStore || typeof journalStore.read !== 'function' || typeof journalStore.writeAtomic !== 'function') {
    throw new TypeError('An atomic journal store is required');
  }
  if (!secretStore || typeof secretStore.get !== 'function' || typeof secretStore.set !== 'function') {
    throw new TypeError('A secret store is required');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  const runner = Object.freeze({
    async run(planInput) {
      const plan = normalizePlan(planInput);
      const writeRedactedBackup = planInput.writeRedactedBackup;
      const commitRedactedState = planInput.commitRedactedState;
      const cleanupLegacyState = planInput.cleanupLegacyState;
      const initialPhaseObserver = planInput[INITIAL_PHASE_OBSERVER];
      const stored = await journalStore.read(plan.migrationId);
      let journal = stored === null ? null : validateJournal(stored, plan);
      if (initialPhaseObserver) {
        initialPhaseObserver(journal === null ? 'pending' : journal.phase);
      }
      if (journal === null) {
        journal = await persistJournal({
          journalStore,
          now,
          plan,
          phase: 'pending',
          entries: [],
        });
      }

      if (journal.phase === 'committed') return committedResult(plan, journal.entries);

      if (journal.phase === 'pending') {
        let written = journal.entries.slice();
        for (let index = 0; index < plan.entries.length; index += 1) {
          const entry = plan.entries[index];
          const recorded = written[index];
          let revision;

          if (recorded) {
            const existing = await secretStore.get(entry.reference);
            revision = verifiedReadback(existing, {
              reference: entry.reference,
              legacyValue: entry.legacyValue,
              revision: recorded.revision,
            });
          } else {
            let created = null;
            try {
              created = await secretStore.set({
                reference: entry.reference,
                value: entry.legacyValue,
                expectedRevision: null,
              });
            } catch (error) {
              if (error?.code !== 'SECRET_CONFLICT') throw error;
            }

            if (created === null) {
              const existing = await secretStore.get(entry.reference);
              revision = verifiedReadback(existing, {
                reference: entry.reference,
                legacyValue: entry.legacyValue,
              });
            } else {
              if (
                !created
                || created.reference !== entry.reference
                || !validRevision(created.revision)
              ) {
                throw secretConflict();
              }
              const readback = await secretStore.get(entry.reference);
              revision = verifiedReadback(readback, {
                reference: entry.reference,
                legacyValue: entry.legacyValue,
                revision: created.revision,
              });
            }

            written = [...written, {
              id: entry.id,
              reference: entry.reference,
              revision,
            }];
            journal = await persistJournal({
              journalStore,
              now,
              plan,
              phase: 'pending',
              entries: written,
            });
          }
        }

        journal = await persistJournal({
          journalStore,
          now,
          plan,
          phase: 'secrets-written',
          entries: written,
        });
      }

      if (journal.phase === 'secrets-written') {
        await writeRedactedBackup();
        await commitRedactedState(publicEntries(journal.entries));
        journal = await persistJournal({
          journalStore,
          now,
          plan,
          phase: 'state-committed',
          entries: journal.entries,
        });
      }

      if (journal.phase === 'state-committed') {
        await cleanupLegacyState();
        journal = await persistJournal({
          journalStore,
          now,
          plan,
          phase: 'committed',
          entries: journal.entries,
        });
      }

      return committedResult(plan, journal.entries);
    },
  });
  JOURNAL_STORES_BY_RUNNER.set(runner, journalStore);
  return runner;
}
