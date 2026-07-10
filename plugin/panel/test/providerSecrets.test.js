import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProviderSecretService,
  resolveProviderRequestProfile,
} from '../src/cep/providerSecrets.js';

const CREDENTIAL_ID = '5eb75f05-5d9e-5d9c-85af-f0893e8b90c2';

function secretRef(slot, revision = 1) {
  return {
    kind: 'secret',
    reference: `aemcp-secret://provider/${CREDENTIAL_ID}/${slot}/v1`,
    revision,
  };
}

function providerFixture(overrides = {}) {
  return Object.assign({
    id: 'provider-1',
    credentialId: CREDENTIAL_ID,
    name: 'Provider 1',
    protocol: 'openai-compatible',
    baseUrl: 'https://provider.example/v1',
    allowInsecureHttp: false,
    authProfileRevision: 1,
    auth: { model: { kind: 'none' }, probe: { kind: 'inherit-model' } },
    headers: [],
    dialect: { override: null, detected: null },
    probedModels: [],
    probedAt: 0,
  }, overrides);
}

function publicErrorText(error) {
  return JSON.stringify({ name: error?.name, code: error?.code, message: error?.message });
}

test('provider secret service creates, reads back, and returns only a reference plus revision', async () => {
  const calls = [];
  const values = new Map();
  const host = {
    async secretSet(input) {
      calls.push(['set', input.reference, input.expectedRevision]);
      values.set(input.reference, { value: input.value, revision: 1 });
      return { reference: input.reference, revision: 1 };
    },
    async secretGet(reference) {
      calls.push(['get', reference]);
      const item = values.get(reference);
      if (!item) {
        const error = new Error(`missing ${reference} sk-provider-secret`);
        error.code = 'SECRET_NOT_FOUND';
        throw error;
      }
      return { reference, value: item.value, revision: item.revision };
    },
    async secretDelete(input) {
      calls.push(['delete', input.reference, input.expectedRevision]);
      const deleted = values.delete(input.reference);
      return { reference: input.reference, deleted, revision: null };
    },
  };
  const service = createProviderSecretService({
    getHost: () => host,
    randomBytes: () => Buffer.from('a13f28', 'utf8'),
  });

  assert.deepEqual(Object.keys(service).sort(), ['create', 'delete', 'resolve']);
  assert.equal('list' in service, false);

  const ref = await service.create({
    credentialId: CREDENTIAL_ID,
    slotPrefix: 'auth-model',
    value: 'sk-provider-secret',
  });
  assert.deepEqual(Object.keys(ref).sort(), ['kind', 'reference', 'revision']);
  assert.equal(ref.kind, 'secret');
  assert.equal(ref.revision, 1);
  assert.match(
    ref.reference,
    /^aemcp-secret:\/\/provider\/5eb75f05-5d9e-5d9c-85af-f0893e8b90c2\/auth-model-[a-z0-9_-]+\/v1$/,
  );
  assert.equal(JSON.stringify(ref).includes('sk-provider-secret'), false);
  assert.equal(await service.resolve(ref), 'sk-provider-secret');
  assert.deepEqual(calls.map((call) => call[0]), ['set', 'get', 'get']);

  assert.deepEqual(await service.delete(ref), { deleted: true, revision: null });
  assert.deepEqual(calls.at(-1), ['delete', ref.reference, 1]);
  await assert.rejects(service.resolve(ref), (error) => {
    assert.equal(error.code, 'SECRET_NOT_FOUND');
    const text = publicErrorText(error);
    assert.equal(text.includes(ref.reference), false);
    assert.equal(text.includes('sk-provider-secret'), false);
    return true;
  });
});

test('provider secret service validates references and revisions before returning protected values', async () => {
  const marker = 'sk-revision-marker';
  const reference = secretRef('auth-model', 1).reference;
  let reads = 0;
  const service = createProviderSecretService({
    getHost: () => ({
      async secretGet(requested) {
        reads += 1;
        return { reference: requested, value: marker, revision: 2 };
      },
      async secretSet() { throw new Error('not used'); },
      async secretDelete() { throw new Error('not used'); },
    }),
  });

  await assert.rejects(
    service.resolve(secretRef('auth-model', 1)),
    (error) => {
      assert.equal(error.code, 'SECRET_CONFLICT');
      assert.equal(publicErrorText(error).includes(marker), false);
      assert.equal(publicErrorText(error).includes(reference), false);
      return true;
    },
  );
  assert.equal(reads, 1);

  await assert.rejects(
    service.resolve({ kind: 'secret', reference: `${reference}?other=1`, revision: 1 }),
    (error) => error instanceof Error && error.code === 'INVALID_REFERENCE',
  );
  assert.equal(reads, 1);
});

