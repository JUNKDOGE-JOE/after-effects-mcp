export function parseMcpPayload(result) {
  const text = Array.isArray(result && result.content)
    ? result.content
      .filter((entry) => entry && entry.type === 'text')
      .map((entry) => String(entry.text || ''))
      .join('')
    : '';
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (cause) {
    const error = new Error('Invalid Tool Library response');
    error.code = 'tool_invalid_response';
    error.cause = cause;
    throw error;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    const error = new Error('Invalid Tool Library response');
    error.code = 'tool_invalid_response';
    throw error;
  }
  if ((result && result.isError) || payload.ok === false) {
    const message = String(payload.error || 'Tool Library request failed');
    const error = new Error(message);
    error.code = String(payload.code || payload.error || 'tool_request_failed');
    error.payload = payload;
    throw error;
  }
  return payload;
}

export function createToolsApi(mcp) {
  if (!mcp || typeof mcp.callTool !== 'function') {
    throw new TypeError('An MCP client is required');
  }
  const call = async (name, args) => parseMcpPayload(
    await mcp.callTool(name, args),
  );
  const panelCall = async (name, args) => {
    if (typeof mcp.callPanelTool !== 'function') {
      throw new Error('Trusted panel Tool Library channel is unavailable');
    }
    return parseMcpPayload(await mcp.callPanelTool(name, args));
  };
  return {
    index: (args = {}) => call('ae_toolIndex', args),
    search: (args = {}) => call('ae_toolSearch', args),
    inspect: (artifactId, options = {}) => call('ae_toolInspect', {
      artifact_id: artifactId,
      ...options,
    }),
    developerIndex: (args = {}) => panelCall('ae_toolIndex', args),
    developerSearch: (args = {}) => panelCall('ae_toolSearch', args),
    developerInspect: (artifactId) => panelCall('ae_toolInspect', {
      artifact_id: artifactId,
    }),
    create: (input) => call('ae_toolCreate', input),
    edit: (input) => call('ae_toolEdit', input),
    delete: (input) => call('ae_toolDelete', input),
    archive: (input) => call('ae_toolArchive', input),
    duplicate: (input) => call('ae_toolDuplicate', input),
    promoteFromHistory: (input) => call('ae_toolPromoteFromHistory', input),
    use: (input) => call('ae_toolUse', input),
    previewImport: (path) => call('ae_toolImport', { action: 'preview', path }),
    commitImport: (importId, resolutions) => call('ae_toolImport', {
      action: 'commit', import_id: importId, resolutions,
    }),
    discardImport: (importId) => call('ae_toolImport', {
      action: 'discard', import_id: importId,
    }),
    exportPackage: (artifactIds, outPath) => call('ae_toolExport', {
      artifact_ids: artifactIds, out_path: outPath,
    }),
    newOperationId: () => {
      if (typeof mcp.newOperationId !== 'function') {
        throw new Error('Secure operation id generation is unavailable');
      }
      return mcp.newOperationId();
    },
  };
}

export async function executeToolPlan(api, {
  artifactId,
  operation,
  args = {},
  target = {},
  operationId = api.newOperationId(),
}) {
  const plan = await api.use({
    artifact_id: artifactId,
    action: 'prepare',
    operation,
    args,
    target,
  });
  const grant = await api.use({
    action: 'grant',
    plan_hash: plan.planHash,
    grant_scope: 'once',
  });
  return api.use({
    action: 'execute',
    plan_hash: plan.planHash,
    grant_id: grant.grantId,
    operation_id: operationId,
  });
}

export async function startToolPlan(api, {
  artifactId,
  operation,
  args = {},
  target = {},
  operationId = api.newOperationId(),
}) {
  const plan = await api.use({
    artifact_id: artifactId,
    action: 'prepare',
    operation,
    args,
    target,
  });
  const grant = await api.use({
    action: 'grant',
    plan_hash: plan.planHash,
    grant_scope: 'once',
  });
  const startRequest = {
    action: 'start',
    plan_hash: plan.planHash,
    grant_id: grant.grantId,
    operation_id: operationId,
  };
  try {
    return await api.use(startRequest);
  } catch (firstError) {
    // The start response can be lost after the server has accepted the job.
    // One bounded retry with the same operation id is idempotent server-side.
    try {
      return await api.use(startRequest);
    } catch (secondError) {
      secondError.startRetryCause = firstError;
      throw secondError;
    }
  }
}

export async function waitForToolExecution(api, execution, {
  pollIntervalMs = 250,
  statusRetryLimit = 2,
  onProgress = () => {},
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  let current = execution;
  onProgress(current);
  while (!current.terminal) {
    await wait(pollIntervalMs);
    let lastError;
    for (let attempt = 0; attempt <= statusRetryLimit; attempt += 1) {
      try {
        current = await api.use({ action: 'status', execution_id: current.executionId });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < statusRetryLimit) await wait(pollIntervalMs);
      }
    }
    if (lastError) {
      lastError.execution = current;
      lastError.recoveryAction = 'resume-status';
      throw lastError;
    }
    onProgress(current);
  }
  return current;
}
