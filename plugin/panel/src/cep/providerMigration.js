import { createProviderSecretReference, parseProviderSecretReference } from './platform/secret-reference.js';
import { readSecretMigrationJournalSnapshot } from './platform/secret-migration.js';
import { normalizeProviderEntryV2 } from '../lib/providerProfile.js';

const DEFAULT_LEGACY_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
const MIGRATION_ID = 'provider-store-v1-to-v2';
const STATE_KEYS = ['migratedLegacy', 'pendingSecretDeletes', 'providers', 'revision', 'version'];
const VALUE_REF_KEYS = ['kind', 'reference', 'revision'];
const MIGRATION_PHASES = new Set(['pending', 'secrets-written', 'state-committed', 'committed']);
const INITIAL_PHASE_OBSERVER = Symbol.for(
  'com.junkdoge.ae-mcp.secret-migration.initial-phase',
);

function migrationError() {
  const error = new Error('Provider secret migration is invalid');
  error.code = 'INVALID_PROVIDER_MIGRATION';
  return error;
}

function secretConflict() {
  const error = new Error('Provider secret migration conflict');
  error.code = 'SECRET_CONFLICT';
  return error;
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function uuidBytes(value) {
  if (typeof value !== 'string') throw migrationError();
  try {
    createProviderSecretReference({ providerId: value, slot: 'namespace' });
  } catch {
    throw migrationError();
  }
  const hex = value.replace(/-/g, '');
  return Uint8Array.from(hex.match(/../g), (part) => Number.parseInt(part, 16));
}

function utf8Bytes(value) {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(value);
  const encoded = unescape(encodeURIComponent(value));
  return Uint8Array.from(encoded, (character) => character.charCodeAt(0));
}

async function sha1(value) {
  if (globalThis.crypto?.subtle && typeof globalThis.crypto.subtle.digest === 'function') {
    return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-1', value));
  }
  const req = globalThis.window?.cep_node?.require
    || globalThis.window?.require
    || globalThis.require;
  if (typeof req === 'function') {
    const cryptoImpl = req('crypto');
    const digest = cryptoImpl.createHash('sha1').update(value).digest();
    return Uint8Array.from(digest);
  }
  throw migrationError();
}

async function uuidV5(name, namespace) {
  const namespaceBytes = uuidBytes(namespace);
  const nameBytes = utf8Bytes(name);
  const input = new Uint8Array(namespaceBytes.length + nameBytes.length);
  input.set(namespaceBytes, 0);
  input.set(nameBytes, namespaceBytes.length);
  const bytes = (await sha1(input)).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function credentialIdFor(providerId, legacyCredentialId) {
  const value = typeof legacyCredentialId === 'function'
    ? await legacyCredentialId(providerId)
    : await uuidV5(providerId, legacyCredentialId || DEFAULT_LEGACY_NAMESPACE);
  try {
    createProviderSecretReference({ providerId: value, slot: 'auth-model' });
  } catch {
    throw migrationError();
  }
  return value;
}

function normalizeLegacyProvider(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw migrationError();
  if (typeof value.id !== 'string' || !value.id.trim()) throw migrationError();
  const id = value.id.trim();
  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : id;
  const protocol = value.protocol === undefined ? 'openai-compatible' : value.protocol;
  if (protocol !== 'openai-compatible' && protocol !== 'anthropic') throw migrationError();
  if (typeof value.baseUrl !== 'string' || !value.baseUrl.trim()) throw migrationError();
  if (value.apiKey !== undefined && typeof value.apiKey !== 'string') throw migrationError();
  if (value.probedModels !== undefined && !Array.isArray(value.probedModels)) throw migrationError();
  if (value.probedAt !== undefined && (!Number.isFinite(value.probedAt) || value.probedAt < 0)) {
    throw migrationError();
  }
  return {
    id,
    name,
    protocol,
    baseUrl: value.baseUrl,
    apiKey: value.apiKey || '',
    probedModels: value.probedModels || [],
    probedAt: value.probedAt || 0,
  };
}

async function buildMigrationInputs(legacyState, legacyCredentialId) {
  if (!legacyState || typeof legacyState !== 'object' || Array.isArray(legacyState)) {
    throw migrationError();
  }
  if (legacyState.version !== 1 || !Array.isArray(legacyState.providers)) throw migrationError();
  const ids = new Set();
  const providers = [];
  const entries = [];

  for (const rawProvider of legacyState.providers) {
    const provider = normalizeLegacyProvider(rawProvider);
    if (ids.has(provider.id)) throw migrationError();
    ids.add(provider.id);
    const credentialId = await credentialIdFor(provider.id, legacyCredentialId);
    const entryId = `${provider.id}:auth-model`;
    const reference = createProviderSecretReference({ providerId: credentialId, slot: 'auth-model' });
    providers.push({ provider, credentialId, entryId });
    if (provider.apiKey) {
      entries.push({ entryId, reference, legacyValue: provider.apiKey });
    }
  }
  return { providers, entries };
}

function normalizeWrittenEntries(entries, migrationInputs) {
  if (!Array.isArray(entries) || entries.length !== migrationInputs.entries.length) {
    throw secretConflict();
  }
  return entries.map((entry, index) => {
    const expected = migrationInputs.entries[index];
    if (
      !hasExactKeys(entry, ['id', 'reference', 'revision'])
      || entry.id !== expected.entryId
      || entry.reference !== expected.reference
      || !Number.isSafeInteger(entry.revision)
      || entry.revision <= 0
    ) {
      throw secretConflict();
    }
    return { id: entry.id, reference: entry.reference, revision: entry.revision };
  });
}

function buildProviderV2State(legacyState, migrationInputs, writes) {
  const normalizedWrites = normalizeWrittenEntries(writes, migrationInputs);
  const writesById = new Map(normalizedWrites.map((entry) => [entry.id, entry]));
  const providers = migrationInputs.providers.map(({ provider, credentialId, entryId }) => {
    const write = writesById.get(entryId);
    if (Boolean(provider.apiKey) !== Boolean(write)) throw secretConflict();
    return normalizeProviderEntryV2({
      id: provider.id,
      credentialId,
      name: provider.name,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      allowInsecureHttp: false,
      authProfileRevision: 1,
      auth: {
        model: write
          ? {
            kind: provider.protocol === 'anthropic' ? 'x-api-key' : 'bearer',
            valueRef: { kind: 'secret', reference: write.reference, revision: write.revision },
          }
          : { kind: 'none' },
        probe: { kind: 'inherit-model' },
      },
      headers: [],
      dialect: { override: null, detected: null },
      probedModels: provider.probedModels,
      probedAt: provider.probedAt,
    });
  });
  const state = {
    version: 2,
    revision: Number.isSafeInteger(legacyState.revision) && legacyState.revision > 0
      ? legacyState.revision
      : 1,
    migratedLegacy: true,
    pendingSecretDeletes: [],
    providers,
  };
  assertNoLegacySecretInPersistedFields(
    state,
    migrationInputs.entries.map((entry) => entry.legacyValue),
  );
  return state;
}

function isSecretValueRef(value) {
  return hasExactKeys(value, VALUE_REF_KEYS)
    && value.kind === 'secret'
    && typeof value.reference === 'string'
    && Number.isSafeInteger(value.revision)
    && value.revision > 0;
}

function assertNoLegacySecretInPersistedFields(value, legacySecrets) {
  const forbidden = legacySecrets.filter((secret) => typeof secret === 'string' && secret);
  // Substring scanning is useful for catching accidental interpolation of a
  // credential, but very short legacy values (for example a one-character
  // test key) occur naturally throughout URLs, names, and model metadata.
  // Exact matches remain forbidden at every length; embedded matching starts
  // at eight characters, including after bounded percent decoding.
  const embeddedForbidden = forbidden.filter((secret) => utf8Bytes(secret).length >= 8);
  const decodePercentRuns = (input) => String(input).replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try { return decodeURIComponent(run); } catch { return run; }
  });
  const containsForbidden = (input) => {
    let current = String(input);
    for (let layer = 0; layer <= 3; layer += 1) {
      if (forbidden.some((secret) => current === secret)) return true;
      if (embeddedForbidden.some((secret) => current.includes(secret))) return true;
      const decoded = decodePercentRuns(current);
      if (decoded === current) break;
      current = decoded;
    }
    return false;
  };
  const visit = (current) => {
    if (typeof current === 'string') {
      if (containsForbidden(current)) throw secretConflict();
      return;
    }
    if (!current || typeof current !== 'object') return;
    if (isSecretValueRef(current)) return;
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    Object.values(current).forEach(visit);
  };
  visit(value);
}

