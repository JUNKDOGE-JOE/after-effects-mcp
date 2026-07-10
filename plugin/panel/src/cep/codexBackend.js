import { createNdjsonReader } from '../lib/ndjson.js';
import { codexAppServerArgs, codexSpawnEnv, normalizeProviderProfile } from '../lib/providerProfile.js';
import { PANEL_VERSION } from './mcpClient.js';
import { expertGuidanceEnv } from './externalClients.js';
import { createPlatformAdapter } from './platform/index.js';

const RPC_TIMEOUT_MS = 30000;
const STDERR_TAIL_LIMIT = 4096;
const APPROVAL_POLICY = {
  granular: { mcp_elicitations: true, rules: false, sandbox_approval: false },
};
// Tagged union per the protocol schema: ReadOnlySandboxPolicy.
const SANDBOX_POLICY = { type: 'readOnly' };

function appendTail(tail, chunk) {
  const next = tail + String(chunk || '');
  return next.length > STDERR_TAIL_LIMIT ? next.slice(next.length - STDERR_TAIL_LIMIT) : next;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function defaultCwd(env, platform) {
  const extRoot = env && (env.AE_MCP_PANEL_EXT_ROOT || env.EXTENSION_ROOT);
  const parent = extRoot ? platform.paths.dirname(extRoot) : '';
  if (parent) return parent;
  return platform.paths.tempRoot;
}

function responseMessage(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function errorMessage(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function isTransientReconnectError(error) {
  const message = error && error.message !== undefined ? String(error.message) : '';
  // codex app-server currently exposes MCP cold-start retries only as this
  // notification text; there is no structured retry flag in the panel protocol.
  return /^reconnecting\.\.\.\s*\d+\/\d+$/i.test(message);
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
  const raw = elicitationToolName(params);
  if (!raw) return '';
  const text = String(raw);
  return text.startsWith('mcp__') ? text : 'mcp__ae__' + text;
}

function elicitationToolName(params) {
  if (!params || typeof params !== 'object') return '';
  const match = String(params.message || '').match(/run tool "([^"]+)"/);
  if (match) return match[1];
  const description = params._meta && params._meta.tool_description;
  if (description) return String(description).split('—')[0].trim();
  return params.name || params.tool || params.toolName || (params.request && params.request.tool) || '';
}

function elicitationInput(params) {
  if (!params || typeof params !== 'object') return params;
  if (params._meta && params._meta.tool_params !== undefined) return params._meta.tool_params;
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

export async function resolveCodexCli({ env, platform } = {}) {
  const adapter = platform || createPlatformAdapter();
  const requiredArch = adapter.id === 'macos-arm64' ? 'arm64' : (adapter.id === 'windows-x64' ? 'x64' : undefined);
  const resolved = await adapter.resolveExecutable('codex', { env: env || {}, ...(requiredArch ? { requiredArch } : {}) });
  if (!resolved.ok) {
    return { ok: false, cliPath: '', version: '', detail: 'codex CLI resolution failed: ' + resolved.code, resolution: resolved };
  }
  return { ok: true, cliPath: resolved.path, version: resolved.version || '', executable: resolved };
}

export function createCodexBackend({
  platform,
  getModel,
  getEffort,
  getFast,
  getPermissionMode,
  getMcpSpec,
  getToolMeta,
  getExpertGuidance = () => true,
  getServerInstructions = () => '',
  getProviderProfile = () => ({}),
  // Spec A extension: when the panel has no explicit custom provider
  // configured, inherit a model_provider already declared in
  // ~/.codex/config.toml. config.toml owns model_provider selection; the
  // panel only supplies the missing API key env var the provider needs (no
  // `-c model_provider=...` override).
  getCliConfigProvider = () => null,
  resolveCli = resolveCodexCli,
  onEvent,
  lang = 'zh',
  env,
}) {
  const adapter = platform || createPlatformAdapter();
  let proc = null;
  let rpc = null;
  let startPromise = null;
  let initializePromise = null;
  let initialized = false;
  let threadId = null;
  // Codex does not forward the ae-mcp server `instructions` to the model, so we
  // inject them once as a preamble on the first turn of each (re)started thread.
  // Reset alongside every threadId reset so a fresh thread re-sends it.
  let preambleSent = false;
  let currentTurnId = null;
  let stopping = false;
  let stderrTail = '';
  let transcript = [];
  let activeRun = null;
  let activeResolve = null;
  let activeAssistantText = '';
  let toolMeta = { allowedTools: [], annotations: {} };
  let lastCliInfo = null;
  const pendingApprovals = new Map();
  const sessionAllowedTools = new Set();

  function emit(evt) {
    if (onEvent) onEvent(evt);
  }

  function currentEnv() {
    return adapter.completeSpawnEnv(env || {});
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
      emit({ type: 'thinking', active: false });
      const text = params.delta !== undefined ? params.delta : params.text;
      if (text) {
        activeAssistantText += String(text);
        emit({ type: 'text-delta', text: String(text), phase: params.phase });
      }
      return;
    }
    if (message.method === 'item/started') {
      const item = itemFromParams(params);
      if (item.type === 'reasoning') {
        emit({ type: 'thinking', active: true });
        return;
      }
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
      if (item.type === 'reasoning') {
        emit({ type: 'thinking', active: false });
        return;
      }
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
      if (isTransientReconnectError(error)) return;
      emit({ type: 'error', kind: error.kind || 'mcp', message: error.message || String(error || 'Codex app-server error') });
      finishActive();
    }
  }

  function acceptElicitation(rpcId) {
    if (rpc) rpc.respond(rpcId, { action: 'accept', content: {} });
  }

  function declineElicitation(rpcId, toolUseId) {
    if (rpc) rpc.respond(rpcId, { action: 'decline', content: {} });
    emit({ type: 'tool-denied', toolUseId });
  }

  function handleRequest(message) {
    if (message.method !== 'mcpServer/elicitation/request') {
      if (rpc) rpc.respondError(message.id, -32601, 'Method not found');
      return;
    }
    const toolUseId = String(message.id);
    const params = message.params || {};
    const name = prefixedToolName(params);
    const input = elicitationInput(params) || {};
    const annotations = (toolMeta && toolMeta.annotations) || {};
    const ann = annotations[name] || {};
    const tier = getPermissionMode ? getPermissionMode() : 'manual';

    if (sessionAllowedTools.has(name) || ann.readOnly || tier === 'none' || (tier === 'auto' && !ann.destructive)) {
      acceptElicitation(message.id);
      return;
    }

    if (tier === 'readonly') {
      declineElicitation(message.id, toolUseId);
      return;
    }

    const approval = {
      rpcId: message.id,
      name,
      input,
    };
    pendingApprovals.set(toolUseId, approval);
    emit({
      type: 'approval-required',
      toolUseId,
      name: approval.name,
      input: approval.input,
      risk: ann.destructive ? 'destructive' : 'write',
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
    preambleSent = false;
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
    preambleSent = false;
    if (activeRun) {
      emit({ type: 'error', kind: 'mcp', message: err.message });
      finishActive();
    }
  }

  async function startProcess() {
    if (proc && rpc) return true;
    if (startPromise) return startPromise;
    startPromise = (async () => {
      const spawnEnv = currentEnv();
      const providerProfile = normalizeProviderProfile(getProviderProfile ? getProviderProfile() : {}, spawnEnv);
      stderrTail = '';
      stopping = false;
      const cliInfo = await resolveCli({ env: spawnEnv, platform: adapter });
      if (!cliInfo || !cliInfo.ok) throw new Error((cliInfo && cliInfo.detail) || 'codex CLI is unavailable');
      lastCliInfo = cliInfo;
      const executable = cliInfo.executable || {
        ok: true, id: 'codex', path: cliInfo.cliPath, argsPrefix: [], source: 'path', version: cliInfo.version || null, arch: null,
      };
      let spawnEnvWithCreds = codexSpawnEnv(providerProfile, spawnEnv);
      // Only inherit cli-config's provider env var when the panel has no
      // explicit custom provider (codexBaseUrl) configured — an explicit
      // custom provider always wins.
      if (!providerProfile.codexBaseUrl) {
        const cliConfig = getCliConfigProvider ? getCliConfigProvider() : null;
        const envKey = cliConfig && cliConfig.provider && String(cliConfig.provider.envKey || '').trim();
        if (envKey && cliConfig.apiKey) {
          spawnEnvWithCreds = Object.assign({}, spawnEnvWithCreds, { [envKey]: cliConfig.apiKey });
        }
      }
      proc = adapter.spawn(executable, codexAppServerArgs(providerProfile), {
        stdio: 'pipe',
        windowsHide: true,
        env: spawnEnvWithCreds,
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

  async function initialize(timeoutOverrideMs) {
    if (initialized) return true;
    if (initializePromise) return initializePromise;
    initializePromise = (async () => {
      await startProcess();
      await rpc.request('initialize', {
        clientInfo: { name: 'ae-mcp-panel', version: PANEL_VERSION },
        // granular askForApproval (our four-tier mapping) is gated behind
        // the experimental API surface (live error without it).
        capabilities: { experimentalApi: true },
      }, timeoutOverrideMs);
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
    toolMeta = getToolMeta ? await getToolMeta() : { allowedTools: [], annotations: {} };
    const spawnEnv = currentEnv();
    const result = await rpc.request('thread/start', {
      ephemeral: true,
      cwd: defaultCwd(spawnEnv, adapter),
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
              ...expertGuidanceEnv(getExpertGuidance()),
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
      await ensureThread();
      const userText = String(text || '');
      transcript.push({ role: 'user', text: userText });
      // On the first turn of a (re)started thread, prepend the ae-mcp server
      // instructions as a preamble (Codex does not forward them to the model).
      // Attempt only once per thread; subsequent turns rely on thread history.
      let turnText = userText;
      if (!preambleSent) {
        const instr = (getServerInstructions() || '').trim();
        if (instr) turnText = instr + '\n\n---\n\n' + userText;
        preambleSent = true;
      }
      // turn/start resolves long before turn/completed; track it so a
      // JSON-RPC error (bad model, dead thread) surfaces instead of
      // leaving the run promise spinning forever. The first ack can wait
      // on the injected ae-mcp cold start, hence the long timeout.
      rpc.request('turn/start', turnParams(turnText), 180000).catch((e) => {
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
    if (action === 'accept' && decision === 'allow-session') sessionAllowedTools.add(approval.name);
    rpc.respond(approval.rpcId, { action, content: {} });
    if (action === 'decline') emit({ type: 'tool-denied', toolUseId: id });
    else emit({ type: 'tool-allowed', toolUseId: id });
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
    preambleSent = false;
    currentTurnId = null;
    transcript = [];
    pendingApprovals.clear();
    sessionAllowedTools.clear();
    toolMeta = { allowedTools: [], annotations: {} };
    finishActive();
    stderrTail = '';
    stopping = false;
  }

  // Bounded timeouts for the probe's own RPC calls. These are independent of
  // (and tighter than) createRpc's generic RPC_TIMEOUT_MS: probeAccount backs
  // the "checking credential channels" UI gate, so it must resolve quickly
  // and NEVER hang even if a third-party relay's upstream stream to
  // model/list disconnects without ever responding.
  const PROBE_INITIALIZE_TIMEOUT_MS = 10000;
  const PROBE_ACCOUNT_READ_TIMEOUT_MS = 10000;
  const PROBE_MODEL_LIST_TIMEOUT_MS = 4000;

  async function boundedProbeRequest(method, params, ms, label) {
    try {
      return await rpc.request(method, params, ms);
    } catch (error) {
      if (error && /timed out/i.test(String(error.message || ''))) error.probeTimeout = label;
      throw error;
    }
  }

  async function probeAccount() {
    const spawnEnv = currentEnv();
    let cliInfo = { ok: false, cliPath: '', version: '' };
    try {
      cliInfo = lastCliInfo || await resolveCli({ env: spawnEnv, platform: adapter });
      lastCliInfo = cliInfo;
    } catch (e) { /* diagnostics only, never blocks the probe */ }
    const diag = { cliPath: cliInfo.cliPath || '', cliVersion: cliInfo.version || '' };
    let probedProc = null;
    try {
      try {
        await initialize(PROBE_INITIALIZE_TIMEOUT_MS);
      } catch (error) {
        if (error && /timed out/i.test(String(error.message || ''))) error.probeTimeout = 'initialize';
        throw error;
      }
      probedProc = proc;
      const accountResult = await boundedProbeRequest('account/read', {}, PROBE_ACCOUNT_READ_TIMEOUT_MS, 'account/read');
      let models = null;
      try {
        const listed = await boundedProbeRequest('model/list', {}, PROBE_MODEL_LIST_TIMEOUT_MS, 'model/list');
        models = Array.isArray(listed) ? listed : listed && listed.models;
      } catch (e) {
        // Non-fatal: a stuck/slow model/list (e.g. a relay whose upstream
        // stream disconnects) must not fail the whole probe.
        models = null;
      }
      const account = accountResult && accountResult.account;
      if (!account) return { loggedIn: false, runtimeOk: true, detail: accountResult && accountResult.requiresOpenaiAuth ? 'OpenAI auth required' : undefined, models, ...diag };
      return {
        loggedIn: true,
        runtimeOk: true,
        email: account.email,
        planType: account.planType,
        models,
        ...diag,
      };
    } catch (e) {
      const detail = [e && e.message ? e.message : String(e), cliInfo.ok ? '' : cliInfo.detail].filter(Boolean).join(' | ');
      if (e && e.probeTimeout) {
        // The app-server process behind this probe is stuck (e.g. hung
        // upstream RPC). Kill this specific spawned process so it doesn't
        // leak as a zombie; a fresh probe/turn will spawn a new one via
        // startProcess()/initialize().
        if (probedProc) {
          try { probedProc.kill(); } catch (killErr) { /* best effort */ }
        }
        reset();
        return { loggedIn: false, runtimeOk: false, detail: 'probe timeout: ' + e.probeTimeout + (detail ? ' | ' + detail : ''), ...diag };
      }
      return { loggedIn: false, runtimeOk: false, detail, ...diag };
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
