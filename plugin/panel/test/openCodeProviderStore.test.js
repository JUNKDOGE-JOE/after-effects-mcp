import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createOpenCodeProviderStore,
  normalizeOpenCodeProviderId,
  OPEN_CODE_CUSTOM_MODEL_LIMIT,
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
    assert.equal(store.readApiKey(provider.id), 'new-key');
    assert.equal(store.readApiKey('missing-provider'), '');
    assert.equal(store.readApiKey(''), '');
    if (process.platform !== 'win32') assert.equal(fs.statSync(authFile).mode & 0o077, 0);
    assert.deepEqual(openCodeProviderDefinitions(store.list()), {
      'aemcp-acme-relay': {
        npm: '@ai-sdk/anthropic',
        name: 'Acme Relay',
        options: { baseURL: 'https://relay.example/v1' },
        models: {
          'claude-test': {
            name: 'claude-test',
            limit: { context: 128000, output: 32000 },
          },
        },
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

test('custom OpenCode models advertise a conservative non-zero capacity', () => {
  assert.deepEqual(OPEN_CODE_CUSTOM_MODEL_LIMIT, { context: 128000, output: 32000 });
  const definitions = openCodeProviderDefinitions([{
    id: 'aemcp-limits',
    name: 'Limited Relay',
    baseUrl: 'https://relay.example/v1',
    allowInsecureHttp: false,
    modelIds: ['model-a', 'model-b'],
    needsApiKey: false,
  }]);
  for (const model of Object.values(definitions['aemcp-limits'].models)) {
    assert.deepEqual(model.limit, OPEN_CODE_CUSTOM_MODEL_LIMIT);
    assert.ok(model.limit.context > 0);
    assert.ok(model.limit.output > 0);
    assert.equal('max_tokens' in model, false);
    assert.equal('maxTokens' in model, false);
  }
});

test('custom OpenCode models use per-model context windows and safe output reserves', () => {
  const definitions = openCodeProviderDefinitions([{
    id: 'aemcp-limits',
    name: 'Limited Relay',
    baseUrl: 'https://relay.example/v1',
    allowInsecureHttp: false,
    modelIds: ['model-a', 'model-b', 'model-c'],
    modelContexts: { 'model-a': 32000, 'model-b': 64000, 'model-c': 200000 },
    needsApiKey: false,
  }]);
  assert.deepEqual(definitions['aemcp-limits'].models, {
    'model-a': { name: 'model-a', limit: { context: 32000, output: 8000 } },
    'model-b': { name: 'model-b', limit: { context: 64000, output: 16000 } },
    'model-c': { name: 'model-c', limit: { context: 200000, output: 32000 } },
  });
});

test('the same model id can use independent windows in different providers', () => {
  const definitions = openCodeProviderDefinitions([
    {
      id: 'aemcp-small',
      name: 'Small',
      baseUrl: 'https://small.example/v1',
      modelIds: ['shared'],
      modelContexts: { shared: 64000 },
    },
    {
      id: 'aemcp-large',
      name: 'Large',
      baseUrl: 'https://large.example/v1',
      modelIds: ['shared'],
      modelContexts: { shared: 200000 },
    },
  ]);
  assert.deepEqual(definitions['aemcp-small'].models.shared.limit, {
    context: 64000, output: 16000,
  });
  assert.deepEqual(definitions['aemcp-large'].models.shared.limit, {
    context: 200000, output: 32000,
  });
});

test('prototype-like model ids survive store and generated config as own keys', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-opencode-provider-'));
  try {
    const store = makeStore(root);
    const modelContexts = Object.fromEntries([
      ['__proto__', 32000],
      ['constructor', 64000],
      ['toString', 200000],
    ]);
    store.save({
      name: 'Odd Models',
      baseUrl: 'https://relay.example/v1',
      modelId: '__proto__, constructor, toString',
      modelContexts,
    }, { apiKey: 'odd-key' });
    const provider = store.list()[0];
    for (const id of ['__proto__', 'constructor', 'toString']) {
      assert.equal(Object.prototype.hasOwnProperty.call(provider.modelContexts, id), true);
    }
    const models = openCodeProviderDefinitions(store.list())['aemcp-odd-models'].models;
    assert.deepEqual(Object.keys(models).sort(), ['__proto__', 'constructor', 'toString'].sort());
    assert.equal(models.__proto__.limit.context, 32000);
    assert.equal(models.constructor.limit.context, 64000);
    assert.equal(models.toString.limit.context, 200000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('legacy provider files gain the 128K context default without credential migration', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-opencode-provider-'));
  try {
    const store = makeStore(root);
    fs.mkdirSync(path.dirname(store.filePath()), { recursive: true });
    fs.writeFileSync(store.filePath(), `${JSON.stringify({
      version: 1,
      providers: [{
        id: 'aemcp-legacy',
        name: 'Legacy',
        baseUrl: 'https://legacy.example/v1',
        protocol: 'openai',
        allowInsecureHttp: false,
        modelIds: ['old-model'],
        needsApiKey: false,
      }],
    })}\n`);
    assert.deepEqual(store.list()[0].modelContexts, { 'old-model': 128000 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('per-model contexts persist as an additive version 1 field', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-opencode-provider-'));
  try {
    const store = makeStore(root);
    store.save({
      name: 'Compatible',
      baseUrl: 'https://relay.example/v1',
      modelId: 'model-a',
      modelContexts: { 'model-a': 64000 },
    }, { apiKey: 'compatible-key' });
    const raw = JSON.parse(fs.readFileSync(store.filePath(), 'utf8'));
    assert.equal(raw.version, 1);
    assert.deepEqual(raw.providers[0].modelContexts, { 'model-a': 64000 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('provider store rejects context windows outside the supported range', () => {
  assert.throws(() => openCodeProviderDefinitions([{
    id: 'aemcp-invalid',
    name: 'Invalid',
    baseUrl: 'https://relay.example/v1',
    modelIds: ['model-a'],
    modelContexts: { 'model-a': 0 },
  }]), { code: 'OPENCODE_PROVIDER_INVALID' });
  assert.throws(() => openCodeProviderDefinitions([{
    id: 'aemcp-invalid',
    name: 'Invalid',
    baseUrl: 'https://relay.example/v1',
    modelIds: ['model-a'],
    modelContexts: { 'model-a': 31999 },
  }]), { code: 'OPENCODE_PROVIDER_INVALID' });
  assert.throws(() => openCodeProviderDefinitions([{
    id: 'aemcp-invalid',
    name: 'Invalid',
    baseUrl: 'https://relay.example/v1',
    modelIds: ['model-a'],
    modelContexts: { 'model-a': 2000001 },
  }]), { code: 'OPENCODE_PROVIDER_INVALID' });
});

test('an invalid context leaves both provider and auth files unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-opencode-provider-'));
  try {
    const store = makeStore(root);
    const saved = store.save({
      name: 'Atomic',
      baseUrl: 'https://relay.example/v1',
      modelId: 'model-a',
      modelContexts: { 'model-a': 64000 },
    }, { apiKey: 'original-key' });
    const beforeProvider = fs.readFileSync(store.filePath(), 'utf8');
    const beforeAuth = fs.readFileSync(store.authFilePath(), 'utf8');
    assert.throws(() => store.save({
      ...saved,
      modelContexts: { 'model-a': 31999 },
    }, { apiKey: 'replacement-key' }), { code: 'OPENCODE_PROVIDER_INVALID' });
    assert.equal(fs.readFileSync(store.filePath(), 'utf8'), beforeProvider);
    assert.equal(fs.readFileSync(store.authFilePath(), 'utf8'), beforeAuth);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('provider store rejects a catalog id that OpenCode would not expose', () => {
  assert.throws(() => openCodeProviderDefinitions([{
    id: 'aemcp-invalid-model',
    name: 'Invalid model',
    baseUrl: 'https://relay.example/v1',
    modelIds: ['<script>'],
  }]), { code: 'OPENCODE_PROVIDER_INVALID' });
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
