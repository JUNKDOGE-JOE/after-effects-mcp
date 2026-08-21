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
