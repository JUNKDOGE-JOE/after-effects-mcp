# ae-mcp Install

ae-mcp uses the simple RPC path:

```text
MCP client -> Python ae-mcp -> HTTP 127.0.0.1:11488 -> CEP panel -> AE ExtendScript
```

## Developer Install

From the repo root:

```powershell
uv sync --all-packages --group dev
cd plugin\host
npm ci
cd ..\..
.\scripts\install-plugin-dev.ps1
```

Restart After Effects, then open `Window -> Extensions -> ae-mcp`. The panel should show a green status line with `Listening on 127.0.0.1:11488`.

## MCP Client Config

Use the block shown in the panel, or configure manually:

```json
{
  "ae": {
    "command": "python",
    "args": ["-m", "ae_mcp"],
    "env": {
      "AE_MCP_BACKEND": "ae-mcp",
      "AE_MCP_PLUGIN_URL": "http://127.0.0.1:11488"
    }
  }
}
```

Run `ae.ping` first. Then try `ae.previewFrame` and `ae.createRig` in a simple comp.

## Expected Smoke Result

With After Effects open and the panel green, the full local live suite should pass:

```powershell
$env:AE_MCP_LIVE_TESTS = "1"
$env:AE_MCP_BACKEND = "ae-mcp"
$env:AE_MCP_PLUGIN_URL = "http://127.0.0.1:11488"
uv run pytest packages/core/tests/live -o addopts='' -vv
```

Current expected result: `20 passed`.

## Troubleshooting

- Panel missing from the menu: rerun `scripts/install-plugin-dev.ps1`, then restart AE.
- Panel red: read the panel `Last error` line and log area.
- Port conflict: edit the port in the panel and update `AE_MCP_PLUGIN_URL` to match.
- `evalScript` timeouts: close AE modal dialogs, then restart AE if calls still hang.
- `ae.snapshot` is diagnostic desktop/window capture. `ae.previewFrame` is fast viewer capture, not a true render.
