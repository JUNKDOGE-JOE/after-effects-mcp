# ae-mcp

Backend-agnostic MCP (Model Context Protocol) server for Adobe After Effects automation.

Lets any MCP-aware client (Claude Code, Cursor, Codex, Continue, ...) drive After Effects through any compatible AE plugin. The MCP itself is a **pure protocol layer** — this repo contains zero plugin-specific code. Concrete backends and screenshot implementations live in *separate pip packages* discovered at runtime via Python entry points. To use this with a real AE plugin you must install at least one third-party (or your own) backend package.

## Status

**Pre-1.0** — backend interface may still evolve. Production use is fine; pin major versions in your requirements.

## Architecture

```
MCP client (Claude Code / Cursor / Codex / ...)
        |
        | stdio JSON-RPC
        v
ae-mcp                          (this package — protocol + JSX dispatch)
        |
        | abstract Backend.exec(code)
        v
[ Backend implementation (separate pip package) ]
        |
        | plugin-specific protocol
        v
After Effects + AE plugin
```

The server has 24 verbs (`ae.init` … `ae.searchProject`). All write verbs and most read verbs route through `Backend.exec(jsx)`. The `ae.snapshot` verb routes through a separate Snapshotter abstraction.

## Install

```powershell
# 1) Core (this package)
pip install ae-mcp

# 2) A backend matching your AE plugin (NOT in this repo — published separately)
#    Examples: `ae-mcp-backend-aebm` ships with the AEBMethod plugin's repo.
#    See "Backends" below.
pip install ae-mcp-backend-<name>

# 3) Optional: cross-platform snapshot for ae.snapshot
pip install ae-mcp-snapshot-mss
```

This repo intentionally ships NO concrete backends — `ae-mcp` is a pure MCP layer. Backends are owned by AE plugin authors who publish their own pip packages registering entry-point group `ae_mcp.backends`. See "Writing a new backend" below.

If you have multiple backends installed, set `AE_MCP_BACKEND` to choose.

## Configure your MCP client

Copy `.mcp.json.template` to your client config (e.g., `~/.claude.json` for Claude Code) and fill in:

```json
{
  "mcpServers": {
    "ae": {
      "command": "python",
      "args": ["-m", "ae_mcp"],
      "env": {
        "AE_MCP_BACKEND": "aebm",
        "AE_BRIDGE_ROOT": "E:/Code/AEBMethod"
      }
    }
  }
}
```

Replace `AE_MCP_BACKEND` and the per-backend env vars (`AE_BRIDGE_ROOT`, etc.) per the backend you chose.

Restart your MCP client. `/mcp` (or equivalent) should list 24 tools under `ae.*` (23 if you didn't install a snapshotter).

## Backends

`ae-mcp` does not ship any backend. The Backend interface is public; AE plugin authors publish their own integration packages.

Known third-party backends (not endorsed, listed for reference):
- `ae-mcp-backend-aebm` — adapts AEBMethod's file-polling protocol (lives in a sibling repo; install via `pip install -e <path-to-backend-aebm>`)

If you author and publish a backend, send a PR to add it to this list.

### Writing a new backend

Implement `ae_mcp.backends.base.Backend` (subclass with `exec`, `health_check`, `from_env`), publish as a pip package, register entry point group `ae_mcp.backends`. See spec 3c (Backend Author Guide — TBD).

## Develop

```powershell
git clone <this-repo>
cd after-effects-mcp
python -m uv sync --group dev                          # installs core + snapshot-mss editable + pytest
python -m uv run pytest -m "not live and not live_smoke" -v
```

Tests: ~122 unit tests across `packages/{core,snapshot-mss}/tests/`. Backend tests live in their own repos.

To run the live test suite you also need a backend installed:
```powershell
pip install -e <path-to-backend-aebm-repo>             # or another backend
```

## Live tests

Opt-in end-to-end against a real AE instance:

```powershell
$env:AEBM_LIVE_TESTS = "1"
$env:AE_MCP_BACKEND = "aebm"
$env:AE_BRIDGE_ROOT = "E:/Code/AEBMethod"
python -m uv run pytest -m live_smoke      # 3-case canary, ~30s
python -m uv run pytest -m live            # full ~10 cases, ~2-3min

# Note: aebm backend uses AEGP idle hook polling, which is throttled when AE
# is in background. Keep AE in foreground while running live tests.
```

CI does not run live tests (hosted runners cannot drive a GUI Adobe app). See `docs/REFERENCE.md`.

## Migrating from `after-effects-mcp` v0.7

See [MIGRATION.md](MIGRATION.md).

## License

MIT.
