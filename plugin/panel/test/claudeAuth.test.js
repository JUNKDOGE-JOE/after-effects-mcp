import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import {
  probeClaudeLogin,
  resolveNodeForSidecarSelection,
  resolveSidecarPath,
  resolveSidecarSelection,
} from '../src/cep/claudeAuth.js';

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

function macPaths() {
  const runtimeRoot = '/Users/test/.ae-mcp/runtime';
  return {
    runtimeRoot,
    join: (parts) => path.posix.join(...parts),
    resolve: (parts) => path.posix.resolve(...parts),
    isAbsolute: (value) => path.posix.isAbsolute(value),
    contains: (root, candidate) => {
      const normalizedRoot = path.posix.resolve(root);
      const normalizedCandidate = path.posix.resolve(candidate);
      return normalizedCandidate === normalizedRoot
        || normalizedCandidate.startsWith(normalizedRoot + '/');
    },
  };
}

function macPlatform() {
  return { id: 'macos-arm64', paths: macPaths() };
}

function selectedRuntime(canonicalPath, action = 'ready') {
  return {
    ok: true,
    action,
    launcher: '/Users/test/.ae-mcp/bin/ae-mcp',
    relative: 'generations/g-0123456789abcdef',
    version: '0.9.3',
    sourceCommitSha: 'a'.repeat(40),
    componentReceipt: {
      schemaVersion: 1,
      component: 'core-runtime',
      platform: 'macos-arm64',
      version: '0.9.3',
      sourceRevision: 'a'.repeat(40),
      sourceRevisionRole: 'advisory',
      canonicalPath,
      installReceiptPath: '/Users/test/.ae-mcp/runtime/generations/g-0123456789abcdef/install-record.json',
      generation: 'generations/g-0123456789abcdef',
      layerId: 'b'.repeat(64),
      signals: {},
      stableLauncher: {
        canonicalPath: '/Users/test/.ae-mcp/bin/ae-mcp',
        installReceiptPath: '/Users/test/.ae-mcp/runtime/stable-launcher-record.json',
        signal: {},
      },
    },
  };
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

test('resolveSidecarPath waits for a verified macOS production runtime selection', () => {
  const result = resolveSidecarPath({
    extRoot: '/Applications/Adobe/CEP/extensions/ae-mcp',
    platform: macPlatform(),
    fsImpl: { existsSync: () => false },
  });

  assert.equal(result, null);
});

test('resolveSidecarPath uses the selected macOS generation for ready retained and fallback results', () => {
  const cases = [
    ['ready', '/Users/test/.ae-mcp/runtime/layers/a/i-ready/macos-arm64',
      '/Users/test/.ae-mcp/runtime/layers/a/i-ready/macos-arm64/node/sidecar/agent-sidecar.mjs'],
    ['retained', '/Users/test/.ae-mcp/runtime/layers/b/i-retained/macos-arm64',
      '/Users/test/.ae-mcp/runtime/layers/b/i-retained/macos-arm64/node/sidecar/agent-sidecar.mjs'],
    ['fallback', '/Users/test/.ae-mcp/runtime/layers/c/i-fallback/macos-arm64',
      '/Users/test/.ae-mcp/runtime/layers/c/i-fallback/macos-arm64/node/sidecar/agent-sidecar.mjs'],
  ];

  for (const [action, canonicalPath, expected] of cases) {
    const result = resolveSidecarPath({
      extRoot: '/Applications/Adobe/CEP/extensions/ae-mcp',
      platform: macPlatform(),
      runtimeSelection: selectedRuntime(canonicalPath, action),
      fsImpl: { existsSync: () => false },
    });
    assert.equal(result, expected);
  }
});

test('resolveSidecarPath rejects incompatible macOS runtime receipts without an extension fallback', () => {
  const base = selectedRuntime('/Users/test/.ae-mcp/runtime/layers/a/i-valid/macos-arm64');
  const cases = [
    { ...base, componentReceipt: { ...base.componentReceipt, component: 'platform-helper' } },
    { ...base, componentReceipt: { ...base.componentReceipt, platform: 'windows-x64' } },
    { ...base, componentReceipt: { ...base.componentReceipt, canonicalPath: 'relative/runtime' } },
    { ...base, componentReceipt: { ...base.componentReceipt, canonicalPath: '/Applications/Adobe/CEP/extensions/ae-mcp/runtime/macos-arm64' } },
  ];

  for (const runtimeSelection of cases) {
    assert.throws(
      () => resolveSidecarPath({
        extRoot: '/Applications/Adobe/CEP/extensions/ae-mcp',
        platform: macPlatform(),
        runtimeSelection,
        fsImpl: { existsSync: () => false },
      }),
      (error) => error?.code === 'RUNTIME_SIDECAR_SELECTION_INCOMPATIBLE',
    );
  }
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

test('resolveSidecarSelection keeps macOS pending until runtime activation is ready', () => {
  const selection = resolveSidecarSelection({
    extRoot: '/Applications/Adobe/CEP/extensions/ae-mcp',
    platform: macPlatform(),
    runtimeActivation: { state: 'starting', result: null, error: null },
    fsImpl: { existsSync: () => false },
  });

  assert.deepEqual(selection, { state: 'pending', path: null, error: null });
});

test('resolveSidecarSelection exposes the verified path only after macOS activation', () => {
  const runtime = selectedRuntime('/Users/test/.ae-mcp/runtime/layers/a/i-active/macos-arm64');
  const selection = resolveSidecarSelection({
    extRoot: '/Applications/Adobe/CEP/extensions/ae-mcp',
    platform: macPlatform(),
    runtimeActivation: { state: 'ready', result: runtime, error: null },
    fsImpl: { existsSync: () => false },
  });

  assert.deepEqual(selection, {
    state: 'ready',
    path: '/Users/test/.ae-mcp/runtime/layers/a/i-active/macos-arm64/node/sidecar/agent-sidecar.mjs',
    error: null,
  });
});

test('resolveSidecarSelection preserves RuntimeManager and receipt errors before dispatch', () => {
  const runtimeError = Object.assign(new Error('runtime failed'), {
    code: 'RUNTIME_MANIFEST_INVALID',
  });
  const activationFailure = resolveSidecarSelection({
    extRoot: '/Applications/Adobe/CEP/extensions/ae-mcp',
    platform: macPlatform(),
    runtimeActivation: { state: 'error', result: null, error: runtimeError },
    fsImpl: { existsSync: () => false },
  });
  assert.equal(activationFailure.state, 'error');
  assert.equal(activationFailure.path, null);
  assert.equal(activationFailure.error, runtimeError);

  const runtime = selectedRuntime('/Applications/Adobe/CEP/extensions/ae-mcp/runtime/macos-arm64');
  const receiptFailure = resolveSidecarSelection({
    extRoot: '/Applications/Adobe/CEP/extensions/ae-mcp',
    platform: macPlatform(),
    runtimeActivation: { state: 'ready', result: runtime, error: null },
    fsImpl: { existsSync: () => false },
  });
  assert.equal(receiptFailure.state, 'error');
  assert.equal(receiptFailure.path, null);
  assert.equal(receiptFailure.error.code, 'RUNTIME_SIDECAR_SELECTION_INCOMPATIBLE');
});

test('resolveSidecarSelection keeps Windows and debug paths independent of RuntimeManager', () => {
  const windows = resolveSidecarSelection({
    extRoot: 'C:\\ext',
    platform: windowsPlatform(),
    runtimeActivation: { state: 'ready', result: null, error: null },
    fsImpl: { existsSync: () => false },
  });
  assert.deepEqual(windows, {
    state: 'ready',
    path: 'C:\\ext\\runtime\\windows-x64\\node\\sidecar\\agent-sidecar.mjs',
    error: null,
  });

  const debug = resolveSidecarSelection({
    extRoot: '/Applications/Adobe/CEP/extensions/ae-mcp',
    platform: macPlatform(),
    runtimeActivation: { state: 'ready', result: null, error: null },
    fsImpl: {
      existsSync: (value) => value === '/Applications/Adobe/CEP/extensions/ae-mcp/.debug'
        || value === '/Applications/Adobe/CEP/extensions/ae-mcp/sidecar/agent-sidecar.mjs',
    },
  });
  assert.deepEqual(debug, {
    state: 'ready',
    path: '/Applications/Adobe/CEP/extensions/ae-mcp/sidecar/agent-sidecar.mjs',
    error: null,
  });
});

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
    cliOk: true,
    cliVersion: '2.1.227',
    cliPath: 'C:\\npm\\claude.cmd',
    reason: 'not-logged-in',
    detail: 'Claude CLI is not logged in.',
  });
});

