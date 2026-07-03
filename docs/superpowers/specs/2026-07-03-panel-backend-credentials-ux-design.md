# 面板凭据通道与 Settings UX 重构设计

日期：2026-07-03　状态：已获用户批准　范围：plugin/panel/、plugin/sidecar/

## 背景与问题

v0.8.3 面板对每个 AI 后端各有一套独立发明的凭据检测逻辑，均不读取用户实际存放凭据的位置，导致三类故障：

1. **ZCode**：面板只读 ZCode 桌面版配置（`~/.zcode/v2/`），不读 CLI 配置（`~/.zcode/cli/config.json`）。provider 评分逻辑（zcodeBackend.js 的 `zcodeProviderScore`）给内置 `-start-plan` 条目 +80/+30 分而"有 apiKey"仅 +10 分，导致宁选无 key 的官方托管计划并报 `Model provider is missing an API key: builtin:zai-start-plan`（英文内部错误原样透传）。官方计划还需面板尚未实现的桌面验证码桥接。
2. **Codex**：面板 spawn `codex app-server` 问 `account/read` 判定登录，但 CEP 环境是 AE 启动时的快照——PATH 解析到的 codex 可能不是用户登录的那份，`USERPROFILE/HOME/APPDATA` 可能缺失，导致 CLI 已登录而面板判未登录。
3. **Claude**：面板只认订阅登录态（Agent SDK 自发现），三处代码（claudeAuth.js / claudeAgentBackend.js / sidecar lib.mjs）无条件 `delete ANTHROPIC_API_KEY`。用户在 Claude Code Desktop（Claude-3p 第三方托管版）配置的 `ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN` 只注入其自身进程树，面板无法继承，也没有代码去读 `~/.claude/settings.json`。

