import { createNdjsonReader } from '../lib/ndjson.js';
import { claudeChannelEnv } from '../lib/claudeChannel.js';
import { createPlatformAdapter } from './platform/index.js';
import { resolveSystemNode } from './claudeAgentBackend.js';
import { normalizeCepSystemPath } from './platform/paths.js';

export function resolveSidecarPath({ extRoot, fsImpl, platform } = {}) {
  const adapter = platform || createPlatformAdapter();
  const root = normalizeCepSystemPath(extRoot || adapter.paths.configRoot, adapter);
  const developmentMarker = adapter.paths.join([root, '.debug']);
  const developmentSidecar = adapter.paths.join([root, 'sidecar', 'agent-sidecar.mjs']);
  const runtimeSidecar = adapter.paths.join([
    root, 'runtime', adapter.id, 'node', 'sidecar', 'agent-sidecar.mjs',
  ]);
  const fs = fsImpl || adapter.fs;
  if (!fs || typeof fs.existsSync !== 'function') throw new Error('platform filesystem is unavailable');
  if (fs.existsSync(developmentMarker) && fs.existsSync(developmentSidecar)) return developmentSidecar;
  // Returning the deterministic production candidate keeps App construction
  // non-throwing; the login probe reports a missing/incomplete payload with the
  // exact path.  This immutable extension path never consults runtime/current.
  return runtimeSidecar;
}

export async function probeClaudeLogin({
  platform,
  resolveNode,
  sidecarPath,
  spawnImpl,
  env,
  timeoutMs = 30000,
} = {}) {
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
