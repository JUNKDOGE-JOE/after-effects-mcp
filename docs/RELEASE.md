# ae-mcp Release Checklist

## Package ZXP

Install Adobe `ZXPSignCmd`, then run:

```powershell
.\scripts\package-zxp.ps1 -ZxpSignCmd C:\Tools\ZXPSignCmd.exe
```

The script stages the CEP panel, runs `npm ci --omit=dev` for `plugin/host`, creates a self-signed certificate if needed, and writes `release/ae-mcp-panel.zxp`.

## Smoke

1. Install from a clean checkout or ZXP.
2. Restart After Effects.
3. Open `Window -> Extensions -> ae-mcp`.
4. Confirm the panel is green.
5. Configure the MCP client with `AE_MCP_BACKEND=ae-mcp` and the panel port.
6. Run `ae.ping`.
7. In a new comp, run `ae.previewFrame`.
8. Run `ae.createRig` with `rig_type=transform_controller`.
9. For any expression-bearing change, run `ae.validateExpressions` before visual review.

## Known Pre-Release Gaps

- `ae.previewFrame` is fast viewer capture, not a true render or precise comp crop.
- `ae.createRig` is an MVP and does not yet provide a bundled rig preset library.
- Skill storage is functional, but there is no panel UI for browsing/editing skills.
- The release package still needs a clean-machine install pass before a public release.

## Required Verification

```powershell
uv run pytest
```

Current expected non-live result: `152 passed, 20 deselected`.

With AE open and panel green:

```powershell
$env:AE_MCP_LIVE_TESTS = "1"
$env:AE_MCP_BACKEND = "ae-mcp"
$env:AE_MCP_PLUGIN_URL = "http://127.0.0.1:11488"
uv run pytest packages/core/tests/live -o addopts='' -vv
```

Current expected live result: `20 passed`.
