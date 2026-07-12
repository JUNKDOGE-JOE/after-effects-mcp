import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  anthropicEndpoint,
  CODEX_PROVIDER_API_KEY_ENV,
  codexAppServerArgs,
  codexRuntimeProviderProfile,
  codexSpawnEnv,
  effectiveProviderDialect,
  effectiveProviderCapability,
  ensureUserEnv,
  normalizeProviderEntryV2,
  normalizeProviderEntryV3,
  providerCapabilityForModel,
  providerRouteOverride,
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
    dialect: { override: null, detected: [] },
    probedModels: [],
    probedAt: 0,
  }, overrides);
}

function agentFeatures(status = 'unknown') {
  return {
    compact: status,
    continuation: status,
    countTokens: status,
    namespaceTools: status,
    reasoningReplay: status,
    stream: status,
    terminal: status,
    tools: status,
  };
}

function modelMetadata() {
  return { task: null, inputModalities: [], outputModalities: [], capabilities: [] };
}

function unknownCapability(requestProfileRevision = 1, modelListRevision = 0) {
  return {
    status: 'unknown',
    apiRoot: null,
    auth: null,
    compatibility: null,
    agentFeatures: agentFeatures(),
    checkedAt: 0,
    validUntil: 0,
    requestProfileRevision,
    modelListRevision,
    evidence: null,
  };
}

