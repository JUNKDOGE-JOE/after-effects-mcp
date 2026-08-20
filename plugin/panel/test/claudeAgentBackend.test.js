import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import {
  CLAUDE_MINIMUM_VERSION,
  createClaudeAgentBackend,
  resolveClaudeCli,
} from '../src/cep/claudeAgentBackend.js';

const SPIKE_ROOT = new URL('../../../.codex/spike/', import.meta.url);

function transcript(name) {
  return readFileSync(new URL(`transcript-${name}.ndjson`, SPIKE_ROOT), 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
}

const TRANSCRIPTS = {
  B: transcript('B'),
  D: transcript('D'),
  F: transcript('F'),
};

function wire(name, lineNumber) {
  const record = TRANSCRIPTS[name][lineNumber - 1];
  assert.ok(record, `${name}:${lineNumber} exists`);
  return JSON.parse(JSON.stringify(record.data));
}

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdinLines = [];
    this.killCount = 0;
    this.stdin = {
      write: (value) => {
        this.stdinLines.push(String(value));
        return true;
      },
    };
  }

  kill() {
    this.killCount += 1;
    return true;
  }
}

function emitWire(proc, message) {
  proc.stdout.emit('data', `${JSON.stringify(message)}\n`);
}

function written(proc) {
  return proc.stdinLines.map((line) => JSON.parse(line));
}

