// CEP-only module: spawns the in-process Express host (plugin/host/server.js)
// the way the legacy client.js did. Pure helpers are exported for tests.
import { expertGuidanceEnv } from './externalClients.js';
import { createPlatformAdapter } from './platform/index.js';
import { normalizeCepSystemPath } from './platform/paths.js';

export function normalizeCepPath(value, platform) {
  return normalizeCepSystemPath(value, platform);
}

export function isValidPort(p) { return isFinite(p) && p >= 1024 && p <= 65535; }

export const DEFAULT_PORT = 11488;
const PORT_STORAGE_KEY = 'ae_mcp_panel_port';

export function loadSavedPort(storage) {
  try {
    const p = parseInt(storage.getItem(PORT_STORAGE_KEY), 10);
    if (isValidPort(p)) return p;
  } catch (e) {
    // storage unavailable
  }
  return null;
}

export function savePort(storage, port) {
  try {
    storage.setItem(PORT_STORAGE_KEY, String(port));
  } catch (e) {
    // best-effort persistence
  }
}

export function buildMcpConfig(port, expertGuidance = true) {
  return {
    mcpServers: {
      ae: {
        command: 'ae-mcp',
        env: Object.assign(
          { AE_MCP_BACKEND: 'ae-mcp' },
          expertGuidanceEnv(expertGuidance !== false),
          { AE_MCP_PLUGIN_URL: 'http://127.0.0.1:' + port },
        ),
      },
    },
  };
}

function getCepRequire() {
  if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) {
    return globalThis.window.cep_node.require;
  }
  if (globalThis.window && globalThis.window.require) return globalThis.window.require;
  if (globalThis.require) return globalThis.require;
  throw new Error('CEP Node require is unavailable');
}

