import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProviderAcceptanceBridge } from '../src/cep/providerAcceptanceBridge.js';

const UPSTREAM_SECRET = 'sk-upstream-must-never-leave-cep';
const SECRET_REFERENCE = 'aemcp-secret://provider/credential-id/auth-model/v1';
const UPSTREAM_ROOT = 'https://private-provider.example/internal/v1';

function features(status = 'supported') {
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

function capability(status, protocol, modelListRevision = 7) {
  return {
    status,
    apiRoot: UPSTREAM_ROOT,
    auth: { scheme: 'bearer', headerName: null, value: UPSTREAM_SECRET },
    compatibility: { instructionMode: `${protocol}-private`, tokenField: 'max_tokens' },
    agentFeatures: features(status === 'supported' ? 'supported' : 'unknown'),
    checkedAt: 100,
    validUntil: 10_000,
    requestProfileRevision: 3,
    modelListRevision,
    evidence: `${protocol}-${UPSTREAM_SECRET}`,
  };
}

function providerFixture(overrides = {}) {
  return {
    id: 'provider-1',
    credentialId: 'credential-id',
    name: 'Private Provider',
    baseUrl: UPSTREAM_ROOT,
    allowInsecureHttp: false,
    requestProfileRevision: 3,
    credential: {
      valueRef: { kind: 'secret', reference: SECRET_REFERENCE, revision: 4 },
      preferredAuth: { scheme: 'bearer', headerName: null },
    },
    probeAuthOverride: null,
    headers: [{
      name: 'x-private',
      scopes: ['model'],
      valueRef: { kind: 'literal', value: UPSTREAM_SECRET },
    }],
    modelList: {
      revision: 7,
      status: 'supported',
      apiRoot: UPSTREAM_ROOT,
      auth: { scheme: 'bearer', headerName: null },
      models: [{ id: 'model-a', label: 'Model A' }, { id: 'model-b', label: 'Model B' }],
      checkedAt: 100,
      validUntil: 10_000,
      requestProfileRevision: 3,
    },
    modelCapabilities: [{
      modelId: 'model-a',
      responses: capability('supported', 'responses'),
      chat: capability('unknown', 'chat'),
      messages: capability('unsupported', 'messages'),
    }],
    routeOverrides: [{ client: 'codex', modelId: 'model-a', protocol: 'responses' }],
    ...overrides,
  };
}

function fakeStore(initialProvider, initialRevision = 5) {
  let provider = initialProvider;
  let revision = initialRevision;
  const writes = [];
  return {
    writes,
    list: () => [provider],
    get: (id) => (id === provider.id ? provider : null),
    readState: () => ({ revision, providers: [provider], hidden: UPSTREAM_SECRET }),
    upsert(entry, { expectedRevision } = {}) {
      assert.equal(expectedRevision, revision);
      writes.push({ expectedRevision, entry });
      provider = entry;
      revision += 1;
      return { entry, stateRevision: revision };
    },
  };
}

function routeSelection(_provider, { client }) {
  const clientProtocol = client === 'codex' ? 'responses' : 'messages';
  const upstreamProtocol = client === 'codex' ? 'responses' : 'chat';
  return {
    ok: true,
    clientProtocol,
    upstreamProtocol,
    conversion: clientProtocol === upstreamProtocol
      ? 'native'
      : `${clientProtocol}-to-${upstreamProtocol}`,
    apiRoot: UPSTREAM_ROOT,
    auth: { scheme: 'bearer', value: UPSTREAM_SECRET },
    compatibility: { private: UPSTREAM_SECRET },
    features: features(),
    reasonCode: 'selected',
  };
}

function bridgeDeps(overrides = {}) {
  const store = overrides.store || fakeStore(providerFixture());
  return {
    store,
    secretService: { resolve: async () => UPSTREAM_SECRET },
    runProviderManagerProbe: async () => ({ ok: false, reason: 'configuration' }),
    createUniversalProviderRoute: () => ({
      start: async () => ({
        origin: 'http://127.0.0.1:32123',
        openaiBaseUrl: 'http://127.0.0.1:32123/v1',
        anthropicBaseUrl: 'http://127.0.0.1:32123',
        routeToken: 'route-token-1234567890',
      }),
      close: async () => {},
    }),
    selectProviderRoute: routeSelection,
    resolveProviderRequestProfile: async () => ({
      baseUrl: UPSTREAM_ROOT,
      auth: { kind: 'header', name: 'authorization', value: `Bearer ${UPSTREAM_SECRET}` },
    }),
    onProvidersChanged: () => {},
    ...overrides,
  };
}

function assertNoUpstreamMaterial(value) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /sk-upstream-must-never-leave-cep/);
  assert.doesNotMatch(serialized, /aemcp-secret:\/\/provider/);
  assert.doesNotMatch(serialized, /private-provider\.example/);
  assert.doesNotMatch(serialized, /"(?:apiRoot|auth|baseUrl|credential|headers|reference)"/);
}

