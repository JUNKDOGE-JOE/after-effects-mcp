import { createNdjsonReader } from '../lib/ndjson.js';
import { expertGuidanceEnv } from './externalClients.js';

const DEFAULT_TIMEOUT_MS = 30000;
const MCP_PROTOCOL_VERSION = '2025-06-18';
export const PANEL_VERSION = '0.8.2';

function getCepRequire() {
  if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) {
    return globalThis.window.cep_node.require;
  }
  if (globalThis.window && globalThis.window.require) return globalThis.window.require;
  if (globalThis.require) return globalThis.require;
  throw new Error('CEP Node require is unavailable');
}

function getCepEnv() {
  return (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.process && globalThis.window.cep_node.process.env) || {};
}

function normalizeFsPath(value) {
  let text = String(value || '').replace(/\//g, '\\');
  text = text.replace(/\\+$/, '');
  return text;
}

function dirname(value) {
  const normalized = normalizeFsPath(value);
  const index = normalized.lastIndexOf('\\');
  if (index <= 0) return '';
  return normalized.slice(0, index);
}

function joinPath(base, leaf) {
  return normalizeFsPath(base) + '\\' + leaf;
}

function firstWhereHit(stdout) {
  return String(stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

function defaultWhereImpl() {
  const childProcess = getCepRequire()('child_process');
  return new Promise((resolve) => {
    childProcess.execFile('where', ['ae-mcp'], { windowsHide: true }, (err, stdout) => {
      resolve(err ? '' : stdout);
    });
  });
}

function defaultFs() {
  return getCepRequire()('fs');
}

export function findProjectRoot({ extRoot, repoRoot, fsImpl }) {
  if (repoRoot && fsImpl.existsSync(joinPath(repoRoot, 'pyproject.toml'))) return normalizeFsPath(repoRoot);

  let current = normalizeFsPath(extRoot);
  while (current) {
    if (fsImpl.existsSync(joinPath(current, 'pyproject.toml'))) return current;
    const parent = dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  return '';
}

export async function resolveMcpCommand({
  explicitPath,
  whereImpl = defaultWhereImpl,
  fsImpl,
  envImpl = null,
  extRoot = '',
  repoRoot = '',
} = {}) {
  const configured = String(explicitPath || '').trim();
  if (configured) return { command: configured, args: [], source: 'explicit' };

  const found = firstWhereHit(await whereImpl('ae-mcp'));
  if (found) return { command: found, args: [], source: 'where' };

  const fs = fsImpl || defaultFs();
  const profile = (envImpl || getCepEnv()).USERPROFILE || '';
  if (profile) {
    const shim = joinPath(joinPath(joinPath(normalizeFsPath(profile), '.local'), 'bin'), 'ae-mcp.exe');
    if (fs.existsSync(shim)) return { command: shim, args: [], source: 'uv-tool' };
  }

  const projectRoot = findProjectRoot({ extRoot, repoRoot, fsImpl: fs });
  if (projectRoot) {
    return { command: 'uv', args: ['run', '--project', projectRoot, 'ae-mcp'], source: 'uv' };
  }

  throw new Error('Unable to find ae-mcp. Configure the ae-mcp executable path, add ae-mcp to PATH, or run from a checkout containing pyproject.toml for uv run --project.');
}

export function _createRpc(stdinWrite, onLine, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  let nextId = 1;
  const pending = new Map();

  function rejectPending(id, error) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.reject(error);
  }

  function handleMessage(message) {
    if (!message || message.id === undefined || message.id === null) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      const error = new Error(message.error.message || 'JSON-RPC request failed');
      error.code = message.error.code;
      error.data = message.error.data;
      entry.reject(error);
    } else {
      entry.resolve(message.result);
    }
  }

  const handleChunk = createNdjsonReader(handleMessage);

  if (onLine) onLine(handleChunk);

  function writeMessage(message) {
    stdinWrite(JSON.stringify(message) + '\n');
  }

  function request(method, params) {
    const id = nextId++;
    const message = { jsonrpc: '2.0', id, method };
    if (params !== undefined) message.params = params;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => rejectPending(id, new Error(method + ' timed out after ' + timeoutMs + 'ms')), timeoutMs);
      pending.set(id, { resolve, reject, timer });
    });
    writeMessage(message);
    return promise;
  }

  function notify(method, params) {
    const message = { jsonrpc: '2.0', method };
    if (params !== undefined) message.params = params;
    writeMessage(message);
  }

  function close(reason = new Error('MCP process closed')) {
    for (const id of Array.from(pending.keys())) rejectPending(id, reason);
  }

  return { request, notify, handleChunk, close };
}

