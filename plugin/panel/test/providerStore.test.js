import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProviderStore, normalizeProviderEntry } from '../src/cep/providerStore.js';

function makeDeps() {
  const files = new Map();
  const dirs = new Set();
  const chmods = [];
  const fs = {
    existsSync: (p) => dirs.has(p) || files.has(p),
    mkdirSync: (p) => { dirs.add(p); },
    readFileSync: (p) => {
      if (!files.has(p)) { const e = new Error('missing'); e.code = 'ENOENT'; throw e; }
      return files.get(p);
    },
    writeFileSync: (p, v) => { files.set(p, v); },
    chmodSync: (p, mode) => { chmods.push([p, mode]); },
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    unlinkSync: (p) => { files.delete(p); },
  };
  const path = { join: (...parts) => parts.join('/') };
  const os = { homedir: () => '/home/user' };
  return { fs, path, os, pid: 42, files, dirs, chmods };
}

test('list returns [] when providers.json is missing', () => {
  const store = createProviderStore(makeDeps());
  assert.deepEqual(store.list(), []);
});

test('upsert adds then updates a provider entry and persists JSON', () => {
  const deps = makeDeps();
  const store = createProviderStore(deps);
  store.upsert({ id: 'relay', name: '中转站', protocol: 'openai-compatible', baseUrl: 'https://token.mediastorm.studio/v1', apiKey: 'sk-1' });
  assert.equal(store.get('relay').apiKey, 'sk-1');
  store.upsert({ id: 'relay', name: '中转站', protocol: 'openai-compatible', baseUrl: 'https://token.mediastorm.studio/v1', apiKey: 'sk-2' });
  assert.equal(store.list().length, 1);
  assert.equal(store.get('relay').apiKey, 'sk-2');
  const raw = JSON.parse(deps.files.get('/home/user/.ae-mcp/providers.json'));
  assert.equal(raw.version, 1);
  assert.equal(raw.providers[0].id, 'relay');
  assert.equal(deps.chmods.length, 2);
  assert.equal(deps.chmods[0][1], 0o600);
  assert.equal(deps.chmods[1][1], 0o600);
});

test('remove deletes an entry and tolerates unknown ids', () => {
  const store = createProviderStore(makeDeps());
  store.upsert({ id: 'a', name: 'A', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'k' });
  store.remove('a');
  assert.deepEqual(store.list(), []);
  assert.doesNotThrow(() => store.remove('nope'));
});

test('normalizeProviderEntry fills defaults and rejects bad protocol', () => {
  const e = normalizeProviderEntry({ id: ' x ', name: '', baseUrl: 'https://h/v1/', apiKey: ' k ' });
  assert.equal(e.id, 'x');
  assert.equal(e.name, 'x');
  assert.equal(e.protocol, 'openai-compatible');
  assert.equal(e.baseUrl, 'https://h/v1');
  assert.equal(e.apiKey, 'k');
  assert.deepEqual(e.probedModels, []);
  assert.equal(e.probedAt, 0);
  assert.throws(() => normalizeProviderEntry({ id: 'y', protocol: 'grpc', baseUrl: 'https://h' }));
});

test('migrateLegacy imports anthropic-key/codex-key + base URL prefs once', () => {
  const deps = makeDeps();
  const store = createProviderStore(deps);
  const prefs = { ae_mcp_anthropic_base_url: 'https://relay.example/anthropic', ae_mcp_codex_base_url: 'https://relay.example/openai' };
  const keys = { anthropic: 'sk-ant-legacy', codex: 'sk-codex-legacy' };
  const first = store.migrateLegacy({ readKey: (n) => keys[n] || '', readPref: (k) => prefs[k] || '' });
  assert.equal(first.migrated.length, 2);
  const a = store.get('legacy-anthropic');
  assert.equal(a.protocol, 'anthropic');
  assert.equal(a.baseUrl, 'https://relay.example/anthropic');
  assert.equal(a.apiKey, 'sk-ant-legacy');
  const c = store.get('legacy-codex');
  assert.equal(c.protocol, 'openai-compatible');
  assert.equal(c.apiKey, 'sk-codex-legacy');
  // Second run is a no-op (migratedLegacy flag persisted).
  const second = store.migrateLegacy({ readKey: (n) => keys[n] || '', readPref: (k) => prefs[k] || '' });
  assert.equal(second.migrated.length, 0);
});

test('migrateLegacy with nothing to migrate still marks done', () => {
  const store = createProviderStore(makeDeps());
  assert.deepEqual(store.migrateLegacy({ readKey: () => '', readPref: () => '' }).migrated, []);
  assert.deepEqual(store.migrateLegacy({ readKey: () => 'late-key', readPref: () => '' }).migrated, []);
});
