import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCcSwitch, ccSwitchProviderEntries, readCcSwitchProviderDrafts } from '../src/cep/ccSwitch.js';

function platform(fsImpl) {
  return {
    paths: { home: 'C:\\Users\\me', join: (parts) => parts.join('\\') },
    fs: fsImpl,
    completeSpawnEnv: () => ({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }),
  };
}

function fakeFs(initial) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    existsSync: (p) => files.has(p),
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error('ENOENT: ' + p);
      return files.get(p);
    },
  };
}

test('ccSwitchProviderEntries is a pure non-secret preview mapper', () => {
  const preview = ccSwitchProviderEntries([
    {
      name: 'My Provider',
      baseUrl: 'https://example.com',
      apiKey: 'sk-ccswitch-marker',
      meta: { apiFormat: 'openai_chat', apiKeyField: 'OPENAI_API_KEY' },
    },
    { title: 'Anthropic Direct', url: 'https://api.anthropic.com', token: 'sk-ant', type: 'anthropic' },
  ]);
  assert.deepEqual(preview, [
    { candidateId: 'ccswitch-my-provider', name: 'My Provider', protocol: 'openai-compatible', baseUrl: 'https://example.com', dialectHint: 'chat', authHint: 'bearer' },
    { candidateId: 'ccswitch-anthropic-direct', name: 'Anthropic Direct', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', dialectHint: null, authHint: null },
  ]);
  assert.equal(JSON.stringify(preview).includes('sk-ccswitch-marker'), false);
  assert.equal(Object.hasOwn(preview[0], 'secretInput'), false);
});

test('detectCcSwitch returns a SHA-256 preview and re-read returns ephemeral drafts', () => {
  const dir = 'C:\\Users\\me\\.cc-switch';
  const file = dir + '\\config.json';
  const fs = fakeFs({
    [file]: JSON.stringify({
      providers: [{
        name: 'Found',
        baseUrl: 'https://found.example.com',
        apiKey: 'sk-ccswitch-marker',
        meta: { apiFormat: 'openai_responses', apiKeyField: 'ANTHROPIC_API_KEY' },
      }],
    }),
  });
  const preview = detectCcSwitch({ platform: platform(fs), fsImpl: fs });
  assert.equal(preview.dir, dir);
  assert.equal(preview.file, file);
  assert.match(preview.sourceRevision, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(preview).includes('sk-ccswitch-marker'), false);
  const draft = readCcSwitchProviderDrafts({ file, expectedSourceRevision: preview.sourceRevision, fsImpl: fs })[0];
  assert.deepEqual(draft, {
    candidateId: 'ccswitch-found',
    name: 'Found',
    protocol: 'openai-compatible',
    baseUrl: 'https://found.example.com',
    modelAuthKind: 'x-api-key',
    modelAuthSecret: 'sk-ccswitch-marker',
    dialectHint: 'responses',
    authHint: 'x-api-key',
  });
});

test('cc-switch metadata maps apiFormat, apiKeyField, config TOML, and settings auth', () => {
  const entries = ccSwitchProviderEntries([
    {
      name: 'Meta Chat',
      baseUrl: 'https://chat.example/v1',
      meta: { apiFormat: 'openai_chat', apiKeyField: 'x-api-key' },
    },
    {
      name: 'Config Responses',
      baseUrl: 'https://responses.example/v1',
      settingsConfig: {
        config: '[model_providers.relay]\nwire_api = "responses"\n',
        auth: { OPENAI_API_KEY: 'sk-must-not-enter-preview' },
      },
    },
  ]);
  assert.deepEqual(entries, [
    {
      candidateId: 'ccswitch-meta-chat',
      name: 'Meta Chat',
      protocol: 'openai-compatible',
      baseUrl: 'https://chat.example/v1',
      dialectHint: 'chat',
      authHint: 'x-api-key',
    },
    {
      candidateId: 'ccswitch-config-responses',
      name: 'Config Responses',
      protocol: 'openai-compatible',
      baseUrl: 'https://responses.example/v1',
      dialectHint: 'responses',
      authHint: 'bearer',
    },
  ]);
  assert.equal(JSON.stringify(entries).includes('sk-must-not-enter-preview'), false);
});

test('confirmed cc-switch import applies explicit x-api-key metadata to the ephemeral draft', () => {
  const file = 'C:\\Users\\me\\.cc-switch\\config.json';
  const text = JSON.stringify({
    providers: [{
      name: 'Header Provider',
      baseUrl: 'https://header.example/v1',
      apiKey: 'sk-ephemeral-import-secret',
      meta: { apiFormat: 'openai_chat', apiKeyField: 'x-api-key' },
    }],
  });
  const fs = fakeFs({ [file]: text });
  const preview = detectCcSwitch({ platform: platform(fs), fsImpl: fs });
  const [draft] = readCcSwitchProviderDrafts({
    file,
    expectedSourceRevision: preview.sourceRevision,
    fsImpl: fs,
  });
  assert.deepEqual(draft, {
    candidateId: 'ccswitch-header-provider',
    name: 'Header Provider',
    protocol: 'openai-compatible',
    baseUrl: 'https://header.example/v1',
    modelAuthKind: 'x-api-key',
    modelAuthSecret: 'sk-ephemeral-import-secret',
    dialectHint: 'chat',
    authHint: 'x-api-key',
  });
});

test('readCcSwitchProviderDrafts rejects a changed source before returning secrets', () => {
  const file = 'C:\\Users\\me\\.cc-switch\\config.json';
  const fs = fakeFs({
    [file]: JSON.stringify({ providers: [{ name: 'Found', baseUrl: 'https://found.example.com', apiKey: 'sk-old' }] }),
  });
  const preview = detectCcSwitch({ platform: platform(fs), fsImpl: fs });
  fs.files.set(file, JSON.stringify({ providers: [{ name: 'Found', baseUrl: 'https://changed.example.com', apiKey: 'sk-changed' }] }));
  assert.throws(
    () => readCcSwitchProviderDrafts({ file, expectedSourceRevision: preview.sourceRevision, fsImpl: fs }),
    (error) => error.code === 'provider_import_source_changed',
  );
});

test('detectCcSwitch scans fallback names and ignores corrupt candidates', () => {
  const bad = 'C:\\Users\\me\\.cc-switch\\config.json';
  const goodDir = 'C:\\Users\\me\\.config\\cc-switch';
  const good = goodDir + '\\providers.json';
  const fs = fakeFs({
    [bad]: '{bad json',
    [good]: JSON.stringify({ profiles: [{ name: 'Fallback', baseUrl: 'https://fallback.example', key: 'k' }] }),
  });
  const found = detectCcSwitch({ platform: platform(fs), fsImpl: fs });
  assert.equal(found.dir, goodDir);
  assert.equal(found.providers[0].name, 'Fallback');
});

test('detectCcSwitch returns null when nothing usable is present', () => {
  const fs = fakeFs({});
  assert.equal(detectCcSwitch({ platform: platform(fs), fsImpl: fs }), null);
});

test('cc-switch preview rejects base URLs that embed credentials', () => {
  const file = 'C:\\Users\\me\\.cc-switch\\config.json';
  const fs = fakeFs({
    [file]: JSON.stringify({ providers: [{ name: 'Unsafe', baseUrl: 'https://user:secret@relay.example/v1', apiKey: 'sk-marker' }] }),
  });
  assert.equal(detectCcSwitch({ platform: platform(fs), fsImpl: fs }), null);
  assert.deepEqual(ccSwitchProviderEntries([{ name: 'Unsafe', baseUrl: 'https://relay.example/v1?api_key=secret', apiKey: 'sk-marker' }]), []);
});
