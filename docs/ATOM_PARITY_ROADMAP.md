# AEMCP → Atom Parity: Optimization Roadmap

Synthesized from five per-area audits, with load-bearing facts re-verified against the codebase (`runtime.jsx`, `server.py`, `handlers/core.py` `_run_exec`, `jsx_result.py`, `checkpoint_store.py`). The plan favors changes that ship safely **without a live AE** (pytest + JSX-render-string token assertions) and respects two project-specific hazards from memory: (a) `ae_exec` silently no-ops when `undo_group_name`/`checkpoint_label` are misused, and (b) a thrown script error mid checkpoint/revert can delete unrelated layers — so **JSX must never throw**.

## Verified foundations (drive the ordering)
- `plugin/jsx/runtime.jsx` is **JSON-polyfill-only** (33 lines, gated on `typeof JSON==='undefined'`). No Array/Object polyfills, no domain helpers. It loads once into the persistent ES3 engine — so anything added there is free for all `ae.exec`/`ae.readProps` user code. **This is why polyfills+helpers rank first.**
- `server.py::_format_result` (L48-49) **passes a `str` return through verbatim**, so compact text needs **no wire-boundary change** — a pure standalone Python win.
- `Server("ae")` is built with **no `instructions=` arg** (L62), though mcp 1.27.0 plumbs it to clients at handshake — the cheapest always-on guidance channel is empty.
- `_run_exec` checkpoint **leak confirmed**: the `_resolve_project_path` probe (L172) and `dst.parent.mkdir` (L178) are **outside** the checkpoint `try/except` (begins L181) — a hung probe or unwritable store aborts the user's edit.
- `CheckpointStore.__init__` does eager `root.mkdir` (L49); `list_checkpoints` uses unguarded `d.glob` / `d.exists()` (L132-135) — confirmed startup-crash + hang risk on a dead/locked store dir.

## Per-area gaps (summary)

**1. ExtendScript runtime + `ae.exec` envelope.** No ES3 Array/Object polyfills (agent-idiomatic JS throws); no shared path/matchName resolver (copy-pasted `split('/')` loops in `set_property.jsx`, `inspect_property_capabilities.jsx`); `ae.exec` returns only the bare last-expr value — no touched-paths, no failed-mutation attribution, no auto expression-error report; no matchName resolver despite scan/getProperties emitting matchPaths.

**2. Read-verb output format.** Every read verb is forced to verbose JSON at the dispatch boundary; no `format`/`compact` flag anywhere; `ae.layers` has **zero pagination** and omits `type`/parent; `scanPropertyTree` repeats 7 keys per node; `getProperties` pages internally but still emits verbose objects.

**3. Discovery verbs.** `scanPropertyTree` lacks path subtree-root, query filter, and paging (unbounded dump); `getKeyframes.path` is **required** (no scan mode) and single-layer; `getProperties` ranking is near-trivial; bare matchNames with no `#ordinal` so duplicate siblings aren't addressable.

**4. previewFrame.** Screen-grab of the whole AE window, not a render: `scale` is a no-op; no auto-sample/range/count, no maxWidth downscale, no contact-sheet grid, no diff, no comp-space ROI (no comp→pixel map exists); frame `width/height` are window pixels.

**5. createRig.** 4 fixed rig_types; `options:Dict[str,Any]` is opaque in `tools/list`; only slider/angle/checkbox/color; always spawns a new null; every control **must** be wired (4 transform paths only, unknown paths fail **silently**); no defaults/options metadata; no groups; N separate effects not one named pseudo-effect.

**6. init/checkpoint.** `ae.init` returns no guidance and no active_comp_state (bare `activeItemId`); `refresh_only` is a dead param; MCP server instructions unused; checkpoint best-effort guarantee leaks; store construction + listing are fragile. (Genuine advantage: whole-project revert is structurally all-or-nothing — worth keeping + documenting.)

## Ranked roadmap

