# ae-mcp 参考 / Reference

## 中文

### 快速信息

| 项目 | 值 |
|---|---|
| MCP transport | stdio JSON-RPC 2.0 |
| AE transport | HTTP RPC, `127.0.0.1:11488` |
| 入口 | `ae-mcp` |
| Backend | `AE_MCP_BACKEND=ae-mcp` |
| Plugin URL | `AE_MCP_PLUGIN_URL=http://127.0.0.1:11488` |
| Handler count | 32 verbs，按 backend `supported_verbs()` 过滤 |
| Skill storage | `~/.ae-mcp/skills/<name>.json` |
| Preview output | 默认位于操作系统临时目录的 `ae_mcp_previews/<session>/...png`，可用 `out_dir` 覆盖 |
| Checkpoint store | 操作系统临时目录下的 `ae_mcp_checkpoints/<basename>/<id>.aep + .json` |

### v0.9.1 平台与分发契约

v0.9.1 当前是未发布候选；下面是最终 RC 契约，不表示 helper、provider route、Tool Library 或实机矩阵已经验收：

| 平台 | 安装资产 | 审计载荷 |
|---|---|---|
| macOS 14+ Apple Silicon arm64 | `ae-mcp-panel-v0.9.1-macos-arm64.dmg` | `ae-mcp-panel-v0.9.1-macos-arm64.zxp` |
| Windows 11 24H2+ x64 | `ae-mcp-panel-v0.9.1-windows-x64.zxp` | 同一个 ZXP |

两端的最终目标均为 AE 25.x–26.x（CEP `[25.0,26.9]`），并由 `artifact-manifest-v0.9.1.json` 绑定同一个 candidate SHA。在最终契约中，Panel 将从资产内离线安装 runtime，普通用户不依赖系统 Python/Node/uv。Claude Code CLI、Codex CLI 与 ZCode CLI/app-server 都是对应 AI 通道的**可选**依赖，不是 core 前置。Provider 配置与凭据不可导出；signed helper、RuntimeManager 和系统凭据库的最终实现仍受明确审批与 Phase 0 证据门禁。

### 环境变量

| 变量 | 作用 | 默认值 |
|---|---|---|
| `AE_MCP_BACKEND` | 选择后端 entry point 名称（bridge 注册为 `ae-mcp`） | 无（单后端时自动选用） |
| `AE_MCP_PLUGIN_URL` | bridge 后端连接 AE 面板 HTTP RPC 的地址 | `http://127.0.0.1:11488` |
| `AE_MCP_SKILL_DIR` | skill 存储目录（`ae.skill*` 读写的 `<name>.json`） | `~/.ae-mcp/skills` |
| `AE_MCP_CHECKPOINT_KEEP` | 每个工程保留的 checkpoint 数量上限（旧的自动清理，最小 1） | `50` |

### 面板内嵌 provider 配置

- 面板设置页以 Claude / Codex / ZCode 三路后端组织内嵌 AI 服务，每路后端显示凭证通道卡，并可自动选择或手动锁定可用通道。
- Claude 的 API 直连通道取代旧 BYOK 后端：官方 Anthropic API 或 Anthropic-compatible provider 都通过 Provider 管理器配置，`/v1/messages` 与 `/v1/models` 接到对应 Base URL。
- Codex 后端默认走 `codex app-server` + Codex CLI 登录态；也可继承 `~/.codex/config.toml` 的自定义 model provider，或使用 Provider 管理器中的 OpenAI-compatible provider。
- Provider 管理器把 OpenAI-compatible 与 Anthropic provider 保存在本机 `~/.ae-mcp/providers.json`，并支持 `/v1/models` 探测模型列表。显式自定义 provider 优先于继承配置。
- 自定义模型 ID 会插入对应通道的模型列表首位，作为默认模型；清空后回到探测到的模型列表。

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
| `ae.status` | none | 检查 backend 选择、已安装 backend 与 snapshotter 状态 |
| `ae.diagnose` | none | 端到端检查 host、Python 握手、token 与 AE 响应 |
| `ae.overview` | none | 项目和 comp 概览 |
| `ae.layers` | `comp_id?`, `offset?`, `limit?`, `format?` | 获取图层列表（分页 + 可选紧凑文本） |
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
| `ae.createRig` | `comp_id?`, `target_layer_id`, `rig_type`, `name?`, `options?`, `controls?` | 创建 controller/effect/preset rig |
| `ae.ping` | `expect?` | bridge 握手 |

### `ae.layers`

默认一次返回**全部**图层（与旧行为兼容）。分页与紧凑输出均为可选：

| 参数 | 说明 |
|---|---|
| `offset?` | 0-based 起始下标，默认 `0` |
| `limit?` | 返回上限；`0`（默认）表示全部 |
| `format?` | `json`（默认，结构化）或 `text`（紧凑分页表，约为 JSON 的 1/3 token） |

每个图层含 `id / name / type / enabled / inPoint / outPoint / isThreeD / hasParent / parent`。
`type` 为 `camera/light/text/shape/null/adjustment/solid/footage/av` 之一；`parent` 为父层名（无则 `null`），`hasParent` 为布尔。
返回 envelope 含 `total / offset / limit / returned / hasMore`，便于分页。

