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
    pid: req('process') && req('process').pid,
  };
}

export function createApiKeyStore(deps = defaultDeps()) {
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

  function writeKey(key, name = 'anthropic') {
    const value = String(key || '').trim();
    const dir = keyDir();
    const fileName = keyFile(name);
    const file = keyPath(name);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const pid = deps.pid || 0;
    const tmp = path.join(dir, `${fileName}.${pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, value, 'utf8');
    try {
      fs.chmodSync(tmp, 0o600);
    } catch (e) {
      // Best effort only. Windows and some filesystems ignore or reject chmod.
    }
    fs.renameSync(tmp, file);
    return value;
  }

  function clearKey(name = 'anthropic') {
    try {
      fs.unlinkSync(keyPath(name));
    } catch (e) {
      if (!e || e.code !== 'ENOENT') throw e;
    }
  }

  return { keyDir, keyPath, readKey, writeKey, clearKey };
}

export function readKey(deps) {
  return createApiKeyStore(deps).readKey();
}

export function writeKey(key, deps) {
  return createApiKeyStore(deps).writeKey(key);
}

export function clearKey(deps) {
  return createApiKeyStore(deps).clearKey();
}
