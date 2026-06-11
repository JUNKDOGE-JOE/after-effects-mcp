// CEP-only module: spawns the in-process Express host (plugin/host/server.js)
// the way the legacy client.js did. Pure helpers are exported for tests.
export function normalizeCepPath(value) {
  var normalized = String(value || '');
  normalized = normalized.replace(/^file:\\+/i, '');
  normalized = normalized.replace(/^file:\/\/\//i, '');
  normalized = normalized.replace(/^file:\/\//i, '');
  normalized = decodeURIComponent(normalized);
  if (/^\/[A-Za-z]:/.test(normalized)) normalized = normalized.slice(1);
  return normalized;
}

export function isValidPort(p) { return isFinite(p) && p >= 1024 && p <= 65535; }

export const DEFAULT_PORT = 11488;
const PORT_STORAGE_KEY = 'ae_mcp_panel_port';

export function loadSavedPort(storage) {
  try {
    const p = parseInt(storage.getItem(PORT_STORAGE_KEY), 10);
    if (isValidPort(p)) return p;
  } catch (e) {
    // storage unavailable
  }
  return null;
}

export function savePort(storage, port) {
  try {
    storage.setItem(PORT_STORAGE_KEY, String(port));
  } catch (e) {
    // best-effort persistence
  }
}

export function buildMcpConfig(port) {
  return {
    mcpServers: {
      ae: {
        command: 'ae-mcp',
        env: { AE_MCP_BACKEND: 'ae-mcp', AE_MCP_PLUGIN_URL: 'http://127.0.0.1:' + port },
      },
    },
  };
}

function getCepRequire() {
  if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) {
    return globalThis.window.cep_node.require;
  }
  if (globalThis.window && globalThis.window.require) return globalThis.window.require;
  if (globalThis.require) return globalThis.require;
  throw new Error('CEP Node require is unavailable');
}

// ---- CEP side-effects (exercised in AE manual checklist) ----
export function createHostController({ cs, onStatus, onLog }) {
  let host = null;
  function start(port) {
    onStatus('starting', port);
    try {
      const cepRequire = getCepRequire();
      const path = cepRequire('path');
      const extRoot = normalizeCepPath(cs.getSystemPath('extension'));
      const hostPath = path.join(extRoot, 'host', 'server.js');
      onLog('host: ' + hostPath);
      host = cepRequire(hostPath);
      host.setCSInterface(cs);
      host.start(port, (err) => err ? onStatus('error', port, err.message) : onStatus('ok', port));
    } catch (e) {
      onStatus('error', port, e.message);
    }
  }
  function restart(port) {
    if (host && host.restart) {
      onStatus('starting', port);
      host.restart(port, (err) => err ? onStatus('error', port, err.message) : onStatus('ok', port));
    }
  }
  return { start, restart, getHost: () => host };
}
