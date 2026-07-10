import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  anthropicEndpoint,
  codexAppServerArgs,
  codexRuntimeProviderProfile,
  codexSpawnEnv,
  ensureUserEnv,
  normalizeProviderEntryV2,
  normalizeProviderProfile,
} from '../src/lib/providerProfile.js';

const CREDENTIAL_ID = '5eb75f05-5d9e-5d9c-85af-f0893e8b90c2';

function secretRef(slot, revision = 1) {
  return {
    kind: 'secret',
    reference: `aemcp-secret://provider/${CREDENTIAL_ID}/${slot}/v1`,
    revision,
  };
}

function providerFixture(overrides = {}) {
  return Object.assign({
    id: 'provider-1',
    credentialId: CREDENTIAL_ID,
    name: 'Provider 1',
    protocol: 'openai-compatible',
    baseUrl: 'https://provider.example/v1',
    allowInsecureHttp: false,
    authProfileRevision: 1,
    auth: { model: { kind: 'none' }, probe: { kind: 'inherit-model' } },
    headers: [],
    dialect: { override: null, detected: null },
    probedModels: [],
    probedAt: 0,
  }, overrides);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertInvalidProvider(value) {
  assert.throws(
    () => normalizeProviderEntryV2(value),
    (error) => error instanceof Error && error.code === 'provider_profile_invalid',
  );
}

test('codexAppServerArgs keeps official Codex login path when no custom base URL is configured', () => {
  assert.deepEqual(codexAppServerArgs(normalizeProviderProfile({})), ['app-server']);
});

test('codexAppServerArgs builds explicit custom provider config for app-server', () => {
  const profile = normalizeProviderProfile({
    codexBaseUrl: ' https://proxy.example/openai/ ',
    codexApiKey: ' sk-proxy ',
    codexProviderId: 'my-provider',
    codexWireApi: 'chat',
  });

  assert.deepEqual(codexAppServerArgs(profile), [
    'app-server',
    '-c', 'model_provider="my-provider"',
    '-c', 'model_providers.my-provider.name="AE MCP Custom"',
    '-c', 'model_providers.my-provider.base_url="https://proxy.example/openai"',
    '-c', 'model_providers.my-provider.env_key="AE_MCP_CODEX_API_KEY"',
    '-c', 'model_providers.my-provider.wire_api="chat"',
    '-c', 'model_providers.my-provider.requires_openai_auth=false',
  ]);
  assert.equal(codexSpawnEnv(profile, { PATH: 'C:\\Node' }).AE_MCP_CODEX_API_KEY, 'sk-proxy');
});

test('normalizeProviderProfile falls back to responses for missing or invalid codex wire API', () => {
  assert.equal(normalizeProviderProfile({ codexWireApi: 'bogus' }).codexWireApi, 'responses');
  assert.equal(normalizeProviderProfile({}).codexWireApi, 'responses');
});

test('anthropicEndpoint appends API paths without dropping a proxy prefix', () => {
  assert.equal(
    anthropicEndpoint('https://proxy.example/anthropic/', '/v1/messages'),
    'https://proxy.example/anthropic/v1/messages'
  );
});

test('validateProviderBaseUrl rejects raw and percent-decoded credential-like path material', () => {
  for (const baseUrl of [
    'https://relay.example/proxy/sk-secret-token-123456',
    'https://relay.example/proxy/%73%6b%2dsecret-token-123456',
    'https://relay.example/proxy/Bearer%20secret-token-123456',
    'https://relay.example/proxy/%2542%2565%2561%2572%2565%2572%2520secret-token-123456',
  ]) {
    assertInvalidProvider(providerFixture({ baseUrl }));
  }
});

test('validateProviderBaseUrl rejects even empty query, fragment, and userinfo delimiters', () => {
  for (const baseUrl of [
    'https://relay.example/v1?',
    'https://relay.example/v1#',
    'https://@relay.example/v1',
  ]) assertInvalidProvider(providerFixture({ baseUrl }));
});

test('Codex runtime provider profile is selected only by the effective channel and resolver gate', () => {
  const customProvider = providerFixture({ baseUrl: 'https://custom.example/v1' });
  assert.deepEqual(codexRuntimeProviderProfile({
    effectiveChannel: 'cli-config',
    customProvider,
    customProviderCredentialResolverReady: true,
  }), normalizeProviderProfile({}));
  assert.deepEqual(codexRuntimeProviderProfile({
    effectiveChannel: 'custom',
    customProvider,
    customProviderCredentialResolverReady: false,
  }), normalizeProviderProfile({}));
  assert.equal(codexRuntimeProviderProfile({
    effectiveChannel: 'custom',
    customProvider,
    customProviderCredentialResolverReady: true,
  }).codexBaseUrl, 'https://custom.example/v1');
});

test('ensureUserEnv fills USERPROFILE/HOME/APPDATA from whichever anchor exists', () => {
  const fromHome = ensureUserEnv({ HOME: 'C:\\Users\\me\\' });
  assert.equal(fromHome.USERPROFILE, 'C:\\Users\\me');
  assert.equal(fromHome.HOME, 'C:\\Users\\me\\');
  assert.equal(fromHome.APPDATA, 'C:\\Users\\me\\AppData\\Roaming');

  const fromHomedir = ensureUserEnv({}, { homedir: 'C:\\Users\\me' });
  assert.equal(fromHomedir.USERPROFILE, 'C:\\Users\\me');
  assert.equal(fromHomedir.HOME, 'C:\\Users\\me');

  const untouched = ensureUserEnv({ USERPROFILE: 'C:\\U', HOME: 'C:\\U', APPDATA: 'C:\\A' });
  assert.equal(untouched.APPDATA, 'C:\\A');

  assert.deepEqual(ensureUserEnv({ PATH: 'x' }), { PATH: 'x' });
});

test('normalizeProviderEntryV2 accepts only the exact v2 schema and returns a detached value', () => {
  const input = providerFixture({
    auth: {
      model: { kind: 'bearer', valueRef: secretRef('auth-model', 2) },
      probe: { kind: 'inherit-model' },
    },
    headers: [
      { id: 'feature', name: 'x-provider-feature', scopes: ['probe', 'model'], valueRef: { kind: 'literal', value: 'enabled' } },
      { id: 'secret', name: 'x-provider-token', scopes: ['model'], valueRef: secretRef('header', 3) },
    ],
    dialect: {
      override: { wireApi: 'chat', source: 'legacy-v0.9', updatedAt: 1783612800000 },
      detected: {
        wireApi: 'chat',
        baseUrl: 'https://provider.example/v1',
        authProfileRevision: 1,
        detectedAt: 1783612800100,
        evidence: 'chat-success-schema',
      },
    },
    probedModels: [{ id: 'model-1', label: 'Model 1' }],
    probedAt: 1783612800200,
  });

  const normalized = normalizeProviderEntryV2(input);
  assert.deepEqual(normalized, input);
  assert.notEqual(normalized, input);
  assert.notEqual(normalized.auth, input.auth);
  assert.notEqual(normalized.headers, input.headers);
  assert.deepEqual(Object.keys(normalized).sort(), [
    'allowInsecureHttp',
    'auth',
    'authProfileRevision',
    'baseUrl',
    'credentialId',
    'dialect',
    'headers',
    'id',
    'name',
    'probedAt',
    'probedModels',
    'protocol',
  ]);
});

test('normalizeProviderEntryV2 rejects extra, missing, or malformed nested schema fields', () => {
  const extraTopLevel = { ...providerFixture(), apiKey: 'must-never-be-v2' };
  const missingTopLevel = providerFixture();
  delete missingTopLevel.dialect;
  const extraAuth = providerFixture({ auth: { model: { kind: 'none', valueRef: secretRef('auth-model') }, probe: { kind: 'inherit-model' } } });
  const wrongCredentialReference = providerFixture({
    auth: {
      model: {
        kind: 'bearer',
        valueRef: {
          kind: 'secret',
          reference: 'aemcp-secret://provider/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/auth-model/v1',
          revision: 1,
        },
      },
      probe: { kind: 'inherit-model' },
    },
  });
  const badRevision = providerFixture({
    auth: { model: { kind: 'bearer', valueRef: secretRef('auth-model', 0) }, probe: { kind: 'inherit-model' } },
  });
  const duplicateScope = providerFixture({
    headers: [{ id: 'feature', name: 'x-feature', scopes: ['model', 'model'], valueRef: { kind: 'literal', value: 'on' } }],
  });
  const extraModelField = providerFixture({ probedModels: [{ id: 'model-1', label: 'Model 1', secret: false }] });
  const badEvidence = providerFixture({
    dialect: {
      override: null,
      detected: {
        wireApi: 'responses',
        baseUrl: 'https://provider.example/v1',
        authProfileRevision: 1,
        detectedAt: 1,
        evidence: 'http-200',
      },
    },
  });

  for (const value of [
    extraTopLevel,
    missingTopLevel,
    extraAuth,
    wrongCredentialReference,
    badRevision,
    duplicateScope,
    extraModelField,
    badEvidence,
    providerFixture({ protocol: 'grpc' }),
  ]) {
    assertInvalidProvider(value);
  }

  const nonCanonical = clone(providerFixture());
  nonCanonical.credentialId = nonCanonical.credentialId.toUpperCase();
  assertInvalidProvider(nonCanonical);
});

test('normalizeProviderEntryV2 requires SecretValueRef for sensitive names and exact credential literals', () => {
  const rejectedHeaders = [
    { id: 'named-token', name: 'x-provider-token', scopes: ['model'], valueRef: { kind: 'literal', value: 'enabled' } },
    { id: 'secret-value', name: 'x-feature', scopes: ['model'], valueRef: { kind: 'literal', value: 'sk-test-secret-1234' } },
    { id: 'jwt-value', name: 'x-feature', scopes: ['probe'], valueRef: { kind: 'literal', value: `${'a'.repeat(16)}.${'b'.repeat(16)}.${'c'.repeat(8)}` } },
  ];

  for (const header of rejectedHeaders) {
    assert.throws(
      () => normalizeProviderEntryV2(providerFixture({ headers: [header] })),
      (error) => error instanceof Error && error.code === 'provider_header_secret_reference_required',
    );
  }

  assert.deepEqual(
    normalizeProviderEntryV2(providerFixture({
      headers: [{ id: 'feature', name: 'x-provider-feature', scopes: ['model'], valueRef: { kind: 'literal', value: 'enabled' } }],
    })).headers,
    [{ id: 'feature', name: 'x-provider-feature', scopes: ['model'], valueRef: { kind: 'literal', value: 'enabled' } }],
  );
});
