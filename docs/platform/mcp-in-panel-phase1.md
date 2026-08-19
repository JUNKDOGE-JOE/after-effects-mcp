# MCP in CEP Node — Phase 1 进展

续 [mcp-in-panel-spike.md](mcp-in-panel-spike.md)（Phase 0 的最小闭环）。方向与退出条件见 [ARCHITECTURE_DIRECTION.md](../ARCHITECTURE_DIRECTION.md) §6 Phase 1。本文记录每一批落地了什么、面板下一批要接的进程内 API、以及有意留空的点。

## 批 1（2026-08-19）

三路并行：`codex/sol-p1-exec-gate`（每会话配置 + 审批门 + checkpoint + `ae_exec`）、`codex/terra-p1-status-preview`（`ae_status` + `ae_previewFrame`）、`codex/luna-p1-read`（`ae_read`）。基线 `phase1/mcp-tool-scaffold`：`/mcp` 每个工具一个模块 `plugin/host/mcp/tools/<name>.js`，导出 `{ definition, call(args, context, deps) }`，在 `plugin/host/mcp/tools.js` 的 `TOOL_MODULES` 注册；**每个新增的 `plugin/host/**/*.js` 都必须登记进 `plugin/host/cep-runtime-contract.test.js` 的 `CEP_EXECUTED_FILES`**（它守 `node:` 前缀与 require 图）。

`tools/list` 现在是：`ae_status`、`ae_exec`、`ae_previewFrame`、`ae_read`。

### 每会话配置（conversation）

- `/mcp/c/:token` 与 `/mcp` 复用同一套 POST / GET(SSE) / DELETE；`initialize` 把会话绑到该 conversation，会话不能跨路径复用；未知 token → 404。
- 普通 `/mcp` 的会话 `conversationId = null`，策略 = 默认外部策略 `{ approvalTier: null, expertGuidance: true, label: 'external' }`。`approvalTier: null` 等价于 Python 里 `AE_MCP_APPROVAL_TIER_FILE` 未设置：调用方是外部 MCP 客户端，它自己的权限系统就是门。
- 会话身份 `session.clientName` = `initialize.clientInfo.name`（对话会话为 `<name>@<label>`；无 clientInfo 时 `mcp:<id 前 8 位>`），传进 `executeJsx({client})` 用于 activity 与客户端阻断。
- 策略在每次 `tools/call` 时现读，`update()` 立即生效。

面板（同一 CEP Node 上下文，`require` 宿主后 `start()`）用进程内 API，不走 HTTP：

```js
const server = require('<host>/server');      // start() 之后 server.mcp 可用
const c = server.mcp.conversations.create({ label: 'chat-3', policy: { approvalTier: 'manual', expertGuidance: true } });
// c = { id, token, path: '/mcp/c/<token>', policy }
// 把 'http://127.0.0.1:<port>' + c.path 作为该对话 CLI 的 MCP HTTP 入口
server.mcp.conversations.update(c.id, { approvalTier: 'auto' });   // 用户翻审批芯片
server.mcp.conversations.close(c.id);    // 对话结束：删该对话的 MCP 会话并关 SSE writer
server.mcp.conversations.get(token) / getById(id) / list()
```

token 只经进程内 API 交付，宿主不记录它。

### 审批门与审批队列

- `plugin/host/mcp/approval-gate.js`：Python `approval_gate.py` 动词门的移植，模块 docstring（"两道门默认方向相反"的决策记录）逐字保留，另附宿主适配说明；`gateDecision(tier, tool)` 四档 × `VERB_ANNOTATIONS`（`plugin/host/mcp/annotations.js`，方向文档 §8 的 11 个工具）；文案 `_READONLY_DENIED` / `_NO_PROMPT_API` / `User denied this action.` 与 Python 一致。
- `plugin/host/mcp/approvals.js`：进程内 `ApprovalQueue`（EventEmitter）。

```js
server.mcp.approvals.on('request', item => { /* item = { id, conversationId, sessionId, tool, risk, summary:{code(≤200), undo_group_name, checkpoint_label}, createdAt } */ });
server.mcp.approvals.list();
server.mcp.approvals.resolve(id, 'accept' | 'decline');   // 默认 10 分钟超时 = decline
```

- 外部会话（tier null）永远不会进队列；`ae_exec` 在参数校验后、执行前过门，`deny-readonly` 直接返回错误。
- 面板侧：复用 `plugin/panel/src/lib/elicitationCoordinator.js` 的队列 / `resolveVisible` UI 管线把 `request` 事件弹成审批卡（下一批）。

### `ae_exec`

顺序：参数校验 → 审批门 → best-effort 自动 checkpoint（只在给了 `checkpoint_label` 时；任何失败只变成结果里的 `checkpointSkipped`，绝不阻止编辑；流程与 Python `_run_exec` 逐步对照）→ `executeJsx` → `parseJsxResult`（`jsx_result.py` 五条规则 + `error_hints.py` 的提示）。成功时工具结果就是脚本返回的 JSON；裸字符串 → `{ok:true, content}`；空 / `undefined` / `"EvalScript error."` 哨兵 → `{ok:false, error, raw}`。底层失败保持 `{ok:false, error, disposition, jsxBridge}`。

