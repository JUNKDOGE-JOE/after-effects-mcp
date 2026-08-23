const MCP_PROTOCOL_VERSION = '2025-06-18';
export const PANEL_VERSION = '0.10.2';

function defaultFetch() {
  if (globalThis.window && globalThis.window.fetch) {
    return globalThis.window.fetch.bind(globalThis.window);
  }
  if (globalThis.fetch) return globalThis.fetch.bind(globalThis);
  throw new Error('fetch is unavailable');
}

function loadHostServer(extensionRoot) {
  const requireImpl = globalThis.window
    && globalThis.window.cep_node
    && globalThis.window.cep_node.require;
  const root = String(extensionRoot || '').replace(/[\\/]+$/, '');
  if (typeof requireImpl !== 'function' || !root) return null;
  try {
    return requireImpl(root + '/host/server.js');
  } catch (error) {
    return null;
  }
}

function rpcError(response) {
  const detail = response && response.error;
  const error = new Error(detail && detail.message ? detail.message : 'MCP request failed');
  if (detail && detail.code !== undefined) error.code = detail.code;
  if (detail && detail.data !== undefined) error.data = detail.data;
  return error;
}

function resultFor(response) {
  if (!response || typeof response !== 'object') return null;
  if (response.error) throw rpcError(response);
  return response.result === undefined ? null : response.result;
}

async function responseBody(response) {
  if (!response) return null;
  if (typeof response.text === 'function') {
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
  if (typeof response.json === 'function') return response.json();
  return null;
}

function requestHeaders(values) {
  const normalized = {};
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') {
      normalized[name.toLowerCase()] = String(value);
    }
  }
  return {
    values: normalized,
    get(name) {
      return normalized[String(name || '').toLowerCase()];
    },
  };
}

export function createMcpClient({
  getHost,
  getConversation = () => null,
  getPort,
  port = 11488,
  fetchImpl,
  extRoot,
  packageVersion = PANEL_VERSION,
} = {}) {
  let status = 'idle';
  let lastError = null;
  let tools = null;
  let serverInstructions = '';
  let serverInfo = null;
  let sessionId = '';
  let nextId = 1;
  let transport = null;
  let startPromise = null;
  let stopped = false;

  function resolveHost() {
    return typeof getHost === 'function' ? getHost() : loadHostServer(extRoot);
  }

  function mountedMcp() {
    const host = resolveHost();
    const mounted = host && host.mcp;
    return mounted && typeof mounted.dispatch === 'function' ? mounted : null;
  }

  function currentConversation() {
    return typeof getConversation === 'function' ? getConversation() : null;
  }

  function currentPort() {
    const value = typeof getPort === 'function' ? getPort() : port;
    return Number(value) || 11488;
  }

  function rootUrl() {
    return `http://127.0.0.1:${currentPort()}/mcp`;
  }

  function currentState() {
    return {
      status,
      error: lastError,
      tools,
      transport: transport ? transport.kind : null,
    };
  }

  function message(method, params) {
    const value = { jsonrpc: '2.0', id: nextId++, method };
    if (params !== undefined) value.params = params;
    return value;
  }

  function notification(method, params) {
    const value = { jsonrpc: '2.0', method };
    if (params !== undefined) value.params = params;
    return value;
  }

  async function dispatchInProcess(payload) {
    const headers = requestHeaders({
      'mcp-session-id': sessionId,
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
    });
    const request = {
      get: headers.get,
      headers: headers.values,
      socket: { localPort: currentPort() },
    };
    const conversation = currentConversation();
    const output = await transport.mounted.dispatch(request, payload, conversation);
    if (output && output.session && output.session.id) sessionId = output.session.id;
    return output ? output.response : null;
  }

  async function dispatchHttp(payload, method = 'POST') {
    const headers = {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const response = await transport.fetcher(transport.url, {
      method,
      headers,
      ...(method === 'POST' ? { body: JSON.stringify(payload) } : {}),
    });
    if (response && response.headers && typeof response.headers.get === 'function') {
      sessionId = response.headers.get('mcp-session-id') || sessionId;
    }
    if (response && response.ok === false) {
      const error = new Error('MCP HTTP request failed with status ' + response.status);
      error.status = response.status;
      throw error;
    }
    return responseBody(response);
  }

  function dispatch(payload) {
    return transport.kind === 'in-process'
      ? dispatchInProcess(payload)
      : dispatchHttp(payload);
  }

  function connectionMatches() {
    if (!transport) return false;
    if (transport.kind === 'in-process') {
      const conversation = currentConversation();
      const conversationId = conversation && conversation.id ? conversation.id : null;
      return mountedMcp() === transport.mounted
        && conversationId === transport.conversationId;
    }
    return rootUrl() === transport.url;
  }

  function clearConnection() {
    if (transport && sessionId) {
      if (transport.kind === 'in-process') {
        try { transport.mounted.sessions?.delete?.(sessionId); } catch (error) { /* best effort */ }
      } else {
        dispatchHttp(null, 'DELETE').catch(() => {});
      }
    }
    transport = null;
    sessionId = '';
    tools = null;
    serverInstructions = '';
    serverInfo = null;
    startPromise = null;
  }

  async function start() {
    if (status === 'ready' && connectionMatches()) return currentState();
    if (status === 'ready') clearConnection();
    if (startPromise) return startPromise;
    stopped = false;
    status = 'starting';
    lastError = null;
    startPromise = (async () => {
      const mounted = mountedMcp();
      if (mounted) {
        const conversation = currentConversation();
        transport = {
          kind: 'in-process',
          mounted,
          conversationId: conversation && conversation.id ? conversation.id : null,
        };
      } else {
        transport = {
          kind: 'http',
          url: rootUrl(),
          fetcher: fetchImpl || defaultFetch(),
        };
      }
      const initialized = resultFor(await dispatch(message('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        clientInfo: { name: 'ae-mcp-panel', version: packageVersion },
        capabilities: {},
      })));
      serverInstructions = initialized && initialized.instructions || '';
      serverInfo = initialized && initialized.serverInfo
        ? { ...initialized.serverInfo }
        : null;
      await dispatch(notification('notifications/initialized'));
      const listed = resultFor(await dispatch(message('tools/list', {})));
      tools = listed && Array.isArray(listed.tools) ? listed.tools : [];
      status = 'ready';
      return currentState();
    })();
    try {
      return await startPromise;
    } catch (error) {
      clearConnection();
      status = 'error';
      lastError = error;
      throw error;
    } finally {
      startPromise = null;
    }
  }

  async function listTools() {
    await start();
    return tools || [];
  }

  async function callTool(name, args = {}) {
    await start();
    try {
      return resultFor(await dispatch(message('tools/call', { name, arguments: args })));
    } catch (error) {
      clearConnection();
      status = 'error';
      lastError = error;
      throw error;
    }
  }

  function stop() {
    stopped = true;
    clearConnection();
    status = 'stopped';
    lastError = null;
  }

  return {
    start,
    listTools,
    callTool,
    stop,
    state: currentState,
    getServerInstructions: () => serverInstructions,
    getServerInfo: () => serverInfo,
    isStopped: () => stopped,
  };
}
