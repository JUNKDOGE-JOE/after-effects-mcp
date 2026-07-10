// Legacy wizard orchestration. Task 11 replaces the online install catalog;
// this module only keeps business code behind the shared platform boundary.
import { findProjectRoot } from './mcpClient.js';
import { createPlatformAdapter } from './platform/index.js';

const OUTPUT_TAIL = 8192;
const REPO = 'https://github.com/JUNKDOGE-JOE/after-effects-mcp';
const TOOL_IDS = { aeMcp: 'ae-mcp', uv: 'uv', node: 'node', claude: 'claude' };

export async function detectTool(id, { platform } = {}) {
  const adapter = platform || createPlatformAdapter();
  const executableId = TOOL_IDS[id];
  if (!executableId) return { ok: false, detail: 'unsupported tool id' };
  const options = executableId === 'node' ? { minimumVersion: '18.0.0' } : {};
  const resolved = await adapter.resolveExecutable(executableId, options);
  if (!resolved.ok) return { ok: false, detail: resolved.code, resolution: resolved };
  return {
    ok: true,
    version: resolved.version || resolved.path,
    path: resolved.path,
    source: resolved.source,
  };
}

export function buildInstallCommands({ panelVersion, repoRoot, platform } = {}) {
  const adapter = platform || createPlatformAdapter();
  if (typeof adapter.legacyWizardInstallCommands !== 'function') {
    throw new Error('Legacy wizard command catalog is unavailable on this platform');
  }
  return adapter.legacyWizardInstallCommands({ panelVersion, repoRoot, repo: REPO });
}

export async function runAction({ file, executableId, args, platform, env, onChunk }) {
  const adapter = platform || createPlatformAdapter();
  if (!executableId || typeof executableId !== 'string') {
    return { ok: false, code: -1, output: 'Installer command is missing a platform executable id: ' + String(file || '') };
  }
  const executable = await adapter.resolveExecutable(executableId, env === undefined ? {} : { env });
  if (!executable.ok) return { ok: false, code: -1, output: executableId + ' resolution failed: ' + executable.code };
  return new Promise((resolve) => {
    let output = '';
    let spawnError = null;
    const push = (chunk) => {
      const text = String(chunk || '');
      output = (output + text).slice(-OUTPUT_TAIL);
      if (onChunk) onChunk(text);
    };
    let child;
    try {
      const spawnOptions = { windowsHide: true };
      if (env !== undefined) spawnOptions.env = env;
      child = adapter.spawn(executable, args || [], spawnOptions);
    } catch (error) {
      resolve({ ok: false, code: -1, output: String(error && error.message || error) });
      return;
    }
    child.stdout?.on?.('data', push);
    child.stderr?.on?.('data', push);
    child.on?.('error', (error) => {
      spawnError = error;
      push(String(error && error.message || error));
    });
    child.on?.('close', (code) => resolve({ ok: !spawnError && code === 0, code: spawnError ? -1 : code, output }));
  });
}

export function commandPreview({ file, args }) {
  return [file, ...(args || []).map((value) => (/\s/.test(value) ? `"${value}"` : value))].join(' ');
}

export function detectRepoRoot({ extRoot, fsImpl, platform }) {
  const adapter = platform || createPlatformAdapter();
  return findProjectRoot({ extRoot, repoRoot: '', fsImpl: fsImpl || adapter.fs, platform: adapter });
}

export async function openLoginTerminal({ tool, platform } = {}) {
  const adapter = platform || createPlatformAdapter();
  await adapter.openLoginTerminal(tool === 'codex' ? 'codex' : 'claude');
  return true;
}