export function loadBundledHostDependencies({ cepRequire, adapter, extensionRoot }) {
  if (typeof cepRequire !== 'function') throw new TypeError('CEP Node require is unavailable');
  if (!adapter || !['macos-arm64', 'windows-x64'].includes(adapter.id)) {
    throw new TypeError('A supported platform adapter is required');
  }
  if (!adapter.paths || typeof adapter.paths.join !== 'function') {
    throw new TypeError('A native platform path catalog is required');
  }
  const nativePath = adapter.paths;
  if (typeof nativePath.resolve !== 'function' || typeof nativePath.dirname !== 'function'
      || typeof nativePath.isAbsolute !== 'function' || typeof nativePath.contains !== 'function'
      || typeof nativePath.same !== 'function') {
    throw new TypeError('A complete native platform path catalog is required');
  }
  const moduleApi = cepRequire('module');
  if (!moduleApi || typeof moduleApi.createRequire !== 'function') {
    throw new Error('CEP Node module.createRequire is unavailable');
  }
  const fs = adapter.fs || cepRequire('fs');
  if (!fs || typeof fs.existsSync !== 'function' || typeof fs.lstatSync !== 'function'
      || typeof fs.realpathSync !== 'function' || typeof fs.statSync !== 'function'
      || typeof fs.readFileSync !== 'function') {
    throw new Error('CEP Node filesystem is unavailable');
  }
  const unavailable = (cause) => {
    if (cause?.code === 'HOST_RUNTIME_DEPENDENCIES_UNAVAILABLE') return cause;
    const error = new Error('host runtime dependencies are unavailable');
    error.code = 'HOST_RUNTIME_DEPENDENCIES_UNAVAILABLE';
    error.cause = cause;
    return error;
  };
  const pathInside = (root, candidate) => {
    return nativePath.contains(root, candidate);
  };
  const ordinaryAnchor = (candidate) => {
    let info;
    try {
      info = fs.lstatSync(candidate);
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink?.()) {
      throw new Error('selected host package anchor is not an ordinary file');
    }
    return true;
  };
  const samePath = (left, right) => nativePath.same(left, right);

  try {
    // This path is inside the immutable extension payload.  It intentionally
    // does not consult ~/.ae-mcp/runtime/current; that pointer remains owned by
    // the helper-gated RuntimeManager.
    const runtimePackageAnchor = adapter.paths.join([
      extensionRoot, 'runtime', adapter.id, 'node', 'host', 'package.json',
    ]);
    const developmentMarker = adapter.paths.join([extensionRoot, '.debug']);
    const developmentPackageAnchor = adapter.paths.join([extensionRoot, 'host', 'package.json']);
    let packageAnchor = '';
    if (ordinaryAnchor(runtimePackageAnchor)) {
      packageAnchor = runtimePackageAnchor;
    } else if (fs.existsSync(developmentMarker) && ordinaryAnchor(developmentPackageAnchor)) {
      packageAnchor = developmentPackageAnchor;
    }
    if (!packageAnchor) throw new Error('no selected host package anchor');

    const hostRoot = nativePath.dirname(packageAnchor);
    const lexicalExtensionRoot = nativePath.resolve([extensionRoot]);
    const realExtensionRoot = nativePath.resolve([fs.realpathSync(extensionRoot)]);
    const lexicalHostRoot = nativePath.resolve([hostRoot]);
    const realHostRoot = nativePath.resolve([fs.realpathSync(hostRoot)]);
    const realAnchor = fs.realpathSync(packageAnchor);
    if (!pathInside(lexicalExtensionRoot, lexicalHostRoot)
        || !pathInside(realExtensionRoot, realHostRoot)
        || !pathInside(realHostRoot, realAnchor)) {
      throw new Error('selected host root escaped the extension');
    }

    const lexicalExpressRoot = nativePath.resolve([hostRoot, 'node_modules', 'express']);
    const realExpressRoot = nativePath.resolve([fs.realpathSync(lexicalExpressRoot)]);
    if (!pathInside(lexicalHostRoot, lexicalExpressRoot)
        || !pathInside(realHostRoot, realExpressRoot)) {
      throw new Error('Express package root escaped the selected host root');
    }
    const expressPackage = nativePath.resolve([lexicalExpressRoot, 'package.json']);
    if (!ordinaryAnchor(expressPackage)) throw new Error('Express package manifest is missing');
    const realExpressPackage = nativePath.resolve([fs.realpathSync(expressPackage)]);
    if (!pathInside(lexicalExpressRoot, expressPackage)
        || !pathInside(realExpressRoot, realExpressPackage)) {
      throw new Error('Express package manifest escaped its exact package root');
    }
    const expressMetadata = JSON.parse(String(fs.readFileSync(expressPackage, 'utf8')));
    const mainEntry = expressMetadata.main === undefined ? 'index.js' : expressMetadata.main;
    if (typeof mainEntry !== 'string' || !mainEntry.trim() || mainEntry.includes('\0')) {
      throw new Error('Express package main is invalid');
    }
    const lexicalExpressEntry = nativePath.resolve([lexicalExpressRoot, mainEntry]);
    if (!pathInside(lexicalExpressRoot, lexicalExpressEntry) || !ordinaryAnchor(lexicalExpressEntry)) {
      throw new Error('Express entry escaped its exact package root');
    }
    const realExpressEntry = nativePath.resolve([fs.realpathSync(lexicalExpressEntry)]);
    if (!pathInside(realExpressRoot, realExpressEntry)) {
      throw new Error('Express entry real path escaped its exact package root');
    }

    const builtins = new Set((moduleApi.builtinModules || []).map((name) => String(name).replace(/^node:/, '')));
    const isBuiltin = (request) => {
      const name = String(request || '').replace(/^node:/, '');
      return typeof moduleApi.isBuiltin === 'function' ? moduleApi.isBuiltin(request) : builtins.has(name);
    };
    const validateResolvedFile = (resolved) => {
      if (isBuiltin(resolved)) return resolved;
      if (typeof resolved !== 'string' || !nativePath.isAbsolute(resolved)) {
        throw new Error('non-builtin dependency did not resolve to an absolute file');
      }
      const lexicalResolved = nativePath.resolve([resolved]);
      if (!pathInside(lexicalHostRoot, lexicalResolved) && !pathInside(realHostRoot, lexicalResolved)) {
        throw new Error('dependency resolution escaped the selected host root');
      }
      const realResolved = nativePath.resolve([fs.realpathSync(lexicalResolved)]);
      if (!pathInside(realHostRoot, realResolved)) {
        throw new Error('dependency real path escaped the selected host root');
      }
      if (!fs.statSync(realResolved).isFile()) throw new Error('dependency is not a regular file');
      return resolved;
    };

    const originalResolveFilename = moduleApi._resolveFilename;
    if (typeof originalResolveFilename !== 'function') {
      throw new Error('CEP Node module resolver hook is unavailable');
    }
    moduleApi._resolveFilename = function fencedResolveFilename(request) {
      const resolved = originalResolveFilename.apply(this, arguments);
      if (!isBuiltin(request) && !isBuiltin(resolved)) validateResolvedFile(resolved);
      return resolved;
    };
    try {
      const anchoredRequire = moduleApi.createRequire(packageAnchor);
      if (typeof anchoredRequire.resolve !== 'function') throw new Error('anchored require.resolve is unavailable');
      const resolvedExpressEntry = validateResolvedFile(anchoredRequire.resolve('express'));
      const resolvedExpressPackage = validateResolvedFile(anchoredRequire.resolve('express/package.json'));
      if (!samePath(fs.realpathSync(resolvedExpressEntry), realExpressEntry)
          || !samePath(fs.realpathSync(resolvedExpressPackage), realExpressPackage)) {
        throw new Error('Express package did not resolve from selected host node_modules');
      }
      const express = anchoredRequire(lexicalExpressEntry);
      if (typeof express !== 'function') throw new TypeError('Bundled Express export is invalid');
      return Object.freeze({ express });
    } finally {
      moduleApi._resolveFilename = originalResolveFilename;
    }
  } catch (cause) {
    throw unavailable(cause);
  }
}

