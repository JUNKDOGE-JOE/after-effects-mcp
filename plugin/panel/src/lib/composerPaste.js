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
