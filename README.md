# ae-mcp

**Agent-driven After Effects automation.** ae-mcp is the desktop MCP server half of an integrated AE-agent product:

- the **AEBMethod** AE plugin (`E:/Code/AEBMethod`, our own C++ AEGP plugin) gives us a foothold inside AE
- this repo's **ae-mcp** server speaks the [Model Context Protocol](https://modelcontextprotocol.io) so Codex / Cursor / Claude Code / Continue / any other MCP client can drive AE through 24 verbs

The two halves work together. We own and ship both. Think of ae-mcp + AEBMethod as one product, like Atom — but under our own brand.

## Status

**Pre-1.0** (`0.1.0`) — public verb surface stable; internal architecture may still evolve before 1.0.

## Architecture

```
MCP client (Claude Code / Cursor / Codex / ...)
        │  stdio JSON-RPC 2.0
        ▼
┌─────────────────────────────────────────────────────────┐
│  ae-mcp  (this repo)                                    │
│  ┌─────────────────┐    ┌──────────────────────────┐    │
│  │  core           │    │  backend-aebm            │    │
│  │  (24 handlers,  │ ── │  (bridge to our          │    │
│  │   JSX, schemas) │    │   AEBMethod plugin)      │    │
│  └─────────────────┘    └──────────────────────────┘    │
│  ┌─────────────────┐                                    │
│  │  snapshot-mss   │  cross-platform PNG capture        │
│  └─────────────────┘                                    │
└─────────────────────────────────────────────────────────┘
        │  pwsh subprocess + file queue
        ▼
AEBMethod.aex  (our AE plugin, separate repo: E:/Code/AEBMethod)
        │
        ▼
After Effects (ExtendScript runtime)
```

The internal `Backend` ABC in `core/backends/` is an architectural seam, not a third-party plugin point. We don't advertise pluggable backends as a product feature.

## Verb surface (24)

| Category | Verbs |
|---|---|
| Project | `ae.init`, `ae.overview`, `ae.layers`, `ae.readProps`, `ae.searchProject` |
| Mutation | `ae.exec`, `ae.applyEffect`, `ae.createLayer`, `ae.setProperty`, `ae.moveLayer`, `ae.selectLayers`, `ae.setTime` |
| Read-typed | `ae.getTime`, `ae.getProperties`, `ae.scanPropertyTree`, `ae.inspectPropertyCapabilities`, `ae.getExpressions`, `ae.getKeyframes` |
| Checkpoint | `ae.checkpoint` (create/list), `ae.revert` |
| Diagnostic | `ae.ping`, `ae.snapshot` |
| AEBMethod-plugin features | `ae.isolateToggle`, `ae.toastQuery` |

## Install (end user)

```powershell
# Both halves are managed in this monorepo:
git clone <this-repo>
cd after-effects-mcp
python -m uv sync --group dev

# AEBMethod plugin checkout (separate repo) needs to live somewhere:
$env:AE_BRIDGE_ROOT = "E:/Code/AEBMethod"
$env:AE_MCP_BACKEND = "aebm"
```

Then point your MCP client at `python -m ae_mcp` (see `.mcp.json.template`).

## Configure your MCP client

```json
{
  "mcpServers": {
    "ae": {
      "command": "python",
      "args": [
        "-m", "uv", "run",
        "--directory", "<PATH_TO_THIS_REPO>",
        "python", "-m", "ae_mcp"
      ],
      "env": {
        "AE_MCP_BACKEND": "aebm",
        "AE_BRIDGE_ROOT": "<PATH_TO_AEBMethod_CHECKOUT>"
      }
    }
  }
}
```

Restart your MCP client. `/mcp` (or equivalent) lists 24 `ae.*` tools.

## Develop

```powershell
git clone <this-repo>
cd after-effects-mcp
python -m uv sync --group dev
python -m uv run pytest -m "not live and not live_smoke" -v
```

Unit tests: 130 cases across `packages/{core,backend-aebm,snapshot-mss}/tests/`.

## Live tests

End-to-end against a real AE instance + the AEBMethod plugin loaded:

```powershell
$env:AE_MCP_LIVE_TESTS = "1"
$env:AE_MCP_BACKEND    = "aebm"
$env:AE_BRIDGE_ROOT    = "<PATH_TO_AEBMethod_CHECKOUT>"
python -m uv run pytest -m live_smoke      # 3-case canary, ~30s
python -m uv run pytest -m live            # full ~10 cases, ~2-3min
```

CI does not run live tests (hosted runners cannot drive a GUI Adobe app).

## Migrating from `after-effects-mcp` v0.7

See [MIGRATION.md](MIGRATION.md).

## License

MIT.
