import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createZcodeBackend, zcodeModelFromDesktopConfig, zcodeRuntimeModelFromDesktopConfig, mergeZcodeConfigs, resolveZcodeProviderApiKey, summarizeZcodeConfig, readZcodeDesktopModel } from '../src/cep/zcodeBackend.js';
import { zcodeStaticDescriptor, zcodeDescriptorFromModels, zcodeDynamicDescriptor } from '../src/lib/backendCapabilities.js';
import { reconcileModelPref } from '../src/lib/descriptorSelect.js';

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
  const platform = options.platform || {
    id: 'windows-x64',
    paths: {
      home: 'C:\\Users\\test',
      tempRoot: 'C:\\tmp',
      join: (parts) => parts.join('\\'),
      resolve: (parts) => parts.join('\\').replace(/\//g, '\\'),
      dirname: (value) => String(value).replace(/[\\/][^\\/]+$/, ''),
    },
    fs: { readFileSync: () => { throw new Error('ENOENT'); } },
    completeSpawnEnv: (base = {}, additions = {}) => ({ ...base, ...additions }),
    resolveExecutable: async (id) => id === 'zcode'
      ? { ok: true, id, path: 'C:\\Node\\node.exe', argsPrefix: ['C:\\ZCode\\zcode.cjs'], source: 'standard', version: '1.0.0', arch: 'x64' }
      : { ok: false, id, code: 'NOT_FOUND', attempts: [] },
    spawn: (executable, args, spawnOptions) => spawned.spawn(executable.path, [...(executable.argsPrefix || []), ...args], spawnOptions),
  };
  const backend = createZcodeBackend({
    platform,
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

test('interaction/requestProviderRuntimeHeaders never reads unsupported desktop credentials', async () => {
  let credentialReads = 0;
  const { backend, spawned } = makeBackend({
    getModel: () => 'custom-provider/model-1',
    readDesktopRuntimeModel: () => ({
      revision: 'desktop-v2:custom-provider',
      generatedAt: 1,
      model: { providerId: 'custom-provider', modelId: 'model-1' },
      provider: {
        providerId: 'custom-provider',
        kind: 'openai-compatible',
        apiFormat: 'openai-responses',
        source: 'custom',
        baseURL: 'https://api.example.com/v1',
        models: [{ modelId: 'model-1' }],
      },
    }),
    readOAuthAccessToken: () => { credentialReads += 1; return 'must-not-be-read'; },
  });
  const { proc } = await startTurn(backend, spawned, 'hello');

  proc.pushStdout({
    id: 92,
    method: 'interaction/requestProviderRuntimeHeaders',
    params: {
      requestId: 'runtime_headers_2',
      sessionId: 'sess_test',
      workspace: { workspacePath: 'C:\\Repo\\plugin\\panel', workspaceKey: 'C:\\Repo\\plugin\\panel' },
      modelRef: { providerId: 'custom-provider', modelId: 'model-1' },
      providerId: 'custom-provider',
      reason: 'model-request',
    },
  });
  await flush();

  const reply = parseWrites(proc).find((m) => m.id === 92);
  assert.equal(reply.error, undefined);
  assert.equal(reply.result.headersApplied, false);
  assert.match(reply.result.errorMessage, /runtime headers/i);
  assert.equal(credentialReads, 0);
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

test('sendUser recreates the session when the preferred model changed since session/create', async () => {
  // Regression: ensureSession() must not blindly reuse a cached sessionId
  // once the panel's default-model preference changes -- otherwise flipping
  // "默认模型" in Settings silently keeps talking to the old model.
  let model = 'provider-a/model-a';
  const { backend, spawned } = makeBackend({ getModel: () => model });

  // First turn establishes a session bound to model-a.
  const first = await startTurn(backend, spawned, 'hello');
  assert.equal(first.createReq.params.model.modelId, 'model-a');

  // Finish the first turn so sendUser is free to run again.
  pushEvent(first.proc, 'turn.completed', { response: 'ok' });
  await first.pending;

  // Flip the preferred model.
  model = 'provider-b/model-b';

  // Next sendUser must create a NEW session using the new model, not reuse
  // the old sessionId.
  const pending = backend.sendUser('again');
  await flush();
  const proc = spawned.procs[0];
  const writes = parseWrites(proc);
  const secondCreateReq = writes.filter((m) => m.method === 'session/create')[1];
  assert.ok(secondCreateReq, 'a second session/create was sent after the model preference changed');
  assert.equal(secondCreateReq.params.model.modelId, 'model-b');

  respond(proc, secondCreateReq, { session: { sessionId: 'sess_test_2' }, settings: { model: { available: [] } } });
  await flush();
  const subReq2 = parseWrites(proc).filter((m) => m.method === 'session/subscribe')[1];
  if (subReq2) respond(proc, subReq2, { sessionId: 'sess_test_2', eventSeq: 0 });
  await flush();
  const sendReq2 = parseWrites(proc).filter((m) => m.method === 'session/send')[1];
  assert.ok(sendReq2, 'session/send was sent against the new session');
  assert.equal(sendReq2.params.sessionId, 'sess_test_2');
  respond(proc, sendReq2, { accepted: true, sessionId: 'sess_test_2' });
  await flush();
  pushEvent(proc, 'turn.completed', { response: 'ok' });
  await pending;
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


// --- Task 4: CLI config merge + score fix + apiKeyEnv chain ---

const CLI_PROVIDER = {
  kind: 'openai-compatible',
  name: 'MediaStorm GLM',
  options: { baseURL: 'https://api.example.com/v1', apiKeyEnv: 'MEDIASTORM_GLM_API_KEY' },
};

function fakeFs(files) {
  return {
    readFileSync(p) {
      if (!(p in files)) { const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e; }
      return files[p];
    },
  };
}

function zcodePlatform(fsImpl, home = 'C:\\Users\\me') {
  return {
    paths: { home, join: (parts) => parts.join('\\') },
    fs: fsImpl,
    completeSpawnEnv: (base = {}, additions = {}) => ({ ...base, ...additions }),
  };
}

test('mergeZcodeConfigs lets CLI providers override desktop providers of the same id', () => {
  const merged = mergeZcodeConfigs({
    cliConfig: { provider: { shared: { kind: 'openai-compatible', options: { baseURL: 'https://cli' } }, cliOnly: {} } },
    desktopConfig: { provider: { shared: { kind: 'anthropic' }, desktopOnly: {} } },
  });
  assert.equal(merged.provider.shared.options.baseURL, 'https://cli');
  assert.ok(merged.provider.cliOnly);
  assert.ok(merged.provider.desktopOnly);
  assert.equal(mergeZcodeConfigs({}), null);
});

test('a credentialed custom provider outranks a keyless builtin start-plan (spec B1 regression)', () => {
  const model = zcodeModelFromDesktopConfig({
    setting: { providerFamilyDomain: 'zai' },
    env: { MEDIASTORM_GLM_API_KEY: 'sk-live' },
    config: {
      provider: {
        'builtin:zai-start-plan': { enabled: true, models: { 'GLM-5.2': {} } },
        mediastorm_glm: { ...CLI_PROVIDER, models: { 'glm-5.2': {} } },
      },
    },
  });
  assert.equal(model, 'mediastorm_glm/glm-5.2');
});

test('without any credential the builtin start-plan still wins (no behavior change)', () => {
  const model = zcodeModelFromDesktopConfig({
    setting: { providerFamilyDomain: 'zai' },
    env: {},
    config: {
      provider: {
        'builtin:zai-start-plan': { enabled: true, models: { 'GLM-5.2': {} } },
        mediastorm_glm: { ...CLI_PROVIDER, models: { 'glm-5.2': {} } },
      },
    },
  });
  assert.equal(model, 'builtin:zai-start-plan/GLM-5.2');
});

test('resolveZcodeProviderApiKey chain: config -> env[apiKeyEnv] -> stored panel key -> empty', () => {
  assert.deepEqual(resolveZcodeProviderApiKey({ provider: { options: { apiKey: 'inline' } } }), { key: 'inline', source: 'config' });
  assert.deepEqual(resolveZcodeProviderApiKey({ provider: CLI_PROVIDER, env: { MEDIASTORM_GLM_API_KEY: 'sk-env' } }), { key: 'sk-env', source: 'env' });
  assert.deepEqual(resolveZcodeProviderApiKey({ provider: CLI_PROVIDER, env: {}, storedKey: 'sk-panel' }), { key: 'sk-panel', source: 'panel' });
  assert.deepEqual(resolveZcodeProviderApiKey({ provider: CLI_PROVIDER, env: {} }), { key: '', source: '' });
});

test('zcodeRuntimeModelFromDesktopConfig injects the resolved apiKeyEnv key for a modelRef-selected provider without models', () => {
  const config = { provider: { mediastorm_glm: CLI_PROVIDER } };
  const fromEnv = zcodeRuntimeModelFromDesktopConfig({ config, setting: {}, modelRef: 'mediastorm_glm/glm-5.2', env: { MEDIASTORM_GLM_API_KEY: 'sk-env' } });
  assert.equal(fromEnv.model.modelId, 'glm-5.2');
  assert.equal(fromEnv.provider.apiFormat, 'openai-chat-completions');
  assert.deepEqual(fromEnv.provider.apiKey, { source: 'inline', value: 'sk-env' });
  assert.deepEqual(fromEnv.provider.models, [{ modelId: 'glm-5.2' }]);
  const fromPanel = zcodeRuntimeModelFromDesktopConfig({ config, setting: {}, modelRef: 'mediastorm_glm/glm-5.2', env: {}, storedKey: 'sk-panel' });
  assert.deepEqual(fromPanel.provider.apiKey, { source: 'inline', value: 'sk-panel' });
  const none = zcodeRuntimeModelFromDesktopConfig({ config, setting: {}, modelRef: 'mediastorm_glm/glm-5.2', env: {} });
  assert.equal(none.provider.apiKey, undefined);
});

test('zcodeRuntimeModelFromDesktopConfig maps openai-compatible dialect responses to openai-responses', () => {
  const config = {
    provider: {
      mediastorm_glm: {
        ...CLI_PROVIDER,
        dialect: { wireApi: 'responses', authScheme: 'bearer', source: 'detected', updatedAt: 123 },
        models: { 'glm-5.2': {} },
      },
    },
  };

  const runtimeModel = zcodeRuntimeModelFromDesktopConfig({ config, setting: {}, modelRef: 'mediastorm_glm/glm-5.2', storedKey: 'sk-panel' });

  assert.equal(runtimeModel.provider.kind, 'openai-compatible');
  assert.equal(runtimeModel.provider.apiFormat, 'openai-responses');
});

test('readZcodeDesktopModel merges ~/.zcode/cli/config.json and prefers its top-level model', () => {
  const env = {};
  const files = {
    'C:\\Users\\me\\.zcode\\cli\\config.json': JSON.stringify({ provider: { mediastorm_glm: CLI_PROVIDER }, model: 'mediastorm_glm/glm-5.2' }),
    'C:\\Users\\me\\.zcode\\v2\\config.json': JSON.stringify({ provider: { 'builtin:zai-start-plan': { enabled: true, models: { 'GLM-5.2': {} } } } }),
    'C:\\Users\\me\\.zcode\\v2\\setting.json': JSON.stringify({ providerFamilyDomain: 'zai' }),
  };
  const fsImpl = fakeFs(files);
  assert.equal(readZcodeDesktopModel({ env, fsImpl, platform: zcodePlatform(fsImpl) }), 'mediastorm_glm/glm-5.2');
});

// End-to-end regression for the "settings page shows CLI model X, but Chat
// actually sends builtin GLM-5.2" bug. Before the fix, the zcode descriptor
// used for both display and reconcileModelPref's reset target was
// zcodeStaticDescriptor()'s hardcoded builtin list (defaultModelId
// 'builtin:bigmodel-start-plan/GLM-5.2') until a live session existed. A
// stale/invalid stored pref (Y) would reconcile to that builtin id instead of
// the CLI-configured model (X), and createZcodeBackend's currentModelRef
// would then send whatever getModel() returns first if it looks like a
// non-legacy '<provider>/<model>' ref -- so the wrong (builtin) model shipped
// in the session/create request.
test('CLI config X + stale stored model Y reconcile to X, and X is what session/create actually sends', async () => {
  const env = { PATH: 'C:\\Node', TEMP: 'C:\\tmp', AE_MCP_PANEL_EXT_ROOT: 'C:\\Repo\\plugin\\panel' };
  const files = {
    'C:\\Users\\me\\.zcode\\cli\\config.json': JSON.stringify({
      provider: { mediastorm_glm: CLI_PROVIDER },
      model: 'mediastorm_glm/deepseek-v4-flash',
    }),
  };
  const fsImpl = fakeFs(files);
  const cliModel = 'mediastorm_glm/deepseek-v4-flash';

  // 1. Settings-page display source: the descriptor built while CLI
  //    inheritance is active (no live session yet) must be built around the
  //    CLI-configured model, not the static/builtin list.
  const configPlatform = zcodePlatform(fsImpl);
  const descriptor = zcodeDynamicDescriptor({ env, fsImpl, platform: configPlatform });
  assert.equal(descriptor.defaultModelId, cliModel);
  assert.deepEqual(descriptor.models.map((m) => m.id), [cliModel]);

  // 2. A stale/invalid previously-selected model Y (not in the descriptor's
  //    models) must reconcile to X (the CLI model), not to a builtin.
  const staleY = 'mediastorm_glm/glm-5.2';
  const reconciled = reconcileModelPref(staleY, descriptor, { isCustom: false });
  assert.equal(reconciled, cliModel);
  assert.notEqual(reconciled, 'builtin:bigmodel-start-plan/GLM-5.2');

  // 3. The reconciled value, fed into createZcodeBackend as getModel(), must
  //    be exactly what session/create's model field carries -- the real
  //    send-time behavior, not just descriptor bookkeeping.
  const { backend, spawned } = makeBackend({
    getModel: () => reconciled,
    readDesktopModel: () => readZcodeDesktopModel({ env, fsImpl, platform: configPlatform }),
    env,
  });
  backend.sendUser('hello');
  await flush();

  const createReq = parseWrites(spawned.procs[0])[0];
  assert.deepEqual(createReq.params.model, {
    providerId: 'mediastorm_glm',
    modelId: 'deepseek-v4-flash',
  });
});

test('summarizeZcodeConfig reports cli/desktop/start-plan channel facts', () => {
  const env = {};
  const files = {
    'C:\\Users\\me\\.zcode\\cli\\config.json': JSON.stringify({ provider: { mediastorm_glm: CLI_PROVIDER }, model: 'mediastorm_glm/glm-5.2' }),
    'C:\\Users\\me\\.zcode\\v2\\config.json': JSON.stringify({ provider: { 'builtin:zai-start-plan': { enabled: true, models: { 'GLM-5.2': {} } } } }),
  };
  const fsImpl = fakeFs(files);
  const configPlatform = zcodePlatform(fsImpl);
  const bare = summarizeZcodeConfig({ env, fsImpl, platform: configPlatform });
  assert.equal(bare.cli.providerId, 'mediastorm_glm');
  assert.equal(bare.cli.model, 'mediastorm_glm/glm-5.2');
  assert.equal(bare.cli.apiKeyEnv, 'MEDIASTORM_GLM_API_KEY');
  assert.equal(bare.cli.hasCredential, false);
  assert.equal(bare.desktop.providerId, 'builtin:zai-start-plan');
  assert.equal(bare.startPlan.providerId, 'builtin:zai-start-plan');
  assert.equal(bare.startPlan.hasCredential, false);
  const withKey = summarizeZcodeConfig({ env: { ...env, MEDIASTORM_GLM_API_KEY: 'k' }, fsImpl, platform: configPlatform });
  assert.equal(withKey.cli.hasCredential, true);
  assert.equal(withKey.cli.keySource, 'env');
  const withStored = summarizeZcodeConfig({ env, fsImpl, platform: configPlatform, storedKey: 'panel-key' });
  assert.equal(withStored.cli.hasCredential, true);
  assert.equal(withStored.cli.keySource, 'panel');
});

// Probe-driven zcode model list (custom openai-compatible providers): the
// panel needs the CLI provider's baseUrl + protocol kind to call
// probeProviderModels (cep/modelProbe.js) against /v1/models.
test('summarizeZcodeConfig exposes cli.baseUrl and cli.protocol for probe-driven model discovery', () => {
  const env = {};
  const files = {
    'C:\\Users\\me\\.zcode\\cli\\config.json': JSON.stringify({ provider: { mediastorm_glm: CLI_PROVIDER }, model: 'mediastorm_glm/glm-5.2' }),
    'C:\\Users\\me\\.zcode\\v2\\config.json': JSON.stringify({ provider: {} }),
  };
  const fsImpl = fakeFs(files);
  const summary = summarizeZcodeConfig({ env, fsImpl, platform: zcodePlatform(fsImpl) });
  assert.equal(summary.cli.baseUrl, 'https://api.example.com/v1');
  assert.equal(summary.cli.protocol, 'openai-compatible');
});

test('summarizeZcodeConfig omits cli.baseUrl when the CLI provider has none configured', () => {
  const env = {};
  const files = {
    'C:\\Users\\me\\.zcode\\cli\\config.json': JSON.stringify({ provider: { anthro: { kind: 'anthropic' } }, model: 'anthro/claude' }),
    'C:\\Users\\me\\.zcode\\v2\\config.json': JSON.stringify({ provider: {} }),
  };
  const fsImpl = fakeFs(files);
  const summary = summarizeZcodeConfig({ env, fsImpl, platform: zcodePlatform(fsImpl) });
  assert.equal(summary.cli.baseUrl, '');
  assert.equal(summary.cli.protocol, 'anthropic');
});

test('stored panel zcode key flows into spawn env via the apiKeyEnv chain', async () => {
  const { backend, spawned } = makeBackend({
    readStoredZcodeKey: () => 'sk-panel',
    env: {
      PATH: 'C:\Node', TEMP: 'C:\tmp', LOCALAPPDATA: 'C:\Users\test\AppData\Local',
      AE_MCP_PANEL_EXT_ROOT: 'C:\Repo\plugin\panel', AE_MCP_ZCODE_MODEL: 'mediastorm_glm/glm-5.2',
    },
  });
  backend.sendUser('hello');
  await flush();
  assert.equal(spawned.calls[0].options.env.ZCODE_API_KEY, 'sk-panel');
  assert.equal(spawned.calls[0].options.env.MEDIASTORM_GLM_API_KEY, 'sk-panel');
});

test('zh lang backends localize turn.failed missing-key errors (spec B1)', async () => {
  const { backend, events, spawned } = makeBackend({ lang: 'zh' });
  const { proc, pending } = await startTurn(backend, spawned, 'hi');
  pushEvent(proc, 'turn.failed', { error: { message: 'Model provider is missing an API key: builtin:zai-start-plan' } });
  await pending;
  await flush();
  const err = events.find((e) => e.type === 'error');
  assert.match(err.message, /缺少 API Key/);
  assert.match(err.message, /builtin:zai-start-plan/);
});

// Regression: the composer's model chip is built from session/create's
// settings.model.available via zcodeDescriptorFromModels, but that result
// was never surfaced past ensureSession() — the panel had no way to see it,
// so the model chip disappeared entirely. Fix: emit a 'zcode-session-created'
// event carrying the session/create result so App.jsx can build a live
// descriptor from it.
test('ensureSession emits zcode-session-created with the session/create result', async () => {
  const { backend, events, spawned } = makeBackend();
  const pending = backend.sendUser('hello');
  await flush();
  const proc = spawned.procs[0];
  const createReq = parseWrites(proc)[0];
  assert.equal(createReq.method, 'session/create');
  // settings is a sibling of session in the real session/create result (see
  // the startTurn() harness above: { session: {...}, settings: {...} }).
  const createResult = {
    session: { sessionId: 'sess_test' },
    settings: {
      model: {
        available: [{ label: 'GLM-5.2', ref: { modelId: 'GLM-5.2', providerId: 'bigmodel-start-plan' } }],
        current: { modelId: 'GLM-5.2', providerId: 'bigmodel-start-plan' },
      },
    },
  };
  respond(proc, createReq, createResult);
  await flush();

  const subReq = parseWrites(proc).find((m) => m.method === 'session/subscribe');
  if (subReq) respond(proc, subReq, { sessionId: 'sess_test', eventSeq: 0 });
  await flush();
  const sendReq = parseWrites(proc).find((m) => m.method === 'session/send');
  respond(proc, sendReq, { accepted: true, sessionId: 'sess_test' });
  await flush();

  const sessionCreated = events.find((e) => e.type === 'zcode-session-created');
  assert.ok(sessionCreated, 'zcode-session-created event was emitted');
  assert.deepEqual(sessionCreated.result, createResult);
  // The emitted result must be directly usable by zcodeDescriptorFromModels,
  // i.e. settings must be at the top level, not nested under .session.
  const descriptor = zcodeDescriptorFromModels(sessionCreated.result);
  assert.equal(descriptor.models.length, 1);
  assert.equal(descriptor.defaultModelId, 'bigmodel-start-plan/GLM-5.2');
});
