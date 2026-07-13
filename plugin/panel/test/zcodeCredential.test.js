import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createZcodeCredentialManager,
  ZCODE_CREDENTIAL_ID,
  ZCODE_CREDENTIAL_STORAGE_KEY,
} from '../src/cep/zcodeCredential.js';

function valueRef(slot = 'auth-model-00112233', revision = 1) {
  return {
    kind: 'secret',
    reference: `aemcp-secret://provider/${ZCODE_CREDENTIAL_ID}/${slot}/v1`,
    revision,
  };
}

function harness({ legacy = '', createFailure = null } = {}) {
  const data = new Map();
  const secrets = new Map();
  const deleted = [];
  let legacyValue = legacy;
  let nextRevision = 1;
  const storage = {
    getItem: (key) => data.get(key) || null,
    setItem: (key, value) => { data.set(key, value); },
  };
  const secretService = {
    async create({ value }) {
      if (createFailure) throw createFailure;
      const ref = valueRef(`auth-model-${String(nextRevision).padStart(8, '0')}`, nextRevision);
      nextRevision += 1;
      secrets.set(ref.reference, { ref, value });
      return ref;
    },
    async resolve(ref) {
      const record = secrets.get(ref.reference);
      if (!record || record.ref.revision !== ref.revision) throw new Error('missing');
      return record.value;
    },
    async delete(ref) {
      deleted.push(ref);
      secrets.delete(ref.reference);
      return { deleted: true, revision: ref.revision };
    },
  };
  const legacyKeyStore = {
    readKey: () => legacyValue,
    clearKey: () => { legacyValue = ''; },
  };
  return {
    data,
    deleted,
    legacyKeyStore,
    secretService,
    secrets,
    storage,
    legacyValue: () => legacyValue,
  };
}

test('save persists only an opaque reference and resolves the value from the helper', async () => {
  const h = harness();
  const manager = createZcodeCredentialManager(h);
  const secret = 'opaque-zcode-value-without-prefix';
  assert.equal(await manager.save(secret), secret);
  const persisted = h.data.get(ZCODE_CREDENTIAL_STORAGE_KEY);
  assert.ok(persisted);
  assert.equal(persisted.includes(secret), false);
  assert.equal(await manager.resolve(), secret);
});

test('loadOrMigrate moves a legacy plaintext key before returning it', async () => {
  const h = harness({ legacy: 'legacy-zcode-value' });
  const manager = createZcodeCredentialManager(h);
  assert.equal(await manager.loadOrMigrate(), 'legacy-zcode-value');
  assert.equal(h.legacyValue(), '');
  assert.equal(h.data.get(ZCODE_CREDENTIAL_STORAGE_KEY).includes('legacy-zcode-value'), false);
});

test('helper failure never returns or rewrites a legacy plaintext key', async () => {
  const secret = 'legacy-value-that-must-stay-confined';
  const h = harness({ legacy: secret, createFailure: new Error(`failed ${secret}`) });
  const manager = createZcodeCredentialManager(h);
  await assert.rejects(
    manager.loadOrMigrate(),
    (error) => error.code === 'ZCODE_CREDENTIAL_UNAVAILABLE' && !error.message.includes(secret),
  );
  assert.equal(h.legacyValue(), secret);
  assert.equal(h.data.has(ZCODE_CREDENTIAL_STORAGE_KEY), false);
});

test('replacing a key publishes the new reference before deleting the old revision', async () => {
  const h = harness();
  const manager = createZcodeCredentialManager(h);
  await manager.save('first-value');
  const first = manager.readValueRef();
  await manager.save('second-value');
  assert.deepEqual(h.deleted, [first]);
  assert.equal(await manager.resolve(), 'second-value');
});

test('corrupt or cross-scope metadata fails closed before helper resolution', async () => {
  const h = harness();
  h.data.set(ZCODE_CREDENTIAL_STORAGE_KEY, JSON.stringify({
    ...valueRef(),
    reference: 'aemcp-secret://provider/5eb75f05-5d9e-5d9c-85af-f0893e8b90c2/auth-model-00112233/v1',
  }));
  const manager = createZcodeCredentialManager(h);
  await assert.rejects(manager.loadOrMigrate(), { code: 'ZCODE_CREDENTIAL_UNAVAILABLE' });
});
