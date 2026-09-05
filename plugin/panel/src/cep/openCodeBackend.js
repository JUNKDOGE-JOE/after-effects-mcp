import { createSseParser } from '../lib/sse.js';
import { captureToolImages, toolDisplayText } from './toolImages.js';
import { cliIdentity } from '../lib/cliUpdates.js';
import { openCodeCatalogId } from '../lib/openCodeCatalogId.js';
import { createPlatformAdapter } from './platform/index.js';
import { createDeltaRedactor, redactValue } from '../lib/exactSecretRedaction.js';
import {
  boundedResolution,
  classifyErrorCode,
  extractHttpStatus,
  trimStderrTail,
} from '../lib/errorCodes.js';
import { openCodeProviderDefinitions } from './openCodeProviderStore.js';
import {
  OPEN_CODE_HISTORY_GUARD_FILENAME,
  openCodeHistoryGuardPluginSource,
} from './openCodeHistoryGuard.js';
import { attachmentFileUrl, normalizeTurnInput } from '../../../shared/chat-attachments.mjs';
import { displayAnswers, questionsFromUserInput } from '../lib/questionForm.js';

const READY_TIMEOUT_MS = 30000;
const PROBE_TIMEOUT_MS = 40000;
const READY_POLL_MS = 250;
const READY_REQUEST_TIMEOUT_MS = 1500;
export const OPENCODE_STALL_WARNING_MS = 180000;
export const OPENCODE_STALL_TIMEOUT_MS = 300000;
export const OPENCODE_FINALIZATION_TIMEOUT_MS = 5000;
const DEFAULT_PROVIDER_ID = 'opencode';
const DEFAULT_MODEL_ID = 'hy3-free';
const STDERR_TAIL_LIMIT = 4096;
const STALE_TERMINATE_LIMIT = 8;
const STALE_REMOVE_LIMIT = 64;
const PANEL_HOST_GENERATION = [
  Date.now().toString(36),
  Math.random().toString(36).slice(2),
].join('-');

export const OPEN_CODE_DISABLED_BUILTIN_TOOL_NAMES = Object.freeze([
  'apply_patch',
  'bash',
  'batch',
  'codesearch',
  'edit',
  'glob',
  'grep',
  'invalid',
  'list',
  'lsp',
  'plan_enter',
  'plan_exit',
  'read',
  'skill',
  'task',
  'todoread',
  'todowrite',
  'webfetch',
  'websearch',
  'write',
]);

function getCepRequire() {
  if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) {
    return globalThis.window.cep_node.require;
  }
  if (globalThis.window && globalThis.window.require) return globalThis.window.require;
  if (globalThis.require) return globalThis.require;
  throw new Error('CEP Node require is unavailable');
}

