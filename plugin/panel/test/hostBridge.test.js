import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import {
  createHostController,
  isValidPort,
  loadBundledHostDependencies,
  loadSavedPort,
  normalizeCepPath,
  resolveHostInstance,
  resolveWorkDirectory,
  savePort,
} from '../src/cep/hostBridge.js';
import { createWindowsAdapter } from '../src/cep/platform/windows.js';
import { createMacosAdapter } from '../src/cep/platform/macos.js';

function testPathCatalog(platformId) {
  const nativePath = platformId === 'windows-x64' ? path.win32 : path.posix;
  const normalize = (value) => {
    const resolved = nativePath.resolve(value);
    return platformId === 'windows-x64' ? resolved.toLowerCase() : resolved;
  };
  return {
    home: platformId === 'windows-x64' ? 'C:\\Users\\a' : '/Users/a',
    join: (parts) => nativePath.join(...parts),
    resolve: (parts) => nativePath.resolve(...parts),
    dirname: (value) => nativePath.dirname(value),
    isAbsolute: (value) => nativePath.isAbsolute(value),
    contains: (root, candidate) => {
      const relative = nativePath.relative(nativePath.resolve(root), nativePath.resolve(candidate));
      return relative === '' || (!relative.startsWith('..' + nativePath.sep)
        && relative !== '..' && !nativePath.isAbsolute(relative));
    },
    same: (left, right) => normalize(left) === normalize(right),
  };
}

function hostAdapter(fsImpl = fs, platformId = 'macos-arm64') {
  return { id: platformId, fs: fsImpl, paths: testPathCatalog(platformId) };
}

// Tests that hit the real filesystem need the path catalog of the machine
// they run on — a posix catalog against real Windows temp paths reports
// every containment check as an escape.
function nativeHostAdapter(fsImpl = fs) {
  return hostAdapter(fsImpl, process.platform === 'win32' ? 'windows-x64' : 'macos-arm64');
}

function createSymlinkOrSkip(t, target, destination, type) {
  try {
    fs.symlinkSync(target, destination, type);
    return true;
  } catch (error) {
    if (process.platform === 'win32' && error?.code === 'EPERM') {
      t.skip('Windows symbolic-link privilege is unavailable');
      return false;
    }
    throw error;
  }
}

function expectUnavailable(callback) {
  assert.throws(
    callback,
    (error) => error && error.code === 'HOST_RUNTIME_DEPENDENCIES_UNAVAILABLE',
  );
}

function writeCommonJsPackage(packageRoot, source, name = 'express') {
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(packageRoot + '/package.json', JSON.stringify({ name, main: 'index.js' }));
  fs.writeFileSync(packageRoot + '/index.js', source);
}

function fakeHostDependencyRuntime({ platformId, extensionRoot, express }) {
  const nativePath = platformId === 'windows-x64' ? path.win32 : path.posix;
  const hostRoot = nativePath.join(extensionRoot, 'host');
  const anchor = nativePath.join(hostRoot, 'package.json');
  const expressRoot = nativePath.join(hostRoot, 'node_modules', 'express');
  const expressEntry = nativePath.join(expressRoot, 'index.js');
  const expressPackage = nativePath.join(expressRoot, 'package.json');
  const existing = new Set([anchor, hostRoot, expressRoot, expressEntry, expressPackage]);
  const fakeFs = {
    existsSync: (candidate) => existing.has(candidate),
    lstatSync: (candidate) => ({
      isFile: () => [anchor, expressEntry, expressPackage].includes(candidate),
      isSymbolicLink: () => false,
    }),
    statSync: () => ({ isFile: () => true, isDirectory: () => true }),
    accessSync() {},
    realpathSync: (candidate) => candidate,
    readFileSync: (candidate) => {
      if (candidate === expressPackage) return '{"name":"express","main":"index.js"}\n';
      if (candidate === anchor) return '{"private":true}\n';
      throw new Error('unexpected fixture read: ' + candidate);
    },
  };
  const moduleApi = {
    builtinModules: ['fs', 'module', 'path'],
    isBuiltin: (request) => ['fs', 'module', 'path'].includes(String(request).replace(/^node:/, '')),
    _resolveFilename: (request) => request,
    createRequire: () => {
      const anchored = (request) => {
        if (request === expressEntry) return express;
        throw new Error('unexpected anchored require: ' + request);
      };
      anchored.resolve = (request) => {
        if (request === 'express') return expressEntry;
        if (request === 'express/package.json') return expressPackage;
        return request;
      };
      return anchored;
    },
  };
  return { fs: fakeFs, moduleApi };
}

