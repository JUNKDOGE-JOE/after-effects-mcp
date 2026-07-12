import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodexBackend } from '../src/cep/codexBackend.js';
import { PANEL_VERSION } from '../src/cep/mcpClient.js';

function makeProc() {
  const stdoutHandlers = [];
  const stderrHandlers = [];
  const exitHandlers = [];
  const errorHandlers = [];
  const writes = [];
  let killed = false;

  return {
    writes,
    get killed() {
      return killed;
    },
    stdin: {
      write(line) {
        writes.push(line);
      },
    },
    stdout: {
      on(event, handler) {
        if (event === 'data') stdoutHandlers.push(handler);
      },
    },
    stderr: {
      on(event, handler) {
        if (event === 'data') stderrHandlers.push(handler);
      },
    },
    on(event, handler) {
      if (event === 'exit') exitHandlers.push(handler);
      if (event === 'error') errorHandlers.push(handler);
    },
    kill() {
      killed = true;
    },
    pushStdout(message) {
      const line = typeof message === 'string' ? message : JSON.stringify(message) + '\n';
      for (const handler of stdoutHandlers) handler(line);
    },
    pushStderr(text) {
      for (const handler of stderrHandlers) handler(text);
    },
    exit(code = 0, signal = null) {
      for (const handler of exitHandlers) handler(code, signal);
    },
    error(error) {
      for (const handler of errorHandlers) handler(error);
    },
  };
}

