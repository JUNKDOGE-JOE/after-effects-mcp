import { createNdjsonReader } from '../lib/ndjson.js';
import { expertGuidanceEnv } from './externalClients.js';
import { createPlatformAdapter } from './platform/index.js';

const DEFAULT_TIMEOUT_MS = 30000;
const INITIALIZE_TIMEOUT_MS = 120000;
const MCP_PROTOCOL_VERSION = '2025-06-18';
export const PANEL_VERSION = '0.9.2';

export function findProjectRoot({ extRoot, repoRoot, fsImpl, platform }) {
  const adapter = platform || createPlatformAdapter();
  if (repoRoot && fsImpl.existsSync(adapter.paths.join([repoRoot, 'pyproject.toml']))) return adapter.paths.resolve([repoRoot]);

  let current = adapter.paths.resolve([extRoot]);
  while (current) {
    if (fsImpl.existsSync(adapter.paths.join([current, 'pyproject.toml']))) return current;
    const parent = adapter.paths.dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  return '';
}

export async function resolveMcpCommand({
  explicitPath,
  platform,
} = {}) {
  const configured = String(explicitPath || '').trim();
  if (configured) return { command: configured, args: [], source: 'explicit' };
  const adapter = platform || createPlatformAdapter();
  const resolved = await adapter.resolveExecutable('ae-mcp');
  if (resolved.ok) return { command: resolved.path, args: [...resolved.argsPrefix], source: resolved.source };
  throw new Error('Unable to find ae-mcp. Repair the installed runtime launcher at ' + adapter.paths.launcher + '.');
}

export function _createRpc(stdinWrite, onLine, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const onRequest = options.onRequest;
  let nextId = 1;
  const pending = new Map();
  const inbound = new Map();

  function rejectPending(id, error) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.reject(error);
  }

  function writeMessage(message) {
    stdinWrite(JSON.stringify(message) + '\n');
  }

  function hasId(message) {
    return message && message.id !== undefined && message.id !== null;
  }

  function hasMethod(message) {
    return message && typeof message.method === 'string' && message.method.length > 0;
  }

  function abortInbound(id) {
    const entry = inbound.get(id);
    if (entry) entry.controller.abort();
  }

  async function dispatchRequest(message) {
    if (inbound.has(message.id)) {
      writeMessage({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32600, message: 'Invalid Request' },
      });
      return;
    }
    const controller = new AbortController();
    let settleAbort;
    const aborted = new Promise((resolve) => { settleAbort = resolve; });
    const abortHandler = () => settleAbort({ kind: 'abort' });
    controller.signal.addEventListener('abort', abortHandler, { once: true });
    inbound.set(message.id, { controller });
    try {
      const handled = typeof onRequest === 'function'
        ? Promise.resolve().then(() => onRequest(message, { signal: controller.signal }))
        : Promise.reject(Object.assign(new Error('Method not found'), { code: -32601 }));
      const outcome = await Promise.race([
        handled.then(
          (result) => ({ kind: 'result', result }),
          (error) => ({ kind: 'error', error }),
        ),
        aborted,
      ]);
      if (outcome.kind === 'abort') {
        writeMessage({
          jsonrpc: '2.0',
          id: message.id,
          result: { action: 'cancel', content: {} },
        });
      } else if (outcome.kind === 'error') {
        const code = outcome.error && outcome.error.code === -32601 ? -32601 : -32603;
        const error = {
          code,
          message: code === -32601 ? 'Method not found' : 'Internal error',
        };
        if (code === -32601 && outcome.error && outcome.error.data !== undefined) {
          error.data = outcome.error.data;
        }
        writeMessage({ jsonrpc: '2.0', id: message.id, error });
      } else {
        writeMessage({
          jsonrpc: '2.0',
          id: message.id,
          result: outcome.result === undefined ? null : outcome.result,
        });
      }
    } finally {
      controller.signal.removeEventListener('abort', abortHandler);
      inbound.delete(message.id);
    }
  }

  function handleMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (hasMethod(message)) {
      if (!hasId(message)) {
        if (message.method === 'notifications/cancelled') {
          abortInbound(message.params && message.params.requestId);
        }
        return;
      }
      dispatchRequest(message).catch(() => {});
      return;
    }
    if (!hasId(message)) return;
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

  function request(method, params, timeoutOverrideMs) {
    const id = nextId++;
    const message = { jsonrpc: '2.0', id, method };
    if (params !== undefined) message.params = params;
    const limit = Number.isFinite(timeoutOverrideMs) && timeoutOverrideMs > 0
      ? timeoutOverrideMs
      : timeoutMs;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => rejectPending(id, new Error(method + ' timed out after ' + limit + 'ms')), limit);
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
    for (const entry of inbound.values()) entry.controller.abort();
  }

  return { request, notify, handleChunk, close };
}

