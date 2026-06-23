// Embedded ZCode chat backend.
//
// Spawns the ZCode CLI (`zcode.cjs app-server`) as a stdio JSON-RPC server and
// drives it through the ZCode Protocol (NOT standard MCP — messages omit the
// `jsonrpc` envelope; the server strict-parses and rejects it). Login state is
// shared with the ZCode Electron app via ~/.zcode/v2/config.json, and the ae
// MCP server is already registered in ~/.zcode/cli/config.json, so unlike the
// codex/opencode backends we do NOT inject mcp_servers here — ZCode connects
// to ae-mcp on its own.
//
// Protocol (verified live against zcode.cjs 0.14.8, see C0 probe notes):
//   session/create  {workspace:{workspacePath,workspaceKey}, mode} -> result.session.sessionId
//   session/subscribe {sessionId, deliveryKind:"desktop-continuous"}  -> streams notifications
//   session/send    {sessionId, content} -> {accepted:true}
//   session/stop    {sessionId}
//   session/messages {sessionId} -> {messages:[...]}
// Events (notifications, payload under .payload):
//   turn.started, model.streaming {delta, kind:"text_delta", done}, tool.updated,
//   permission.requested {toolCallId, toolName, riskLevel, options[]},
//   permission.resolved, turn.completed {response, usage}
// Approval is answered via elicitation/create.
//
// Message format: {method, params, id?} — NO jsonrpc field (server rejects it).

import { createNdjsonReader } from '../lib/ndjson.js';
import { resolveSystemNode } from './claudeAgentBackend.js';

const RPC_TIMEOUT_MS = 30000;
const STDERR_TAIL_LIMIT = 4096;
const DELIVERY_KIND = 'desktop-continuous';

// ZCode permission modes map onto the panel's four approval tiers.
const MODE_BY_TIER = {
  readonly: 'plan',
  manual: 'build',
  auto: 'edit',
  none: 'yolo',
};

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

function appendTail(tail, chunk) {
  const next = tail + String(chunk || '');
  return next.length > STDERR_TAIL_LIMIT ? next.slice(next.length - STDERR_TAIL_LIMIT) : next;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

// Resolve the ZCode CLI bundle. Checks the env override first, then the
// standard install path under LOCALAPPDATA, then `where zcode` on PATH.
async function resolveZcodeCli({ env, execFileImpl }) {
  const override = env && env.AE_MCP_ZCODE_CLI;
  if (override) return { ok: true, cliPath: override };

  const localAppData = env && (env.LOCALAPPDATA || env.LocalAppData);
  if (localAppData) {
    const path = localAppData + '\\Programs\\ZCode\\resources\\glm\\zcode.cjs';
    try {
      await statFile(path);
      return { ok: true, cliPath: path };
    } catch (e) { /* not installed here, fall through */ }
  }

  // Last resort: a `zcode` shim on PATH (rare; the installer is Electron-only).
  const execFile = execFileImpl || getCepRequire()('child_process').execFile;
  try {
    const where = await execFileAsync(execFile, 'where', ['zcode'], env || {});
    if (!where.err && where.stdout) {
      const exe = String(where.stdout).split(/\r?\n/)[0].trim();
      if (exe) return { ok: true, cliPath: exe, isExe: true };
    }
  } catch (e) { /* ignore */ }

  return { ok: false, detail: 'ZCode CLI not found. Install ZCode or set AE_MCP_ZCODE_CLI to the zcode.cjs path.' };
}

function statFile(path) {
  const fs = getCepRequire()('fs');
  return new Promise((resolve, reject) => fs.stat(path, (err) => (err ? reject(err) : resolve())));
}

function execFileAsync(execFile, cmd, args, env) {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// Minimal RPC for ZCode's stripped protocol (no jsonrpc field).
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
    if (!message || typeof message !== 'object') return;
    const hasId = message.id !== undefined && message.id !== null;

    if (hasId && !message.method) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        const error = new Error(message.error.message || 'ZCode request failed');
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
    const message = { id, method };
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
    const message = { id, method };
    if (params !== undefined) message.params = params;
    writeMessage(message);
    return id;
  }

  function respond(id, result) {
    writeMessage({ id, result });
  }

  function respondError(id, code, message) {
    writeMessage({ id, error: { code, message } });
  }

  function close(reason = new Error('ZCode app-server closed')) {
    for (const id of Array.from(pending.keys())) rejectPending(id, reason);
  }

  return { request, fireRequest, respond, respondError, close, handleMessage };
}

