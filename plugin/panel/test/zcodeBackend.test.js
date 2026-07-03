import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createZcodeBackend, zcodeModelFromDesktopConfig, zcodeRuntimeModelFromDesktopConfig } from '../src/cep/zcodeBackend.js';
import { zcodeStaticDescriptor, zcodeDescriptorFromModels } from '../src/lib/backendCapabilities.js';

// --- harness (mirrors codexBackend.test.js shape, adapted to ZCode protocol) ---

function makeProc() {
  const stdoutHandlers = [];
  const stderrHandlers = [];
  const exitHandlers = [];
  const errorHandlers = [];
  const writes = [];
  let killed = false;
  return {
    writes,
    get killed() { return killed; },
    stdin: { write(line) { writes.push(line); } },
    stdout: { on(event, handler) { if (event === 'data') stdoutHandlers.push(handler); } },
    stderr: { on(event, handler) { if (event === 'data') stderrHandlers.push(handler); } },
    on(event, handler) {
      if (event === 'exit') exitHandlers.push(handler);
      if (event === 'error') errorHandlers.push(handler);
    },
    kill() { killed = true; },
    pushStdout(message) {
      const line = typeof message === 'string' ? message : JSON.stringify(message) + '\n';
      for (const handler of stdoutHandlers) handler(line);
    },
    exit(code = 0, signal = null) { for (const h of exitHandlers) h(code, signal); },
    error(error) { for (const h of errorHandlers) h(error); },
  };
}

function makeSpawn() {
  const calls = [];
  const procs = [];
  function spawn(command, args, options) {
    const proc = makeProc();
    calls.push({ command, args, options, proc });
    procs.push(proc);
    return proc;
  }
  return { spawn, calls, procs };
}

