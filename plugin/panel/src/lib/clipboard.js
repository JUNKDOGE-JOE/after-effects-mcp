function copyTextLegacy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  document.body.removeChild(ta);
  return ok ? Promise.resolve() : Promise.reject(new Error('execCommand copy failed'));
}

export function copyText(text) {
  // CEP's file:// origin rejects navigator.clipboard ("Write permission
  // denied"), so the async API is only an attempt — execCommand is the
  // path that actually works inside AE.
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(() => copyTextLegacy(text));
  }
  return copyTextLegacy(text);
}
