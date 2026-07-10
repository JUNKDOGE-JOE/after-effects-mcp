import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  deleteProviderProfile,
  drainPendingProviderSecretDeletes,
  importProviderDraft,
  saveProviderDraft,
} from '../src/app/providerProfileFlow.js';

const CREDENTIAL_ID = '5eb75f05-5d9e-5d9c-85af-f0893e8b90c2';

function secretRef(slot, revision = 1) {
  return {
    kind: 'secret',
    reference: `aemcp-secret://provider/${CREDENTIAL_ID}/${slot}/v1`,
    revision,
  };
}

function providerDraft(overrides = {}) {
  return {
    id: '',
    name: 'Provider 1',
    protocol: 'openai-compatible',
    baseUrl: 'https://provider.example/v1',
    allowInsecureHttp: false,
    modelAuthKind: 'bearer',
    modelAuthHeaderName: '',
    modelAuthSecret: '',
    probeAuthMode: 'inherit-model',
    probeAuthKind: 'none',
    probeAuthHeaderName: '',
    probeAuthSecret: '',
    headers: [],
    dialectOverride: '',
    ...overrides,
  };
}

function providerEntry(overrides = {}) {
  return {
    id: 'provider-1',
    credentialId: CREDENTIAL_ID,
    name: 'Provider 1',
    protocol: 'openai-compatible',
    baseUrl: 'https://provider.example/v1',
    allowInsecureHttp: false,
    authProfileRevision: 1,
    auth: {
      model: { kind: 'bearer', valueRef: secretRef('auth-model-old', 1) },
      probe: { kind: 'inherit-model' },
    },
    headers: [],
    dialect: { override: null, detected: null },
    probedModels: [],
    probedAt: 0,
    ...overrides,
  };
}

function createdSecretService({ failDelete = false } = {}) {
  const created = [];
  const deleted = [];
  return {
    created,
    deleted,
    async create({ credentialId, slotPrefix, value }) {
      const ref = {
        kind: 'secret',
        reference: `aemcp-secret://provider/${credentialId}/${slotPrefix}-new/v1`,
        revision: 1,
      };
      created.push({ credentialId, slotPrefix, value, ref });
      return ref;
    },
    async delete(ref) {
      deleted.push(ref);
      if (failDelete) throw Object.assign(new Error('helper unavailable'), { code: 'SECRET_STORE_UNAVAILABLE' });
      return { deleted: true, revision: null };
    },
  };
}

test('saveProviderDraft deletes a newly-created secret when JSON commit fails', async () => {
  const secretService = createdSecretService();
  const store = { readState: () => ({ revision: 0 }), upsert: () => { throw new Error('disk full'); } };
  await assert.rejects(
    saveProviderDraft({
      draft: providerDraft({ modelAuthSecret: 'sk-new' }),
      current: null,
      store,
      secretService,
      confirmInsecureHttp: async () => true,
      randomUUID: () => CREDENTIAL_ID,
    }),
    /disk full/,
  );
  assert.deepEqual(secretService.deleted, secretService.created.map((item) => item.ref));
});

test('saveProviderDraft commits only a secret reference and never forwards raw draft fields to store', async () => {
  const secretService = createdSecretService();
  const calls = [];
  const store = {
    readState: () => ({ revision: 3 }),
    upsert(entry, options) {
      calls.push({ entry: structuredClone(entry), options: structuredClone(options) });
      return { entry, stateRevision: 4 };
    },
  };
  const result = await saveProviderDraft({
    draft: providerDraft({ id: 'relay', modelAuthSecret: 'sk-provider-secret' }),
    current: null,
    store,
    secretService,
    confirmInsecureHttp: async () => true,
    randomUUID: () => CREDENTIAL_ID,
  });

  assert.equal(result.id, 'relay');
  assert.equal(result.auth.model.valueRef.kind, 'secret');
  assert.equal(Object.hasOwn(result, 'modelAuthSecret'), false);
  assert.equal(JSON.stringify(result).includes('sk-provider-secret'), false);
  assert.equal(JSON.stringify(calls).includes('sk-provider-secret'), false);
  assert.deepEqual(calls[0].options, { expectedRevision: 3, pendingSecretDeletes: [] });
});

test('empty secret fields retain existing references without resolving them', async () => {
  const current = providerEntry();
  const secretService = createdSecretService();
  let committed;
  const store = {
    readState: () => ({ revision: 8 }),
    upsert(entry, options) {
      committed = { entry, options };
      return { entry, stateRevision: 9 };
    },
  };
  const result = await saveProviderDraft({
    draft: providerDraft({ id: current.id, name: 'Renamed' }),
    current,
    store,
    secretService,
    confirmInsecureHttp: async () => true,
    randomUUID: () => { throw new Error('must not generate a new credential id'); },
  });
  assert.deepEqual(result.auth.model.valueRef, current.auth.model.valueRef);
  assert.equal(secretService.created.length, 0);
  assert.deepEqual(committed.options.pendingSecretDeletes, []);
});

