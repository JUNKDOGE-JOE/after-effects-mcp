# aebm-mcp — BlendifyAE MCP server

Python MCP server that exposes 15 AE verbs to Claude Code over stdio JSON-RPC. Wraps the
existing `aebm-file` PowerShell bridge (`scripts/backend_interface.ps1`) so Claude can drive
After Effects without hand-dispatching pwsh via the Bash tool.

## Layout

```
aebm_mcp/
  server.py       - MCP server entry, tools/list + tools/call
  bridge.py       - subprocess pwsh wrapper -> Invoke-Ae*
  snapshot.py     - ctypes Win32 BitBlt, Python port of scripts/viewer_snapshot.ps1
  schemas.py      - pydantic models for 15 verbs
  progress.py     - asyncio heartbeat for long-running calls
  handlers/
    core.py       - 9 critical-path verbs (init/overview/layers/readProps/exec/
                    checkpoint/revert/snapshot/applyEffect)
    typed.py      - 6 sugar verbs (createLayer/setProperty/moveLayer/selectLayers/
                    setTime/getTime) that build JSX and hand it to ae.exec
  jsx_templates/  - .jsx string templates used by typed handlers
```

## Prerequisites

- Python 3.10+
- `uv` (install via `pip install uv`; invoke as `python -m uv` on Windows if the `uv`
  executable is not on PATH)
- Windows + PowerShell 5+ (for the pwsh bridge and ctypes snapshot)
- AE 2026 running, with the AEBlenderMode plugin loaded (for live verbs)

## Install

```powershell
cd mcp
python -m uv sync
```

## Run (stdio)

```powershell
cd mcp
python -m uv run python -m aebm_mcp
```

## Register with Claude Code

Add to your `.claude/settings.json` (project) or `claude_desktop_config.json` (global):

```json
{
  "mcpServers": {
    "aebm": {
      "command": "python",
      "args": [
        "-m", "uv", "run",
        "--directory", "E:/Code/AEBMethod/.claude/worktrees/modest-boyd-c4f2e1/mcp",
        "python", "-m", "aebm_mcp"
      ]
    }
  }
}
```

Restart Claude Code and run `/mcp` — you should see 15 tools under `aebm.ae.*`.

## Verb reference

See `docs/development/AEBM_MCP.md` in the repo root for the full spec.

| # | verb | purpose |
|---|---|---|
| 1 | `ae.init` | refresh project snapshot |
| 2 | `ae.overview` | project-level summary |
| 3 | `ae.layers` | list layers for a comp |
| 4 | `ae.readProps` | run read-only JSX |
| 5 | `ae.exec` | run JSX with undo group |
| 6 | `ae.checkpoint` | list checkpoints (stub, v0.7) |
| 7 | `ae.revert` | revert to checkpoint (stub, v0.7) |
| 8 | `ae.snapshot` | capture viewer PNG (ctypes BitBlt) |
| 9 | `ae.applyEffect` | add effect to layer |
| 10 | `ae.createLayer` | create solid/text/shape/null/adjustment/camera/light |
| 11 | `ae.setProperty` | write property by path |
| 12 | `ae.moveLayer` | reorder layer |
| 13 | `ae.selectLayers` | select all/none/by id |
| 14 | `ae.setTime` | set comp current time |
| 15 | `ae.getTime` | read comp current time |

## Tests

```powershell
cd mcp
python -m uv run pytest -v
```
