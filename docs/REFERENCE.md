# Reference

## Local MCP service

The installed CEP panel starts the host service on:

```text
http://127.0.0.1:11488/mcp
```

The endpoint is intended for clients on the same machine as After Effects.
The host is a Node process. Stdio-only clients normally use the published
`ae-mcp-jkdg` connector; the installed extension also ships the same
dependency-free bridge as `host/stdio-shim.js`.

## Supported client setup

Claude Code:

```bash
claude mcp add --transport http ae http://127.0.0.1:11488/mcp
```

Stdio-only clients such as Claude Desktop:

```json
{
  "mcpServers": {
    "ae": {
      "command": "npx",
      "args": ["-y", "ae-mcp-jkdg"]
    }
  }
}
```

Installed-extension shim alternative:

```json
{
  "mcpServers": {
    "ae": {
      "command": "node",
      "args": ["<installed-extension>/host/stdio-shim.js"],
      "env": { "AE_MCP_HTTP_URL": "http://127.0.0.1:11488/mcp" }
    }
  }
}
```

## Public tools

The CEP host advertises exactly 16 tools:

| Area | Tools |
|---|---|
| Status | `ae_status` |
| ExtendScript | `ae_exec`, `ae_execRecover` |
| Structured reads | `ae_read` |
| Native AEGP | `ae_nativeExec` |
| Preview and validation | `ae_previewFrame`, `ae_validateExpressions` |
| Checkpoints and recovery | `ae_checkpoint`, `ae_revert` |
| Skills | `ae_skillUse` |
| Tool Library | `ae_toolSearch`, `ae_toolUse`, `ae_toolSave` |
| Instances and work contexts | `ae_instances`, `ae_workspace`, `ae_readJob` |

`ae_exec` is the default route for maintained scripting semantics. Use
`ae_nativeExec` for the frozen native primitives. Native writes require an
operation key and Undo group, followed by an independent readback.
`undo.available` means AEGP opened and closed a real After Effects Undo group
with StartUndoGroup/EndUndoGroup; the response envelope does not certify that
Undo restores state. Release discipline proves restoration separately through
an explicit Undo and state readback. A result that may have dispatched a write
must be reconciled against After Effects state and audit evidence before retrying.

### Native connection diagnosis

`ae_status({"depth":"status"})` and `depth="ping"` are passive. Before the
lazy native client has connected, `nativeExecutionPlane.available=false` does
not establish that the native plug-in failed to load. Use
`ae_status({"depth":"diagnose"})` for a bounded, read-only native handshake.
It does not dispatch native project operations or modify the project or Undo
stack. Diagnose reports `probeAttempted`, the resulting connection `state`,
and a typed `error` when the probe fails; AE responsiveness is reported
separately. An unsuccessful connection attempt is cleared on timeout so the
next diagnose or native operation can retry. This applies to Windows named
pipes and macOS Unix sockets. See [validation evidence](validation/issue392-native.md).

### Tool Library lifecycle

Successful `ae_exec` and `ae_execRecover` calls add `artifactId` to their
execution envelope after best-effort capture. Captured JSX starts as a hidden,
exact-id-rerunnable `candidate`; `ae_toolSave` promotes it or creates a new
`jsx`/`prompt-skill` artifact. `ae_toolUse` replays JSX, while `ae_skillUse`
lists and renders saved/pinned prompt-skills. User-library usage updates
`useCount` and `lastUsedAt`.

Candidates expire after 7 days and are capped at 20 per conversation and 200
globally. Saved/pinned artifacts can be exported and imported from the panel's
Tools page. See [Tool Library](TOOL_LIBRARY.md) for schemas, state transitions,
placeholder protection, host routes, and bundled generation.

### `ae_exec` failure recovery

`ae_exec` accepts only a new script and requires `code`. Recovery is a separate
`ae_execRecover` call requiring the exact six-character `recoveryId` returned
by a dispatched `ae_exec` failure. Its optional `retryMode` is either `restore`
(the default) or `continue`; corrected inline `code` is also optional.

