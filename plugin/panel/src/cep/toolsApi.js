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
    error.cause = cause;
    throw error;
  }
  if (result && result.isError) {
    const error = new Error(payload && payload.error || 'Tool Library request failed');
    error.code = payload && payload.error;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function searchArgs(input = {}) {
  const result = {};
  if (typeof input.query === 'string' && input.query.trim()) result.query = input.query.trim();
  if (Number.isInteger(input.offset) && input.offset >= 0) result.offset = input.offset;
  if (Number.isInteger(input.limit) && input.limit > 0) result.limit = input.limit;
  return result;
}

export function createToolsApi(mcp) {
  const call = async (name, args = {}) => parseMcpPayload(await mcp.callTool(name, args));
  return {
    index: (args = {}) => call('ae_toolSearch', searchArgs(args)),
    search: (args = {}) => call('ae_toolSearch', searchArgs(args)),
    inspect: (name) => call('ae_toolSearch', { name }),
    executeTool: (name, args = {}) => call('ae_toolUse', { name, args }),
    listSkills: (options = {}) => call('ae_skillUse', {
      include_templates: options.includeTemplates === true,
    }),
    renderSkill: (name, args = {}) => call('ae_skillUse', {
      name,
      args,
      execute: false,
    }),
    executeSkill: (name, args = {}) => call('ae_skillUse', {
      name,
      args,
      execute: true,
    }),
  };
}