| # | Title | Area | Lev | Eff | Risk | Depends on |
|---|-------|------|-----|-----|------|-----------|
| 1 | ES3 polyfills + AEMCP helper namespace in `runtime.jsx` | runtime | H | S | L | — |
| 2 | `render_text.py` module + `format:'json'\|'text'` flag | read-format | H | M | L | — |
| 3 | Static guidance via `Server(instructions=...)` | init/guidance | H | S | L | 1 |
| 4 | Non-blocking auto-checkpoint in `ae.exec` (wrap probe+mkdir) | checkpoint | H | S | L | — |
| 5 | `ae.layers` pagination + type/parent | read-format | H | S | L | 2 |
| 6 | Enrich `ae.init` with active_comp_state + `refresh_only` | init/guidance | H | M | L | 3 |
| 7 | `maxWidth` downscale (make `scale` real) via Pillow | previewFrame | H | S | L | — |
| 8 | Model createRig controls in pydantic (drop `Dict[str,Any]`) | createRig | H | S | L | — |
| 9 | Harden `CheckpointStore` (lazy mkdir + guarded listing) | checkpoint | M | M | M | — |
| 10 | `scanPropertyTree`: path root + query + paging | discovery | H | M | L | 1 |
| 11 | SCAN mode for `getKeyframes` (path optional) | discovery | H | M | L | 1 |
| 12 | Contact-sheet grid for >2 previewFrames | previewFrame | H | M | L | 7 |
| 13 | Richer `ae.exec` envelope (opt-in touched/failed/expr-errors) | exec envelope | H | M | M | 1, 14 |
| 14 | Self-attributing `AEMCP.set(...)` touched-path buffer | runtime | M | S | L | 1 |
| 15 | createRig `control_panel` native builder (7 types + defaults) | createRig | H | M | M | 8 |
| 16 | Auto-sample previewFrame by duration + range + count | previewFrame | H | M | L | 7, 12 |
| 17 | Compact flatten renderers (scan/props/keyframes) | read-format | M | S | L | 2 |
| 18 | Refactor template path-walk → `AEMCP.propByPath` | runtime | M | S | L | 1 |
| 19 | Strengthen `getProperties` ranking | discovery | M | S | L | — |
| 20 | createRig wiring map + surface unwired/failed paths | createRig | M | S | L | 15 |
| 21 | Document/preserve whole-project revert as a guarantee | checkpoint | M | S | L | 3 |
| 22 | previewFrame diff mode (Pillow `ImageChops`) | previewFrame | M | S | L | 7 |
| 23 | Shared ES3 query/ordinal matchName resolver in `runtime.jsx` | runtime | M | M | M | 1, 10, 11 |
| 24 | createRig one-level group nesting (ADBE Group) | createRig | M | M | H | 15 |
| 25 | previewFrame ROI (window-pixel, NOT comp-space) | previewFrame | L | S | M | 7 |

## Top quick wins
1. **Item 1** — ES3 polyfills + `AEMCP` namespace: highest leverage, additive with `if(!x)` guards, free for all user JSX, token-asserted unit tests. The foundation.
2. **Item 2** — Compact text renderer + `format` flag: `_format_result` already passes `str` through, so no boundary/JSX change; default `json` keeps tests green; ~2.9x savings on `ae.layers`.
3. **Item 3** — `Server(instructions=...)`: one arg, already plumbed by the SDK; mirrors Atom's biggest differentiator at zero per-call cost.
4. **Item 4** — Non-blocking checkpoint: surgical fix for a confirmed leak; monkeypatch-testable.
5. **Item 5** — `ae.layers` paging + type/parent: small JSX slice + two fields; caps unbounded replies, feeds item 2's `Page:` line.
6. **Item 8** — Type createRig controls: makes the verb self-describing in `tools/list` (Atom's core strength) with no JSX/AE change; de-risks item 15.

## Cautions
- **Build order is load-bearing.** `runtime.jsx` helpers (1) → `AEMCP.set` buffer (14) → richer exec envelope (13): the envelope's `touchedPaths` come from the buffer; build the envelope first and you ship an empty feature. `render_text.py` (2) before the flatten renderers (17). RigControl schema (8) before `control_panel` (15) before wiring (20) before group nesting (24).
- **Two things are infeasible — scope honestly.** (a) A true before/after `.aep` diff for the exec envelope is expensive over the string bridge and unsafe given the broken checkpoint store — capture a cheap structured signal instead. (b) Comp-coordinate ROI: `capture(main_window=True)` grabs the whole window via `GetWindowRect` with no comp→screen pixel map, so item 25 can only crop the screenshot in window pixels — label it loudly; real comp ROI needs the viewer child HWND + zoom math (separate future work).
- **`runtime.jsx` is the blast radius.** It loads once at startup, so a syntax error breaks every verb. Keep additions strictly ES3 (`var` only, no arrow/const/template-literals/Array methods), guard polyfills with `if(!x)`, guard the shared matcher (23) with per-template inline fallbacks for stale panels, and add a live smoke test. This is why item 23 is risk=medium despite being mostly cleanup.
- **Never throw from JSX** (recorded hazard: a mid-checkpoint/revert throw can delete layers). All new fallible JSX — `setPropertyParameters` on pre-2019.1 AE, ADBE Group nesting, the generic wiring walker, control defaults — must `try/catch` and return `{ok,...,note}`, mirroring the existing `checkpointSkipped` pattern. Surface unwired/failed paths (item 20) instead of dropping them silently.
- **Back-compat or you break the suite.** Every new field defaults to today's behavior (`format='json'`, `report=False`, `offset=0`, `path=None`, `max_width=None`). Existing pytest asserts on dicts and full JSON shapes (incl. keyframe easing tangents) — add keys, never remove.
- **Live verification is read-only here** (down bridge + broken store). Treat JSX-mutation behavior as unverifiable on this machine: prefer faithful extractions over redesigns, preserve recognizable string tokens for render-token tests, and reserve `tests/live/` for the few items that truly need it (createRig control types).