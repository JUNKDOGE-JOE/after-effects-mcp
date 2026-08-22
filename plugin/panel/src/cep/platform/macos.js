import { createPathCatalog } from './paths.js';
import { createProcessBoundary } from './process.js';

function normalizedExecutableName(value) {
  return String(value || '').trim().split('/').at(-1).replace(/\.exe$/i, '').toLowerCase();
}

export function createMacosAdapter(deps) {
  if (!deps || deps.platform !== 'darwin' || deps.arch !== 'arm64') throw new Error('macOS arm64 dependencies are required');
  const paths = createPathCatalog({ home: deps.home, temp: deps.temp, platform: deps.platform });
  const boundary = createProcessBoundary({ deps, paths, platform: deps.platform });
  const fixed = (id, path, argsPrefix = []) => ({ ok: true, id, path, argsPrefix, source: 'standard', version: null, arch: 'arm64' });
  return Object.freeze({
    id: 'macos-arm64',
    pid: deps.pid,
    paths,
    fs: deps.fs,
    ...boundary,
    async processAlive({ pid } = {}) {
      const processId = Number(pid);
      if (!Number.isInteger(processId) || processId <= 0) return false;
      try {
        const result = await boundary.run({
          executable: fixed('ps', '/bin/ps'),
          args: ['-p', String(processId), '-o', 'pid='],
          timeoutMs: 3000,
        });
        return result.exitCode === 0 && Boolean(String(result.stdout || '').trim());
      } catch {
        return false;
      }
    },
    async terminateProcess({ pid, executableName } = {}) {
      if (!Number.isInteger(pid) || pid <= 0) {
        return { ok: false, matched: false, killed: false, detail: 'invalid pid' };
      }
      try {
        const inspected = await boundary.run({
          executable: fixed('ps', '/bin/ps'),
          args: ['-p', String(pid), '-o', 'comm='],
          timeoutMs: 3000,
        });
        if (inspected.exitCode !== 0 || inspected.timedOut || inspected.aborted) {
          return { ok: false, matched: false, killed: false, detail: 'ps failed' };
        }
        const command = String(inspected.stdout || '').trim().split(/\r?\n/, 1)[0];
        if (!command) return { ok: true, matched: false, killed: false, detail: 'process not found' };
        if (normalizedExecutableName(command) !== normalizedExecutableName(executableName)) {
          return { ok: true, matched: false, killed: false, detail: 'pid reused by ' + command };
        }
        const terminated = await boundary.run({
          executable: fixed('kill', '/bin/kill'),
          args: ['-9', String(pid)],
          timeoutMs: 3000,
        });
        const killed = terminated.exitCode === 0 && !terminated.timedOut && !terminated.aborted;
        return {
          ok: killed,
          matched: true,
          killed,
          detail: killed ? 'terminated' : 'kill failed',
        };
      } catch (error) {
        return { ok: false, matched: false, killed: false, detail: error?.message || String(error) };
      }
    },
    revealFile(filePath) {
      return boundary.run({
        executable: fixed('system-open', '/usr/bin/open'),
        args: ['-R', String(filePath)],
        timeoutMs: 5000,
      });
    },
    openLoginTerminal(tool) {
      if (tool !== 'claude' && tool !== 'codex') throw new TypeError('Unsupported login tool');
      const command = tool === 'claude' ? 'claude' : 'codex login';
      const script = 'tell application "Terminal" to do script ' + JSON.stringify(command) + '\ntell application "Terminal" to activate';
      return boundary.run({ executable: fixed(tool, '/usr/bin/osascript'), args: ['-e', script], timeoutMs: 5000 });
    },
    legacyWizardInstallCommands() {
      return {
        node: { file: 'brew', executableId: 'brew', args: ['install', 'node@24'] },
      };
    },
  });
}
