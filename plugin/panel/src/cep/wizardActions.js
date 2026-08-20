import { createPlatformAdapter } from './platform/index.js';

const OUTPUT_TAIL = 8192;
const TOOL_IDS = {
  node: 'node',
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
};

async function detectHost({ port = 11488, fetchImpl } = {}) {
  const fetcher = fetchImpl || globalThis.fetch;
  if (typeof fetcher !== 'function') return { ok: false, detail: 'fetch unavailable' };
  try {
    const response = await fetcher('http://127.0.0.1:' + port + '/health');
    const body = response && typeof response.json === 'function'
      ? await response.json()
      : {};
    const ok = response && response.ok !== false && body.ok === true;
    return {
      ok,
      version: ok ? 'Host ' + (body.pluginVersion || 'ready') : '',
      detail: ok ? '127.0.0.1:' + (body.port || port) : 'Host did not return ok',
    };
  } catch (error) {
    return { ok: false, detail: error.message || String(error) };
  }
}

export async function detectTool(id, options = {}) {
  if (id === 'host') return detectHost(options);
  const adapter = options.platform || createPlatformAdapter();
  const executableId = TOOL_IDS[id];
  if (!executableId) return { ok: false, detail: 'unsupported tool id' };
  const resolveOptions = id === 'node'
    ? { minimumVersion: '18.0.0' }
    : (id === 'claude' ? { minimumVersion: '2.0.0' } : {});
  const resolved = await adapter.resolveExecutable(executableId, resolveOptions);
  if (!resolved.ok) {
    return { ok: false, detail: resolved.code, resolution: resolved };
  }
  return {
    ok: true,
    version: resolved.version || resolved.path,
    path: resolved.path,
    source: resolved.source,
  };
}

export function buildInstallCommands({ platform } = {}) {
  const adapter = platform || createPlatformAdapter();
  if (typeof adapter.legacyWizardInstallCommands !== 'function') return {};
  const commands = adapter.legacyWizardInstallCommands({
    panelVersion: '',
    repoRoot: '',
    repo: '',
  });
  return commands && commands.node ? { node: commands.node } : {};
}

export async function runAction({
  file,
  executableId,
  args,
  platform,
  env,
  onChunk,
}) {
  const adapter = platform || createPlatformAdapter();
  if (!executableId || typeof executableId !== 'string') {
    return {
      ok: false,
      code: -1,
      output: 'Installer command is missing a platform executable id: ' + String(file || ''),
    };
  }
  const executable = await adapter.resolveExecutable(
    executableId,
    env === undefined ? {} : { env },
  );
  if (!executable.ok) {
    return {
      ok: false,
      code: -1,
      output: executableId + ' resolution failed: ' + executable.code,
    };
  }
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
    child.on?.('close', (code) => {
      resolve({
        ok: !spawnError && code === 0,
        code: spawnError ? -1 : code,
        output,
      });
    });
  });
}

export function commandPreview({ file, args } = {}) {
  if (!file) return '';
  return [file, ...(args || []).map((value) => (
    /\s/.test(value) ? `"${value}"` : value
  ))].join(' ');
}