function makeSpawn() {
  const calls = [];
  const procs = [];
  function spawn(command, args, options) {
    const proc = makeProc();
    calls.push({
      command,
      args,
      options: { ...options, env: { ...(options.env || {}) } },
      sourceOptions: options,
      proc,
    });
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

async function waitFor(check, message = 'condition was not reached') {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (check()) return;
    await flush();
  }
  assert.fail(message);
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

function respond(proc, request, result = {}) {
  proc.pushStdout({ id: request.id, result });
}

const TOOL_META = {
  allowedTools: [],
  annotations: {
    mcp__ae__ae_overview: { readOnly: true, destructive: false },
    mcp__ae__ae_setProperty: { readOnly: false, destructive: false },
    mcp__ae__ae_exec: { readOnly: false, destructive: true },
  },
};

const WRITE_PLAN = {
  artifactId: 'user:123',
  contentHash: 'a'.repeat(64),
  operation: 'execute',
  normalizedArgs: {},
  target: { compId: '7' },
  planHash: 'b'.repeat(64),
  risk: 'write',
  expiresAt: 9999999999999,
};

const PROVIDER_CREDENTIAL_ID = '5eb75f05-5d9e-5d9c-85af-f0893e8b90c2';
const PROVIDER_MODEL_ID = 'gpt-5.5';

function providerSecretRef() {
  return {
    kind: 'secret',
    reference: `aemcp-secret://provider/${PROVIDER_CREDENTIAL_ID}/auth-model/v1`,
    revision: 1,
  };
}

function providerAgentFeatures(status = 'supported') {
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

function providerCapability(protocol, {
  apiRoot = 'https://proxy.example/openai/v1',
  requestProfileRevision = 1,
  modelListRevision = 1,
} = {}) {
  const protocolFields = {
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
  };
  return {
    status: 'supported',
    apiRoot,
    auth: { scheme: 'bearer', headerName: null },
    ...protocolFields[protocol],
    agentFeatures: providerAgentFeatures(),
    checkedAt: 1,
    validUntil: 9_000_000_000_000,
    requestProfileRevision,
    modelListRevision,
  };
}

function unsupportedProviderCapability({
  apiRoot = 'https://proxy.example/openai/v1',
  requestProfileRevision = 1,
  modelListRevision = 1,
} = {}) {
  return {
    status: 'unsupported',
    apiRoot,
    auth: { scheme: 'bearer', headerName: null },
    compatibility: null,
    agentFeatures: providerAgentFeatures('unsupported'),
    checkedAt: 1,
    validUntil: null,
    requestProfileRevision,
    modelListRevision,
    evidence: 'model-protocol-unsupported',
  };
}

function providerFixtureV3({
  id = 'my-provider',
  name = 'My Provider',
  baseUrl = 'https://proxy.example/openai/v1',
  apiRoot = baseUrl,
  requestProfileRevision = 1,
  modelListRevision = 1,
  responses,
  chat,
  messages,
  routeOverrides = [],
} = {}) {
  const capabilityOptions = { apiRoot, requestProfileRevision, modelListRevision };
  return {
    id,
    credentialId: PROVIDER_CREDENTIAL_ID,
    name,
    baseUrl,
    allowInsecureHttp: false,
    requestProfileRevision,
    credential: {
      valueRef: providerSecretRef(),
      preferredAuth: { scheme: 'auto', headerName: null },
    },
    probeAuthOverride: null,
    headers: [],
    probePreference: null,
    modelList: {
      revision: modelListRevision,
      status: 'supported',
      apiRoot,
      auth: { scheme: 'bearer', headerName: null },
      models: [{
        id: PROVIDER_MODEL_ID,
        label: 'GPT 5.5',
        metadata: {
          task: null,
          inputModalities: ['text'],
          outputModalities: ['text'],
          capabilities: [],
        },
      }],
      checkedAt: 1,
      validUntil: 9_000_000_000_000,
      requestProfileRevision,
    },
    modelCapabilities: [{
      modelId: PROVIDER_MODEL_ID,
      responses: responses || providerCapability('responses', capabilityOptions),
      chat: chat || providerCapability('chat', capabilityOptions),
      messages: messages || providerCapability('messages', capabilityOptions),
    }],
    routeOverrides,
  };
}

function providerForProtocol(protocol, overrides = {}) {
  const baseUrl = overrides.baseUrl || 'https://proxy.example/openai/v1';
  const apiRoot = overrides.apiRoot || baseUrl;
  const requestProfileRevision = overrides.requestProfileRevision || 1;
  const modelListRevision = overrides.modelListRevision || 1;
  const capabilityOptions = { apiRoot, requestProfileRevision, modelListRevision };
  const unavailable = () => unsupportedProviderCapability(capabilityOptions);
  return providerFixtureV3({
    ...overrides,
    responses: protocol === 'responses' ? providerCapability('responses', capabilityOptions) : unavailable(),
    chat: protocol === 'chat' ? providerCapability('chat', capabilityOptions) : unavailable(),
    messages: protocol === 'messages' ? providerCapability('messages', capabilityOptions) : unavailable(),
  });
}

const CUSTOM_PROVIDER = Object.freeze(providerFixtureV3());

function selectedProvider(provider = CUSTOM_PROVIDER) {
  return { provider, modelId: PROVIDER_MODEL_ID };
}

function localProviderRoute({
  routeToken = 'local-route-key',
  openaiBaseUrl = 'http://127.0.0.1:49123/v1',
  close = async () => {},
} = {}) {
  return {
    start: async () => ({
      origin: openaiBaseUrl.replace(/\/v1$/, ''),
      openaiBaseUrl,
      baseUrl: openaiBaseUrl,
      routeToken,
    }),
    close,
  };
}

function expectedLocalProviderArgs({ chatCompatibility = false } = {}) {
  const args = [
    'app-server',
    '-c', 'model_provider="my-provider"',
    '-c', 'model_providers.my-provider.name="AE MCP Custom"',
    '-c', 'model_providers.my-provider.base_url="http://127.0.0.1:49123/v1"',
    '-c', 'model_providers.my-provider.env_http_headers={ "x-ae-mcp-route-token" = "AE_MCP_PROVIDER_HEADER_00" }',
    '-c', 'model_providers.my-provider.wire_api="responses"',
    '-c', 'model_providers.my-provider.requires_openai_auth=false',
    '-c', 'features.multi_agent=false',
    '-c', 'features.multi_agent_v2=false',
    '-c', 'features.multi_agent_v2.non_code_mode_only=false',
  ];
  if (chatCompatibility) {
    args.push(
      '-c', 'web_search="disabled"',
      '-c', 'features.apps=false',
      '-c', 'features.plugins=false',
      '-c', 'features.remote_plugin=false',
    );
  }
  return args;
}

function resolvedModelProfile(overrides = {}) {
  return {
    providerId: CUSTOM_PROVIDER.id,
    baseUrl: CUSTOM_PROVIDER.baseUrl,
    allowInsecureHttp: false,
    auth: { kind: 'header', name: 'Authorization', value: 'Bearer resolved-model-secret' },
    extraHeaders: [{ name: 'x-provider-feature', value: 'enabled-secret', source: 'secret' }],
    authProfileRevision: 1,
    ...overrides,
  };
}

function realElicitation(tool, params = {}) {
  return {
    threadId: 'thread_1',
    turnId: 'turn_1',
    serverName: 'ae',
    mode: 'form',
    _meta: {
      codex_approval_kind: 'mcp_tool_call',
      persist: ['session', 'always'],
      tool_description: `${tool} — run JSX under an undo group, return the last expression value.`,
      tool_params: params,
      tool_params_display: Object.entries(params).map(([name, value]) => ({ name, value, display_name: name })),
    },
    message: `Allow the ae MCP server to run tool "${tool}"?`,
    requestedSchema: { type: 'object', properties: {} },
  };
}

function planElicitation(plan) {
  return {
    threadId: 'thread_1',
    turnId: 'turn_1',
    serverName: 'ae',
    mode: 'form',
    message: 'Approve artifact plan?',
    requestedSchema: {
      type: 'object',
      'x-ae-mcp-plan': plan,
    },
  };
}

function makeBackend(options = {}) {
  const events = [];
  const spawned = makeSpawn();
  const platform = options.platform || {
    id: 'windows-x64',
    paths: {
      tempRoot: 'C:\\tmp',
      dirname: (value) => String(value).replace(/[\\/][^\\/]+$/, ''),
    },
    completeSpawnEnv: (base = {}, additions = {}) => ({
      ...base,
      USERPROFILE: base.USERPROFILE || base.HOME || 'C:\\Users\\test',
      HOME: base.HOME || base.USERPROFILE || 'C:\\Users\\test',
      APPDATA: base.APPDATA || 'C:\\Users\\test\\AppData\\Roaming',
      ...additions,
    }),
    resolveExecutable: async (id, resolutionOptions = {}) => ({
      ok: true,
      id,
      path: resolutionOptions.env?.AE_MCP_CODEX_CLI || 'C:\\Tools\\codex.exe',
      argsPrefix: [],
      source: resolutionOptions.env?.AE_MCP_CODEX_CLI ? 'override' : 'path',
      version: '1.0.0',
      arch: 'x64',
    }),
    spawn: (executable, args, spawnOptions) => spawned.spawn(executable.path, [...(executable.argsPrefix || []), ...args], spawnOptions),
  };
  const backend = createCodexBackend({
    platform,
    getModel: () => 'gpt-5.5',
    getEffort: () => 'high',
    getFast: () => true,
    getPermissionMode: () => 'manual',
    getMcpSpec: async () => ({ command: 'ae-mcp', args: ['--stdio'], env: { A: 'B' } }),
    getToolMeta: async () => TOOL_META,
    onEvent: (evt) => events.push(evt),
    lang: 'en',
    env: {
      PATH: 'C:\\Node',
      TEMP: 'C:\\tmp',
      AE_MCP_PANEL_EXT_ROOT: 'C:\\Repo\\plugin\\panel',
    },
    createProviderRoute: () => localProviderRoute(),
    ...options,
  });
  return { backend, events, spawned };
}

async function startTurn(backend, spawned, text = 'hello') {
  const pending = backend.sendUser(text);
  await flush();
  const proc = spawned.procs[0];
  const init = parseWrites(proc)[0];
  assert.equal(init.method, 'initialize');
  assert.equal(init.params.capabilities.experimentalApi, true);
  respond(proc, init, {});
  await flush();
  const threadStart = parseWrites(proc)[1];
  assert.equal(threadStart.method, 'thread/start');
  respond(proc, threadStart, { threadId: 'thread_1' });
  await flush();
  const turnStart = parseWrites(proc)[2];
  assert.equal(turnStart.method, 'turn/start');
  respond(proc, turnStart, {});
  await flush();
  return { pending, proc, init, threadStart, turnStart };
}

async function startTurnRequest(backend, spawned, text = 'hello', processIndex = 0, threadId = 'thread_1') {
  const pending = backend.sendUser(text);
  await flush();
  const proc = spawned.procs[processIndex];
  const init = parseWrites(proc)[0];
  respond(proc, init, {});
  await flush();
  const threadStart = parseWrites(proc)[1];
  respond(proc, threadStart, { threadId });
  await flush();
  return { pending, proc, turnStart: parseWrites(proc)[2] };
}

function pushElicitation(proc, id, params) {
  proc.pushStdout({
    jsonrpc: '2.0',
    id,
    method: 'mcpServer/elicitation/request',
    params,
  });
}

test('createCodexBackend starts codex app-server and sends thread/start with AE MCP config', async () => {
  const { backend, spawned } = makeBackend();
  const pending = backend.sendUser('hello');
  await flush();

  assert.equal(spawned.calls.length, 1);
  assert.equal(spawned.calls[0].command, 'C:\\Tools\\codex.exe');
  assert.deepEqual(spawned.calls[0].args, ['app-server']);
  assert.equal(spawned.calls[0].options.shell, undefined);
  assert.equal(spawned.calls[0].options.stdio, 'pipe');
  assert.equal(spawned.calls[0].options.windowsHide, true);

  const proc = spawned.procs[0];
  const init = parseWrites(proc)[0];
  assert.equal(init.method, 'initialize');
  assert.deepEqual(init.params.clientInfo, { name: 'ae-mcp-panel', version: PANEL_VERSION });
  respond(proc, init, {});
  await flush();

  const threadStart = parseWrites(proc)[1];
  assert.equal(threadStart.params.ephemeral, true);
  assert.equal(threadStart.params.cwd, 'C:\\Repo\\plugin');
  assert.equal(threadStart.params.model, 'gpt-5.5');
  assert.equal(threadStart.params.approvalsReviewer, 'user');
  assert.deepEqual(threadStart.params.approvalPolicy, {
    granular: { mcp_elicitations: true, rules: false, sandbox_approval: false },
  });
  assert.deepEqual(threadStart.params.sandboxPolicy, { type: 'readOnly' });
  assert.deepEqual(threadStart.params.config.mcp_servers.ae, {
    command: 'ae-mcp',
    args: ['--stdio'],
    env: {
      A: 'B',
      AE_MCP_BACKEND: 'ae-mcp',
    },
  });
  assert.equal(Object.hasOwn(threadStart.params.config.mcp_servers.ae.env, 'AE_MCP_APPROVAL_TIER_FILE'), false);
  respond(proc, threadStart, { threadId: 'thread_1' });
  await flush();

  const turnStart = parseWrites(proc)[2];
  assert.deepEqual(turnStart.params, {
    threadId: 'thread_1',
    input: [{ type: 'text', text: 'hello' }],
    model: 'gpt-5.5',
    effort: 'high',
    serviceTier: 'priority',
    approvalPolicy: {
      granular: { mcp_elicitations: true, rules: false, sandbox_approval: false },
    },
    sandboxPolicy: { type: 'readOnly' },
  });
  respond(proc, turnStart, {});
  await flush();

  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await pending;
});

test('native Responses providers also use the local universal route and keep upstream secrets lazy', async () => {
  const routeCalls = [];
  let resolveCalls = 0;
  let closed = 0;
  const resolveRequestProfile = async () => {
    resolveCalls += 1;
    return resolvedModelProfile();
  };
  const { backend, spawned } = makeBackend({
    createProviderRoute: (input) => {
      routeCalls.push(input);
      return localProviderRoute({ close: async () => { closed += 1; } });
    },
    getProviderProfile: () => selectedProvider(),
    resolveRequestProfile,
  });

  const { pending, proc } = await startTurn(backend, spawned, 'custom provider');

  assert.equal(routeCalls.length, 1);
  assert.equal(routeCalls[0].provider, CUSTOM_PROVIDER);
  assert.equal(routeCalls[0].resolveRequestProfile, resolveRequestProfile);
  assert.equal(routeCalls[0].resolveCapability({
    provider: CUSTOM_PROVIDER,
    modelId: PROVIDER_MODEL_ID,
    clientProtocol: 'responses',
    feature: 'generate',
  }).upstreamProtocol, 'responses');
  assert.equal(resolveCalls, 0);
  assert.equal(spawned.calls[0].command, 'C:\\Tools\\codex.exe');
  assert.deepEqual(spawned.calls[0].args, expectedLocalProviderArgs());
  assert.equal(spawned.calls[0].options.env.AE_MCP_PROVIDER_HEADER_00, 'local-route-key');
  assert.equal(Object.hasOwn(spawned.calls[0].sourceOptions.env, 'AE_MCP_PROVIDER_HEADER_00'), false);
  assert.equal(Object.hasOwn(spawned.calls[0].options.env, 'AE_MCP_CODEX_API_KEY'), false);
  assert.doesNotMatch(
    JSON.stringify({ args: spawned.calls[0].args, env: spawned.calls[0].options.env }),
    /proxy\.example|resolved-model-secret|enabled-secret/,
  );

  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await pending;
  backend.reset();
  assert.equal(closed, 1);
});

test('Codex selects verified Chat and Messages routes with compatibility restrictions', async (context) => {
  for (const protocol of ['chat', 'messages']) {
    await context.test(protocol, async () => {
      const provider = providerForProtocol(protocol);
      const routeCalls = [];
      let resolveCalls = 0;
      const { backend, spawned } = makeBackend({
        createProviderRoute: (input) => {
          routeCalls.push(input);
          return localProviderRoute();
        },
        getProviderProfile: () => selectedProvider(provider),
        resolveRequestProfile: async () => {
          resolveCalls += 1;
          return resolvedModelProfile();
        },
      });

      const { pending, proc } = await startTurn(backend, spawned, `${protocol} provider`);
      const selected = routeCalls[0].resolveCapability({
        provider,
        modelId: PROVIDER_MODEL_ID,
        clientProtocol: 'responses',
        feature: 'generate',
      });
      assert.equal(selected.ok, true);
      assert.equal(selected.upstreamProtocol, protocol);
      assert.equal(resolveCalls, 0);
      assert.deepEqual(spawned.calls[0].args, expectedLocalProviderArgs({ chatCompatibility: true }));
      assert.equal(spawned.calls[0].options.env.AE_MCP_PROVIDER_HEADER_00, 'local-route-key');
      assert.doesNotMatch(JSON.stringify(spawned.calls[0].options.env), /resolved-model-secret/);

      proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
      await pending;
      backend.reset();
    });
  }
});

test('createCodexBackend reports structured unavailability before route creation or credential resolution', async () => {
  const capabilityOptions = { apiRoot: CUSTOM_PROVIDER.baseUrl };
  const provider = providerFixtureV3({
    responses: unsupportedProviderCapability(capabilityOptions),
    chat: unsupportedProviderCapability(capabilityOptions),
    messages: unsupportedProviderCapability(capabilityOptions),
  });
  let routeCalls = 0;
  let resolveCalls = 0;
  const { backend, events, spawned } = makeBackend({
    createProviderRoute: () => {
      routeCalls += 1;
      return localProviderRoute();
    },
    getProviderProfile: () => selectedProvider(provider),
    resolveRequestProfile: async () => {
      resolveCalls += 1;
      return resolvedModelProfile();
    },
  });

  await backend.sendUser('unsupported provider');

  assert.equal(routeCalls, 0);
  assert.equal(resolveCalls, 0);
  assert.equal(spawned.calls.length, 0);
  assert.deepEqual(events.filter((event) => event.type === 'error'), [{
    type: 'error',
    kind: 'model',
    code: 'provider_route_unavailable',
    message: 'Custom provider has no verified Codex route for model gpt-5.5',
  }]);
});

test('createCodexBackend refuses a provider profile bound to another model', async () => {
  const { backend, events, spawned } = makeBackend({
    getProviderProfile: () => ({ provider: CUSTOM_PROVIDER, modelId: 'glm-5.2' }),
    resolveRequestProfile: async () => { throw new Error('resolver must not run'); },
  });
  await backend.sendUser('mismatched model binding');
  assert.equal(spawned.calls.length, 0);
  assert.equal(events.some((event) => event.type === 'error' && /model binding/i.test(event.message)), true);
});

test('createCodexBackend preflights an unbound custom provider before spawn and sends the turn once', async () => {
  const recoveryCalls = [];
  let resolveCalls = 0;
  const { backend, events, spawned } = makeBackend({
    getProviderCandidate: () => selectedProvider(),
    getProviderProfile: () => null,
    recoverProviderProfile: async (provider, facts, modelId) => {
      recoveryCalls.push({ provider, facts, modelId });
      return selectedProvider(provider);
    },
    resolveRequestProfile: async () => {
      resolveCalls += 1;
      return resolvedModelProfile();
    },
  });

  const pending = backend.sendUser('preflight once');
  await waitFor(() => spawned.calls.length === 1, 'preflight did not create the verified runtime');
  assert.deepEqual(recoveryCalls, [{
    provider: CUSTOM_PROVIDER,
    facts: { status: null, code: 'provider_preflight_required' },
    modelId: PROVIDER_MODEL_ID,
  }]);
  assert.equal(resolveCalls, 0);

  const proc = spawned.procs[0];
  await waitFor(() => parseWrites(proc).length >= 1);
  respond(proc, parseWrites(proc)[0], {});
  await waitFor(() => parseWrites(proc).length >= 2);
  respond(proc, parseWrites(proc)[1], { threadId: 'thread_preflight' });
  await waitFor(() => parseWrites(proc).length >= 3);
  const turnStarts = parseWrites(proc).filter((message) => message.method === 'turn/start');
  assert.equal(turnStarts.length, 1);
  assert.equal(turnStarts[0].params.input[0].text, 'preflight once');
  respond(proc, turnStarts[0], {});
  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await pending;

  assert.equal(events.some((event) => event.type === 'error'), false);
  assert.equal(backend.getMessages().filter((message) => message.role === 'user').length, 1);
});

test('createCodexBackend reports a structured model error and never spawns when provider preflight fails', async () => {
  const { backend, events, spawned } = makeBackend({
    getProviderCandidate: () => selectedProvider(),
    getProviderProfile: () => null,
    recoverProviderProfile: async () => null,
    resolveRequestProfile: async () => { throw new Error('resolver must not run'); },
  });

  await backend.sendUser('must not reach official login');

  assert.equal(spawned.calls.length, 0);
  assert.deepEqual(events.filter((event) => event.type === 'error'), [{
    type: 'error',
    kind: 'model',
    code: 'provider_preflight_failed',
    message: 'Custom provider did not expose a verified API for model gpt-5.5',
  }]);
});

test('createCodexBackend reset prevents an in-flight provider preflight from spawning', async () => {
  const preflight = deferred();
  let recoveryCalls = 0;
  const { backend, spawned } = makeBackend({
    getProviderCandidate: () => selectedProvider(),
    getProviderProfile: () => null,
    recoverProviderProfile: async () => {
      recoveryCalls += 1;
      return preflight.promise;
    },
    resolveRequestProfile: async () => resolvedModelProfile(),
  });

  const pending = backend.sendUser('cancel preflight');
  await waitFor(() => recoveryCalls === 1);
  backend.reset();
  preflight.resolve(selectedProvider());
  await pending;
  await flush();

  assert.equal(spawned.calls.length, 0);
  assert.deepEqual(backend.getMessages(), []);
});

test('createCodexBackend invalidates a runtime when provider URL and cache revisions change', async () => {
  let candidateProvider = providerFixtureV3();
  const recoveryCalls = [];
  const routeCalls = [];
  let closed = 0;
  const { backend, spawned } = makeBackend({
    createProviderRoute: (input) => {
      routeCalls.push(input);
      return localProviderRoute({
        routeToken: `local-route-${routeCalls.length}`,
        close: async () => { closed += 1; },
      });
    },
    getProviderCandidate: () => selectedProvider(candidateProvider),
    getProviderProfile: () => null,
    recoverProviderProfile: async (provider, _facts, modelId) => {
      recoveryCalls.push({ provider, modelId });
      return selectedProvider(provider);
    },
    resolveRequestProfile: async () => resolvedModelProfile(),
  });

  const first = await startTurn(backend, spawned, 'first provider revision');
  first.proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await first.pending;
  candidateProvider = providerFixtureV3({
    baseUrl: 'https://proxy.example/changed/v1',
    requestProfileRevision: 2,
    modelListRevision: 2,
  });

  const secondPending = backend.sendUser('changed provider revision');
  await waitFor(() => spawned.calls.length === 2, 'edited provider reused a stale runtime override');

  assert.equal(recoveryCalls.length, 2);
  assert.equal(recoveryCalls[1].provider, candidateProvider);
  assert.equal(routeCalls[1].provider, candidateProvider);
  assert.equal(spawned.procs[0].killed, true);
  assert.equal(closed, 1);
  assert.deepEqual(spawned.calls[1].args, expectedLocalProviderArgs());
  backend.reset();
  await secondPending;
});

test('createCodexBackend redacts a local route token split across Codex deltas and transcript', async () => {
  const { backend, events, spawned } = makeBackend({
    createProviderRoute: () => localProviderRoute({ routeToken: 'split-secret-marker' }),
    getProviderProfile: () => selectedProvider(),
    resolveRequestProfile: async () => resolvedModelProfile(),
  });
  const { pending, proc } = await startTurn(backend, spawned, 'redact provider output');
  proc.pushStdout({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { delta: 'split-secret-' } });
  proc.pushStdout({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { delta: 'marker' } });
  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await pending;
  assert.equal(JSON.stringify(events).includes('split-secret-marker'), false);
  assert.equal(JSON.stringify(backend.getMessages()).includes('split-secret-marker'), false);
});

test('createCodexBackend redacts the local route token from stderr failures', async () => {
  const provider = providerForProtocol('chat');
  const { backend, events, spawned } = makeBackend({
    createProviderRoute: () => localProviderRoute({ routeToken: 'local-route-secret' }),
    getProviderProfile: () => selectedProvider(provider),
    resolveRequestProfile: async () => resolvedModelProfile(),
  });
  const { pending, proc } = await startTurn(backend, spawned, 'redact route stderr');
  proc.pushStderr('route failed with local-route-');
  proc.pushStderr('secret');
  proc.exit(1);
  await pending;
  assert.equal(JSON.stringify(events).includes('local-route-secret'), false);
});
test('createCodexBackend injects cli-config provider env var when no custom provider is configured', async () => {
  const { backend, spawned } = makeBackend({
    getCliConfigProvider: () => ({
      provider: { envKey: 'MEDIASTORM_GLM_API_KEY', baseUrl: 'https://api.example.com/v1' },
      apiKey: 'stored-codex-key',
    }),
  });

  const { pending, proc } = await startTurn(backend, spawned, 'cli-config env');

  assert.equal(spawned.calls[0].command, 'C:\\Tools\\codex.exe');
  // config.toml already declares model_provider; no -c override args.
  assert.deepEqual(spawned.calls[0].args, ['app-server']);
  assert.equal(spawned.calls[0].options.env.MEDIASTORM_GLM_API_KEY, 'stored-codex-key');
  assert.equal(Object.hasOwn(spawned.calls[0].sourceOptions.env, 'MEDIASTORM_GLM_API_KEY'), false);

  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await pending;
});

test('createCodexBackend reads cli-config provider lazily for each spawn', async () => {
  let cliConfig = {
    provider: { envKey: 'MEDIASTORM_GLM_API_KEY', baseUrl: 'https://api.example.com/v1' },
    apiKey: 'first-key',
  };
  const { backend, spawned } = makeBackend({
    getCliConfigProvider: () => cliConfig,
  });

  const { pending, proc } = await startTurn(backend, spawned, 'first cli-config env');
  assert.equal(spawned.calls[0].options.env.MEDIASTORM_GLM_API_KEY, 'first-key');
  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await pending;

  backend.reset();
  cliConfig = {
    provider: { envKey: 'MEDIASTORM_GLM_API_KEY', baseUrl: 'https://api.example.com/v1' },
    apiKey: 'second-key',
  };

  const second = backend.sendUser('second cli-config env');
  await flush();
  const proc2 = spawned.procs[1];
  respond(proc2, parseWrites(proc2)[0], {});
  await flush();
  respond(proc2, parseWrites(proc2)[1], { threadId: 'thread_2' });
  await flush();
  respond(proc2, parseWrites(proc2)[2], {});
  assert.equal(spawned.calls.length, 2);
  assert.equal(spawned.calls[1].options.env.MEDIASTORM_GLM_API_KEY, 'second-key');
  proc2.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await second;
});

test('createCodexBackend prefers an explicit custom provider over cli-config inheritance', async () => {
  let resolveCalls = 0;
  const { backend, spawned } = makeBackend({
    createProviderRoute: () => localProviderRoute({ routeToken: 'explicit-local-key' }),
    getProviderProfile: () => selectedProvider(),
    resolveRequestProfile: async () => {
      resolveCalls += 1;
      return resolvedModelProfile();
    },
    getCliConfigProvider: () => ({
      provider: { envKey: 'MEDIASTORM_GLM_API_KEY', baseUrl: 'https://api.example.com/v1' },
      apiKey: 'stored-codex-key',
    }),
  });

  const { pending, proc } = await startTurn(backend, spawned, 'custom wins');

  assert.deepEqual(spawned.calls[0].args, expectedLocalProviderArgs());
  assert.equal(resolveCalls, 0);
  assert.equal(spawned.calls[0].options.env.AE_MCP_PROVIDER_HEADER_00, 'explicit-local-key');
  assert.equal(Object.hasOwn(spawned.calls[0].options.env, 'MEDIASTORM_GLM_API_KEY'), false);
  assert.doesNotMatch(JSON.stringify(spawned.calls[0].options.env), /stored-codex-key|resolved-model-secret/);

  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await pending;
});

test('createCodexBackend reuses threadId on subsequent turns', async () => {
  const { backend, spawned } = makeBackend({
    getFast: () => false,
    getPermissionMode: () => 'auto',
  });
  const { pending, proc } = await startTurn(backend, spawned, 'one');
  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await pending;

  const second = backend.sendUser('two');
  await flush();
  const writes = parseWrites(proc);
  assert.equal(writes.filter((w) => w.method === 'thread/start').length, 1);
  const secondTurn = writes.at(-1);
  assert.equal(secondTurn.method, 'turn/start');
  assert.equal(secondTurn.params.threadId, 'thread_1');
  assert.equal(secondTurn.params.input[0].text, 'two');
  assert.equal(Object.hasOwn(secondTurn.params, 'serviceTier'), false);
  respond(proc, secondTurn, {});
  await flush();
  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await second;
});

test('createCodexBackend maps app-server turn and tool notifications to panel events', async () => {
  const { backend, events, spawned } = makeBackend();
  const { pending, proc } = await startTurn(backend, spawned, 'events');

  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thread_1' } });
  proc.pushStdout({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { phase: 'final_answer', delta: 'hi' } });
  proc.pushStdout({
    jsonrpc: '2.0',
    method: 'item/started',
    params: { item: { type: 'mcpToolCall', id: 'call_x', server: 'ae', tool: 'ae_ping', arguments: {} } },
  });
  proc.pushStdout({
    jsonrpc: '2.0',
    method: 'item/completed',
    params: {
      item: {
        type: 'mcpToolCall',
        id: 'call_x',
        server: 'ae',
        tool: 'ae_ping',
        status: 'completed',
        arguments: {},
        result: { content: [{ type: 'text', text: '{"ok": true}' }] },
        error: null,
        durationMs: 53,
      },
    },
  });
  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await pending;

  assert.deepEqual(events, [
    { type: 'turn-start' },
    { type: 'thinking', active: false },
    { type: 'text-delta', text: 'hi', phase: 'final_answer' },
    { type: 'tool-start', toolUseId: 'call_x', name: 'mcp__ae__ae_ping', input: {} },
    { type: 'tool-result', toolUseId: 'call_x', name: 'mcp__ae__ae_ping', ok: true, text: '{"ok": true}', durationMs: 53 },
    { type: 'turn-end', stopReason: 'end_turn' },
  ]);
});

test('createCodexBackend ignores transient app-server reconnect error notifications', async () => {
  const { backend, events, spawned } = makeBackend();
  const { pending, proc } = await startTurn(backend, spawned, 'reconnect');
  let settled = false;
  pending.then(() => {
    settled = true;
  });

  proc.pushStdout({ jsonrpc: '2.0', method: 'error', params: { error: { message: 'Reconnecting... 1/5' } } });
  await flush();

  assert.equal(events.some((evt) => evt.type === 'error'), false);
  assert.equal(settled, false);

  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await pending;
  assert.equal(settled, true);
});

test('createCodexBackend treats non-reconnect app-server errors as terminal', async () => {
  const { backend, events, spawned } = makeBackend();
  const { pending, proc } = await startTurn(backend, spawned, 'real error');
  let settled = false;
  pending.then(() => {
    settled = true;
  });

  proc.pushStdout({ jsonrpc: '2.0', method: 'error', params: { error: { kind: 'mcp', message: 'MCP server failed' } } });
  await pending;
  await flush();

  assert.deepEqual(events.at(-1), { type: 'error', kind: 'mcp', message: 'MCP server failed' });
  assert.equal(settled, true);
});

test('createCodexBackend emits one model error when RPC rejection and error notification race', async () => {
  const { backend, events, spawned } = makeBackend();
  const { pending, proc, turnStart } = await startTurnRequest(backend, spawned, 'one terminal error');
  const error = {
    message: 'unexpected status 403 Forbidden: Unknown error, url: https://provider.example/v1/responses',
  };

  proc.pushStdout({ id: turnStart.id, error });
  proc.pushStdout({ jsonrpc: '2.0', method: 'error', params: { error } });
  await pending;
  await flush();

  assert.deepEqual(events.filter((event) => event.type === 'error'), [{
    type: 'error',
    kind: 'model',
    message: error.message,
  }]);
});

test('createCodexBackend re-detects a recoverable provider once and retries the same turn', async () => {
  const recoveredProvider = providerFixtureV3({ baseUrl: 'https://recovered.example/v1' });
  const recoveryCalls = [];
  const routeCalls = [];
  let resolveCalls = 0;
  let refreshed = 0;
  const { backend, events, spawned } = makeBackend({
    createProviderRoute: (input) => {
      routeCalls.push(input);
      return localProviderRoute({ routeToken: `recovery-route-${routeCalls.length}` });
    },
    getProviderProfile: () => selectedProvider(),
    resolveRequestProfile: async () => {
      resolveCalls += 1;
      return resolvedModelProfile();
    },
    recoverProviderProfile: async (provider, facts, modelId) => {
      recoveryCalls.push({ provider, facts, modelId });
      return selectedProvider(recoveredProvider);
    },
    onProviderProfileRecovered: () => { refreshed += 1; },
  });
  const { pending, proc } = await startTurn(backend, spawned, 'retry this turn');

  proc.pushStdout({ jsonrpc: '2.0', method: 'error', params: { error: { status: 404, message: 'HTTP status 404' } } });
  for (let index = 0; index < 20 && spawned.procs.length < 2; index += 1) await flush();
  assert.equal(spawned.procs.length, 2);
  assert.equal(proc.killed, true);
  assert.equal(recoveryCalls.length, 1);
  assert.equal(recoveryCalls[0].provider, CUSTOM_PROVIDER);
  assert.deepEqual(recoveryCalls[0].facts, { status: 404, code: '' });
  assert.equal(recoveryCalls[0].modelId, PROVIDER_MODEL_ID);
  assert.equal(resolveCalls, 0);

  const proc2 = spawned.procs[1];
  assert.equal(routeCalls.length, 2);
  assert.equal(routeCalls[1].provider, recoveredProvider);
  assert.deepEqual(spawned.calls[1].args, expectedLocalProviderArgs());
  let settled = false;
  pending.then(() => { settled = true; });
  proc.pushStdout({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { delta: 'stale' } });
  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  proc.exit(1);
  await flush();
  assert.equal(settled, false);

  const init = parseWrites(proc2)[0];
  respond(proc2, init, {});
  await flush();
  const threadStart = parseWrites(proc2)[1];
  respond(proc2, threadStart, { threadId: 'thread_recovered' });
  await flush();
  const retriedTurn = parseWrites(proc2)[2];
  assert.equal(retriedTurn.params.input[0].text, 'retry this turn');
  respond(proc2, retriedTurn, {});
  proc2.pushStdout({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { delta: 'recovered' } });
  proc2.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await pending;
  await flush();

  assert.equal(events.some((event) => event.type === 'error'), false);
  assert.equal(backend.getMessages().filter((message) => message.role === 'user').length, 1);
  assert.equal(backend.getMessages().at(-1).text, 'recovered');
  assert.equal(refreshed, 1);
});

test('createCodexBackend re-detects generic 405 and 501 provider failures', async (context) => {
  for (const status of [405, 501]) {
    await context.test(`HTTP ${status}`, async () => {
      let recoveryCalls = 0;
      const { backend, events, spawned } = makeBackend({
        getProviderProfile: () => selectedProvider(),
        resolveRequestProfile: async () => resolvedModelProfile(),
        recoverProviderProfile: async (provider, _facts, modelId) => {
          recoveryCalls += 1;
          return { provider, modelId };
        },
      });
      const { pending, proc } = await startTurn(backend, spawned, `recover ${status}`);
      proc.pushStdout({
        jsonrpc: '2.0',
        method: 'error',
        params: { error: { status, message: `HTTP status ${status}` } },
      });
      await waitFor(() => spawned.procs.length === 2);

      const recoveredProc = spawned.procs[1];
      await waitFor(() => parseWrites(recoveredProc).length >= 1);
      respond(recoveredProc, parseWrites(recoveredProc)[0], {});
      await waitFor(() => parseWrites(recoveredProc).length >= 2);
      respond(recoveredProc, parseWrites(recoveredProc)[1], { threadId: `thread_${status}` });
      await waitFor(() => parseWrites(recoveredProc).length >= 3);
      respond(recoveredProc, parseWrites(recoveredProc)[2], {});
      recoveredProc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
      await pending;

      assert.equal(recoveryCalls, 1);
      assert.equal(events.some((event) => event.type === 'error'), false);
    });
  }
});

test('createCodexBackend never retries a recoverable provider failure more than once per turn', async () => {
  let recoveryCalls = 0;
  const recoveredProvider = providerFixtureV3({ baseUrl: 'https://recovered.example/v1' });
  const { backend, events, spawned } = makeBackend({
    getProviderProfile: () => selectedProvider(),
    resolveRequestProfile: async () => resolvedModelProfile(),
    recoverProviderProfile: async () => {
      recoveryCalls += 1;
      return selectedProvider(recoveredProvider);
    },
  });
  const { pending, proc } = await startTurn(backend, spawned, 'retry only once');
  proc.pushStdout({ jsonrpc: '2.0', method: 'error', params: { error: { statusCode: 404, message: 'HTTP status 404' } } });
  for (let index = 0; index < 20 && spawned.procs.length < 2; index += 1) await flush();
  const proc2 = spawned.procs[1];
  respond(proc2, parseWrites(proc2)[0], {});
  await flush();
  respond(proc2, parseWrites(proc2)[1], { threadId: 'thread_retry_once' });
  await flush();
  respond(proc2, parseWrites(proc2)[2], {});
  proc2.pushStdout({ jsonrpc: '2.0', method: 'error', params: { error: { httpStatus: 404, message: 'HTTP status 404' } } });
  await pending;
  await flush();
  assert.equal(recoveryCalls, 1);
  assert.equal(spawned.procs.length, 2);
  assert.equal(events.at(-1).type, 'error');
});

test('createCodexBackend keeps the original route error redacted when re-detection fails', async () => {
  const { backend, events, spawned } = makeBackend({
    createProviderRoute: () => localProviderRoute({ routeToken: 'recovery-secret-marker' }),
    getProviderProfile: () => selectedProvider(),
    resolveRequestProfile: async () => resolvedModelProfile(),
    recoverProviderProfile: async () => null,
  });
  const { pending, proc } = await startTurn(backend, spawned, 'failed re-detect');
  proc.pushStdout({
    jsonrpc: '2.0',
    method: 'error',
    params: { error: { status: 404, message: 'HTTP status 404 echoed recovery-secret-marker' } },
  });
  await pending;
  assert.equal(JSON.stringify(events).includes('recovery-secret-marker'), false);
  assert.equal(spawned.procs.length, 1);
});

test('createCodexBackend never re-detects the exact compact unsupported contract', async () => {
  let recoveryCalls = 0;
  const provider = providerForProtocol('chat');
  const { backend, events, spawned } = makeBackend({
    getProviderProfile: () => selectedProvider(provider),
    resolveRequestProfile: async () => resolvedModelProfile(),
    createProviderRoute: () => localProviderRoute({ routeToken: 'local-route-secret' }),
    recoverProviderProfile: async () => {
      recoveryCalls += 1;
      return selectedProvider(provider);
    },
  });
  const { pending, proc } = await startTurn(backend, spawned, 'compact contract');
  proc.pushStdout({
    jsonrpc: '2.0',
    method: 'error',
    params: {
      error: {
        code: 'provider_compaction_unsupported',
        status: 501,
        message: 'unsupported endpoint request',
      },
    },
  });
  await pending;
  assert.equal(recoveryCalls, 0);
  assert.equal(spawned.procs.length, 1);
  assert.equal(events.at(-1).type, 'error');
});

test('createCodexBackend never re-detects compact unsupported contracts retained only in a 501 message', async (context) => {
  for (const message of [
    'HTTP status 501: provider_compaction_unsupported',
    'This chat-only provider cannot compact Responses context.',
  ]) {
    await context.test(message, async () => {
      let recoveryCalls = 0;
      const provider = providerForProtocol('chat');
      const { backend, events, spawned } = makeBackend({
        getProviderProfile: () => selectedProvider(provider),
        resolveRequestProfile: async () => resolvedModelProfile(),
        createProviderRoute: () => localProviderRoute({ routeToken: 'local-route-secret' }),
        recoverProviderProfile: async () => {
          recoveryCalls += 1;
          return selectedProvider(provider);
        },
      });
      const { pending, proc } = await startTurn(backend, spawned, 'compact message contract');
      proc.pushStdout({
        jsonrpc: '2.0',
        method: 'error',
        params: { error: { status: 501, message } },
      });
      await pending;

      assert.equal(recoveryCalls, 0);
      assert.equal(spawned.procs.length, 1);
      assert.equal(events.at(-1).type, 'error');
    });
  }
});

test('createCodexBackend reset prevents an in-flight provider recovery from reviving runtime', async () => {
  let releaseRecovery;
  let recoveryCalls = 0;
  let refreshed = 0;
  const recovery = new Promise((resolve) => { releaseRecovery = resolve; });
  const { backend, spawned } = makeBackend({
    getProviderProfile: () => selectedProvider(),
    resolveRequestProfile: async () => resolvedModelProfile(),
    recoverProviderProfile: async () => {
      recoveryCalls += 1;
      return recovery;
    },
    onProviderProfileRecovered: () => { refreshed += 1; },
  });
  const { pending, proc } = await startTurn(backend, spawned, 'reset during recovery');
  proc.pushStdout({ jsonrpc: '2.0', method: 'error', params: { error: { code: 'unsupported_endpoint', message: 'unsupported endpoint' } } });
  for (let index = 0; index < 20 && recoveryCalls < 1; index += 1) await flush();
  assert.equal(recoveryCalls, 1);
  backend.reset();
  releaseRecovery(selectedProvider(providerFixtureV3({ baseUrl: 'https://late.example/v1' })));
  await pending;
  await flush();
  await flush();
  assert.equal(spawned.procs.length, 1);
  assert.equal(refreshed, 0);
  assert.deepEqual(backend.getMessages(), []);
});

test('createCodexBackend reset prevents an in-flight local route start from spawning later', async () => {
  const routeStart = deferred();
  let startCalls = 0;
  let closed = 0;
  let resolveCalls = 0;
  const { backend, spawned } = makeBackend({
    createProviderRoute: () => ({
      start: async () => {
        startCalls += 1;
        return routeStart.promise;
      },
      close: async () => { closed += 1; },
    }),
    getProviderProfile: () => selectedProvider(),
    resolveRequestProfile: async () => {
      resolveCalls += 1;
      return resolvedModelProfile();
    },
  });
  const pending = backend.sendUser('reset before spawn');
  await waitFor(() => startCalls === 1);
  assert.equal(resolveCalls, 0);
  backend.reset();
  routeStart.resolve({
    origin: 'http://127.0.0.1:49123',
    openaiBaseUrl: 'http://127.0.0.1:49123/v1',
    routeToken: 'late-local-route',
  });
  await pending;
  await flush();
  assert.equal(spawned.calls.length, 0);
  assert.equal(closed, 1);
  assert.deepEqual(backend.getMessages(), []);
});

test('codex approval adapter applies four tiers and annotations', async () => {
  const cases = [
    { mode: 'none', tool: 'ae_exec', params: { code: 'app.project' }, response: 'accept', event: null },
    { mode: 'readonly', tool: 'ae_setProperty', params: { value: 1 }, response: 'decline', event: { type: 'tool-denied', toolUseId: 'ask_readonly' }, id: 'ask_readonly' },
    { mode: 'auto', tool: 'ae_setProperty', params: { value: 2 }, response: 'accept', event: null },
    { mode: 'auto', tool: 'ae_exec', params: { code: 'app.project' }, response: null, event: { type: 'approval-required', toolUseId: 'ask_auto', name: 'mcp__ae__ae_exec', input: { code: 'app.project' }, risk: 'destructive' }, id: 'ask_auto' },
    { mode: 'manual', tool: 'ae_overview', params: {}, response: 'accept', event: null },
  ];

  for (const item of cases) {
    const { backend, events, spawned } = makeBackend({ getPermissionMode: () => item.mode });
    const { pending, proc } = await startTurn(backend, spawned, item.mode);
    const id = item.id || `ask_${item.mode}`;
    pushElicitation(proc, id, realElicitation(item.tool, item.params));

    if (item.response) {
      assert.deepEqual(parseWrites(proc).at(-1), { jsonrpc: '2.0', id, result: { action: item.response, content: {} } });
      assert.equal(events.some((evt) => evt.type === 'approval-required'), false);
    } else {
      assert.deepEqual(events.at(-1), item.event);
    }
    if (item.event && item.event.type === 'tool-denied') assert.deepEqual(events.at(-1), item.event);
    proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
    await pending;
  }
});

test('manual approval allow, allow-session, and deny write elicitation responses', async () => {
  const { backend, events, spawned } = makeBackend();
  const { pending, proc } = await startTurn(backend, spawned, 'approve');

  pushElicitation(proc, 'ask_1', realElicitation('ae_exec', { code: 'app.project' }));
  assert.deepEqual(events.at(-1), {
    type: 'approval-required',
    toolUseId: 'ask_1',
    name: 'mcp__ae__ae_exec',
    input: { code: 'app.project' },
    risk: 'destructive',
  });
  backend.approve('ask_1', 'allow');
  assert.deepEqual(parseWrites(proc).at(-1), { jsonrpc: '2.0', id: 'ask_1', result: { action: 'accept', content: {} } });
  assert.deepEqual(events.at(-1), { type: 'tool-allowed', toolUseId: 'ask_1' });

  pushElicitation(proc, 'ask_2', realElicitation('ae_exec', { code: 'app.project.item(1).remove()' }));
  backend.approve('ask_2', 'allow-session');
  assert.deepEqual(parseWrites(proc).at(-1), { jsonrpc: '2.0', id: 'ask_2', result: { action: 'accept', content: {} } });
  assert.deepEqual(events.at(-1), { type: 'tool-allowed', toolUseId: 'ask_2' });

  const eventCount = events.length;
  pushElicitation(proc, 'ask_3', realElicitation('ae_exec', { code: 'app.project' }));
  assert.deepEqual(parseWrites(proc).at(-1), { jsonrpc: '2.0', id: 'ask_3', result: { action: 'accept', content: {} } });
  assert.equal(events.length, eventCount);

  pushElicitation(proc, 22, realElicitation('ae_setProperty', { value: 3 }));
  backend.approve('22', 'deny');
  assert.deepEqual(events.at(-1), { type: 'tool-denied', toolUseId: '22' });
  assert.deepEqual(parseWrites(proc).at(-1), { jsonrpc: '2.0', id: 22, result: { action: 'decline', content: {} } });

  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await pending;
});

test('elicitation tool name parsing supports message regex and tool_description fallback', async () => {
  const { backend, events, spawned } = makeBackend();
  const { pending, proc } = await startTurn(backend, spawned, 'parse');

  pushElicitation(proc, 'ask_msg', realElicitation('ae_setProperty', { value: 4 }));
  assert.deepEqual(events.at(-1), {
    type: 'approval-required',
    toolUseId: 'ask_msg',
    name: 'mcp__ae__ae_setProperty',
    input: { value: 4 },
    risk: 'write',
  });
  backend.approve('ask_msg', 'deny');

  const fallback = realElicitation('ae_exec', { code: 'app.project' });
  delete fallback.message;
  pushElicitation(proc, 'ask_desc', fallback);
  assert.deepEqual(events.at(-1), {
    type: 'approval-required',
    toolUseId: 'ask_desc',
    name: 'mcp__ae__ae_exec',
    input: { code: 'app.project' },
    risk: 'destructive',
  });

  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await pending;
});

test('Codex none tier still asks for an external artifact plan', async () => {
  const externalPlan = { ...WRITE_PLAN, risk: 'external' };
  const { backend, events, spawned } = makeBackend({ getPermissionMode: () => 'none' });
  const { pending, proc } = await startTurn(backend, spawned, 'publish');

  pushElicitation(proc, 'plan_external', planElicitation(externalPlan));
  assert.deepEqual(events.at(-1), {
    type: 'approval-required',
    toolUseId: 'plan_external',
    name: 'mcp__ae__ae_toolUse',
    input: externalPlan,
    risk: 'external',
  });

  backend.approve('plan_external', 'allow');
  assert.deepEqual(parseWrites(proc).at(-1), {
    jsonrpc: '2.0',
    id: 'plan_external',
    result: { action: 'accept', content: { decision: 'once' } },
  });
  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await pending;
});

test('Codex auto accepts write plans once and declines malformed plans without cards', async () => {
  const { backend, events, spawned } = makeBackend({ getPermissionMode: () => 'auto' });
  const { pending, proc } = await startTurn(backend, spawned, 'apply');

  pushElicitation(proc, 'plan_auto', planElicitation(WRITE_PLAN));
  assert.deepEqual(parseWrites(proc).at(-1), {
    jsonrpc: '2.0',
    id: 'plan_auto',
    result: { action: 'accept', content: { decision: 'once' } },
  });

  pushElicitation(proc, 'plan_bad', planElicitation({ risk: 'write' }));
  assert.deepEqual(parseWrites(proc).at(-1), {
    jsonrpc: '2.0',
    id: 'plan_bad',
    result: { action: 'decline', content: {} },
  });
  assert.equal(events.some((event) => event.type === 'approval-required'), false);
  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await pending;
});

test('Codex plan approval fails closed for unknown or missing decisions', async () => {
  const { backend, spawned } = makeBackend();
  const { pending, proc } = await startTurn(backend, spawned, 'decide');

  for (const [id, decision] of [['plan_unknown', 'unexpected'], ['plan_missing', undefined]]) {
    pushElicitation(proc, id, planElicitation(WRITE_PLAN));
    backend.approve(id, decision);
    assert.deepEqual(parseWrites(proc).at(-1), {
      jsonrpc: '2.0',
      id,
      result: { action: 'decline', content: {} },
    });
  }

  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await pending;
});

test('Codex plan sessions bind content and target while high risks reject session scope', async () => {
  const changedHash = { ...WRITE_PLAN, contentHash: 'c'.repeat(64), planHash: 'd'.repeat(64) };
  const changedTarget = { ...WRITE_PLAN, target: { compId: '8' }, planHash: 'e'.repeat(64) };
  const destructivePlan = { ...WRITE_PLAN, risk: 'destructive' };
  const { backend, events, spawned } = makeBackend();
  const { pending, proc } = await startTurn(backend, spawned, 'apply plans');

  pushElicitation(proc, 'plan_1', planElicitation(WRITE_PLAN));
  backend.approve('plan_1', 'allow-session');
  assert.deepEqual(parseWrites(proc).at(-1), {
    jsonrpc: '2.0',
    id: 'plan_1',
    result: { action: 'accept', content: { decision: 'session' } },
  });

  const cardsAfterSession = events.filter((event) => event.type === 'approval-required').length;
  pushElicitation(proc, 'plan_same', planElicitation(WRITE_PLAN));
  assert.deepEqual(parseWrites(proc).at(-1), {
    jsonrpc: '2.0',
    id: 'plan_same',
    result: { action: 'accept', content: { decision: 'once' } },
  });
  assert.equal(events.filter((event) => event.type === 'approval-required').length, cardsAfterSession);

  pushElicitation(proc, 'plan_hash', planElicitation(changedHash));
  assert.equal(events.at(-1).toolUseId, 'plan_hash');
  assert.deepEqual(events.at(-1).input, changedHash);
  backend.approve('plan_hash', 'allow');

  pushElicitation(proc, 'plan_target', planElicitation(changedTarget));
  assert.equal(events.at(-1).toolUseId, 'plan_target');
  assert.deepEqual(events.at(-1).input, changedTarget);
  backend.approve('plan_target', 'allow');

  pushElicitation(proc, 'plan_high', planElicitation(destructivePlan));
  assert.equal(events.at(-1).risk, 'destructive');
  backend.approve('plan_high', 'allow-session');
  assert.deepEqual(parseWrites(proc).at(-1), {
    jsonrpc: '2.0',
    id: 'plan_high',
    result: { action: 'decline', content: {} },
  });

  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await pending;
});

test('Codex delegates valid staged ae_toolUse calls without caching the tool name', async () => {
  const { backend, events, spawned } = makeBackend();
  const { pending, proc } = await startTurn(backend, spawned, 'stage');

  pushElicitation(proc, 'stage_valid', realElicitation('ae_toolUse', { action: 'prepare' }));
  assert.deepEqual(parseWrites(proc).at(-1), {
    jsonrpc: '2.0',
    id: 'stage_valid',
    result: { action: 'accept', content: {} },
  });

  pushElicitation(proc, 'stage_invalid', realElicitation('ae_toolUse', { action: 'invalid' }));
  assert.deepEqual(events.at(-1), {
    type: 'approval-required',
    toolUseId: 'stage_invalid',
    name: 'mcp__ae__ae_toolUse',
    input: { action: 'invalid' },
    risk: 'write',
  });
  backend.approve('stage_invalid', 'allow');
  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await pending;
});

test('thinking events track reasoning start, completion, and answer delta', async () => {
  const { backend, events, spawned } = makeBackend();
  const { pending, proc } = await startTurn(backend, spawned, 'think');

  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thread_1' } });
  proc.pushStdout({ jsonrpc: '2.0', method: 'item/started', params: { item: { type: 'reasoning', id: 'r1' } } });
  proc.pushStdout({ jsonrpc: '2.0', method: 'item/completed', params: { item: { type: 'reasoning', id: 'r1' } } });
  proc.pushStdout({ jsonrpc: '2.0', method: 'item/started', params: { item: { type: 'reasoning', id: 'r2' } } });
  proc.pushStdout({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { delta: 'done' } });

  assert.deepEqual(events.filter((evt) => evt.type === 'thinking'), [
    { type: 'thinking', active: true },
    { type: 'thinking', active: false },
    { type: 'thinking', active: true },
    { type: 'thinking', active: false },
  ]);

  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await pending;
});

test('createCodexBackend stop interrupts the turn, drains pending approvals, and emits aborted error', async () => {
  const { backend, events, spawned } = makeBackend();
  const { pending, proc } = await startTurn(backend, spawned, 'stop');

  proc.pushStdout({ method: 'turn/started', params: { threadId: 'thread_1', turn: { id: 'turn_1' } } });
  pushElicitation(proc, 'ask_stop', realElicitation('ae_exec', {}));
  backend.stop();
  const writes = parseWrites(proc);

  assert.equal(writes.at(-2).method, 'turn/interrupt');
  assert.deepEqual(writes.at(-2).params, { threadId: 'thread_1', turnId: 'turn_1' });
  assert.deepEqual(writes.at(-1), { jsonrpc: '2.0', id: 'ask_stop', result: { action: 'decline', content: {} } });
  assert.deepEqual(events.slice(-2), [
    { type: 'tool-denied', toolUseId: 'ask_stop' },
    { type: 'error', kind: 'aborted', message: 'Turn aborted.' },
  ]);
  await pending;
});

test('createCodexBackend reset kills the app-server process and clears thread state', async () => {
  const { backend, spawned } = makeBackend();
  const { pending: first, proc } = await startTurn(backend, spawned, 'one');

  backend.reset();
  assert.equal(proc.killed, true);
  await first;

  const second = backend.sendUser('two');
  await flush();
  assert.equal(spawned.calls.length, 2);
  const proc2 = spawned.procs[1];
  respond(proc2, parseWrites(proc2)[0], {});
  await flush();
  respond(proc2, parseWrites(proc2)[1], { threadId: 'thread_2' });
  await flush();
  respond(proc2, parseWrites(proc2)[2], {});
  proc2.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await second;
});

test('createCodexBackend prepends server instructions as a preamble on the first turn only', async () => {
  const { backend, spawned } = makeBackend({ getServerInstructions: () => 'CODEX_PREAMBLE' });
  const { pending, proc } = await startTurn(backend, spawned, 'first message');

  const firstTurn = parseWrites(proc).at(-1);
  assert.equal(firstTurn.method, 'turn/start');
  const firstText = firstTurn.params.input[0].text;
  assert.ok(firstText.startsWith('CODEX_PREAMBLE'));
  assert.ok(firstText.includes('first message'));

  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await pending;

  const second = backend.sendUser('second message');
  await flush();
  const secondTurn = parseWrites(proc).at(-1);
  assert.equal(secondTurn.method, 'turn/start');
  assert.equal(secondTurn.params.threadId, 'thread_1');
  // The preamble lives in thread history; the second turn must not repeat it.
  assert.equal(secondTurn.params.input[0].text, 'second message');
  assert.equal(secondTurn.params.input[0].text.includes('CODEX_PREAMBLE'), false);
  respond(proc, secondTurn, {});
  await flush();
  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await second;
});

test('createCodexBackend re-sends the preamble after a thread reset', async () => {
  const { backend, spawned } = makeBackend({ getServerInstructions: () => 'CODEX_PREAMBLE' });
  const { pending, proc } = await startTurn(backend, spawned, 'before reset');
  assert.ok(parseWrites(proc).at(-1).params.input[0].text.startsWith('CODEX_PREAMBLE'));
  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await pending;

  backend.reset();
  await pending;

  // A brand-new thread (after reset) spawns a fresh process and must re-send
  // the preamble. Drive the new proc manually since startTurn targets procs[0].
  const second = backend.sendUser('after reset');
  await flush();
  const proc2 = spawned.procs[1];
  respond(proc2, parseWrites(proc2)[0], {});
  await flush();
  respond(proc2, parseWrites(proc2)[1], { threadId: 'thread_2' });
  await flush();
  const turn = parseWrites(proc2)[2];
  assert.equal(turn.method, 'turn/start');
  assert.ok(turn.params.input[0].text.startsWith('CODEX_PREAMBLE'));
  assert.ok(turn.params.input[0].text.includes('after reset'));
  respond(proc2, turn, {});
  await flush();
  proc2.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await second;
});

test('createCodexBackend probeAccount initializes and reads account plus model list', async () => {
  const { backend, spawned } = makeBackend();
  const probe = backend.probeAccount();
  await flush();
  const proc = spawned.procs[0];
  assert.equal(spawned.calls[0].command, 'C:\\Tools\\codex.exe');
  respond(proc, parseWrites(proc)[0], {});
  await flush();
  assert.equal(parseWrites(proc)[1].method, 'account/read');
  respond(proc, parseWrites(proc)[1], { account: { type: 'chatgpt', email: 'a@example.com', planType: 'plus' } });
  await flush();
  assert.equal(parseWrites(proc)[2].method, 'model/list');
  respond(proc, parseWrites(proc)[2], { models: [{ id: 'gpt-5.5', displayName: 'GPT-5.5', hidden: false }] });

  assert.deepEqual(await probe, {
    loggedIn: true,
    runtimeOk: true,
    email: 'a@example.com',
    planType: 'plus',
    models: [{ id: 'gpt-5.5', displayName: 'GPT-5.5', hidden: false }],
    cliPath: 'C:\\Tools\\codex.exe',
    cliVersion: '1.0.0',
  });
});

test('createCodexBackend probeAccount reports runtime ok when OpenAI auth is absent', async () => {
  const { backend, spawned } = makeBackend();
  const probe = backend.probeAccount();
  await flush();
  const proc = spawned.procs[0];
  respond(proc, parseWrites(proc)[0], {});
  await flush();
  respond(proc, parseWrites(proc)[1], { requiresOpenaiAuth: true });
  await flush();
  respond(proc, parseWrites(proc)[2], { models: [] });

  assert.deepEqual(await probe, {
    loggedIn: false,
    runtimeOk: true,
    detail: 'OpenAI auth required',
    models: [],
    cliPath: 'C:\\Tools\\codex.exe',
    cliVersion: '1.0.0',
  });
});

test('spawn env is completed with USERPROFILE/HOME/APPDATA (spec B2)', async () => {
  const { backend, spawned } = makeBackend({ env: { PATH: 'C:\\bin', HOME: 'C:\\Users\\test' } });
  backend.sendUser('hi');
  await flush();
  const call = spawned.calls[0];
  assert.equal(call.options.env.USERPROFILE, 'C:\\Users\\test');
  assert.equal(call.options.env.APPDATA, 'C:\\Users\\test\\AppData\\Roaming');
  backend.reset();
});

test('AE_MCP_CODEX_CLI overrides the spawned codex binary', async () => {
  const { backend, spawned } = makeBackend({ env: { PATH: 'C:\\bin', AE_MCP_CODEX_CLI: 'D:\\tools\\codex\\codex.exe' } });
  backend.sendUser('hi');
  await flush();
  const call = spawned.calls[0];
  assert.equal(call.command, 'D:\\tools\\codex\\codex.exe');
  backend.reset();
});

test('probeAccount reports resolved codex cliPath and cliVersion for diagnostics', async () => {
  const { backend, spawned } = makeBackend({
    resolveCli: async () => ({ ok: true, cliPath: 'C:\\bin\\codex.exe', version: 'codex-cli 1.2.3' }),
  });
  const probe = backend.probeAccount();
  await flush();
  const proc = spawned.procs[0];
  respond(proc, parseWrites(proc)[0], {});
  await flush();
  assert.equal(parseWrites(proc)[1].method, 'account/read');
  respond(proc, parseWrites(proc)[1], { account: { type: 'chatgpt', email: 'a@example.com', planType: 'plus' } });
  await flush();
  assert.equal(parseWrites(proc)[2].method, 'model/list');
  respond(proc, parseWrites(proc)[2], { models: [{ id: 'gpt-5.5', displayName: 'GPT-5.5', hidden: false }] });

  const result = await probe;
  assert.equal(result.loggedIn, true);
  assert.equal(result.cliPath, 'C:\\bin\\codex.exe');
  assert.equal(result.cliVersion, 'codex-cli 1.2.3');
});

test('probeAccount resolves within bounds when model/list never responds (relay stream hang)', async () => {
  const { backend, spawned } = makeBackend();
  const probe = backend.probeAccount();
  await flush();
  const proc = spawned.procs[0];
  respond(proc, parseWrites(proc)[0], {});
  await flush();
  assert.equal(parseWrites(proc)[1].method, 'account/read');
  respond(proc, parseWrites(proc)[1], { account: { type: 'chatgpt', email: 'a@example.com', planType: 'plus' } });
  await flush();
  assert.equal(parseWrites(proc)[2].method, 'model/list');
  // Never respond to model/list — simulates a third-party relay whose
  // upstream stream disconnects and never completes the request.

  const start = Date.now();
  const result = await probe;
  const elapsedMs = Date.now() - start;

  // A stuck model/list must not fail the whole probe: account/read already
  // succeeded, so probeAccount should resolve as logged-in with models=null.
  assert.ok(elapsedMs < 6000, `probeAccount took too long: ${elapsedMs}ms`);
  assert.equal(result.loggedIn, true);
  assert.equal(result.runtimeOk, true);
  assert.equal(result.models, null);
});

test('probeAccount resolves within bounds and kills the process when initialize never responds', async () => {
  const { backend, spawned } = makeBackend();
  const probe = backend.probeAccount();
  await flush();
  const proc = spawned.procs[0];
  // Never respond to `initialize` — simulates a fully hung app-server.

  const start = Date.now();
  const result = await probe;
  const elapsedMs = Date.now() - start;

  assert.ok(elapsedMs < 12000, `probeAccount took too long: ${elapsedMs}ms`);
  assert.equal(result.loggedIn, false);
  assert.equal(result.runtimeOk, false);
  assert.match(result.detail, /timeout/i);
  assert.equal(proc.killed, true);
});