test('provider secret service fails closed on mismatched create readback without leaking either value', async () => {
  const requested = 'sk-create-marker';
  const returned = 'sk-wrong-readback-marker';
  let createdReference = '';
  const service = createProviderSecretService({
    getHost: () => ({
      async secretSet(input) {
        createdReference = input.reference;
        return { reference: input.reference, revision: 1 };
      },
      async secretGet(reference) {
        return { reference, value: returned, revision: 1 };
      },
      async secretDelete() { throw new Error('not used'); },
    }),
    randomBytes: () => Uint8Array.from([1, 2, 3, 4]),
  });

  await assert.rejects(
    service.create({ credentialId: CREDENTIAL_ID, slotPrefix: 'header', value: requested }),
    (error) => {
      assert.equal(error.code, 'SECRET_CONFLICT');
      const text = publicErrorText(error);
      assert.equal(text.includes(requested), false);
      assert.equal(text.includes(returned), false);
      assert.equal(text.includes(createdReference), false);
      return true;
    },
  );
});

test('provider secret service rejects non-contract read results without exposing their value', async () => {
  const marker = 'sk-non-contract-read-marker';
  const service = createProviderSecretService({
    getHost: () => ({
      async secretGet(reference) {
        return { found: true, reference, value: marker, revision: 1 };
      },
      async secretSet() { throw new Error('not used'); },
      async secretDelete() { throw new Error('not used'); },
    }),
  });

  await assert.rejects(
    service.resolve(secretRef('auth-model', 1)),
    (error) => {
      assert.equal(error.code, 'SECRET_CONFLICT');
      assert.equal(publicErrorText(error).includes(marker), false);
      return true;
    },
  );
});

test('resolveProviderRequestProfile separates probe and model auth', async () => {
  const provider = providerFixture({
    auth: {
      model: { kind: 'bearer', valueRef: secretRef('auth-model', 4) },
      probe: { kind: 'custom', headerName: 'x-probe-token', valueRef: secretRef('auth-probe', 2) },
    },
  });
  const secretService = {
    resolve: async (ref) => (ref.reference.includes('auth-probe') ? 'probe-secret' : 'model-secret'),
  };

  const probe = await resolveProviderRequestProfile(provider, { scope: 'probe', secretService });
  const model = await resolveProviderRequestProfile(provider, { scope: 'model', secretService });
  assert.deepEqual(probe.auth, { kind: 'header', name: 'x-probe-token', value: 'probe-secret' });
  assert.deepEqual(model.auth, { kind: 'header', name: 'Authorization', value: 'Bearer model-secret' });
  assert.deepEqual(Object.keys(probe).sort(), [
    'allowInsecureHttp',
    'auth',
    'authProfileRevision',
    'baseUrl',
    'extraHeaders',
    'providerId',
  ]);
});

test('resolveProviderRequestProfile filters extra headers by scope and preserves source', async () => {
  const provider = providerFixture({
    headers: [
      { id: 'probe-feature', name: 'x-probe-feature', scopes: ['probe'], valueRef: { kind: 'literal', value: 'probe-on' } },
      { id: 'model-token', name: 'x-model-token', scopes: ['model'], valueRef: secretRef('header-model', 3) },
      { id: 'shared', name: 'x-shared-feature', scopes: ['probe', 'model'], valueRef: { kind: 'literal', value: 'shared-on' } },
    ],
  });
  const secretService = { resolve: async () => 'resolved-header-secret' };

  const probe = await resolveProviderRequestProfile(provider, { scope: 'probe', secretService });
  const model = await resolveProviderRequestProfile(provider, { scope: 'model', secretService });
  assert.deepEqual(probe.extraHeaders, [
    { name: 'x-probe-feature', value: 'probe-on', source: 'literal' },
    { name: 'x-shared-feature', value: 'shared-on', source: 'literal' },
  ]);
  assert.deepEqual(model.extraHeaders, [
    { name: 'x-model-token', value: 'resolved-header-secret', source: 'secret' },
    { name: 'x-shared-feature', value: 'shared-on', source: 'literal' },
  ]);
});
