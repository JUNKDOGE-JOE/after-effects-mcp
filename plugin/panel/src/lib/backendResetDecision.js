const REAL_BACKENDS = new Set(['subscription', 'codex', 'opencode']);

function realBackend(value) {
  return REAL_BACKENDS.has(value) ? value : null;
}

function pendingBackend(pendingSessionLoad, selectedPref) {
  if (!pendingSessionLoad) return null;
  if (typeof pendingSessionLoad === 'object') {
    return realBackend(pendingSessionLoad.backend);
  }
  return realBackend(selectedPref);
}

export function decideBackendReset({
  lastReal,
  effective,
  selectedPref,
  pendingSessionLoad,
} = {}) {
  const previous = realBackend(lastReal);
  const next = realBackend(effective);
  const selected = realBackend(selectedPref);
  const sessionTarget = pendingBackend(pendingSessionLoad, selected);

  if (!next) {
    return {
      reset: false,
      nextReal: sessionTarget && selected === sessionTarget ? sessionTarget : previous,
    };
  }
  if (!previous || previous === next || (sessionTarget === next && selected === next)) {
    return { reset: false, nextReal: next };
  }
  return { reset: true, nextReal: next };
}
