import { createNdjsonReader } from '../lib/ndjson.js';
import { cliIdentity } from '../lib/cliUpdates.js';
import {
  containsExactSecret,
  createDeltaRedactor,
  redactText,
  redactValue,
} from '../lib/exactSecretRedaction.js';
import {
  boundedResolution,
  classifyErrorCode,
  extractHttpStatus,
  trimStderrTail,
} from '../lib/errorCodes.js';
import { PANEL_VERSION } from './mcpClient.js';
import { createPlatformAdapter } from './platform/index.js';
import {
  PLAN_SCHEMA_KEY,
  approvalResult,
  decideToolPlan,
  extractToolPlan,
  isCoreAuthorizedDynamicCall,
  planSessionKey,
} from '../../../shared/tool-approval.mjs';
import {
  normalizeTurnInput,
  withAttachmentManifest,
} from '../../../shared/chat-attachments.mjs';
import {
  answersForCodexUserInput,
  displayAnswers,
  questionsFromCodexUserInput,
} from '../lib/questionForm.js';

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
      const timer = setTimeout(() => {
        const error = new Error(method + ' timed out after ' + limit + 'ms');
        error.method = method;
        error.timeoutMs = limit;
        rejectPending(id, error);
      }, limit);
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

function resolutionArchitecture(resolution) {
  for (const attempt of resolution?.attempts || []) {
    const match = String(attempt?.detail || '').match(/architecture\s+(arm64|aarch64|x64|amd64|x86_64)\b/i);
    if (match) return match[1];
  }
  return '';
}

function codexResolutionMessage(code, lang, resolution) {
  if (code === 'VERSION_TOO_OLD') {
    return lang === 'zh'
      ? 'Codex CLI 版本过旧，请升级后重新检测。'
      : 'Codex CLI is too old. Upgrade it and re-check.';
  }
  if (code === 'ARCH_MISMATCH') {
    const found = resolutionArchitecture(resolution);
    if (lang === 'zh') {
      return found
        ? `Codex CLI 架构不匹配：找到的是 ${found} 架构。请安装与 After Effects 一致的版本。`
        : 'Codex CLI 架构不匹配。请安装与 After Effects 一致的版本。';
    }
    return found
      ? `Codex CLI architecture mismatch: the detected executable is ${found}. Install a build matching After Effects.`
      : 'Codex CLI architecture mismatch. Install a build matching After Effects.';
  }
  if (code === 'PROBE_FAILED') {
    return lang === 'zh'
      ? '已找到 Codex CLI，但版本探针启动失败。请在终端确认 codex --version 可正常运行。'
      : 'Codex CLI was found, but its version probe failed. Confirm codex --version runs in a terminal.';
  }
  return lang === 'zh'
    ? '未找到 Codex CLI。请安装 Codex CLI，并确保 codex 在 PATH 中。'
    : 'Codex CLI was not found. Install Codex CLI and put codex on PATH.';
}

function taggedError(error, property, value) {
  const result = error instanceof Error
    ? error
    : new Error(error?.message || String(error || value));
  result[property] = value;
  return result;
}

export async function resolveCodexCli({ env, platform, lang = 'zh' } = {}) {
  const adapter = platform || createPlatformAdapter();
  const requiredArch = adapter.id === 'macos-arm64' ? 'arm64' : (adapter.id === 'windows-x64' ? 'x64' : undefined);
  const resolved = await adapter.resolveExecutable('codex', { env: env || {}, ...(requiredArch ? { requiredArch } : {}) });
  if (!resolved.ok) {
    return {
      ok: false,
      code: resolved.code,
      cliPath: '',
      version: '',
      detail: codexResolutionMessage(resolved.code, lang, resolved),
      resolution: resolved,
    };
  }
  // cliPath is diagnostics-only (#225): show the tool the user installed, not
  // the node.exe a materialized cmd-shim spawns through.
  return { ok: true, cliPath: resolved.displayPath || resolved.path, version: resolved.version || '', executable: resolved };
}

