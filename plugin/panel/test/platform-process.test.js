import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createMacosAdapter } from '../src/cep/platform/macos.js';
import { createWindowsAdapter } from '../src/cep/platform/windows.js';

// Static golden outputs copied from the longProg branches of npm/cmd-shim
// v6.0.3, v7.0.0, and main. Source URLs are stored beside each fixture; these
// bytes are intentionally independent of the resolver implementation.
const CMD_SHIM_GOLDENS = JSON.parse(
  readFileSync(new URL('./fixtures/cmd-shim-golden.json', import.meta.url), 'utf8'),
);
const cmdShimGolden = (name) => CMD_SHIM_GOLDENS.find((fixture) => fixture.name === name);

function fakeFs(files, realpaths = {}, contents = {}) {
  return {
    constants: { X_OK: 1, R_OK: 4 },
    existsSync: (file) => files.has(file),
    realpathSync: (file) => realpaths[file] || file,
    statSync: () => ({ isFile: () => true }),
    lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false }),
    accessSync() {},
    readFileSync: (file) => contents[file] || Buffer.alloc(0),
  };
}

function macho64(cpuType) {
  const value = Buffer.alloc(32);
  value.writeUInt32LE(0xfeedfacf, 0);
  value.writeUInt32LE(cpuType, 4);
  return value;
}

function pe64(machine) {
  const value = Buffer.alloc(256);
  value.write('MZ', 0, 'ascii');
  value.writeUInt32LE(128, 0x3c);
  value.write('PE\0\0', 128, 'binary');
  value.writeUInt16LE(machine, 132);
  return value;
}

function processFactory(steps, calls) {
  return (file, args, options) => {
    calls.push({ file, args, options });
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { end(value) { proc.stdinValue = value; } };
    proc.kill = (signal) => {
      proc.killedWith = [...(proc.killedWith || []), signal];
      if (step.ignoreKill && signal === 'SIGTERM') return true;
      queueMicrotask(() => {
        proc.emit('exit', null, signal);
        proc.emit('close', null, signal);
      });
      return true;
    };
    const step = steps.shift() || {};
    queueMicrotask(() => {
      if (step.error) {
        proc.emit('error', step.error);
        proc.emit('close', -2, null);
        return;
      }
      if (step.hang) return;
      if (step.stdout) proc.stdout.emit('data', Buffer.from(step.stdout));
      if (step.stderr) proc.stderr.emit('data', Buffer.from(step.stderr));
      proc.emit('exit', step.code ?? 0, step.signal ?? null);
      proc.emit('close', step.code ?? 0, step.signal ?? null);
    });
    return proc;
  };
}

function macHarness({ files = [], realpaths = {}, steps = [] } = {}) {
  const calls = [];
  const adapter = createMacosAdapter({
    platform: 'darwin', arch: 'arm64', home: '/Users/a', temp: '/tmp',
    env: { PATH: '/path/bin' }, fs: fakeFs(new Set(files), realpaths),
    spawnImpl: processFactory(steps, calls), now: (() => { let n = 0; return () => ++n; })(),
  });
  return { adapter, calls };
}

test('resolution order starts with override and resolves symlinks before probing', async () => {
  const harness = macHarness({
    files: ['/override/codex'],
    realpaths: { '/override/codex': '/opt/codex/bin/codex' },
    steps: [{ stdout: 'codex-cli 1.4.0 arm64\n' }],
  });
  const result = await harness.adapter.resolveExecutable('codex', { overridePath: '/override/codex' });

  assert.equal(result.ok, true);
  assert.equal(result.path, '/opt/codex/bin/codex');
  assert.equal(result.source, 'override');
  assert.deepEqual(harness.calls.map((call) => call.file), ['/opt/codex/bin/codex']);
});

