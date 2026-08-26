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

function assertOnlyRegistryQueries(calls, message) {
  assert.equal(calls.length, 2, message);
  assert.equal(calls.every((call) => /reg\.exe$/i.test(call.file)), true, message);
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

test('Windows standard candidates find common fresh CLI installer directories', async () => {
  const cases = [
    { id: 'claude', executable: 'C:\\Users\\a\\.local\\bin\\claude.exe' },
    { id: 'opencode', executable: 'C:\\Users\\a\\scoop\\shims\\opencode.exe' },
    { id: 'opencode', executable: 'C:\\Users\\a\\.opencode\\bin\\opencode.exe' },
  ];

  for (const fixture of cases) {
    const calls = [];
    const adapter = createWindowsAdapter({
      platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp', env: { PATH: '' },
      fs: fakeFs(new Set([fixture.executable])),
      spawnImpl: processFactory([{ code: 1 }, { code: 1 }, { stdout: fixture.id + ' 1.0.0' }], calls), now: () => 0,
    });

    const result = await adapter.resolveExecutable(fixture.id);

    assert.equal(result.ok, true, fixture.executable);
    assert.equal(result.path, fixture.executable);
    assert.equal(result.source, 'standard');
    assert.equal(calls.filter((call) => /reg\.exe$/i.test(call.file)).length, 2);
  }
});

test('Windows prefers the bundled OpenCode runtime after an explicit override', async () => {
  const calls = [];
  const bundled = 'C:\\Extensions\\com.aemcp.panel\\runtime\\opencode\\opencode.exe';
  const pathCopy = 'C:\\Tools\\opencode.exe';
  const adapter = createWindowsAdapter({
    platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp',
    extensionRoot: 'C:\\Extensions\\com.aemcp.panel', env: { Path: 'C:\\Tools' },
    fs: fakeFs(new Set([bundled, pathCopy]), {}, { [bundled]: pe64(0x8664), [pathCopy]: pe64(0x8664) }),
    spawnImpl: processFactory([{ stdout: 'opencode 1.18.23' }], calls), now: () => 0,
  });

  const result = await adapter.resolveExecutable('opencode', { requiredArch: 'x64' });

  assert.equal(result.ok, true);
  assert.equal(result.path, bundled);
  assert.equal(result.source, 'runtime');
  assert.deepEqual(calls.map((call) => call.file), [bundled]);
});

test('Windows OpenCode runtime lookup is empty without an extension root', async () => {
  const calls = [];
  const adapter = createWindowsAdapter({
    platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp', env: { Path: '' },
    fs: fakeFs(new Set()), spawnImpl: processFactory([{ code: 1 }, { code: 1 }], calls), now: () => 0,
  });

  const result = await adapter.resolveExecutable('opencode');

  assert.equal(result.ok, false);
  assertOnlyRegistryQueries(calls);
});

test('Windows OpenCode override wins over the bundled runtime', async () => {
  const calls = [];
  const override = 'C:\\Override\\opencode.exe';
  const bundled = 'C:\\Extensions\\com.aemcp.panel\\runtime\\opencode\\opencode.exe';
  const adapter = createWindowsAdapter({
    platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp',
    extensionRoot: 'C:\\Extensions\\com.aemcp.panel', env: { Path: '' },
    fs: fakeFs(new Set([override, bundled]), {}, { [override]: pe64(0x8664), [bundled]: pe64(0x8664) }),
    spawnImpl: processFactory([{ stdout: 'opencode 1.19.0' }], calls), now: () => 0,
  });

  const result = await adapter.resolveExecutable('opencode', { overridePath: override, requiredArch: 'x64' });

  assert.equal(result.path, override);
  assert.equal(result.source, 'override');
});

test('Windows OpenCode falls back to PATH when the bundled runtime is absent', async () => {
  const calls = [];
  const pathCopy = 'C:\\Tools\\opencode.exe';
  const adapter = createWindowsAdapter({
    platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp',
    extensionRoot: 'C:\\Extensions\\com.aemcp.panel', env: { Path: 'C:\\Tools' },
    fs: fakeFs(new Set([pathCopy]), {}, { [pathCopy]: pe64(0x8664) }),
    spawnImpl: processFactory([{ stdout: 'opencode 1.19.0' }], calls), now: () => 0,
  });

  const result = await adapter.resolveExecutable('opencode', { requiredArch: 'x64' });

  assert.equal(result.path, pathCopy);
  assert.equal(result.source, 'path');
});

test('Windows resolution reads expanded registry PATH entries for default environments', async () => {
  const calls = [];
  const executable = 'C:\\Users\\a\\.local\\bin\\claude.exe';
  const adapter = createWindowsAdapter({
    platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp',
    env: { PATH: 'C:\\Inherited', USERPROFILE: 'C:\\Users\\a' },
    fs: fakeFs(new Set([executable])),
    spawnImpl: processFactory([
      { stdout: '\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\.local\\bin;C:\\Custom Tools\r\n' },
      { stdout: '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment\r\n    Path    REG_SZ    C:\\System Tools\r\n' },
      { stdout: 'claude 1.0.0' },
    ], calls), now: () => 0,
  });

  const result = await adapter.resolveExecutable('claude');

  assert.equal(result.ok, true);
  assert.equal(result.path, executable);
  assert.equal(result.source, 'registry-path');
  assert.deepEqual(calls.slice(0, 2).map((call) => call.args), [
    ['query', 'HKCU\\Environment', '/v', 'Path'],
    ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', '/v', 'Path'],
  ]);
});

test('Windows explicit resolver environments do not read the registry PATH', async () => {
  const calls = [];
  const executable = 'C:\\Users\\a\\.local\\bin\\claude.exe';
  const adapter = createWindowsAdapter({
    platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp', env: { PATH: 'C:\\Inherited' },
    fs: fakeFs(new Set([executable])), spawnImpl: processFactory([{ stdout: 'claude 1.0.0' }], calls), now: () => 0,
  });

  const result = await adapter.resolveExecutable('claude', { env: { PATH: '' } });

  assert.equal(result.ok, true);
  assert.equal(result.source, 'standard');
  assert.equal(calls.some((call) => /reg\.exe$/i.test(call.file)), false);
});

test('Windows spawn prepends registry and standard executable directories without changing PATH resolutions', async () => {
  const registryCalls = [];
  const registryExecutable = 'C:\\Registry Bin\\claude.exe';
  const registry = createWindowsAdapter({
    platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp', env: { PATH: 'C:\\Inherited', KEEP: 'yes' },
    fs: fakeFs(new Set([registryExecutable])),
    spawnImpl: processFactory([
      { stdout: '\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_SZ    C:\\Registry Bin\r\n' },
      { code: 1 },
      { stdout: 'claude 1.0.0' },
      {},
    ], registryCalls), now: () => 0,
  });
  const registryResult = await registry.resolveExecutable('claude');
  registry.spawn(registryResult);
  assert.equal(registryCalls.at(-1).options.env.PATH, 'C:\\Registry Bin;C:\\Inherited');
  assert.equal(registryCalls.at(-1).options.env.KEEP, 'yes');

  const standardCalls = [];
  const standardExecutable = 'C:\\Users\\a\\.local\\bin\\claude.exe';
  const standard = createWindowsAdapter({
    platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp', env: { Path: 'C:\\Inherited', KEEP: 'yes' },
    fs: fakeFs(new Set([standardExecutable])),
    spawnImpl: processFactory([{ code: 1 }, { code: 1 }, { stdout: 'claude 1.0.0' }, {}], standardCalls), now: () => 0,
  });
  const standardResult = await standard.resolveExecutable('claude');
  standard.spawn(standardResult);
  assert.equal(standardCalls.at(-1).options.env.Path, 'C:\\Users\\a\\.local\\bin;C:\\Inherited');
  assert.equal(standardCalls.at(-1).options.env.PATH, undefined);

  const pathCalls = [];
  const pathExecutable = 'C:\\Path Bin\\claude.exe';
  const path = createWindowsAdapter({
    platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp', env: { PATH: 'C:\\Path Bin;C:\\Inherited' },
    fs: fakeFs(new Set([pathExecutable])), spawnImpl: processFactory([{ stdout: 'claude 1.0.0' }, {}], pathCalls), now: () => 0,
  });
  const pathResult = await path.resolveExecutable('claude');
  path.spawn(pathResult);
  assert.equal(pathCalls.at(-1).options.env.PATH, 'C:\\Path Bin;C:\\Inherited');
});

test('Windows registry PATH candidates skip directories already in the inherited PATH', async () => {
  const calls = [];
  const adapter = createWindowsAdapter({
    platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp', env: { PATH: 'C:\\Existing Bin\\' },
    fs: fakeFs(new Set()),
    spawnImpl: processFactory([
      { stdout: '\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_SZ    c:\\existing bin\r\n' },
      { stdout: '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment\r\n    Path    REG_SZ    C:\\Existing Bin\\\r\n' },
    ], calls), now: () => 0,
  });

  const result = await adapter.resolveExecutable('claude');

  assert.equal(result.ok, false);
  assert.equal(calls.length, 2);
  assert.equal(calls.every((call) => /reg\.exe$/i.test(call.file)), true);
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
  assert.equal(calls[0].options.env.PATH, '/explicit/bin');
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

test('a Windows Claude npm cmd shim resolves to the in-package native exe', async () => {
  const calls = [];
  const npmRoot = 'C:\\Users\\a\\AppData\\Roaming\\npm';
  const shim = npmRoot + '\\claude.cmd';
  const native = npmRoot
    + '\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
  const contents = [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
    '',
  ].join('\r\n');
  const adapter = createWindowsAdapter({
    platform: 'win32',
    arch: 'x64',
    home: 'C:\\Users\\a',
    temp: 'C:\\Temp',
    env: { Path: npmRoot },
    fs: fakeFs(new Set([shim, native]), {}, {
      [shim]: Buffer.from(contents),
      [native]: pe64(0x8664),
    }),
    spawnImpl: processFactory([
      { stdout: '2.1.227 (Claude Code)\n' },
    ], calls),
    now: () => 0,
  });

  const result = await adapter.resolveExecutable('claude', {
    minimumVersion: '2.0.0',
    requiredArch: 'x64',
  });

  assert.equal(result.ok, true);
  assert.equal(result.path, native);
  assert.equal(result.displayPath, shim);
  assert.deepEqual(result.argsPrefix, []);
  assert.equal(result.version, '2.1.227');
  assert.equal(result.arch, 'x64');
  assert.deepEqual(calls.map((call) => call.file), [native]);
  assert.deepEqual(calls[0].args, ['--version']);
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
  assertOnlyRegistryQueries(calls);
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
  assertOnlyRegistryQueries(calls);
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
  assertOnlyRegistryQueries(calls);
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
  assert.equal(result.displayPath, golden.shim, 'diagnostics keep naming the shim (#225)');
  assert.deepEqual(result.argsPrefix, [golden.entry]);
  assert.deepEqual(calls.map((call) => call.file), [node, node]);
});

test('requiredArch accepts strict local and global npm cmd-shims without cmd.exe', async () => {
  for (const value of CMD_SHIM_GOLDENS.filter((fixture) => fixture.variant === 'node-launcher')) {
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
    assert.equal(result.displayPath, value.shim);
    assert.deepEqual(result.argsPrefix, [value.entry]);
    assert.deepEqual(calls.map((call) => call.file), [node, node]);
  }
});

test('direct-exe npm cmd-shims dereference the native entry before arch inspection', async () => {
  const calls = [];
  const golden = cmdShimGolden('cmd-shim-direct-exe-global');
  const adapter = createWindowsAdapter({
    platform: 'win32', arch: 'x64', home: 'C:\\Users\\A', temp: 'C:\\Temp', env: { Path: golden.path },
    fs: fakeFs(new Set([golden.shim, golden.entry]), {}, {
      [golden.shim]: Buffer.from(golden.content),
      [golden.entry]: pe64(0x8664),
    }),
    spawnImpl: processFactory([{ stdout: 'opencode 1.2.3' }], calls), now: () => 0,
  });

  const result = await adapter.resolveExecutable('opencode', { requiredArch: 'x64' });

  assert.equal(result.ok, true);
  assert.equal(result.path, golden.entry);
  assert.equal(result.displayPath, golden.shim);
  assert.deepEqual(result.argsPrefix, []);
  assert.equal(result.arch, 'x64');
  assert.deepEqual(calls.map((call) => call.file), [golden.entry]);
  assert.deepEqual(calls[0].args, ['--version']);
});

test('direct-exe npm cmd-shims reject escape, non-exe, and mangled-prefix variants', async () => {
  for (const golden of CMD_SHIM_GOLDENS.filter((fixture) => fixture.variant === 'direct-exe-negative')) {
    const calls = [];
    const adapter = createWindowsAdapter({
      platform: 'win32', arch: 'x64', home: 'C:\\Users\\A', temp: 'C:\\Temp', env: { Path: golden.path },
      fs: fakeFs(new Set([golden.shim, golden.entry]), {}, {
        [golden.shim]: Buffer.from(golden.content),
        [golden.entry]: pe64(0x8664),
      }),
      spawnImpl: processFactory([], calls), now: () => 0,
    });

    const result = await adapter.resolveExecutable('opencode', { requiredArch: 'x64' });

    assert.equal(result.ok, false, golden.name);
    assertOnlyRegistryQueries(calls, golden.name);
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
  assertOnlyRegistryQueries(calls);
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
    assertOnlyRegistryQueries(calls);
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
  assertOnlyRegistryQueries(calls);
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
