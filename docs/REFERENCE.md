# Reference

## Local MCP service

The installed CEP panel starts the host service on:

```text
http://127.0.0.1:11488/mcp
```

The endpoint is intended for clients on the same machine as After Effects.
The host is a Node process and the shipped Claude Desktop bridge is
`host/stdio-shim.js`; it runs with the system Node executable and has no
additional package install step.

## Supported client setup

Claude Code:

```bash
claude mcp add --transport http ae http://127.0.0.1:11488/mcp
```

Claude Desktop:

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

| Area | Tools |
|---|---|
| Status | `ae_status` |
| ExtendScript | `ae_exec` |
| Structured reads | `ae_read` |
| Native AEGP | `ae_nativeExec` |
| Preview and validation | `ae_previewFrame`, `ae_validateExpressions` |
| Checkpoints and recovery | `ae_checkpoint`, `ae_revert` |
| Skills | `ae_skillUse` |
| Tool Library | `ae_toolSearch`, `ae_toolUse` |

`ae_exec` is the default route for maintained scripting semantics. Use
`ae_nativeExec` for the frozen native primitives. Native writes require an
operation key and Undo group, followed by an independent readback. A result
that may have dispatched a write must be reconciled against After Effects
state and audit evidence before retrying.

### `ae_exec` failure recovery

`ae_exec` accepts either new `code` or a six-character `recoveryId`. The input
schema intentionally does not use a top-level JSON Schema combinator; the host
validates the two forms at call time. `retryMode` is valid only with a
`recoveryId` and is either `restore` (the default) or `continue`.

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

Edit `scriptPath` and call `ae_exec({"recoveryId":"..."})`, or provide the
corrected script inline as `code`. By default the host restores the checkpoint
created by the failed call before executing the corrected script. A
`checkpoint_label` must have successfully created that restore point. Without
one, retry is automatic only when the recorded project revision did not
change; otherwise the caller must explicitly choose `retryMode:"continue"` or
revert to another checkpoint first. Continue mode deliberately runs against
the current failed state.

Recovery scripts and metadata live only under
`~/.ae-mcp/checkpoints/<project-key>/recovery/`; they are never written beside
the `.aep`. The legacy HTTP `/exec` route does not enable diagnostics and keeps
its existing request and response shape.

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
| `EVENT_STREAM_FAILED` | The OpenCode SSE event stream disconnected. | Check the OpenCode process and local network. |
| `TURN_INPUT_INVALID` | The turn or one of its attachments is invalid/unavailable. | Re-select or remove the unavailable attachment. |
| `TURN_ABORTED` | The user stopped the active turn. | Confirm no write remains unresolved before resending. |
| `CANCELLED` | The backend cancelled, canceled, or interrupted the request. | Confirm the session is still usable, then retry. |
| `TRANSPORT_UNCERTAIN` | The transport cannot prove whether dispatch completed. | Inspect AE state before any retry. |
| `BACKEND_UNAVAILABLE` | No usable chat backend is selected. | Enable an available channel in Settings. |
| `BACKEND_ERROR` | A backend failure did not match a more specific category. | Expand details and attach an exported diagnostics bundle. |

Settings → Export log writes the last 50 structured chat failures under
`## backend errors (last 50)`, per-line-cleaned process output under
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