实机核查结论（用户机器，Windows 11）：
- `~/.zcode/cli/config.json` 存在自定义 provider（openai-compatible，`baseURL` + `apiKeyEnv` 指名环境变量）与默认模型，完全可解析。
- 相关 API key 环境变量均**不是** Windows 持久化（注册表 User/Machine 层皆无），只存在于特定进程树。CEP 面板继承不到，"继承"必须以读配置文件为主 + 面板内一次性粘贴 key 兜底。
- Claude-3p 的 host-creds 文件（`AppData\Local\Claude-3p\host-creds-<GUID>.json`）属内部实现，不做自动读取。
- Claude Code / Agent SDK 原生支持 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` 指向第三方兼容端点——面板可将其注入 sidecar 实现完整 agentic 体验跑在自定义 provider 上。

UI 侧问题：BYOK 是后端四选一的一个分支且无中文解释；Codex 与 BYOK 用同一 ApiProfileFields 组件渲染出无差别表单；Settings 为单页长表单无折叠；存在死代码（OpenCode 分支、PanelFrame.jsx）、假开关（随 AE 启动）、无效按钮（导出日志恒 disabled、关于区文档/GitHub 未绑定）；Settings/ConnectionDrawer/Wizard 三处重复实现配置逻辑。

## 已确认的设计决策

- 凭据哲学：**继承外部配置为主**，面板手填为兜底覆盖。
- BYOK **并入 Claude 后端**成为其"API 直连"通道，后端从四选一减为三选一，"BYOK"一词从 UI 消失（中文呈现"API 直连"）。
- Settings 布局：**全部分区可折叠**（左侧箭头），默认只展开「AI 服务」，展开状态持久化 localStorage。
- 日志导出功能**补全实现**（不删除）。
- 面板内自定义 provider 统一由内建「Provider 管理器」配置管理（带模型探测）；cc-switch 检测到时作为可选导入源，不作为前置依赖。

## A. 统一凭据模型："后端 × 凭据通道"

后端三选一：Claude / Codex / ZCode。每后端内部有有序的凭据通道，按序探测，命中即用；UI 显示当前生效通道与来源徽标（"订阅登录"/"继承自 ZCode CLI"/"继承自 Claude Code 配置"/"面板配置"）；全部可用时用①，用户可手动锁定某通道。

| 后端 | 通道①（优先） | 通道② | 通道③ |
|---|---|---|---|
| Claude | 订阅登录（Agent SDK 自发现，保留现状逻辑） | API 直连（原 BYOK：Base URL + Key/Token；优先经 sidecar 注入 `ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN` 获得完整 agentic 能力；Node 不可用时降级走现有 byokLoop 直连 HTTP） | — |
| Codex | CLI 登录态（`account/read`，修复 spawn env） | 自定义 provider（Base URL + Key，现状保留） | — |
| ZCode | CLI 配置继承（读 `~/.zcode/cli/config.json` provider + 默认模型；`apiKeyEnv` 解析：spawn env 有则用，无则面板提示粘贴一次，存 `~/.ae-mcp/zcode-key`） | 桌面版配置（`~/.zcode/v2/`，现状逻辑降为次级） | 官方托管计划（start-plan）：桥接未实现前仅在检测到有效凭据时可选，绝不作为无 key 默认 |

Claude API 直连通道的 env 注入要求把现有三处无条件 `delete ANTHROPIC_API_KEY`（claudeAuth.js:62、claudeAgentBackend.js:71、lib.mjs:495 附近）改为**按通道条件化**：订阅通道探测/会话时仍删除（防串路），API 直连通道则注入用户配置的 base URL 与 token。

## A2. Provider 管理器（统一自定义 provider + 模型探测）

面板内所有"自定义 provider"类凭据（Claude API 直连、Codex 自定义 provider、ZCode 手填兜底）不再各自维护分散的 Base URL/Key 字段，统一收口到内建的轻量 Provider 管理器：

- **存储**：`~/.ae-mcp/providers.json`，每条 provider 含 `{id, name, protocol: "anthropic"|"openai-compatible", baseUrl, apiKey, probedModels, probedAt}`。key 写入沿用现有 `~/.ae-mcp` 原子写 + chmod 600 方案；现有 `~/.ae-mcp/anthropic-key`、`~/.ae-mcp/codex-key` 与 localStorage 中的 `ae_mcp_anthropic_base_url`/`ae_mcp_codex_base_url` 首次启动自动迁移为 provider 条目。
- **模型探测**：`GET {baseUrl}/v1/models`，openai-compatible 用 `Authorization: Bearer`，anthropic 协议用 `x-api-key` + `anthropic-version`（Anthropic 官方同样提供 GET /v1/models）。探测结果缓存为该 provider 的可选模型列表并驱动 Chat composer 的模型 chip；探测失败时降级为手填模型 ID（保留现有"自定义模型 ID"能力）。实测用户中转站（New API 类网关）`/v1/models` 返回 200 与 16 个模型，方案可行。curated 静态模型列表仅用于官方通道（订阅/CLI 登录态）；自定义 provider 通道以探测结果为准。
- **通道引用**：各后端通道卡中的自定义通道呈现为"provider 选择下拉 + 该 provider 探测出的模型列表 + 管理入口"，同一 provider 可被多个后端通道复用（例如同一中转站同时服务 Claude 与 ZCode 的场景）。
- **cc-switch 导入**：启动探测时检测 cc-switch 配置（若存在），提供一键导入其 provider profiles 进管理器；不将 cc-switch 加入向导的前置依赖安装列表（实机核查用户机器未安装，且第三方配置格式不稳定，只做可选继承源）。

## B. 三个故障的修复

1. **ZCode**
   - `zcodeDesktopProviderEntry` 处合并 CLI 配置来源（`~/.zcode/cli/config.json`），CLI 优先于桌面版。
   - 修 `zcodeProviderScore`："有可用凭据"权重必须高于 family 匹配（+80）与 `-start-plan` 后缀（+30）的固定加分。回归用例：有 key 的自定义 provider 必须赢过无 key 的 builtin start-plan。
   - `apiKeyEnv` 解析链：spawn env → 面板存储（`~/.ae-mcp/zcode-key`）→ 提示用户粘贴。
   - 错误文案本地化（zh/en 双语，跟随界面语言设置）、可操作化（指明去哪个通道、做什么），不再透传 `builtin:zai-start-plan` 式内部错误。
2. **Codex**
   - spawn 前显式补全 `USERPROFILE/HOME/APPDATA`。
   - probe 结果附带解析到的 codex 可执行文件绝对路径与版本，暴露到 UI 诊断。
   - 新增 `AE_MCP_CODEX_CLI` 环境变量覆盖二进制路径（对齐 ZCode 的 `AE_MCP_ZCODE_CLI` 做法）。
3. **Claude**
   - 订阅探测失败时给出中文引导至"API 直连"通道。
   - 低成本继承：若 `~/.claude/settings.json` 存在 `env.ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN`，提供一键导入预填 API 直连通道。
   - Claude-3p host-creds 不自动读取；UI 说明该场景请手动填一次。

## C. Settings 布局重构

- 六分区全部可折叠（左侧箭头），默认仅展开「AI 服务」，展开状态存 localStorage。
- 「AI 服务」区重构为"三选一 Segmented + 每后端一张通道卡"：卡内为通道列表（状态点 + 来源徽标 + 配置字段/检测按钮），替代现有四套 if/else 重复分支。
- 「AI 服务」区内提供「Provider 管理」入口（列表 + 新增/编辑/删除 + 逐条"探测模型"按钮与结果展示），自定义通道的 provider 下拉与其联动。
- 清理：删 OpenCode 死分支（SettingsScreen.jsx 499–506 及关联）、删假"随 AE 启动"开关、删未引用的 `screens/PanelFrame.jsx`；「关于」区文档/GitHub 按钮绑定真实链接。
- **日志功能补全**：日志级别选择保留并确保生效；"导出日志"实现为——聚合面板日志缓冲、host server 日志、sidecar stderr tail，写入 `~/.ae-mcp/logs/export-<时间戳>.txt` 并在资源管理器中定位该文件。
- 职责收敛：ConnectionDrawer 仅只读状态+诊断；端口/Token 编辑只在 Settings；Wizard 第 3 步复用新通道卡组件；「关于」区加"重新运行向导"入口。

## D. 数据流与错误处理

- 每后端统一 `probeChannels()` → `[{channel, source, ok, detail, fixHint}]`；`pickBackend` 改为消费该结构，替代 probe/codexProbe/zcodeProbe 三套异构 state。
- 所有不可用状态必须携带本地化 `fixHint`（zh/en 双语，具体动作指引）。

## E. 测试

- panel 单测：ZCode CLI 配置合并与评分修正（含上述回归用例）、apiKeyEnv 解析与粘贴兜底、Codex spawn env 补全、`pickBackend` 通道逻辑、折叠状态持久化、日志导出聚合逻辑、provider store 的 CRUD 与旧配置迁移、/v1/models 双协议探测解析与失败降级、通道-provider 引用联动。
- sidecar 单测：按通道条件化的 env 处理（订阅删 key / API 直连注入 base URL+token）。
- 收尾 live 手测：用户三个真实场景（ZCode 继承 CLI provider、Codex CLI 登录态、Claude API 直连跑第三方中转）各验证一遍。