function providerFixtureV3(overrides = {}) {
  return Object.assign({
    id: 'provider-1',
    credentialId: CREDENTIAL_ID,
    name: 'Provider 1',
    baseUrl: 'https://provider.example/root',
    allowInsecureHttp: false,
    requestProfileRevision: 1,
    credential: {
      valueRef: secretRef('auth-model'),
      preferredAuth: { scheme: 'auto', headerName: null },
    },
    probeAuthOverride: null,
    headers: [],
    probePreference: null,
    modelList: {
      revision: 0,
      status: 'unknown',
      apiRoot: null,
      auth: null,
      models: [],
      checkedAt: 0,
      validUntil: 0,
      requestProfileRevision: 1,
    },
    modelCapabilities: [],
    routeOverrides: [],
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
  assert.deepEqual(codexAppServerArgs(), ['app-server']);
});

test('custom Codex providers keep model-forced v2 collaboration inside code mode', () => {
  const args = codexAppServerArgs({
    providerId: 'my-provider',
    baseUrl: 'https://proxy.example/openai/v1',
    envHeaders: [],
  }).join('\n');

  assert.match(args, /features\.multi_agent=false/);
  assert.match(args, /features\.multi_agent_v2=false/);
  assert.match(args, /features\.multi_agent_v2\.non_code_mode_only=false/);
  assert.doesNotMatch(codexAppServerArgs().join('\n'), /multi_agent_v2/);
});

test('Codex bearer API key uses env_key while extra headers use one inline header map', () => {
  const runtime = {
    providerId: 'my-provider',
    baseUrl: 'https://proxy.example/openai/v1',
    apiKey: 'sk-secret',
    envHeaders: [
      { name: 'x-provider-feature', envName: 'AE_MCP_PROVIDER_HEADER_00', value: 'enabled-secret' },
    ],
  };
  const args = codexAppServerArgs(runtime);
  assert.deepEqual(args, [
    'app-server',
    '-c', 'model_provider="my-provider"',
    '-c', 'model_providers.my-provider.name="AE MCP Custom"',
    '-c', 'model_providers.my-provider.base_url="https://proxy.example/openai/v1"',
    '-c', 'model_providers.my-provider.env_key="AE_MCP_CODEX_API_KEY"',
    '-c', 'model_providers.my-provider.env_http_headers={ "x-provider-feature" = "AE_MCP_PROVIDER_HEADER_00" }',
    '-c', 'model_providers.my-provider.wire_api="responses"',
    '-c', 'model_providers.my-provider.requires_openai_auth=false',
    '-c', 'features.multi_agent=false',
    '-c', 'features.multi_agent_v2=false',
    '-c', 'features.multi_agent_v2.non_code_mode_only=false',
  ]);
  assert.doesNotMatch(args.join('\n'), /sk-secret|enabled-secret|wire_api="chat"/);
  const env = codexSpawnEnv(runtime, { PATH: 'C:\\Node' });
  assert.equal(env[CODEX_PROVIDER_API_KEY_ENV], 'sk-secret');
  assert.equal(env.AE_MCP_PROVIDER_HEADER_00, 'enabled-secret');
});

test('Codex non-bearer auth remains an env header and clears a stale provider API key', () => {
  const runtime = {
    providerId: 'my-provider',
    baseUrl: 'https://proxy.example/openai/v1',
    envHeaders: [
      { name: 'x-api-key', envName: 'AE_MCP_PROVIDER_HEADER_00', value: 'custom-secret' },
    ],
  };
  const args = codexAppServerArgs(runtime);
  assert.match(args.join('\n'), /env_http_headers=\{ "x-api-key" = "AE_MCP_PROVIDER_HEADER_00" \}/);
  assert.doesNotMatch(args.join('\n'), /env_key/);
  const env = codexSpawnEnv(runtime, { [CODEX_PROVIDER_API_KEY_ENV]: 'stale-login-key' });
  assert.equal(Object.hasOwn(env, CODEX_PROVIDER_API_KEY_ENV), false);
  assert.equal(env.AE_MCP_PROVIDER_HEADER_00, 'custom-secret');
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

test('Codex runtime provider profile exposes only a normalized v3 provider and exact model selection', () => {
  const customProvider = providerFixtureV3({
    baseUrl: 'https://custom.example/v1',
  });
  assert.equal(codexRuntimeProviderProfile({
    effectiveChannel: 'cli-config',
    customProvider,
    customProviderCredentialResolverReady: true,
  }), null);
  assert.equal(codexRuntimeProviderProfile({
    effectiveChannel: 'custom',
    customProvider,
    customProviderCredentialResolverReady: false,
    modelId: 'model-a',
  }), null);
  assert.deepEqual(codexRuntimeProviderProfile({
    effectiveChannel: 'custom',
    customProvider,
    customProviderCredentialResolverReady: true,
    modelId: ' model-a ',
  }), { provider: normalizeProviderEntryV3(customProvider), modelId: 'model-a' });
  assert.equal(codexRuntimeProviderProfile({
    effectiveChannel: 'custom',
    customProvider,
    customProviderCredentialResolverReady: true,
  }), null);
  assert.equal(codexRuntimeProviderProfile({
    effectiveChannel: 'custom',
    customProvider: providerFixture(),
    customProviderCredentialResolverReady: true,
    modelId: 'model-a',
  }), null);
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
      detected: [{
        modelId: 'model-1',
        wireApi: 'chat',
        baseUrl: 'https://provider.example/v1',
        authProfileRevision: 1,
        detectedAt: 1783612800100,
        evidence: 'chat-success-schema',
      }],
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

test('normalizeProviderEntryV2 accepts legacy provider-level detection but canonicalizes it as unconfirmed', () => {
  assert.deepEqual(
    normalizeProviderEntryV2(providerFixture({ dialect: { override: null, detected: null } })).dialect,
    { override: null, detected: [] },
  );
  const normalized = normalizeProviderEntryV2(providerFixture({
    dialect: {
      override: null,
      detected: {
        wireApi: 'responses',
        baseUrl: 'https://provider.example/v1',
        authProfileRevision: 1,
        detectedAt: 100,
        evidence: 'models-capability',
      },
    },
  }));

  assert.deepEqual(normalized.dialect, { override: null, detected: [] });
  assert.equal(effectiveProviderDialect(normalized, { modelId: 'model-1', now: () => 101 }), null);
});

test('normalizeProviderEntryV2 canonicalizes model ids and detection ordering', () => {
  const detected = [
    {
      modelId: ' model-b ',
      wireApi: 'chat',
      baseUrl: 'https://provider.example/v1',
      authProfileRevision: 1,
      detectedAt: 2,
      evidence: 'chat-success-schema',
    },
    {
      modelId: 'model-a',
      wireApi: 'responses',
      baseUrl: 'https://provider.example/v1',
      authProfileRevision: 1,
      detectedAt: 1,
      evidence: 'responses-success-schema',
    },
  ];

  assert.deepEqual(
    normalizeProviderEntryV2(providerFixture({ dialect: { override: null, detected } })).dialect.detected,
    [
      { ...detected[1] },
      { ...detected[0], modelId: 'model-b' },
    ],
  );
});

test('effectiveProviderDialect selects only the exact model cache entry', () => {
  const nowMs = 100_000_000;
  const provider = providerFixture({
    dialect: {
      override: null,
      detected: [
        {
          modelId: 'model-b',
          wireApi: 'chat',
          baseUrl: 'https://provider.example/v1',
          authProfileRevision: 1,
          detectedAt: nowMs - 1,
          evidence: 'chat-success-schema',
        },
        {
          modelId: 'model-a',
          wireApi: 'responses',
          baseUrl: 'https://provider.example/v1/',
          authProfileRevision: 1,
          detectedAt: nowMs - 2,
          evidence: 'responses-success-schema',
        },
      ],
    },
  });

  assert.equal(effectiveProviderDialect(provider, { modelId: 'model-a', now: () => nowMs }), 'responses');

  const weakEvidence = {
    ...provider,
    dialect: {
      override: null,
      detected: [{ ...provider.dialect.detected[0], evidence: 'models-capability' }],
    },
  };
  assert.equal(effectiveProviderDialect(weakEvidence, { modelId: 'model-b', now: () => nowMs }), null);

  const mismatchedSuccessEvidence = {
    ...provider,
    dialect: {
      override: null,
      detected: [{ ...provider.dialect.detected[0], evidence: 'responses-success-schema' }],
    },
  };
  assert.equal(effectiveProviderDialect(mismatchedSuccessEvidence, { modelId: 'model-b', now: () => nowMs }), null);
  assert.equal(effectiveProviderDialect(provider, { modelId: ' model-b ', now: () => nowMs }), 'chat');
  assert.equal(effectiveProviderDialect(provider, { modelId: 'MODEL-A', now: () => nowMs }), null);
  assert.equal(effectiveProviderDialect(provider, { modelId: 'model-c', now: () => nowMs }), null);
  assert.equal(effectiveProviderDialect(provider, { now: () => nowMs }), null);

  assert.equal(effectiveProviderDialect({
    ...provider,
    dialect: {
      override: null,
      detected: provider.dialect.detected.map((entry) => (
        entry.modelId === 'model-b' ? { ...entry, detectedAt: nowMs - 86_400_001 } : entry
      )),
    },
  }, { modelId: 'model-b', now: () => nowMs }), null);
  assert.equal(effectiveProviderDialect(provider, { modelId: 'model-a', now: () => nowMs }), 'responses');
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
      detected: [{
        modelId: 'model-1',
        wireApi: 'responses',
        baseUrl: 'https://provider.example/v1',
        authProfileRevision: 1,
        detectedAt: 1,
        evidence: 'http-200',
      }],
    },
  });
  const legacyPerModelEvidence = providerFixture({
    dialect: {
      override: null,
      detected: [{
        modelId: 'model-1',
        wireApi: 'chat',
        baseUrl: 'https://provider.example/v1',
        authProfileRevision: 1,
        detectedAt: 1,
        evidence: 'chat-missing-messages-500-compat',
      }],
    },
  });
  const mismatchedSuccessfulEvidence = providerFixture({
    dialect: {
      override: null,
      detected: [{
        modelId: 'model-1',
        wireApi: 'chat',
        baseUrl: 'https://provider.example/v1',
        authProfileRevision: 1,
        detectedAt: 1,
        evidence: 'responses-success-schema',
      }],
    },
  });
  const duplicateModelDetection = providerFixture({
    dialect: {
      override: null,
      detected: [
        {
          modelId: 'model-1',
          wireApi: 'responses',
          baseUrl: 'https://provider.example/v1',
          authProfileRevision: 1,
          detectedAt: 1,
          evidence: 'responses-success-schema',
        },
        {
          modelId: ' model-1 ',
          wireApi: 'chat',
          baseUrl: 'https://provider.example/v1',
          authProfileRevision: 1,
          detectedAt: 2,
          evidence: 'chat-success-schema',
        },
      ],
    },
  });
  const missingDetectedModelId = providerFixture({
    dialect: {
      override: null,
      detected: [{
        wireApi: 'responses',
        baseUrl: 'https://provider.example/v1',
        authProfileRevision: 1,
        detectedAt: 1,
        evidence: 'responses-success-schema',
      }],
    },
  });
  const extraDetectedField = providerFixture({
    dialect: {
      override: null,
      detected: [{
        modelId: 'model-1',
        wireApi: 'responses',
        baseUrl: 'https://provider.example/v1',
        authProfileRevision: 1,
        detectedAt: 1,
        evidence: 'responses-success-schema',
        capability: 'all',
      }],
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
    legacyPerModelEvidence,
    mismatchedSuccessfulEvidence,
    duplicateModelDetection,
    missingDetectedModelId,
    extraDetectedField,
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

test('normalizeProviderEntryV3 canonicalizes the per-model protocol matrix and client overrides', () => {
  const checkedAt = 1_783_612_800_000;
  const modelList = {
    revision: 3,
    status: 'supported',
    apiRoot: 'https://provider.example/v1/',
    auth: { scheme: 'bearer', headerName: null },
    models: [
      { id: ' model-b ', label: 'Model B', metadata: modelMetadata() },
      { id: 'model-a', label: 'Model A', metadata: modelMetadata() },
    ],
    checkedAt,
    validUntil: checkedAt + 3_600_000,
    requestProfileRevision: 1,
  };
  const chat = {
    status: 'supported',
    apiRoot: 'https://provider.example/v1',
    auth: { scheme: 'bearer', headerName: null },
    compatibility: { instructionMode: 'chat-system', tokenField: 'max_tokens' },
    agentFeatures: agentFeatures(),
    checkedAt,
    validUntil: checkedAt + 86_400_000,
    requestProfileRevision: 1,
    modelListRevision: 3,
    evidence: 'chat-success-schema',
  };
  const provider = providerFixtureV3({
    modelList,
    modelCapabilities: [{
      modelId: ' model-b ',
      responses: unknownCapability(1, 3),
      chat,
      messages: unknownCapability(1, 3),
    }, {
      modelId: 'model-a',
      responses: unknownCapability(1, 3),
      chat: unknownCapability(1, 3),
      messages: unknownCapability(1, 3),
    }],
    routeOverrides: [{
      client: 'claude-code', modelId: 'model-b', protocol: 'chat', updatedAt: checkedAt,
    }, {
      client: 'codex', modelId: 'model-a', protocol: 'responses', updatedAt: checkedAt,
    }],
  });

  const normalized = normalizeProviderEntryV3(provider);
  assert.deepEqual(normalized.modelList.models.map((entry) => entry.id), ['model-a', 'model-b']);
  assert.deepEqual(normalized.modelCapabilities.map((entry) => entry.modelId), ['model-a', 'model-b']);
  assert.deepEqual(
    normalized.routeOverrides.map((entry) => `${entry.client}:${entry.modelId}`),
    ['claude-code:model-b', 'codex:model-a'],
  );
  assert.equal(providerCapabilityForModel(normalized, {
    modelId: 'model-b', protocol: 'chat', now: () => checkedAt + 1,
  }).status, 'supported');
  assert.equal(effectiveProviderCapability(normalized, {
    modelId: 'model-b', protocol: 'chat', now: () => checkedAt + 1,
  }).compatibility.instructionMode, 'chat-system');
  assert.equal(providerRouteOverride(normalized, {
    client: 'claude-code', modelId: 'model-b',
  }).protocol, 'chat');
});

test('Provider v3 cache identity requires exact request and model-list revisions', () => {
  const checkedAt = 10_000;
  const capability = {
    status: 'supported',
    apiRoot: 'https://provider.example/v1',
    auth: { scheme: 'bearer', headerName: null },
    compatibility: { instructionMode: 'responses-instructions', tokenField: 'max_output_tokens' },
    agentFeatures: agentFeatures(),
    checkedAt,
    validUntil: checkedAt + 100,
    requestProfileRevision: 1,
    modelListRevision: 0,
    evidence: 'responses-success-schema',
  };
  const provider = providerFixtureV3({
    modelCapabilities: [{
      modelId: 'model-a',
      responses: capability,
      chat: unknownCapability(),
      messages: unknownCapability(),
    }],
  });
  assert.ok(effectiveProviderCapability(provider, {
    modelId: 'model-a', protocol: 'responses', now: () => checkedAt + 1,
  }));
  assert.equal(effectiveProviderCapability({ ...provider, requestProfileRevision: 2 }, {
    modelId: 'model-a', protocol: 'responses', now: () => checkedAt + 1,
  }), null);
  assert.equal(effectiveProviderCapability(provider, {
    modelId: 'model-a', protocol: 'responses', now: () => checkedAt + 101,
  }), null);
});

test('Provider v3 accepts verified budget terminals and revision-bound unsupported caches', () => {
  const checkedAt = 20_000;
  const provider = providerFixtureV3({
    modelCapabilities: [{
      modelId: 'model-a',
      responses: {
        status: 'supported',
        apiRoot: 'https://provider.example/v1',
        auth: { scheme: 'bearer', headerName: null },
        compatibility: { instructionMode: 'responses-instructions', tokenField: 'max_output_tokens' },
        agentFeatures: agentFeatures(),
        checkedAt,
        validUntil: checkedAt + 100,
        requestProfileRevision: 1,
        modelListRevision: 0,
        evidence: 'responses-incomplete-schema',
      },
      chat: {
        status: 'unsupported',
        apiRoot: 'https://provider.example/v1',
        auth: { scheme: 'bearer', headerName: null },
        compatibility: null,
        agentFeatures: agentFeatures(),
        checkedAt,
        validUntil: null,
        requestProfileRevision: 1,
        modelListRevision: 0,
        evidence: 'endpoint-unsupported',
      },
      messages: unknownCapability(),
    }],
  });
  assert.equal(effectiveProviderCapability(provider, {
    modelId: 'model-a', protocol: 'responses', now: () => checkedAt + 1,
  }).evidence, 'responses-incomplete-schema');
  assert.equal(providerCapabilityForModel(provider, {
    modelId: 'model-a', protocol: 'chat', now: () => checkedAt + 1_000_000,
  }).status, 'unsupported');
  assert.equal(effectiveProviderCapability(provider, {
    modelId: 'model-a', protocol: 'chat', now: () => checkedAt + 1,
  }), null);
});

test('normalizeProviderEntryV3 rejects global protocol fields and unsafe capability claims', () => {
  const checkedAt = 1_000;
  const supported = {
    status: 'supported',
    apiRoot: 'https://provider.example/v1',
    auth: { scheme: 'bearer', headerName: null },
    compatibility: { instructionMode: 'chat-developer', tokenField: 'max_tokens' },
    agentFeatures: agentFeatures(),
    checkedAt,
    validUntil: checkedAt + 1,
    requestProfileRevision: 1,
    modelListRevision: 0,
    evidence: 'chat-success-schema',
  };
  const baseCapability = {
    modelId: 'model-a',
    responses: unknownCapability(),
    chat: supported,
    messages: unknownCapability(),
  };
  const extraProtocol = { ...providerFixtureV3(), protocol: 'openai-compatible' };
  const crossOrigin = providerFixtureV3({
    modelCapabilities: [{
      ...baseCapability,
      chat: { ...supported, apiRoot: 'https://other.example/v1' },
    }],
  });
  const mismatchedEvidence = providerFixtureV3({
    modelCapabilities: [{
      ...baseCapability,
      chat: { ...supported, evidence: 'responses-success-schema' },
    }],
  });
  const duplicateOverride = providerFixtureV3({
    routeOverrides: [{
      client: 'codex', modelId: 'model-a', protocol: 'responses', updatedAt: checkedAt,
    }, {
      client: 'codex', modelId: 'model-a', protocol: 'chat', updatedAt: checkedAt + 1,
    }],
  });
  const unknownFeatureClaim = providerFixtureV3({
    modelCapabilities: [{
      ...baseCapability,
      responses: {
        ...unknownCapability(),
        agentFeatures: { ...agentFeatures(), tools: 'supported' },
      },
    }],
  });
  const unsupportedFeatureClaim = providerFixtureV3({
    modelCapabilities: [{
      ...baseCapability,
      responses: {
        status: 'unsupported',
        apiRoot: 'https://provider.example/v1',
        auth: { scheme: 'bearer', headerName: null },
        compatibility: null,
        agentFeatures: { ...agentFeatures(), stream: 'supported' },
        checkedAt,
        validUntil: null,
        requestProfileRevision: 1,
        modelListRevision: 0,
        evidence: 'endpoint-unsupported',
      },
    }],
  });
  const incompleteAgentFeatures = providerFixtureV3({
    modelCapabilities: [{
      ...baseCapability,
      responses: {
        ...unknownCapability(),
        agentFeatures: { compact: 'unknown' },
      },
    }],
  });
  for (const value of [
    extraProtocol,
    crossOrigin,
    mismatchedEvidence,
    duplicateOverride,
    unknownFeatureClaim,
    unsupportedFeatureClaim,
    incompleteAgentFeatures,
  ]) {
    assert.throws(
      () => normalizeProviderEntryV3(value),
      (error) => error instanceof Error && error.code === 'provider_profile_invalid',
    );
  }
});

test('Provider v3 retains a migration-only probe credential without replacing the primary ref', () => {
  const normalized = normalizeProviderEntryV3(providerFixtureV3({
    probeAuthOverride: { kind: 'x-api-key', valueRef: secretRef('auth-probe', 4) },
  }));
  assert.deepEqual(normalized.credential.valueRef, secretRef('auth-model'));
  assert.deepEqual(normalized.probeAuthOverride.valueRef, secretRef('auth-probe', 4));
});
