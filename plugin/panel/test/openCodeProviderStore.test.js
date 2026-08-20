import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createOpenCodeProviderStore,
  normalizeOpenCodeProviderId,
  openCodeProviderDefinitions,
} from '../src/cep/openCodeProviderStore.js';

function makeStore(root) {
  const home = path.join(root, 'home');
  return createOpenCodeProviderStore({
    fsImpl: fs,
    tempSuffix: 'test-write',
    platform: {
      env: {},
      fs,
      paths: {
        home,
        configRoot: path.join(home, '.ae-mcp'),
        join: (parts) => path.join(...parts),
        resolve: (parts) => path.resolve(home, ...parts),
      },
    },
  });
}

test('OpenCode provider store merge-writes auth.json and preserves existing providers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-opencode-provider-'));
  try {
    const store = makeStore(root);
    const authFile = store.authFilePath();
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, `${JSON.stringify({ opencode: { type: 'api', key: 'keep-me' } })}\n`);

    const provider = store.save({
      name: 'Acme Relay',
      baseUrl: 'https://relay.example/v1',
      modelId: 'claude-test',
      allowInsecureHttp: false,
    }, { apiKey: 'new-key' });

    assert.equal(provider.id, 'aemcp-acme-relay');
    assert.deepEqual(JSON.parse(fs.readFileSync(authFile, 'utf8')), {
      opencode: { type: 'api', key: 'keep-me' },
      'aemcp-acme-relay': { type: 'api', key: 'new-key' },
    });
    if (process.platform !== 'win32') assert.equal(fs.statSync(authFile).mode & 0o077, 0);
    assert.deepEqual(openCodeProviderDefinitions(store.list()), {
      'aemcp-acme-relay': {
        npm: '@ai-sdk/anthropic',
        name: 'Acme Relay',
        options: { baseURL: 'https://relay.example/v1' },
        models: { 'claude-test': { name: 'claude-test' } },
      },
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('OpenCode provider IDs are stable and legacy providers require a new key', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-opencode-provider-'));
  try {
    const store = makeStore(root);
    assert.equal(normalizeOpenCodeProviderId('aemcp-My Relay'), 'aemcp-my-relay');
    store.importLegacyProviders([{
      id: 'old-relay',
      name: 'Old Relay',
      baseUrl: 'https://old.example/v1',
      allowInsecureHttp: false,
      modelList: { models: [{ id: 'old-model' }] },
    }]);

    assert.equal(store.list()[0].needsApiKey, true);
    assert.throws(() => store.save({
      id: 'old-relay',
      name: 'Old Relay',
      baseUrl: 'https://old.example/v1',
      modelId: 'old-model',
      allowInsecureHttp: false,
    }), { code: 'OPENCODE_API_KEY_REQUIRED' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