test('normalizeCepPath strips CEP file URLs without changing native paths', () => {
  assert.equal(normalizeCepPath('file:///C:/Program%20Files/AE%20MCP'), 'C:/Program Files/AE MCP');
  assert.equal(normalizeCepPath('/Applications/AE MCP'), '/Applications/AE MCP');
});

test('isValidPort accepts the supported host listener range', () => {
  assert.equal(isValidPort(1023), false);
  assert.equal(isValidPort(1024), true);
  assert.equal(isValidPort(65535), true);
  assert.equal(isValidPort(65536), false);
});

test('saved panel port round-trips and rejects invalid values', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key),
    setItem: (key, value) => values.set(key, value),
  };
  savePort(storage, 11489);
  assert.equal(loadSavedPort(storage), 11489);
  values.set('ae_mcp_panel_port', '70000');
  assert.equal(loadSavedPort(storage), null);
});

test('normalizeCepPath uses the adapter for Windows paths and UNC file URLs', () => {
  const platform = createWindowsAdapter({
    platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp', env: {},
    fs: { existsSync: () => false },
    spawnImpl() { throw new Error('not expected'); },
    now: () => 0,
  });

  assert.equal(
    normalizeCepPath('file:///C:/Program%20Files/AE%20MCP', platform),
    'C:\\Program Files\\AE MCP',
  );
  assert.equal(
    normalizeCepPath('file://server/share/AE%20MCP/plugin', platform),
    '\\\\server\\share\\AE MCP\\plugin',
  );
});

test('host Express resolves from the extension host without NODE_PATH mutation', (t) => {
  const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-host-resolution-'));
  t.after(() => fs.rmSync(extensionRoot, { recursive: true, force: true }));
  const hostRoot = path.join(extensionRoot, 'host');
  fs.mkdirSync(path.join(hostRoot, 'node_modules', 'express'), { recursive: true });
  fs.writeFileSync(path.join(hostRoot, 'package.json'), '{"private":true}\n');
  fs.writeFileSync(
    path.join(hostRoot, 'node_modules', 'express', 'package.json'),
    '{"name":"express","main":"index.js"}\n',
  );
  fs.writeFileSync(
    path.join(hostRoot, 'node_modules', 'express', 'index.js'),
    'module.exports = function bundledExpress() {};\n',
  );
  const adapter = nativeHostAdapter();
  const cepRequire = createRequire(import.meta.url);
  const nodePathBefore = process.env.NODE_PATH;
  const resolverBefore = Module._resolveFilename;
  const dependencies = loadBundledHostDependencies({ cepRequire, adapter, extensionRoot });

  assert.equal(typeof dependencies.express, 'function');
  assert.equal(dependencies.express.name, 'bundledExpress');
  assert.equal(process.env.NODE_PATH, nodePathBefore);
  assert.equal(Module._resolveFilename, resolverBefore);
  assert.equal(Object.isFrozen(dependencies), true);
});

test('host dependency loading rejects a missing direct host anchor', (t) => {
  const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-host-missing-'));
  t.after(() => fs.rmSync(extensionRoot, { recursive: true, force: true }));
  writeCommonJsPackage(
    path.join(extensionRoot, 'node_modules', 'express'),
    'module.exports = function ambientExpress() {};\n',
  );
  expectUnavailable(() => loadBundledHostDependencies({
    cepRequire: createRequire(import.meta.url),
    adapter: nativeHostAdapter(),
    extensionRoot,
  }));
});