After a dispatched failure, the tool returns the original failure plus an
absolute editable `scriptPath`, `recoveryId`, `attempt`, checkpoint identity
when available, `errorLine`, the trimmed failing line as `errorSource`, captured
`$.writeln` lines, project revision before/after, and bounded `touched` evidence.
`touched.level` is `layer_diff` when layers were added, removed, or changed;
`item_diff` when only project items changed; otherwise it is `none`.
`layersChanged` reports flattened fields such as `transform.opacity`, while
`layersAdded`, `layersRemoved`, `itemsAdded`, and `itemsRemoved` identify graph
changes. Snapshots inspect at most 500 project items and 200 layers, and report
at most 50 changed layers with 20 changed fields per layer. `truncated` signals
that a limit was reached. Attribution uses before/after snapshots because AE
host methods are not exposed through interceptable JavaScript prototypes.
Failures before dispatch, including argument or approval rejection, do not
create recovery files.

Edit `scriptPath` and call `ae_execRecover({"recoveryId":"..."})`, or provide
the corrected script inline as `code`. By default the host restores the
checkpoint created by the failed call before executing the corrected script. A
`checkpoint_label` must have successfully created that restore point. Without
one, retry is automatic only when the recorded project revision did not
change; otherwise the caller must explicitly choose `retryMode:"continue"` or
revert to another checkpoint first. Continue mode deliberately runs against
the current failed state.

Recovery scripts and metadata live only under
`~/.ae-mcp/checkpoints/<project-key>/recovery/`; they are never written beside
the `.aep`. The legacy HTTP `/exec` route does not enable diagnostics and keeps
its existing request and response shape.

### `ae_previewFrame` visual verification

Project calls also accept `context_id` from `ae_workspace`. A direct panel connection can
bind its local conversation; the generic multi-instance stdio entry requires an explicit
context and never assumes a globally active AE. Project writes have one owner per host.
Live and snapshot previews retain the `CompItem.saveFrameToPng` capture path. Its PNG
output may omit Guide Layers that are visible in the AE viewer. This is an accepted
limitation; the original Guide pixel checks remain recorded as FAIL rather than being
rewritten as PASS. The tool does not promise an exact image of the viewer.

Capture does not automatically change `guideLayer`, `enabled`, or other layer visibility
states. Users or models prepare any required project state explicitly before previewing,
using the normal write context when an edit is needed. Setting `enabled=true` alone does
not guarantee that a layer with `guideLayer=true` will appear in the PNG. A missing Guide
in the image therefore does not prove that the layer is disabled or deleted.

There is no guide-layer override or Render Queue fallback. The unimplemented native
Guide probe and OS window-capture proposals have been withdrawn; the frozen native
primitive set remains unchanged.

### Local instances and project contexts

`ae_instances` supports `list`, `start` and `stop`. Starting requires an existing
absolute `project_path` and an absolute task `work_dir`. It returns a starting instance;
registration and a real AE read are required before considering it ready. `stop` is an
explicit operation: finish active turns and reconcile outstanding writes first;
`save_policy` defaults to `refuse-dirty`.
Closing the panel is intentional disconnection, not a reason to start another AE.

`ae_workspace` supports `bind`, `inspect`, `release`, `transfer` and `reconcile`:

- Bind by `instance_id` or `project_path`, with `access: "read"` or `"write"` and `work_dir`.
- `access: "write"` grants write eligibility, not a permanent lock. A panel conversation
  owns its local project throughout a streaming turn. External MCP clients own it only
  while an AE call is executing; their model text streams are not visible to MCP.
  The next eligible context takes idle ownership automatically, without a takeover prompt.
  An explicitly read-only context stays read-only until an explicit write binding/transfer.
- Pass the returned `context_id` to subsequent AE calls, including when chats share a connection.
- Transfer remains available to grant an existing context write eligibility. It no longer
  forces a separate manual takeover approval. Existing write-operation approval policy remains.
  Queued/in-flight calls, a still-active turn, bridge draining or an uncertain result
  prevent takeover. Stop/error UI alone is not termination: the provider must confirm its
  turn ended or its owned process exited. Old completion events cannot release a newer turn.
- `inspect` reports `active_turn` and `draining` separately from `has_writer`. An idle
  write-capable context may therefore have `has_writer: false`. An open SSE connection is
  not an active turn. Cross-instance forwarded calls use call-level ownership at the target.
