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
| Handler count | 49 verbs，按 backend `supported_verbs()` 过滤 |
| Skill storage | `~/.ae-mcp/skills/<name>.json` |
| Tool Library | `~/.ae-mcp/tools`；legacy skill 保持原路径，不复制 |
| Preview output | 默认位于操作系统临时目录的 `ae_mcp_previews/<session>/...png`，可用 `out_dir` 覆盖 |
| Checkpoint store | 操作系统临时目录下的 `ae_mcp_checkpoints/<basename>/<id>.aep + .json` |

### v0.9.2 平台与分发契约

v0.9.2 是 Windows x64 正式版本。Provider、Tool Library 与 Platform Helper 已完成实现并通过 Windows AE 2025 实机验证；macOS、包内 RuntimeManager、正式跨平台签名链和完整实机矩阵转入 v0.9.3：

| 平台 | 安装资产 | 审计载荷 |
|---|---|---|
| Windows 11 24H2+ x64 | `ae-mcp-panel-v0.9.2-windows-x64.zxp` | 同一个 ZXP |

v0.9.2 保持 CEP host 范围 `[25.0,26.9]`，但本次发布证据只覆盖 Windows AE 2025。Panel 继续使用现有外部 runtime/launcher 配置；包内离线 RuntimeManager 转入 v0.9.3。Claude Code CLI、Codex CLI 与 ZCode CLI/app-server 都是对应 AI 通道的**可选**依赖，不是 core 前置。Provider 配置与凭据不可导出；系统凭据库与 Helper 功能已经落地并保持 fail-closed。

### 环境变量

| 变量 | 作用 | 默认值 |
|---|---|---|
| `AE_MCP_BACKEND` | 选择后端 entry point 名称（bridge 注册为 `ae-mcp`） | 无（单后端时自动选用） |
| `AE_MCP_PLUGIN_URL` | bridge 后端连接 AE 面板 HTTP RPC 的地址 | `http://127.0.0.1:11488` |
| `AE_MCP_SKILL_DIR` | skill 存储目录（`ae.skill*` 读写的 `<name>.json`） | `~/.ae-mcp/skills` |
| `AE_MCP_TOOL_DIR` | 原生 Tool Library、索引、审计、迁移备份与 legacy metadata 根目录 | `~/.ae-mcp/tools` |
| `AE_MCP_TOOL_APPROVAL_TIER_FILE` | 动态制品执行的 panel 管理审批档文件 | 无；缺失/非法时按 `manual` |
| `AE_MCP_CHECKPOINT_KEEP` | 每个工程保留的 checkpoint 数量上限（旧的自动清理，最小 1） | `50` |

### 面板内嵌 provider 配置

- 面板设置页以 Claude / Codex / ZCode 三路后端组织内嵌 AI 服务，每路后端显示凭证通道卡，并可自动选择或手动锁定可用通道。
- Claude 的 API 直连通道取代旧 BYOK 后端：官方 Anthropic API 或 Anthropic-compatible provider 都通过 Provider 管理器配置，`/v1/messages` 与 `/v1/models` 接到对应 Base URL。
- Codex 后端默认走 `codex app-server` + Codex CLI 登录态；也可继承 `~/.codex/config.toml` 的自定义 model provider，或使用 Provider 管理器中的 OpenAI-compatible provider。
- Provider 管理器把 OpenAI-compatible 与 Anthropic provider 保存在本机 `~/.ae-mcp/providers.json`，并支持通过 `/v1/models` 枚举模型列表。列表本身不代表所有模型使用相同 API；Codex 会对当前明确的模型 ID 分别验证并缓存 dialect：原生支持 Responses 的模型直连 `/responses`，仅支持 Chat Completions 的模型经本地 `/responses` facade 安全转换，只有无法等价转换的 Responses 特性才返回结构化 compact 501，且不静默丢字段。旧版未绑定模型的 Provider 级探测结果按未确认处理。显式自定义 provider 优先于继承配置。
- 自定义模型 ID 会插入对应通道的模型列表首位，作为默认模型；清空后回到探测到的模型列表。

### 架构

```text
MCP client
  -> ae_mcp.server
  -> ae-mcp backend package
  -> HTTP 127.0.0.1:11488
  -> CEP panel Node host
     -> native RPC -> AEGP main-thread dispatcher -> After Effects
     -> CSInterface.evalScript -> After Effects ExtendScript（legacy JSX 工具）
```

### Verb Reference

除特别说明外，工具返回 JSON：成功时 `ok: true`，失败时 `ok: false` 和 `error`。`ae.toolUse` 的 `action="prepare"` 成功时直接返回 plan object，不含 `ok`。

