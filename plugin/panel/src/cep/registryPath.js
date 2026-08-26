const REG_EXECUTABLE = {
  ok: true,
  id: 'reg',
  path: 'reg.exe',
  argsPrefix: [],
  source: 'override',
  version: null,
  arch: 'x64',
};

const USER_PATH_QUERY = ['query', 'HKCU\\Environment', '/v', 'Path'];
const USER_PATH_DEFAULT = { value: '', type: 'REG_EXPAND_SZ' };

export function isWindowsPlatform(adapter) {
  return adapter?.id === 'windows-x64' || adapter?.platform === 'win32';
}

function requireWindows(adapter) {
  if (!isWindowsPlatform(adapter)) {
    throw new Error('User PATH updates are only supported on Windows');
  }
}

function normalizedPathEntry(value) {
  let result = String(value || '').trim().replace(/\//g, '\\');
  while (result.length > 3 && result.endsWith('\\')) result = result.slice(0, -1);
  return result.toLowerCase();
}

function expandEnvironmentEntry(value, environment) {
  return String(value || '').replace(/%([^%]+)%/g, (match, name) => {
    const key = Object.keys(environment || {}).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    return key === undefined ? match : String(environment[key]);
  });
}

export function pathIncludesEntry(rawValue, directory, environment = {}) {
  const expected = normalizedPathEntry(directory);
  if (!expected) return false;
  return String(rawValue || '').split(';').some((entry) => (
    normalizedPathEntry(entry) === expected
    || normalizedPathEntry(expandEnvironmentEntry(entry, environment)) === expected
  ));
}

async function resolvePowerShell(adapter) {
  const executable = await adapter.resolveExecutable('powershell');
  if (!executable || !executable.ok) {
    throw new Error('powershell resolution failed: ' + (executable?.code || 'NOT_FOUND'));
  }
  return executable;
}

function spawnAndCollect(adapter, executable, args) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result, error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve({ ...result, stdout, stderr });
    };
    try {
      const child = adapter.spawn(executable, args, { windowsHide: true });
      child.stdout?.on?.('data', (chunk) => { stdout += String(chunk || ''); });
      child.stderr?.on?.('data', (chunk) => { stderr += String(chunk || ''); });
      child.on?.('error', (error) => finish({}, error));
      child.on?.('close', (code) => finish({ code }, null));
    } catch (error) {
      finish({}, error);
    }
  });
}

function parseUserPath(output) {
  const line = String(output || '').split(/\r?\n/).find((entry) => (
    /^\s*Path\s+REG_(?:SZ|EXPAND_SZ)\s+/i.test(entry)
  ));
  if (!line) return null;
  const match = line.match(/^\s*Path\s+(REG_(?:SZ|EXPAND_SZ))\s+(.*)$/i);
  return match ? { value: match[2].trim(), type: match[1].toUpperCase() } : null;
}

export async function readUserPath(adapter) {
  requireWindows(adapter);
  const result = await spawnAndCollect(adapter, REG_EXECUTABLE, USER_PATH_QUERY);
  if (result.code !== 0) return { ...USER_PATH_DEFAULT };
  return parseUserPath(result.stdout) || { ...USER_PATH_DEFAULT };
}

async function addRegistryPath(adapter, value, type) {
  const result = await spawnAndCollect(adapter, REG_EXECUTABLE, [
    'add',
    'HKCU\\Environment',
    '/v',
    'Path',
    '/t',
    type,
    '/d',
    value,
    '/f',
  ]);
  if (result.code !== 0) {
    throw new Error((result.stderr || result.stdout || 'reg add failed').trim());
  }
}

const BROADCAST_SCRIPT = [
  "Add-Type @'",
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class EnvironmentChange {',
  '  public static readonly IntPtr HWND_BROADCAST = new IntPtr(0xffff);',
  '  public const uint WM_SETTINGCHANGE = 0x001A;',
  '  public const uint SMTO_ABORTIFHUNG = 0x0002;',
  '  [DllImport("user32.dll", CharSet = CharSet.Unicode)]',
  '  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);',
  '}',
  "'@",
  '$result = [UIntPtr]::Zero',
  '[EnvironmentChange]::SendMessageTimeout([EnvironmentChange]::HWND_BROADCAST, [EnvironmentChange]::WM_SETTINGCHANGE, [UIntPtr]::Zero, "Environment", [EnvironmentChange]::SMTO_ABORTIFHUNG, 2000, [ref]$result) | Out-Null',
].join('\n');

async function broadcastEnvironmentChange(adapter) {
  const executable = await resolvePowerShell(adapter);
  const result = await spawnAndCollect(adapter, executable, [
    '-NoProfile',
    '-Command',
    BROADCAST_SCRIPT,
  ]);
  if (result.code !== 0) throw new Error((result.stderr || result.stdout || 'broadcast failed').trim());
}

export async function addUserPathEntry(adapter, directory) {
  requireWindows(adapter);
  const entry = String(directory || '').trim();
  if (!entry) throw new Error('A non-empty PATH directory is required');
  const current = await readUserPath(adapter);
  if (pathIncludesEntry(current.value, entry)) return { changed: false };
  // Preserve REG_EXPAND_SZ so existing %VAR% references remain expandable.
  const newValue = current.value ? current.value + ';' + entry : entry;
  // Do not use setx: it can truncate PATH values at 1024 characters.
  await addRegistryPath(adapter, newValue, current.type);
  try {
    await broadcastEnvironmentChange(adapter);
  } catch (error) {
    globalThis.console?.warn?.('User PATH broadcast failed:', error);
  }
  return { changed: true };
}
