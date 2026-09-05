import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodexBackend, resolveCodexCli } from '../src/cep/codexBackend.js';

function createProcess() {
  const stdout = [];
  const stderr = [];
  const exits = [];
  const errors = [];
  const writes = [];
  const encodings = [];
  let killCount = 0;
  return {
    stdin: { write: (line) => writes.push(line) },
    stdout: {
      on: (event, handler) => event === 'data' && stdout.push(handler),
      setEncoding: (value) => encodings.push(['stdout', value]),
    },
    stderr: {
      on: (event, handler) => event === 'data' && stderr.push(handler),
      setEncoding: (value) => encodings.push(['stderr', value]),
    },
    on(event, handler) {
      if (event === 'exit') exits.push(handler);
      if (event === 'error') errors.push(handler);
    },
    kill() { killCount += 1; },
    get killCount() { return killCount; },
    encodings,
    writes,
    emit(message) {
      for (const handler of stdout) handler(`${JSON.stringify(message)}\n`);
    },
    emitStderr(message) {
      for (const handler of stderr) handler(message);
    },
    exit(code = 0, signal = null) {
      for (const handler of exits) handler(code, signal);
    },
    error(error) {
      for (const handler of errors) handler(error);
    },
  };
}

function parseWrites(proc) {
  return proc.writes.map((line) => JSON.parse(line));
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeBackend(overrides = {}) {
  const spawned = [];
  const mkdirs = [];
  const events = [];
  const platform = {
    id: 'windows-x64',
    paths: {
      tempRoot: 'C:\\tmp',
      configRoot: 'C:\\Users\\test\\.ae-mcp',
      join: (parts) => parts.join('\\'),
      dirname: (value) => value.replace(/[\\/][^\\/]+$/, ''),
    },
    fs: { mkdirSync: (path, options) => mkdirs.push({ path, options }) },
    completeSpawnEnv: (base = {}, additions = {}) => ({
      ...base,
      USERPROFILE: base.USERPROFILE || 'C:\\Users\\test',
      HOME: base.HOME || 'C:\\Users\\test',
      APPDATA: base.APPDATA || 'C:\\Users\\test\\AppData\\Roaming',
      ...additions,
    }),
    resolveExecutable: overrides.resolveExecutable || (async () => ({
      ok: true,
      id: 'codex',
      path: 'C:\\Tools\\codex.exe',
      displayPath: 'C:\\Tools\\codex.cmd',
      argsPrefix: [],
      source: 'path',
      version: '1.0.0',
      arch: 'x64',
    })),
    spawn(executable, args, options) {
      if (overrides.spawnError) throw overrides.spawnError;
      const proc = createProcess();
      spawned.push({ executable, args, options, proc });
      return proc;
    },
  };
  const backend = createCodexBackend({
    platform,
    getModel: () => overrides.state?.model || 'gpt-5.5',
    getEffort: () => overrides.state?.effort ?? 'high',
    getFast: () => overrides.state?.fast ?? true,
    getPermissionMode: () => overrides.state?.permissionMode || 'manual',
    getMcpSpec: overrides.getMcpSpec || (async () => ({
      kind: 'http',
      url: 'http://127.0.0.1:11488/mcp/c/codex-token',
      name: 'ae',
    })),
    getToolMeta: overrides.getToolMeta || (async () => ({ allowedTools: [], annotations: {} })),
    resolveCli: overrides.resolveCli,
    getLang: overrides.getLang,
    rpcTimeoutMs: overrides.rpcTimeoutMs,
    turnTimeoutMs: overrides.turnTimeoutMs,
    env: { AE_MCP_PANEL_EXT_ROOT: 'C:\\Repo\\plugin\\panel' },
    onEvent: (event) => events.push(event),
  });
  return { backend, platform, spawned, mkdirs, events };
}

async function startTurn(
  backend,
  spawned,
  input = { turnId: 'turn_1', text: 'hello', attachments: [] },
) {
  const pending = backend.sendUser(input);
  await flush();
  const proc = spawned[0].proc;
  const initialize = parseWrites(proc)[0];
  assert.equal(initialize.method, 'initialize');
  proc.emit({ id: initialize.id, result: {} });
  await flush();
  const thread = parseWrites(proc)[1];
  assert.equal(thread.method, 'thread/start');
  proc.emit({ id: thread.id, result: { threadId: 'thread_1' } });
  await flush();
  const turn = parseWrites(proc)[2];
  assert.equal(turn.method, 'turn/start');
  return { pending, proc, thread, turn };
}

test('resolveCodexCli exposes the CLI shim for diagnostics', async () => {
  const result = await resolveCodexCli({
    env: { AE_MCP_CODEX_CLI: 'C:\\Custom\\codex.cmd' },
    platform: {
      id: 'windows-x64',
      resolveExecutable: async (_id, { env }) => ({
        ok: true,
        path: 'C:\\Node\\node.exe',
        displayPath: env.AE_MCP_CODEX_CLI,
        version: '1.2.3',
      }),
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.cliPath, 'C:\\Custom\\codex.cmd');
  assert.equal(result.version, '1.2.3');
});

test('Codex routes blank-MIME images and audio as media with the selected model', async () => {
  const h = makeBackend({ state: { model: 'selected-model' } });
  try {
    const attachments = ['image.PNG', 'audio.WAV', 'clip.MOV'].map((name) => ({ id: name, name, localPath: `C:\\tmp\\${name}`, size: 4, mediaType: '', temporary: false }));
    const { turn, proc, pending } = await startTurn(h.backend, h.spawned, { turnId: 'mime', text: 'inspect', attachments });
    assert.equal(turn.params.model, 'selected-model');
    assert.match(turn.params.input[0].text, /clip.MOV/);
    assert.deepEqual(turn.params.input.slice(1), [
      { type: 'localImage', path: 'C:\\tmp\\image.PNG' },
      { type: 'localAudio', path: 'C:\\tmp\\audio.WAV' },
    ]);
    proc.emit({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    await pending;
  } finally { h.backend.reset(); }
});

test('Codex starts its CLI app-server with an isolated pre-created CODEX_HOME', async () => {
  const { backend, spawned, mkdirs } = makeBackend();
  try {
    const { thread, turn } = await startTurn(backend, spawned);
    assert.deepEqual(spawned[0].proc.encodings, [
      ['stdout', 'utf8'],
      ['stderr', 'utf8'],
    ]);
    assert.deepEqual(spawned[0].args, [
      'app-server',
      '-c',
      'features.default_mode_request_user_input=true',
    ]);
    assert.equal(spawned[0].options.env.CODEX_HOME, 'C:\\Users\\test\\.ae-mcp\\codex-home');
    assert.ok(mkdirs.length >= 1);
    assert.ok(mkdirs.every(({ path, options }) => (
      path === 'C:\\Users\\test\\.ae-mcp\\codex-home' && options.recursive === true
    )));
    assert.deepEqual(thread.params.config.mcp_servers.ae, {
      url: 'http://127.0.0.1:11488/mcp/c/codex-token',
    });
    assert.equal(thread.params.ephemeral, false);
    assert.equal(thread.params.cwd, 'C:\\Repo\\plugin');
    assert.deepEqual(turn.params.input, [{ type: 'text', text: 'hello' }]);
  } finally {
    backend.reset();
  }
});

test('Codex serializes every discovered model effort and supported speed tier', async () => {
  const discovered = [
    { id: 'gpt-5.6-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], fast: true },
    { id: 'gpt-5.6-terra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], fast: true },
    { id: 'gpt-5.6-luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], fast: true },
    { id: 'gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'], fast: true },
    { id: 'gpt-5.4', efforts: ['low', 'medium', 'high', 'xhigh'], fast: true },
    { id: 'gpt-5.4-mini', efforts: ['low', 'medium', 'high', 'xhigh'], fast: false },
    { id: 'gpt-5.3-codex-spark', efforts: ['low', 'medium', 'high', 'xhigh'], fast: false },
  ];

  for (const model of discovered) {
    const speedModes = model.fast ? [false, true] : [false];
    for (const effort of model.efforts) {
      for (const fast of speedModes) {
        const h = makeBackend({ state: { model: model.id, effort, fast } });
        try {
          const { pending, proc, turn } = await startTurn(h.backend, h.spawned);
          assert.equal(turn.params.model, model.id, `${model.id}/${effort}/${fast}`);
          assert.equal(turn.params.effort, effort, `${model.id}/${effort}/${fast}`);
          if (fast) assert.equal(turn.params.serviceTier, 'priority');
          else assert.equal(Object.hasOwn(turn.params, 'serviceTier'), false);
          h.backend.reset();
          await pending;
        } finally {
          h.backend.reset();
        }
      }
    }
  }
});

test('Codex reports cold-start stages before output and omits spawn on a warm turn', async () => {
  const { backend, spawned, events } = makeBackend();
  try {
    const first = await startTurn(backend, spawned);
    const coldStages = events.filter((event) => event.type === 'turn-progress');
    assert.deepEqual(coldStages.map((event) => event.stage), ['spawn', 'session', 'dispatch']);
    assert.ok(coldStages.every((event) => event.turnId === 'turn_1'));

    first.proc.emit({ method: 'turn/started', params: { turn: { id: 'remote_1' } } });
    first.proc.emit({ method: 'item/agentMessage/delta', params: { delta: 'hello' } });
    first.proc.emit({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    await first.pending;
    const acceptedIndex = events.findIndex((event) => event.type === 'turn-accepted');
    const textIndex = events.findIndex((event) => event.type === 'text-delta');
    assert.ok(coldStages.every((event) => events.indexOf(event) < acceptedIndex));
    assert.ok(coldStages.every((event) => events.indexOf(event) < textIndex));

    const boundary = events.length;
    const secondPending = backend.sendUser({ turnId: 'turn_2', text: 'again', attachments: [] });
    await flush();
    const secondTurn = parseWrites(first.proc).at(-1);
    assert.equal(secondTurn.method, 'turn/start');
    first.proc.emit({ method: 'turn/started', params: { turn: { id: 'remote_2' } } });
    first.proc.emit({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    await secondPending;
    assert.deepEqual(
      events.slice(boundary).filter((event) => event.type === 'turn-progress').map((event) => event.stage),
      ['dispatch'],
    );
    assert.equal(spawned.length, 1);
  } finally {
    backend.reset();
  }
});

test('Codex flushes redacted assistant text before MCP tool start events', async () => {
  const sensitivePath = 'C:\\' + 's'.repeat(61);
  assert.equal(sensitivePath.length, 64);
  const h = makeBackend();
  try {
    const { pending, proc } = await startTurn(h.backend, h.spawned, {
      turnId: 'turn_text_order',
      text: 'use a tool',
      attachments: [{
        id: 'att-sensitive',
        name: 'sensitive.txt',
        mediaType: 'text/plain',
        size: 1,
        temporary: false,
        localPath: sensitivePath,
      }],
    });
    proc.emit({ method: 'turn/started', params: { turn: { id: 'remote_text_order' } } });
    const beforeToolChunks = [
      'The composition is ready, and the expression setup is complete up to globalA',
      'lpha 0.7 before the tool runs.',
    ];
    for (const delta of beforeToolChunks) {
      proc.emit({ method: 'item/agentMessage/delta', params: { delta } });
    }
    proc.emit({
      method: 'item/started',
      params: {
        item: {
          type: 'mcpToolCall',
          id: 'tool_text_order',
          tool: 'ae_exec',
          arguments: { value: 1 },
        },
      },
    });

    const toolIndex = h.events.findIndex((event) => event.type === 'tool-start');
    assert.ok(toolIndex >= 0);
    assert.equal(
      h.events.slice(0, toolIndex)
        .filter((event) => event.type === 'text-delta')
        .map((event) => event.text)
        .join(''),
      beforeToolChunks.join(''),
    );

    proc.emit({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    await pending;
    assert.equal(
      h.events.filter((event) => event.type === 'text-delta').map((event) => event.text).join(''),
      beforeToolChunks.join(''),
    );
  } finally {
    h.backend.reset();
  }
});

test('Codex account probes use the same isolated CLI environment', async () => {
  const { backend, spawned, mkdirs } = makeBackend();
  const pending = backend.probeAccount();
  await flush();
  const proc = spawned[0].proc;
  const initialize = parseWrites(proc)[0];
  proc.emit({ id: initialize.id, result: {} });
  await flush();
  const account = parseWrites(proc)[1];
  assert.equal(account.method, 'account/read');
  proc.emit({
    id: account.id,
    result: { account: { email: 'user@example.test', planType: 'plus' } },
  });
  await flush();
  const models = parseWrites(proc)[2];
  assert.equal(models.method, 'model/list');
  proc.emit({ id: models.id, result: { models: [{ id: 'gpt-5.5' }] } });

  const result = await pending;
  assert.equal(result.loggedIn, true);
  assert.deepEqual(result.models, [{ id: 'gpt-5.5' }]);
  assert.equal(result.codexHome, 'C:\\Users\\test\\.ae-mcp\\codex-home');
  assert.equal(result.platformId, 'windows-x64');
  assert.equal(spawned[0].options.env.CODEX_HOME, 'C:\\Users\\test\\.ae-mcp\\codex-home');
  assert.equal(mkdirs.length, 1);
});

test('Codex account probes retain the real model/list data envelope', async () => {
  const { backend, spawned } = makeBackend();
  const pending = backend.probeAccount();
  await flush();
  const proc = spawned[0].proc;
  const initialize = parseWrites(proc)[0];
  proc.emit({ id: initialize.id, result: {} });
  await flush();
  const account = parseWrites(proc)[1];
  proc.emit({ id: account.id, result: { account: { email: 'user@example.test' } } });
  await flush();
  const models = parseWrites(proc)[2];
  proc.emit({ id: models.id, result: { data: [{ id: 'gpt-5.6-luna' }] } });

  const result = await pending;
  assert.deepEqual(result.models, [{ id: 'gpt-5.6-luna' }]);
});

async function probePages(h, pages) {
  const pending = h.backend.probeAccount();
  await flush();
  const proc = h.spawned.at(-1).proc;
  proc.emit({ id: parseWrites(proc).at(-1).id, result: {} });
  await flush();
  proc.emit({ id: parseWrites(proc).at(-1).id, result: { account: { planType: 'pro' } } });
  for (const page of pages) {
    await flush();
    const request = parseWrites(proc).at(-1);
    assert.equal(request.method, 'model/list');
    assert.equal(request.params.includeHidden, false);
    proc.emit({ id: request.id, ...page });
  }
  return { result: await pending, proc };
}

test('Codex pagination retains Astra, de-duplicates and respects hidden metadata', async () => {
  const h = makeBackend();
  const { result, proc } = await probePages(h, [
    { result: { data: [{ id: 'gpt-5.6-sol' }], nextCursor: 'page2' } },
    { result: { data: [{ id: 'gpt-6-astra' }, { id: 'gpt-5.6-sol', hidden: true }], nextCursor: null } },
  ]);
  assert.equal(result.catalogStatus, 'complete');
  assert.deepEqual(result.models, [{ id: 'gpt-5.6-sol', hidden: true }, { id: 'gpt-6-astra' }]);
  assert.equal(parseWrites(proc).at(-1).params.cursor, 'page2');
  assert.equal(proc.killCount, 1);
});

test('Codex partial failure, malformed page, cursor cycles and page limit fail the catalog only', async () => {
  for (const pages of [
    [{ result: { data: [], nextCursor: 'next' } }, { error: { code: -1, message: 'offline' } }],
    [{ result: { unexpected: [] } }],
    [{ result: { data: [], nextCursor: 'same' } }, { result: { data: [], nextCursor: 'same' } }],
    Array.from({ length: 10 }, (_, i) => ({ result: { data: [{ id: 'gpt-5.6-sol' }], nextCursor: `page${i}` } })),
  ]) {
    const { result, proc } = await probePages(makeBackend(), pages);
    assert.equal(result.catalogStatus, 'failed');
    assert.equal(result.models, null);
    assert.equal(result.loggedIn, true);
    assert.equal(proc.killCount, 1);
  }
});

test('Codex recheck resolves the updated executable without resetting the conversation', async () => {
  let version = '0.144.1';
  const h = makeBackend({ resolveExecutable: async () => ({ ok: true, path: 'C:/codex.exe', version }) });
  const first = await probePages(h, [{ result: { data: [{ id: 'gpt-5.6-sol' }] } }]);
  assert.equal(first.result.cli.version, version);
  version = '0.153.4';
  const second = await probePages(h, [{ result: { data: [{ id: 'gpt-6-astra' }] } }]);
  assert.equal(second.result.cli.version, version);
  assert.equal(second.result.models[0].id, 'gpt-6-astra');
  assert.equal(h.spawned.length, 2);
});

test('Codex account probes return isolated-home diagnostics when login is required', async () => {
  const { backend, spawned } = makeBackend();
  const pending = backend.probeAccount();
  await flush();
  const proc = spawned[0].proc;
  const initialize = parseWrites(proc)[0];
  proc.emit({ id: initialize.id, result: {} });
  await flush();
  const account = parseWrites(proc)[1];
  proc.emit({
    id: account.id,
    result: { account: null, requiresOpenaiAuth: true },
  });
  await flush();
  const models = parseWrites(proc)[2];
  proc.emit({ id: models.id, result: { models: [] } });

  const result = await pending;
  assert.equal(result.loggedIn, false);
  assert.equal(result.runtimeOk, true);
  assert.equal(result.detail, 'OpenAI auth required');
  assert.equal(result.codexHome, 'C:\\Users\\test\\.ae-mcp\\codex-home');
  assert.equal(result.platformId, 'windows-x64');
});

test('Codex account probe failures retain isolated-home diagnostics', async () => {
  const { backend } = makeBackend({
    resolveCli: async () => ({ ok: false, code: 'NOT_FOUND' }),
  });
  const result = await backend.probeAccount();
  assert.equal(result.loggedIn, false);
  assert.equal(result.runtimeOk, false);
  assert.equal(result.codexHome, 'C:\\Users\\test\\.ae-mcp\\codex-home');
  assert.equal(result.platformId, 'windows-x64');
});

test('Codex keeps JSON-RPC code and data in TURN_START_FAILED detail', async () => {
  const { backend, spawned, events } = makeBackend();
  try {
    const { pending, proc, turn } = await startTurn(backend, spawned);
    proc.emit({
      id: turn.id,
      error: { code: -32001, message: 'turn rejected', data: { reason: 'policy' } },
    });
    await pending;
    const error = events.find((event) => event.type === 'error');
    assert.equal(error.code, 'TURN_START_FAILED');
    assert.equal(error.detail.jsonRpcCode, -32001);
    assert.deepEqual(error.detail.jsonRpcData, { reason: 'policy' });
    assert.equal(error.dispatchState, 'uncertain');
  } finally {
    backend.reset();
  }
});

test('Codex initialize timeout reports RPC_TIMEOUT with the method', async () => {
  const { backend, events } = makeBackend({ rpcTimeoutMs: 5 });
  try {
    await backend.sendUser({ turnId: 'turn-timeout', text: 'hello', attachments: [] });
    const error = events.find((event) => event.type === 'error');
    assert.equal(error.code, 'RPC_TIMEOUT');
    assert.equal(error.detail.method, 'initialize');
    assert.equal(error.dispatchState, 'not-started');
  } finally {
    backend.reset();
  }
});

test('Codex relay status text becomes an URL-free upstream HTTP category', async () => {
  const { backend, spawned, events } = makeBackend();
  try {
    const { pending, proc, turn } = await startTurn(backend, spawned);
    proc.emit({
      id: turn.id,
      error: {
        code: -32000,
        message: 'unexpected status 502, url: https://relay.example/v1/messages?key=SECRET',
      },
    });
    await pending;
    const error = events.find((event) => event.type === 'error');
    assert.equal(error.code, 'UPSTREAM_HTTP_502');
    assert.equal(error.detail.httpStatus, 502);
    assert.match(error.detail.upstreamMessage, /unexpected status 502/);
    assert.equal(error.message.includes('https://'), false);
  } finally {
    backend.reset();
  }
});

test('Codex reads getLang for each resolution failure without rebuilding the backend', async () => {
  let currentLang = 'en';
  const h = makeBackend({
    getLang: () => currentLang,
    resolveCli: async () => ({ ok: false, code: 'NOT_FOUND' }),
  });

  await h.backend.sendUser({ turnId: 'turn-en', text: 'hello', attachments: [] });
  currentLang = 'zh';
  await h.backend.sendUser({ turnId: 'turn-zh', text: 'hello', attachments: [] });

  const errors = h.events.filter((event) => event.type === 'error');
  assert.match(errors[0].message, /not found/i);
  assert.match(errors[1].message, /未找到/);
  assert.equal(h.spawned.length, 0);
});

test('Codex maps all app-server cancellation spellings to CANCELLED', async () => {
  for (const status of ['cancelled', 'canceled', 'interrupted']) {
    const { backend, spawned, events } = makeBackend();
    try {
      const { pending, proc } = await startTurn(backend, spawned);
      proc.emit({ method: 'turn/completed', params: { turn: { status } } });
      await pending;
      assert.equal(events.find((event) => event.type === 'error')?.code, 'CANCELLED');
    } finally {
      backend.reset();
    }
  }
});

test('Codex distinguishes CLI resolution, spawn, and unauthenticated exits', async () => {
  const missing = makeBackend({
    resolveCli: async () => ({
      ok: false,
      code: 'ARCH_MISMATCH',
      resolution: {
        code: 'ARCH_MISMATCH',
        attempts: [{ path: 'C:\\Tools\\codex.exe', source: 'path', detail: 'architecture arm64' }],
      },
    }),
  });
  await missing.backend.sendUser({ turnId: 'turn-arch', text: 'hello', attachments: [] });
  assert.equal(missing.events.find((event) => event.type === 'error')?.code, 'CLI_ARCH_MISMATCH');

  const spawnFailure = new Error('spawn EACCES');
  spawnFailure.code = 'EACCES';
  const spawning = makeBackend({ spawnError: spawnFailure });
  await spawning.backend.sendUser({ turnId: 'turn-spawn', text: 'hello', attachments: [] });
  assert.equal(spawning.events.find((event) => event.type === 'error')?.code, 'SPAWN_FAILED');

  const exiting = makeBackend();
  const { pending, proc } = await startTurn(exiting.backend, exiting.spawned);
  proc.emitStderr('Not logged in. Run login first.');
  proc.exit(1);
  await pending;
  const authError = exiting.events.find((event) => event.type === 'error');
  assert.equal(authError?.code, 'AUTH_REQUIRED');
  assert.equal(authError?.detail.codexHome, 'C:\\Users\\test\\.ae-mcp\\codex-home');
});

test('Codex adopts and resumes a persisted thread with the current MCP URL', async () => {
  const { backend, spawned, events } = makeBackend();
  backend.adoptSessionRef({ kind: 'codex-thread', id: 'thread_saved' });
  assert.deepEqual(backend.getSessionRef(), { kind: 'codex-thread', id: 'thread_saved' });
  const pending = backend.sendUser({ turnId: 'turn-resume', text: 'continue', attachments: [] });
  await flush();
  const proc = spawned[0].proc;
  const initialize = parseWrites(proc)[0];
  proc.emit({ id: initialize.id, result: {} });
  await flush();
  const resume = parseWrites(proc)[1];
  assert.equal(resume.method, 'thread/resume');
  assert.equal(resume.params.threadId, 'thread_saved');
  assert.equal(resume.params.config.mcp_servers.ae.url, 'http://127.0.0.1:11488/mcp/c/codex-token');
  proc.emit({ id: resume.id, result: { thread: { id: 'thread_saved' } } });
  await flush();
  assert.deepEqual(events.find((event) => event.type === 'session-ref'), {
    type: 'session-ref',
    ref: { kind: 'codex-thread', id: 'thread_saved' },
  });
  backend.reset();
  await pending;
});

test('Codex resume failure falls back to a persistent new thread and emits its reference', async () => {
  const { backend, spawned, events } = makeBackend();
  backend.adoptSessionRef({ kind: 'codex-thread', id: 'thread_empty' });
  const pending = backend.sendUser({ turnId: 'turn-fallback', text: 'hello', attachments: [] });
  await flush();
  const proc = spawned[0].proc;
  const initialize = parseWrites(proc)[0];
  proc.emit({ id: initialize.id, result: {} });
  await flush();
  const resume = parseWrites(proc)[1];
  proc.emit({ id: resume.id, error: { code: -32600, message: 'no rollout found for thread id thread_empty' } });
  await flush();
  const start = parseWrites(proc)[2];
  assert.equal(start.method, 'thread/start');
  assert.equal(start.params.ephemeral, false);
  proc.emit({ id: start.id, result: { thread: { id: 'thread_new' } } });
  await flush();
  assert.deepEqual(backend.getSessionRef(), { kind: 'codex-thread', id: 'thread_new' });
  assert.ok(events.some((event) => event.type === 'session-ref' && event.ref.id === 'thread_new'));
  backend.reset();
  await pending;
});

test('Codex deletes a thread through a dedicated short-lived app-server', async () => {
  const { backend, spawned } = makeBackend();
  const pending = backend.deleteSessionRef({ kind: 'codex-thread', id: 'thread_delete' });
  await flush();
  const proc = spawned[0].proc;
  const initialize = parseWrites(proc)[0];
  assert.equal(initialize.method, 'initialize');
  proc.emit({ id: initialize.id, result: {} });
  await flush();
  const deletion = parseWrites(proc)[1];
  assert.equal(deletion.method, 'thread/delete');
  assert.deepEqual(deletion.params, { threadId: 'thread_delete' });
  proc.emit({ id: deletion.id, result: {} });
  assert.deepEqual(await pending, { ok: true });
  assert.equal(proc.killCount, 1);
});
