import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  providerClientRouteBadge,
  providerDialectBadge,
} from '../src/lib/providerDialectBadge.js';

function providerFixture(overrides = {}) {
  return Object.assign({
    protocol: 'openai-compatible',
    baseUrl: 'https://provider.example/v1',
    authProfileRevision: 1,
    dialect: { override: null, detected: [] },
  }, overrides);
}

test('providerDialectBadge formats explicit override and detected cache sources', () => {
  const manual = providerFixture({
    dialect: {
      override: { wireApi: 'chat', source: 'manual', updatedAt: 1 },
      detected: [],
    },
  });
  assert.deepEqual(providerDialectBadge(manual, 'zh'), { label: 'chat', title: '手动设置' });

  const imported = providerFixture({
    dialect: {
      override: { wireApi: 'responses', source: 'ccswitch-import', updatedAt: 1 },
      detected: [],
    },
  });
  assert.deepEqual(providerDialectBadge(imported, 'en'), { label: 'unconfirmed', title: 'unconfirmed' });

  const importedWithDetected = providerFixture({
    dialect: {
      override: { wireApi: 'chat', source: 'ccswitch-import', updatedAt: 1 },
      detected: [{
        modelId: 'model-a',
        wireApi: 'responses',
        baseUrl: 'https://provider.example/v1',
        authProfileRevision: 1,
        detectedAt: 999,
        evidence: 'responses-success-schema',
      }],
    },
  });
  assert.deepEqual(providerDialectBadge(importedWithDetected, 'en', undefined, { modelId: 'model-a', now: () => 1000 }), {
    label: 'responses',
    title: 'auto-detected',
  });

  const detected = providerFixture({
    dialect: {
      override: null,
      detected: [{
        modelId: 'model-a',
        wireApi: 'responses',
        baseUrl: 'https://provider.example/v1',
        authProfileRevision: 1,
        detectedAt: 999,
        evidence: 'responses-success-schema',
      }],
    },
  });
  assert.deepEqual(providerDialectBadge(detected, 'zh', undefined, { modelId: 'model-a', now: () => 1000 }), {
    label: 'responses',
    title: '自动检测',
  });
});

test('providerDialectBadge shows unconfirmed for missing, stale, or mismatched detected state', () => {
  const unconfirmed = { label: 'unconfirmed', title: '未确认' };
  assert.deepEqual(providerDialectBadge(providerFixture(), 'zh'), unconfirmed);

  const stale = providerFixture({
    dialect: {
      override: null,
      detected: [{
        modelId: 'model-a',
        wireApi: 'chat',
        baseUrl: 'https://provider.example/v1',
        authProfileRevision: 1,
        detectedAt: 1,
        evidence: 'chat-success-schema',
      }],
    },
  });
  assert.deepEqual(providerDialectBadge(stale, 'zh', undefined, { modelId: 'model-a', now: () => 86_400_002 }), unconfirmed);

  const mismatched = providerFixture({
    authProfileRevision: 2,
    dialect: stale.dialect,
  });
  assert.deepEqual(providerDialectBadge(mismatched, 'en', undefined, { modelId: 'model-a', now: () => 2 }), {
    label: 'unconfirmed',
    title: 'unconfirmed',
  });
});

test('providerDialectBadge reports the selected model in a mixed provider', () => {
  const mixed = providerFixture({
    dialect: {
      override: null,
      detected: [
        {
          modelId: 'model-a',
          wireApi: 'responses',
          baseUrl: 'https://provider.example/v1',
          authProfileRevision: 1,
          detectedAt: 10,
          evidence: 'responses-success-schema',
        },
        {
          modelId: 'model-b',
          wireApi: 'chat',
          baseUrl: 'https://provider.example/v1',
          authProfileRevision: 1,
          detectedAt: 10,
          evidence: 'chat-success-schema',
        },
      ],
    },
  });

  assert.equal(providerDialectBadge(mixed, 'en', undefined, { modelId: 'model-a', now: () => 11 }).label, 'responses');
  assert.equal(providerDialectBadge(mixed, 'en', undefined, { modelId: 'model-b', now: () => 11 }).label, 'chat');
  assert.equal(providerDialectBadge(mixed, 'en', undefined, { modelId: 'model-c', now: () => 11 }).label, 'unconfirmed');
});

test('providerDialectBadge omits non-OpenAI-compatible providers', () => {
  assert.equal(providerDialectBadge(providerFixture({ protocol: 'anthropic' })), null);
});

const CREDENTIAL_ID = '5eb75f05-5d9e-5d9c-85af-f0893e8b90c2';

