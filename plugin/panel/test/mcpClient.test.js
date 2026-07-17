import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _createRpc, createMcpClient, findProjectRoot, resolveMcpCommand } from '../src/cep/mcpClient.js';

function makeRpc(timeoutMs = 50) {
  const writes = [];
  let pushChunk = null;
  const rpc = _createRpc(
    (text) => writes.push(text),
    (handler) => { pushChunk = handler; },
    { timeoutMs },
  );
  return { rpc, writes, pushChunk: (text) => pushChunk(text) };
}

test('_createRpc pairs requests with out-of-order responses', async () => {
  const io = makeRpc();

  const first = io.rpc.request('first', { a: 1 });
  const second = io.rpc.request('second', { b: 2 });
  const sent = io.writes.map((line) => JSON.parse(line));

  io.pushChunk(JSON.stringify({ jsonrpc: '2.0', id: sent[1].id, result: 'two' }) + '\n');
  io.pushChunk(JSON.stringify({ jsonrpc: '2.0', id: sent[0].id, result: 'one' }) + '\n');

  assert.equal(await first, 'one');
  assert.equal(await second, 'two');
});

test('_createRpc buffers torn lines before parsing JSON-RPC frames', async () => {
  const io = makeRpc();

  const pending = io.rpc.request('split', {});
  const id = JSON.parse(io.writes[0]).id;

  io.pushChunk('{"jsonrpc":"2.0","id":');
  io.pushChunk(String(id) + ',"result":{"ok":true}}\n');

  assert.deepEqual(await pending, { ok: true });
});

test('_createRpc rejects timed out requests', async () => {
  const io = makeRpc(5);

  await assert.rejects(io.rpc.request('slow', {}), /timed out/);
});

test('_createRpc supports a longer timeout for cold-start initialization', async () => {
  const io = makeRpc(5);

  const pending = io.rpc.request('initialize', {}, 50);
  const id = JSON.parse(io.writes[0]).id;
  await new Promise((resolve) => setTimeout(resolve, 10));
  io.pushChunk(JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } }) + '\n');

  assert.deepEqual(await pending, { ok: true });
});

test('_createRpc rejects JSON-RPC error responses', async () => {
  const io = makeRpc();

  const pending = io.rpc.request('bad', {});
  const id = JSON.parse(io.writes[0]).id;
  io.pushChunk(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -1, message: 'nope' } }) + '\n');

  await assert.rejects(pending, /nope/);
});

function fakeCommandPlatform({ launcher = '/Users/a/.ae-mcp/bin/ae-mcp', resolved = null, exists = () => false } = {}) {
  return {
    id: launcher.includes('\\') ? 'windows-x64' : 'macos-arm64',
    paths: {
      launcher,
      join: (parts) => parts.join(launcher.includes('\\') ? '\\' : '/'),
      dirname: (value) => value.slice(0, Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))),
      resolve: (parts) => parts.join(launcher.includes('\\') ? '\\' : '/').replace(/\//g, launcher.includes('\\') ? '\\' : '/'),
    },
    fs: { existsSync: exists },
    resolveExecutable: async () => resolved || ({ ok: true, id: 'ae-mcp', path: launcher, argsPrefix: [], source: 'runtime', version: null, arch: null }),
  };
}

test('resolveMcpCommand prefers an explicit executable path', async () => {
  const result = await resolveMcpCommand({
    explicitPath: 'C:/tools/ae-mcp.exe',
    platform: fakeCommandPlatform(),
  });

  assert.deepEqual(result, { command: 'C:/tools/ae-mcp.exe', args: [], source: 'explicit' });
});

test('resolveMcpCommand prefers the installed stable launcher on both platforms', async () => {
  const mac = fakeCommandPlatform({ launcher: '/Users/a/.ae-mcp/bin/ae-mcp' });
  const win = fakeCommandPlatform({ launcher: 'C:\\Users\\a\\.ae-mcp\\bin\\ae-mcp.exe' });
  assert.deepEqual(await resolveMcpCommand({ platform: mac }), {
    command: '/Users/a/.ae-mcp/bin/ae-mcp', args: [], source: 'runtime',
  });
  assert.deepEqual(await resolveMcpCommand({ platform: win }), {
    command: 'C:\\Users\\a\\.ae-mcp\\bin\\ae-mcp.exe', args: [], source: 'runtime',
  });
});

