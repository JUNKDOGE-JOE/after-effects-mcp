import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDraft, draftFromEntry, validateDraft, draftToEntry } from '../src/lib/providerManagerState.js';

const CREDENTIAL_ID = '5eb75f05-5d9e-5d9c-85af-f0893e8b90c2';

test('emptyDraft returns the exact non-secret v2 form shape', () => {
  assert.deepEqual(emptyDraft(), {
    id: '',
    name: '',
    protocol: 'openai-compatible',
    baseUrl: '',
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
  });
});

test('draftFromEntry never copies a secret value or opaque reference into React state', () => {
  const reference = `aemcp-secret://provider/${CREDENTIAL_ID}/auth-model-old/v1`;
  const entry = {
    id: 'p1',
    credentialId: CREDENTIAL_ID,
    name: 'Provider 1',
    protocol: 'anthropic',
    baseUrl: 'https://x.example.com',
    allowInsecureHttp: false,
    authProfileRevision: 4,
    auth: {
      model: { kind: 'x-api-key', valueRef: { kind: 'secret', reference, revision: 2 } },
      probe: { kind: 'inherit-model' },
    },
    headers: [],
    dialect: { override: { wireApi: 'chat', source: 'manual', updatedAt: 1 }, detected: null },
    probedModels: [{ id: 'm', label: 'M' }],
    probedAt: 123,
  };
  const draft = draftFromEntry(entry);
  assert.equal(draft.modelAuthKind, 'x-api-key');
  assert.equal(draft.modelAuthSecret, '');
  assert.equal(draft.probeAuthSecret, '');
  assert.equal(draft.dialectOverride, 'chat');
  assert.equal(JSON.stringify(draft).includes(reference), false);
  assert.equal(Object.hasOwn(draft, 'credentialId'), false);
});

test('validateDraft requires a name and http(s) URL', () => {
  assert.ok(validateDraft({ ...emptyDraft(), baseUrl: 'https://x.example.com' }));
  assert.ok(validateDraft({ ...emptyDraft(), name: 'Foo', baseUrl: 'ftp://x.example.com' }));
  assert.equal(validateDraft({ ...emptyDraft(), name: 'Foo', baseUrl: 'https://x.example.com' }), '');
});

test('draftToEntry derives an id but preserves only draft fields for save orchestration', () => {
  const entry = draftToEntry({ ...emptyDraft(), name: 'My Cool Provider!', baseUrl: 'https://x.example.com', modelAuthSecret: 'sk-ephemeral' });
  assert.equal(entry.id, 'my-cool-provider');
  assert.equal(entry.name, 'My Cool Provider!');
  assert.equal(entry.modelAuthSecret, 'sk-ephemeral');
  assert.equal(Object.hasOwn(entry, 'apiKey'), false);
});
