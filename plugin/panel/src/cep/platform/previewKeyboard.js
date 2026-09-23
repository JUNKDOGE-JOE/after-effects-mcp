const registrations = new WeakMap();

function registerPanelKeys(keys, page) {
  const platform = page?.cep_node?.process?.platform || globalThis.process?.platform;
  const cep = page?.__adobe_cep__;
  if (platform !== 'win32' || typeof cep?.registerKeyEventsInterest !== 'function') return undefined;
  let state = registrations.get(page);
  if (!state) {
    const owners = new Map();
    const sync = () => {
      const unique = new Map();
      for (const group of owners.values()) {
        for (const key of group) unique.set(JSON.stringify(key), key);
      }
      // CEP replaces the whole interest list; preview cleanup must not erase paste keys.
      cep.registerKeyEventsInterest(unique.size ? JSON.stringify([...unique.values()]) : '');
    };
    const detach = () => {
      page.removeEventListener?.('beforeunload', unload);
      registrations.delete(page);
    };
    const unload = () => {
      owners.clear();
      detach();
      try { sync(); } catch {}
    };
    state = { owners, sync, detach, unload };
  }
  const owner = Symbol();
  state.owners.set(owner, keys);
  try {
    state.sync();
  } catch {
    state.owners.delete(owner);
    return undefined;
  }
  if (!registrations.has(page)) {
    registrations.set(page, state);
    page.addEventListener?.('beforeunload', state.unload);
  }
  return () => {
    if (!state.owners.delete(owner)) return;
    if (!state.owners.size) state.detach();
    try { state.sync(); } catch {}
  };
}

export function registerPreviewEscape(page = globalThis.window) {
  return registerPanelKeys([
    { keyCode: 27, ctrlKey: false, altKey: false, shiftKey: false },
  ], page);
}

export function registerComposerClipboard(page = globalThis.window) {
  return registerPanelKeys([
    { keyCode: 67, ctrlKey: true, altKey: false, shiftKey: false },
    { keyCode: 86, ctrlKey: true, altKey: false, shiftKey: false },
    { keyCode: 86, ctrlKey: false, altKey: true, shiftKey: true },
    { keyCode: 45, ctrlKey: false, altKey: false, shiftKey: true },
  ], page);
}