function defaultFetch() {
  if (globalThis.window && globalThis.window.fetch) return globalThis.window.fetch.bind(globalThis.window);
  if (globalThis.fetch) return globalThis.fetch.bind(globalThis);
  throw new Error('fetch is unavailable');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendTail(tail, chunk) {
  const next = tail + String(chunk || '');
  return next.length > STDERR_TAIL_LIMIT
    ? next.slice(next.length - STDERR_TAIL_LIMIT)
    : next;
}

function endpointPath(value) {
  const path = String(value || '').split(/[?#]/, 1)[0];
  return path.startsWith('/') ? path : '/';
}

function resolutionArchitecture(resolution) {
  for (const attempt of resolution?.attempts || []) {
    const match = String(attempt?.detail || '').match(/architecture\s+(arm64|aarch64|x64|amd64|x86_64)\b/i);
    if (match) return match[1];
  }
  return '';
}

function openCodeResolutionMessage(code, lang, resolution) {
  if (code === 'VERSION_TOO_OLD') {
    return lang === 'zh'
      ? 'OpenCode CLI 版本过旧，请升级后重新检测。'
      : 'OpenCode CLI is too old. Upgrade it and re-check.';
  }
  if (code === 'ARCH_MISMATCH') {
    const found = resolutionArchitecture(resolution);
    if (lang === 'zh') {
      return found
        ? `OpenCode CLI 架构不匹配：找到的是 ${found} 架构。请安装与 After Effects 一致的版本。`
        : 'OpenCode CLI 架构不匹配。请安装与 After Effects 一致的版本。';
    }
    return found
      ? `OpenCode CLI architecture mismatch: the detected executable is ${found}. Install a build matching After Effects.`
      : 'OpenCode CLI architecture mismatch. Install a build matching After Effects.';
  }
  if (code === 'PROBE_FAILED') {
    return lang === 'zh'
      ? '已找到 OpenCode CLI，但版本探针启动失败。请在终端确认 opencode --version 可正常运行。'
      : 'OpenCode CLI was found, but its version probe failed. Confirm opencode --version runs in a terminal.';
  }
  return lang === 'zh'
    ? '未找到 OpenCode CLI。请安装 OpenCode CLI，并确保 opencode 在 PATH 中。'
    : 'OpenCode CLI was not found. Install OpenCode CLI and put opencode on PATH.';
}

function taggedError(error, property, value) {
  const result = error instanceof Error
    ? error
    : new Error(error?.message || String(error || value));
  result[property] = value;
  return result;
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

function prefixedToolName(raw) {
  const text = String(raw || '');
  if (!text) return '';
  if (text.startsWith('mcp__')) return text;
  if (!text.startsWith('ae_')) return text;
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

function boundedCauseChain(value, limit = 6) {
  const messages = [];
  const seen = new Set();
  function visit(candidate, depth) {
    if (candidate === undefined || candidate === null || depth > 5 || messages.length >= limit) return;
    if (typeof candidate === 'string') {
      const text = candidate.trim().slice(0, 500);
      if (text && !messages.includes(text)) messages.push(text);
      return;
    }
    if (typeof candidate !== 'object' || seen.has(candidate)) return;
    seen.add(candidate);
    for (const field of ['message', 'code', 'statusCode', 'status']) {
      const item = candidate[field];
      if (typeof item === 'string' || typeof item === 'number') visit(String(item), depth + 1);
    }
    visit(candidate.cause, depth + 1);
    visit(candidate.error, depth + 1);
    if (candidate.data && typeof candidate.data === 'object') {
      visit(candidate.data.message, depth + 1);
      visit(candidate.data.cause, depth + 1);
      visit(candidate.data.error, depth + 1);
      visit(candidate.data.statusCode, depth + 1);
    }
  }
  visit(value, 0);
  return messages;
}

// /config/providers may also contain provider options and credentials. Reduce
// it immediately to the only facts the model picker needs, so secrets never
// enter React state, diagnostics, or exported logs.
export function sanitizeOpenCodeProviderFacts(value) {
  const source = Array.isArray(value?.providers)
    ? value.providers
    : Array.isArray(value)
      ? value
      : value && typeof value === 'object'
        ? Object.entries(value).filter(([key]) => key !== 'default').map(([key, provider]) => ({
          ...(provider && typeof provider === 'object' ? provider : {}),
          id: provider?.id || provider?.providerID || provider?.providerId || key,
        }))
        : [];
  const providers = [];
  for (const provider of source) {
    if (!provider || typeof provider !== 'object') continue;
    const id = openCodeCatalogId(
      provider.id || provider.providerID || provider.providerId || provider.name,
    );
    if (!id) continue;
    const rawModels = Array.isArray(provider.models)
      ? provider.models
      : provider.models && typeof provider.models === 'object'
        ? Object.entries(provider.models).map(([key, model]) => ({
          ...(model && typeof model === 'object' ? model : {}),
          id: model?.id || model?.modelID || model?.modelId || key,
        }))
        : [];
    const modelIds = Array.from(new Set(rawModels.map((model) => (
      openCodeCatalogId(model && typeof model === 'object'
        ? (model.id || model.modelID || model.modelId || model.name)
        : model)
    )).filter(Boolean)));
    if (modelIds.length) providers.push({ id, modelIds, needsApiKey: false });
  }
  return providers;
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

function permissionReplyBody(decision) {
  if (decision === 'deny') return { action: 'deny', remember: false };
  return { action: 'allow', remember: decision === 'allow-session' };
}

function permissionReplyPath(sessionId, permissionId) {
  return '/session/' + encodeURIComponent(sessionId) + '/permission/' + encodeURIComponent(permissionId);
}

function questionsFromOpenCode(value) {
  const raw = Array.isArray(value) ? value : [];
  const questions = questionsFromUserInput({
    questions: raw.map((question) => ({
      ...question,
      multiSelect: Boolean(question && question.multiple),
    })),
  });
  return questions.map((question, index) => ({
    ...question,
    allowCustom: raw[index]?.custom !== false,
  }));
}

function answersForOpenCode(questions, values) {
  return questions.map((question) => {
    const value = values && typeof values === 'object' ? values[question.id] : undefined;
    if (question.multiSelect) {
      const list = Array.isArray(value) ? value : (value ? [value] : []);
      return list.map((item) => String(item));
    }
    const selected = Array.isArray(value) ? value[0] : value;
    return selected === undefined || selected === null || selected === ''
      ? []
      : [String(selected)];
  });
}

function valuesFromOpenCodeAnswers(questions, answers) {
  const values = {};
  questions.forEach((question, index) => {
    const list = Array.isArray(answers?.[index]) ? answers[index].map((item) => String(item)) : [];
    values[question.id] = question.multiSelect ? list : (list[0] || '');
  });
  return values;
}

function questionReplyPath(questionId, action) {
  return '/question/' + encodeURIComponent(questionId) + '/' + action;
}

function isBuiltInQuestionTool(part) {
  return String(part?.tool || part?.name || '').toLowerCase() === 'question';
}

export function createOpenCodeBackend({
  platform,
  fetchImpl,
  getPort = defaultGetPort,
  fsImpl,
  getModel,
  getPermissionMode,
  getMcpSpec,
  getToolMeta,
  getProviders = () => [],
  getSensitiveValues = () => [],
  onEvent,
  env,
  getLang,
  lang = 'zh',
  readyTimeoutMs = READY_TIMEOUT_MS,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
  readyPollMs = READY_POLL_MS,
  readyRequestTimeoutMs = READY_REQUEST_TIMEOUT_MS,
  stallWarningMs = OPENCODE_STALL_WARNING_MS,
  stallTimeoutMs = OPENCODE_STALL_TIMEOUT_MS,
  now = () => Date.now(),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  sleepImpl = sleep,
  onSweepComplete,
  hostGeneration = PANEL_HOST_GENERATION,
} = {}) {
  const adapter = platform || createPlatformAdapter();
  if (!Number.isFinite(readyRequestTimeoutMs)
    || readyRequestTimeoutMs <= 0
    || readyRequestTimeoutMs < readyPollMs) {
    throw new RangeError('OpenCode readiness request timeout must be at least the poll interval');
  }
  if (!Number.isFinite(stallWarningMs) || !Number.isFinite(stallTimeoutMs)
    || stallWarningMs <= 0 || stallTimeoutMs <= stallWarningMs) {
    throw new RangeError('OpenCode stall timeout must be greater than its warning timeout');
  }
  // OpenCode isolates sessions and its event bus by request directory. Keep
  // the default cwd stable so resumed sessions publish to this panel's bus.
  const openCodeRoot = adapter.paths.join([adapter.paths.configRoot, 'opencode']);
  const workspaceDir = adapter.paths.join([openCodeRoot, 'workspace']);
  const totalProbeTimeoutMs = Number(probeTimeoutMs);
  if (!Number.isFinite(totalProbeTimeoutMs) || totalProbeTimeoutMs <= readyTimeoutMs) {
    throw new TypeError('probeTimeoutMs must be greater than readyTimeoutMs');
  }
  const currentLang = () => (typeof getLang === 'function' ? getLang() : lang) || 'zh';
  const currentHostGeneration = String(hostGeneration || PANEL_HOST_GENERATION);
  let proc = null;
  let runningCli = null;
  let port = null;
  let baseUrl = '';
  let configHome = '';
  let sessionId = null;
  let adoptedSessionId = null;
  let sessionWasAdopted = false;
  let serverPromise = null;
  let sweeping = null;
  let sessionPromise = null;
  let sseStarted = false;
  let sseClosed = false;
  let stopping = false;
  let stderrTail = '';
  let activeRun = null;
  let activeResolve = null;
  let activeAssistantText = '';
  let activeAttachmentPaths = [];
  let processStderrAttachmentPaths = [];
  let assistantDeltaRedactor = createDeltaRedactor([], () => {});
  let stderrRedactor = createDeltaRedactor([], () => {});
  let activeTurn = null;
  let activeTurnAccepted = false;
  let messageDispatched = false;
  let turnStarted = false;
  let stopRequested = false;
  let stallTimer = null;
  let stallLastActivityAt = 0;
  let stallWarningEmitted = false;
  let messageAbortController = null;
  let generation = 0;
  let aeMcpRecoveryAttempts = 0;
  let aeMcpRecoveryStarted = false;
  let aeMcpRecoveryPromise = null;
  let toolMeta = { annotations: {} };
  const pendingApprovals = new Map();
  const pendingQuestions = new Map();
  const sessionAllowedTools = new Set();
  const startedTools = new Set();
  const partTypes = new Map();
  const transcript = [];

  function redactionValues(paths = []) {
    let providerSecrets = [];
    try {
      providerSecrets = getSensitiveValues();
    } catch {}
    return Array.from(new Set([
      ...(Array.isArray(providerSecrets) ? providerSecrets : []),
      ...paths,
    ].filter((item) => typeof item === 'string' && item)));
  }

  function invalidateSession() {
    const invalidated = sessionId || adoptedSessionId;
    settleFailedTurnInteractions();
    sessionId = null;
    adoptedSessionId = null;
    sessionWasAdopted = false;
    sessionPromise = null;
    sessionAllowedTools.clear();
    return Boolean(invalidated);
  }

  function settlePendingQuestions() {
    for (const [questionId] of pendingQuestions) {
      pendingQuestions.delete(questionId);
      emitAfterText({ type: 'question-resolved', toolUseId: questionId, outcome: 'cancelled' });
    }
  }

  function settleFailedTurnInteractions() {
    settlePendingQuestions();
    for (const [permissionId] of pendingApprovals) {
      emit({ type: 'tool-denied', toolUseId: permissionId });
    }
    pendingApprovals.clear();
    startedTools.clear();
    partTypes.clear();
  }

  function emit(evt) {
    if (onEvent) onEvent(redactValue(evt, redactionValues(activeAttachmentPaths)));
  }

  function emitAfterText(evt) {
    assistantDeltaRedactor.flush();
    emit(evt);
  }

  function clearStallWatchdog() {
    if (stallTimer !== null) clearTimeoutImpl(stallTimer);
    stallTimer = null;
    stallLastActivityAt = 0;
    stallWarningEmitted = false;
  }

  function armStallWatchdog() {
    if (!activeRun || stopRequested || pendingQuestions.size > 0 || pendingApprovals.size > 0) return;
    if (stallTimer !== null) clearTimeoutImpl(stallTimer);
    stallLastActivityAt = now();
    stallWarningEmitted = false;
    scheduleStallWatchdog();
  }

  function touchStallWatchdog() {
    if (activeRun && !stopRequested) armStallWatchdog();
  }

  function suspendStallWatchdogForPendingInteraction() {
    clearStallWatchdog();
  }

  function resumeStallWatchdogAfterPendingInteraction() {
    if (pendingQuestions.size === 0 && pendingApprovals.size === 0) {
      armStallWatchdog();
    }
  }

  function scheduleStallWatchdog() {
    if (!activeRun || stopRequested) return;
    const elapsedMs = Math.max(0, now() - stallLastActivityAt);
    const deadline = stallWarningEmitted ? stallTimeoutMs : stallWarningMs;
    stallTimer = setTimeoutImpl(() => {
      stallTimer = null;
      if (!activeRun || stopRequested) return;
      const currentElapsedMs = Math.max(0, now() - stallLastActivityAt);
      if (!stallWarningEmitted && currentElapsedMs >= stallWarningMs) {
        stallWarningEmitted = true;
        emit({ type: 'turn-progress-warning', turnId: activeTurn?.turnId, elapsedMs: currentElapsedMs, warningMs: stallWarningMs });
      }
      if (currentElapsedMs >= stallTimeoutMs) {
        void terminateStalledTurn();
      } else {
        scheduleStallWatchdog();
      }
    }, Math.max(1, deadline - elapsedMs));
  }

  async function terminateStalledTurn() {
    if (!activeRun || stopRequested) return;
    stopRequested = true;
    messageAbortController?.abort();
    await finalizeActiveTurnRequests();
    if (activeRun) {
      emitAfterText({
        type: 'error',
        kind: 'network',
        code: 'PROVIDER_STREAM_STALLED',
        message: 'The OpenCode provider stream was silent for over five minutes, so this turn was stopped.',
        ...activeTurnFailureFields(),
      });
      finishActive();
    }
  }

  function emitTurnProgress(stage) {
    if (!activeRun || !activeTurn) return;
    emit({
      type: 'turn-progress',
      ...(activeTurn.turnId ? { turnId: activeTurn.turnId } : {}),
      stage,
    });
  }

  function resetAssistantDeltaRedactor() {
    assistantDeltaRedactor.discard();
    assistantDeltaRedactor = createDeltaRedactor(redactionValues(activeAttachmentPaths), (text) => {
      activeAssistantText += text;
      emit({ type: 'text-delta', text });
    });
  }

  function resetStderrRedactor() {
    stderrRedactor.discard();
    stderrRedactor = createDeltaRedactor(redactionValues(processStderrAttachmentPaths), (text) => {
      stderrTail = appendTail(stderrTail, text);
    });
  }

  function setActiveAttachmentPaths(values) {
    activeAttachmentPaths = Array.from(new Set((values || [])
      .filter((value) => typeof value === 'string' && value)))
      .sort((left, right) => right.length - left.length);
    if (stderrTail) stderrTail = redactValue(stderrTail, redactionValues(activeAttachmentPaths));
    const previousProcessPathCount = processStderrAttachmentPaths.length;
    processStderrAttachmentPaths = Array.from(new Set([
      ...processStderrAttachmentPaths,
      ...activeAttachmentPaths,
    ])).sort((left, right) => right.length - left.length);
    resetAssistantDeltaRedactor();
    if (processStderrAttachmentPaths.length !== previousProcessPathCount) {
      resetStderrRedactor();
    }
  }

  function clearProcessStderrAttachmentPaths() {
    processStderrAttachmentPaths = [];
    resetStderrRedactor();
  }

  function fetcher() {
    return fetchImpl || defaultFetch();
  }

  function currentEnv() {
    return adapter.completeSpawnEnv(env || {});
  }

  function stableConfigHome(mcpSpec) {
    let hostPort = 'default';
    try {
      hostPort = new URL(String(mcpSpec?.url || '')).port || 'default';
    } catch {}
    return adapter.paths.join([openCodeRoot, 'home-' + hostPort]);
  }

  function instanceMarkerPath(home) {
    return adapter.paths.join([home, 'instance.json']);
  }

  function removeInstanceMarker(home) {
    if (!home) return;
    try {
      const fs = fsImpl || adapter.fs;
      const markerPath = instanceMarkerPath(home);
      if (typeof fs.existsSync === 'function' && !fs.existsSync(markerPath)) return;
      fs.rmSync(markerPath, { force: true });
    } catch {}
  }

  function readInstanceMarker(home) {
    const fs = fsImpl || adapter.fs;
    if (!home || typeof fs?.readFileSync !== 'function') return null;
    try {
      const markerPath = instanceMarkerPath(home);
      if (typeof fs.existsSync === 'function' && !fs.existsSync(markerPath)) return null;
      return JSON.parse(String(fs.readFileSync(markerPath, 'utf8')));
    } catch {
      return null;
    }
  }

  async function reclaimStableInstance(home) {
    const marker = readInstanceMarker(home);
    if (marker?.owner === 'ae-mcp-panel' && marker.pid) {
      const ownerPid = Number(marker.ownerPid);
      let ownedElsewhere = false;
      if (Number.isInteger(ownerPid) && ownerPid > 0 && ownerPid !== adapter.pid) {
        try {
          ownedElsewhere = await adapter.processAlive({ pid: ownerPid });
        } catch {}
      }
      if (marker.hostGeneration !== currentHostGeneration || !ownedElsewhere) {
        try {
          await adapter.terminateProcess({ pid: marker.pid, executableName: 'opencode' });
        } catch {}
      }
    }
    removeInstanceMarker(home);
  }

  async function removeStaleDirectory(home) {
    if (!home) return false;
    const fs = fsImpl || adapter.fs;
    const options = { recursive: true, force: true };
    try {
      if (fs?.promises && typeof fs.promises.rm === 'function') {
        await fs.promises.rm(home, options);
      } else if (typeof fs?.rm === 'function') {
        await new Promise((resolve, reject) => {
          fs.rm(home, options, (error) => {
            if (error) reject(error);
            else resolve();
          });
        });
      } else {
        removeConfigHomeSyncFallback(home);
      }
      return true;
    } catch {
      return false;
    }
  }

  function sweepStaleInstances(skipHome = configHome) {
    if (sweeping) return sweeping;
    const fs = fsImpl || adapter.fs;
    if (!fs || typeof fs.readdirSync !== 'function') return Promise.resolve();

    let entries;
    try {
      entries = fs.readdirSync(adapter.paths.tempRoot);
    } catch {
      return Promise.resolve();
    }

    const pendingSweep = (async () => {
      let terminated = 0;
      let removed = 0;
      for (const entry of entries || []) {
        if (removed >= STALE_REMOVE_LIMIT) break;
        const name = String(entry?.name || entry || '');
        if (!name.startsWith('ae-opencode-')) continue;
        const home = adapter.paths.join([adapter.paths.tempRoot, name]);
        if (home === skipHome) continue;

        let marker = null;
        try {
          const markerPath = adapter.paths.join([home, 'instance.json']);
          const exists = typeof fs.existsSync !== 'function' || fs.existsSync(markerPath);
          if (exists && typeof fs.readFileSync === 'function') {
            marker = JSON.parse(String(fs.readFileSync(markerPath, 'utf8')));
          }
        } catch {}

        const ownerPid = Number(marker?.ownerPid);
        if (marker?.owner === 'ae-mcp-panel'
          && Number.isInteger(ownerPid)
          && ownerPid > 0
          && ownerPid !== adapter.pid) {
          let ownerAlive = false;
          try {
            ownerAlive = await adapter.processAlive({ pid: ownerPid });
          } catch {}
          if (ownerAlive) continue;
        }

        if (marker?.owner === 'ae-mcp-panel' && marker.pid) {
          if (terminated >= STALE_TERMINATE_LIMIT) continue;
          terminated += 1;
          try {
            await adapter.terminateProcess({ pid: marker.pid, executableName: 'opencode' });
          } catch {}
        }

        removed += 1;
        await removeStaleDirectory(home);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    })().catch(() => {});

    sweeping = pendingSweep;
    pendingSweep.finally(() => {
      if (sweeping === pendingSweep) sweeping = null;
      try {
        if (typeof onSweepComplete === 'function') onSweepComplete();
      } catch {}
    });
    return pendingSweep;
  }

  function backendFs() {
    return fsImpl || adapter.fs;
  }

  function removeConfigHomeSyncFallback(home) {
    if (!home) return;
    try {
      backendFs().rmSync(home, { recursive: true, force: true });
    } catch (error) {
      // A live process may still hold its cwd on Windows; a later sweep retries.
    }
  }

  function writeInstanceMarker(home, spawnedProc, instancePort) {
    try {
      backendFs().writeFileSync(
        adapter.paths.join([home, 'instance.json']),
        JSON.stringify({
          owner: 'ae-mcp-panel',
          ownerPid: adapter.pid,
          pid: spawnedProc.pid,
          hostGeneration: currentHostGeneration,
          port: instancePort,
          startedAt: new Date().toISOString(),
        }),
      );
    } catch (error) {
      // Marker failure must not turn a healthy CLI spawn into a failed chat.
    }
  }

  function cancelledStartError() {
    const error = new Error('OpenCode start was cancelled');
    error.categoryCode = 'CANCELLED';
    return error;
  }

  function finishActive() {
    clearStallWatchdog();
    if (!activeResolve) {
      activeRun = null;
      activeAssistantText = '';
      activeTurn = null;
      activeTurnAccepted = false;
      messageDispatched = false;
      turnStarted = false;
      aeMcpRecoveryAttempts = 0;
      aeMcpRecoveryStarted = false;
      aeMcpRecoveryPromise = null;
      startedTools.clear();
      partTypes.clear();
      setActiveAttachmentPaths([]);
      return;
    }
    const resolve = activeResolve;
    activeResolve = null;
    activeRun = null;
    activeAssistantText = '';
    activeTurn = null;
    activeTurnAccepted = false;
    messageDispatched = false;
    turnStarted = false;
    aeMcpRecoveryAttempts = 0;
    aeMcpRecoveryStarted = false;
    aeMcpRecoveryPromise = null;
    startedTools.clear();
    partTypes.clear();
    setActiveAttachmentPaths([]);
    resolve();
  }

  async function request(path, options = {}, requestBaseUrl = baseUrl) {
    const endpoint = endpointPath(path);
    let response;
    try {
      response = await fetcher()(requestBaseUrl + path, options);
    } catch (error) {
      throw taggedError(error, 'endpoint', endpoint);
    }
    if (!response || !response.ok) {
      const error = new Error('OpenCode request failed.');
      if (Number.isInteger(Number(response?.status))) error.httpStatus = Number(response.status);
      error.endpoint = endpoint;
      if (response && typeof response.text === 'function') {
        try {
          const excerpt = String(await response.text()).slice(0, 200);
          if (excerpt) error.responseExcerpt = excerpt;
        } catch {}
      }
      throw error;
    }
    return response;
  }

  function activeTurnFailureFields() {
    if (!activeTurn?.turnId) return {};
    return {
      turnId: activeTurn.turnId,
      ...(!activeTurnAccepted ? {
        dispatchState: messageDispatched ? 'uncertain' : 'not-started',
      } : {}),
    };
  }

  function isAeMcpTransportFailure(value, text = '', { allowBareNotConnected = false } = {}) {
    // Session errors have no tool identity, so require the JSON-RPC code there
    // instead of replaying a turn for an unrelated provider disconnection.
    const combined = [String(text || '')];
    try { combined.push(JSON.stringify(value)); } catch {}
    const message = combined.filter(Boolean).join('\n');
    return /(?:mcp\s+error\s*)?-?32000\b[\s\S]{0,120}\b(?:connection\s+closed|not\s+connected)\b/i.test(message)
      || (allowBareNotConnected && /\bnot\s+connected\b/i.test(message));
  }

  function aeMcpRebuildFailureMessage() {
    return /^zh/i.test(currentLang())
      ? '与 AE 宿主的连接重建失败。请重载面板或新建会话后再试。'
      : 'The connection to the AE host could not be rebuilt. Reload the panel or start a new session, then try again.';
  }

  function aeMcpTransportRebuiltMessage() {
    return /^zh/i.test(currentLang())
      ? '与 AE 宿主的连接已重建，本轮已停止；请确认没有未完成的写入后重新发送。'
      : 'The connection to the AE host was rebuilt and this turn was stopped. Confirm that no write remains unresolved before resending.';
  }

  async function recycleAeMcpServer() {
    const staleProc = proc;
    const staleHome = configHome;
    generation += 1;
    sseClosed = true;
    sseStarted = false;
    serverPromise = null;
    messageAbortController?.abort();
    messageAbortController = null;
    invalidateSession();
    proc = null;
    port = null;
    baseUrl = '';
    configHome = '';
    removeInstanceMarker(staleHome);
    if (staleProc?.pid) {
      try {
        await adapter.terminateProcess({ pid: staleProc.pid, executableName: 'opencode' });
      } catch {}
    }
    try { staleProc?.kill?.(); } catch {}
  }

  function failAeMcpRebuild() {
    if (!activeRun || stopRequested) return;
    emitAfterText({
      type: 'error',
      kind: 'network',
      code: 'AE_MCP_REBUILD_FAILED',
      message: aeMcpRebuildFailureMessage(),
      detail: { recoveryAttempts: aeMcpRecoveryAttempts },
      ...activeTurnFailureFields(),
    });
    finishActive();
    void recycleAeMcpServer();
  }

  function recoverAeMcpTransport() {
    if (!activeRun || stopRequested) return false;
    if (aeMcpRecoveryPromise) return true;
    if (aeMcpRecoveryAttempts >= 1) {
      failAeMcpRebuild();
      return true;
    }

    aeMcpRecoveryAttempts += 1;
    aeMcpRecoveryStarted = true;
    emitTurnProgress('mcp-rebuild');
    const pendingRecovery = (async () => {
      await recycleAeMcpServer();
      if (!activeRun || stopRequested) return;
      await prepareTurnSession();
      if (!activeRun || stopRequested) return;
      emitAfterText({
        type: 'error',
        kind: 'network',
        code: 'AE_MCP_TRANSPORT_REBUILT',
        message: aeMcpTransportRebuiltMessage(),
        detail: { recoveryAttempts: aeMcpRecoveryAttempts },
        ...activeTurnFailureFields(),
      });
      finishActive();
    })();
    aeMcpRecoveryPromise = pendingRecovery;
    void pendingRecovery.then(
      () => {
        if (aeMcpRecoveryPromise === pendingRecovery) aeMcpRecoveryPromise = null;
      },
      () => {
        if (aeMcpRecoveryPromise === pendingRecovery) aeMcpRecoveryPromise = null;
        failAeMcpRebuild();
      },
    );
    return true;
  }

  async function requestJson(path, options = {}, requestBaseUrl = baseUrl) {
    const response = await request(path, options, requestBaseUrl);
    return response.json ? response.json() : {};
  }

  async function postJson(path, body, signal) {
    return requestJson(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      ...(signal ? { signal } : {}),
    });
  }

  async function finalizeActiveTurnRequests() {
    const controller = new AbortController();
    const requests = Promise.allSettled([
      rejectPendingQuestions(controller.signal),
      sessionId
        ? postJson('/session/' + encodeURIComponent(sessionId) + '/abort', {}, controller.signal)
        : Promise.resolve(),
      drainApprovals(controller.signal),
    ]);
    let timer = null;
    const deadline = new Promise((resolve) => {
      timer = setTimeoutImpl(() => {
        controller.abort();
        resolve();
      }, OPENCODE_FINALIZATION_TIMEOUT_MS);
    });
    try {
      await Promise.race([requests, deadline]);
    } finally {
      if (timer !== null) clearTimeoutImpl(timer);
      controller.abort();
    }
  }

  async function waitForMcp(requestBaseUrl, isCancelled = () => false) {
    const deadline = Date.now() + readyTimeoutMs;
    let lastError = null;
    let lastStatus = null;
    while (Date.now() < deadline) {
      if (isCancelled()) throw cancelledStartError();
      try {
        const controller = new AbortController();
        const requestTimeoutMs = Math.min(
          readyRequestTimeoutMs,
          Math.max(1, deadline - Date.now()),
        );
        const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
        let status;
        try {
          // OpenCode can accept a connection immediately after bind without
          // servicing it, so each readiness attempt must expire and retry.
          status = await requestJson('/mcp', { signal: controller.signal }, requestBaseUrl);
        } finally {
          clearTimeout(timer);
        }
        lastStatus = status?.ae?.status || status;
        if (status && status.ae && status.ae.status === 'connected') return true;
      } catch (e) {
        lastError = e;
        if (e?.httpStatus) lastStatus = e.httpStatus;
      }
      await sleepImpl(readyPollMs);
    }
    const error = new Error('OpenCode MCP server did not become ready.');
    error.categoryCode = 'MCP_UNREACHABLE';
    error.endpoint = '/mcp';
    error.mcpStatus = lastStatus;
    error.lastError = lastError?.message || '';
    if (lastError?.httpStatus) error.httpStatus = lastError.httpStatus;
    if (lastError?.responseExcerpt) error.responseExcerpt = lastError.responseExcerpt;
    throw error;
  }

  function writeConfig(mcpSpec, home) {
    const fs = backendFs();
    const configDir = adapter.paths.join([home, 'opencode']);
    const pluginDir = adapter.paths.join([configDir, 'plugins']);
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(pluginDir, { recursive: true });
    // OpenCode auto-loads local plugins from $XDG_CONFIG_HOME/opencode/plugins.
    // This hook only transforms the outbound message copy; it never writes
    // session history or changes tool results and call identity.
    fs.writeFileSync(
      adapter.paths.join([pluginDir, OPEN_CODE_HISTORY_GUARD_FILENAME]),
      openCodeHistoryGuardPluginSource(),
    );
    const mcpEntry = { type: 'remote', url: mcpSpec.url, enabled: true };
    const config = {
      $schema: 'https://opencode.ai/config.json',
      // OpenCode is only the CLI transport here. Host conversation approval
      // remains authoritative for writes through the tokenized MCP endpoint.
      permission: { '*': 'allow' },
      // Explicit names leave dynamic `ae` MCP tools enabled while preventing
      // this isolated transport from reading or changing the workspace itself.
      tools: Object.fromEntries(OPEN_CODE_DISABLED_BUILTIN_TOOL_NAMES.map((name) => [name, false])),
      provider: openCodeProviderDefinitions(getProviders()),
      mcp: {
        ae: mcpEntry,
      },
    };
    fs.writeFileSync(adapter.paths.join([configDir, 'opencode.json']), JSON.stringify(config, null, 2));
    return home;
  }

  function handleExit(exitedProc, processGeneration, home, code, signal) {
    if (processGeneration !== generation || proc !== exitedProc) return;
    const wasStopping = stopping;
    generation += 1;
    settlePendingQuestions();
    stderrRedactor.flush();
    const tail = trimStderrTail(stderrTail);
    proc = null;
    sessionPromise = null;
    sessionId = null;
    port = null;
    baseUrl = '';
    configHome = '';
    sseClosed = true;
    sseStarted = false;
    if (wasStopping) {
      clearProcessStderrAttachmentPaths();
      return;
    }
    removeInstanceMarker(home);
    if (activeRun) {
      const classified = classifyErrorCode({ exitCode: code, signal, stderrTail: tail });
      emitAfterText({
        type: 'error',
        kind: classified.kind,
        code: classified.code,
        message: 'OpenCode serve exited unexpectedly.',
        detail: {
          exitCode: code,
          ...(signal ? { signal } : {}),
          ...(tail ? { stderrTail: tail } : {}),
        },
        ...activeTurnFailureFields(),
      });
      finishActive();
    }
    clearProcessStderrAttachmentPaths();
  }

  function handleError(failedProc, processGeneration, home, error) {
    if (processGeneration !== generation || proc !== failedProc) return;
    generation += 1;
    settlePendingQuestions();
    stderrRedactor.flush();
    proc = null;
    sessionPromise = null;
    sessionId = null;
    port = null;
    baseUrl = '';
    configHome = '';
    sseClosed = true;
    sseStarted = false;
    removeInstanceMarker(home);
    if (activeRun) {
      const tail = trimStderrTail(stderrTail);
      const classified = classifyErrorCode({ error, spawnError: true, stderrTail: tail });
      emitAfterText({
        type: 'error',
        kind: classified.kind,
        code: classified.code,
        message: 'OpenCode serve process could not continue.',
        detail: {
          ...(error?.code ? { spawnCode: error.code } : {}),
          ...(tail ? { stderrTail: tail } : {}),
        },
        ...activeTurnFailureFields(),
      });
      finishActive();
    }
    clearProcessStderrAttachmentPaths();
  }

  async function startServer() {
    if (proc && baseUrl && !stopping && !sseClosed) return true;
    if (serverPromise) return serverPromise;
    const startGeneration = generation;
    let spawnedProc = null;
      let startHome;
    let startPort = null;
    let startBaseUrl = '';
    const assertCurrentStart = () => {
      if (startGeneration === generation) return;
      try { spawnedProc?.kill?.(); } catch (error) {}
      removeInstanceMarker(startHome);
      throw cancelledStartError();
    };
    const pendingStart = (async () => {
      void sweepStaleInstances();
      assertCurrentStart();
      let mcpSpec;
      try {
        mcpSpec = getMcpSpec ? await getMcpSpec() : { command: 'ae-mcp', args: [] };
        assertCurrentStart();
        startHome = stableConfigHome(mcpSpec);
        (fsImpl || adapter.fs).mkdirSync(workspaceDir, { recursive: true });
        await reclaimStableInstance(startHome);
        assertCurrentStart();
        writeConfig(mcpSpec, startHome);
      } catch (error) {
        if (error?.categoryCode === 'CANCELLED') throw error;
        throw taggedError(error, 'categoryCode', 'MCP_UNREACHABLE');
      }
      startPort = await getPort();
      assertCurrentStart();
      startBaseUrl = 'http://127.0.0.1:' + startPort;
      const spawnEnv = adapter.completeSpawnEnv(currentEnv(), { XDG_CONFIG_HOME: startHome });
      const requiredArch = adapter.id === 'macos-arm64' ? 'arm64' : (adapter.id === 'windows-x64' ? 'x64' : undefined);
      const executable = await adapter.resolveExecutable('opencode', { env: spawnEnv, ...(requiredArch ? { requiredArch } : {}) });
      assertCurrentStart();
      if (!executable.ok) {
        const error = new Error(openCodeResolutionMessage(executable.code, currentLang(), executable));
        const classified = classifyErrorCode({ resolutionCode: executable.code });
        error.categoryCode = classified.code;
        error.resolution = boundedResolution(executable);
        throw error;
      }
      stderrTail = '';
      resetStderrRedactor();
      stopping = false;
      sseClosed = false;
      try {
        spawnedProc = adapter.spawn(executable, [
          'serve', '--print-logs', '--log-level', 'INFO', '--port', String(startPort),
        ], {
          stdio: 'pipe',
          windowsHide: true,
          // OpenCode scopes its project context to the cwd. Inheriting the CEP
          // process cwd (AE's Support Files, thousands of files) inflated every
          // provider request until the relay-side WAF rejected it with a 403
          // challenge page; pin a tiny neutral directory.
          cwd: workspaceDir,
          env: spawnEnv,
        });
      } catch (error) {
        throw taggedError(error, 'spawnError', true);
      }
      writeInstanceMarker(startHome, spawnedProc, startPort);
      assertCurrentStart();
      proc = spawnedProc;
      runningCli = cliIdentity(executable, adapter.fs);
      port = startPort;
      baseUrl = startBaseUrl;
      configHome = startHome;
      spawnedProc.stdout?.setEncoding?.('utf8');
      spawnedProc.stderr?.setEncoding?.('utf8');
      if (spawnedProc.stdout && spawnedProc.stdout.on) spawnedProc.stdout.on('data', (chunk) => {
        if (startGeneration !== generation || proc !== spawnedProc) return;
        stderrRedactor.feed(chunk);
      });
      if (spawnedProc.stderr && spawnedProc.stderr.on) spawnedProc.stderr.on('data', (chunk) => {
        if (startGeneration !== generation || proc !== spawnedProc) return;
        stderrRedactor.feed(chunk);
      });
      if (spawnedProc.on) {
        spawnedProc.on('exit', (code, signal) => (
          handleExit(spawnedProc, startGeneration, startHome, code, signal)
        ));
        spawnedProc.on('error', (error) => (
          handleError(spawnedProc, startGeneration, startHome, error)
        ));
      }
        await waitForMcp(startBaseUrl, () => (
          startGeneration !== generation || proc !== spawnedProc
        ));
      assertCurrentStart();
      startSse(startGeneration, spawnedProc, startHome, startBaseUrl);
      return true;
    })().catch((error) => {
      if (proc === spawnedProc) {
        generation += 1;
        proc = null;
        port = null;
        baseUrl = '';
        configHome = '';
        sseClosed = true;
        sseStarted = false;
      }
      try { spawnedProc?.kill?.(); } catch (killError) {}
      removeInstanceMarker(startHome);
      throw error;
    });
    serverPromise = pendingStart;
    try {
      return await pendingStart;
    } finally {
      if (serverPromise === pendingStart) serverPromise = null;
    }
  }

  async function readSseBody(body, parser, isCurrent) {
    if (!body) return;
    const decoder = typeof TextDecoder === 'function' ? new TextDecoder('utf-8') : null;
    const feedChunk = (chunk) => {
      if (!isCurrent()) return;
      if (typeof chunk === 'string') parser.feed(chunk);
      else if (decoder) parser.feed(decoder.decode(chunk, { stream: true }));
      else parser.feed(String(chunk || ''));
    };
    const flushDecoder = () => {
      if (!decoder) return;
      const tail = decoder.decode();
      if (tail) parser.feed(tail);
    };
    if (body.getReader) {
      const reader = body.getReader();
      while (isCurrent()) {
        const next = await reader.read();
        if (!next || next.done) break;
        if (!isCurrent()) break;
        feedChunk(next.value);
      }
      if (isCurrent()) flushDecoder();
      return;
    }
    if (body[Symbol.asyncIterator]) {
      for await (const chunk of body) {
        if (!isCurrent()) break;
        feedChunk(chunk);
      }
      if (isCurrent()) flushDecoder();
    }
  }

  function startSse(processGeneration, spawnedProc, home, requestBaseUrl) {
    if (sseStarted) return;
    sseStarted = true;
    const isCurrent = () => processGeneration === generation
      && proc === spawnedProc && !sseClosed;
    const parser = createSseParser(({ data }) => {
      if (isCurrent()) handleOpenCodeEvent(data);
    });
    request('/event', {}, requestBaseUrl).then(async (response) => {
      await readSseBody(response.body, parser, isCurrent);
      if (isCurrent()) throw new Error('OpenCode event stream closed.');
    }).catch((e) => {
      if (isCurrent()) {
        generation += 1;
        sseStarted = false;
        const wasActive = Boolean(activeRun);
        settlePendingQuestions();
        sseClosed = true;
        proc = null;
        port = null;
        sessionId = null;
        sessionPromise = null;
        baseUrl = '';
        configHome = '';
        if (wasActive) {
          emitAfterText({
            type: 'error',
            kind: 'network',
            code: 'EVENT_STREAM_FAILED',
            message: 'OpenCode event stream failed.',
            detail: {
              ...(e?.httpStatus ? { httpStatus: e.httpStatus } : {}),
              endpoint: e?.endpoint || '/event',
              ...(e?.message ? { lastError: e.message } : {}),
              ...(e?.responseExcerpt ? {
                responseExcerpt: redactValue(e.responseExcerpt, activeAttachmentPaths),
              } : {}),
            },
            ...activeTurnFailureFields(),
          });
          finishActive();
        }
        try { spawnedProc?.kill?.(); } catch {}
    removeInstanceMarker(home);
      }
    });
  }

  async function ensureSession() {
    if (sessionPromise) return sessionPromise;
    const sessionGeneration = generation;
    const assertCurrentSession = () => {
      if (sessionGeneration !== generation) throw cancelledStartError();
    };
    const pendingSession = (async () => {
      await startServer();
      const liveGeneration = generation;
      try {
        toolMeta = getToolMeta ? await getToolMeta() : { annotations: {} };
      } catch (error) {
        throw taggedError(error, 'categoryCode', 'MCP_UNREACHABLE');
      }
      if (liveGeneration !== generation) throw cancelledStartError();
      if (sessionId) return sessionId;
      if (adoptedSessionId) {
        sessionId = adoptedSessionId;
        sessionWasAdopted = true;
        return sessionId;
      }
      // OpenCode 1.17.x /session rejects unknown fields with a bare 400
      // (a permission field here broke session creation on the live round).
      // Write approval is owned by the CEP host conversation gate, and the
      // injected opencode.json already sets permission '*': 'allow'.
      emitTurnProgress('session');
      const result = await postJson('/session', {
        title: 'After Effects MCP',
        model: parseModel(getModel ? getModel() : DEFAULT_MODEL_ID),
      });
      if (liveGeneration !== generation) throw cancelledStartError();
      sessionId = String((result && (result.id || result.sessionID || result.sessionId)) || '');
      if (!sessionId) throw taggedError(new Error('OpenCode did not return a session id.'), 'fallbackCode', 'SESSION_START_FAILED');
      adoptedSessionId = sessionId;
      sessionWasAdopted = false;
      emit({ type: 'session-ref', ref: { kind: 'opencode-session', id: sessionId } });
      return sessionId;
    })();
    sessionPromise = pendingSession;
    try {
      assertCurrentSession();
      return await pendingSession;
    } finally {
      if (sessionPromise === pendingSession) sessionPromise = null;
    }
  }

  function annFor(name) {
    const annotations = (toolMeta && toolMeta.annotations) || {};
    return annotations[name] || {};
  }

  async function replyPermission(permissionId, decision, signal) {
    if (!sessionId || !permissionId) return;
    await postJson(permissionReplyPath(sessionId, permissionId), permissionReplyBody(decision), signal);
  }

  async function autoReply(permissionId, decision, signal) {
    try {
      await replyPermission(permissionId, decision, signal);
    } catch (e) {
      if (signal?.aborted) return;
      const httpStatus = extractHttpStatus(e?.httpStatus);
      const classified = classifyErrorCode({
        error: e,
        httpStatus,
        fallbackCode: 'BACKEND_ERROR',
      });
      emitAfterText({
        type: 'error',
        kind: classified.kind,
        code: classified.code,
        message: httpStatus ? 'OpenCode permission reply failed upstream.' : 'Failed to reply to OpenCode permission request.',
        detail: {
          ...(httpStatus ? { httpStatus } : {}),
          ...(e?.endpoint ? { endpoint: e.endpoint } : {}),
          ...(e?.responseExcerpt ? {
            responseExcerpt: redactValue(e.responseExcerpt, activeAttachmentPaths),
          } : {}),
        },
      });
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
    suspendStallWatchdogForPendingInteraction();
    emitAfterText({
      type: 'approval-required',
      toolUseId: permissionId,
      name,
      input,
      risk: ann.destructive ? 'destructive' : 'write',
    });
  }

  function handleToolPart(part) {
    // `question` is an OpenCode built-in interaction, not an AE MCP tool. Its
    // own question.asked event renders the form; showing this part as
    // mcp__ae__question leaves a misleading, permanently-running tool card.
    if (isBuiltInQuestionTool(part)) return;
    const toolUseId = String(part.callID || part.id || '');
    if (!toolUseId) return;
    const name = prefixedToolName(part.tool || part.name);
    const state = part.state || {};
    const status = state.status;
    if (status === 'completed' || status === 'error') {
      const outputText = typeof state.output === 'string' ? state.output : eventOutputText(state);
      if (status === 'error'
        && name.startsWith('mcp__ae__')
        && isAeMcpTransportFailure(state, outputText, { allowBareNotConnected: true })) {
        void recoverAeMcpTransport();
      }
      const ms = state.time && Number.isFinite(state.time.start) && Number.isFinite(state.time.end)
        ? state.time.end - state.time.start
        : undefined;
      emitAfterText({
        type: 'tool-result',
        toolUseId,
        name,
        ok: status === 'completed',
        text: toolDisplayText(outputText),
        ...captureToolImages(state.attachments || state.content, adapter),
        durationMs: ms,
      });
      return;
    }
    // pending / running -> tool-start (once)
    if (startedTools.has(toolUseId)) return;
    startedTools.add(toolUseId);
    emitAfterText({ type: 'tool-start', toolUseId, name, input: state.input || {} });
  }

  // OpenCode SSE events arrive as { type, properties } with dotted lowercase
  // types. Text/tool/reasoning ride message.part.*; turn lifecycle rides
  // session.status (busy/idle).
  function handleOpenCodeEvent(evt) {
    const type = eventType(evt);
    if (!type) return;
    const p = (evt && evt.properties) || {};
    if (p.sessionID && (!sessionId || p.sessionID !== sessionId)) return;
    touchStallWatchdog();

    if (type === 'session.status') {
      const st = (p.status && p.status.type) || '';
      if (st === 'busy') {
        if (!activeRun) return;
        if (!turnStarted) { turnStarted = true; emit({ type: 'turn-start' }); }
      } else if (st === 'idle') {
        if (stopRequested) return;
        if (!activeRun || !turnStarted) return;
        assistantDeltaRedactor.flush();
        drainApprovals();
        emit({ type: 'turn-end', stopReason: 'end_turn' });
        transcript.push({ role: 'assistant', text: activeAssistantText });
        finishActive();
      }
      return;
    }
    if (type === 'message.part.delta') {
      const partId = String(p.partID || '');
      const partType = partId ? partTypes.get(partId) : undefined;
      if (partType === 'reasoning') {
        emit({ type: 'thinking', active: true });
      } else if (partType === 'text') {
        emit({ type: 'thinking', active: false });
        const text = p.delta;
        if (text) assistantDeltaRedactor.feed(String(text));
      } else if (partType) {
        return;
      } else if (p.field === 'text') {
        emit({ type: 'thinking', active: false });
        const text = p.delta;
        if (text) assistantDeltaRedactor.feed(String(text));
      } else if (p.field === 'reasoning') {
        emit({ type: 'thinking', active: true });
      }
      return;
    }
    if (type === 'message.part.updated') {
      const part = p.part || {};
      if (part.id && part.type) partTypes.set(String(part.id), String(part.type));
      if (part.type === 'tool') handleToolPart(part);
      else if (part.type === 'reasoning') emit({ type: 'thinking', active: true });
      return;
    }
    if (type === 'question.asked') {
      const questionId = String(p.id || '');
      if (!questionId || pendingQuestions.has(questionId)) return;
      const questions = questionsFromOpenCode(p.questions);
      if (!questions.length) {
        void postJson(questionReplyPath(questionId, 'reject'), {}).catch(() => {});
        return;
      }
      pendingQuestions.set(questionId, { questions, settling: false });
      suspendStallWatchdogForPendingInteraction();
      emitAfterText({
        type: 'question-required',
        toolUseId: questionId,
        source: 'opencode-question',
        title: '',
        questions,
      });
      return;
    }
    if (type === 'question.replied' || type === 'question.rejected') {
      const questionId = String(p.requestID || p.requestId || '');
      const pending = pendingQuestions.get(questionId);
      if (!pending) return;
      pendingQuestions.delete(questionId);
      resumeStallWatchdogAfterPendingInteraction();
      if (type === 'question.rejected') {
        emitAfterText({ type: 'question-resolved', toolUseId: questionId, outcome: 'cancelled' });
      } else {
        const values = valuesFromOpenCodeAnswers(pending.questions, p.answers);
        emitAfterText({
          type: 'question-resolved',
          toolUseId: questionId,
          outcome: 'answered',
          answers: displayAnswers(pending.questions, values),
        });
      }
      return;
    }
    if (type === 'session.error') {
      assistantDeltaRedactor.discard();
      stderrRedactor.flush();
      const error = p.error || p;
      const detail = (error && error.data && error.data.message)
        || (error && error.message)
        || (typeof error === 'string' ? error : '');
      if (stopRequested
        && /abort(?:ed)?/i.test([error && error.name, detail].filter(Boolean).join(' '))) {
        return;
      }
      const causeChain = boundedCauseChain(error);
      const processTail = trimStderrTail(stderrTail);
      const combined = [detail, ...causeChain, processTail].filter(Boolean).join('\n');
      const httpStatus = extractHttpStatus(error?.statusCode)
        || extractHttpStatus(error?.data?.statusCode)
        || extractHttpStatus(combined);
      const classified = classifyErrorCode({
        error: { message: combined },
        httpStatus,
        upstream: true,
        upstreamText: combined,
      });
      const mediaRejected = activeTurn?.attachments.length > 0
        && startedTools.size === 0 && !activeAssistantText
        && !Array.from(partTypes.values()).includes('tool')
        && /^'(?:file part media type |media type: )[^']+' functionality not supported\.$/.test(detail);
      if (isAeMcpTransportFailure(error, combined)) {
        void recoverAeMcpTransport();
        return;
      }
      // A provider failure does not invalidate OpenCode's local conversation.
      // Keep the session so a user retry preserves context; only settle
      // interactions that belonged to the failed turn. Local 404/process/SSE
      // failures still invalidate the session through their dedicated paths.
      settleFailedTurnInteractions();
      emitAfterText({
        type: 'error',
        kind: mediaRejected ? 'attachment' : classified.kind,
        code: mediaRejected ? 'ATTACHMENT_TRANSPORT_UNSUPPORTED' : classified.code,
        // OpenCode session errors arrive as {name, data:{message}} objects;
        // String() on that shape rendered "[object Object]" in the chat.
        message: mediaRejected
          ? (currentLang() === 'zh'
            ? 'OpenCode 的媒体读取通道不支持此格式。这不是模型能力判断；可提供支持的格式，或在消息中给出本地路径供 AE 导入。'
            : 'The OpenCode media reader cannot send this format. This is a channel limitation; use a supported format or provide a local path in the message for AE import.')
          : httpStatus
          ? 'OpenCode upstream request failed.'
          : classified.code === 'UPSTREAM_CONNECTION_CLOSED'
            ? 'OpenCode upstream connection was interrupted.'
          : (detail || (error && error.name) || 'OpenCode session error'),
        detail: {
          ...(error?.name ? { errorName: error.name } : {}),
          ...(httpStatus && !mediaRejected ? { httpStatus } : {}),
          ...(detail ? {
            upstreamMessage: String(redactValue(detail, activeAttachmentPaths)).slice(0, 500),
          } : {}),
          ...(causeChain.length ? {
            causeChain: redactValue(causeChain, activeAttachmentPaths),
          } : {}),
          ...(processTail ? {
            stderrTail: redactValue(processTail, activeAttachmentPaths),
          } : {}),
        },
        ...activeTurnFailureFields(),
        ...(mediaRejected ? { dispatchState: 'not-started' } : {}),
      });
      finishActive();
      return;
    }
    // Permission prompts may not appear on read-only tool paths, so match
    // defensively on a permission-ish ask type.
    if (/permission/i.test(String(type)) && /ask/i.test(String(type))) {
      handlePermission({ ...p, properties: p });
    }
  }

  function drainApprovals(signal) {
    const replies = [];
    for (const [permissionId] of Array.from(pendingApprovals.entries())) {
      pendingApprovals.delete(permissionId);
      replies.push(autoReply(permissionId, 'deny', signal));
      emit({ type: 'tool-denied', toolUseId: permissionId });
    }
    return Promise.allSettled(replies);
  }

  function openCodeParts(turn) {
    return [
      ...(turn.text ? [{ type: 'text', text: turn.text }] : []),
      ...turn.attachments.map((file) => ({
        type: 'file',
        mime: file.mediaType || 'application/octet-stream',
        filename: file.name,
        url: attachmentFileUrl(file.localPath, adapter.id),
      })),
    ];
  }

  async function prepareTurnSession() {
    if (!proc || !baseUrl || sseClosed) emitTurnProgress('spawn');
    else if (!sessionId) emitTurnProgress('session');
    return ensureSession();
  }

  async function dispatchTurnMessage(id, turn) {
    const messageBody = { parts: openCodeParts(turn) };
    try {
      messageDispatched = true;
      armStallWatchdog();
      const controller = new AbortController();
      messageAbortController = controller;
      const messageRequest = postJson('/session/' + encodeURIComponent(id) + '/message', messageBody, controller.signal);
      emitTurnProgress('dispatch');
      await messageRequest;
    } catch (error) {
      if (!sessionWasAdopted || (error?.httpStatus !== 404 && error?.httpStatus !== 503)) throw error;
      sessionId = null;
      adoptedSessionId = null;
      sessionWasAdopted = false;
      const replacementId = await ensureSession();
      const controller = new AbortController();
      messageAbortController = controller;
      const replacementRequest = postJson(
        '/session/' + encodeURIComponent(replacementId) + '/message',
        messageBody,
        controller.signal,
      );
      emitTurnProgress('dispatch');
      await replacementRequest;
    }
  }

  async function sendUser(input) {
    if (activeRun) return activeRun;
    stopRequested = false;
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
    messageDispatched = false;
    aeMcpRecoveryAttempts = 0;
    aeMcpRecoveryStarted = false;
    aeMcpRecoveryPromise = null;
    setActiveAttachmentPaths(turn.attachments.flatMap((attachment) => [
      attachment.localPath,
      attachmentFileUrl(attachment.localPath, adapter.id),
    ]));
    activeRun = new Promise((resolve) => {
      activeResolve = resolve;
    });
    try {
      const id = await prepareTurnSession();
      const userText = turn.text;
      transcript.push({ role: 'user', text: userText });
      // Accept at dispatch, not on POST completion: OpenCode's message POST
      // blocks until the model finishes while assistant deltas stream over
      // SSE, so a late accept rendered the reply ABOVE the user's message.
      // ensureSession failures above still reject as not-started (draft is
      // restored); a POST failure after this point surfaces as an in-chat
      // error under the already-rendered user turn.
      if (turn.turnId) {
        activeTurnAccepted = true;
        emit({ type: 'turn-accepted', turnId: turn.turnId, transport: 'opencode-file-part' });
      }
      await dispatchTurnMessage(id, turn);
    } catch (e) {
      if (stopRequested || !activeRun) return;
      if (aeMcpRecoveryStarted) {
        if (aeMcpRecoveryPromise) await aeMcpRecoveryPromise;
        return activeRun;
      }
      const httpStatus = extractHttpStatus(e?.httpStatus);
      const fallbackCode = e?.fallbackCode
        || (messageDispatched ? 'TURN_START_FAILED' : 'SESSION_START_FAILED');
      const classified = classifyErrorCode({
        error: e,
        code: e?.categoryCode,
        httpStatus,
        spawnError: e?.spawnError === true,
        fallbackCode,
      });
      const sessionReset = messageDispatched ? invalidateSession() : false;
      let message = e && e.message ? e.message : 'Failed to start OpenCode turn.';
      if (classified.code.startsWith('UPSTREAM_HTTP_')) message = 'OpenCode upstream request failed.';
      else if (classified.code === 'AUTH_REQUIRED') message = 'OpenCode authentication is required.';
      else if (classified.code === 'SPAWN_FAILED') message = 'OpenCode serve process could not be started.';
      else if (classified.code === 'MCP_UNREACHABLE') message = 'OpenCode MCP server did not become ready.';
      else if (classified.code === 'SESSION_START_FAILED') message = 'OpenCode session could not be started.';
      else if (classified.code === 'TURN_START_FAILED') message = 'OpenCode turn could not be started.';
      const detail = {
        ...(httpStatus ? { httpStatus } : {}),
        ...(e?.endpoint ? { endpoint: e.endpoint } : {}),
        ...(e?.mcpStatus !== undefined && e?.mcpStatus !== null ? { mcpStatus: e.mcpStatus } : {}),
        ...(e?.lastError ? { lastError: e.lastError } : {}),
        ...(e?.responseExcerpt ? { responseExcerpt: redactValue(e.responseExcerpt, activeAttachmentPaths) } : {}),
        ...(e?.resolution ? { resolution: e.resolution } : {}),
        ...(e?.code && e?.spawnError ? { spawnCode: e.code } : {}),
        ...(sessionReset ? { sessionReset: true } : {}),
      };
      emitAfterText({
        type: 'error',
        kind: classified.kind,
        code: classified.code,
        message,
        ...(Object.keys(detail).length ? { detail } : {}),
        ...activeTurnFailureFields(),
        dispatchState: messageDispatched ? 'uncertain' : 'not-started',
      });
      finishActive();
    }
    return activeRun;
  }

  async function approve(toolUseId, decision) {
    const id = String(toolUseId);
    const approval = pendingApprovals.get(id);
    if (!approval) return;
    pendingApprovals.delete(id);
    resumeStallWatchdogAfterPendingInteraction();
    if (decision === 'allow-session') sessionAllowedTools.add(approval.name);
    await replyPermission(id, decision);
    if (decision === 'deny') emit({ type: 'tool-denied', toolUseId: id });
    else emit({ type: 'tool-allowed', toolUseId: id });
  }

  async function answerQuestion(toolUseId, result) {
    const id = String(toolUseId || '');
    const pending = pendingQuestions.get(id);
    if (!pending || pending.settling) return false;
    pending.settling = true;
    const submitted = result && result.action === 'submit';
    try {
      if (submitted) {
        await postJson(questionReplyPath(id, 'reply'), {
          answers: answersForOpenCode(pending.questions, result.values),
        });
      } else {
        await postJson(questionReplyPath(id, 'reject'), {});
      }
    } catch (error) {
      if (pendingQuestions.get(id) === pending) pending.settling = false;
      const httpStatus = extractHttpStatus(error?.httpStatus);
      const classified = classifyErrorCode({ error, httpStatus, fallbackCode: 'BACKEND_ERROR' });
      emitAfterText({
        type: 'error',
        kind: classified.kind,
        code: classified.code,
        message: submitted
          ? 'Failed to answer OpenCode question.'
          : 'Failed to dismiss OpenCode question.',
        detail: {
          ...(httpStatus ? { httpStatus } : {}),
          ...(error?.endpoint ? { endpoint: error.endpoint } : {}),
        },
      });
      return false;
    }
    // The matching SSE reply can arrive before the HTTP response. In that
    // case it already settled the card, so do not emit a duplicate event.
    if (pendingQuestions.get(id) !== pending) return true;
    pendingQuestions.delete(id);
    resumeStallWatchdogAfterPendingInteraction();
    emitAfterText({
      type: 'question-resolved',
      toolUseId: id,
      outcome: submitted ? 'answered' : 'cancelled',
      ...(submitted ? { answers: displayAnswers(pending.questions, result.values) } : {}),
    });
    return true;
  }

  async function rejectPendingQuestions(signal) {
    const rejects = [];
    for (const [questionId, pending] of Array.from(pendingQuestions.entries())) {
      pendingQuestions.delete(questionId);
      if (!pending.settling && baseUrl) {
        rejects.push(postJson(questionReplyPath(questionId, 'reject'), {}, signal));
      }
      emitAfterText({ type: 'question-resolved', toolUseId: questionId, outcome: 'cancelled' });
    }
    await Promise.allSettled(rejects);
  }

  async function stop() {
    if (activeRun) stopRequested = true;
    messageAbortController?.abort();
    await finalizeActiveTurnRequests();
    if (activeRun) {
      emitAfterText({ type: 'error', kind: 'aborted', code: 'TURN_ABORTED', message: 'Turn aborted.', ...activeTurnFailureFields() });
      finishActive();
    }
  }

  function reset() {
    if (activeRun) {
      emitAfterText({
        type: 'error',
        kind: 'aborted',
        code: 'TURN_ABORTED',
        message: 'Turn aborted.',
        ...activeTurnFailureFields(),
      });
      finishActive();
    }
    generation += 1;
    const stoppedProc = proc;
    const stoppedHome = configHome;
    stopping = true;
    sseClosed = true;
    sseStarted = false;
    clearStallWatchdog();
    messageAbortController?.abort();
    messageAbortController = null;
    settlePendingQuestions();
    pendingApprovals.clear();
    sessionAllowedTools.clear();
    sessionId = null;
    adoptedSessionId = null;
    sessionWasAdopted = false;
    sessionPromise = null;
    activeResolve = null;
    activeRun = null;
    activeAssistantText = '';
    activeTurn = null;
    activeTurnAccepted = false;
    messageDispatched = false;
    turnStarted = false;
    aeMcpRecoveryAttempts = 0;
    aeMcpRecoveryStarted = false;
    aeMcpRecoveryPromise = null;
    stopRequested = false;
    startedTools.clear();
    partTypes.clear();
    transcript.length = 0;
    proc = null;
    port = null;
    baseUrl = '';
    configHome = '';
    serverPromise = null;
    stderrTail = '';
    clearProcessStderrAttachmentPaths();
    try { stoppedProc?.kill?.(); } catch (error) {}
    removeInstanceMarker(stoppedHome);
    void Promise.resolve().then(() => sweepStaleInstances());
  }

  async function probeAccount() {
    const controller = new AbortController();
    let timedOut = false;
    let timer = null;
    const seconds = totalProbeTimeoutMs / 1000;
    const timeoutLabel = Number.isInteger(seconds) ? `${seconds}s` : `${totalProbeTimeoutMs}ms`;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error('OpenCode probe timed out'));
      }, totalProbeTimeoutMs);
    });
    try {
      const providers = await Promise.race([
        (async () => {
          await startServer();
          // This endpoint may also embed provider options and credentials.
          // Sanitize in the backend before returning anything to React state.
          const catalog = await requestJson('/config/providers', { signal: controller.signal }).catch((error) => {
            if (controller.signal.aborted) throw error;
            return requestJson('/provider', { signal: controller.signal });
          });
          return sanitizeOpenCodeProviderFacts(catalog);
        })(),
        timeout,
      ]);
      const requiredArch = adapter.id === 'macos-arm64' ? 'arm64' : (adapter.id === 'windows-x64' ? 'x64' : undefined);
      const selected = await adapter.resolveExecutable('opencode', {
        env: adapter.completeSpawnEnv(currentEnv(), { XDG_CONFIG_HOME: configHome }), ...(requiredArch ? { requiredArch } : {}),
      });
      return { loggedIn: true, providers, cli: cliIdentity(selected, adapter.fs), runningCli };
    } catch (e) {
      if (timedOut) {
        if (!activeRun) reset();
        return {
          loggedIn: false,
          code: 'PROBE_TIMEOUT',
          detail: `OpenCode probe timed out after ${timeoutLabel}`,
        };
      }
      return { loggedIn: false, detail: e && e.message ? e.message : String(e) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function getMessages() {
    return transcript.slice();
  }

  function getSessionRef() {
    const id = sessionId || adoptedSessionId;
    return id ? { kind: 'opencode-session', id } : null;
  }

  function adoptSessionRef(ref) {
    settlePendingQuestions();
    partTypes.clear();
    sessionId = null;
    adoptedSessionId = ref && ref.kind === 'opencode-session' && ref.id
      ? String(ref.id) : null;
    sessionWasAdopted = Boolean(adoptedSessionId);
  }

  async function deleteSessionRef(ref) {
    if (!ref || ref.kind !== 'opencode-session' || !ref.id) {
      return { ok: false, detail: 'invalid opencode session reference' };
    }
    if (!baseUrl || !proc || sseClosed) {
      return { ok: false, skipped: true, detail: 'opencode server not running' };
    }
    try {
      await request('/session/' + encodeURIComponent(String(ref.id)), { method: 'DELETE' });
      if (sessionId === ref.id) sessionId = null;
      if (adoptedSessionId === ref.id) adoptedSessionId = null;
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: error?.message || String(error) };
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
    getMessages,
    getStderrTail: () => stderrTail,
    probeAccount,
  };
}
