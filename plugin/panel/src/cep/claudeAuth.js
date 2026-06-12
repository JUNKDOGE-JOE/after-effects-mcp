import { createNdjsonReader } from '../lib/ndjson.js';

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

function normalizeFsPath(value) {
  let text = String(value || '').replace(/\//g, '\\');
  text = text.replace(/\\+$/, '');
  return text;
}

function defaultFs() {
  return getCepRequire()('fs');
}

function defaultSpawn() {
  return getCepRequire()('child_process').spawn;
}

function joinPath(base, leaf) {
  return normalizeFsPath(base) + '\\' + leaf;
}

export function resolveSidecarPath({ extRoot, fsImpl } = {}) {
  const root = normalizeFsPath(extRoot || '');
  const deployed = joinPath(root, 'sidecar\\agent-sidecar.mjs');
  const repo = joinPath(root, '..\\sidecar\\agent-sidecar.mjs');
  const fs = fsImpl || defaultFs();
  if (fs.existsSync(deployed)) return deployed;
  if (fs.existsSync(repo)) return repo;
  return deployed;
}

export async function probeClaudeLogin({
  resolveNode,
  sidecarPath,
  spawnImpl,
  env,
  timeoutMs = 30000,
} = {}) {
  const resolved = await resolveNode();
  if (!resolved || resolved.ok === false) {
    return { loggedIn: false, nodeOk: false, detail: (resolved && resolved.detail) || 'node unavailable' };
  }

  return await new Promise((resolve) => {
    let settled = false;
    let stderr = '';
    let proc = null;
    const spawn = spawnImpl || defaultSpawn();
    const spawnEnv = Object.assign({}, getCepEnv(), env || {});
    delete spawnEnv.ANTHROPIC_API_KEY;

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
      proc = spawn(resolved.nodePath, [sidecarPath, '--probe'], {
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
