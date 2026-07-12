import test from 'node:test';
import assert from 'node:assert/strict';

import {
  providerRouteLabel,
  selectProviderRoute,
} from '../src/lib/providerRouteSelection.js';

const CREDENTIAL_ID = '5eb75f05-5d9e-5d9c-85af-f0893e8b90c2';
const CHECKED_AT = 1_000;
const NOW = 2_000;
const VALID_UNTIL = 10_000;

function secretRef(slot = 'auth-model') {
  return {
    kind: 'secret',
    reference: `aemcp-secret://provider/${CREDENTIAL_ID}/${slot}/v1`,
    revision: 1,
  };
}

function agentFeatures(status = 'supported', overrides = {}) {
  return {
    compact: status,
    continuation: status,
    countTokens: status,
    namespaceTools: status,
    reasoningReplay: status,
    stream: status,
    terminal: status,
    tools: status,
    ...overrides,
  };
}

function unknownCapability(overrides = {}) {
  return {
    status: 'unknown',
    apiRoot: null,
    auth: null,
    compatibility: null,
    agentFeatures: agentFeatures('unknown'),
    checkedAt: 0,
    validUntil: 0,
    requestProfileRevision: 1,
    modelListRevision: 1,
    evidence: null,
    ...overrides,
  };
}

function supportedCapability(protocol, overrides = {}) {
  const protocolFields = {
    responses: {
      compatibility: {
        instructionMode: 'responses-instructions',
        tokenField: 'max_output_tokens',
      },
      evidence: 'responses-success-schema',
    },
    chat: {
      compatibility: { instructionMode: 'chat-system', tokenField: 'max_tokens' },
      evidence: 'chat-success-schema',
    },
    messages: {
      compatibility: { instructionMode: 'messages-system', tokenField: 'max_tokens' },
      evidence: 'messages-success-schema',
    },
  };
  return {
    status: 'supported',
    apiRoot: 'https://provider.example/v1',
    auth: { scheme: 'bearer', headerName: null },
    ...protocolFields[protocol],
    agentFeatures: agentFeatures(),
    checkedAt: CHECKED_AT,
    validUntil: VALID_UNTIL,
    requestProfileRevision: 1,
    modelListRevision: 1,
    ...overrides,
  };
}

function unsupportedCapability(overrides = {}) {
  return {
    status: 'unsupported',
    apiRoot: 'https://provider.example/v1',
    auth: { scheme: 'bearer', headerName: null },
    compatibility: null,
    agentFeatures: agentFeatures('unsupported'),
    checkedAt: CHECKED_AT,
    validUntil: null,
    requestProfileRevision: 1,
    modelListRevision: 1,
    evidence: 'model-protocol-unsupported',
    ...overrides,
  };
}

function providerFixture({
  responses = supportedCapability('responses'),
  chat = supportedCapability('chat'),
  messages = supportedCapability('messages'),
  routeOverrides = [],
  headers = [],
} = {}) {
  return {
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
    headers,
    probePreference: null,
    modelList: {
      revision: 1,
      status: 'supported',
      apiRoot: 'https://provider.example/v1',
      auth: { scheme: 'bearer', headerName: null },
      models: [{
        id: 'model-a',
        label: 'Model A',
        metadata: {
          task: null,
          inputModalities: [],
          outputModalities: ['text'],
          capabilities: [],
        },
      }],
      checkedAt: CHECKED_AT,
      validUntil: VALID_UNTIL,
      requestProfileRevision: 1,
    },
    modelCapabilities: [{ modelId: 'model-a', responses, chat, messages }],
    routeOverrides,
  };
}

function select(provider, options = {}) {
  return selectProviderRoute(provider, {
    client: 'codex',
    modelId: 'model-a',
    feature: 'generate',
    now: NOW,
    ...options,
  });
}