| Verb | Args | 说明 |
|---|---|---|
| `ae.init` | `refresh_only?` | 初始化/刷新项目状态 |
| `ae.status` | none | 检查 backend 选择、已安装 backend 与 snapshotter 状态 |
| `ae.diagnose` | none | 端到端检查 host、Python 握手、token 与 AE 响应 |
| `ae.overview` | none | 项目和 comp 概览 |
| `ae.projectSummary` | none | 通过原生 AEGP 返回带 provenance 与 postcondition 的工程摘要；不回退 JSX |
| `ae.getProjectBitDepth` | none | 通过原生 AEGP 读取当前 `8/16/32` bits-per-channel；不回退 JSX |
| `ae.setProjectBitDepth` | `target_depth`, `idempotency_key` | 通过原生 AEGP 设置 `8/16/32`，返回 before/after、Undo 可用性和审计；不回退 JSX |
| `ae_listProjectItems` | `project_locator?`, `offset?`, `limit?` | 通过原生 AEGP 分页列出工程项；默认 25、最多 50；不回退 JSX |
| `ae_listCompositionLayers` | `composition_locator`, `offset?`, `limit?` | 通过原生 AEGP 分页列出指定合成的图层；默认 25、最多 50；不回退 JSX |
| `ae.layers` | `comp_id?`, `offset?`, `limit?`, `format?` | legacy JSX 图层列表（行为保持不变） |
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
| `ae.toolIndex` | `kinds?`, `statuses?`, `source_types?`, `include_candidates?`, `limit?` | 只列制品摘要 |
| `ae.toolSearch` | `query`, `kinds?`, `categories?`, `tags?`, `risks?`, `statuses?`, `source_types?`, `offset?`, `limit?` | 搜索摘要；不返回 content |
| `ae.toolInspect` | `artifact_id` | 首个返回完整 content 的调用 |
| `ae.toolUse` | staged action fields | render 或 prepare/grant/execute |
| `ae.toolCreate` | `name`, `kind`, `content` 及可选元数据字段 | 创建原生制品 |
| `ae.toolEdit` | `artifact_id`, `changes`, `expected_revision`, `expected_content_hash`, `replace_artifact_id?` | 编辑或验证制品 |
| `ae.toolDelete` | `artifact_id`, `expected_revision`, `expected_content_hash` | 永久删除用户制品 |
| `ae.toolArchive` | `artifact_id`, `expected_revision`, `expected_content_hash` | 归档制品 |
| `ae.toolDuplicate` | `artifact_id`, `name`, `expected_revision`, `expected_content_hash` | 复制为原生用户制品 |
| `ae.toolPromoteFromHistory` | `artifact_id`, `expected_revision`, `expected_content_hash`, `replace_artifact_id?` | 提升 chat history candidate |
| `ae.toolImport` | staged import fields | preview/commit/discard 隔离导入 |
| `ae.toolExport` | `artifact_ids`, `out_path` | 确定性导出 `.aemcptools` |
| `ae.createRig` | `comp_id?`, `target_layer_id`, `rig_type`, `name?`, `options?`, `controls?` | 创建 controller/effect/preset rig |
| `ae.ping` | `expect?` | bridge 握手 |

### 原生工程导航

公开 MCP 工具 `ae_listProjectItems` 和 `ae_listCompositionLayers` 分别调用 canonical Core verb `ae.listProjectItems` 与 `ae.listCompositionLayers`，并固定走 `MCP -> Core -> native RPC -> AEGP -> AE`。两者均为严格的原生只读工具；原生能力、契约或传输不可用时返回结构化错误，**不会回退到 JSX**。

- 首次调用 `ae_listProjectItems` 时省略 `project_locator`；`offset` 默认为 `0`，`limit` 默认为 `25`、最大为 `50`。续页时传回上一页的 `projectLocator`，且 `offset > 0` 时该 locator 必填。
- `ae_listCompositionLayers` 的 `composition_locator` 必须来自工程项结果中 `type="composition"` 的 `locator`；同样使用 `offset` 分页，`limit` 默认为 `25`、最大为 `50`。
- Locator 是不透明的原生句柄，绑定当前 host、session、project 与 generation；不要拆解、改写或跨重启缓存。成功结果携带 `native-aegp` provenance、已验证 postcondition 与 audit evidence。

现有 `ae.layers` 是 legacy JSX 工具，继续保留原参数、数值 ID、`limit=0` 全量返回及可选文本格式语义。它没有被改造成原生工具，也不与上述 locator 契约混用。

### `ae.layers`

这是 legacy JSX 工具。默认一次返回**全部**图层（与旧行为兼容）。分页与紧凑输出均为可选：

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

### Tool Library 协议