test('snapshot exposes only Provider identity, revisions, model ids, and capability statuses', () => {
  const bridge = createProviderAcceptanceBridge(bridgeDeps());
  const result = bridge.snapshot();

  assert.equal(result.revision, 5);
  assert.deepEqual(result.providers[0].revisions, { requestProfile: 3, modelList: 7 });
  assert.deepEqual(result.providers[0].modelIds, ['model-a', 'model-b']);
  assert.equal(result.providers[0].capabilities[0].responses.status, 'supported');
  assert.equal(result.providers[0].capabilities[0].messages.status, 'unsupported');
  assert.equal(result.providers[0].capabilities[0].responses.agentFeatures.tools, 'supported');
  assertNoUpstreamMaterial(result);
});

test('routes returns current per-model client selections without probing or resolving credentials', () => {
  const selected = [];
  let profileCalls = 0;
  const bridge = createProviderAcceptanceBridge(bridgeDeps({
    selectProviderRoute(provider, details) {
      selected.push({ provider, details });
      return routeSelection(provider, details);
    },
    resolveProviderRequestProfile: async () => {
      profileCalls += 1;
      throw new Error('must not resolve credentials');
    },
  }));

  const result = bridge.routes('provider-1', ['model-a', 'model-b', 'model-a']);

  assert.deepEqual(result.results.map((entry) => entry.modelId), ['model-a', 'model-b']);
  assert.deepEqual(result.results.map((entry) => entry.routes.codex.upstreamProtocol), [
    'responses',
    'responses',
  ]);
  assert.deepEqual(result.results.map((entry) => entry.routes.claude.conversion), [
    'messages-to-chat',
    'messages-to-chat',
  ]);
  assert.deepEqual(selected.map(({ details }) => details.client), [
    'codex', 'claude-code', 'codex', 'claude-code',
  ]);
  assert.equal(profileCalls, 0);
  assertNoUpstreamMaterial(result);
});

test('probeAll runs models sequentially, lets the manager persist by CAS, and returns sanitized dual-client routes', async () => {
  const store = fakeStore(providerFixture());
  const order = [];
  const observedRevisions = [];
  const priorModels = [];
  const resolverCalls = [];
  const notifications = [];
  let active = 0;
  let maxActive = 0;
  const bridge = createProviderAcceptanceBridge(bridgeDeps({
    store,
    async runProviderManagerProbe(provider, options) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(options.modelId);
      observedRevisions.push(options.store.readState().revision);
      priorModels.push(provider.modelCapabilities.map((entry) => entry.modelId));
      const profile = await options.resolveRequestProfile(provider, {
        scope: 'model',
        modelId: options.modelId,
        protocol: 'responses',
      });
      assert.equal(profile.auth.value, UPSTREAM_SECRET);
      await new Promise((resolve) => setTimeout(resolve, 2));
      const expectedRevision = options.store.readState().revision;
      const modelCapabilities = [
        ...provider.modelCapabilities.filter((entry) => entry.modelId !== options.modelId),
        {
          modelId: options.modelId,
          responses: capability('supported', 'responses'),
          chat: capability('supported', 'chat'),
          messages: capability('supported', 'messages'),
        },
      ];
      const persisted = options.store.upsert(
        { ...provider, modelCapabilities },
        { expectedRevision },
      );
      active -= 1;
      return {
        ok: true,
        entry: persisted.entry,
        stateRevision: persisted.stateRevision,
        preferredProtocol: 'responses',
        result: { secret: UPSTREAM_SECRET, apiRoot: UPSTREAM_ROOT },
      };
    },
    async resolveProviderRequestProfile(provider, details) {
      resolverCalls.push({ provider, details });
      assert.equal(details.secretService.resolve instanceof Function, true);
      return { auth: { value: await details.secretService.resolve(provider.credential.valueRef) } };
    },
    onProvidersChanged(value) { notifications.push(value); },
  }));

  const result = await bridge.probeAll('provider-1', ['model-a', 'model-b', 'model-a']);

  assert.deepEqual(order, ['model-a', 'model-b']);
  assert.deepEqual(observedRevisions, [5, 6]);
  assert.deepEqual(priorModels[1].sort(), ['model-a']);
  assert.equal(maxActive, 1);
  assert.equal(store.writes.length, 2);
  assert.deepEqual(store.writes.map((write) => write.expectedRevision), [5, 6]);
  assert.equal(resolverCalls.length, 2);
  assert.equal(notifications.length, 1);
  assert.equal(result.storeRevision, 7);
  assert.equal(result.results[0].routes.codex.upstreamProtocol, 'responses');
  assert.equal(result.results[0].routes.claude.upstreamProtocol, 'chat');
  assert.equal(result.results[0].routes.claude.conversion, 'messages-to-chat');
  assertNoUpstreamMaterial(result);
  assertNoUpstreamMaterial(notifications[0]);
});

