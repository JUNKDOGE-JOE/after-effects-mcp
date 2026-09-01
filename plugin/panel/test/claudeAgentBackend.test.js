import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import {
  CLAUDE_MINIMUM_VERSION,
  createClaudeAgentBackend,
  CLAUDE_NO_PROGRESS_WARNING_MS,
  resolveClaudeCli,
} from '../src/cep/claudeAgentBackend.js';
import { CLAUDE_MODELS } from '../src/lib/backendCapabilities.js';

const SPIKE_ROOT = new URL('./fixtures/claude-cli-spike/', import.meta.url);

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
    this.encodings = [];
    this.stdout.setEncoding = (value) => { this.encodings.push(['stdout', value]); };
    this.stderr.setEncoding = (value) => { this.encodings.push(['stderr', value]); };
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

function resolvedClaude(version = '2.1.257') {
  const executable = {
    ok: true,
    id: 'claude',
    path: 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe',
    displayPath: 'C:\\npm\\claude.cmd',
    argsPrefix: [],
    source: 'path',
    version,
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
      url: 'http://127.0.0.1:11488/mcp/c/claude-default-token',
    })),
    getToolMeta: overrides.getToolMeta || (async () => toolMeta()),
    getModel: () => state.model,
    getPermissionMode: () => state.permissionMode,
    getEffort: () => state.effort,
    getThinking: () => state.thinking,
    getChannel: () => state.channel,
    onEvent: (event) => events.push(event),
    getLang: overrides.getLang,
    lang: overrides.lang || 'en',
    now: overrides.now || (() => 100),
    setTimeoutImpl: overrides.setTimeoutImpl,
    clearTimeoutImpl: overrides.clearTimeoutImpl,
    noProgressWarningMs: overrides.noProgressWarningMs,
    env: overrides.env,
    spawnImpl: overrides.spawnImpl,
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
    ['ARCH_MISMATCH', /architecture mismatch/i],
    ['PROBE_FAILED', /probe failed/i],
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

test('Claude decodes both child-process streams as UTF-8', async () => {
  const h = makeHarness();
  const run = h.backend.sendUser('utf8');
  await flush();
  assert.deepEqual(h.processes[0].encodings, [
    ['stdout', 'utf8'],
    ['stderr', 'utf8'],
  ]);
  finishTurn(h.processes[0]);
  await run;
});

test('Claude reports spawn and dispatch before output and omits spawn on a warm turn', async () => {
  const h = makeHarness();
  const first = h.backend.sendUser({ turnId: 'turn-progress-1', text: 'hello', attachments: [] });
  await flush();
  const coldStages = h.events.filter((event) => event.type === 'turn-progress');
  assert.deepEqual(coldStages.map((event) => event.stage), ['spawn', 'dispatch']);
  assert.ok(coldStages.every((event) => event.turnId === 'turn-progress-1'));

  emitWire(h.processes[0], wire('B', 3));
  emitWire(h.processes[0], wire('B', 6));
  emitWire(h.processes[0], wire('B', 84));
  emitWire(h.processes[0], wire('B', 94));
  finishTurn(h.processes[0], 99);
  await first;
  const acceptedIndex = h.events.findIndex((event) => event.type === 'turn-accepted');
  const textIndex = h.events.findIndex((event) => event.type === 'text-delta');
  assert.ok(coldStages.every((event) => h.events.indexOf(event) < acceptedIndex));
  assert.ok(coldStages.every((event) => h.events.indexOf(event) < textIndex));

  const boundary = h.events.length;
  const second = h.backend.sendUser({ turnId: 'turn-progress-2', text: 'again', attachments: [] });
  await flush();
  emitWire(h.processes[0], wire('B', 101));
  emitWire(h.processes[0], wire('B', 137));
  finishTurn(h.processes[0], 142);
  await second;
  assert.deepEqual(
    h.events.slice(boundary).filter((event) => event.type === 'turn-progress').map((event) => event.stage),
    ['dispatch'],
  );
  assert.equal(h.processes.length, 1);
});

