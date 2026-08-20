import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import {
  buildMcpConfig,
  createHostController,
  isValidPort,
  loadBundledHostDependencies,
  loadSavedPort,
  normalizeCepPath,
  savePort,
} from '../src/cep/hostBridge.js';
import { createWindowsAdapter } from '../src/cep/platform/windows.js';

function testPathCatalog(platformId, runtimeRoot) {
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
    runtimeRoot,
  };
}

function macHostAdapter(fsImpl = fs, runtimeRoot = '/Users/a/.ae-mcp/runtime') {
  return {
    id: 'macos-arm64',
    fs: fsImpl,
    paths: testPathCatalog('macos-arm64', runtimeRoot),
  };
}

function nativeHostAdapter(fsImpl = fs) {
  const platformId = process.platform === 'win32' ? 'windows-x64' : 'macos-arm64';
  return {
    id: platformId,
    fs: fsImpl,
    paths: testPathCatalog(platformId, path.join(os.homedir(), '.ae-mcp', 'runtime')),
  };
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

function expectHostDependenciesUnavailable(callback) {
  assert.throws(
    callback,
    (error) => error && error.code === 'HOST_RUNTIME_DEPENDENCIES_UNAVAILABLE',
  );
}

function writeCommonJsPackage(packageRoot, source, name = 'express') {
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
  fs.writeFileSync(path.join(packageRoot, 'index.js'), source);
}

function fakeHostDependencyRuntime({ platformId, extensionRoot, express }) {
  const nativePath = platformId === 'windows-x64' ? path.win32 : path.posix;
  const hostRoot = nativePath.join(extensionRoot, 'runtime', platformId, 'node', 'host');
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

test('MCP config remains a direct local ae-mcp command', () => {
  assert.deepEqual(buildMcpConfig(11488, true, 'ae-mcp'), {
    mcpServers: {
      ae: {
        command: 'ae-mcp',
        env: {
          AE_MCP_BACKEND: 'ae-mcp',
          AE_MCP_PLUGIN_URL: 'http://127.0.0.1:11488',
        },
      },
    },
  });
});

test('saved panel port round-trips and rejects invalid values', () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
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

test('host Express resolves from the platform-specific bundle runtime without NODE_PATH mutation', (t) => {
  const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-host-resolution-'));
  t.after(() => fs.rmSync(extensionRoot, { recursive: true, force: true }));
  const adapter = nativeHostAdapter();
  const runtimeHost = path.join(extensionRoot, 'runtime', adapter.id, 'node', 'host');
  const extensionHost = path.join(extensionRoot, 'host');
  fs.mkdirSync(path.join(runtimeHost, 'node_modules', 'express'), { recursive: true });
  fs.mkdirSync(extensionHost, { recursive: true });
  fs.writeFileSync(path.join(runtimeHost, 'package.json'), '{"private":true}\n');
  fs.writeFileSync(
    path.join(runtimeHost, 'node_modules', 'express', 'package.json'),
    '{"name":"express","main":"index.js"}\n',
  );
  fs.writeFileSync(
    path.join(runtimeHost, 'node_modules', 'express', 'index.js'),
    'module.exports = function bundledExpress() {};\n',
  );
  fs.writeFileSync(path.join(extensionHost, 'probe.js'), 'module.exports = require("express");\n');
  const cepRequire = createRequire(import.meta.url);
  const nodePathBefore = process.env.NODE_PATH;
  const resolverBefore = Module._resolveFilename;

  assert.throws(
    () => cepRequire(path.join(extensionHost, 'probe.js')),
    (error) => error && error.code === 'MODULE_NOT_FOUND',
  );
  const dependencies = loadBundledHostDependencies({ cepRequire, adapter, extensionRoot });

  assert.equal(typeof dependencies.express, 'function');
  assert.equal(dependencies.express.name, 'bundledExpress');
  assert.equal(process.env.NODE_PATH, nodePathBefore);
  assert.equal(Module._resolveFilename, resolverBefore);
  assert.equal(Object.isFrozen(dependencies), true);
});

test('host Express resolves from extension host only for an explicit .debug development install', (t) => {
  const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-host-dev-resolution-'));
  t.after(() => fs.rmSync(extensionRoot, { recursive: true, force: true }));
  const adapter = nativeHostAdapter();
  const extensionHost = path.join(extensionRoot, 'host');
  fs.mkdirSync(path.join(extensionHost, 'node_modules', 'express'), { recursive: true });
  fs.writeFileSync(path.join(extensionRoot, '.debug'), '<ExtensionList />\n');
  fs.writeFileSync(path.join(extensionHost, 'package.json'), '{"private":true}\n');
  fs.writeFileSync(
    path.join(extensionHost, 'node_modules', 'express', 'package.json'),
    '{"name":"express","main":"index.js"}\n',
  );
  fs.writeFileSync(
    path.join(extensionHost, 'node_modules', 'express', 'index.js'),
    'module.exports = function developmentExpress() {};\n',
  );

  const dependencies = loadBundledHostDependencies({
    cepRequire: createRequire(import.meta.url), adapter, extensionRoot,
  });
  assert.equal(dependencies.express.name, 'developmentExpress');
});

test('host dependency loading rejects fallback to extension or ancestor node_modules', (t) => {
  const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-host-ambient-'));
  t.after(() => fs.rmSync(extensionRoot, { recursive: true, force: true }));
  const runtimeHost = path.join(extensionRoot, 'runtime', 'macos-arm64', 'node', 'host');
  fs.mkdirSync(runtimeHost, { recursive: true });
  fs.writeFileSync(path.join(runtimeHost, 'package.json'), '{"private":true}\n');
  writeCommonJsPackage(
    path.join(extensionRoot, 'node_modules', 'express'),
    'module.exports = function ancestorExpress() {};\n',
  );

  expectHostDependenciesUnavailable(() => loadBundledHostDependencies({
    cepRequire: createRequire(import.meta.url), adapter: macHostAdapter(), extensionRoot,
  }));
});

test('host dependency loading rejects Express discovered only through NODE_PATH', (t) => {
  const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-host-node-path-'));
  const ambientRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-host-node-path-ambient-'));
  t.after(() => fs.rmSync(extensionRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(ambientRoot, { recursive: true, force: true }));
  const runtimeHost = path.join(extensionRoot, 'runtime', 'macos-arm64', 'node', 'host');
  fs.mkdirSync(runtimeHost, { recursive: true });
  fs.writeFileSync(path.join(runtimeHost, 'package.json'), '{"private":true}\n');
  writeCommonJsPackage(
    path.join(ambientRoot, 'express'),
    'module.exports = function nodePathExpress() {};\n',
  );
  const previousNodePath = process.env.NODE_PATH;
  const resolverBefore = Module._resolveFilename;
  process.env.NODE_PATH = ambientRoot;
  Module._initPaths();
  t.after(() => {
    if (previousNodePath === undefined) delete process.env.NODE_PATH;
    else process.env.NODE_PATH = previousNodePath;
    Module._initPaths();
  });

  expectHostDependenciesUnavailable(() => loadBundledHostDependencies({
    cepRequire: createRequire(import.meta.url), adapter: macHostAdapter(), extensionRoot,
  }));
  assert.equal(Module._resolveFilename, resolverBefore);
});

test('host dependency loading rejects selected anchors and package roots that are symlinks', (t) => {
  for (const development of [false, true]) {
    const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-host-anchor-link-'));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-host-anchor-outside-'));
    t.after(() => fs.rmSync(extensionRoot, { recursive: true, force: true }));
    t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
    const hostRoot = development
      ? path.join(extensionRoot, 'host')
      : path.join(extensionRoot, 'runtime', 'macos-arm64', 'node', 'host');
    fs.mkdirSync(hostRoot, { recursive: true });
    if (development) fs.writeFileSync(path.join(extensionRoot, '.debug'), '<ExtensionList />\n');
    fs.writeFileSync(path.join(outsideRoot, 'package.json'), '{"private":true}\n');
    const linked = createSymlinkOrSkip(
      t,
      path.join(outsideRoot, 'package.json'),
      path.join(hostRoot, 'package.json'),
    );
    if (!linked) {
      return;
    }
    writeCommonJsPackage(
      path.join(hostRoot, 'node_modules', 'express'),
      'module.exports = function linkedAnchorExpress() {};\n',
    );

    expectHostDependenciesUnavailable(() => loadBundledHostDependencies({
      cepRequire: createRequire(import.meta.url), adapter: macHostAdapter(), extensionRoot,
    }));
  }
});

test('host dependency loading rejects an Express package symlink that escapes the host root', (t) => {
  const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-host-package-link-'));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-host-package-outside-'));
  t.after(() => fs.rmSync(extensionRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
  const runtimeHost = path.join(extensionRoot, 'runtime', 'macos-arm64', 'node', 'host');
  fs.mkdirSync(path.join(runtimeHost, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(runtimeHost, 'package.json'), '{"private":true}\n');
  writeCommonJsPackage(outsideRoot, 'module.exports = function escapedPackageExpress() {};\n');
  if (!createSymlinkOrSkip(t, outsideRoot, path.join(runtimeHost, 'node_modules', 'express'))) return;

  expectHostDependenciesUnavailable(() => loadBundledHostDependencies({
    cepRequire: createRequire(import.meta.url), adapter: macHostAdapter(), extensionRoot,
  }));
});

test('host dependency loading rejects an Express entry symlink even when it remains in host root', (t) => {
  const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-host-entry-link-'));
  t.after(() => fs.rmSync(extensionRoot, { recursive: true, force: true }));
  const hostRoot = path.join(extensionRoot, 'runtime', 'macos-arm64', 'node', 'host');
  const expressRoot = path.join(hostRoot, 'node_modules', 'express');
  fs.mkdirSync(expressRoot, { recursive: true });
  fs.writeFileSync(path.join(hostRoot, 'package.json'), '{"private":true}\n');
  fs.writeFileSync(
    path.join(expressRoot, 'package.json'),
    '{"name":"express","main":"index.js"}\n',
  );
  const inRootTarget = path.join(hostRoot, 'other.js');
  fs.writeFileSync(inRootTarget, 'module.exports = function linkedMainExpress() {};\n');
  if (!createSymlinkOrSkip(t, inRootTarget, path.join(expressRoot, 'index.js'))) return;

  expectHostDependenciesUnavailable(() => loadBundledHostDependencies({
    cepRequire: createRequire(import.meta.url), adapter: macHostAdapter(), extensionRoot,
  }));
});

test('host dependency loading rejects a package main entry outside its package root', (t) => {
  const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-host-main-escape-'));
  t.after(() => fs.rmSync(extensionRoot, { recursive: true, force: true }));
  const hostRoot = path.join(extensionRoot, 'runtime', 'macos-arm64', 'node', 'host');
  const expressRoot = path.join(hostRoot, 'node_modules', 'express');
  fs.mkdirSync(expressRoot, { recursive: true });
  fs.writeFileSync(path.join(hostRoot, 'package.json'), '{"private":true}\n');
  fs.writeFileSync(
    path.join(expressRoot, 'package.json'),
    '{"name":"express","main":"../../other.js"}\n',
  );
  fs.writeFileSync(path.join(hostRoot, 'other.js'), 'module.exports = function escapedMainExpress() {};\n');

  expectHostDependenciesUnavailable(() => loadBundledHostDependencies({
    cepRequire: createRequire(import.meta.url), adapter: macHostAdapter(), extensionRoot,
  }));
});

test('host controller reuses an already-normalized extension root instead of reading CEP again', () => {
  const calls = [];
  let receivedRoots = null;
  let receivedDependencies = null;
  let receivedNativeRuntime = null;
  const bundledExpress = function bundledExpress() {};
  const runtime = fakeHostDependencyRuntime({
    platformId: 'macos-arm64', extensionRoot: '/Applications/AE MCP', express: bundledExpress,
  });
  const host = {
    setRuntimeDependencies(dependencies) { receivedDependencies = dependencies; },
    setNativeAegpRuntime(runtime) { receivedNativeRuntime = runtime; },
    setCSInterface() {},
    start(port, callback, roots) { calls.push(port); receivedRoots = roots; callback(null); },
    stop() {},
  };
  const platform = macHostAdapter(runtime.fs, '/Applications/AE MCP/runtime');
  const controller = createHostController({
    cs: { getSystemPath: () => { throw new Error('extension root was read twice'); } },
    extensionRoot: '/Applications/AE MCP',
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
  assert.equal(calls[0], '/Applications/AE MCP/host/server.js');
  assert.equal(receivedDependencies.express, bundledExpress);
  assert.deepEqual(receivedNativeRuntime, { platform: 'darwin', arch: 'arm64' });
  assert.deepEqual(receivedRoots, {
    extensionRoot: '/Applications/AE MCP',
    runtimeRoot: '/Applications/AE MCP/runtime',
  });
});

test('host controller keeps identical native roots when restarting', () => {
  const calls = [];
  const host = {
    setRuntimeDependencies() {},
    setCSInterface() {},
    start(port, callback, roots) { calls.push({ method: 'start', port, roots }); callback(null); },
    restart(port, callback, roots) { calls.push({ method: 'restart', port, roots }); callback(null); },
    stop() {},
  };
  const runtime = fakeHostDependencyRuntime({
    platformId: 'windows-x64', extensionRoot: 'C:\\Program Files\\AE MCP',
    express: function bundledExpress() {},
  });
  const platform = createWindowsAdapter({
    platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp', env: {},
    fs: runtime.fs,
    spawnImpl() { throw new Error('not expected'); },
    now: () => 0,
  });
  const controller = createHostController({
    cs: { getSystemPath: () => 'file:///C:/Program%20Files/AE%20MCP' },
    platform,
    requireImpl: (request) => {
      if (request === 'module') return runtime.moduleApi;
      if (request === 'path') return path;
      return host;
    },
    onStatus: () => {}, onLog: () => {}, addBeforeUnload: () => {},
  });

  controller.start(11488);
  controller.restart(11489);

  const expectedRoots = {
    extensionRoot: 'C:\\Program Files\\AE MCP',
    runtimeRoot: 'C:\\Users\\a\\.ae-mcp\\runtime',
  };
  assert.deepEqual(calls[0], { method: 'start', port: 11488, roots: expectedRoots });
  assert.deepEqual(calls[1], { method: 'restart', port: 11489, roots: expectedRoots });
});

test('host bridge no longer loads platform-helper modules', () => {
  const source = fs.readFileSync(new URL('../src/cep/hostBridge.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /platform-helper/);
  assert.doesNotMatch(source, /repairPlatformHelper/);
});
