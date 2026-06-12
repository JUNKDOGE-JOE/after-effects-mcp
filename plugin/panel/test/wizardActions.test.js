import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectRepoRoot,
  detectTool,
  buildInstallCommands,
  openLoginTerminal,
  runAction,
} from '../src/cep/wizardActions.js';

function fakeExecFile(results) {
  return (file, args, opts, cb) => {
    const key = [file, ...(args || [])].join(' ');
    const r = results[key] || { err: new Error('not found'), stdout: '', stderr: '' };
    setImmediate(() => cb(r.err || null, r.stdout || '', r.stderr || ''));
  };
}

test('detectTool parses versions and reports missing', async () => {
  const execFile = fakeExecFile({
    'uv --version': { stdout: 'uv 0.7.2' },
    'node --version': { stdout: 'v24.14.0' },
  });
  assert.deepEqual(await detectTool('uv', { execFileImpl: execFile }), { ok: true, version: 'uv 0.7.2' });
  assert.deepEqual(await detectTool('node', { execFileImpl: execFile }), { ok: true, version: 'v24.14.0' });
  assert.equal((await detectTool('claude', { execFileImpl: execFile })).ok, false);
});

test('detectTool falls back to the uv tool shim for ae-mcp before PATH refresh', async () => {
  const execFile = fakeExecFile({
    'C:\\Users\\X\\.local\\bin\\ae-mcp.exe --version': { stdout: 'ae-mcp 0.5.0' },
  });
  const result = await detectTool('aeMcp', { execFileImpl: execFile, env: { USERPROFILE: 'C:\\Users\\X' } });
  assert.deepEqual(result, { ok: true, version: 'ae-mcp 0.5.0' });
  const missing = await detectTool('aeMcp', { execFileImpl: execFile, env: { USERPROFILE: 'C:\\Users\\Y' } });
  assert.equal(missing.ok, false);
});

test('ae-mcp install command pins the release tag for end users', () => {
  const cmds = buildInstallCommands({ panelVersion: '0.5.0', repoRoot: '' });
  const aeMcp = cmds.aeMcp;
  assert.equal(aeMcp.file, 'uv');
  const joined = aeMcp.args.join(' ');
  assert.ok(joined.includes('git+https://github.com/JUNKDOGE-JOE/after-effects-mcp@v0.5.0#subdirectory=packages/core'));
  assert.ok(joined.includes('#subdirectory=packages/bridge'));
  assert.ok(joined.includes('#subdirectory=packages/snapshot-mss'));
});

test('ae-mcp install command uses local paths on a dev checkout', () => {
  const cmds = buildInstallCommands({ panelVersion: '0.5.0', repoRoot: 'E:\\repo' });
  const joined = cmds.aeMcp.args.join(' ');
  assert.ok(joined.includes('E:\\repo\\packages\\core'));
  assert.ok(!joined.includes('git+https'));
});

test('runAction streams chunks and resolves ok by exit code', async () => {
  const events = [];
  const fakeSpawn = () => {
    const handlers = {};
    const child = {
      stdout: { on: (e, cb) => { if (e === 'data') handlers.out = cb; } },
      stderr: { on: (e, cb) => { if (e === 'data') handlers.errout = cb; } },
      on: (e, cb) => { if (e === 'exit') handlers.exit = cb; },
    };
    setImmediate(() => { handlers.out('hello '); handlers.out('world'); handlers.exit(0); });
    return child;
  };
  const result = await runAction({ file: 'x', args: [], spawnImpl: fakeSpawn, onChunk: (c) => events.push(c) });
  assert.equal(result.ok, true);
  assert.deepEqual(events, ['hello ', 'world']);
  assert.ok(result.output.includes('hello world'));
});

test('openLoginTerminal launches a visible terminal for claude and codex login', () => {
  const calls = [];
  const spawnImpl = (file, args, opts) => {
    calls.push({ file, args, opts });
    return { unref: () => {} };
  };

  assert.equal(openLoginTerminal({ tool: 'claude', spawnImpl }), true);
  assert.equal(openLoginTerminal({ tool: 'codex', spawnImpl }), true);

  assert.equal(calls[0].file, 'cmd');
  assert.deepEqual(calls[0].args, ['/c', 'start', 'ae-mcp login', 'pwsh', '-NoExit', '-Command', 'claude']);
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.windowsHide, false);
  assert.deepEqual(calls[1].args, ['/c', 'start', 'ae-mcp login', 'pwsh', '-NoExit', '-Command', 'codex login']);
});

test('detectRepoRoot reuses the mcpClient project root probe', () => {
  const root = detectRepoRoot({
    extRoot: 'E:/repo/plugin/panel',
    fsImpl: { existsSync: (p) => p === 'E:\\repo\\pyproject.toml' },
  });

  assert.equal(root, 'E:\\repo');
});
