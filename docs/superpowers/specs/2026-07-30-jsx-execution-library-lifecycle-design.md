# JSX Execution and Tool Library Lifecycle Design

**Date:** 2026-07-30

**Issue:** #82

**Status:** User-approved design

## Decision

Execution-level JSX and user-level reusable JSX are separate products:

```text
ae_exec
  -> execute the supplied source string
  -> return the execution result
  -> do not create or update a Tool Library artifact

user explicitly asks the model to save, or saves in the Tools panel
  -> create a saved JSX artifact
  -> assign stable identity, revision, and content hash
  -> expose it through the existing Tool Library discovery and execution flow

model judges that generated JSX may be useful again
  -> explicitly create a non-executable candidate artifact
  -> keep it outside default Tool Library discovery
  -> retain it until the user promotes or deletes it
```

The successful terminal result of `ae_exec` is not a persistence event. The
product does not materialize a `.jsx` file for that call, retain the source in a
hidden candidate, or infer persistence in the server. Persistence requires a
separate deliberate model tool call or an explicit Tools panel action.

The current Issue #82 archive and retention design is superseded by this
document. In particular, this package does not create an ephemeral archive,
retention daemon, quarantine store, or lifecycle policy engine.

## Problem

`ae_exec` already accepts complete JSX source and sends the string directly to
the selected AE backend. It does not need a durable `.jsx` file.

After a successful call, however, Core currently runs an independent history
capture path that copies the complete source into the Tool Library as a
`chat-tool-call` artifact with `candidate` status. The candidate is excluded
from the default saved-and-pinned index, but it is durable, can be selected by
candidate filters, and appears in the Tools panel's candidate view.

That behavior has two product problems:

1. a one-time execution silently becomes retained user data; and
2. execution-level JSX and deliberately reusable user tools share one lifecycle
   even though they have different ownership and discovery expectations.

The repository also contains the Tool Library mutation handlers and a complete
Tools panel editing surface, but those mutation handlers are not registered on
the current final public MCP surface. The panel still calls names such as
`ae_toolCreate` and `ae_toolEdit`, so the explicit user save path is not an
end-to-end product path on the current source revision.

## Outcomes

- A successful `ae_exec` call leaves Tool Library storage and store revision
  unchanged.
- A user can ask the model to save JSX as a reusable Tool Library artifact.
- A model can deliberately retain JSX as a candidate when it judges that the
  content may be useful again.
- A user can explicitly create, edit, archive, delete, duplicate, import,
  export, or promote Tool Library content from the existing Tools panel.
- A user-created JSX artifact enters the library as `saved`, with the existing
  stable user ID, revision, content hash, provenance, and execution rules.
- The model-facing public MCP tool list is unchanged.
- Existing Tool Library read, discovery, staged execution, audit, grant, and
  content-hash behavior is reused rather than reimplemented.
- Existing persisted candidates and other user data are preserved.

## Non-goals

- Creating an archive for one-time JSX.
- Retention by age, count, byte size, or oldest-first cleanup.
- Crash recovery, restart recovery, cleanup concurrency, file locking, or a
  generic lifecycle framework for execution-level JSX.
- Asking the user to classify every `ae_exec` call.
- Server-side persistence inferred from a successful or repeated execution.
- Automatically promoting a model-curated candidate to `saved`.
- Expiring or deleting candidates automatically.
- Adding a `save_as_tool` argument to `ae_exec`.
- Adding a new public tool name such as `ae_toolCreate` or `ae_toolSave`.
- Changing AEGP/JSX route selection or `ae_nativeExec`.
- Changing AE dispatch, checkpoint, Undo, timeout, or uncertain-write
  semantics.
- Deleting, migrating, or silently promoting existing Tool Library data.
- Changing maintained product-owned JSX templates or bundled skills.
- Adding system-command execution.

## Lifecycle Model

### Execution-level JSX

Execution-level JSX is the source string supplied to one `ae_exec` request.

It has:

- request lifetime only;
- no Tool Library artifact ID;
- no Tool Library status;
- no Tool Library revision;
- no Tool Library content record; and
- no promotion or cleanup lifecycle.

