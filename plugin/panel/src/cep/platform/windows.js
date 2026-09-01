import { createPathCatalog } from './paths.js';
import { createProcessBoundary } from './process.js';
import { createHttpJsonRequester } from './http-json.js';

function envValue(environment, name) {
  const key = Object.keys(environment || {}).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : environment[key];
}

function normalizedExecutableName(value) {
  return String(value || '').trim().split(/[\\/]/).at(-1).replace(/\.exe$/i, '').toLowerCase();
}

function tasklistImage(stdout) {
  const line = String(stdout || '').split(/\r?\n/).find((value) => /^"/.test(value.trim()));
  const match = line && line.trim().match(/^"((?:[^"]|"")*)"/);
  return match ? match[1].replace(/""/g, '"') : '';
}

const USER_PATH_DEFAULT = Object.freeze({ value: '', type: 'REG_EXPAND_SZ' });
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

function normalizedPathEntry(value) {
  let result = String(value || '').trim().replace(/\//g, '\\');
  while (result.length > 3 && result.endsWith('\\')) result = result.slice(0, -1);
  return result.toLowerCase();
}

function expandEnvironmentEntry(value, environment) {
  return String(value || '').replace(/%([^%]+)%/g, (match, name) => {
    const replacement = envValue(environment, name);
    return replacement === undefined ? match : String(replacement);
  });
}

function pathIncludesEntry(rawValue, directory, environment) {
  const expected = normalizedPathEntry(directory);
  if (!expected) return false;
  return String(rawValue || '').split(';').some((entry) => (
    normalizedPathEntry(entry) === expected
    || normalizedPathEntry(expandEnvironmentEntry(entry, environment)) === expected
  ));
}

function parseUserPath(output) {
  const line = String(output || '').split(/\r?\n/).find((entry) => (
    /^\s*Path\s+REG_(?:SZ|EXPAND_SZ)\s+/i.test(entry)
  ));
  if (!line) return null;
  const match = line.match(/^\s*Path\s+(REG_(?:SZ|EXPAND_SZ))\s+(.*)$/i);
  return match ? { value: match[2].trim(), type: match[1].toUpperCase() } : null;
}

export function createWindowsAdapter(deps) {
  if (!deps || deps.platform !== 'win32' || deps.arch !== 'x64') throw new Error('Windows x64 dependencies are required');
  const paths = createPathCatalog({ home: deps.home, temp: deps.temp, platform: deps.platform });
  const boundary = createProcessBoundary({
    deps, paths, platform: deps.platform, extensionRoot: deps.extensionRoot,
  });
  const systemRoot = String(envValue(deps.env, 'SystemRoot') || envValue(deps.env, 'WINDIR') || 'C:\\Windows');
  const fixed = (id, path, argsPrefix = []) => ({ ok: true, id, path, argsPrefix, source: 'standard', version: null, arch: 'x64' });
  const registry = fixed('reg', paths.join([systemRoot, 'System32', 'reg.exe']));
  const powershell = fixed(
    'powershell',
    paths.join([systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe']),
  );

  async function readUserPath() {
    const result = await boundary.run({
      executable: registry,
      args: ['query', 'HKCU\\Environment', '/v', 'Path'],
    });
    if (result.exitCode !== 0 || result.timedOut || result.aborted) return { ...USER_PATH_DEFAULT };
    return parseUserPath(result.stdout) || { ...USER_PATH_DEFAULT };
  }

  async function addUserPathEntry(directory) {
    const entry = String(directory || '').trim();
    if (!entry) throw new Error('A non-empty PATH directory is required');
    const current = await readUserPath();
    const environment = boundary.completeSpawnEnv();
    if (pathIncludesEntry(current.value, entry, environment)) return { changed: false };
    // Preserve REG_EXPAND_SZ so existing environment references remain expandable.
    const value = current.value ? current.value + ';' + entry : entry;
    // setx can truncate PATH values at 1024 characters.
    const written = await boundary.run({
      executable: registry,
      args: [
        'add', 'HKCU\\Environment', '/v', 'Path', '/t', current.type,
        '/d', value, '/f',
      ],
    });
    if (written.exitCode !== 0 || written.timedOut || written.aborted) {
      throw new Error((written.stderr || written.stdout || 'reg add failed').trim());
    }
    try {
      const broadcast = await boundary.run({
        executable: powershell,
        args: ['-NoProfile', '-Command', BROADCAST_SCRIPT],
      });
      if (broadcast.exitCode !== 0 || broadcast.timedOut || broadcast.aborted) {
        throw new Error((broadcast.stderr || broadcast.stdout || 'broadcast failed').trim());
      }
    } catch (error) {
      // The registry write is complete even when another process misses the notification.
      globalThis.console?.warn?.('User PATH broadcast failed:', error);
    }
    return { changed: true };
  }

  return Object.freeze({
    id: 'windows-x64',
    pid: deps.pid,
    canManageUserPath: true,
    paths,
    fs: deps.fs,
    requestJson: createHttpJsonRequester(deps),
    ...boundary,
    async processAlive({ pid } = {}) {
      const processId = Number(pid);
      if (!Number.isInteger(processId) || processId <= 0) return false;
      try {
        const tasklist = paths.join([systemRoot, 'System32', 'tasklist.exe']);
        const result = await boundary.run({
          executable: fixed('tasklist', tasklist),
          args: ['/FI', 'PID eq ' + processId, '/FO', 'CSV', '/NH'],
          timeoutMs: 3000,
        });
        return result.exitCode === 0 && Boolean(tasklistImage(result.stdout));
      } catch {
        return false;
      }
    },
    async terminateProcess({ pid, executableName } = {}) {
      if (!Number.isInteger(pid) || pid <= 0) {
        return { ok: false, matched: false, killed: false, detail: 'invalid pid' };
      }
      try {
        const tasklist = paths.join([systemRoot, 'System32', 'tasklist.exe']);
        const inspected = await boundary.run({
          executable: fixed('tasklist', tasklist),
          args: ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'],
          timeoutMs: 3000,
        });
        if (inspected.exitCode !== 0 || inspected.timedOut || inspected.aborted) {
          return { ok: false, matched: false, killed: false, detail: 'tasklist failed' };
        }
        const image = tasklistImage(inspected.stdout);
        if (!image) return { ok: true, matched: false, killed: false, detail: 'process not found' };
        if (normalizedExecutableName(image) !== normalizedExecutableName(executableName)) {
          return { ok: true, matched: false, killed: false, detail: 'pid reused by ' + image };
        }
        const taskkill = paths.join([systemRoot, 'System32', 'taskkill.exe']);
        const terminated = await boundary.run({
          executable: fixed('taskkill', taskkill),
          args: ['/PID', String(pid), '/T', '/F'],
          timeoutMs: 3000,
        });
        const killed = terminated.exitCode === 0 && !terminated.timedOut && !terminated.aborted;
        return {
          ok: killed,
          matched: true,
          killed,
          detail: killed ? 'terminated' : 'taskkill failed',
        };
      } catch (error) {
        return { ok: false, matched: false, killed: false, detail: error?.message || String(error) };
      }
    },
    revealFile(filePath) {
      const explorer = paths.join([systemRoot, 'explorer.exe']);
      return boundary.run({
        executable: fixed('explorer', explorer),
        args: ['/select,', String(filePath)],
        timeoutMs: 5000,
      });
    },
    openLoginTerminal(tool) {
      if (tool !== 'claude' && tool !== 'codex') throw new TypeError('Unsupported login tool');
      const cmd = paths.join([systemRoot, 'System32', 'cmd.exe']);
      const args = tool === 'claude' ? ['start', '', 'claude'] : ['start', '', 'codex', 'login'];
      return boundary.run({ executable: fixed(tool, cmd, ['/d', '/s', '/c']), args, timeoutMs: 5000 });
    },
    readUserPath,
    userPathIncludes(rawValue, directory) {
      return pathIncludesEntry(rawValue, directory, boundary.completeSpawnEnv());
    },
    addUserPathEntry,
    legacyWizardInstallCommands() {
      return {
        node: { file: 'winget', executableId: 'winget', args: ['install', '--id', 'OpenJS.NodeJS.LTS', '-e', '--accept-source-agreements', '--accept-package-agreements'] },
        claude: {
          file: 'powershell',
          executableId: 'powershell',
          args: [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            'irm https://claude.ai/install.ps1 | iex',
          ],
        },
      };
    },
  });
}
