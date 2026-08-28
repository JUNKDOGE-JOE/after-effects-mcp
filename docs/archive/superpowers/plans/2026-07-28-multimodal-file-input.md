# Multimodal File Input Implementation Plan

> Archived 2026-08-28: this dated implementation plan is superseded by the current panel attachment implementation and workflow docs.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add FilePond-backed local file attachments to the real AE chat Composer and expose every attachment through the built-in Codex and Claude Code choices without panel-side content parsing.

**Architecture:** The Panel owns one normalized `TurnInput` contract and one session-scoped attachment store. FilePond owns picker/drop/paste presentation, while a thin draft reducer and store create stable local references. Backend adapters map those references to native local-file items where available or to a delimited, non-visible attachment manifest. Claude subscription and custom Provider channels both use the Agent SDK sidecar; custom Providers are exposed through a panel-owned loopback route. The internal legacy direct-HTTP `byok` backend remains only for state compatibility and is never a live fallback.

**Tech Stack:** React 18.3.1, FilePond 4.32.12, react-filepond 7.1.3, filepond-plugin-image-preview 4.6.12, CEP Node filesystem APIs, Node test runner, Codex app-server JSON-RPC, Claude Agent SDK sidecar, OpenCode HTTP/SSE, ZCode app-server RPC.

## Global Constraints

- Built-in attachment choices and real-host HDEV targets are Codex and Claude Code.
- Claude custom Providers use the Claude Agent SDK loopback route; absence of a usable Node/sidecar runtime fails closed with no direct-HTTP fallback.
- Internal OpenCode and ZCode adapters remain contract-tested but are not exposed or exercised in this slice.
- The internal legacy `byok` HTTP backend remains text-only and must reject attachment turns before dispatch with `ATTACHMENT_SIDECAR_REQUIRED`.
- Do not add a file-extension or MIME allowlist.
- Do not parse, extract, OCR, transcribe, index, convert, transcode, thumbnail video, or sample video frames.
- Do not add a provider upload manager or a new public AE MCP tool.
- Accept at most 32 attachments per turn.
- Stable path-backed files are references and have no Panel-level byte cap.
- Pathless clipboard blobs are capped at 256 MiB each and 512 MiB per turn.
- Never log file contents, absolute paths, generated manifests, credentials, or signed URLs.
- Delete only application-created temporary files; never modify or delete a user original.
- Preserve existing Enter, Shift+Enter, Shift+ArrowUp/Down, pointer resize, chips, send/stop, streaming, and approval behavior.
- Reuse the current development dependencies and installed AE environment where unchanged.
- Run ordinary focused development validation only. Do not run packaged T5 or T6.
- Do not touch the dirty root checkout or its existing #67/#69 and release changes.

---

## File Structure

### New files

- `plugin/shared/chat-attachments.mjs`
  - Normalizes `TurnInput` and `AttachmentRef`.
  - Builds redacted display metadata, native file URLs, and the delimited model-facing manifest.
  - Defines the fixed attachment and clipboard resource constants.
  - Is imported by both the Panel bundle and Claude sidecar so manifest syntax
    cannot drift across processes.
- `plugin/panel/src/lib/attachmentDraft.js`
  - Pure reducer for pending, staging, ready, failed, sending, accepted, and rejected draft states.
- `plugin/panel/src/cep/attachmentStore.js`
  - Validates stable source paths.
  - Atomically stages pathless Blob data in bounded chunks.
  - Tracks temporary ownership and performs contained cleanup.
- `plugin/panel/src/components/chat/AttachmentPond.jsx`
  - Registers FilePond's image preview plugin.
  - Renders picker/drop/paste, progress, generic cards, image previews, errors, and remove actions.
- `plugin/panel/test/attachments.test.js`
  - Common contract, manifest, URL, display-redaction, limits, and registry-invariant tests.
- `plugin/panel/test/attachmentDraft.test.js`
  - Pure draft state and send/accept/reject tests.
- `plugin/panel/test/attachmentStore.test.js`
  - Real temporary-directory staging and cleanup tests.
- `plugin/panel/test/composerAttachmentsWiring.test.js`
  - Source-level React wiring and keyboard-regression guard.

### Modified files

- `plugin/panel/package.json`
- `plugin/panel/package-lock.json`
- `plugin/panel/src/main.jsx`
- `plugin/panel/src/styles/index.css`
- `plugin/panel/src/components/chat/Composer.jsx`
- `plugin/panel/src/components/chat/ChatBubble.jsx`
- `plugin/panel/src/screens/ChatScreen.jsx`
- `plugin/panel/src/app/App.jsx`
- `plugin/panel/src/lib/chatEntries.js`
- `plugin/panel/src/lib/agentLoop.js`
- `plugin/panel/src/cep/backends/contract.js`
- `plugin/panel/src/cep/backends/index.js`
- `plugin/panel/src/cep/codexBackend.js`
- `plugin/panel/src/cep/claudeAgentBackend.js`
- `plugin/panel/src/cep/openCodeBackend.js`
- `plugin/panel/src/cep/zcodeBackend.js`
- `plugin/sidecar/lib.mjs`
- `plugin/panel/test/backends-contract.test.js`
- `plugin/panel/test/chatEntries.test.js`
- `plugin/panel/test/agentLoop.test.js`
- `plugin/panel/test/codexBackend.test.js`
- `plugin/panel/test/claudeAgentBackend.test.js`
- `plugin/panel/test/openCodeBackend.test.js`
- `plugin/panel/test/zcodeBackend.test.js`
- `plugin/sidecar/test/sidecar.test.js`
- `docs/superpowers/specs/2026-07-28-multimodal-file-input-design.md`

---

### Task 1: Freeze the shared turn and backend attachment contracts

**Files:**
- Create: `plugin/shared/chat-attachments.mjs`
- Modify: `plugin/panel/src/cep/backends/contract.js`
- Modify: `plugin/panel/src/cep/backends/index.js`
- Create: `plugin/panel/test/attachments.test.js`
- Modify: `plugin/panel/test/backends-contract.test.js`

