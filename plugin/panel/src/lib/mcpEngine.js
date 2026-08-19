export const MCP_ENGINE_PREF_KEY = 'ae_mcp_mcp_engine';
export const MCP_ENGINE_PYTHON = 'python';
export const MCP_ENGINE_CEP_HOST = 'cep-host';

export function normalizeMcpEngine(value) {
  return value === MCP_ENGINE_CEP_HOST ? MCP_ENGINE_CEP_HOST : MCP_ENGINE_PYTHON;
}

export function loadMcpEngine(storage) {
  try {
    return normalizeMcpEngine(storage && storage.getItem(MCP_ENGINE_PREF_KEY));
  } catch (error) {
    return MCP_ENGINE_PYTHON;
  }
}

export function saveMcpEngine(storage, value) {
  const engine = normalizeMcpEngine(value);
  try {
    if (storage) storage.setItem(MCP_ENGINE_PREF_KEY, engine);
  } catch (error) {
    // Best-effort preference persistence.
  }
  return engine;
}

function cepHostUnavailableError() {
  const error = new Error('CEP host MCP server is not running');
  error.code = 'CEP_HOST_MCP_NOT_RUNNING';
  return error;
}

export async function getMcpSpec({
  engine,
  port,
  label,
  approvalTier,
  expertGuidance,
  hostConversation,
  resolvePythonSpec,
}) {
  if (normalizeMcpEngine(engine) === MCP_ENGINE_PYTHON) {
    if (typeof resolvePythonSpec !== 'function') throw new TypeError('resolvePythonSpec is required');
    return resolvePythonSpec();
  }

  const conversation = hostConversation && hostConversation.ensureConversation({
    label,
    approvalTier,
    expertGuidance,
  });
  if (!conversation || typeof conversation.path !== 'string' || !conversation.path) {
    throw cepHostUnavailableError();
  }
  return {
    kind: 'http',
    url: `http://127.0.0.1:${port}${conversation.path}`,
    name: 'ae',
  };
}
