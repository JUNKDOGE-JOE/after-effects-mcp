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

test('resolveSidecarPath returns deployed sidecar when present', () => {
  const hits = new Set(['C:\\ext\\sidecar\\agent-sidecar.mjs']);
  const result = resolveSidecarPath({
    extRoot: 'C:/ext/',
    fsImpl: { existsSync: (p) => hits.has(p) },
  });

  assert.equal(result, 'C:\\ext\\sidecar\\agent-sidecar.mjs');
});

test('resolveSidecarPath returns repo sidecar when deployed path is missing', () => {
  const hits = new Set(['C:\\repo\\plugin\\panel\\..\\sidecar\\agent-sidecar.mjs']);
  const result = resolveSidecarPath({
    extRoot: 'C:/repo/plugin/panel',
    fsImpl: { existsSync: (p) => hits.has(p) },
  });

  assert.equal(result, 'C:\\repo\\plugin\\panel\\..\\sidecar\\agent-sidecar.mjs');
});

test('resolveSidecarPath returns deployed candidate when neither exists', () => {
  const result = resolveSidecarPath({
    extRoot: 'C:/missing',
    fsImpl: { existsSync: () => false },
  });

  assert.equal(result, 'C:\\missing\\sidecar\\agent-sidecar.mjs');
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