test('Claude thinking_tokens emits estimated tokens and elapsed turn progress', async () => {
  let clock = 1000;
  const h = makeHarness({ now: () => clock });
  const run = h.backend.sendUser({ turnId: 'turn-thinking-progress', text: 'think', attachments: [] });
  await flush();

  clock = 1375;
  emitWire(h.processes[0], {
    type: 'system',
    subtype: 'thinking_tokens',
    estimated_tokens: 42,
  });

  assert.deepEqual(h.events.find((event) => event.type === 'turn-progress' && event.stage === 'thinking'), {
    type: 'turn-progress',
    turnId: 'turn-thinking-progress',
    stage: 'thinking',
    estimatedTokens: 42,
    elapsedMs: 375,
  });
  finishTurn(h.processes[0]);
  await run;
});

test('Claude soft watchdog warns once after no progress without killing or retrying', async () => {
  let clock = 0;
  let watchdog;
  const h = makeHarness({
    now: () => clock,
    noProgressWarningMs: CLAUDE_NO_PROGRESS_WARNING_MS,
    setTimeoutImpl: (callback) => {
      watchdog = callback;
      return watchdog;
    },
    clearTimeoutImpl: () => {},
  });
  const run = h.backend.sendUser({ turnId: 'turn-watchdog', text: 'long task', attachments: [] });
  await flush();
  assert.equal(typeof watchdog, 'function');

  clock = CLAUDE_NO_PROGRESS_WARNING_MS;
  watchdog();
  assert.deepEqual(h.events.find((event) => event.type === 'turn-progress-warning'), {
    type: 'turn-progress-warning',
    turnId: 'turn-watchdog',
    elapsedMs: CLAUDE_NO_PROGRESS_WARNING_MS,
    warningMs: CLAUDE_NO_PROGRESS_WARNING_MS,
  });
  assert.equal(h.processes[0].killCount, 0);
  assert.equal(h.processes.length, 1);

  emitWire(h.processes[0], {
    type: 'system',
    subtype: 'thinking_tokens',
    estimated_tokens: 1,
  });
  assert.equal(h.events.filter((event) => event.type === 'turn-progress-warning').length, 1);
  finishTurn(h.processes[0]);
  await run;
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
        url: 'http://127.0.0.1:11488/mcp/c/claude-default-token',
      },
    },
  });
  finishTurn(h.processes[0]);
  await run;
});

test('Claude serializes every advertised model and effort pair', async () => {
  for (const model of CLAUDE_MODELS) {
    for (const effort of model.effortLevels) {
      const h = makeHarness({ state: { model: model.id, effort } });
      const run = h.backend.sendUser('reply OK');
      await flush();
      const args = h.spawns[0].args;
      assert.equal(args[args.indexOf('--model') + 1], model.id, `${model.id}/${effort}`);
      assert.equal(args[args.indexOf('--effort') + 1], effort, `${model.id}/${effort}`);
      finishTurn(h.processes[0]);
      await run;
      h.backend.reset();
    }
  }
});

test('Claude blocks a model when the resolved CLI is below its declared minimum', async () => {
  const h = makeHarness({
    state: { model: 'claude-fable-5-1' },
    resolveClaude: async () => resolvedClaude('2.1.227'),
  });
  const run = h.backend.sendUser('should not spawn');
  await flush();
  assert.equal(h.spawns.length, 0);
  const error = h.events.find((event) => event.type === 'error');
  assert.equal(error.code, 'CLI_TOO_OLD');
  assert.match(error.message, /2\.1\.227/);
  assert.match(error.message, /2\.1\.251/);
  assert.match(error.message, /claude update/i);
  assert.match(error.message, /换一个模型|another model/i);
  await run;
});

