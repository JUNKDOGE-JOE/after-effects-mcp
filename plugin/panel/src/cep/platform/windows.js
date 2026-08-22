import { createPathCatalog } from './paths.js';
import { createProcessBoundary } from './process.js';

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

export function createWindowsAdapter(deps) {
  if (!deps || deps.platform !== 'win32' || deps.arch !== 'x64') throw new Error('Windows x64 dependencies are required');
  const paths = createPathCatalog({ home: deps.home, temp: deps.temp, platform: deps.platform });
  const boundary = createProcessBoundary({ deps, paths, platform: deps.platform });
  const systemRoot = String(envValue(deps.env, 'SystemRoot') || envValue(deps.env, 'WINDIR') || 'C:\\Windows');
  const fixed = (id, path, argsPrefix = []) => ({ ok: true, id, path, argsPrefix, source: 'standard', version: null, arch: 'x64' });
  return Object.freeze({
    id: 'windows-x64',
    pid: deps.pid,
    paths,
    fs: deps.fs,
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
    legacyWizardInstallCommands() {
      return {
        node: { file: 'winget', executableId: 'winget', args: ['install', '--id', 'OpenJS.NodeJS.LTS', '-e', '--accept-source-agreements', '--accept-package-agreements'] },
      };
    },
  });
}