function providerActiveReferences(provider) {
  const references = [];
  const add = (valueRef) => {
    if (valueRef?.kind === 'secret') references.push(valueRef.reference);
  };
  add(provider.auth.model.valueRef);
  add(provider.auth.probe.valueRef);
  provider.headers.forEach((header) => add(header.valueRef));
  return references;
}

function readStrictProviderStateV2(value) {
  if (!hasExactKeys(value, STATE_KEYS)) throw migrationError();
  if (
    value.version !== 2
    || !Number.isSafeInteger(value.revision)
    || value.revision <= 0
    || value.migratedLegacy !== true
    || !Array.isArray(value.pendingSecretDeletes)
    || !Array.isArray(value.providers)
  ) {
    throw migrationError();
  }
  let providers;
  try {
    providers = value.providers.map((provider) => normalizeProviderEntryV2(provider));
  } catch {
    throw migrationError();
  }
  const ids = new Set();
  const activeReferences = new Set();
  for (const provider of providers) {
    if (ids.has(provider.id)) throw migrationError();
    ids.add(provider.id);
    providerActiveReferences(provider).forEach((reference) => activeReferences.add(reference));
  }
  const pendingReferences = new Set();
  const pendingSecretDeletes = value.pendingSecretDeletes.map((ref) => {
    if (!isSecretValueRef(ref)) throw migrationError();
    try { parseProviderSecretReference(ref.reference); } catch { throw migrationError(); }
    if (pendingReferences.has(ref.reference) || activeReferences.has(ref.reference)) throw migrationError();
    pendingReferences.add(ref.reference);
    return { kind: 'secret', reference: ref.reference, revision: ref.revision };
  });
  return { ...value, pendingSecretDeletes, providers };
}

