# 更新日志 / What's New

让 AI 操控 After Effects 更稳、更顺、更省心。
Making AI-driven After Effects more reliable, smoother, and worry-free.

格式参考 [Keep a Changelog](https://keepachangelog.com/)，版本遵循 [语义化版本](https://semver.org/)。
Format based on Keep a Changelog; versioning follows SemVer.

---

## 中文

### [0.9.2] — 2026-07-13

#### ✨ 新增

- **按模型路由的通用自定义 Provider（#49）**——同一个 Provider 可同时承载 Responses、Chat Completions 与 Anthropic Messages 模型。每个明确模型 ID 独立探测并缓存协议能力：原生支持 Responses 时直连 `/responses`；仅支持 Chat Completions 时由本地 `/responses` facade 做可审计转换；只有请求含无法等价转换的 Responses 特性时才返回带字段路径的 compact 501，绝不静默丢字段。
- **安全平台 Helper 与系统凭据库（#49）**——Provider API key 不再从明文配置回读；Helper 启动、认证或系统凭据库异常时 fail-closed。Panel 启动 Helper，Helper 生命周期跟随已认证的 AE 主进程，AE 正常退出或闪退后不会残留。
- **完整 Tool Library（#50）**——Panel Tools 页支持搜索、查看、创建、编辑、复制、固定、归档、删除及 `.aemcptools` 安全导入/导出；legacy/bundled skills 与原生制品统一呈现，并通过 `ae.toolIndex → Search → Inspect → Use` 渐进发现和 plan/grant/execute 门禁执行。
- **Codex 官方登录态模型扩展**——加入 GPT-5.6 系列登录态模型，并保留按模型能力选择协议的行为，不再把 Provider 全部模型误判为同一种 API。

#### 🐛 修复 / 改进

- **Windows ZXP Host runtime 打包修复（#58）**——生产包现在将 Express 与 Host package anchor 放入面板实际加载的 `runtime/windows-x64/node/host`，并在签名前后验证该契约，避免面板启动时报 `host runtime dependencies are unavailable`。
- **跨协议角色与流式完成兼容**——向不接受 `developer` 角色的上游安全降级为其支持的等价角色；兼容缺少 `response.completed` 但已正常结束的受限流式实现，同时仍拒绝截断或语义不完整的流。
- **诊断与错误边界收紧**——最小 token 探测按模型运行，未知错误转为可操作的结构化信息；Provider 响应、凭据、请求头和导出内容均经过脱敏与泄漏回归测试。
- **双平台不可变 RC 契约更新**——受保护 `main` 的同一个 candidate SHA 生成 `ae-mcp-panel-v0.9.2-macos-arm64.zxp`、`ae-mcp-panel-v0.9.2-macos-arm64.dmg`、`ae-mcp-panel-v0.9.2-windows-x64.zxp`，由 `artifact-manifest-v0.9.2.json` 绑定 artifact ID 与 SHA-256；正式发布只提升已验证字节，禁止重建。

#### 验证

- Provider、Tool Library 与安全定向回归 207/207，通过额外 44/44 路由安全集成测试；Panel 951 项（944 通过、7 跳过），Python 635 通过（8 跳过、25 deselected）。
- Windows AE 2025 实机已验证 Panel 正常挂载、Helper/凭据链路、`127.0.0.1:11488` 服务与 AE→Helper 生命周期；PR #54 CI 与独立安全复核均无阻断项。

#### 发布范围

- v0.9.2 正式资产仅面向 Windows 11 x64；Provider、Tool Library、Helper 功能与 Windows AE 2025 实机链路已经闭环。macOS、包内 RuntimeManager、完整跨平台签名链和 Mac/Windows × AE 25/26 四格矩阵转入 v0.9.3。Windows ZXP 使用有效至 2037 年的自签名证书；ZXPSignCmd 无法通过本机代理连接 TSA，因此本次资产没有时间戳。包内原生 Helper 尚未进行 Authenticode 签名，发布页会明确披露这些边界。

### [0.9.0] — 2026-07-04

#### ✨ 新增
- **统一凭证通道模型**（#47）——Claude / Codex / ZCode 三路后端现在各自呈现「凭证通道卡」，按优先级自动选择订阅登录、API 直连、CLI 配置继承、自定义 provider、桌面版继承或官方托管计划，并支持手动锁定某条通道。`pickBackend` 已改为通道驱动。
- **Provider 管理器**（#47）——面板内可新增、编辑、删除 OpenAI-compatible 与 Anthropic 协议 provider（Base URL + Key），配置保存在本机 `~/.ae-mcp/providers.json`（0600 权限）；支持一键探测 `/v1/models` 拉取模型列表、从 cc-switch 导入，并自动迁移旧的 `anthropic-key` / `codex-key` / Base URL 偏好。
- **Codex 继承 CLI 配置**（#47）——面板可直接继承 `~/.codex/config.toml` 中的自定义 `model_provider`，并支持对应 `/v1/models` 探测；显式自定义 provider 优先于继承配置。
- **Claude API 直连通道**（#47）——可读取 `~/.claude/settings.json` 中的 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` 作为导入提示；sidecar 新增 `--channel` 参数区分订阅与 API 环境处理。
- **ZCode 模型体验升级**（#47）——模型列表改由 `/v1/models` 探测并缓存 1 小时，默认模型可解锁，会话内换模型会自动重建 session，并补齐缺 key、缺模型配置、desktop OAuth 缺口等双语可读错误提示。

#### 🔧 改进
- **设置页 UX 重构**（#47）——设置页改为状态持久化的折叠分区、三路后端分段控件、复用通道卡、About 链接和可重跑向导；日志导出进入工作中状态，包含脱敏与有效日志级别。

#### 🐛 修复
- **Codex 探测 / 后端重建死循环修复**（#47）——probe 状态变化不再造成配置对象身份抖动和 backend 反复重建；`cli-config` 经 `runtimeRef` 懒读，被替换的 backend 实例会 `reset()` 杀掉旧 app-server 进程，避免 UI 卡在「正在检测凭据通道」并泄漏大量进程。
- **Codex 冷启动提示降噪**（#47）——app-server 冷启动时的 `Reconnecting... N/5` 瞬态通知不再渲染成红色对话错误。
- **Probe 超时与进程卫生**（#47）——`probeAccount` 各 RPC 有独立有界超时；超时的探测进程会被 kill，不再泄漏。
- **探测错误脱敏**（#47）——错误详情不再包含 provider 响应体原文，避免中转端点回显密钥进 UI。
- **通道边界修正**（#47）——修复 `claudeSettingsImport` 反斜杠转义损坏、Codex 自定义 provider 在 `pickChannel` 中正确压过 `cli-config`、ZCode 缓存探测模型正确接入 descriptor 链等实机问题。

#### 📦 说明
- **BYOK 已并入 Claude 的「API 直连」通道**；旧偏好会自动迁移，无需手动操作。
- **ZCode `*-start-plan` 官方托管计划仍需 ZCode 桌面端验证码桥接**；面板检测到有效凭据前不可选。

### [0.8.3] — 2026-07-03

#### ✨ 新增
- **Claude Sonnet 5 进入精选模型列表并成为新的 Claude 默认模型**（#40）；Codex 静态模型列表新增 **GPT-5.4 mini**。

#### 🔧 改进
- **BYOK / Codex API profile 字段统一**（#41）——两类 API profile 现在共用 `ApiProfileFields` 组件，减少重复表单逻辑。
- **ZCode `*-start-plan` 边界写入工作流文档**（#42）——明确该类 provider 仍依赖桌面端能力。
- **实时模型矩阵补齐 `claude-sonnet-5`**（#43）。
- **README 刷新到 v0.8.2 状态**（#44、#45）——补齐 ZCode 后端、`ae_diagnose`、真实合成帧预览，并新增中英双语截图区。

### [0.8.2] — 2026-07-03

#### ✨ 新增
- **ZCode 接入**——外接客户端注册表新增 ZCode，并能生成正确的 `mcp.servers` 配置；面板内嵌 ZCode chat 后端接入 `zcode.cjs app-server`，补齐 session 协议、四档审批映射和 elicitation / `AskUserQuestion` 处理。
- **只读一键诊断 `ae.diagnose`**——新增始终暴露的只读 verb，一次探测 host `/health`（现在会回显 Python 握手字段）、token 有效性、AE 响应和工程打开状态，方便客户端先定位连接断点。
- **真实合成帧预览**——`ae_previewFrame` 现在优先用 `CompItem.saveFrameToPng` 渲染真实 comp 像素，viewer snapshot 只作为 fallback；预览文件进入受管的 `ae_mcp_previews` 临时会话目录，并自动清理超过 24 小时的陈旧会话。
- **Provider profiles 扩展**——BYOK 支持 Anthropic-compatible Base URL 和自定义模型 ID，并按 Base URL 缓存模型列表；Codex 后端支持 OpenAI-compatible 自定义 provider，API key 本地保存，`wire_api` 固定为 `responses`。

#### 🐛 修复 / 改进
- **ZCode 失败模式可读**——真机验证出的 provider API key、模型配置、desktop OAuth runtime-headers 缺口等失败，现在在面板里显示为可读提示，不再冒出 `[object Object]`。coding-plan providers 可经 OAuth credential bridge 工作；`*-start-plan` providers 仍需要 ZCode 桌面端（captcha / runtime headers 目前还不能桥接）。
- **禁止截图绕路**——server instructions 和 sidecar prompts 明确禁止用 OS screenshot / desktop automation 绕过 `ae_previewFrame`，把预览路径收回到 AE 渲染链路。
- **CI 锁住 panel dist**——CI 现在验证 `plugin/client/dist/app.js` 与 panel 源码同步；新增 `.gitattributes`，统一 `eol=lf` 并把 dist bundle 标为 binary。

### [0.8.1] — 2026-06-14

#### 🐛 修复 / 改进
- **引导向导去掉「等待握手」死胡同步骤**——该步在客户端未连接时根本没有完成按钮(只能干等或 60s 超时),而它只是连接验证、并非功能门;连接状态本就常驻在 ConnectionDrawer。向导精简为 **3 步**,末步「连接 AI 客户端」直接「开始使用」。

### [0.8.0] — 2026-06-14

把 AE 操作专识沉淀进 ae-mcp 本体——跨后端、免沙箱，且**默认开、可一键关**：常驻成本由用户掌控。

#### ✨ 新增
- **AE 专家防错指导（默认开，可关）**——握手指令新增一段 ExtendScript 高频陷阱铁律（文字层取回-改-回写 / 字体 PostScript 名 / addProperty 两遍法 / 新建图层 prepend 顺序 / effect 子属性按索引）。由 `AE_MCP_EXPERT_GUIDANCE` 开关控制，是唯一的常驻 token 成本（每会话握手仅下发一次）；面板设置页一键开关。
- **内置技能库（7 个，按需取、零常驻）**——`ae_skillList`/`ae_skillUse` 现自带一套打包技能：`extendscript-cookbook`（情景化 JSX 配方与坑）、`kinetic-typography`、`ease-and-timing`、`grade-stack`、`render-order`、`project-organization`、`glow-recipes`。走新的"内置只读技能目录"机制（用户同名技能可覆盖、内置不可删），随包发布；只有 agent 主动取用时才占 token。
- **错误提示扩充**——新增「属性未与图层关联 / 字体名无效 / fontSize 超 1296」三条自动修复提示，并给 null 族提示补上"effect 子属性改用索引"的兜底。
- **三后端都吃到指导**——mcpClient 捕获握手指令；BYOK 追加进 system；Codex 以首轮 preamble 注入（Codex 不转发 MCP 指令）；Claude 订阅经 Agent SDK 原生转发。

#### 📦 说明
- 开关默认开；介意常驻成本的用户可在设置页关掉，技能与错误提示不受影响、始终可用。
- 内嵌后端要求不变（Claude 订阅 Node≥18 + 登录 / Codex CLI 登录 / BYOK Anthropic key）。

### [0.7.0] — 2026-06-13

内嵌对话走向**多框架**，并把后端接入正式化：新增 **Codex 内嵌后端**之外，这一版把"内嵌后端接口"抽象成注册表 + 契约，新增**外接客户端注册表**（让任意 MCP 客户端一键接入），P6 的撤销/空结果标记，以及一次彻底的文档刷新。

#### ✨ 新增
- **内嵌后端接口正式化**——后端注册表 + 冻结的事件契约 + 一致性测试，把上一版真机踩出的协议坑固化为新后端必须满足的契约；面板按注册表查表选择后端，新增后端不再往主流程塞分支。
- **外接客户端注册表**——数据驱动的外接客户端清单（Claude Desktop / Claude Code / Cursor / OpenCode / OpenClaw / AstrBot / Gemini Antigravity），向导第 3 步与设置页据此渲染并生成正确的 MCP 配置。新增一个框架 = 加一行数据。
- **OpenCode 外接支持**——OpenCode 作为外接 MCP 客户端接入 ae-mcp（面板内嵌 OpenCode 后端已实现但门控待验证，延后到 v0.7.1）。
- **IM-bot 框架网络提示**——OpenClaw / AstrBot 等常驻或 Docker 化、可能不与 AE 同机；注册表条目明确同机 / `127.0.0.1:11488` 端口可达性要求。
- **P6：撤销到上一检查点 + 空结果标记**——活动流把"成功但无返回值"的工具调用（AE 2026 未捕获异常的静默空结果类）显著标记为中性"无返回值"，区别于错误；新增"撤销到上一检查点"动作。
- **全模型矩阵冒烟脚本**（`scripts/live-model-matrix.mjs`）——两后端 × 多模型一键体检。

#### 🐛 修复 / 改进
- 文档全面刷新到 v0.7.0 真实状态（README / WORKFLOW / RELEASE / 各包 readme / parity roadmap）：完整面板产品、双层后端接入、`uv tool install` 三件套安装（不再是失效的 `pip install ae-mcp`）。

#### 📦 说明
- 内嵌后端：Claude 订阅需 Node ≥18 + 已登录 Claude Code；Codex 需 Codex CLI 登录；BYOK 需 Anthropic key。
- OpenCode 这一版仅作外接客户端；面板内嵌 OpenCode 留待 v0.7.1（其审批门控需 OpenCode 权限 DSL 的真机验证）。

### [0.6.0] — 2026-06-13

内嵌对话成为**多 agent 框架**产品：新增 **Codex 后端**（OpenAI 订阅直连），加上模型/思考/快速/审批四枚 composer 便捷选择、向导全包一键化与一轮显著的降错工程。本版包含原计划 v0.5.0 的全部内容。升级后请重新安装/同步面板并重载；Python 端建议一起升。

#### ✨ 新增
- **Codex 对话后端**——面板直连 `codex app-server`（实验协议，已按官方 schema 与真机转录逐项适配）：复用你的 Codex 订阅登录态（设置页直读邮箱与计划），模型列表由 `model/list` 动态生成（含每模型思考档位与快速档），线程跨轮保活（注入的 ae-mcp 只冷启一次）。
- **审批四档（只读 / 手动 / 自动 / 免审）**——语义由工具注解驱动，跨后端一致：Claude 侧经 SDK `allowedTools`/`dontAsk` 与回调；Codex 侧消费其原生逐调用审批（毫秒级静默放行只读/免审/自动档非破坏操作，该弹卡的带真实工具名与参数，支持"本会话此类操作免批"）。
- **Composer 便捷选择条**——模型（含 $ 成本标识，会话内切换不清空对话）、思考深度（框架原生档位：Claude effort 五档 / Codex 四档，按模型裁剪）、快速模式（Codex 原生 1.5×；BYOK+Opus 3×）、审批档。设置页模型项改为「默认模型」。
- **向导全包一键化**——uv / Node / Claude CLI / ae-mcp 全部检测+一键安装（命令原文先行展示，官方源），登录拉起可见终端零打字；装完免重启 AE。替换了失效的 `pip install ae-mcp` 指引（改走按发布 tag 的 git 源）。
- **思考中指示**——模型推理阶段对话流尾部显示脉冲提示，不再"看似卡死"。
- **降错工程**——两个 agent 系统提示注入 AE 脚本陷阱速查；常见 ExtendScript 错误自动附加修复提示（`[hint]`）；prelude 新增 `AEMCP.easeKeys()`（缓动数组按属性维度自动构造）与 `AEMCP.mustFind()`。实测同任务错误轮次从 4 降到 0。
- **全模型矩阵冒烟脚本**（`scripts/live-model-matrix.mjs`）——两后端 × 8 模型一键体检，本版发布前 8/8 通过。

#### 🐛 修复
- 审批卡不再无差别弹出/无法落定/只显示「MCP」（Codex 路径审批架构重做）。
- chips 下拉菜单被容器剪裁不可见；向导工具行不自动检测；claude 命令探测在 Windows 误报缺失（npm .cmd 需 shell）；`ae-mcp --version` 探测挂起 stdio 服务器（改存在性探测）；向导登录复检不重跑探针。
- 「订阅」后端更名「Claude」，多后端语境不再歧义。

#### 📦 说明
- Codex 后端需本机安装并登录 Codex CLI（≥0.139）；Claude 后端要求不变（Node ≥18 + `claude` 登录）。
- `codex app-server` 为实验接口，协议变动可能需要跟进适配。

### [0.4.0] — 2026-06-12

面板从"连接配置器"长成完整产品：**对话、审批、活动流、向导、诊断全部内置**。本版合并 #26（外壳 + 后端使能）、#27（向导 + 活动界面）、#28（内嵌 AI 对话）。升级后请重新安装 / 同步面板并重载一次；Python 端与面板建议一起升。

#### ✨ 新增
- **面板内嵌 AI 对话**（#28）——不开任何外部客户端，直接在 AE 面板里让 AI 操作工程。双后端：**Claude 订阅**（默认）——面板用系统 Node 拉起 Agent SDK sidecar，复用 `claude /login` 登录态，零 API key、零 token 落盘，模型工具面锁死为 ae_ 工具；**BYOK** 兜底——自带 Anthropic API key 的内置 agent 循环。仅在真实后端切换时清空会话。
- **操作审批**（#28）——手动 / 自动 / 免审三档权限；破坏性动作（exec、revert 等）弹卡确认，拒绝会回传给模型让它改道；停止回合会作废全部悬挂审批，不会污染后续回合的免审白名单。
- **首跑向导与连接诊断**（#27）——四步引导 + 五项自检定位断点；按客户端信任管理（拉黑 / 解封）。
- **活动流**（#26/#27）——每次 AE 操作实时上屏：调用方、undo 组、结果、耗时；kill switch 一键熔断所有 AI 操作。
- **面板外壳与设计系统**（#26）——React 18 单文件 bundle，AE 原生暗色视觉，中英双语。
- **CI 覆盖 JS 测试**——panel / sidecar / host 三套 node:test 纳入 CI（此前仅 Python）。

#### 🐛 修复
- **本地化（如中文版）AE 的 `/exec` 非 ASCII 返回不再乱码**——ExtendScript→CEP 边界按系统码页回传字节；现在全部 /exec 流量走 ASCII 安全信封双向转义。
- **未捕获的 ExtendScript 异常不再静默丢失**——AE 2026 上 evalScript 对未捕获异常返回空串（官方哨兵已失效）；信封在 JSX 侧捕获并带回真实错误文本与行号（`ExtendScript error: …`），空输出与传输故障可区分。
- **`ae_setProperty` 写文本图层 Source Text 不再误报失败**——TextDocument 等宿主对象统一经 `AEMCP.safeValue` 序列化兜底，写入成功不再因回包序列化崩溃而报 "jsx returned no value"。
- **ZXP 打包补齐 sidecar 生产依赖、剔除开发目录**——干净安装的订阅后端此前会因缺依赖无法启动。
- **审批卡不再挂到上一回合的旧调用**——sidecar 工具簿记按回合清零。

#### 📦 说明
- 订阅模式需要本机 Node ≥ 18 和已登录的 Claude Code（`claude /login`）；BYOK 模式无此要求。
- CI runner Node 20 → 24。

### [0.3.2] — 2026-06-11

收尾 v0.3.1 时有意留待讨论的最后 3 条 review 发现（#22/#23/#24），"静默成功"主题至此全部关闭。均为兼容修复，**唯一可见的行为变化就是修复本身**：失败现在会在 MCP 协议层被如实标记。

#### 🐛 修复
- **失败的工具调用现在在 MCP 协议层置 `isError`**（#22）——此前所有结果在协议层一律报成功，失败只藏在 payload 文本的 `{ok:false}` 里；按 `isError` 分支 / 统计的 MCP 客户端会把失败的 AE 操作记成成功。payload 格式不变：`isError` 供机器分支，`{ok:false, error}` 照旧供人和模型阅读。
- **以 `EvalScript error` 开头的合法字符串不再被误判为失败**（#23）——错误哨兵改为与 CEP 常量 `"EvalScript error."` 精确比对（此前是裸前缀匹配），`ae.exec` 读出 `"EvalScript errors found: 0"` 这类文本不再被错误拒绝；三处哨兵副本已互链锁定，防止再次漂移（#8 的失配漏报、#23 的前缀误报，同根问题就此了结）。
- **`ae_setProperty` 的 `at_time` 支持负时间**（#24）——AE 图层可早于 t=0，负时间关键帧合法；此前 `-1.0` 兼任内部哨兵，负 `at_time` 会被静默改写成常量值（不建关键帧）还报成功。内部哨兵改为 `null`，任意数字（含负数）都如实建关键帧。

#### 📦 依赖
- `mcp` Python SDK 下限 `>=1.0.0` → `>=1.19.0`——#22 需要 `CallToolResult` 直接返回（python-sdk v1.19.0 引入；更老版本会静默错误处理该返回值）。

### [0.3.1] — 2026-06-11

继 0.3.0 之后，这一批补齐了 issue #8(“失败伪装成功”)修复方案的剩余部分。全部为兼容的健壮性改进，**不影响已有调用方**。

#### 🐛 修复
- **针对已删除 / 失效 comp、越界图层 id 的操作返回明确的“找不到”**（#8）——此前在 AE 26.2+ 上会抛出不透明的 `EvalScript error.`；现在 comp / 图层查找统一走防御式 helper，稳定返回 `{ok:false}`。
- **只升级 Python 端、面板没重启也不再整批失效**（#8）——脚本现在自带所需的 helper 定义，不再依赖面板那一侧是否已加载新版命名空间，消除升级时的版本错配。
- **坏掉 / 半卸载的截图插件不再拖垮整个工具列表**——快照器发现过程逐个隔离，单个损坏的扩展只会被跳过并记一条警告。
- **后端缺失时给出可操作的提示，而不是空白工具列表**——新增 `ae_status` 诊断工具：没有可用后端时返回带安装指引的说明；其它 AE 工具异常时可先调它排查。
- **更多失败被如实上报**（#8）——属性路径写错、传入无效图层 id、脚本输出损坏 / 被截断，现在都返回明确错误，而不是一个具有欺骗性的“成功”。
- **插件 `/health` 报告真实版本号**，不再硬编码为 `0.1.0`。

### [0.3.0] — 2026-06-10

> ⚠️ **升级须知（破坏性变更）**：本次为插件的 `/exec` 接口加上了本地鉴权，**面板（CEP 插件）和 Python 端必须一起升级**。只升级一边会导致调用被拒（401）。请按文档重新安装 / 同步面板后再使用。

本次发布合并了 6 个修复 PR（#14–#19），覆盖数据安全、连接安全、跨语言与大型工程的健壮性，以及一批安装与字段一致性问题。

#### 🔒 安全
- **`/exec` 现在需要本地令牌鉴权**（#11）——此前任何本地进程都能向插件发送任意脚本并以你的身份执行。面板启动时会在 `~/.ae-mcp/auth-token` 生成密钥，只有持有它的本机调用方才能执行。
- **不再向用户分发远程调试端口**（#11）——打包的面板会剔除 `.debug`，避免在每台机器上开放可被本地进程附加的调试端口。签名也改为必填证书密码并加入时间戳服务。
- **脚本调用串行化**（#11）——并发请求不再交错执行、互相污染。

#### 🐛 修复
- **回滚不再把工程偷偷搬进临时目录**（#10）——`ae_revert` 现在把存档原子地还原到原工程路径再打开原文件；此前会直接打开 `%TEMP%` 里的副本，导致之后的保存写进临时目录、并可能被清理删除。未保存（无路径）的工程会被明确拒绝而非冒险打开。同名工程的存档也不再互相串台。
- **失败不再伪装成成功**（#8）——ExtendScript 抛错会作为错误上报；无效 / 越界图层 id 返回明确的“找不到图层”而非崩溃；后端选择失败会给出可诊断提示。
- **从零克隆即可安装**（#9）——锁文件已纳入版本管理，文档里的 `npm ci` 在干净克隆上不再失败。
- **非英文版 AE 下新建图层不再丢失位置**（#12）——改用与语言无关的属性寻址。
- **大型工程的搜索 / 扫描不再卡死**（#12）——超出时间预算会返回已找到的部分结果并标记 `truncated`，而不是耗尽超时、零结果、还卡住界面。
- **进度心跳真正发出**（#13）——长任务不再因“看似无响应”被客户端中途断开。
- **截图抓的是 After Effects 窗口**（#13）——按进程识别 AE 窗口，不再误抓同名网页标签页或整块屏幕；找不到时明确报错。
- **部分客户端（如 Claude 桌面版扩展）连接报错**（#3 / #4 / #7）——工具名统一为下划线形式（`ae.ping` → `ae_ping`），严格客户端可正常连接；**仍兼容原有带点名调用**。
- **含 `$` 的技能脚本不再保存后无法使用**（#12）——`$.writeln` 等 ExtendScript 写法可正常渲染。
- **预览的 `scale` 参数现在真的生效**（#13）。

#### 🔧 改进
- **面板端口会被记住**（#13）——重启后不再重置为默认值，`AE_MCP_PLUGIN_URL` 不会被悄悄打断。
- **文档**（#13）——补充“三件套需一起安装”、`AE_MCP_SKILL_DIR` / `AE_MCP_CHECKPOINT_KEEP` 环境变量说明，以及 PyPI 占名风险提示。

### [0.2.0] — 2026-06-05

本次发布合并了两个 PR：**#1**（多步操作可靠性）和 **#2**（向 Atom 能力对齐的一轮优化）。
**所有改动默认保持原有使用习惯，不影响已有调用方。**

#### ✨ 新增
- **AI 常用动作工具箱**（#2）——内置一套常用构件，AI 自动生成的脚本更少出错、复杂操作更容易一次做对。
- **AI 连接即获使用说明**（#2）——AI 一连上就拿到操作指引，从一开始就用对各项功能、少走弯路。
- **图层列表更好用**（#2）——可按需分页、能直接看到每个图层的类型和父级，并新增精简文本视图（数据量约为原来的三分之一）。**默认仍一次返回全部图层。**
- **控制器 / Rig 可结构化声明**（#2）——搭控制器时直接声明每个控件，更清晰、更可靠。

#### 🔧 改进
- **自动备份不再拖累操作**（#2）——备份出问题时自动跳过并照常执行，绝不卡住、也不会丢失正在做的修改。
- **结果处理更稳、失败不再静默**（#1）——统一了内部结果解析，出错会被明确标记出来，而不是悄无声息地略过。

#### 🐛 修复
- **多步操作有时只做了第一步就停下**（#1）——现在每一步都会完整执行。
- **图层超过 100 层时静默丢层**（#2）——默认恢复为返回全部图层，分页改为按需开启。
- **未知 id 导致莫名失败、弹出看不懂的报错**（#2）——已修复。

### [0.1.0] — 基线

Atom 级 After Effects 插件 MVP：30 个 `ae.*` 工具，覆盖 MCP → Python → HTTP → CEP → ExtendScript 链路，含早期的预览截帧修复。

---

## English

### [0.9.2] — 2026-07-13

#### ✨ Added

- **Per-model universal custom Provider routing (#49)** — one Provider can host Responses, Chat Completions, and Anthropic Messages models. Protocol capabilities are probed and cached per explicit model ID: native Responses models use `/responses`; Chat-only models use the local `/responses` facade with auditable conversion; only non-equivalent Responses features receive a compact 501 with a field path, and fields are never silently discarded.
- **Secure Platform Helper and system credential store (#49)** — Provider API keys are never read back from plaintext configuration. Helper startup, authentication, and credential-store failures remain fail-closed. The Panel starts Helper, and Helper follows the authenticated AE process lifetime so it does not survive a normal exit or crash.
- **Complete Tool Library (#50)** — the Panel Tools page supports search, inspect, create, edit, duplicate, pin, archive, delete, and safe `.aemcptools` import/export. Legacy/bundled skills and native artifacts share one view, with progressive `ae.toolIndex → Search → Inspect → Use` discovery and plan/grant/execute enforcement.
- **Expanded Codex authenticated models** — GPT-5.6 family models are available to the official-login channel, while protocol selection remains model-specific instead of classifying every model on a Provider as one API type.

#### 🐛 Fixed / Improved

- **Windows ZXP Host runtime packaging (#58)** — the production package now places Express and the Host package anchor under the Panel's actual `runtime/windows-x64/node/host` load path and verifies that contract around signing, preventing `host runtime dependencies are unavailable` at Panel startup.
- **Cross-protocol roles and stream completion** — upstreams that reject the `developer` role receive a safe equivalent supported role. Restricted streaming implementations that finish cleanly without `response.completed` are supported without accepting truncated or semantically incomplete streams.
- **Tighter diagnostics and error boundaries** — minimal-token probes run per model; unknown failures become actionable structured errors; Provider responses, credentials, headers, and exports are covered by redaction and leak regressions.
- **Updated immutable dual-platform RC contract** — one protected-`main` candidate SHA produces `ae-mcp-panel-v0.9.2-macos-arm64.zxp`, `ae-mcp-panel-v0.9.2-macos-arm64.dmg`, and `ae-mcp-panel-v0.9.2-windows-x64.zxp`; `artifact-manifest-v0.9.2.json` binds artifact IDs and SHA-256, and release promotion never rebuilds verified bytes.

#### Validation

- Provider, Tool Library, and security targeted regressions pass 207/207, plus 44/44 route-security integration tests; Panel tests report 944 passed and 7 skipped out of 951, while Python reports 635 passed, 8 skipped, and 25 deselected.
- Windows AE 2025 hardware validation covered Panel mounting, Helper/credential flow, the `127.0.0.1:11488` service, and AE→Helper lifetime. PR #54 CI and the independent security review found no blocking issues.

#### Release Scope

- v0.9.2 publishes a Windows 11 x64 asset only. Provider, Tool Library, Helper behavior, and the Windows AE 2025 hardware path are closed. macOS, bundled RuntimeManager, the complete cross-platform signing chain, and the Mac/Windows × AE 25/26 four-cell matrix move to v0.9.3. The Windows ZXP uses a self-signed certificate valid until 2037; ZXPSignCmd could not reach the TSA through the local proxy, so this asset has no timestamp. Bundled native Helper binaries are not Authenticode-signed, and the GitHub Release discloses these boundaries.

### [0.9.0] — 2026-07-04

#### ✨ Added
- **Unified credential channels** (#47) — Claude, Codex, and ZCode now each show credential-channel cards. The panel automatically picks the best available channel across subscription login, API direct, inherited CLI config, custom providers, desktop inheritance, and official hosted plans, with manual channel locking when needed. `pickBackend` is now channel-driven.
- **Provider Manager** (#47) — Settings can add, edit, and delete OpenAI-compatible and Anthropic providers (Base URL + key), stored locally in `~/.ae-mcp/providers.json` with 0600 permissions. It can probe `/v1/models`, import from cc-switch, and migrate legacy `anthropic-key` / `codex-key` / Base URL preferences automatically.
- **Codex CLI config inheritance** (#47) — the panel can inherit custom `model_provider` entries from `~/.codex/config.toml`, including `/v1/models` probing. Explicit custom providers take priority over inherited config.
- **Claude API direct channel** (#47) — `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` from `~/.claude/settings.json` can be surfaced as import hints, and the sidecar now accepts `--channel` so subscription and API environments are handled separately.
- **Better ZCode model handling** (#47) — model lists are probe-driven from `/v1/models` with a one-hour cache, default models can be unlocked, switching models inside a session rebuilds the session automatically, and missing-key / missing-model / desktop OAuth gaps now produce readable bilingual errors.

#### 🔧 Improved
- **Settings UX refresh** (#47) — Settings now use persistent collapsible sections, a three-way backend segmented control, reusable channel cards, About links, and a rerunnable wizard. Log export now has an in-progress state with redaction and effective log-level handling.

#### 🐛 Fixed
- **Codex probe / backend rebuild loop** (#47) — probe state changes no longer churn config object identity and repeatedly rebuild the backend. `cli-config` is read lazily through `runtimeRef`, and replaced backend instances call `reset()` to kill old app-server processes instead of leaking them while the UI stays stuck on credential-channel detection.
- **Codex cold-start noise** (#47) — transient `Reconnecting... N/5` app-server startup notices no longer render as red chat errors.
- **Probe timeout and process hygiene** (#47) — each `probeAccount` RPC has its own bounded timeout, and timed-out probe processes are killed instead of leaked.
- **Probe error redaction** (#47) — probe error details no longer include raw provider response bodies, preventing relay endpoints from echoing secrets into the UI.
- **Channel edge-case fixes** (#47) — fixed `claudeSettingsImport` backslash escaping, ensured Codex custom providers correctly outrank `cli-config` in `pickChannel`, and wired cached ZCode probed models into the descriptor chain.

#### 📦 Notes
- **BYOK is now Claude's API direct channel**; legacy preferences migrate automatically and require no manual action.
- **ZCode `*-start-plan` official hosted plans still require the ZCode desktop captcha bridge** and remain unavailable until the panel detects valid credentials.

### [0.8.3] — 2026-07-03

#### ✨ Added
- **Claude Sonnet 5 is now in the curated model list and is the new Claude default** (#40); **GPT-5.4 mini** was added to the Codex static list.

#### 🔧 Improved
- **BYOK / Codex API profile fields are unified** (#41) — both profile types now share the `ApiProfileFields` component, reducing duplicated form logic.
- **ZCode `*-start-plan` boundaries are documented in WORKFLOW.md** (#42) — these providers are explicitly desktop-only.
- **The live model matrix now includes `claude-sonnet-5`** (#43).
- **README refreshed to the v0.8.2 state** (#44, #45) — ZCode backend, `ae_diagnose`, real comp-frame previews, and bilingual screenshots are documented.

### [0.8.2] — 2026-07-03

#### ✨ Added
- **ZCode integration** — ZCode is now in the external-client registry with correct `mcp.servers` config generation; the embedded ZCode chat backend drives `zcode.cjs app-server` with session protocol support, four-tier approval mapping, and elicitation / `AskUserQuestion` handling.
- **Read-only one-shot diagnostics with `ae.diagnose`** — a new always-exposed read-only verb probes host `/health` (now echoing Python handshake fields), token validity, AE responsiveness, and project-open state in one call.
- **Real comp-pixel previews** — `ae_previewFrame` now renders through `CompItem.saveFrameToPng` first, using viewer snapshots only as a fallback; preview files live in a managed `ae_mcp_previews` temp session dir with automatic stale-session cleanup after 24 hours.
- **Expanded provider profiles** — BYOK supports Anthropic-compatible base URLs and custom model IDs with a per-base-URL model cache; the Codex backend supports OpenAI-compatible custom providers with the API key stored locally and `wire_api` pinned to `responses`.

#### 🐛 Fixed / Improved
- **Readable ZCode failure hints** — live-tested provider API key, model config, and desktop OAuth runtime-headers failures now surface as panel hints instead of `[object Object]`. Coding-plan providers work through an OAuth credential bridge; `*-start-plan` providers still require the ZCode desktop app because captcha / runtime headers cannot be bridged yet.
- **No screenshot workaround path** — server instructions and sidecar prompts now forbid OS-screenshot / desktop-automation substitutes for `ae_previewFrame`, keeping previews on the AE render path.
- **CI guards the panel bundle** — CI now verifies `plugin/client/dist/app.js` is in sync with source; `.gitattributes` was added to enforce `eol=lf` and mark the dist bundle as binary.

### [0.8.1] — 2026-06-14

#### 🐛 Fixed
- **Removed the dead-end "waiting for handshake" wizard step** — it had no finish button until a client happened to connect (only wait / 60s timeout), yet it was a verification, not a functional gate; connection status already lives in the always-visible ConnectionDrawer. The wizard is now **3 steps**, finishing at the "Connect an AI client" step.

### [0.8.0] — 2026-06-14

Bake durable AE operating expertise into ae-mcp itself — cross-backend, sandbox-immune, **default-on but one-click off** so the standing cost stays user-controlled.

#### ✨ Added
- **AE expert anti-error guidance (default on, toggleable)** — the handshake instructions gain a block of high-frequency ExtendScript guardrails (text-layer retrieve-modify-setValue / PostScript font names / addProperty two-pass / new-layer prepend order / effect sub-property by index). Controlled by `AE_MCP_EXPERT_GUIDANCE` — the only always-on token cost (delivered once per session at handshake); one-click in Settings.
- **Bundled skill library (7, on-demand, zero standing cost)** — `ae_skillList`/`ae_skillUse` now ship a packaged skill set: `extendscript-cookbook` (situational JSX recipes & traps), `kinetic-typography`, `ease-and-timing`, `grade-stack`, `render-order`, `project-organization`, `glow-recipes`. Via a new bundled read-only skills dir (user skills override by name; bundled can't be deleted), shipped with the package; tokens are spent only when an agent fetches one.
- **More error hints** — three new auto-fix hints (detached property ref / invalid font name / fontSize over 1296) plus an effect-sub-property-by-index fallback on the null-family hint.
- **Guidance reaches all three backends** — mcpClient captures the handshake instructions; BYOK appends them to its system prompt; Codex injects them as a first-turn preamble (Codex doesn't forward MCP instructions); the Claude subscription gets them natively via the Agent SDK.

#### 📦 Notes
- The toggle defaults on; cost-conscious users can switch it off in Settings — skills and error hints are unaffected and always available.
- Embedded-backend requirements unchanged (Claude subscription Node≥18 + login / Codex CLI login / BYOK Anthropic key).

### [0.7.0] — 2026-06-13

The embedded chat goes **multi-framework** and the backend interface is formalized: beyond the new **Codex embedded backend**, this release extracts the embedded-backend interface into a registry + contract, adds an **external-client registry** (any MCP client connects with one click), the P6 undo / empty-result flag, and a full docs refresh.

#### ✨ Added
- **Formalized embedded-backend interface** — a backend registry + a frozen event contract + a conformance test that pins the protocol gaps last release's live testing uncovered as a contract every backend must satisfy. The panel selects backends by registry lookup, so a new backend is no longer another branch threaded through the app.
- **External-client registry** — a data-driven list of external MCP clients (Claude Desktop / Claude Code / Cursor / OpenCode / OpenClaw / AstrBot / Gemini Antigravity); the wizard step 3 and a Settings section render from it and generate the correct MCP config. Adding a framework is one data row.
- **OpenCode external support** — OpenCode connects to ae-mcp as an external MCP client. (An embedded OpenCode backend is implemented but its approval gating is unverified, so it is deferred to v0.7.1.)
- **IM-bot network note** — OpenClaw / AstrBot and similar are often long-running or Dockerized and may not share a machine with AE; registry entries spell out the same-machine / `127.0.0.1:11488` reachability requirement.
- **P6: undo to last checkpoint + empty-result flag** — the activity feed marks successful-but-empty tool calls (the AE-2026 uncaught-exception silent-empty class) as a neutral "no return value" distinct from errors; a new "undo to previous checkpoint" action is available.
- **Model-matrix smoke script** (`scripts/live-model-matrix.mjs`) — one command checks both backends across models.

#### 🐛 Fixed / Improved
- Docs fully refreshed to the v0.7.0 reality (README / WORKFLOW / RELEASE / package readmes / parity roadmap): the full panel product, the two-tier backend story, and `uv tool install` of the three packages (replacing the dead `pip install ae-mcp`).

#### 📦 Notes
- Embedded backends: Claude subscription needs Node ≥18 + a logged-in Claude Code; Codex needs the Codex CLI logged in; BYOK needs an Anthropic key.
- OpenCode is external-only this release; embedded OpenCode lands in v0.7.1 (its approval gating needs live verification of OpenCode's permission DSL).

### [0.6.0] — 2026-06-13

The embedded chat becomes a **multi-agent-framework** product: a new **Codex backend** (direct OpenAI subscription), four composer quick-pick chips (model / thinking / fast / approvals), a fully one-click wizard, and a substantial error-reduction pass. This release includes everything originally planned for v0.5.0. Reinstall/sync the panel and reload after upgrading; updating the Python side together is recommended.

#### ✨ Added
- **Codex chat backend** — the panel drives `codex app-server` directly (experimental protocol, adapted against the official schema plus live transcripts): reuses your Codex subscription login (Settings shows the account email and plan), builds the model list dynamically from `model/list` (per-model reasoning levels and the fast tier), and keeps one thread alive across turns so the injected ae-mcp cold-starts once.
- **Four approval tiers (read-only / manual / auto / bypass)** — annotation-driven and consistent across backends: the Claude side rides SDK `allowedTools`/`dontAsk` plus the approval callback; the Codex side consumes its native per-call approvals (read-only tools, the bypass tier, and non-destructive writes under auto pass silently in milliseconds; cards that do appear carry the real tool name and params, with "allow for this session" support).
- **Composer quick-pick chips** — model (with $ cost badges; switching mid-conversation keeps the transcript), thinking depth (framework-native ladders: five Claude effort levels / four Codex levels, trimmed per model), fast mode (Codex native 1.5×; BYOK+Opus 3×), and the approval tier. The Settings model field becomes "Default model".
- **Fully one-click wizard** — uv / Node / Claude CLI / ae-mcp all detect and install with one click (exact commands shown first, official sources only), login opens a visible terminal with zero typing, and installs work without restarting AE. Replaces the dead `pip install ae-mcp` instruction with release-tag-pinned git sources.
- **Thinking indicator** — a pulse line shows while the model reasons, so long gaps no longer look like a hang.
- **Error-reduction engineering** — both agent system prompts carry an ExtendScript pitfall table; common ExtendScript errors gain actionable `[hint]` suffixes; the AEMCP prelude adds `easeKeys()` (dimension-aware ease arrays) and `mustFind()`. Measured on the same task: error rounds went from 4 to 0.
- **Model-matrix smoke script** (`scripts/live-model-matrix.mjs`) — one command checks both backends across 8 models; 8/8 passed before this release.

#### 🐛 Fixed
- Approval cards no longer fire indiscriminately, stick forever, or read just "MCP" (the Codex approval architecture was redone).
- Chip drop-up menus clipped invisible; wizard rows not auto-detecting; the claude probe false-negative on Windows (npm .cmd shims need a shell); `ae-mcp --version` probing hanging the stdio server (now presence-based); the wizard login re-check not re-running the probe.
- The "Subscription" backend is now labeled "Claude" — unambiguous in a multi-backend world.

#### 📦 Notes
- The Codex backend needs the Codex CLI (≥0.139) installed and logged in; Claude backend requirements are unchanged (Node ≥18 + a logged-in `claude`).
- `codex app-server` is an experimental interface; future protocol changes may require adapter updates.

### [0.4.0] — 2026-06-12

The panel grows from a connection configurator into a full product: **chat, approvals, activity feed, wizard, and diagnostics are all built in**. Merges #26 (shell + backend enablement), #27 (wizard + activity UI), #28 (embedded AI chat). After upgrading, reinstall/sync the panel and reload it once; upgrading the Python side together is recommended.

#### ✨ Added
- **Embedded AI chat in the panel** (#28) — drive After Effects without any external client. Dual backend: **Claude subscription** (default) — the panel spawns an Agent SDK sidecar on system Node, reusing your `claude /login` session: no API key, no token stored, and the model's tool surface is locked to ae_ tools only; **BYOK** fallback — the built-in agent loop with your own Anthropic API key. The conversation resets only on a real backend switch.
- **Action approvals** (#28) — manual / auto / none permission tiers; destructive actions (exec, revert, …) raise an approval card, denials are fed back to the model so it can adapt; stopping a turn voids every pending approval so it can never poison later turns' session allowlist.
- **First-run wizard & connection diagnostics** (#27) — 4-step setup plus 5 self-checks that pinpoint where the chain breaks; per-client trust management (block / unblock).
- **Activity feed** (#26/#27) — every AE operation streams live: caller, undo group, result, duration; a kill switch instantly blocks all AI actions.
- **Panel shell & design system** (#26) — React 18 single-file bundle, AE-native dark visuals, bilingual CN/EN.
- **CI now runs the JS suites** — panel / sidecar / host node:test suites join the Python tests.

#### 🐛 Fixed
- **No more mojibake from `/exec` on localized (e.g. Chinese) AE** — the ExtendScript→CEP boundary returns system-codepage bytes; all /exec traffic now crosses in an ASCII-safe envelope, escaped both ways.
- **Uncaught ExtendScript exceptions are no longer lost** — on AE 2026 evalScript returns an empty string for uncaught throws (the documented sentinel never fires); the envelope now catches in JSX and carries the real error text and line (`ExtendScript error: …`), and truly empty output is reported distinctly.
- **`ae_setProperty` on a text layer's Source Text no longer reports failure after succeeding** — host objects like TextDocument are serialized through `AEMCP.safeValue`, so a successful write can't come back as "jsx returned no value" anymore.
- **ZXP packaging ships sidecar production deps and drops dev trees** — clean installs previously left the subscription backend unable to start.
- **Approval cards can no longer attach to a previous turn's tool call** — sidecar tool bookkeeping is scoped per turn.

#### 📦 Notes
- Subscription mode needs local Node ≥ 18 and a logged-in Claude Code (`claude /login`); BYOK has no such requirement.
- CI runner moved from Node 20 to 24.

### [0.3.2] — 2026-06-11

Closes out the last 3 review findings deliberately deferred from v0.3.1 (#22/#23/#24), finishing the "silent success" theme. All compatible fixes; **the only visible behavior change is the fix itself**: failures are now honestly flagged at the MCP protocol layer.

#### 🐛 Fixed
- **Failed tool calls now set `isError` at the MCP protocol layer** (#22) — previously every result reported protocol-level success and failures only lived inside the `{ok:false}` payload text, so MCP clients branching/counting on `isError` recorded failed AE operations as successes. The payload format is unchanged: `isError` serves machine branching while `{ok:false, error}` stays for humans and models.
- **Legitimate strings starting with `EvalScript error` are no longer misreported as failures** (#23) — the error sentinel is now compared exactly against CEP's `"EvalScript error."` constant (previously a bare prefix match), so text like `"EvalScript errors found: 0"` from `ae.exec` is no longer wrongly rejected; the three sentinel copies are now cross-referenced to prevent drift (#8 was a mismatch missing real failures, #23 a prefix flagging valid text — same root cause, now closed).
- **`ae_setProperty` accepts negative `at_time`** (#24) — AE layers can start before t=0, so negative keyframe times are legal; previously `-1.0` doubled as an internal sentinel and a negative `at_time` was silently rewritten into a constant-value write (no keyframe) while reporting success. The sentinel is now `null`, and any number (negatives included) honestly creates a keyframe.

#### 📦 Dependencies
- `mcp` Python SDK floor raised `>=1.0.0` → `>=1.19.0` — #22 needs the `CallToolResult` direct return introduced in python-sdk v1.19.0 (older SDKs silently mishandle that return value).

### [0.3.1] — 2026-06-11

A follow-up to 0.3.0 that finishes the remaining half of the issue #8 ("failures masquerading as success") remediation. All changes are compatible robustness fixes; **existing callers are unaffected.**

#### 🐛 Fixed
- **Operations on a deleted/stale comp or an out-of-range layer id return a clear "not found"** (#8) — on AE 26.2+ these used to throw an opaque `EvalScript error.`; comp/layer lookups now go through defensive helpers that reliably return `{ok:false}`.
- **Upgrading only the Python side no longer breaks every verb until the panel is reloaded** (#8) — scripts now carry their own helper definitions instead of depending on whether the panel loaded the newer namespace, eliminating upgrade-time version skew.
- **A broken / half-uninstalled snapshot plugin no longer takes down the whole tool list** — snapshotter discovery isolates each entry point; one bad extension is skipped with a warning.
- **A missing backend now gives an actionable hint instead of a blank tool list** — a new `ae_status` diagnostic verb returns the backend-selection result with install hints; call it first when other AE tools are missing or failing.
- **More failures are reported honestly** (#8) — a mistyped property path, invalid layer ids, or corrupt/truncated script output now return an explicit error instead of a deceptive "success".
- **The plugin's `/health` reports its real version** instead of a hardcoded `0.1.0`.

### [0.3.0] — 2026-06-10

> ⚠️ **Upgrade note (breaking change):** local authentication was added to the plugin's `/exec` endpoint, so **the panel (CEP plugin) and the Python side must be upgraded together**. Upgrading only one side will get calls rejected (401). Reinstall / re-sync the panel per the docs before use.

This release merges 6 fix PRs (#14–#19) covering data safety, connection security, cross-language & large-project robustness, and a batch of install / field-consistency issues.

#### 🔒 Security
- **`/exec` now requires a local token** (#11) — previously any local process could send arbitrary script to the plugin and run it as you. The panel generates a secret at `~/.ae-mcp/auth-token` on startup; only callers holding it can execute.
- **The remote-debug port no longer ships to users** (#11) — the packaged panel strips `.debug`, so no machine exposes a debug port a local process could attach to. Signing now also requires the cert password and adds a timestamp server.
- **JSX calls are serialized** (#11) — concurrent requests no longer interleave and corrupt each other.

#### 🐛 Fixed
- **Revert no longer hijacks your project into a temp folder** (#10) — `ae_revert` now atomically restores the checkpoint over the original project path and reopens the original; it used to open the copy inside `%TEMP%`, so later saves went to temp and could be wiped by cleanup. Unsaved (path-less) projects are refused rather than risked. Same-named projects no longer mix checkpoints.
- **Failures no longer masquerade as success** (#8) — ExtendScript throws surface as errors; an invalid/out-of-range layer id returns a clear "no layer" instead of crashing; backend-selection failure emits a diagnostic.
- **Fresh clones install cleanly** (#9) — the lockfile is tracked, so the documented `npm ci` no longer fails on a clean clone.
- **New layers keep their position on non-English AE** (#12) — property addressing is now locale-independent.
- **Search / scan no longer hang on large projects** (#12) — exceeding the time budget returns partial results flagged `truncated` instead of blowing the timeout with zero output and a frozen UI.
- **Progress heartbeats actually emit** (#13) — long operations are no longer dropped by clients that think the server stalled.
- **Snapshots capture the After Effects window** (#13) — the AE window is found by process, not a title substring, so it no longer grabs a same-named browser tab or the whole desktop; a clear error is returned when none is found.
- **Some clients (e.g. Claude Desktop extensions) errored on connect** (#3 / #4 / #7) — tool names are unified to underscore form (`ae.ping` → `ae_ping`) so strict clients connect; **dotted names are still accepted**.
- **Skills containing `$` are no longer unusable after saving** (#12) — ExtendScript like `$.writeln` renders correctly.
- **The preview `scale` argument now actually works** (#13).

#### 🔧 Improved
- **The panel port is remembered** (#13) — it no longer resets to the default on restart, so `AE_MCP_PLUGIN_URL` isn't silently broken.
- **Docs** (#13) — added "install all three packages together", the `AE_MCP_SKILL_DIR` / `AE_MCP_CHECKPOINT_KEEP` env vars, and a PyPI name-squatting note.

### [0.2.0] — 2026-06-05

This release merges two PRs: **#1** (multi-step reliability) and **#2** (a round of
Atom-parity optimizations). **Everything defaults to prior behavior — existing
callers are unaffected.**

#### ✨ Added
- **A toolkit of common AI actions** (#2) — built-in building blocks so AI-generated scripts fail less often and complex operations are more likely to work the first time.
- **The AI is guided the moment it connects** (#2) — it receives a usage guide on connect, so it uses each feature correctly from the start.
- **Better layer listing** (#2) — optional pagination, each layer's type and parent at a glance, plus a compact text view (~1/3 the data). **Still returns all layers by default.**
- **Structured controller / rig setup** (#2) — declare each control directly for clearer, more reliable rigs.

#### 🔧 Improved
- **Auto-backup no longer gets in the way** (#2) — if a backup hits a snag it's skipped and your action still runs; no freezing, no lost edits.
- **More robust results, no silent failures** (#1) — unified internal result parsing; errors are surfaced instead of being swallowed.

#### 🐛 Fixed
- **Multi-step actions sometimes stopped after the first step** (#1) — every step now runs to completion.
- **Layer lists silently dropped layers past 100** (#2) — the default returns all layers again; pagination is opt-in.
- **Unknown ids caused confusing failures** (#2) — fixed.

### [0.1.0] — baseline

Atom-level After Effects plugin MVP: 30 `ae.*` verbs over the
MCP → Python → HTTP → CEP → ExtendScript chain, including the early
preview-frame capture fix.
