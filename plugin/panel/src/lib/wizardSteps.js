export const HOST_STEPS = ['host'];
export const CLI_STEPS = ['claude', 'codex', 'opencode'];
export const OPTIONAL_CLIENT_STEPS = ['node'];

const LOG_TAIL = 4096;
const ALL_STEPS = [...HOST_STEPS, ...CLI_STEPS, ...OPTIONAL_CLIENT_STEPS];

function emptyState() {
  return { status: 'idle', version: '', path: '', source: '', logTail: '' };
}

export function initialStepStates() {
  return ALL_STEPS.reduce((acc, id) => {
    acc[id] = emptyState();
    return acc;
  }, {});
}

function appendTail(current, text) {
  return (String(current || '') + String(text || '')).slice(-LOG_TAIL);
}

function patchStep(state, id, patch) {
  return {
    ...state,
    [id]: {
      ...(state[id] || emptyState()),
      ...patch,
    },
  };
}

export function stepReducer(state, action) {
  if (!action || !action.id) return state;
  const current = state[action.id] || emptyState();
  switch (action.type) {
    case 'detect-start':
      return patchStep(state, action.id, { status: 'checking' });
    case 'detect-result':
      return patchStep(state, action.id, {
        status: action.ok ? 'ok' : 'missing',
        version: action.ok ? (action.version || '') : '',
        logTail: action.detail || current.logTail,
        path: action.ok ? (action.path || '') : '',
        source: action.ok ? (action.source || '') : '',
      });
    case 'run-start':
      return patchStep(state, action.id, { status: 'running', logTail: '' });
    case 'run-chunk':
      return patchStep(state, action.id, {
        logTail: appendTail(current.logTail, action.text),
      });
    case 'run-done':
      return patchStep(state, action.id, {
        status: action.ok ? 'checking' : 'fail',
        logTail: appendTail(current.logTail, action.output),
      });
    default:
      return state;
  }
}