| Dotted verb | MCP 暴露名 | 必填参数 | 可选参数 | 成功响应重点 |
|---|---|---|---|---|
| `ae.toolIndex` | `ae_toolIndex` | 无 | `kinds`, `statuses`, `source_types`, `include_candidates`, `limit` | `ok`, `artifacts[]`（`ToolSummary`，无 content） |
| `ae.toolSearch` | `ae_toolSearch` | `query` | `kinds`, `categories`, `tags`, `risks`, `statuses`, `source_types`, `offset`, `limit` | `ok`, `artifacts[]`, `total`, `offset`, `limit`；无 content |
| `ae.toolInspect` | `ae_toolInspect` | `artifact_id` | 无 | `ok`, 完整 `artifact`, `trust` |
| `ae.toolUse` | `ae_toolUse` | `action` 及对应 action 字段 | 见下方 action 表 | render，或 plan/grant/execute 结果 |
| `ae.toolCreate` | `ae_toolCreate` | `name`, `kind`, `content` | `description`, `category`, `tags`, `compatibility`, `declared_risk`, `status`, `args_schema`, `expected_store_revision` | `ok`, 完整新 `artifact` |
| `ae.toolEdit` | `ae_toolEdit` | `artifact_id`, `changes`, `expected_revision`, `expected_content_hash` | `replace_artifact_id` | `ok`, 完整更新 `artifact` |
| `ae.toolDelete` | `ae_toolDelete` | `artifact_id`, `expected_revision`, `expected_content_hash` | 无 | `ok`, `deleted` |
| `ae.toolArchive` | `ae_toolArchive` | `artifact_id`, `expected_revision`, `expected_content_hash` | 无 | `ok`, 完整 archived `artifact` |
| `ae.toolDuplicate` | `ae_toolDuplicate` | `artifact_id`, `name`, `expected_revision`, `expected_content_hash` | 无 | `ok`, 完整副本 `artifact` |
| `ae.toolPromoteFromHistory` | `ae_toolPromoteFromHistory` | `artifact_id`, `expected_revision`, `expected_content_hash` | `replace_artifact_id` | `ok`, 完整 saved `artifact` |
| `ae.toolImport` | `ae_toolImport` | `action`；preview 用 `path`，commit/discard 用 `import_id` | commit 的 `resolutions` | 见下方 import flow |
| `ae.toolExport` | `ae_toolExport` | `artifact_ids`（1..511，且不可重复）, `out_path` | 无 | `ok`, `path`, `packageSha256` |

Wire enum 如下：

- `kind`: `jsx`, `expression`, `prompt-skill`, `recipe`, `diagnostic`。
- `status`: `candidate`, `saved`, `pinned`, `archived`, `deprecated`。可编辑的 user/legacy artifact 通过公开 Edit 只允许 `candidate -> saved`, `saved -> pinned`, `pinned -> saved`；归档使用 `ae.toolArchive`。
- `source.type` / 摘要的 `sourceType`: `user`, `legacy`, `bundled`, `chat-tool-call`, `imported`。
- `declaredRisk` / plan `risk`: `read`, `write`, `destructive`, `external`；`operation`: `render`, `execute`, `apply`。

`jsx`, `expression`, `prompt-skill` 的 `content` 是 UTF-8 string。`recipe` 的 `content` 是 `{"steps": [...]}`，每步严格包含 `refType` (`artifact`/`tool`), `ref`, `operation` (`render`/`execute`/`apply`/`call`), `args`, `target`。`diagnostic` 的 `content` 严格为 `{"capability": string, "args": object}`。未知键会被拒绝。Create 的 `status` 只能是 `candidate` 或 `saved`。

Edit 的 `changes` 只允许 `name`, `description`, `kind`, `category`, `tags`, `compatibility`, `declared_risk`/`declaredRisk`, `status`, `content`, `args_schema`/`argsSchema`, `verification_action`/`verificationAction`。`verification_action` 只能是 `mark-reviewed` 或 `clear`；修改 content、kind 或 args schema 会清除旧 verification。

`ae.toolIndex` 和 `ae.toolSearch` 默认只查 `saved`/`pinned`。Index 的 `include_candidates=true` 会额外加入 `candidate`；Search 要查 candidate 必须显式传 `statuses`。`ToolSummary` 含 `id`, `name`, `description`, `kind`, `category`, `tags`, `status`, `verified`, `declaredRisk`, `contentHash`, `revision`, `updatedAt`, `lastUsedAt`, `sourceType`，不含 content。Inspect 返回完整 `ToolArtifact`；只有 manifest 验签通过的 bundled artifact 获得 `trust="signed-bundled"`，其余为 `user-untrusted`。

