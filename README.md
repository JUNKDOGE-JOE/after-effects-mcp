# ae-mcp

Agent-driven After Effects automation through MCP.

ae-mcp lets Codex, Cursor, Claude Code, and other MCP clients drive After Effects through a Python MCP server plus a local CEP panel bridge.

```text
MCP client -> Python ae-mcp -> HTTP 127.0.0.1:11488 -> CEP panel -> AE ExtendScript
```

## Status

The simple RPC plugin path is implemented: CEP panel, HTTP bridge backend, 30 `ae.*` verbs, live AE verification, and dev install scripts. Current verification:

- `uv run pytest -q`: 152 passed, 20 live tests deselected
- `uv run pytest packages/core/tests/live -o addopts='' -vv`: 20 passed with AE open and panel green

This is an Atom-level AE operation MVP: agents can inspect, mutate, preview, checkpoint, use skills, and create basic rigs in After Effects. `ae.generateImage` is intentionally out of scope; image generation belongs on the agent/model side.

## Verb Surface

| Category | Verbs |
|---|---|
| Project | `ae.init`, `ae.overview`, `ae.layers`, `ae.readProps`, `ae.searchProject` |
| Mutation | `ae.exec`, `ae.applyEffect`, `ae.createLayer`, `ae.setProperty`, `ae.moveLayer`, `ae.selectLayers`, `ae.setTime` |
| Read-typed | `ae.getTime`, `ae.getProperties`, `ae.scanPropertyTree`, `ae.inspectPropertyCapabilities`, `ae.getExpressions`, `ae.validateExpressions`, `ae.getKeyframes` |
| Preview | `ae.previewFrame` |
| Rigging | `ae.createRig` |
| Skill | `ae.skillList`, `ae.skillCreate`, `ae.skillEdit`, `ae.skillDelete`, `ae.skillUse` |
| Checkpoint | `ae.checkpoint`, `ae.revert` |
| Diagnostic | `ae.ping`, `ae.snapshot` |

`ae.previewFrame` captures the current AE viewer for fast visual feedback. It does not run Render Queue or write a true comp render. `ae.snapshot` remains a lower-level diagnostic desktop/window capture.

Expression-bearing workflows should be validated before visual review. `ae.validateExpressions` force-evaluates expressions and reports `expressionError`/sample failures so agents can catch locale-sensitive binding bugs before handing work to a user.

## Parity Gaps

The remaining gap is product polish, not basic AE control:

- `ae.previewFrame` captures the visible AE window/viewer area, so it is fast and modal-safe but not yet a precise comp-viewer crop.
- `ae.createRig` is a useful MVP, not a full rigging system. Puppet pin null binding, preset libraries, and advanced controller templates are still future work.
- The skill system has persistent CRUD/use behavior, but no bundled skill library or panel-side management UI yet.
- Simple RPC intentionally requires both the CEP panel and Python package. A single-install HTTP MCP plugin remains a later packaging choice.
- ZXP packaging scripts exist, but a clean-machine signed install smoke still needs to be run before a user-facing release.

## Install

Developer install:

```powershell
uv sync --all-packages --group dev
cd plugin\host
npm ci
cd ..\..
.\scripts\install-plugin-dev.ps1
```

Restart After Effects and open `Window -> Extensions -> ae-mcp`. See [docs/INSTALL.md](docs/INSTALL.md) for MCP client config and troubleshooting.

## Test

Non-live:

```powershell
uv run pytest
```

Live, with AE open and the ae-mcp panel green:

```powershell
$env:AE_MCP_LIVE_TESTS = "1"
$env:AE_MCP_BACKEND = "ae-mcp"
$env:AE_MCP_PLUGIN_URL = "http://127.0.0.1:11488"
uv run pytest packages/core/tests/live -o addopts='' -vv
```

## Package

Use Adobe `ZXPSignCmd`:

```powershell
.\scripts\package-zxp.ps1 -ZxpSignCmd C:\Tools\ZXPSignCmd.exe
```

See [docs/RELEASE.md](docs/RELEASE.md).

## Credits And Inspirations

ae-mcp is an independent implementation. It does not vendor Atom, FX Console, or AtomX code.

Design and behavior were informed by:

- Atom-style AE operation surfaces: broad agent-facing verbs for inspection, mutation, preview, and reusable workflows.
- FX Console-style preview expectations: fast viewer feedback instead of forcing a true render for every visual check.
- Adobe CEP and ExtendScript APIs for the panel bridge and AE automation runtime.
- The Model Context Protocol for the client/server tool interface.

Third-party components:

- `plugin/client/CSInterface.js` is Adobe CEP `CSInterface` v11 and retains Adobe's license notice in that file.
- `ae-mcp-snapshot-mss` uses `mss` and Pillow for screen capture.
- The Python bridge uses `httpx`; the CEP host uses Express.

## License

MIT for ae-mcp project code. See [LICENSE](LICENSE).

Files carrying their own upstream license notices, such as Adobe's `CSInterface.js`, are governed by those notices.