The request and result may still appear in the ordinary MCP or product audit
surfaces already applicable to `ae_exec`. This package removes only the
secondary Tool Library copy. It does not weaken the existing execution result,
checkpoint, Undo, timeout, or approval behavior.

### User-level reusable JSX

Reusable JSX begins when the user explicitly asks the model to save it or
performs an explicit Tools panel mutation. A newly created artifact uses the
existing Tool Library model:

- `kind = "jsx"`;
- `source.type = "user"` for a new user-requested artifact;
- `source.ref = "manual"` for panel creation or a model-request reference for
  model creation;
- `status = "saved"`;
- stable `user:<uuid>` identity;
- revision managed by the canonical store;
- content hash computed from kind, content, and argument schema; and
- existing declared-risk, verification, grant, and staged execution rules.

No new `ephemeral-jsx` or `reusable-jsx` discriminator is added. The lifecycle
is represented by whether a Tool Library artifact exists:

```text
no artifact -> execution-level JSX
saved user JSX artifact -> reusable user-level JSX
candidate chat-tool-call artifact -> model-curated temporary JSX
bundled/product source -> maintained product-owned JSX
```

This keeps the distinction observable without adding a parallel classification
schema. Promoting a candidate changes its status to `saved` while preserving
its original `chat-tool-call` source provenance.

### Model-curated candidate JSX

The model may decide that generated JSX is likely to be useful again even when
the user has not requested permanent retention. The model can then make a
separate Tool Library save call with `status = "candidate"`.

A model-curated candidate:

- uses the existing `chat-tool-call` source type and records model-curated
  intent in provenance;
- has stable identity, revision, and content hash;
- is excluded from default saved-and-pinned discovery;
- is visible only when candidate status is explicitly requested;
- cannot be rendered or executed through `ae_toolUse`;
- has no expiration time, retention deadline, or automatic cleanup; and
- remains until the user deletes it through the panel or requests promotion to
  `saved`.

The model must not create a candidate after every successful execution. The
candidate is an explicit model decision and therefore a separate tool call.

### Maintained JSX

Bundled templates, maintained adapters, and product-owned skills keep their
existing source and release lifecycle. They do not pass through execution
history capture and are outside the mutation scope of this package.

## Public MCP Boundary

The public Tool Library surface remains:

- `ae_toolIndex`
- `ae_toolSearch`
- `ae_toolInspect`
- `ae_toolUse`

The public `ae_exec` schema remains unchanged. No lifecycle or persistence
fields are added.

`ae_toolUse` gains one `save` action. This extends the existing Tool Library
surface without adding another public tool name.

Create shape:

```json
{
  "action": "save",
  "save": {
    "mode": "create",
    "intent": "user-requested",
    "status": "saved",
    "artifact": {
      "name": "Reusable JSX",
      "description": "What the script does",
      "kind": "jsx",
      "category": "workflow",
      "tags": [],
      "compatibility": {},
      "declared_risk": "write",
      "content": "JSON.stringify({ok:true});",
      "args_schema": {}
    }
  }
}
```

Promotion shape:

```json
{
  "action": "save",
  "save": {
    "mode": "promote",
    "intent": "user-requested",
    "status": "saved",
    "artifact_id": "user-or-chat-candidate-id",
    "expected_revision": 1,
    "expected_content_hash": "64-lowercase-hex-characters"
  }
}
```

Admission rules are narrow:

- `mode = "create"` requires the complete artifact draft and forbids existing
  artifact identity fields;
- `mode = "promote"` requires candidate identity plus revision/content-hash
  compare-and-swap fields and forbids a replacement draft;
- `intent = "model-curated"` may create only `status = "candidate"`;
- `intent = "user-requested"` may create `candidate` or `saved`;
- promotion always requires `intent = "user-requested"` and
  `status = "saved"`; and
- V1 accepts only `kind = "jsx"` through this model-facing save action.

The model-facing execution skill explains that ordinary `ae_exec` calls are
ephemeral, user-requested retention uses `saved`, model-judged possible reuse
uses `candidate`, and candidates are not executable until promoted.

The current final public registry, public schema registry, annotation registry,
backend-supported verb sets, generated tool listings, default execution skill,
and user-visible model instructions must not gain a new tool name.

## Panel-only Mutation Boundary

