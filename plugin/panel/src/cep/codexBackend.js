import { createNdjsonReader } from '../lib/ndjson.js';
import {
  codexAppServerArgs,
  codexSpawnEnv,
} from '../lib/providerProfile.js';
import { LOCAL_ROUTE_TOKEN_HEADER } from '../lib/providerHeaders.js';
import { selectProviderRoute } from '../lib/providerRouteSelection.js';
import {
  createDeltaRedactor,
  redactValue,
} from '../lib/exactSecretRedaction.js';
import { PANEL_VERSION } from './mcpClient.js';
import { createUniversalProviderRoute } from './universalProviderRoute.js';
import { expertGuidanceEnv } from './externalClients.js';
import { createPlatformAdapter } from './platform/index.js';
import {
  PLAN_SCHEMA_KEY,
  approvalResult,
  decideToolPlan,
  extractToolPlan,
  isCoreAuthorizedDynamicCall,
  planSessionKey,
} from '../../../shared/tool-approval.mjs';

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

function recoverableProviderFailure(error) {
  const values = [error, error?.data, error?.error, error?.cause].filter((value) => value && typeof value === 'object');
  if (values.some((value) => ['code', 'type', 'kind', 'reason']
    .some((key) => String(value[key] || '').toLowerCase() === 'provider_compaction_unsupported'))) {
    return false;
  }
  const message = values.map((value) => String(value.message || '')).filter(Boolean).join('\n');
  if (
    /\bprovider_compaction_unsupported\b/i.test(message)
    || /\bthis chat-only provider cannot compact responses context\.?/i.test(message)
  ) return false;
  for (const value of values) {
    for (const key of ['status', 'statusCode', 'httpStatus', 'upstreamStatus']) {
      if ([401, 403, 404, 405, 501].includes(Number(value[key]))) return true;
    }
    for (const key of ['code', 'type', 'kind', 'reason']) {
      if (key === 'code' && [401, 403, 404, 405, 501].includes(Number(value[key]))) return true;
      const code = String(value[key] || '').toLowerCase();
      if (/unsupported[_-](?:endpoint|api|wire)|(?:endpoint|api|wire)[_-]unsupported/.test(code)) return true;
    }
  }
  return /\b(?:http|status(?:\s+code)?)\s*[:=]?\s*(?:401|403|404|405|501)\b/i.test(message)
    || /\bunsupported\s+(?:endpoint|api|wire api|request)\b/i.test(message);
}

function providerFailureFacts(error) {
  const values = [error, error?.data, error?.error, error?.cause].filter((value) => value && typeof value === 'object');
  let status = null;
  let code = '';
  for (const value of values) {
    for (const key of ['status', 'statusCode', 'httpStatus', 'upstreamStatus']) {
      const candidate = Number(value[key]);
      if (Number.isInteger(candidate)) status = candidate;
    }
    for (const key of ['code', 'type', 'kind', 'reason']) {
      if (!code && value[key] !== undefined) code = String(value[key]);
    }
  }
  return { status, code };
}

