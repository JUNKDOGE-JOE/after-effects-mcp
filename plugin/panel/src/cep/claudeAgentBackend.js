import { createNdjsonReader } from '../lib/ndjson.js';
import { claudeChannelEnv } from '../lib/claudeChannel.js';
import { createDeltaRedactor, redactValue } from '../lib/exactSecretRedaction.js';
import { selectProviderRoute } from '../lib/providerRouteSelection.js';
import { createPlatformAdapter } from './platform/index.js';
import { createUniversalProviderRoute } from './universalProviderRoute.js';
import { normalizeTurnInput } from '../../../shared/chat-attachments.mjs';
import {
  answersForAskUserQuestion,
  displayAnswers,
  questionsFromAskUserQuestion,
} from '../lib/questionForm.js';

const READY_TIMEOUT_MS = 15000;
const STDERR_TAIL_LIMIT = 4096;
export async function resolveSystemNode({ platform } = {}) {
  const adapter = platform || createPlatformAdapter();
  const requiredArch = adapter.id === 'macos-arm64' ? 'arm64' : (adapter.id === 'windows-x64' ? 'x64' : undefined);
  const resolved = await adapter.resolveExecutable('node', { minimumVersion: '18.0.0', ...(requiredArch ? { requiredArch } : {}) });
  if (!resolved.ok) return { ok: false, detail: 'Node runtime resolution failed: ' + resolved.code, resolution: resolved };
  return { ok: true, nodePath: resolved.path, version: resolved.version || '', executable: resolved };
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function nodeMissingMessage(lang) {
  if (lang === 'zh') return '内嵌对话运行时缺失或损坏，请在设置中修复离线运行时。';
  return 'The embedded chat runtime is missing or damaged. Repair the offline runtime in Settings.';
}

function appendTail(tail, chunk) {
  const next = tail + String(chunk || '');
  return next.length > STDERR_TAIL_LIMIT ? next.slice(next.length - STDERR_TAIL_LIMIT) : next;
}

function defaultResolveCapability({ provider, modelId, feature = 'generate' } = {}) {
  return selectProviderRoute(provider, {
    client: 'claude-code',
    modelId,
    feature,
  });
}

function runtimeIdentity({ channel, model, provider }) {
  return JSON.stringify([
    channel,
    model,
    channel === 'api' ? provider.id ?? null : null,
    channel === 'api' ? provider.baseUrl ?? null : null,
    channel === 'api' ? provider.requestProfileRevision ?? null : null,
    channel === 'api' ? provider.modelList?.revision ?? null : null,
  ]);
}

function cancelledStartError() {
  const error = new Error('Claude sidecar start was cancelled');
  error.code = 'CLAUDE_AGENT_START_CANCELLED';
  return error;
}

function normalizeChannel(channel) {
  return channel === 'api' ? 'api' : 'subscription';
}

function providerModelError(code, message) {
  const error = new Error(message);
  error.kind = 'model';
  error.code = code;
  return error;
}

export function createClaudeAgentBackend({
  platform,
  resolveNode = resolveSystemNode,
  sidecarPath,
  getMcpSpec,
  getToolMeta,
  getModel,
  getPermissionMode,
  getEffort,
  getThinking,
  getChannel = () => 'subscription',
  getProviderSensitiveValues = () => [],
  resolveApiProvider,
  resolveRequestProfile,
  resolveCapability = defaultResolveCapability,
  createProviderRoute = createUniversalProviderRoute,
  recoverProviderProfile,
  onProviderProfileRecovered = () => {},
  onEvent,
  lang = 'zh',
  spawnImpl,
  env,
}) {
  const adapter = platform || (spawnImpl ? {
    completeSpawnEnv: (base = {}, additions = {}) => ({ ...base, ...additions }),
    spawn: (executable, args, options) => spawnImpl(executable.path, [...(executable.argsPrefix || []), ...args], options),
  } : createPlatformAdapter());
  let proc = null;
  let startPromise = null;
  let pendingReadyReject = null;
  let pendingReadyTimer = null;
  let ready = false;
  let stderrTail = '';
  let transcript = [];
  let activeRun = null;
  let activeResolve = null;
  let activeAssistantText = '';
  let processChannel = 'subscription';
  let processModel = '';
  let processIdentity = null;
  let processProvider = null;
  let processCandidateIdentity = null;
  let providerRoute = null;
  let routeClosePromise = Promise.resolve();
  let runtimeGeneration = 0;
  let providerSensitiveValues = [];
  let activeAttachmentPaths = [];
  let providerDeltaPhase = undefined;
  let providerDeltaRedactor = createDeltaRedactor([], () => {});
  let activeTurn = null;
  let activeTurnAccepted = false;
  let activeTurnDispatched = false;
  const pendingUserInputs = new Map();

  function emit(evt) {
    let event = evt;
    if (
      event?.type === 'error'
      && activeTurn?.turnId
      && !event.turnId
    ) {
      event = {
        ...event,
        turnId: activeTurn.turnId,
        ...(!activeTurnAccepted ? {
          dispatchState: activeTurnDispatched ? 'uncertain' : 'not-started',
        } : {}),
      };
    }
    if (onEvent) onEvent(redactValue(event, [...providerSensitiveValues, ...activeAttachmentPaths]));
  }

  function resetProviderDeltaRedactor() {
    providerDeltaRedactor.discard();
    providerDeltaPhase = undefined;
    providerDeltaRedactor = createDeltaRedactor([...providerSensitiveValues, ...activeAttachmentPaths], (text) => {
      activeAssistantText += text;
      emit({ type: 'text-delta', text, ...(providerDeltaPhase ? { phase: providerDeltaPhase } : {}) });
    });
  }

  function setProviderSensitiveValues(values) {
    providerSensitiveValues = Array.from(new Set((values || [])
      .filter((value) => typeof value === 'string' && value)))
      .sort((left, right) => right.length - left.length);
    resetProviderDeltaRedactor();
  }

  function setActiveAttachmentPaths(values) {
    activeAttachmentPaths = Array.from(new Set((values || [])
      .filter((value) => typeof value === 'string' && value)))
      .sort((left, right) => right.length - left.length);
    if (stderrTail) {
      stderrTail = redactValue(stderrTail, activeAttachmentPaths);
    }
    resetProviderDeltaRedactor();
  }

  function clearProviderSensitiveValues() {
    providerDeltaRedactor.discard();
    providerSensitiveValues = [];
    providerDeltaPhase = undefined;
    providerDeltaRedactor = createDeltaRedactor(activeAttachmentPaths, () => {});
  }

  function writeMessage(message) {
    if (!proc || !proc.stdin || !proc.stdin.write) return;
    proc.stdin.write(JSON.stringify(message) + '\n');
  }

  // #228: settle a pending AskUserQuestion (#219). result:
  //   { action:'submit', values: { [question.id]: string|string[] } }
  //   | { action:'cancel' }
  function answerQuestion(toolUseId, result) {
    const id = String(toolUseId);
    const pending = pendingUserInputs.get(id);
    if (!pending) return false;
    pendingUserInputs.delete(id);
    if (!result || result.action !== 'submit') {
      writeMessage({ t: 'answer', id, cancel: true });
      emit({ type: 'question-resolved', toolUseId: id, outcome: 'cancelled' });
      return true;
    }
    const answers = answersForAskUserQuestion(pending.questions, result.values);
    writeMessage({ t: 'answer', id, answers });
    // Display shape for the card: multi-select answers are arrays on the wire
    // but must be joined strings in the chat event.
    emit({
      type: 'question-resolved',
      toolUseId: id,
      outcome: 'answered',
      answers: displayAnswers(pending.questions, result.values),
    });
    return true;
  }

  // #228/#220: a question never outlives its backend. On teardown, settle each
  // pending one locally as cancelled — the sidecar drains its own side.
  function drainUserInputs() {
    for (const id of Array.from(pendingUserInputs.keys())) {
      pendingUserInputs.delete(id);
      emit({ type: 'question-resolved', toolUseId: id, outcome: 'cancelled' });
    }
  }

  function finishActive() {
    const resolve = activeResolve;
    activeResolve = null;
    activeRun = null;
    activeAssistantText = '';
    activeTurn = null;
    activeTurnAccepted = false;
    activeTurnDispatched = false;
    setActiveAttachmentPaths([]);
    if (resolve) resolve();
  }

  function handleSidecarMessage(message) {
    if (!message || message.t === 'ready') return;
    if (message.t !== 'event') return;

    let event = message.event;
    if (!event) return;
    // #228: the sidecar passes AskUserQuestion through raw; the backend owns
    // question-form normalization (mirrors the codex/zcode split). Translate
    // the raw pair into the #219 question events and track the round-trip.
    if (event.type === 'question-required-raw') {
      const toolUseId = String(event.toolUseId || '');
      const questions = questionsFromAskUserQuestion(event);
      pendingUserInputs.set(toolUseId, { questions });
      emit({ type: 'question-required', toolUseId, source: 'claude-ask-user-question', title: '', questions });
      return;
    }
    if (event.type === 'question-resolved-raw') {
      const toolUseId = String(event.toolUseId || '');
      if (pendingUserInputs.delete(toolUseId)) {
        emit({ type: 'question-resolved', toolUseId, outcome: 'cancelled' });
      }
      return;
    }
    if (processChannel === 'api' && event.type === 'error') {
      event = { ...event, message: 'Provider sidecar request failed.' };
    }
    if (event.type === 'text-delta') {
      const nextPhase = typeof event.phase === 'string' ? event.phase : undefined;
      if (providerDeltaPhase !== undefined && providerDeltaPhase !== nextPhase) providerDeltaRedactor.flush();
      providerDeltaPhase = nextPhase;
      providerDeltaRedactor.feed(String(event.text || ''));
      return;
    }
    providerDeltaRedactor.flush();
    if (event.type === 'turn-accepted' && activeTurn && event.turnId === activeTurn.turnId) {
      activeTurnAccepted = true;
    }
    emit(event);
    if (event.type === 'turn-end') {
      transcript.push({ role: 'assistant', text: activeAssistantText });
      finishActive();
    }
    if (event.type === 'error') finishActive();
  }

  function exitDetail(code, signal) {
    const suffix = signal ? String(code) + ' ' + signal : String(code);
    return stderrTail ? suffix + ' ' + stderrTail : suffix;
  }

  function clearReadyWait() {
    if (pendingReadyTimer) clearTimeout(pendingReadyTimer);
    pendingReadyTimer = null;
    pendingReadyReject = null;
  }

  function closeProviderRoute() {
    const route = providerRoute;
    providerRoute = null;
    if (!route || typeof route.close !== 'function') return routeClosePromise;
    routeClosePromise = routeClosePromise
      .then(() => route.close())
      .catch(() => {});
    return routeClosePromise;
  }

  async function discardRuntime({ clearTranscript = false, finishRun = false, clearStderr = false } = {}) {
    runtimeGeneration += 1;
    const current = proc;
    const rejectReady = pendingReadyReject;
    proc = null;
    ready = false;
    startPromise = null;
    clearReadyWait();
    processChannel = 'subscription';
    processModel = '';
    processIdentity = null;
    processProvider = null;
    processCandidateIdentity = null;
    if (rejectReady) rejectReady(cancelledStartError());
    if (current) {
      try { current.kill(); } catch {}
    }
    if (clearTranscript) transcript = [];
    if (finishRun) finishActive();
    if (clearStderr) stderrTail = '';
    drainUserInputs();
    clearProviderSensitiveValues();
    await closeProviderRoute();
  }

  function apiSafeErrorMessage(message) {
    return processChannel === 'api' ? 'Provider sidecar request failed.' : message;
  }

  function handleExit(target, generation, code, signal) {
    if (generation !== runtimeGeneration || proc !== target) return;
    const wasReady = ready;
    const detail = exitDetail(code, signal);
    const rejectReady = pendingReadyReject;
    proc = null;
    ready = false;
    startPromise = null;
    processIdentity = null;
    processModel = '';
    processProvider = null;
    processCandidateIdentity = null;
    runtimeGeneration += 1;
    void closeProviderRoute();
    drainUserInputs();
    if (!wasReady && rejectReady) {
      clearReadyWait();
      processChannel = 'subscription';
      clearProviderSensitiveValues();
      rejectReady(new Error('sidecar exited: ' + detail));
      return;
    }
    if (activeRun) {
      providerDeltaRedactor.flush();
      emit({ type: 'error', kind: 'mcp', message: apiSafeErrorMessage('sidecar exited: ' + detail) });
      finishActive();
    }
    processChannel = 'subscription';
    clearProviderSensitiveValues();
  }

  function handleProcError(target, generation, error) {
    if (generation !== runtimeGeneration || proc !== target) return;
    const rejectReady = pendingReadyReject;
    proc = null;
    ready = false;
    startPromise = null;
    processIdentity = null;
    processModel = '';
    processProvider = null;
    processCandidateIdentity = null;
    runtimeGeneration += 1;
    void closeProviderRoute();
    drainUserInputs();
    if (rejectReady) {
      clearReadyWait();
      processChannel = 'subscription';
      clearProviderSensitiveValues();
      rejectReady(error instanceof Error ? error : new Error('sidecar error'));
      return;
    }
    if (activeRun) {
      const message = error && error.message ? error.message : 'sidecar error';
      providerDeltaRedactor.flush();
      emit({ type: 'error', kind: 'mcp', message: apiSafeErrorMessage(message) });
      finishActive();
    }
    processChannel = 'subscription';
    clearProviderSensitiveValues();
  }

  async function selectApiRoute(provider, model) {
    try {
      return await resolveCapability({
        provider,
        modelId: model,
        clientProtocol: 'messages',
        feature: 'generate',
      });
    } catch {
      return null;
    }
  }

  async function desiredSession(channel) {
    const model = String(getModel ? getModel() : '').trim();
    let provider = null;
    let candidateIdentity = null;
    let recovered = false;
    let route = null;
    if (channel === 'api') {
      if (typeof resolveApiProvider !== 'function') throw new Error('Provider is unavailable.');
      if (typeof resolveRequestProfile !== 'function') throw new Error('Provider credential resolver is unavailable.');
      if (typeof resolveCapability !== 'function') throw new Error('Provider capability resolver is unavailable.');
      if (typeof createProviderRoute !== 'function') throw new Error('Provider route factory is unavailable.');
      provider = await resolveApiProvider();
      if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
        throw new Error('Provider is unavailable.');
      }
      candidateIdentity = runtimeIdentity({ channel, model, provider });
      if (
        proc
        && ready
        && processProvider
        && processCandidateIdentity === candidateIdentity
      ) {
        provider = processProvider;
        return {
          channel,
          model,
          provider,
          candidateIdentity,
          recovered,
          route: null,
          identity: runtimeIdentity({ channel, model, provider }),
        };
      }

      route = await selectApiRoute(provider, model);
      if (!route?.ok) {
        if (route?.reasonCode !== 'needs-probe') {
          throw providerModelError(
            'provider_route_unavailable',
            `Custom provider has no verified Claude route for model ${model}`,
          );
        }
        if (typeof recoverProviderProfile !== 'function') {
          throw providerModelError(
            'provider_preflight_unavailable',
            `Custom provider cannot be verified for model ${model}`,
          );
        }

        let recovery;
        try {
          recovery = await recoverProviderProfile(
            provider,
            { status: null, code: 'provider_preflight_required' },
            model,
          );
        } catch (cause) {
          // #222: only the recovery probe knows why verify failed (auth class,
          // HTTP status, not agent-ready...); keep its message in the event.
          const detail = typeof cause?.message === 'string' ? cause.message.trim() : '';
          throw providerModelError(
            'provider_preflight_failed',
            `Custom provider could not verify model ${model}` + (detail ? `: ${detail}` : ''),
          );
        }
        const recoveredProvider = recovery?.provider || recovery;
        const recoveredModel = String(recovery?.modelId || model).trim();
        if (
          !recoveredProvider
          || typeof recoveredProvider !== 'object'
          || Array.isArray(recoveredProvider)
          || recoveredModel !== model
        ) {
          throw providerModelError(
            'provider_preflight_failed',
            `Custom provider did not expose a verified API for model ${model}`,
          );
        }
        route = await selectApiRoute(recoveredProvider, model);
        if (!route?.ok) {
          throw providerModelError(
            'provider_preflight_failed',
            `Custom provider did not expose a verified API for model ${model}`,
          );
        }
        provider = recoveredProvider;
        recovered = true;
      }
    }
    return {
      channel,
      model,
      provider,
      candidateIdentity,
      recovered,
      route,
      identity: runtimeIdentity({ channel, model, provider }),
    };
  }

  async function cleanupFailedStart(generation) {
    if (generation !== runtimeGeneration) {
      await routeClosePromise;
      return;
    }
    runtimeGeneration += 1;
    const current = proc;
    proc = null;
    ready = false;
    processChannel = 'subscription';
    processModel = '';
    processIdentity = null;
    processProvider = null;
    processCandidateIdentity = null;
    clearReadyWait();
    clearProviderSensitiveValues();
    if (current) {
      try { current.kill(); } catch {}
    }
    await closeProviderRoute();
  }

  async function startSidecar(session) {
    if (proc && ready) return true;
    if (startPromise) return startPromise;
    const startGeneration = runtimeGeneration;
    const assertCurrentStart = () => {
      if (startGeneration !== runtimeGeneration) throw cancelledStartError();
    };

    const pendingStart = (async () => {
      const node = await resolveNode({ platform: adapter });
      assertCurrentStart();
      if (!node || !node.ok) {
        emit({ type: 'error', kind: 'mcp', message: nodeMissingMessage(lang) });
        return false;
      }

      const mcpSpec = await getMcpSpec();
      assertCurrentStart();
      const meta = await getToolMeta();
      assertCurrentStart();
      await routeClosePromise;
      assertCurrentStart();
      let localRoute = null;
      if (session.channel === 'api') {
        providerRoute = createProviderRoute({
          provider: session.provider,
          resolveCapability,
          resolveRequestProfile,
        });
        const routeInfo = await providerRoute.start();
        assertCurrentStart();
        localRoute = {
          origin: routeInfo?.origin,
          routeToken: routeInfo?.routeToken,
        };
        const redactionValues = getProviderSensitiveValues();
        if (!Array.isArray(redactionValues)) throw new TypeError('getProviderSensitiveValues must return an array');
        setProviderSensitiveValues([...redactionValues, routeInfo?.routeToken]);
      } else {
        setProviderSensitiveValues([]);
      }
      let spawnEnv = claudeChannelEnv(adapter.completeSpawnEnv(env || {}), {
        channel: session.channel,
        localRoute,
      });
      stderrTail = '';
      ready = false;
      processChannel = session.channel;
      processModel = session.model;
      processIdentity = session.identity;
      processProvider = session.provider;
      processCandidateIdentity = session.candidateIdentity;

      let readyResolve;
      let readyReject;
      const readyPromise = new Promise((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
      });
      pendingReadyReject = readyReject;
      pendingReadyTimer = setTimeout(() => {
        pendingReadyTimer = null;
        pendingReadyReject = null;
        try {
          if (proc) proc.kill();
        } catch {}
        readyReject(new Error('sidecar ready timed out'));
      }, READY_TIMEOUT_MS);

      let spawnedProc;
      try {
        const executable = node.executable || { ok: true, id: 'node', path: node.nodePath, argsPrefix: [], source: 'runtime', version: node.version || null, arch: null };
        spawnedProc = adapter.spawn(executable, [
          sidecarPath,
          '--mcp', JSON.stringify(mcpSpec),
          '--allowed-tools', JSON.stringify(meta.allowedTools),
          '--annotations', JSON.stringify(meta.annotations),
          '--model', session.model,
          '--lang', lang,
          '--channel', session.channel,
        ], {
          stdio: 'pipe',
          windowsHide: true,
          env: spawnEnv,
        });
      } catch (e) {
        clearReadyWait();
        throw e;
      } finally {
        if (spawnEnv) delete spawnEnv.ANTHROPIC_AUTH_TOKEN;
        spawnEnv = null;
      }
      assertCurrentStart();
      proc = spawnedProc;

      const reader = createNdjsonReader((message) => {
        if (startGeneration !== runtimeGeneration || proc !== spawnedProc) return;
        if (message && message.t === 'ready') {
          ready = true;
          clearReadyWait();
          readyResolve(true);
          return;
        }
        handleSidecarMessage(message);
      });
      if (spawnedProc.stdout && spawnedProc.stdout.on) spawnedProc.stdout.on('data', reader);
      if (spawnedProc.stderr && spawnedProc.stderr.on) spawnedProc.stderr.on('data', (chunk) => {
        if (startGeneration !== runtimeGeneration || proc !== spawnedProc) return;
        const detail = processChannel === 'api'
          ? '[provider-sidecar-stderr-redacted]\n'
          : redactValue(String(chunk), [...providerSensitiveValues, ...activeAttachmentPaths]);
        stderrTail = appendTail(stderrTail, detail);
      });
      spawnedProc.on('exit', (code, signal) => handleExit(spawnedProc, startGeneration, code, signal));
      spawnedProc.on('error', (error) => {
        handleProcError(spawnedProc, startGeneration, error);
      });

      await readyPromise;
      return true;
    })();
    startPromise = pendingStart;

    try {
      return await pendingStart;
    } catch (e) {
      await cleanupFailedStart(startGeneration);
      if (e?.code !== 'CLAUDE_AGENT_START_CANCELLED') {
        const message = session.channel === 'api'
          ? 'Provider sidecar request failed.'
          : (e && e.message ? e.message : 'Failed to start sidecar.');
        emit({ type: 'error', kind: 'mcp', message });
      }
      return false;
    } finally {
      if (startPromise === pendingStart) startPromise = null;
    }
  }

  async function ensureSidecar(runToken) {
    let session;
    let channel = 'subscription';
    const initialGeneration = runtimeGeneration;
    try {
      channel = normalizeChannel(getChannel ? getChannel() : 'subscription');
      session = await desiredSession(channel);
      if (activeRun !== runToken || runtimeGeneration !== initialGeneration) {
        throw cancelledStartError();
      }
      if (session.recovered) {
        try { await onProviderProfileRecovered(session.provider); } catch {}
        if (activeRun !== runToken || runtimeGeneration !== initialGeneration) {
          throw cancelledStartError();
        }
      }
      if (processIdentity !== null && processIdentity !== session.identity) {
        const replacing = discardRuntime({ clearTranscript: true, clearStderr: true });
        const replacementGeneration = runtimeGeneration;
        await replacing;
        if (activeRun !== runToken || runtimeGeneration !== replacementGeneration) {
          throw cancelledStartError();
        }
      }
      if (proc && ready && processIdentity === session.identity) {
        processProvider = session.provider;
        processCandidateIdentity = session.candidateIdentity;
      }
      return await startSidecar(session);
    } catch (error) {
      if (activeRun === runToken) {
        await discardRuntime({ clearTranscript: true, clearStderr: true });
      }
      if (error?.code !== 'CLAUDE_AGENT_START_CANCELLED') {
        if (error?.kind === 'model') {
          emit({ type: 'error', kind: 'model', code: error.code, message: error.message });
        } else {
          const message = channel === 'api'
            ? 'Provider sidecar request failed.'
            : (error?.message || 'Failed to start sidecar.');
          emit({ type: 'error', kind: 'mcp', message });
        }
      }
      return false;
    }
  }

  async function sendUser(input) {
    if (activeRun) return activeRun;

    const structuredInput = input !== null && typeof input === 'object' && !Array.isArray(input);
    let turn;
    try {
      turn = normalizeTurnInput(input);
    } catch (error) {
      const turnId = typeof input?.turnId === 'string' ? input.turnId : '';
      emit({
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
    resetProviderDeltaRedactor();
    activeRun = new Promise((resolve) => {
      activeResolve = resolve;
    });
    const run = activeRun;

    const ok = await ensureSidecar(run);
    if (!ok || activeRun !== run || !proc || !ready) {
      if (activeRun === run) finishActive();
      return run;
    }

    const userText = turn.text;
    transcript.push({ role: 'user', text: userText });
    activeTurnDispatched = true;
    writeMessage({
      t: 'user',
      ...(turn.turnId ? { turnId: turn.turnId } : {}),
      text: userText,
      ...(structuredInput ? { attachments: turn.attachments } : {}),
      permissionMode: getPermissionMode(),
      model: processModel,
      effort: getEffort ? getEffort() : undefined,
      thinking: getThinking ? getThinking() : undefined,
    });
    return run;
  }

  function approve(toolUseId, decision) {
    writeMessage({ t: 'approve', id: toolUseId, decision });
  }

  function stop() {
    writeMessage({ t: 'stop' });
  }

  function reset() {
    void discardRuntime({ clearTranscript: true, finishRun: true, clearStderr: true });
  }

  return {
    sendUser,
    approve,
    answerQuestion,
    stop,
    reset,
    getMessages: () => clone(transcript),
    getStderrTail: () => stderrTail,
  };
}
