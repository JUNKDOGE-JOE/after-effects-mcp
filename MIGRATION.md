# Migration: `after-effects-mcp` v0.7 → `ae-mcp` 0.1

This project was renamed from `after-effects-mcp` to `ae-mcp` and reset
to **0.1.0** as part of becoming a standalone, plugin-agnostic product.

## Migration steps

```powershell
# 1) Uninstall the old package
pip uninstall after-effects-mcp

# 2) Install the new core + at least one backend
pip install ae-mcp ae-mcp-backend-aebm
pip install ae-mcp-snapshot-mss          # optional: enables ae.snapshot

# 3) Update your .mcp.json — see .mcp.json.template
#    - Server key:   "aebm" → "ae"
#    - Module:       "after_effects_mcp" → "ae_mcp"
#    - Env var:      AE_BRIDGE_ROOT alone → AE_MCP_BACKEND=aebm + AE_BRIDGE_ROOT
```

## What changed?

- **PyPI name:** `after-effects-mcp` → `ae-mcp`
- **Python module:** `after_effects_mcp` → `ae_mcp`
- **MCP server name:** `aebm` → `ae`
- **Backend selection:** add `AE_MCP_BACKEND` env var
- **Architecture:** core + reference backend impls in separate pip packages
- **Snapshot:** cross-platform via `ae-mcp-snapshot-mss` (optional)

## Tool surface
The same 24 verbs (`ae.init`, `ae.exec`, ..., `ae.searchProject`) work
exactly as before. `tools/list` may hide `ae.snapshot` if you didn't
install a snapshotter.

## What got better
- Pluggable: any AE plugin author can publish their own backend
- Cross-platform: macOS/Linux can now use `ae.snapshot`
- Decoupled: core has zero plugin-specific code
