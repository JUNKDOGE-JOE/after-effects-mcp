# ae-mcp Reference

Protocol-level reference for the `ae-mcp` MCP server and CEP bridge.

## Quick Facts

| Item | Value |
|---|---|
| MCP transport | stdio JSON-RPC 2.0 |
| AE transport | simple HTTP RPC to `127.0.0.1:11488` |
| Entry point | `python -m ae_mcp` |
| Backend | `AE_MCP_BACKEND=ae-mcp` |
| Plugin URL | `AE_MCP_PLUGIN_URL=http://127.0.0.1:11488` |
| Handler count | 30 verbs, filtered by backend `supported_verbs()` |
| Skill storage | `~/.ae-mcp/skills/<name>.json` |
| Preview output | `%TEMP%/ae_mcp_previews/<session>/...png` unless `out_dir` is set |
| Checkpoint store | `%TEMP%/aebm_checkpoints/<basename>/<id>.aep + .json` |
| Current non-live verification | `152 passed, 20 deselected` |
| Current live verification | `20 passed` with AE open and panel green |

## Architecture

```text
MCP client
  -> ae_mcp.server
  -> ae-mcp backend package
  -> HTTP 127.0.0.1:11488
  -> CEP panel Node host
  -> CSInterface.evalScript
  -> After Effects ExtendScript
```

## Verb Reference

All verbs return JSON with `ok: bool` and either result fields or `error`.

| Verb | Args | Notes |
|---|---|---|
| `ae.init` | `refresh_only?` | bootstrap snapshot |
| `ae.overview` | none | comp/item summary |
| `ae.layers` | `comp_id?` | layer list |
| `ae.readProps` | `code` | run read-only JSX |
| `ae.exec` | `code`, `undo_group_name?`, `checkpoint_label?`, `timeout_sec?` | run JSX |
| `ae.checkpoint` | `action`, `label?`, `limit?` | save/list `.aep` snapshots |
| `ae.revert` | `checkpoint_id`, `branch_before_revert?` | reopen a saved snapshot |
| `ae.snapshot` | `out_path?`, `hwnd?`, `main_window?`, `method?` | diagnostic desktop/window capture |
| `ae.previewFrame` | `comp_id?`, `time?`, `times?`, `out_dir?`, `include_base64?`, `scale?` | fast AE viewer capture PNG(s) |
| `ae.applyEffect` | `comp_id?`, `layer_id`, `effect_match_name` | add effect by matchName |
| `ae.createLayer` | `type`, `name`, etc. | solid/text/shape/null/adjustment/camera/light |
| `ae.setProperty` | `layer_id`, `path`, `value`, `at_time?` | write property |
| `ae.moveLayer` | `layer_id`, `to_index` | reorder |
| `ae.selectLayers` | `layer_ids` | select all/none/by index |
| `ae.setTime` | `comp_id?`, `time` | set comp time |
| `ae.getTime` | `comp_id?` | read comp time |
| `ae.getProperties` | `comp_id?`, `layer_ids`, `query`, `offset?`, `limit?` | search properties |
| `ae.scanPropertyTree` | `comp_id?`, `layer_id`, `max_depth?`, `include_values?` | property tree DFS |
| `ae.inspectPropertyCapabilities` | `comp_id?`, `layer_id`, `path` | mutation capability probe |
| `ae.getExpressions` | `comp_id`, `layer_ids?`, `prop?`, `max_results?` | read expressions |
| `ae.validateExpressions` | `comp_id?`, `layer_ids?`, `prop?`, `sample_times?`, `max_results?` | force-evaluate expressions and report errors |
| `ae.getKeyframes` | `comp_id?`, `layer_id`, `path` | keyframe data |
| `ae.searchProject` | `query`, `scope?`, `limit?` | project search |
| `ae.skillList` | `include_templates?` | list local reusable skills |
| `ae.skillCreate` | `name`, `description?`, `template_type?`, `template`, `args_schema?`, `overwrite?` | create a skill |
| `ae.skillEdit` | `name`, fields to update | edit a skill |
| `ae.skillDelete` | `name` | delete a skill |
| `ae.skillUse` | `name`, `args?`, `execute?` | render or execute a JSX skill |
| `ae.createRig` | `comp_id?`, `target_layer_id`, `rig_type`, `name?`, `options?` | controller/effect/preset rig workflows |
| `ae.ping` | `expect?` | bridge handshake |