test('probeClaudeLogin spawns the resolved native executable through the adapter', async () => {
  const proc = makeProc();
  const calls = [];
  const platform = authPlatform(proc, calls);
  const resultPromise = probeClaudeLogin({
    platform,
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

test('resolveNodeForSidecarSelection rejects a Node receipt from another selected runtime generation', async () => {
  const selectionA = selectedRuntime('/Users/test/.ae-mcp/runtime/layers/a/generation-a/macos-arm64');
  const resolvedNodeB = {
    ok: true,
    nodePath: '/Users/test/.ae-mcp/runtime/layers/a/generation-b/macos-arm64/node/bin/node',
    version: '24.17.0',
    runtime: {
      componentReceipt: {
        ...selectionA.componentReceipt,
        canonicalPath: '/Users/test/.ae-mcp/runtime/layers/a/generation-b/macos-arm64',
      },
    },
  };
  let resolutions = 0;

  await assert.rejects(
    () => resolveNodeForSidecarSelection({
      resolveNode: async () => {
        resolutions += 1;
        return resolvedNodeB;
      },
      runtimeSelection: selectionA,
      platform: macPlatform(),
    }),
    (error) => error.code === 'RUNTIME_SIDECAR_NODE_SELECTION_MISMATCH',
  );
  assert.equal(resolutions, 1);
});