test('resolution reports minimum-version and architecture failures for discovered Node executables', async () => {
  const discovered = '/path/bin/node';
  const old = macHarness({ files: [discovered], steps: [{ stdout: 'v17.9.0 arm64' }] });
  const oldResult = await old.adapter.resolveExecutable('node', { minimumVersion: '18.0.0' });
  assert.equal(oldResult.ok, false);
  assert.equal(oldResult.code, 'VERSION_TOO_OLD');

  const wrongArch = macHarness({ files: [discovered], steps: [{ stdout: 'v24.17.0 x64' }] });
  const archResult = await wrongArch.adapter.resolveExecutable('node', { requiredArch: 'arm64' });
  assert.equal(archResult.ok, false);
  assert.equal(archResult.code, 'ARCH_MISMATCH');
});

test('the untrusted current text pointer is never treated as a runtime directory', async () => {
  const fakePointerChild = '/Users/a/.ae-mcp/runtime/current/bin/node';
  const pathNode = '/path/bin/node';
  const harness = macHarness({
    files: [fakePointerChild, pathNode],
    steps: [{ stdout: 'v24.17.0 arm64' }],
  });

  const result = await harness.adapter.resolveExecutable('node', { minimumVersion: '18.0.0' });

  assert.equal(result.ok, true);
  assert.equal(result.path, pathNode);
  assert.equal(result.source, 'path');
  assert.deepEqual(harness.calls.map((call) => call.file), [pathNode]);
});

test('the stable ae-mcp launcher is presence-checked without starting its stdio server', async () => {
  const launcher = '/Users/a/.ae-mcp/bin/ae-mcp';
  const harness = macHarness({ files: [launcher] });
  const result = await harness.adapter.resolveExecutable('ae-mcp');
  assert.equal(result.ok, true);
  assert.equal(result.path, launcher);
  assert.equal(result.version, null);
  assert.deepEqual(harness.calls, []);
});

test('macOS executable candidates require execute permission, including the stable launcher', async () => {
  const launcher = '/Users/a/.ae-mcp/bin/ae-mcp';
  const modes = [];
  const calls = [];
  const adapter = createMacosAdapter({
    platform: 'darwin', arch: 'arm64', home: '/Users/a', temp: '/tmp', env: {},
    fs: {
      constants: { X_OK: 1 },
      existsSync: (file) => file === launcher,
      realpathSync: (file) => file,
      statSync: () => ({ isFile: () => true }),
      accessSync: (_file, mode) => { modes.push(mode); },
    },
    spawnImpl: processFactory([], calls), now: () => 0,
  });

  const result = await adapter.resolveExecutable('ae-mcp');
  assert.equal(result.ok, true);
  assert.deepEqual(modes, [1]);
});

test('macOS login-shell probe accepts exactly one clean sentinel result', async () => {
  const clean = macHarness({
    files: ['/bin/zsh', '/Applications/Test CLI/codex'],
    steps: [
      { stdout: '__AE_MCP_PATH_BEGIN__/Applications/Test CLI/codex__AE_MCP_PATH_END__\n' },
      { stdout: 'codex-cli 1.0.0 arm64\n' },
    ],
  });
  const result = await clean.adapter.resolveExecutable('codex', { env: { PATH: '' } });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'login-shell');

  const polluted = macHarness({
    files: ['/bin/zsh', '/Applications/Test CLI/codex'],
    steps: [{ stdout: 'welcome\n__AE_MCP_PATH_BEGIN__/Applications/Test CLI/codex__AE_MCP_PATH_END__\n' }],
  });
  const rejected = await polluted.adapter.resolveExecutable('codex', { env: { PATH: '' } });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'NOT_FOUND');

  const stderrPolluted = macHarness({
    files: ['/bin/zsh', '/Applications/Test CLI/codex'],
    steps: [{ stdout: '__AE_MCP_PATH_BEGIN__/Applications/Test CLI/codex__AE_MCP_PATH_END__\n', stderr: 'shell profile warning\n' }],
  });
  const stderrRejected = await stderrPolluted.adapter.resolveExecutable('codex', { env: { PATH: '' } });
  assert.equal(stderrRejected.ok, false);
});

