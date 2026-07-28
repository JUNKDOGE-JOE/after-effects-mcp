function initialState() {
  return {
    text: '',
    items: [],
    pendingTurnId: null,
    pendingSnapshot: null,
    dispatchState: null,
    sendError: null,
  };
}

export function createAttachmentDraftState() {
  return initialState();
}

export function readyAttachments(state) {
  return state.items
    .filter((item) => item.status === 'ready' && item.ref)
    .map((item) => item.ref);
}

export function draftIsBusy(state) {
  return state.items.some((item) => item.status === 'staging');
}

export function draftCanSend(state) {
  if (state.pendingTurnId || draftIsBusy(state)) return false;
  if (state.items.some((item) => item.status === 'error')) return false;
  return state.text.trim().length > 0 || readyAttachments(state).length > 0;
}

export function isFileTransfer(dataTransfer) {
  return Array.from(dataTransfer?.types || []).includes('Files');
}

export function attachmentDropFiles(dataTransfer) {
  if (!isFileTransfer(dataTransfer)) return [];
  return Array.from(dataTransfer?.files || []);
}

function replaceItem(items, pondId, update) {
  const index = items.findIndex((item) => item.pondId === pondId);
  if (index < 0) return items;
  const next = items.slice();
  next[index] = update(items[index]);
  return next;
}

function freezeSnapshot(turn, fallbackState, turnId) {
  const source = turn || {
    turnId,
    text: fallbackState.text,
    attachments: readyAttachments(fallbackState),
  };
  return Object.freeze({
    turnId: source.turnId,
    text: source.text,
    attachments: Object.freeze([...source.attachments]),
  });
}

export function reduceAttachmentDraft(state, action) {
  if (!state || !action) return state;

  if (action.type === 'accepted') {
    return action.turnId === state.pendingTurnId ? initialState() : state;
  }
  if (action.type === 'rejected') {
    if (action.turnId !== state.pendingTurnId) return state;
    return {
      ...state,
      pendingTurnId: null,
      pendingSnapshot: null,
      dispatchState: 'not-started',
      sendError: action.error || null,
    };
  }
  if (action.type === 'uncertain') {
    if (action.turnId !== state.pendingTurnId) return state;
    return {
      ...state,
      dispatchState: 'uncertain',
      sendError: action.error || null,
    };
  }
  if (action.type === 'reset') return initialState();

  if (state.pendingTurnId) return state;

  if (action.type === 'text') {
    return {
      ...state,
      text: String(action.value ?? ''),
      sendError: null,
      dispatchState: null,
    };
  }
  if (action.type === 'staging') {
    const replacement = {
      pondId: action.pondId,
      file: action.file,
      status: 'staging',
      ref: null,
      error: null,
    };
    const existing = state.items.findIndex((item) => item.pondId === action.pondId);
    return {
      ...state,
      items: existing < 0
        ? [...state.items, replacement]
        : state.items.map((item, index) => (index === existing ? replacement : item)),
      sendError: null,
    };
  }
  if (action.type === 'ready') {
    const items = replaceItem(state.items, action.pondId, (item) => ({
      ...item,
      status: 'ready',
      ref: action.ref,
      error: null,
    }));
    return items === state.items ? state : { ...state, items };
  }
  if (action.type === 'error') {
    const items = replaceItem(state.items, action.pondId, (item) => ({
      ...item,
      status: 'error',
      ref: null,
      error: action.error || null,
    }));
    return items === state.items ? state : { ...state, items };
  }
  if (action.type === 'remove') {
    const items = state.items.filter((item) => item.pondId !== action.pondId);
    return items.length === state.items.length ? state : { ...state, items };
  }
  if (action.type === 'sending') {
    return {
      ...state,
      pendingTurnId: action.turnId,
      pendingSnapshot: freezeSnapshot(action.turn, state, action.turnId),
      dispatchState: 'pending',
      sendError: null,
    };
  }
  return state;
}