- Release relinquishes that context without closing AE. Another connection does not automatically inherit it.
- After an uncertain write, inspect actual state with `ae_read` or `ae_previewFrame`.
  An observation made while the result is uncertain returns `observation_id`.
  Only after verifying that state, call reconcile with that observation and `confirm: true`.
  The host rejects observations from another context or an AE revision that has changed again.

The stdio connector without an explicit URL discovers the installed extension's instance
entry. `--url` / `AE_MCP_HTTP_URL` retains direct endpoint forwarding. HTTP clients require
an already running local entry; cloud/remote access is not added. MCP initialization and
tool listing do not wait for AE to start. The extension must already be installed; the
connector does not install or update it. A host with only the old connector remains direct-only.

### Snapshot reads and checkpoint continuation

Checkpoints first save the original project, then copy it without changing the open path.
For a bound workspace, an existing sibling `Adobe After Effects Auto-Save` directory takes
precedence; otherwise `work_dir` is required. The destination is
`ae-mcp/checkpoints/<project-key>/` under the chosen directory. This does not parse Adobe's
custom auto-save preference. Checkpoint metadata keeps the actual path; old checkpoints
remain readable in the old layout. MCP does not prune Adobe's auto-save files.

If an `ae_exec` checkpoint fails in a bound context, the edit is not dispatched. To continue
without that checkpoint, obtain explicit user permission and repeat the unchanged operation
with `checkpoint_continue: {failure_id: <checkpoint_failure_id>, confirm: true}`.
The confirmation is single-use and tied to the context and operation. A panel continuation
uses its approval UI. An uncertain save/copy must be reconciled first. Continuing does not
create a usable snapshot or retroactively mark the backup successful.

`ae_readJob` consumes an existing `checkpoint_id`:

```json
{"action":"submit","context_id":"<binding>","checkpoint_id":"<checkpoint>","requests":[{"id":"overview","tool":"ae_read","arguments":{"target":"comps"}},{"id":"frame","tool":"ae_previewFrame","arguments":{"comp_id":"123","time":0}}]}
```

Use `status`, `result` or `cancel` with `context_id` and `job_id`. Result pages use `offset`
and `limit`; at most one preview item's budgeted image content is attached per page,
identified by `image_request_id`. Use `limit: 1` to inspect each preview separately.
Requests are limited to maintained `ae_read` and `ae_previewFrame` operations. Select a
composition explicitly, and supply preview times; arbitrary JSX and caller-selected
preview output paths are not accepted. All results identify their source checkpoint and
are marked as snapshot results, never current live state. Cancellation stops later dispatch;
an executing synchronous AE script is not claimed to have stopped. Unconfirmed worker
shutdown is reported as indeterminate and retains its working snapshot.
Worker admission shares a two-worker limit across hosts and checks free RAM before starting:
the initial estimate allows 1 GiB per starting worker while leaving 2 GiB free. These are
admission estimates, not OS memory caps; real-AE measurements are required to tune them.

### Frame capture and comparison

`ae_previewFrame` uses After Effects `CompItem.saveFrameToPng` and performs all
PNG decoding, scaling, contact-sheet composition, and comparison in the CEP
host with no browser canvas or image-library dependency. RGB and RGBA source
frames from 16 bpc projects are decoded in the host and replace their source
file as an 8-bit PNG before any requested scaling or composition. It supports
three forms:

- A single `time` or `times` array returns the existing per-frame MCP image
  content and `structuredContent.frames` records. Separate output accepts at
  most 8 times.
- `range:{start,end,count}` samples evenly spaced times including both
  endpoints (2–8 for separate output, or up to 16 with `layout:'grid'`). A grid
  returns one labeled contact-sheet image;
  `grid_max_side` is 256–2048 and defaults to 1280. `structuredContent.grid`
  reports the final path, dimensions, digest, rows, columns, cell dimensions,
  scaling flag, and final pixel coordinates for every frame.
