import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import {
  DEFAULT_EXCLUDED_MODELS,
  claudeRouteEnv,
  parseArgs,
  runClaudeModel,
  runCli,
  runCodexModel,
  runProviderMatrix,
  validateMessagesSse,
  validateResponsesSse,
} from './provider-matrix-live.mjs';

const ROUTE_TOKEN = 'local-route-token-must-not-be-reported';
const PROVIDER_ID = 'private-provider-id';

class FakeChild extends EventEmitter {
  constructor(onInput, initialMessages = []) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    let buffer = '';
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        buffer += String(chunk);
        while (buffer.includes('\n')) {
          const newline = buffer.indexOf('\n');
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) onInput(JSON.parse(line), this);
        }
        callback();
      },
    });
    queueMicrotask(() => {
      for (const message of initialMessages) this.send(message);
    });
  }

  send(message) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  kill(signal = 'SIGTERM') {
    if (this.signalCode !== null || this.exitCode !== null) return false;
    this.signalCode = signal;
    this.emit('exit', null, signal);
    return true;
  }
}

function messagesStream() {
  const events = [
    ['message_start', {
      type: 'message_start',
      message: {
        id: 'msg-private-id',
        type: 'message',
        role: 'assistant',
        model: 'text-model',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }],
    ['content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }],
    ['content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'OK' },
    }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

test('help is offline and CLI list options replace defaults deterministically', async () => {
  let connected = false;
  let output = '';
  let code = null;
  await runCli(['--help'], {
    stdout: { write: (value) => { output += value; } },
    stderr: { write: () => {} },
    exitCode: (value) => { code = value; },
    connectBridge: async () => { connected = true; throw new Error('must not connect'); },
    cwd: 'E:\\Code\\after-effects-mcp',
    execPath: 'node',
  });
  assert.equal(code, 0);
  assert.equal(connected, false);
  assert.match(output, /--layers <names>/);

  const options = parseArgs([
    '--layers=probe,l2',
    '--models', 'model-a,model-b',
    '--exclude', 'media-a,media-b',
    '--timeout-ms', '5000',
  ], { cwd: 'E:\\Code\\after-effects-mcp', execPath: 'node' });
  assert.deepEqual(options.layers, ['probe', 'l2']);
  assert.deepEqual(options.models, ['model-a', 'model-b']);
  assert.deepEqual(options.exclude, ['media-a', 'media-b']);
  assert.equal(options.timeoutMs, 5000);
  assert.throws(
    () => parseArgs(['--out', 'outside.json'], { cwd: 'E:\\Code\\after-effects-mcp' }),
    { code: 'matrix_invalid_output_path' },
  );
});

test('strict offline SSE validators require legal Responses and Messages terminals', () => {
  const response = validateResponsesSse(
    'event: response.completed\n'
    + 'data: {"type":"response.completed","response":{"id":"private-response-id","object":"response","status":"completed","output":[]}}\n\n',
  );
  assert.deepEqual(response, { ok: true, terminal: 'response.completed', errorCode: null });
  assert.deepEqual(validateMessagesSse(messagesStream()), {
    ok: true,
    terminal: 'message_stop',
    errorCode: null,
  });
  assert.throws(
    () => validateResponsesSse('event: response.created\ndata: {"type":"response.created"}\n\n'),
    { code: 'upstream_sse_terminal_missing' },
  );
  assert.throws(
    () => validateMessagesSse(messagesStream().replace('event: message_delta\n', 'event: ping\n')),
    { code: 'upstream_sse_malformed' },
  );
});

test('Claude route environment removes inherited API credentials and carries only local route state', () => {
  const env = claudeRouteEnv({
    Path: 'C:\\bin',
    ANTHROPIC_API_KEY: 'upstream-key',
    Anthropic_Base_Url: 'https://upstream.example',
    anthropic_auth_token: 'upstream-token',
    OPENAI_API_KEY: 'openai-key',
  }, {
    anthropicBaseUrl: 'http://127.0.0.1:43123',
    routeToken: ROUTE_TOKEN,
  });
  assert.equal(env.Path, 'C:\\bin');
  assert.equal(env.ANTHROPIC_API_KEY, '');
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:43123');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, ROUTE_TOKEN);
  assert.equal(env.Anthropic_Base_Url, undefined);
  assert.equal(env.anthropic_auth_token, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
});

test('injected full orchestration filters media, calls every model runner independently, and emits a secret-free report', async () => {
  const calls = [];
  let stopped = 0;
  let closed = 0;
  let tick = 1_000;
  const options = parseArgs([], { cwd: 'E:\\Code\\after-effects-mcp', execPath: 'node' });
  const bridge = {
    snapshot: async () => ({
      revision: 9,
      providers: [{
        id: PROVIDER_ID,
        name: 'Private',
        modelIds: ['text-model', ...DEFAULT_EXCLUDED_MODELS],
      }],
    }),
    probeAll: async (providerId, models) => {
      calls.push({ client: 'probe', providerId, models });
      return { results: models.map((modelId) => ({ modelId, ok: true, secret: ROUTE_TOKEN })) };
    },
    routes: async (providerId, models) => {
      calls.push({ client: 'routes', providerId, models });
      return {
        results: models.map((modelId) => ({
          modelId,
          routes: { codex: { ok: true, upstreamProtocol: 'responses' } },
        })),
      };
    },
    startRoute: async (providerId) => {
      calls.push({ client: 'route', providerId });
      return {
        origin: 'http://127.0.0.1:43123',
        openaiBaseUrl: 'http://127.0.0.1:43123/v1',
        anthropicBaseUrl: 'http://127.0.0.1:43123',
        routeToken: ROUTE_TOKEN,
      };
    },
    stopRoute: async () => { stopped += 1; },
    close: () => { closed += 1; },
  };
  const runner = (client, outcome) => async ({ model, route, chatCompatibility }) => {
    calls.push({ client, model, token: route.routeToken, chatCompatibility });
    return { ...outcome, secret: ROUTE_TOKEN };
  };
  const report = await runProviderMatrix(options, {
    connectBridge: async () => bridge,
    runResponses: runner('responses', { ok: true, terminal: 'response.completed' }),
    runMessages: runner('messages', { ok: true, terminal: 'message_stop' }),
    runCodex: runner('codex', { ok: true, terminal: 'turn/completed' }),
    runClaude: runner('claude', { ok: false, terminal: ROUTE_TOKEN, errorCode: ROUTE_TOKEN }),
    now: () => { tick += 5; return tick; },
  });

  assert.equal(stopped, 1);
  assert.equal(closed, 1);
  assert.deepEqual(calls[0], { client: 'probe', providerId: PROVIDER_ID, models: ['text-model'] });
  assert.deepEqual(calls.filter((call) => call.model).map((call) => call.client), [
    'responses', 'messages', 'codex', 'claude',
  ]);
  assert.equal(calls.find((call) => call.client === 'codex').chatCompatibility, false);
  assert.deepEqual(report.excludedModels, DEFAULT_EXCLUDED_MODELS);
  assert.equal(report.results.length, 5);
  assert.deepEqual(Object.keys(report.results[0]), [
    'model', 'client', 'ok', 'terminal', 'duration', 'errorCode',
  ]);
  const claude = report.results.find((entry) => entry.client === 'claude');
  assert.equal(claude.ok, false);
  assert.equal(claude.terminal, null);
  assert.equal(claude.errorCode, 'internal_error');
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /local-route-token-must-not-be-reported/);
  assert.doesNotMatch(serialized, /private-provider-id/);
  assert.doesNotMatch(serialized, /127\.0\.0\.1/);
});

test('probe orchestration applies the timeout independently per model and continues after one failure', async () => {
  const calls = [];
  let tick = 2_000;
  const options = parseArgs([
    '--layers', 'probe',
    '--models', 'model-a,model-b',
  ], { cwd: 'E:\\Code\\after-effects-mcp', execPath: 'node' });
  const bridge = {
    snapshot: async () => ({
      providers: [{ id: PROVIDER_ID, modelIds: ['model-a', 'model-b'] }],
    }),
    async probeAll(providerId, models) {
      calls.push({ providerId, models });
      if (models[0] === 'model-a') {
        const error = new Error('timeout');
        error.code = 'matrix_cdp_timeout';
        throw error;
      }
      return { results: [{ modelId: models[0], ok: true }] };
    },
    stopRoute: async () => {},
    close: () => {},
  };
  const report = await runProviderMatrix(options, {
    connectBridge: async () => bridge,
    now: () => { tick += 5; return tick; },
  });

  assert.deepEqual(calls.map((call) => call.models), [['model-a'], ['model-b']]);
  assert.deepEqual(report.results.map((entry) => ({
    model: entry.model,
    ok: entry.ok,
    errorCode: entry.errorCode,
  })), [
    { model: 'model-a', ok: false, errorCode: 'cdp_timeout' },
    { model: 'model-b', ok: true, errorCode: null },
  ]);
});

test('finally stops the local route when a layer runner throws', async () => {
  let stopped = 0;
  let closed = 0;
  const options = parseArgs(['--layers', 'l2', '--models', 'text-model'], {
    cwd: 'E:\\Code\\after-effects-mcp', execPath: 'node',
  });
  const report = await runProviderMatrix(options, {
    connectBridge: async () => ({
      snapshot: async () => ({ providers: [{ id: PROVIDER_ID, modelIds: ['text-model'] }] }),
      startRoute: async () => ({
        origin: 'http://127.0.0.1:43123',
        openaiBaseUrl: 'http://127.0.0.1:43123/v1',
        anthropicBaseUrl: 'http://127.0.0.1:43123',
        routeToken: ROUTE_TOKEN,
      }),
      stopRoute: async () => { stopped += 1; },
      close: () => { closed += 1; },
    }),
    runResponses: async () => { throw Object.assign(new Error(ROUTE_TOKEN), { code: `matrix_${ROUTE_TOKEN}` }); },
    runMessages: async () => ({ ok: true, terminal: 'message_stop' }),
  });
  assert.equal(stopped, 1);
  assert.equal(closed, 1);
  assert.equal(report.results[0].errorCode, 'internal_error');
  assert.doesNotMatch(JSON.stringify(report), /local-route-token/);
});

test('Codex and Claude L3 runners use one isolated process and accept only their legal success terminals', async () => {
  const route = {
    openaiBaseUrl: 'http://127.0.0.1:43123/v1',
    anthropicBaseUrl: 'http://127.0.0.1:43123',
    routeToken: ROUTE_TOKEN,
  };
  const options = parseArgs(['--timeout-ms', '5000'], {
    cwd: 'E:\\Code\\after-effects-mcp', execPath: 'node',
  });
  const codexSpawns = [];
  const codexRequests = [];
  const codex = await runCodexModel({
    model: 'text-model',
    route,
    options,
    chatCompatibility: true,
    baseEnv: {
      PATH: 'C:\\bin',
      OPENAI_API_KEY: 'inherited-openai-secret',
      ANTHROPIC_API_KEY: 'inherited-anthropic-secret',
    },
    sleep: async () => {},
    spawnImpl(file, args, spawnOptions) {
      codexSpawns.push({ file, args, spawnOptions });
      return new FakeChild((message, child) => {
        codexRequests.push(message);
        if (message.method === 'initialize') child.send({ id: message.id, result: {} });
        if (message.method === 'thread/start') {
          child.send({ id: message.id, result: { threadId: 'private-thread-id' } });
        }
        if (message.method === 'turn/start') {
          child.send({ id: message.id, result: { turn: { id: 'private-turn-id' } } });
          queueMicrotask(() => child.send({
            method: 'turn/completed',
            params: { turn: { id: 'private-turn-id', status: 'completed' } },
          }));
        }
      });
    },
  });
  assert.deepEqual(codex, { terminal: 'turn/completed', ok: true, errorCode: null });
  assert.equal(codexSpawns.length, 1);
  assert.equal(codexSpawns[0].spawnOptions.shell, false);
  assert.match(codexSpawns[0].args.join('\n'), /web_search="disabled"/);
  assert.equal(codexSpawns[0].spawnOptions.env.AE_MCP_PROVIDER_HEADER_00, ROUTE_TOKEN);
  assert.doesNotMatch(JSON.stringify(codexSpawns[0].spawnOptions.env), /inherited-(?:openai|anthropic)-secret/);
  assert.equal(codexRequests.find((message) => message.method === 'turn/start').params.effort, 'low');

  const claudeSpawns = [];
  const claude = await runClaudeModel({
    model: 'text-model',
    route,
    options,
    baseEnv: {
      PATH: 'C:\\bin',
      ANTHROPIC_API_KEY: 'inherited-anthropic-secret',
      ANTHROPIC_AUTH_TOKEN: 'inherited-auth-secret',
    },
    sleep: async () => {},
    spawnImpl(file, args, spawnOptions) {
      claudeSpawns.push({ file, args, spawnOptions });
      return new FakeChild((message, child) => {
        if (message.t === 'user') {
          child.send({ t: 'event', event: { type: 'turn-start' } });
          child.send({ t: 'event', event: { type: 'text-delta', text: 'OK' } });
          child.send({ t: 'event', event: { type: 'turn-end', stopReason: 'end_turn' } });
        }
      }, [{ t: 'ready' }]);
    },
  });
  assert.deepEqual(claude, { terminal: 'turn-end', ok: true, errorCode: null });
  assert.equal(claudeSpawns.length, 1);
  assert.equal(claudeSpawns[0].spawnOptions.env.ANTHROPIC_BASE_URL, route.anthropicBaseUrl);
  assert.equal(claudeSpawns[0].spawnOptions.env.ANTHROPIC_AUTH_TOKEN, ROUTE_TOKEN);
  assert.equal(claudeSpawns[0].spawnOptions.env.ANTHROPIC_API_KEY, '');
  assert.doesNotMatch(JSON.stringify(claudeSpawns[0].spawnOptions.env), /inherited-(?:anthropic|auth)-secret/);
});

test('Codex error notifications remain nonterminal until the failed turn/completed event', async () => {
  const route = {
    openaiBaseUrl: 'http://127.0.0.1:43123/v1',
    routeToken: ROUTE_TOKEN,
  };
  const options = parseArgs(['--timeout-ms', '5000'], {
    cwd: 'E:\\Code\\after-effects-mcp', execPath: 'node',
  });
  const result = await runCodexModel({
    model: 'text-model',
    route,
    options,
    sleep: async () => {},
    spawnImpl(_file, _args, _spawnOptions) {
      return new FakeChild((message, child) => {
        if (message.method === 'initialize') child.send({ id: message.id, result: {} });
        if (message.method === 'thread/start') {
          child.send({ id: message.id, result: { threadId: 'private-thread-id' } });
        }
        if (message.method === 'turn/start') {
          child.send({ id: message.id, result: { turn: { id: 'private-turn-id' } } });
          queueMicrotask(() => {
            child.send({ method: 'error', params: { error: { message: ROUTE_TOKEN } } });
            child.send({
              method: 'turn/completed',
              params: {
                turn: {
                  id: 'private-turn-id',
                  status: 'failed',
                  error: { message: ROUTE_TOKEN },
                },
              },
            });
          });
        }
      });
    },
  });

  assert.deepEqual(result, { terminal: 'turn/completed', ok: false, errorCode: 'codex_error' });
});