test('resolveMcpCommand lets the macOS RuntimeManager verify and activate before spawn', async () => {
  const platform = fakeCommandPlatform({ launcher: '/Users/a/.ae-mcp/bin/ae-mcp' });
  const calls = [];
  const result = await resolveMcpCommand({
    platform,
    extRoot: '/Applications/AE MCP 插件',
    runtimeManager: {
      async ensureReady() {
        calls.push('ensureReady');
        return {
          action: 'install',
          launcher: platform.paths.launcher,
          version: '0.9.3',
          sourceCommitSha: 'a'.repeat(40),
        };
      },
    },
  });

  assert.deepEqual(calls, ['ensureReady']);
  assert.equal(result.command, platform.paths.launcher);
  assert.equal(result.source, 'runtime-manager');
  assert.equal(result.runtime.version, '0.9.3');
});

test('resolveMcpCommand allows PATH only for an explicit .debug install without a bundle', async () => {
  const calls = [];
  const platform = fakeCommandPlatform({
    launcher: '/Users/a/.ae-mcp/bin/ae-mcp',
    exists: (candidate) => candidate === '/Applications/AE MCP/.debug',
  });
  platform.resolveExecutable = async (_id, options) => {
    calls.push(options);
    return { ok: true, path: '/Users/a/.local/bin/ae-mcp', argsPrefix: [], source: 'path' };
  };

  const result = await resolveMcpCommand({ platform, extRoot: '/Applications/AE MCP' });

  assert.equal(result.command, '/Users/a/.local/bin/ae-mcp');
  assert.deepEqual(calls, [{ allowDevelopmentPath: true }]);
});

test('findProjectRoot is exported for wizard repo probing', () => {
  const platform = fakeCommandPlatform({ launcher: 'E:\\Users\\a\\.ae-mcp\\bin\\ae-mcp.exe' });
  const root = findProjectRoot({
    extRoot: 'E:/repo/plugin/panel',
    repoRoot: '',
    platform,
    fsImpl: { existsSync: (p) => p === 'E:\\repo\\pyproject.toml' },
  });

  assert.equal(root, 'E:\\repo');
});

test('resolveMcpCommand reports a repair hint when no executable can be found', async () => {
  await assert.rejects(
    resolveMcpCommand({
      platform: fakeCommandPlatform({ resolved: { ok: false, id: 'ae-mcp', code: 'NOT_FOUND', attempts: [] } }),
    }),
    /Unable to find ae-mcp/,
  );
});

function makeFakeProc() {
  const stdoutHandlers = [];
  let killed = false;
  return {
    stdin: { write() {} },
    stdout: { on(event, handler) { if (event === 'data') stdoutHandlers.push(handler); } },
    stderr: { on() {} },
    on() {},
    kill() { killed = true; },
    get killed() { return killed; },
    pushStdout(message) {
      const line = typeof message === 'string' ? message : JSON.stringify(message) + '\n';
      for (const handler of stdoutHandlers) handler(line);
    },
  };
}

test('createMcpClient terminates a child that cannot initialize in time', async () => {
  const proc = makeFakeProc();
  const client = createMcpClient({
    spawnImpl: () => proc,
    resolveCommand: async () => ({ command: 'ae-mcp', args: [], source: 'explicit' }),
    initializeTimeoutMs: 5,
    retryDelays: [],
  });

  await assert.rejects(client.start(), /initialize timed out after 5ms/);
  assert.equal(proc.killed, true);
  assert.equal(client.state().status, 'error');
});

// Spawn fake that auto-answers initialize (with a configurable result) and
// tools/list so createMcpClient.start() resolves to ready.
function spawnReplying(initResult) {
  let proc = null;
  const spawnImpl = (_command, _args, options) => {
    proc = makeFakeProc();
    proc.spawnOptions = options;
    proc.clientWrites = [];
    const origWrite = proc.stdin.write;
    proc.stdin.write = (line) => {
      origWrite(line);
      const msg = JSON.parse(line);
      proc.clientWrites.push(msg);
      if (msg.method === 'initialize') {
        proc.pushStdout({ jsonrpc: '2.0', id: msg.id, result: initResult });
      } else if (msg.method === 'tools/list') {
        proc.pushStdout({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } });
      } else if (msg.method === 'tools/call') {
        proc.pushStdout({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: '{"ok":true}' }] },
        });
      }
    };
    return proc;
  };
  return { spawnImpl, getProc: () => proc };
}

test('createMcpClient captures server instructions from the initialize result', async () => {
  const { spawnImpl } = spawnReplying({ instructions: 'SERVER_GUIDE' });
  const client = createMcpClient({
    spawnImpl,
    resolveCommand: async () => ({ command: 'ae-mcp', args: [], source: 'explicit' }),
  });

  assert.equal(client.getServerInstructions(), '');
  await client.start();
  assert.equal(client.getServerInstructions(), 'SERVER_GUIDE');
  client.stop();
});

test('createMcpClient defaults server instructions to empty when absent', async () => {
  const { spawnImpl } = spawnReplying({});
  const client = createMcpClient({
    spawnImpl,
    resolveCommand: async () => ({ command: 'ae-mcp', args: [], source: 'explicit' }),
  });

  await client.start();
  assert.equal(client.getServerInstructions(), '');
  client.stop();
});

