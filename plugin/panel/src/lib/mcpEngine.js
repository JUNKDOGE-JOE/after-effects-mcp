function hostUnavailableError() {
  const error = new Error('CEP host MCP server is not running');
  error.code = 'CEP_HOST_MCP_NOT_RUNNING';
  return error;
}

export async function getMcpSpec({
  port,
  label,
  approvalTier,
  expertGuidance,
  hostConversation,
}) {
  const conversation = hostConversation && hostConversation.ensureConversation({
    label,
    approvalTier,
    expertGuidance,
  });
  if (!conversation || typeof conversation.path !== 'string' || !conversation.path) {
    throw hostUnavailableError();
  }
  return {
    kind: 'http',
    url: `http://127.0.0.1:${port}${conversation.path}`,
    name: 'ae',
  };
}
