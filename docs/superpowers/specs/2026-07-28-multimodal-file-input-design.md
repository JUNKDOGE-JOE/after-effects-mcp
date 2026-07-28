# Multimodal File Input Design

**Date:** 2026-07-28

**Issue:** #113 (file input slice)

**Status:** User-approved design

## Outcome

Let a user attach local files to a chat turn from the After Effects CEP panel
and expose those files to the selected model through every existing chat
backend: Codex, Claude, OpenCode, and ZCode.

The panel does not decide how a model should understand a file. It does not
extract document text, parse PDFs, convert Office files, transcode media,
sample video frames, or maintain a model-format routing table. It supplies a
stable file reference and lets the backend and model use their native
multimodal or agentic file capabilities.

The Composer remains backend-neutral. A missing attachment mapping is an
adapter defect to repair, not a reason to permanently disable attachments for
one backend.

The four supported attachment backends are Codex, Claude through the Agent SDK
sidecar, OpenCode, and ZCode. The registry also contains an internal legacy
`byok` HTTP fallback used only when the Claude sidecar cannot run. That direct
HTTP loop has neither local filesystem access nor a portable provider upload
contract, so it cannot truthfully expose arbitrary local files. In that
degraded state the Composer remains visible, but an attachment turn fails
before dispatch with guidance to restore the Claude sidecar. It never drops
the files, sends a path the remote model cannot read, or claims attachment
support.

## Current behavior

The Composer accepts only text. `ChatScreen` owns one text draft and calls the
application with a string. The application appends that text to the transcript
and calls `activeBackend.sendUser(text)`.

All four backends therefore expose text-only submission contracts:

- Codex sends one `text` item to `turn/start`.
- Claude sends a string through the sidecar to the Agent SDK.
- OpenCode sends one text part to the session message endpoint.
- ZCode sends string content to `session/send`.

The provider codec already understands some image content blocks, and model
probing preserves provider input modalities, but the panel submission path
never creates or forwards attachments.

## Scope

### Included

- A FilePond-powered attachment surface in the existing Composer.
- File selection, multi-select, drag-and-drop, clipboard file paste, compact
  preview, progress, and per-item removal.
- Arbitrary regular files without an extension or MIME allowlist.
- Image thumbnails using FilePond's existing image preview support.
- Generic name-and-size cards for all other files.
- Text-plus-file and attachment-only turns.
- One backend-neutral turn contract consumed by Codex, Claude, OpenCode, and
  ZCode.
- Native attachment or file-resource transport where a backend provides it.
- An application-generated attachment manifest where a backend has no generic
  file item, so the agent still receives readable file references.
- A scoped local-file read allowance for the Claude Agent SDK that can open
  only paths present in the current user-selected attachment set.
- Session-scoped attachment drafts and deterministic cleanup of
  application-created temporary files.
- Explicit pre-dispatch, accepted, and uncertain-dispatch behavior.
- Automated cross-backend contract tests and focused real-host development
  validation.

### Explicit non-goals

- Parsing, summarizing, indexing, embedding, OCR, transcription, or other
  interpretation inside the panel.
- Extracting text from PDF, Office, spreadsheet, archive, text, or code files.
- Generating video thumbnails, sampling video frames, transcoding video or
  audio, or deciding when a model should use native vision.
- A file-extension or MIME allowlist that duplicates model/provider support
  tables.
- A cloud upload manager, durable media library, or provider-specific file
  store.
- Portable arbitrary-file support for the internal legacy `byok` direct-HTTP
  fallback. It remains text-only and fails attachment turns before dispatch.
- Directory attachment in this slice.
- Downloading a remote URL supplied as an attachment.
- Changing the public AE MCP surface, AEGP behavior, project state, or Undo.
- Packaged-release T5/T6 evidence. This standalone panel feature uses the
  ordinary development validation path.

## Open-source boundary

Use FilePond and its React adapter rather than implementing picker, drag/drop,
paste, item state, progress, and removal behavior from scratch.

The initial dependency set is:

- `filepond`
- `react-filepond`
- `filepond-plugin-image-preview`

Type validation is not enabled as an acceptance gate. FilePond is the
interaction and pending-file state layer, not the authority for what a model
can consume. The dependency versions are pinned by the Panel lockfile and their
licenses are recorded through the repository's existing dependency process.

Application-owned code is deliberately thin:

1. translate a FilePond item into an application attachment reference;
2. keep the reference stable until the turn finishes;
3. map the common turn into each backend's transport;
4. redact logs and clean temporary files.

It does not duplicate FilePond's upload-widget behavior or introduce a custom
content-processing framework.

## Common turn contract

Replace the text-only backend boundary with a structured turn:

