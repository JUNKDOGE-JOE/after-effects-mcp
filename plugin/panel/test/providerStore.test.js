import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createProviderStore } from '../src/cep/providerStore.js';

const CREDENTIAL_ID = '5eb75f05-5d9e-5d9c-85af-f0893e8b90c2';

function secretRef(slot, revision = 1) {
  return {
    kind: 'secret',
    reference: `aemcp-secret://provider/${CREDENTIAL_ID}/${slot}/v1`,
    revision,
  };
}

function providerEntry(overrides = {}) {
  return {
    id: 'relay',
    credentialId: CREDENTIAL_ID,
    name: 'Relay',
    protocol: 'openai-compatible',
    baseUrl: 'https://relay.example/openai',
    allowInsecureHttp: false,
    authProfileRevision: 1,
    auth: {
      model: { kind: 'bearer', valueRef: secretRef('auth-model-a13f28') },
      probe: { kind: 'inherit-model' },
    },
    headers: [],
    dialect: { override: null, detected: null },
    probedModels: [],
    probedAt: 0,
    ...overrides,
  };
}

function makeDeps() {
  const files = new Map();
  const dirs = new Set();
  const chmods = [];
  let now = 1_700_000_000_000;
  let nextFd = 10;
  let renameHook = null;
  let nonceCounter = 1;
  let lockUnlinkFailures = 0;
  let recoveryRenameHook = null;
  let tempWriteHook = null;
  let recoveryRestoreHook = null;
  let lockMtimeMs = now;
  let statFields = {
    dev: 11,
    ino: 22,
    mtimeMs: 1_700_000_000_123,
    ctimeMs: 1_700_000_000_456,
  };
  const locks = new Map();
  const fds = new Map();
  const livePids = new Map([[42, true]]);
  const providerLockPath = '/home/user/.ae-mcp/providers.json.lock';
  const fs = {
    existsSync: (p) => dirs.has(p) || files.has(p),
    mkdirSync: (p) => { dirs.add(p); },
    readFileSync: (p) => {
      if (!files.has(p)) { const e = new Error('missing'); e.code = 'ENOENT'; throw e; }
      return files.get(p);
    },
    writeFileSync: (p, v) => {
      const destination = typeof p === 'number' ? fds.get(p) : p;
      if (destination === undefined) throw new Error('unknown file descriptor');
      files.set(destination, String(v));
      if (typeof destination === 'string' && destination.endsWith('.tmp') && tempWriteHook) {
        const hook = tempWriteHook;
        tempWriteHook = null;
        hook({ destination, files });
      }
    },
    chmodSync: (p, mode) => { chmods.push([p, mode]); },
    renameSync: (from, to) => {
      if (!files.has(from)) throw new Error('missing temp');
      if (from === providerLockPath && to === `${providerLockPath}.recovering` && recoveryRenameHook) {
        const hook = recoveryRenameHook;
        recoveryRenameHook = null;
        hook({ from, to, files });
      }
      if (renameHook) {
        const hook = renameHook;
        renameHook = null;
        hook({ from, to });
      }
      files.set(to, files.get(from));
      files.delete(from);
      locks.delete(from);
      if (from === providerLockPath) lockMtimeMs = now;
    },
    unlinkSync: (p) => {
      if ((p === providerLockPath || p === `${providerLockPath}.recovering`) && lockUnlinkFailures > 0) {
        lockUnlinkFailures -= 1;
        const error = new Error('simulated lock cleanup failure');
        error.code = 'EACCES';
        throw error;
      }
      files.delete(p);
      locks.delete(p);
    },
    openSync: (p, flags) => {
      assert.equal(flags, 'wx');
      if (locks.has(p) || files.has(p)) { const error = new Error('locked'); error.code = 'EEXIST'; throw error; }
      const fd = nextFd++;
      locks.set(p, fd);
      fds.set(fd, p);
      files.set(p, '');
      if (p === providerLockPath) lockMtimeMs = now;
      return fd;
    },
    linkSync: (from, to) => {
      if (recoveryRestoreHook) {
        const hook = recoveryRestoreHook;
        recoveryRestoreHook = null;
        hook({ from, to, files });
      }
      if (!files.has(from)) { const error = new Error('missing source'); error.code = 'ENOENT'; throw error; }
      if (files.has(to)) { const error = new Error('destination exists'); error.code = 'EEXIST'; throw error; }
      files.set(to, files.get(from));
    },
    closeSync: (fd) => { fds.delete(fd); },
    readdirSync: (p) => Array.from(files.keys()).filter((f) => f.startsWith(`${p}/`)).map((f) => f.slice(p.length + 1)),
    statSync: (p) => ({
      ...statFields,
      size: Buffer.byteLength(String(files.get(p) || ''), 'utf8'),
      mtimeMs: p === providerLockPath || p === `${providerLockPath}.recovering`
        ? lockMtimeMs
        : statFields.mtimeMs,
      ctimeMs: p === providerLockPath || p === `${providerLockPath}.recovering`
        ? lockMtimeMs
        : statFields.ctimeMs,
    }),
  };
  const path = {
    join: (...parts) => parts.join('/'),
    basename: (value) => String(value).split('/').pop(),
  };
  const os = { homedir: () => '/home/user' };
  const crypto = {
    createHash,
    randomBytes(size) {
      const output = Buffer.alloc(size, nonceCounter);
      nonceCounter += 1;
      return output;
    },
  };
  return {
    fs, path, os, crypto, pid: 42, files, dirs, chmods,
    now: () => now++,
    isProcessAlive: (pid) => livePids.get(pid) === true,
    setRenameHook: (hook) => { renameHook = hook; },
    setFileIdentity: (patch) => { statFields = { ...statFields, ...patch }; },
    failNextLockUnlink: (count = 1) => { lockUnlinkFailures = count; },
    seedLock: (metadata, { ageMs = 0 } = {}) => {
      files.set(providerLockPath, `${JSON.stringify(metadata)}\n`);
      lockMtimeMs = now - ageMs;
    },
    seedRawLock: (raw, { ageMs = 0 } = {}) => {
      files.set(providerLockPath, raw);
      lockMtimeMs = now - ageMs;
    },
    seedRecovery: (raw, { ageMs = 0 } = {}) => {
      files.set(`${providerLockPath}.recovering`, raw);
      lockMtimeMs = now - ageMs;
    },
    readLock: () => JSON.parse(files.get(providerLockPath) || files.get(`${providerLockPath}.recovering`)),
    setProcessAlive: (pid, alive) => { livePids.set(pid, alive); },
    setRecoveryRenameHook: (hook) => { recoveryRenameHook = hook; },
    setRecoveryRestoreHook: (hook) => { recoveryRestoreHook = hook; },
    setTempWriteHook: (hook) => { tempWriteHook = hook; },
    currentTime: () => now,
  };
}