// ---- CEP side-effects (exercised in AE manual checklist) ----
function helperUnavailableError() {
  const error = new Error('Platform helper is unavailable');
  error.code = 'HELPER_UNAVAILABLE';
  error.retryable = true;
  return error;
}

function sanitizeHelperError(error) {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.code)
    ? error.code
    : 'HELPER_UNAVAILABLE';
  const sanitized = new Error(code === 'HELPER_UNAVAILABLE'
    ? 'Platform helper is unavailable'
    : `Platform helper request failed with ${code}`);
  sanitized.code = code;
  sanitized.retryable = error?.retryable === true || code === 'HELPER_UNAVAILABLE';
  return sanitized;
}

function helperRuntime(platformId) {
  return platformId === 'macos-arm64'
    ? { platform: 'darwin', arch: 'arm64' }
    : { platform: 'win32', arch: 'x64' };
}

export function createHostController({
  cs,
  onStatus,
  onLog,
  platform,
  requireImpl,
  addBeforeUnload,
  extensionRoot,
  createPlatformHelperTransportImpl,
  createPlatformHelperClientImpl,
}) {
  const adapter = platform || createPlatformAdapter();
  let host = null;
  let helperClient = null;
  let platformRoots = null;
  let beforeUnloadInstalled = false;
  let lifecycleGeneration = 0;

  function closeHelperClient(client, fallbackTransport = null) {
    const closable = client && typeof client.close === 'function' ? client : fallbackTransport;
    if (!closable || typeof closable.close !== 'function') return;
    try { Promise.resolve(closable.close()).catch(() => {}); } catch { /* best effort */ }
  }

  function disposeLifecycle(client, hostInstance, { closeClient = true } = {}) {
    if (closeClient) closeHelperClient(client);
    try { if (hostInstance && typeof hostInstance.stop === 'function') hostInstance.stop(); } catch { /* best effort */ }
  }

  function bindPlatformHelperFacade({ cepRequire, extRoot, hostInstance }) {
    let transport = null;
    let nextClient = null;
    let bindingError = null;
    try {
      const transportFactory = createPlatformHelperTransportImpl || (() => {
        const modulePath = adapter.paths.join([extRoot, 'host', 'platform-helper-transport.js']);
        const loaded = cepRequire(modulePath);
        if (typeof loaded?.createPlatformHelperTransport !== 'function') throw helperUnavailableError();
        return loaded.createPlatformHelperTransport;
      })();
      const clientFactory = createPlatformHelperClientImpl || (() => {
        const modulePath = adapter.paths.join([extRoot, 'host', 'platform-helper-client.js']);
        const loaded = cepRequire(modulePath);
        if (typeof loaded?.createPlatformHelperClient !== 'function') throw helperUnavailableError();
        return loaded.createPlatformHelperClient;
      })();
      transport = transportFactory({
        platformId: adapter.id,
        runtime: helperRuntime(adapter.id),
      });
      if (!transport || typeof transport.request !== 'function' || typeof transport.close !== 'function') {
        throw helperUnavailableError();
      }
      nextClient = clientFactory({ transport });
      for (const method of ['capabilities', 'secretGet', 'secretSet', 'secretDelete', 'close']) {
        if (typeof nextClient?.[method] !== 'function') throw helperUnavailableError();
      }
    } catch (error) {
      bindingError = sanitizeHelperError(error);
      closeHelperClient(nextClient, transport);
      nextClient = null;
    }
    helperClient = nextClient;
    const facadeClient = nextClient;

    const invoke = (method, value, hasValue) => {
      const client = facadeClient;
      if (!client) return Promise.reject(bindingError || helperUnavailableError());
      let request;
      try {
        request = hasValue ? client[method](value) : client[method]();
      } catch (error) {
        return Promise.reject(sanitizeHelperError(error));
      }
      return Promise.resolve(request)
        .catch((error) => { throw sanitizeHelperError(error); });
    };
    hostInstance.capabilities = () => invoke('capabilities', undefined, false);
    hostInstance.secretGet = (reference) => invoke('secretGet', reference, true);
    hostInstance.secretSet = (value) => invoke('secretSet', value, true);
    hostInstance.secretDelete = (value) => invoke('secretDelete', value, true);
  }

  function start(port) {
    const generation = lifecycleGeneration += 1;
    onStatus('starting', port);
    const priorHost = host;
    const priorClient = helperClient;
    host = null;
    helperClient = null;
    platformRoots = null;
    if (priorHost || priorClient) disposeLifecycle(priorClient, priorHost);
    try {
      const cepRequire = requireImpl || getCepRequire();
      const extRoot = normalizeCepPath(extensionRoot || cs.getSystemPath('extension'), adapter);
      const hostPath = adapter.paths.join([extRoot, 'host', 'server.js']);
      const roots = { extensionRoot: extRoot, runtimeRoot: adapter.paths.runtimeRoot };
      platformRoots = roots;
      onLog('host: ' + hostPath);
      const runtimeDependencies = loadBundledHostDependencies({
        cepRequire,
        adapter,
        extensionRoot: extRoot,
      });
      const nextHost = cepRequire(hostPath);
      if (!nextHost || typeof nextHost.setRuntimeDependencies !== 'function') {
        throw new Error('Host runtime dependency binding is unavailable');
      }
      nextHost.setRuntimeDependencies(runtimeDependencies);
      if (nextHost.setNativeAegpRuntime) {
        nextHost.setNativeAegpRuntime(helperRuntime(adapter.id));
      }
      nextHost.setCSInterface(cs);
      if (nextHost.setPlatformRoots) nextHost.setPlatformRoots(roots);
      host = nextHost;
      bindPlatformHelperFacade({ cepRequire, extRoot, hostInstance: nextHost });
      // Release the port when this JS context goes away (panel close or a
      // devtools reload) — otherwise the orphaned listener keeps the port and
      // the next context fails with EADDRINUSE while requests hang on the
      // dead context's evalScript pipe.
      if (!beforeUnloadInstalled) {
        const installBeforeUnload = addBeforeUnload || ((handler) => window.addEventListener('beforeunload', handler));
        installBeforeUnload(() => {
          lifecycleGeneration += 1;
          const closingClient = helperClient;
          const closingHost = host;
          helperClient = null;
          host = null;
          platformRoots = null;
          disposeLifecycle(closingClient, closingHost, { closeClient: false });
        });
        beforeUnloadInstalled = true;
      }
      nextHost.start(port, (err) => {
        if (generation !== lifecycleGeneration || host !== nextHost) return;
        if (err) onStatus('error', port, err.message);
        else onStatus('ok', port);
      }, roots);
    } catch (e) {
      const failedHost = host;
      const failedClient = helperClient;
      host = null;
      helperClient = null;
      platformRoots = null;
      disposeLifecycle(failedClient, failedHost);
      if (generation === lifecycleGeneration) onStatus('error', port, e.message);
    }
  }
  function restart(port) {
    if (host && host.restart) {
      const generation = lifecycleGeneration;
      const restartingHost = host;
      onStatus('starting', port);
      restartingHost.restart(port, (err) => {
        if (generation !== lifecycleGeneration || host !== restartingHost) return;
        if (err) onStatus('error', port, err.message);
        else onStatus('ok', port);
      }, platformRoots);
    }
  }
  return { start, restart, getHost: () => host };
}
