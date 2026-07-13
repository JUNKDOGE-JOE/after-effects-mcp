import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { normalizeCepPath, isValidPort, buildMcpConfig, loadSavedPort, savePort, createHostController, loadBundledHostDependencies } from '../src/cep/hostBridge.js';
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

test('normalizeCepPath strips file scheme and windows leading slash', () => {
  assert.equal(normalizeCepPath('file:///C:/x/y'), 'C:/x/y');
  assert.equal(normalizeCepPath('file://C:\\x'), 'C:\\x');
});

test('normalizeCepPath uses the adapter to produce a native Windows path', () => {
  const platform = createWindowsAdapter({
    platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp', env: {},
    fs: { existsSync: () => false }, spawnImpl() { throw new Error('not expected'); }, now: () => 0,
  });

  assert.equal(
    normalizeCepPath('file:///C:/Program%20Files/AE%20MCP', platform),
    'C:\\Program Files\\AE MCP',
  );
});

test('normalizeCepPath preserves a Windows UNC file URL authority', () => {
  const platform = createWindowsAdapter({
    platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', temp: 'C:\\Temp', env: {},
    fs: { existsSync: () => false }, spawnImpl: () => { throw new Error('not expected'); }, now: () => 0,
  });
  assert.equal(
    normalizeCepPath('file://server/share/AE%20MCP/plugin', platform),
    '\\\\server\\share\\AE MCP\\plugin',
  );
});

test('isValidPort bounds', () => {
  assert.equal(isValidPort(11488), true);
  assert.equal(isValidPort(80), false);
  assert.equal(isValidPort(NaN), false);
});

test('buildMcpConfig matches the real shape - no --port args, no token', () => {
  const c = buildMcpConfig(11488);
  assert.deepEqual(c.mcpServers.ae, {
    command: 'ae-mcp',
    env: { AE_MCP_BACKEND: 'ae-mcp', AE_MCP_PLUGIN_URL: 'http://127.0.0.1:11488' },
  });
  assert.equal(JSON.stringify(c).includes('token'), false);
});

test('port persistence round-trip with fake storage', () => {
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) };
  assert.equal(loadSavedPort(storage), null);
  savePort(storage, 12000);
  assert.equal(loadSavedPort(storage), 12000);
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
  fs.writeFileSync(path.join(runtimeHost, 'node_modules', 'express', 'package.json'), '{"name":"express","main":"index.js"}\n');
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
    'an extension-host require must not accidentally see runtime/node/host/node_modules',
  );

  const dependencies = loadBundledHostDependencies({
    cepRequire,
    adapter,
    extensionRoot,
  });

  assert.equal(typeof dependencies.express, 'function');
  assert.equal(dependencies.express.name, 'bundledExpress');
  assert.equal(process.env.NODE_PATH, nodePathBefore);
  assert.equal(Module._resolveFilename, resolverBefore);
  assert.equal(Object.isFrozen(dependencies), true);
});

test('host Express resolves from the extension host only for an explicit .debug development install', (t) => {
  const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-host-dev-resolution-'));
  t.after(() => fs.rmSync(extensionRoot, { recursive: true, force: true }));
  const adapter = nativeHostAdapter();
  const extensionHost = path.join(extensionRoot, 'host');
  fs.mkdirSync(path.join(extensionHost, 'node_modules', 'express'), { recursive: true });
  fs.writeFileSync(path.join(extensionRoot, '.debug'), '<ExtensionList />\n');
  fs.writeFileSync(path.join(extensionHost, 'package.json'), '{"private":true}\n');
  fs.writeFileSync(path.join(extensionHost, 'node_modules', 'express', 'package.json'), '{"name":"express","main":"index.js"}\n');
  fs.writeFileSync(
    path.join(extensionHost, 'node_modules', 'express', 'index.js'),
    'module.exports = function developmentExpress() {};\n',
  );

  const dependencies = loadBundledHostDependencies({
    cepRequire: createRequire(import.meta.url),
    adapter,
    extensionRoot,
  });

  assert.equal(dependencies.express.name, 'developmentExpress');
});

