import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCcSwitch, ccSwitchProviderEntries } from '../src/cep/ccSwitch.js';

const ENV = {
  USERPROFILE: 'C:\\Users\\me',
  APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
};

function fakeFs(files) {
  return {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error('ENOENT: ' + p);
      return files[p];
    },
  };
}

test('ccSwitchProviderEntries maps tolerant fields into normalized entries', () => {
  const entries = ccSwitchProviderEntries([
    { name: 'My Provider', baseUrl: 'https://example.com', apiKey: 'sk-abc' },
    { title: 'Anthropic Direct', url: 'https://api.anthropic.com', token: 'sk-ant', type: 'anthropic' },
    { name: '', baseUrl: 'https://missing-name.example.com' },
    { name: 'No Base URL' },
    null,
  ]);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, 'ccswitch-my-provider');
  assert.equal(entries[0].name, 'My Provider');
  assert.equal(entries[0].protocol, 'openai-compatible');
  assert.equal(entries[0].baseUrl, 'https://example.com');
  assert.equal(entries[0].apiKey, 'sk-abc');
  assert.equal(entries[0].dialect, undefined);
  assert.equal(entries[1].id, 'ccswitch-anthropic-direct');
  assert.equal(entries[1].protocol, 'anthropic');
  assert.equal(entries[1].apiKey, 'sk-ant');
  assert.equal(entries[1].dialect, undefined);
});

test('ccSwitchProviderEntries inherits apiFormat dialect metadata', () => {
  const entries = ccSwitchProviderEntries([
    {
      name: 'Responses Provider',
      baseUrl: 'https://responses.example.com',
      meta: { apiFormat: 'openai_responses' },
      settingsConfig: { auth: { OPENAI_API_KEY: '' } },
    },
    {
      name: 'Chat Provider',
      baseUrl: 'https://chat.example.com',
      apiFormat: 'openai_chat',
      settingsConfig: { auth: { OPENAI_API_KEY: '' } },
    },
  ], { now: () => 456 });
  assert.deepEqual(entries[0].dialect, { wireApi: 'responses', authScheme: 'bearer', source: 'ccswitch-import', updatedAt: 456 });
  assert.deepEqual(entries[1].dialect, { wireApi: 'chat', authScheme: 'bearer', source: 'ccswitch-import', updatedAt: 456 });
});

test('ccSwitchProviderEntries extracts wire_api from config TOML', () => {
  const entries = ccSwitchProviderEntries([{
    name: 'Toml Provider',
    baseUrl: 'https://toml.example.com',
    settingsConfig: {
      config: `
model_provider = "custom"

[model_providers.custom]
wire_api = "chat"
`,
      auth: { OPENAI_API_KEY: '' },
    },
  }], { now: () => 789 });
  assert.deepEqual(entries[0].dialect, { wireApi: 'chat', authScheme: 'bearer', source: 'ccswitch-import', updatedAt: 789 });
});

test('ccSwitchProviderEntries infers auth scheme from apiKeyField, env, and auth', () => {
  const entries = ccSwitchProviderEntries([
    {
      name: 'Anthropic Key Field',
      baseUrl: 'https://anthropic-key.example.com',
      meta: { apiFormat: 'openai_responses', apiKeyField: 'ANTHROPIC_API_KEY' },
      settingsConfig: {},
    },
    {
      name: 'Anthropic Token Env',
      baseUrl: 'https://anthropic-token.example.com',
      meta: { apiFormat: 'openai_responses' },
      settingsConfig: { env: { ANTHROPIC_AUTH_TOKEN: '' } },
    },
    {
      name: 'Anthropic Key Env',
      baseUrl: 'https://anthropic-env.example.com',
      meta: { apiFormat: 'openai_responses' },
      settingsConfig: { env: { ANTHROPIC_API_KEY: '' } },
    },
    {
      name: 'OpenAI Env',
      baseUrl: 'https://openai-env.example.com',
      meta: { apiFormat: 'openai_responses' },
      settingsConfig: { env: { OPENAI_API_KEY: '' } },
    },
    {
      name: 'OpenAI Auth',
      baseUrl: 'https://openai-auth.example.com',
      meta: { apiFormat: 'openai_responses' },
      settingsConfig: { auth: { OPENAI_API_KEY: '' } },
    },
  ], { now: () => 1000 });
  assert.equal(entries[0].dialect.authScheme, 'x-api-key');
  assert.equal(entries[1].dialect.authScheme, 'bearer');
  assert.equal(entries[2].dialect.authScheme, 'x-api-key');
  assert.equal(entries[3].dialect.authScheme, 'bearer');
  assert.equal(entries[4].dialect.authScheme, 'bearer');
});

test('ccSwitchProviderEntries omits dialect when either wire or auth signal is missing', () => {
  const entries = ccSwitchProviderEntries([
    {
      name: 'Wire Only',
      baseUrl: 'https://wire-only.example.com',
      meta: { apiFormat: 'openai_chat' },
    },
    {
      name: 'Auth Only',
      baseUrl: 'https://auth-only.example.com',
      settingsConfig: { auth: { OPENAI_API_KEY: '' } },
    },
  ]);
  assert.equal(entries[0].dialect, undefined);
  assert.equal(entries[1].dialect, undefined);
});

test('detectCcSwitch finds config.json in the primary ~/.cc-switch directory', () => {
  const dir = 'C:\\Users\\me\\.cc-switch';
  const file = dir + '\\config.json';
  const fs = fakeFs({
    [file]: JSON.stringify({ providers: [{ name: 'Found', baseUrl: 'https://found.example.com', apiKey: 'k' }] }),
  });
  const found = detectCcSwitch({ env: ENV, fsImpl: fs });
  assert.ok(found);
  assert.equal(found.dir, dir);
  assert.equal(found.file, file);
  assert.equal(found.providers.length, 1);
  assert.equal(found.providers[0].name, 'Found');
});

test('detectCcSwitch falls back through candidate dirs and config names', () => {
  const dir = 'C:\\Users\\me\\.config\\cc-switch';
  const file = dir + '\\providers.json';
  const fs = fakeFs({
    [file]: JSON.stringify({ profiles: [{ name: 'Fallback', baseUrl: 'https://fallback.example.com', apiKey: 'k2' }] }),
  });
  const found = detectCcSwitch({ env: ENV, fsImpl: fs });
  assert.ok(found);
  assert.equal(found.dir, dir);
  assert.equal(found.file, file);
  assert.equal(found.providers[0].name, 'Fallback');
});

test('detectCcSwitch returns null when nothing is present', () => {
  const fs = fakeFs({});
  assert.equal(detectCcSwitch({ env: ENV, fsImpl: fs }), null);
});

test('detectCcSwitch tolerates unreadable/corrupt candidate files by continuing to scan', () => {
  const badFile = 'C:\\Users\\me\\.cc-switch\\config.json';
  const goodDir = 'C:\\Users\\me\\.config\\cc-switch';
  const goodFile = goodDir + '\\config.json';
  const fs = fakeFs({
    [badFile]: '{not valid json',
    [goodFile]: JSON.stringify({ providers: [{ name: 'Good', baseUrl: 'https://good.example.com', apiKey: 'k3' }] }),
  });
  const found = detectCcSwitch({ env: ENV, fsImpl: fs });
  assert.ok(found);
  assert.equal(found.dir, goodDir);
});

test('detectCcSwitch returns null when require is unavailable and no fsImpl given', () => {
  assert.equal(detectCcSwitch({ env: ENV }), null);
});
