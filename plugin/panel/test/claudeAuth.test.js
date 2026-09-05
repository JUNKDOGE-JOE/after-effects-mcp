import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { probeClaudeLogin } from '../src/cep/claudeAuth.js';

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

function authPlatform(proc, calls = []) {
  return {
    id: 'windows-x64',
    completeSpawnEnv: (base = {}, additions = {}) => ({ ...base, ...additions }),
    spawn: (resolved, args, options) => {
      calls.push({ resolved, args, options });
      return proc;
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

test('probeClaudeLogin uses claude auth status and strips provider env', async () => {
  const proc = makeProc();
  let spawnArgs;
  const resultPromise = probeClaudeLogin({
    platform: authPlatform(proc),
    resolveClaude: async () => resolvedClaude(),
    env: { ANTHROPIC_API_KEY: 'secret', KEEP: 'yes' },
    spawnImpl: (cmd, args, opts) => {
      spawnArgs = { cmd, args, opts };
      return proc;
    },
  });
  await nextTick();
  proc.stdout.emit('data', '{\n  "loggedIn": true,\n  "email": "private@example.test"\n}\n');
  proc.emit('exit', 0);

  assert.deepEqual(await resultPromise, {
    loggedIn: true,
    cli: { path: 'C:\\npm\\claude.cmd', version: '2.1.227', source: 'path', script: '',
      launchPath: resolvedClaude().cliPath, realPath: resolvedClaude().cliPath },
    cliOk: true,
    cliVersion: '2.1.227',
    cliPath: 'C:\\npm\\claude.cmd',
    reason: null,
    detail: '2.1.227 · C:\\npm\\claude.cmd',
  });
  assert.equal(spawnArgs.cmd, resolvedClaude().cliPath);
  assert.deepEqual(spawnArgs.args, ['auth', 'status', '--json']);
  assert.equal(spawnArgs.opts.stdio, 'pipe');
  assert.equal(spawnArgs.opts.windowsHide, true);
  assert.equal(spawnArgs.opts.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(spawnArgs.opts.env.KEEP, 'yes');
});

test('probeClaudeLogin reports a valid CLI that is not logged in', async () => {
  const proc = makeProc();
  const resultPromise = probeClaudeLogin({
    platform: authPlatform(proc),
    resolveClaude: async () => resolvedClaude(),
    spawnImpl: () => proc,
  });
  await nextTick();
  proc.stdout.emit('data', '{"loggedIn":false}\n');
  proc.emit('exit', 1);

  assert.deepEqual(await resultPromise, {
    loggedIn: false,
    cli: { path: 'C:\\npm\\claude.cmd', version: '2.1.227', source: 'path', script: '',
      launchPath: resolvedClaude().cliPath, realPath: resolvedClaude().cliPath },
    cliOk: true,
    cliVersion: '2.1.227',
    cliPath: 'C:\\npm\\claude.cmd',
    reason: 'not-logged-in',
    detail: 'Claude CLI is not logged in.',
  });
});

test('probeClaudeLogin spawns the resolved CLI executable through the adapter', async () => {
  const proc = makeProc();
  const calls = [];
  const resultPromise = probeClaudeLogin({
    platform: authPlatform(proc, calls),
    resolveClaude: async () => resolvedClaude(),
  });
  await nextTick();
  proc.stdout.emit('data', '{"loggedIn":true}\n');
  proc.emit('exit', 0);

  assert.equal((await resultPromise).loggedIn, true);
  assert.deepEqual(calls[0].resolved, resolvedClaude().executable);
  assert.deepEqual(calls[0].args, ['auth', 'status', '--json']);
});

test('probeClaudeLogin exposes missing and too-old CLI states without spawning', async () => {
  for (const value of [
    { code: 'NOT_FOUND', reason: 'cli-missing', detail: 'install Claude CLI' },
    { code: 'VERSION_TOO_OLD', reason: 'cli-too-old', detail: 'upgrade Claude CLI' },
  ]) {
    let spawned = false;
    const result = await probeClaudeLogin({
      platform: authPlatform(makeProc()),
      resolveClaude: async () => ({ ok: false, code: value.code, detail: value.detail }),
      spawnImpl: () => { spawned = true; },
    });
    assert.equal(spawned, false);
    assert.deepEqual(result, {
      loggedIn: false,
      cliOk: false,
      reason: value.reason,
      detail: value.detail,
    });
  }
});

test('probeClaudeLogin kills the short-lived auth probe on timeout', async () => {
  const proc = makeProc();
  const result = await probeClaudeLogin({
    platform: authPlatform(proc),
    resolveClaude: async () => resolvedClaude(),
    spawnImpl: () => proc,
    timeoutMs: 1,
  });

  assert.equal(proc.killed, true);
  assert.equal(result.loggedIn, false);
  assert.equal(result.cliOk, true);
  assert.equal(result.reason, 'probe-timeout');
});