`candidate`、`archived`、`deprecated` 均不能 render、prepare、获取 grant 或 execute。Index/Search 永不返回 content，Inspect 是 progressive discovery 中第一个 content-bearing 调用。成功的 `ae.exec` 或带顶层 expression 文本的调用可产生 `chat-tool-call` candidate；失败、secret 命中、`ae.skillCreate`/`ae.skillEdit` 和所有 `ae.tool*` 调用都不会捕获。同 kind/content hash 的重复 history candidate 会合并。`chat-tool-call` candidate 用 `ae.toolPromoteFromHistory`；`imported` candidate 用 `ae.toolEdit` 将 `status` 改为 `saved`。`replace_artifact_id` 只能随 candidate-to-saved 提升使用。

`ae.toolUse` 的精确 action 形状：

| Action | 必填 | 可选 | 成功响应 |
|---|---|---|---|
| `render` | `action`, `artifact_id` | `args`；`operation` 若传只能是 `render` | `ok`, `artifactId`, `contentHash`, `trust`，以及 `rendered` 或 `untrustedContext` |
| `prepare` | `action`, `artifact_id`, `operation` | `args` 和 `target`（默认都为 `{}`） | 裸 plan object：`artifactId`, `contentHash`, `operation`, `normalizedArgs`, `target`, `dependencyHashes`, `planHash`, `risk`, `expiresAt`；不含 `ok` |
| `grant` | `action`, `plan_hash`, `grant_scope` (`once`/`session`) | 无 | `ok`, `grantId`, `planHash`, `scope`, `expiresAt` |
| `execute` | `action`, `plan_hash`, `grant_id` | 无 | 依 kind/operation 返回 `ok: true` 的 render/backend/handler 结果；recipe 返回 `results[]` |

grant 只能消费一次。execute 前会重新读取制品、args schema 与 recipe/handler 依赖，任一变化都会使旧 plan/grant 失效。

四档最低策略：read 始终可读；readonly 拒绝其他风险；manual 对 write/destructive/external 询问；auto/none 自动放行普通 write，但 destructive/external 仍逐次询问。只有 write plan 可获得 session 放行；destructive/external 只能 once。write 的 session key 绑定 artifact/content/operation/normalized target，不按工具名缓存。

Import flow：

1. `action="preview"` 只传 `path`，返回 `ok`, `importId`, `packageSha256`, `artifacts[]`, `conflicts[]`, `highestRisk`, `expiresAt`。每个 artifact preview 含 `summary`, `existingId`, `metadataChanges`, `contentChanged`, `calculatedRisk`；conflict 含 `conflictId`, incoming/existing ID 与 content hash。preview 在 15 分钟后过期。
2. `action="commit"` 传 `import_id` 和 `resolutions`。每个 conflict 都必须精确给出 `keep` 或 `duplicate`；`replace` 不可用。commit 返回 `ok` 和新建制品的 summary-only `artifacts[]`。所有接受的导入制品都以 `source.type="imported"`, `status="candidate"`, `verified=false` 进入原生 store，不会覆盖现有制品。
3. `action="discard"` 只传 `import_id`，返回 `ok`, `discarded`；对已清理/不存在的 id 也是幂等成功。

`.aemcptools` 上限：压缩包 10 MiB、展开总量 50 MiB、单文件 5 MiB、最多 512 entries（含 `manifest.json`，因此 `artifact_ids` 严格为 1..511）、路径深度 8、单成员压缩比 100:1。加密、嵌套 archive、symlink/特殊文件、跨平台不安全/重复路径、未声明成员、hash/schema/secret 不匹配均 fail-closed，commit 不留下部分制品。Export 还要求 `artifact_ids` 不重复，并在写目标前扫描整个输出包的 secret。

Legacy skill 仍以 `AE_MCP_SKILL_DIR`/`~/.ae-mcp/skills` 下的 JSON 为唯一正本，不复制到原生 artifact store。用户 legacy skill 可经 Tool Library 编辑、归档和删除；content/args schema 编辑写回原 JSON，Tool-only metadata 写入 `legacy-metadata.json`。Legacy 名称不可在 Tool Editor 中重命名，skill 字段与 Tool-only metadata 也必须分两次 CAS 事务保存。同名 user/bundled skill 会以不同 ID 同时显示，而 `ae.skillUse` 仍保持 user-first 的旧解析顺序。Bundled skill 经过 manifest 校验且只读，但可 Duplicate 为新的原生 user artifact。`ae.skillUse execute=false` 保持旧响应；`execute=true` 只允许 JSX skill，并走与 `ae.toolUse` 相同的 plan/grant 执行引擎。

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

以下是当前代码已覆盖的能力清单，不是 v0.9.2 双平台或四格实机验收证据：

