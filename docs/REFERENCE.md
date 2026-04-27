# ae-mcp 参考 / Reference

## 中文

### 快速信息

| 项目 | 值 |
|---|---|
| MCP transport | stdio JSON-RPC 2.0 |
| AE transport | HTTP RPC, `127.0.0.1:11488` |
| 入口 | `python -m ae_mcp` |
| Backend | `AE_MCP_BACKEND=ae-mcp` |
| Plugin URL | `AE_MCP_PLUGIN_URL=http://127.0.0.1:11488` |
| Handler count | 30 verbs，按 backend `supported_verbs()` 过滤 |
| Skill storage | `~/.ae-mcp/skills/<name>.json` |
| Preview output | 默认 `%TEMP%/ae_mcp_previews/<session>/...png`，可用 `out_dir` 覆盖 |
| Checkpoint store | `%TEMP%/ae_mcp_checkpoints/<basename>/<id>.aep + .json` |
| 非 live 验证 | `152 passed, 20 deselected` |
| live 验证 | AE 打开且面板绿灯时 `20 passed` |

### 架构

```text
MCP client
  -> ae_mcp.server
  -> ae-mcp backend package
  -> HTTP 127.0.0.1:11488
  -> CEP panel Node host
  -> CSInterface.evalScript
  -> After Effects ExtendScript
```

### Verb Reference

所有工具返回 JSON：成功时 `ok: true`，失败时 `ok: false` 和 `error`。

| Verb | Args | 说明 |
|---|---|---|
| `ae.init` | `refresh_only?` | 初始化/刷新项目状态 |
| `ae.overview` | none | 项目和 comp 概览 |
| `ae.layers` | `comp_id?` | 获取图层列表 |
| `ae.readProps` | `code` | 执行只读 JSX |
| `ae.exec` | `code`, `undo_group_name?`, `checkpoint_label?`, `timeout_sec?` | 执行 JSX |
| `ae.checkpoint` | `action`, `label?`, `limit?` | 创建/列出 `.aep` checkpoint |
| `ae.revert` | `checkpoint_id`, `branch_before_revert?` | 回滚到 checkpoint |
| `ae.snapshot` | `out_path?`, `hwnd?`, `main_window?`, `method?` | 诊断截图 |
| `ae.previewFrame` | `comp_id?`, `time?`, `times?`, `out_dir?`, `include_base64?`, `scale?` | 快速 viewer capture |
| `ae.applyEffect` | `comp_id?`, `layer_id`, `effect_match_name` | 按 matchName 添加效果 |
| `ae.createLayer` | `type`, `name`, etc. | 创建 solid/text/shape/null/adjustment/camera/light |
| `ae.setProperty` | `layer_id`, `path`, `value`, `at_time?` | 写属性 |
| `ae.moveLayer` | `layer_id`, `to_index` | 调整图层顺序 |
| `ae.selectLayers` | `layer_ids` | 选择全部/无/指定图层 |
| `ae.setTime` | `comp_id?`, `time` | 设置 comp 时间 |
| `ae.getTime` | `comp_id?` | 读取 comp 时间 |
| `ae.getProperties` | `comp_id?`, `layer_ids`, `query`, `offset?`, `limit?` | 搜索属性 |
| `ae.scanPropertyTree` | `comp_id?`, `layer_id`, `max_depth?`, `include_values?` | 扫描属性树 |
| `ae.inspectPropertyCapabilities` | `comp_id?`, `layer_id`, `path` | 检查属性可变更能力 |
| `ae.getExpressions` | `comp_id`, `layer_ids?`, `prop?`, `max_results?` | 读取表达式 |
| `ae.validateExpressions` | `comp_id?`, `layer_ids?`, `prop?`, `sample_times?`, `max_results?` | 强制求值表达式并返回错误 |
| `ae.getKeyframes` | `comp_id?`, `layer_id`, `path` | 读取关键帧 |
| `ae.searchProject` | `query`, `scope?`, `limit?` | 搜索项目 |
| `ae.skillList` | `include_templates?` | 列出本地 skill |
| `ae.skillCreate` | `name`, `description?`, `template_type?`, `template`, `args_schema?`, `overwrite?` | 创建 skill |
| `ae.skillEdit` | `name`, update fields | 编辑 skill |
| `ae.skillDelete` | `name` | 删除 skill |
| `ae.skillUse` | `name`, `args?`, `execute?` | 渲染或执行 skill |
| `ae.createRig` | `comp_id?`, `target_layer_id`, `rig_type`, `name?`, `options?` | 创建 controller/effect/preset rig |
| `ae.ping` | `expect?` | bridge 握手 |

