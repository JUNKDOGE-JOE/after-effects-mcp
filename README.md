# after-effects-mcp

MCP (Model Context Protocol) server that exposes After Effects automation
to Claude Code / Cursor / any MCP client. Wraps the **aebm file-polling
bridge** protocol: a PowerShell + C++ plugin stack that lets MCP clients
drive After Effects without hand-dispatching ExtendScript.

## Status

**Private** — under active development. Will flip to public once the
backend abstraction layer (Option B) lands, at which point the server
will support multiple bridge implementations, not just aebm.

## Architecture

```
After Effects (aebm plugin loaded)
     |
     | <file bridge: %TEMP%/aebm_bridge/{in,out,done}/>
     |
AE plugin repo: scripts/backend_{interface,aebm_file}.ps1
     |
     | <subprocess: powershell -Command>
     |
THIS repo: after_effects_mcp/bridge.py
     |
     | <MCP stdio JSON-RPC>
     |
Claude Code / Cursor / any MCP client
```

## Prerequisites

- Python 3.10+
- `uv` (install via `pip install uv`; invoke as `python -m uv` on Windows
  if `uv` is not on PATH)
- Windows + PowerShell 5+ (for the bridge subprocess + ctypes snapshot)
- An AE plugin that implements the aebm file-polling protocol. The
  canonical implementation lives at
  [github.com/JUNKDOGEGROUP/BlendifyAE](https://github.com/JUNKDOGEGROUP/BlendifyAE)
  (`scripts/backend_*.ps1` + `src/bridge/FileQueue.cpp`).

## Environment Setup

Clone this repo and the plugin repo side-by-side:

```
E:/Code/after-effects-mcp/     (this repo)
E:/Code/AEBMethod/             (plugin repo; has scripts/backend_interface.ps1)
```

Set `AE_BRIDGE_ROOT` to point at the plugin repo checkout:

```powershell
$env:AE_BRIDGE_ROOT = "E:/Code/AEBMethod"
```

Without `AE_BRIDGE_ROOT`, `bridge.py` raises `RuntimeError` on import.
There is no sibling-path autodetection — explicit wins over implicit.

## Install

```powershell
cd E:/Code/after-effects-mcp
python -m uv sync
```

## Run (stdio)

```powershell
cd E:/Code/after-effects-mcp
$env:AE_BRIDGE_ROOT = "E:/Code/AEBMethod"
python -m uv run python -m after_effects_mcp
```

Blocks on stdin waiting for an MCP client. Ctrl+C to exit.

## Register with Claude Code

Copy `.mcp.json.template` to your MCP client config:

```powershell
# Option A: MCP-client-level (applies everywhere)
Copy-Item .mcp.json.template $HOME/.claude.json

# Option B: project-level (if you want MCP only when in one project)
Copy-Item .mcp.json.template path/to/your/project/.mcp.json
```

Then edit the copied file and replace both `<PATH_...>` placeholders
with your local paths. Example after edit:

```json
{
  "mcpServers": {
    "aebm": {
      "command": "python",
      "args": [
        "-m", "uv", "run",
        "--directory", "E:/Code/after-effects-mcp",
        "python", "-m", "after_effects_mcp"
      ],
      "env": {
        "AE_BRIDGE_ROOT": "E:/Code/AEBMethod"
      }
    }
  }
}
```

Restart Claude Code. `/mcp` should list 24 verbs under `mcp__aebm__ae_*`.

## Verb reference

See [`docs/REFERENCE.md`](docs/REFERENCE.md) for the full spec (24 verbs,
protocol, async + progress contract, error shapes, troubleshooting).

| # | verb | purpose |
|---|---|---|
| 1 | `ae.init` | refresh project snapshot |
| 2 | `ae.overview` | project-level summary |
| 3 | `ae.layers` | list layers for a comp |
| 4 | `ae.readProps` | run read-only JSX |
| 5 | `ae.exec` | run JSX with undo group |
| 6 | `ae.checkpoint` | list checkpoints (stub, deferred) |
| 7 | `ae.revert` | revert to checkpoint (stub, deferred) |
| 8 | `ae.snapshot` | capture viewer PNG (ctypes BitBlt) |
| 9 | `ae.applyEffect` | add effect to layer |
| 10 | `ae.createLayer` | create solid/text/shape/null/adjustment/camera/light |
| 11 | `ae.setProperty` | write property by path |
| 12 | `ae.moveLayer` | reorder layer |
| 13 | `ae.selectLayers` | select all/none/by id |
| 14 | `ae.setTime` | set comp current time |
| 15 | `ae.getTime` | read comp current time |
| 16 | `ae.ping` | bridge handshake (live test smoke) |
| 17 | `ae.getProperties` | property name search across layers |
| 18 | `ae.scanPropertyTree` | DFS dump of one layer's prop tree |
| 19 | `ae.inspectPropertyCapabilities` | what can be set on a property path |
| 20 | `ae.getExpressions` | read all expressions in a comp |
| 21 | `ae.getKeyframes` | keyframes for a property path |
| 22 | `ae.searchProject` | fuzzy search project items/layers/effects/expressions |

Plus two diagnostic / agent-convenience verbs:

| # | verb | purpose |
|---|---|---|
| 23 | `ae.isolateToggle` | toggle Motion4-style `/` timeline isolation session |
| 24 | `ae.toastQuery` | read current active toast queue (for test assertions) |

## Tests

```powershell
cd E:/Code/after-effects-mcp
python -m uv run pytest -v
```

CI runs on every push via `.github/workflows/ci.yml` (windows-2022, Python
3.10).

## Live tests

Opt-in end-to-end tests that drive a real AE instance.

```powershell
$env:AEBM_LIVE_TESTS = "1"
$env:AE_BRIDGE_ROOT  = "E:/Code/AEBMethod"
python -m uv run pytest -m live_smoke      # 3-case canary, ~30s
python -m uv run pytest -m live            # full ~10 cases, ~2-3min
```

CI does not run live tests (hosted runners cannot drive a GUI Adobe app).
See `docs/REFERENCE.md#live-test-layer`.

## Layout

```
after_effects_mcp/
  server.py       MCP server entry, tools/list + tools/call
  bridge.py       subprocess pwsh wrapper -> Invoke-Ae* (uses AE_BRIDGE_ROOT)
  snapshot.py     ctypes Win32 BitBlt, Python port of plugin's viewer_snapshot.ps1
  schemas.py      pydantic models for all verbs
  progress.py     asyncio heartbeat for long-running calls
  handlers/
    core.py       critical-path verbs (init/overview/layers/readProps/exec/
                  checkpoint/revert/snapshot/applyEffect + isolateToggle + toastQuery)
    typed.py      sugar verbs (createLayer/setProperty/moveLayer/selectLayers/
                  setTime/getTime) that build JSX and hand it to ae.exec
  jsx_templates/  .jsx string templates used by typed handlers
docs/
  REFERENCE.md    full protocol + verb spec
tests/            pytest suite (73 cases)
.mcp.json.template  MCP client config template
```
