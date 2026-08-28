# 架构方向（当前有效）

> **状态**：2026-08-15 批准，2026-08-28 按 v0.10.5 功能面刷新。本文是架构与路线图入口；交付纪律仍以 `AGENTS.md` 为准。

## 1. 当前形态

ae-mcp 的公开 MCP 服务运行在 CEP Node 宿主 `plugin/host/` 中。客户端通过
`http://127.0.0.1:11488/mcp` 调用 13 个公开工具；宿主再经 ExtendScript
主执行平面或冻结的原生 AEGP 平面读取、修改和验证 After Effects 状态。

```text
外部 MCP 客户端 / 面板内 claude、codex、opencode
  -> plugin/host /mcp
  -> MCP 工具 handler
  -> /exec -> jsx-bridge -> ExtendScript -> After Effects
     或 native-aegp-client -> 23 个冻结 primitive -> After Effects
  -> typed result + activity/audit evidence
```

旧 Python package server、Node sidecar 与 platform-helper 已退役。不要在
`packages/` 下恢复服务端，也不要为旧 Python 安装流增加兼容层。Claude 与 Codex
使用各自 CLI 的登录态；OpenCode 是第三条 provider 通道，也是 ZXP 支持的内置
runtime。provider 层固定为 claude、codex、opencode 三条通道，不增加第四个适配器。

## 2. 代码边界

| 边界 | 职责 |
| --- | --- |
| `plugin/host/mcp/` | 13 个公开工具、会话、审批、Tool Library、技能与协议结果 |
| `plugin/host/` | `/mcp`、`/exec`、`/native/*`、`/tool-library/*`、状态路径、活动与诊断日志 |
| `plugin/panel/` | 面板聊天、审批卡、客户端配置、诊断与 Tool Library 管理界面 |
| `plugin/jsx/` | 受维护的 ExtendScript 模板与运行时辅助函数 |
| `plugin/shared/` | 面板与宿主共用的少量审批、附件契约 |
| `native/ae-plugin/` | 23 个冻结 AEGP primitive、精确有理数时间与世代绑定 locator |

原生平面保留 `.aex`/`.plugin` 及已提交的协议生成物，但不再增加 primitive、
不扩展 `native-primitives.json`，也不运行 capability-package codegen。新能力默认走
ExtendScript 竖切：公开 MCP 工具 → CEP handler → `/exec` → `jsx-bridge` →
ExtendScript → AE 状态 → typed result → audit evidence。

## 3. 公开工具面：13 个

| 工具 | 职责 |
| --- | --- |
| `ae_status` | 读取同进程宿主状态，并按深度探测 AE 响应。 |
| `ae_exec` | 执行新的 ExtendScript；已派发失败可返回恢复信封。 |
| `ae_execRecover` | 用服务端签发的 `recoveryId` 重跑或修正一次失败脚本。 |
| `ae_previewFrame` | 读取真实合成像素，支持区间拼图与 A/B 差分。 |
| `ae_read` | 分页、排序、过滤地读取工程、合成、图层、属性、关键帧或合成设置。 |
| `ae_checkpoint` | 为当前已保存工程创建或列出 `.aep` 检查点。 |
| `ae_revert` | 按 id 恢复检查点。 |
| `ae_validateExpressions` | 强制求值表达式并报告错误。 |
| `ae_nativeExec` | 执行由 23 个冻结 AEGP primitive 组成的有界线性程序。 |
| `ae_toolSearch` | 搜索、列出或按精确 id 检查 Tool Library 工件。 |
| `ae_toolUse` | 按 id 重放 JSX 工件。 |
| `ae_toolSave` | 新建、更新、沉淀或变更用户工件状态。 |
| `ae_skillUse` | 列出、渲染或执行技能，包括库内 prompt-skill。 |

`ae_exec` 是常规 AE 脚本操作的默认入口；`ae_nativeExec` 只服务于 JSX 无法给出的
精确时间与 locator 保证。工具的完整开发者契约见 `docs/REFERENCE.md` 与
`docs/TOOL_LIBRARY.md`。

## 4. Tool Library 已形成完整链路

v0.10.5 的 Tool Library 不再只是静态技能目录，而是以下闭环：

```text
捕获 capture -> 重放 replay -> 沉淀 promote/save
  -> 分发 export/import/bundle -> 度量 useCount/lastUsedAt + funnel events
```

- `ae_exec` 与 `ae_execRecover` 成功后把完整 JSX 捕获为 `candidate`，并把
  `artifactId` 放入执行信封。相同内容去重；若内容已是 saved/pinned，则复用正式
  工件而不再创建 candidate。
- candidate 不进入 `ae_toolSearch` 的默认列表或文本搜索，但可按精确 id 检查并由
  `ae_toolUse` 原样重放。自动清理边界是 7 天、每会话 20 个、全局 200 个。
- `ae_toolSave` 可把 candidate 沉淀为 saved，也可直接创建 `jsx` 或
  `prompt-skill`、更新用户工件或切换 saved/pinned/archived/deprecated 状态。
  prompt-skill 没有捕获阶段，直接创建后由 `ae_skillUse` 列出和渲染。