**Interfaces:**
- Produces: `normalizeTurnInput(input) -> TurnInput`
- Produces: `displayAttachments(attachments) -> DisplayAttachment[]`
- Produces: `attachmentManifest(attachments) -> string`
- Produces: `withAttachmentManifest(text, attachments) -> string`
- Produces: `attachmentFileUrl(path, platformId) -> string`
- Produces: `assertAttachmentBackendRegistry(registry) -> true`
- Produces event: `{type: "turn-accepted", turnId: string, transport: string}`
- Extends pre-acceptance errors with:
  `turnId: string` and `dispatchState: "not-started" | "uncertain"`
- Produces registry field: `attachmentTransport: "agent-sdk" | "native" | "manifest" | "reject"`

- [ ] **Step 1: Write failing common-contract tests**

Add exact tests covering legacy string normalization, attachment-only turns,
order preservation, display redaction, manifest generation, Windows/macOS file
URLs, and invalid shapes:

```js
test('normalizeTurnInput preserves an attachment-only turn', () => {
  const turn = normalizeTurnInput({
    turnId: 'turn-1',
    text: '',
    attachments: [{
      id: 'att-1',
      name: 'clip.bin',
      localPath: '/tmp/private/clip.bin',
      size: 3,
      mediaType: 'application/octet-stream',
      temporary: true,
    }],
  });
  assert.equal(turn.turnId, 'turn-1');
  assert.equal(turn.text, '');
  assert.equal(turn.attachments[0].localPath, '/tmp/private/clip.bin');
});

test('display metadata never contains a local path', () => {
  const value = displayAttachments([fixtureAttachment()]);
  assert.deepEqual(value, [{
    id: 'att-1',
    name: 'clip.bin',
    size: 3,
    mediaType: 'application/octet-stream',
  }]);
  assert.equal(JSON.stringify(value).includes('/tmp/private'), false);
});
```

- [ ] **Step 2: Run the tests and verify the contract does not exist**

Run:

```bash
cd plugin/panel
node --test test/attachments.test.js test/backends-contract.test.js
```

Expected: FAIL because `chat-attachments.mjs`, `turn-accepted`, and
`attachmentTransport` do not exist.

- [ ] **Step 3: Implement the normalized contract and manifest helpers**

Use the following public shapes:

```js
export const MAX_ATTACHMENTS_PER_TURN = 32;
export const MAX_CLIPBOARD_ITEM_BYTES = 256 * 1024 * 1024;
export const MAX_CLIPBOARD_TURN_BYTES = 512 * 1024 * 1024;
export const ATTACHMENT_MANIFEST_OPEN = '<ae_mcp_attachments version="1">';
export const ATTACHMENT_MANIFEST_CLOSE = '</ae_mcp_attachments>';

export function normalizeTurnInput(input) {
  const source = typeof input === 'string'
    ? { turnId: '', text: input, attachments: [] }
    : input;
  // Return a fresh frozen-compatible object after exact primitive checks.
}

export function displayAttachments(attachments) {
  return attachments.map(({ id, name, size, mediaType }) => ({
    id, name, size, ...(mediaType ? { mediaType } : {}),
  }));
}

export function attachmentManifest(attachments) {
  const files = attachments.map(({ id, name, localPath, size, mediaType }) => ({
    id, name, path: localPath, size, mediaType: mediaType || 'application/octet-stream',
  }));
  return ATTACHMENT_MANIFEST_OPEN + '\n'
    + JSON.stringify({ files }) + '\n'
    + ATTACHMENT_MANIFEST_CLOSE;
}

export function withAttachmentManifest(text, attachments) {
  const body = String(text || '');
  if (!attachments.length) return body;
  return body
    ? body + '\n\n' + attachmentManifest(attachments)
    : attachmentManifest(attachments);
}
```

`attachmentFileUrl` must percent-encode path components and produce
`file:///C:/...` on `windows-x64` and `file:///...` on `macos-arm64`.

- [ ] **Step 4: Add the acceptance event and registry dispositions**

Add `turn-accepted` to `BACKEND_EVENTS`. Add these exact dispositions:

```js
subscription: { attachmentTransport: 'agent-sdk' }
'claude-api': { attachmentTransport: 'agent-sdk' }
byok: { attachmentTransport: 'reject' }
codex: { attachmentTransport: 'native+manifest' }
opencode: { attachmentTransport: 'native' }
zcode: { attachmentTransport: 'manifest' }
```

`assertAttachmentBackendRegistry` must enumerate the supplied registry,
require one known disposition on every row, allow `reject` only for `byok`,
and require every other row to have a non-reject transport.

Document the dispatch rule in `backends/contract.js`:

- an error before any model-turn request is sent uses
  `dispatchState: "not-started"`;
- a transport failure after the request is sent but before `turn-accepted`
  uses `dispatchState: "uncertain"`;
- no adapter retries an uncertain turn automatically.

- [ ] **Step 5: Prove the registry guard with an in-test mutation**

Add:

```js
test('attachment registry rejects a missing supported-backend mapping', () => {
  const mutated = {
    ...BACKENDS,
    codex: { ...BACKENDS.codex, attachmentTransport: undefined },
  };
  assert.throws(
    () => assertAttachmentBackendRegistry(mutated),
    /codex.*attachment transport/i,
  );
});
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
cd plugin/panel
node --test test/attachments.test.js test/backends-contract.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit the shared contract**

```bash
git add plugin/shared/chat-attachments.mjs plugin/panel/src/cep/backends/contract.js plugin/panel/src/cep/backends/index.js plugin/panel/test/attachments.test.js plugin/panel/test/backends-contract.test.js
git commit -m "feat(panel): define attachment turn contract"
```

---

### Task 2: Build the bounded session attachment store

**Files:**
- Create: `plugin/panel/src/cep/attachmentStore.js`
- Create: `plugin/panel/test/attachmentStore.test.js`

**Interfaces:**
- Consumes: constants and normalized attachment shape from
  `plugin/shared/chat-attachments.mjs`
- Produces: `createAttachmentStore(options) -> AttachmentStore`
- Produces: `store.prepare(file, {sessionId, pondId}) -> Promise<AttachmentRef>`
- Produces: `store.release(attachmentId) -> void`
- Produces: `store.releaseSession(sessionId) -> void`
- Produces: `store.dispose() -> void`

- [ ] **Step 1: Write failing filesystem lifecycle tests**

Use `mkdtempSync` and real Node `fs` for a disposable root. Cover:

```js
test('path-backed originals remain user-owned and are never deleted', async (t) => {
  const original = join(root, 'original.mov');
  writeFileSync(original, Buffer.from('video'));
  const store = makeStore(root);
  const ref = await store.prepare(
    { name: 'original.mov', size: 5, type: 'video/quicktime', path: original },
    { sessionId: 's1', pondId: 'p1' },
  );
  assert.equal(ref.temporary, false);
  store.release(ref.id);
  assert.equal(readFileSync(original, 'utf8'), 'video');
});

