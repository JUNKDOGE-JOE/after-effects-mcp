const TOOL_PACKAGE_SUFFIX = '.aemcptools';
const SYSTEM_COMMAND_SUFFIXES = ['.ps1', '.psm1', '.bat', '.cmd', '.sh', '.command'];

function selectedValue(result) {
  if (!result || Number(result.err || 0) !== 0) return null;
  const data = result.data;
  if (Array.isArray(data)) return data.length === 1 ? data[0] : null;
  return data || null;
}

function normalizeFileUrl(value) {
  let path = String(value || '').trim();
  if (/^file:\/\//i.test(path)) {
    path = decodeURIComponent(path.replace(/^file:\/\//i, ''));
    if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1);
  }
  return path;
}

export function chooseToolPackage(cepFs, {
  title = 'Import Tool Library package',
  initialPath = '',
  normalizePath = normalizeFileUrl,
} = {}) {
  if (!cepFs || typeof cepFs.showOpenDialog !== 'function') {
    throw new TypeError('CEP file dialog is unavailable');
  }
  const result = cepFs.showOpenDialog(
    false,
    false,
    title,
    initialPath,
    ['aemcptools', 'ps1', 'psm1', 'bat', 'cmd', 'sh', 'command'],
  );
  const selected = selectedValue(result);
  if (!selected) return null;
  const path = normalizePath(normalizeFileUrl(selected));
  const lower = path.toLowerCase();
  if (!lower.endsWith(TOOL_PACKAGE_SUFFIX)
      && !SYSTEM_COMMAND_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
    throw new Error('Select a .aemcptools package or a quarantined system-command file');
  }
  return path;
}

export function chooseToolExportPath(cepFs, {
  title = 'Export Tool Library package',
  initialPath = '',
  normalizePath = normalizeFileUrl,
} = {}) {
  if (!cepFs || typeof cepFs.showSaveDialog !== 'function') {
    throw new TypeError('CEP file dialog is unavailable');
  }
  const result = cepFs.showSaveDialog(
    title,
    initialPath,
    ['aemcptools'],
    'tools.aemcptools',
  );
  const selected = selectedValue(result);
  if (!selected) return null;
  const path = normalizePath(normalizeFileUrl(selected));
  return path.toLowerCase().endsWith(TOOL_PACKAGE_SUFFIX)
    ? path
    : `${path}${TOOL_PACKAGE_SUFFIX}`;
}
