import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { probeClaudeLogin, resolveSidecarPath } from '../src/cep/claudeAuth.js';

function makeProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = () => { proc.killed = true; };
  return proc;
}

async function nextTick() {
  await Promise.resolve();
  await Promise.resolve();
}

function windowsPaths() {
  return {
    join: (parts) => parts.join('\\').replace(/\\+/g, '\\'),
    resolve: (parts) => {
      const raw = parts.join('\\').replace(/\//g, '\\');
      const drive = raw.match(/^[A-Za-z]:/)?.[0] || '';
      const stack = [];
      for (const part of raw.slice(drive.length).split('\\').filter(Boolean)) {
        if (part === '..') stack.pop();
        else if (part !== '.') stack.push(part);
      }
      return drive + '\\' + stack.join('\\');
    },
  };
}

function windowsPlatform() {
  return { id: 'windows-x64', paths: windowsPaths() };
}

test('resolveSidecarPath returns the local sidecar only for a .debug development extension', () => {
  const hits = new Set(['C:\\ext\\.debug', 'C:\\ext\\sidecar\\agent-sidecar.mjs']);
  const result = resolveSidecarPath({
    extRoot: 'C:\\ext',
    platform: windowsPlatform(),
    fsImpl: { existsSync: (p) => hits.has(p) },
  });

  assert.equal(result, 'C:\\ext\\sidecar\\agent-sidecar.mjs');
});

test('resolveSidecarPath returns the bundled runtime sidecar in production', () => {
  const runtime = 'C:\\ext\\runtime\\windows-x64\\node\\sidecar\\agent-sidecar.mjs';
  const hits = new Set([runtime, 'C:\\ext\\sidecar\\agent-sidecar.mjs']);
  const result = resolveSidecarPath({
    extRoot: 'C:\\ext',
    platform: windowsPlatform(),
    fsImpl: { existsSync: (p) => hits.has(p) },
  });

  assert.equal(result, runtime);
});

test('resolveSidecarPath returns a diagnostic runtime candidate without throwing when payload is missing', () => {
  const result = resolveSidecarPath({
    extRoot: 'C:\\missing',
    platform: windowsPlatform(),
    fsImpl: { existsSync: () => false },
  });

  assert.equal(result, 'C:\\missing\\runtime\\windows-x64\\node\\sidecar\\agent-sidecar.mjs');
});

test('probeClaudeLogin resolves logged in probe-result', async () => {
  const proc = makeProc();
  let spawnArgs;
  const resultPromise = probeClaudeLogin({
    resolveNode: async () => ({ ok: true, nodePath: 'node.exe', version: '20.0.0' }),
    sidecarPath: 'sidecar.mjs',
    env: { ANTHROPIC_API_KEY: 'secret', KEEP: 'yes' },
    spawnImpl: (cmd, args, opts) => {
      spawnArgs = { cmd, args, opts };
      return proc;
    },
  });
  await nextTick();
  proc.stdout.emit('data', '{"t":"probe-result","ok":true,"loggedIn":true,"detail":"ready"}\n');

  assert.deepEqual(await resultPromise, { loggedIn: true, nodeOk: true, nodeVersion: '20.0.0', detail: 'ready' });
  assert.equal(spawnArgs.cmd, 'node.exe');
  assert.deepEqual(spawnArgs.args, ['sidecar.mjs', '--probe']);
  assert.equal(spawnArgs.opts.stdio, 'pipe');
  assert.equal(spawnArgs.opts.windowsHide, true);
  assert.equal(spawnArgs.opts.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(spawnArgs.opts.env.KEEP, 'yes');
});

test('probeClaudeLogin spawns the resolved Node through the platform adapter', async () => {
  const proc = makeProc();
  const executable = { ok: true, id: 'node', path: '/Users/a/.ae-mcp/runtime/current/bin/node', argsPrefix: [], source: 'runtime', version: '24.17.0', arch: 'arm64' };
  const calls = [];
  const platform = {
    resolveExecutable: async () => executable,
    completeSpawnEnv: (base, additions) => ({ ...base, ...additions }),
    spawn: (resolved, args, options) => { calls.push({ resolved, args, options }); return proc; },
  };
  const resultPromise = probeClaudeLogin({ platform, sidecarPath: '/ext/sidecar/agent-sidecar.mjs', env: { KEEP: 'yes' } });
  await nextTick();
  proc.stdout.emit('data', '{"t":"probe-result","loggedIn":true}\n');
  assert.equal((await resultPromise).loggedIn, true);
  assert.equal(calls[0].resolved, executable);
  assert.equal(calls[0].options.shell, undefined);
});

test('probeClaudeLogin resolves not logged in probe-result', async () => {
  const proc = makeProc();
  const resultPromise = probeClaudeLogin({
    resolveNode: async () => ({ ok: true, nodePath: 'node.exe', version: '18.19.0' }),
    sidecarPath: 'sidecar.mjs',
    spawnImpl: () => proc,
  });
  await nextTick();
  proc.stdout.emit('data', '{"t":"probe-result","ok":false,"loggedIn":false,"reason":"login required"}\n');

  assert.deepEqual(await resultPromise, { loggedIn: false, nodeOk: true, nodeVersion: '18.19.0', detail: 'login required' });
});

test('probeClaudeLogin kills process on timeout', async () => {
  const proc = makeProc();
  const result = await probeClaudeLogin({
    resolveNode: async () => ({ ok: true, nodePath: 'node.exe', version: '20.0.0' }),
    sidecarPath: 'sidecar.mjs',
    spawnImpl: () => proc,
    timeoutMs: 1,
  });

  assert.equal(proc.killed, true);
  assert.deepEqual(result, { loggedIn: false, nodeOk: true, nodeVersion: '20.0.0', detail: 'probe timeout' });
});

test('probeClaudeLogin reports stderr tail when process exits without result', async () => {
  const proc = makeProc();
  const resultPromise = probeClaudeLogin({
    resolveNode: async () => ({ ok: true, nodePath: 'node.exe', version: '20.0.0' }),
    sidecarPath: 'sidecar.mjs',
    spawnImpl: () => proc,
  });
  await nextTick();
  proc.stderr.emit('data', 'first\n');
  proc.stderr.emit('data', 'last error\n');
  proc.emit('exit', 1);

  assert.deepEqual(await resultPromise, { loggedIn: false, nodeOk: true, nodeVersion: '20.0.0', detail: 'first\nlast error' });
});

test('probeClaudeLogin reports resolveNode failure and does not spawn', async () => {
  let spawned = false;
  const result = await probeClaudeLogin({
    resolveNode: async () => ({ ok: false, detail: 'node missing' }),
    sidecarPath: 'sidecar.mjs',
    spawnImpl: () => { spawned = true; },
  });

  assert.equal(spawned, false);
  assert.deepEqual(result, { loggedIn: false, nodeOk: false, detail: 'node missing' });
});