```ts
type TurnInput = {
  text: string;
  attachments: AttachmentRef[];
};

type AttachmentRef = {
  id: string;
  name: string;
  localPath: string;
  size: number;
  mediaType?: string;
  temporary: boolean;
};
```

`mediaType` is advisory metadata. It may help a backend select its native
transport shape, but it does not permit or reject the file.

The contract invariants are:

- attachment order is preserved;
- `name` is the user-visible filename;
- `localPath` is readable for the lifetime of the dispatched turn;
- the ordinary transcript stores display metadata, not the absolute path;
- logs never include file contents or absolute paths;
- text may be empty only when at least one attachment exists;
- every active backend accepts the same `TurnInput` shape.

## File exposure and staging

Prefer a stable original local path when the CEP host exposes one and the
selected backend process can read it. Do not copy a large video merely to
produce a second path. If a path is valid in CEP but inaccessible to the
backend's sandbox or session, expose it through the same managed staging root
used for pathless input.

Some inputs, especially clipboard blobs, have no durable source path. Those
items are streamed to an application-managed, session-scoped attachment
directory. The application returns a stable `AttachmentRef` only after the
temporary file is fully written.

The staging layer:

- stores no parsed or derived representation;
- uses an opaque attachment ID rather than the original path as its UI key;
- writes atomically so a backend never observes a partial file;
- distinguishes user-owned originals from application-owned temporary copies;
- deletes only files marked `temporary`;
- retains a dispatched temporary file until the backend turn reaches a
  terminal state or the session is explicitly discarded.

Removing an attachment, discarding a draft, or closing its session cleans the
associated temporary copy. It never deletes, moves, renames, or modifies a
user-owned original.

## Backend mapping

`backend.sendUser(turnInput)` becomes the common submission boundary. Each
adapter receives the complete attachment list.

### Native transport

When the installed backend protocol provides a structured local attachment,
file part, image/audio item, mounted file, or equivalent resource reference,
the adapter maps `AttachmentRef` into that native shape.

The adapter may use advisory media metadata required by that protocol, but it
does not parse or transform the file.

### Manifest transport

When a protocol version has no generic local-file field, the adapter adds a
machine-generated attachment manifest to the model-facing request. The
manifest is separate from the user-visible transcript text and includes the
stable readable path and display metadata required for the agent to open the
file with its tools.

For a protocol that exposes only one string content field, “separate” is a
logical application boundary: the adapter encodes a delimited manifest beside
the user text in the model-facing request, while the draft and transcript keep
only the original user text. The generated envelope is adapter-owned and is
never echoed into the visible message or logs.

This fallback is still file exposure, not content processing. It must not:

- replace the user's visible message with a filename;
- silently omit an attachment;
- claim native multimodal delivery when only a readable path was supplied;
- log the generated manifest.

Codex, Claude Agent SDK, OpenCode, and ZCode must all implement either native
transport or manifest transport. The Composer never branches on backend
identity. The application backend boundary, rather than the Composer,
classifies the internal `byok` fallback as unavailable for attachment turns.

## Composer interaction

The existing Composer gains an attachment button and an attachment area above
the text editor.

- The button opens a multi-file picker.
- The complete Composer accepts dropped files.
- Pasting files while the editor is focused adds them without replacing text.
- Images use FilePond's thumbnail support.
- Other files show a generic icon, filename, size, state, and remove action.
- The send button is enabled when non-whitespace text or at least one ready
  attachment exists.
- Attachments that are still staging show progress; the turn cannot be sent
  until every included item is ready.
- A failed item is marked in place and can be removed or retried without
  deleting successful items.

The attachment surface does not change existing Composer resize behavior:

- Enter sends.
- Shift+Enter inserts a newline.
- Shift+ArrowUp and Shift+ArrowDown resize only when the resize handle's focus
  carrier owns the keyboard event.
- Pointer resizing, compact-panel clamping, option chips, send/stop, and
  streaming behavior remain intact.

## Draft and send lifecycle

Text and pending attachments belong to the same per-session draft. Switching
sessions preserves each session's draft independently.

On send:

1. verify that every attachment is ready and readable;
2. freeze one immutable `TurnInput` snapshot;
3. submit that snapshot to the selected backend;
4. clear the Composer only after the backend emits its existing or newly
   normalized “turn accepted” event.

Turn acceptance is distinct from assistant completion. The backend boundary
must expose acceptance as soon as the remote/local session has created the
turn, while token streaming and terminal completion continue through their
existing event path. A backend that returns only at terminal completion needs
its adapter contract normalized; the Composer must not stay populated for the
entire assistant response.

If submission fails before dispatch, the complete text and attachment draft is
retained.

If the connection fails after dispatch and acceptance is uncertain, the panel
does not automatically resubmit. It preserves enough state to reconcile the
backend session and avoids creating a duplicate model turn.

