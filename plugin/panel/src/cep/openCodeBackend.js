import { createSseParser } from '../lib/sse.js';
import { expertGuidanceEnv } from './externalClients.js';

const MCP_TIMEOUT_MS = 120000;
const READY_TIMEOUT_MS = 30000;
const READY_POLL_MS = 250;
const DEFAULT_PROVIDER_ID = 'opencode';
const DEFAULT_MODEL_ID = 'north-mini-code-free';

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

function defaultFetch() {
  if (globalThis.window && globalThis.window.fetch) return globalThis.window.fetch.bind(globalThis.window);
  if (globalThis.fetch) return globalThis.fetch.bind(globalThis);
  throw new Error('fetch is unavailable');
}

function defaultFs() {
  return getCepRequire()('fs');
}

function defaultOs() {
  return getCepRequire()('os');
}

function defaultPath() {
  return getCepRequire()('path');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendTail(tail, chunk) {
  const next = tail + String(chunk || '');
  return next.length > 4096 ? next.slice(next.length - 4096) : next;
}

function decodeChunk(value) {
  if (typeof value === 'string') return value;
  return new TextDecoder().decode(value);
}

function randomTempName() {
  return 'ae-opencode-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

async function defaultGetPort() {
  const net = getCepRequire()('net');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function asCommandArray(mcpSpec) {
  const command = mcpSpec && mcpSpec.command ? String(mcpSpec.command) : 'ae-mcp';
  const args = mcpSpec && Array.isArray(mcpSpec.args) ? mcpSpec.args.map(String) : [];
  return [command].concat(args);
}

function prefixedToolName(raw) {
  const text = String(raw || '');
  if (!text) return '';
  if (text.startsWith('mcp__')) return text;
  // opencode names an MCP tool "<server>_<tool>" — ae's ae_ping becomes
  // "ae_ae_ping". Strip the single "ae_" server prefix once -> "ae_ping".
  return 'mcp__ae__' + text.replace(/^ae_/, '');
}

function eventType(evt) {
  return evt && (evt.type || evt.event || evt.kind || evt.name);
}

function eventSessionId(evt) {
  return evt && (evt.sessionID || evt.sessionId || evt.session_id || (evt.session && evt.session.id));
}

function eventToolId(evt) {
  return String((evt && (evt.callID || evt.callId || evt.toolCallID || evt.toolCallId || evt.id || (evt.call && evt.call.id))) || '');
}

function eventPermissionId(evt) {
  return String((evt && (evt.permissionID || evt.permissionId || evt.id || evt.requestID || evt.requestId)) || eventToolId(evt));
}

function eventToolName(evt) {
  return prefixedToolName(evt && (
    evt.tool ||
    evt.toolName ||
    evt.name ||
    (evt.call && (evt.call.tool || evt.call.name)) ||
    (evt.permission && (evt.permission.tool || evt.permission.name))
  ));
}

function eventInput(evt) {
  if (!evt || typeof evt !== 'object') return {};
  if (evt.input !== undefined) return evt.input;
  if (evt.arguments !== undefined) return evt.arguments;
  if (evt.args !== undefined) return evt.args;
  if (evt.call && evt.call.input !== undefined) return evt.call.input;
  if (evt.permission && evt.permission.input !== undefined) return evt.permission.input;
  return {};
}

function eventOutputText(evt) {
  const value = evt && (evt.output !== undefined ? evt.output : evt.result !== undefined ? evt.result : evt.error);
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch (e) {
    return String(value);
  }
}

function parseModel(value) {
  const raw = String(value || DEFAULT_MODEL_ID);
  if (raw.includes('/')) {
    const [providerID, ...rest] = raw.split('/');
    return { id: rest.join('/') || DEFAULT_MODEL_ID, providerID: providerID || DEFAULT_PROVIDER_ID };
  }
  if (raw.includes(':')) {
    const [providerID, ...rest] = raw.split(':');
    return { id: rest.join(':') || DEFAULT_MODEL_ID, providerID: providerID || DEFAULT_PROVIDER_ID };
  }
  return { id: raw, providerID: DEFAULT_PROVIDER_ID };
}

function permissionRuleset(mode) {
  if (mode === 'none') return { type: 'allow' };
  return { type: 'ask' };
}

function permissionReplyBody(decision) {
  if (decision === 'deny') return { action: 'deny', remember: false };
  return { action: 'allow', remember: decision === 'allow-session' };
}

function permissionReplyPath(sessionId, permissionId) {
  return '/session/' + encodeURIComponent(sessionId) + '/permission/' + encodeURIComponent(permissionId);
}

export function createOpenCodeBackend({
  spawnImpl,
  fetchImpl,
  getPort = defaultGetPort,
  fsImpl,
  osImpl,
  pathImpl,
  tempDirName = randomTempName,
  getModel,
  getPermissionMode,
  getMcpSpec,
  getToolMeta,
  getExpertGuidance = () => true,
  onEvent,
  env,
} = {}) {
  let proc = null;
  let port = null;
  let baseUrl = '';
  let configHome = '';
  let sessionId = null;
  let serverPromise = null;
  let sessionPromise = null;
  let sseStarted = false;
  let sseClosed = false;
  let stopping = false;
  let stderrTail = '';
  let activeRun = null;
  let activeResolve = null;
  let activeAssistantText = '';
  let turnStarted = false;
  let toolMeta = { annotations: {} };
  const pendingApprovals = new Map();
  const sessionAllowedTools = new Set();
  const startedTools = new Set();
  const transcript = [];

  function emit(evt) {
    if (onEvent) onEvent(evt);
  }

  function fetcher() {
    return fetchImpl || defaultFetch();
  }

  function currentEnv() {
    return Object.assign({}, getCepEnv(), env || {});
  }

  function finishActive() {
    if (!activeResolve) {
      activeRun = null;
      activeAssistantText = '';
      turnStarted = false;
      startedTools.clear();
      return;
    }
    const resolve = activeResolve;
    activeResolve = null;
    activeRun = null;
    activeAssistantText = '';
    turnStarted = false;
    startedTools.clear();
    resolve();
  }

  async function request(path, options = {}) {
    const response = await fetcher()(baseUrl + path, options);
    if (!response || !response.ok) {
      const text = response && response.text ? await response.text().catch(() => '') : '';
      throw new Error('OpenCode HTTP ' + (response ? response.status : 'error') + (text ? ': ' + text : ''));
    }
    return response;
  }

  async function requestJson(path, options = {}) {
    const response = await request(path, options);
    return response.json ? response.json() : {};
  }

  async function postJson(path, body) {
    return requestJson(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  }

  async function waitForMcp() {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const status = await requestJson('/mcp');
        if (status && status.ae && status.ae.status === 'connected') return true;
      } catch (e) {
        lastError = e;
      }
      await sleep(READY_POLL_MS);
    }
    throw lastError || new Error('OpenCode MCP server did not become ready.');
  }

  function writeConfig(mcpSpec) {
    const fs = fsImpl || defaultFs();
    const os = osImpl || defaultOs();
    const path = pathImpl || defaultPath();
    configHome = path.join(os.tmpdir(), tempDirName());
    const configDir = path.join(configHome, 'opencode');
    fs.mkdirSync(configDir, { recursive: true });
    const config = {
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        ae: {
          type: 'local',
          command: asCommandArray(mcpSpec),
          enabled: true,
          timeout: MCP_TIMEOUT_MS,
          environment: Object.assign({}, (mcpSpec && mcpSpec.env) || {}, {
            AE_MCP_BACKEND: 'ae-mcp',
            ...expertGuidanceEnv(getExpertGuidance()),
          }),
        },
      },
    };
    fs.writeFileSync(path.join(configDir, 'opencode.json'), JSON.stringify(config, null, 2));
  }

  function handleExit(code, signal) {
    const wasStopping = stopping;
    proc = null;
    serverPromise = null;
    sessionPromise = null;
    sessionId = null;
    sseClosed = true;
    sseStarted = false;
    if (wasStopping) return;
    if (activeRun) {
      const detail = stderrTail ? String(code) + (signal ? ' ' + signal : '') + ' ' + stderrTail : String(code) + (signal ? ' ' + signal : '');
      emit({ type: 'error', kind: 'mcp', message: 'opencode serve exited: ' + detail });
      finishActive();
    }
  }

  function handleError(error) {
    proc = null;
    serverPromise = null;
    sessionPromise = null;
    sessionId = null;
    sseClosed = true;
    sseStarted = false;
    if (activeRun) {
      emit({ type: 'error', kind: 'mcp', message: error && error.message ? error.message : 'opencode serve error' });
      finishActive();
    }
  }

  async function startServer() {
    if (proc && baseUrl) return true;
    if (serverPromise) return serverPromise;
    serverPromise = (async () => {
      const mcpSpec = getMcpSpec ? await getMcpSpec() : { command: 'ae-mcp', args: [] };
      writeConfig(mcpSpec);
      port = await getPort();
      baseUrl = 'http://127.0.0.1:' + port;
      const spawn = spawnImpl || getCepRequire()('child_process').spawn;
      const spawnEnv = Object.assign({}, currentEnv(), { XDG_CONFIG_HOME: configHome });
      stderrTail = '';
      stopping = false;
      sseClosed = false;
      proc = spawn('opencode', ['serve', '--port', String(port)], {
        stdio: 'pipe',
        windowsHide: true,
        shell: true,
        env: spawnEnv,
      });
      if (proc.stderr && proc.stderr.on) proc.stderr.on('data', (chunk) => {
        stderrTail = appendTail(stderrTail, chunk);
      });
      if (proc.on) {
        proc.on('exit', (code, signal) => handleExit(code, signal));
        proc.on('error', (error) => handleError(error));
      }
      await waitForMcp();
      startSse();
      return true;
    })();
    try {
      return await serverPromise;
    } finally {
      serverPromise = null;
    }
  }

  async function readSseBody(body, parser) {
    if (!body) return;
    if (body.getReader) {
      const reader = body.getReader();
      while (!sseClosed) {
        const next = await reader.read();
        if (!next || next.done) break;
        parser.feed(decodeChunk(next.value));
      }
      return;
    }
    if (body[Symbol.asyncIterator]) {
      for await (const chunk of body) {
        if (sseClosed) break;
        parser.feed(decodeChunk(chunk));
      }
    }
  }

  function startSse() {
    if (sseStarted) return;
    sseStarted = true;
    const parser = createSseParser(({ data }) => handleOpenCodeEvent(data));
    request('/event').then((response) => readSseBody(response.body, parser)).catch((e) => {
      if (!sseClosed && activeRun) {
        emit({ type: 'error', kind: 'mcp', message: e && e.message ? e.message : 'OpenCode event stream failed.' });
        finishActive();
      }
    });
  }

  async function ensureSession() {
    if (sessionId) return sessionId;
    if (sessionPromise) return sessionPromise;
    sessionPromise = (async () => {
      await startServer();
      toolMeta = getToolMeta ? await getToolMeta() : { annotations: {} };
      const result = await postJson('/session', {
        title: 'After Effects MCP',
        model: parseModel(getModel ? getModel() : DEFAULT_MODEL_ID),
        permission: permissionRuleset(getPermissionMode ? getPermissionMode() : 'manual'),
      });
      sessionId = String((result && (result.id || result.sessionID || result.sessionId)) || '');
      if (!sessionId) throw new Error('OpenCode did not return a session id.');
      return sessionId;
    })();
    try {
      return await sessionPromise;
    } finally {
      sessionPromise = null;
    }
  }

  function annFor(name) {
    const annotations = (toolMeta && toolMeta.annotations) || {};
    return annotations[name] || {};
  }

  async function replyPermission(permissionId, decision) {
    if (!sessionId || !permissionId) return;
    await postJson(permissionReplyPath(sessionId, permissionId), permissionReplyBody(decision));
  }

  async function autoReply(permissionId, decision) {
    try {
      await replyPermission(permissionId, decision);
    } catch (e) {
      emit({ type: 'error', kind: 'mcp', message: e && e.message ? e.message : 'Failed to reply to OpenCode permission request.' });
    }
  }

  function handlePermission(evt) {
    const permissionId = eventPermissionId(evt);
    const name = eventToolName(evt);
    const input = eventInput(evt) || {};
    const ann = annFor(name);
    const tier = getPermissionMode ? getPermissionMode() : 'manual';

    if (sessionAllowedTools.has(name) || ann.readOnly || tier === 'none' || (tier === 'auto' && !ann.destructive)) {
      autoReply(permissionId, 'allow');
      return;
    }
    if (tier === 'readonly') {
      autoReply(permissionId, 'deny');
      emit({ type: 'tool-denied', toolUseId: permissionId });
      return;
    }

    pendingApprovals.set(permissionId, { name, input });
    emit({
      type: 'approval-required',
      toolUseId: permissionId,
      name,
      input,
      risk: ann.destructive ? 'destructive' : 'write',
    });
  }

  function handleToolPart(part) {
    const toolUseId = String(part.callID || part.id || '');
    if (!toolUseId) return;
    const name = prefixedToolName(part.tool || part.name);
    const state = part.state || {};
    const status = state.status;
    if (status === 'completed' || status === 'error') {
      const ms = state.time && Number.isFinite(state.time.start) && Number.isFinite(state.time.end)
        ? state.time.end - state.time.start
        : undefined;
      emit({
        type: 'tool-result',
        toolUseId,
        name,
        ok: status === 'completed',
        text: typeof state.output === 'string' ? state.output : eventOutputText(state),
        durationMs: ms,
      });
      return;
    }
    // pending / running -> tool-start (once)
    if (startedTools.has(toolUseId)) return;
    startedTools.add(toolUseId);
    emit({ type: 'tool-start', toolUseId, name, input: state.input || {} });
  }

  // Real opencode SSE wire model (live-verified): every event is
  // { type, properties } with dotted lowercase types. Text/tool/reasoning ride
  // message.part.*; turn lifecycle rides session.status (busy/idle).
  function handleOpenCodeEvent(evt) {
    const type = eventType(evt);
    if (!type) return;
    const p = (evt && evt.properties) || {};
    if (sessionId && p.sessionID && p.sessionID !== sessionId) return;

    if (type === 'session.status') {
      const st = (p.status && p.status.type) || '';
      if (st === 'busy') {
        if (!turnStarted) { turnStarted = true; emit({ type: 'turn-start' }); }
      } else if (st === 'idle') {
        drainApprovals();
        emit({ type: 'turn-end', stopReason: 'end_turn' });
        transcript.push({ role: 'assistant', text: activeAssistantText });
        finishActive();
      }
      return;
    }
    if (type === 'message.part.delta') {
      if (p.field === 'text') {
        emit({ type: 'thinking', active: false });
        const text = p.delta;
        if (text) { activeAssistantText += String(text); emit({ type: 'text-delta', text: String(text) }); }
      } else if (p.field === 'reasoning') {
        emit({ type: 'thinking', active: true });
      }
      return;
    }
    if (type === 'message.part.updated') {
      const part = p.part || {};
      if (part.type === 'tool') handleToolPart(part);
      else if (part.type === 'reasoning') emit({ type: 'thinking', active: true });
      return;
    }
    if (type === 'session.error') {
      const error = p.error || p;
      emit({ type: 'error', kind: error.kind || 'mcp', message: error.message || String(error || 'OpenCode session error') });
      finishActive();
      return;
    }
    // Permission ask: exact wire type unverified (ae_ping is read-only so it
    // never fired in acceptance); match defensively on a permission-ish type.
    if (/permission/i.test(String(type)) && /ask/i.test(String(type))) {
      handlePermission({ ...p, properties: p });
    }
  }

  function drainApprovals() {
    const replies = [];
    for (const [permissionId] of Array.from(pendingApprovals.entries())) {
      pendingApprovals.delete(permissionId);
      replies.push(autoReply(permissionId, 'deny'));
      emit({ type: 'tool-denied', toolUseId: permissionId });
    }
    return Promise.allSettled(replies);
  }

  async function sendUser(text) {
    if (activeRun) return activeRun;
    activeAssistantText = '';
    activeRun = new Promise((resolve) => {
      activeResolve = resolve;
    });
    try {
      const id = await ensureSession();
      const userText = String(text || '');
      transcript.push({ role: 'user', text: userText });
      await postJson('/session/' + encodeURIComponent(id) + '/message', {
        parts: [{ type: 'text', text: userText }],
      });
    } catch (e) {
      emit({ type: 'error', kind: 'mcp', message: e && e.message ? e.message : 'Failed to start OpenCode turn.' });
      finishActive();
    }
    return activeRun;
  }

  async function approve(toolUseId, decision) {
    const id = String(toolUseId);
    const approval = pendingApprovals.get(id);
    if (!approval) return;
    pendingApprovals.delete(id);
    if (decision === 'allow-session') sessionAllowedTools.add(approval.name);
    await replyPermission(id, decision);
    if (decision === 'deny') emit({ type: 'tool-denied', toolUseId: id });
    else emit({ type: 'tool-allowed', toolUseId: id });
  }

  async function stop() {
    if (sessionId) {
      await postJson('/session/' + encodeURIComponent(sessionId) + '/interrupt', {}).catch(() => {});
    }
    await drainApprovals();
    if (activeRun) {
      emit({ type: 'error', kind: 'aborted', message: 'Turn aborted.' });
      finishActive();
    }
  }

  function reset() {
    stopping = true;
    sseClosed = true;
    sseStarted = false;
    pendingApprovals.clear();
    sessionAllowedTools.clear();
    sessionId = null;
    sessionPromise = null;
    activeResolve = null;
    activeRun = null;
    activeAssistantText = '';
    turnStarted = false;
    startedTools.clear();
    transcript.length = 0;
    if (proc && proc.kill) proc.kill();
    proc = null;
    serverPromise = null;
    try {
      if (configHome) {
        const fs = fsImpl || defaultFs();
        fs.rmSync(configHome, { recursive: true, force: true });
      }
    } catch (e) {
      // best-effort cleanup
    }
  }

  async function probeAccount() {
    try {
      await startServer();
      const providers = await requestJson('/config/providers').catch(() => requestJson('/provider'));
      return { loggedIn: true, models: providers };
    } catch (e) {
      return { loggedIn: false, detail: e && e.message ? e.message : String(e) };
    }
  }

  function getMessages() {
    return transcript.slice();
  }

  return { sendUser, approve, stop, reset, getMessages, probeAccount };
}