### 运行时 helper（`ae.exec` / `ae.readProps`）

面板启动时会把一组 helper 载入持久 ExtendScript 引擎，agent 编写的 JSX 可直接调用。所有 helper「永不抛异常」——坏输入返回 `null`：

| Helper | 作用 |
|---|---|
| `AEMCP.compById(id)` | 按 item id 取 CompItem（未知 id 返回 `null`，不抛异常） |
| `AEMCP.activeComp()` | 当前活动 comp，或 `null` |
| `AEMCP.layerById(comp, idx)` | 按 1-based 下标取图层 |
| `AEMCP.propByPath(root, "Transform/Position")` | 按显示名路径解析属性 |
| `AEMCP.propByMatchPath(root, "ADBE Transform Group#1/ADBE Position#1")` | 按 matchName 路径（支持 `#序号`）解析属性 |

同时为经典引擎补齐 ES3 的 Array/Object polyfill（`indexOf/map/filter/...`、`Object.keys/...`），在 AE 2026 现代引擎上自动 no-op。

`ae.exec` 的自动 checkpoint 是**非阻塞**的：探测/快照失败或超时会降级为返回结果里的 `checkpointSkipped` 说明，绝不中断你的编辑。多语句脚本在设置 undo group 时也会完整执行。

### `ae.previewFrame`

`times` 优先于 `time`；两者都不传时使用当前 comp 时间。默认返回文件路径，`include_base64=true` 时返回 base64。

当前实现会让 AE 打开目标 comp、设置时间，然后优先调用 `CompItem.saveFrameToPng` 写出合成帧 PNG。这个路径不依赖可见窗口，不会把 AE 面板、前景遮挡窗口或桌面像素写进 preview。若当前 AE 版本或工程状态无法写出 PNG，才回退到 snapshotter 抓取可见 viewer，并在返回帧里标记 `source: "viewer"`。

`source: "comp"` 表示拿到的是合成帧像素；`source: "viewer"` 表示使用了兼容 fallback。`ae.snapshot` 仍然是底层诊断截图。

默认输出目录是操作系统临时目录下的 `ae_mcp_previews/<session>/`。服务进程内首次使用默认目录时会清理超过 24 小时未更新的旧 session 目录；显式传入 `out_dir` 时不做清理，调用方负责管理该目录。

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

`effect_controls` 支持用类型化的 `controls` 声明（优先于手写的 `options['controls']`）：每项为 `{name, type, property}`，`type` ∈ `slider/angle/checkbox/color`，`property` 为要驱动的目标属性显示名路径。

MVP 不生成任意二进制 `.ffx` 文件。

### Atom-Parity 状态

以下是 v0.9.0 历史基线曾覆盖的能力清单，不是 v0.9.1 双平台或四格实机验收证据：

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
| Entry point | `ae-mcp` |
| Backend | `AE_MCP_BACKEND=ae-mcp` |
| Plugin URL | `AE_MCP_PLUGIN_URL=http://127.0.0.1:11488` |
| Handler count | 32 verbs, filtered by backend `supported_verbs()` |
| Skill storage | `~/.ae-mcp/skills/<name>.json` |
| Preview output | `ae_mcp_previews/<session>/...png` in the operating-system temporary directory unless `out_dir` is set |
| Checkpoint store | `ae_mcp_checkpoints/<basename>/<id>.aep + .json` under the operating-system temporary directory |

### v0.9.1 Platform and Distribution Contract

v0.9.1 is currently an unreleased candidate. This is the final RC contract, not a claim that the helper, provider route, Tool Library, or hardware matrix has passed:

| Platform | Install asset | Audit payload |
|---|---|---|
| macOS 14+ Apple Silicon arm64 | `ae-mcp-panel-v0.9.1-macos-arm64.dmg` | `ae-mcp-panel-v0.9.1-macos-arm64.zxp` |
| Windows 11 24H2+ x64 | `ae-mcp-panel-v0.9.1-windows-x64.zxp` | the same ZXP |

Both target AE 25.x–26.x (CEP `[25.0,26.9]`) and are bound to one candidate SHA by `artifact-manifest-v0.9.1.json`. Under the final contract, the Panel will install the bundled runtime offline so normal users do not depend on system Python/Node/uv. Claude Code CLI, Codex CLI, and the ZCode CLI/app-server are **optional** dependencies for their corresponding AI channels, not core prerequisites. Provider configuration and credentials are not exportable; the final signed-helper, RuntimeManager, and system-credential implementation remains gated by explicit approval and Phase 0 evidence.

### Environment Variables

| Variable | Purpose | Default |
|---|---|---|
| `AE_MCP_BACKEND` | Selects the backend entry-point name (the bridge registers as `ae-mcp`) | unset (auto-selected when exactly one backend is installed) |
| `AE_MCP_PLUGIN_URL` | Address the bridge backend uses to reach the AE panel's HTTP RPC | `http://127.0.0.1:11488` |
| `AE_MCP_SKILL_DIR` | Directory where skills are stored (the `<name>.json` files read/written by `ae.skill*`) | `~/.ae-mcp/skills` |
| `AE_MCP_CHECKPOINT_KEEP` | Max checkpoints retained per project (older ones are pruned; minimum 1) | `50` |

