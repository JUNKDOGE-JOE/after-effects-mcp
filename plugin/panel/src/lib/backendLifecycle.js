export function installBeforeUnloadReset(target, backend, onBeforeUnload) {
  if (!backend || typeof backend.reset !== 'function') {
    throw new TypeError('A backend with reset() is required');
  }

  let active = true;
  const dispose = () => {
    if (!active) return;
    active = false;
    if (target && typeof target.removeEventListener === 'function') {
      target.removeEventListener('beforeunload', dispose);
    }
    if (typeof onBeforeUnload === 'function') onBeforeUnload();
    backend.reset();
  };

  if (target && typeof target.addEventListener === 'function') {
    target.addEventListener('beforeunload', dispose);
  }
  return dispose;
}