test('editing a secret queues the old reference in the same CAS write and retains it if cleanup fails', async () => {
  const current = providerEntry();
  const secretService = createdSecretService({ failDelete: true });
  const calls = [];
  const store = {
    readState: () => ({ revision: 4 }),
    upsert(entry, options) {
      calls.push({ entry, options });
      return { entry, stateRevision: 5 };
    },
    acknowledgeSecretDelete() {
      throw new Error('must not acknowledge failed cleanup');
    },
  };
  const saved = await saveProviderDraft({
    draft: providerDraft({ id: current.id, modelAuthSecret: 'sk-replacement' }),
    current,
    store,
    secretService,
    confirmInsecureHttp: async () => true,
    randomUUID: () => CREDENTIAL_ID,
  });
  assert.notDeepEqual(saved.auth.model.valueRef, current.auth.model.valueRef);
  assert.deepEqual(calls[0].options, {
    expectedRevision: 4,
    pendingSecretDeletes: [current.auth.model.valueRef],
  });
  assert.deepEqual(secretService.deleted, [current.auth.model.valueRef]);
});

test('a successful helper delete is acknowledged immediately even when it returns the deleted revision', async () => {
  const current = providerEntry();
  const secretService = createdSecretService();
  secretService.delete = async (ref) => {
    secretService.deleted.push(ref);
    return { deleted: true, revision: ref.revision };
  };
  const acknowledgements = [];
  const store = {
    readState: () => ({ revision: 4 }),
    upsert: (entry) => ({ entry, stateRevision: 5 }),
    acknowledgeSecretDelete(reference, options) {
      acknowledgements.push({ reference, options });
      return { stateRevision: 6 };
    },
  };
  await saveProviderDraft({
    draft: providerDraft({ id: current.id, modelAuthSecret: 'sk-replacement' }),
    current,
    store,
    secretService,
    confirmInsecureHttp: async () => true,
    randomUUID: () => CREDENTIAL_ID,
  });
  assert.deepEqual(acknowledgements, [{
    reference: current.auth.model.valueRef.reference,
    options: { expectedRevision: 5 },
  }]);
});

test('a pre-commit failure deletes new references but never deletes or queues old references', async () => {
  const current = providerEntry();
  const secretService = createdSecretService();
  let optionsSeen = null;
  const store = {
    readState: () => ({ revision: 2 }),
    upsert(_entry, options) {
      optionsSeen = options;
      throw new Error('CAS conflict');
    },
  };
  await assert.rejects(saveProviderDraft({
    draft: providerDraft({ id: current.id, modelAuthSecret: 'sk-new' }),
    current,
    store,
    secretService,
    confirmInsecureHttp: async () => true,
    randomUUID: () => CREDENTIAL_ID,
  }), /CAS conflict/);
  assert.deepEqual(optionsSeen.pendingSecretDeletes, [current.auth.model.valueRef]);
  assert.equal(secretService.deleted.some((ref) => ref.reference === current.auth.model.valueRef.reference), false);
  assert.equal(secretService.deleted.length, 1);
});

test('save snapshots the CAS revision before creating secrets and rolls back on a concurrent edit', async () => {
  let revision = 5;
  let commits = 0;
  const secretService = createdSecretService();
  const create = secretService.create.bind(secretService);
  secretService.create = async (input) => {
    const ref = await create(input);
    revision += 1;
    return ref;
  };
  const store = {
    readState: () => ({ revision }),
    upsert(entry, options) {
      if (options.expectedRevision !== revision) throw new Error('CAS conflict');
      commits += 1;
      return { entry, stateRevision: revision + 1 };
    },
  };

  await assert.rejects(saveProviderDraft({
    draft: providerDraft({ id: 'relay', modelAuthSecret: 'sk-concurrent' }),
    current: null,
    store,
    secretService,
    confirmInsecureHttp: async () => true,
    randomUUID: () => CREDENTIAL_ID,
  }), /CAS conflict/);
  assert.equal(commits, 0);
  assert.deepEqual(secretService.deleted, secretService.created.map((item) => item.ref));
});

test('deleteProviderProfile commits all protected references before best-effort deletion', async () => {
  const provider = providerEntry({
    headers: [{ id: 'h', name: 'x-feature', scopes: ['model'], valueRef: secretRef('header-old', 2) }],
  });
  const queued = [provider.auth.model.valueRef, provider.headers[0].valueRef];
  const secretService = createdSecretService({ failDelete: true });
  const store = {
    readState: () => ({ revision: 6 }),
    remove(id, options) {
      assert.equal(id, provider.id);
      assert.deepEqual(options, { expectedRevision: 6, pendingSecretDeletes: queued });
      return { removed: true, stateRevision: 7 };
    },
    acknowledgeSecretDelete() { throw new Error('must not acknowledge'); },
  };
  assert.deepEqual(await deleteProviderProfile({ provider, store, secretService }), { removed: true });
  assert.deepEqual(secretService.deleted, queued);
});