test('pathless blob is staged atomically and removed with its session', async () => {
  const store = makeStore(root);
  const blob = new Blob([Buffer.from('abc')], { type: 'application/octet-stream' });
  Object.defineProperty(blob, 'name', { value: 'clip.bin' });
  const ref = await store.prepare(blob, { sessionId: 's1', pondId: 'p1' });
  assert.equal(ref.temporary, true);
  assert.equal(readFileSync(ref.localPath, 'utf8'), 'abc');
  store.releaseSession('s1');
  assert.equal(existsSync(ref.localPath), false);
});
```

Also test the 32-item limit, both clipboard byte limits, separator stripping,
partial-write cleanup, idempotent release, and refusal to delete outside the
managed root.

- [ ] **Step 2: Run the store test and verify it fails**

Run:

```bash
cd plugin/panel
node --test test/attachmentStore.test.js
```

Expected: FAIL because `createAttachmentStore` does not exist.

- [ ] **Step 3: Implement stable-path preparation**

Use this constructor:

```js
export function createAttachmentStore({
  platform,
  randomUUID,
  readBlobChunk = browserBlobChunk,
  chunkBytes = 1024 * 1024,
  now = Date.now,
}) {
  const root = platform.paths.join([
    platform.paths.tempRoot,
    'ae-mcp-panel-attachments',
  ]);
  // Track {ref, sessionId} by attachment id.
}
```

For `file.path`:

1. normalize it with `platform.paths.resolve([file.path])`;
2. require an absolute path;
3. require `statSync(path).isFile()`;
4. require `accessSync(path, fs.constants.R_OK)`;
5. return `temporary: false` without copying.

Use `platform.paths.basename` for the display name so a browser-supplied name
cannot create nested paths.

- [ ] **Step 4: Implement bounded pathless-Blob staging**

Create `<root>/<sessionId>/` with owner-only permissions where supported. Write
to `<id>.part`, call `fsyncSync`, close it, then rename to
`<id>-<safe-basename>`.

Read the Blob in `chunkBytes` slices. The browser default uses `FileReader` for
each slice; tests inject a reader based on `slice.arrayBuffer()`.

On any failure:

- close the descriptor if open;
- unlink only the contained `.part` path;
- remove the in-memory record;
- throw an error with a stable code such as
  `ATTACHMENT_STAGING_FAILED`, `ATTACHMENT_ITEM_TOO_LARGE`, or
  `ATTACHMENT_TURN_TOO_LARGE`.

- [ ] **Step 5: Implement contained cleanup**

Before any unlink:

```js
if (!ref.temporary || !platform.paths.contains(root, ref.localPath)) return;
```

`release`, `releaseSession`, and `dispose` are idempotent. Cleanup removes empty
session directories but never recursively targets `tempRoot` or `configRoot`.

- [ ] **Step 6: Run focused store and path tests**

Run:

```bash
cd plugin/panel
node --test test/attachmentStore.test.js test/platform-paths.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit the attachment store**

```bash
git add plugin/panel/src/cep/attachmentStore.js plugin/panel/test/attachmentStore.test.js
git commit -m "feat(panel): stage session attachments safely"
```

---

### Task 3: Add the FilePond Composer surface and pure draft state

**Files:**
- Modify: `plugin/panel/package.json`
- Modify: `plugin/panel/package-lock.json`
- Modify: `plugin/panel/src/main.jsx`
- Modify: `plugin/panel/src/styles/index.css`
- Modify (generated): `plugin/client/dist/app.js`
- Modify (generated): `plugin/client/dist/app.css`
- Create: `plugin/panel/src/lib/attachmentDraft.js`
- Create: `plugin/panel/src/components/chat/AttachmentPond.jsx`
- Modify: `plugin/panel/src/components/chat/Composer.jsx`
- Create: `plugin/panel/test/attachmentDraft.test.js`
- Create: `plugin/panel/test/composerAttachmentsWiring.test.js`
- Modify: `plugin/panel/test/composerResizeWiring.test.js`

**Interfaces:**
- Consumes: `AttachmentStore.prepare/release`
- Produces: `createAttachmentDraftState()`
- Produces: `reduceAttachmentDraft(state, action)`
- Produces component: `AttachmentPond`
- Extends `Composer` props with `attachmentDraft`, `onAddFile`,
  `onRemoveAttachment`, `onRetryAttachment`, and `attachmentLabels`

- [ ] **Step 1: Add exact open-source dependencies**

From `plugin/panel` run:

```bash
npm install --save-exact filepond@4.32.12 react-filepond@7.1.3 filepond-plugin-image-preview@4.6.12
```

Do not add FilePond type-validation, file-size-validation, PDF-preview, video
preview, transform, encode, or upload plugins.

- [ ] **Step 2: Write failing pure draft tests**

Cover add/staging/ready/error/remove, attachment-only send eligibility,
pre-dispatch preservation, accepted clear, and rejected retention:

