# macOS、请求头路由、Tool Library 与双平台发布闭环设计

日期：2026-07-10　状态：已获用户批准　目标版本：v0.9.x　基线：`main@ef1e4da`

关联工作：

- [Issue #49：请求头中转路由](https://github.com/JUNKDOGE-JOE/after-effects-mcp/issues/49)
- [PR #51：provider dialect autodetect](https://github.com/JUNKDOGE-JOE/after-effects-mcp/pull/51)
- [Issue #50：Tool Library](https://github.com/JUNKDOGE-JOE/after-effects-mcp/issues/50)

## 1. 目标与成功标准

本阶段只围绕四个结果推进：

1. **macOS 完全适配**：Apple Silicon Mac 上的安装、面板、MCP、AI 后端、AE 执行、截图、凭据和升级流程达到可发布状态。
2. **请求头 Bug 完全闭环**：chat-only provider 的 Responses facade 不再丢失必要请求头，并同时关闭本地鉴权、query、compact、错误处理和日志泄密等相邻缺口。
3. **Tool Library 完整实现**：完成本地工具资产的存储、发现、编辑、导入导出、隔离扫描、审批执行和迁移恢复闭环。
4. **Mac 开发、Mac + Windows 同版本发布闭环**：同一源码 commit/tag 产出 macOS arm64 与 Windows x64 两个包，分别完成平台验证后才允许发布。

“完成”不等于只在开发机运行或只通过自动化测试。四个目标必须具有可复现的安装、升级、回滚、实机验证和发布证据。

## 2. 当前基线与已确认问题

### 2.1 仓库与运行环境

- 当前稳定基线为 `main@ef1e4da`，仓库版本为 v0.9.0。
- 本机为 Apple Silicon macOS，After Effects 26.2.1 可用，足以承担主要 macOS 开发与实机 smoke。
- Python core、CEP host 和大部分 ExtendScript 已具备可移植性；主要平台缺口集中在 Panel 编排、截图、安装、CI 和打包。
- Panel/sidecar 的可执行文件发现、路径拼接、首次安装、登录、日志定位等代码仍存在 `where`、PowerShell、`USERPROFILE`、反斜杠和 `.exe` 假设。
- `snapshot-mss` 虽声明跨平台，但当前 AE 窗口发现和窗口矩形只在 Windows 实现。
- CI 与发布打包当前以 Windows 为中心，尚不能从同一 tag 可靠地产出含正确原生依赖的两个平台包。

### 2.2 请求头路由

PR #51 比 `main` 超前六个提交，加入 Responses → Chat Completions 的本地 facade，但尚未合并。已确认的问题包括：

- 上游请求仅重建认证与 `Content-Type`，Codex 入站元数据头全部丢失。
- facade 生成本地 route token，但服务端未校验；任意本机进程可调用用户的上游凭据。
- query 参数被剥离。
- `/responses/compact` 没有独立契约与测试。
- provider 模型无法表达额外自定义头、无认证和探测/模型请求的不同认证要求。
- 任意 JSON 形式的 HTTP 400 可能被误判为支持 Responses dialect。

本设计吸收 PR #51 的有效实现，但不把当前分支原样合并为完成状态。

### 2.3 Tool Library

Issue #50 已定义主要产品范围：`ToolArtifact`、多种 artifact kind、本地存储、bundled 只读工具、历史候选、Tools 页签、渐进式 MCP 工具以及秘密扫描。本设计补全其跨平台、审批、导入隔离、迁移和发布约束。

## 3. 已锁定的架构决策

### 3.1 保持 CEP，不迁移 UXP

- 本阶段继续使用 CEP + ExtendScript + Node sidecar + Python MCP。
- 不做 UXP 迁移、UXP 试验分支或 CEP/UXP 双运行时。
- 不为假设中的未来 UXP 添加专用抽象；只提取当前 Mac/Windows 双平台本来就需要的平台能力边界。
- 当 Adobe 正式为 After Effects 发布满足本项目需求的 UXP SDK 后，另行立项评估，不阻塞本阶段四个目标。

### 3.2 支持矩阵

| 维度 | 本阶段承诺 |
|---|---|
| macOS | Apple Silicon / arm64 |
| Windows | x64 |
| After Effects | 当前主版本与上一主版本 |
| Intel Mac | 不承诺 |
| Windows ARM | 不承诺，也不把 Apple Silicon 上的 Windows ARM 虚拟机作为 x64 发布门禁 |

文档、manifest 和测试矩阵必须一致表达这一范围，不能继续用未经验证的宽泛版本声明代替真实支持承诺。

### 3.3 交付模型

- 单一代码库、单一版本号、单一 commit/tag。
- 从该 tag 分别原生构建：
  - macOS arm64 ZXP；
  - Windows x64 ZXP。
- 每个包自包含对应平台的运行依赖，并携带依赖清单、内容 hash 和构建来源。
- 两个平台包作为同一版本的一组原子发布资产；任一平台未过门禁时，两者均不公开发布。

### 3.4 明确不在范围内

- UXP 或双运行时。
- Intel Mac、Windows ARM 的正式支持。
- Tool Library 云同步。
- provider 配置或凭据导出。
- ZCode 桌面 OAuth、验证码或 captcha 运行时请求头桥接；除非存在官方、稳定且可审计的桥接接口。

## 4. 总体架构

```text
共享层
  Panel UI / Tool Library / Provider profiles / MCP tools / schemas
                              │
                    统一平台能力接口
            ┌─────────────────┴─────────────────┐
            │                                   │
      macOS arm64 adapter                 Windows x64 adapter
      Keychain                            Credential Manager
      ScreenCaptureKit/Quartz             HWND/window capture
      POSIX paths/processes               Win32 paths/processes
      macOS package/signing               Windows package/signing
            │                                   │
            └──────── CEP host / sidecar ───────┘
                              │
                     ExtendScript / After Effects
```

平台判断只允许集中在平台能力实现和打包入口。Provider、Tool Library、MCP schema 和业务 UI 不应散布 `process.platform`、路径分隔符或系统命令分支。

统一平台能力至少覆盖：

- 用户目录、配置目录、临时目录和安全文件写入；
- `ae-mcp`、Codex、Claude、ZCode、Node 等可执行文件发现；
- 子进程启动、环境变量补全、终端/登录入口和文件定位；
- 系统凭据读写；
- AE 窗口发现、窗口矩形与截图；
- 安装、依赖验证、打包、签名和产物检查。

具体文件划分由实施计划决定；本设计约束能力边界，不预先锁死目录命名。

## 5. macOS 适配设计

### 5.1 Panel 与后端编排

- 使用平台原生路径 API，不再手写反斜杠 join/dirname。
- 可执行文件发现按“显式环境变量覆盖 → 已知应用内路径 → 登录 shell/PATH → 标准安装目录”进行，并在诊断 UI 显示实际命中的绝对路径与版本。
- CEP 启动环境缺失 `HOME`、PATH 等变量时，由平台层以可审计方式补全；不得读取或猜测无关用户环境。
- Wizard、Claude、Codex、ZCode、配置继承、日志 reveal 都消费同一平台能力，避免各自复制发现逻辑。
- 缺少 CLI、依赖或登录态时返回结构化诊断与修复动作，不静默 fallback 到错误二进制。

### 5.2 截图

- `ae.previewFrame` 继续优先使用 AE 原生 `CompItem.saveFrameToPng`，这是平台无关、内容精确的主路径。
- `ae.snapshot` 在 macOS 使用 ScreenCaptureKit/Quartz 实现 AE 窗口捕获，覆盖：
  - Screen Recording/TCC 权限检测与引导；
  - Retina 比例；
  - 多显示器坐标；
  - 窗口移动、遮挡、最小化和 Spaces 的明确错误行为；
  - 不得在 AE 窗口解析失败时静默截取整个桌面。
- Screen Recording 权限未授予时，`ae.snapshot` 明确报告不可用；不影响仍可工作的 `ae.previewFrame` 原生路径。

### 5.3 安装、升级与打包

- macOS 开发安装脚本必须可执行，并安装/验证 host、panel、sidecar 所需依赖。
- 首次安装、升级和卸载文档不得要求 Windows 命令。
- 原生可执行依赖保留 Unix executable mode；构建时验证架构，阻止把 Windows 或 Darwin x64 sidecar 误装进 arm64 包。
- 根据实际 Gatekeeper 行为，对 ZXP、内含原生二进制和发布载荷执行所需签名/公证；所有签名步骤应可在 CI 中重现。

## 6. 请求头路由闭环设计

### 6.1 Provider profile

Provider profile 在现有 base URL、模型和 dialect 基础上扩展以下概念：

- 认证方式：Bearer、`x-api-key`、自定义 header、none；
- 敏感值引用：配置中只保存 secret reference，不保存明文；
- 可配置的额外请求头：header name、secret/value reference、适用范围；
- 探测请求与模型请求可使用不同认证/头集合；
- 显式 dialect override 与经验证的探测结果。

Provider 配置不支持导出。任何 UI、日志、诊断包和 Tool Library 导出都不能带出 provider header 值或 secret reference 可解析内容。

### 6.2 请求链

```text
Codex
  → loopback-only facade
  → 校验该会话的独立 route token
  → 保留 method、合法 path、query 与 body
  → 根据 provider profile 选择 probe/model 头集合
  → 过滤危险头与逐跳头
  → 注入上游认证/自定义头
  → provider upstream
  → 流式或非流式响应
```

### 6.3 头转发规则

- 允许安全的协议协商、feature、request-id 和 tracing 元数据按明确规则转发。
- 禁止盲目透传 `Host`、`Content-Length`、`Connection`、`Transfer-Encoding`、代理头、Cookie 等危险或逐跳字段。
- Codex 用于访问本地 facade 的 `Authorization` 永不直接成为上游凭据。
- provider profile 显式配置的头优先于可转发入站头，避免入站值覆盖认证策略。
- 头名比较不区分大小写；输出保持 Node HTTP 所需的规范行为。
- 日志只记录头名、策略决策和脱敏摘要，不记录 secret、完整 token 或敏感 body。

### 6.4 本地安全与协议语义

- facade 只监听 loopback；每次启动生成足够随机的 route token。
- 缺失或错误 token 返回 401，且产生零次上游调用；比较避免明显时序泄露。
- path allowlist 明确区分 models、responses、chat/completions 与 responses/compact，不把任意路径变成开放代理。
- query 原样保留；流式响应、取消、超时、上游断连和 HTTP 错误保持可诊断。
- `/responses/compact` 具有独立契约和测试，不能因路径前缀相同而自动走普通 responses 转换。
- dialect 探测采用保守判定；不能把任意 HTTP 400 JSON 错误当成支持。探测失败时保留用户配置并允许显式 override。

## 7. Tool Library 设计

### 7.1 资产模型与存储

`ToolArtifact` 至少表达：

- 稳定 ID、名称、描述、kind；
- category、tags、兼容性与安全级别；
- source、status、created/updated 时间；
- verified/pinned 元数据；
- 内容、内容 hash 和 schema version。

支持的 kind 为：`jsx`、`expression`、`prompt-skill`、`recipe`、`diagnostic`。

- 用户资产主存储位于 `~/.ae-mcp/tools`，采用本地 JSON/内容文件与版本化 schema。
- bundled 工具随产品发布，只读且可追踪到产品版本。
- 历史记录可生成 candidate，但 candidate 与 saved/verified 状态严格分离。

### 7.2 MCP 与 UI 能力

完成以下渐进式 MCP 工具及对应 Tools UI：

- `toolIndex`
- `toolSearch`
- `toolInspect`
- `toolUse`
- `toolCreate`
- `toolEdit`
- `toolDelete`
- `toolPromoteFromHistory`

列表和搜索只返回轻量索引；inspect 才读取完整内容，避免把整个库无条件塞入模型上下文。

### 7.3 执行与审批

- candidate 永远不可直接执行。
- saved 工具可发起执行，但继续经过现有四级审批。
- verified/pinned 只改变可信度表达、排序与发现体验，不绕过审批。
- destructive、external 或不可逆操作始终要求对应授权。
- 执行记录关联 artifact ID、版本/hash、审批结果和执行结果，便于审计与复现。

### 7.4 `.aemcptools` 导入导出

导出包包含 manifest、schema version、artifact 内容、内容 hash 与来源元数据；不包含 provider、凭据、token、系统路径中的秘密或外部登录态。

导入流程固定为：

```text
.aemcptools
  → 解析到隔离区
  → 校验包结构、schema、hash 和兼容性
  → 扫描秘密及危险内容
  → 展示差异、风险和冲突
  → 用户逐项或整包确认
  → candidate/saved
```

- 导入默认进入 candidate/quarantine，不得直接执行。
- hash 不匹配、schema 不支持或检测到高风险秘密时拒绝提升。
- 导入采用临时目录和原子提交，失败不留下半导入状态。
- 冲突处理不得静默覆盖用户现有工具；保留、替换或生成副本必须由用户明确选择。

## 8. 凭据、迁移与数据安全

### 8.1 Secret store

- macOS 使用 Keychain；Windows 使用 Credential Manager。
- JSON 只保存 provider/字段标识和不可直接使用的 secret reference。
- 不把敏感值 fallback 到普通 JSON、localStorage、日志或导出包。
- secret store 不可用时，相关 provider 明确不可用并给出修复提示，不静默降低安全等级。

### 8.2 迁移

- 首次升级前自动备份 providers、settings、skills/tools 和相关索引。
- 迁移有单调递增 schema version，支持从当前 v0.9.0 数据无损升级。
- 写入使用临时文件、校验和原子替换；失败后自动恢复旧文件。
- 升级后保留回滚说明和备份定位入口。
- 现有 provider、skills、settings 与 key 引用应继续工作；若旧配置含明文 key，迁入系统凭据后再清理明文，且清理前必须确认新凭据可读。

## 9. 错误处理与可观测性

- 统一错误分类：配置、认证、权限、网络、协议、平台能力、迁移、包校验、AE 宿主。
- 用户可见错误包含可执行的修复建议；内部错误保留 cause/code 供诊断，但不直接泄露实现细节或 secret。
- provider 探测明确区分认证失败、网络失败、路径不支持和 dialect 不兼容。
- 路由日志可关联本地 request ID 与脱敏后的 upstream request ID；Tool Library 日志可关联 artifact hash。
- 诊断包默认脱敏，且不包含 provider 配置导出。
- 平台能力缺失只影响对应能力，不得清空配置、破坏 Tool Library 或导致无关功能崩溃。

## 10. 实施与 PR 顺序

采用小 PR 顺序合并，保持 `main` 可用：

1. **规范与测试骨架**：支持矩阵、平台能力契约、CI matrix 和测试 fixture。
2. **macOS Panel/安装适配**：路径、CLI 发现、spawn env、Wizard、日志和依赖检查。
3. **macOS 截图**：ScreenCaptureKit/Quartz、TCC、Retina、多显示器及安全 fallback。
4. **双平台打包骨架**：平台原生依赖、架构校验、签名与可追踪产物。
5. **请求头路由闭环**：在最新 `main` 上吸收 PR #51，先补失败测试，再修安全与协议缺口。
6. **Tool Library 存储与迁移**：模型、索引、原子存储、历史候选和备份恢复。
7. **Tool Library UI/MCP/导入导出**：完整 CRUD、渐进式读取、隔离扫描和审批执行。
8. **最终 RC 与发布编排**：全量回归、双平台实机、Windows Codex 交接、原子发版。

每个 PR 运行相关单元/集成测试。安全、数据损坏和阻塞问题立即修复；不影响当前体验的隐性问题可登记，但必须在最终 RC 统一复测，并在影响完成定义时关闭。

## 11. 双平台 CI、实机验证与发布

### 11.1 自动化构建

- macOS runner 原生安装依赖、运行测试并构建 macOS arm64 载荷。
- Windows x64 runner 原生安装依赖、运行测试并构建 Windows x64 载荷。
- 构建必须锁定依赖，验证 sidecar/native package 的 OS 与架构，生成 hash 和依赖清单。
- 发布编排只接受同一 commit/tag 的两个成功构建，不允许手工混合不同 commit 的包。

### 11.2 macOS 实机

主要开发机完成：

- 全新安装与旧版升级；
- Panel/host/sidecar/MCP 启动；
- Claude、Codex、ZCode 中处于支持范围内的通道 smoke；
- AE 命令、previewFrame、snapshot、权限拒绝与恢复；
- provider、Tool Library、重启持久化和回滚；
- macOS ZXP 安装后的 Gatekeeper/签名行为。

### 11.3 Windows Codex 手工门禁

由于本机无法代表性地运行 Windows x64 After Effects，最终 Windows 实机验证交给一台 Windows x64 机器上的 Codex：

- 用户在 Windows 机器拉取 PR 指定的精确 branch 与 commit。
- Windows Codex 使用仓库生成的固定提示词，只测试和报告，不修改代码。
- 它验证依赖安装、自动化测试、AE smoke、升级/回滚与 Windows artifact。
- 它在当前 PR 留下结构化评论，至少包含：commit SHA、Windows/AE/Codex 版本、测试命令与结果、AE smoke 清单、artifact hash、失败证据以及最终 `PASS`/`FAIL`。
- 只有 SHA 完全匹配且评论为 `PASS`，Windows 门禁才通过。失败返回主开发流程修复，再从新 SHA 重跑。

### 11.4 原子发布门禁

公开发布必须同时满足：

- macOS 自动化与实机通过；
- Windows 自动化构建通过；
- Windows Codex 对精确 release commit 留下合格 `PASS`；
- 两个包的版本、commit、依赖与 hash 可追溯；
- 没有安全、数据损坏、安装阻塞或核心体验缺陷；
- 安装、升级、回滚、已知限制和 Windows 交接文档完整。

任一条件失败时，不发布两个平台中的任何一个。

## 12. 测试矩阵

### 12.1 macOS 与平台层

- POSIX/Windows 路径 fixture、用户目录、空/异常环境变量。
- CLI 显式覆盖、PATH、标准路径、多个版本与不存在场景。
- spawn 环境、退出、取消、超时和带空格路径。
- Keychain/Credential Manager 的写入、读取、删除、拒绝和不可用。
- Screen Recording 首次拒绝、后续授权、Retina、多显示器、窗口消失和不得截桌面。
- fresh install、upgrade、rollback、架构错误依赖和 executable mode。

### 12.2 请求头路由

- Bearer、`x-api-key`、custom header、none。
- probe/model 分离认证与 provider-configured header precedence。
- 安全保留 `Accept`、feature、request-id、`traceparent` 等受支持元数据。
- 拒绝 Host、hop-by-hop、Cookie、proxy 和本地 route token 泄漏。
- 缺失/错误 route token 返回 401 且上游请求数为零。
- models、responses、chat/completions、responses/compact 的 path/query。
- 流式/非流式、取消、超时、上游断连与错误 body。
- dialect false positive、显式 override 与缓存失效。
- 使用真实 Codex 对要求特定元数据头的 chat-only mock/测试 provider 做集成 smoke。

### 12.3 Tool Library

- schema、CRUD、索引、搜索、排序、bundled 只读与历史提升。
- candidate 不可执行，saved/verified/pinned 均不绕过审批。
- `.aemcptools` round-trip、hash 篡改、未知 schema、秘密扫描和冲突处理。
- 原子导入失败、并发写入、崩溃恢复、备份与 rollback。
- 旧 skills/settings/provider 引用无损迁移。
- 完整四级审批回归在最终 RC 执行；各 PR 仍运行其直接相关的审批测试。

### 12.4 AE 与发布

- 支持的当前/上一 AE 主版本兼容性检查；当前版本必须完成 Mac 与 Windows 实机 smoke。
- 双平台 ZXP 内容、manifest、架构、权限、依赖和 hash 检查。
- Windows PR 评论 schema 与 SHA 门禁自动校验。
- release workflow 验证任一平台失败时不会产生公开 release。

## 13. 四个目标的完成定义

| 目标 | 必须通过的验收条件 |
|---|---|
| macOS 完全适配 | 全新安装、旧版升级、Panel、MCP、AE 执行、配置持久化、Keychain、原生截图、多显示器/Retina、卸载/恢复通过；支持路径无 Windows 命令假设 |
| 请求头 Bug 闭环 | 认证矩阵、端点矩阵、流式/非流式、query、错误处理与安全负例全部通过；无本地鉴权绕过、危险头或日志泄密 |
| Tool Library 完整实现 | 数据模型、CRUD、搜索、历史提升、导入导出、隔离扫描、审批、迁移、备份恢复和秘密防泄漏全部通过 |
| 双平台发布闭环 | 同一 commit/tag 生成两个平台包；Mac 实机通过；Windows Codex 对相同 SHA 留下 `PASS`；依赖、hash、构建日志可追溯 |

不以“自动化通过但 AE 未验证”、不同 commit 的两个包或仅一个平台可安装作为完成。

## 14. 前置条件与外部依赖

实施期间需要具备：

- 可用的本机 After Effects 与 Screen Recording 授权；
- 一台真实 Windows x64 + After Effects 机器，至少在平台基础里程碑和最终 RC 两次可用；
- Windows Codex 对仓库/PR 的读取与评论权限；
- 一个可用于 live smoke 的 chat-only OpenAI-compatible provider，以及覆盖已承诺认证方式的测试凭据；
- macOS/Windows ZXP 发布所需证书、签名材料与 CI secret；
- 当前和上一 AE 主版本的兼容性验证渠道；若无法取得上一版本实机，发布文档必须明确降低该版本的验证等级，不能声称完成了实机认证。

这些条件不阻塞单元实现，但缺失时会阻塞对应的最终发布门禁。

## 15. 工作量评估

以下为单人主开发、已有代码基础可复用、评审与 Windows 交接响应正常时的工程量区间：

| 工作流 | 估算 |
|---|---:|
| macOS 平台适配、截图、安装、CI 与双平台打包基础 | 15–26 人日 |
| 请求头路由安全与协议闭环 | 2–4 人日 |
| Tool Library 完整实现 | 8–13 人日 |
| 最终跨后端回归、双平台 RC、文档与发布演练 | 3–6 人日 |
| **总计** | **28–49 人日** |

平台抽象、CI 和最终 RC 之间存在少量重叠，实际人日可能低于简单相加；Apple/Windows 签名、上一版 AE 获取、真实 provider 行为和 Windows 手工反馈周期是主要不确定项。该估算是实施计划输入，不是日历交付承诺。

## 16. 最终约束摘要

- CEP 是本阶段唯一生产宿主。
- 共享业务代码，明确隔离系统能力，但继续维护并测试两个平台产物。
- provider 配置不可导出，secret 只存在系统凭据库。
- 请求头采用“安全选择性转发 + provider 显式注入”，不是全丢弃或全透传。
- Tool 导入先隔离，candidate 不可执行，verified/pinned 不绕过审批。
- 小 PR 顺序合并，四个目标完成前不公开发布。
- Windows x64 AE 实机 `PASS` 是双平台版本不可替代的发布门禁。