- `compare:{a,b,mode,threshold}` compares two `{time}` selectors or previously
  returned `{capture_id,index}` frames. `mode` is `diff`, `side-by-side`, or
  `both` (default); `threshold` is 0–255 (default 8). The result includes the
  selected frame identities, `changedRatio`, `changedPixels`, `totalPixels`,
  `meanAbsDiff`, `maxAbsDiff`, changed-region `bbox`, artifact paths, and a
  scaling flag. Frame B is resampled to Frame A dimensions when necessary and
  that fact is reported in metrics and warnings. Metrics, including `bbox`,
  always use Frame A's original pixel coordinates even when `scaled:true`
  means the heatmap or side-by-side image itself was reduced.

`range` is mutually exclusive with `time` and `times`. `compare` is a
comparison-only call and is mutually exclusive with `time`, `times`, `range`,
and `layout`. The process keeps the most recent 50 successful capture records;
a referenced PNG must still match its recorded SHA-256 or the comparison fails.
Grid, diff, and side-by-side output is bounded to a 2048-pixel long side (or the
smaller `grid_max_side` for grids). Existing `comp_id`, `out_dir`,
`scale`, and `repaint_delay_ms` behavior is unchanged, and `frames` contains
every newly captured frame even when the call returns a single derived image.

All image content blocks and optional `include_base64` frame copies share a
12 MiB base64-character budget, with a 4.5 MiB limit for each image. The host
reduces inline copies in 0.75 steps down to a 256-pixel minimum edge and reports
`budgetScale`, inline dimensions, and warnings without modifying the file named
by `path`. If a frame still cannot fit, its full-resolution 8-bit `path` remains
available, `frame.base64` is omitted, and the image content block becomes a
thumbnail whose long side is at most 512 pixels. Thus `path`, `sizeBytes`, and
`sha256` always describe the full-resolution 8-bit disk file, while inline
fields describe any response-budget reduction.

On the first preview call in a host process, the default preview root removes
`.png` files older than seven days from other session directories. If all
session PNGs still exceed 300 MiB, it deletes the oldest eligible files until
the total is at or below that limit. The current process session is never
deleted, and only empty directories are removed afterward.

## Host response shape

Successful MCP calls return the standard JSON-RPC result through the `/mcp`
endpoint. Errors include a stable error code and a human-readable message.
The panel log export records host status, request identifiers, and bounded
diagnostic tails; credentials and access tokens are redacted.

### Panel chat error codes

The built-in claude, codex, and opencode chat channels use the same stable
category vocabulary. The error card shows the code, a localized action hint,
and a collapsed redacted detail block when process, RPC, HTTP, resolution, or
stderr evidence is available.