test('createMcpClient passes the Tool Library tier file into the direct MCP process', async () => {
  const { spawnImpl, getProc } = spawnReplying({});
  const client = createMcpClient({
    spawnImpl,
    env: { AE_MCP_TOOL_APPROVAL_TIER_FILE: '/tmp/panel.tier' },
    resolveCommand: async () => ({ command: 'ae-mcp', args: [], source: 'explicit' }),
  });

  await client.start();
  assert.equal(
    getProc().spawnOptions.env.AE_MCP_TOOL_APPROVAL_TIER_FILE,
    '/tmp/panel.tier',
  );
  client.stop();
});

test('createMcpClient keeps Developer Tools behind a per-process panel capability', async () => {
  const { spawnImpl, getProc } = spawnReplying({});
  const client = createMcpClient({
    spawnImpl,
    randomBytes: (size) => new Uint8Array(size).fill(0xab),
    resolveCommand: async () => ({ command: 'ae-mcp', args: [], source: 'explicit' }),
  });

  await client.start();
  assert.equal(getProc().spawnOptions.env.AE_MCP_PANEL_CAPABILITY, 'ab'.repeat(32));
  await client.callPanelTool('ae_toolIndex', { kinds: ['system-command'] });
  const call = getProc().clientWrites.find((message) => message.method === 'tools/call');
  assert.equal(call.params.arguments._ae_panel_capability, 'ab'.repeat(32));
  assert.equal(client.newOperationId(), 'ab'.repeat(16));
  client.stop();
});

test('createMcpClient relays elicitation with server metadata and responds', async () => {
  const initResult = {
    instructions: 'SERVER_GUIDE',
    serverInfo: { name: 'ae', version: '1.2.3' },
  };
  const { spawnImpl, getProc } = spawnReplying(initResult);
  const seen = [];
  const client = createMcpClient({
    spawnImpl,
    resolveCommand: async () => ({ command: 'ae-mcp', args: [], source: 'explicit' }),
    onElicitation: async (request, { signal }) => {
      seen.push({ request, signal });
      return { action: 'accept', content: { decision: 'once' } };
    },
  });
  await client.start();
  getProc().pushStdout({
    jsonrpc: '2.0',
    id: 77,
    method: 'elicitation/create',
    params: {
      mode: 'form',
      message: 'Approve tool?',
      requestedSchema: { type: 'object' },
      _meta: { progressToken: 'p1' },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(seen.length, 1);
  assert.equal(seen[0].request.message, 'Approve tool?');
  assert.equal(seen[0].request.mode, 'form');
  assert.deepEqual(seen[0].request.requestedSchema, { type: 'object' });
  assert.deepEqual(seen[0].request.serverInfo, initResult.serverInfo);
  assert.equal(seen[0].request.serverInstructions, 'SERVER_GUIDE');
  assert.deepEqual(seen[0].request.meta, { progressToken: 'p1' });
  assert.equal(seen[0].signal.aborted, false);
  assert.deepEqual(getProc().clientWrites.find((message) => message.id === 77), {
    jsonrpc: '2.0', id: 77, result: { action: 'accept', content: { decision: 'once' } },
  });
  client.stop();
});

test('createMcpClient declines elicitation when no callback is configured', async () => {
  const { spawnImpl, getProc } = spawnReplying({ serverInfo: { name: 'ae', version: '1' } });
  const client = createMcpClient({
    spawnImpl,
    resolveCommand: async () => ({ command: 'ae-mcp', args: [], source: 'explicit' }),
  });
  await client.start();
  getProc().pushStdout({
    jsonrpc: '2.0', id: 78, method: 'elicitation/create', params: { message: 'Approve?' },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(getProc().clientWrites.find((message) => message.id === 78), {
    jsonrpc: '2.0', id: 78, result: { action: 'decline', content: {} },
  });
  client.stop();
});

test('createMcpClient returns JSON-RPC method-not-found for unknown server requests', async () => {
  const { spawnImpl, getProc } = spawnReplying({ serverInfo: { name: 'ae', version: '1' } });
  const client = createMcpClient({
    spawnImpl,
    resolveCommand: async () => ({ command: 'ae-mcp', args: [], source: 'explicit' }),
  });
  await client.start();
  getProc().pushStdout({
    jsonrpc: '2.0', id: 79, method: 'unknown/request', params: {},
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(getProc().clientWrites.find((message) => message.id === 79), {
    jsonrpc: '2.0',
    id: 79,
    error: {
      code: -32601,
      message: 'Method not found',
      data: { method: 'unknown/request' },
    },
  });
  client.stop();
});
