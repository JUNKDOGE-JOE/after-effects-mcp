// Provider JSON contains opaque helper references only. Plaintext credentials
// are accepted solely by the v1 secret migration and never returned by list/get.
import {
  normalizeProviderEntryV2,
  normalizeProviderEntryV3,
  validateProviderBaseUrl,
} from '../lib/providerProfile.js';
import { parseProviderSecretReference } from './platform/secret-reference.js';

const FILE_NAME = 'providers.json';
const STATE_KEYS = ['migratedLegacy', 'pendingSecretDeletes', 'providers', 'revision', 'version'];
const VALUE_REF_KEYS = ['kind', 'reference', 'revision'];
const LOCK_KEYS = ['createdAt', 'ownerNonce', 'pid', 'schemaVersion'];
const RELEASED_LOCK_NONCES = new Set();
const MAX_RELEASED_LOCK_NONCES = 256;
// Mutations are synchronous and normally complete in milliseconds. The lease
// bounds PID-reuse wedges while a final ownership check fences a resumed stale
// writer before it can publish its temp file.
const LOCK_STALE_AFTER_MS = 30_000;

function cepRequire() {
  if (globalThis.window?.cep_node?.require) return globalThis.window.cep_node.require;
  if (globalThis.window?.require) return globalThis.window.require;
  if (globalThis.require) return globalThis.require;
  return null;
}

function defaultDeps() {
  const req = cepRequire();
  if (!req) throw storeError('PROVIDER_STORE_UNAVAILABLE');
  const processApi = req('process');
  return {
    fs: req('fs'),
    os: req('os'),
    path: req('path'),
    crypto: req('crypto'),
    pid: processApi?.pid || 0,
    now: Date.now,
    isProcessAlive(pid) {
      try {
        processApi.kill(pid, 0);
        return true;
      } catch (error) {
        return error?.code !== 'ESRCH';
      }
    },
  };
}

function storeError(code) {
  const messages = {
    PROVIDER_STORE_CONFLICT: 'Provider store revision conflict',
    PROVIDER_STORE_INVALID: 'Provider store is invalid',
    PROVIDER_STORE_MIGRATION_REQUIRED: 'Provider store migration is required',
    PROVIDER_STORE_UNAVAILABLE: 'Provider store is unavailable',
  };
  const error = new Error(messages[code] || messages.PROVIDER_STORE_INVALID);
  error.code = messages[code] ? code : 'PROVIDER_STORE_INVALID';
  return error;
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeValueRef(value) {
  if (!hasExactKeys(value, VALUE_REF_KEYS) || value.kind !== 'secret') {
    throw storeError('PROVIDER_STORE_INVALID');
  }
  try {
    parseProviderSecretReference(value.reference);
  } catch {
    throw storeError('PROVIDER_STORE_INVALID');
  }
  if (!Number.isSafeInteger(value.revision) || value.revision <= 0) {
    throw storeError('PROVIDER_STORE_INVALID');
  }
  return { kind: 'secret', reference: value.reference, revision: value.revision };
}

function requireSafeProviderUrl(value) {
  try { validateProviderBaseUrl(value); } catch { throw storeError('PROVIDER_STORE_INVALID'); }
}

function providerSecretReferences(provider) {
  const references = [];
  const add = (valueRef) => {
    if (valueRef?.kind === 'secret') references.push(valueRef);
  };
  if (provider.credential) {
    add(provider.credential.valueRef);
    add(provider.probeAuthOverride?.valueRef);
  } else {
    add(provider.auth?.model?.valueRef);
    add(provider.auth?.probe?.valueRef);
  }
  for (const header of provider.headers || []) add(header.valueRef);
  return references;
}

function exactStatInteger(value) {
  if (typeof value === 'bigint') {
    if (value < BigInt(0)) throw storeError('PROVIDER_STORE_UNAVAILABLE');
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString(10);
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw storeError('PROVIDER_STORE_UNAVAILABLE');
  }
  return value;
}

function statTimeMilliseconds(value) {
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isFinite(number) || number < 0 || !Number.isSafeInteger(Math.trunc(number))) {
    throw storeError('PROVIDER_STORE_UNAVAILABLE');
  }
  return number;
}