```js
test('accepted clears only the matching frozen turn', () => {
  let state = createAttachmentDraftState();
  state = reduceAttachmentDraft(state, { type: 'text', value: 'inspect' });
  state = reduceAttachmentDraft(state, { type: 'ready', pondId: 'p1', ref: fixtureRef() });
  state = reduceAttachmentDraft(state, { type: 'sending', turnId: 'turn-1' });
  assert.equal(reduceAttachmentDraft(state, { type: 'accepted', turnId: 'other' }), state);
  const cleared = reduceAttachmentDraft(state, { type: 'accepted', turnId: 'turn-1' });
  assert.equal(cleared.text, '');
  assert.deepEqual(cleared.items, []);
});

test('pre-dispatch rejection preserves text and files', () => {
  const sending = readySendingState('turn-1');
  const rejected = reduceAttachmentDraft(sending, {
    type: 'rejected',
    turnId: 'turn-1',
    error: 'backend unavailable',
  });
  assert.equal(rejected.text, sending.text);
  assert.deepEqual(rejected.items, sending.items);
  assert.equal(rejected.pendingTurnId, null);
});
```

- [ ] **Step 3: Run the draft test and verify it fails**

Run:

```bash
cd plugin/panel
node --test test/attachmentDraft.test.js
```

Expected: FAIL because the reducer does not exist.

- [ ] **Step 4: Implement the pure reducer**

Use item states:

```js
{
  pondId,
  file,
  status: 'staging' | 'ready' | 'error',
  ref: null | AttachmentRef,
  error: null | {code, message},
}
```

The state also contains:

```js
{
  text: '',
  items: [],
  pendingTurnId: null,
  pendingSnapshot: null,
}
```

Export selectors `readyAttachments(state)`, `draftCanSend(state)`, and
`draftIsBusy(state)`.

- [ ] **Step 5: Create the FilePond wrapper**

Register `FilePondPluginImagePreview` once at module scope. Configure:

```jsx
<FilePond
  files={pondFiles}
  allowMultiple
  allowPaste
  allowBrowse={!disabled}
  allowDrop={!disabled}
  allowReorder={false}
  instantUpload={false}
  maxFiles={MAX_ATTACHMENTS_PER_TURN}
  credits={false}
  onaddfile={handleAdd}
  onremovefile={handleRemove}
/>
```

Do not configure `acceptedFileTypes`, a FilePond `server`, any other MIME or
extension filter, or an upload endpoint. Use
FilePond only for local item interaction. Render application status text beside
each item so staging and errors remain understandable even if FilePond's
internal status wording differs. A staging error exposes explicit retry and
remove actions; retry reuses the original FilePond `File` and creates a fresh
store operation.

- [ ] **Step 6: Wire attachments into Composer without changing keyboard behavior**

Import FilePond CSS and image-preview CSS from `main.jsx`, before the local
stylesheet:

```js
import 'filepond/dist/filepond.min.css';
import 'filepond-plugin-image-preview/dist/filepond-plugin-image-preview.css';
import './styles/index.css';
```

Render `AttachmentPond` inside the resizable input well above the textarea.
Compute:

```js
const canSend = !disabled
  && !streaming
  && !attachmentsBusy
  && (value.trim().length > 0 || readyAttachmentCount > 0);
```

Keep the existing `handleKey` condition for Enter and Shift+Enter. Keep the
resize handle and option row outside FilePond's event handling.

Give `AttachmentPond` a ref exposing `addFiles(files)`. Add `dragenter`,
`dragover`, and `drop` handlers to the Composer input well, call
`preventDefault` only when the transfer contains files, and forward the
complete dropped file list to FilePond. This makes the whole Composer the drop
target without implementing a second file list. Non-file text drops keep their
existing browser behavior.

- [ ] **Step 7: Add CSS scoped under `.ae-attachment-pond`**

Override FilePond only within the Composer:

- compact single-column item height;
- image thumbnail where available;
- generic icon/name/size for other files;
- visible remove button and focus ring;
- no media, PDF, or video preview;
- no clipping of Composer chip drop-ups;
- internal scroll once attachments consume the allowed Composer space.

- [ ] **Step 8: Add wiring regressions**

The source-level test must assert:

- FilePond is configured with `allowPaste`, `allowMultiple`, and no accepted
  type list;
- a file drop anywhere on the Composer delegates to FilePond exactly once;
- a staging error exposes retry and remove without discarding other items;
- attachment-only state participates in `canSend`;
- `Shift+Enter` remains excluded from send;
- `ComposerResizeHandle` and its Shift+Arrow logic remain present;
- no `FileReader` or content parser exists in the React component.

- [ ] **Step 9: Run focused UI-state and resize tests**

Run:

```bash
cd plugin/panel
node --test test/attachmentDraft.test.js test/composerAttachmentsWiring.test.js test/composerResize.test.js test/composerResizeWiring.test.js
```

Expected: PASS.

- [ ] **Step 10: Commit the Composer surface**

```bash
git add plugin/panel/package.json plugin/panel/package-lock.json plugin/panel/src/main.jsx plugin/panel/src/styles/index.css plugin/panel/src/lib/attachmentDraft.js plugin/panel/src/components/chat/AttachmentPond.jsx plugin/panel/src/components/chat/Composer.jsx plugin/panel/test/attachmentDraft.test.js plugin/panel/test/composerAttachmentsWiring.test.js plugin/panel/test/composerResizeWiring.test.js plugin/client/dist/app.js plugin/client/dist/app.css
git commit -m "feat(panel): add FilePond attachment composer"
```

---

### Task 4: Integrate drafts, acceptance, transcript metadata, and cleanup

**Files:**
- Modify: `plugin/panel/src/screens/ChatScreen.jsx`
- Modify: `plugin/panel/src/app/App.jsx`
- Modify: `plugin/panel/src/lib/chatEntries.js`
- Modify: `plugin/panel/src/components/chat/ChatBubble.jsx`
- Modify: `plugin/panel/test/chatEntries.test.js`
- Modify: `plugin/panel/test/composerAttachmentsWiring.test.js`

**Interfaces:**
- Consumes: `AttachmentStore`, draft reducer, `TurnInput`, and
  `turn-accepted`
