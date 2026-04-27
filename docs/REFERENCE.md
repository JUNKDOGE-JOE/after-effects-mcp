# ae-mcp Reference

Protocol-level reference for the `ae-mcp` MCP server.

## Quick facts

| Item | Value |
|---|---|
| Runtime | Python 3.10+ managed by `uv` workspace |
| Transport | stdio JSON-RPC 2.0 (via the official `mcp` SDK low-level `Server`) |
| Entry point | `python -m ae_mcp` |
| Backend selection | `AE_MCP_BACKEND` env var; entry point group `ae_mcp.backends` |
| Snapshot selection | entry point group `ae_mcp.snapshotters` (`ae.snapshot` hidden if none installed) |
| Handler count | 24 verbs (filtered by active backend's `supported_verbs()`) |
| Progress cadence | `ctx.report_progress` every 2s while a call is in flight |
| Default per-call timeout | 30s (overridable via `timeout_sec` on `ae.exec`) |
| Checkpoint store | `%TEMP%/aebm_checkpoints/<basename>/<id>.aep + .json` (keep N=AEBM_CHECKPOINT_KEEP, default 50) |

## Architecture

```
MCP client (stdio JSON-RPC 2.0)
        |
        v
ae_mcp.server                           tools/list, tools/call dispatcher
   |        |
   |        +-- ae_mcp.backends.discovery — selects active Backend by AE_MCP_BACKEND
   |        |
   |        +-- ae_mcp.snapshot.discovery — selects active Snapshotter (or None)
   |        |
   v        v
handlers/* (24 verbs) — render JSX templates, call backend.exec(jsx)
   |
   v
[ Backend implementation in a separate pip package ]
   |
   v
AE plugin (AEBM file queue / your own)
   |
   v
After Effects (ExtendScript runtime)
```

## Backend interface

```python
class Backend(ABC):
    name: str                       # matched against AE_MCP_BACKEND env var
    manages_undo: bool = False      # if True, core skips its own undo wrapping
    manages_checkpoints: bool = False  # if True, core skips checkpoint_create

    @abstractmethod
    async def exec(self, code, *, undo_group=None, checkpoint_label=None,
                    timeout_sec=30.0) -> str: ...

    @abstractmethod
    async def health_check(self, timeout_sec=5.0) -> bool: ...

    def supported_verbs(self) -> set[str]:    # default: all 24
        return ALL_VERBS

    @classmethod
    @abstractmethod
    def from_env(cls) -> "Backend": ...
```

Backends are discovered via `importlib.metadata.entry_points(group="ae_mcp.backends")`. Each entry point maps a `name` (matched to `AE_MCP_BACKEND`) to a `Backend` subclass. Selection rules:

- `AE_MCP_BACKEND=<name>` set → must match an installed backend; else error
- env var unset, exactly one backend installed → use it
- multiple installed, no env var → error (set AE_MCP_BACKEND)
- none installed → error with install hint

## Snapshotter interface

```python
class Snapshotter(ABC):
    name: str

    @abstractmethod
    async def capture(self, out_path, *, hwnd=None, main_window=False,
                       method="auto") -> dict: ...

    @abstractmethod
    def supports_platform(self) -> bool: ...
```

Snapshotters are discovered via `importlib.metadata.entry_points(group="ae_mcp.snapshotters")`. The first installed snapshotter whose `supports_platform()` is True wins. If none installed, `ae.snapshot` is hidden from `tools/list`.

## Verb reference

All 24 verbs return a JSON object with `ok: bool` and either result fields (success) or `error: str` (failure).

| Verb | Args | Notes |
|---|---|---|
| `ae.init` | `refresh_only?` | bootstrap snapshot |
| `ae.overview` | (none) | comp/item summary |
| `ae.layers` | `comp_id?` | layer list for a comp |
| `ae.readProps` | `code` (JSX) | run read-only JSX |
| `ae.exec` | `code` (JSX), `undo_group_name?`, `checkpoint_label?`, `timeout_sec?` | run JSX under undo group; auto-checkpoint if label set (skipped when backend.manages_checkpoints) |
| `ae.checkpoint` | `action: "create"\|"list"`, `label?`, `limit?` | save .aep snapshot or list saved snapshots |
| `ae.revert` | `checkpoint_id`, `branch_before_revert?` | reopen a saved .aep |
| `ae.snapshot` | `out_path?`, `hwnd?`, `main_window?`, `method?` | capture PNG (hidden if no snapshotter) |
| `ae.applyEffect` | `comp_id?`, `layer_id`, `effect_match_name` | add effect by matchName |
| `ae.createLayer` | `type`, `name`, etc. | solid/text/shape/null/adjustment/camera/light |
| `ae.setProperty` | `layer_id`, `path`, `value`, `at_time?` | write property by `Transform/Position` style path |
| `ae.moveLayer` | `layer_id`, `to_index` | reorder |
| `ae.selectLayers` | `layer_ids` | select all/none/by id |
| `ae.setTime` | `time` | comp current time |
| `ae.getTime` | `comp_id?` | read comp current time |
| `ae.ping` | `expect?` | handshake smoke test |
| `ae.getProperties` | `comp_id?`, `layer_ids`, `query`, `offset?`, `limit?` | search properties by name |
| `ae.scanPropertyTree` | `comp_id?`, `layer_id`, `max_depth?`, `include_values?` | DFS dump of one layer's prop tree |
| `ae.inspectPropertyCapabilities` | `comp_id?`, `layer_id`, `path` | what can be set on a property |
| `ae.getExpressions` | `comp_id`, `layer_ids?`, `prop?`, `max_results?` | read all expressions in a comp |
| `ae.getKeyframes` | `comp_id?`, `layer_id`, `path` | keyframes for a property path |
| `ae.searchProject` | `query`, `scope?`, `limit?` | fuzzy search across project |
| `ae.isolateToggle` | (none) | (AEBM backend only) |
| `ae.toastQuery` | (none) | (AEBM backend only) |

## Live test layer

Opt-in end-to-end tests against a real AE instance.

**Activate**: `AEBM_LIVE_TESTS=1`. Without it, tests in `packages/core/tests/live/` skip.

**Markers**: `live` (full ~10 cases) / `live_smoke` (3-case canary).

**CI policy**: live tests excluded via `pyproject.toml` `addopts = "-m 'not live and not live_smoke'"`. Hosted runners cannot drive a GUI Adobe app. Run locally before each release.

```powershell
$env:AEBM_LIVE_TESTS = "1"
$env:AE_MCP_BACKEND = "aebm"
$env:AE_BRIDGE_ROOT = "E:/Code/AEBMethod"   # for aebm backend
python -m uv run pytest -m live_smoke
python -m uv run pytest -m live
```

## Cross-references

- [MIGRATION.md](../MIGRATION.md) — migrating from `after-effects-mcp` v0.7
- [README.md](../README.md) — install + configuration
- `docs/superpowers/specs/2026-04-27-spec-3a-backend-abstraction-design.md` — design rationale