test('run is shell-free, preserves nonzero exits and caps combined output', async () => {
  const calls = [];
  const adapter = createWindowsAdapter({
    platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp', env: {},
    fs: fakeFs(new Set()), spawnImpl: processFactory([{ stdout: 'a'.repeat(6000), stderr: 'b'.repeat(6000), code: 7 }], calls),
    now: (() => { let n = 10; return () => n += 5; })(),
  });
  const result = await adapter.run({
    executable: { ok: true, id: 'codex', path: 'C:\\Tools\\codex.exe', argsPrefix: [], source: 'override', version: null, arch: null },
    args: ['probe'], maxOutputBytes: 8192,
  });
  assert.equal(result.exitCode, 7);
  assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 8192);
  assert.equal(calls[0].options.shell, false);
});

test('spawn does not restore inherited variables removed from an explicit environment', () => {
  const calls = [];
  const adapter = createMacosAdapter({
    platform: 'darwin', arch: 'arm64', home: '/Users/a', temp: '/tmp',
    env: { PATH: '/inherited/bin', PROVIDER_SECRET: 'must-not-return' },
    fs: fakeFs(new Set()), spawnImpl: processFactory([], calls), now: () => 0,
  });

  adapter.spawn(
    { ok: true, id: 'codex', path: '/bin/codex', argsPrefix: [], source: 'override', version: null, arch: null },
    [],
    { env: { PATH: '/explicit/bin', SAFE: 'yes' } },
  );

  assert.equal(calls[0].options.env.PROVIDER_SECRET, undefined);
  assert.equal(calls[0].options.env.SAFE, 'yes');
  assert.equal(calls[0].options.env.PATH, '/Users/a/.ae-mcp/bin:/explicit/bin');
});

test('resolveExecutable does not restore ambient variables removed from an explicit probe environment', async () => {
  const calls = [];
  const executable = '/tools/codex';
  const adapter = createMacosAdapter({
    platform: 'darwin', arch: 'arm64', home: '/Users/a', temp: '/tmp',
    env: { PATH: '/ambient/bin', AMBIENT_SECRET: 'must-not-reach-probe' },
    fs: fakeFs(new Set([executable]), {}, { [executable]: macho64(0x0100000c) }),
    spawnImpl: processFactory([{ stdout: 'codex-cli 1.0.0\n' }], calls), now: () => 0,
  });

  const result = await adapter.resolveExecutable('codex', {
    overridePath: executable,
    env: { PATH: '/explicit/bin', SAFE: 'yes' },
    requiredArch: 'arm64',
  });

  assert.equal(result.ok, true);
  assert.equal(calls[0].options.env.AMBIENT_SECRET, undefined);
  assert.equal(calls[0].options.env.SAFE, 'yes');
});