- Produces: `onSend(turnInput)`
- Produces: `userTurnEntry(turnInput) -> redacted transcript entry`
- Produces prop: `createTurnId() -> string`
- Produces transcript entry:
  `{type: "user-text", text, attachments: DisplayAttachment[]}`

- [ ] **Step 1: Write failing send-lifecycle tests**

Add reducer and source-wiring tests proving:

```js
test('turn-accepted appends only redacted display metadata', () => {
  const entry = userTurnEntry({
    turnId: 'turn-1',
    text: '',
    attachments: [fixtureAttachment()],
  });
  assert.equal(entry.type, 'user-text');
  assert.deepEqual(entry.attachments, [{
    id: 'att-1',
    name: 'clip.bin',
    size: 3,
    mediaType: 'application/octet-stream',
  }]);
  assert.equal(JSON.stringify(entry).includes('/tmp/private'), false);
});
```

The wiring test must require a pending `turnId`, delayed draft clearing, and
temporary cleanup on terminal events.

- [ ] **Step 2: Run focused tests and verify they fail**

Run:

```bash
cd plugin/panel
node --test test/chatEntries.test.js test/composerAttachmentsWiring.test.js
```

Expected: FAIL because App and ChatScreen still pass strings and clear
immediately.

- [ ] **Step 3: Make ChatScreen a controlled attachment draft consumer**

Replace the local text-only send path with:

```js
const send = () => {
  if (!draftCanSend(attachmentDraft) || composerDisabled || streaming) return;
  const turnId = createTurnId();
  const turn = {
    turnId,
    text: attachmentDraft.text.trim(),
    attachments: readyAttachments(attachmentDraft),
  };
  dispatchAttachmentDraft({ type: 'sending', turnId, turn });
  onSend?.(turn);
};
```

Do not clear on click. Clear only when `acceptedTurnId` matches. On a matching
`rejectedTurn`, retain text and attachments and expose the error beside the
Composer.

App passes `createTurnId={() => cepRequire('crypto').randomUUID()}`. Do not
derive the turn id from `Date.now()` or an attachment filename.

- [ ] **Step 4: Own store and draft lifecycle in App**

Create one store from the existing `platform`:

```js
const attachmentStore = React.useMemo(() => createAttachmentStore({
  platform,
  randomUUID: () => cepRequire('crypto').randomUUID(),
}), [platform]);
```

Keep draft state above the conditionally rendered Chat tab so switching tabs
does not lose it. Use a session token such as `chat-${chatSessionEpoch}`.

The add/remove callbacks are:

```js
async function addAttachment({ pondId, file }) {
  dispatchAttachmentDraft({ type: 'staging', pondId, file });
  try {
    const ref = await attachmentStore.prepare(file, { sessionId, pondId });
    dispatchAttachmentDraft({ type: 'ready', pondId, ref });
  } catch (error) {
    dispatchAttachmentDraft({
      type: 'error',
      pondId,
      error: { code: error.code || 'ATTACHMENT_STAGING_FAILED', message: error.message },
    });
  }
}
```

Remove releases a ready ref before deleting the reducer item. Retry calls
`addAttachment` again with the retained original `File`.

On a new session or backend reset:

1. stop/reset the backend as today;
2. release the previous session's temporary attachments;
3. create a new session token;
4. reset the draft and transcript.

Dispose the store during App unmount.

- [ ] **Step 5: Correlate accepted and rejected turns**

Keep `pendingTurnRef` with one immutable normalized turn. `sendChat(turn)` must:

1. reject a second send while one turn is pending;
2. store the snapshot;
3. call `activeBackend.sendUser(turn)`;
4. avoid appending transcript content before acceptance.

On matching `turn-accepted`:

- append one `user-text` entry created by
  `userTurnEntry(pendingTurnRef.current)`, with display attachments;
- set the accepted turn id for ChatScreen;
- mark streaming true;
- retain temporary refs until the terminal event.

On an `error` before acceptance:

- when `dispatchState === "not-started"`, set the rejected turn for ChatScreen,
  do not append the user entry, leave the draft and temporary refs intact, and
  permit an explicit retry;
- when `dispatchState === "uncertain"`, retain the frozen snapshot, leave the
  draft and temporary refs intact, disable resubmission, and require backend
  reset/new-session reconciliation.

Every pre-acceptance backend error must carry the matching `turnId`. Ignore
stale errors from an older turn rather than applying them to the current draft.

On `turn-end` or a post-acceptance `error`:

- release the dispatched temporary refs;
- clear the pending snapshot;
- preserve the existing streaming/thinking terminal behavior.

- [ ] **Step 6: Render transcript attachment metadata**

Extend user `ChatBubble` content with compact attachment rows containing only
name and formatted size. Do not render `localPath`, `temporary`, manifest
content, or transport details.

Export `userTurnEntry` from `chatEntries.js`:

```js
export function userTurnEntry(turn) {
  return {
    id: `user-${turn.turnId}`,
    type: 'user-text',
    text: turn.text,
    attachments: displayAttachments(turn.attachments),
  };
}
```

- [ ] **Step 7: Run focused lifecycle tests**

Run:

