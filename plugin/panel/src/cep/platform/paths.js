function assertAbsoluteHome(home, separator) {
  const value = String(home || '').trim();
  const absolute = separator === '\\' ? /^(?:[A-Za-z]:\\|\\\\)/.test(value) : value.startsWith('/');
  if (!absolute) throw new Error('A non-empty absolute home path is required');
  return trimTrailing(nativeSeparators(value, separator), separator);
}

function nativeSeparators(value, separator) {
  const text = String(value || '');
  return separator === '\\' ? text.replace(/\//g, '\\') : text;
}

function trimTrailing(value, separator) {
  if (separator === '\\' && /^[A-Za-z]:\\$/.test(value)) return value;
  if (value === '/') return value;
  while (value.endsWith(separator)) value = value.slice(0, -1);
  return value;
}

function splitRoot(value, separator) {
  if (separator === '/') return { root: value.startsWith('/') ? '/' : '', rest: value.replace(/^\/+/, '') };
  const normalized = value.replace(/\//g, '\\');
  const drive = normalized.match(/^([A-Za-z]:)\\/);
  if (drive) return { root: drive[1] + '\\', rest: normalized.slice(drive[0].length) };
  const unc = normalized.match(/^(\\\\[^\\]+\\[^\\]+)\\?/);
  if (unc) return { root: unc[1] + '\\', rest: normalized.slice(unc[0].length) };
  return { root: '', rest: normalized.replace(/^\\+/, '') };
}

function normalizePath(value, separator) {
  const input = nativeSeparators(value, separator);
  const { root, rest } = splitRoot(input, separator);
  const parts = [];
  for (const part of rest.split(separator)) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length && parts[parts.length - 1] !== '..') parts.pop();
      else if (!root) parts.push(part);
      continue;
    }
    parts.push(part);
  }
  const body = parts.join(separator);
  if (!root) return body || '.';
  return body ? root + body : root;
}

export function normalizeCepSystemPath(value, platform) {
  let normalized = String(value || '');
  const fileUrl = normalized.match(/^file:\/\/(.*)$/i);
  const legacyFilePath = !fileUrl && /^file:\\+/i.test(normalized);
  if (fileUrl) {
    const body = fileUrl[1];
    normalized = body.startsWith('/') || /^[A-Za-z]:[\\/]/.test(body)
      ? body
      : '//' + body;
  } else if (legacyFilePath) {
    const body = normalized.slice('file:'.length);
    normalized = /^\\+[A-Za-z]:\\/.test(body)
      ? body.replace(/^\\+/, '')
      : body;
  }
  if (fileUrl || legacyFilePath) {
    try {
      normalized = decodeURIComponent(normalized);
    } catch (cause) {
      const error = new Error('CEP file URL contains invalid percent encoding');
      error.code = 'CEP_PATH_INVALID';
      error.cause = cause;
      throw error;
    }
  }
  if (/^\/[A-Za-z]:/.test(normalized)) normalized = normalized.slice(1);
  if (platform?.paths?.resolve) return platform.paths.resolve([normalized]);
  return normalized;
}

export function readCepSystemPath({ cs, cep, platform, pathType = 'extension' } = {}) {
  const rawCep = cep === undefined ? globalThis.window?.__adobe_cep__ : cep;
  const value = rawCep && typeof rawCep.getSystemPath === 'function'
    ? rawCep.getSystemPath(pathType)
    : (cs && typeof cs.getSystemPath === 'function' ? cs.getSystemPath(pathType) : '');
  if (!value) throw new Error('CEP system path is unavailable: ' + pathType);
  return normalizeCepSystemPath(value, platform);
}

