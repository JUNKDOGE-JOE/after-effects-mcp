import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _createRpc, resolveMcpCommand } from '../src/cep/mcpClient.js';

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

test('resolveMcpCommand prefers an explicit executable path', async () => {
  const result = await resolveMcpCommand({
    explicitPath: 'C:/tools/ae-mcp.exe',
    whereImpl: () => { throw new Error('should not call where'); },
  });

  assert.deepEqual(result, { command: 'C:/tools/ae-mcp.exe', args: [], source: 'explicit' });
});

test('resolveMcpCommand uses where ae-mcp when no explicit path is configured', async () => {
  const result = await resolveMcpCommand({
    whereImpl: async () => 'C:\\Tools\\ae-mcp.exe\r\n',
  });

  assert.deepEqual(result, { command: 'C:\\Tools\\ae-mcp.exe', args: [], source: 'where' });
});

test('resolveMcpCommand falls back to uv project command in development mode', async () => {
  const result = await resolveMcpCommand({
    whereImpl: async () => '',
    extRoot: 'E:/Code/ae-mcp-codex-p5a/plugin/panel',
    fsImpl: { existsSync: (p) => p === 'E:\\Code\\ae-mcp-codex-p5a\\pyproject.toml' },
  });

  assert.equal(result.command, 'uv');
  assert.deepEqual(result.args.slice(0, 3), ['run', '--project', 'E:\\Code\\ae-mcp-codex-p5a']);
  assert.equal(result.args[3], 'ae-mcp');
  assert.equal(result.source, 'uv');
});

test('resolveMcpCommand reports a repair hint when no executable can be found', async () => {
  await assert.rejects(
    resolveMcpCommand({
      whereImpl: async () => '',
      extRoot: 'E:/missing/plugin/panel',
      fsImpl: { existsSync: () => false },
    }),
    /Unable to find ae-mcp/,
  );
});
