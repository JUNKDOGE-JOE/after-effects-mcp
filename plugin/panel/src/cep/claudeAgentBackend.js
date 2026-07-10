import { createNdjsonReader } from '../lib/ndjson.js';
import { claudeChannelEnv } from '../lib/claudeChannel.js';
import { createPlatformAdapter } from './platform/index.js';

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
  getApiProvider = () => null,
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
  let stopping = false;
  let stderrTail = '';
  let transcript = [];
  let activeRun = null;
  let activeResolve = null;
  let activeAssistantText = '';

  function emit(evt) {
    if (onEvent) onEvent(evt);
  }

  function writeMessage(message) {
    if (!proc || !proc.stdin || !proc.stdin.write) return;
    proc.stdin.write(JSON.stringify(message) + '\n');
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

  function handleSidecarMessage(message) {
    if (!message || message.t === 'ready') return;
    if (message.t !== 'event') return;

    const event = message.event;
    if (!event) return;
    if (event.type === 'text-delta') activeAssistantText += String(event.text || '');
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

  function handleExit(code, signal) {
    const wasStopping = stopping;
    const wasReady = ready;
    const detail = exitDetail(code, signal);
    const rejectReady = pendingReadyReject;
    proc = null;
    ready = false;
    startPromise = null;
    stopping = false;
    if (wasStopping) return;
    if (!wasReady && rejectReady) {
      clearReadyWait();
      rejectReady(new Error('sidecar exited: ' + detail));
      return;
    }
    if (activeRun) {
      emit({ type: 'error', kind: 'mcp', message: 'sidecar exited: ' + detail });
      finishActive();
    }
  }

  function handleProcError(error) {
    const rejectReady = pendingReadyReject;
    proc = null;
    ready = false;
    startPromise = null;
    if (rejectReady) {
      clearReadyWait();
      rejectReady(error instanceof Error ? error : new Error('sidecar error'));
      return;
    }
    if (activeRun) {
      emit({ type: 'error', kind: 'mcp', message: error && error.message ? error.message : 'sidecar error' });
      finishActive();
    }
  }

  async function startSidecar() {
    if (proc && ready) return true;
    if (startPromise) return startPromise;

    startPromise = (async () => {
      const node = await resolveNode({ platform: adapter });
      if (!node || !node.ok) {
        emit({ type: 'error', kind: 'mcp', message: nodeMissingMessage(lang) });
        return false;
      }

      const mcpSpec = await getMcpSpec();
      const meta = await getToolMeta();
      const channel = getChannel ? getChannel() : 'subscription';
      const spawnEnv = claudeChannelEnv(adapter.completeSpawnEnv(env || {}), { channel, provider: getApiProvider ? getApiProvider() : null });
      stderrTail = '';
      stopping = false;
      ready = false;

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
          stopping = true;
          if (proc) proc.kill();
        } catch (e) {
          // best effort
        }
        readyReject(new Error('sidecar ready timed out'));
      }, READY_TIMEOUT_MS);

      try {
        const executable = node.executable || { ok: true, id: 'node', path: node.nodePath, argsPrefix: [], source: 'runtime', version: node.version || null, arch: null };
        proc = adapter.spawn(executable, [
          sidecarPath,
          '--mcp', JSON.stringify(mcpSpec),
          '--allowed-tools', JSON.stringify(meta.allowedTools),
          '--annotations', JSON.stringify(meta.annotations),
          '--model', getModel(),
          '--lang', lang,
          '--channel', channel,
        ], {
          stdio: 'pipe',
          windowsHide: true,
          env: spawnEnv,
        });
      } catch (e) {
        clearReadyWait();
        throw e;
      }

      const reader = createNdjsonReader((message) => {
        if (message && message.t === 'ready') {
          ready = true;
          clearReadyWait();
          readyResolve(true);
          return;
        }
        handleSidecarMessage(message);
      });
      if (proc.stdout && proc.stdout.on) proc.stdout.on('data', reader);
      if (proc.stderr && proc.stderr.on) proc.stderr.on('data', (chunk) => {
        stderrTail = appendTail(stderrTail, chunk);
      });
      proc.on('exit', (code, signal) => handleExit(code, signal));
      proc.on('error', (error) => {
        handleProcError(error);
      });

      await readyPromise;
      return true;
    })();

    try {
      return await startPromise;
    } catch (e) {
      emit({ type: 'error', kind: 'mcp', message: e && e.message ? e.message : 'Failed to start sidecar.' });
      return false;
    } finally {
      startPromise = null;
    }
  }

  async function sendUser(text) {
    if (activeRun) return activeRun;

    activeAssistantText = '';
    activeRun = new Promise((resolve) => {
      activeResolve = resolve;
    });

    const ok = await startSidecar();
    if (!ok) {
      finishActive();
      return activeRun;
    }

    const userText = String(text || '');
    transcript.push({ role: 'user', text: userText });
    writeMessage({
      t: 'user',
      text: userText,
      permissionMode: getPermissionMode(),
      model: getModel(),
      effort: getEffort ? getEffort() : undefined,
      thinking: getThinking ? getThinking() : undefined,
    });
    return activeRun;
  }

  function approve(toolUseId, decision) {
    writeMessage({ t: 'approve', id: toolUseId, decision });
  }

  function stop() {
    writeMessage({ t: 'stop' });
  }

  function reset() {
    stopping = true;
    if (proc) {
      try { proc.kill(); } catch (e) { /* best effort */ }
    }
    proc = null;
    ready = false;
    startPromise = null;
    transcript = [];
    finishActive();
    stderrTail = '';
    stopping = false;
  }

  return {
    sendUser,
    approve,
    stop,
    reset,
    getMessages: () => clone(transcript),
    getStderrTail: () => stderrTail,
  };
}