export function createMcpClient({
  spawnImpl,
  resolveCommand = resolveMcpCommand,
  env,
  onCrash,
  extRoot,
  repoRoot,
  getExpertGuidance = () => true,
  packageVersion = PANEL_VERSION,
  retryDelays = [1000, 2000, 4000],
} = {}) {
  let proc = null;
  let rpc = null;
  let tools = null;
  let serverInstructions = '';
  let status = 'idle';
  let startPromise = null;
  let retryCount = 0;
  let lastError = null;
  let stopped = false;
  let restartTimer = null;

  function currentState() {
    return { status, retryCount, error: lastError, tools };
  }

  function getSpawn() {
    if (spawnImpl) return spawnImpl;
    return getCepRequire()('child_process').spawn;
  }

  function attachBeforeUnload() {
    if (globalThis.window && globalThis.window.addEventListener) {
      globalThis.window.addEventListener('beforeunload', () => stop());
    }
  }

  async function start() {
    if (status === 'ready') return currentState();
    if (startPromise) return startPromise;
    stopped = false;
    status = 'starting';
    startPromise = (async () => {
      const commandSpec = await resolveCommand({ extRoot, repoRoot });
      const spawn = getSpawn();
      const spawnEnv = Object.assign({}, getCepEnv(), env || {}, {
        AE_MCP_BACKEND: 'ae-mcp',
        ...expertGuidanceEnv(getExpertGuidance()),
      });
      proc = spawn(commandSpec.command, commandSpec.args || [], {
        stdio: 'pipe',
        windowsHide: true,
        env: spawnEnv,
      });
      rpc = _createRpc(
        (line) => proc.stdin.write(line),
        (handler) => proc.stdout.on('data', handler),
      );
      proc.on('exit', (code, signal) => handleExit(code, signal));
      proc.on('error', (err) => handleCrash(err));
      if (proc.stderr && proc.stderr.on) proc.stderr.on('data', () => {});

      const initResult = await rpc.request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        clientInfo: { name: 'panel-chat', version: packageVersion },
        capabilities: {},
      });
      serverInstructions = (initResult && initResult.instructions) || '';
      rpc.notify('notifications/initialized');
      const listed = await rpc.request('tools/list', {});
      tools = listed && Array.isArray(listed.tools) ? listed.tools : [];
      status = 'ready';
      retryCount = 0;
      lastError = null;
      attachBeforeUnload();
      return currentState();
    })();

    try {
      return await startPromise;
    } catch (e) {
      status = 'error';
      lastError = e;
      throw e;
    } finally {
      startPromise = null;
    }
  }

  function handleCrash(error) {
    if (stopped) return;
    status = 'crashed';
    lastError = error;
    if (rpc) rpc.close(error instanceof Error ? error : new Error('MCP process crashed'));
    if (onCrash) onCrash(error);
    scheduleRestart();
  }

  function handleExit(code, signal) {
    if (stopped) return;
    handleCrash(new Error('MCP process exited: ' + code + (signal ? ' ' + signal : '')));
  }

  function scheduleRestart() {
    if (retryCount >= retryDelays.length) {
      status = 'error';
      return;
    }
    const delay = retryDelays[retryCount++];
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      start().catch((err) => {
        lastError = err;
        scheduleRestart();
      });
    }, delay);
  }

  async function listTools() {
    await start();
    return tools || [];
  }

  async function callTool(name, args = {}) {
    await start();
    return rpc.request('tools/call', { name, arguments: args });
  }

  function stop() {
    stopped = true;
    clearTimeout(restartTimer);
    restartTimer = null;
    status = 'stopped';
    if (rpc) rpc.close(new Error('MCP client stopped'));
    if (proc) {
      try { proc.kill(); } catch (e) { /* best effort */ }
    }
    proc = null;
    rpc = null;
    startPromise = null;
  }

  return { start, listTools, callTool, stop, state: currentState, getServerInstructions: () => serverInstructions };
}
