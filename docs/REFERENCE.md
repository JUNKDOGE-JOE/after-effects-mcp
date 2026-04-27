# After Effects MCP Server — Reference

Python MCP server that exposes **24 After Effects verbs** to Claude Code over
stdio JSON-RPC. This is the "last-mile" wrapper that lets Claude drive AE
through the existing `aebm-file` PowerShell bridge without hand-dispatching
`pwsh -Command` via the Bash tool.

**Audience**: this document is the long-form reference that Claude / other LLM
clients read when deciding which verb to call. For install + run instructions
see `README.md`. For the underlying file-polling protocol see
[AEBM_BRIDGE.md in plugin repo](https://github.com/JUNKDOGEGROUP/BlendifyAE/blob/main/docs/development/AEBM_BRIDGE.md).

---

## Quick facts

| Item | Value |
|---|---|
| Runtime | Python 3.10+ managed by `uv` |
| Transport | stdio JSON-RPC 2.0 (via the official `mcp` SDK low-level `Server`) |
| Entry point | `python -m after_effects_mcp` |
| Backend dependency | `scripts/backend_interface.ps1` with `AE_BACKEND=aebm-file` |
| Handler count | 21 (10 core + 11 typed) |
| Progress cadence | `ctx.report_progress` every 2 s while a call is in flight |
| Default per-call timeout | 30 s (overridable via `timeout_sec` on `ae.exec`) |
| Checkpoint store | `%TEMP%/aebm_checkpoints/<basename>/<id>.aep` + `.json` (keep N=`AEBM_CHECKPOINT_KEEP`, default 50) |
| Snapshot capture | Python ctypes `BitBlt` (does NOT go through the file queue) |

---

## Architecture

```
Claude Code
    |  (MCP stdio: JSON-RPC 2.0 over stdin/stdout)
    v
after_effects_mcp.server (Python, asyncio)
    |-- tools/list        -> 24 verb schemas (pydantic model_json_schema)
    |-- tools/call        -> dispatch to handler, emit progress heartbeats
    |                          |
    |                          v
    |                      progress.run_with_timeout
    |                      (asyncio.wait_for + with_heartbeat)
    |                          |
    v                          v
bridge.py              snapshot.py
    |  pwsh subprocess          |  ctypes -> user32 + gdi32
    v                           v
scripts/backend_interface.ps1   (host-side BitBlt, no PS hop)
    |
    v
%TEMP%/aebm_bridge/in/<id>.json
    |
    v
FileQueue (C++ plugin, AEGP idle hook)
    |
    v
AEGP_ExecuteScript -> AE
```

### Key design decisions

1. **Python wraps pwsh via subprocess for every verb except `ae.snapshot`.**
   The PowerShell layer already handles UTF-8 no-BOM encoding, atomic file
   writes, bridge-timeout normalization and error shapes; Python only deals
   with MCP protocol + pydantic validation + asyncio heartbeat. Snapshot is
   the exception because a pwsh cold start is 100-300 ms per call and
   screenshotting is on the LLM "look at frame, decide next step" hot path.

2. **Long-running verbs emit progress notifications on a 2 s heartbeat.**
   `progress.with_heartbeat(ctx, coro, interval=2.0)` races `coro` against
   an `asyncio.sleep` loop that calls `ctx.report_progress(n, None, "Still
   running at t+Ns...")`. When `coro` completes (or raises) the heartbeat
   task is cancelled. `run_with_timeout` wraps that in `asyncio.wait_for`
   so the handler returns `{"ok": false, "error": "timed out after Xs"}`
   on timeout rather than raising.

3. **11 typed verbs are Python-rendered JSX templates dispatched via
   `ae.exec`.** They do NOT add new entries to the PowerShell
   `Invoke-Ae*` surface. Rationale: keeping the typed verbs in Python
   means the C++ `FileQueue` stays at 7 verbs + NotImplemented stub, and
   `backend_atom_http.ps1` (still partially present for the Atom-
   compatibility exit ramp) does not need parallel maintenance of 11 new
   typed entries.

4. **Every pydantic model uses `ConfigDict(extra="forbid")`.** Unknown
   fields in the `arguments` object surface as validation errors instead
   of being silently ignored.

5. **Snapshot never enters the file queue.** `after_effects_mcp/snapshot.py` is a
   faithful Python port of [scripts/viewer_snapshot.ps1 in plugin repo](https://github.com/JUNKDOGEGROUP/BlendifyAE/blob/main/scripts/viewer_snapshot.ps1). The plugin-side
   `FileQueue.cpp::ae.snapshot` intentionally remains a `NotImplemented`
   stub so callers that route snapshot through the queue get a clear
   error.

---

## Registration (Claude Code)

Add this block to your Claude Code config (`.claude/settings.json` for the
project, `~/.claude.json` / `claude_desktop_config.json` for global):

```json
{
  "mcpServers": {
    "aebm": {
      "command": "python",
      "args": [
        "-m", "uv", "run",
        "--directory", "E:/Code/after-effects-mcp",
        "python", "-m", "after_effects_mcp"
      ]
    }
  }
}
```

After restarting Claude Code, `/mcp` should list 24 tools under
`aebm.ae.*`. If the list is empty, see **Troubleshooting** below.

> The `python -m uv` invocation works around the `uv.exe` not being on
> `PATH` on Windows when uv is installed via `pip install uv`. If `uv` is
> on `PATH` you can simplify to `"command": "uv"`.

---

## Verb reference

All verbs return a JSON object. On success `ok == true`. On failure
`ok == false` + `error` contains a string message. The tool call itself
is still MCP-successful — Claude sees the error payload as a text result
and can recover.

### 1. `ae.init`

Refresh the AE project snapshot.

| Arg | Type | Required | Default | Notes |
|---|---|---|---|---|
| `refresh_only` | bool | no | `false` | If true, skip the large instructions block, only refresh `project_state`. |

Returns: text (project snapshot) as `{ok, content}`.

### 2. `ae.overview`

Project-level summary (no args).

Returns: `{ok, project, numItems, activeItemId}` or similar
PowerShell-shaped object.

### 3. `ae.layers`

List layers in a comp.

| Arg | Type | Required | Default | Notes |
|---|---|---|---|---|
| `comp_id` | string | no | active comp | AE item id, typically a stringified int. |

Returns: `{ok, compId, layers: [{id, name, enabled}, ...]}`.

### 4. `ae.readProps`

Run **read-only** JSX and return its JSON.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `code` | string | yes | Must end in `JSON.stringify(...)`. No undo group is opened. |

Returns: whatever the JSX emitted. If the JSX returns non-JSON text, the
bridge wraps it as `{ok: true, content: "<raw text>"}`.

**Why explicit JSX?** The `aebm-file` backend does not implement the
Atom-style property-path walker. Callers that want a typed read path
should use `ae.layers` / `ae.getTime` / `ae.getProperties` instead.

### 5. `ae.exec`

Run JSX under an undo group.

| Arg | Type | Required | Default | Notes |
|---|---|---|---|---|
| `code` | string | yes | — | Full JSX source. |
| `undo_group_name` | string | no | `"AEBM MCP"` | Undo-stack label. |
| `checkpoint_label` | string | no | — | Non-empty: auto-create a checkpoint before running JSX. Untitled project → `checkpointSkipped: 'untitled-project'` in result. |
| `timeout_sec` | int (1-600) | no | 30 | Per-call timeout. |

Returns: whatever the JSX emitted, same shape rules as `ae.readProps`.

**Progress**: heartbeat fires at t+2s, t+4s, ... until the call resolves
or times out.

### 6. `ae.checkpoint` **(v0.7 upgrade)**

Create or list project checkpoints.

| Arg | Type | Required | Default | Notes |
|---|---|---|---|---|
| `action` | `"create" \| "list"` | no | `"list"` | Default `"list"` preserves v0.6 compatibility. |
| `label` | string | no | `""` | Human-readable label (recommended for `create`). |
| `limit` | int (1-200) | no | 20 | Maximum checkpoints returned by `list`. |

Returns:

```json
// action: "create" (saved project)
{"ok": true, "id": "1714180800000_a3f2bc91", "label": "before risky write", "path": "C:/.../1714180800000_a3f2bc91.aep", "sizeBytes": 12345678}

// action: "create" (untitled project — silent skip)
{"ok": true, "skipped": true, "reason": "untitled-project", "id": null}

// action: "list"
{"ok": true, "checkpoints": [{"id": "...", "label": "...", "ts": "2026-04-27T...", "sizeBytes": 12345678, "activeCompId": "12"}], "total": 17}
```

### 7. `ae.revert`

Revert to a checkpoint.

| Arg | Type | Required | Default | Notes |
|---|---|---|---|---|
| `checkpoint_id` | string | yes | — | From `ae.checkpoint list`. |
| `branch_before_revert` | bool | no | `true` | Create a `before-revert-<short-id>` checkpoint first. |

Returns: `{ok, reverted: true, openedPath, branchedFromId?: str}` on success,
or `{ok: false, error: "checkpoint not found: <id>"}` if the id does not exist.

### 8. `ae.snapshot`

Capture a PNG of the AE viewer via Win32 `BitBlt`.

| Arg | Type | Required | Default | Notes |
|---|---|---|---|---|
| `out_path` | string | no | `release/logs/integration_runs/ae_viewer_<ts>.png` | Destination. |
| `hwnd` | string | no | auto-pick | Explicit child HWND as `"0x..."` or decimal string. |
| `main_window` | bool | no | `false` | Capture the whole AE main window instead of the viewer. |
| `method` | `"DesktopCopy"` \| `"PrintWindow"` | no | `"DesktopCopy"` | DesktopCopy works for D3D11; PrintWindow is GDI-only (diagnostic). |

Returns: `{ok, path, bytes, width, height, hwnd, method}`.

**Implementation notes**:

- **Does not use pwsh.** Python `snapshot.py` walks `EnumChildWindows`
  looking for `OS_ViewContainer` children closest to 16:9 with
  width > 800 px.
- Calls `SetForegroundWindow(ae_main)` + 80 ms settle before capture to
  avoid capturing occluded pixels.
- DesktopCopy = `BitBlt(hdcDesktop, SRCCOPY | CAPTUREBLT)` at the target
  rect's screen coords; correct for AE's D3D11-composited viewer.
- PrintWindow with `PW_RENDERFULLCONTENT` returns blank for D3D11
  surfaces on AE 2026 retail builds. Keep it only for diagnostics on
  GDI-only panels.
- Windows-only. Non-Windows platforms get `{ok: false, error: "snapshot
  is Windows-only"}`.

### 9. `ae.applyEffect`

Apply an effect to a layer by match-name.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `comp_id` | string | no | Active comp if omitted. |
| `layer_id` | int (>=1) | yes | 1-based layer index. |
| `effect_match_name` | string | yes | E.g. `"ADBE Gaussian Blur 2"`, `"ADBE Drop Shadow"`. |

Returns: `{ok, effectIndex, effectName}`.

### 10. `ae.createLayer`

Create a layer in a comp.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `comp_id` | string | no | Active comp if omitted. |
| `type` | `"solid"` \| `"text"` \| `"shape"` \| `"null"` \| `"adjustment"` \| `"camera"` \| `"light"` | yes | Layer kind. |
| `name` | string (non-empty) | yes | Display name. |
| `color` | `[r, g, b, a]` (0..1) | no | Solid color; alpha is dropped inside the JSX template. |
| `size` | `[w, h]` (px) | no | Solid size; defaults to comp size when omitted. |
| `duration` | float (>0) | no | Layer duration (seconds); defaults to comp duration. Passed as `-1` sentinel when omitted. |
| `position` | `[x, y, z]` | no | Initial position. |

Returns: `{ok, layerId, name, index}`.

JSX template: `jsx_templates/create_layer.jsx` uses `string.Template`
with `${placeholders}`. Sentinel `-1` values tell the JSX to fall back
to comp defaults.

### 11. `ae.setProperty`

Write a property on a layer by dotted path.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `comp_id` | string | no | Active comp if omitted. |
| `layer_id` | int (>=1) | yes | 1-based layer index. |
| `path` | string | yes | E.g. `"Transform/Position"`, `"Effects/Gaussian Blur/Blurriness"`. |
| `value` | scalar \| array | yes | Passed to `setValue` / `setValueAtTime` as-is. |
| `at_time` | float | no | If set, writes a keyframe; else sets the constant value. |

Returns: `{ok, previous, current}`.

The JSX splits `path` on `/` and walks `prop.property(seg)` for each
segment. Missing segments surface a clear error from the JSX layer.

### 12. `ae.moveLayer`

Reorder a layer.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `comp_id` | string | no | Active comp if omitted. |
| `layer_id` | int (>=1) | yes | Source 1-based index. |
| `to_index` | int (>=1) | yes | Target index. |

Returns: `{ok, fromIndex, toIndex}`. The JSX clamps `to_index` against
`comp.numLayers`, so out-of-range values do not throw on the AE side.

### 13. `ae.selectLayers`

Select layers in a comp.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `comp_id` | string | no | Active comp if omitted. |
| `layer_ids` | `int[]` \| `"all"` \| `"none"` | yes | List of indices, or the string literal. |

Returns: `{ok, selected: [int, ...]}`.

### 14. `ae.setTime`

Set comp current time (seconds).

| Arg | Type | Required | Notes |
|---|---|---|---|
| `comp_id` | string | no | Active comp if omitted. |
| `time` | float (>=0) | yes | Seconds from comp start. |

Returns: `{ok, time}`.

### 15. `ae.getTime`

Read comp current time (seconds).

| Arg | Type | Required | Notes |
|---|---|---|---|
| `comp_id` | string | no | Active comp if omitted. |

Returns: `{ok, time, duration, numLayers, compId}`.

### 16. `ae.ping`

Handshake smoke test for live diagnostics.

| Arg | Type | Required | Default | Notes |
|---|---|---|---|---|
| `expect` | string | no | `"pong"` | String to echo back. |

Returns: `{ok, pong, aeVersion, latencyMs}`.

### 17. `ae.getProperties`

Structured property search across layers, equivalent to Atom's `get_properties`.

| Arg | Type | Required | Default | Notes |
|---|---|---|---|---|
| `comp_id` | string | no | active comp | AE item id. |
| `layer_ids` | int[] | yes | — | 1-based layer index list. |
| `query` | string | yes | — | Multi-word AND; `\|`-separated for OR. |
| `offset` | int (>=0) | no | 0 | Pagination offset. |
| `limit` | int (1-500) | no | 50 | Pagination page size. |

Returns: `{ok, total, results: [{layerId, propPath, propType, value, hasExpression, hasKeyframes}]}`.

### 18. `ae.scanPropertyTree`

Full property-tree dump for a single layer, equivalent to Atom's `scan_property_tree`.

| Arg | Type | Required | Default | Notes |
|---|---|---|---|---|
| `comp_id` | string | no | active comp | — |
| `layer_id` | int (>=1) | yes | — | — |
| `max_depth` | int (1-10) | no | 4 | Guards against mask/effects nesting explosion. |
| `include_values` | bool | no | `true` | Set `false` to get schema only (reduces payload). |

Returns: `{ok, layerId, layerName, tree: <node>, truncatedAt: int|null}`.

Each tree node: `{name, matchName, kind: "PropertyGroup"|"Property", propType, value, hasExpression, numKeyframes, children}`.

### 19. `ae.inspectPropertyCapabilities`

Query what operations are valid on a property path before writing, equivalent to Atom's `inspect_property_capabilities`.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `comp_id` | string | no | Active comp if omitted. |
| `layer_id` | int | yes | — |
| `path` | string | yes | Same `Transform/Position` style as `ae.setProperty`. |

Returns: `{ok, exists, canSetValue, canSetExpression, canAddKeyframe, propType, valueDimension, hasMin, hasMax, minValue, maxValue, unitsText, numKeyframes, hasExpression}`.

### 20. `ae.getExpressions`

Read all expression source code in a comp, equivalent to Atom's `get_expressions`.

| Arg | Type | Required | Default | Notes |
|---|---|---|---|---|
| `comp_id` | string | yes | — | — |
| `layer_ids` | int[] | no | all layers | Restrict scan to these indices. |
| `prop` | string | no | — | Filter by matchName substring. |
| `max_results` | int (1-1000) | no | 200 | Guards against large-project blowup. |

Returns: `{ok, expressions: [{layerId, propPath, expression, enabled, hash}], grouped: {hash: [{layerId, propPath}]}, truncated}`.

### 21. `ae.getKeyframes`

Read keyframes for a single property path, equivalent to Atom's `get_keyframes`.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `comp_id` | string | no | Active comp if omitted. |
| `layer_id` | int | yes | — |
| `path` | string | yes | Property path. |

Returns: `{ok, numKeyframes, keyframes: [{index, time, value, interpIn, interpOut, easeIn, easeOut, spatialIn, spatialOut}]}`.

### 22. `ae.searchProject`

Cross-project fuzzy search, equivalent to Atom's `search_project`.

| Arg | Type | Required | Default | Notes |
|---|---|---|---|---|
| `query` | string | yes | — | Multi-word AND; `\|`-separated for OR. |
| `scope` | string[] | no | all | Subset of `["layers","expressions","effects","comps","items"]`. |
| `limit` | int (1-500) | no | 100 | — |

Returns: `{ok, hits: [{kind, compId?, layerId?, name, snippet, score}], truncated}`.

Scoring: `comps`/`items` name hits > `layers` > `effects` > `expression` substrings.

### 23. `ae.isolateToggle`

Toggle solo/isolate state on a layer.

Returns: `{ok, layerId, isolated}`.

### 24. `ae.toastQuery`

Display a toast notification in AE and return user response.

Returns: `{ok, response}`.

---

## Checkpoint store

Real implementation backing `ae.checkpoint` and `ae.revert` (v0.7+). Lives in
`after_effects_mcp/checkpoint_store.py` — pure Python filesystem index, no AE dependency.

### Layout

```
%TEMP%/aebm_checkpoints/
    <project_basename>/      # e.g. "MyProject" for C:/foo/MyProject.aep
        <id>.aep             # full project copy via File.copy()
        <id>.json            # metadata sidecar
    _untitled/               # placeholder for unsaved projects (always empty)
```

### ID format

`<unix_ms>_<8-hex-chars>` — millisecond prefix gives natural lexicographic sort
order; module-level monotonic counter ensures strictly increasing ms across
calls within the same millisecond. Random hex suffix breaks any residual
collisions and prevents ID guessing.

### Retention

Default: keep the 50 newest checkpoints per project basename, prune older.
Override via `AEBM_CHECKPOINT_KEEP` env var. `prune()` is called automatically
after each successful `create` action.

### Untitled project behavior

`app.project.file === null` → `ae.checkpoint create` returns
`{ok: true, skipped: true, reason: "untitled-project", id: null}`.
Verb's write action proceeds; only rollback capability is unavailable until
the user saves the .aep. This avoids a "must save first" loop.

### Save strategy (avoiding fsName drift)

`checkpoint_create.jsx` calls `app.project.save()` (no args, saves to current
fsName) followed by `File.copy(checkpointPath)`. **Never call
`app.project.save(File(checkpointPath))`** — that mutates the project's
fsName, polluting the user's workflow.

### Revert behavior

`ae.revert(id)` closes the current project (no-save) and opens
`<project_basename>/<id>.aep`. After revert, AE's project file path points at
the checkpoint .aep, not the original. Subsequent `create` calls record the
checkpoint .aep as their source. This matches Atom's behavior — revert =
"continue from this state."

`branch_before_revert=true` (default) creates a `before-revert-<short-id>`
checkpoint first; failures are logged but do not block the revert itself.

---

## Async + progress contract

```python
# simplified server dispatch
async def _call_tool(name: str, arguments: dict | None):
    schema_cls, run_fn = HANDLERS[name]
    validated = schema_cls(**(arguments or {}))
    result = await run_fn(validated, ctx)
    return [TextContent(type="text", text=_format_result(result))]
```

The `run_fn` for each long-running verb wraps its own work in
`progress.run_with_timeout(ctx, _call(), timeout_sec=N)`:

```python
async def run_with_timeout(ctx, coro, timeout_sec, interval=2.0,
                           start_msg="Running..."):
    try:
        return await asyncio.wait_for(
            with_heartbeat(ctx, coro, interval=interval, start_msg=start_msg),
            timeout=timeout_sec,
        )
    except asyncio.TimeoutError:
        return {"ok": False, "error": f"timed out after {timeout_sec:.0f}s"}
```

- **Cancellation**: the heartbeat task is always cancelled in a
  `finally` block, so even if `coro` raises, no stray progress messages
  land after the tool call returns.
- **`ctx` can be `None`**: `_safe_report_progress` guards the
  `ctx.report_progress` call so unit tests (which pass `ctx=None`) do
  not have to mock a full context object.
- **Timeout shape**: callers that want to distinguish "timed out" from
  "runtime error" should check `result.get("ok") is False and "timed
  out" in result.get("error", "")`.

---

## Error shapes

| Source | Shape |
|---|---|
| pydantic validation | MCP returns an error response; Claude re-prompts with the `extra fields not permitted` / `value_error` message. |
| pwsh subprocess non-zero exit | `{ok: false, error: "<stderr text>"}`. |
| bridge timeout (PS layer) | `{ok: false, error: "aebm-file: timed out waiting for out/<id>.json"}` surfaced verbatim. |
| handler-level timeout (`run_with_timeout`) | `{ok: false, error: "timed out after 30s"}`. |
| `ae.revert` checkpoint not found | `{ok: false, error: "checkpoint not found: <id>"}`. |
| snapshot on non-Windows | `{ok: false, error: "snapshot is Windows-only"}`. |

---

## Troubleshooting

### `/mcp` in Claude Code shows zero tools

1. Check stderr of the spawned server. The low-level MCP server prints
   handshake failures to stderr; Claude Code surfaces those in the MCP
   log panel.
2. Verify the `--directory` path in the config actually contains
   `after_effects_mcp/__main__.py`. `uv run` fails silently if the directory is
   wrong.
3. Try running the server standalone first:
   `python -m uv run python -m after_effects_mcp`. It should block on stdin; no
   output is expected. Kill it with Ctrl+C.

### `ae.exec` returns `{ok: false, error: "aebm-file: timed out ..."}`

The bridge has its own 60 s default. Raise `timeout_sec` on the MCP
call (the PS bridge sees `-TimeoutSec $timeout_sec`). If the AE plugin
is wedged (dialog, Artisan hang), no amount of timeout will help —
use `ae.snapshot` + `ae_enumerate_windows.ps1` to diagnose.

### `ae.snapshot` returns `{ok: true, bytes: 0}` or a blank PNG

- If `method: "PrintWindow"`, switch to `"DesktopCopy"`. PrintWindow
  does not capture D3D11-composited surfaces on AE 2026.
- If DesktopCopy is also blank, AE is likely occluded by another
  topmost window. The snapshot code calls `SetForegroundWindow` +
  80 ms settle, but a foreground lock from the Windows focus-stealing
  prevention can defeat that. Alt-tab to AE manually and retry.
- If `hwnd` was passed explicitly, verify it still exists. Windows
  HWNDs are recycled — a stale HWND captures whatever window now owns
  that id.

### `ae.createLayer` returns `KeyError: 'var'` in the server log

The JSX template uses `string.Template` with `${placeholder}` syntax.
If you see `KeyError`, the template text contains an un-escaped
`${something}` that is not in the substitution dict. Fix: in
`jsx_templates/*.jsx`, replace the literal `$` with `$$` to escape it
(e.g. jQuery-ish code that wrote `${x}` should be edited to read
`$${x}` since the typed handlers do not use jQuery). The shipped
templates are already escape-safe — this only bites if you add a new
template and forget.

### pydantic `extra_forbidden` error on a call

The schema uses `extra="forbid"`. Remove the offending field from the
`arguments` object, or add the field to the relevant pydantic model
in `after_effects_mcp/schemas.py` if it is a legitimate new parameter.

### `python -m uv sync` exits with code 1 but packages install fine

Known PowerShell stderr-routing cosmetic issue. The actual exit code
is 0 under cmd.exe / bash; PowerShell's default redirect drops the
`STATUS_` on piped output. Verify success by running
`python -c "import after_effects_mcp; print('ok')"` from the `mcp/` directory.

### Heartbeat never fires during a long call

- Verify the handler is actually wrapped in `run_with_timeout` /
  `with_heartbeat`. Handlers that forgot the wrapper will block
  without heartbeats (none of the shipped 24 do — but new ones
  might).
- Confirm Claude Code is the client. Other MCP clients may not
  render progress notifications, which makes the heartbeat invisible
  even though it is firing.

---

## Test coverage

```
tests/
  conftest.py              - mock_bridge fixture (replaces bridge.invoke_ae_*)
  test_schemas.py          - pydantic models, good + bad arg cases
  test_bridge.py           - pwsh arg encoding + JSON parse against mock subprocess
  test_handlers_core.py    - core handlers against mock_bridge
  test_handlers_typed.py   - typed handlers + JSX render correctness
  test_checkpoint_store.py - filesystem index unit tests (no AE dependency)
  test_snapshot.py         - ctypes signature sanity (Windows-only tests skip elsewhere)
  test_progress.py         - heartbeat cadence + cancel semantics
```

Run: `cd mcp && python -m uv run pytest -v`. Expected: tests pass in
<1 s without needing AE.

CI: `.github/workflows/build.yml` has a dedicated `python-mcp-tests`
job on `windows-2022` that installs uv + syncs + pytest. Independent
matrix from the C++ build — a Python regression cannot block the C++
job and vice versa.

### Live test layer

Opt-in end-to-end tests that drive a real AE instance through the bridge.

**Activate**: `AEBM_LIVE_TESTS=1`. Without it, every `tests/live/*.py`
test skips (autouse fixture in `tests/live/conftest.py`).

**Markers**:
- `live` — full live suite (~10 cases, ~2-3 min on warm AE)
- `live_smoke` — 3-case ping/exec/snapshot canary (<30 s)

**CI policy**: live tests are excluded from `.github/workflows/ci.yml`
via `pyproject.toml`'s `addopts = "-m 'not live and not live_smoke'"`.
Hosted runners cannot drive a GUI Adobe app. Run locally before each
release.

**Failure artifacts**: `tests/live/_artifacts/<test_name>/` collects
recent bridge stderr, last `out/<id>.json`, and a snapshot PNG when the
test failed.

**Run examples**:

```powershell
$env:AEBM_LIVE_TESTS = "1"
$env:AE_BRIDGE_ROOT  = "E:/Code/AEBMethod"
python -m uv run pytest -m live_smoke      # quick canary
python -m uv run pytest -m live            # full
```

---

## Not doing (explicit backlog)

| Item | Deferred to | Why |
|---|---|---|
| macOS `ae.snapshot` | v0.7+ | Requires CGWindowListCreateImage port. |
| HTTP/SSE transport | v0.7 | stdio is enough for single-client Claude Code. |
| Task-queue style cancel/poll | v0.7+ | Heartbeat + timeout cover current use cases. |
| Atom's marketplace/cloud 5 verbs (`create_skill`, `edit_skill`, `use_skill`, `generate_image`, `create_rig`) | v0.7+ | Depends on Atom cloud / skill marketplace; no equivalent in a local AE-only MCP. |

---

## Cross-references

- `README.md` — install + run instructions.
- [AEBM_BRIDGE.md in plugin repo](https://github.com/JUNKDOGEGROUP/BlendifyAE/blob/main/docs/development/AEBM_BRIDGE.md) — underlying file-polling protocol.
- [ATOM_INTEGRATION.md in plugin repo](https://github.com/JUNKDOGEGROUP/BlendifyAE/blob/main/docs/development/ATOM_INTEGRATION.md) — history of the Atom exit
  ramp and why the verb surface looks the way it does.
- [ATOM_MCP_CASCADE_RCA.md in plugin repo](https://github.com/JUNKDOGEGROUP/BlendifyAE/blob/main/docs/development/ATOM_MCP_CASCADE_RCA.md) — why we moved away from
  Atom's HTTP MCP.
- [scripts/viewer_snapshot.ps1 in plugin repo](https://github.com/JUNKDOGEGROUP/BlendifyAE/blob/main/scripts/viewer_snapshot.ps1) — reference implementation that
  `after_effects_mcp/snapshot.py` was ported from.
- `after_effects_mcp/checkpoint_store.py` — pure Python filesystem checkpoint index.
- `docs/superpowers/specs/2026-04-27-atommcp-parity-design.md` — full v0.7 design spec.
