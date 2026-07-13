export const TOOL_TIER_ENV = 'AE_MCP_TOOL_APPROVAL_TIER_FILE';

const VALID_TIERS = new Set(['readonly', 'manual', 'auto', 'none']);

function protect(fs, path, mode, platformId) {
  try {
    fs.chmodSync(path, mode);
  } catch (error) {
    if (platformId !== 'windows-x64') throw error;
  }
}

export function createApprovalTierFile(deps) {
  if (!deps?.fs || !deps?.paths || typeof deps.paths.join !== 'function') {
    throw new TypeError('platform file dependencies are required');
  }
  const { fs, paths } = deps;
  const pid = Number.isSafeInteger(deps.pid) && deps.pid >= 0 ? deps.pid : 0;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const directory = paths.join([paths.runtimeRoot, 'approval']);
  const file = paths.join([directory, `panel-${pid}.tier`]);
  let temporaryCounter = 0;

  function ensureDirectory() {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    protect(fs, directory, 0o700, deps.platformId);
  }

  function temporaryPath() {
    temporaryCounter += 1;
    const suffix = typeof deps.nonce === 'function' ? deps.nonce() : temporaryCounter;
    return paths.join([directory, `.panel-${pid}.${now()}.${suffix}.tmp`]);
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
      protect(fs, temporary, 0o600, deps.platformId);
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