```bash
cd plugin/panel
node --test test/attachmentDraft.test.js test/chatEntries.test.js test/composerAttachmentsWiring.test.js test/backendLifecycle.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit lifecycle integration**

```bash
git add plugin/panel/src/screens/ChatScreen.jsx plugin/panel/src/app/App.jsx plugin/panel/src/lib/chatEntries.js plugin/panel/src/components/chat/ChatBubble.jsx plugin/panel/test/chatEntries.test.js plugin/panel/test/composerAttachmentsWiring.test.js
git commit -m "feat(panel): retain attachment turns until accepted"
```

---

### Task 5: Map Codex, OpenCode, ZCode, and legacy BYOK

**Files:**
- Modify: `plugin/panel/src/cep/codexBackend.js`
- Modify: `plugin/panel/src/cep/openCodeBackend.js`
- Modify: `plugin/panel/src/cep/zcodeBackend.js`
- Modify: `plugin/panel/src/lib/agentLoop.js`
- Modify: `plugin/panel/test/codexBackend.test.js`
- Modify: `plugin/panel/test/openCodeBackend.test.js`
- Modify: `plugin/panel/test/zcodeBackend.test.js`
- Modify: `plugin/panel/test/agentLoop.test.js`

**Interfaces:**
- Consumes: normalized `TurnInput`, `withAttachmentManifest`, and
  `attachmentFileUrl`
- Produces: one `turn-accepted` event per accepted turn
- Codex transport: manifest for every file plus native image/audio input items
- OpenCode transport: `FilePartInput`
- ZCode transport: delimited attachment manifest
- BYOK transport: pre-dispatch structured rejection

- [ ] **Step 1: Write failing Codex hybrid-input tests**

Assert the `turn/start` body contains:

```js
[
  {
    type: 'text',
    text: 'inspect\n\n<ae_mcp_attachments version="1">\n'
      + '{"files":[/* every attachment in order */]}\n'
      + '</ae_mcp_attachments>',
  },
  { type: 'localImage', path: '/tmp/frame.png' },
  { type: 'localAudio', path: '/tmp/audio.wav' },
]
```

Use advisory `mediaType` only to select the app-server's image/audio native
shape. The app-server's `mention` item is for `app://` and `plugin://`
references, not arbitrary local files, so every attachment also appears in
the manifest and no filesystem path is serialized as a `mention`. Assert
`turn/started` emits
`{type:'turn-accepted', turnId, transport:'codex-app-server'}` exactly once
before normal streaming.

- [ ] **Step 2: Write failing OpenCode file-part tests**

The message body must contain:

```js
{
  parts: [
    { type: 'text', text: 'inspect' },
    {
      type: 'file',
      mime: 'application/pdf',
      filename: 'notes.pdf',
      url: 'file:///tmp/notes.pdf',
    },
  ],
}
```

This matches OpenCode's official `FilePartInput` fields. Emit
`turn-accepted` only after the message POST succeeds.

- [ ] **Step 3: Write failing ZCode manifest tests**

Assert `session/send.params.content` contains the original text followed by
one manifest with every attachment in order. Assert the user transcript remains
the original text. Resolve `session/send` with `{accepted:true}` and require:

```js
{ type: 'turn-accepted', turnId: 'turn-1', transport: 'zcode-manifest' }
```

- [ ] **Step 4: Write failing BYOK rejection tests**

Assert that a text-only turn still behaves exactly as before. For any non-empty
attachment list, assert:

```js
{
  type: 'error',
  kind: 'attachment',
  code: 'ATTACHMENT_SIDECAR_REQUIRED',
  message: 'Restore the Claude Agent SDK sidecar to send local files.',
  turnId: 'turn-1',
}
```

The Anthropic HTTP function must not be called and no user history entry may be
added. The error uses `dispatchState: 'not-started'`.

- [ ] **Step 5: Run adapter tests and verify they fail**

Run:

```bash
cd plugin/panel
node --test test/codexBackend.test.js test/openCodeBackend.test.js test/zcodeBackend.test.js test/agentLoop.test.js
```

Expected: FAIL on string-only serialization and the missing acceptance event.

- [ ] **Step 6: Implement Codex mapping**

Store `activeTurnId` and the full normalized turn. Replace `turnParams(text)`
with `turnParams(turn, textWithPreamble)`. Build one text item containing the
user text plus an attachment manifest whenever attachments are present, append
native image/audio items in attachment order, and keep the preamble confined
to the text item.

Never place a local path in emitted events or transcript messages.

Track whether `rpc.request('turn/start', ...)` has been issued. Initialization,
profile, and thread failures before that call are `not-started`; a rejection or
disconnect after the call but before `turn/started` is `uncertain`. Both error
forms retain the matching `turnId`.

- [ ] **Step 7: Implement OpenCode mapping**

Use the official file part shape:

```js
function openCodeParts(turn, platformId) {
  return [
    ...(turn.text ? [{ type: 'text', text: turn.text }] : []),
    ...turn.attachments.map((file) => ({
      type: 'file',
      mime: file.mediaType || 'application/octet-stream',
      filename: file.name,
      url: attachmentFileUrl(file.localPath, platformId),
    })),
  ];
}
```

Emit acceptance after the HTTP request resolves successfully, before waiting
for the SSE terminal state. A fetch failure after the POST begins and before
its response is `uncertain`; failures while starting the local server/session
before the POST are `not-started`. Both error forms retain the matching
`turnId`.

- [ ] **Step 8: Implement ZCode mapping**

Build `turnText` from the unchanged user text plus
`withAttachmentManifest`. Preserve the existing first-turn server-instruction
preamble outside the generated attachment envelope.

Await or chain the `session/send` acceptance promise so rejection remains
classified correctly and success emits `turn-accepted` with the matching id.
Session creation/subscription failures are `not-started`; a `session/send`
failure before its acceptance response is `uncertain`. Both error forms retain
the matching `turnId`.

- [ ] **Step 9: Implement legacy BYOK rejection**

Normalize the turn before mutating `messages` or emitting `turn-start`. If it
contains attachments, emit the structured error and return without calling
the provider or changing history.

For text-only input, preserve current string compatibility and event order.

- [ ] **Step 10: Run focused adapter tests**

Run:

```bash
cd plugin/panel
node --test test/codexBackend.test.js test/openCodeBackend.test.js test/zcodeBackend.test.js test/agentLoop.test.js
```

Expected: PASS.

- [ ] **Step 11: Commit the non-Claude adapter mappings**

```bash
git add plugin/panel/src/cep/codexBackend.js plugin/panel/src/cep/openCodeBackend.js plugin/panel/src/cep/zcodeBackend.js plugin/panel/src/lib/agentLoop.js plugin/panel/test/codexBackend.test.js plugin/panel/test/openCodeBackend.test.js plugin/panel/test/zcodeBackend.test.js plugin/panel/test/agentLoop.test.js
git commit -m "feat(panel): expose files to chat backends"
```