## `ae.previewFrame`

`times` wins over `time`; if neither is supplied, the active comp's current time is previewed. The default response returns file paths. Set `include_base64=true` when the MCP client needs inline PNG bytes.

The implementation asks AE to open the target comp in the viewer, sets the requested time, then captures the visible AE window through the installed snapshotter. This matches fast Atom/FX Console-style visual preview: it avoids Render Queue, `saveFrameToPng`, overwrite prompts, and modal render failures. It does not guarantee comp-native dimensions or alpha.

Use a future `ae.renderFrame`-style API for true rendered frames. `ae.snapshot` remains the lower-level diagnostic capture primitive.

## Atom-Parity Status

Implemented and live-verified:

- CEP panel to AE bridge
- 30 public `ae.*` verbs
- read/mutate/search/checkpoint/revert workflows
- fast viewer preview via `ae.previewFrame`
- persistent Python-side skill system
- MVP rig creation via `ae.createRig`
- expression validation via `ae.validateExpressions`

Remaining gaps:

- precise Composition Viewer crop for `ae.previewFrame`
- deeper `createRig` workflows, especially Puppet pin null binding
- bundled skill library and import/export UX
- signed ZXP clean-install validation
- optional future single-install MCP-over-HTTP transport

## Skill System

Skills live in `~/.ae-mcp/skills/<name>.json`:

```json
{
  "name": "wiggle-position",
  "description": "Add wiggle expression",
  "template_type": "jsx",
  "template": "wiggle(${freq}, ${amp})",
  "args_schema": {
    "freq": {"type": "number", "default": 2},
    "amp": {"type": "number", "default": 30}
  }
}
```

`ae.skillUse` renders `${arg}` placeholders. JSX skill arguments are JSON-encoded before substitution.

## Expression Validation

Use `ae.validateExpressions` after any workflow that writes expressions and before visual review. It scans matching expression properties, calls `valueAtTime()` at the requested sample times, and returns:

```json
{
  "ok": true,
  "valid": false,
  "checked": 1,
  "errors": [
    {
      "layerId": 1,
      "propPath": "Text/Source Text",
      "expressionError": "..."
    }
  ]
}
```

This is intended to catch problems such as locale-sensitive effect references before the user sees the project.

## `ae.createRig`

MVP rig types:

| Type | Behavior |
|---|---|
| `transform_controller` | creates a null controller and expression-links transform properties |
| `effect_controls` | creates a controller with Slider/Angle/Checkbox/Color controls and wires target properties |
| `puppet_pin_nulls` | skips gracefully when no Puppet effect exists |
| `apply_preset` | applies a user-supplied `.ffx` preset path |

The MVP does not generate arbitrary binary `.ffx` files.

## Live Tests

```powershell
$env:AE_MCP_LIVE_TESTS = "1"
$env:AE_MCP_BACKEND = "ae-mcp"
$env:AE_MCP_PLUGIN_URL = "http://127.0.0.1:11488"
uv run pytest packages/core/tests/live -o addopts='' -vv
```

## Credits And Licensing

ae-mcp is an independent implementation inspired by Atom-style AE operation coverage and FX Console-style fast viewer preview behavior. It does not vendor Atom, FX Console, or AtomX code.

The project code is MIT licensed. Adobe's `plugin/client/CSInterface.js` is included with its upstream Adobe license notice intact. Other dependencies keep their upstream licenses.