function parseWrites(proc) {
  return proc.writes.map((line) => JSON.parse(line));
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// Respond to a ZCode request (no jsonrpc field — the protocol is stripped).
function respond(proc, request, result = {}) {
  proc.pushStdout({ id: request.id, result });
}

function reject(proc, request, message = 'ZCode request failed') {
  proc.pushStdout({ id: request.id, error: { message } });
}

// Push a ZCode notification (event) with the given type/payload.
function pushEvent(proc, type, payload = {}, extra = {}) {
  proc.pushStdout({
    method: 'session/event',
    params: { type, payload, sessionId: 'sess_test', seq: extra.seq || 1, ...extra },
  });
}

const TOOL_META = {
  allowedTools: [],
  annotations: {
    mcp__ae__ae_overview: { readOnly: true, destructive: false },
    mcp__ae__ae_setProperty: { readOnly: false, destructive: false },
    mcp__ae__ae_exec: { readOnly: false, destructive: true },
  },
};

function makeBackend(options = {}) {
  const events = [];
  const spawned = makeSpawn();
  const backend = createZcodeBackend({
    spawnImpl: spawned.spawn,
    getModel: () => 'glm-5.2',
    getPermissionMode: () => 'manual',
    getToolMeta: async () => TOOL_META,
    getServerInstructions: () => '',
    onEvent: (evt) => events.push(evt),
    lang: 'en',
    env: {
      PATH: 'C:\\Node',
      TEMP: 'C:\\tmp',
      LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
      AE_MCP_PANEL_EXT_ROOT: 'C:\\Repo\\plugin\\panel',
    },
    resolveCli: async () => ({ ok: true, cliPath: 'C:\\ZCode\\zcode.cjs' }),
    resolveNode: async () => ({ ok: true, nodePath: 'C:\\Node\\node.exe', version: 'v24.0.0' }),
    ...options,
  });
  return { backend, events, spawned };
}

// Drive a full session/create + subscribe + session/send handshake.
async function startTurn(backend, spawned, text = 'hello') {
  const pending = backend.sendUser(text);
  await flush();
  const proc = spawned.procs[0];

  // 1. session/create
  const createReq = parseWrites(proc)[0];
  assert.equal(createReq.method, 'session/create');
  respond(proc, createReq, { session: { sessionId: 'sess_test' }, settings: { model: { available: [] } } });
  await flush();

  // 2. session/subscribe (now a request — respond to its ack)
  const subReq = parseWrites(proc).find((m) => m.method === 'session/subscribe');
  if (subReq) respond(proc, subReq, { sessionId: 'sess_test', eventSeq: 0 });
  await flush();

  // 3. session/send
  const sendReq = parseWrites(proc).find((m) => m.method === 'session/send');
  assert.ok(sendReq, 'session/send was sent');
  respond(proc, sendReq, { accepted: true, sessionId: 'sess_test' });
  await flush();
  return { pending, proc, createReq, sendReq };
}

// --- tests ---

test('createZcodeBackend spawns node with zcode.cjs app-server args', async () => {
  const { backend, spawned } = makeBackend();
  backend.sendUser('hello');
  await flush();

  assert.equal(spawned.calls.length, 1);
  assert.equal(spawned.calls[0].command, 'C:\\Node\\node.exe');
  assert.deepEqual(spawned.calls[0].args, ['C:\\ZCode\\zcode.cjs', 'app-server']);
  assert.equal(spawned.calls[0].options.stdio, 'pipe');
  assert.equal(spawned.calls[0].options.windowsHide, true);
});

test('createZcodeBackend passes AE_MCP_ZCODE_MODEL to ZCODE_MODEL', async () => {
  const { backend, spawned } = makeBackend({
    env: {
      PATH: 'C:\\Node',
      TEMP: 'C:\\tmp',
      LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
      AE_MCP_PANEL_EXT_ROOT: 'C:\\Repo\\plugin\\panel',
      AE_MCP_ZCODE_MODEL: 'mediastorm_glm/glm-5.2',
    },
  });
  backend.sendUser('hello');
  await flush();

  assert.equal(spawned.calls[0].options.env.ZCODE_MODEL, 'mediastorm_glm/glm-5.2');
});

test('session/create carries the selected panel model without forcing env config', async () => {
  const { backend, spawned } = makeBackend({
    getModel: () => 'builtin:bigmodel-start-plan/GLM-5.2',
  });
  backend.sendUser('hello');
  await flush();

  const createReq = parseWrites(spawned.procs[0])[0];
  assert.equal(spawned.calls[0].options.env.ZCODE_MODEL, undefined);
  assert.deepEqual(createReq.params.model, {
    providerId: 'builtin:bigmodel-start-plan',
    modelId: 'GLM-5.2',
  });
});

test('createZcodeBackend replaces the legacy bundled model with the enabled desktop provider', async () => {
  const { backend, spawned } = makeBackend({
    getModel: () => 'mediastorm_glm/glm-5.2',
    readDesktopModel: () => 'builtin:bigmodel-start-plan/GLM-5.2',
    readDesktopRuntimeModel: () => ({
      revision: 'desktop-v2',
      generatedAt: 1,
      model: { providerId: 'builtin:bigmodel-start-plan', modelId: 'GLM-5.2' },
      provider: {
        providerId: 'builtin:bigmodel-start-plan',
        kind: 'anthropic',
        apiFormat: 'anthropic-messages',
        source: 'custom',
        baseURL: 'https://zcode.z.ai/api/v1/zcode-plan/anthropic',
        apiKey: { source: 'inline', value: 'secret' },
        models: [{ modelId: 'GLM-5.2' }],
      },
    }),
  });
  backend.sendUser('hello');
  await flush();

  const createReq = parseWrites(spawned.procs[0])[0];
  assert.equal(spawned.calls[0].options.env.ZCODE_MODEL, undefined);
  assert.equal(createReq.params.runtimeModel.provider.providerId, 'builtin:bigmodel-start-plan');
  assert.equal(createReq.params.runtimeModel.provider.apiKey.source, 'inline');
  assert.deepEqual(createReq.params.model, {
    providerId: 'builtin:bigmodel-start-plan',
    modelId: 'GLM-5.2',
  });
});

test('interaction/requestProviderRuntimeHeaders reports the desktop OAuth plan bridge gap', async () => {
  const { backend, spawned } = makeBackend({
    getModel: () => 'builtin:bigmodel-start-plan/GLM-5.2',
    readDesktopRuntimeModel: () => ({
      revision: 'desktop-v2:builtin:bigmodel-start-plan',
      generatedAt: 1,
      model: { providerId: 'builtin:bigmodel-start-plan', modelId: 'GLM-5.2' },
      provider: {
        providerId: 'builtin:bigmodel-start-plan',
        kind: 'anthropic',
        apiFormat: 'anthropic-messages',
        source: 'custom',
        baseURL: 'https://zcode.z.ai/api/v1/zcode-plan/anthropic',
        models: [{ modelId: 'GLM-5.2' }],
      },
    }),
    readOAuthAccessToken: () => { throw new Error('should not decrypt desktop OAuth tokens'); },
    resolveCodingPlanApiKey: async () => { throw new Error('should not create provider API keys'); },
  });
  const { proc } = await startTurn(backend, spawned, 'hello');

  proc.pushStdout({
    id: 91,
    method: 'interaction/requestProviderRuntimeHeaders',
    params: {
      requestId: 'runtime_headers_1',
      sessionId: 'sess_test',
      workspace: { workspacePath: 'C:\\Repo\\plugin\\panel', workspaceKey: 'C:\\Repo\\plugin\\panel' },
      modelRef: { providerId: 'builtin:bigmodel-start-plan', modelId: 'GLM-5.2' },
      providerId: 'builtin:bigmodel-start-plan',
      reason: 'model-request',
    },
  });
  await flush();

  const updateReq = parseWrites(proc).find((m) => m.method === 'session/updateRuntimeModelConfig');
  assert.equal(updateReq, undefined, 'zcode-plan must not be rewritten into a fake API-key provider');
  const reply = parseWrites(proc).find((m) => m.id === 91);
  assert.equal(reply.error, undefined);
  assert.equal(reply.result.headersApplied, false);
  assert.match(reply.result.errorMessage, /desktop OAuth/i);
  assert.match(reply.result.errorMessage, /runtime headers/i);
  assert.match(reply.result.errorMessage, /captcha/i);
});

test('interaction/requestProviderRuntimeHeaders reports provider header failures without method errors', async () => {
  const { backend, spawned } = makeBackend({
    getModel: () => 'builtin:bigmodel-start-plan/GLM-5.2',
    readDesktopRuntimeModel: () => ({
      revision: 'desktop-v2:builtin:bigmodel-start-plan',
      generatedAt: 1,
      model: { providerId: 'builtin:bigmodel-start-plan', modelId: 'GLM-5.2' },
      provider: {
        providerId: 'builtin:bigmodel-start-plan',
        kind: 'anthropic',
        apiFormat: 'anthropic-messages',
        source: 'custom',
        baseURL: 'https://zcode.z.ai/api/v1/zcode-plan/anthropic',
        models: [{ modelId: 'GLM-5.2' }],
      },
    }),
    readOAuthAccessToken: () => '',
  });
  const { proc } = await startTurn(backend, spawned, 'hello');

  proc.pushStdout({
    id: 92,
    method: 'interaction/requestProviderRuntimeHeaders',
    params: {
      requestId: 'runtime_headers_2',
      sessionId: 'sess_test',
      workspace: { workspacePath: 'C:\\Repo\\plugin\\panel', workspaceKey: 'C:\\Repo\\plugin\\panel' },
      modelRef: { providerId: 'builtin:bigmodel-start-plan', modelId: 'GLM-5.2' },
      providerId: 'builtin:bigmodel-start-plan',
      reason: 'model-request',
    },
  });
  await flush();

  const reply = parseWrites(proc).find((m) => m.id === 92);
  assert.equal(reply.error, undefined);
  assert.equal(reply.result.headersApplied, false);
  assert.match(reply.result.errorMessage, /runtime headers/i);
});

test('zcodeModelFromDesktopConfig picks the enabled coding-plan provider from v2 settings', () => {
  const model = zcodeModelFromDesktopConfig({
    setting: {
      providerFamilyDomain: 'bigmodel',
      modelProviderFamilyModes: { bigmodel: 'oauth' },
    },
    config: {
      provider: {
        'builtin:bigmodel': {
          name: 'Bigmodel - API Key',
          models: { 'GLM-5.2': {} },
        },
        'builtin:bigmodel-start-plan': {
          name: 'BigModel- Coding Plan',
          enabled: true,
          options: { apiKey: 'redacted' },
          models: { 'GLM-5.2': {}, 'GLM-5-Turbo': { name: 'glm-5-turbo' } },
        },
        'builtin:zai-start-plan': {
          enabled: false,
          systemDisabledReason: 'oauth_provider_inactive',
          models: { 'GLM-5.2': {} },
        },
      },
    },
  });

  assert.equal(model, 'builtin:bigmodel-start-plan/GLM-5.2');
});

test('zcodeRuntimeModelFromDesktopConfig maps v2 provider config to a runtimeModel', () => {
  const runtimeModel = zcodeRuntimeModelFromDesktopConfig({
    modelRef: 'builtin:bigmodel-start-plan/GLM-5.2',
    setting: { providerFamilyDomain: 'bigmodel' },
    config: {
      provider: {
        'builtin:bigmodel-start-plan': {
          name: 'BigModel- Coding Plan',
          kind: 'anthropic',
          enabled: true,
          source: 'custom',
          options: {
            apiKey: 'desktop-secret',
            baseURL: 'https://zcode.z.ai/api/v1/zcode-plan/anthropic',
          },
          models: {
            'GLM-5.2': { contextWindow: 200000 },
            'GLM-5-Turbo': { name: 'glm-5-turbo', maxOutputTokens: 8192 },
          },
        },
      },
    },
  });

  assert.equal(runtimeModel.model.providerId, 'builtin:bigmodel-start-plan');
  assert.equal(runtimeModel.model.modelId, 'GLM-5.2');
  assert.equal(runtimeModel.provider.kind, 'anthropic');
  assert.equal(runtimeModel.provider.apiFormat, 'anthropic-messages');
  assert.deepEqual(runtimeModel.provider.apiKey, { source: 'inline', value: 'desktop-secret' });
  assert.deepEqual(runtimeModel.provider.models.map((m) => m.modelId), ['GLM-5.2', 'GLM-5-Turbo']);
});

test('createZcodeBackend maps AE_MCP_ZCODE_API_KEY to ZCode provider key env names', async () => {
  const { backend, spawned } = makeBackend({
    env: {
      PATH: 'C:\\Node',
      TEMP: 'C:\\tmp',
      LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
      AE_MCP_PANEL_EXT_ROOT: 'C:\\Repo\\plugin\\panel',
      AE_MCP_ZCODE_MODEL: 'mediastorm_glm/glm-5.2',
      AE_MCP_ZCODE_API_KEY: 'secret-key',
    },
  });
  backend.sendUser('hello');
  await flush();

  assert.equal(spawned.calls[0].options.env.ZCODE_API_KEY, 'secret-key');
  assert.equal(spawned.calls[0].options.env.MEDIASTORM_GLM_API_KEY, 'secret-key');
});

test('createZcodeBackend does not overwrite existing ZCode provider key env vars', async () => {
  const { backend, spawned } = makeBackend({
    env: {
      PATH: 'C:\\Node',
      TEMP: 'C:\\tmp',
      LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
      AE_MCP_PANEL_EXT_ROOT: 'C:\\Repo\\plugin\\panel',
      AE_MCP_ZCODE_MODEL: 'mediastorm_glm/glm-5.2',
      AE_MCP_ZCODE_API_KEY: 'panel-key',
      ZCODE_API_KEY: 'generic-key',
      MEDIASTORM_GLM_API_KEY: 'provider-key',
    },
  });
  backend.sendUser('hello');
  await flush();

  assert.equal(spawned.calls[0].options.env.ZCODE_API_KEY, 'generic-key');
  assert.equal(spawned.calls[0].options.env.MEDIASTORM_GLM_API_KEY, 'provider-key');
});

test('session/create is sent with a workspace object and permission mode', async () => {
  const { backend, spawned } = makeBackend();
  backend.sendUser('hello');
  await flush();
  const proc = spawned.procs[0];
  const createReq = parseWrites(proc)[0];
  assert.equal(createReq.method, 'session/create');
  assert.ok(createReq.params.workspace, 'workspace object present');
  assert.equal(typeof createReq.params.workspace.workspacePath, 'string');
  assert.equal(createReq.params.mode, 'build'); // manual tier -> build
});

test('messages omit the jsonrpc field (ZCode strict-parses and rejects it)', async () => {
  const { backend, spawned } = makeBackend();
  backend.sendUser('hello');
  await flush();
  const proc = spawned.procs[0];
  for (const line of proc.writes) {
    const msg = JSON.parse(line);
    assert.equal(msg.jsonrpc, undefined, 'no jsonrpc field on outbound messages');
  }
});

test('text-delta events flow from model.streaming notifications', async () => {
  const { backend, events, spawned } = makeBackend();
  const { proc } = await startTurn(backend, spawned, 'say PONG');
  // Stream two deltas then complete the turn.
  pushEvent(proc, 'turn.started', { turnNumber: 0 });
  pushEvent(proc, 'model.streaming', { delta: 'PON', kind: 'text_delta', done: false });
  pushEvent(proc, 'model.streaming', { delta: 'G', kind: 'text_delta', done: false });
  pushEvent(proc, 'turn.completed', { response: 'PONG', usage: { totalTokens: 10 } });
  await flush();

  const deltas = events.filter((e) => e.type === 'text-delta');
  assert.equal(deltas.length, 2);
  assert.equal(deltas[0].text, 'PON');
  assert.equal(deltas[1].text, 'G');
  assert.ok(events.some((e) => e.type === 'turn-start'));
  assert.ok(events.some((e) => e.type === 'turn-end' && e.stopReason === 'end_turn'));
});

test('turn.failed object errors keep their message and classify provider failures as model errors', async () => {
  const { backend, events, spawned } = makeBackend();
  const { proc, pending } = await startTurn(backend, spawned, 'say PONG');
  pushEvent(proc, 'turn.failed', {
    error: { message: 'Model provider is missing an API key: mediastorm_glm' },
  });
  await pending;
  await flush();

  assert.ok(events.some((e) => e.type === 'error'
    && e.kind === 'model'
    && e.message.includes('Model provider is missing an API key: mediastorm_glm')
    && e.message.includes('AE_MCP_ZCODE_API_KEY')
    && e.message.includes('MEDIASTORM_GLM_API_KEY')));
});

test('turn.failed provider authentication errors mention desktop OAuth runtime headers', async () => {
  const { backend, events, spawned } = makeBackend();
  const { proc, pending } = await startTurn(backend, spawned, 'say PONG');
  pushEvent(proc, 'turn.failed', {
    error: { message: 'Provider authentication failed.' },
  });
  await pending;
  await flush();

  assert.ok(events.some((e) => e.type === 'error'
    && e.kind === 'model'
    && e.message.includes('Provider authentication failed.')
    && /desktop OAuth/i.test(e.message)
    && /runtime headers/i.test(e.message)));
});

test('turn.failed model request errors mention desktop OAuth runtime headers for zcode-plan', async () => {
  const { backend, events, spawned } = makeBackend({
    getModel: () => 'builtin:bigmodel-start-plan/GLM-5.2',
    readDesktopRuntimeModel: () => ({
      revision: 'desktop-v2:builtin:bigmodel-start-plan',
      generatedAt: 1,
      model: { providerId: 'builtin:bigmodel-start-plan', modelId: 'GLM-5.2' },
      provider: {
        providerId: 'builtin:bigmodel-start-plan',
        kind: 'anthropic',
        apiFormat: 'anthropic-messages',
        source: 'custom',
        baseURL: 'https://zcode.z.ai/api/v1/zcode-plan/anthropic',
        models: [{ modelId: 'GLM-5.2' }],
      },
    }),
  });
  const { proc, pending } = await startTurn(backend, spawned, 'say PONG');
  pushEvent(proc, 'turn.failed', {
    error: { message: 'Model request failed.' },
  });
  await pending;
  await flush();

  assert.ok(events.some((e) => e.type === 'error'
    && e.kind === 'model'
    && e.message.includes('Model request failed.')
    && /desktop OAuth/i.test(e.message)
    && /runtime headers/i.test(e.message)));
});

test('manual tier emits approval-required for a non-read-only tool', async () => {
  const { backend, events, spawned } = makeBackend({ getPermissionMode: () => 'manual' });
  const { proc } = await startTurn(backend, spawned, 'set a property');
  pushEvent(proc, 'permission.requested', {
    toolCallId: 'tc_1',
    toolName: 'ae_setProperty',
    riskLevel: 'medium',
    input: { layerId: 1 },
    requestId: 'r1',
  });
  await flush();

  const approval = events.find((e) => e.type === 'approval-required');
  assert.ok(approval, 'approval-required emitted');
  assert.equal(approval.toolUseId, 'tc_1');
  assert.equal(approval.name, 'mcp__ae__ae_setProperty');
  assert.equal(approval.risk, 'write');
});

test('readonly tier auto-denies a tool', async () => {
  const { backend, events, spawned } = makeBackend({ getPermissionMode: () => 'readonly' });
  const { proc } = await startTurn(backend, spawned, 'set a property');
  pushEvent(proc, 'permission.requested', {
    toolCallId: 'tc_2',
    toolName: 'ae_setProperty',
    riskLevel: 'medium',
    input: {},
    requestId: 'r2',
  });
  await flush();
  assert.ok(events.some((e) => e.type === 'tool-denied' && e.toolUseId === 'tc_2'));
});

test('none tier auto-allows a destructive tool', async () => {
  const { backend, events, spawned } = makeBackend({ getPermissionMode: () => 'none' });
  const { proc } = await startTurn(backend, spawned, 'exec code');
  pushEvent(proc, 'permission.requested', {
    toolCallId: 'tc_3',
    toolName: 'ae_exec',
    riskLevel: 'critical',
    input: {},
    requestId: 'r3',
  });
  await flush();
  assert.ok(events.some((e) => e.type === 'tool-allowed' && e.toolUseId === 'tc_3'));
});

test('approve(allow) resolves a pending approval and emits tool-allowed', async () => {
  const { backend, events, spawned } = makeBackend({ getPermissionMode: () => 'manual' });
  const { proc } = await startTurn(backend, spawned, 'set a property');
  pushEvent(proc, 'permission.requested', {
    toolCallId: 'tc_4',
    toolName: 'ae_setProperty',
    riskLevel: 'medium',
    input: {},
    requestId: 'r4',
  });
  await flush();
  backend.approve('tc_4', 'allow');
  await flush();
  assert.ok(events.some((e) => e.type === 'tool-allowed' && e.toolUseId === 'tc_4'));
});

test('stop emits an aborted error and drains pending approvals', async () => {
  const { backend, events, spawned } = makeBackend({ getPermissionMode: () => 'manual' });
  const { proc } = await startTurn(backend, spawned, 'set a property');
  pushEvent(proc, 'permission.requested', {
    toolCallId: 'tc_5',
    toolName: 'ae_setProperty',
    riskLevel: 'medium',
    input: {},
    requestId: 'r5',
  });
  await flush();
  backend.stop();
  await flush();
  assert.ok(events.some((e) => e.type === 'tool-denied' && e.toolUseId === 'tc_5'));
  assert.ok(events.some((e) => e.type === 'error' && e.kind === 'aborted'));
});

test('reset kills the process and clears transcript', async () => {
  const { backend, spawned } = makeBackend();
  const { proc } = await startTurn(backend, spawned, 'hello');
  backend.reset();
  assert.ok(spawned.procs[0].killed, 'process killed on reset');
  assert.deepEqual(backend.getMessages(), []);
});

test('probeAccount reports loggedIn when session/create succeeds', async () => {
  const { backend, spawned } = makeBackend();
  const probe = backend.probeAccount();
  await flush();
  const proc = spawned.procs[0];
  const createReq = parseWrites(proc)[0];
  respond(proc, createReq, { session: { sessionId: 'sess_probe' }, settings: { model: { available: [] } } });
  await flush();
  // respond to the subscribe request so ensureSession resolves
  const subReq = parseWrites(proc).find((m) => m.method === 'session/subscribe');
  if (subReq) respond(proc, subReq, { sessionId: 'sess_probe', eventSeq: 0 });
  await flush();
  const result = await probe;
  assert.equal(result.loggedIn, true);
  assert.equal(result.runtimeOk, true);
  assert.equal(result.provider, 'zcode');
});

test('probeAccount reports runtime unavailable when the CLI cannot be resolved', async () => {
  // ZCode uses a provider API key, not `zcode login` — a spawn failure is an
  // environment problem, not a login problem, so we must not gate the user
  // behind a fake "not logged in" state.
  const { backend } = makeBackend({ resolveCli: async () => ({ ok: false, detail: 'not installed' }) });
  const result = await backend.probeAccount();
  assert.deepEqual(result, {
    loggedIn: true,
    runtimeOk: false,
    provider: 'zcode',
    detail: 'not installed',
  });
});

test('probeAccount reports provider API key repair hints when session/create fails for missing key', async () => {
  const { backend, spawned } = makeBackend();
  const probe = backend.probeAccount();
  await flush();

  const proc = spawned.procs[0];
  const createReq = parseWrites(proc)[0];
  reject(proc, createReq, 'Model provider is missing an API key: mediastorm_glm');
  await flush();

  const result = await probe;
  assert.equal(result.loggedIn, true);
  assert.equal(result.runtimeOk, false);
  assert.equal(result.provider, 'zcode');
  assert.match(result.detail, /AE_MCP_ZCODE_API_KEY/);
  assert.match(result.detail, /MEDIASTORM_GLM_API_KEY/);
  assert.match(result.detail, /ZCODE_API_KEY/);
});

test('probeAccount reports model config repair hints when ZCode has no explicit provider', async () => {
  const { backend, spawned } = makeBackend();
  const probe = backend.probeAccount();
  await flush();

  const proc = spawned.procs[0];
  const createReq = parseWrites(proc)[0];
  reject(proc, createReq, 'Model config is missing. Create C:\\Users\\A\\.zcode\\cli\\config.json with an explicit model provider before running ZCode.');
  await flush();

  const result = await probe;
  assert.equal(result.loggedIn, true);
  assert.equal(result.runtimeOk, false);
  assert.equal(result.provider, 'zcode');
  assert.match(result.detail, /config\.json/);
  assert.match(result.detail, /provider\/model/);
  assert.match(result.detail, /Open ZCode/);
});

test('probeAccount does not cache sessionId when subscribe fails', async () => {
  const { backend, spawned } = makeBackend();
  const firstProbe = backend.probeAccount();
  await flush();
  const proc = spawned.procs[0];
  const firstCreate = parseWrites(proc)[0];
  respond(proc, firstCreate, { session: { sessionId: 'sess_partial' }, settings: { model: { available: [] } } });
  await flush();
  const firstSub = parseWrites(proc).find((m) => m.method === 'session/subscribe');
  assert.ok(firstSub, 'probe subscribes before reporting runtime ready');
  reject(proc, firstSub, 'subscribe failed');
  await flush();
  const firstResult = await firstProbe;
  assert.equal(firstResult.runtimeOk, false);
  assert.match(firstResult.detail, /subscribe failed/);

  const writesBeforeRetry = parseWrites(proc).length;
  const secondProbe = backend.probeAccount();
  await flush();
  const retryWrites = parseWrites(proc).slice(writesBeforeRetry);
  const secondCreate = retryWrites.find((m) => m.method === 'session/create');
  assert.ok(secondCreate, 'retry starts a fresh session/create after subscribe failure');
  respond(proc, secondCreate, { session: { sessionId: 'sess_retry' }, settings: { model: { available: [] } } });
  await flush();
  const secondSub = parseWrites(proc).slice(writesBeforeRetry).find((m) => m.method === 'session/subscribe');
  assert.ok(secondSub, 'retry subscribes before reporting runtime ready');
  respond(proc, secondSub, { sessionId: 'sess_retry', eventSeq: 0 });
  await flush();
  const secondResult = await secondProbe;
  assert.equal(secondResult.runtimeOk, true);
});

// --- descriptor tests ---

test('zcodeStaticDescriptor satisfies the backend descriptor contract', () => {
  const d = zcodeStaticDescriptor();
  assert.equal(d.id, 'zcode');
  assert.ok(Array.isArray(d.models) && d.models.length > 0);
  assert.ok(d.defaultModelId);
  assert.equal(typeof d.supportsFast, 'function');
  assert.equal(d.perTurnModelSwitch, false);
  assert.equal(Array.isArray(d.approvalModes) && d.approvalModes.length, 4);
  assert.deepEqual(d.models[0].effortLevels, ['nothink', 'high', 'max']);
  assert.equal(d.defaultEffort, 'high');
});

test('session/create carries thoughtLevel when getEffort returns a valid level', async () => {
  const { backend, spawned } = makeBackend({ getEffort: () => 'high' });
  backend.sendUser('hello');
  await flush();
  const proc = spawned.procs[0];
  const createReq = parseWrites(proc)[0];
  assert.equal(createReq.method, 'session/create');
  assert.equal(createReq.params.thoughtLevel, 'high');
});

test('session/create omits thoughtLevel when getEffort is null', async () => {
  const { backend, spawned } = makeBackend({ getEffort: () => null });
  backend.sendUser('hello');
  await flush();
  const proc = spawned.procs[0];
  const createReq = parseWrites(proc)[0];
  assert.equal(createReq.params.thoughtLevel, undefined);
});

test('setThoughtLevel pushes a session/setThoughtLevel request', async () => {
  const { backend, spawned } = makeBackend();
  const { proc } = await startTurn(backend, spawned, 'hello');
  const before = parseWrites(proc).length;
  const pending = backend.setThoughtLevel('high');
  await flush();
  const setReq = parseWrites(proc).slice(before).find((m) => m.method === 'session/setThoughtLevel');
  assert.ok(setReq, 'session/setThoughtLevel sent');
  assert.equal(setReq.params.thoughtLevel, 'high');
  respond(proc, setReq, { ok: true });
  assert.equal(await pending, true);
});

test('setThoughtLevel rejects an invalid level', async () => {
  const { backend, spawned } = makeBackend();
  await startTurn(backend, spawned, 'hello');
  const ok = await backend.setThoughtLevel('turbo');
  assert.equal(ok, false);
});

test('elicitation/create (AskUserQuestion) surfaces options and replies with action/content', async () => {
  const { backend, events, spawned } = makeBackend({ getPermissionMode: () => 'manual' });
  const { proc } = await startTurn(backend, spawned, 'pick a color');
  // Simulate ZCode sending an elicitation/create REQUEST (mode:form) with a
  // requestedSchema whose property "color" has an enum of choices.
  proc.pushStdout({
    id: 99,
    method: 'elicitation/create',
    params: {
      mode: 'form',
      message: 'Which color?',
      requestedSchema: {
        type: 'object',
        properties: { color: { type: 'string', enum: ['red', 'green', 'blue'] } },
        required: ['color'],
      },
    },
  });
  await flush();

  // The panel should have received an approval-required with the choices.
  const approval = events.find((e) => e.type === 'approval-required' && e.name === 'AskUserQuestion');
  assert.ok(approval, 'approval-required emitted for elicitation');
  assert.deepEqual(approval.input.choices, ['red', 'green', 'blue']);

  // User picks "green" — approve() must reply with {action:"accept", content:{color:"green"}}.
  backend.approve(approval.toolUseId, 'green');
  await flush();
  const reply = parseWrites(proc).find((m) => m.id === 99);
  assert.ok(reply, 'elicitation reply sent');
  assert.equal(reply.result.action, 'accept');
  assert.deepEqual(reply.result.content, { color: 'green' });
});

test('elicitation auto-accepts in none tier (no blocking)', async () => {
  const { backend, events, spawned } = makeBackend({ getPermissionMode: () => 'none' });
  const { proc } = await startTurn(backend, spawned, 'pick a color');
  proc.pushStdout({
    id: 100,
    method: 'elicitation/create',
    params: {
      mode: 'form',
      message: 'Which color?',
      requestedSchema: {
        type: 'object',
        properties: { color: { type: 'string', enum: ['red', 'green'] } },
        required: ['color'],
      },
    },
  });
  await flush();
  // Should auto-accept with the first option, no approval-required emitted.
  assert.ok(!events.some((e) => e.type === 'approval-required'));
  const reply = parseWrites(proc).find((m) => m.id === 100);
  assert.equal(reply.result.action, 'accept');
  assert.equal(reply.result.content.color, 'red');
});

test('interaction/requestUserInput (AskUserQuestion) surfaces choices and replies with decision/answers', async () => {
  const { backend, events, spawned } = makeBackend({ getPermissionMode: () => 'manual' });
  const { proc } = await startTurn(backend, spawned, 'pick a color');
  // ZCode sends interaction/requestUserInput as a REQUEST (with id).
  proc.pushStdout({
    id: 77,
    method: 'interaction/requestUserInput',
    params: {
      prompt: 'Tool AskUserQuestion requires user interaction',
      input: {
        questions: [{
          question: 'Which color do you prefer: red or blue?',
          header: 'Color choice',
          multiSelect: false,
          options: [
            { label: 'Red', description: 'You prefer the color red.' },
            { label: 'Blue', description: 'You prefer the color blue.' },
          ],
        }],
      },
    },
  });
  await flush();

  const approval = events.find((e) => e.type === 'approval-required' && e.name === 'AskUserQuestion');
  assert.ok(approval, 'approval-required emitted for AskUserQuestion');
  assert.deepEqual(approval.input.choices, ['Red', 'Blue']);

  // User picks "Blue" — approve() must reply {decision:"allow", answers:{...:"Blue"}}.
  backend.approve(approval.toolUseId, 'Blue');
  await flush();
  const reply = parseWrites(proc).find((m) => m.id === 77);
  assert.ok(reply, 'requestUserInput reply sent');
  assert.equal(reply.result.decision, 'allow');
  assert.equal(reply.result.answers['Which color do you prefer: red or blue?'], 'Blue');
});

test('session/create injects the ae MCP server when getMcpSpec is provided', async () => {
  const { backend, spawned } = makeBackend({
    getMcpSpec: async () => ({ command: 'ae-mcp', args: ['--stdio'], env: { A: 'B' } }),
    getExpertGuidance: () => true,
  });
  backend.sendUser('hello');
  await flush();
  const proc = spawned.procs[0];
  const createReq = parseWrites(proc)[0];
  assert.equal(createReq.method, 'session/create');
  assert.ok(Array.isArray(createReq.params.mcpServers), 'mcpServers array present');
  assert.equal(createReq.params.mcpServers.length, 1);
  const ae = createReq.params.mcpServers[0];
  assert.equal(ae.name, 'ae');
  assert.equal(ae.command, 'ae-mcp');
  assert.deepEqual(ae.args, ['--stdio']);
  // env is the app-server wire format [{name,value}], not an object.
  assert.ok(Array.isArray(ae.env), 'env is array');
  assert.equal(ae.env[0].name, 'A');
  assert.equal(ae.env[0].value, 'B');
  assert.ok(ae.env.some((e) => e.name === 'AE_MCP_BACKEND' && e.value === 'ae-mcp'));
});

test('session/create omits mcpServers when getMcpSpec is absent', async () => {
  const { backend, spawned } = makeBackend();
  backend.sendUser('hello');
  await flush();
  const proc = spawned.procs[0];
  const createReq = parseWrites(proc)[0];
  assert.equal(createReq.params.mcpServers, undefined);
});

test('zcodeDescriptorFromModels builds from session/create model.available', () => {
  const result = zcodeDescriptorFromModels({
    settings: {
      model: {
        available: [
          { label: 'GLM-5.2', ref: { modelId: 'glm-5.2', providerId: 'mediastorm_glm' }, contextWindow: 1000000 },
          { label: 'Deepseek V4', ref: { modelId: 'deepseek-v4-pro', providerId: 'mediastorm_glm' } },
        ],
        current: { modelId: 'glm-5.2', providerId: 'mediastorm_glm' },
      },
    },
  });
  assert.equal(result.id, 'zcode');
  assert.equal(result.models.length, 2);
  assert.equal(result.models[0].id, 'mediastorm_glm/glm-5.2');
  assert.equal(result.models[0].label, 'GLM-5.2');
  assert.equal(result.defaultModelId, 'mediastorm_glm/glm-5.2');
  assert.equal(result.perTurnModelSwitch, false);
});

test('zcodeDescriptorFromModels falls back to static when no models', () => {
  const result = zcodeDescriptorFromModels({});
  assert.equal(result.id, 'zcode');
  assert.ok(result.models.length > 0);
});
