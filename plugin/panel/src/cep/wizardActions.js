// One-click wizard actions: detect -> show exact command -> spawn with
// streamed output -> re-detect. All sources are official (winget ids /
// npm packages / astral installer); commands are shown verbatim to the
// user BEFORE running. Workers: keep getCepRequire pattern from mcpClient.
import { findProjectRoot } from './mcpClient.js';

const OUTPUT_TAIL = 8192;

function getCepRequire() {
  if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) {
    return globalThis.window.cep_node.require;
  }
  if (globalThis.window && globalThis.window.require) return globalThis.window.require;
  if (globalThis.require) return globalThis.require;
  throw new Error('CEP Node require is unavailable');
}

const DETECT = {
  uv: { file: 'uv', args: ['--version'] },
  node: { file: 'node', args: ['--version'] },
  claude: { file: 'claude', args: ['--version'] },
};

function execVersion(execFile, file, args, env) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, env }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false });
      resolve({ ok: true, version: String(stdout || stderr || '').trim() });
    });
  });
}

function getCepEnvSafe() {
  return (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.process && globalThis.window.cep_node.process.env) || {};
}

// ae-mcp is a stdio MCP server: launched with ANY argv it ignores the flags
// and blocks serving stdin (verified live — `ae-mcp --version` hangs forever),
// so its presence is checked WITHOUT executing it: `where` hit or the uv tool
// shim existing on disk. The resolved path doubles as the version detail.
async function detectAeMcp({ execFileImpl, env, fsImpl }) {
  const execFile = execFileImpl || getCepRequire()('child_process').execFile;
  const whereHit = await new Promise((resolve) => {
    execFile('where', ['ae-mcp'], { windowsHide: true, env }, (err, stdout) => {
      resolve(err ? '' : String(stdout || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '');
    });
  });
  if (whereHit) return { ok: true, version: whereHit };
  const profile = (env || getCepEnvSafe()).USERPROFILE || '';
  if (profile) {
    const shim = profile.replace(/[\\/]+$/, '') + '\\.local\\bin\\ae-mcp.exe';
    const fs = fsImpl || getCepRequire()('fs');
    if (fs.existsSync(shim)) return { ok: true, version: shim };
  }
  return { ok: false };
}

export async function detectTool(id, { execFileImpl, env, fsImpl } = {}) {
  if (id === 'aeMcp') return detectAeMcp({ execFileImpl, env, fsImpl });
  const spec = DETECT[id];
  const execFile = execFileImpl || getCepRequire()('child_process').execFile;
  return execVersion(execFile, spec.file, spec.args, env);
}

const REPO = 'https://github.com/JUNKDOGE-JOE/after-effects-mcp';

export function buildInstallCommands({ panelVersion, repoRoot }) {
  const src = (sub) => repoRoot
    ? `${repoRoot}\\packages\\${sub}`
    : `git+${REPO}@v${panelVersion}#subdirectory=packages/${sub}`;
  return {
    uv: { file: 'winget', args: ['install', '--id', 'astral-sh.uv', '-e', '--accept-source-agreements', '--accept-package-agreements'] },
    uvFallback: { file: 'powershell', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://astral.sh/uv/install.ps1 | iex'] },
    node: { file: 'winget', args: ['install', '--id', 'OpenJS.NodeJS.LTS', '-e', '--accept-source-agreements', '--accept-package-agreements'] },
    claude: { file: 'npm', args: ['install', '-g', '@anthropic-ai/claude-code'] },
    aeMcp: { file: 'uv', args: ['tool', 'install', '--force', '--from', src('core'), 'ae-mcp', '--with', src('bridge'), '--with', src('snapshot-mss')] },
  };
}

export function runAction({ file, args, spawnImpl, env, onChunk }) {
  const spawn = spawnImpl || getCepRequire()('child_process').spawn;
  return new Promise((resolve) => {
    let output = '';
    const push = (chunk) => {
      const text = String(chunk || '');
      output = (output + text).slice(-OUTPUT_TAIL);
      if (onChunk) onChunk(text);
    };
    let child;
    try {
      child = spawn(file, args, { windowsHide: true, env, shell: false });
    } catch (e) {
      return resolve({ ok: false, code: -1, output: String(e && e.message || e) });
    }
    if (child.stdout && child.stdout.on) child.stdout.on('data', push);
    if (child.stderr && child.stderr.on) child.stderr.on('data', push);
    child.on('error', (e) => resolve({ ok: false, code: -1, output: output + String(e && e.message || e) }));
    child.on('exit', (code) => resolve({ ok: code === 0, code, output }));
  });
}

export function commandPreview({ file, args }) {
  return [file, ...args.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(' ');
}

export function detectRepoRoot({ extRoot, fsImpl }) {
  return findProjectRoot({ extRoot, repoRoot: '', fsImpl: fsImpl || getCepRequire()('fs') });
}

// claude CLI does not have a login subcommand: running bare `claude`
// interactively enters the browser OAuth flow when the user is logged out.
const LOGIN_COMMANDS = { claude: 'claude', codex: 'codex login' };

export function openLoginTerminal({ tool, spawnImpl } = {}) {
  const spawn = spawnImpl || getCepRequire()('child_process').spawn;
  const command = LOGIN_COMMANDS[tool] || LOGIN_COMMANDS.claude;
  const child = spawn('cmd', ['/c', 'start', 'ae-mcp login', 'pwsh', '-NoExit', '-Command', command], {
    detached: true, windowsHide: false,
  });
  if (child && child.unref) child.unref();
  return true;
}