function validateProviderStateV2(value) {
  const state = readStrictProviderStateV2(value);
  if (state.pendingSecretDeletes.length !== 0) throw migrationError();
  return state;
}

function expectedMigrationEntriesFromV2State(value) {
  const state = validateProviderStateV2(value);
  const entries = [];
  for (const provider of state.providers) {
    if (
      provider.allowInsecureHttp !== false
      || provider.authProfileRevision !== 1
      || provider.auth.probe.kind !== 'inherit-model'
      || provider.headers.length !== 0
      || provider.dialect.override !== null
      || !Array.isArray(provider.dialect.detected)
      || provider.dialect.detected.length !== 0
    ) {
      throw migrationError();
    }
    const model = provider.auth.model;
    if (model.kind === 'none') continue;
    const expectedKind = provider.protocol === 'anthropic' ? 'x-api-key' : 'bearer';
    if (model.kind !== expectedKind || model.valueRef?.kind !== 'secret') throw migrationError();
    entries.push({
      id: `${provider.id}:auth-model`,
      reference: model.valueRef.reference,
      revision: model.valueRef.revision,
    });
  }
  return entries;
}

function assertRecoveryStateMatchesJournal(state, journal) {
  if (!journal || journal.phase === 'pending') throw migrationError();
  const expected = expectedMigrationEntriesFromV2State(state);
  if (expected.length !== journal.entries.length) throw migrationError();
  for (let index = 0; index < expected.length; index += 1) {
    const actual = journal.entries[index];
    const wanted = expected[index];
    if (
      actual.id !== wanted.id
      || actual.reference !== wanted.reference
      || actual.revision !== wanted.revision
    ) {
      throw migrationError();
    }
  }
}

async function recoverCommittedProviderState({ store, legacyKeyStore, runner, journal }) {
  if (typeof store.readState !== 'function') throw migrationError();
  const readCurrentState = () => {
    let state;
    try {
      const schemaInput = typeof store.readSchemaMigrationInput === 'function'
        ? store.readSchemaMigrationInput()
        : null;
      state = schemaInput?.state || store.readState();
    } catch { throw migrationError(); }
    return readStrictProviderStateV2(state);
  };
  if (journal.phase === 'committed') {
    readCurrentState();
    return { status: 'already-committed', written: 0, resumedFrom: 'committed' };
  }
  if (typeof legacyKeyStore?.cleanupCommittedProviderSecrets !== 'function') throw migrationError();
  const validateCurrentState = () => assertRecoveryStateMatchesJournal(readCurrentState(), journal);
  validateCurrentState();

  let resumedFrom = null;
  const result = await runner.run({
    migrationId: MIGRATION_ID,
    sourceRevision: journal.sourceRevision,
    entries: journal.entries.map((entry) => ({
      id: entry.id,
      reference: entry.reference,
      legacyValue: '',
    })),
    [INITIAL_PHASE_OBSERVER](phase) {
      if (resumedFrom !== null || (phase !== 'secrets-written' && phase !== 'state-committed')) {
        throw migrationError();
      }
      resumedFrom = phase;
    },
    async writeRedactedBackup() {
      // Backup and v2 replacement both completed before legacy input vanished.
      validateCurrentState();
    },
    async commitRedactedState(entries) {
      if (JSON.stringify(entries) !== JSON.stringify(journal.entries)) throw migrationError();
      validateCurrentState();
    },
    async cleanupLegacyState() {
      await legacyKeyStore.cleanupCommittedProviderSecrets();
    },
  });
  if (
    !result
    || result.status !== 'committed'
    || resumedFrom === null
    || result.entries.length !== journal.entries.length
  ) {
    throw migrationError();
  }
  return { status: 'committed', written: result.entries.length, resumedFrom };
}