checkpoint 存储 `plugin/host/mcp/checkpoint-store.js`：`AE_MCP_HOME/checkpoints`（缺省 `~/.ae-mcp/checkpoints`），按解析后的工程路径分组，`makeId / aepPath / writeMeta / list / latest / remove / prune`（保留 50，`AE_MCP_CHECKPOINT_KEEP` 覆盖）。`ae_checkpoint` / `ae_revert` 工具下一批接在它上面。直接 HTTP `/exec` 不做 checkpoint（与 Python 时代一致）。

### `ae_status`

`depth: "ping" | "status" | "diagnose"`（默认 status）、`expect`（ping 回显）。`ping` → `{ok, pong, server:"cep-host", pluginVersion, port}`；`status` → 宿主状态 + `server:"cep-host"`、`python:null`、`paused`、`clients`（无 token）、`nativeExecutionPlane`、`mcp:{sessions, protocolVersion}`；`diagnose` → 再加 `host{…}` 与 `ae{responsive, aeVersion, projectFile}`（跑 `diagnose.jsx`；失败为 `ae.responsive:false` 但整体仍 `ok:true`，与 Python 一致）。

### `ae_previewFrame`

Python `ae.previewFrame` 的 **`saveFrameToPng` 分支**移植：`comp_id` / `time` / `times`(≤8) / `out_dir` / `include_base64` / `scale`(0<s≤4) / `repaint_delay_ms`（保留、无效果）。PNG 完成 = IEND 在 + 两次轮询大小不变 + 真能解码；尺寸只信文件；`scale` 用零依赖 `plugin/host/mcp/png.js`（8-bit 非隔行 RGB/RGBA：CRC、去滤波、盒式下采样、重编码；其它格式保留 IHDR 尺寸并标 `downsampleSkipped`）；每帧预算递增；结果 `content` = image 块（`_meta{captureId, frameIndex, sha256, width, height}`）在前 + JSON 文本；每帧一行 `previewFrame.branch` 进宿主日志。**没有查看器截屏回落**（`ae.snapshot` 已决定删除）。

### `ae_read`

新工具。`target: project | comps | layers | properties | keyframes | compSettings`，`comp{id|name|index}` / `layer{index|id|name}` / `property{matchPath}` 选择器，`page{offset, limit≤200}`、`sort{by, order}`、`filter{nameContains, type, enabledOnly, timeVaryingOnly, matchNamePrefix}`（按 target 闭合）、`depth`（properties，1..8）、`sampleTime`（properties，缺省当前时间）、`timeout_sec`。每个 target 一个 ES3 模板 `plugin/jsx/templates/read_<target>.jsx`；请求整体 `JSON.stringify` 后注入 `$options`；遍历 / 过滤 / 排序 / 分页都在 AE 内；宿主校验闭合参数与分页信封。输出镜像 native 读 primitive（`projectItemsListValue` / `compositionLayersListValue` / `layerPropertiesListValue` / `layerPropertyKeyframesListValue` / `compositionSettingsReadValue`），定位用 JSX 能稳定给的 `itemId` / `layerIndex + layerId` / `matchPath` 并标 `locatorKind:"jsx"`。标量 / 向量 / 颜色 / 文本给 `value`，其它 `valueStatus:"unsupported"`。`nativeProjectGraphEffect:"preserve"`、不传 undo group、不 checkpoint。

性能：`plugin/host/mcp/tools/read.perf.jsx` 在 AE 里建约 300 层 × 16 个 Slider 的合成量测 layers 全量 / properties depth 2/4/8 / keyframes；真机验收时经 `ae_exec` 跑一次，每次调用 < 2 秒可接受，> 5 秒记录规模并评估 `.aex` 在场时回落 native list。

### 模板

`plugin/jsx/templates/` 现在有 `checkpoint_create.jsx`、`diagnose.jsx`、`preview_viewer.jsx`（与 `packages/core/ae_mcp/jsx_templates/` 同名文件**逐字节一致**，有测试守着，Python 退役前两份都在）和 `read_*.jsx`（新）。`plugin/jsx/runtime.jsx` 由 CEP manifest 预加载，`AEMCP.*` 助手可直接用，宿主不需要 Python 的 prelude。

### 有意留空（下一批起）

- 面板接线：内置后端（claude / codex / opencode）的 MCP 从 stdio spec 改 HTTP spec 并带 conversation 入口；审批卡接 `approvals` 队列；两套 server 的切换开关。
- `ae_checkpoint` / `ae_revert`、`ae_validateExpressions`、`ae_nativeExec` 走 `/native/invoke`；`instructions.py` + `skills_bundled/` 作为数据进宿主。
- 外部客户端的 `elicitation/create`（外部会话目前 tier null 放行）；Tool Library 的 `plan_decision` / `authorize_plan` 门。
- `packages/core/tests/live` 的等价用例改打 `/mcp`（退出条件）。
- 真机：AE 2026 上跑一遍四个工具 + `read.perf.jsx`；AE 2023/2024 众测。
## 批 2（2026-08-20）

