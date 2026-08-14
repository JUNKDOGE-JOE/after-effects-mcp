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

// The resolver's packaged-payload contract (#239): entry, lib, both shared
// modules, and the SDK manifest must all exist before a path is reported.
function windowsClosureHits(root) {
  const nodeRoot = `${root}\\runtime\\windows-x64\\node`;
  return [
    `${nodeRoot}\\sidecar\\agent-sidecar.mjs`,
    `${nodeRoot}\\sidecar\\lib.mjs`,
    `${nodeRoot}\\shared\\tool-approval.mjs`,
    `${nodeRoot}\\shared\\chat-attachments.mjs`,
    `${nodeRoot}\\sidecar\\node_modules\\@anthropic-ai\\claude-agent-sdk\\package.json`,
  ];
}

function macClosureHits(canonicalPath) {
  const nodeRoot = `${canonicalPath}/node`;
  return [
    `${nodeRoot}/sidecar/agent-sidecar.mjs`,
    `${nodeRoot}/sidecar/lib.mjs`,
    `${nodeRoot}/shared/tool-approval.mjs`,
    `${nodeRoot}/shared/chat-attachments.mjs`,
    `${nodeRoot}/sidecar/node_modules/@anthropic-ai/claude-agent-sdk/package.json`,
  ];
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
    const hits = new Set(macClosureHits(canonicalPath));
    const result = resolveSidecarPath({
      extRoot: '/Applications/Adobe/CEP/extensions/ae-mcp',
      platform: macPlatform(),
      runtimeSelection: selectedRuntime(canonicalPath, action),
      fsImpl: { existsSync: (p) => hits.has(p) },
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
  const hits = new Set([
    ...windowsClosureHits('C:\\ext'),
    'C:\\ext\\sidecar\\agent-sidecar.mjs',
  ]);
  const result = resolveSidecarPath({
    extRoot: 'C:\\ext',
    platform: windowsPlatform(),
    fsImpl: { existsSync: (p) => hits.has(p) },
  });

  assert.equal(result, 'C:\\ext\\runtime\\windows-x64\\node\\sidecar\\agent-sidecar.mjs');
});

test('resolveSidecarPath fails closed with the missing-file inventory when the payload is absent (#239)', () => {
  assert.throws(
    () => resolveSidecarPath({
      extRoot: 'C:\\missing',
      platform: windowsPlatform(),
      fsImpl: { existsSync: () => false },
    }),
    (error) => error?.code === 'SIDECAR_PAYLOAD_MISSING'
      && Array.isArray(error.missing)
      && error.missing.length === 5
      && error.missing.includes('sidecar/agent-sidecar.mjs')
      && error.missing.includes('shared/tool-approval.mjs')
      && error.missing.includes('shared/chat-attachments.mjs'),
  );
});

test('resolveSidecarPath reports exactly the files that are missing from a partial payload', () => {
  const hits = new Set(windowsClosureHits('C:\\ext')
    .filter((p) => !p.endsWith('chat-attachments.mjs')));
  assert.throws(
    () => resolveSidecarPath({
      extRoot: 'C:\\ext',
      platform: windowsPlatform(),
      fsImpl: { existsSync: (p) => hits.has(p) },
    }),
    (error) => error?.code === 'SIDECAR_PAYLOAD_MISSING'
      && error.missing.length === 1
      && error.missing[0] === 'shared/chat-attachments.mjs',
  );
});

test('a production bundle carrying .debug never routes to the stage-root sidecar (#239 macOS)', () => {
  // stage-platform-bundle.mjs REQUIRES .debug inside the macOS bundle, and the
  // bundle also carries a dependency-less stage-root sidecar copy. Packaged
  // evidence (bundle-manifest.json) must win over the marker.
  const root = '/Applications/Adobe/CEP/extensions/ae-mcp';
  const hits = new Set([
    `${root}/.debug`,
    `${root}/bundle-manifest.json`,
    `${root}/sidecar/agent-sidecar.mjs`,
  ]);
  const result = resolveSidecarPath({
    extRoot: root,
    platform: macPlatform(),
    fsImpl: { existsSync: (p) => hits.has(p) },
  });
  assert.equal(result, null);
});

test('a Windows install with a hand-planted .debug still resolves the packaged payload', () => {
  const hits = new Set([
    ...windowsClosureHits('C:\\ext'),
    'C:\\ext\\.debug',
    'C:\\ext\\sidecar\\agent-sidecar.mjs',
    'C:\\ext\\runtime\\windows-x64\\node\\host\\package.json',
  ]);
  const result = resolveSidecarPath({
    extRoot: 'C:\\ext',
    platform: windowsPlatform(),
    fsImpl: { existsSync: (p) => hits.has(p) },
  });
  assert.equal(result, 'C:\\ext\\runtime\\windows-x64\\node\\sidecar\\agent-sidecar.mjs');
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
  const canonicalPath = '/Users/test/.ae-mcp/runtime/layers/a/i-active/macos-arm64';
  const runtime = selectedRuntime(canonicalPath);
  const hits = new Set(macClosureHits(canonicalPath));
  const selection = resolveSidecarSelection({
    extRoot: '/Applications/Adobe/CEP/extensions/ae-mcp',
    platform: macPlatform(),
    runtimeActivation: { state: 'ready', result: runtime, error: null },
    fsImpl: { existsSync: (p) => hits.has(p) },
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
  // A Windows install whose payload is absent must surface a typed error —
  // never report ready off a computed-but-unverified path (#239).
  const missingPayload = resolveSidecarSelection({
    extRoot: 'C:\\ext',
    platform: windowsPlatform(),
    runtimeActivation: { state: 'ready', result: null, error: null },
    fsImpl: { existsSync: () => false },
  });
  assert.equal(missingPayload.state, 'error');
  assert.equal(missingPayload.path, null);
  assert.equal(missingPayload.error.code, 'SIDECAR_PAYLOAD_MISSING');

  const hits = new Set(windowsClosureHits('C:\\ext'));
  const windows = resolveSidecarSelection({
    extRoot: 'C:\\ext',
    platform: windowsPlatform(),
    runtimeActivation: { state: 'ready', result: null, error: null },
    fsImpl: { existsSync: (p) => hits.has(p) },
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

test('probeClaudeLogin does not spawn a generation-B Node for a generation-A Sidecar selection', async () => {
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
  let spawns = 0;
  const resolveSelectedNode = ({ platform }) => resolveNodeForSidecarSelection({
    resolveNode: async () => resolvedNodeB,
    runtimeSelection: selectionA,
    platform,
  });
  const result = await probeClaudeLogin({
    platform: macPlatform(),
    resolveNode: async (options) => {
      try {
        return await resolveSelectedNode(options);
      } catch (error) {
        return { ok: false, detail: error.message };
      }
    },
    sidecarPath: '/Users/test/.ae-mcp/runtime/layers/a/generation-a/macos-arm64/node/sidecar/agent-sidecar.mjs',
    spawnImpl: () => {
      spawns += 1;
      return makeProc();
    },
  });

  assert.deepEqual(result, {
    loggedIn: false,
    nodeOk: false,
    detail: 'Selected Sidecar and Node runtime receipts do not match',
  });
  assert.equal(spawns, 0);
});

test('probeClaudeLogin does not resolve Node or spawn while Sidecar selection is pending', async () => {
  let nodeResolutions = 0;
  let spawns = 0;
  const result = await probeClaudeLogin({
    sidecarPath: null,
    resolveNode: async () => {
      nodeResolutions += 1;
      return { ok: true, nodePath: 'node', version: '20.0.0' };
    },
    spawnImpl: () => {
      spawns += 1;
      return makeProc();
    },
  });

  assert.deepEqual(result, {
    loggedIn: false,
    nodeOk: false,
    detail: 'verified runtime sidecar is not ready',
  });
  assert.equal(nodeResolutions, 0);
  assert.equal(spawns, 0);
});