The existing panel needs mutations that models must not discover. Implement one
small private dispatch table separate from the public handler registry.

The table maps the panel's existing mutation names to the existing handler
functions through panel-only strict schemas for their current request shapes:

- `ae.toolCreate`
- `ae.toolEdit`
- `ae.toolDelete`
- `ae.toolArchive`
- `ae.toolDuplicate`
- `ae.toolPromoteFromHistory`
- `ae.toolImport`
- `ae.toolExport`

These names:

- are absent from `tools/list`;
- are absent from `FINAL_PUBLIC_TOOLS`, public `SCHEMAS`, public annotations,
  backend verb sets, and model instructions;
- are resolved only after the caller presents the panel capability already
  generated for the local panel/Core process; and
- return the same structured handler payloads the panel already expects.

The panel's `toolsApi` must use its existing `callPanelTool` path for mutation
operations. No second token, pairing ceremony, network service, or generalized
authorization framework is introduced.

An unauthenticated or ordinary MCP call to a panel-only name is treated as an
unknown tool. It must not expose the private schema or handler inventory.

Developer-mode access for the existing index/search/inspect operations remains
unchanged. The implementation may share the same capability extraction helper,
but it must not merge private mutation handlers into the public registry.

## Execution Capture Change

The server's successful-result path currently asks `extract_history_draft`
whether the call should create a Tool Library candidate. For `ae.exec`, the
answer becomes permanently `None`.

The narrow implementation may either:

1. remove the `ae.exec` branch from history draft extraction while retaining
   any independently justified non-JSX history capture; or
2. remove the unused capture layer if live registry analysis proves no
   remaining public operation consumes it.

The implementation must choose the smaller verified change. It must not widen
this package into an expression-history redesign.

Success or failure of Tool Library initialization must no longer affect or
follow a successful `ae_exec` result. A test must prove that a successful
execution does not resolve the default Tool Library service at all.

## Existing Data and Compatibility

Existing candidates, including earlier `chat-tool-call` candidates, are user
data and remain untouched. New model-curated candidates deliberately reuse the
same source type with explicit intent provenance.

- No startup migration deletes them.
- No background job archives or prunes them.
- Candidate filtering remains available for imported or historical content.
- Existing candidates may still be explicitly inspected, deleted, or promoted
  through the panel or promoted by the model after a user request.
- New `ae_exec` calls stop producing candidates automatically.

This is a forward behavior change, not a destructive data migration.

## Error Behavior

### `ae_exec`

Execution errors keep the current result contract. The absence of history
capture adds no new error and no new success field.

### Model save

`ae_toolUse action = "save"` is a separate Tool Library mutation. Its success
or failure does not change, reinterpret, or roll back any preceding
`ae_exec` result.

Malformed intent/status/mode combinations fail before store mutation. Store
validation, revision conflicts, content-hash conflicts, secret scanning, and
structured errors reuse the canonical Tool Library path.

### Panel mutation

Panel mutation handlers keep the existing Tool Library errors:

- validation errors for malformed artifacts;
- revision or content-hash conflicts for stale edits;
- not-found errors for missing artifacts;
- import conflict and package validation results; and
- structured store failures.

The panel continues to refresh after revision conflicts using its existing
state reducer. This package does not create an additional recovery workflow.

### Private dispatch

Missing or invalid panel capability returns the same unknown-tool behavior as
any other non-public name. Handler exceptions use the existing structured
Tool Library error conversion.

## User Flow

### One-time execution

1. The model or user sends complete source through `ae_exec`.
2. Core executes it through the current backend.
3. Core returns the current typed/JSON result.
4. Tool Library storage is not opened or modified.
5. The script does not appear in candidates, search, index, or Tools panel
   history.

### Explicit reusable tool

1. The user asks the model to save the JSX, or opens the Tools panel and chooses
   **New**.
2. The model calls public `ae_toolUse` with `action = "save"` and
   `intent = "user-requested"`, or the panel calls private `ae.toolCreate`.
3. The canonical Tool Library store creates a `saved` user artifact.
4. The caller reads back the new stable identity, revision, and content hash.
5. Future model discovery uses the existing
   `Index -> Search -> Inspect -> Use` flow.

### Model-curated temporary storage