function providerModelError(code, message) {
  const error = new Error(message);
  error.kind = 'model';
  error.code = code;
  return error;
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
  getProviderProfile = () => null,
  getProviderCandidate = () => null,
  resolveRequestProfile,
  recoverProviderProfile,
  onProviderProfileRecovered = () => {},
  // Spec A extension: when the panel has no explicit custom provider
  // configured, inherit a model_provider already declared in
  // ~/.codex/config.toml. config.toml owns model_provider selection; the
  // panel only supplies the missing API key env var the provider needs (no
  // `-c model_provider=...` override).
  getCliConfigProvider = () => null,
  createProviderRoute = createUniversalProviderRoute,
  createResponsesRoute,
  selectRoute = selectProviderRoute,
  resolveCli = resolveCodexCli,
  onEvent,
  lang = 'zh',
  env,
}) {
  const adapter = platform || createPlatformAdapter();
  const providerRouteFactory = createResponsesRoute || createProviderRoute;
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
  let providerRoute = null;
  let providerSensitiveValues = [];
  let providerDeltaPhase = undefined;
  let providerDeltaRedactor = createDeltaRedactor([], () => {});
  let providerStderrRedactor = createDeltaRedactor([], () => {});
  let runtimeGeneration = 0;
  let providerProfileOverride = null;
  let providerRecoveryAttempted = false;
  let providerRecoveryInFlight = false;
  let turnFailureInFlight = false;
  let providerRecoverySequence = 0;
  let providerRefreshPending = false;
  let activeUserText = '';
  let activeUserRecorded = false;
  const pendingApprovals = new Map();
  const sessionAllowedTools = new Set();
  const sessionAllowedPlans = new Set();

  function closeProviderRoute() {
    const route = providerRoute;
    providerRoute = null;
    if (route && route.close) Promise.resolve(route.close()).catch(() => {});
  }

  function emit(evt) {
    if (onEvent) onEvent(redactValue(evt, providerSensitiveValues));
  }

  function resetProviderDeltaRedactor() {
    providerDeltaRedactor.discard();
    providerDeltaPhase = undefined;
    providerDeltaRedactor = createDeltaRedactor(providerSensitiveValues, (text) => {
      activeAssistantText += text;
      emit({ type: 'text-delta', text, phase: providerDeltaPhase });
    });
  }

  function resetProviderStderrRedactor() {
    providerStderrRedactor.discard();
    providerStderrRedactor = createDeltaRedactor(providerSensitiveValues, (text) => {
      stderrTail = appendTail(stderrTail, text);
    });
  }

  function setProviderSensitiveValues(values) {
    providerSensitiveValues = Array.from(new Set((values || []).filter((value) => typeof value === 'string' && value)))
      .sort((left, right) => right.length - left.length);
    resetProviderDeltaRedactor();
    resetProviderStderrRedactor();
  }

  function clearProviderSensitiveValues() {
    providerDeltaRedactor.discard();
    providerStderrRedactor.discard();
    providerSensitiveValues = [];
    providerDeltaPhase = undefined;
    providerDeltaRedactor = createDeltaRedactor([], () => {});
    providerStderrRedactor = createDeltaRedactor([], () => {});
  }

  function currentEnv() {
    return adapter.completeSpawnEnv(env || {});
  }

  function finishActive() {
    const resolve = activeResolve;
    const refreshProvider = providerRefreshPending;
    activeResolve = null;
    activeRun = null;
    activeAssistantText = '';
    activeUserText = '';
    activeUserRecorded = false;
    providerRecoveryAttempted = false;
    providerRecoveryInFlight = false;
    turnFailureInFlight = false;
    providerRefreshPending = false;
    if (resolve) resolve();
    if (refreshProvider) {
      Promise.resolve().then(() => onProviderProfileRecovered()).catch(() => {});
    }
  }

  function drainApprovals() {
    for (const [toolUseId, approval] of Array.from(pendingApprovals.entries())) {
      if (rpc) rpc.respond(approval.rpcId, { action: 'decline', content: {} });
      pendingApprovals.delete(toolUseId);
      emit({ type: 'tool-denied', toolUseId });
    }
  }

  function detachRuntimeForProviderRecovery() {
    const previousProc = proc;
    const previousRpc = rpc;
    runtimeGeneration += 1;
    drainApprovals();
    closeProviderRoute();
    if (previousRpc) previousRpc.close(new Error('Codex provider runtime is restarting'));
    proc = null;
    rpc = null;
    startPromise = null;
    initializePromise = null;
    initialized = false;
    threadId = null;
    preambleSent = false;
    currentTurnId = null;
    activeAssistantText = '';
    stderrTail = '';
    clearProviderSensitiveValues();
    if (previousProc) {
      try { previousProc.kill(); } catch { /* best effort */ }
    }
  }

  function handleNotification(message) {
    const params = message.params || {};
    if (message.method === 'turn/started') {
      currentTurnId = (params.turn && params.turn.id) || params.turnId || null;
      resetProviderDeltaRedactor();
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
      const turn = params.turn && typeof params.turn === 'object' ? params.turn : params;
      const completionFailure = turn.error || params.error
        || (turn.status === 'failed' || turn.status === 'error'
          ? { code: turn.status, message: 'Codex turn failed.' }
          : null);
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

  function handleRequest(message) {
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
      emit({
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
    providerStderrRedactor.flush();
    const detail = stderrTail ? String(code) + (signal ? ' ' + signal : '') + ' ' + stderrTail : String(code) + (signal ? ' ' + signal : '');
    if (rpc) rpc.close(new Error('codex app-server exited: ' + detail));
    proc = null;
    rpc = null;
    startPromise = null;
    initializePromise = null;
    initialized = false;
    threadId = null;
    preambleSent = false;
    closeProviderRoute();
    if (wasStopping) {
      clearProviderSensitiveValues();
      return;
    }
    if (activeRun) {
      emit({ type: 'error', kind: 'mcp', message: 'codex app-server exited: ' + detail });
      finishActive();
    }
    clearProviderSensitiveValues();
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
    closeProviderRoute();
    if (activeRun) {
      emit({ type: 'error', kind: 'mcp', message: err.message });
      finishActive();
    }
    clearProviderSensitiveValues();
  }

  function clearSpawnCredentialCopies(runtimeConfig, spawnEnvironment, extraNames = []) {
    const names = new Set(extraNames);
    for (const header of runtimeConfig?.envHeaders || []) {
      names.add(header.envName);
      header.value = undefined;
    }
    for (const name of names) delete spawnEnvironment[name];
  }

  function selectedProviderProfile() {
    const selected = providerProfileOverride || (getProviderProfile ? getProviderProfile() : null);
    if (!selected) return null;
    const provider = selected.provider || selected;
    const modelId = String(selected.modelId || '').trim();
    const runtimeModelId = String(getModel ? getModel() : '').trim();
    if (!provider) throw new Error('Custom provider is unavailable');
    if (!modelId || modelId !== runtimeModelId) {
      throw new Error('Custom provider model binding is unavailable');
    }
    if (typeof resolveRequestProfile !== 'function') {
      throw new Error('Custom provider credential resolver is unavailable');
    }
    const route = selectRoute(provider, {
      client: 'codex',
      modelId,
      feature: 'generate',
    });
    if (!route?.ok) {
      const code = route?.reasonCode === 'needs-probe'
        ? 'provider_preflight_required'
        : 'provider_route_unavailable';
      throw providerModelError(code, `Custom provider has no verified Codex route for model ${modelId}`);
    }
    return { provider, modelId, route };
  }

  function normalizedProviderProfile(selected) {
    if (!selected) return null;
    const provider = selected.provider || selected;
    const modelId = String(selected.modelId || '').trim();
    let route = null;
    try {
      route = selectRoute(provider, {
        client: 'codex',
        modelId,
        feature: 'generate',
      });
    } catch {
      route = null;
    }
    return {
      provider,
      modelId,
      route,
    };
  }

  function providerProfileMatchesCandidate(profile, candidate) {
    if (!profile?.provider || !candidate?.provider) return false;
    const profileProviderId = String(profile.provider.id || '').trim();
    const candidateProviderId = String(candidate.provider.id || '').trim();
    const profileBaseUrl = String(profile.provider.baseUrl || '').trim();
    const candidateBaseUrl = String(candidate.provider.baseUrl || '').trim();
    const profileRequestRevision = profile.provider.requestProfileRevision
      ?? profile.provider.authProfileRevision
      ?? null;
    const candidateRequestRevision = candidate.provider.requestProfileRevision
      ?? candidate.provider.authProfileRevision
      ?? null;
    const profileModelListRevision = profile.provider.modelList?.revision ?? null;
    const candidateModelListRevision = candidate.provider.modelList?.revision ?? null;
    return Boolean(
      profileProviderId
      && profileProviderId === candidateProviderId
      && profileBaseUrl === candidateBaseUrl
      && profileRequestRevision === candidateRequestRevision
      && profileModelListRevision === candidateModelListRevision
      && profile.route?.ok === true
      && profile.modelId === candidate.modelId,
    );
  }

  function currentProviderCandidate() {
    const selected = getProviderCandidate ? getProviderCandidate() : null;
    if (!selected) return null;
    const provider = selected.provider || selected;
    const modelId = String(selected.modelId || '').trim();
    const runtimeModelId = String(getModel ? getModel() : '').trim();
    if (!provider) {
      throw providerModelError('provider_candidate_unavailable', 'Selected custom provider is unavailable');
    }
    if (!modelId || modelId !== runtimeModelId) {
      throw providerModelError('provider_model_binding_unavailable', 'Selected custom provider model binding is unavailable');
    }
    return { provider, modelId };
  }

  async function ensureProviderProfileForSend() {
    const candidate = currentProviderCandidate();
    if (!candidate) return true;

    const override = normalizedProviderProfile(providerProfileOverride);
    if (providerProfileMatchesCandidate(override, candidate)) return true;

    let configured = null;
    try {
      configured = normalizedProviderProfile(getProviderProfile ? getProviderProfile() : null);
    } catch {
      configured = null;
    }

    const sequence = providerRecoverySequence + 1;
    providerRecoverySequence = sequence;
    detachRuntimeForProviderRecovery();
    providerProfileOverride = null;
    if (providerProfileMatchesCandidate(configured, candidate)) {
      providerProfileOverride = configured;
      return true;
    }
    if (typeof recoverProviderProfile !== 'function') {
      throw providerModelError(
        'provider_preflight_unavailable',
        `Custom provider cannot be verified for model ${candidate.modelId}`,
      );
    }

    let recovered;
    try {
      recovered = await recoverProviderProfile(
        candidate.provider,
        { status: null, code: 'provider_preflight_required' },
        candidate.modelId,
      );
    } catch (error) {
      if (sequence !== providerRecoverySequence || !activeRun) return false;
      throw providerModelError(
        'provider_preflight_failed',
        error?.message || `Custom provider could not verify model ${candidate.modelId}`,
      );
    }
    if (sequence !== providerRecoverySequence || !activeRun) return false;

    const profile = normalizedProviderProfile(recovered);
    const currentModelId = String(getModel ? getModel() : '').trim();
    if (!providerProfileMatchesCandidate(profile, candidate) || currentModelId !== candidate.modelId) {
      throw providerModelError(
        'provider_preflight_failed',
        `Custom provider did not expose a verified API for model ${candidate.modelId}`,
      );
    }
    providerProfileOverride = profile;
    providerRefreshPending = true;
    return true;
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
      stopping = false;
      const cliInfo = await resolveCli({ env: spawnEnv, platform: adapter });
      assertCurrentStart();
      if (!cliInfo || !cliInfo.ok) throw new Error((cliInfo && cliInfo.detail) || 'codex CLI is unavailable');
      lastCliInfo = cliInfo;
      const executable = cliInfo.executable || {
        ok: true, id: 'codex', path: cliInfo.cliPath, argsPrefix: [], source: 'path', version: cliInfo.version || null, arch: null,
      };
      const selected = selectedProviderProfile();
      let runtimeConfig = null;
      if (selected) {
        closeProviderRoute();
        providerRoute = providerRouteFactory({
          provider: selected.provider,
          resolveCapability: ({ provider, modelId, clientProtocol, feature }) => selectRoute(provider, {
            client: clientProtocol === 'messages' ? 'claude-code' : 'codex',
            modelId,
            feature,
          }),
          resolveRequestProfile,
        });
        const routeInfo = await providerRoute.start();
        assertCurrentStart();
        runtimeConfig = {
          providerId: selected.provider.id,
          baseUrl: routeInfo.openaiBaseUrl || routeInfo.baseUrl,
          chatCompatibility: selected.route.upstreamProtocol !== 'responses',
          envHeaders: [{
            name: LOCAL_ROUTE_TOKEN_HEADER,
            envName: 'AE_MCP_PROVIDER_HEADER_00',
            value: routeInfo.routeToken,
          }],
        };
        setProviderSensitiveValues([routeInfo.routeToken]);
      } else {
        setProviderSensitiveValues([]);
      }
      let spawnEnvWithCreds = codexSpawnEnv(runtimeConfig, spawnEnv);
      const extraCredentialEnvNames = [];
      // Only inherit cli-config's provider env var when the panel has no
      // explicit custom provider configured — an explicit
      // custom provider always wins.
      if (!selected) {
        const cliConfig = getCliConfigProvider ? getCliConfigProvider() : null;
        const envKey = cliConfig && cliConfig.provider && String(cliConfig.provider.envKey || '').trim();
        if (envKey && cliConfig.apiKey) {
          spawnEnvWithCreds = Object.assign({}, spawnEnvWithCreds, { [envKey]: cliConfig.apiKey });
          extraCredentialEnvNames.push(envKey);
          setProviderSensitiveValues([String(cliConfig.apiKey)]);
        }
      }
      assertCurrentStart();
      let spawnedProc;
      try {
        spawnedProc = adapter.spawn(executable, codexAppServerArgs(runtimeConfig), {
          stdio: 'pipe',
          windowsHide: true,
          env: spawnEnvWithCreds,
        });
      } finally {
        clearSpawnCredentialCopies(runtimeConfig, spawnEnvWithCreds, extraCredentialEnvNames);
      }
      proc = spawnedProc;
      const generation = startGeneration + 1;
      runtimeGeneration = generation;
      const nextRpc = createRpc({
        writeLine: (line) => spawnedProc.stdin.write(line),
        onNotification: handleNotification,
        onRequest: handleRequest,
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
        closeProviderRoute();
        clearProviderSensitiveValues();
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
    const mcpSpec = await getMcpSpec();
    toolMeta = getToolMeta ? await getToolMeta() : { allowedTools: [], annotations: {} };
    if (threadGeneration !== runtimeGeneration || rpc !== threadRpc) {
      throw new Error('Codex thread start was cancelled');
    }
    const spawnEnv = currentEnv();
    const result = await threadRpc.request('thread/start', {
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
    if (threadGeneration !== runtimeGeneration || rpc !== threadRpc) {
      throw new Error('Codex thread start was cancelled');
    }
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
    rpc.request('turn/start', turnParams(turnText), 180000).catch((error) => {
      void handleTurnFailure(error);
    });
  }

  async function attemptProviderRecovery(error) {
    if (providerRecoveryInFlight) return true;
    if (
      providerRecoveryAttempted
      || !activeRun
      || typeof recoverProviderProfile !== 'function'
      || !recoverableProviderFailure(error)
    ) return false;

    let selected;
    try { selected = selectedProviderProfile(); } catch { return false; }
    if (!selected) return false;

    providerRecoveryAttempted = true;
    providerRecoveryInFlight = true;
    const sequence = providerRecoverySequence + 1;
    providerRecoverySequence = sequence;
    detachRuntimeForProviderRecovery();

    let recovered;
    try {
      recovered = await recoverProviderProfile(
        selected.provider,
        providerFailureFacts(error),
        selected.modelId,
      );
    } catch {
      recovered = null;
    }
    if (sequence !== providerRecoverySequence || !activeRun) return true;
    providerRecoveryInFlight = false;
    const profile = normalizedProviderProfile(recovered);
    const provider = profile?.provider;
    const modelId = profile?.modelId || '';
    if (
      !provider
      || String(provider.id || '').trim() !== String(selected.provider.id || '').trim()
      || profile.route?.ok !== true
      || modelId !== selected.modelId
      || modelId !== String(getModel ? getModel() : '').trim()
    ) return false;
    providerProfileOverride = profile;
    providerRefreshPending = true;
    await launchActiveTurn();
    return true;
  }

  async function handleTurnFailure(error) {
    if (!activeRun || providerRecoveryInFlight || turnFailureInFlight) return;
    turnFailureInFlight = true;
    try {
      let failure = {
        kind: error?.kind,
        code: error?.code,
        message: redactValue(error?.message || 'Failed to start Codex turn.', providerSensitiveValues),
      };
      try {
        if (await attemptProviderRecovery(error)) return;
      } catch (recoveryError) {
        failure = {
          kind: recoveryError?.kind,
          code: recoveryError?.code,
          message: redactValue(recoveryError?.message || 'Failed to start Codex turn.', providerSensitiveValues),
        };
      }
      providerDeltaRedactor.discard();
      const message = failure?.message || 'Failed to start Codex turn.';
      const providerHttpFailure = /\bunexpected status\s+\d{3}\b.*\burl:\s*https?:\/\//i.test(message);
      emit({
        type: 'error',
        kind: failure?.kind || (providerHttpFailure || /model/i.test(message) ? 'model' : 'mcp'),
        ...(failure?.code ? { code: failure.code } : {}),
        message,
      });
      finishActive();
    } finally {
      turnFailureInFlight = false;
    }
  }

  async function sendUser(text) {
    if (activeRun) return activeRun;
    activeAssistantText = '';
    activeUserText = String(text || '');
    activeUserRecorded = false;
    providerRecoveryAttempted = false;
    providerRecoveryInFlight = false;
    turnFailureInFlight = false;
    providerRecoverySequence += 1;
    activeRun = new Promise((resolve) => {
      activeResolve = resolve;
    });
    const run = activeRun;

    try {
      if (await ensureProviderProfileForSend()) await launchActiveTurn();
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
    providerRecoverySequence += 1;
    // turn/interrupt requires BOTH ids (schema: TurnInterruptParams);
    // without an active turn there is nothing to interrupt server-side.
    if (rpc && threadId && currentTurnId) {
      rpc.fireRequest('turn/interrupt', { threadId, turnId: currentTurnId });
    }
    drainApprovals();
    providerDeltaRedactor.discard();
    if (activeRun) {
      emit({ type: 'error', kind: 'aborted', message: 'Turn aborted.' });
      finishActive();
    }
  }

  function reset() {
    stopping = true;
    runtimeGeneration += 1;
    providerRecoverySequence += 1;
    closeProviderRoute();
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
    sessionAllowedPlans.clear();
    toolMeta = { allowedTools: [], annotations: {} };
    providerProfileOverride = null;
    finishActive();
    stderrTail = '';
    clearProviderSensitiveValues();
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
