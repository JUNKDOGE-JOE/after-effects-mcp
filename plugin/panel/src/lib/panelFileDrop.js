import { attachmentDropFiles, isFileTransfer } from './attachmentDraft.js';

// Panel-wide file drop handling (#208). CEP's WebView navigates to a dropped
// file (replacing the panel with a media player), so FILE transfers must be
// intercepted everywhere. Text and URL drags are explicitly left alone: the
// guard never calls preventDefault for them, preserving native drop behavior
// into the Composer textarea. (FilePond's own dropOnPage cannot express this —
// its page-level handlers cancel every transfer — hence this dedicated guard.)
//
// Two install sites share this module:
// - App installs a bare navigation guard (no addFiles) that lives for the
//   panel lifetime, covering tabs where the chat composer is unmounted.
// - Composer installs the attaching guard wired to its FilePond instance.
//   Drops the composer box already handled stop propagating before reaching
//   the window listeners, so each file attaches exactly once.
export function createPanelFileDropGuard({
  target,
  canAttach = () => false,
  addFiles = null,
} = {}) {
  function handleDragOver(event) {
    if (!isFileTransfer(event.dataTransfer)) return;
    // preventDefault is what both allows a drop here and blocks navigation.
    event.preventDefault();
    if (event.dataTransfer) {
      try {
        event.dataTransfer.dropEffect = addFiles && canAttach() ? 'copy' : 'none';
      } catch (e) { /* some engines expose a readonly dropEffect */ }
    }
  }

  function handleDrop(event) {
    if (!isFileTransfer(event.dataTransfer)) return;
    // File drops must never navigate the WebView, even when nothing attaches.
    event.preventDefault();
    if (!addFiles || !canAttach()) return;
    const files = attachmentDropFiles(event.dataTransfer);
    if (files.length) addFiles(files);
  }

  if (target && typeof target.addEventListener === 'function') {
    target.addEventListener('dragover', handleDragOver);
    target.addEventListener('drop', handleDrop);
  }

  return {
    handleDragOver,
    handleDrop,
    dispose() {
      if (target && typeof target.removeEventListener === 'function') {
        target.removeEventListener('dragover', handleDragOver);
        target.removeEventListener('drop', handleDrop);
      }
    },
  };
}
