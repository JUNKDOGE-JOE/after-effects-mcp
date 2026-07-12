import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultProviderModelAuthKind,
  draftFromEntry,
  draftToEntry,
  draftWithProtocol,
  emptyDraft,
  validateDraft,
} from '../src/lib/providerManagerState.js';

const CREDENTIAL_ID = '5eb75f05-5d9e-5d9c-85af-f0893e8b90c2';

test('emptyDraft uses one automatic API-key credential and no Provider-level protocol', () => {
  assert.deepEqual(emptyDraft(), {
    id: '',
    name: '',
    baseUrl: '',
    allowInsecureHttp: false,
    modelAuthKind: 'auto',
    modelAuthAutomatic: false,
    modelAuthHeaderName: '',
    modelAuthSecret: '',
    headers: [],
    probePreference: '',
  });
  assert.equal(Object.hasOwn(emptyDraft(), 'protocol'), false);
  assert.equal(Object.hasOwn(emptyDraft(), 'dialectOverride'), false);
  assert.equal(Object.hasOwn(emptyDraft(), 'probeAuthSecret'), false);
});

test('legacy import helpers retain protocol auth hints without affecting v3 drafts', () => {
  assert.equal(defaultProviderModelAuthKind('openai-compatible'), 'bearer');
  assert.equal(defaultProviderModelAuthKind('anthropic'), 'x-api-key');
  const changed = draftWithProtocol({ ...emptyDraft(), modelAuthKind: 'bearer', modelAuthAutomatic: true }, 'anthropic');
  assert.equal(changed.protocol, 'anthropic');
  assert.equal(changed.modelAuthKind, 'x-api-key');
});

test('draftFromEntry maps v3 auth and probe preference without copying opaque references', () => {
  const reference = `aemcp-secret://provider/${CREDENTIAL_ID}/auth-model-old/v1`;
  const entry = {
    id: 'p1',
    credentialId: CREDENTIAL_ID,
    name: 'Provider 1',
    baseUrl: 'https://x.example.com',
    allowInsecureHttp: false,
    credential: {
      preferredAuth: { scheme: 'custom', headerName: 'x-provider-key' },
      valueRef: { kind: 'secret', reference, revision: 2 },
    },
    probeAuthOverride: null,
    headers: [{
      id: 'feature',
      name: 'x-feature',
      scopes: ['model'],
      valueRef: { kind: 'secret', reference, revision: 2 },
    }],
    probePreference: 'messages',
  };
  const draft = draftFromEntry(entry);
  assert.equal(draft.modelAuthKind, 'custom');
  assert.equal(draft.modelAuthHeaderName, 'x-provider-key');
  assert.equal(draft.modelAuthSecret, '');
  assert.equal(draft.probePreference, 'messages');
  assert.deepEqual(draft.headers[0], {
    id: 'feature',
    name: 'x-feature',
    scopes: ['model'],
    valueKind: 'secret',
    value: '',
  });
  assert.equal(JSON.stringify(draft).includes(reference), false);
  assert.equal(Object.hasOwn(draft, 'credentialId'), false);
});

test('draftFromEntry keeps v2 entries editable only as a migration fallback', () => {
  const entry = {
    id: 'legacy',
    name: 'Legacy',
    protocol: 'anthropic',
    baseUrl: 'https://legacy.example',
    auth: { model: { kind: 'x-api-key' } },
    headers: [],
    dialect: { override: { wireApi: 'chat', source: 'manual', updatedAt: 1 }, detected: [] },
  };
  const draft = draftFromEntry(entry);
  assert.equal(draft.modelAuthKind, 'x-api-key');
  assert.equal(draft.probePreference, 'chat');
  assert.equal(Object.hasOwn(draft, 'protocol'), false);
});

test('validateDraft requires a name and http(s) URL', () => {
  assert.ok(validateDraft({ ...emptyDraft(), baseUrl: 'https://x.example.com' }));
  assert.ok(validateDraft({ ...emptyDraft(), name: 'Foo', baseUrl: 'ftp://x.example.com' }));
  assert.equal(validateDraft({ ...emptyDraft(), name: 'Foo', baseUrl: 'https://x.example.com' }), '');
});

test('draftToEntry derives an id and preserves only ephemeral v3 form fields', () => {
  const entry = draftToEntry({
    ...emptyDraft(),
    name: 'My Cool Provider!',
    baseUrl: 'https://x.example.com',
    modelAuthSecret: 'sk-ephemeral',
  });
  assert.equal(entry.id, 'my-cool-provider');
  assert.equal(entry.name, 'My Cool Provider!');
  assert.equal(entry.modelAuthSecret, 'sk-ephemeral');
  assert.equal(entry.modelAuthKind, 'auto');
  assert.equal(Object.hasOwn(entry, 'protocol'), false);
  assert.equal(Object.hasOwn(entry, 'apiKey'), false);
});