test('startRoute maps Responses to Codex and Messages to Claude while keeping request credentials internal', async () => {
  const selected = [];
  const profileCalls = [];
  let routeOptions;
  let closeCount = 0;
  const bridge = createProviderAcceptanceBridge(bridgeDeps({
    selectProviderRoute(provider, details) {
      selected.push({ provider, details });
      return routeSelection(provider, details);
    },
    async resolveProviderRequestProfile(provider, details) {
      profileCalls.push({ provider, details });
      return {
        baseUrl: UPSTREAM_ROOT,
        auth: { value: await details.secretService.resolve(provider.credential.valueRef) },
      };
    },
    createUniversalProviderRoute(options) {
      routeOptions = options;
      return {
        async start() {
          return {
            origin: 'http://127.0.0.1:32123',
            openaiBaseUrl: 'http://127.0.0.1:32123/v1',
            anthropicBaseUrl: 'http://127.0.0.1:32123',
            routeToken: 'route-token-1234567890',
            baseUrl: UPSTREAM_ROOT,
            upstreamSecret: UPSTREAM_SECRET,
          };
        },
        async close() { closeCount += 1; },
      };
    },
  }));

  const local = await bridge.startRoute('provider-1');
  assert.deepEqual(Object.keys(local).sort(), [
    'anthropicBaseUrl',
    'openaiBaseUrl',
    'origin',
    'routeToken',
  ]);
  assertNoUpstreamMaterial(local);

  const codex = await routeOptions.resolveCapability({
    modelId: 'model-a', clientProtocol: 'responses', feature: 'generate',
  });
  const claude = await routeOptions.resolveCapability({
    modelId: 'model-a', clientProtocol: 'messages', feature: 'generate',
  });
  const invalid = await routeOptions.resolveCapability({
    modelId: 'model-a', clientProtocol: 'chat', feature: 'generate',
  });
  assert.equal(codex.apiRoot, UPSTREAM_ROOT);
  assert.equal(claude.apiRoot, UPSTREAM_ROOT);
  assert.equal(invalid.ok, false);
  assert.deepEqual(selected.map(({ details }) => details.client), ['codex', 'claude-code']);

  const internalProfile = await routeOptions.resolveRequestProfile(providerFixture(), {
    scope: 'model', modelId: 'model-a', protocol: 'responses',
  });
  assert.equal(internalProfile.auth.value, UPSTREAM_SECRET);
  assert.equal(profileCalls[0].details.secretService.resolve instanceof Function, true);

  assert.deepEqual(await bridge.stopRoute(), { stopped: true, providerId: 'provider-1' });
  assert.equal(closeCount, 1);
});

test('route replacement, stop, and dispose close every local listener exactly once', async () => {
  const closes = [];
  let sequence = 0;
  const bridge = createProviderAcceptanceBridge(bridgeDeps({
    createUniversalProviderRoute() {
      const id = sequence += 1;
      return {
        start: async () => ({
          origin: `http://127.0.0.1:${32120 + id}`,
          openaiBaseUrl: `http://127.0.0.1:${32120 + id}/v1`,
          anthropicBaseUrl: `http://127.0.0.1:${32120 + id}`,
          routeToken: `route-token-${id}-1234567890`,
        }),
        close: async () => { closes.push(id); },
      };
    },
  }));

  await bridge.startRoute('provider-1');
  await bridge.startRoute('provider-1');
  assert.deepEqual(closes, [1]);
  assert.deepEqual(await bridge.stopRoute(), { stopped: true, providerId: 'provider-1' });
  assert.deepEqual(await bridge.stopRoute(), { stopped: false, providerId: null });
  await bridge.startRoute('provider-1');
  const disposing = bridge.dispose();
  assert.strictEqual(bridge.dispose(), disposing);
  assert.deepEqual(await disposing, { disposed: true });
  assert.deepEqual(closes, [1, 2, 3]);
  await assert.rejects(
    bridge.startRoute('provider-1'),
    { code: 'PROVIDER_ACCEPTANCE_BRIDGE_DISPOSED' },
  );
});

test('dependency failures are compact and never echo upstream credentials', async () => {
  const bridge = createProviderAcceptanceBridge(bridgeDeps({
    createUniversalProviderRoute: () => ({
      start: async () => { throw new Error(`${UPSTREAM_SECRET} ${UPSTREAM_ROOT}`); },
      close: async () => { throw new Error(UPSTREAM_SECRET); },
    }),
  }));

  await assert.rejects(bridge.startRoute('provider-1'), (error) => {
    assert.equal(error.code, 'PROVIDER_ACCEPTANCE_ROUTE_FAILED');
    assertNoUpstreamMaterial({ message: error.message });
    return true;
  });
});