Once accepted, the user message in the transcript displays attachment names
and sizes but not absolute paths. Temporary attachments remain available until
the backend turn is terminal, then become eligible for cleanup.

## Resource protection

Resource controls protect the panel rather than define model capabilities:

- at most 32 attachments per turn;
- stable path-backed files are passed by reference and are not loaded into
  panel memory or rejected by an application-level file-size allowlist;
- a pathless clipboard blob is limited to 256 MiB per item and 512 MiB per
  turn because it must be materialized by the application;
- non-image files and large media do not receive generated previews;
- backend or provider size failures are reported as their actual errors rather
  than copied into a Composer support table.

These limits are named configuration constants and produce actionable UI
errors.

## Error handling and observability

The panel distinguishes these outcomes:

- **staging failure:** the file never became a valid attachment; keep the rest
  of the draft;
- **pre-dispatch failure:** the backend did not accept the turn; retain the
  complete draft;
- **accepted:** the backend owns the turn; clear the Composer and show the
  attachment metadata in the transcript;
- **uncertain dispatch:** do not retry automatically; reconcile session state;
- **backend rejection:** show the backend's real error without silently
  converting or dropping files.

The UI says that files were attached or delivered, never that the model read,
understood, or correctly interpreted them.

Diagnostics may record:

- attachment IDs;
- attachment count;
- byte sizes;
- temporary/original ownership;
- staging and dispatch dispositions;
- backend and transport kind.

Diagnostics must not record:

- file contents;
- absolute local paths;
- generated attachment manifests;
- provider credentials or signed upload URLs.

## Validation strategy

### UI and lifecycle tests

Focused Panel tests prove:

1. picker, drag/drop, and clipboard input produce the same attachment model;
2. image and unknown-extension files are both accepted;
3. image preview and generic file cards render correctly;
4. removal cleans only application-owned temporary files;
5. attachment-only turns can be sent;
6. text and attachments remain paired when switching sessions;
7. staging and pre-dispatch failures preserve the draft;
8. accepted turns clear the draft exactly once;
9. uncertain dispatch does not trigger automatic resubmission;
10. existing Enter, Shift+Enter, resize, chip, send, stop, and streaming
    behavior remains unchanged.

### Cross-backend contract tests

Run the same `TurnInput` vector through Codex, Claude, OpenCode, and ZCode.
Assert for every adapter that:

- all attachments are present in order;
- names, sizes, and readable references survive serialization;
- the adapter selects an implemented native or manifest transport;
- attachment metadata reaches the backend request without changing the
  user-visible text;
- redacted diagnostics contain no contents or absolute paths.

Add a dynamic invariant that enumerates the registered chat backends and
requires every one to declare either an implemented attachment mapping or the
explicit legacy-HTTP pre-dispatch rejection. The four supported attachment
backends must use a real mapping; only the internal `byok` fallback may use the
rejection disposition. Prove the guard by mutation: remove one supported
backend's mapping, observe the test fail, restore it, and observe the test
pass.

### Real-host development validation

Reuse the installed development dependencies and the current real AE/CEP
environment. Do not rebuild or reinstall unchanged components, and do not run
packaged-release T5/T6.

Use one application-owned temporary fixture set containing:

- a text file;
- an image;
- a PDF;
- a short video;
- a file with an unknown extension.

For each of Codex, Claude, OpenCode, and ZCode:

1. attach the same fixture set from the real Composer;
2. send the smallest prompt that asks the model to list the files it can see;
3. verify the backend accepted every attachment and the model-facing request
   contains every reference;
4. record whether delivery used a native attachment or the agent-readable
   manifest;
5. do not require the model to parse every file as proof of transport.

On at least one configured backend with native multimodal support, ask the
model to use an image or video through its own supported mechanism. This proves
the panel did not prevent native multimodal behavior without making the panel
responsible for interpreting the media.

Finally remove the drafts and close the test sessions. Verify that
application-created temporary files are gone and the fixture originals remain
unchanged.

## Done criteria

This slice is complete when:

- the Composer exposes FilePond-backed file selection, drop, paste, preview,
  removal, and attachment-only send;
- every registered backend accepts the same structured turn and exposes all
  files to the model;
- no application format allowlist, parser, converter, or video slicer exists;
- draft retention, uncertain dispatch, redacted diagnostics, and temporary
  cleanup behave as specified;
- the mutation-proven cross-backend invariant passes;
- focused Panel tests and required repository checks pass;
- the real AE panel verifies file exposure through all four configured
  backends using reused development dependencies;
- the resulting PR documents any backend that used a native attachment versus
  a manifest, without claiming that transport alone proves model
  understanding.