test('Claude spawns Fable on a supported CLI and Opus on an older supported CLI', async () => {
  for (const state of [
    { model: 'claude-fable-5-1', version: '2.1.257' },
    { model: 'claude-opus-5', version: '2.1.227' },
  ]) {
    const h = makeHarness({
      state: { model: state.model },
      resolveClaude: async () => resolvedClaude(state.version),
    });
    const run = h.backend.sendUser('spawn');
    await flush();
    assert.equal(h.spawns.length, 1, state.model);
    finishTurn(h.processes[0]);
    await run;
  }
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

test('Claude flushes redacted assistant text before tool_use events', async () => {
  const selected = 'C:\\' + 's'.repeat(61);
  assert.equal(selected.length, 64);
  const h = makeHarness();
  h.fs.files.add(selected);
  const run = h.backend.sendUser({
    turnId: 'turn-text-order',
    text: 'use a tool',
    attachments: [{
      id: 'att-sensitive',
      name: 'sensitive.txt',
      mediaType: 'text/plain',
      size: 1,
      temporary: false,
      localPath: selected,
    }],
  });
  await flush();

  const beforeToolChunks = [
    'The composition is ready, and the expression setup is complete up to globalA',
    'lpha 0.7 before the tool runs.',
  ];
  for (const text of beforeToolChunks) {
    emitWire(h.processes[0], {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text },
      },
    });
  }
  emitWire(h.processes[0], {
    type: 'assistant',
    message: {
      content: [{
        type: 'tool_use',
        id: 'tool_text_order',
        name: 'mcp__ae__ae_exec',
        input: { value: 1 },
      }],
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

  finishTurn(h.processes[0]);
  await run;
  assert.equal(
    h.events.filter((event) => event.type === 'text-delta').map((event) => event.text).join(''),
    beforeToolChunks.join(''),
  );
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
    kind: 'backend',
    code: 'CLI_MISSING',
    message: 'Install Claude CLI 2.x.',
    detail: {
      resolution: {
        code: 'NOT_FOUND',
        attempts: [],
      },
    },
    turnId: 'turn-missing',
    dispatchState: 'not-started',
  });
});

test('is_error emits one upstream error and settles the active turn', async () => {
  const h = makeHarness();
  const run = h.backend.sendUser({ turnId: 'turn-upstream', text: 'hello', attachments: [] });
  await flush();
  emitWire(h.processes[0], {
    type: 'result',
    is_error: true,
    result: 'relay rejected the request with status 429',
  });
  await run;

  const errors = h.events.filter((event) => event.type === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'UPSTREAM_HTTP_429');
  assert.equal(errors[0].detail.httpStatus, 429);
  assert.equal(errors[0].detail.upstreamMessage, 'relay rejected the request with status 429');

  const next = h.backend.sendUser({ turnId: 'turn-after-error', text: 'again', attachments: [] });
  await flush();
  assert.equal(written(h.processes[0]).filter((message) => message.type === 'user').length, 2);
  finishTurn(h.processes[0]);
  await next;
});

test('Claude reads getLang for each resolution failure without rebuilding the backend', async () => {
  let currentLang = 'en';
  const h = makeHarness({
    getLang: () => currentLang,
    resolveClaude: async () => ({ ok: false, code: 'NOT_FOUND' }),
  });

  await h.backend.sendUser({ turnId: 'turn-en', text: 'hello', attachments: [] });
  currentLang = 'zh';
  await h.backend.sendUser({ turnId: 'turn-zh', text: 'hello', attachments: [] });

  const errors = h.events.filter((event) => event.type === 'error');
  assert.match(errors[0].message, /not found/i);
  assert.match(errors[1].message, /未找到/);
  assert.equal(h.spawns.length, 0);
});

test('spawn ENOENT is classified separately from a later process exit', async () => {
  const h = makeHarness({
    spawnImpl() {
      const error = new Error('spawn claude ENOENT');
      error.code = 'ENOENT';
      throw error;
    },
  });
  await h.backend.sendUser({ turnId: 'turn-spawn', text: 'hello', attachments: [] });

  const error = h.events.find((event) => event.type === 'error');
  assert.equal(error.code, 'SPAWN_FAILED');
  assert.equal(error.detail.spawnCode, 'ENOENT');
  assert.equal(error.dispatchState, 'not-started');
});

test('process exit stderr detects an unauthenticated Claude CLI', async () => {
  const h = makeHarness();
  const run = h.backend.sendUser({ turnId: 'turn-auth', text: 'hello', attachments: [] });
  await flush();
  h.processes[0].stderr.emit('data', 'Not logged ');
  h.processes[0].stderr.emit('data', 'in. Please run /login.');
  h.processes[0].emit('exit', 1, null);
  await run;

  const error = h.events.find((event) => event.type === 'error');
  assert.equal(error.code, 'AUTH_REQUIRED');
  assert.equal(error.kind, 'auth');
  assert.equal(error.detail.exitCode, 1);
  assert.match(error.detail.stderrTail, /Not logged in/);
});

test('architecture resolution has dedicated guidance and bounded attempts', async () => {
  const h = makeHarness({
    resolveClaude: async () => ({
      ok: false,
      code: 'ARCH_MISMATCH',
      resolution: {
        code: 'ARCH_MISMATCH',
        attempts: [{
          path: 'C:\\Tools\\claude.exe',
          source: 'path',
          detail: 'architecture arm64 does not match x64',
        }],
      },
    }),
  });
  await h.backend.sendUser({ turnId: 'turn-arch', text: 'hello', attachments: [] });

  const error = h.events.find((event) => event.type === 'error');
  assert.equal(error.code, 'CLI_ARCH_MISMATCH');
  assert.match(error.message, /arm64/);
  assert.deepEqual(error.detail.resolution.attempts, [{
    path: 'C:\\Tools\\claude.exe',
    source: 'path',
    detail: 'architecture arm64 does not match x64',
  }]);
});

test('stderr delta redaction catches an attachment path split across chunks', async () => {
  const h = makeHarness();
  const selected = 'C:\\private\\customer.mov';
  h.fs.files.add(selected);
  const run = h.backend.sendUser({
    turnId: 'turn-stderr-secret',
    text: 'inspect',
    attachments: [{
      id: 'att-1',
      name: 'customer.mov',
      size: 10,
      mediaType: 'video/quicktime',
      temporary: false,
      localPath: selected,
    }],
  });
  await flush();
  h.processes[0].stderr.emit('data', 'failed C:\\private\\');
  h.processes[0].stderr.emit('data', 'customer.mov');
  h.processes[0].emit('exit', 1, null);
  await run;

  const rendered = JSON.stringify(h.events);
  assert.equal(rendered.includes(selected), false);
  assert.match(rendered, /\[redacted\]/);
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

test('Claude emits a session reference when stream-json reveals the session id', async () => {
  const h = makeHarness();
  const run = h.backend.sendUser('hello');
  await flush();
  emitWire(h.processes[0], { type: 'system', subtype: 'init', session_id: 'claude-session-1' });
  finishTurn(h.processes[0]);
  await run;
  assert.deepEqual(h.events.find((event) => event.type === 'session-ref'), {
    type: 'session-ref',
    ref: { kind: 'claude-session', id: 'claude-session-1' },
  });
  assert.deepEqual(h.backend.getSessionRef(), h.events.filter((event) => event.type === 'session-ref').at(-1).ref);
});

test('Claude adopts a stored session id for the next spawn', async () => {
  const h = makeHarness();
  h.backend.adoptSessionRef({ kind: 'claude-session', id: 'claude-saved' });
  const run = h.backend.sendUser('continue');
  await flush();
  const args = h.spawns[0].args;
  assert.equal(args[args.indexOf('--resume') + 1], 'claude-saved');
  h.backend.reset();
  await run;
});

test('Claude retries a missing resumed session once without --resume', async () => {
  const h = makeHarness();
  h.backend.adoptSessionRef({ kind: 'claude-session', id: 'claude-missing' });
  const run = h.backend.sendUser('continue');
  await flush();
  emitWire(h.processes[0], {
    type: 'result',
    subtype: 'error',
    is_error: true,
    result: 'No conversation found for session claude-missing',
  });
  await flush(24);
  assert.equal(h.processes.length, 2);
  assert.equal(h.spawns[1].args.includes('--resume'), false);
  assert.equal(written(h.processes[1]).filter((message) => message.type === 'user').length, 1);
  emitWire(h.processes[1], { type: 'system', subtype: 'init', session_id: 'claude-new' });
  emitWire(h.processes[1], {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'continued',
    session_id: 'claude-new',
  });
  await run;
  assert.deepEqual(h.backend.getSessionRef(), { kind: 'claude-session', id: 'claude-new' });
  assert.equal(h.events.filter((event) => event.type === 'session-ref').at(-1).ref.id, 'claude-new');
});

test('Claude transcript deletion is explicitly delegated to the CLI', async () => {
  const h = makeHarness();
  assert.deepEqual(await h.backend.deleteSessionRef({ kind: 'claude-session', id: 'one' }), {
    ok: true,
    skipped: true,
    detail: 'claude CLI owns its transcript files',
  });
});
