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

The CEP host advertises exactly 13 tools:

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

`ae_exec` is the default route for maintained scripting semantics. Use
`ae_nativeExec` for the frozen native primitives. Native writes require an
operation key and Undo group, followed by an independent readback.
`undo.available` means AEGP opened and closed a real After Effects Undo group
with StartUndoGroup/EndUndoGroup; the response envelope does not certify that
Undo restores state. Release discipline proves restoration separately through
an explicit Undo and state readback. A result that may have dispatched a write
must be reconciled against After Effects state and audit evidence before retrying.

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

`ae_previewFrame` uses After Effects `CompItem.saveFrameToPng` and performs all
PNG decoding, scaling, contact-sheet composition, and comparison in the CEP
host with no browser canvas or image-library dependency. It supports three
forms:

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
`include_base64`, `scale`, and `repaint_delay_ms` behavior is unchanged, and
`frames` contains every newly captured frame even when the call returns a
single derived image.

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

External MCP clients always receive the ExtendScript expert guardrails in the
server instructions; the expert-guidance switch in Settings applies to the
panel's own conversations.