test('selects native client protocols before conversion routes', () => {
  const provider = providerFixture();
  const codex = select(provider);
  assert.deepEqual(codex, {
    ok: true,
    upstreamProtocol: 'responses',
    clientProtocol: 'responses',
    conversion: 'native',
    apiRoot: 'https://provider.example/v1',
    auth: { scheme: 'bearer', headerName: null },
    compatibility: {
      instructionMode: 'responses-instructions',
      tokenField: 'max_output_tokens',
    },
    features: {
      generate: 'supported',
      compact: 'supported',
      continuation: 'supported',
      countTokens: 'supported',
      namespaceTools: 'supported',
      reasoningReplay: 'supported',
      stream: 'supported',
      terminal: 'supported',
      tools: 'supported',
    },
    reasonCode: 'selected',
  });

  const claude = select(provider, { client: 'claude-code' });
  assert.equal(claude.upstreamProtocol, 'messages');
  assert.equal(claude.clientProtocol, 'messages');
  assert.equal(claude.conversion, 'native');
});

test('uses the client-specific automatic fallback order only after explicit unsupported results', () => {
  const codex = select(providerFixture({
    responses: unsupportedCapability(),
  }));
  assert.equal(codex.ok, true);
  assert.equal(codex.upstreamProtocol, 'chat');
  assert.equal(codex.conversion, 'responses-to-chat');

  const claude = select(providerFixture({
    messages: unsupportedCapability(),
  }), { client: 'claude-code' });
  assert.equal(claude.ok, true);
  assert.equal(claude.upstreamProtocol, 'responses');
  assert.equal(claude.conversion, 'messages-to-responses');
});

test('uses a verified lower-priority route while retaining needs-probe when none is ready', () => {
  const unknown = select(providerFixture({ responses: unknownCapability() }));
  assert.equal(unknown.ok, true);
  assert.equal(unknown.upstreamProtocol, 'chat');
  assert.equal(unknown.conversion, 'responses-to-chat');

  const stale = select(providerFixture({
    responses: supportedCapability('responses', { validUntil: NOW - 1 }),
  }));
  assert.equal(stale.ok, true);
  assert.equal(stale.upstreamProtocol, 'chat');

  const allPending = select(providerFixture({
    responses: unknownCapability(),
    chat: unknownCapability(),
    messages: unsupportedCapability(),
  }));
  assert.equal(allPending.ok, false);
  assert.equal(allPending.upstreamProtocol, 'responses');
  assert.equal(allPending.reasonCode, 'needs-probe');
  assert.equal(allPending.apiRoot, null);
  assert.equal(allPending.auth, null);
});

test('honors a model override and never silently substitutes it', () => {
  const routeOverrides = [{
    client: 'codex',
    modelId: 'model-a',
    protocol: 'chat',
    updatedAt: CHECKED_AT,
  }];
  const selected = select(providerFixture({ routeOverrides }));
  assert.equal(selected.ok, true);
  assert.equal(selected.upstreamProtocol, 'chat');
  assert.equal(selected.conversion, 'responses-to-chat');
  assert.equal(selected.reasonCode, 'override-selected');

  const unavailable = select(providerFixture({
    chat: unsupportedCapability(),
    routeOverrides,
  }));
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.upstreamProtocol, 'chat');
  assert.equal(unavailable.reasonCode, 'unavailable');

  const needsProbe = select(providerFixture({
    chat: unknownCapability(),
    routeOverrides,
  }));
  assert.equal(needsProbe.ok, false);
  assert.equal(needsProbe.upstreamProtocol, 'chat');
  assert.equal(needsProbe.reasonCode, 'needs-probe');
});