test('fresh state is v2 and contains no plaintext-provider compatibility surface', () => {
  const store = createProviderStore(makeDeps());
  assert.deepEqual(store.readState(), {
    version: 2,
    revision: 0,
    migratedLegacy: true,
    pendingSecretDeletes: [],
    providers: [],
  });
  assert.deepEqual(store.list(), []);
  assert.equal(store.needsSecretMigration(), false);
  assert.equal(store.readLegacyMigrationInput(), null);
});

test('upsert persists strict v2 entries with CAS and never persists a raw secret', () => {
  const deps = makeDeps();
  const store = createProviderStore(deps);
  const result = store.upsert(providerEntry(), { expectedRevision: 0 });
  assert.equal(result.stateRevision, 1);
  assert.deepEqual(result.entry, providerEntry());
  assert.deepEqual(store.get('relay'), providerEntry());

  const rawText = deps.files.get('/home/user/.ae-mcp/providers.json');
  const raw = JSON.parse(rawText);
  assert.equal(raw.version, 2);
  assert.equal(raw.revision, 1);
  assert.deepEqual(raw.pendingSecretDeletes, []);
  assert.equal(Object.hasOwn(raw.providers[0], 'apiKey'), false);
  assert.equal(rawText.includes('sk-provider-secret'), false);
  assert.match(raw.providers[0].auth.model.valueRef.reference, /^aemcp-secret:\/\//);
  assert.equal(deps.chmods.at(-1)[1], 0o600);
});

test('upsert and remove reject stale CAS revisions without modifying disk', () => {
  const deps = makeDeps();
  const store = createProviderStore(deps);
  store.upsert(providerEntry(), { expectedRevision: 0 });
  const before = deps.files.get(store.filePath());
  assert.throws(
    () => store.upsert(providerEntry({ name: 'Changed' }), { expectedRevision: 0 }),
    (error) => error.code === 'PROVIDER_STORE_CONFLICT',
  );
  assert.throws(
    () => store.remove('relay', { expectedRevision: 0 }),
    (error) => error.code === 'PROVIDER_STORE_CONFLICT',
  );
  assert.equal(deps.files.get(store.filePath()), before);
});

test('upsert and remove atomically append replaced references to the cleanup queue', () => {
  const deps = makeDeps();
  const store = createProviderStore(deps);
  const first = store.upsert(providerEntry(), { expectedRevision: 0 });
  const oldRef = providerEntry().auth.model.valueRef;
  const nextRef = secretRef('auth-model-new', 2);
  const updated = providerEntry({
    authProfileRevision: 2,
    auth: { model: { kind: 'bearer', valueRef: nextRef }, probe: { kind: 'inherit-model' } },
  });
  const second = store.upsert(updated, {
    expectedRevision: first.stateRevision,
    pendingSecretDeletes: [oldRef],
  });
  assert.equal(second.stateRevision, 2);
  assert.deepEqual(store.readState().pendingSecretDeletes, [oldRef]);

  const removed = store.remove('relay', {
    expectedRevision: second.stateRevision,
    pendingSecretDeletes: [nextRef],
  });
  assert.deepEqual(removed, { removed: true, stateRevision: 3 });
  assert.deepEqual(store.readState().pendingSecretDeletes, [oldRef, nextRef]);
  assert.equal(store.get('relay'), null);
});

test('acknowledgeSecretDelete removes one exact reference and is idempotent', () => {
  const store = createProviderStore(makeDeps());
  const ref = secretRef('auth-model-old', 4);
  store.upsert(providerEntry(), { expectedRevision: 0, pendingSecretDeletes: [ref] });
  const first = store.acknowledgeSecretDelete(ref.reference, { expectedRevision: 1 });
  assert.deepEqual(first, { stateRevision: 2 });
  assert.deepEqual(store.readState().pendingSecretDeletes, []);
  const second = store.acknowledgeSecretDelete(ref.reference, { expectedRevision: 2 });
  assert.deepEqual(second, { stateRevision: 2 });
});

test('v1 input is migration-only and source revision uses non-content-derived file identity', () => {
  const deps = makeDeps();
  const legacy = {
    version: 1,
    migratedLegacy: false,
    providers: [{ id: 'legacy', baseUrl: 'https://legacy.example', apiKey: 'sk-legacy-marker' }],
  };
  const text = JSON.stringify(legacy);
  deps.files.set('/home/user/.ae-mcp/providers.json', text);
  const store = createProviderStore(deps);
  deps.crypto.createHash = () => { throw new Error('content hashing is forbidden'); };
  assert.equal(store.needsSecretMigration(), true);
  assert.deepEqual(store.list(), []);
  const migration = store.readLegacyMigrationInput();
  assert.deepEqual(migration.state, legacy);
  assert.deepEqual(JSON.parse(migration.sourceRevision), {
    kind: 'provider-file-identity-v1',
    dev: 11,
    ino: 22,
    size: Buffer.byteLength(text, 'utf8'),
    mtimeMs: 1_700_000_000_123,
    ctimeMs: 1_700_000_000_456,
  });
});

test('legacy migration fails closed when file stat identity is unavailable', () => {
  const deps = makeDeps();
  deps.files.set('/home/user/.ae-mcp/providers.json', JSON.stringify({
    version: 1,
    migratedLegacy: false,
    providers: [{ id: 'legacy', baseUrl: 'https://legacy.example', apiKey: 'sk-legacy' }],
  }));
  delete deps.fs.statSync;
  const store = createProviderStore(deps);
  assert.throws(
    () => store.readLegacyMigrationInput(),
    (error) => error.code === 'PROVIDER_STORE_UNAVAILABLE',
  );
});

test('legacy migration uses BigInt stat when CEP reports an unsafe Windows inode', () => {
  const deps = makeDeps();
  const legacy = {
    version: 1,
    migratedLegacy: false,
    providers: [{ id: 'legacy', baseUrl: 'https://legacy.example', apiKey: 'sk-legacy-marker' }],
  };
  const text = JSON.stringify(legacy);
  deps.files.set('/home/user/.ae-mcp/providers.json', text);
  const statSync = deps.fs.statSync;
  let bigintReads = 0;
  deps.fs.statSync = (path, options) => {
    if (options?.bigint === true) {
      bigintReads += 1;
      return {
        dev: 2_352_244_688n,
        ino: 93_731_167_244_702_350n,
        size: BigInt(Buffer.byteLength(text, 'utf8')),
        mtimeMs: 1_783_534_310_888n,
        ctimeMs: 1_783_534_310_888n,
      };
    }
    return { ...statSync(path), ino: 93_731_167_244_702_350 };
  };

  const migration = createProviderStore(deps).readLegacyMigrationInput();
  assert.equal(bigintReads, 2);
  assert.deepEqual(JSON.parse(migration.sourceRevision), {
    kind: 'provider-file-identity-v1',
    dev: 2_352_244_688,
    ino: '93731167244702350',
    size: Buffer.byteLength(text, 'utf8'),
    mtimeMs: 1_783_534_310_888,
    ctimeMs: 1_783_534_310_888,
  });
});

test('replaceState commits a migration result and writeRedactedBackup never receives plaintext', async () => {
  const deps = makeDeps();
  const store = createProviderStore(deps);
  const state = {
    version: 2,
    revision: 1,
    migratedLegacy: true,
    pendingSecretDeletes: [],
    providers: [providerEntry()],
  };
  assert.deepEqual(store.replaceState(state), { stateRevision: 1 });
  await store.writeRedactedBackup(state, { keep: 3, maxAgeDays: 30 });
  const backup = Array.from(deps.files.entries()).find(([path]) => path.includes('provider-backups/'));
  assert.ok(backup);
  assert.equal(backup[1].includes('sk-provider-secret'), false);
  assert.equal(store.needsSecretMigration(), false);
});

test('replaceState compares the legacy file identity again while holding the mutation lock', () => {
  const deps = makeDeps();
  const legacy = {
    version: 1,
    migratedLegacy: false,
    providers: [{ id: 'legacy', baseUrl: 'https://legacy.example', apiKey: 'sk-legacy-marker' }],
  };
  deps.files.set('/home/user/.ae-mcp/providers.json', JSON.stringify(legacy));
  const store = createProviderStore(deps);
  const sourceRevision = store.readLegacyMigrationInput().sourceRevision;
  deps.setFileIdentity({ mtimeMs: 1_700_000_000_999 });
  assert.throws(
    () => store.replaceState({
      version: 2,
      revision: 1,
      migratedLegacy: true,
      pendingSecretDeletes: [],
      providers: [providerEntry()],
    }, { expectedSourceRevision: sourceRevision }),
    (error) => error.code === 'PROVIDER_STORE_CONFLICT',
  );
  assert.equal(JSON.parse(deps.files.get(store.filePath())).version, 1);
});

test('existing corrupt v2 state fails closed instead of silently becoming an empty store', () => {
  const deps = makeDeps();
  deps.files.set('/home/user/.ae-mcp/providers.json', JSON.stringify({ version: 2, revision: 1, providers: [{ apiKey: 'leak' }] }));
  const store = createProviderStore(deps);
  assert.throws(() => store.readState(), (error) => error.code === 'PROVIDER_STORE_INVALID');
  assert.throws(() => store.list(), (error) => error.code === 'PROVIDER_STORE_INVALID');
});

test('store rejects credential-bearing provider base URLs even when callers bypass the UI flow', () => {
  const deps = makeDeps();
  const store = createProviderStore(deps);
  assert.throws(
    () => store.upsert(providerEntry({ baseUrl: 'https://user:secret@relay.example/v1' }), { expectedRevision: 0 }),
    (error) => error.code === 'PROVIDER_STORE_INVALID',
  );
  assert.throws(
    () => store.replaceState({
      version: 2,
      revision: 1,
      migratedLegacy: true,
      pendingSecretDeletes: [],
      providers: [providerEntry({ baseUrl: 'https://relay.example/v1?auth_token=secret' })],
    }),
    (error) => error.code === 'PROVIDER_STORE_INVALID',
  );
  assert.equal(deps.files.has(store.filePath()), false);
});

test('legacy migration input rejects credential-bearing URLs before any helper write can start', () => {
  const deps = makeDeps();
  deps.files.set('/home/user/.ae-mcp/providers.json', JSON.stringify({
    version: 1,
    migratedLegacy: false,
    providers: [{ id: 'unsafe', baseUrl: 'https://relay.example?vendor_token=secret', apiKey: 'sk-legacy' }],
  }));
  const store = createProviderStore(deps);
  assert.throws(() => store.readLegacyMigrationInput(), (error) => error.code === 'PROVIDER_STORE_INVALID');
});

test('store rejects every provider URL query value instead of relying on sensitive key names', () => {
  const deps = makeDeps();
  const store = createProviderStore(deps);
  assert.throws(
    () => store.upsert(providerEntry({ baseUrl: 'https://relay.example/v1?region=sk-hidden-value' }), { expectedRevision: 0 }),
    (error) => error.code === 'PROVIDER_STORE_INVALID',
  );
  assert.equal(deps.files.has(store.filePath()), false);
});

test('provider mutations hold a cross-process lock across re-read, CAS, and atomic rename', () => {
  const saveSaveDeps = makeDeps();
  const first = createProviderStore(saveSaveDeps);
  const second = createProviderStore(saveSaveDeps);
  let nestedSaveError = null;
  saveSaveDeps.setRenameHook(() => {
    try {
      second.upsert(providerEntry({ id: 'second', name: 'Second' }), { expectedRevision: 0 });
    } catch (error) {
      nestedSaveError = error;
    }
  });
  first.upsert(providerEntry({ id: 'first', name: 'First' }), { expectedRevision: 0 });
  assert.equal(nestedSaveError?.code, 'PROVIDER_STORE_CONFLICT');
  assert.deepEqual(first.list().map((provider) => provider.id), ['first']);

  const saveDeleteDeps = makeDeps();
  const editor = createProviderStore(saveDeleteDeps);
  const remover = createProviderStore(saveDeleteDeps);
  editor.upsert(providerEntry(), { expectedRevision: 0 });
  let nestedDeleteError = null;
  saveDeleteDeps.setRenameHook(() => {
    try {
      remover.remove('relay', { expectedRevision: 1, pendingSecretDeletes: [providerEntry().auth.model.valueRef] });
    } catch (error) {
      nestedDeleteError = error;
    }
  });
  editor.upsert(providerEntry({ name: 'Edited' }), { expectedRevision: 1 });
  assert.equal(nestedDeleteError?.code, 'PROVIDER_STORE_CONFLICT');
  assert.equal(editor.get('relay').name, 'Edited');
});

test('a committed mutation remains successful when lock unlink fails and its released nonce is safely recovered', () => {
  const deps = makeDeps();
  const first = createProviderStore(deps);
  deps.failNextLockUnlink();

  const committed = first.upsert(providerEntry(), { expectedRevision: 0 });

  assert.equal(committed.stateRevision, 1);
  assert.equal(first.readState().revision, 1);
  const released = deps.readLock();
  assert.deepEqual(Object.keys(released).sort(), ['createdAt', 'ownerNonce', 'pid', 'schemaVersion']);
  assert.equal(released.schemaVersion, 1);
  assert.equal(released.pid, 42);
  assert.match(released.ownerNonce, /^[0-9a-f]{32,}$/);

  const second = createProviderStore(deps);
  const next = second.upsert(providerEntry({ name: 'Recovered' }), { expectedRevision: 1 });
  assert.equal(next.stateRevision, 2);
  assert.equal(second.get('relay').name, 'Recovered');
});

test('a dead lock owner is recovered but a live owner is never stolen', () => {
  const deadDeps = makeDeps();
  const deadNonce = 'a'.repeat(32);
  deadDeps.seedLock({ schemaVersion: 1, ownerNonce: deadNonce, pid: 9001, createdAt: 1_700_000_000_000 });
  deadDeps.setProcessAlive(9001, false);
  const recovered = createProviderStore(deadDeps).upsert(providerEntry(), { expectedRevision: 0 });
  assert.equal(recovered.stateRevision, 1);

  const liveDeps = makeDeps();
  const liveNonce = 'b'.repeat(32);
  liveDeps.seedLock({ schemaVersion: 1, ownerNonce: liveNonce, pid: 9002, createdAt: liveDeps.currentTime() });
  liveDeps.setProcessAlive(9002, true);
  assert.throws(
    () => createProviderStore(liveDeps).upsert(providerEntry(), { expectedRevision: 0 }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_STORE_CONFLICT');
      assert.equal(error.message.includes(liveNonce), false);
      assert.equal(error.message.includes('/home/user'), false);
      return true;
    },
  );
  assert.equal(liveDeps.readLock().ownerNonce, liveNonce);
  assert.equal(liveDeps.files.has('/home/user/.ae-mcp/providers.json'), false);
});

test('stale empty and half-written lock files recover after the grace period but fresh ones fail closed', () => {
  for (const raw of ['', '{"schemaVersion":1,"ownerNonce":']) {
    const staleDeps = makeDeps();
    staleDeps.seedRawLock(raw, { ageMs: 60_000 });
    assert.equal(createProviderStore(staleDeps).upsert(providerEntry(), { expectedRevision: 0 }).stateRevision, 1);

    const freshDeps = makeDeps();
    freshDeps.seedRawLock(raw, { ageMs: 100 });
    assert.throws(
      () => createProviderStore(freshDeps).upsert(providerEntry(), { expectedRevision: 0 }),
      (error) => error.code === 'PROVIDER_STORE_CONFLICT',
    );
    assert.equal(freshDeps.files.get('/home/user/.ae-mcp/providers.json.lock'), raw);
  }
});

test('a crash-left recovery quarantine follows the same stale grace and cannot wedge the store forever', () => {
  const staleDeps = makeDeps();
  staleDeps.seedRecovery('{"schemaVersion":1,"ownerNonce":', { ageMs: 60_000 });
  assert.equal(createProviderStore(staleDeps).upsert(providerEntry(), { expectedRevision: 0 }).stateRevision, 1);
  assert.equal(staleDeps.files.has('/home/user/.ae-mcp/providers.json.lock.recovering'), false);

  const freshDeps = makeDeps();
  freshDeps.seedRecovery('', { ageMs: 100 });
  assert.throws(
    () => createProviderStore(freshDeps).upsert(providerEntry(), { expectedRevision: 0 }),
    (error) => error.code === 'PROVIDER_STORE_CONFLICT',
  );
  assert.equal(freshDeps.files.has('/home/user/.ae-mcp/providers.json.lock.recovering'), true);
});

test('an expired lock lease recovers even when its pid has been reused by a live process', () => {
  const deps = makeDeps();
  const nonce = 'c'.repeat(32);
  deps.seedLock({
    schemaVersion: 1,
    ownerNonce: nonce,
    pid: 9003,
    createdAt: deps.currentTime() - 60_000,
  }, { ageMs: 60_000 });
  deps.setProcessAlive(9003, true);
  const result = createProviderStore(deps).upsert(providerEntry(), { expectedRevision: 0 });
  assert.equal(result.stateRevision, 1);
});

test('stale-lock recovery quarantines and restores a replacement live lock instead of deleting it', () => {
  const deps = makeDeps();
  const stale = { schemaVersion: 1, ownerNonce: 'd'.repeat(32), pid: 9004, createdAt: 1 };
  const replacement = {
    schemaVersion: 1,
    ownerNonce: 'e'.repeat(32),
    pid: 9005,
    createdAt: deps.currentTime(),
  };
  deps.seedLock(stale, { ageMs: 60_000 });
  deps.setProcessAlive(9004, false);
  deps.setProcessAlive(9005, true);
  deps.setRecoveryRenameHook(({ from, files }) => {
    files.set(from, `${JSON.stringify(replacement)}\n`);
  });

  assert.throws(
    () => createProviderStore(deps).upsert(providerEntry(), { expectedRevision: 0 }),
    (error) => error.code === 'PROVIDER_STORE_CONFLICT',
  );
  assert.deepEqual(deps.readLock(), replacement);
  assert.equal(deps.files.has('/home/user/.ae-mcp/providers.json.lock.recovering'), false);
  assert.equal(deps.files.has('/home/user/.ae-mcp/providers.json'), false);
});

test('normal lock release also restores a replacement live lock instead of unlinking it', () => {
  const deps = makeDeps();
  const replacement = {
    schemaVersion: 1,
    ownerNonce: '1'.repeat(32),
    pid: 9011,
    createdAt: deps.currentTime(),
  };
  deps.setProcessAlive(9011, true);
  deps.setRecoveryRenameHook(({ from, files }) => {
    files.set(from, `${JSON.stringify(replacement)}\n`);
  });

  const result = createProviderStore(deps).upsert(providerEntry(), { expectedRevision: 0 });
  assert.equal(result.stateRevision, 1);
  assert.deepEqual(deps.readLock(), replacement);
  assert.equal(deps.files.has('/home/user/.ae-mcp/providers.json.lock.recovering'), false);
});

test('replacement restoration never overwrites a newer live lock that wins the restore race', () => {
  const deps = makeDeps();
  const stale = { schemaVersion: 1, ownerNonce: '2'.repeat(32), pid: 9012, createdAt: 1 };
  const movedReplacement = {
    schemaVersion: 1,
    ownerNonce: '3'.repeat(32),
    pid: 9013,
    createdAt: deps.currentTime(),
  };
  const newerReplacement = {
    schemaVersion: 1,
    ownerNonce: '4'.repeat(32),
    pid: 9014,
    createdAt: deps.currentTime(),
  };
  deps.seedLock(stale, { ageMs: 60_000 });
  deps.setProcessAlive(9012, false);
  deps.setProcessAlive(9013, true);
  deps.setProcessAlive(9014, true);
  deps.setRecoveryRenameHook(({ from, files }) => {
    files.set(from, `${JSON.stringify(movedReplacement)}\n`);
  });
  deps.setRecoveryRestoreHook(({ to, files }) => {
    files.set(to, `${JSON.stringify(newerReplacement)}\n`);
  });

  assert.throws(
    () => createProviderStore(deps).upsert(providerEntry(), { expectedRevision: 0 }),
    (error) => error.code === 'PROVIDER_STORE_CONFLICT',
  );
  assert.deepEqual(deps.readLock(), newerReplacement);
  assert.equal(deps.files.has('/home/user/.ae-mcp/providers.json.lock.recovering'), true);
});

test('a writer fenced by a replacement lock reports conflict and never publishes its temp state', () => {
  const deps = makeDeps();
  const replacement = {
    schemaVersion: 1,
    ownerNonce: 'f'.repeat(32),
    pid: 9010,
    createdAt: deps.currentTime(),
  };
  deps.setProcessAlive(9010, true);
  deps.setTempWriteHook(({ files }) => {
    files.set('/home/user/.ae-mcp/providers.json.lock', `${JSON.stringify(replacement)}\n`);
  });

  assert.throws(
    () => createProviderStore(deps).upsert(providerEntry(), { expectedRevision: 0 }),
    (error) => error.code === 'PROVIDER_STORE_CONFLICT',
  );
  assert.deepEqual(deps.readLock(), replacement);
  assert.equal(deps.files.has('/home/user/.ae-mcp/providers.json'), false);
  assert.equal(Array.from(deps.files.keys()).some((file) => file.endsWith('.tmp')), false);
});

test('pending deletes are unique by reference even when revisions differ', () => {
  const deps = makeDeps();
  const store = createProviderStore(deps);
  const reference = secretRef('queued', 1).reference;
  assert.throws(
    () => store.replaceState({
      version: 2,
      revision: 1,
      migratedLegacy: true,
      pendingSecretDeletes: [
        { kind: 'secret', reference, revision: 1 },
        { kind: 'secret', reference, revision: 2 },
      ],
      providers: [],
    }),
    (error) => error.code === 'PROVIDER_STORE_INVALID',
  );
});

test('pending deletes can never overlap an active provider secret reference', () => {
  const deps = makeDeps();
  const store = createProviderStore(deps);
  const active = providerEntry().auth.model.valueRef;
  assert.throws(
    () => store.upsert(providerEntry(), { expectedRevision: 0, pendingSecretDeletes: [active] }),
    (error) => error.code === 'PROVIDER_STORE_INVALID',
  );
  assert.equal(deps.files.has(store.filePath()), false);
});