export function createPathCatalog({ home, temp, platform }) {
  const windows = platform === 'win32';
  const separator = windows ? '\\' : '/';
  const normalizedHome = assertAbsoluteHome(home, separator);
  const normalizedTemp = normalizePath(String(temp || ''), separator);

  const join = (parts) => {
    const values = Array.from(parts || []).map((part) => String(part || '')).filter(Boolean);
    if (!values.length) return '.';
    return normalizePath(values.join(separator), separator);
  };
  const resolve = (parts) => {
    const values = Array.from(parts || []).map((part) => String(part || '')).filter(Boolean);
    if (!values.length) return normalizedHome;
    let combined = '';
    for (const value of values) {
      const normalized = nativeSeparators(value, separator);
      const absolute = separator === '\\' ? /^(?:[A-Za-z]:\\|\\\\)/.test(normalized) : normalized.startsWith('/');
      if (absolute) {
        combined = normalized;
        continue;
      }
      if (windows) {
        const driveRelative = normalized.match(/^([A-Za-z]:)(?!\\)(.*)$/);
        if (driveRelative) {
          const drive = driveRelative[1];
          const combinedDrive = String(combined).match(/^([A-Za-z]:)\\/);
          const homeDrive = normalizedHome.match(/^([A-Za-z]:)\\/);
          const base = combinedDrive && combinedDrive[1].toLowerCase() === drive.toLowerCase()
            ? combined
            : (homeDrive && homeDrive[1].toLowerCase() === drive.toLowerCase() ? normalizedHome : drive + '\\');
          const rest = driveRelative[2];
          combined = rest ? trimTrailing(base, separator) + separator + rest : base;
          continue;
        }
        if (/^\\(?!\\)/.test(normalized)) {
          const currentRoot = splitRoot(String(combined || normalizedHome), separator).root;
          const currentDrive = currentRoot.match(/^([A-Za-z]:)\\$/);
          combined = currentDrive
            ? currentDrive[1] + normalized
            : trimTrailing(currentRoot, separator) + normalized;
          continue;
        }
      }
      combined = combined ? combined + separator + normalized : normalized;
    }
    if (!(separator === '\\' ? /^(?:[A-Za-z]:\\|\\\\)/.test(combined) : combined.startsWith('/'))) {
      combined = normalizedHome + separator + combined;
    }
    return normalizePath(combined, separator);
  };
  const dirname = (value) => {
    const normalized = normalizePath(value, separator);
    const { root } = splitRoot(normalized, separator);
    const end = trimTrailing(normalized, separator).lastIndexOf(separator);
    if (end < 0) return '.';
    if (end < root.length) return root || separator;
    return normalized.slice(0, end) || root || separator;
  };
  const basename = (value) => {
    const normalized = trimTrailing(normalizePath(value, separator), separator);
    const end = normalized.lastIndexOf(separator);
    return end < 0 ? normalized : normalized.slice(end + 1);
  };
  const isAbsolute = (value) => separator === '\\'
    ? /^(?:[A-Za-z]:\\|\\\\)/.test(String(value || '').replace(/\//g, '\\'))
    : String(value || '').startsWith('/');
  const canonical = (value) => {
    const resolved = resolve([value]);
    return windows ? resolved.toLowerCase() : resolved;
  };
  const contains = (root, candidate) => {
    const normalizedRoot = trimTrailing(canonical(root), separator);
    const normalizedCandidate = canonical(candidate);
    const childPrefix = normalizedRoot.endsWith(separator)
      ? normalizedRoot
      : normalizedRoot + separator;
    return normalizedCandidate === normalizedRoot
      || normalizedCandidate.startsWith(childPrefix);
  };
  const same = (left, right) => canonical(left) === canonical(right);

  const configRoot = join([normalizedHome, '.ae-mcp']);
  const runtimeRoot = join([configRoot, 'runtime']);
  const binRoot = join([configRoot, 'bin']);
  return Object.freeze({
    home: normalizedHome,
    tempRoot: normalizedTemp,
    configRoot,
    toolsRoot: join([configRoot, 'tools']),
    legacySkillsRoot: join([configRoot, 'skills']),
    migrationRoot: join([configRoot, 'migrations']),
    logsRoot: join([configRoot, 'logs']),
    captureSpool: join([configRoot, 'capture-spool']),
    runtimeRoot,
    currentPointer: join([runtimeRoot, 'current']),
    previousPointer: join([runtimeRoot, 'previous']),
    binRoot,
    launcher: join([binRoot, windows ? 'ae-mcp.exe' : 'ae-mcp']),
    join,
    dirname,
    basename,
    resolve,
    isAbsolute,
    contains,
    same,
  });
}