1. The model determines that generated JSX may be useful again.
2. The model makes a separate `ae_toolUse action = "save"` call with
   `intent = "model-curated"` and `status = "candidate"`.
3. The canonical store creates a non-executable candidate.
4. Default Tool Library discovery remains unchanged.
5. The candidate remains until explicitly promoted or deleted.

### Historical candidate

1. The user deliberately selects the candidate filter.
2. The panel reads a pre-existing or imported candidate.
3. The user may delete it, promote it in the panel, or ask the model to promote
   it.
4. No automatic decision is made on the user's behalf.

## Acceptance Tests

### Core and server

- A successful `ae_exec` result does not call
  `default_tool_service`, create a candidate, or change Tool Library revision.
- A failed or non-terminal `ae_exec` result also creates no artifact.
- Repeated identical `ae_exec` calls create no candidate and no deduplication
  record.
- The public registry, schemas, annotations, and `tools/list` remain exactly
  unchanged in tool names.
- A valid user-requested save creates a `saved` JSX artifact through public
  `ae_toolUse`.
- A valid model-curated save creates a non-executable `candidate` excluded from
  default index/search and included only when candidate status is requested.
- Invalid save mode, intent, status, or payload combinations fail before any
  Tool Library mutation.
- A user-requested promotion changes the selected candidate to `saved` using
  the exact expected revision and content hash.
- A panel-only mutation name without the panel capability is unknown.
- A panel-only mutation with the real test capability validates against its
  private schema and reaches exactly one existing handler.
- A user JSX create returns `status = "saved"`, a `user:` ID, revision, and
  content hash, then appears through public `ae_toolIndex` and
  `ae_toolInspect`.
- Edit, archive, delete, and historical-candidate promotion preserve current
  compare-and-swap behavior.

### Panel

- `toolsApi` sends every mutation through `callPanelTool`.
- Ordinary index/search/inspect/use calls retain their current public paths.
- Creating a JSX artifact refreshes the list and selects the saved artifact.
- A mutation conflict remains visible and requests refresh through the current
  reducer behavior.
- No candidate is added after `ae_exec` unless a separate model save call is
  made.

### Regression

- Existing Tool Library store, execution, import/export, and panel state tests
  remain green.
- Public tool-name and Native EXEC generated-registry tests remain green.
- The generated panel bundle is rebuilt and checked in only when the source
  change affects it.

## Validation Level

This package changes Core persistence side effects and panel-to-Core mutation
wiring. It does not change JSX dispatched to AE, backend execution, AE project
state, Undo, AEGP, CEP/native communication, or visual output.

Required validation:

- T0 formatting and syntax;
- focused Core unit and server contract tests;
- focused panel API/state tests;
- affected Tool Library integration tests;
- generated bundle consistency; and
- focused CI for the frozen PR.

No real-AE HDEV, T4, T5, or T6 run is required unless implementation changes
the actual AE execution path contrary to this design.

## Review Classification

Only a defect reproduced in one of these paths is a P0 blocker:

- `ae_exec` still persists Tool Library content;
- user-requested model save cannot create a stable saved JSX artifact;
- model-curated save is exposed in default discovery or becomes executable;
- explicit Tools panel save cannot create a stable saved JSX artifact;
- a panel-only mutation becomes model-discoverable;
- private dispatch can reach a mutation without the existing panel capability;
  or
- the change breaks current Tool Library discovery or execution.

Archive retention, cleanup races, candidate expiry, restart census, generic
permission hardening, system-command expansion, and unrelated Tool Library
redesign are follow-up or out of scope. Review uses at most two concentrated
rounds unless a reproduced blocker changes the acceptance boundary.

## Delivery Boundary

This is one standalone product PR for Issue #82.

The package is complete when:

1. one-time `ae_exec` no longer persists;
2. user-requested model save and explicit panel creation both produce reusable
   saved JSX artifacts;
3. model-curated save produces a durable, non-default, non-executable
   candidate;
4. the public MCP tool-name surface is unchanged;
5. focused tests and CI pass;
6. concentrated review has no unresolved current-path blocker;
7. the PR is merged; and
8. Issue #82 is rewritten or closed with the superseded archive scope clearly
   recorded.

No `.aep` fixture is created or retained for this package.
