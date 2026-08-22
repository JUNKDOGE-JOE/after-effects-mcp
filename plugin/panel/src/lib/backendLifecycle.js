export function installBeforeUnloadReset(target, backends, onBeforeUnload) {
  const resettable = Array.isArray(backends) ? backends : [backends];
  if (!resettable.length || resettable.some((backend) => !backend || typeof backend.reset !== 'function')) {
    throw new TypeError('A backend with reset() is required');
  }

  let active = true;
  const dispose = () => {
    if (!active) return;
    active = false;
    if (target && typeof target.removeEventListener === 'function') {
      target.removeEventListener('beforeunload', dispose);
    }
    try {
      if (typeof onBeforeUnload === 'function') onBeforeUnload();
    } catch (error) {
      // Backend termination must still run when persistence cannot finish.
    }
    for (const backend of resettable) {
      try {
        backend.reset();
      } catch (error) {
        // One backend must not prevent the remaining processes from exiting.
      }
    }
  };

  if (target && typeof target.addEventListener === 'function') {
    target.addEventListener('beforeunload', dispose);
  }
  return dispose;
}