test('host Express never falls back to extension node_modules without the .debug marker', (t) => {
  const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-host-prod-resolution-'));
  t.after(() => fs.rmSync(extensionRoot, { recursive: true, force: true }));
  const extensionHost = path.join(extensionRoot, 'host');
  fs.mkdirSync(path.join(extensionHost, 'node_modules', 'express'), { recursive: true });
  fs.writeFileSync(path.join(extensionHost, 'package.json'), '{"private":true}\n');
  fs.writeFileSync(
    path.join(extensionHost, 'node_modules', 'express', 'index.js'),
    'module.exports = function ambientExpress() {};\n',
  );

  assert.throws(
    () => loadBundledHostDependencies({
      cepRequire: createRequire(import.meta.url),
      adapter: macHostAdapter(),
      extensionRoot,
    }),
    (error) => error && error.code === 'HOST_RUNTIME_DEPENDENCIES_UNAVAILABLE',
  );
});

test('host dependency loading rejects an ancestor Express when the selected anchor has no local package', (t) => {
  const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-host-ancestor-'));
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

test('host dependency loading rejects Express discovered only through host NODE_PATH and restores the resolver hook', (t) => {
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

test('host dependency loading rejects selected package anchors that are symlinks', (t) => {
  for (const development of [false, true]) {
    const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-host-anchor-link-'));
    t.after(() => fs.rmSync(extensionRoot, { recursive: true, force: true }));
    const hostRoot = development
      ? path.join(extensionRoot, 'host')
      : path.join(extensionRoot, 'runtime', 'macos-arm64', 'node', 'host');
    const outsideAnchor = path.join(extensionRoot, 'outside-package.json');
    fs.mkdirSync(hostRoot, { recursive: true });
    if (development) fs.writeFileSync(path.join(extensionRoot, '.debug'), '<ExtensionList />\n');
    fs.writeFileSync(outsideAnchor, '{"private":true}\n');
    if (!createSymlinkOrSkip(t, outsideAnchor, path.join(hostRoot, 'package.json'))) return;
    writeCommonJsPackage(
      path.join(hostRoot, 'node_modules', 'express'),
      'module.exports = function linkedAnchorExpress() {};\n',
    );

    expectHostDependenciesUnavailable(() => loadBundledHostDependencies({
      cepRequire: createRequire(import.meta.url), adapter: macHostAdapter(), extensionRoot,
    }));
  }
});

test('host dependency loading rejects an Express package symlink that escapes the selected host root', (t) => {
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

test('host dependency loading rejects an Express entry symlink that escapes the selected host root', (t) => {
  const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-host-entry-link-'));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-host-entry-outside-'));
  t.after(() => fs.rmSync(extensionRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
  const runtimeHost = path.join(extensionRoot, 'runtime', 'macos-arm64', 'node', 'host');
  const expressRoot = path.join(runtimeHost, 'node_modules', 'express');
  fs.mkdirSync(expressRoot, { recursive: true });
  fs.writeFileSync(path.join(runtimeHost, 'package.json'), '{"private":true}\n');
  fs.writeFileSync(path.join(expressRoot, 'package.json'), '{"name":"express","main":"index.js"}\n');
  const outsideEntry = path.join(outsideRoot, 'index.js');
  fs.writeFileSync(outsideEntry, 'module.exports = function escapedEntryExpress() {};\n');
  if (!createSymlinkOrSkip(t, outsideEntry, path.join(expressRoot, 'index.js'))) return;

  expectHostDependenciesUnavailable(() => loadBundledHostDependencies({
    cepRequire: createRequire(import.meta.url), adapter: macHostAdapter(), extensionRoot,
  }));
});

test('host dependency loading rejects a transitive dependency that falls back to an ambient ancestor', (t) => {
  const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-host-transitive-'));
  t.after(() => fs.rmSync(extensionRoot, { recursive: true, force: true }));
  const runtimeHost = path.join(extensionRoot, 'runtime', 'macos-arm64', 'node', 'host');
  fs.mkdirSync(runtimeHost, { recursive: true });
  fs.writeFileSync(path.join(runtimeHost, 'package.json'), '{"private":true}\n');
  writeCommonJsPackage(
    path.join(runtimeHost, 'node_modules', 'express'),
    'require("ambient-only"); module.exports = function transitiveExpress() {};\n',
  );
  writeCommonJsPackage(
    path.join(extensionRoot, 'node_modules', 'ambient-only'),
    'module.exports = true;\n',
    'ambient-only',
  );
  const resolverBefore = Module._resolveFilename;

  expectHostDependenciesUnavailable(() => loadBundledHostDependencies({
    cepRequire: createRequire(import.meta.url), adapter: macHostAdapter(), extensionRoot,
  }));
  assert.equal(Module._resolveFilename, resolverBefore);
});

test('host dependency loading rejects production and development host roots symlinked outside the extension', (t) => {
  for (const development of [false, true]) {
    const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-host-root-link-'));
    const outsideHost = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-host-root-outside-'));
    t.after(() => fs.rmSync(extensionRoot, { recursive: true, force: true }));
    t.after(() => fs.rmSync(outsideHost, { recursive: true, force: true }));
    const hostRoot = development
      ? path.join(extensionRoot, 'host')
      : path.join(extensionRoot, 'runtime', 'macos-arm64', 'node', 'host');
    fs.mkdirSync(path.dirname(hostRoot), { recursive: true });
    fs.writeFileSync(path.join(outsideHost, 'package.json'), '{"private":true}\n');
    writeCommonJsPackage(
      path.join(outsideHost, 'node_modules', 'express'),
      'module.exports = function escapedHostRootExpress() {};\n',
    );
    if (!createSymlinkOrSkip(t, outsideHost, hostRoot, 'dir')) return;
    if (development) fs.writeFileSync(path.join(extensionRoot, '.debug'), '<ExtensionList />\n');

    expectHostDependenciesUnavailable(() => loadBundledHostDependencies({
      cepRequire: createRequire(import.meta.url), adapter: macHostAdapter(), extensionRoot,
    }));
  }
});

test('host dependency loading rejects an Express main entry outside the exact package root', (t) => {
  const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-host-main-escape-'));
  t.after(() => fs.rmSync(extensionRoot, { recursive: true, force: true }));
  const hostRoot = path.join(extensionRoot, 'runtime', 'macos-arm64', 'node', 'host');
  const expressRoot = path.join(hostRoot, 'node_modules', 'express');
  fs.mkdirSync(expressRoot, { recursive: true });
  fs.writeFileSync(path.join(hostRoot, 'package.json'), '{"private":true}\n');
  fs.writeFileSync(path.join(expressRoot, 'package.json'), '{"name":"express","main":"../../other.js"}\n');
  fs.writeFileSync(path.join(hostRoot, 'other.js'), 'module.exports = function escapedMainExpress() {};\n');

  expectHostDependenciesUnavailable(() => loadBundledHostDependencies({
    cepRequire: createRequire(import.meta.url), adapter: macHostAdapter(), extensionRoot,
  }));
});

test('host dependency loading rejects an in-root Express entry symlink', (t) => {
  const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-host-entry-in-root-link-'));
  t.after(() => fs.rmSync(extensionRoot, { recursive: true, force: true }));
  const hostRoot = path.join(extensionRoot, 'runtime', 'macos-arm64', 'node', 'host');
  const expressRoot = path.join(hostRoot, 'node_modules', 'express');
  fs.mkdirSync(expressRoot, { recursive: true });
  fs.writeFileSync(path.join(hostRoot, 'package.json'), '{"private":true}\n');
  fs.writeFileSync(path.join(expressRoot, 'package.json'), '{"name":"express","main":"index.js"}\n');
  const inRootTarget = path.join(hostRoot, 'other.js');
  fs.writeFileSync(inRootTarget, 'module.exports = function linkedMainExpress() {};\n');
  if (!createSymlinkOrSkip(t, inRootTarget, path.join(expressRoot, 'index.js'))) return;

  expectHostDependenciesUnavailable(() => loadBundledHostDependencies({
    cepRequire: createRequire(import.meta.url), adapter: macHostAdapter(), extensionRoot,
  }));
});

test('host controller reuses an already-normalized extension root instead of reading CEP again', () => {
  const calls = [];
  let receivedRoots = null;
  let receivedDependencies = null;
  const bundledExpress = function bundledExpress() {};
  const runtime = fakeHostDependencyRuntime({
    platformId: 'macos-arm64', extensionRoot: '/Applications/AE MCP', express: bundledExpress,
  });
  const host = {
    setRuntimeDependencies(dependencies) { receivedDependencies = dependencies; },
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
    onStatus: () => {}, onLog: () => {},
    addBeforeUnload: () => {},
  });
  controller.start(11488);
  assert.equal(calls[0], '/Applications/AE MCP/host/server.js');
  assert.equal(receivedDependencies.express, bundledExpress);
  assert.deepEqual(receivedRoots, {
    extensionRoot: '/Applications/AE MCP',
    runtimeRoot: '/Applications/AE MCP/runtime',
  });
});

test('host controller keeps the same native roots when restarting', () => {
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
    spawnImpl() { throw new Error('not expected'); }, now: () => 0,
  });
  const controller = createHostController({
    cs: { getSystemPath: () => 'file:///C:/Program%20Files/AE%20MCP' }, platform,
    requireImpl: (request) => request === 'module' ? runtime.moduleApi : (request === 'path' ? path : host),
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

test('real host controller exposes in-process Foundation helper pass-through methods', async () => {
  const calls = [];
  const reference = 'aemcp-secret://provider/5eb75f05-5d9e-5d9c-85af-f0893e8b90c2/auth-model/v1';
  const transport = { request() {}, close() {} };
  const helperClient = {
    async capabilities() { calls.push(['capabilities']); return { authenticatedCaller: true }; },
    async secretGet(value) { calls.push(['secretGet', value]); return { reference: value, value: 'secret', revision: 1 }; },
    async secretSet(value) { calls.push(['secretSet', value]); return { reference: value.reference, revision: 1 }; },
    async secretDelete(value) { calls.push(['secretDelete', value]); return { reference: value.reference, deleted: true, revision: 1 }; },
    async close() { calls.push(['close']); },
  };
  const host = {
    setRuntimeDependencies() {},
    setCSInterface() {},
    setPlatformRoots() {},
    start(_port, callback) { callback(null); },
    stop() {},
  };
  const runtime = fakeHostDependencyRuntime({
    platformId: 'macos-arm64', extensionRoot: '/Applications/AE MCP',
    express: function bundledExpress() {},
  });
  const controller = createHostController({
    cs: { getSystemPath: () => '/Applications/AE MCP' },
    extensionRoot: '/Applications/AE MCP',
    platform: macHostAdapter(runtime.fs, '/Applications/AE MCP/runtime'),
    requireImpl: (request) => request === 'module' ? runtime.moduleApi : (request === 'path' ? path : host),
    createPlatformHelperTransportImpl(options) {
      calls.push(['createTransport', options.platformId]);
      return transport;
    },
    createPlatformHelperClientImpl(options) {
      calls.push(['createClient', options.transport]);
      return helperClient;
    },
    onStatus: () => {}, onLog: () => {}, addBeforeUnload: () => {},
  });

  controller.start(11488);
  const inProcessHost = controller.getHost();
  assert.equal(typeof inProcessHost.capabilities, 'function');
  assert.equal(typeof inProcessHost.secretGet, 'function');
  assert.equal(typeof inProcessHost.secretSet, 'function');
  assert.equal(typeof inProcessHost.secretDelete, 'function');
  assert.deepEqual(await inProcessHost.capabilities(), { authenticatedCaller: true });
  assert.equal((await inProcessHost.secretGet(reference)).value, 'secret');
  await inProcessHost.secretSet({ reference, value: 'secret', expectedRevision: null });
  await inProcessHost.secretDelete({ reference, expectedRevision: 1 });
  assert.deepEqual(calls.slice(0, 2), [
    ['createTransport', 'macos-arm64'],
    ['createClient', transport],
  ]);
  assert.deepEqual(calls.slice(2), [
    ['capabilities'],
    ['secretGet', reference],
    ['secretSet', { reference, value: 'secret', expectedRevision: null }],
    ['secretDelete', { reference, expectedRevision: 1 }],
  ]);
});

test('host controller loads the bundled helper client and transport modules by exact extension paths', async () => {
  const loaded = [];
  const transport = { request() {}, close() {} };
  const helperClient = {
    async capabilities() { return { authenticatedCaller: true }; },
    async secretGet() {}, async secretSet() {}, async secretDelete() {}, async close() {},
  };
  const host = {
    setRuntimeDependencies() {}, setCSInterface() {},
    start(_port, callback) { callback(null); }, stop() {},
  };
  const runtime = fakeHostDependencyRuntime({
    platformId: 'macos-arm64', extensionRoot: '/Applications/AE MCP',
    express: function bundledExpress() {},
  });
  const controller = createHostController({
    cs: { getSystemPath: () => '/Applications/AE MCP' },
    extensionRoot: '/Applications/AE MCP',
    platform: macHostAdapter(runtime.fs, '/Applications/AE MCP/runtime'),
    requireImpl(request) {
      if (request === 'module') return runtime.moduleApi;
      if (request === 'path') return path;
      loaded.push(request);
      if (request.endsWith('/platform-helper-transport.js')) {
        return { createPlatformHelperTransport: () => transport };
      }
      if (request.endsWith('/platform-helper-client.js')) {
        return { createPlatformHelperClient: ({ transport: actual }) => {
          assert.equal(actual, transport);
          return helperClient;
        } };
      }
      return host;
    },
    onStatus: () => {}, onLog: () => {}, addBeforeUnload: () => {},
  });

  controller.start(11488);
  assert.deepEqual(loaded, [
    '/Applications/AE MCP/host/server.js',
    '/Applications/AE MCP/host/platform-helper-transport.js',
    '/Applications/AE MCP/host/platform-helper-client.js',
  ]);
  assert.deepEqual(await controller.getHost().capabilities(), { authenticatedCaller: true });
});

test('host controller helper facade preserves sanitized synchronous repair failures', async () => {
  const host = {
    setRuntimeDependencies() {}, setCSInterface() {},
    start(_port, callback) { callback(null); }, stop() {},
  };
  const runtime = fakeHostDependencyRuntime({
    platformId: 'macos-arm64', extensionRoot: '/Applications/AE MCP',
    express: function bundledExpress() {},
  });
  const controller = createHostController({
    cs: { getSystemPath: () => '/Applications/AE MCP' },
    extensionRoot: '/Applications/AE MCP',
    platform: macHostAdapter(runtime.fs, '/Applications/AE MCP/runtime'),
    requireImpl: (request) => request === 'module' ? runtime.moduleApi : (request === 'path' ? path : host),
    createPlatformHelperTransportImpl() {
      const error = new Error('sensitive addon path');
      error.code = 'PLATFORM_HELPER_REPAIR_REQUIRED';
      throw error;
    },
    createPlatformHelperClientImpl() { throw new Error('must not create a client'); },
    onStatus: () => {}, onLog: () => {}, addBeforeUnload: () => {},
  });
  controller.start(11488);

  await assert.rejects(
    controller.getHost().capabilities(),
    (error) => {
      assert.equal(error.code, 'PLATFORM_HELPER_REPAIR_REQUIRED');
      assert.equal(error.message.includes('/Applications'), false);
      assert.equal(error.message.includes('addon path'), false);
      return true;
    },
  );
});

test('host controller closes a created transport when the helper client is invalid', async () => {
  let transportCloses = 0;
  const transport = {
    request() {},
    close() { transportCloses += 1; },
  };
  const host = {
    setRuntimeDependencies() {}, setCSInterface() {},
    start(_port, callback) { callback(null); }, stop() {},
  };
  const runtime = fakeHostDependencyRuntime({
    platformId: 'macos-arm64', extensionRoot: '/Applications/AE MCP',
    express: function bundledExpress() {},
  });
  const controller = createHostController({
    cs: { getSystemPath: () => '/Applications/AE MCP' },
    extensionRoot: '/Applications/AE MCP',
    platform: macHostAdapter(runtime.fs, '/Applications/AE MCP/runtime'),
    requireImpl: (request) => request === 'module' ? runtime.moduleApi : (request === 'path' ? path : host),
    createPlatformHelperTransportImpl: () => transport,
    createPlatformHelperClientImpl: () => ({ capabilities() {} }),
    onStatus: () => {}, onLog: () => {}, addBeforeUnload: () => {},
  });

  controller.start(11488);
  await Promise.resolve();
  await assert.rejects(controller.getHost().capabilities(), { code: 'HELPER_UNAVAILABLE' });
  assert.equal(transportCloses, 1);
});

test('host controller start reentry disposes the prior lifecycle and queued calls keep their client snapshot', async () => {
  const reference = 'aemcp-secret://provider/5eb75f05-5d9e-5d9c-85af-f0893e8b90c2/auth-model/v1';
  const lifecycle = [];
  const beforeUnloadHandlers = [];
  let generation = 0;
  const host = {
    setRuntimeDependencies() {}, setCSInterface() {},
    start(port, callback) { lifecycle.push(['host-start', port]); callback(null); },
    stop() { lifecycle.push(['host-stop']); },
  };
  const clients = [1, 2].map((id) => ({
    async capabilities() { return { id }; },
    async secretGet(value) { lifecycle.push(['secretGet', id, value]); return { reference: value, value: `secret-${id}`, revision: 1 }; },
    async secretSet() {},
    async secretDelete() {},
    async close() { lifecycle.push(['client-close', id]); },
  }));
  const runtime = fakeHostDependencyRuntime({
    platformId: 'macos-arm64', extensionRoot: '/Applications/AE MCP',
    express: function bundledExpress() {},
  });
  const controller = createHostController({
    cs: { getSystemPath: () => '/Applications/AE MCP' },
    extensionRoot: '/Applications/AE MCP',
    platform: macHostAdapter(runtime.fs, '/Applications/AE MCP/runtime'),
    requireImpl: (request) => request === 'module' ? runtime.moduleApi : (request === 'path' ? path : host),
    createPlatformHelperTransportImpl: () => ({ request() {}, close() {} }),
    createPlatformHelperClientImpl: () => clients[generation++],
    onStatus: () => {}, onLog: () => {},
    addBeforeUnload: (handler) => { beforeUnloadHandlers.push(handler); },
  });

  controller.start(11488);
  const queued = controller.getHost().secretGet(reference);
  controller.start(11489);
  const result = await queued;
  await Promise.resolve();

  assert.equal(result.value, 'secret-1');
  assert.equal(lifecycle.filter(([name]) => name === 'host-stop').length, 1);
  assert.deepEqual(lifecycle.filter(([name]) => name === 'client-close'), [['client-close', 1]]);
  assert.ok(
    lifecycle.findIndex(([name, value]) => name === 'client-close' && value === 1)
      < lifecycle.findIndex(([name, value]) => name === 'host-start' && value === 11489),
    'the prior client close must start before the replacement host starts',
  );
  assert.equal(beforeUnloadHandlers.length, 1);
});

test('beforeunload releases the host without queuing native Helper close work', async () => {
  const lifecycle = [];
  const beforeUnloadHandlers = [];
  const host = {
    setRuntimeDependencies() {}, setCSInterface() {},
    start(_port, callback) { callback(null); },
    stop() { lifecycle.push('host-stop'); },
  };
  const client = {
    async capabilities() {}, async secretGet() {}, async secretSet() {}, async secretDelete() {},
    async close() { lifecycle.push('client-close'); },
  };
  const runtime = fakeHostDependencyRuntime({
    platformId: 'macos-arm64', extensionRoot: '/Applications/AE MCP',
    express: function bundledExpress() {},
  });
  const controller = createHostController({
    cs: { getSystemPath: () => '/Applications/AE MCP' },
    extensionRoot: '/Applications/AE MCP',
    platform: macHostAdapter(runtime.fs, '/Applications/AE MCP/runtime'),
    requireImpl: (request) => request === 'module' ? runtime.moduleApi : (request === 'path' ? path : host),
    createPlatformHelperTransportImpl: () => ({ request() {}, close() {} }),
    createPlatformHelperClientImpl: () => client,
    onStatus: () => {}, onLog: () => {},
    addBeforeUnload: (handler) => { beforeUnloadHandlers.push(handler); },
  });

  controller.start(11488);
  beforeUnloadHandlers[0]();
  await Promise.resolve();

  assert.deepEqual(lifecycle, ['host-stop']);
  assert.equal(controller.getHost(), null);
});

test('host controller ignores callbacks from a superseded start lifecycle', () => {
  const callbacks = [];
  const statuses = [];
  const host = {
    setRuntimeDependencies() {}, setCSInterface() {},
    start(port, callback) { callbacks.push({ port, callback }); },
    stop() {},
  };
  const client = () => ({
    async capabilities() {}, async secretGet() {}, async secretSet() {}, async secretDelete() {}, async close() {},
  });
  const runtime = fakeHostDependencyRuntime({
    platformId: 'macos-arm64', extensionRoot: '/Applications/AE MCP',
    express: function bundledExpress() {},
  });
  const controller = createHostController({
    cs: { getSystemPath: () => '/Applications/AE MCP' },
    extensionRoot: '/Applications/AE MCP',
    platform: macHostAdapter(runtime.fs, '/Applications/AE MCP/runtime'),
    requireImpl: (request) => request === 'module' ? runtime.moduleApi : (request === 'path' ? path : host),
    createPlatformHelperTransportImpl: () => ({ request() {}, close() {} }),
    createPlatformHelperClientImpl: client,
    onStatus: (...args) => { statuses.push(args); }, onLog: () => {}, addBeforeUnload: () => {},
  });

  controller.start(11488);
  controller.start(11489);
  callbacks[0].callback(new Error('stale start failure'));
  callbacks[1].callback(null);

  assert.deepEqual(statuses, [
    ['starting', 11488],
    ['starting', 11489],
    ['ok', 11489],
  ]);
});

test('a stale host facade cannot dispatch through the replacement helper client', async () => {
  const reference = 'aemcp-secret://provider/5eb75f05-5d9e-5d9c-85af-f0893e8b90c2/auth-model/v1';
  let hostIndex = 0;
  let clientIndex = 0;
  let replacementReads = 0;
  const hosts = [1, 2].map(() => ({
    setRuntimeDependencies() {}, setCSInterface() {},
    start(_port, callback) { callback(null); }, stop() {},
  }));
  const clients = [1, 2].map((id) => {
    let closed = false;
    return {
      async capabilities() {},
      async secretGet(value) {
        if (id === 2) replacementReads += 1;
        if (closed) {
          const error = new Error('closed client');
          error.code = 'HELPER_UNAVAILABLE';
          throw error;
        }
        return { reference: value, value: `secret-${id}`, revision: 1 };
      },
      async secretSet() {}, async secretDelete() {},
      async close() { closed = true; },
    };
  });
  const runtime = fakeHostDependencyRuntime({
    platformId: 'macos-arm64', extensionRoot: '/Applications/AE MCP',
    express: function bundledExpress() {},
  });
  const controller = createHostController({
    cs: { getSystemPath: () => '/Applications/AE MCP' },
    extensionRoot: '/Applications/AE MCP',
    platform: macHostAdapter(runtime.fs, '/Applications/AE MCP/runtime'),
    requireImpl(request) {
      if (request === 'module') return runtime.moduleApi;
      if (request === 'path') return path;
      return hosts[hostIndex++];
    },
    createPlatformHelperTransportImpl: () => ({ request() {}, close() {} }),
    createPlatformHelperClientImpl: () => clients[clientIndex++],
    onStatus: () => {}, onLog: () => {}, addBeforeUnload: () => {},
  });

  controller.start(11488);
  const staleHost = controller.getHost();
  controller.start(11489);

  await assert.rejects(staleHost.secretGet(reference), { code: 'HELPER_UNAVAILABLE' });
  assert.equal(replacementReads, 0);
  assert.equal((await controller.getHost().secretGet(reference)).value, 'secret-2');
});
