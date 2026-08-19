function conversationApi(getHost) {
  const host = typeof getHost === 'function' ? getHost() : null;
  const conversations = host && host.mcp && host.mcp.conversations;
  if (!conversations || typeof conversations.create !== 'function') return null;
  return conversations;
}

export function createHostConversation({ getHost } = {}) {
  let current = null;
  let currentApi = null;

  function ensureConversation({ label, approvalTier, expertGuidance } = {}) {
    const conversations = conversationApi(getHost);
    if (!conversations) {
      current = null;
      currentApi = null;
      return null;
    }
    if (current && currentApi === conversations) return current;
    current = null;
    currentApi = conversations;
    current = conversations.create({
      label,
      policy: {
        approvalTier,
        expertGuidance: expertGuidance !== false,
      },
    }) || null;
    if (!current) currentApi = null;
    return current;
  }

  function updatePolicy(patch = {}) {
    if (!current) return null;
    const conversations = conversationApi(getHost);
    if (!conversations || conversations !== currentApi || typeof conversations.update !== 'function') {
      current = null;
      currentApi = null;
      return null;
    }
    const updated = conversations.update(current.id, patch);
    if (updated) current = updated;
    else current = {
      ...current,
      policy: { ...(current.policy || {}), ...patch },
    };
    return current;
  }

  function closeConversation() {
    if (!current) return false;
    const closing = current;
    current = null;
    currentApi = null;
    const conversations = conversationApi(getHost);
    if (!conversations || typeof conversations.close !== 'function') return false;
    return conversations.close(closing.id);
  }

  function currentPath() {
    return current && current.path ? current.path : null;
  }

  function currentId() {
    return current && current.id ? current.id : null;
  }

  function currentConversation() {
    return current;
  }

  return {
    ensureConversation,
    updatePolicy,
    closeConversation,
    currentPath,
    currentId,
    currentConversation,
  };
}
