import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLegacyApiKeyStore } from '../src/cep/apiKey.js';

function makeDeps() {
  const files = new Map();
  const fs = {
    readFileSync(file) {
      if (!files.has(file)) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(file);
    },
    unlinkSync(file) {
      if (!files.has(file)) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      files.delete(file);
    },
  };
  return {
    fs,
    os: { homedir: () => '/home/user' },
    path: { join: (...parts) => parts.join('/') },
    files,
  };
}

test('legacy key store only reads migration sources and trims their values', () => {
  const deps = makeDeps();
  deps.files.set('/home/user/.ae-mcp/zcode-key', '  legacy-value  ');
  const store = createLegacyApiKeyStore(deps);
  assert.equal(store.readKey('zcode'), 'legacy-value');
  assert.equal(Object.hasOwn(store, 'writeKey'), false);
});

test('legacy key cleanup removes an existing key and ignores a missing file', () => {
  const deps = makeDeps();
  deps.files.set('/home/user/.ae-mcp/anthropic-key', 'legacy-value');
  const store = createLegacyApiKeyStore(deps);
  store.clearKey('anthropic');
  assert.equal(store.readKey('anthropic'), '');
  assert.doesNotThrow(() => store.clearKey('anthropic'));
});

test('legacy key store rejects unknown file slots', () => {
  const store = createLegacyApiKeyStore(makeDeps());
  assert.throws(() => store.readKey('unknown'), /Unsupported API key name/);
});

test('production ZCode paths cannot write or directly reopen plaintext key files', () => {
  const legacySource = readFileSync(new URL('../src/cep/apiKey.js', import.meta.url), 'utf8');
  const appSource = readFileSync(new URL('../src/app/App.jsx', import.meta.url), 'utf8');
  const backendSource = readFileSync(new URL('../src/cep/zcodeBackend.js', import.meta.url), 'utf8');
  const settingsSource = readFileSync(new URL('../src/screens/SettingsScreen.jsx', import.meta.url), 'utf8');
  const channelsSource = readFileSync(new URL('../src/lib/channels.js', import.meta.url), 'utf8');
  const errorsSource = readFileSync(new URL('../src/lib/zcodeErrors.js', import.meta.url), 'utf8');
  assert.doesNotMatch(legacySource, /writeFileSync|renameSync|writeKey/);
  assert.doesNotMatch(appSource, /writeKey\s*\(|readKey\s*\(\s*['"]zcode/);
  assert.doesNotMatch(backendSource, /apiKey\.js|createLegacyApiKeyStore|createApiKeyStore/);
  assert.doesNotMatch(settingsSource, /\.ae-mcp[\\/]zcode-key/);
  assert.doesNotMatch(channelsSource, /\.ae-mcp[\\/]zcode-key/);
  assert.doesNotMatch(errorsSource, /\.ae-mcp[\\/]zcode-key/);
});
