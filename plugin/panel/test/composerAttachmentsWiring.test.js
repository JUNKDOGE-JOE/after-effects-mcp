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

test('ChatScreen sends one controlled TurnInput and never clears on click', () => {
  const chat = source('../src/screens/ChatScreen.jsx');
  assert.match(chat, /attachmentDraft/);
  assert.match(chat, /dispatchAttachmentDraft/);
  assert.match(chat, /const turnId = createTurnId\(\)/);
  assert.match(chat, /attachments:\s*readyAttachments\(attachmentDraft\)/);
  assert.match(chat, /type:\s*'sending',\s*turnId,\s*turn/);
  assert.match(chat, /onSend\?\.\(turn\)/);
  assert.doesNotMatch(chat, /setDraft\(''\)/);
  assert.doesNotMatch(chat, /React\.useState\(''\)/);
});

test('App correlates acceptance before transcript append and releases only at terminal state', () => {
  const app = source('../src/app/App.jsx');
  assert.match(app, /pendingTurnRef/);
  assert.match(app, /evt\.type === 'turn-accepted'/);
  assert.match(app, /if \(!pending \|\| evt\.turnId !== pending\.turnId\) return/);
  assert.match(app, /userTurnEntry\(pending\)/);
  assert.match(app, /dispatchAttachmentDraft\(\{\s*type:\s*'accepted'/);
  assert.match(app, /dispatchState === 'not-started'/);
  assert.match(app, /type:\s*'uncertain'/);
  assert.match(app, /dispatchState:\s*error\?\.dispatchState \|\| 'uncertain'/);
  assert.match(app, /attachmentStore\.release\(attachment\.id\)/);
  assert.match(app, /evt\.type === 'turn-end' \|\| evt\.type === 'error'/);
  assert.doesNotMatch(app, /user-\$\{Date\.now\(\)\}/);
});

test('App owns the draft above Chat tab and disposes its attachment store', () => {
  const app = source('../src/app/App.jsx');
  const draftState = app.indexOf('React.useReducer(\n    reduceAttachmentDraft');
  const conditionalChat = app.indexOf("tab === 'chat'");
  assert.ok(draftState >= 0 && draftState < conditionalChat);
  assert.match(app, /createAttachmentStore/);
  assert.match(app, /\(\) => attachmentStore\.dispose\(\)/);
  assert.match(app, /attachmentStore\.releaseSession\(chatSessionIdRef\.current\)/);
});

test('App includes active attachment paths in exact log-export redaction', () => {
  const app = source('../src/app/App.jsx');
  assert.match(app, /attachmentPathSecrets\(\{\s*draft:\s*attachmentDraft,\s*pendingTurn:\s*pendingTurnRef\.current/s);
  assert.match(app, /exactSecrets\.push\(\.\.\.attachmentSecrets\)/);
});
