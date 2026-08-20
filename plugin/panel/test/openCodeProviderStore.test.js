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

test('OpenCode provider IDs are stable and new providers require an API key', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-opencode-provider-'));
  try {
    const store = makeStore(root);
    assert.equal(normalizeOpenCodeProviderId('aemcp-My Relay'), 'aemcp-my-relay');
    assert.throws(() => store.save({
      id: 'new-relay',
      name: 'New Relay',
      baseUrl: 'https://new.example/v1',
      modelId: 'new-model',
      allowInsecureHttp: false,
    }), { code: 'OPENCODE_API_KEY_REQUIRED' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('openCodeProviderDefinitions appends /v1 to a bare relay base URL', () => {
  const definitions = openCodeProviderDefinitions([{
    id: 'aemcp-bare',
    name: 'Bare Relay',
    baseUrl: 'https://relay.example',
    allowInsecureHttp: false,
    modelIds: ['claude-test'],
    needsApiKey: false,
  }]);
  assert.equal(definitions['aemcp-bare'].options.baseURL, 'https://relay.example/v1');
});

test('openai-protocol providers inject the openai-compatible loader', () => {
  const definitions = openCodeProviderDefinitions([{
    id: 'aemcp-relay',
    name: 'Relay',
    baseUrl: 'https://relay.example',
    allowInsecureHttp: false,
    modelIds: ['gemini-test'],
    needsApiKey: false,
    protocol: 'openai',
  }]);
  assert.equal(definitions['aemcp-relay'].npm, '@ai-sdk/openai-compatible');
  assert.equal(definitions['aemcp-relay'].options.baseURL, 'https://relay.example/v1');
});
