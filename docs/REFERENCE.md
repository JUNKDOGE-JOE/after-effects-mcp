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
| ExtendScript | `ae_exec` |
| Native AEGP | `ae_nativeExec` |
| Preview and validation | `ae_previewFrame`, `ae_validateExpressions` |
| Checkpoints and recovery | `ae_checkpoint`, `ae_revert` |
| Screen capture | `ae_snapshot` |
| Skills | `ae_skillList`, `ae_skillUse` |
| Tool Library | `ae_toolSearch`, `ae_toolUse` |
| Diagnostics | `ae_ping`, `ae_status`, `ae_diagnose` |

`ae_exec` is the default route for maintained scripting semantics. Use
`ae_nativeExec` for the frozen native primitives. Native writes require an
operation key and Undo group, followed by an independent readback. A result
that may have dispatched a write must be reconciled against After Effects
state and audit evidence before retrying.

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