---

### Task 6: Give Claude Agent SDK scoped access to selected files

**Files:**
- Modify: `plugin/panel/src/cep/claudeAgentBackend.js`
- Modify: `plugin/sidecar/lib.mjs`
- Modify: `plugin/panel/test/claudeAgentBackend.test.js`
- Modify: `plugin/sidecar/test/sidecar.test.js`

**Interfaces:**
- Consumes: normalized `TurnInput` from the Panel
- Panel-to-sidecar message:
  `{t:"user", turnId, text, attachments, permissionMode, model, effort?, thinking?}`
- Produces: scoped Claude `Read` permission for exact selected real paths
- Produces: `{type:"turn-accepted", turnId, transport:"claude-agent-sdk"}`

- [ ] **Step 1: Write failing Panel-to-sidecar tests**

Assert the sidecar stdin message contains all attachment references and no
extra content transformation:

```js
{
  t: 'user',
  turnId: 'turn-1',
  text: 'inspect',
  attachments: [{
    id: 'att-1',
    name: 'notes.pdf',
    localPath: '/tmp/notes.pdf',
    size: 12,
    mediaType: 'application/pdf',
    temporary: false,
  }],
  permissionMode: 'manual',
  model: 'claude-test',
}
```

The Panel backend must not emit the attachment paths in any event or stderr
summary.

- [ ] **Step 2: Write failing sidecar permission tests**

Inject filesystem/path dependencies so the tests are platform-neutral. Cover:

```js
test('Read is allowed only for an exact selected attachment path', async () => {
  const query = captureQuery();
  const sidecar = makeSidecar({ queryFn: query.fn, realpath: (p) => p });
  sidecar.handleLine(JSON.stringify(userWithAttachment('/tmp/notes.pdf')));
  await query.started;
  assert.deepEqual(
    await query.options.canUseTool('Read', { file_path: '/tmp/notes.pdf' }),
    { behavior: 'allow', updatedInput: { file_path: '/tmp/notes.pdf' } },
  );
  assert.equal(
    (await query.options.canUseTool('Read', { file_path: '/tmp/other.pdf' })).behavior,
    'deny',
  );
});
```

Also deny a directory, traversal alias, symlink resolving outside the selected
real path, missing `file_path`, `Write`, `Edit`, `Bash`, and every other
non-`mcp__ae__` tool.

- [ ] **Step 3: Run Claude tests and verify they fail**

Run:

```bash
cd plugin/panel
node --test test/claudeAgentBackend.test.js
cd ../sidecar
node --test test/sidecar.test.js
```

Expected: FAIL because the sidecar only accepts text and denies `Read`.

- [ ] **Step 4: Forward the normalized turn to the sidecar**

`claudeAgentBackend.sendUser` must:

1. normalize before starting;
2. retain `turnId`;
3. write the exact attachments array only after the ready handshake;
4. keep transcript storage limited to user text and display metadata;
5. add current attachment paths to redaction values for all errors and stderr
   summaries during the turn.

- [ ] **Step 5: Normalize and canonicalize selected paths in the sidecar**

At turn start:

- require each attachment path to be absolute;
- call injected/default `realpathSync`;
- require `statSync(realPath).isFile()`;
- store the exact real paths in the turn;
- build the model prompt with `withAttachmentManifest`;
- never emit the prompt or manifest.

If any path cannot be canonicalized, emit a pre-dispatch attachment error with
the `turnId`, `dispatchState: 'not-started'`, and do not invoke `queryFn`.

- [ ] **Step 6: Add the exact-path Read allowance**

For turns with attachments:

- include `Read` in `queryOptions.allowedTools`;
- include `Read` in the `ae` agent tool list;
- keep `Read` absent on text-only turns;
- in `canUseTool`, canonicalize `input.file_path`;
- allow only an exact member of the current turn's selected-real-path set;
- deny directories and every non-member without opening an approval card.

All existing AE MCP approval behavior remains unchanged.

Extend the Claude agent prompt with one narrow rule: `Read` may be used only
for exact paths listed in the current `<ae_mcp_attachments>` manifest. Do not
generalize the prompt to arbitrary filesystem exploration.

- [ ] **Step 7: Emit acceptance and redact path-bearing errors**

Emit `turn-accepted` immediately before `queryFn` begins consuming the accepted
turn. Include only `turnId` and `transport`.

Replace every selected real path in sidecar error text with
`[attachment-path]` before emitting the error.

- [ ] **Step 8: Run Panel and sidecar focused tests**

Run:

```bash
cd plugin/panel
node --test test/claudeAgentBackend.test.js
cd ../sidecar
node --test test/sidecar.test.js
```

Expected: PASS.

- [ ] **Step 9: Commit Claude scoped attachment access**

```bash
git add plugin/panel/src/cep/claudeAgentBackend.js plugin/sidecar/lib.mjs plugin/panel/test/claudeAgentBackend.test.js plugin/sidecar/test/sidecar.test.js
git commit -m "feat(sidecar): expose selected attachments to Claude"
```

---

### Task 7: Close cross-layer tests, prove the guard, build, and run real-host HDEV

**Files:**
- Modify: `plugin/panel/test/backends-contract.test.js`
- Modify: `plugin/panel/test/noSensitiveDefaults.test.js`
- Modify: `docs/superpowers/specs/2026-07-28-multimodal-file-input-design.md`
- Create after validation: `docs/checkpoints/2026-07-28-multimodal-file-input-hdev.md`

**Interfaces:**
- Consumes all preceding tasks
- Produces mutation evidence, automated regression evidence, built CEP assets,
  and non-candidate real-host development evidence

- [ ] **Step 1: Add the dynamic cross-backend invariant**

Enumerate `BACKENDS` rather than hardcoding only the four implementation files:

```js
test('every registered backend has a truthful attachment disposition', () => {
  assert.equal(assertAttachmentBackendRegistry(BACKENDS), true);
});
```

