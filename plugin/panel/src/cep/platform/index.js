import { createMacosAdapter } from './macos.js';
import { createWindowsAdapter } from './windows.js';
import { normalizeCepSystemPath } from './paths.js';

export class PlatformCapabilityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PlatformCapabilityError';
    this.code = code;
  }
}

function cepRequire() {
  if (globalThis.window?.cep_node?.require) return globalThis.window.cep_node.require;
  if (globalThis.window?.require) return globalThis.window.require;
  if (globalThis.require) return globalThis.require;
  throw new PlatformCapabilityError('CEP_NODE_UNAVAILABLE', 'CEP Node require is unavailable');
}

function windowsEnvValue(environment, name) {
  const key = Object.keys(environment || {}).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : environment[key];
}

function extensionRootFromPage() {
  try {
    const root = globalThis.window?.__adobe_cep__?.getSystemPath?.('extension');
    if (typeof root === 'string' && root.trim()) return normalizeCepSystemPath(root);
  } catch {
    // CEP hosts may expose the page before their system-path bridge is ready.
  }
  try {
    const location = globalThis.location;
    if (typeof location?.href !== 'string' || !location.href.startsWith('file:')) return null;
    let pagePath = decodeURIComponent(new URL(location.href).pathname);
    pagePath = pagePath.replace(/^\/([A-Za-z]:\/)/, '$1');
    const clientDirectory = pagePath.slice(0, pagePath.lastIndexOf('/'));
    const root = clientDirectory.slice(0, clientDirectory.lastIndexOf('/'));
    return root || null;
  } catch {
    return null;
  }
}

export function defaultPlatformDependencies() {
  const require = cepRequire();
  const processImpl = globalThis.window?.cep_node?.process || globalThis.process;
  if (!processImpl) throw new PlatformCapabilityError('CEP_NODE_UNAVAILABLE', 'CEP Node process is unavailable');
  const os = require('os');
  const env = { ...(processImpl.env || {}) };
  const platform = processImpl.platform;
  const home = platform === 'win32' ? (windowsEnvValue(env, 'USERPROFILE') || os.homedir()) : (env.HOME || os.homedir());
  return {
    platform,
    arch: processImpl.arch,
    pid: processImpl.pid,
    home,
    temp: os.tmpdir(),
    extensionRoot: extensionRootFromPage(),
    env,
    fs: require('fs'),
    httpImpl: require('http'),
    httpsImpl: require('https'),
    spawnImpl: require('child_process').spawn,
    now: () => Date.now(),
  };
}

export function createPlatformAdapter(deps = defaultPlatformDependencies()) {
  if (deps.platform === 'darwin' && deps.arch === 'arm64') return createMacosAdapter(deps);
  if (deps.platform === 'win32' && deps.arch === 'x64') return createWindowsAdapter(deps);
  throw new PlatformCapabilityError('UNSUPPORTED_PLATFORM', deps.platform + '-' + deps.arch + ' is not supported');
}

export { createMacosAdapter, createWindowsAdapter };