### `ae.previewFrame`

`times` 优先于 `time`；两者都不传时使用当前 comp 时间。默认返回文件路径，`include_base64=true` 时返回 base64。

当前实现会让 AE 打开目标 comp、设置时间，然后通过 snapshotter 抓取可见 AE 窗口/viewer。它接近 Atom/FX Console 风格的即时预览：不走 Render Queue、不调用 `saveFrameToPng`、不触发覆盖文件弹窗。它不保证 comp 原始尺寸或 alpha。

真实渲染帧应由未来的 `ae.renderFrame` 类 API 承担。`ae.snapshot` 仍然是底层诊断截图。

### Skill System

Skill 存储在 `~/.ae-mcp/skills/<name>.json`：

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

`ae.skillUse` 渲染 `${arg}` 占位符。JSX skill 参数会先 JSON encode 再替换。

### 表达式校验

写表达式后，视觉检查前应运行 `ae.validateExpressions`。它会扫描表达式属性，按 sample time 调用 `valueAtTime()`，并返回 `expressionError` 和求值错误。

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

这个工具用于提前发现本地化敏感引用等问题，例如中文 AE 下 `effect("Value")("Slider")` 失效，应改用 `effect("Value")(1)`。

### `ae.createRig`

MVP rig 类型：

| Type | 行为 |
|---|---|
| `transform_controller` | 创建 null controller，并用表达式连接 transform 属性 |
| `effect_controls` | 创建带 Slider/Angle/Checkbox/Color controls 的 controller，并连接目标属性 |
| `puppet_pin_nulls` | 没有 Puppet pin 时 graceful skip |
| `apply_preset` | 应用用户提供的 `.ffx` preset |

MVP 不生成任意二进制 `.ffx` 文件。

### Atom-Parity 状态

已实现并 live 验证：

- CEP panel 到 AE bridge
- 30 个公开 `ae.*` verbs
- read/mutate/search/checkpoint/revert
- `ae.previewFrame` 快速 viewer preview
- Python 侧持久化 skill system
- `ae.createRig` MVP
- `ae.validateExpressions` 表达式校验

剩余差距：

- `ae.previewFrame` 还不是精准 Composition Viewer crop
- `ae.createRig` 需要更深的 Puppet pin 和 preset workflow
- skill library 和 import/export UX 还未提供
- signed ZXP clean install 还需验证
- 单安装 MCP-over-HTTP transport 可作为未来方向

### 授权与借鉴

ae-mcp 是独立实现，参考了 Atom 风格 AE 操作面和 FX Console 风格即时预览体验，但不 vendoring Atom、FX Console 或 AtomX 代码。

项目代码使用 MIT License。Adobe `plugin/client/CSInterface.js` 保留其上游许可声明。其他依赖遵循其各自上游许可证。

## English

### Quick Facts

| Item | Value |
|---|---|
| MCP transport | stdio JSON-RPC 2.0 |
| AE transport | HTTP RPC, `127.0.0.1:11488` |
| Entry point | `python -m ae_mcp` |
| Backend | `AE_MCP_BACKEND=ae-mcp` |
| Plugin URL | `AE_MCP_PLUGIN_URL=http://127.0.0.1:11488` |
| Handler count | 30 verbs, filtered by backend `supported_verbs()` |
| Skill storage | `~/.ae-mcp/skills/<name>.json` |
| Preview output | `%TEMP%/ae_mcp_previews/<session>/...png` unless `out_dir` is set |
| Checkpoint store | `%TEMP%/ae_mcp_checkpoints/<basename>/<id>.aep + .json` |
| Current non-live verification | `152 passed, 20 deselected` |
| Current live verification | `20 passed` with AE open and panel green |

### Architecture

```text
MCP client
  -> ae_mcp.server
  -> ae-mcp backend package
  -> HTTP 127.0.0.1:11488
  -> CEP panel Node host
  -> CSInterface.evalScript
  -> After Effects ExtendScript
```

### Verb Reference

All tools return JSON with `ok: true` on success, or `ok: false` plus `error` on failure.

