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
  if (event.altKey || event.metaKey || !(clipboardChord || alternatePaste)) return;
  // The browser's default action produces paste/clipboardData; cancelling it would lose the files.
  event.stopPropagation();
}
