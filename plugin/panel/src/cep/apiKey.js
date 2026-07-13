// Migration-only access to API key files created by older panel versions.
// Runtime callers must move values into the platform Helper before use.
const KEY_FILES = {
  anthropic: 'anthropic-key',
  codex: 'codex-key',
  zcode: 'zcode-key',
};

function cepRequire() {
  if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) return globalThis.window.cep_node.require;
  if (globalThis.window && globalThis.window.require) return globalThis.window.require;
  if (globalThis.require) return globalThis.require;
  return null;
}

function defaultDeps() {
  const req = cepRequire();
  if (!req) throw new Error('CEP Node require is unavailable');
  return {
    fs: req('fs'),
    os: req('os'),
    path: req('path'),
  };
}

export function createLegacyApiKeyStore(deps = defaultDeps()) {
  const fs = deps.fs;
  const os = deps.os;
  const path = deps.path;

  function keyDir() {
    return path.join(os.homedir(), '.ae-mcp');
  }

  function keyFile(name = 'anthropic') {
    const file = KEY_FILES[String(name || 'anthropic')];
    if (!file) throw new Error('Unsupported API key name: ' + name);
    return file;
  }

  function keyPath(name = 'anthropic') {
    return path.join(keyDir(), keyFile(name));
  }

  function readKey(name = 'anthropic') {
    try {
      return fs.readFileSync(keyPath(name), 'utf8').trim();
    } catch (e) {
      if (e && e.code === 'ENOENT') return '';
      throw e;
    }
  }

  function clearKey(name = 'anthropic') {
    try {
      fs.unlinkSync(keyPath(name));
    } catch (e) {
      if (!e || e.code !== 'ENOENT') throw e;
    }
  }

  return Object.freeze({ keyDir, keyPath, readKey, clearKey });
}
