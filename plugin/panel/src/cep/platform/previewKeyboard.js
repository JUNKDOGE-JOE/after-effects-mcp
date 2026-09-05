export function registerPreviewEscape(page = globalThis.window) {
  const platform = page?.cep_node?.process?.platform || globalThis.process?.platform;
  const cep = page?.__adobe_cep__;
  if (platform !== 'win32' || typeof cep?.registerKeyEventsInterest !== 'function') return undefined;
  try {
    // CEP otherwise forwards keys from focused buttons to the AE host.
    cep.registerKeyEventsInterest(JSON.stringify([
      { keyCode: 27, ctrlKey: false, altKey: false, shiftKey: false },
    ]));
  } catch {
    return undefined;
  }
  let active = true;
  const release = () => {
    if (!active) return;
    active = false;
    page.removeEventListener?.('beforeunload', release);
    try { cep.registerKeyEventsInterest(''); } catch {}
  };
  page.addEventListener?.('beforeunload', release);
  return release;
}