function fileIdentity(stat) {
  if (!stat || typeof stat !== 'object') throw storeError('PROVIDER_STORE_UNAVAILABLE');
  return {
    kind: 'provider-file-identity-v1',
    dev: exactStatInteger(stat.dev),
    ino: exactStatInteger(stat.ino),
    size: exactStatInteger(stat.size),
    mtimeMs: statTimeMilliseconds(stat.mtimeMs),
    ctimeMs: statTimeMilliseconds(stat.ctimeMs),
  };
}

function readFileIdentity(fs, file) {
  try {
    return fileIdentity(fs.statSync(file));
  } catch (error) {
    if (error?.code !== 'PROVIDER_STORE_UNAVAILABLE') throw error;
  }
  return fileIdentity(fs.statSync(file, { bigint: true }));
}

function normalizeStateForVersion(value, version, normalizeProvider) {
  if (!hasExactKeys(value, STATE_KEYS)) throw storeError('PROVIDER_STORE_INVALID');
  if (
    value.version !== version
    || !Number.isSafeInteger(value.revision)
    || value.revision < 0
    || value.migratedLegacy !== true
    || !Array.isArray(value.pendingSecretDeletes)
    || !Array.isArray(value.providers)
  ) {
    throw storeError('PROVIDER_STORE_INVALID');
  }
  const pendingSecretDeletes = value.pendingSecretDeletes.map(normalizeValueRef);
  const pendingKeys = new Set();
  for (const ref of pendingSecretDeletes) {
    if (pendingKeys.has(ref.reference)) throw storeError('PROVIDER_STORE_INVALID');
    pendingKeys.add(ref.reference);
  }
  const providers = value.providers.map((provider) => {
    try {
      const normalized = normalizeProvider(provider);
      requireSafeProviderUrl(normalized.baseUrl);
      return normalized;
    } catch {
      throw storeError('PROVIDER_STORE_INVALID');
    }
  });
  const ids = new Set();
  const activeReferences = new Map();
  for (const provider of providers) {
    if (ids.has(provider.id)) throw storeError('PROVIDER_STORE_INVALID');
    ids.add(provider.id);
    for (const valueRef of providerSecretReferences(provider)) {
      if (pendingKeys.has(valueRef.reference)) throw storeError('PROVIDER_STORE_INVALID');
      const existingRevision = activeReferences.get(valueRef.reference);
      if (existingRevision !== undefined && existingRevision !== valueRef.revision) {
        throw storeError('PROVIDER_STORE_INVALID');
      }
      activeReferences.set(valueRef.reference, valueRef.revision);
    }
  }
  return {
    version,
    revision: value.revision,
    migratedLegacy: true,
    pendingSecretDeletes,
    providers,
  };
}

function normalizeStateV2(value) {
  return normalizeStateForVersion(value, 2, normalizeProviderEntryV2);
}

function normalizeStateV3(value) {
  return normalizeStateForVersion(value, 3, normalizeProviderEntryV3);
}

function normalizePersistedState(value) {
  if (value?.version === 2) return normalizeStateV2(value);
  if (value?.version === 3) return normalizeStateV3(value);
  throw storeError('PROVIDER_STORE_INVALID');
}

function emptyState() {
  return {
    version: 3,
    revision: 0,
    migratedLegacy: true,
    pendingSecretDeletes: [],
    providers: [],
  };
}

