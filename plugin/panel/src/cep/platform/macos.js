import { createPathCatalog } from './paths.js';
import { createProcessBoundary } from './process.js';

export function createMacosAdapter(deps) {
  if (!deps || deps.platform !== 'darwin' || deps.arch !== 'arm64') throw new Error('macOS arm64 dependencies are required');
  const paths = createPathCatalog({ home: deps.home, temp: deps.temp, platform: deps.platform });
  const boundary = createProcessBoundary({ deps, paths, platform: deps.platform });
  const fixed = (id, path, argsPrefix = []) => ({ ok: true, id, path, argsPrefix, source: 'standard', version: null, arch: 'arm64' });
  return Object.freeze({
    id: 'macos-arm64',
    paths,
    fs: deps.fs,
    ...boundary,
    revealFile(filePath) {
      return boundary.run({ executable: fixed('ae-mcp', '/usr/bin/open'), args: ['-R', String(filePath)], timeoutMs: 5000 });
    },
    openLoginTerminal(tool) {
      if (tool !== 'claude' && tool !== 'codex') throw new TypeError('Unsupported login tool');
      const command = tool === 'claude' ? 'claude' : 'codex login';
      const script = 'tell application "Terminal" to do script ' + JSON.stringify(command) + '\ntell application "Terminal" to activate';
      return boundary.run({ executable: fixed(tool, '/usr/bin/osascript'), args: ['-e', script], timeoutMs: 5000 });
    },
    legacyWizardInstallCommands({ panelVersion, repoRoot, repo }) {
      const src = (sub) => repoRoot
        ? paths.join([repoRoot, 'packages', sub])
        : `git+${repo}@v${panelVersion}#subdirectory=packages/${sub}`;
      return {
        uv: { file: 'brew', executableId: 'brew', args: ['install', 'uv'] },
        uvFallback: { file: 'brew', executableId: 'brew', args: ['install', 'uv'] },
        node: { file: 'brew', executableId: 'brew', args: ['install', 'node@24'] },
        claude: { file: 'npm', executableId: 'npm', args: ['install', '-g', '@anthropic-ai/claude-code'] },
        aeMcp: { file: 'uv', executableId: 'uv', args: ['tool', 'install', '--force', '--from', src('core'), 'ae-mcp', '--with', src('bridge'), '--with', src('snapshot-mss')] },
      };
    },
  });
}
