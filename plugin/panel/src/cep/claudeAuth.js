import { claudeChannelEnv } from '../lib/claudeChannel.js';
import { createPlatformAdapter } from './platform/index.js';
import { resolveClaudeCli } from './claudeAgentBackend.js';
import { normalizeCepSystemPath } from './platform/paths.js';

function incompatibleSidecarSelection(message) {
  const error = new Error(message);
  error.code = 'RUNTIME_SIDECAR_SELECTION_INCOMPATIBLE';
  return error;
}

export function resolveSidecarPath({
  extRoot,
  fsImpl,
  platform,
  runtimeSelection,
} = {}) {
  const adapter = platform || createPlatformAdapter();
  const root = normalizeCepSystemPath(extRoot || adapter.paths.configRoot, adapter);
  const developmentMarker = adapter.paths.join([root, '.debug']);
  const developmentSidecar = adapter.paths.join([root, 'sidecar', 'agent-sidecar.mjs']);
  const extensionRuntimeSidecar = adapter.paths.join([
    root, 'runtime', adapter.id, 'node', 'sidecar', 'agent-sidecar.mjs',
  ]);
  const fs = fsImpl || adapter.fs;
  if (!fs || typeof fs.existsSync !== 'function') {
    throw new Error('platform filesystem is unavailable');
  }
  if (fs.existsSync(developmentMarker) && fs.existsSync(developmentSidecar)) {
    return developmentSidecar;
  }
  if (adapter.id !== 'macos-arm64') return extensionRuntimeSidecar;
  if (!runtimeSelection) return null;

  const receipt = runtimeSelection.componentReceipt;
  const canonicalPath = receipt?.canonicalPath;
  if (receipt?.component !== 'core-runtime'
      || receipt?.platform !== adapter.id
      || typeof canonicalPath !== 'string'
      || !adapter.paths.isAbsolute(canonicalPath)
      || !adapter.paths.contains(adapter.paths.runtimeRoot, canonicalPath)) {
    throw incompatibleSidecarSelection(
      'The selected runtime does not own a compatible Claude sidecar payload',
    );
  }
  return adapter.paths.join([
    canonicalPath, 'node', 'sidecar', 'agent-sidecar.mjs',
  ]);
}

export function resolveSidecarSelection({
  runtimeActivation,
  extRoot,
  fsImpl,
  platform,
} = {}) {
  const adapter = platform || createPlatformAdapter();
  if (adapter.id === 'macos-arm64'
      && runtimeActivation?.state === 'error'
      && runtimeActivation.error) {
    return { state: 'error', path: null, error: runtimeActivation.error };
  }
  try {
    const path = resolveSidecarPath({
      extRoot,
      fsImpl,
      platform: adapter,
      runtimeSelection: runtimeActivation?.state === 'ready'
        ? runtimeActivation.result
        : null,
    });
    return path
      ? { state: 'ready', path, error: null }
      : { state: 'pending', path: null, error: null };
  } catch (error) {
    return { state: 'error', path: null, error };
  }
}

export async function resolveNodeForSidecarSelection({
  resolveNode,
  runtimeSelection,
  platform,
} = {}) {
  const resolved = await resolveNode({ platform });
  const sidecarCanonicalPath = runtimeSelection?.componentReceipt?.canonicalPath;
  if (sidecarCanonicalPath
      && resolved?.runtime?.componentReceipt?.canonicalPath !== sidecarCanonicalPath) {
    const error = new Error('Selected Sidecar and Node runtime receipts do not match');
    error.code = 'RUNTIME_SIDECAR_NODE_SELECTION_MISMATCH';
    throw error;
  }
  return resolved;
}

export async function probeClaudeLogin({
  platform,
  resolveClaude,
  spawnImpl,
  env,
  timeoutMs = 10000,
} = {}) {
  const adapter = platform || createPlatformAdapter();
  const resolver = resolveClaude || resolveClaudeCli;
  const resolved = await resolver({ platform: adapter, env });
  if (!resolved || resolved.ok === false) {
    return {
      loggedIn: false,
      cliOk: false,
      reason: resolved?.code === 'VERSION_TOO_OLD' ? 'cli-too-old' : 'cli-missing',
      detail: resolved?.detail || 'Claude CLI is unavailable',
    };
  }

  return await new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let proc = null;
    const spawnEnv = claudeChannelEnv(adapter.completeSpawnEnv(env || {}), {
      channel: 'subscription',
    });

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }

    const timer = setTimeout(() => {
      if (proc && proc.kill) {
        try { proc.kill(); } catch (e) { /* best effort */ }
      }
      finish({
        loggedIn: false,
        cliOk: true,
        cliVersion: resolved.version,
        cliPath: resolved.displayPath || resolved.cliPath,
        reason: 'probe-timeout',
        detail: 'Claude CLI auth probe timed out',
      });
    }, timeoutMs);

    try {
      const executable = resolved.executable || {
        ok: true,
        id: 'claude',
        path: resolved.cliPath,
        argsPrefix: [],
        source: 'path',
        version: resolved.version || null,
        arch: null,
      };
      const args = ['auth', 'status', '--json'];
      proc = spawnImpl
        ? spawnImpl(
          executable.path,
          [...(executable.argsPrefix || []), ...args],
          { stdio: 'pipe', windowsHide: true, env: spawnEnv },
        )
        : adapter.spawn(executable, args, {
          stdio: 'pipe',
          windowsHide: true,
          env: spawnEnv,
        });
    } catch (e) {
      finish({
        loggedIn: false,
        cliOk: true,
        cliVersion: resolved.version,
        cliPath: resolved.displayPath || resolved.cliPath,
        reason: 'probe-failed',
        detail: e?.message || String(e),
      });
      return;
    }

    proc.stdout?.on?.('data', (chunk) => {
      stdout = (stdout + String(chunk || '')).slice(-4000);
    });
    if (proc.stderr && proc.stderr.on) {
      proc.stderr.on('data', (chunk) => {
        stderr += String(chunk || '');
        if (stderr.length > 4000) stderr = stderr.slice(-4000);
      });
    }
    if (proc.on) {
      proc.on('error', (err) => {
        finish({
          loggedIn: false,
          cliOk: true,
          cliVersion: resolved.version,
          cliPath: resolved.displayPath || resolved.cliPath,
          reason: 'probe-failed',
          detail: err?.message || String(err),
        });
      });
      proc.on('exit', () => {
        let status = null;
        try { status = JSON.parse(stdout); } catch {}
        if (status && typeof status.loggedIn === 'boolean') {
          finish({
            loggedIn: status.loggedIn,
            cliOk: true,
            cliVersion: resolved.version,
            cliPath: resolved.displayPath || resolved.cliPath,
            reason: status.loggedIn ? null : 'not-logged-in',
            detail: status.loggedIn
              ? [resolved.version, resolved.displayPath || resolved.cliPath]
                .filter(Boolean)
                .join(' · ')
              : 'Claude CLI is not logged in.',
          });
          return;
        }
        finish({
          loggedIn: false,
          cliOk: true,
          cliVersion: resolved.version,
          cliPath: resolved.displayPath || resolved.cliPath,
          reason: 'probe-failed',
          detail: stderr.trim() || stdout.trim() || 'Claude auth probe exited without JSON',
        });
      });
    }
  });
}