test('drainPendingProviderSecretDeletes is idempotent and acknowledges absent secrets', async () => {
  const pending = [secretRef('old-a', 1), secretRef('old-b', 2)];
  const state = { revision: 9, pendingSecretDeletes: pending.slice() };
  const acknowledged = [];
  const store = {
    readState: () => ({ revision: state.revision, pendingSecretDeletes: state.pendingSecretDeletes.slice() }),
    acknowledgeSecretDelete(reference, { expectedRevision }) {
      assert.equal(expectedRevision, state.revision);
      state.pendingSecretDeletes = state.pendingSecretDeletes.filter((ref) => ref.reference !== reference);
      state.revision += 1;
      acknowledged.push(reference);
      return { stateRevision: state.revision };
    },
  };
  const deleted = [];
  const secretService = {
    async delete(ref) {
      deleted.push(ref.reference);
      return { deleted: ref.reference.endsWith('old-a/v1'), revision: null };
    },
  };
  assert.deepEqual(await drainPendingProviderSecretDeletes({ store, secretService }), { deleted: 2, pending: 0 });
  assert.deepEqual(acknowledged, deleted);
  assert.deepEqual(await drainPendingProviderSecretDeletes({ store, secretService }), { deleted: 0, pending: 0 });
});

test('drain keeps a reference queued when delete reports a live conflicting revision', async () => {
  const ref = secretRef('old-conflict', 1);
  let acknowledgements = 0;
  const store = {
    readState: () => ({ revision: 3, pendingSecretDeletes: [ref] }),
    acknowledgeSecretDelete() { acknowledgements += 1; return { stateRevision: 4 }; },
  };
  const secretService = { delete: async () => ({ deleted: false, revision: 2 }) };
  assert.deepEqual(await drainPendingProviderSecretDeletes({ store, secretService }), { deleted: 0, pending: 1 });
  assert.equal(acknowledgements, 0);
});

test('drain immediately acknowledges a successful delete that reports its deleted revision', async () => {
  const ref = secretRef('old-deleted', 3);
  let pending = [ref];
  let revision = 8;
  const store = {
    readState: () => ({ revision, pendingSecretDeletes: pending.slice() }),
    acknowledgeSecretDelete(reference, { expectedRevision }) {
      assert.equal(expectedRevision, revision);
      pending = pending.filter((item) => item.reference !== reference);
      revision += 1;
      return { stateRevision: revision };
    },
  };
  const result = await drainPendingProviderSecretDeletes({
    store,
    secretService: { delete: async () => ({ deleted: true, revision: 3 }) },
  });
  assert.deepEqual(result, { deleted: 1, pending: 0 });
});

test('importProviderDraft consumes an ephemeral secret but never passes it to providerStore.upsert', async () => {
  const secretService = createdSecretService();
  let serializedStoreCall = '';
  const store = {
    readState: () => ({ revision: 0 }),
    upsert(entry, options) {
      serializedStoreCall = JSON.stringify({ entry, options });
      return { entry, stateRevision: 1 };
    },
  };
  const imported = await importProviderDraft({
    candidate: {
      candidateId: 'ccswitch-relay',
      name: 'Imported Relay',
      protocol: 'openai-compatible',
      baseUrl: 'https://import.example/v1',
      modelAuthKind: 'bearer',
      modelAuthSecret: 'sk-import-marker',
      dialectHint: 'chat',
    },
    store,
    secretService,
    randomUUID: () => CREDENTIAL_ID,
  });
  assert.equal(serializedStoreCall.includes('sk-import-marker'), false);
  assert.equal(Object.hasOwn(imported, 'modelAuthSecret'), false);
  assert.deepEqual(imported.dialect.override.wireApi, 'chat');
  assert.equal(imported.dialect.override.source, 'ccswitch-import');
});

test('re-importing the same candidate uses edit copy-on-write and queues the prior reference', async () => {
  const current = providerEntry({ id: 'ccswitch-relay' });
  const secretService = createdSecretService();
  let committed = null;
  const store = {
    get: (id) => id === current.id ? current : null,
    readState: () => ({ revision: 7 }),
    upsert(entry, options) {
      committed = { entry, options };
      return { entry, stateRevision: 8 };
    },
    acknowledgeSecretDelete: () => ({ stateRevision: 9 }),
  };
  await importProviderDraft({
    candidate: {
      candidateId: current.id,
      name: 'Relay imported again',
      protocol: 'openai-compatible',
      baseUrl: 'https://provider.example/v1',
      modelAuthKind: 'bearer',
      modelAuthSecret: 'sk-import-replacement',
      dialectHint: null,
    },
    store,
    secretService,
    randomUUID: () => { throw new Error('must retain the existing credential namespace'); },
  });
  assert.equal(committed.entry.credentialId, current.credentialId);
  assert.deepEqual(committed.options.pendingSecretDeletes, [current.auth.model.valueRef]);
});

