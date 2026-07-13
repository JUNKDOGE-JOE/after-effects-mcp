import { createPathCatalog } from './paths.js';
import { createProcessBoundary } from './process.js';

function envValue(environment, name) {
  const key = Object.keys(environment || {}).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : environment[key];
}

export function createWindowsAdapter(deps) {
  if (!deps || deps.platform !== 'win32' || deps.arch !== 'x64') throw new Error('Windows x64 dependencies are required');
  const paths = createPathCatalog({ home: deps.home, temp: deps.temp, platform: deps.platform });
  const boundary = createProcessBoundary({ deps, paths, platform: deps.platform });
  const systemRoot = String(envValue(deps.env, 'SystemRoot') || envValue(deps.env, 'WINDIR') || 'C:\\Windows');
  const fixed = (id, path, argsPrefix = []) => ({ ok: true, id, path, argsPrefix, source: 'standard', version: null, arch: 'x64' });
  return Object.freeze({
    id: 'windows-x64',
    paths,
    fs: deps.fs,
    ...boundary,
    revealFile(filePath) {
      const explorer = paths.join([systemRoot, 'explorer.exe']);
      return boundary.run({ executable: fixed('ae-mcp', explorer), args: ['/select,', String(filePath)], timeoutMs: 5000 });
    },
    openLoginTerminal(tool) {
      if (tool !== 'claude' && tool !== 'codex') throw new TypeError('Unsupported login tool');
      const cmd = paths.join([systemRoot, 'System32', 'cmd.exe']);
      const args = tool === 'claude' ? ['start', '', 'claude'] : ['start', '', 'codex', 'login'];
      return boundary.run({ executable: fixed(tool, cmd, ['/d', '/s', '/c']), args, timeoutMs: 5000 });
    },
    legacyWizardInstallCommands({ panelVersion, repoRoot, repo }) {
      const src = (sub) => repoRoot
        ? paths.join([repoRoot, 'packages', sub])
        : `git+${repo}@v${panelVersion}#subdirectory=packages/${sub}`;
      return {
        uv: { file: 'winget', executableId: 'winget', args: ['install', '--id', 'astral-sh.uv', '-e', '--accept-source-agreements', '--accept-package-agreements'] },
        uvFallback: { file: 'powershell', executableId: 'powershell', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://astral.sh/uv/install.ps1 | iex'] },
        node: { file: 'winget', executableId: 'winget', args: ['install', '--id', 'OpenJS.NodeJS.LTS', '-e', '--accept-source-agreements', '--accept-package-agreements'] },
        claude: { file: 'npm', executableId: 'npm', args: ['install', '-g', '@anthropic-ai/claude-code'] },
        aeMcp: { file: 'uv', executableId: 'uv', args: ['tool', 'install', '--force', '--from', src('core'), 'ae-mcp', '--with', src('bridge'), '--with', src('snapshot-mss')] },
      };
    },
  });
}