三路并行：`codex/sol-p1b2-panel-wiring`（面板接线）、`codex/terra-p1b2-checkpoint-revert-validate`（`ae_checkpoint` / `ae_revert` / `ae_validateExpressions` + instructions + live 套件）、`codex/luna-p1b2-native-exec`（`ae_nativeExec`）。`tools/list` 现在是：`ae_status`、`ae_exec`、`ae_previewFrame`、`ae_read`、`ae_checkpoint`、`ae_revert`、`ae_validateExpressions`、`ae_nativeExec`。

### 面板接线

- 设置 → 连接 → **MCP server engine**：`Python`（默认）/ `CEP host（实验性）`，pref `ae_mcp_mcp_engine`，对新会话生效。
- `cep-host` 模式：`plugin/panel/src/lib/hostConversation.js` 为每个聊天会话 `conversations.create`（label = 会话 id，policy = 审批芯片 + 专家指导），芯片 / 指导变化 `update`，新建会话 `close` 旧的；`plugin/panel/src/lib/mcpEngine.js` 的 `getMcpSpec` 返回 `{ kind: 'http', url: 'http://127.0.0.1:<port>/mcp/c/<token>' }`；codex → `mcp_servers.ae = { url }`，opencode → `{ type: 'remote', url, enabled }`，claude sidecar → `--mcp { type: 'http', url }`。
- `plugin/panel/src/lib/hostApprovalBridge.js`：`server.mcp.approvals` 的 `request` → 现有 `elicitationCoordinator` 卡片（Python 那份 `approve: boolean` schema）→ `approvals.resolve(accept|decline)`，按 `conversationId` 投递；非 `cep-host` 模式不挂。
- 外部客户端页（`externalClients.httpConfigFor`）在 `cep-host` 模式显示 HTTP 片段（Claude Code：`claude mcp add --transport http ae http://127.0.0.1:<port>/mcp`），并说明面板必须开着。
- **仍走 Python stdio**：面板自己的 Tools UI / Tool Library / 工具搜索客户端（`createMcpClient`）。

### `ae_checkpoint` / `ae_revert` / `ae_validateExpressions` / instructions

- checkpoint 流程抽到 `plugin/host/mcp/checkpoint-ops.js`（`createCheckpoint` / `autoCheckpoint` / `atomicReplace` / `resolveProjectPath`），`ae_exec` 自动建档、`ae_checkpoint create`、`ae_revert` 共用。显式 `create` 在未命名工程上是错误（自动建档才是 best-effort）。
- `ae_revert`：`revert_close.jsx` 关工程 → 同目录临时文件 + rename 原子替换 .aep → `revert_open.jsx` 重开；`branch_before_revert` 先建分支存档；失败返回 `{ok:false, stage: close|replace|reopen, ...}`，替换失败会重开原工程；过审批门（destructive）。
- `ae_validateExpressions`：`validate_expressions.jsx` 移植，只读。
- `plugin/host/mcp/instructions.js`：`instructions.py` 的两段文案逐字移植；`initialize.instructions` 按会话策略的 `expertGuidance` 决定是否带专家附录，末尾动态列出宿主工具。

### `ae_nativeExec`

- `plugin/host/mcp/tools/native-exec.js` + `native-program.js`：广告 API-safe schema（顶层无组合子），`tools/call` 用完整生成契约校验（错误带 `errors[{path, message}]`），过审批门，然后与 Python `invoke_native_program` 同流程：`nativeNegotiate` → `nativeInvoke`（`server.js` 挂载处新增的两个依赖，走 `/native/*` 路由同一条 `connectedNativeClient`）→ 请求摘要 / 后置摘要 / 操作序列 / 输出契约 / undo 证据 11 项核对 → Python 同形响应；native 错误统一 `{ok:false, error, code, retryable, sideEffect, recovery, details?}`。
- canonical JSON = Python `json.dumps(sort_keys=True, separators=(',',':'), ensure_ascii=False)`（已与 Python 交叉核对含 sha256）；`json-schema-lite.js` 只实现生成契约用到的关键字，其它 fail-closed（测试钉死关键字集合）。
- `native/ae-plugin/protocol/native_exec.generated.json`（CJS 可 `require` 的生成物孪生，`emit-native-exec-cjs.mjs` 产出，有一致性测试）。native 平面本身仍冻结：没有新增 primitive。

## 运行 live MCP 验收套件

此套件不在 CI 运行，需要真实 AE 和已打开的面板。先在 AE 关闭时运行
`install-plugin-dev.ps1` 安装面板，启动 AE（面板会启动 `:11488`），然后执行：

```powershell
cd plugin/host
npm run test:live-mcp
```

可用 `--only status` 选择段落、`--no-cdp` 跳过面板 CDP 段、`--keep-ae` 在结束时保留 AE。
