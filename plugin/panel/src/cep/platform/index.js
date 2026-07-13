import { createMacosAdapter } from './macos.js';
import { createWindowsAdapter } from './windows.js';

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
    home,
    temp: os.tmpdir(),
    env,
    fs: require('fs'),
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