test('requires nonstream schema, streaming, tools, and a legal terminal for agent-ready generation', () => {
  const fallback = select(providerFixture({
    responses: supportedCapability('responses', {
      agentFeatures: agentFeatures('supported', { terminal: 'unsupported' }),
    }),
  }));
  assert.equal(fallback.ok, true);
  assert.equal(fallback.upstreamProtocol, 'chat');

  const unknown = select(providerFixture({
    responses: supportedCapability('responses', {
      agentFeatures: agentFeatures('supported', { tools: 'unknown' }),
    }),
  }));
  assert.equal(unknown.ok, true);
  assert.equal(unknown.upstreamProtocol, 'chat');

  const nonAgentRoute = select(providerFixture({
    responses: supportedCapability('responses', {
      agentFeatures: agentFeatures('unknown'),
    }),
  }), { requireAgentReady: false });
  assert.equal(nonAgentRoute.ok, true);
  assert.equal(nonAgentRoute.upstreamProtocol, 'responses');
});

test('checks compact and countTokens only on their native client protocols', () => {
  const provider = providerFixture();
  const compact = select(provider, { feature: 'compact' });
  assert.equal(compact.ok, true);
  assert.equal(compact.upstreamProtocol, 'responses');
  assert.equal(compact.features.compact, 'supported');

  const countTokens = select(provider, {
    client: 'claude-code',
    feature: 'countTokens',
  });
  assert.equal(countTokens.ok, true);
  assert.equal(countTokens.upstreamProtocol, 'messages');
  assert.equal(countTokens.features.countTokens, 'supported');

  const unknown = select(providerFixture({
    responses: supportedCapability('responses', {
      agentFeatures: agentFeatures('supported', { compact: 'unknown' }),
    }),
  }), { feature: 'compact' });
  assert.equal(unknown.reasonCode, 'needs-probe');

  const unsupported = select(providerFixture({
    responses: supportedCapability('responses', {
      agentFeatures: agentFeatures('supported', { compact: 'unsupported' }),
    }),
  }), { feature: 'compact' });
  assert.equal(unsupported.reasonCode, 'unavailable');

  assert.equal(select(provider, {
    client: 'claude-code',
    feature: 'compact',
  }).reasonCode, 'unavailable');
  assert.equal(select(provider, { feature: 'countTokens' }).reasonCode, 'unavailable');
});

test('a non-native feature override is unavailable without an automatic fallback', () => {
  const route = select(providerFixture({
    routeOverrides: [{
      client: 'codex',
      modelId: 'model-a',
      protocol: 'chat',
      updatedAt: CHECKED_AT,
    }],
  }), { feature: 'compact' });
  assert.equal(route.ok, false);
  assert.equal(route.upstreamProtocol, 'chat');
  assert.equal(route.reasonCode, 'unavailable');
});

test('returns structured validation failures and never exposes secret references', () => {
  assert.equal(select({}, {}).reasonCode, 'invalid-provider');
  assert.equal(select(providerFixture(), { client: 'unknown' }).reasonCode, 'invalid-request');
  assert.equal(select(providerFixture(), { modelId: ' ' }).reasonCode, 'invalid-request');
  assert.equal(select(providerFixture(), { feature: 'video' }).reasonCode, 'invalid-request');
  assert.equal(select(providerFixture(), { now: () => { throw new Error('clock'); } }).reasonCode,
    'invalid-request');

  const route = select(providerFixture({
    headers: [{
      id: 'secret-header',
      name: 'x-provider-token',
      scopes: ['model'],
      valueRef: secretRef('header-secret'),
    }],
  }));
  const serialized = JSON.stringify(route);
  assert.doesNotMatch(serialized, /aemcp-secret|header-secret|auth-model|credential/i);
});

test('route labels describe only the selected protocol and conversion mode', () => {
  const native = select(providerFixture());
  const converted = select(providerFixture({ responses: unsupportedCapability() }));
  assert.equal(providerRouteLabel(native), 'Responses 直连');
  assert.equal(providerRouteLabel(converted), 'Chat 转换');
  assert.equal(providerRouteLabel(converted, 'en'), 'Chat conversion');
  assert.equal(providerRouteLabel({ ...native, ok: false }), null);
});