export function createMcpClient({
  platform,
  spawnImpl,
  resolveCommand = resolveMcpCommand,
  env,
  onCrash,
  onElicitation,
  extRoot,
  repoRoot,
  getExpertGuidance = () => true,
  packageVersion = PANEL_VERSION,
  retryDelays = [1000, 2000, 4000],
  initializeTimeoutMs = INITIALIZE_TIMEOUT_MS,
} = {}) {
  let proc = null;
  let rpc = null;
  let tools = null;
  let serverInstructions = '';
  let serverInfo = null;
  let status = 'idle';
  let startPromise = null;
  let retryCount = 0;
  let lastError = null;
  let stopped = false;
  let restartTimer = null;

  function currentState() {
    return { status, retryCount, error: lastError, tools };
  }

  function attachBeforeUnload() {
    if (globalThis.window && globalThis.window.addEventListener) {
      globalThis.window.addEventListener('beforeunload', () => stop());
    }
  }

  async function handleServerRequest(message, { signal }) {
    if (message.method !== 'elicitation/create') {
      throw Object.assign(new Error('Method not found'), {
        code: -32601,
        data: { method: message.method },
      });
    }
    if (typeof onElicitation !== 'function') return { action: 'decline', content: {} };
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    const request = {
      serverName: serverInfo && typeof serverInfo.name === 'string' ? serverInfo.name : '',
      message: typeof params.message === 'string' ? params.message : '',
      requestedSchema: params.requestedSchema,
      mode: params.mode,
      serverInfo: serverInfo ? { ...serverInfo } : null,
      serverInstructions,
      meta: params._meta,
    };
    if (signal.aborted) return { action: 'cancel', content: {} };
    const result = await onElicitation(request, { signal });
    if (signal.aborted) return { action: 'cancel', content: {} };
    if (!result || !['accept', 'decline', 'cancel'].includes(result.action)) {
      return { action: 'decline', content: {} };
    }
    return {
      action: result.action,
      content: result.content && typeof result.content === 'object' && !Array.isArray(result.content)
        ? result.content
        : {},
    };
  }

  async function start() {
    if (status === 'ready') return currentState();
    if (startPromise) return startPromise;
    stopped = false;
    status = 'starting';
    startPromise = (async () => {
      const adapter = platform || (!spawnImpl ? createPlatformAdapter() : null);
      const commandSpec = await resolveCommand({ extRoot, repoRoot, platform: adapter || undefined });
      const additions = {
        AE_MCP_BACKEND: 'ae-mcp',
        ...expertGuidanceEnv(getExpertGuidance()),
      };
      const spawnEnv = adapter ? adapter.completeSpawnEnv(env || {}, additions) : Object.assign({}, env || {}, additions);
      const options = {
        stdio: 'pipe',
        windowsHide: true,
        env: spawnEnv,
      };
      if (adapter) {
        const executable = { ok: true, id: 'ae-mcp', path: commandSpec.command, argsPrefix: [], source: commandSpec.source || 'runtime', version: null, arch: null };
        proc = adapter.spawn(executable, commandSpec.args || [], options);
      } else {
        proc = spawnImpl(commandSpec.command, commandSpec.args || [], { ...options, shell: false });
      }
      const spawnedProc = proc;
      rpc = _createRpc(
        (line) => spawnedProc.stdin.write(line),
        (handler) => spawnedProc.stdout.on('data', handler),
        { onRequest: handleServerRequest },
      );
      proc.on('exit', (code, signal) => {
        if (proc === spawnedProc) handleExit(code, signal);
      });
      proc.on('error', (err) => {
        if (proc === spawnedProc) handleCrash(err);
      });
      if (proc.stderr && proc.stderr.on) proc.stderr.on('data', () => {});

      const initResult = await rpc.request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        clientInfo: { name: 'panel-chat', version: packageVersion },
        capabilities: { elicitation: {} },
      }, initializeTimeoutMs);
      serverInstructions = (initResult && initResult.instructions) || '';
      serverInfo = initResult && initResult.serverInfo && typeof initResult.serverInfo === 'object'
        ? { ...initResult.serverInfo }
        : null;
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
      const failedRpc = rpc;
      const failedProc = proc;
      rpc = null;
      proc = null;
      if (failedRpc) failedRpc.close(e instanceof Error ? e : new Error('MCP initialization failed'));
      if (failedProc && failedProc.kill) {
        try { failedProc.kill(); } catch (killError) { /* best effort */ }
      }
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
    serverInfo = null;
    startPromise = null;
  }

  return { start, listTools, callTool, stop, state: currentState, getServerInstructions: () => serverInstructions };
}