test('host dependency loading rejects a symlinked host anchor', (t) => {
  const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-host-anchor-link-'));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-host-anchor-outside-'));
  t.after(() => fs.rmSync(extensionRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
  const hostRoot = path.join(extensionRoot, 'host');
  fs.mkdirSync(hostRoot, { recursive: true });
  fs.writeFileSync(path.join(outsideRoot, 'package.json'), '{"private":true}\n');
  if (!createSymlinkOrSkip(
    t,
    path.join(outsideRoot, 'package.json'),
    path.join(hostRoot, 'package.json'),
  )) return;
  writeCommonJsPackage(path.join(hostRoot, 'node_modules', 'express'), 'module.exports = function x() {};\n');
  expectUnavailable(() => loadBundledHostDependencies({
    cepRequire: createRequire(import.meta.url), adapter: nativeHostAdapter(), extensionRoot,
  }));
});

test('host dependency loading rejects an Express package that escapes its host root', (t) => {
  const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-host-package-link-'));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-host-package-outside-'));
  t.after(() => fs.rmSync(extensionRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
  const hostRoot = path.join(extensionRoot, 'host');
  fs.mkdirSync(path.join(hostRoot, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(hostRoot, 'package.json'), '{"private":true}\n');
  writeCommonJsPackage(outsideRoot, 'module.exports = function escapedExpress() {};\n');
  if (!createSymlinkOrSkip(
    t,
    outsideRoot,
    path.join(hostRoot, 'node_modules', 'express'),
    'junction',
  )) return;
  expectUnavailable(() => loadBundledHostDependencies({
    cepRequire: createRequire(import.meta.url), adapter: nativeHostAdapter(), extensionRoot,
  }));
});

test('host dependency loading rejects a package main entry outside its package root', (t) => {
  const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-host-main-escape-'));
  t.after(() => fs.rmSync(extensionRoot, { recursive: true, force: true }));
  const hostRoot = path.join(extensionRoot, 'host');
  const expressRoot = path.join(hostRoot, 'node_modules', 'express');
  fs.mkdirSync(expressRoot, { recursive: true });
  fs.writeFileSync(path.join(hostRoot, 'package.json'), '{"private":true}\n');
  fs.writeFileSync(path.join(expressRoot, 'package.json'), '{"name":"express","main":"../../other.js"}\n');
  fs.writeFileSync(path.join(hostRoot, 'other.js'), 'module.exports = function escapedMain() {};\n');
  expectUnavailable(() => loadBundledHostDependencies({
    cepRequire: createRequire(import.meta.url), adapter: nativeHostAdapter(), extensionRoot,
  }));
});

test('host controller loads the direct host bundle and restarts without root payload state', () => {
  const calls = [];
  let receivedDependencies = null;
  let receivedNativeRuntime = null;
  const bundledExpress = function bundledExpress() {};
  const runtime = fakeHostDependencyRuntime({
    platformId: 'macos-arm64', extensionRoot: '/Applications/AE MCP', express: bundledExpress,
  });
  const host = {
    setRuntimeDependencies(dependencies) { receivedDependencies = dependencies; },
    setNativeAegpRuntime(value) { receivedNativeRuntime = value; },
    setCSInterface() {},
    configureInstance() {},
    start(port, callback) { calls.push({ method: 'start', port }); callback(null); },
    restart(port, callback) { calls.push({ method: 'restart', port }); callback(null); },
    stop() {},
  };
  const platform = hostAdapter(runtime.fs);
  const controller = createHostController({
    cs: { getSystemPath: () => { throw new Error('extension root was read twice'); } },
    extensionRoot: '/Applications/AE MCP',
    environment: {},
    createInstanceId: () => 'manual-main',
    platform,
    requireImpl: (request) => {
      if (request === 'module') return runtime.moduleApi;
      if (request === 'path') return path;
      calls.push(request);
      return host;
    },
    onStatus: () => {}, onLog: () => {}, addBeforeUnload: () => {},
  });
  controller.start(11488);
  controller.restart(11489);

  assert.equal(calls[0], '/Applications/AE MCP/host/server.js');
  assert.deepEqual(receivedNativeRuntime, { platform: 'darwin', arch: 'arm64' });
  assert.equal(receivedDependencies.express, bundledExpress);
  assert.deepEqual(calls.slice(1), [
    { method: 'start', port: 11488 },
    { method: 'restart', port: 11489 },
  ]);
});

test('host bridge has no retired helper wiring', () => {
  const source = fs.readFileSync(new URL('../src/cep/hostBridge.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /platform-helper|runtimeRoot|runtime[\\/]/i);
});

test('host identity uses the AE launch PID instead of the CEP process PID', () => {
  const env = { AE_MCP_INSTANCE_ID: 'main-launched', AE_MCP_INSTANCE_ROLE: 'primary',
    AE_MCP_WORK_DIR: '/projects', AE_MCP_LAUNCH_TICKET: '/ticket.json' };
  const ticket = { version: 1, instanceId: 'main-launched', role: 'primary', workDir: '/projects', pid: 902 };
  const info = resolveHostInstance({ env, readTicket: () => ticket,
    paths: testPathCatalog('macos-arm64'), createId: () => 'unused' });
  assert.equal(info.aePid, 902);
  const manual = resolveHostInstance({ env: {}, createId: () => 'manual-main', paths: testPathCatalog('macos-arm64') });
  assert.equal(manual.instanceId, 'manual-main');
  assert.equal(manual.aePid, null);
  assert.equal(manual.workDir, null);
  assert.throws(() => resolveHostInstance({ env, readTicket: () => ({ ...ticket, instanceId: 'other-main' }),
    paths: testPathCatalog('macos-arm64') }), /does not match/);
});

test('work directory defaults to the saved project parent or writable home on both platforms', () => {
  for (const id of ['windows-x64', 'macos-arm64']) {
    const paths = testPathCatalog(id);
    const platform = { id, paths, fs: {
      statSync: () => ({ isDirectory: () => true }),
      accessSync: (directory) => { if (directory.includes('locked')) throw new Error('EACCES'); },
    } };
    const parent = paths.join([paths.home, '工程 空格']);
    const projectPath = paths.join([parent, '镜头.aep']);
    const resolve = (options) => resolveWorkDirectory({ platform, projectPath, ...options });
    assert.equal(resolve({}), parent);
    assert.equal(resolve({ directory: paths.home }), paths.home);
    assert.equal(resolve({ projectPath: null }), paths.home);
    assert.equal(resolve({ projectPath: paths.join([paths.home, 'locked', 'a.aep']) }), paths.home);
    assert.throws(() => resolve({ directory: 'relative' }), /writable absolute/);
    assert.throws(() => resolve({ directory: paths.join([paths.home, 'locked']) }), /writable absolute/);
  }
});

test('work directory changes are scoped to the current project and controller and can reset', async () => {
  const runtime = fakeHostDependencyRuntime({ platformId: 'macos-arm64', extensionRoot: '/extension', express: () => {} });
  function harness() {
    let projectPath = '/shots/a/main.aep';
    let workDir;
    const host = { setRuntimeDependencies() {}, setCSInterface() {},
      configureInstance: (value) => { workDir = value.workDir; },
      getInstanceInfo: () => ({ projectPath, workDir }),
      executeJsx: async (input) => {
        assert.equal(input.nativeProjectGraphEffect, 'preserve');
        assert.equal(input.undoGroup, undefined);
        return { payload: { ok: true, result: projectPath } };
      },
      start: (port, callback) => callback(null, { port }),
    };
    const controller = createHostController({ cs: {}, platform: hostAdapter(runtime.fs), extensionRoot: '/extension',
      environment: {}, createInstanceId: () => 'test-main', addBeforeUnload() {}, onLog() {},
      onStatus: (state, port, error) => { assert.notEqual(state, 'error', error); },
      requireImpl: (request) => request === 'module' ? runtime.moduleApi : request === 'path' ? path : host,
    });
    return { host, controller, open: (value) => { projectPath = value; } };
  }
  const a = harness();
  const b = harness();
  await a.controller.start(11488);
  await b.controller.start(11489);
  assert.equal(a.host.getInstanceInfo().workDir, '/shots/a');
  assert.equal(await a.controller.refreshWorkDirectory('/custom'), '/custom');
  assert.equal(b.host.getInstanceInfo().workDir, '/shots/a');
  a.open('/shots/b/save-as.aep');
  assert.equal(await a.controller.refreshWorkDirectory(), '/shots/b');
  a.open('/shots/a/main.aep');
  assert.equal(await a.controller.refreshWorkDirectory(), '/custom');
  assert.equal(await a.controller.refreshWorkDirectory(null), '/shots/a');
  a.open(null);
  assert.equal(await a.controller.refreshWorkDirectory(), '/Users/a');
});

test('host lifecycle reports the bound port and makes panel unload terminal without relaunching', () => {
  const runtime = fakeHostDependencyRuntime({ platformId: 'macos-arm64', extensionRoot: '/extension', express: () => {} });
  const calls = [];
  let unload;
  let configured;
  const states = [];
  const ticket = { version: 1, instanceId: 'main-ticket', role: 'primary', workDir: '/projects',
    pid: 902, bootstrapStatusPath: '/launch-status.json' };
  const files = { ...runtime.fs,
    readFileSync: (file) => file === '/launch-ticket.json' ? JSON.stringify(ticket) : runtime.fs.readFileSync(file),
    writeFileSync: (file, value) => {
      assert.equal(file, ticket.bootstrapStatusPath);
      states.push(JSON.parse(value).state);
    },
  };
  const host = {
    setRuntimeDependencies() {}, setCSInterface() {},
    configureInstance: (value) => { configured = value; },
    start: (port, callback) => {
      assert.deepEqual(states, ['panel-loading']);
      calls.push(['start', port]); callback(null, { port: 12001 });
    },
    markIntentionalDisconnect: (reason) => calls.push(['disconnect', reason]),
    stop: () => calls.push(['stop']),
  };
  const controller = createHostController({
    cs: {}, platform: hostAdapter(files), extensionRoot: '/extension',
    environment: { AE_MCP_WORK_DIR: '/projects', AE_MCP_INSTANCE_ROLE: 'primary',
      AE_MCP_INSTANCE_ID: 'main-ticket', AE_MCP_LAUNCH_TICKET: '/launch-ticket.json' },
    requireImpl: (request) => request === 'module' ? runtime.moduleApi : request === 'path' ? path : host,
    onStatus: (...value) => calls.push(['status', ...value]), onLog() {},
    addBeforeUnload: (callback) => { unload = callback; },
  });
  controller.start(0);
  assert.equal(configured.workDir, '/projects');
  assert.ok(calls.some((entry) => entry[0] === 'status' && entry[1] === 'ok' && entry[2] === 12001));
  unload();
  assert.equal(controller.getHost(), null);
  assert.deepEqual(calls.slice(-2), [['disconnect', 'panel-closed'], ['stop']]);
  assert.equal(calls.filter((entry) => entry[0] === 'start').length, 1);
  assert.deepEqual(states, ['panel-loading', 'host-started', 'intentional-disconnect']);
});

test('a restored panel in a read worker does not load a host or its dependencies', () => {
  const statuses = [];
  const controller = createHostController({ cs: {}, platform: hostAdapter({}), extensionRoot: '/extension',
    environment: { AE_MCP_INSTANCE_ID: 'worker', AE_MCP_INSTANCE_ROLE: 'worker', AE_MCP_WORK_DIR: '/jobs' },
    requireImpl: () => { throw new Error('worker must not load server'); },
    onStatus: (...value) => statuses.push(value), onLog() {},
  });
  controller.start(11488);
  assert.equal(statuses.at(-1)[0], 'disabled');
  assert.equal(controller.getHost(), null);
});

function processProbeSpawn(output) {
  return (file, args, options) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { end() {} };
    proc.kill = () => {};
    queueMicrotask(() => {
      proc.stdout.emit('data', Buffer.from(output(file, args, options)));
      proc.emit('exit', 0, null);
      proc.emit('close', 0, null);
    });
    return proc;
  };
}

test('manual Windows panels bind only a formal AE process on their validated parent chain', async () => {
  const rows = [
    { pid: 90, ppid: 80, executablePath: 'C:\\Adobe\\CEPHtmlEngine.exe' },
    { pid: 80, ppid: 10, executablePath: 'C:\\Adobe\\Adobe After Effects 2026\\Support Files\\AfterFX.exe' },
  ];
  const platform = createWindowsAdapter({ platform: 'win32', arch: 'x64', pid: 90,
    home: 'C:\\Users\\a', temp: 'C:\\Temp', env: { SystemRoot: 'D:\\Windows' },
    fs: { existsSync: () => false }, now: Date.now,
    spawnImpl: processProbeSpawn((file, args, options) => {
      assert.equal(file, 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
      assert.ok(args.includes('-NonInteractive'));
      assert.ok(args.includes('-NoProfile'));
      assert.equal(args.at(-1).match(/Get-CimInstance/g)?.length, 1);
      assert.equal(options.windowsHide, true);
      return JSON.stringify(rows);
    }),
  });
  assert.equal(await platform.resolveAeHostPid({ cepPid: 90 }), 80);
  rows[1].pid = 81;
  assert.equal(await platform.resolveAeHostPid({ cepPid: 90 }), null);
  rows[1].pid = 80;
  rows[1].executablePath = 'C:\\Adobe\\Adobe After Effects (Beta)\\Support Files\\AfterFX.exe';
  assert.equal(await platform.resolveAeHostPid({ cepPid: 90 }), null);
});

test('Windows PID probe executes one snapshot and emits only the bounded CEP ancestry', { skip: process.platform !== 'win32' }, async () => {
  let executable, probe;
  const platform = createWindowsAdapter({ platform: 'win32', arch: 'x64', pid: 90,
    home: os.homedir(), temp: os.tmpdir(), env: process.env, fs, now: Date.now,
    spawnImpl: processProbeSpawn((file, args) => { executable = file; probe = args.at(-1); return '[]'; }),
  });
  await platform.resolveAeHostPid({ cepPid: 90 });
  const row = (pid, ppid) => ({ ProcessId: pid, ParentProcessId: ppid, ExecutablePath: `C:\\process-${pid}.exe` });
  const snapshots = [
    [row(70, 1), row(90, 80), row(80, 1)],
    [row(90, 80), row(80, 90)],
    [row(90, 80)],
    Array.from({ length: 15 }, (_, i) => row(90 - i, 89 - i)),
  ];
  const setup = JSON.stringify(snapshots).replace(/'/g, "''");
  const script = [
    `$aeTestSnapshots=ConvertFrom-Json '${setup}'`,
    'function Get-CimInstance { [CmdletBinding()] param($ClassName,$Property)',
    '$script:aeTestCalls++; if($ClassName -ne "Win32_Process"){throw "wrong class"}',
    'for($aeTestPid=1000;$aeTestPid -lt 2000;$aeTestPid++){[pscustomobject]@{ProcessId=$aeTestPid;ParentProcessId=1;ExecutablePath="C:\\other.exe"}}',
    '$script:aeTestSnapshot }',
    '$aeTestResults=@(foreach($script:aeTestSnapshot in $aeTestSnapshots){',
    '$script:aeTestCalls=0',
    `$aeTestOutput=& {\n${probe}\n}`,
    'if($script:aeTestCalls -ne 1){throw "expected one snapshot"}',
    '[pscustomobject]@{json=$aeTestOutput}',
    '})',
    'ConvertTo-Json -InputObject $aeTestResults -Depth 5 -Compress',
  ].join('\n');
  const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const results = JSON.parse(result.stdout);
  assert.deepEqual(results.map(item => JSON.parse(item.json).map(entry => entry.pid)),
    [[90, 80], [90, 80], [90], Array.from({ length: 12 }, (_, i) => 90 - i)]);
  assert.ok(result.stdout.length < 16384);
});

test('Windows PID probe rejects malformed ancestry and invalid input without guessing an owner', async () => {
  let output = '[]', calls = 0;
  const platform = createWindowsAdapter({ platform: 'win32', arch: 'x64', pid: 90,
    home: 'C:\\Users\\a', temp: 'C:\\Temp', env: {}, fs: { existsSync: () => false }, now: Date.now,
    spawnImpl: processProbeSpawn(() => { calls += 1; return output; }),
  });
  for (const input of [{ cepPid: null }, { cepPid: 1 }, { cepPid: 1.5 }, { timeoutMs: 0 }]) {
    assert.equal(await platform.resolveAeHostPid(input), null);
  }
  assert.equal(calls, 0);
  for (const value of ['', '{', '{}', '[]',
    JSON.stringify([{ pid: 91, ppid: 1, executablePath: 'C:\\AfterFX.exe' }]),
    JSON.stringify([{ pid: 90, ppid: '80', executablePath: 'C:\\AfterFX.exe' }]),
    JSON.stringify([{ pid: 90, ppid: 80 }, { pid: 80, ppid: 90 }, { pid: 90, ppid: 1, executablePath: 'C:\\AfterFX.exe' }]),
    JSON.stringify(Array.from({ length: 13 }, (_, i) => ({ pid: 90 - i, ppid: 89 - i })))]) {
    output = value;
    assert.equal(await platform.resolveAeHostPid({ cepPid: 90 }), null, value);
  }
});

function pidRetryHarness({ resolvePid, waitForPidRetry, hostOverrides = {} }) {
  const runtime = fakeHostDependencyRuntime({ platformId: 'macos-arm64', extensionRoot: '/extension', express: () => {} });
  const statuses = [], probes = [], waits = [], calls = [];
  let unload;
  const host = { setRuntimeDependencies() {}, setCSInterface() {}, configureInstance() {},
    stop: () => calls.push('stop'),
    start: (port, callback) => { calls.push('start'); callback(null, { port }); },
    restart: (port, callback) => { calls.push('restart'); callback(null, { port }); },
    ...hostOverrides,
  };
  const controller = createHostController({ cs: {}, extensionRoot: '/extension', environment: {},
    platform: { ...hostAdapter(runtime.fs), pid: 90, resolveAeHostPid: args => { probes.push(args); return resolvePid(); } },
    waitForPidRetry: async ms => { waits.push(ms); await waitForPidRetry?.(ms); },
    createInstanceId: () => 'retry-main', addBeforeUnload: callback => { unload = callback; }, onLog() {},
    requireImpl: request => request === 'module' ? runtime.moduleApi : request === 'path' ? path : host,
    onStatus: (...value) => statuses.push(value),
  });
  return { controller, statuses, probes, waits, calls, unload: () => unload() };
}

test('PID discovery retries in place and starts once when the second or third attempt succeeds', async () => {
  for (const successfulAttempt of [2, 3]) {
    let attempt = 0;
    const h = pidRetryHarness({ resolvePid: async () => ++attempt === successfulAttempt ? 80 : null });
    await h.controller.start(11488);
    assert.deepEqual(h.probes, Array(successfulAttempt).fill({ cepPid: 90, timeoutMs: 4000 }));
    assert.deepEqual(h.waits, [250, 750].slice(0, successfulAttempt - 1));
    assert.deepEqual(h.calls, ['start']);
    assert.equal(h.statuses.at(-1)[0], 'ok');
    assert.equal(h.controller.getInstance().nativeUnavailable, null);
    await h.controller.restart(11489);
    assert.deepEqual(h.calls, ['start', 'restart']);
    assert.equal(h.probes.length, successfulAttempt);
  }
});

test('PID retry exhaustion never starts a host and Retry connection reruns discovery without reopening', async () => {
  const values = [null, 1, '80', 80];
  const h = pidRetryHarness({ resolvePid: async () => values.shift() });
  await h.controller.start(11488);
  assert.equal(h.statuses.at(-1)[0], 'error');
  assert.match(h.statuses.at(-1)[2], /AE_HOST_PID_UNVERIFIED.*3 attempts.*Retry connection/);
  assert.equal(h.statuses.some(value => value[0] === 'ok'), false);
  assert.equal(h.calls.includes('start'), false);
  assert.equal(h.controller.getHost(), null);
  assert.equal(h.controller.getInstance().aePid, null);
  assert.equal(h.controller.getInstance().nativeUnavailable.code, 'AE_HOST_PID_UNVERIFIED');
  assert.deepEqual(h.waits, [250, 750]);
  await h.controller.restart(11488);
  assert.equal(h.probes.length, 4);
  assert.equal(h.calls.filter(value => value === 'start').length, 1);
  assert.equal(h.statuses.at(-1)[0], 'ok');
  assert.equal(h.controller.getInstance().aePid, 80);
});

test('closing during PID retry backoff cancels retries and concurrent restart cannot duplicate startup', async () => {
  let resume, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const h = pidRetryHarness({ resolvePid: async () => null,
    waitForPidRetry: () => { entered(); return new Promise(resolve => { resume = resolve; }); } });
  const starting = h.controller.start(11488);
  await waiting;
  await h.controller.restart(11488);
  assert.equal(h.probes.length, 1);
  h.unload();
  resume();
  await starting;
  assert.equal(h.probes.length, 1);
  assert.equal(h.calls.includes('start'), false);
  assert.equal(h.controller.getHost(), null);
  assert.equal(h.controller.getInstance().aePid, null);
});

test('PID retry leaves no registry owner or close marker before successful service publication', async t => {
  const require = createRequire(import.meta.url);
  const { InstanceRegistry } = require('../../host/instance-registry.js');
  const { createInstanceService } = require('../../host/instance-service.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-pid-retry-'));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  const registry = new InstanceRegistry({ root, isProcessAlive: () => true });
  let service, configured = {}, published, pid = null;
  t.after(async () => { await service?.markClosed('test-completed'); fs.rmSync(root, { recursive: true, force: true }); });
  const h = pidRetryHarness({ resolvePid: async () => pid, hostOverrides: {
    configureInstance: value => { configured = { ...configured, ...value }; service?.configure(value); },
    getInstanceInfo: () => service?.getInfo() || configured,
    stop: () => service?.markClosed('panel-stopped'),
    start: (port, callback) => {
      service = createInstanceService({ ...configured, registry, cepPid: 90, launcher: {},
        executeJsx: async () => ({ payload: { ok: true, result: JSON.stringify({ projectPath: '/fixture/pid.aep', dirty: false, revision: 1 }) } }) });
      published = service.publish('http://127.0.0.1:' + port + '/mcp').then(() => callback(null, { port }), callback);
    },
  } });
  await h.controller.start(11488);
  assert.equal(service, undefined);
  assert.deepEqual(await registry.list({ includeClosed: true }), []);
  assert.equal(fs.existsSync(path.join(root, 'retry-main.closed')), false);
  pid = 80;
  await h.controller.restart(11488);
  await published;
  const owner = await registry.get('retry-main');
  assert.equal(owner.state, 'running');
  assert.equal(owner.pid, 80);
  assert.equal(fs.existsSync(path.join(root, 'retry-main.closed')), false);
  assert.equal(h.statuses.at(-1)[0], 'ok');
});

test('manual macOS panels follow ps parent relationships without selecting an unrelated AE', async () => {
  const checked = [];
  const platform = createMacosAdapter({ platform: 'darwin', arch: 'arm64', pid: 90,
    home: '/Users/a', temp: '/tmp', env: {}, fs: { existsSync: () => false }, now: Date.now,
    spawnImpl: processProbeSpawn((file, args) => {
      assert.equal(file, '/bin/ps');
      checked.push(args[1]);
      return args[1] === '90' ? '90 80 /Library/Adobe/CEPHtmlEngine'
        : '80 1 /Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/After Effects';
    }),
  });
  assert.equal(await platform.resolveAeHostPid({ cepPid: 90 }), 80);
  assert.deepEqual(checked, ['90', '80']);
});

test('closing a panel during its parent process probe cannot start the listener afterwards', async () => {
  const runtime = fakeHostDependencyRuntime({ platformId: 'macos-arm64', extensionRoot: '/extension', express: () => {} });
  let settle;
  let unload;
  let starts = 0;
  const host = { setRuntimeDependencies() {}, setCSInterface() {}, configureInstance() {},
    stop() {}, markIntentionalDisconnect() {}, start() { starts += 1; } };
  const platform = { ...hostAdapter(runtime.fs), pid: 90, resolveAeHostPid: ({ cepPid, timeoutMs }) => {
    assert.equal(cepPid, 90);
    assert.equal(timeoutMs, 4000);
    return new Promise((resolve) => { settle = resolve; });
  } };
  const controller = createHostController({ cs: {}, platform, extensionRoot: '/extension',
    environment: {}, createInstanceId: () => 'main-a',
    requireImpl: (request) => request === 'module' ? runtime.moduleApi : request === 'path' ? path : host,
    onStatus() {}, onLog() {}, addBeforeUnload: (callback) => { unload = callback; },
  });
  const starting = controller.start(0);
  unload();
  settle(90);
  await starting;
  assert.equal(starts, 0);
  assert.equal(controller.getHost(), null);
  assert.equal(controller.getInstance().aePid, null);
});