test('requiredArch rejects a native Mach-O candidate based on its own header', async () => {
  const calls = [];
  const executable = '/tools/codex';
  const adapter = createMacosAdapter({
    platform: 'darwin', arch: 'arm64', home: '/Users/a', temp: '/tmp', env: {},
    fs: fakeFs(new Set([executable]), {}, { [executable]: macho64(0x01000007) }),
    spawnImpl: processFactory([{ stdout: 'codex-cli 1.0.0\n' }], calls), now: () => 0,
  });

  const result = await adapter.resolveExecutable('codex', {
    overridePath: executable,
    requiredArch: 'arm64',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'ARCH_MISMATCH');
  assert.deepEqual(calls, []);
});

test('a Node shebang shim is materialized through a verified Node architecture', async () => {
  const calls = [];
  const shim = '/tools/codex.js';
  const node = '/path/bin/node';
  const adapter = createMacosAdapter({
    platform: 'darwin', arch: 'arm64', home: '/Users/a', temp: '/tmp', env: { PATH: '/path/bin' },
    fs: fakeFs(new Set([shim, node]), {}, {
      [shim]: Buffer.from('#!/usr/bin/env node\nconsole.log("codex")\n'),
      [node]: macho64(0x0100000c),
    }),
    spawnImpl: processFactory([
      { stdout: 'v24.17.0 arm64' },
      { stdout: 'codex-cli 1.0.0' },
    ], calls),
    now: () => 0,
  });

  const result = await adapter.resolveExecutable('codex', {
    overridePath: shim,
    requiredArch: 'arm64',
  });

  assert.equal(result.ok, true);
  assert.equal(result.path, node);
  assert.deepEqual(result.argsPrefix, [shim]);
  assert.equal(result.arch, 'arm64');
});

test('a Windows npm cmd shim is rewritten to its entry through a verified Node', async () => {
  const calls = [];
  const golden = cmdShimGolden('cmd-shim-main-local');
  const shim = golden.shim;
  const entry = golden.entry;
  const node = 'C:\\Tools\\node.exe';
  const adapter = createWindowsAdapter({
    platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp',
    env: { Path: golden.path },
    fs: fakeFs(new Set([shim, entry, node]), {}, {
      [shim]: Buffer.from(golden.content),
      [entry]: Buffer.from('#!/usr/bin/env node\n'),
      [node]: pe64(0x8664),
    }),
    spawnImpl: processFactory([
      { stdout: 'v24.17.0 x64' },
      { stdout: 'codex-cli 1.0.0' },
    ], calls),
    now: () => 0,
  });

  const result = await adapter.resolveExecutable('codex', { requiredArch: 'x64' });

  assert.equal(result.ok, true);
  assert.equal(result.path, node);
  assert.deepEqual(result.argsPrefix, [entry]);
  assert.equal(result.arch, 'x64');
  assert.equal(calls[0].file, node);
  assert.equal(calls[1].file, node);
  assert.deepEqual(calls[1].args, [entry, '--version']);
});

test('a node.cmd candidate fails closed without recursively resolving Node', async () => {
  const calls = [];
  const shim = 'C:\\Tools\\node.cmd';
  const golden = cmdShimGolden('cmd-shim-6-local');
  const adapter = createWindowsAdapter({
    platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp', env: { Path: 'C:\\Tools' },
    fs: fakeFs(new Set([shim]), {}, { [shim]: Buffer.from(golden.content) }),
    spawnImpl: processFactory([], calls), now: () => 0,
  });

  const result = await adapter.resolveExecutable('node', { requiredArch: 'x64' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'NOT_FOUND');
  assert.deepEqual(calls, []);
});

test('requiredArch rejects an arbitrary Windows command wrapper before probing Node', async () => {
  const calls = [];
  const shim = 'C:\\Tools\\codex.cmd';
  const node = 'C:\\Tools\\node.exe';
  const adapter = createWindowsAdapter({
    platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp', env: { Path: 'C:\\Tools' },
    fs: fakeFs(new Set([shim, node]), {}, {
      [shim]: Buffer.from('@echo off\r\nnode C:\\outside\\evil.js %*\r\n'),
      [node]: pe64(0x8664),
    }),
    spawnImpl: processFactory([{ stdout: 'v24.17.0 x64' }, { stdout: 'codex-cli 1.0.0' }], calls),
    now: () => 0,
  });

  const result = await adapter.resolveExecutable('codex', { requiredArch: 'x64' });

  assert.equal(result.ok, false);
  assert.deepEqual(calls, []);
});

test('Windows command wrappers are rejected even when the caller omits requiredArch', async () => {
  const calls = [];
  const shim = 'C:\\Tools\\codex.cmd';
  const node = 'C:\\Tools\\node.exe';
  const adapter = createWindowsAdapter({
    platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp', env: { Path: 'C:\\Tools' },
    fs: fakeFs(new Set([shim, node]), {}, {
      [shim]: Buffer.from('@echo off\r\nnode C:\\outside\\evil.js %*\r\n'),
      [node]: pe64(0x8664),
    }),
    spawnImpl: processFactory([{ stdout: 'attacker 1.0.0' }], calls),
    now: () => 0,
  });

  const result = await adapter.resolveExecutable('codex');

  assert.equal(result.ok, false);
  assert.deepEqual(calls, []);
});

test('strict npm cmd-shims use native Node even when the caller omits requiredArch', async () => {
  const calls = [];
  const golden = cmdShimGolden('cmd-shim-main-local');
  const node = 'C:\\Tools\\node.exe';
  const adapter = createWindowsAdapter({
    platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp',
    env: { Path: golden.path },
    fs: fakeFs(new Set([golden.shim, golden.entry, node]), {}, {
      [golden.shim]: Buffer.from(golden.content),
      [golden.entry]: Buffer.from('#!/usr/bin/env node\n'),
      [node]: pe64(0x8664),
    }),
    spawnImpl: processFactory([
      { stdout: 'v24.17.0 x64' },
      { stdout: 'codex-cli 1.0.0' },
    ], calls),
    now: () => 0,
  });

  const result = await adapter.resolveExecutable('codex');

  assert.equal(result.ok, true);
  assert.equal(result.path, node);
  assert.deepEqual(result.argsPrefix, [golden.entry]);
  assert.deepEqual(calls.map((call) => call.file), [node, node]);
});

test('requiredArch accepts strict local and global npm cmd-shims without cmd.exe', async () => {
  for (const value of CMD_SHIM_GOLDENS) {
    const calls = [];
    const node = 'C:\\Tools\\node.exe';
    const adapter = createWindowsAdapter({
      platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp', env: { Path: value.path },
      fs: fakeFs(new Set([value.shim, value.entry, node]), {}, {
        [value.shim]: Buffer.from(value.content),
        [value.entry]: Buffer.from('#!/usr/bin/env node\n'),
        [node]: pe64(0x8664),
      }),
      spawnImpl: processFactory([{ stdout: 'v24.17.0 x64' }, { stdout: 'codex-cli 1.0.0' }], calls),
      now: () => 0,
    });

    const result = await adapter.resolveExecutable('codex', { requiredArch: 'x64' });

    assert.equal(result.ok, true);
    assert.equal(result.path, node);
    assert.deepEqual(result.argsPrefix, [value.entry]);
    assert.deepEqual(calls.map((call) => call.file), [node, node]);
  }
});

test('requiredArch rejects an npm shim when its verified Node has the wrong native architecture', async () => {
  const calls = [];
  const golden = cmdShimGolden('cmd-shim-6-local');
  const shim = golden.shim;
  const entry = golden.entry;
  const node = 'C:\\Tools\\node.exe';
  const adapter = createWindowsAdapter({
    platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp',
    env: { Path: golden.path },
    fs: fakeFs(new Set([shim, entry, node]), {}, {
      [shim]: Buffer.from(golden.content),
      [entry]: Buffer.from('#!/usr/bin/env node\n'),
      [node]: pe64(0xaa64),
    }),
    spawnImpl: processFactory([], calls), now: () => 0,
  });

  const result = await adapter.resolveExecutable('codex', { requiredArch: 'x64' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'ARCH_MISMATCH');
  assert.deepEqual(calls, []);
});

test('requiredArch rejects ambiguous or escaping cmd-shim entries', async () => {
  const golden = cmdShimGolden('cmd-shim-main-local');
  const shim = golden.shim;
  const node = 'C:\\Tools\\node.exe';
  const valid = golden.content;
  const invalidShims = [
    Buffer.from(valid + 'calc.exe\r\n'),
    Buffer.from(valid.replace(/\r\n$/, '') + '\r\n"%_prog%" "%dp0%\\..\\other\\index.js" %*\r\n'),
    Buffer.from(valid.replace('..\\@openai\\codex\\bin\\codex.mjs', '..\\..\\outside.js')),
  ];
  for (const contents of invalidShims) {
    const calls = [];
    const adapter = createWindowsAdapter({
      platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp',
      env: { Path: golden.path },
      fs: fakeFs(new Set([shim, node, 'C:\\outside.js']), {}, { [shim]: contents, [node]: pe64(0x8664) }),
      spawnImpl: processFactory([], calls), now: () => 0,
    });
    const result = await adapter.resolveExecutable('codex', { requiredArch: 'x64' });
    assert.equal(result.ok, false);
    assert.deepEqual(calls, []);
  }
});

test('run inherits the CEP environment only when the request omits env', async () => {
  const calls = [];
  const adapter = createMacosAdapter({
    platform: 'darwin', arch: 'arm64', home: '/Users/a', temp: '/tmp',
    env: { PATH: '/inherited/bin', INHERITED_MARKER: 'yes' },
    fs: fakeFs(new Set()), spawnImpl: processFactory([{}, {}], calls), now: () => 0,
  });
  const executable = { ok: true, id: 'codex', path: '/bin/codex', argsPrefix: [], source: 'override', version: null, arch: null };

  await adapter.run({ executable });
  await adapter.run({ executable, env: { PATH: '/explicit/bin' } });

  assert.equal(calls[0].options.env.INHERITED_MARKER, 'yes');
  assert.equal(calls[1].options.env.INHERITED_MARKER, undefined);
});

test('run waits for close so output arriving after exit is retained', async () => {
  let proc;
  const adapter = createMacosAdapter({
    platform: 'darwin', arch: 'arm64', home: '/Users/a', temp: '/tmp', env: {},
    fs: fakeFs(new Set()),
    spawnImpl() {
      proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = { end() {} };
      proc.kill = () => true;
      return proc;
    },
    now: () => 0,
  });
  const pending = adapter.run({
    executable: { ok: true, id: 'codex', path: '/bin/codex', argsPrefix: [], source: 'override', version: null, arch: null },
  });
  let settled = false;
  pending.then(() => { settled = true; });

  proc.emit('exit', 0, null);
  proc.stdout.emit('data', Buffer.from('late output'));
  await Promise.resolve();
  assert.equal(settled, false);
  proc.emit('close', 0, null);

  const result = await pending;
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'late output');
});

test('run retains a spawn error and still settles from close', async () => {
  let proc;
  const adapter = createMacosAdapter({
    platform: 'darwin', arch: 'arm64', home: '/Users/a', temp: '/tmp', env: {},
    fs: fakeFs(new Set()),
    spawnImpl() {
      proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = { end() {} };
      proc.kill = () => true;
      return proc;
    },
    now: () => 0,
  });
  const pending = adapter.run({
    executable: { ok: true, id: 'codex', path: '/missing/codex', argsPrefix: [], source: 'override', version: null, arch: null },
  });
  let settled = false;
  pending.then(() => { settled = true; });

  proc.emit('error', new Error('spawn ENOENT'));
  await Promise.resolve();
  assert.equal(settled, false);
  proc.emit('close', -2, null);

  const result = await pending;
  assert.equal(result.exitCode, -2);
  assert.match(result.stderr, /spawn ENOENT/);
});

test('run terminates on timeout and cancellation', async () => {
  const timeout = macHarness({ steps: [{ hang: true }] });
  const timed = await timeout.adapter.run({
    executable: { ok: true, id: 'codex', path: '/bin/codex', argsPrefix: [], source: 'override', version: null, arch: null },
    timeoutMs: 5,
  });
  assert.equal(timed.timedOut, true);
  assert.equal(timed.aborted, false);

  const abort = macHarness({ steps: [{ hang: true }] });
  const controller = new AbortController();
  const pending = abort.adapter.run({
    executable: { ok: true, id: 'codex', path: '/bin/codex', argsPrefix: [], source: 'override', version: null, arch: null },
    signal: controller.signal,
  });
  controller.abort();
  const cancelled = await pending;
  assert.equal(cancelled.timedOut, false);
  assert.equal(cancelled.aborted, true);
});

test('run resolves after a bounded hard-kill fallback when a process ignores termination', async () => {
  const harness = macHarness({ steps: [{ hang: true, ignoreKill: true }] });
  const result = await harness.adapter.run({
    executable: { ok: true, id: 'codex', path: '/bin/codex', argsPrefix: [], source: 'override', version: null, arch: null },
    timeoutMs: 1,
  });
  assert.equal(result.timedOut, true);
  assert.deepEqual(harness.calls.length, 1);
});

test('run waits for close after the hard-kill request instead of declaring the process closed', async () => {
  let proc;
  let hardKill;
  const hardKillRequested = new Promise((resolve) => { hardKill = resolve; });
  const adapter = createMacosAdapter({
    platform: 'darwin', arch: 'arm64', home: '/Users/a', temp: '/tmp', env: {},
    fs: fakeFs(new Set()),
    spawnImpl() {
      proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = { end() {} };
      proc.kill = (signal) => {
        if (signal === 'SIGKILL') hardKill();
        return true;
      };
      return proc;
    },
    now: () => 0,
  });
  const pending = adapter.run({
    executable: { ok: true, id: 'codex', path: '/bin/codex', argsPrefix: [], source: 'override', version: null, arch: null },
    timeoutMs: 1,
  });
  let settled = false;
  pending.then(() => { settled = true; });

  await hardKillRequested;
  await Promise.resolve();
  assert.equal(settled, false);
  proc.stdout.emit('data', Buffer.from('last bytes'));
  proc.emit('close', null, 'SIGKILL');

  const result = await pending;
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.stdout, 'last bytes');
});

test('run still drains close when a timeout kill reports false after exit', async () => {
  let proc;
  const adapter = createMacosAdapter({
    platform: 'darwin', arch: 'arm64', home: '/Users/a', temp: '/tmp', env: {},
    fs: fakeFs(new Set()),
    spawnImpl() {
      proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = { end() {} };
      proc.kill = () => false;
      queueMicrotask(() => proc.emit('exit', 0, null));
      setTimeout(() => {
        proc.stdout.emit('data', Buffer.from('late bytes'));
        proc.emit('close', 0, null);
      }, 20);
      return proc;
    },
    now: () => 0,
  });

  const result = await adapter.run({
    executable: { ok: true, id: 'codex', path: '/bin/codex', argsPrefix: [], source: 'override', version: null, arch: null },
    timeoutMs: 5,
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'late bytes');
});

test('Windows resolution rejects incomplete cmd wrappers instead of invoking cmd.exe', async () => {
  const calls = [];
  const shim = 'C:\\Users\\A Person\\node_modules\\.bin\\codex.cmd';
  const adapter = createWindowsAdapter({
    platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp',
    env: { Path: 'C:\\Users\\A Person\\node_modules\\.bin', ComSpec: 'D:\\Windows\\System32\\cmd.exe' }, fs: fakeFs(new Set([shim])),
    spawnImpl: processFactory([{ stdout: 'codex-cli 1.0.0 x64' }], calls), now: () => 0,
  });
  const result = await adapter.resolveExecutable('codex');
  assert.equal(result.ok, false);
  assert.deepEqual(calls, []);
});

test('Windows spawn rejects a forged command-script resolution', () => {
  const calls = [];
  const shim = 'C:\\Users\\A Person\\node_modules\\.bin\\codex.cmd';
  const adapter = createWindowsAdapter({
    platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp',
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, fs: fakeFs(new Set()),
    spawnImpl: processFactory([], calls), now: () => 0,
  });
  assert.throws(
    () => adapter.spawn(
      { ok: true, id: 'codex', path: shim, argsPrefix: [], source: 'path', version: '1.0.0', arch: null },
      ['--version'],
    ),
    /command scripts must be materialized/i,
  );
  assert.deepEqual(calls, []);
});

test('Windows resolution rejects bat wrappers outside the strict npm contract', async () => {
  const calls = [];
  const shim = 'C:\\Tools With Space\\uv.bat';
  const adapter = createWindowsAdapter({
    platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp',
    env: { Path: 'C:\\Tools With Space' }, fs: fakeFs(new Set([shim])),
    spawnImpl: processFactory([{ stdout: 'uv 0.8.0 x64' }], calls), now: () => 0,
  });

  const result = await adapter.resolveExecutable('uv');
  assert.equal(result.ok, false);
  assert.deepEqual(calls, []);
});

test('Windows executable resolution looks up PATH and SystemRoot case-insensitively', async () => {
  const calls = [];
  const executable = 'C:\\Tools\\codex.exe';
  const adapter = createWindowsAdapter({
    platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp',
    env: { path: 'C:\\Tools', systemroot: 'D:\\Windows' },
    fs: fakeFs(new Set([executable]), {}, { [executable]: pe64(0x8664) }),
    spawnImpl: processFactory([{ stdout: 'codex-cli 1.0.0 x64' }, {}], calls), now: () => 0,
  });

  const result = await adapter.resolveExecutable('codex');
  await adapter.openLoginTerminal('codex');

  assert.equal(result.ok, true);
  assert.equal(result.path, executable);
  assert.equal(calls[0].file, executable);
  assert.equal(calls[1].file, 'D:\\Windows\\System32\\cmd.exe');
});

test('Windows ZCode desktop scripts are materialized as a verified Node command', async () => {
  const calls = [];
  const discoveredNode = 'C:\\Tools\\node.exe';
  const zcodeScript = 'C:\\Users\\a\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs';
  const adapter = createWindowsAdapter({
    platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp', env: { Path: 'C:\\Tools' },
    fs: fakeFs(new Set([discoveredNode, zcodeScript])),
    spawnImpl: processFactory([
      { stdout: 'v24.17.0 x64' },
      { stdout: 'zcode 1.0.0' },
    ], calls),
    now: () => 0,
  });
  const result = await adapter.resolveExecutable('zcode', { requiredArch: 'x64' });
  assert.equal(result.ok, true);
  assert.equal(result.path, discoveredNode);
  assert.deepEqual(result.argsPrefix, [zcodeScript]);
  assert.deepEqual(calls[1].args, [zcodeScript, '--version']);
});

test('macOS ZCode cjs candidates need read access but not an executable bit before Node materialization', async () => {
  const calls = [];
  const discoveredNode = '/path/bin/node';
  const zcodeScript = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
  const files = new Set([discoveredNode, zcodeScript]);
  const adapter = createMacosAdapter({
    platform: 'darwin', arch: 'arm64', home: '/Users/a', temp: '/tmp', env: { PATH: '/path/bin' },
    fs: {
      constants: { X_OK: 1, R_OK: 4 },
      existsSync: (file) => files.has(file),
      realpathSync: (file) => file,
      statSync: () => ({ isFile: () => true }),
      accessSync: (file, mode) => {
        if (file === zcodeScript && mode === 1) throw Object.assign(new Error('not executable'), { code: 'EACCES' });
      },
    },
    spawnImpl: processFactory([
      { stdout: 'v24.17.0 arm64' },
      { stdout: 'zcode 1.0.0' },
    ], calls),
    now: () => 0,
  });

  const result = await adapter.resolveExecutable('zcode', { requiredArch: 'arm64' });
  assert.equal(result.ok, true);
  assert.equal(result.path, discoveredNode);
  assert.deepEqual(result.argsPrefix, [zcodeScript]);
});