function agentFeatures(status) {
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

function capability(protocol, status = 'supported') {
  if (status === 'unknown') {
    return {
      status,
      apiRoot: null,
      auth: null,
      compatibility: null,
      agentFeatures: agentFeatures('unknown'),
      checkedAt: 0,
      validUntil: 0,
      requestProfileRevision: 1,
      modelListRevision: 1,
      evidence: null,
    };
  }
  if (status === 'unsupported') {
    return {
      status,
      apiRoot: 'https://provider.example/v1',
      auth: { scheme: 'bearer', headerName: null },
      compatibility: null,
      agentFeatures: agentFeatures('unsupported'),
      checkedAt: 100,
      validUntil: null,
      requestProfileRevision: 1,
      modelListRevision: 1,
      evidence: 'model-protocol-unsupported',
    };
  }
  const protocolShape = {
    responses: {
      compatibility: { instructionMode: 'responses-instructions', tokenField: 'max_output_tokens' },
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
  }[protocol];
  return {
    status,
    apiRoot: 'https://provider.example/v1',
    auth: { scheme: 'bearer', headerName: null },
    ...protocolShape,
    agentFeatures: agentFeatures('supported'),
    checkedAt: 100,
    validUntil: 10_000,
    requestProfileRevision: 1,
    modelListRevision: 1,
  };
}

function v3Provider({
  responses = capability('responses'),
  chat = capability('chat'),
  messages = capability('messages'),
} = {}) {
  return {
    id: 'universal',
    credentialId: CREDENTIAL_ID,
    name: 'Universal',
    baseUrl: 'https://provider.example/root',
    allowInsecureHttp: false,
    requestProfileRevision: 1,
    credential: {
      valueRef: {
        kind: 'secret',
        reference: `aemcp-secret://provider/${CREDENTIAL_ID}/auth-model/v1`,
        revision: 1,
      },
      preferredAuth: { scheme: 'auto', headerName: null },
    },
    probeAuthOverride: null,
    headers: [],
    probePreference: null,
    modelList: {
      revision: 1,
      status: 'supported',
      apiRoot: 'https://provider.example/v1',
      auth: { scheme: 'bearer', headerName: null },
      models: [{
        id: 'model-a',
        label: 'Model A',
        metadata: { task: null, inputModalities: [], outputModalities: ['text'], capabilities: [] },
      }],
      checkedAt: 100,
      validUntil: 10_000,
      requestProfileRevision: 1,
    },
    modelCapabilities: [{ modelId: 'model-a', responses, chat, messages }],
    routeOverrides: [],
  };
}

test('providerClientRouteBadge shows per-model native and conversion routes for both clients', () => {
  const native = v3Provider();
  assert.deepEqual(providerClientRouteBadge(native, {
    client: 'codex', modelId: 'model-a', lang: 'zh', now: 200,
  }), {
    label: 'Codex · Responses 直连',
    title: 'model-a 的当前选路',
    status: 'neutral',
  });
  assert.equal(providerClientRouteBadge(native, {
    client: 'claude-code', modelId: 'model-a', lang: 'en', now: 200,
  }).label, 'Claude · Messages direct');

  const chatOnly = v3Provider({
    responses: capability('responses', 'unsupported'),
    messages: capability('messages', 'unsupported'),
  });
  assert.equal(providerClientRouteBadge(chatOnly, {
    client: 'codex', modelId: 'model-a', lang: 'zh', now: 200,
  }).label, 'Codex · Chat 转换');
  assert.equal(providerClientRouteBadge(chatOnly, {
    client: 'claude-code', modelId: 'model-a', lang: 'zh', now: 200,
  }).label, 'Claude · Chat 转换');
});

test('providerClientRouteBadge uses a verified lower-priority route before probe-required', () => {
  const provider = v3Provider({ responses: capability('responses', 'unknown') });
  assert.deepEqual(providerClientRouteBadge(provider, {
    client: 'codex', modelId: 'model-a', lang: 'zh', now: 200,
  }), {
    label: 'Codex · Chat 转换',
    title: 'model-a 的当前选路',
    status: 'neutral',
  });
});

test('providerClientRouteBadge reports probe-required when no verified route is ready', () => {
  const provider = v3Provider({
    responses: capability('responses', 'unknown'),
    chat: capability('chat', 'unsupported'),
    messages: capability('messages', 'unsupported'),
  });
  assert.deepEqual(providerClientRouteBadge(provider, {
    client: 'codex', modelId: 'model-a', lang: 'zh', now: 200,
  }), {
    label: 'Codex · 需探测',
    title: '需先探测 model-a 的协议与 Agent 特性。',
    status: 'warn',
  });
});
