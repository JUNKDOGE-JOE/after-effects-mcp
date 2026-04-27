# ae-mcp

**Agent-driven After Effects automation — MCP server half.**

ae-mcp is one half of an integrated AE-agent product. It speaks the [Model Context Protocol](https://modelcontextprotocol.io) over stdio so Codex / Cursor / Claude Code / Continue / any other MCP client can drive AE through 24 verbs.

## Status: incomplete

The MCP-server half (this repo) is implemented and unit-tested. **The AE-plugin half does not exist yet** — it's the next major piece of work. Without an installed plugin + bridge, ae-mcp cannot drive a real AE; the verbs are defined, the protocol layer is in place, but there is nothing on the other end of `Backend.exec(jsx)` yet.

This is not the same as some other AE projects in this codespace (e.g. AEBMethod, Atom). Those are unrelated products. ae-mcp's plugin will be designed and built fresh under this repo's brand.

## What's implemented

- 22 MCP verbs defined as pydantic schemas (`ae.init`, `ae.exec`, ..., `ae.searchProject`)
- Internal `Backend` ABC + entry-point discovery (architectural seam where the plugin bridge will register)
- `Snapshotter` ABC + cross-platform `mss`-based PNG capture (`packages/snapshot-mss/`)
- 119 unit tests against a `MockBackend` proving the protocol layer is internally consistent
- Checkpoint store (filesystem index for project snapshots)
- Per-call progress heartbeat + timeout discipline

## What's NOT implemented (yet)

- **The AE plugin** — needs design + implementation: C++ AEGP / CEP / UXP / ScriptUI all on the table
- **A bridge package** that registers as `Backend` to talk to the plugin
- End-to-end live testing (blocked on plugin)

## Architecture (target)

```
MCP client (Claude Code / Cursor / Codex / ...)
        │  stdio JSON-RPC 2.0
        ▼
┌─────────────────────────────────────────────────────────┐
│  ae-mcp  (this repo)                                    │
│  ┌─────────────────┐    ┌──────────────────────────┐    │
│  │  core           │    │  bridge (TBD)            │    │
│  │  (24 handlers,  │ ── │  Backend impl talking    │    │
│  │   JSX, schemas) │    │  to our AE plugin        │    │
│  └─────────────────┘    └──────────────────────────┘    │
│  ┌─────────────────┐                                    │
│  │  snapshot-mss   │  cross-platform PNG capture        │
│  └─────────────────┘                                    │
└─────────────────────────────────────────────────────────┘
                                ▲
                                │  TBD protocol
                                ▼
                      Our AE plugin (TBD — not in repo yet)
                                │
                                ▼
                      After Effects (ExtendScript runtime)
```

## Verb surface (22)

| Category | Verbs |
|---|---|
| Project | `ae.init`, `ae.overview`, `ae.layers`, `ae.readProps`, `ae.searchProject` |
| Mutation | `ae.exec`, `ae.applyEffect`, `ae.createLayer`, `ae.setProperty`, `ae.moveLayer`, `ae.selectLayers`, `ae.setTime` |
| Read-typed | `ae.getTime`, `ae.getProperties`, `ae.scanPropertyTree`, `ae.inspectPropertyCapabilities`, `ae.getExpressions`, `ae.getKeyframes` |
| Checkpoint | `ae.checkpoint` (create/list), `ae.revert` |
| Diagnostic | `ae.ping`, `ae.snapshot` |

## Develop

```powershell
git clone <this-repo>
cd after-effects-mcp
python -m uv sync --group dev
python -m uv run pytest -m "not live and not live_smoke" -v
```

Unit tests: 119 cases across `packages/{core,snapshot-mss}/tests/`. They use a `MockBackend` and prove only the protocol layer; they do not touch AE.

## Live tests

Currently unrunnable — there is no plugin and no bridge to run against. The opt-in `pytest -m live` infrastructure is in place but will skip until a backend is registered as `ae_mcp.backends` entry point.

## Migrating from `after-effects-mcp` v0.7

See [MIGRATION.md](MIGRATION.md). (Note: the v0.7 lineage was pre-rebrand; the verb surface is preserved minus two plugin-specific verbs that didn't belong in core.)

## License

MIT.
