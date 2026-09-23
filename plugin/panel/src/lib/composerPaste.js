export function clipboardFiles(data) {
  const files = Array.from(data?.files || []);
  if (files.length) return files;
  return Array.from(data?.items || [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter(Boolean);
}

export function handleComposerPaste(event, { canAttach, addFiles }) {
  const files = clipboardFiles(event.clipboardData);
  if (!files.length) return false;
  event.preventDefault();
  event.stopPropagation();
  if (canAttach) addFiles(files);
  return true;
}

export function containClipboardKey(event) {
  const key = String(event.key || '').toLowerCase();
  const clipboardChord = event.ctrlKey && !event.shiftKey && (key === 'c' || key === 'v');
  const alternatePaste = event.shiftKey && !event.ctrlKey && key === 'insert';
  const panelPaste = event.altKey && event.shiftKey && !event.ctrlKey && key === 'v';
  if (event.metaKey || (event.altKey && !panelPaste) || !(clipboardChord || alternatePaste || panelPaste)) return;
  if (panelPaste) {
    event.stopPropagation();
    event.preventDefault();
    if (event.type !== 'keydown' || event.repeat) return;
    const doc = event.target?.ownerDocument;
    if (!doc?.execCommand) return false;
    let received = false;
    const markPaste = () => { received = true; };
    doc.addEventListener('paste', markPaste, true);
    try {
      // Use CEP's ordinary paste action so clipboardData retains images and files.
      return doc.execCommand('paste') || received;
    } catch {
      return received;
    } finally {
      doc.removeEventListener('paste', markPaste, true);
    }
  }
  // The browser's default action produces paste/clipboardData; cancelling it would lose the files.
  event.stopPropagation();
}
