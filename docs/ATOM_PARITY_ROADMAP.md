# AEMCP -> Atom Parity: Optimization Roadmap

This roadmap is now updated to the v0.7.0 state. Earlier audits were written when ae-mcp was still mostly an MCP-only/simple-RPC chain; v0.7.0 delivered the panel product layer, multi-backend embedded chat, approval flow, diagnostics, and several core parity fixes.

## v0.7.0 Current State

Architecture:

```text
MCP client
  -> packages/core (ae_mcp, Python stdio MCP server, 31 ae_ tools)
  -> backend (packages/bridge, httpx)
  -> CEP panel Node host (plugin/host, Express, 127.0.0.1:11488)
  -> CSInterface.evalScript
  -> ExtendScript (plugin/jsx/runtime.jsx + jsx_templates/*.jsx)
```

Panel product:

- Built-in AI chat is delivered.
- Embedded backends are Claude subscription, BYOK Anthropic, and Codex.
- Composer controls are delivered: model with cost badges, reasoning effort, fast mode where supported, and approval mode.
- Four approval modes are delivered: read-only, manual, auto, bypass.
- First-run wizard is delivered: `uv`, Node, Claude CLI, and ae-mcp detection/install; command preview before execution; visible login terminal.
- Activity stream and AI kill switch are delivered.
- Connection diagnostics are delivered.
- External client path is delivered for Claude Desktop, Claude Code, Cursor, OpenCode, OpenClaw, AstrBot, Gemini Antigravity, and similar MCP clients.

OpenCode note: OpenCode is an external client in v0.7.0. Embedded OpenCode is intentionally not counted as delivered here; it is deferred to v0.7.1.

## Delivered Parity Items

| Area | Status | Notes |
|---|---:|---|
| P1 Runtime helpers | Delivered | Shared ExtendScript prelude/runtime helpers exist and templates use the AEMCP helper path. |
| P2 Compact read output | Delivered | `ae.layers` supports pagination and `format='text'`; compact render support exists in Python. |
| P3 Static server guidance | Delivered | MCP server is constructed with `instructions=SERVER_INSTRUCTIONS`. |
| P4 Non-blocking `ae.exec` checkpoint | Delivered | Auto-checkpoint is best-effort and guarded so checkpoint failures do not abort the edit. |
| P5 `ae.layers` pagination + type/parent | Delivered | `ae.layers` supports offset/limit and richer layer fields. |
| P6 Init/checkpoint hardening | Delivered | `ae.init` guidance/state improvements, checkpoint undo, and `emptyResult` handling are part of the v0.7.0 baseline. |
| Multi-framework client path | Delivered | Panel-generated MCP config covers mainstream local clients and documents same-machine/port reachability for IM-bot/Docker deployments. |
| Panel product layer | Delivered | Built-in chat, approvals, wizard, diagnostics, activity stream, and kill switch are v0.7.0 features. |

## Remaining Roadmap

| # | Title | Area | Priority | Notes |
|---|---|---|---|---|
| 1 | More compact renderers for scan/props/keyframes | read-format | M | `ae.layers` text mode exists; extend the same discipline to larger read verbs. |
| 2 | Richer `ae.exec` envelope | exec envelope | M | Keep opt-in; report touched paths, failed mutation attribution, and expression errors without breaking existing return shapes. |
| 3 | Stronger property discovery filters | discovery | M | Path root, query, paging, and better ranking remain useful for large comps. |
| 4 | `getKeyframes` scan mode | discovery | M | Current workflows still benefit from easier keyframe discovery across selected layers/comps. |
| 5 | Preview contact sheets / sampling | previewFrame | M | Useful for reviewing motion over a range rather than one frame at a time. |
| 6 | Preview diff mode | previewFrame | M | Good follow-up once baseline preview paths are stable. |
| 7 | More typed rig controls and presets | createRig | M | `ae.createRig` remains useful but not a full rigging platform. |
| 8 | Embedded OpenCode backend | panel | M | Deferred from v0.7.0 to v0.7.1; keep docs clear that v0.7.0 OpenCode is external. |
| 9 | More robust remote/Docker client guidance | workflow | S | OpenClaw/AstrBot-style deployments need explicit network examples beyond same-machine warning. |

## Cautions That Still Apply

- `runtime.jsx` / shared prelude changes have high blast radius. Keep additions ES3-compatible and covered by render-token tests plus live smoke where possible.
- Existing tool return shapes are part of the MCP contract. Add fields and opt-in formats; do not remove current JSON defaults.
- Checkpoint/revert must remain fail-safe. Any checkpoint failure should surface as a note or skipped state, not abort unrelated user edits.
- Preview capture is for fast feedback. Do not document it as a final render pipeline unless the implementation actually switches to a render-backed path.
- Remote clients must account for `127.0.0.1:11488` resolving on their own host. Dockerized or remote IM-bot frameworks need same-machine execution, port forwarding, or a wrapper running beside AE.

## Verification Targets

Use these before claiming parity work is delivered:

```powershell
uv run pytest
```

With After Effects open and the panel running:

```powershell
$env:AE_MCP_LIVE_TESTS = "1"
$env:AE_MCP_BACKEND = "ae-mcp"
$env:AE_MCP_PLUGIN_URL = "http://127.0.0.1:11488"
uv run pytest packages/core/tests/live -o addopts='' -vv
```

Panel/model smoke:

```powershell
node scripts/live-model-matrix.mjs
```

For release-facing work, also rebuild `plugin/client/dist/app.js` and run the ZXP smoke from [docs/RELEASE.md](RELEASE.md).
