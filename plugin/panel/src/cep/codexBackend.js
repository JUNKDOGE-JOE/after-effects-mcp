import { createNdjsonReader } from '../lib/ndjson.js';
import { PANEL_VERSION } from './mcpClient.js';

const RPC_TIMEOUT_MS = 30000;
const STDERR_TAIL_LIMIT = 4096;
const APPROVAL_POLICY = {
  granular: { mcp_elicitations: true, rules: true, sandbox_approval: true },
};
// Tagged union per the protocol schema: ReadOnlySandboxPolicy.
const SANDBOX_POLICY = { type: 'readOnly' };

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

function defaultFs() {
  return getCepRequire()('fs');
}

function appendTail(tail, chunk) {
  const next = tail + String(chunk || '');
  return next.length > STDERR_TAIL_LIMIT ? next.slice(next.length - STDERR_TAIL_LIMIT) : next;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeFsPath(value) {
  return String(value || '').replace(/\//g, '\\').replace(/\\+$/, '');
}

function dirname(value) {
  const normalized = normalizeFsPath(value);
  const index = normalized.lastIndexOf('\\');
  if (index <= 0) return '';
  return normalized.slice(0, index);
}

function defaultCwd(env) {
  const extRoot = env && (env.AE_MCP_PANEL_EXT_ROOT || env.EXTENSION_ROOT);
  const parent = extRoot ? dirname(extRoot) : '';
  if (parent) return parent;
  if (env && (env.TEMP || env.TMP)) return env.TEMP || env.TMP;
  try {
    return getCepRequire()('os').tmpdir();
  } catch (e) {
    return '.';
  }
}

function responseMessage(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function errorMessage(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function createRpc({ writeLine, onNotification, onRequest, timeoutMs = RPC_TIMEOUT_MS }) {
  let nextId = 1;
  const pending = new Map();

  function writeMessage(message) {
    writeLine(JSON.stringify(message) + '\n');
  }

  function rejectPending(id, error) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.reject(error);
  }

  function handleMessage(message) {
    // codex app-server omits the jsonrpc field on its messages (verified
    // live: {"id":1,"result":{...}} with no envelope) - accept any parsed
    // object instead of gating on jsonrpc === '2.0'.
    if (!message || typeof message !== 'object') return;
    const hasId = message.id !== undefined && message.id !== null;

    if (hasId && !message.method) {
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
      return;
    }

    if (message.method && hasId) {
      if (onRequest) onRequest(message);
      return;
    }

    if (message.method && onNotification) onNotification(message);
  }

  function request(method, params, timeoutOverrideMs) {
    const id = nextId++;
    const message = { jsonrpc: '2.0', id, method };
    if (params !== undefined) message.params = params;
    const limit = timeoutOverrideMs || timeoutMs;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => rejectPending(id, new Error(method + ' timed out after ' + limit + 'ms')), limit);
      pending.set(id, { resolve, reject, timer });
    });
    writeMessage(message);
    return promise;
  }

  function fireRequest(method, params) {
    const id = nextId++;
    const message = { jsonrpc: '2.0', id, method };
    if (params !== undefined) message.params = params;
    writeMessage(message);
    return id;
  }

  function respond(id, result) {
    writeMessage(responseMessage(id, result));
  }

  function respondError(id, code, message) {
    writeMessage(errorMessage(id, code, message));
  }

  function close(reason = new Error('Codex app-server closed')) {
    for (const id of Array.from(pending.keys())) rejectPending(id, reason);
  }

  return { request, fireRequest, respond, respondError, close, handleMessage };
}

function prefixedToolName(params) {
  const raw = params && (params.name || params.tool || params.toolName || (params.request && params.request.tool));
  if (!raw) return '';
  const text = String(raw);
  return text.startsWith('mcp__') ? text : 'mcp__ae__' + text;
}

function elicitationInput(params) {
  if (!params || typeof params !== 'object') return params;
  if (params.arguments !== undefined) return params.arguments;
  if (params.input !== undefined) return params.input;
  if (params.request && params.request.arguments !== undefined) return params.request.arguments;
  return params;
}

