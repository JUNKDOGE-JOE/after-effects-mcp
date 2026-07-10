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
  return {
    stdin: { write() {} },
    stdout: { on(event, handler) { if (event === 'data') stdoutHandlers.push(handler); } },
    stderr: { on() {} },
    on() {},
    kill() {},
    pushStdout(message) {
      const line = typeof message === 'string' ? message : JSON.stringify(message) + '\n';
      for (const handler of stdoutHandlers) handler(line);
    },
  };
}

// Spawn fake that auto-answers initialize (with a configurable result) and
// tools/list so createMcpClient.start() resolves to ready.
function spawnReplying(initResult) {
  let proc = null;
  const spawnImpl = () => {
    proc = makeFakeProc();
    const origWrite = proc.stdin.write;
    proc.stdin.write = (line) => {
      origWrite(line);
      const msg = JSON.parse(line);
      if (msg.method === 'initialize') {
        proc.pushStdout({ jsonrpc: '2.0', id: msg.id, result: initResult });
      } else if (msg.method === 'tools/list') {
        proc.pushStdout({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } });
      }
    };
    return proc;
  };
  return { spawnImpl };
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
