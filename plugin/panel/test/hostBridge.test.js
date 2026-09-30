import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import {
  createHostController,
  isValidPort,
  loadBundledHostDependencies,
  loadSavedPort,
  normalizeCepPath,
  resolveHostInstance,
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
    statSync: () => ({ isFile: () => true }),
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
});
