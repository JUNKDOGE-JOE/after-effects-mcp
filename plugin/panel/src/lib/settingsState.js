export function zcodeModelLocked({ backend, modelSwitchable }) {
  return backend === 'zcode' && modelSwitchable === false;
}

export function zcodeRuntimeBadge(zcodeStatus, t) {
  const state = (zcodeStatus && zcodeStatus.state) || 'checking';
  if (state === 'ready') return { status: 'ok', text: t.zcodeReady };
  if (state === 'not-logged-in') return { status: 'warn', text: t.zcodeNotLoggedIn };
  if (state === 'runtime-error') return { status: 'error', text: t.zcodeRuntimeError };
  return { status: 'neutral', text: t.zcodeChecking };
}

export function zcodeUnavailableHint(zcodeStatus, fallback) {
  const detail = zcodeStatus && zcodeStatus.detail ? String(zcodeStatus.detail).trim() : '';
  return detail || fallback;
}