| Verb | Args | Notes |
|---|---|---|
| `ae.init` | `refresh_only?` | initialize/refresh project state |
| `ae.overview` | none | project and comp overview |
| `ae.layers` | `comp_id?` | list layers |
| `ae.readProps` | `code` | run read-only JSX |
| `ae.exec` | `code`, `undo_group_name?`, `checkpoint_label?`, `timeout_sec?` | run JSX |
| `ae.checkpoint` | `action`, `label?`, `limit?` | create/list `.aep` checkpoints |
| `ae.revert` | `checkpoint_id`, `branch_before_revert?` | revert to a checkpoint |
| `ae.snapshot` | `out_path?`, `hwnd?`, `main_window?`, `method?` | diagnostic screenshot |
| `ae.previewFrame` | `comp_id?`, `time?`, `times?`, `out_dir?`, `include_base64?`, `scale?` | fast viewer capture |
| `ae.applyEffect` | `comp_id?`, `layer_id`, `effect_match_name` | add effect by matchName |
| `ae.createLayer` | `type`, `name`, etc. | create solid/text/shape/null/adjustment/camera/light |
| `ae.setProperty` | `layer_id`, `path`, `value`, `at_time?` | write property |
| `ae.moveLayer` | `layer_id`, `to_index` | reorder layer |
| `ae.selectLayers` | `layer_ids` | select all/none/by index |
| `ae.setTime` | `comp_id?`, `time` | set comp time |
| `ae.getTime` | `comp_id?` | read comp time |
| `ae.getProperties` | `comp_id?`, `layer_ids`, `query`, `offset?`, `limit?` | search properties |
| `ae.scanPropertyTree` | `comp_id?`, `layer_id`, `max_depth?`, `include_values?` | scan property tree |
| `ae.inspectPropertyCapabilities` | `comp_id?`, `layer_id`, `path` | inspect mutation capability |
| `ae.getExpressions` | `comp_id`, `layer_ids?`, `prop?`, `max_results?` | read expressions |
| `ae.validateExpressions` | `comp_id?`, `layer_ids?`, `prop?`, `sample_times?`, `max_results?` | force-evaluate expressions and report errors |
| `ae.getKeyframes` | `comp_id?`, `layer_id`, `path` | read keyframes |
| `ae.searchProject` | `query`, `scope?`, `limit?` | search project |
| `ae.skillList` | `include_templates?` | list local skills |
| `ae.skillCreate` | `name`, `description?`, `template_type?`, `template`, `args_schema?`, `overwrite?` | create skill |
| `ae.skillEdit` | `name`, update fields | edit skill |
| `ae.skillDelete` | `name` | delete skill |
| `ae.skillUse` | `name`, `args?`, `execute?` | render or execute skill |
| `ae.createRig` | `comp_id?`, `target_layer_id`, `rig_type`, `name?`, `options?` | create controller/effect/preset rigs |
| `ae.ping` | `expect?` | bridge handshake |

### `ae.previewFrame`

`times` wins over `time`; if neither is supplied, the current comp time is previewed. The default response returns file paths. Set `include_base64=true` to include inline image bytes.

The implementation opens the target comp, sets the requested time, then captures the visible AE window/viewer through the installed snapshotter. It matches Atom/FX Console-style instant preview: no Render Queue, no `saveFrameToPng`, and no overwrite prompt. It does not guarantee native comp dimensions or alpha.

True rendered frames should be handled by a future `ae.renderFrame`-style API. `ae.snapshot` remains the lower-level diagnostic capture primitive.

### Skill System

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

### Expression Validation

After writing expressions and before visual review, run `ae.validateExpressions`. It scans expression properties, calls `valueAtTime()` at sample times, and returns `expressionError` plus evaluation errors.

This catches locale-sensitive references before users see the project. For example, `effect("Value")("Slider")` can fail in localized AE; prefer `effect("Value")(1)`.

### `ae.createRig`

MVP rig types:

| Type | Behavior |
|---|---|
| `transform_controller` | creates a null controller and expression-links transform properties |
| `effect_controls` | creates a controller with Slider/Angle/Checkbox/Color controls and wires target properties |
| `puppet_pin_nulls` | skips gracefully when no Puppet pins exist |
| `apply_preset` | applies a user-supplied `.ffx` preset |

The MVP does not generate arbitrary binary `.ffx` files.

### Atom-Parity Status

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
- deeper Puppet pin and preset workflows for `ae.createRig`
- skill library and import/export UX
- signed ZXP clean install validation
- optional future single-install MCP-over-HTTP transport

### Credits And Licensing

ae-mcp is an independent implementation inspired by Atom-style AE operation coverage and FX Console-style instant preview behavior. It does not vendor Atom, FX Console, or AtomX code.

Project code is MIT licensed. Adobe `plugin/client/CSInterface.js` keeps its upstream license notice. Other dependencies keep their upstream licenses.