- saved/pinned 工件可从面板导出为状态根 `exports/` 下的自包含 JSON；导入校验
  内容哈希、密钥与重复内容。构建生成器把导出件或库工件转换为 bundled skill，
  并更新 manifest SHA-256。
- 用户库工件成功经 `ae_toolUse` 或 `ae_skillUse` 使用后更新 `useCount` 与
  `lastUsedAt`；活动日志记录 use/render/promote/create/update/status 漏斗事件。

管理界面的目标位置是面板的**工具页**。候选与已保存工件、沉淀、置顶、归档、
恢复、删除、清空候选、导入和导出都在该页完成；这是与并行 issue #350 对齐的
产品位置，不再把 Tool Library 描述成设置项。

## 5. 占位符死循环已经在宿主边界切断

聊天历史压缩会把旧脚本正文替换为脱敏占位符。宿主在 `ae_exec` 和
`ae_execRecover` 派发前执行两层检测：已知 marker 精确匹配，以及“占位形状 ×
脱敏词族 × history/token/context 词族”的启发式匹配。拒绝发生在 AE 执行之前，
不会覆盖恢复脚本。

第一次拒绝会要求重写完整脚本，并列出本会话最近的可重放 candidate；同一 MCP
会话连续第 2 次起启用短路文案，只保留完整重写或精确 `ae_toolUse` 重放这一条
出路。每次拒绝都记录 `placeholder_rejected`、连续次数、脚本长度与脱敏摘要；
一次通过守卫并进入正常执行的调用会重置该会话计数。

## 6. 接入与状态根

- 原生 HTTP 客户端直接连接 `/mcp`。Claude Code 的标准命令是
  `claude mcp add --transport http ae http://127.0.0.1:11488/mcp`。
- 只支持 stdio 的客户端使用 `npx -y ae-mcp-jkdg`；连接器转发到同一面板 URL。
- 面板必须保持打开。面板关闭或重载会断开 MCP 会话，客户端重连是正常行为。
- 默认持久状态根是 `~/.ae-mcp`。`AE_MCP_STATE_DIR` 覆盖整个状态根，
  `AE_MCP_HOME` 仅作为兼容回落；`AE_MCP_LOG_DIR`、`AE_MCP_TOOL_DIR`、
  `AE_MCP_SKILL_DIR` 分别覆盖日志、Tool Library 与 legacy skill 目录。

## 7. 当前路线图

| 状态 | 项目 |
| --- | --- |
| 已完成 | Python MCP 服务、sidecar 与 platform-helper 退役；`/mcp` 进入 CEP host。 |
| 已完成 | 13 工具公开面；恢复信封、结构化读取、预览区间/差分与冻结 native 路由。 |
| 已完成 | Tool Library 捕获 → 重放 → 沉淀 → 分发 → 度量全链。 |
| 已完成 | 占位符守卫、重放指路、会话断路器与诊断遥测。 |
| 进行中 | issue #350：Tool Library 管理功能集中到工具页。 |
| 已分派 | `jsx-bridge` 超时后队列提前释放的重叠窗口；按现有 issue 修复，不重复立项。 |
| 后续准入 | 只有能通过公开 MCP → 真实 AE 状态闭环证明用户价值的 ExtendScript 能力。 |

## 8. 明确不做

- 不新增原生 AEGP primitive，不恢复 native capability-package/codegen 流水线。
- 不恢复 Python package server、Python 桥、sidecar、platform-helper 或旧安装入口。
- 不增加第四个 provider/backend 适配器，不扩展已裁决删除的旧 provider facade。
- 不给捕获脚本增加独立的“目标身份戳”。候选以内容哈希、来源与会话 provenance
  管理；执行前仍由真实 AE 读取、审批绑定与写后验证确认目标。除非公开验收路径
  复现了仅靠现有 locator/读回无法解决的错误，否则不增加另一套身份层。
- 不把 candidate 自动提升为正式工具；沉淀必须经 `ae_toolSave` 或用户在工具页操作。
- 不承诺面板重启后的 MCP 会话或进行中任务恢复。
- 不把 loopback 服务扩展为远程、多用户或多租户产品。
- 不把 HDEV 证据称为 release-accepted；正式发布仍需独立 T5/T6 边界。

## 9. 现行文档

| 文件 | 用途 |
| --- | --- |
| `docs/INSTALL.md` | 安装、HTTP 与 stdio 客户端接入 |
| `docs/REFERENCE.md` | MCP 工具、恢复、预览、错误与状态根参考 |
| `docs/TOOL_LIBRARY.md` | Tool Library 工件、生命周期、守卫、路由与分发 |
| `docs/WORKFLOW.md` | 当前开发与验收路径 |
| `docs/THREAT_MODEL.md` | 单用户单机信任边界 |
| `docs/native-sdk/SDK_INPUTS.md` | 冻结 native 平面的 SDK 输入政策 |
| `docs/RELEASE.md` | 打包、签名与发布验收 |
