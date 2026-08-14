import { createNdjsonReader } from '../lib/ndjson.js';
import { claudeChannelEnv } from '../lib/claudeChannel.js';
import { createPlatformAdapter } from './platform/index.js';
import { resolveSystemNode } from './claudeAgentBackend.js';
import { normalizeCepSystemPath } from './platform/paths.js';
import { isDevelopmentInstall } from './installMode.js';

// The sidecar's import closure. lib.mjs imports ../shared/tool-approval.mjs
// and ../shared/chat-attachments.mjs, so a payload without shared/ spawns and
// immediately dies with ERR_MODULE_NOT_FOUND (#239, confirmed on live
// installs). "The path exists" is therefore not "the sidecar can start" —
// every packaged branch must verify the whole closure before reporting ready.
const SIDECAR_CLOSURE_FILES = Object.freeze(['agent-sidecar.mjs', 'lib.mjs']);
const SHARED_CLOSURE_FILES = Object.freeze(['tool-approval.mjs', 'chat-attachments.mjs']);
const SDK_MANIFEST_SEGMENTS = Object.freeze([
  'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json',
]);

function incompatibleSidecarSelection(message) {
  const error = new Error(message);
  error.code = 'RUNTIME_SIDECAR_SELECTION_INCOMPATIBLE';
  return error;
}

function missingSidecarPayload(missing) {
  const error = new Error(
    `The packaged Claude sidecar payload is incomplete: missing ${missing.join(', ')}`,
  );
  error.code = 'SIDECAR_PAYLOAD_MISSING';
  error.missing = missing;
  return error;
}

// nodeRoot is the directory holding sibling sidecar/ and shared/ trees:
// runtime/<platform>/node inside the extension (Windows ZXP), or
// <componentReceipt.canonicalPath>/node (macOS activated runtime).
function requireSidecarClosure({ nodeRoot, adapter, fs }) {
  const missing = [];
  for (const name of SIDECAR_CLOSURE_FILES) {
    if (!fs.existsSync(adapter.paths.join([nodeRoot, 'sidecar', name]))) {
      missing.push(`sidecar/${name}`);
    }
  }
  for (const name of SHARED_CLOSURE_FILES) {
    if (!fs.existsSync(adapter.paths.join([nodeRoot, 'shared', name]))) {
      missing.push(`shared/${name}`);
    }
  }
  if (!fs.existsSync(adapter.paths.join([nodeRoot, 'sidecar', ...SDK_MANIFEST_SEGMENTS]))) {
    missing.push(`sidecar/${SDK_MANIFEST_SEGMENTS.join('/')}`);
  }
  if (missing.length > 0) throw missingSidecarPayload(missing);
  return adapter.paths.join([nodeRoot, 'sidecar', 'agent-sidecar.mjs']);
}

// Narrow export for packaging self-checks: verify the closure contract at an
// explicit node root (a staged bundle's runtime/<platform>/node before any
// runtime activation exists). Shares requireSidecarClosure with production.
export function verifySidecarClosureAt({ nodeRoot, platform, fsImpl }) {
  const adapter = platform || createPlatformAdapter();
  const fs = fsImpl || adapter.fs;
  return requireSidecarClosure({ nodeRoot, adapter, fs });
}

export function resolveSidecarPath({
  extRoot,
  fsImpl,
  platform,
  runtimeSelection,
} = {}) {
  const adapter = platform || createPlatformAdapter();
  const root = normalizeCepSystemPath(extRoot || adapter.paths.configRoot, adapter);
  const fs = fsImpl || adapter.fs;
  if (!fs || typeof fs.existsSync !== 'function') {
    throw new Error('platform filesystem is unavailable');
  }

  // Development wins only when the install actually IS a development checkout.
  // The macOS platform bundle ships `.debug` by contract, so the marker alone
  // must never route a production install to the stage-root sidecar (#239).
  const developmentSidecar = adapter.paths.join([root, 'sidecar', 'agent-sidecar.mjs']);
  if (isDevelopmentInstall({ extRoot: root, adapter, fsImpl: fs })
      && fs.existsSync(developmentSidecar)) {
    return developmentSidecar;
  }

  if (adapter.id !== 'macos-arm64') {
    const nodeRoot = adapter.paths.join([root, 'runtime', adapter.id, 'node']);
    return requireSidecarClosure({ nodeRoot, adapter, fs });
  }

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
  const nodeRoot = adapter.paths.join([canonicalPath, 'node']);
  return requireSidecarClosure({ nodeRoot, adapter, fs });
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
  resolveNode,
  sidecarPath,
  spawnImpl,
  env,
  timeoutMs = 30000,
} = {}) {
  if (!sidecarPath) {
    return {
      loggedIn: false,
      nodeOk: false,
      detail: 'verified runtime sidecar is not ready',
    };
  }
  const adapter = platform || (spawnImpl ? {
    completeSpawnEnv: (base = {}, additions = {}) => ({ ...base, ...additions }),
    spawn: (executable, args, options) => spawnImpl(executable.path, [...(executable.argsPrefix || []), ...args], options),
  } : createPlatformAdapter());
  const nodeResolver = resolveNode || resolveSystemNode;
  const resolved = await nodeResolver({ platform: adapter });
  if (!resolved || resolved.ok === false) {
    return { loggedIn: false, nodeOk: false, detail: (resolved && resolved.detail) || 'node unavailable' };
  }

  return await new Promise((resolve) => {
    let settled = false;
    let stderr = '';
    let proc = null;
    // Subscription-channel probe: strip key/base-url overrides (spec B3).
    const spawnEnv = claudeChannelEnv(adapter.completeSpawnEnv(env || {}), { channel: 'subscription' });

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
      finish({ loggedIn: false, nodeOk: true, nodeVersion: resolved.version, detail: 'probe timeout' });
    }, timeoutMs);

    try {
      const executable = resolved.executable || { ok: true, id: 'node', path: resolved.nodePath, argsPrefix: [], source: 'runtime', version: resolved.version || null, arch: null };
      proc = adapter.spawn(executable, [sidecarPath, '--probe'], {
        stdio: 'pipe',
        windowsHide: true,
        env: spawnEnv,
      });
    } catch (e) {
      finish({ loggedIn: false, nodeOk: true, nodeVersion: resolved.version, detail: e && e.message ? e.message : String(e) });
      return;
    }

    const onMessage = createNdjsonReader((message) => {
      if (!message || message.t !== 'probe-result') return;
      finish({
        loggedIn: !!message.loggedIn,
        nodeOk: true,
        nodeVersion: resolved.version,
        detail: message.detail || message.reason || '',
      });
    });

    if (proc.stdout && proc.stdout.on) proc.stdout.on('data', onMessage);
    if (proc.stderr && proc.stderr.on) {
      proc.stderr.on('data', (chunk) => {
        stderr += String(chunk || '');
        if (stderr.length > 4000) stderr = stderr.slice(-4000);
      });
    }
    if (proc.on) {
      proc.on('error', (err) => {
        finish({ loggedIn: false, nodeOk: true, nodeVersion: resolved.version, detail: err && err.message ? err.message : String(err) });
      });
      proc.on('exit', () => {
        finish({ loggedIn: false, nodeOk: true, nodeVersion: resolved.version, detail: stderr.trim() || 'probe exited without result' });
      });
    }
  });
}