export function createCodexBackend({
  platform,
  getModel,
  getEffort,
  getFast,
  getPermissionMode,
  getMcpSpec,
  getToolMeta,
  getServerInstructions = () => '',
  resolveCli = resolveCodexCli,
  onEvent,
  getLang,
  lang = 'zh',
  env,
  rpcTimeoutMs = RPC_TIMEOUT_MS,
  turnTimeoutMs = 180000,
}) {
  const adapter = platform || createPlatformAdapter();
  const currentLang = () => (typeof getLang === 'function' ? getLang() : lang) || 'zh';
  let proc = null;
  let rpc = null;
  let startPromise = null;
  let initializePromise = null;
  let initialized = false;
  let threadId = null;
  let adoptedThreadId = null;
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
  let activeAttachmentPaths = [];
  let processStderrAttachmentPaths = [];
  let providerDeltaPhase = undefined;
  let providerDeltaRedactor = createDeltaRedactor([], () => {});
  let providerStderrRedactor = createDeltaRedactor([], () => {});
  let runtimeGeneration = 0;
  let turnFailureInFlight = false;
  let activeTurn = null;
  let activeTurnAccepted = false;
  let activeTurnDispatched = false;
  let activeUserText = '';
  let activeUserRecorded = false;
  const pendingApprovals = new Map();
  const pendingUserInputs = new Map();
  const sessionAllowedTools = new Set();
  const sessionAllowedPlans = new Set();

  function emit(evt) {
    if (onEvent) onEvent(redactValue(evt, activeAttachmentPaths));
  }

  function emitAfterText(evt) {
    providerDeltaRedactor.flush();
    emit(evt);
  }

  function emitTurnProgress(stage) {
    if (!activeRun || !activeTurn) return;
    emit({
      type: 'turn-progress',
      ...(activeTurn.turnId ? { turnId: activeTurn.turnId } : {}),
      stage,
    });
  }

  function resetProviderDeltaRedactor() {
    providerDeltaRedactor.discard();
    providerDeltaPhase = undefined;
    providerDeltaRedactor = createDeltaRedactor(
      activeAttachmentPaths,
      (text) => {
        activeAssistantText += text;
        emit({ type: 'text-delta', text, phase: providerDeltaPhase });
      },
    );
  }

  function resetProviderStderrRedactor() {
    providerStderrRedactor.discard();
    providerStderrRedactor = createDeltaRedactor(
      processStderrAttachmentPaths,
      (text) => {
        stderrTail = appendTail(stderrTail, text);
      },
    );
  }

  function setActiveAttachmentPaths(values) {
    activeAttachmentPaths = Array.from(new Set((values || [])
      .filter((value) => typeof value === 'string' && value)))
      .sort((left, right) => right.length - left.length);
    if (stderrTail) stderrTail = redactValue(stderrTail, activeAttachmentPaths);
    const previousProcessPathCount = processStderrAttachmentPaths.length;
    processStderrAttachmentPaths = Array.from(new Set([
      ...processStderrAttachmentPaths,
      ...activeAttachmentPaths,
    ])).sort((left, right) => right.length - left.length);
    resetProviderDeltaRedactor();
    if (processStderrAttachmentPaths.length !== previousProcessPathCount) {
      resetProviderStderrRedactor();
    }
  }

  function clearProcessStderrAttachmentPaths({ preserveActive = false } = {}) {
    processStderrAttachmentPaths = preserveActive ? activeAttachmentPaths.slice() : [];
    resetProviderStderrRedactor();
  }

  function codexHomePath() {
    return adapter.paths.join([adapter.paths.configRoot, 'codex-home']);
  }

  function currentEnv() {
    const spawnEnv = adapter.completeSpawnEnv(env || {});
    const codexHome = codexHomePath();
    adapter.fs.mkdirSync(codexHome, { recursive: true });
    return { ...spawnEnv, CODEX_HOME: codexHome };
  }

  function activeTurnFailureFields() {
    if (!activeTurn?.turnId) return {};
    return {
      turnId: activeTurn.turnId,
      ...(!activeTurnAccepted ? {
        dispatchState: activeTurnDispatched ? 'uncertain' : 'not-started',
      } : {}),
    };
  }

  function finishActive() {
    const resolve = activeResolve;
    activeResolve = null;
    activeRun = null;
    activeAssistantText = '';
    activeTurn = null;
    activeTurnAccepted = false;
    activeTurnDispatched = false;
    activeUserText = '';
    activeUserRecorded = false;
    turnFailureInFlight = false;
    setActiveAttachmentPaths([]);
    if (resolve) resolve();
  }

  function drainApprovals() {
    for (const [toolUseId, approval] of Array.from(pendingApprovals.entries())) {
      if (rpc) rpc.respond(approval.rpcId, { action: 'decline', content: {} });
      pendingApprovals.delete(toolUseId);
      emit({ type: 'tool-denied', toolUseId });
    }
    // #228/#220: settle any pending agent-to-user question as cancelled so the
    // card stops being actionable and the question never outlives the backend.
    for (const [toolUseId, pending] of Array.from(pendingUserInputs.entries())) {
      pendingUserInputs.delete(toolUseId);
      if (rpc) rpc.respond(pending.rpcId, { answers: {} });
      emitAfterText({ type: 'question-resolved', toolUseId, outcome: 'cancelled' });
    }
  }

  // #228: settle a pending codex question. result:
  //   { action:'submit', values: { [question.id]: string|string[] } }
  //   | { action:'cancel' }
  function answerQuestion(toolUseId, result) {
    const id = String(toolUseId);
    const pending = pendingUserInputs.get(id);
    if (!pending) return false;
    pendingUserInputs.delete(id);
    if (!result || result.action !== 'submit') {
      if (rpc) rpc.respond(pending.rpcId, { answers: {} });
      emitAfterText({ type: 'question-resolved', toolUseId: id, outcome: 'cancelled' });
      return true;
    }
    const answers = answersForCodexUserInput(pending.questions, result.values);
    if (rpc) rpc.respond(pending.rpcId, { answers });
    // The event carries the display shape (plain strings), not the wire shape —
    // QuestionCard joins the values, and `{answers:[...]}` objects would render
    // as "[object Object]".
    emitAfterText({
      type: 'question-resolved',
      toolUseId: id,
      outcome: 'answered',
      answers: displayAnswers(pending.questions, result.values),
    });
    return true;
  }

  function handleNotification(message) {
    const params = message.params || {};
    if (message.method === 'turn/started') {
      currentTurnId = (params.turn && params.turn.id) || params.turnId || null;
      resetProviderDeltaRedactor();
      if (activeTurn && activeTurn.turnId && !activeTurnAccepted) {
        activeTurnAccepted = true;
        emit({ type: 'turn-accepted', turnId: activeTurn.turnId, transport: 'codex-app-server' });
      }
      emit({ type: 'turn-start' });
      return;
    }
    if (message.method === 'item/agentMessage/delta') {
      emit({ type: 'thinking', active: false });
      const text = params.delta !== undefined ? params.delta : params.text;
      if (text) {
        providerDeltaPhase = params.phase;
        providerDeltaRedactor.feed(String(text));
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
      emitAfterText({
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
      emitAfterText({
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
      const turn = params.turn && typeof params.turn === 'object' ? params.turn : params;
      const cancelled = ['cancelled', 'canceled', 'interrupted'].includes(String(turn.status || '').toLowerCase());
      const completionFailure = turn.error || params.error
        || (turn.status === 'failed' || turn.status === 'error'
          ? { code: turn.status, message: 'Codex turn failed.' }
          : (cancelled ? { code: turn.status, message: `Codex turn ${turn.status}.` } : null));
      if (completionFailure) {
        providerDeltaRedactor.discard();
        void handleTurnFailure(completionFailure);
        return;
      }
      providerDeltaRedactor.flush();
      drainApprovals();
      emit({ type: 'turn-end', stopReason: 'end_turn' });
      transcript.push({ role: 'assistant', text: activeAssistantText });
      finishActive();
      return;
    }
    if (message.method === 'error') {
      const error = params.error || params;
      if (isTransientReconnectError(error)) return;
      providerDeltaRedactor.discard();
      void handleTurnFailure(error);
    }
  }

  function acceptElicitation(rpcId) {
    if (rpc) rpc.respond(rpcId, { action: 'accept', content: {} });
  }

  function declineElicitation(rpcId, toolUseId) {
    if (rpc) rpc.respond(rpcId, { action: 'decline', content: {} });
    emit({ type: 'tool-denied', toolUseId });
  }

  // #228: surface an agent-to-user question through the #219 form. The answer
  // returns via answerQuestion(); teardown settles it as cancelled so a
  // question never outlives its backend (#220).
  function handleUserInput(message) {
    const params = message.params || {};
    const questions = questionsFromCodexUserInput(params);
    if (!questions.length) {
      if (rpc) rpc.respond(message.id, { answers: {} });
      return;
    }
    const toolUseId = 'ask_' + String(message.id);
    pendingUserInputs.set(toolUseId, { rpcId: message.id, questions });
    emitAfterText({
      type: 'question-required',
      toolUseId,
      source: 'codex-user-input',
      title: '',
      questions,
    });
  }

  function handleRequest(message) {
    // #228: codex asks the user directly via the experimental
    // item/tool/requestUserInput server request (enabled with
    // features.default_mode_request_user_input). Bridge it to the #219
    // question form instead of the old -32601 Method-not-found reply.
    if (message.method === 'item/tool/requestUserInput') {
      handleUserInput(message);
      return;
    }
    if (message.method !== 'mcpServer/elicitation/request') {
      if (rpc) rpc.respondError(message.id, -32601, 'Method not found');
      return;
    }
    const toolUseId = String(message.id);
    const params = message.params || {};
    const schema = params.requestedSchema;
    if (schema && Object.prototype.hasOwnProperty.call(schema, PLAN_SCHEMA_KEY)) {
      const plan = extractToolPlan(schema);
      if (!plan) {
        if (rpc) rpc.respond(message.id, approvalResult('deny'));
        return;
      }

      const policy = decideToolPlan({
        tier: getPermissionMode ? getPermissionMode() : 'manual',
        plan,
        sessionAllowed: sessionAllowedPlans.has(planSessionKey(plan)),
      });
      if (policy.decision === 'allow') {
        if (rpc) rpc.respond(message.id, approvalResult('once', policy));
        return;
      }
      if (policy.decision === 'deny') {
        declineElicitation(message.id, toolUseId);
        return;
      }

      pendingApprovals.set(toolUseId, {
        kind: 'tool-plan',
        rpcId: message.id,
        name: 'mcp__ae__ae_toolUse',
        input: plan,
        plan,
        allowSession: policy.allowSession,
      });
      emitAfterText({
        type: 'approval-required',
        toolUseId,
        name: 'mcp__ae__ae_toolUse',
        input: plan,
        risk: policy.risk,
      });
      return;
    }

    const name = prefixedToolName(params);
    const input = elicitationInput(params) || {};
    const annotations = (toolMeta && toolMeta.annotations) || {};
    const ann = annotations[name] || {};
    const tier = getPermissionMode ? getPermissionMode() : 'manual';

    if (isCoreAuthorizedDynamicCall(name, input)) {
      acceptElicitation(message.id);
      return;
    }

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
    emitAfterText({
      type: 'approval-required',
      toolUseId,
      name: approval.name,
      input: approval.input,
      risk: ann.destructive ? 'destructive' : 'write',
    });
  }

  function handleExit(code, signal) {
    const wasStopping = stopping;
    providerStderrRedactor.flush();
    const tail = trimStderrTail(stderrTail);
    if (rpc) rpc.close(new Error('codex app-server exited'));
    proc = null;
    rpc = null;
    startPromise = null;
    initializePromise = null;
    initialized = false;
    if (threadId) adoptedThreadId = threadId;
    threadId = null;
    preambleSent = false;
    // Settle pending approvals now that the RPC peer is gone: without this the
    // awaiting-approval card stays actionable forever (#220). rpc is already
    // null, so drain releases local state without writing to a dead pipe.
    drainApprovals();
    if (wasStopping) {
      clearProcessStderrAttachmentPaths();
      return;
    }
    if (activeRun) {
      const classified = classifyErrorCode({ exitCode: code, signal, stderrTail: tail });
      emitAfterText({
        type: 'error',
        kind: classified.kind,
        code: classified.code,
        message: 'Codex app-server exited unexpectedly.',
        detail: {
          exitCode: code,
          ...(signal ? { signal } : {}),
          ...(tail ? { stderrTail: tail } : {}),
          ...(classified.code === 'AUTH_REQUIRED' ? { codexHome: codexHomePath() } : {}),
        },
        ...activeTurnFailureFields(),
      });
      finishActive();
    }
    clearProcessStderrAttachmentPaths();
  }

  function handleError(error) {
    const err = error instanceof Error ? error : new Error('codex app-server error');
    providerStderrRedactor.flush();
    if (rpc) rpc.close(err);
    proc = null;
    rpc = null;
    startPromise = null;
    initializePromise = null;
    initialized = false;
    if (threadId) adoptedThreadId = threadId;
    threadId = null;
    preambleSent = false;
    drainApprovals();
    if (activeRun) {
      const classified = classifyErrorCode({ error: err, spawnError: true });
      emitAfterText({
        type: 'error',
        kind: classified.kind,
        code: classified.code,
        message: 'Codex app-server process could not continue.',
        detail: {
          ...(err.code ? { spawnCode: err.code } : {}),
          ...(trimStderrTail(stderrTail) ? { stderrTail: trimStderrTail(stderrTail) } : {}),
        },
        ...activeTurnFailureFields(),
      });
      finishActive();
    }
    clearProcessStderrAttachmentPaths();
  }

  async function startProcess() {
    if (proc && rpc) return true;
    if (startPromise) return startPromise;
    const startGeneration = runtimeGeneration;
    const assertCurrentStart = () => {
      if (startGeneration !== runtimeGeneration) throw new Error('Codex start was cancelled');
    };
    const pendingStart = (async () => {
      const spawnEnv = currentEnv();
      stderrTail = '';
      resetProviderStderrRedactor();
      stopping = false;
      const resolvedLang = currentLang();
      const cliInfo = await resolveCli({ env: spawnEnv, platform: adapter, lang: resolvedLang });
      assertCurrentStart();
      if (!cliInfo || !cliInfo.ok) {
        const error = new Error((cliInfo && cliInfo.detail) || codexResolutionMessage(cliInfo?.code, resolvedLang, cliInfo?.resolution || cliInfo));
        const classified = classifyErrorCode({ resolutionCode: cliInfo?.code || cliInfo?.resolution?.code });
        error.categoryCode = classified.code;
        error.resolution = boundedResolution(cliInfo?.resolution || cliInfo);
        throw error;
      }
      lastCliInfo = cliInfo;
      const executable = cliInfo.executable || {
        ok: true, id: 'codex', path: cliInfo.cliPath, argsPrefix: [], source: 'path', version: cliInfo.version || null, arch: null,
      };
      assertCurrentStart();
      const appServerArgs = [
        'app-server',
        '-c', 'features.default_mode_request_user_input=true',
      ];
      let spawnedProc;
      try {
        emitTurnProgress('spawn');
        spawnedProc = adapter.spawn(executable, appServerArgs, {
          stdio: 'pipe',
          windowsHide: true,
          env: spawnEnv,
        });
      } catch (error) {
        throw taggedError(error, 'spawnError', true);
      }
      proc = spawnedProc;
      spawnedProc.stdout?.setEncoding?.('utf8');
      spawnedProc.stderr?.setEncoding?.('utf8');
      const generation = startGeneration + 1;
      runtimeGeneration = generation;
      const nextRpc = createRpc({
        writeLine: (line) => spawnedProc.stdin.write(line),
        onNotification: handleNotification,
        onRequest: handleRequest,
        timeoutMs: rpcTimeoutMs,
      });
      rpc = nextRpc;
      const reader = createNdjsonReader((message) => {
        if (generation === runtimeGeneration && rpc === nextRpc) nextRpc.handleMessage(message);
      });
      if (spawnedProc.stdout && spawnedProc.stdout.on) spawnedProc.stdout.on('data', reader);
      if (spawnedProc.stderr && spawnedProc.stderr.on) spawnedProc.stderr.on('data', (chunk) => {
        if (generation !== runtimeGeneration || proc !== spawnedProc) return;
        providerStderrRedactor.feed(chunk);
      });
      spawnedProc.on('exit', (code, signal) => {
        if (generation === runtimeGeneration && proc === spawnedProc) handleExit(code, signal);
      });
      spawnedProc.on('error', (error) => {
        if (generation === runtimeGeneration && proc === spawnedProc) handleError(error);
      });
      return true;
    })().catch((error) => {
      if (startGeneration === runtimeGeneration) {
        drainApprovals();
      }
      throw error;
    });
    startPromise = pendingStart;
    try {
      return await pendingStart;
    } finally {
      if (startPromise === pendingStart) startPromise = null;
    }
  }

  async function initialize(timeoutOverrideMs) {
    if (initialized) return true;
    if (initializePromise) return initializePromise;
    const pendingInitialize = (async () => {
      await startProcess();
      const initializingRpc = rpc;
      const initializingGeneration = runtimeGeneration;
      await initializingRpc.request('initialize', {
        clientInfo: { name: 'ae-mcp-panel', version: PANEL_VERSION },
        // granular askForApproval (our four-tier mapping) is gated behind
        // the experimental API surface (live error without it).
        capabilities: { experimentalApi: true },
      }, timeoutOverrideMs);
      if (initializingGeneration !== runtimeGeneration || rpc !== initializingRpc) {
        throw new Error('Codex initialization was cancelled');
      }
      initialized = true;
      return true;
    })();
    initializePromise = pendingInitialize;
    try {
      return await pendingInitialize;
    } finally {
      if (initializePromise === pendingInitialize) initializePromise = null;
    }
  }

  async function ensureThread() {
    if (threadId) return threadId;
    await initialize();
    const threadRpc = rpc;
    const threadGeneration = runtimeGeneration;
    let mcpSpec;
    try {
      mcpSpec = await getMcpSpec();
      toolMeta = getToolMeta ? await getToolMeta() : { allowedTools: [], annotations: {} };
    } catch (error) {
      throw taggedError(error, 'categoryCode', 'MCP_UNREACHABLE');
    }
    if (threadGeneration !== runtimeGeneration || rpc !== threadRpc) {
      throw new Error('Codex thread start was cancelled');
    }
    const spawnEnv = currentEnv();
    const params = {
      cwd: defaultCwd(spawnEnv, adapter),
      model: getModel(),
      approvalPolicy: APPROVAL_POLICY,
      approvalsReviewer: 'user',
      sandboxPolicy: SANDBOX_POLICY,
      config: {
        mcp_servers: {
          ae: { url: mcpSpec.url },
        },
      },
    };
    let result;
    if (adoptedThreadId) {
      try {
        emitTurnProgress('session');
        result = await threadRpc.request('thread/resume', {
          threadId: adoptedThreadId,
          ...params,
        });
        preambleSent = true;
      } catch (error) {
        adoptedThreadId = null;
        preambleSent = false;
      }
    }
    if (!result) {
      try {
        emitTurnProgress('session');
        result = await threadRpc.request('thread/start', {
          ephemeral: false,
          ...params,
        });
      } catch (error) {
        throw taggedError(error, 'fallbackCode', 'SESSION_START_FAILED');
      }
    }
    if (threadGeneration !== runtimeGeneration || rpc !== threadRpc) {
      throw new Error('Codex thread start was cancelled');
    }
    threadId = threadIdFromResult(result);
    if (!threadId) {
      throw taggedError(new Error('Codex did not return a thread id.'), 'fallbackCode', 'SESSION_START_FAILED');
    }
    adoptedThreadId = threadId;
    emit({ type: 'session-ref', ref: { kind: 'codex-thread', id: threadId } });
    return threadId;
  }

  function turnInput(turn, text) {
    const input = [];
    const modelText = withAttachmentManifest(text, turn.attachments);
    if (modelText) input.push({ type: 'text', text: modelText });
    for (const attachment of turn.attachments) {
      if (attachment.mediaType.startsWith('image/')) {
        input.push({ type: 'localImage', path: attachment.localPath });
      } else if (attachment.mediaType.startsWith('audio/')) {
        input.push({ type: 'localAudio', path: attachment.localPath });
      }
    }
    return input;
  }

  function turnParams(turn, text) {
    const params = {
      threadId,
      input: turnInput(turn, text),
      model: getModel(),
      effort: getEffort ? getEffort() : undefined,
      approvalPolicy: APPROVAL_POLICY,
      sandboxPolicy: SANDBOX_POLICY,
    };
    if (getFast && getFast()) params.serviceTier = 'priority';
    if (params.effort === undefined || params.effort === null) delete params.effort;
    return params;
  }

  async function launchActiveTurn() {
    await ensureThread();
    if (!activeRun) return;
    if (!activeUserRecorded) {
      transcript.push({ role: 'user', text: activeUserText });
      activeUserRecorded = true;
    }
    let turnText = activeUserText;
    if (!preambleSent) {
      const instructions = (getServerInstructions() || '').trim();
      if (instructions) turnText = instructions + '\n\n---\n\n' + activeUserText;
      preambleSent = true;
    }
    activeTurnDispatched = true;
    const turnRequest = rpc.request('turn/start', turnParams(activeTurn, turnText), turnTimeoutMs);
    emitTurnProgress('dispatch');
    turnRequest.catch((error) => {
      void handleTurnFailure(error);
    });
  }

  async function handleTurnFailure(error) {
    if (!activeRun || turnFailureInFlight) return;
    turnFailureInFlight = true;
    try {
      const rawMessage = redactValue(
        error?.message || 'Failed to start Codex turn.',
        activeAttachmentPaths,
      );
      const httpStatus = extractHttpStatus(error?.httpStatus) || extractHttpStatus(rawMessage);
      const fallbackCode = error?.fallbackCode
        || (activeTurnDispatched ? 'TURN_START_FAILED' : 'SESSION_START_FAILED');
      const classified = classifyErrorCode({
        error,
        code: error?.categoryCode,
        method: error?.method,
        httpStatus,
        upstreamText: rawMessage,
        spawnError: error?.spawnError === true,
        fallbackCode,
      });
      const detail = {
        ...(error?.method ? { method: error.method } : {}),
        ...(httpStatus ? { httpStatus } : {}),
        ...(typeof error?.code === 'number' ? { jsonRpcCode: error.code } : {}),
        ...(error?.data !== undefined ? { jsonRpcData: error.data } : {}),
        ...(error?.resolution ? { resolution: error.resolution } : {}),
        ...(error?.code && error?.spawnError ? { spawnCode: error.code } : {}),
      };
      if (classified.code === 'AUTH_REQUIRED') detail.codexHome = codexHomePath();
      providerDeltaRedactor.discard();
      // The turn is reaching its error terminal state; settle any approval that
      // is still awaiting the user so the card cannot outlive its turn (#220).
      // The peer may still be alive here, so drain delivers real declines.
      drainApprovals();
      let message = rawMessage || 'Failed to start Codex turn.';
      if (classified.code.startsWith('UPSTREAM_HTTP_')) message = 'Codex upstream request failed.';
      else if (classified.code === 'AUTH_REQUIRED') message = 'Codex authentication is required.';
      else if (classified.code === 'CANCELLED') message = 'Codex request was cancelled.';
      else if (classified.code === 'SPAWN_FAILED') message = 'Codex app-server process could not be started.';
      else if (classified.code === 'MCP_UNREACHABLE') message = 'Codex could not reach the panel MCP server.';
      else if (classified.code === 'SESSION_START_FAILED') message = 'Codex session could not be started.';
      else if (classified.code === 'TURN_START_FAILED') message = 'Codex turn could not be started.';
      if (message !== rawMessage && rawMessage) {
        detail.upstreamMessage = String(rawMessage).slice(0, 500);
      }
      emitAfterText({
        type: 'error',
        kind: classified.kind,
        code: classified.code,
        message,
        ...(Object.keys(detail).length ? { detail } : {}),
        ...activeTurnFailureFields(),
      });
      finishActive();
    } finally {
      turnFailureInFlight = false;
    }
  }

  async function sendUser(input) {
    if (activeRun) return activeRun;
    let turn;
    try {
      turn = normalizeTurnInput(input);
    } catch (error) {
      const turnId = typeof input?.turnId === 'string' ? input.turnId : '';
      emitAfterText({
        type: 'error',
        kind: 'attachment',
        code: 'TURN_INPUT_INVALID',
        message: error.message,
        ...(turnId ? { turnId, dispatchState: 'not-started' } : {}),
      });
      return;
    }
    activeAssistantText = '';
    activeTurn = turn;
    activeTurnAccepted = false;
    activeTurnDispatched = false;
    setActiveAttachmentPaths(turn.attachments.map((attachment) => attachment.localPath));
    activeUserText = turn.text;
    activeUserRecorded = false;
    turnFailureInFlight = false;
    activeRun = new Promise((resolve) => {
      activeResolve = resolve;
    });
    const run = activeRun;

    try {
      await launchActiveTurn();
    } catch (error) {
      await handleTurnFailure(error);
    }
    return run;
  }

  function approve(toolUseId, decision) {
    const id = String(toolUseId);
    const approval = pendingApprovals.get(id);
    if (!approval || !rpc) return;
    pendingApprovals.delete(id);
    if (approval.kind === 'tool-plan') {
      const requestedDecision = decision === 'allow-session'
        ? 'session'
        : (decision === 'allow' ? 'once' : 'deny');
      const result = approvalResult(requestedDecision, { allowSession: approval.allowSession });
      if (result.action === 'accept' && result.content.decision === 'session') {
        sessionAllowedPlans.add(planSessionKey(approval.plan));
      }
      rpc.respond(approval.rpcId, result);
      emit({ type: result.action === 'accept' ? 'tool-allowed' : 'tool-denied', toolUseId: id });
      return;
    }
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
    providerDeltaRedactor.discard();
    if (activeRun) {
      emitAfterText({ type: 'error', kind: 'aborted', code: 'TURN_ABORTED', message: 'Turn aborted.', ...activeTurnFailureFields() });
      finishActive();
    }
  }

  function reset() {
    stopping = true;
    runtimeGeneration += 1;
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
    adoptedThreadId = null;
    preambleSent = false;
    currentTurnId = null;
    transcript = [];
    pendingApprovals.clear();
    pendingUserInputs.clear();
    sessionAllowedTools.clear();
    sessionAllowedPlans.clear();
    toolMeta = { allowedTools: [], annotations: {} };
    finishActive();
    stderrTail = '';
    clearProcessStderrAttachmentPaths();
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

  async function boundedProbeRequest(probeRpc, method, params, ms, label) {
    try {
      return await probeRpc.request(method, params, ms);
    } catch (error) {
      if (error && /timed out/i.test(String(error.message || ''))) error.probeTimeout = label;
      throw error;
    }
  }

  async function probeAccount() {
    const spawnEnv = currentEnv();
    let cliInfo = { ok: false, cliPath: '', version: '' };
    try {
      cliInfo = await resolveCli({ env: spawnEnv, platform: adapter });
    } catch (e) { /* diagnostics only, never blocks the probe */ }
    const diag = {
      cliPath: cliInfo.cliPath || '',
      cliVersion: cliInfo.version || '',
      cli: cliIdentity(cliInfo.executable, adapter.fs),
      runningCli: proc ? cliIdentity(lastCliInfo?.executable, adapter.fs) : null,
      codexHome: codexHomePath(),
      platformId: adapter.id || '',
    };
    const probeSecrets = () => [];
    const failure = (detail) => ({ loggedIn: false, runtimeOk: false, detail, ...diag });
    if (!cliInfo.ok) {
      return failure(redactText(cliInfo.detail || 'codex CLI is unavailable', probeSecrets()));
    }

    // The probe is a dedicated app-server process so it never interleaves
    // probe RPC with an active conversation.
    const executable = cliInfo.executable || {
      ok: true, id: 'codex', path: cliInfo.cliPath, argsPrefix: [], source: 'path', version: cliInfo.version || null, arch: null,
    };
    let probeProc;
    try {
      probeProc = adapter.spawn(executable, ['app-server'], {
        stdio: 'pipe',
        windowsHide: true,
        env: spawnEnv,
      });
    } catch (error) {
      return failure(redactText(error && error.message ? error.message : String(error), probeSecrets()));
    }
    probeProc.stdout?.setEncoding?.('utf8');
    probeProc.stderr?.setEncoding?.('utf8');
    const probeRpc = createRpc({ writeLine: (line) => probeProc.stdin.write(line) });
    const reader = createNdjsonReader((message) => probeRpc.handleMessage(message));
    if (probeProc.stdout && probeProc.stdout.on) probeProc.stdout.on('data', reader);
    if (probeProc.stderr && probeProc.stderr.on) probeProc.stderr.on('data', () => {});
    if (probeProc.on) {
      probeProc.on('exit', () => probeRpc.close(new Error('codex app-server exited before the probe completed')));
      probeProc.on('error', (error) => probeRpc.close(error instanceof Error ? error : new Error('codex app-server failed')));
    }
    try {
      await boundedProbeRequest(probeRpc, 'initialize', {
        clientInfo: { name: 'ae-mcp-panel', version: PANEL_VERSION },
        capabilities: { experimentalApi: true },
      }, PROBE_INITIALIZE_TIMEOUT_MS, 'initialize');
      const accountResult = await boundedProbeRequest(probeRpc, 'account/read', {}, PROBE_ACCOUNT_READ_TIMEOUT_MS, 'account/read');
      let models = null;
      let catalogStatus = 'failed';
      try {
        const all = new Map(), cursors = new Set();
        const deadline = Date.now() + PROBE_MODEL_LIST_TIMEOUT_MS;
        let cursor;
        for (let page = 0; page < 10; page += 1) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error('model/list deadline');
          const listed = await boundedProbeRequest(probeRpc, 'model/list', {
            limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}),
          }, remaining, 'model/list');
          const data = Array.isArray(listed) ? listed : listed?.models || listed?.data;
          if (!Array.isArray(data) || data.some((m) => !m || typeof m.id !== 'string' || !m.id)) throw new Error('Invalid model/list');
          for (const model of data) all.set(model.id, model);
          cursor = listed.nextCursor;
          if (!cursor) { models = [...all.values()]; catalogStatus = 'complete'; break; }
          if (typeof cursor !== 'string' || cursors.has(cursor)) throw new Error('Invalid model/list cursor');
          cursors.add(cursor);
        }
      } catch (e) {
        // Non-fatal: a stuck/slow model/list (e.g. a relay whose upstream
        // stream disconnects) must not fail the whole probe.
        models = null;
      }
      const account = accountResult && accountResult.account;
      const result = !account ? {
        loggedIn: false,
        runtimeOk: true,
        detail: accountResult && accountResult.requiresOpenaiAuth ? 'OpenAI auth required' : undefined,
        models,
        catalogStatus,
        ...diag,
      } : {
        loggedIn: true,
        runtimeOk: true,
        email: account.email,
        planType: account.planType,
        models,
        catalogStatus,
        ...diag,
      };
      if (containsExactSecret(result, probeSecrets())) {
        return failure('Provider probe metadata was rejected');
      }
      return result;
    } catch (e) {
      const detail = redactText(e && e.message ? e.message : String(e), probeSecrets());
      if (e && e.probeTimeout) {
        return failure('probe timeout: ' + e.probeTimeout + (detail ? ' | ' + detail : ''));
      }
      return failure(detail);
    } finally {
      // The probe process is single-use: kill it even on success so a hung
      // app-server can never leak past its probe.
      try { probeProc.kill(); } catch (killErr) { /* best effort */ }
      probeRpc.close(new Error('codex login probe finished'));
    }
  }

  function getSessionRef() {
    const id = threadId || adoptedThreadId;
    return id ? { kind: 'codex-thread', id } : null;
  }

  function adoptSessionRef(ref) {
    const valid = ref && ref.kind === 'codex-thread' && ref.id;
    threadId = null;
    adoptedThreadId = valid ? String(ref.id) : null;
    preambleSent = Boolean(adoptedThreadId);
  }

  async function deleteSessionRef(ref) {
    if (!ref || ref.kind !== 'codex-thread' || !ref.id) {
      return { ok: false, detail: 'invalid codex thread reference' };
    }
    let deleteProc = null;
    let deleteRpc = null;
    try {
      const spawnEnv = currentEnv();
      const cliInfo = lastCliInfo || await resolveCli({
        env: spawnEnv,
        platform: adapter,
        lang: currentLang(),
      });
      if (!cliInfo?.ok) return { ok: false, detail: cliInfo?.detail || 'codex CLI is unavailable' };
      lastCliInfo = cliInfo;
      const executable = cliInfo.executable || {
        ok: true,
        id: 'codex',
        path: cliInfo.cliPath,
        argsPrefix: [],
        source: 'path',
        version: cliInfo.version || null,
        arch: null,
      };
      deleteProc = adapter.spawn(executable, ['app-server'], {
        stdio: 'pipe',
        windowsHide: true,
        env: spawnEnv,
      });
      deleteProc.stdout?.setEncoding?.('utf8');
      deleteProc.stderr?.setEncoding?.('utf8');
      deleteRpc = createRpc({ writeLine: (line) => deleteProc.stdin.write(line) });
      const reader = createNdjsonReader((message) => deleteRpc.handleMessage(message));
      deleteProc.stdout?.on?.('data', reader);
      deleteProc.stderr?.on?.('data', () => {});
      deleteProc.on?.('exit', () => deleteRpc.close(new Error('codex app-server exited during thread delete')));
      deleteProc.on?.('error', (error) => deleteRpc.close(error));
      await deleteRpc.request('initialize', {
        clientInfo: { name: 'ae-mcp-panel', version: PANEL_VERSION },
        capabilities: { experimentalApi: true },
      });
      await deleteRpc.request('thread/delete', { threadId: String(ref.id) });
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: error?.message || String(error) };
    } finally {
      try { deleteProc?.kill?.(); } catch {}
      if (deleteRpc) deleteRpc.close(new Error('codex thread delete finished'));
    }
  }

  return {
    sendUser,
    approve,
    answerQuestion,
    stop,
    reset,
    getSessionRef,
    adoptSessionRef,
    deleteSessionRef,
    getMessages: () => clone(transcript),
    getStderrTail: () => stderrTail,
    probeAccount,
  };
}