function itemFromParams(params) {
  return (params && params.item) || params || {};
}

function mcpToolName(item) {
  const tool = item && (item.tool || item.name);
  return tool ? 'mcp__ae__' + String(tool).replace(/^mcp__ae__/, '') : '';
}

function toolResultText(result) {
  const content = result && Array.isArray(result.content) ? result.content : [];
  return content.filter((part) => part && part.type === 'text').map((part) => String(part.text || '')).join('');
}

function threadIdFromResult(result) {
  return (result && (result.threadId || result.id || (result.thread && result.thread.id))) || null;
}

export function createCodexBackend({
  spawnImpl,
  getModel,
  getEffort,
  getFast,
  getPermissionMode,
  getMcpSpec,
  onEvent,
  lang = 'zh',
  tierFilePath,
  fsImpl,
  env,
}) {
  let proc = null;
  let rpc = null;
  let startPromise = null;
  let initializePromise = null;
  let initialized = false;
  let threadId = null;
  let currentTurnId = null;
  let stopping = false;
  let stderrTail = '';
  let transcript = [];
  let activeRun = null;
  let activeResolve = null;
  let activeAssistantText = '';
  const pendingApprovals = new Map();

  function emit(evt) {
    if (onEvent) onEvent(evt);
  }

  function getSpawn() {
    if (spawnImpl) return spawnImpl;
    return getCepRequire()('child_process').spawn;
  }

  function getFs() {
    return fsImpl || defaultFs();
  }

  function writeTierFile() {
    if (!tierFilePath) return;
    getFs().writeFileSync(tierFilePath, String(getPermissionMode ? getPermissionMode() : 'manual'));
  }

  function currentEnv() {
    return Object.assign({}, getCepEnv(), env || {});
  }

  function finishActive() {
    if (!activeResolve) {
      activeRun = null;
      activeAssistantText = '';
      return;
    }
    const resolve = activeResolve;
    activeResolve = null;
    activeRun = null;
    activeAssistantText = '';
    resolve();
  }

  function drainApprovals() {
    for (const [toolUseId, approval] of Array.from(pendingApprovals.entries())) {
      if (rpc) rpc.respond(approval.rpcId, { action: 'decline', content: {} });
      pendingApprovals.delete(toolUseId);
      emit({ type: 'tool-denied', toolUseId });
    }
  }

  function handleNotification(message) {
    const params = message.params || {};
    if (message.method === 'turn/started') {
      currentTurnId = (params.turn && params.turn.id) || params.turnId || null;
      emit({ type: 'turn-start' });
      return;
    }
    if (message.method === 'item/agentMessage/delta') {
      const text = params.delta !== undefined ? params.delta : params.text;
      if (text) {
        activeAssistantText += String(text);
        emit({ type: 'text-delta', text: String(text), phase: params.phase });
      }
      return;
    }
    if (message.method === 'item/started') {
      const item = itemFromParams(params);
      if (item.type !== 'mcpToolCall') return;
      emit({
        type: 'tool-start',
        toolUseId: String(item.id || ''),
        name: mcpToolName(item),
        input: item.arguments,
      });
      return;
    }
    if (message.method === 'item/completed') {
      const item = itemFromParams(params);
      if (item.type !== 'mcpToolCall') return;
      emit({
        type: 'tool-result',
        toolUseId: String(item.id || ''),
        name: mcpToolName(item),
        ok: !item.error && item.status === 'completed',
        text: toolResultText(item.result),
        durationMs: item.durationMs,
      });
      return;
    }
    if (message.method === 'turn/completed') {
      currentTurnId = null;
      drainApprovals();
      emit({ type: 'turn-end', stopReason: 'end_turn' });
      transcript.push({ role: 'assistant', text: activeAssistantText });
      finishActive();
      return;
    }
    if (message.method === 'error') {
      const error = params.error || params;
      emit({ type: 'error', kind: error.kind || 'mcp', message: error.message || String(error || 'Codex app-server error') });
      finishActive();
    }
  }

  function handleRequest(message) {
    if (message.method !== 'mcpServer/elicitation/request') {
      if (rpc) rpc.respondError(message.id, -32601, 'Method not found');
      return;
    }
    const toolUseId = String(message.id);
    const params = message.params || {};
    const approval = {
      rpcId: message.id,
      name: prefixedToolName(params),
      input: elicitationInput(params),
    };
    pendingApprovals.set(toolUseId, approval);
    emit({
      type: 'approval-required',
      toolUseId,
      name: approval.name,
      input: approval.input,
    });
  }

  function handleExit(code, signal) {
    const wasStopping = stopping;
    const detail = stderrTail ? String(code) + (signal ? ' ' + signal : '') + ' ' + stderrTail : String(code) + (signal ? ' ' + signal : '');
    if (rpc) rpc.close(new Error('codex app-server exited: ' + detail));
    proc = null;
    rpc = null;
    startPromise = null;
    initializePromise = null;
    initialized = false;
    threadId = null;
    if (wasStopping) return;
    if (activeRun) {
      emit({ type: 'error', kind: 'mcp', message: 'codex app-server exited: ' + detail });
      finishActive();
    }
  }

  function handleError(error) {
    const err = error instanceof Error ? error : new Error('codex app-server error');
    if (rpc) rpc.close(err);
    proc = null;
    rpc = null;
    startPromise = null;
    initializePromise = null;
    initialized = false;
    threadId = null;
    if (activeRun) {
      emit({ type: 'error', kind: 'mcp', message: err.message });
      finishActive();
    }
  }

  async function startProcess() {
    if (proc && rpc) return true;
    if (startPromise) return startPromise;
    startPromise = (async () => {
      const spawn = getSpawn();
      const spawnEnv = currentEnv();
      stderrTail = '';
      stopping = false;
      proc = spawn('codex', ['app-server'], {
        stdio: 'pipe',
        windowsHide: true,
        shell: true,
        env: spawnEnv,
      });
      rpc = createRpc({
        writeLine: (line) => proc.stdin.write(line),
        onNotification: handleNotification,
        onRequest: handleRequest,
      });
      const reader = createNdjsonReader((message) => rpc && rpc.handleMessage(message));
      if (proc.stdout && proc.stdout.on) proc.stdout.on('data', reader);
      if (proc.stderr && proc.stderr.on) proc.stderr.on('data', (chunk) => {
        stderrTail = appendTail(stderrTail, chunk);
      });
      proc.on('exit', (code, signal) => handleExit(code, signal));
      proc.on('error', (error) => handleError(error));
      return true;
    })();
    try {
      return await startPromise;
    } finally {
      startPromise = null;
    }
  }

  async function initialize() {
    if (initialized) return true;
    if (initializePromise) return initializePromise;
    initializePromise = (async () => {
      await startProcess();
      await rpc.request('initialize', {
        clientInfo: { name: 'ae-mcp-panel', version: PANEL_VERSION },
        // granular askForApproval (our four-tier mapping) is gated behind
        // the experimental API surface (live error without it).
        capabilities: { experimentalApi: true },
      });
      initialized = true;
      return true;
    })();
    try {
      return await initializePromise;
    } finally {
      initializePromise = null;
    }
  }

  async function ensureThread() {
    if (threadId) return threadId;
    await initialize();
    const mcpSpec = await getMcpSpec();
    const spawnEnv = currentEnv();
    const result = await rpc.request('thread/start', {
      ephemeral: true,
      cwd: defaultCwd(spawnEnv),
      model: getModel(),
      approvalPolicy: APPROVAL_POLICY,
      approvalsReviewer: 'user',
      sandboxPolicy: SANDBOX_POLICY,
      config: {
        mcp_servers: {
          ae: {
            command: mcpSpec.command,
            args: mcpSpec.args || [],
            env: Object.assign({}, mcpSpec.env || {}, {
              AE_MCP_BACKEND: 'ae-mcp',
              AE_MCP_APPROVAL_TIER_FILE: tierFilePath,
            }),
          },
        },
      },
    });
    threadId = threadIdFromResult(result);
    return threadId;
  }

  function turnParams(text) {
    const params = {
      threadId,
      input: [{ type: 'text', text }],
      model: getModel(),
      effort: getEffort ? getEffort() : undefined,
      approvalPolicy: APPROVAL_POLICY,
      sandboxPolicy: SANDBOX_POLICY,
    };
    if (getFast && getFast()) params.serviceTier = 'priority';
    if (params.effort === undefined || params.effort === null) delete params.effort;
    return params;
  }

  async function sendUser(text) {
    if (activeRun) return activeRun;
    activeAssistantText = '';
    activeRun = new Promise((resolve) => {
      activeResolve = resolve;
    });

    try {
      writeTierFile();
      await ensureThread();
      const userText = String(text || '');
      transcript.push({ role: 'user', text: userText });
      // turn/start resolves long before turn/completed; track it so a
      // JSON-RPC error (bad model, dead thread) surfaces instead of
      // leaving the run promise spinning forever. The first ack can wait
      // on the injected ae-mcp cold start, hence the long timeout.
      rpc.request('turn/start', turnParams(userText), 180000).catch((e) => {
        const message = e && e.message ? e.message : 'Failed to start Codex turn.';
        emit({ type: 'error', kind: /model/i.test(message) ? 'model' : 'mcp', message });
        finishActive();
      });
    } catch (e) {
      emit({ type: 'error', kind: 'mcp', message: e && e.message ? e.message : 'Failed to start Codex turn.' });
      finishActive();
    }
    return activeRun;
  }

  function approve(toolUseId, decision) {
    const id = String(toolUseId);
    const approval = pendingApprovals.get(id);
    if (!approval || !rpc) return;
    pendingApprovals.delete(id);
    const action = decision === 'deny' ? 'decline' : 'accept';
    rpc.respond(approval.rpcId, { action, content: {} });
    if (action === 'decline') emit({ type: 'tool-denied', toolUseId: id });
  }

  function stop() {
    // turn/interrupt requires BOTH ids (schema: TurnInterruptParams);
    // without an active turn there is nothing to interrupt server-side.
    if (rpc && threadId && currentTurnId) {
      rpc.fireRequest('turn/interrupt', { threadId, turnId: currentTurnId });
    }
    drainApprovals();
    if (activeRun) {
      emit({ type: 'error', kind: 'aborted', message: 'Turn aborted.' });
      finishActive();
    }
  }

  function reset() {
    stopping = true;
    drainApprovals();
    if (rpc) rpc.close(new Error('Codex backend reset'));
    if (proc) {
      try { proc.kill(); } catch (e) { /* best effort */ }
    }
    proc = null;
    rpc = null;
    startPromise = null;
    initializePromise = null;
    initialized = false;
    threadId = null;
    currentTurnId = null;
    transcript = [];
    pendingApprovals.clear();
    finishActive();
    stderrTail = '';
    stopping = false;
  }

  async function probeAccount() {
    try {
      await initialize();
      const accountResult = await rpc.request('account/read', {});
      let models = null;
      try {
        const listed = await rpc.request('model/list', {});
        models = Array.isArray(listed) ? listed : listed && listed.models;
      } catch (e) {
        models = null;
      }
      const account = accountResult && accountResult.account;
      if (!account) return { loggedIn: false, detail: accountResult && accountResult.requiresOpenaiAuth ? 'OpenAI auth required' : undefined, models };
      return {
        loggedIn: true,
        email: account.email,
        planType: account.planType,
        models,
      };
    } catch (e) {
      return { loggedIn: false, detail: e && e.message ? e.message : String(e) };
    }
  }

  return {
    sendUser,
    approve,
    stop,
    reset,
    getMessages: () => clone(transcript),
    probeAccount,
  };
}
