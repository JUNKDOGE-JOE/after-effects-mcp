import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApiKeyStore } from '../src/cep/apiKey.js';

function makeDeps() {
  const files = new Map();
  const dirs = new Set();
  const chmods = [];
  const fs = {
    existsSync(p) {
      return dirs.has(p) || files.has(p);
    },
    mkdirSync(p) {
      dirs.add(p);
    },
    readFileSync(p) {
      if (!files.has(p)) {
        const e = new Error('missing');
        e.code = 'ENOENT';
        throw e;
      }
      return files.get(p);
    },
    writeFileSync(p, value) {
      files.set(p, value);
    },
    chmodSync(p, mode) {
      chmods.push([p, mode]);
    },
    renameSync(from, to) {
      files.set(to, files.get(from));
      files.delete(from);
    },
    unlinkSync(p) {
      if (!files.has(p)) {
        const e = new Error('missing');
        e.code = 'ENOENT';
        throw e;
      }
      files.delete(p);
    },
  };
  const path = {
    join(...parts) {
      return parts.join('/');
    },
  };
  const os = { homedir: () => '/home/user' };
  return { fs, path, os, pid: 42, files, dirs, chmods };
}

test('readKey returns empty string when the key file is missing', () => {
  const deps = makeDeps();
  const store = createApiKeyStore(deps);
  assert.equal(store.readKey(), '');
});

test('writeKey atomically writes, chmods, renames, and readKey trims the stored value', () => {
  const deps = makeDeps();
  const store = createApiKeyStore(deps);
  assert.equal(store.writeKey('  sk-ant-test  '), 'sk-ant-test');
  assert.equal(store.readKey(), 'sk-ant-test');
  assert.equal(deps.dirs.has('/home/user/.ae-mcp'), true);
  assert.equal(deps.files.has('/home/user/.ae-mcp/anthropic-key'), true);
  assert.equal(deps.chmods.length, 1);
  assert.equal(deps.chmods[0][1], 0o600);
});

test('writeKey can store Codex and Anthropic keys separately', () => {
  const deps = makeDeps();
  const store = createApiKeyStore(deps);
  store.writeKey('sk-ant-test');
  store.writeKey('sk-codex-test', 'codex');

  assert.equal(store.readKey(), 'sk-ant-test');
  assert.equal(store.readKey('codex'), 'sk-codex-test');
  assert.equal(deps.files.has('/home/user/.ae-mcp/anthropic-key'), true);
  assert.equal(deps.files.has('/home/user/.ae-mcp/codex-key'), true);
});

test('clearKey removes an existing key and ignores missing files', () => {
  const deps = makeDeps();
  const store = createApiKeyStore(deps);
  store.writeKey('sk-ant-test');
  store.clearKey();
  assert.equal(store.readKey(), '');
  assert.doesNotThrow(() => store.clearKey());
});

test('writeKey can store a ZCode fallback key at ~/.ae-mcp/zcode-key', () => {
  const deps = makeDeps();
  const store = createApiKeyStore(deps);
  store.writeKey('zc-secret', 'zcode');
  assert.equal(store.readKey('zcode'), 'zc-secret');
  assert.equal(deps.files.has('/home/user/.ae-mcp/zcode-key'), true);
  store.clearKey('zcode');
  assert.equal(store.readKey('zcode'), '');
});
