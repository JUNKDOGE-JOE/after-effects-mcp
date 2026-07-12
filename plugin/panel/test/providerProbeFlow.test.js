import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProviderManagerProbe } from '../src/app/providerProbeFlow.js';
import { effectiveProviderCapability } from '../src/lib/providerProfile.js';

const CREDENTIAL_ID = '5eb75f05-5d9e-5d9c-85af-f0893e8b90c2';
const OBSERVED_AT = 1_000;

function secretRef(slot = 'auth-model') {
  return {
    kind: 'secret',
    reference: `aemcp-secret://provider/${CREDENTIAL_ID}/${slot}/v1`,
    revision: 1,
  };
}

function metadata(overrides = {}) {
  return {
    task: null,
    inputModalities: [],
    outputModalities: [],
    capabilities: [],
    ...overrides,
  };
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

function probedAgentFeatureState(protocol) {
  const features = agentFeatures();
  const evidence = Object.fromEntries(Object.keys(features).map((key) => [key, 'not-probed']));
  const set = (feature, value) => {
    features[feature] = 'supported';
    evidence[feature] = value;
  };
  set('stream', `${protocol}-stream-terminal-valid`);
  set('terminal', `${protocol}-stream-terminal-valid`);
  set('tools', `${protocol}-tool-call-valid`);
  if (protocol === 'responses') {
    set('compact', 'responses-compact-valid');
    set('continuation', 'responses-continuation-valid');
    set('namespaceTools', 'responses-namespace-tools-valid');
  }
  if (protocol === 'messages') set('countTokens', 'messages-count-tokens-valid');
  return { features, evidence };
}

function unknownCapability(modelListRevision = 0) {
  return {
    status: 'unknown',
    apiRoot: null,
    auth: null,
    compatibility: null,
    agentFeatures: agentFeatures(),
    checkedAt: 0,
    validUntil: 0,
    requestProfileRevision: 1,
    modelListRevision,
    evidence: null,
  };
}

function storedSupported(protocol, {
  checkedAt = 900,
  validUntil = 10_000,
  modelListRevision = 0,
} = {}) {
  const compatibility = protocol === 'responses'
    ? { instructionMode: 'responses-instructions', tokenField: 'max_output_tokens' }
    : protocol === 'chat'
      ? { instructionMode: 'chat-developer', tokenField: 'max_tokens' }
      : { instructionMode: 'messages-system', tokenField: 'max_tokens' };
  return {
    status: 'supported',
    apiRoot: 'https://provider.example/v1',
    auth: { scheme: 'bearer', headerName: null },
    compatibility,
    agentFeatures: agentFeatures(),
    checkedAt,
    validUntil,
    requestProfileRevision: 1,
    modelListRevision,
    evidence: `${protocol}-success-schema`,
  };
}

function providerFixture(overrides = {}) {
  return Object.assign({
    id: 'provider-1',
    credentialId: CREDENTIAL_ID,
    name: 'Provider 1',
    baseUrl: 'https://provider.example/root',
    allowInsecureHttp: false,
    requestProfileRevision: 1,
    credential: {
      valueRef: secretRef(),
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

function resolvedProfile(provider, secret = 'resolved-provider-secret') {
  return {
    providerId: provider.id,
    baseUrl: provider.baseUrl,
    allowInsecureHttp: provider.allowInsecureHttp,
    auth: { kind: 'header', name: 'Authorization', value: secret },
    extraHeaders: [],
    requestProfileRevision: provider.requestProfileRevision,
  };
}

function fakeStore(provider, revision = 7) {
  let current = provider;
  let stateRevision = revision;
  const writes = [];
  return {
    writes,
    current: () => current,
    readState: () => ({ revision: stateRevision }),
    get: (id) => (id === current.id ? current : null),
    upsert(entry, options = {}) {
      writes.push({ entry, options });
      if (options.expectedRevision !== stateRevision) {
        const error = new Error('Provider store revision conflict');
        error.code = 'PROVIDER_STORE_CONFLICT';
        throw error;
      }
      current = entry;
      stateRevision += 1;
      return { entry, stateRevision };
    },
    bumpRevision() { stateRevision += 1; },
  };
}

function supported(protocol, overrides = {}) {
  const evidence = {
    responses: 'responses-success-schema',
    chat: 'chat-success-schema',
    messages: 'messages-success-schema',
  }[protocol];
  const agent = probedAgentFeatureState(protocol);
  return {
    protocol,
    support: 'supported',
    apiRoot: 'https://provider.example/v1',
    authScheme: 'bearer',
    schema: { nonStreaming: 'valid', evidence },
    compatibility: {
      instructionRole: protocol === 'chat' ? 'developer' : protocol === 'messages' ? 'system' : null,
      tokenField: protocol === 'responses' ? 'max_output_tokens' : 'max_tokens',
    },
    agentFeatures: agent.features,
    agentFeatureEvidence: agent.evidence,
    errorClass: null,
    ttl: { class: 'success', maxAgeMs: 86_400_000 },
    ...overrides,
  };
}

function unsupported(protocol, errorClass = 'endpoint-unsupported') {
  return {
    protocol,
    support: 'unsupported',
    apiRoot: 'https://provider.example/v1',
    authScheme: 'bearer',
    schema: { nonStreaming: 'not-tested', evidence: 'verified-unsupported' },
    compatibility: { instructionRole: null, tokenField: null },
    agentFeatures: agentFeatures(),
    agentFeatureEvidence: Object.fromEntries(
      Object.keys(agentFeatures()).map((key) => [key, 'not-probed']),
    ),
    errorClass,
    ttl: { class: 'unsupported', maxAgeMs: null },
  };
}

function uncacheable(protocol, support, errorClass, ttlClass = support) {
  return {
    protocol,
    support,
    apiRoot: 'https://provider.example/v1',
    authScheme: 'bearer',
    schema: { nonStreaming: 'not-tested', evidence: errorClass },
    compatibility: { instructionRole: null, tokenField: null },
    agentFeatures: agentFeatures(),
    agentFeatureEvidence: Object.fromEntries(
      Object.keys(agentFeatures()).map((key) => [key, 'not-probed']),
    ),
    errorClass,
    ttl: { class: ttlClass, maxAgeMs: 60_000 },
  };
}

function matrix(modelId = 'model-1', overrides = {}) {
  return {
    ok: true,
    modelId,
    capabilities: {
      responses: supported('responses'),
      chat: supported('chat'),
      messages: supported('messages'),
    },
    preferredProtocol: 'responses',
    preferredProtocolEvidence: 'observed-supported-protocol-order',
    observedAt: OBSERVED_AT,
    models: [],
    inventory: [],
    modelListProbe: null,
    tried: [],
    ...overrides,
  };
}

test('maps one model into three independent v3 protocol and strictly-probed agent capabilities', async () => {
  const provider = providerFixture();
  const store = fakeStore(provider, 11);
  const capabilities = {
    responses: supported('responses', {
      schema: { nonStreaming: 'valid', evidence: 'responses-incomplete-schema' },
    }),
    chat: supported('chat', {
      compatibility: { instructionRole: 'system', tokenField: 'max_completion_tokens' },
    }),
    messages: supported('messages', {
      schema: { nonStreaming: 'valid', evidence: 'messages-max-tokens-schema' },
    }),
  };
  const result = await runProviderManagerProbe(provider, {
    store,
    modelId: 'model-1',
    resolveRequestProfile: async (entry) => resolvedProfile(entry),
    probeProviderCapabilitiesImpl: async ({ provider: adapted, modelId, timeoutMs }) => {
      assert.equal(adapted.protocol, 'openai-compatible');
      assert.equal(adapted.authProfileRevision, 1);
      assert.equal(modelId, 'model-1');
      assert.equal(timeoutMs, 30_000);
      return matrix('model-1', { capabilities, preferredProtocol: 'chat' });
    },
  });

  assert.equal(result.ok, true);
  const record = result.entry.modelCapabilities[0];
  assert.equal(record.responses.evidence, 'responses-incomplete-schema');
  assert.deepEqual(record.chat.compatibility, {
    instructionMode: 'chat-system',
    tokenField: 'max_completion_tokens',
  });
  assert.equal(record.messages.evidence, 'messages-max-tokens-schema');
  for (const protocol of ['responses', 'chat', 'messages']) {
    assert.deepEqual(record[protocol].agentFeatures, probedAgentFeatureState(protocol).features);
  }
  assert.deepEqual(result.entry.routeOverrides, []);
  assert.equal(store.writes[0].options.expectedRevision, 11);
});

test('capability probing preserves a verified v1 API root for probe and model profiles', async () => {
  const provider = providerFixture({
    modelList: {
      revision: 1,
      status: 'supported',
      apiRoot: 'https://provider.example/v1',
      auth: { scheme: 'bearer', headerName: null },
      models: [{ id: 'model-1', label: 'Model 1', metadata: metadata() }],
      checkedAt: 100,
      validUntil: 3_700_000,
      requestProfileRevision: 1,
    },
  });
  const resolverCalls = [];
  const result = await runProviderManagerProbe(provider, {
    modelId: 'model-1',
    resolveRequestProfile: async (entry, details) => {
      resolverCalls.push(details);
      return resolvedProfile(entry);
    },
    probeProviderCapabilitiesImpl: async ({ provider: adapted, resolveRequestProfile }) => {
      assert.equal(adapted.baseUrl, 'https://provider.example/v1');
      const probeProfile = await resolveRequestProfile(adapted, { scope: 'probe' });
      const modelProfile = await resolveRequestProfile(adapted, { scope: 'model' });
      assert.equal(probeProfile.baseUrl, 'https://provider.example/v1');
      assert.equal(modelProfile.baseUrl, 'https://provider.example/v1');
      assert.equal(probeProfile.auth.value, 'resolved-provider-secret');
      assert.equal(modelProfile.auth.value, 'resolved-provider-secret');
      return matrix('model-1');
    },
  });

  assert.equal(result.ok, true);
  assert.equal(resolverCalls.length, 2);
  assert.equal(resolverCalls.every((details) => details.apiRoot === 'https://provider.example/v1'), true);
});

test('persists a revisioned model inventory with only allowlisted metadata', async () => {
  const provider = providerFixture();
  const result = await runProviderManagerProbe(provider, {
    modelId: 'model-a',
    resolveRequestProfile: async (entry) => resolvedProfile(entry),
    probeProviderCapabilitiesImpl: async () => matrix('model-a', {
      modelListProbe: {
        status: 'supported',
        apiRoot: 'https://provider.example/v1',
        authScheme: 'bearer',
        models: [
          { id: 'model-b', label: 'Model B' },
          { id: 'model-a', label: 'Fallback A' },
        ],
        inventory: [{
          id: 'model-a',
          label: 'Model A',
          ignored: 'not-persisted',
          metadata: {
            task: 'chat',
            inputModalities: ['text', 'text'],
            outputModalities: ['text'],
            capabilities: ['tools'],
            owner: 'not-persisted',
          },
        }],
      },
    }),
  });

  assert.equal(result.entry.modelList.revision, 1);
  assert.deepEqual(result.entry.modelList.models, [{
    id: 'model-a',
    label: 'Model A',
    metadata: metadata({
      task: 'chat',
      inputModalities: ['text'],
      outputModalities: ['text'],
      capabilities: ['tools'],
    }),
  }, {
    id: 'model-b',
    label: 'Model B',
    metadata: metadata(),
  }]);
  assert.deepEqual(Object.keys(result.entry.modelList.models[0]).sort(), ['id', 'label', 'metadata']);
  assert.deepEqual(Object.keys(result.entry.modelList.models[0].metadata).sort(), [
    'capabilities', 'inputModalities', 'outputModalities', 'task',
  ]);
  assert.equal(result.entry.modelCapabilities[0].responses.modelListRevision, 1);
});

test('transient, authentication, and invalid results preserve a fresh verified capability', async () => {
  const prior = storedSupported('responses');
  const provider = providerFixture({
    modelCapabilities: [{
      modelId: 'model-1',
      responses: prior,
      chat: unknownCapability(),
      messages: unknownCapability(),
    }],
  });
  const result = await runProviderManagerProbe(provider, {
    modelId: 'model-1',
    resolveRequestProfile: async (entry) => resolvedProfile(entry),
    probeProviderCapabilitiesImpl: async () => matrix('model-1', {
      ok: false,
      capabilities: {
        responses: uncacheable('responses', 'transient', 'network'),
        chat: uncacheable('chat', 'authentication', 'authentication', 'authentication'),
        messages: uncacheable('messages', 'invalid', 'invalid-schema', 'invalid'),
      },
    }),
  });

  assert.deepEqual(result.entry.modelCapabilities[0].responses, prior);
  assert.equal(result.entry.modelCapabilities[0].chat.status, 'unknown');
  assert.equal(result.entry.modelCapabilities[0].messages.status, 'unknown');
});

test('a retryable matrix gets one bounded full-model retry before persistence', async () => {
  const provider = providerFixture();
  let attempts = 0;
  const result = await runProviderManagerProbe(provider, {
    modelId: 'model-1',
    resolveRequestProfile: async (entry) => resolvedProfile(entry),
    probeProviderCapabilitiesImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        return matrix('model-1', {
          ok: false,
          capabilities: {
            responses: uncacheable('responses', 'transient', 'network'),
            chat: unsupported('chat', 'protocol-unsupported'),
            messages: unsupported('messages', 'protocol-unsupported'),
          },
          preferredProtocol: null,
        });
      }
      return matrix('model-1');
    },
  });

  assert.equal(attempts, 2);
  assert.equal(result.ok, true);
  assert.equal(result.entry.modelCapabilities[0].responses.status, 'supported');
});

test('agent-critical transient features retry at most three full-model attempts', async () => {
  const provider = providerFixture();
  let attempts = 0;
  const transientResponses = supported('responses');
  transientResponses.agentFeatures = {
    ...transientResponses.agentFeatures,
    stream: 'unknown',
    terminal: 'unknown',
    tools: 'unknown',
  };
  transientResponses.agentFeatureEvidence = {
    ...transientResponses.agentFeatureEvidence,
    stream: 'responses-stream-network',
    terminal: 'responses-stream-network',
    tools: 'responses-tool-network',
  };
  const result = await runProviderManagerProbe(provider, {
    modelId: 'model-1',
    resolveRequestProfile: async (entry) => resolvedProfile(entry),
    probeProviderCapabilitiesImpl: async () => {
      attempts += 1;
      if (attempts < 3) {
        return matrix('model-1', {
          capabilities: {
            responses: transientResponses,
            chat: unsupported('chat', 'protocol-unsupported'),
            messages: unsupported('messages', 'protocol-unsupported'),
          },
        });
      }
      return matrix('model-1');
    },
  });

  assert.equal(attempts, 3);
  assert.equal(result.ok, true);
});

test('fresh verified agent features survive a later feature-level transient probe', async () => {
  const prior = storedSupported('responses');
  prior.agentFeatures = {
    ...prior.agentFeatures,
    stream: 'supported',
    terminal: 'supported',
    tools: 'supported',
  };
  const provider = providerFixture({
    modelCapabilities: [{
      modelId: 'model-1',
      responses: prior,
      chat: unknownCapability(),
      messages: unknownCapability(),
    }],
  });
  const transientResponses = supported('responses');
  transientResponses.agentFeatures = {
    ...transientResponses.agentFeatures,
    stream: 'unknown',
    terminal: 'unknown',
    tools: 'unknown',
  };
  transientResponses.agentFeatureEvidence = {
    ...transientResponses.agentFeatureEvidence,
    stream: 'responses-stream-network',
    terminal: 'responses-stream-network',
    tools: 'responses-tool-network',
  };
  const result = await runProviderManagerProbe(provider, {
    modelId: 'model-1',
    resolveRequestProfile: async (entry) => resolvedProfile(entry),
    probeProviderCapabilitiesImpl: async () => matrix('model-1', {
      capabilities: {
        responses: transientResponses,
        chat: uncacheable('chat', 'transient', 'network'),
        messages: uncacheable('messages', 'transient', 'network'),
      },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.entry.modelCapabilities[0].responses.agentFeatures.stream, 'supported');
  assert.equal(result.entry.modelCapabilities[0].responses.agentFeatures.terminal, 'supported');
  assert.equal(result.entry.modelCapabilities[0].responses.agentFeatures.tools, 'supported');
});

test('persists only explicit stable unsupported evidence and leaves near-miss failures unknown', async () => {
  const provider = providerFixture();
  const store = fakeStore(provider);
  const result = await runProviderManagerProbe(provider, {
    store,
    modelId: 'model-1',
    resolveRequestProfile: async (entry) => resolvedProfile(entry),
    probeProviderCapabilitiesImpl: async () => matrix('model-1', {
      ok: false,
      capabilities: {
        responses: unsupported('responses', 'endpoint-unsupported'),
        chat: uncacheable('chat', 'invalid', 'invalid-schema', 'invalid'),
        messages: uncacheable('messages', 'authentication', 'authentication', 'authentication'),
      },
    }),
  });

  assert.equal(result.ok, false);
  const record = result.entry.modelCapabilities[0];
  assert.equal(record.responses.status, 'unsupported');
  assert.equal(record.responses.evidence, 'endpoint-unsupported');
  assert.equal(record.responses.validUntil, null);
  assert.equal(record.chat.status, 'unknown');
  assert.equal(record.messages.status, 'unknown');
  assert.equal(store.writes.length, 1);

  const untouchedStore = fakeStore(provider);
  const nearMiss = await runProviderManagerProbe(provider, {
    store: untouchedStore,
    modelId: 'model-1',
    resolveRequestProfile: async (entry) => resolvedProfile(entry),
    probeProviderCapabilitiesImpl: async () => matrix('model-1', {
      ok: false,
      capabilities: {
        responses: uncacheable('responses', 'transient', 'network'),
        chat: uncacheable('chat', 'invalid', 'invalid-schema', 'invalid'),
        messages: uncacheable('messages', 'authentication', 'authentication', 'authentication'),
      },
    }),
  });
  assert.deepEqual(nearMiss.entry, provider);
  assert.equal(untouchedStore.writes.length, 0);
});

test('rejects malformed agent feature maps, evidence maps, and cross-origin protocol roots', async () => {
  const provider = providerFixture();
  const malformed = [];
  const extraFeature = supported('responses');
  extraFeature.agentFeatures = { ...extraFeature.agentFeatures, extra: 'supported' };
  malformed.push(extraFeature);

  const missingEvidence = supported('responses');
  delete missingEvidence.agentFeatureEvidence.tools;
  malformed.push(missingEvidence);

  const inconsistentEvidence = supported('responses');
  inconsistentEvidence.agentFeatureEvidence.tools = 'not-probed';
  malformed.push(inconsistentEvidence);

  malformed.push(supported('responses', { apiRoot: 'https://other.example/v1' }));
  malformed.push(supported('responses', {
    schema: { nonStreaming: 'valid', evidence: 'http-200' },
  }));

  for (const responses of malformed) {
    const store = fakeStore(provider);
    const result = await runProviderManagerProbe(provider, {
      store,
      modelId: 'model-1',
      resolveRequestProfile: async (entry) => resolvedProfile(entry),
      probeProviderCapabilitiesImpl: async () => matrix('model-1', {
        capabilities: {
          responses,
          chat: uncacheable('chat', 'transient', 'network'),
          messages: uncacheable('messages', 'transient', 'network'),
        },
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'configuration');
    assert.equal(store.writes.length, 0);
  }
});

test('a changed model inventory advances its revision and makes older model records stale', async () => {
  const oldCapability = storedSupported('responses', { modelListRevision: 1 });
  const provider = providerFixture({
    modelList: {
      revision: 1,
      status: 'supported',
      apiRoot: 'https://provider.example/v1',
      auth: { scheme: 'bearer', headerName: null },
      models: [{ id: 'old-model', label: 'Old Model', metadata: metadata() }],
      checkedAt: 100,
      validUntil: 3_700_000,
      requestProfileRevision: 1,
    },
    modelCapabilities: [{
      modelId: 'old-model',
      responses: oldCapability,
      chat: unknownCapability(1),
      messages: unknownCapability(1),
    }],
  });
  const result = await runProviderManagerProbe(provider, {
    modelId: 'new-model',
    resolveRequestProfile: async (entry) => resolvedProfile(entry),
    probeProviderCapabilitiesImpl: async () => matrix('new-model', {
      modelListProbe: {
        status: 'supported',
        apiRoot: 'https://provider.example/v1',
        authScheme: 'bearer',
        models: [
          { id: 'old-model', label: 'Old Model' },
          { id: 'new-model', label: 'New Model' },
        ],
        inventory: [],
      },
    }),
  });

  assert.equal(result.entry.modelList.revision, 2);
  assert.equal(result.entry.modelCapabilities.find((entry) => entry.modelId === 'new-model')
    .responses.modelListRevision, 2);
  assert.equal(result.entry.modelCapabilities.find((entry) => entry.modelId === 'old-model')
    .responses.modelListRevision, 1);
  assert.equal(effectiveProviderCapability(result.entry, {
    modelId: 'old-model', protocol: 'responses', now: () => OBSERVED_AT,
  }), null);
});

test('without a model id, probes and persists only the v3 model inventory', async () => {
  const provider = providerFixture();
  const store = fakeStore(provider);
  let capabilityProbes = 0;
  const result = await runProviderManagerProbe(provider, {
    store,
    now: () => 2_000,
    resolveRequestProfile: async (entry) => resolvedProfile(entry),
    probeProviderModelsImpl: async ({ requestProfile }) => {
      assert.equal(requestProfile.auth.value, 'resolved-provider-secret');
      return {
        ok: true,
        status: 200,
        apiRoot: 'https://provider.example/v1',
        authScheme: 'bearer',
        models: [{ id: 'model-1', label: 'Model 1' }],
        inventory: [{ id: 'model-1', label: 'Model 1', metadata: metadata() }],
        detail: '',
      };
    },
    probeProviderCapabilitiesImpl: async () => { capabilityProbes += 1; },
  });

  assert.equal(result.ok, true);
  assert.equal(capabilityProbes, 0);
  assert.equal(result.entry.modelList.status, 'supported');
  assert.deepEqual(result.entry.modelCapabilities, []);
  assert.equal(store.writes.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /resolved-provider-secret/);
});

test('force detection without a model id fails before resolving credentials or probing', async () => {
  const provider = providerFixture();
  const store = fakeStore(provider);
  let resolves = 0;
  let modelProbes = 0;
  let capabilityProbes = 0;
  const result = await runProviderManagerProbe(provider, {
    store,
    forceDetect: true,
    resolveRequestProfile: async () => { resolves += 1; },
    probeProviderModelsImpl: async () => { modelProbes += 1; },
    probeProviderCapabilitiesImpl: async () => { capabilityProbes += 1; },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'configuration');
  assert.equal(resolves, 0);
  assert.equal(modelProbes, 0);
  assert.equal(capabilityProbes, 0);
  assert.equal(store.writes.length, 0);
});

test('rejects a capability matrix for a different model without changing the store', async () => {
  const provider = providerFixture();
  const store = fakeStore(provider);
  const result = await runProviderManagerProbe(provider, {
    store,
    modelId: 'model-a',
    resolveRequestProfile: async (entry) => resolvedProfile(entry),
    probeProviderCapabilitiesImpl: async () => matrix('model-b'),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'configuration');
  assert.equal(store.writes.length, 0);
  assert.deepEqual(store.current(), provider);
});

test('a concurrent store mutation fails CAS instead of overwriting provider state', async () => {
  const provider = providerFixture();
  const store = fakeStore(provider, 3);
  await assert.rejects(
    runProviderManagerProbe(provider, {
      store,
      modelId: 'model-1',
      resolveRequestProfile: async (entry) => resolvedProfile(entry),
      probeProviderCapabilitiesImpl: async () => {
        store.bumpRevision();
        return matrix('model-1');
      },
    }),
    (error) => error?.code === 'PROVIDER_STORE_CONFLICT',
  );
});

test('resolved credential values are confined to the probe call and never returned or persisted', async () => {
  const provider = providerFixture();
  const secret = 'credential-value-that-must-not-escape';
  const result = await runProviderManagerProbe(provider, {
    modelId: 'model-1',
    resolveRequestProfile: async (entry) => resolvedProfile(entry, secret),
    probeProviderCapabilitiesImpl: async ({ provider: adapted, resolveRequestProfile }) => {
      const profile = await resolveRequestProfile(adapted, { scope: 'model' });
      assert.equal(profile.auth.value, secret);
      assert.equal(profile.authProfileRevision, 1);
      return matrix('model-1');
    },
  });

  assert.equal(result.ok, true);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});