### Built-In Provider Configuration

- Built-in AI services are organized as Claude / Codex / ZCode backends. Each backend shows credential-channel cards in Settings, with automatic selection and optional manual channel locking.
- Claude's API direct channel replaces the old BYOK backend. Official Anthropic API and Anthropic-compatible providers are configured in Provider Manager, and `/v1/messages` plus `/v1/models` route to the selected Base URL.
- The Codex backend uses `codex app-server` plus Codex CLI login by default. It can also inherit custom model providers from `~/.codex/config.toml` or use an OpenAI-compatible provider from Provider Manager.
- Provider Manager stores OpenAI-compatible and Anthropic providers locally in `~/.ae-mcp/providers.json` and can probe `/v1/models` for model lists. Explicit custom providers take priority over inherited config.
- A custom model ID is inserted at the top of the selected channel's model list and becomes the default model. Clearing it returns to the probed model list.

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
| `ae.status` | none | inspect backend selection, installed backends, and snapshotter status |
| `ae.diagnose` | none | end-to-end host, Python handshake, token, and AE responsiveness check |
| `ae.overview` | none | project and comp overview |
| `ae.layers` | `comp_id?`, `offset?`, `limit?`, `format?` | list layers (paginated + optional compact text) |
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
| `ae.createRig` | `comp_id?`, `target_layer_id`, `rig_type`, `name?`, `options?`, `controls?` | create controller/effect/preset rigs |
| `ae.ping` | `expect?` | bridge handshake |

### `ae.layers`

Returns **all** layers by default (matching the historical behavior). Pagination
and compact output are both opt-in:

| Arg | Notes |
|---|---|
| `offset?` | 0-based start index, default `0` |
| `limit?` | max layers to return; `0` (default) returns all |
| `format?` | `json` (default, structured) or `text` (compact paginated table, ~1/3 the tokens of JSON) |

Each layer carries `id / name / type / enabled / inPoint / outPoint / isThreeD / hasParent / parent`.
`type` is one of `camera/light/text/shape/null/adjustment/solid/footage/av`; `parent` is the parent layer name (or `null`), and `hasParent` is a boolean.
The envelope includes `total / offset / limit / returned / hasMore` for paging.

### Runtime Helpers (`ae.exec` / `ae.readProps`)

At panel startup a set of helpers is loaded into the persistent ExtendScript
engine, so agent-authored JSX can call them directly. All helpers honor a
never-throw invariant — bad input returns `null`:

| Helper | Purpose |
|---|---|
| `AEMCP.compById(id)` | CompItem by item id (`null`, never throws, on an unknown id) |
| `AEMCP.activeComp()` | the active comp, or `null` |
| `AEMCP.layerById(comp, idx)` | layer by 1-based index |
| `AEMCP.propByPath(root, "Transform/Position")` | resolve a property by display-name path |
| `AEMCP.propByMatchPath(root, "ADBE Transform Group#1/ADBE Position#1")` | resolve by matchName path (supports `#ordinals`) |

ES3 Array/Object polyfills (`indexOf/map/filter/...`, `Object.keys/...`) are also
provided for the classic engine and no-op on AE 2026's modern engine.

`ae.exec` auto-checkpoint is **non-blocking**: a failed/timed-out probe or
snapshot degrades to a `checkpointSkipped` note in the result rather than
aborting your edit. Multi-statement scripts also run fully under an undo group.

### `ae.previewFrame`

`times` wins over `time`; if neither is supplied, the current comp time is previewed. The default response returns file paths. Set `include_base64=true` to include inline image bytes.

The implementation opens the target comp, sets the requested time, then prefers `CompItem.saveFrameToPng` to write a comp-frame PNG. This path does not depend on visible window pixels, so AE panels, foreground windows, and desktop occlusion are not included in the preview. If the current AE version or project state cannot write the PNG, it falls back to the installed snapshotter and marks the frame with `source: "viewer"`.

`source: "comp"` means the preview contains comp-frame pixels; `source: "viewer"` means the compatibility fallback was used. `ae.snapshot` remains the lower-level diagnostic capture primitive.

The default output directory is `ae_mcp_previews/<session>/` under the operating-system temporary directory. On the first use of that default root in a service process, stale session directories not updated for 24 hours are pruned. Explicit `out_dir` values are never pruned by ae-mcp; the caller owns that directory.

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

`effect_controls` accepts a typed `controls` list (which takes precedence over a
raw `options['controls']`): each entry is `{name, type, property}`, where `type`
is one of `slider/angle/checkbox/color` and `property` is the display-name path
of the target property to drive.

The MVP does not generate arbitrary binary `.ffx` files.

### Atom-Parity Status

The following capability list belongs to the historical v0.9.0 baseline; it is not v0.9.1 dual-platform or four-cell hardware-acceptance evidence:

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