function mcpToolName(name) {
  const text = String(name || '');
  return text.startsWith('mcp__') ? text : 'mcp__ae__' + text;
}

export function createZcodeBackend({
  spawnImpl,
  getModel,
  getPermissionMode,
  getToolMeta,
  getExpertGuidance = () => true,
  getServerInstructions = () => '',
  onEvent,
  lang = 'zh',
  env,
  resolveCli = resolveZcodeCli,
  resolveNode = resolveSystemNode,
}) {
  let proc = null;
  let rpc = null;
  let startPromise = null;
  let sessionPromise = null;
  let sessionId = null;
  let subscribed = false;
  let stopping = false;
  let stderrTail = '';
  let transcript = [];
  let activeRun = null;
  let activeResolve = null;
  let activeAssistantText = '';
  let toolMeta = { allowedTools: [], annotations: {} };
  const pendingApprovals = new Map();
  const sessionAllowedTools = new Set();

  function emit(evt) {
    if (onEvent) onEvent(evt);
  }

  function getSpawn() {
    if (spawnImpl) return spawnImpl;
    return getCepRequire()('child_process').spawn;
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
      if (rpc) rpc.respond(approval.rpcId, { decision: 'decline' });
      pendingApprovals.delete(toolUseId);
      emit({ type: 'tool-denied', toolUseId });
    }
  }

  function handleNotification(message) {
    const params = message.params || {};
    const type = params.type || message.method;

    if (type === 'turn.started') {
      emit({ type: 'turn-start' });
      return;
    }
    if (type === 'model.streaming') {
      const payload = params.payload || {};
      if (payload.kind === 'text_delta' && payload.delta) {
        activeAssistantText += String(payload.delta);
        emit({ type: 'text-delta', text: String(payload.delta) });
      }
      return;
    }
    if (type === 'tool.updated' || type === 'part.started' || type === 'part.upserted') {
      const payload = params.payload || {};
      if (payload.toolName || payload.tool) {
        // Heuristic: parts carrying a tool name signal a tool call boundary.
        emit({
          type: 'tool-start',
          toolUseId: String(payload.toolCallId || payload.id || ''),
          name: mcpToolName(payload.toolName || payload.tool),
          input: payload.input || payload.arguments,
        });
      }
      return;
    }
    if (type === 'permission.requested') {
      handlePermissionRequest(params);
      return;
    }
    if (type === 'turn.completed') {
      drainApprovals();
      const payload = params.payload || {};
      emit({ type: 'turn-end', stopReason: 'end_turn' });
      transcript.push({ role: 'assistant', text: activeAssistantText || payload.response || '' });
      finishActive();
      return;
    }
    if (type === 'turn.failed') {
      const payload = params.payload || {};
      const message = payload.error || payload.message || 'ZCode turn failed';
      emit({ type: 'error', kind: 'mcp', message: String(message) });
      finishActive();
      return;
    }
  }

  function handlePermissionRequest(params) {
    const payload = params.payload || params;
    const toolUseId = String(payload.toolCallId || '');
    const name = mcpToolName(payload.toolName || '');
    const input = payload.input || {};
    const riskLevel = payload.riskLevel || 'medium';
    const annotations = (toolMeta && toolMeta.annotations) || {};
    const ann = annotations[name] || {};
    const tier = getPermissionMode ? getPermissionMode() : 'manual';

    // rpcId: ZCode sends permission.requested as a notification, so there is no
    // request id to reply to. We stash the requestId if present and resolve via
    // elicitation/create; otherwise we rely on session-level allow/deny sets.
    const requestId = payload.requestId || null;

    if (sessionAllowedTools.has(name) || ann.readOnly || tier === 'none' || (tier === 'auto' && !ann.destructive && riskLevel === 'low')) {
      if (requestId && rpc) rpc.respond(requestId, { decision: 'allow' });
      emit({ type: 'tool-allowed', toolUseId });
      return;
    }

    if (tier === 'readonly') {
      if (requestId && rpc) rpc.respond(requestId, { decision: 'decline' });
      emit({ type: 'tool-denied', toolUseId });
      return;
    }

    pendingApprovals.set(toolUseId, { rpcId: requestId, name, input });
    emit({
      type: 'approval-required',
      toolUseId,
      name,
      input,
      risk: ann.destructive ? 'destructive' : 'write',
    });
  }

  function handleExit(code, signal) {
    const wasStopping = stopping;
    const detail = stderrTail ? String(code) + (signal ? ' ' + signal : '') + ' ' + stderrTail : String(code) + (signal ? ' ' + signal : '');
    if (rpc) rpc.close(new Error('ZCode app-server exited: ' + detail));
    proc = null;
    rpc = null;
    startPromise = null;
    sessionPromise = null;
    sessionId = null;
    subscribed = false;
    if (wasStopping) return;
    if (activeRun) {
      emit({ type: 'error', kind: 'mcp', message: 'ZCode app-server exited: ' + detail });
      finishActive();
    }
  }

  function handleError(error) {
    const err = error instanceof Error ? error : new Error('ZCode app-server error');
    if (rpc) rpc.close(err);
    proc = null;
    rpc = null;
    startPromise = null;
    sessionPromise = null;
    sessionId = null;
    subscribed = false;
    if (activeRun) {
      emit({ type: 'error', kind: 'mcp', message: err.message });
      finishActive();
    }
  }

  async function startProcess() {
    if (proc && rpc) return true;
    if (startPromise) return startPromise;
    startPromise = (async () => {
      // execFileImpl is resolved lazily so tests can inject resolveCli without
      // a CEP Node environment being present (getCepRequire would throw).
      let execFileImpl = null;
      try { execFileImpl = getCepRequire()('child_process').execFile; } catch (e) { /* non-CEP env */ }
      const cli = await resolveCli({ env: currentEnv(), execFileImpl });
      if (!cli.ok) throw new Error(cli.detail);

      const spawn = getSpawn();
      const spawnEnv = currentEnv();
      stderrTail = '';
      stopping = false;

      let cmd;
      let cmdArgs;
      if (cli.isExe) {
        // A real `zcode` executable on PATH.
        cmd = cli.cliPath;
        cmdArgs = ['app-server'];
      } else {
        // zcode.cjs — spawn via system Node (matches the claudeAgentBackend pattern).
        const node = await resolveNode({ env: spawnEnv });
        if (!node.ok) throw new Error(node.detail);
        cmd = node.nodePath;
        cmdArgs = [cli.cliPath, 'app-server'];
      }

      proc = spawn(cmd, cmdArgs, {
        stdio: 'pipe',
        windowsHide: true,
        env: spawnEnv,
      });
      rpc = createRpc({
        writeLine: (line) => proc.stdin.write(line),
        onNotification: handleNotification,
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

  function workspaceFromEnv(spawnEnv) {
    // ZCode keys sessions by workspace; derive from the panel extension root.
    const extRoot = spawnEnv && (spawnEnv.AE_MCP_PANEL_EXT_ROOT || spawnEnv.EXTENSION_ROOT);
    const path = extRoot ? String(extRoot).replace(/\//g, '\\').replace(/\\+$/, '') : (spawnEnv && (spawnEnv.TEMP || spawnEnv.TMP) || '.');
    const key = path.replace(/\\/g, '\\');
    return { workspacePath: path, workspaceKey: key };
  }

  function modeFromTier() {
    const tier = getPermissionMode ? getPermissionMode() : 'manual';
    return MODE_BY_TIER[tier] || 'build';
  }

  async function ensureSession() {
    if (sessionId) return sessionId;
    if (sessionPromise) return sessionPromise;
    sessionPromise = (async () => {
      await startProcess();
      toolMeta = getToolMeta ? await getToolMeta() : { allowedTools: [], annotations: {} };
      const spawnEnv = currentEnv();
      const result = await rpc.request('session/create', {
        workspace: workspaceFromEnv(spawnEnv),
        mode: modeFromTier(),
      });
      sessionId = (result && result.session && result.session.sessionId) || null;
      if (!sessionId) throw new Error('ZCode session/create returned no sessionId');

      // Subscribe to the event stream. desktop-continuous streams turn events
      // as notifications for the life of the subscription.
      if (!subscribed) {
        rpc.fireRequest('session/subscribe', { sessionId, deliveryKind: DELIVERY_KIND });
        subscribed = true;
      }
      return sessionId;
    })();
    try {
      return await sessionPromise;
    } finally {
      sessionPromise = null;
    }
  }

  async function sendUser(text) {
    if (activeRun) return activeRun;
    activeAssistantText = '';
    activeRun = new Promise((resolve) => {
      activeResolve = resolve;
    });

    try {
      await ensureSession();
      const userText = String(text || '');
      transcript.push({ role: 'user', text: userText });

      // ZCode (like Codex) does not forward the ae-mcp server instructions to
      // the model, so prepend them as a one-shot preamble on the first turn.
      let turnText = userText;
      if (transcript.filter((m) => m.role === 'user').length === 1) {
        const instr = (getServerInstructions() || '').trim();
        if (instr) turnText = instr + '\n\n---\n\n' + userText;
      }

      // session/send resolves on acceptance, long before turn.completed.
      rpc.request('session/send', { sessionId, content: turnText }, 180000).catch((e) => {
        const message = e && e.message ? e.message : 'Failed to start ZCode turn.';
        emit({ type: 'error', kind: /model/i.test(message) ? 'model' : 'mcp', message });
        finishActive();
      });
    } catch (e) {
      emit({ type: 'error', kind: 'mcp', message: e && e.message ? e.message : 'Failed to start ZCode turn.' });
      finishActive();
    }
    return activeRun;
  }

  function approve(toolUseId, decision) {
    const id = String(toolUseId);
    const approval = pendingApprovals.get(id);
    if (!approval) return;
    pendingApprovals.delete(id);
    const allow = decision !== 'deny';
    if (allow && decision === 'allow-session') sessionAllowedTools.add(approval.name);
    if (approval.rpcId && rpc) rpc.respond(approval.rpcId, { decision: allow ? 'allow' : 'decline' });
    emit({ type: allow ? 'tool-allowed' : 'tool-denied', toolUseId: id });
  }

  function stop() {
    if (rpc && sessionId) {
      rpc.fireRequest('session/stop', { sessionId });
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
    if (rpc) rpc.close(new Error('ZCode backend reset'));
    if (proc) {
      try { proc.kill(); } catch (e) { /* best effort */ }
    }
    proc = null;
    rpc = null;
    startPromise = null;
    sessionPromise = null;
    sessionId = null;
    subscribed = false;
    transcript = [];
    pendingApprovals.clear();
    sessionAllowedTools.clear();
    toolMeta = { allowedTools: [], annotations: {} };
    finishActive();
    stderrTail = '';
    stopping = false;
  }

  async function probeAccount() {
    try {
      await ensureSession();
      // session/create already returned settings.model.available + current.
      // Re-fetch the session to surface provider/login info.
      let models = null;
      try {
        const msgs = await rpc.request('session/messages', { sessionId });
        // session/messages confirms the session is live; models come from the
        // create result which we don't retain here, so report loggedIn on liveness.
        models = null;
      } catch (e) { /* liveness check only */ }
      return { loggedIn: true, provider: 'zcode', models };
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