- CEP panel 到 AE bridge
- 49 个已注册 `ae.*` handlers（47 个 backend verbs，加 `ae.status`/`ae.diagnose`）
- read/mutate/search/checkpoint/revert
- `ae.previewFrame` 快速 viewer preview
- Python 侧持久化 skill system
- Panel Tools 页、progressive Tool Library discovery 与 `.aemcptools` import/export UX
- `ae.createRig` MVP
- `ae.validateExpressions` 表达式校验

剩余差距：

- `ae.previewFrame` 还不是精准 Composition Viewer crop
- `ae.createRig` 需要更深的 Puppet pin 和 preset workflow
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
| Handler count | 49 verbs, filtered by backend `supported_verbs()` |
| Skill storage | `~/.ae-mcp/skills/<name>.json` |
| Tool Library | `~/.ae-mcp/tools`; legacy skills remain canonical in place |
| Preview output | `ae_mcp_previews/<session>/...png` in the operating-system temporary directory unless `out_dir` is set |
| Checkpoint store | `ae_mcp_checkpoints/<basename>/<id>.aep + .json` under the operating-system temporary directory |

### v0.9.2 Platform and Distribution Contract

v0.9.2 is the Windows x64 release. Provider, Tool Library, and Platform Helper implementation is complete and has passed Windows AE 2025 hardware validation; macOS, bundled RuntimeManager, the production cross-platform signing chain, and the complete hardware matrix move to v0.9.3:

| Platform | Install asset | Audit payload |
|---|---|---|
| Windows 11 24H2+ x64 | `ae-mcp-panel-v0.9.2-windows-x64.zxp` | the same ZXP |

v0.9.2 retains the CEP host range `[25.0,26.9]`, while this release evidence covers Windows AE 2025 only. The Panel continues to use the existing external runtime/launcher setup; bundled offline RuntimeManager moves to v0.9.3. Claude Code CLI, Codex CLI, and the ZCode CLI/app-server are **optional** dependencies for their corresponding AI channels, not core prerequisites. Provider configuration and credentials are not exportable; system-credential and Helper behavior is implemented and fail-closed.

### Environment Variables

| Variable | Purpose | Default |
|---|---|---|
| `AE_MCP_BACKEND` | Selects the backend entry-point name (the bridge registers as `ae-mcp`) | unset (auto-selected when exactly one backend is installed) |
| `AE_MCP_PLUGIN_URL` | Address the bridge backend uses to reach the AE panel's HTTP RPC | `http://127.0.0.1:11488` |
| `AE_MCP_SKILL_DIR` | Directory where skills are stored (the `<name>.json` files read/written by `ae.skill*`) | `~/.ae-mcp/skills` |
| `AE_MCP_TOOL_DIR` | Root for native artifacts, index, audit, migration backups, and legacy metadata | `~/.ae-mcp/tools` |
| `AE_MCP_TOOL_APPROVAL_TIER_FILE` | Panel-managed tier file for dynamic artifact execution | unset; missing/invalid means `manual` |
| `AE_MCP_CHECKPOINT_KEEP` | Max checkpoints retained per project (older ones are pruned; minimum 1) | `50` |

### Built-In Provider Configuration

- Built-in AI services are organized as Claude / Codex / ZCode backends. Each backend shows credential-channel cards in Settings, with automatic selection and optional manual channel locking.
- Claude's API direct channel replaces the old BYOK backend. Official Anthropic API and Anthropic-compatible providers are configured in Provider Manager, and `/v1/messages` plus `/v1/models` route to the selected Base URL.
- The Codex backend uses `codex app-server` plus Codex CLI login by default. It can also inherit custom model providers from `~/.codex/config.toml` or use an OpenAI-compatible provider from Provider Manager.
- Provider Manager stores OpenAI-compatible and Anthropic providers locally in `~/.ae-mcp/providers.json` and uses `/v1/models` only to enumerate model IDs. A list does not imply one API for every model: Codex verifies and caches the dialect for the exact current model ID. Models with native Responses support call `/responses` directly; Chat-Completions-only models use the local `/responses` facade for safe conversion; only Responses features that cannot be represented equivalently return a structured compact 501, with no silent field dropping. Legacy Provider-level detections without a model binding are treated as unconfirmed. Explicit custom providers take priority over inherited config.
- A custom model ID is inserted at the top of the selected channel's model list and becomes the default model. Clearing it returns to the probed model list.

### Architecture

```text
MCP client
  -> ae_mcp.server
  -> ae-mcp backend package
  -> HTTP 127.0.0.1:11488
  -> CEP panel Node host
     -> native RPC -> AEGP main-thread dispatcher -> After Effects
     -> CSInterface.evalScript -> After Effects ExtendScript (legacy JSX tools)
```

### Verb Reference

