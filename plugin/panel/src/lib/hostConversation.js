function conversationApi(getHost) {
  const host = typeof getHost === 'function' ? getHost() : null;
  const conversations = host && host.mcp && host.mcp.conversations;
  if (!conversations) return null;
  return conversations;
}

function rebindError(id) {
  const error = new Error(`CEP host conversation ${id || 'unknown'} could not be rebound after the host API changed`);
  error.code = 'CEP_HOST_CONVERSATION_REBIND_FAILED';
  return error;
}

export function createHostConversation({ getHost, getWorkContext } = {}) {
  let current = null;
  let currentApi = null;
  let activeTurn = null;

  function turnHeldError() {
    return Object.assign(new Error('The current turn has not confirmed completion.'), { code: 'TURN_STILL_ACTIVE' });
  }

  async function startTurn(turnId) {
    if (activeTurn) throw turnHeldError();
    const api = conversationApi(getHost);
    if (!current || typeof api?.startTurn !== 'function') throw rebindError(current?.id);
    bindCurrent(api);
    const turn = { conversationId: current.id, turnId, api };
    activeTurn = turn;
    try {
      const conversation = await api.startTurn(turn.conversationId, turnId);
      if (!conversation) throw rebindError(turn.conversationId);
      current = conversation;
      return turn;
    } catch (error) {
      if (activeTurn === turn) activeTurn = null;
      throw error;
    }
  }

  async function endTurn(turn) {
    if (!turn || activeTurn !== turn) return false;
    if (!turn.ending) {
      turn.ending = Promise.resolve().then(() => turn.api.endTurn(turn.conversationId, turn.turnId)).then((ended) => {
        if (!ended) throw turnHeldError();
        if (activeTurn === turn) activeTurn = null;
        return true;
      }).catch((error) => { turn.ending = null; throw error; });
    }
    return turn.ending;
  }

  function bindCurrent(conversations) {
    if (!current) return null;
    if (currentApi === conversations) return current;
    if (!conversations || typeof conversations.getById !== 'function') throw rebindError(current.id);
    const rebound = conversations.getById(current.id);
    if (!rebound) throw rebindError(current.id);
    current = rebound;
    currentApi = conversations;
    return current;
  }

  function ensureConversation({ label, approvalTier, expertGuidance, workDir } = {}) {
    const conversations = conversationApi(getHost);
    if (!conversations) {
      if (current) throw rebindError(current.id);
      current = null;
      currentApi = null;
      return null;
    }
    if (current) return bindCurrent(conversations);
    if (typeof conversations.create !== 'function') return null;
    current = null;
    currentApi = conversations;
    const supplied = getWorkContext?.();
    const workContext = workDir === undefined ? supplied : { ...supplied, workDir };
    current = conversations.create({
      label,
      ...(workContext ? { workDir: workContext.workDir, instanceId: workContext.instanceId } : {}),
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
    if (!conversations || typeof conversations.update !== 'function') throw rebindError(current.id);
    bindCurrent(conversations);
    const updated = conversations.update(current.id, patch);
    if (!updated) throw rebindError(current.id);
    current = updated;
    return current;
  }

  function closeConversation() {
    if (!current) return false;
    if (activeTurn) throw turnHeldError();
    const closing = current;
    const conversations = conversationApi(getHost);
    if (!conversations || typeof conversations.close !== 'function') throw rebindError(closing.id);
    bindCurrent(conversations);
    const closed = conversations.close(closing.id);
    if (!closed) throw rebindError(closing.id);
    current = null;
    currentApi = null;
    return true;
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
    startTurn,
    endTurn,
    currentTurn: () => activeTurn,
  };
}