Add a source registry used by tests to associate the supported rows with their
factories:

```js
{
  subscription: createClaudeAgentBackend,
  'claude-api': createClaudeAgentBackend,
  byok: createAgentLoop,
  codex: createCodexBackend,
  opencode: createOpenCodeBackend,
  zcode: createZcodeBackend,
}
```

For every non-reject row, require a shared fixture to reach one
`turn-accepted` event with the original turn id. For `byok`, require the exact
pre-dispatch rejection.

- [ ] **Step 2: Add sensitive-data regressions**

Use a sentinel absolute path such as
`/private/attachment-secret/customer.mov`. Assert it is absent from:

- transcript entries;
- `reduceEvent` output;
- Panel diagnostic/log helpers;
- sidecar stderr tail;
- structured error events;
- exported log text.

The path may appear only in captured transport requests inside adapter unit
tests.

- [ ] **Step 3: Run the full lower test tiers**

Reuse dependency caches; do not reinstall the native runtime.

Run:

```bash
cd plugin/panel
npm test
npm run build
cd ../sidecar
npm test
cd ../..
node --test scripts/package/test/*.test.mjs
node scripts/check-repository-governance.mjs
```

Expected: all commands pass and `plugin/client/dist/app.js` plus
`plugin/client/dist/app.css` build successfully.

- [ ] **Step 4: Perform an explicit production-code mutation proof**

Temporarily remove `attachmentTransport: 'native+manifest'` from the Codex registry row
using `apply_patch`. Run:

```bash
cd plugin/panel
node --test test/backends-contract.test.js
```

Expected: FAIL naming Codex's missing attachment transport while unrelated
contract tests remain green.

Restore the exact line with `apply_patch`, rerun the same command, and require
PASS. Do not commit the mutation.

- [ ] **Step 5: Review the complete diff before AE**

Verify:

- no parser, converter, upload endpoint, video slicer, or MIME allowlist was
  introduced;
- only the internal legacy `byok` backend rejects attachments;
- every supported backend carries all attachment refs in order;
- absolute paths occur only inside scoped store/transport code and tests;
- no native, Core, public MCP, protocol, release, #67, or #69 files changed;
- the root checkout remains untouched.

- [ ] **Step 6: Sync only changed Panel and sidecar development components**

Use the repository's current HDEV component-sync command from
`scripts/hardware/README.md`. Reuse unchanged Core, native plug-in, helper, Node,
and provider installations. Record:

- branch and commit;
- changed component receipts;
- panel/sidecar version and modification times;
- `candidateEvidence=false`;
- `validationClass=HDEV`.

Do not perform a clean environment install, release audit, T5, or T6.

- [ ] **Step 7: Prepare one disposable attachment fixture set**

Create, outside tracked source and outside Adobe scan roots:

- `note.txt`;
- `image.png`;
- `document.pdf`;
- a short `video.mp4`;
- `unknown.payload`.

Record lifecycle `ephemeral-validation`, the file count, and a cleanup
condition. Do not retain file contents in the PR or checkpoint.

- [ ] **Step 8: Run focused real AE/CEP validation through both built-in backends**

In the actual AE panel:

1. add files using picker, drag/drop, and paste across the fixture set;
2. remove and re-add one item;
3. send an attachment-only turn;
4. send a text-plus-attachment turn;
5. verify each built-in backend receives all filenames in order:
   Codex and Claude Agent SDK;
6. record native versus manifest transport for each;
7. on one native multimodal backend, ask it to use the image or video through
   its own capability;
8. switch away from and back to Chat before one send and confirm the draft is
   retained;
9. force one pre-dispatch failure and confirm the complete draft remains;
10. simulate or capture one request-sent/pre-acceptance transport interruption,
    confirm the turn becomes uncertain, and confirm the UI offers no blind
    resend;
11. confirm no absolute attachment path appears in exported Panel logs.

This is non-candidate development evidence. It is not packaged-release
acceptance.

- [ ] **Step 9: Verify cleanup**

Remove the draft and end the test sessions. Confirm:

- all application-created temporary files are gone;
- original fixture files remain byte-for-byte unchanged;
- no attachment file exists in tracked source;
- `.aep` counts are unchanged because this feature does not create a project.

- [ ] **Step 10: Write the redacted HDEV checkpoint**

Create `docs/checkpoints/2026-07-28-multimodal-file-input-hdev.md` containing:

- tested commit;
- `candidateEvidence=false`;
- `validationClass=HDEV`;
- automated test/build totals;
- per-backend attachment count and transport kind;
- pre-dispatch draft-retention result;
- log-redaction result;
- temporary/original cleanup counts;
- explicit statement that T5/T6 were not run;
- no credentials, absolute local paths, prompts containing private data, or
  fixture contents.

Update the design status to “Implemented; non-candidate HDEV verified” only if
both built-in backend checks passed.

- [ ] **Step 11: Run final verification**

Run:

```bash
git diff --check origin/main...HEAD
git status --short
cd plugin/panel
npm test
npm run build
cd ../sidecar
npm test
cd ../..
node scripts/check-repository-governance.mjs
```

Expected: clean diff check, only intentional tracked changes, all tests/build
green, governance green.

- [ ] **Step 12: Commit validation evidence**

```bash
git add plugin/panel/test/backends-contract.test.js plugin/panel/test/noSensitiveDefaults.test.js docs/superpowers/specs/2026-07-28-multimodal-file-input-design.md docs/checkpoints/2026-07-28-multimodal-file-input-hdev.md
git commit -m "test(panel): verify multimodal attachment delivery"
```

- [ ] **Step 13: Request concentrated review**

Review specifically:

- exact selected-path authorization in Claude;
- no cleanup path can escape the managed root;
- no absolute path reaches logs or transcript;
- every backend emits one correctly correlated acceptance event;
- internal legacy BYOK fails before dispatch and is not a live Provider
  fallback;
- FilePond introduces no format allowlist or upload endpoint;
- existing Composer resize and keyboard behavior remains intact.

Do not merge until the review has no unresolved blocker and CI is green.
