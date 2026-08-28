# Tool Library developer guide

The Tool Library is the persistent workflow layer inside the CEP host. It
captures successful JSX, replays exact content, promotes useful work into named
artifacts, distributes saved artifacts, and records whether the library is
actually used. The implementation lives in `plugin/host/mcp/`; it does not use
the retired Python server.

## Public MCP surface

The host advertises exactly 13 tools, in this order:

| Tool | Responsibility |
| --- | --- |
| `ae_status` | Read host status, ping the same-process host, or diagnose AE responsiveness. |
| `ae_exec` | Run a new ExtendScript and return recovery information for dispatched failures. |
| `ae_execRecover` | Retry one failed `ae_exec` by its exact server-issued recovery id. |
| `ae_previewFrame` | Read real composition pixels, sample a range, or compare two frames. |
| `ae_read` | Read a paginated, sortable, filterable AE state view without mutation. |
| `ae_checkpoint` | Create or list `.aep` checkpoints for the current saved project. |
| `ae_revert` | Restore a checkpoint by id. |
| `ae_validateExpressions` | Force-evaluate expressions and report errors. |
| `ae_nativeExec` | Run a bounded program of the 23 frozen AEGP primitives. |
| `ae_toolSearch` | List or search saved tools, or inspect any artifact by exact id. |
| `ae_toolUse` | Render and replay a JSX artifact by id. |
| `ae_toolSave` | Create, update, promote, or change the status of a user artifact. |
| `ae_skillUse` | List, render, or execute skills, including saved prompt-skills. |

The registry order and definitions come from `plugin/host/mcp/tools.js` and
`plugin/host/mcp/tools/*.js`. Documentation and tests should derive the count
from that registry rather than carrying a second hard-coded list.

## Artifact model

A persisted artifact has `schemaVersion: 1`, a `user:<uuid>` id, display
metadata, source provenance, content, an argument schema, a content hash,
revision timestamps, and usage fields. `contentHash` is SHA-256 over the kind,
content, and normalized `argsSchema`; changing content or arguments changes the
approval identity.

The store accepts these schema kinds: `jsx`, `expression`, `prompt-skill`,
`recipe`, `diagnostic`, and `system-command`. The public `ae_toolSave.create`
contract intentionally creates only `jsx` and `prompt-skill`:

- `jsx` is executable through `ae_toolUse`; successful chat execution can also
  capture it automatically.
- `prompt-skill` is created directly with `ae_toolSave`. It has no capture
  phase, appears in `ae_skillUse` when saved or pinned, and is render-only.
  Calling it with `execute:true` returns an explicit error.

Artifact status is one of `candidate`, `saved`, `pinned`, `archived`, or
`deprecated`:

- `candidate` is an automatically captured, rerunnable JSX draft. It is hidden
  from the default list and text search but remains addressable by exact id.
- `saved` is the normal discoverable state.
- `pinned` is discoverable and carries an explicit keep signal.
- `archived` is retained but omitted from normal discovery.
- `deprecated` is retained as a non-discoverable compatibility record.

`ae_toolSave` never changes an artifact back to `candidate`. Bundled artifacts
(`builtin:skill:*`) and legacy skill-directory artifacts (`legacy:*`) are
read-only. A user write increments `revision`, updates `updatedAt`, recomputes
the content hash, runs the secret scanner, and refuses the save if the artifact
changed while its approval card was waiting.

### Usage fields

User and imported artifacts start with `useCount: 0` and `lastUsedAt: null`.
Older stored artifacts without `useCount` normalize to zero. A successful
`ae_toolUse`, or a successful render/use of a library-backed skill through
`ae_skillUse`, increments `useCount` and records `lastUsedAt`. Bundled and
legacy virtual artifacts are not rewritten for usage accounting.

The activity log separately records funnel events. `ae_toolUse` records
`operation: "use"`; `ae_skillUse` records `render` or `use`; `ae_toolSave`
records `promote`, `create`, `update`, or `status`, always with the artifact id.

## Capture, replay, and promotion

On every successful `ae_exec` or `ae_execRecover`, the host attempts a
best-effort capture:

1. Compute the JSX content hash with an empty argument schema.
2. If the same content already exists as saved or pinned, return that id.
3. Otherwise create a `candidate`, or refresh the matching candidate's
   `updatedAt` instead of duplicating it.
4. Add `artifactId` to the successful execution envelope.
5. Prune old and excess candidates. Capture or pruning failures never change
   the AE execution result.

Candidate cleanup is deterministic:

| Boundary | Limit |
| --- | ---: |
| Time to live | 7 days since `updatedAt` |
| Per conversation | 20 newest candidates |
| Global | 200 newest candidates |

The intended model workflow is:

```text
ae_toolSearch -> ae_toolUse -> ae_toolSave
search first     replay exact   keep a useful candidate or script
```

`ae_toolSearch {}` and query search return only saved/pinned artifacts.
`ae_toolSearch {"name":"user:..."}` inspects an exact candidate or saved
artifact. `ae_toolUse` requires that exact artifact id and optional template
arguments. Its plan hash binds the artifact id, content hash, normalized
arguments, target, dependency hashes, and risk across approval and dispatch.

`ae_toolSave` has four modes:

- `{"name":"user:..."}` promotes a candidate to saved.
- `{"name":"user:...","newName":"...","description":"...","tags":[]}`
  promotes with metadata changes.
- `{"create":{"name":"...","description":"...","kind":"jsx|prompt-skill","content":"...","argsSchema":{},"tags":[]}}`
  creates a saved artifact by default.
- `{"name":"user:...","content":"..."}` updates an existing non-candidate;
  `status` changes it to saved, pinned, archived, or deprecated.

Candidate promotion may change only name, description, tags, and status; it
cannot silently replace the captured content or argument schema.

## Placeholder guard and circuit breaker

`ae_exec` and `ae_execRecover` reject history-redaction placeholders before
dispatch. Detection has two layers:

- exact markers for the known “omitted from prior model history” and “hidden
  from history to save tokens” forms;
- a bounded heuristic requiring both a placeholder-like shape and a redaction
  word family plus a history/token/context word family.

The first rejection explains that the value is not runnable code and lists up
to five recent candidates, preferring the current conversation. It includes the
exact `ae_toolUse {"name":"<artifactId>"}` escape path. From the second
consecutive rejection in the same MCP session, the circuit breaker switches to
a shorter message with the streak count and one recovery direction. A real
execution attempt resets the streak. Rejections record
`verdict: "placeholder_rejected"`, tool, client, streak, character count, and
a 200-character whitespace-normalized script head in the activity log.

For `ae_execRecover`, omitting `code` reruns the stored recovery script. A
placeholder must never be used to overwrite that file.

## Panel management and host routes

The management surface belongs on the panel's **Tools page**. It presents
candidate and retained artifact lists and exposes promote, pin, archive,
restore, delete, clear-candidates, import, and export actions. This is the
target location shared with issue #350; developer docs should not direct users
to Settings for Tool Library management.

The panel calls these host routes:

| Method | Route | Action |
| --- | --- | --- |
| `GET` | `/tool-library` | Return candidates and saved/pinned/archived managed artifacts. |
| `POST` | `/tool-library/promote` | Change a candidate to saved. |
| `POST` | `/tool-library/pin` | Pin a candidate or saved artifact. |
| `POST` | `/tool-library/archive` | Archive a saved or pinned artifact. |
| `POST` | `/tool-library/restore` | Restore an archived artifact to saved. |
| `DELETE` | `/tool-library/:id` | Delete a candidate or archived artifact. |
| `POST` | `/tool-library/clear-candidates` | Delete every candidate. |
| `POST` | `/tool-library/export` | Write one saved/pinned artifact to the export directory. |
| `POST` | `/tool-library/import` | Import one self-contained export wire. |

Every route uses the same shared loopback token header check as `/exec`. They
are panel-management routes, not additional MCP tools.

## Export, import, and bundled generation

Only saved or pinned user-library artifacts can be exported. The host writes a
self-contained schema-v1 JSON wire under `<state-root>/exports/` and returns
the absolute path. Bundled and legacy artifacts do not need exporting.

Import requires exactly `schemaVersion`, `exportedAt`, and `artifact`. It
validates the artifact content hash, scans the complete wire for secrets, and
deduplicates by kind plus content hash. A duplicate returns HTTP 409 with the
existing id. A successful import receives a new user id, source type
`imported`, `verified:false`, revision 1, reset usage fields, and saved status
(or pinned when the exported artifact was pinned).

The build-side generator converts an export wire or one saved artifact from a
state root into the bundled skill format and updates the bundled manifest hash.
Use exactly one input form:

```bash
node scripts/package/generate-bundled-skill.mjs \
  --input /absolute/path/to/export.json \
  --output-dir plugin/host/mcp/skills_bundled \
  --dry-run
```

```bash
AE_MCP_STATE_DIR=/absolute/path/to/state \
node scripts/package/generate-bundled-skill.mjs \
  --artifact-id user:00000000-0000-4000-8000-000000000000 \
  --output-dir plugin/host/mcp/skills_bundled \
  --dry-run
```

The `--artifact-id` form accepts only a saved artifact. Both forms accept only
`jsx` or `prompt-skill`, and the artifact name must match
`[A-Za-z0-9][A-Za-z0-9_-]{0,63}`. Inspect the JSON result from `--dry-run`, then
rerun without that flag to write `<name>.json` and update `manifest.json`.
Generated content still passes the secret scanner and manifest tests before it
can ship.

## State directories

The default state root is `~/.ae-mcp`. Path resolution uses this precedence:

1. An injected `stateDir` supplied by the host/test fixture.
2. `AE_MCP_STATE_DIR`.
3. Legacy compatibility fallback `AE_MCP_HOME`.
4. `~/.ae-mcp`.

Subdirectories default under that root, with optional fine-grained overrides:

| Data | Default | Override |
| --- | --- | --- |
| Logs | `<state-root>/logs` | `AE_MCP_LOG_DIR` |
| Tool Library | `<state-root>/tools` | `AE_MCP_TOOL_DIR` |
| Legacy user skills | `<state-root>/skills` | `AE_MCP_SKILL_DIR` |
| Checkpoints/recovery | `<state-root>/checkpoints` | none |
| Panel exports | `<state-root>/exports` | none |

Tests must inject a temporary `AE_MCP_STATE_DIR`; they must never read or write
the developer's real state root.