async function flush(count = 8) {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

function windowsJoin(parts) {
  return parts.join('\\').replace(/\\+/g, '\\');
}

function createFs() {
  const writes = [];
  const removals = [];
  const realpaths = new Map();
  const files = new Set();
  return {
    writes,
    removals,
    realpaths,
    files,
    mkdirSync() {},
    writeFileSync(path, value) {
      writes.push({ path, text: String(value) });
      files.add(path);
    },
    chmodSync() {},
    rmSync(path) {
      removals.push(path);
    },
    realpathSync(path) {
      if (!files.has(path) && !realpaths.has(path)) throw new Error('missing file');
      return realpaths.get(path) || path;
    },
    statSync(path) {
      if (!files.has(path) && ![...realpaths.values()].includes(path)) {
        throw new Error('missing file');
      }
      return { isFile: () => true };
    },
  };
}

function resolvedClaude() {
  const executable = {
    ok: true,
    id: 'claude',
    path: 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe',
    displayPath: 'C:\\npm\\claude.cmd',
    argsPrefix: [],
    source: 'path',
    version: '2.1.227',
    arch: 'x64',
  };
  return {
    ok: true,
    cliPath: executable.path,
    displayPath: executable.displayPath,
    version: executable.version,
    executable,
  };
}

function toolMeta() {
  return {
    allowedTools: ['mcp__ae__ae_status'],
    annotations: {
      mcp__ae__ae_status: { readOnly: true, destructive: false },
      mcp__ae__ae_exec: { readOnly: false, destructive: false },
      mcp__ae__ae_revert: { readOnly: false, destructive: true },
    },
  };
}

function makeHarness(overrides = {}) {
  const processes = [];
  const spawns = [];
  const events = [];
  const fs = overrides.fsImpl || createFs();
  let tempSequence = 0;
  const platform = overrides.platform || {
    id: 'windows-x64',
    fs,
    paths: {
      tempRoot: 'C:\\Temp',
      join: windowsJoin,
      isAbsolute: (value) => /^[A-Za-z]:\\/.test(String(value || '')),
    },
    completeSpawnEnv: (base = {}, additions = {}) => ({
      Path: 'C:\\npm',
      ...base,
      ...additions,
    }),
    spawn(executable, args, options) {
      const proc = new FakeProcess();
      processes.push(proc);
      spawns.push({
        executable,
        args: [...args],
        options: { ...options, env: { ...(options.env || {}) } },
      });
      return proc;
    },
  };
  const state = {
    model: 'claude-haiku-4-5-20251001',
    permissionMode: 'manual',
    effort: 'high',
    thinking: null,
    channel: 'subscription',
    ...(overrides.state || {}),
  };
  const backend = createClaudeAgentBackend({
    platform,
    fsImpl: fs,
    tempDirName: () => `claude-test-${++tempSequence}`,
    resolveClaude: overrides.resolveClaude || (async () => resolvedClaude()),
    getMcpSpec: overrides.getMcpSpec || (async () => ({
      kind: 'http',
      url: 'http://127.0.0.1:11488/mcp?session=chat-1',
    })),
    getToolMeta: overrides.getToolMeta || (async () => toolMeta()),
    getModel: () => state.model,
    getPermissionMode: () => state.permissionMode,
    getEffort: () => state.effort,
    getThinking: () => state.thinking,
    getChannel: () => state.channel,
    getProviderSensitiveValues: overrides.getProviderSensitiveValues,
    resolveApiProvider: overrides.resolveApiProvider,
    resolveRequestProfile: overrides.resolveRequestProfile,
    resolveCapability: overrides.resolveCapability,
    createProviderRoute: overrides.createProviderRoute,
    recoverProviderProfile: overrides.recoverProviderProfile,
    onProviderProfileRecovered: overrides.onProviderProfileRecovered,
    onEvent: (event) => events.push(event),
    lang: overrides.lang || 'en',
    now: overrides.now || (() => 100),
    env: overrides.env,
  });
  return { backend, events, fs, platform, processes, spawns, state };
}

function controlTool(name = 'mcp__ae__ae_exec') {
  // Real can_use_tool wire shape: transcript-F.ndjson:55.
  const message = wire('F', 55);
  message.request.tool_name = name;
  message.request.display_name = name;
  return message;
}

function finishTurn(proc, resultLine = 99) {
  emitWire(proc, wire('B', resultLine));
}

test('resolveClaudeCli requires Claude 2.x and the host architecture', async () => {
  let request;
  const executable = resolvedClaude().executable;
  const result = await resolveClaudeCli({
    platform: {
      id: 'windows-x64',
      resolveExecutable: async (id, options) => {
        request = { id, options };
        return executable;
      },
    },
  });

  assert.equal(CLAUDE_MINIMUM_VERSION, '2.0.0');
  assert.deepEqual(request, {
    id: 'claude',
    options: { minimumVersion: '2.0.0', requiredArch: 'x64' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.executable, executable);
});

test('resolveClaudeCli gives install and upgrade guidance for probe failures', async () => {
  for (const value of [
    ['NOT_FOUND', /not found/i],
    ['VERSION_TOO_OLD', /upgrade Claude CLI/i],
  ]) {
    const result = await resolveClaudeCli({
      lang: 'en',
      platform: {
        id: 'windows-x64',
        resolveExecutable: async () => ({ ok: false, code: value[0], attempts: [] }),
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, value[0]);
    assert.match(result.detail, value[1]);
  }
});

test('turn round-trip uses real stream-json wire and keeps one process', async () => {
  const h = makeHarness();
  const firstInput = wire('B', 2);
  const first = h.backend.sendUser({
    turnId: 'turn-1',
    text: firstInput.message.content[0].text,
    attachments: [],
  });
  await flush();

  assert.equal(h.processes.length, 1);
  assert.deepEqual(written(h.processes[0])[0], firstInput);
  emitWire(h.processes[0], wire('B', 3));
  emitWire(h.processes[0], wire('B', 6));
  emitWire(h.processes[0], wire('B', 84));
  emitWire(h.processes[0], wire('B', 94));
  finishTurn(h.processes[0], 99);
  await first;

  assert.deepEqual(
    h.events.find((event) => event.type === 'turn-accepted'),
    {
      type: 'turn-accepted',
      turnId: 'turn-1',
      transport: 'claude-cli-stream-json',
    },
  );
  assert.ok(h.events.some((event) => event.type === 'thinking' && event.active));
  assert.ok(h.events.some((event) => event.type === 'thinking' && !event.active));
  assert.ok(h.events.some((event) => (
    event.type === 'text-delta'
    && event.text === 'Done. The tool returned: `did: hello`'
  )));
  assert.deepEqual(h.backend.getMessages(), [
    { role: 'user', text: firstInput.message.content[0].text },
    { role: 'assistant', text: 'Done. The tool returned: `did: hello`' },
  ]);

  const secondInput = wire('B', 100);
  const second = h.backend.sendUser(secondInput.message.content[0].text);
  await flush();
  assert.equal(h.processes.length, 1);
  assert.deepEqual(written(h.processes[0]).at(-1), secondInput);
  emitWire(h.processes[0], wire('B', 101));
  emitWire(h.processes[0], wire('B', 137));
  finishTurn(h.processes[0], 142);
  await second;
});

test('spawn argv carries isolation, agents, approvals, effort, and MCP config', async () => {
  const h = makeHarness({
    state: { thinking: 'adaptive' },
    env: { ANTHROPIC_API_KEY: 'must-not-reach-subscription', KEEP: 'yes' },
  });
  const run = h.backend.sendUser('hello');
  await flush();
  const call = h.spawns[0];

  assert.equal(call.executable.path, resolvedClaude().cliPath);
  assert.deepEqual(call.args.slice(0, 8), [
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--model',
  ]);
  assert.ok(call.args.includes('--strict-mcp-config'));
  assert.equal(call.args[call.args.indexOf('--setting-sources') + 1], '');
  assert.equal(call.args[call.args.indexOf('--permission-prompt-tool') + 1], 'stdio');
  assert.equal(call.args[call.args.indexOf('--effort') + 1], 'high');
  assert.equal(call.args[call.args.indexOf('--thinking') + 1], 'adaptive');
  assert.equal(call.options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(call.options.env.KEEP, 'yes');

  const deniedStart = call.args.indexOf('--disallowedTools') + 1;
  const deniedEnd = call.args.indexOf('--allowedTools');
  assert.deepEqual(call.args.slice(deniedStart, deniedEnd), [
    'Bash',
    'Edit',
    'Write',
    'PowerShell',
    'Task',
    'WebFetch',
    'WebSearch',
  ]);
  assert.equal(call.args[deniedEnd + 1], 'mcp__ae__ae_status');
  const agents = JSON.parse(call.args[call.args.indexOf('--agents') + 1]);
  assert.deepEqual(Object.keys(agents), ['ae']);
  assert.ok(agents.ae.tools.includes('mcp__ae__ae_exec'));
  assert.ok(agents.ae.tools.includes('AskUserQuestion'));
  assert.equal(call.args[call.args.indexOf('--agent') + 1], 'ae');

  const configPath = call.args[call.args.indexOf('--mcp-config') + 1];
  const config = JSON.parse(h.fs.writes.find((item) => item.path === configPath).text);
  assert.deepEqual(config, {
    mcpServers: {
      ae: {
        type: 'http',
        url: 'http://127.0.0.1:11488/mcp?session=chat-1',
      },
    },
  });
  finishTurn(h.processes[0]);
  await run;
});

test('stdio MCP config preserves command args and strips provider credentials', async () => {
  const h = makeHarness({
    getMcpSpec: async () => ({
      kind: 'stdio',
      command: 'ae-mcp.exe',
      args: ['--stdio', '--label', 'chat-1'],
      env: {
        AE_MCP_APPROVAL_TIER_FILE: 'C:\\Temp\\tier.txt',
        anthropic_api_key: 'must-not-leak',
      },
    }),
  });
  const run = h.backend.sendUser('hello');
  await flush();
  const path = h.spawns[0].args[h.spawns[0].args.indexOf('--mcp-config') + 1];
  const config = JSON.parse(h.fs.writes.find((item) => item.path === path).text);

  assert.deepEqual(config, {
    mcpServers: {
      ae: {
        command: 'ae-mcp.exe',
        args: ['--stdio', '--label', 'chat-1'],
        env: {
          ANTHROPIC_API_KEY: '',
          ANTHROPIC_BASE_URL: '',
          ANTHROPIC_AUTH_TOKEN: '',
          AE_MCP_APPROVAL_TIER_FILE: 'C:\\Temp\\tier.txt',
          AE_MCP_BACKEND: 'ae-mcp',
        },
      },
    },
  });
  finishTurn(h.processes[0]);
  await run;
});

test('real assistant and user wire map AE tool start and result events', async () => {
  let clock = 100;
  const h = makeHarness({ now: () => (clock += 25) });
  const run = h.backend.sendUser('use a tool');
  await flush();
  emitWire(h.processes[0], wire('B', 3));
  const assistant = wire('B', 57);
  assistant.message.content[0].name = 'mcp__ae__ae_exec';
  emitWire(h.processes[0], assistant);
  const user = wire('B', 59);
  emitWire(h.processes[0], user);
  finishTurn(h.processes[0]);
  await run;

  assert.deepEqual(h.events.find((event) => event.type === 'tool-start'), {
    type: 'tool-start',
    toolUseId: 'toolu_018GkeHtP8wW7HmmrmZn72zA',
    name: 'mcp__ae__ae_exec',
    input: { message: 'hello' },
  });
  assert.deepEqual(h.events.find((event) => event.type === 'tool-result'), {
    type: 'tool-result',
    toolUseId: 'toolu_018GkeHtP8wW7HmmrmZn72zA',
    ok: true,
    text: 'did: hello',
    durationMs: 25,
  });
});

test('manual can_use_tool allow and deny use the real control wire shape', async () => {
  for (const decision of ['allow', 'deny']) {
    const h = makeHarness();
    const run = h.backend.sendUser(`manual ${decision}`);
    await flush();
    const request = controlTool();
    emitWire(h.processes[0], request);
    const required = h.events.find((event) => event.type === 'approval-required');
    assert.deepEqual(required, {
      type: 'approval-required',
      toolUseId: request.request.tool_use_id,
      name: 'mcp__ae__ae_exec',
      input: { message: 'hello' },
      risk: 'write',
    });
    assert.equal(h.backend.approve(request.request.tool_use_id, decision), true);
    const response = written(h.processes[0]).at(-1);
    assert.equal(response.type, wire('F', 56).type);
    assert.equal(response.response.subtype, 'success');
    assert.equal(response.response.request_id, request.request_id);
    assert.equal(response.response.response.behavior, decision);
    if (decision === 'allow') {
      assert.deepEqual(response.response.response.updatedInput, { message: 'hello' });
    } else {
      assert.match(response.response.response.message, /denied/i);
      assert.ok(h.events.some((event) => event.type === 'tool-denied'));
    }
    finishTurn(h.processes[0]);
    await run;
  }
});

test('readonly, auto, none, and session-allowed preserve sidecar gate semantics', async () => {
  const cases = [
    ['readonly', 'mcp__ae__ae_exec', 'deny'],
    ['auto', 'mcp__ae__ae_exec', 'allow'],
    ['auto', 'mcp__ae__ae_revert', null],
    ['none', 'mcp__ae__ae_revert', 'allow'],
  ];
  for (const [permissionMode, name, expected] of cases) {
    const h = makeHarness({ state: { permissionMode } });
    const run = h.backend.sendUser(`${permissionMode} gate`);
    await flush();
    const request = controlTool(name);
    emitWire(h.processes[0], request);
    if (expected === null) {
      assert.ok(h.events.some((event) => event.type === 'approval-required'));
      h.backend.approve(request.request.tool_use_id, 'deny');
    } else {
      const response = written(h.processes[0]).at(-1);
      assert.equal(response.response.response.behavior, expected);
      assert.equal(
        h.events.some((event) => event.type === 'approval-required'),
        false,
      );
    }
    finishTurn(h.processes[0]);
    await run;
  }

  const h = makeHarness();
  let run = h.backend.sendUser('approve for session');
  await flush();
  let request = controlTool();
  emitWire(h.processes[0], request);
  h.backend.approve(request.request.tool_use_id, 'allow-session');
  finishTurn(h.processes[0]);
  await run;

  run = h.backend.sendUser('same tool again');
  await flush();
  request = controlTool();
  request.request_id = 'second-request';
  request.request.tool_use_id = 'second-tool-use';
  emitWire(h.processes[0], request);
  const response = written(h.processes[0]).at(-1);
  assert.equal(response.response.request_id, 'second-request');
  assert.equal(response.response.response.behavior, 'allow');
  assert.equal(
    h.events.filter((event) => event.type === 'approval-required').length,
    1,
  );
  finishTurn(h.processes[0]);
  await run;
});

test('AskUserQuestion round-trips through the existing question form', async () => {
  const h = makeHarness();
  const run = h.backend.sendUser('ask me');
  await flush();
  const request = wire('F', 117);
  emitWire(h.processes[0], request);
  const required = h.events.find((event) => event.type === 'question-required');
  assert.equal(required.toolUseId, request.request.tool_use_id);
  assert.equal(required.source, 'claude-ask-user-question');
  assert.equal(required.questions[0].prompt, 'Do you prefer red or blue?');
  assert.equal(h.backend.answerQuestion(required.toolUseId, {
    action: 'submit',
    values: { q0: 'Blue' },
  }), true);

  const response = written(h.processes[0]).at(-1);
  assert.equal(response.type, wire('F', 118).type);
  assert.equal(response.response.request_id, request.request_id);
  assert.equal(response.response.response.behavior, 'allow');
  assert.deepEqual(response.response.response.updatedInput, {
    questions: request.request.input.questions,
    answers: { 'Do you prefer red or blue?': 'Blue' },
  });
  assert.deepEqual(h.events.find((event) => event.type === 'question-resolved'), {
    type: 'question-resolved',
    toolUseId: request.request.tool_use_id,
    outcome: 'answered',
    answers: { 'Do you prefer red or blue?': 'Blue' },
  });
  finishTurn(h.processes[0], 142);
  await run;
});

test('model changes restart with --resume while preserving the transcript', async () => {
  const h = makeHarness();
  let run = h.backend.sendUser('first turn');
  await flush();
  emitWire(h.processes[0], wire('B', 3));
  finishTurn(h.processes[0]);
  await run;

  const session = wire('D', 1).args[wire('D', 1).args.indexOf('--resume') + 1];
  assert.equal(session, wire('B', 99).session_id);
  h.state.model = 'claude-sonnet-5';
  run = h.backend.sendUser('second turn');
  await flush(24);

  assert.equal(h.processes[0].killCount, 1);
  assert.equal(h.processes.length, 2);
  const args = h.spawns[1].args;
  assert.equal(args[args.indexOf('--model') + 1], 'claude-sonnet-5');
  assert.equal(args[args.indexOf('--resume') + 1], session);
  finishTurn(h.processes[1], 142);
  await run;
  assert.deepEqual(h.backend.getMessages().map((message) => message.role), [
    'user',
    'assistant',
    'user',
    'assistant',
  ]);
});

test('thinking settings mirror Agent SDK CLI argument mapping', async () => {
  const h = makeHarness({
    state: {
      effort: 'xhigh',
      thinking: { type: 'enabled', budgetTokens: 4096 },
    },
  });
  const run = h.backend.sendUser('budgeted thinking');
  await flush();
  const args = h.spawns[0].args;
  assert.equal(args[args.indexOf('--effort') + 1], 'xhigh');
  assert.equal(args[args.indexOf('--max-thinking-tokens') + 1], '4096');
  assert.equal(args.includes('--thinking'), false);
  finishTurn(h.processes[0]);
  await run;
});

test('attachments use a manifest plus an exact Read allow rule', async () => {
  const fs = createFs();
  const selected = 'C:\\Media\\reference.png';
  fs.files.add(selected);
  const h = makeHarness({ fsImpl: fs });
  const run = h.backend.sendUser({
    turnId: 'turn-attachment',
    text: 'inspect this',
    attachments: [{
      id: 'att-1',
      name: 'reference.png',
      mediaType: 'image/png',
      size: 12,
      temporary: false,
      localPath: selected,
    }],
  });
  await flush();

  const args = h.spawns[0].args;
  assert.ok(args.includes(`Read(${selected})`));
  const agents = JSON.parse(args[args.indexOf('--agents') + 1]);
  assert.ok(agents.ae.tools.includes('Read'));
  assert.match(agents.ae.prompt, /exact paths/);
  const input = written(h.processes[0])[0].message.content[0].text;
  assert.match(input, /<ae_mcp_attachments version="1">/);
  assert.match(input, /reference\.png/);
  assert.ok(input.includes(JSON.stringify(selected).slice(1, -1)));
  finishTurn(h.processes[0]);
  await run;
});

test('unexpected error and exit drain approvals and questions exactly once', async () => {
  const h = makeHarness();
  const run = h.backend.sendUser({
    turnId: 'turn-drain',
    text: 'pending controls',
    attachments: [],
  });
  await flush();
  const approval = controlTool();
  emitWire(h.processes[0], approval);
  emitWire(h.processes[0], wire('F', 117));
  assert.equal(h.events.filter((event) => event.type === 'approval-required').length, 1);
  assert.equal(h.events.filter((event) => event.type === 'question-required').length, 1);

  h.processes[0].emit('error', new Error('spawn channel failed'));
  h.processes[0].emit('exit', 1, null);
  await run;
  assert.equal(h.events.filter((event) => event.type === 'error').length, 1);
  assert.equal(h.events.filter((event) => event.type === 'tool-denied').length, 1);
  assert.equal(
    h.events.filter((event) => (
      event.type === 'question-resolved' && event.outcome === 'cancelled'
    )).length,
    1,
  );
  assert.equal(h.backend.approve(approval.request.tool_use_id, 'allow'), false);
  assert.equal(h.backend.answerQuestion(wire('F', 117).request.tool_use_id, {
    action: 'submit',
    values: { q0: 'Red' },
  }), false);
});

test('missing CLI fails before dispatch and never spawns', async () => {
  const h = makeHarness({
    resolveClaude: async () => ({
      ok: false,
      code: 'NOT_FOUND',
      detail: 'Install Claude CLI 2.x.',
    }),
  });
  await h.backend.sendUser({ turnId: 'turn-missing', text: 'hello', attachments: [] });

  assert.equal(h.spawns.length, 0);
  assert.deepEqual(h.events.find((event) => event.type === 'error'), {
    type: 'error',
    kind: 'mcp',
    code: 'NOT_FOUND',
    message: 'Install Claude CLI 2.x.',
    turnId: 'turn-missing',
    dispatchState: 'not-started',
  });
});

test('stop emits one aborted error, drains controls, and kills the process', async () => {
  const h = makeHarness();
  const run = h.backend.sendUser('stop me');
  await flush();
  const request = controlTool();
  emitWire(h.processes[0], request);
  h.backend.stop();
  await run;
  await flush();

  assert.equal(h.processes[0].killCount, 1);
  assert.equal(
    h.events.filter((event) => event.type === 'error' && event.kind === 'aborted').length,
    1,
  );
  assert.equal(h.events.filter((event) => event.type === 'tool-denied').length, 1);
});

test('API channel keeps route credentials local and redacts process failures', async () => {
  let routeClosed = 0;
  const h = makeHarness({
    state: { channel: 'api' },
    resolveApiProvider: async () => ({
      id: 'provider-1',
      baseUrl: 'https://provider.example',
      requestProfileRevision: 1,
    }),
    resolveRequestProfile: async () => ({}),
    resolveCapability: async () => ({ ok: true }),
    createProviderRoute: () => ({
      start: async () => ({
        origin: 'http://127.0.0.1:42100',
        routeToken: 'route-secret',
      }),
      close: async () => { routeClosed += 1; },
    }),
    getProviderSensitiveValues: () => ['provider-secret'],
  });
  const run = h.backend.sendUser('api turn');
  await flush();
  assert.equal(h.spawns[0].options.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:42100');
  assert.equal(h.spawns[0].options.env.ANTHROPIC_AUTH_TOKEN, 'route-secret');
  h.processes[0].stderr.emit('data', 'provider-secret route-secret');
  h.processes[0].emit('exit', 1, null);
  await run;
  await flush();

  const error = h.events.find((event) => event.type === 'error');
  assert.equal(error.message, 'Provider CLI request failed.');
  assert.equal(JSON.stringify(h.events).includes('provider-secret'), false);
  assert.equal(JSON.stringify(h.events).includes('route-secret'), false);
  assert.equal(routeClosed, 1);
});