Unless noted otherwise, tools return JSON with `ok: true` on success, or `ok: false` plus `error` on failure. A successful `ae.toolUse` call with `action="prepare"` returns the plan object directly and does not include `ok`.

| Verb | Args | Notes |
|---|---|---|
| `ae.init` | `refresh_only?` | initialize/refresh project state |
| `ae.status` | none | inspect backend selection, installed backends, and snapshotter status |
| `ae.diagnose` | none | end-to-end host, Python handshake, token, and AE responsiveness check |
| `ae.overview` | none | project and comp overview |
| `ae.projectSummary` | none | return a provenance-bound native AEGP project summary; never falls back to JSX |
| `ae.getProjectBitDepth` | none | read native AEGP `8/16/32` bits per channel; never falls back to JSX |
| `ae.setProjectBitDepth` | `target_depth`, `idempotency_key` | set native AEGP `8/16/32` with before/after, Undo availability, and audit evidence; never falls back to JSX |
| `ae_listProjectItems` | `project_locator?`, `offset?`, `limit?` | page through project items via native AEGP; default 25, maximum 50; never falls back to JSX |
| `ae_listCompositionLayers` | `composition_locator`, `offset?`, `limit?` | page through one composition's layers via native AEGP; default 25, maximum 50; never falls back to JSX |
| `ae.layers` | `comp_id?`, `offset?`, `limit?`, `format?` | legacy JSX layer listing (behavior unchanged) |
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
| `ae.toolIndex` | `kinds?`, `statuses?`, `source_types?`, `include_candidates?`, `limit?` | list summaries only |
| `ae.toolSearch` | `query`, `kinds?`, `categories?`, `tags?`, `risks?`, `statuses?`, `source_types?`, `offset?`, `limit?` | search summaries; no content |
| `ae.toolInspect` | `artifact_id` | first content-bearing call |
| `ae.toolUse` | staged action fields | render or prepare/grant/execute |
| `ae.toolCreate` | `name`, `kind`, `content`, plus optional metadata fields | create native artifact |
| `ae.toolEdit` | `artifact_id`, `changes`, `expected_revision`, `expected_content_hash`, `replace_artifact_id?` | edit or verify artifact |
| `ae.toolDelete` | `artifact_id`, `expected_revision`, `expected_content_hash` | permanently delete user artifact |
| `ae.toolArchive` | `artifact_id`, `expected_revision`, `expected_content_hash` | archive artifact |
| `ae.toolDuplicate` | `artifact_id`, `name`, `expected_revision`, `expected_content_hash` | copy to native user store |
| `ae.toolPromoteFromHistory` | `artifact_id`, `expected_revision`, `expected_content_hash`, `replace_artifact_id?` | promote chat-history candidate |
| `ae.toolImport` | staged import fields | quarantined preview/commit/discard |
| `ae.toolExport` | `artifact_ids`, `out_path` | deterministic `.aemcptools` export |
| `ae.createRig` | `comp_id?`, `target_layer_id`, `rig_type`, `name?`, `options?`, `controls?` | create controller/effect/preset rigs |
| `ae.ping` | `expect?` | bridge handshake |

### Native Project Navigation

The public MCP tools `ae_listProjectItems` and `ae_listCompositionLayers` call the canonical Core verbs `ae.listProjectItems` and `ae.listCompositionLayers`, respectively, over the fixed `MCP -> Core -> native RPC -> AEGP -> AE` path. Both are strict native reads: if the native capability, contract, or transport is unavailable, they return a structured error and **never fall back to JSX**.

- Omit `project_locator` on the first `ae_listProjectItems` call. `offset` defaults to `0`; `limit` defaults to `25` and is capped at `50`. Pass the returned `projectLocator` on continuation pages; it is required when `offset > 0`.
- `ae_listCompositionLayers` requires the `locator` of an item whose `type="composition"` in the project-items result. It uses the same offset pagination and default/max limits.
- Locators are opaque native handles bound to the current host, session, project, and generation. Do not decompose, edit, or cache them across restarts. Successful results carry `native-aegp` provenance, a verified postcondition, and audit evidence.

The existing `ae.layers` tool remains a legacy JSX tool with its original arguments, numeric IDs, `limit=0` all-items behavior, and optional text format. It was not converted to native and does not share the locator contract above.

### `ae.layers`

This is a legacy JSX tool. It returns **all** layers by default (matching the historical behavior). Pagination
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

### Tool Library Protocol