| Code | Meaning | Common action |
|---|---|---|
| `CLI_MISSING` | The selected CLI could not be resolved. | Install it or make its executable visible on the panel PATH. |
| `CLI_TOO_OLD` | The resolved CLI is below the supported version. | Upgrade the CLI and re-check the channel. |
| `CLI_ARCH_MISMATCH` | The resolved executable does not match the AE host architecture. | Install the matching x64 or arm64 build. |
| `CLI_PROBE_FAILED` | The executable was found but its version/start probe failed. | Run the CLI version command in a terminal and inspect Diagnostics. |
| `SPAWN_FAILED` | The OS refused or could not create the CLI process. | Check the path, execute permission, and security software. |
| `PROCESS_EXITED` | A running CLI process exited unexpectedly. | Expand the exit/signal and stderr detail. |
| `AUTH_REQUIRED` | The CLI or upstream requires login or credentials. | Complete that CLI's login flow and re-check. |
| `MCP_UNREACHABLE` | The channel could not prepare or reach the conversation MCP server. | Keep the panel host running and inspect the MCP diagnostic row. |
| `AE_MCP_TRANSPORT_REBUILT` | The OpenCode connection to the AE host was rebuilt after an uncertain transport failure, and the turn was stopped without replay. | Confirm that no write remains unresolved before resending the turn. |
| `SESSION_START_FAILED` | A Codex thread or OpenCode session was not created. | Repair the channel, then retry; the turn was not dispatched. |
| `TURN_START_FAILED` | Starting or posting a turn failed. | Check `dispatchState` before retrying because dispatch may be uncertain. |
| `RPC_TIMEOUT` | A Codex app-server RPC method timed out. | Inspect the method detail and check the CLI process/network. |
| `UPSTREAM_HTTP_<status>` | An upstream service returned a three-digit HTTP status. `401`/`403` are authentication failures. | Use the numeric status to check login, quota, model access, or relay health. |
| `UPSTREAM_ERROR` | The model/upstream failed without a usable HTTP status. | Check model availability and provider service status. |
| `UPSTREAM_CONNECTION_CLOSED` | The upstream connection closed while it was returning an error. The turn is not retried automatically. | Send the next message; it starts a fresh session. Check the channel process if it repeats. |
| `EVENT_STREAM_FAILED` | The OpenCode SSE event stream disconnected. | Check the OpenCode process and local network. |
| `PROVIDER_STREAM_STALLED` | The provider stream was silent for more than five minutes and the turn was stopped. | Check relay or proxy connectivity, then retry. |
| `TURN_INPUT_INVALID` | The turn or one of its attachments is invalid/unavailable. | Re-select or remove the unavailable attachment. |
| `TURN_ABORTED` | The user stopped the active turn. | Confirm no write remains unresolved before resending. |
| `CANCELLED` | The backend cancelled, canceled, or interrupted the request. | Confirm the session is still usable, then retry. |
| `TRANSPORT_UNCERTAIN` | The transport cannot prove whether dispatch completed. | Inspect AE state before any retry. |
| `BACKEND_UNAVAILABLE` | No usable chat backend is selected. | Enable an available channel in Settings. |
| `BACKEND_ERROR` | A backend failure did not match a more specific category. | Expand details and attach an exported diagnostics bundle. |

Settings → Export log writes the last 50 structured chat failures under
`## backend errors (last 50, memory + disk)`, per-line-cleaned process output under
`## backend stderr tails`, and persisted chat events in both host-log sections.
These sections are complementary: the category is the routing handle, while
the process/RPC detail and host timeline provide the failure context.

## Development files

The maintained source boundaries are:

- `plugin/panel`: CEP UI and client-side orchestration.
- `plugin/host`: Node host, `/mcp`, `/exec`, and the stdio bridge.
- `plugin/shared`: panel-shared approval and attachment modules.
- `plugin/jsx`: ExtendScript templates.
- `native/ae-plugin`: the frozen native AEGP implementation.

The generated native protocol catalog and bundled skills are shipped with the
host. The Adobe SDK remains a local developer input and is never part of the
extension payload.

## Persistent state

The default state root is `~/.ae-mcp`. `AE_MCP_STATE_DIR` overrides the whole
root; `AE_MCP_HOME` remains a compatibility fallback. Fine-grained overrides
are `AE_MCP_LOG_DIR`, `AE_MCP_TOOL_DIR`, and `AE_MCP_SKILL_DIR`. Host
checkpoints, recovery files, blocked-client state, logs, tools, legacy skills,
and Tool Library exports derive from the selected root. Panel conversation
history continues to use the panel platform path `~/.ae-mcp/sessions`. Host
tests must inject a temporary root instead of using the developer's real state.

Other environment variables the host and panel read:

| Variable | Effect |
|---|---|
| `AE_MCP_CHECKPOINT_KEEP` | Number of `.aep` checkpoints retained per project (default 50, minimum 1). |
| `AE_MCP_CLAUDE_CLI`, `AE_MCP_CODEX_CLI` | Explicit executable path for the Claude or Codex CLI when it is not on the panel PATH. Restart After Effects after setting them. |
| `AE_MCP_APPROVAL_TIER_FILE` | Path to a file holding `readonly`, `manual`, `auto`, or `none`. When set, the host enforces that tier on the verb tools for an embedding UI; when unset the gate is a no-op and the connecting client's own permission system applies. |

The host includes ExtendScript guardrails in the default server instructions
for panel conversations and external MCP clients. Settings no longer offers
an expert-guidance switch: changing that preference could not reliably change
instructions already received by a model. The old panel preference and
`AE_MCP_EXPERT_GUIDANCE` environment variable have no effect. Bundled skills
remain available through `ae_skillUse`.
