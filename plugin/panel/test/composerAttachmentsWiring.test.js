import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function source(relative) {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

test('AttachmentPond configures local unrestricted picker, paste, and preview', () => {
  const pond = source('../src/components/chat/AttachmentPond.jsx');
  assert.match(pond, /registerPlugin\(FilePondPluginImagePreview\)/);
  assert.match(pond, /\ballowMultiple\b/);
  assert.match(pond, /\ballowPaste\b/);
  assert.match(pond, /\ballowBrowse=\{!disabled\}/);
  assert.match(pond, /\ballowDrop=\{!disabled\}/);
  assert.match(pond, /\binstantUpload=\{false\}/);
  assert.match(pond, /\bmaxFiles=\{MAX_ATTACHMENTS_PER_TURN\}/);
  assert.match(pond, /filepond--label-action/);
  assert.doesNotMatch(pond, /acceptedFileTypes|server=|FileReader|readAs|parse|extract|transcod/i);
});

test('Composer delegates one complete file drop to FilePond and leaves text drops alone', () => {
  const composer = source('../src/components/chat/Composer.jsx');
  assert.match(composer, /attachmentDropFiles\(event\.dataTransfer\)/);
  assert.match(
    composer,
    /if \(disabled \|\| streaming \|\| attachmentDraft\.pendingTurnId\) return/,
  );
  assert.match(composer, /if \(!files\.length\) return/);
  assert.match(composer, /event\.preventDefault\(\)/);
  assert.match(composer, /event\.stopPropagation\(\)/);
  assert.equal(
    (composer.match(/attachmentPondRef\.current\?\.addFiles\(files\)/g) || []).length,
    1,
  );
  assert.match(composer, /onDragEnterCapture=\{handleFileDrag\}/);
  assert.match(composer, /onDragOverCapture=\{handleFileDrag\}/);
  assert.match(composer, /onDropCapture=\{handleFileDrop\}/);
});

test('Composer enables attachment-only sends without changing keyboard resize behavior', () => {
  const composer = source('../src/components/chat/Composer.jsx');
  assert.match(composer, /readyAttachmentCount > 0/);
  assert.match(composer, /!attachmentsBusy/);
  assert.match(composer, /e\.key === 'Enter' && !e\.shiftKey/);
  assert.match(composer, /function ComposerResizeHandle/);
  assert.match(composer, /composerKeyboardRequest/);
  assert.doesNotMatch(composer, /FileReader|readAs|parseAttachment|extractText|videoFrame/i);
});

test('AttachmentPond keeps staging failures actionable without hiding other items', () => {
  const pond = source('../src/components/chat/AttachmentPond.jsx');
  assert.match(pond, /item\.status === 'error'/);
  assert.match(pond, /onRetryAttachment\?\.\(item\)/);
  assert.match(pond, /onRemoveAttachment\?\.\(item\)/);
  assert.match(pond, /items\.map/);
});