| Dotted verb | Exposed MCP name | Required | Optional | Success payload |
|---|---|---|---|---|
| `ae.toolIndex` | `ae_toolIndex` | none | `kinds`, `statuses`, `source_types`, `include_candidates`, `limit` | `ok`, summary-only `artifacts[]` |
| `ae.toolSearch` | `ae_toolSearch` | `query` | `kinds`, `categories`, `tags`, `risks`, `statuses`, `source_types`, `offset`, `limit` | `ok`, `artifacts[]`, `total`, `offset`, `limit`; no content |
| `ae.toolInspect` | `ae_toolInspect` | `artifact_id` | none | `ok`, full `artifact`, `trust` |
| `ae.toolUse` | `ae_toolUse` | `action` and that action's fields | see the action table below | render or plan/grant/execute result |
| `ae.toolCreate` | `ae_toolCreate` | `name`, `kind`, `content` | `description`, `category`, `tags`, `compatibility`, `declared_risk`, `status`, `args_schema`, `expected_store_revision` | `ok`, full new `artifact` |
| `ae.toolEdit` | `ae_toolEdit` | `artifact_id`, `changes`, `expected_revision`, `expected_content_hash` | `replace_artifact_id` | `ok`, full updated `artifact` |
| `ae.toolDelete` | `ae_toolDelete` | `artifact_id`, `expected_revision`, `expected_content_hash` | none | `ok`, `deleted` |
| `ae.toolArchive` | `ae_toolArchive` | `artifact_id`, `expected_revision`, `expected_content_hash` | none | `ok`, full archived `artifact` |
| `ae.toolDuplicate` | `ae_toolDuplicate` | `artifact_id`, `name`, `expected_revision`, `expected_content_hash` | none | `ok`, full duplicate `artifact` |
| `ae.toolPromoteFromHistory` | `ae_toolPromoteFromHistory` | `artifact_id`, `expected_revision`, `expected_content_hash` | `replace_artifact_id` | `ok`, full saved `artifact` |
| `ae.toolImport` | `ae_toolImport` | `action`; `path` for preview, `import_id` for commit/discard | commit `resolutions` | see the import flow below |
| `ae.toolExport` | `ae_toolExport` | `artifact_ids` (1..511, unique), `out_path` | none | `ok`, `path`, `packageSha256` |

The wire enums are:

- `kind`: `jsx`, `expression`, `prompt-skill`, `recipe`, `diagnostic`.
- `status`: `candidate`, `saved`, `pinned`, `archived`, `deprecated`. For editable user/legacy artifacts, public Edit transitions are limited to `candidate -> saved`, `saved -> pinned`, and `pinned -> saved`; use `ae.toolArchive` to archive.
- `source.type`, or `sourceType` in a summary: `user`, `legacy`, `bundled`, `chat-tool-call`, `imported`.
- `declaredRisk`, or plan `risk`: `read`, `write`, `destructive`, `external`; `operation`: `render`, `execute`, `apply`.

For `jsx`, `expression`, and `prompt-skill`, `content` is a UTF-8 string. Recipe content is `{"steps": [...]}`, where every step contains exactly `refType` (`artifact`/`tool`), `ref`, `operation` (`render`/`execute`/`apply`/`call`), `args`, and `target`. Diagnostic content is exactly `{"capability": string, "args": object}`. Unknown keys are rejected. Create accepts only `candidate` or `saved` for `status`.

Edit `changes` accepts only `name`, `description`, `kind`, `category`, `tags`, `compatibility`, `declared_risk`/`declaredRisk`, `status`, `content`, `args_schema`/`argsSchema`, and `verification_action`/`verificationAction`. `verification_action` is `mark-reviewed` or `clear`; changing content, kind, or args schema clears prior verification.

`ae.toolIndex` and `ae.toolSearch` default to `saved`/`pinned`. `include_candidates=true` adds `candidate` to Index; Search requires an explicit `statuses` filter to include candidates. `ToolSummary` contains `id`, `name`, `description`, `kind`, `category`, `tags`, `status`, `verified`, `declaredRisk`, `contentHash`, `revision`, `updatedAt`, `lastUsedAt`, and `sourceType`, but no content. Inspect returns the full `ToolArtifact`. Only a bundled artifact verified by its signed manifest receives `trust="signed-bundled"`; every other artifact is `user-untrusted`.

`candidate`, `archived`, and `deprecated` artifacts cannot render, prepare, receive a grant, or execute. Index/Search never return content; Inspect is the first content-bearing progressive-discovery call. A successful `ae.exec` or call with a top-level expression string may produce a `chat-tool-call` candidate; failures, secret hits, `ae.skillCreate`/`ae.skillEdit`, and all `ae.tool*` calls are not captured. Repeated history candidates with the same kind/content hash are merged. Use `ae.toolPromoteFromHistory` for a `chat-tool-call` candidate; move an `imported` candidate to `saved` with `ae.toolEdit`. `replace_artifact_id` is valid only as part of a candidate-to-saved promotion.

The exact `ae.toolUse` action shapes are:

| Action | Required | Optional | Success payload |
|---|---|---|---|
| `render` | `action`, `artifact_id` | `args`; if present, `operation` must be `render` | `ok`, `artifactId`, `contentHash`, `trust`, plus `rendered` or `untrustedContext` |
| `prepare` | `action`, `artifact_id`, `operation` | `args` and `target` (both default to `{}`) | bare plan object: `artifactId`, `contentHash`, `operation`, `normalizedArgs`, `target`, `dependencyHashes`, `planHash`, `risk`, `expiresAt`; no `ok` |
| `grant` | `action`, `plan_hash`, `grant_scope` (`once`/`session`) | none | `ok`, `grantId`, `planHash`, `scope`, `expiresAt` |
| `execute` | `action`, `plan_hash`, `grant_id` | none | the kind/operation-specific render, backend, or handler result with `ok: true`; recipes return `results[]` |

A grant is consumed once. Immediately before execution the artifact, args schema, and recipe/handler dependencies are re-read, so any change invalidates the old plan/grant.

Minimum four-tier policy: reads are allowed; readonly denies other risks; manual asks for write/destructive/external; auto and none allow ordinary writes, while destructive/external always ask. Only write plans can receive session approval; destructive/external plans are once-only. A write session key binds artifact/content/operation/normalized target and is never cached by tool name.

The import flow is:

1. `action="preview"` accepts only `path` and returns `ok`, `importId`, `packageSha256`, `artifacts[]`, `conflicts[]`, `highestRisk`, and `expiresAt`. Each artifact preview contains `summary`, `existingId`, `metadataChanges`, `contentChanged`, and `calculatedRisk`; each conflict contains `conflictId`, incoming/existing IDs, and content hashes. A preview expires after 15 minutes.
2. `action="commit"` accepts `import_id` and `resolutions`. Every conflict requires exactly one `keep` or `duplicate` resolution; `replace` is not accepted. Commit returns `ok` and summary-only `artifacts[]` for newly created artifacts. Every accepted artifact enters the native store with `source.type="imported"`, `status="candidate"`, and `verified=false`; import never overwrites an existing artifact.
3. `action="discard"` accepts only `import_id` and returns `ok` and `discarded`. Discard is idempotent for an already-cleaned or unknown ID.

`.aemcptools` limits are 10 MiB compressed, 50 MiB expanded, 5 MiB per file, 512 entries including `manifest.json` (so `artifact_ids` is strictly 1..511), path depth 8, and 100:1 per-member compression ratio. Encrypted or nested archives, links/special files, cross-platform unsafe or duplicate paths, undeclared members, and hash/schema/secret mismatches fail closed; commit leaves no partial artifacts. Export also requires unique IDs and secret-scans the complete output before writing the destination.

Legacy skill JSON under `AE_MCP_SKILL_DIR`/`~/.ae-mcp/skills` remains the single canonical copy and is not copied into the native artifact store. User legacy skills can be edited, archived, and deleted through the Tool Library: content/args-schema edits write the original JSON, while Tool-only metadata goes to `legacy-metadata.json`. Legacy names cannot be renamed in the Tool Editor, and skill fields plus Tool-only metadata must be saved as two separate CAS transactions. Same-name user and bundled skills are both visible under distinct IDs, while `ae.skillUse` preserves its historical user-first resolution order. Bundled skills are manifest-verified and read-only, but can be duplicated into a new native user artifact. `ae.skillUse execute=false` preserves the legacy response; `execute=true` accepts JSX skills only and uses the same plan/grant execution engine as `ae.toolUse`.

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

The following capabilities are present in the current code; this is not v0.9.2 dual-platform or four-cell hardware-acceptance evidence:

- CEP panel to AE bridge
- 47 registered `ae.*` handlers (45 backend verbs plus `ae.status`/`ae.diagnose`)
- read/mutate/search/checkpoint/revert workflows
- fast viewer preview via `ae.previewFrame`
- persistent Python-side skill system
- Panel Tools screen, progressive Tool Library discovery, and `.aemcptools` import/export UX
- MVP rig creation via `ae.createRig`
- expression validation via `ae.validateExpressions`

Remaining gaps:

- precise Composition Viewer crop for `ae.previewFrame`
- deeper Puppet pin and preset workflows for `ae.createRig`
- signed ZXP clean install validation
- optional future single-install MCP-over-HTTP transport

### Credits And Licensing

ae-mcp is an independent implementation inspired by Atom-style AE operation coverage and FX Console-style instant preview behavior. It does not vendor Atom, FX Console, or AtomX code.

Project code is MIT licensed. Adobe `plugin/client/CSInterface.js` keeps its upstream license notice. Other dependencies keep their upstream licenses.