function appendPending(existing, additions) {
  if (additions === undefined) return existing.slice();
  if (!Array.isArray(additions)) throw storeError('PROVIDER_STORE_INVALID');
  const output = existing.slice();
  const seen = new Map(output.map((ref) => [ref.reference, ref.revision]));
  for (const raw of additions) {
    const ref = normalizeValueRef(raw);
    if (seen.has(ref.reference)) {
      if (seen.get(ref.reference) !== ref.revision) throw storeError('PROVIDER_STORE_INVALID');
    } else {
      seen.set(ref.reference, ref.revision);
      output.push(ref);
    }
  }
  return output;
}

export function createProviderStore(inputDeps) {
  const deps = inputDeps || defaultDeps();
  const { fs, os, path } = deps;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const pid = Number.isSafeInteger(deps.pid) && deps.pid > 0 ? deps.pid : 0;
  const randomBytes = deps.crypto?.randomBytes;
  const isProcessAlive = typeof deps.isProcessAlive === 'function'
    ? deps.isProcessAlive
    : () => true;
  let tempCounter = 0;
  let activeLockOwner = null;

  function dir() { return path.join(os.homedir(), '.ae-mcp'); }
  function filePath() { return path.join(dir(), FILE_NAME); }
  function lockPath() { return path.join(dir(), `${FILE_NAME}.lock`); }

  function ensureDirectory() {
    const directory = dir();
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
    return directory;
  }

  function normalizeLockMetadata(value) {
    if (
      !hasExactKeys(value, LOCK_KEYS)
      || value.schemaVersion !== 1
      || typeof value.ownerNonce !== 'string'
      || !/^[0-9a-f]{32,128}$/.test(value.ownerNonce)
      || !Number.isSafeInteger(value.pid)
      || value.pid <= 0
      || !Number.isFinite(value.createdAt)
      || value.createdAt < 0
    ) {
      return null;
    }
    return {
      schemaVersion: 1,
      ownerNonce: value.ownerNonce,
      pid: value.pid,
      createdAt: value.createdAt,
    };
  }

  function readLockMetadata(lock) {
    try {
      return normalizeLockMetadata(JSON.parse(String(fs.readFileSync(lock, 'utf8'))));
    } catch {
      return null;
    }
  }

  function readLockSnapshot(lock) {
    if (typeof fs.statSync !== 'function') return null;
    try {
      const firstRaw = String(fs.readFileSync(lock, 'utf8'));
      const firstIdentity = readFileIdentity(fs, lock);
      const secondRaw = String(fs.readFileSync(lock, 'utf8'));
      const secondIdentity = readFileIdentity(fs, lock);
      if (firstRaw !== secondRaw || JSON.stringify(firstIdentity) !== JSON.stringify(secondIdentity)) {
        return null;
      }
      let metadata = null;
      try { metadata = normalizeLockMetadata(JSON.parse(firstRaw)); } catch { /* malformed lock */ }
      return { raw: firstRaw, identity: firstIdentity, metadata };
    } catch {
      return null;
    }
  }

  function sameLockOwner(left, right) {
    return Boolean(left && right
      && left.ownerNonce === right.ownerNonce
      && left.pid === right.pid
      && left.createdAt === right.createdAt);
  }

  function sameLockSnapshot(left, right) {
    return Boolean(left && right
      && left.raw === right.raw
      && JSON.stringify(left.identity) === JSON.stringify(right.identity)
      && (left.metadata === null && right.metadata === null
        || sameLockOwner(left.metadata, right.metadata)));
  }

  function sameLockPayload(left, right) {
    return Boolean(left && right
      && left.raw === right.raw
      && (left.metadata === null && right.metadata === null
        || sameLockOwner(left.metadata, right.metadata)));
  }

  function rememberReleasedNonce(ownerNonce) {
    RELEASED_LOCK_NONCES.add(ownerNonce);
    while (RELEASED_LOCK_NONCES.size > MAX_RELEASED_LOCK_NONCES) {
      RELEASED_LOCK_NONCES.delete(RELEASED_LOCK_NONCES.values().next().value);
    }
  }

  function ownerIsAlive(ownerPid) {
    try { return isProcessAlive(ownerPid) !== false; } catch { return true; }
  }

  function lockLeaseExpired(snapshot) {
    const timestamp = snapshot.metadata
      ? snapshot.metadata.createdAt
      : Math.max(snapshot.identity.mtimeMs, snapshot.identity.ctimeMs);
    const age = now() - timestamp;
    return Number.isFinite(age) && age >= LOCK_STALE_AFTER_MS;
  }

  function lockSnapshotIsRecoverable(snapshot) {
    const releasedByThisProcess = Boolean(snapshot.metadata
      && snapshot.metadata.pid === pid
      && RELEASED_LOCK_NONCES.has(snapshot.metadata.ownerNonce));
    const deadOwner = Boolean(snapshot.metadata && !ownerIsAlive(snapshot.metadata.pid));
    return releasedByThisProcess || deadOwner || lockLeaseExpired(snapshot);
  }

  function recoverQuarantinedLock(lock) {
    const recovery = `${lock}.recovering`;
    if (!fs.existsSync?.(recovery) || fs.existsSync?.(lock)) return false;
    const observed = readLockSnapshot(recovery);
    if (!observed || !lockSnapshotIsRecoverable(observed)) return false;
    const confirmed = readLockSnapshot(recovery);
    if (!sameLockSnapshot(observed, confirmed)) return false;
    try {
      fs.unlinkSync(recovery);
      if (observed.metadata) RELEASED_LOCK_NONCES.delete(observed.metadata.ownerNonce);
      return true;
    } catch {
      return false;
    }
  }

  function restoreQuarantinedLock(lock, recovery) {
    // linkSync is an exclusive create: unlike rename, it cannot overwrite a
    // newer lock that appeared while the observed file was quarantined.
    if (typeof fs.linkSync !== 'function') return false;
    try {
      fs.linkSync(recovery, lock);
      fs.unlinkSync(recovery);
      return true;
    } catch {
      return false;
    }
  }

  function quarantineAndRemoveLock(lock, observed) {
    const recovery = `${lock}.recovering`;
    if (fs.existsSync?.(recovery)) return false;
    const confirmed = readLockSnapshot(lock);
    if (!sameLockSnapshot(observed, confirmed)) return false;
    try {
      fs.renameSync(lock, recovery);
    } catch {
      return false;
    }
    const quarantined = readLockSnapshot(recovery);
    if (!sameLockPayload(observed, quarantined)) {
      restoreQuarantinedLock(lock, recovery);
      return false;
    }
    try {
      fs.unlinkSync(recovery);
      return true;
    } catch {
      return false;
    }
  }

  function recoverReleasedOrDeadLock(lock) {
    const observed = readLockSnapshot(lock);
    if (!observed) return false;
    if (!lockSnapshotIsRecoverable(observed)) return false;
    if (quarantineAndRemoveLock(lock, observed)) {
      if (observed.metadata) RELEASED_LOCK_NONCES.delete(observed.metadata.ownerNonce);
      return true;
    }
    return false;
  }

  function createLockOwner() {
    if (pid <= 0 || typeof randomBytes !== 'function') {
      throw storeError('PROVIDER_STORE_UNAVAILABLE');
    }
    let ownerNonce;
    try { ownerNonce = randomBytes.call(deps.crypto, 24).toString('hex'); } catch {
      throw storeError('PROVIDER_STORE_UNAVAILABLE');
    }
    const metadata = normalizeLockMetadata({
      schemaVersion: 1,
      ownerNonce,
      pid,
      createdAt: now(),
    });
    if (!metadata) throw storeError('PROVIDER_STORE_UNAVAILABLE');
    return metadata;
  }

  function acquireMutationLock(lock) {
    const owner = createLockOwner();
    const recovery = `${lock}.recovering`;
    let fd;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (fs.existsSync?.(recovery) && !recoverQuarantinedLock(lock)) {
        throw storeError('PROVIDER_STORE_CONFLICT');
      }
      try {
        fd = fs.openSync(lock, 'wx');
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw storeError('PROVIDER_STORE_UNAVAILABLE');
        if (attempt === 0 && recoverReleasedOrDeadLock(lock)) continue;
        throw storeError('PROVIDER_STORE_CONFLICT');
      }
    }
    if (fd === undefined) throw storeError('PROVIDER_STORE_CONFLICT');
    try {
      fs.writeFileSync(fd, `${JSON.stringify(owner)}\n`, 'utf8');
      if (typeof fs.fsyncSync === 'function') fs.fsyncSync(fd);
      try { fs.chmodSync(lock, 0o600); } catch { /* best effort */ }
      if (fs.existsSync?.(recovery)) throw storeError('PROVIDER_STORE_CONFLICT');
    } catch (error) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
      try {
        const observed = readLockSnapshot(lock);
        if (observed && sameLockOwner(observed.metadata, owner)) {
          quarantineAndRemoveLock(lock, observed);
        }
      } catch { /* best effort */ }
      if (error?.code === 'PROVIDER_STORE_CONFLICT') throw error;
      throw storeError('PROVIDER_STORE_UNAVAILABLE');
    }
    return { fd, owner };
  }

  function withMutationLock(operation) {
    if (typeof fs.openSync !== 'function' || typeof fs.closeSync !== 'function') {
      throw storeError('PROVIDER_STORE_UNAVAILABLE');
    }
    ensureDirectory();
    const lock = lockPath();
    const { fd, owner } = acquireMutationLock(lock);
    activeLockOwner = owner;
    let result;
    let operationError = null;
    try {
      result = operation();
    } catch (error) {
      operationError = error;
    }
    activeLockOwner = null;
    let closed = false;
    try { fs.closeSync(fd); closed = true; } catch { /* leave owned lock fail-closed */ }
    let removed = false;
    try {
      const observed = readLockSnapshot(lock);
      if (observed && sameLockOwner(observed.metadata, owner)) {
        removed = quarantineAndRemoveLock(lock, observed);
      }
    } catch { /* a committed operation must remain successful */ }
    if (removed) RELEASED_LOCK_NONCES.delete(owner.ownerNonce);
    else if (closed) rememberReleasedNonce(owner.ownerNonce);
    if (operationError) throw operationError;
    return result;
  }

  function readRaw() {
    let text;
    try {
      text = fs.readFileSync(filePath(), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT' || !fs.existsSync?.(filePath())) return null;
      throw storeError('PROVIDER_STORE_UNAVAILABLE');
    }
    let parsed;
    try {
      parsed = JSON.parse(String(text));
    } catch {
      throw storeError('PROVIDER_STORE_INVALID');
    }
    return { text: String(text), parsed };
  }

  function readState() {
    const raw = readRaw();
    if (raw === null) return emptyState();
    if (raw.parsed?.version === 1) {
      throw storeError('PROVIDER_STORE_MIGRATION_REQUIRED');
    }
    if (raw.parsed?.version === 2) {
      normalizeStateV2(raw.parsed);
      throw storeError('PROVIDER_STORE_MIGRATION_REQUIRED');
    }
    return normalizeStateV3(raw.parsed);
  }

  function writeState(value) {
    const state = normalizePersistedState(value);
    const directory = ensureDirectory();
    const tmp = path.join(
      directory,
      `${FILE_NAME}.${deps.pid || 0}.${now()}.${tempCounter += 1}.tmp`,
    );
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      try { fs.chmodSync(tmp, 0o600); } catch { /* best effort on Windows */ }
      if (!sameLockOwner(readLockMetadata(lockPath()), activeLockOwner)
          || fs.existsSync?.(`${lockPath()}.recovering`)) {
        throw storeError('PROVIDER_STORE_CONFLICT');
      }
      fs.renameSync(tmp, filePath());
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
      if (error?.code === 'PROVIDER_STORE_INVALID' || error?.code === 'PROVIDER_STORE_CONFLICT') throw error;
      throw storeError('PROVIDER_STORE_UNAVAILABLE');
    }
    return clone(state);
  }

  function assertExpected(state, expectedRevision) {
    if (expectedRevision === undefined) return;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision !== state.revision) {
      throw storeError('PROVIDER_STORE_CONFLICT');
    }
  }

  function list() {
    const raw = readRaw();
    if (raw === null) return [];
    if (raw.parsed?.version === 1) return [];
    if (raw.parsed?.version === 2) {
      normalizeStateV2(raw.parsed);
      return [];
    }
    return clone(normalizeStateV3(raw.parsed).providers);
  }

  function get(id) {
    const wanted = String(id || '').trim();
    return list().find((provider) => provider.id === wanted) || null;
  }

  function upsert(entry, options = {}) {
    let normalized;
    try {
      normalized = normalizeProviderEntryV3(entry);
    } catch {
      throw storeError('PROVIDER_STORE_INVALID');
    }
    return withMutationLock(() => {
      const state = readState();
      assertExpected(state, options.expectedRevision);
      const index = state.providers.findIndex((provider) => provider.id === normalized.id);
      if (index === -1) state.providers.push(normalized);
      else state.providers[index] = normalized;
      state.pendingSecretDeletes = appendPending(state.pendingSecretDeletes, options.pendingSecretDeletes);
      state.revision += 1;
      const written = writeState(state);
      return { entry: clone(normalized), stateRevision: written.revision };
    });
  }

  function remove(id, options = {}) {
    const wanted = String(id || '').trim();
    return withMutationLock(() => {
      const state = readState();
      assertExpected(state, options.expectedRevision);
      const nextProviders = state.providers.filter((provider) => provider.id !== wanted);
      const removed = nextProviders.length !== state.providers.length;
      const pending = appendPending(state.pendingSecretDeletes, options.pendingSecretDeletes);
      if (!removed && pending.length === state.pendingSecretDeletes.length) {
        return { removed: false, stateRevision: state.revision };
      }
      state.providers = nextProviders;
      state.pendingSecretDeletes = pending;
      state.revision += 1;
      const written = writeState(state);
      return { removed, stateRevision: written.revision };
    });
  }

  function acknowledgeSecretDelete(reference, options = {}) {
    if (typeof reference !== 'string' || !reference) throw storeError('PROVIDER_STORE_INVALID');
    try { parseProviderSecretReference(reference); } catch { throw storeError('PROVIDER_STORE_INVALID'); }
    return withMutationLock(() => {
      const state = readState();
      assertExpected(state, options.expectedRevision);
      const pending = state.pendingSecretDeletes.filter((ref) => ref.reference !== reference);
      if (pending.length === state.pendingSecretDeletes.length) return { stateRevision: state.revision };
      state.pendingSecretDeletes = pending;
      state.revision += 1;
      return { stateRevision: writeState(state).revision };
    });
  }

  function replaceState(value, options = {}) {
    const next = normalizePersistedState(value);
    return withMutationLock(() => {
      const raw = readRaw();
      if (options.expectedSourceRevision !== undefined) {
        if (typeof options.expectedSourceRevision !== 'string' || !options.expectedSourceRevision) {
          throw storeError('PROVIDER_STORE_INVALID');
        }
        const expectedSourceVersion = options.expectedSourceVersion === undefined
          ? next.version - 1
          : options.expectedSourceVersion;
        const currentSource = expectedSourceVersion === 1
          ? readLegacyMigrationInput()
          : expectedSourceVersion === 2 ? readSchemaMigrationInput() : null;
        if (!currentSource || currentSource.sourceRevision !== options.expectedSourceRevision) {
          throw storeError('PROVIDER_STORE_CONFLICT');
        }
      }
      if (options.expectedRevision !== undefined) {
        const current = raw === null ? emptyState() : normalizeStateV3(raw.parsed);
        assertExpected(current, options.expectedRevision);
      }
      return { stateRevision: writeState(next).revision };
    });
  }

  function needsSecretMigration() {
    const raw = readRaw();
    return raw !== null && raw.parsed?.version === 1;
  }

  function needsSchemaMigration() {
    const raw = readRaw();
    return raw !== null && raw.parsed?.version === 2;
  }

  function stableMigrationInput(raw, state) {
    if (typeof fs.statSync !== 'function') throw storeError('PROVIDER_STORE_UNAVAILABLE');
    let firstIdentity;
    let secondIdentity;
    let secondRaw;
    try {
      firstIdentity = readFileIdentity(fs, filePath());
      secondRaw = readRaw();
      secondIdentity = readFileIdentity(fs, filePath());
    } catch (error) {
      if (error?.code === 'PROVIDER_STORE_UNAVAILABLE') throw error;
      throw storeError('PROVIDER_STORE_UNAVAILABLE');
    }
    if (
      secondRaw === null
      || secondRaw.text !== raw.text
      || JSON.stringify(firstIdentity) !== JSON.stringify(secondIdentity)
    ) {
      throw storeError('PROVIDER_STORE_CONFLICT');
    }
    return { sourceRevision: JSON.stringify(firstIdentity), state: clone(state) };
  }

  function readLegacyMigrationInput() {
    const raw = readRaw();
    if (raw === null || raw.parsed?.version !== 1) return null;
    if (!raw.parsed || typeof raw.parsed !== 'object' || !Array.isArray(raw.parsed.providers)) {
      throw storeError('PROVIDER_STORE_INVALID');
    }
    for (const provider of raw.parsed.providers) {
      if (!provider || typeof provider !== 'object' || typeof provider.baseUrl !== 'string') {
        throw storeError('PROVIDER_STORE_INVALID');
      }
      requireSafeProviderUrl(provider.baseUrl);
    }
    return stableMigrationInput(raw, raw.parsed);
  }

  function readSchemaMigrationInput() {
    const raw = readRaw();
    if (raw === null || raw.parsed?.version !== 2) return null;
    return stableMigrationInput(raw, normalizeStateV2(raw.parsed));
  }

  async function writeRedactedBackup(value, policy = {}) {
    const state = normalizePersistedState(value);
    const keep = policy.keep === undefined ? 3 : policy.keep;
    const maxAgeDays = policy.maxAgeDays === undefined ? 30 : policy.maxAgeDays;
    if (!Number.isSafeInteger(keep) || keep < 1 || !Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
      throw storeError('PROVIDER_STORE_INVALID');
    }
    const backupDir = path.join(dir(), 'provider-backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const stamp = now();
    const file = path.join(backupDir, `providers-${stamp}.json`);
    fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
    if (typeof fs.readdirSync === 'function') {
      const names = fs.readdirSync(backupDir)
        .filter((name) => /^providers-\d+\.json$/.test(name))
        .sort()
        .reverse();
      const cutoff = stamp - maxAgeDays * 24 * 60 * 60 * 1000;
      for (let index = 0; index < names.length; index += 1) {
        const match = names[index].match(/^providers-(\d+)\.json$/);
        const tooOld = match && Number(match[1]) < cutoff;
        if (index >= keep || tooOld) {
          try { fs.unlinkSync(path.join(backupDir, names[index])); } catch { /* best effort */ }
        }
      }
    }
  }

  return Object.freeze({
    filePath,
    readState,
    readLegacyMigrationInput,
    readSchemaMigrationInput,
    list,
    get,
    upsert,
    remove,
    acknowledgeSecretDelete,
    replaceState,
    writeRedactedBackup,
    needsSecretMigration,
    needsSchemaMigration,
  });
}