test('external HTTP requires the toggle and a fresh explicit confirmation on each risky change', async () => {
  const store = {
    readState: () => ({ revision: 0 }),
    upsert: (entry) => ({ entry, stateRevision: 1 }),
  };
  const secretService = createdSecretService();
  await assert.rejects(
    saveProviderDraft({
      draft: providerDraft({ baseUrl: 'http://relay.example/v1', allowInsecureHttp: false, modelAuthKind: 'none' }),
      current: null,
      store,
      secretService,
      confirmInsecureHttp: async () => true,
      randomUUID: () => CREDENTIAL_ID,
    }),
    (error) => error.code === 'provider_insecure_http_forbidden',
  );
  const prompts = [];
  await assert.rejects(
    saveProviderDraft({
      draft: providerDraft({ id: 'relay', baseUrl: 'http://relay.example/v1', allowInsecureHttp: true, modelAuthKind: 'none' }),
      current: null,
      store,
      secretService,
      confirmInsecureHttp: async (input) => { prompts.push(input); return false; },
      randomUUID: () => CREDENTIAL_ID,
    }),
    (error) => error.code === 'provider_insecure_http_confirmation_required',
  );
  assert.deepEqual(prompts, [{ baseUrl: 'http://relay.example/v1', providerId: 'relay' }]);

  const current = providerEntry({
    id: 'relay',
    baseUrl: 'http://relay.example/v1',
    allowInsecureHttp: true,
    auth: { model: { kind: 'none' }, probe: { kind: 'inherit-model' } },
  });
  let confirmed = 0;
  await saveProviderDraft({
    draft: providerDraft({ id: 'relay', baseUrl: 'http://relay.example/v2', allowInsecureHttp: true, modelAuthKind: 'none' }),
    current,
    store,
    secretService,
    confirmInsecureHttp: async () => { confirmed += 1; return true; },
    randomUUID: () => CREDENTIAL_ID,
  });
  assert.equal(confirmed, 1);
});

test('loopback HTTP never prompts', async () => {
  let prompts = 0;
  const store = { readState: () => ({ revision: 0 }), upsert: (entry) => ({ entry, stateRevision: 1 }) };
  const saved = await saveProviderDraft({
    draft: providerDraft({ baseUrl: 'http://127.0.0.1:8787/v1', modelAuthKind: 'none' }),
    current: null,
    store,
    secretService: createdSecretService(),
    confirmInsecureHttp: async () => { prompts += 1; return false; },
    randomUUID: () => CREDENTIAL_ID,
  });
  assert.equal(prompts, 0);
  assert.equal(saved.allowInsecureHttp, false);
});

test('save rejects credential-bearing base URL query parameters before secret creation', async () => {
  const secretService = createdSecretService();
  await assert.rejects(
    saveProviderDraft({
      draft: providerDraft({ baseUrl: 'https://relay.example/v1?api_key=embedded', modelAuthSecret: 'sk-model' }),
      current: null,
      store: { readState: () => ({ revision: 0 }), upsert: () => { throw new Error('must not commit'); } },
      secretService,
      confirmInsecureHttp: async () => true,
      randomUUID: () => CREDENTIAL_ID,
    }),
    (error) => error.code === 'provider_draft_invalid',
  );
  assert.equal(secretService.created.length, 0);
});

test('App and Settings wiring expose no long-lived raw-provider-key state or callback', () => {
  const appSource = readFileSync(new URL('../src/app/App.jsx', import.meta.url), 'utf8');
  const settingsSource = readFileSync(new URL('../src/screens/SettingsScreen.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(appSource, /useState\([^\n]*(?:codexApiKey|apiKey)/);
  assert.doesNotMatch(appSource, /runtimeRef\.current\s*=\s*\{[^}]*apiKey/s);
  assert.doesNotMatch(appSource, /onSaveCodexKey=\{\s*\([^)]*\)\s*=>/);
  assert.match(settingsSource, /onSaveCodexKey\s*\?\s*<ZcodeKeyFallback/);
  const appStateSnapshot = { providers: [providerEntry()], codexCliCredentialReady: true };
  const callbackEvents = [{ type: 'provider-saved', providerId: 'provider-1' }];
  assert.equal(JSON.stringify({ appStateSnapshot, callbackEvents }).includes('resolved-only-for-request'), false);
});
