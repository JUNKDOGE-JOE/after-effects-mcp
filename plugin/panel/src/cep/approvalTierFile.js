export const TOOL_TIER_ENV = 'AE_MCP_TOOL_APPROVAL_TIER_FILE';

const VALID_TIERS = new Set(['readonly', 'manual', 'auto', 'none']);

function cepRequire() {
  if (globalThis.window?.cep_node?.require) return globalThis.window.cep_node.require;
  if (globalThis.window?.require) return globalThis.window.require;
  if (globalThis.require) return globalThis.require;
  return null;
}

function defaultDeps() {
  const require = cepRequire();
  if (!require) throw new Error('CEP Node require is unavailable');
  const processImpl = globalThis.window?.cep_node?.process || globalThis.process;
  return {
    fs: require('fs'),
    os: require('os'),
    path: require('path'),
    pid: processImpl?.pid || 0,
    platform: processImpl?.platform || '',
    now: () => Date.now(),
  };
}

function protect(fs, path, mode, platform) {
  try {
    fs.chmodSync(path, mode);
  } catch (error) {
    if (platform !== 'win32') throw error;
  }
}

export function createApprovalTierFile(deps = defaultDeps()) {
  const { fs, os, path } = deps;
  const pid = Number.isSafeInteger(deps.pid) && deps.pid >= 0 ? deps.pid : 0;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const directory = path.join(os.homedir(), '.ae-mcp', 'runtime', 'approval');
  const file = path.join(directory, `panel-${pid}.tier`);
  let temporaryCounter = 0;

  function ensureDirectory() {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    protect(fs, directory, 0o700, deps.platform);
  }

  function temporaryPath() {
    temporaryCounter += 1;
    const suffix = typeof deps.nonce === 'function' ? deps.nonce() : temporaryCounter;
    return path.join(directory, `.panel-${pid}.${now()}.${suffix}.tmp`);
  }

  function write(tier) {
    if (!VALID_TIERS.has(tier)) throw new TypeError('Unsupported tool approval tier');
    ensureDirectory();
    const temporary = temporaryPath();
    let descriptor = null;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, tier + '\n', 'utf8');
      if (typeof fs.fsyncSync !== 'function') throw new Error('Filesystem fsync is unavailable');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      protect(fs, temporary, 0o600, deps.platform);
      fs.renameSync(temporary, file);
      return tier;
    } catch (error) {
      if (descriptor !== null) {
        try { fs.closeSync(descriptor); } catch {}
      }
      try { fs.unlinkSync(temporary); } catch {}
      throw error;
    }
  }

  function dispose() {
    try {
      fs.unlinkSync(file);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }

  return {
    path: () => file,
    env: () => ({ [TOOL_TIER_ENV]: file }),
    write,
    dispose,
  };
}

export function withToolApprovalTier(commandSpec, tierFile) {
  return Object.assign({}, commandSpec, {
    env: Object.assign({}, commandSpec.env || {}, {
      [TOOL_TIER_ENV]: tierFile.path(),
    }),
  });
}