async function readWrittenEntries(secretStore, migrationInputs) {
  const entries = [];
  for (const expected of migrationInputs.entries) {
    let record;
    try {
      if (secretStore && typeof secretStore.secretGet === 'function') {
        record = await secretStore.secretGet(expected.reference);
      } else if (secretStore && typeof secretStore.get === 'function') {
        record = await secretStore.get(expected.reference);
      } else {
        throw migrationError();
      }
    } catch (error) {
      if (error?.code === 'INVALID_PROVIDER_MIGRATION') throw error;
      throw secretConflict();
    }
    if (
      !record
      || !hasExactKeys(record, ['reference', 'revision', 'value'])
      || record.reference !== expected.reference
      || record.value !== expected.legacyValue
      || !Number.isSafeInteger(record.revision)
      || record.revision <= 0
    ) {
      throw secretConflict();
    }
    entries.push({ id: expected.entryId, reference: expected.reference, revision: record.revision });
  }
  return entries;
}

export async function migrateProviderStoreSecrets({
  store,
  legacyKeyStore,
  runner,
  secretStore,
  now = Date.now,
  legacyCredentialId,
} = {}) {
  if (
    !store
    || typeof store.readLegacyMigrationInput !== 'function'
    || typeof runner?.run !== 'function'
    || typeof now !== 'function'
  ) {
    throw migrationError();
  }
  const legacyInput = await store.readLegacyMigrationInput();
  if (legacyInput === null) {
    let journal;
    try {
      journal = await readSecretMigrationJournalSnapshot(runner, MIGRATION_ID);
    } catch {
      throw migrationError();
    }
    if (journal === null) {
      return { status: 'already-committed', written: 0, resumedFrom: 'committed' };
    }
    return recoverCommittedProviderState({ store, legacyKeyStore, runner, journal });
  }
  if (
    !legacyInput
    || typeof legacyInput !== 'object'
    || typeof legacyInput.sourceRevision !== 'string'
    || !legacyInput.sourceRevision
  ) {
    throw migrationError();
  }
  if (
    typeof store.writeRedactedBackup !== 'function'
    || typeof store.replaceState !== 'function'
    || typeof legacyKeyStore?.cleanupCommittedProviderSecrets !== 'function'
  ) {
    throw migrationError();
  }

  const migrationInputs = await buildMigrationInputs(legacyInput.state, legacyCredentialId);
  let backupState = null;
  let resumedFrom = null;

  const result = await runner.run({
    migrationId: MIGRATION_ID,
    sourceRevision: legacyInput.sourceRevision,
    entries: migrationInputs.entries.map((entry) => ({
      id: entry.entryId,
      reference: entry.reference,
      legacyValue: entry.legacyValue,
    })),
    [INITIAL_PHASE_OBSERVER](phase) {
      if (resumedFrom !== null || !MIGRATION_PHASES.has(phase)) throw migrationError();
      resumedFrom = phase;
    },
    async writeRedactedBackup() {
      const writes = await readWrittenEntries(secretStore, migrationInputs);
      backupState = validateProviderStateV2(
        buildProviderV2State(legacyInput.state, migrationInputs, writes),
      );
      await store.writeRedactedBackup(backupState, { keep: 3, maxAgeDays: 30 });
    },
    async commitRedactedState(entries) {
      const state = validateProviderStateV2(
        buildProviderV2State(legacyInput.state, migrationInputs, entries),
      );
      if (backupState === null || JSON.stringify(backupState) !== JSON.stringify(state)) {
        throw secretConflict();
      }
      await store.replaceState(state, { expectedSourceRevision: legacyInput.sourceRevision });
    },
    async cleanupLegacyState() {
      await legacyKeyStore.cleanupCommittedProviderSecrets();
    },
  });

  if (
    !result
    || result.status !== 'committed'
    || !Array.isArray(result.entries)
    || resumedFrom === null
  ) {
    throw migrationError();
  }
  return { status: 'committed', written: result.entries.length, resumedFrom };
}
