# macOS、请求头路由、Tool Library 与双平台发布闭环设计

日期：2026-07-10　状态：设计已获用户批准，安全自审通过，待用户复核　目标版本：v0.9.x　基线：`main@ef1e4da`

关联工作：

- [Issue #49：请求头中转路由](https://github.com/JUNKDOGE-JOE/after-effects-mcp/issues/49)
- [PR #51：provider dialect autodetect](https://github.com/JUNKDOGE-JOE/after-effects-mcp/pull/51)
- [Issue #50：Tool Library](https://github.com/JUNKDOGE-JOE/after-effects-mcp/issues/50)
- [Adobe：After Effects 26.x system requirements](https://helpx.adobe.com/after-effects/desktop/get-started/technical-requirements/system-requirements.html)
- [Adobe：After Effects 25.x system requirements](https://helpx.adobe.com/after-effects/system-requirements/2025.html)
- [Adobe：After Effects on Apple Silicon / Rosetta boundary](https://helpx.adobe.com/after-effects/kb/after-effects-apple-silicon.html)
- [OpenAI：Responses compaction](https://developers.openai.com/api/docs/guides/compaction)

## 1. 目标与成功标准

本阶段只围绕四个结果推进：

1. **macOS 完全适配**：Apple Silicon Mac 上的安装、面板、MCP、AI 后端、AE 执行、截图、凭据和升级流程达到可发布状态。
2. **请求头 Bug 完全闭环**：chat-only provider 的 Responses facade 不再丢失必要请求头，并同时关闭本地鉴权、query、compact、错误处理和日志泄密等相邻缺口。
3. **Tool Library 完整实现**：完成本地工具资产的存储、发现、编辑、导入导出、隔离扫描、审批执行和迁移恢复闭环。
4. **Mac 开发、Mac + Windows 同版本发布闭环**：同一候选 commit 一次构建 macOS arm64 与 Windows x64 两个不可变包，分别完成平台验证后再给该 commit 创建最终 tag 并原样发布。

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
| macOS | macOS 14 Sonoma 或更高版本，Apple Silicon，原生 arm64；不支持 Rosetta |
| Windows | Windows 11 24H2 或更高版本，x64 |
| After Effects | 25.x 与 26.x；两个版本均需在 Mac arm64 和 Windows x64 完成实机 smoke |
| Intel Mac | 不承诺 |
| Windows ARM | 不承诺，也不把 Apple Silicon 上的 Windows ARM 虚拟机作为 x64 发布门禁 |

该矩阵与 Adobe 对 AE 26.x 的最低 macOS 14 / Windows 11 24H2 要求及 24.0 起不再支持 Rosetta 的现状对齐。文档、manifest 和测试必须只声明 AE 25.x–26.x；不得继续用 `[22.0,99.9]` 一类未经验证的宽泛范围代替真实支持承诺。

### 3.3 交付模型

- 单一代码库、单一版本号、单一 commit/tag。
- 从同一候选 SHA 分别原生构建：
  - macOS arm64 ZXP；
  - Windows x64 ZXP。
- 每个包自包含核心运行所需的平台依赖，并携带依赖清单、许可证清单、内容 hash 和构建来源。
- 两个平台包作为同一版本的一组原子发布资产；任一平台未过门禁时，两者均不公开发布。

“自包含”的边界固定如下：

| 类别 | 内容 |
|---|---|
| ZXP 内载荷 | CEP manifest/panel bundle、host/sidecar 生产依赖、锁定的便携 Node runtime、锁定的便携 CPython runtime、core/bridge/snapshot wheels、平台 helper、启动器和默认 bundled tools |
| 安装时动作 | 只解包、注册启动器、写入配置引用和请求系统权限；核心能力不得在安装时联网下载依赖 |
| 外部必需 | After Effects、操作系统支持的凭据库、macOS Screen Recording 权限 |
| 外部可选 | Claude Code、Codex、ZCode CLI 及其账号；只影响各自订阅/CLI 通道，不影响 API-direct provider 与核心 MCP/AE 能力 |
| 仅开发需要 | `uv`、开发版 Python/Node、编译与签名工具链 |

便携 Python/Node 的准确 patch 版本由 Phase 0 在依赖兼容测试后写入 lock 与 SBOM；发布包不依赖系统 Python、系统 Node、`uv` 或在线 PyPI/npm 解析。若许可证或签名验证证明某运行时不能合法、可靠地内置，必须回到设计审批，不能静默退回在线安装。

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

### 4.1 平台 helper 边界

系统凭据与窗口截图不由 CEP 中的任意脚本、系统 Python 或临时 shell 命令直接操作，而由包内签名的 `ae-mcp-platform-helper` broker 负责：

- macOS 载荷为具有稳定 bundle ID `com.junkdoge.ae-mcp.platform-helper` 的后台 XPC/helper；通过 Security.framework 访问 Keychain，通过 ScreenCaptureKit 捕获窗口，Quartz 只用于窗口发现、坐标与元数据。
- Windows 载荷通过 Win32 Credential Manager API 与窗口 API 实现同一协议，并使用仅当前用户 ACL 的命名管道/继承 handle。
- 只有运行在 After Effects 中的 CEP host 可以建立生产 broker 会话。Python snapshotter 不直接启动 helper，而通过现有已认证 host bridge 请求窗口捕获；host 不暴露任何 secret read HTTP/RPC endpoint。
- macOS broker 在初始化任何 secret subsystem 前验证 XPC audit token、Adobe After Effects bundle ID/Team designated requirement 与允许的 AE 25/26 进程链；Windows broker 验证父进程 image、Adobe Authenticode signer、会话用户以及不可继承给无关进程的一次性 pipe capability。
- 任意 Terminal、系统 Python、其他本机进程或复制出的 helper 直接启动时，必须在 secret read、窗口捕获和 reference 解析之前拒绝。生产 helper 不提供通用 CLI 模式，不允许 secret enumeration。
- 协议只暴露版本化的 `secret.get/set/delete`、`window.find/describe/capture` 和 `capabilities`；每个操作校验 schema、大小、精确 reference/AE target 和目标命名空间。Secret 与 capture handler 权限逻辑隔离，capture 只能定位 Adobe 签名的 After Effects 窗口，不能成为任意屏幕/窗口捕获器。
- 生产实现使用稳定签名身份；测试注入内存 secret store 与 fake capture backend，不触碰真实系统凭据或 TCC。

Phase 0 必须先用最小 helper 验证 TCC 归属、Keychain ACL、Credential Manager 可读回、AE 更新后的身份稳定性、安装后签名和敌对调用。至少包含“从 Terminal/Python 直接启动”“伪造 reference/namespace”“错误父进程/签名”“复用旧 pipe/capability”负例，且都必须在 secret read 前失败；验证失败即暂停相关实现并回到设计评审。

## 5. macOS 适配设计

### 5.1 Panel 与后端编排

- 使用平台原生路径 API，不再手写反斜杠 join/dirname。
- 可执行文件发现按“显式环境变量覆盖 → 已知应用内路径 → 登录 shell/PATH → 标准安装目录”进行，并在诊断 UI 显示实际命中的绝对路径与版本。
- CEP 启动环境缺失 `HOME`、PATH 等变量时，由平台层以可审计方式补全；不得读取或猜测无关用户环境。
- Wizard、Claude、Codex、ZCode、配置继承、日志 reveal 都消费同一平台能力，避免各自复制发现逻辑。
- 缺少 CLI、依赖或登录态时返回结构化诊断与修复动作，不静默 fallback 到错误二进制。

### 5.2 截图

- `ae.previewFrame` 继续优先使用 AE 原生 `CompItem.saveFrameToPng`，这是平台无关、内容精确的主路径。
- `ae.snapshot` 在 macOS 由签名 helper 使用 ScreenCaptureKit 捕获；Quartz 仅用于窗口发现与坐标换算，不作为图像捕获 fallback。覆盖：
  - Screen Recording/TCC 权限检测与引导；
  - Retina 比例；
  - 多显示器坐标；
  - 遮挡窗口仍按窗口内容捕获；
  - 最小化、离开当前 Space 或不可捕获时返回 `AE_WINDOW_NOT_CAPTURABLE`；
  - 未发现 AE 窗口时返回 `AE_WINDOW_NOT_FOUND`；
  - 未授权时返回 `SCREEN_RECORDING_PERMISSION_REQUIRED`；
  - 不得在 AE 窗口解析失败时静默截取整个桌面。
- Screen Recording 权限未授予时，`ae.snapshot` 明确报告不可用；不影响仍可工作的 `ae.previewFrame` 原生路径。

### 5.3 安装、升级与打包

- macOS 开发安装脚本必须可执行，并安装/验证 host、panel、sidecar 所需依赖。
- 首次安装、升级和卸载文档不得要求 Windows 命令。
- ZXP 内载荷在 Panel 首次启动时离线解包到 `~/.ae-mcp/runtime/<version>/<platform-arch>`；稳定启动器位于 `~/.ae-mcp/bin/ae-mcp`，只通过原子 `current` pointer 选择已验证 runtime。升级先安装新目录并 smoke，成功后切换；失败/回滚只切回旧 pointer。Settings 中的卸载动作经用户确认后删除 shim 与未使用 runtime，不由 DMG/ZXP 静默删除用户配置或 Tool Library。
- 原生可执行依赖保留 Unix executable mode；构建时验证架构，阻止把 Windows 或 Darwin x64 sidecar 误装进 arm64 包。
- Phase 0 必须确定并固化 macOS 发布链：nested helper/runtime 签名 → ZXP 签名 → 分发容器验证。若原始 ZXP 不能作为 Apple 公证/装订对象，则保留 ZXP 载荷，并额外使用签名、公证、staple 的 DMG/PKG 作为 macOS 分发容器；不得把该判断推迟到最终 RC。
- Developer ID、ZXP 证书、Windows Authenticode 证书和 notary 凭据存放在 protected CI environment。流水线执行 `codesign`/架构检查、ZXP 验签、`spctl`/staple 或等价安装后检查，并记录命令结果。

## 6. 请求头路由闭环设计

### 6.1 Provider profile

Provider profile 在现有 base URL、模型和 dialect 基础上扩展以下概念：

- 认证方式：Bearer、`x-api-key`、自定义认证 header、none；认证 header 只能由认证层生成；
- 敏感值引用：配置中只保存 secret reference，不保存明文；
- 可配置的额外请求头：header name、secret/value reference、适用范围；所有来源都经过同一最终校验；
- 探测请求与模型请求可使用不同认证/头集合；
- 显式 dialect override 与按精确 `modelId` 保存的经验证探测结果。同一 Provider 可同时包含 native Responses 与 Chat-only 模型；旧版没有模型绑定的 Provider 级 `detected` 结果必须失效并按未确认处理，不能套用到所有模型。

Provider 配置不支持导出。任何 UI、日志、诊断包和 Tool Library 导出都不能带出 provider header 值或 secret reference 可解析内容。

### 6.2 请求链

```text
Codex
  → loopback-only facade
  → 校验该会话的独立 route token
  → 校验 method、path、query、body 与资源上限
  → 根据 provider profile 选择 probe/model 头集合
  → 合并受允许的 Codex 元数据头与 provider 头
  → 对合并结果再次执行最终 denylist/schema 校验
  → 由认证层最后注入唯一的上游认证头
  → provider upstream
  → 流式或非流式响应
```

### 6.3 Endpoint 契约

Facade 只接受下表入口；`/v1/chat/completions` 不是本地入口，也不能成为任意反向代理：

| 入站 | chat-only 上游 | 请求/响应语义 |
|---|---|---|
| `GET /v1/models` | `GET <base>/v1/models` | body 不存在；保留 query；status/body 透明传递但响应头经过 allowlist；结果只用于枚举模型 ID，不作为各模型 dialect 的证据 |
| `POST /v1/responses` | `POST <base>/v1/chat/completions` | 只转换已声明支持的 Responses 字段、function tools 与对应 SSE/JSON 输出；无法等价转换或未知且不能安全忽略的字段返回结构化 501，畸形的已支持字段返回 400，均不静默丢弃 |
| `POST /v1/responses/compact` | 不转换为普通 Chat Completion | chat-only provider 返回 501 `provider_compaction_unsupported`；native Responses provider 不经过 facade，直接调用其原生 compact endpoint |

当前官方 compact endpoint 返回可供下一轮原样携带的 compacted window，其中包含不可由 Chat Completions 等价伪造的 opaque compaction item。因此本项目不得把 compact 当作普通 responses 调用或制造伪 `encrypted_content`。最终 RC 必须运行 Codex 长上下文测试：若目标 Codex 版本无法在 501 后继续工作，则 chat-only provider 仍不算完整支持，必须先另行批准并实现真实的本地 compaction 设计。

Responses → Chat 转换器维护显式 schema：

- 支持 `model`、`instructions`、文本 message、function call/output、`max_output_tokens`、`temperature`、`top_p`、function tools、`tool_choice`、`parallel_tool_calls` 和 `stream`。
- image/audio/file input、OpenAI hosted tools、conversation/`previous_response_id`、background、未知 output item 等不能等价表达的能力一律 fail closed，并返回具体不兼容字段。
- 每个受支持 Codex 版本保存请求/响应 fixture；升级 Codex 时先更新契约测试，不靠宽松字段忽略维持“兼容”。

### 6.4 请求头契约

入站 Codex 头只允许以下集合，大小写不敏感：

- 精确名称：`accept`、`content-type`、`openai-beta`、`user-agent`、`x-client-request-id`、`x-request-id`、`traceparent`、`tracestate`；
- 受限前缀：`x-stainless-*`、`x-codex-*`；
- `content-type` 必须是受支持的 JSON 类型；前缀匹配后仍执行 header name/value 和长度校验。

所有来源——包括 Codex 入站头、provider 额外头和认证配置——都必须拒绝：

- `Host`、`Content-Length`、`Connection`、`Transfer-Encoding`、`Upgrade`、`Keep-Alive`、`TE`、`Trailer`、`Expect`；
- `Cookie`、`Set-Cookie`、`Forwarded`、`X-Forwarded-*`、`Proxy-*`、`Sec-*`；
- CR、LF、NUL、非 RFC token 头名、单值超过 8 KiB、总头超过 32 KiB 或超过 64 个头。

认证层独占 `Authorization`、`x-api-key` 或所选自定义认证 header。Provider 的“额外头”不能设置这些认证头、本地 route token、逐跳头或路由控制头。合并优先级为“安全 Codex 元数据 < provider 额外头 < 认证层”，但最终 denylist 在每一层之后和发出请求之前各执行一次。

响应只转发 `content-type`、`cache-control`、`retry-after`、标准 rate-limit 头以及 `x-request-id`/受支持 provider request-id；`set-cookie`、逐跳头和未知认证相关头不返回本地客户端。日志只记录头名、策略决策和脱敏摘要。

### 6.5 本地鉴权、URL 与资源边界

- facade 仅绑定 `127.0.0.1`；启动时用 CSPRNG 生成 32-byte/256-bit base64url token，保存在内存，关闭时销毁，不写磁盘。
- Codex 通过 `Authorization: Bearer <route-token>` 访问 facade；服务端先固定解析 Bearer，再以 constant-time 比较。缺失或错误 token 返回 401，并产生零次 DNS、secret read 或上游调用。
- 上游只允许 `https:`；`http:` 默认仅允许 loopback。非 loopback 明文 HTTP 需要 provider profile 的显式危险开关和再次确认。禁止 URL userinfo、fragment、路径穿越及协议相对 URL。
- 不自动跟随 3xx；任何 redirect 原样转为受控错误，绝不跨 origin 携带认证。URL join 保留 provider base path，但最终 origin 必须与配置 origin 相同。
- 默认上限：request body 16 MiB、单 SSE frame 1 MiB、同 route 并发 4、连接超时 15 秒、活动空闲超时 120 秒、总调用 30 分钟；后续可在安全范围内配置，但不能无限制。
- 客户端断开立即 abort upstream；错误 body 最多读取 64 KiB，经 JSON 解析与 secret redaction 后才可显示，原始 provider 回显不得直通 UI。

### 6.6 Dialect 探测

- 必须由当前明确、非空的 `modelId` 发起探测；不允许用列表首项代替，也不允许把一个模型的结果推广到同一 Provider 的其他模型。
- `/v1/models` 只枚举可选模型。对当前模型先发送字段完整的最小 Responses 请求，只有 HTTP 200 且命中已知 Responses 成功 schema 才记为 native Responses；否则再发送字段完整的最小 Chat Completions 请求，只有 HTTP 200 且命中已知 Chat 成功 schema 才记为 Chat-only。
- 任意 HTTP 400 JSON、HTML 错误页、WAF challenge 或登录重定向都不能视为支持。
- 探测结果按精确 `modelId` 缓存，并带 base URL、auth profile revision 和时间戳；模型不匹配或任一校验项改变即失效。旧版 Provider 级单例结果因缺少模型绑定而 fail closed。
- 探测失败不覆盖用户显式选择；UI 显示“未确认”而不是猜测成功。

## 7. Tool Library 设计

### 7.1 资产模型与存储

`ToolArtifact` 至少表达：

- 稳定 ID、名称、描述、kind；
- category、tags、兼容性与安全级别；
- source、status、created/updated 时间；
- verified 与验证方式元数据；
- 内容、内容 hash 和 schema version。

支持的 kind 为：`jsx`、`expression`、`prompt-skill`、`recipe`、`diagnostic`。

- 用户资产主存储位于 `~/.ae-mcp/tools`，采用本地 JSON/内容文件与版本化 schema。
- bundled 工具随产品发布，只读且可追踪到产品版本。
- 历史记录可生成 candidate，但 candidate 与 saved/verified 状态严格分离。
- `status` 支持 candidate、saved、pinned、archived、deprecated；verified 是独立验证属性，不是导入来源可声明的信任等级。

现有 skill 保持 v0.9.x 兼容：

- 继续读取 `~/.ae-mcp/skills` 与 `AE_MCP_SKILL_DIR`，并在 Tools UI 中作为 legacy source 建立索引；不在首次升级时制造第二份可分叉的副本。
- 旧 `ae.skill*` MCP tools 继续工作；对 legacy skill 的 Tool Library 编辑写回原 skill store，因此只有一个 canonical copy。
- `ae.skillUse execute=false` 保持旧的 render-only 返回；`execute=true` 必须内部委托给同一 prepare/risk/hash/grant 引擎，以 deterministic legacy artifact ID 与实际 skill content hash 参与审批。旧入口不得保留按工具名或 `none` 无条件执行 JSX 的旁路。
- legacy 缺少的 category/status/verified 元数据写入 `~/.ae-mcp/tools/legacy-metadata.json`，key 为 canonical source path + content hash；外部编辑导致 hash 改变时撤销 verified/grant。该 sidecar 使用同一 revision/CAS 与备份机制。
- bundled skill/tool 使用 `builtin:` 命名空间，只读、不可被同名用户文件静默覆盖；Duplicate 会创建新的用户 ID。
- 升级前存在 legacy/user/bundled 同名时全部保留并分配不同 namespaced ID；旧 `ae.skill*` 继续使用原 skill store 的既有解析顺序，新 Tool UI/`ae.tool*` 必须用精确 ID，不做名称猜测。
- 用户明确 Duplicate/Convert 后才把 legacy/bundled 内容写入 `~/.ae-mcp/tools`。

### 7.2 MCP 与 UI 能力

完成以下带 `ae.` 命名空间的渐进式 MCP 工具及对应 Tools UI：

- `ae.toolIndex`
- `ae.toolSearch`
- `ae.toolInspect`
- `ae.toolUse`
- `ae.toolCreate`
- `ae.toolEdit`
- `ae.toolDelete`
- `ae.toolArchive`
- `ae.toolDuplicate`
- `ae.toolPromoteFromHistory`

列表和搜索只返回轻量索引；inspect 才读取完整内容，避免把整个库无条件塞入模型上下文。

### 7.3 Artifact kind 边界

| kind | 解释/执行语义 |
|---|---|
| `jsx` | 在 AE ExtendScript bridge 执行；服务端分析实际模板与渲染参数并计算 write/destructive/external 风险 |
| `expression` | 只产生表达式文本或应用到明确的 comp/layer/property target；应用属于 write，不能把任意 JSX 伪装为 expression |
| `prompt-skill` | 作为标记清晰的“不可信用户上下文”按需插入；不得自动进入 system/developer prompt，也不直接执行代码 |
| `recipe` | 只引用受支持 artifact/tool 与显式参数；展开为有限步骤的执行计划，风险取所有步骤和目标的最高值 |
| `diagnostic` | 仅调用 read-only capability；任何写入、文件、网络或任意 JSX 使其至少升级为 write/external，不能依赖导入 metadata 自称只读 |

所有导入文本在 UI 中按文本转义，不作为 HTML 渲染。Recipe 依赖的每个 artifact hash 都进入最终 plan hash；任一依赖变化使审批失效。Bundled trust 来自随产品签名 manifest，不来自内容 hash；hash 只证明内容一致性，不能证明作者或安全性。

### 7.4 执行与审批

- candidate 永远不可直接执行。
- saved 工具可发起 prepare；verified/pinned 只改变可信度表达、排序与发现体验，不改变审批矩阵。
- 风险由服务端根据 artifact kind、渲染内容、参数和目标重新计算；导入或用户声明只能提高风险，不能降低。
- prepare 返回 `{artifactId, contentHash, operation, normalizedArgs, target, planHash, risk, expiresAt}`。真正执行需要与该对象完全绑定的一次性 grant；执行前重新读取不可变内容并核对所有 hash，防止 TOCTOU。
- 编辑 artifact、参数 schema 或 recipe 依赖会撤销 verified，并使旧 grant/session allow 全部失效。
- “本会话允许”只可用于同一 artifact hash、operation 和归一化 target 的 read/write 操作；不得只按 `ae.toolUse` 名称放行，也不适用于 destructive/external。

四模式的服务端强制矩阵为：

| 状态/风险 | readonly | manual | auto | none / Bypass |
|---|---|---|---|---|
| candidate / archived / deprecated | 阻止 | 阻止 | 阻止 | 阻止 |
| read | 自动 | 自动 | 自动 | 自动 |
| write（本地、可逆） | 阻止 | 每次或受限 session grant | 自动 grant | 自动 grant |
| destructive / external / 不可逆 | 阻止 | 每次明确批准 | 每次明确批准 | **仍须每次明确批准** |

这保留四个用户模式，但对 Tool Library 的高风险动态内容增加不可绕过的服务端下限；现有 `none` 不能因为统一入口名相同而放行任意导入 JSX。无法参与 grant 流程的外部 MCP 客户端可以 inspect/prepare，但不能执行 destructive/external artifact。

执行记录关联 artifact ID、content/plan hash、归一化参数与目标、审批/grant、实际执行结果和 backend，便于审计与复现。Tool Library 功能 PR 必须立即运行 Claude/Codex/ZCode 的审批适配回归；最终 RC 再运行完整端到端矩阵。

### 7.5 `.aemcptools` 导入导出

`.aemcptools` 是确定性的 UTF-8 ZIP：根目录只允许 `manifest.json` 和 manifest 引用的 `artifacts/` 普通文件；不允许加密 ZIP、嵌套归档或未声明文件。Manifest 包含 schema version、artifact 内容 hash 与来源元数据；不包含 provider、凭据、token、系统路径中的秘密或外部登录态。

导入流程固定为：

```text
.aemcptools
  → 在内存预检 central directory 与路径
  → 解包到当前用户专属隔离区
  → 校验包结构、schema、hash 和兼容性
  → 扫描秘密及危险内容
  → 展示差异、风险和冲突
  → 用户确认导入为 candidate
  → 单独审阅并提升为 saved
```

- 包上限：压缩包 10 MiB、展开总量 50 MiB、单文件 5 MiB、512 entries、目录深度 8、压缩比 100:1；超过任一项立即拒绝。
- 路径必须是规范化相对路径并保持在隔离根下；拒绝绝对路径、`..`、drive/UNC、symlink、hardlink、设备/特殊文件、重复路径以及 Unicode-normalize + case-fold 后的跨平台冲突。
- macOS 隔离目录权限为 0700；Windows ACL 仅当前用户。扫描/预览期间不得 `eval`、`require`、运行脚本、解析为 HTML 或跟随链接。
- secret scan 在任何持久化、diff 展示或日志记录之前运行；命中 credential 时只显示脱敏类型/位置，拒绝持久化并清理临时内容。Scanner 异常或不可用一律 fail closed。
- 导入一律重置 verified、pinned 和来源信任，只能进入 candidate；整包确认不能直接变为 saved。
- hash 不匹配、schema 不支持、secret 命中、恶意归档结构或策略禁止内容时拒绝导入。合法但风险为 destructive/external 的 artifact 可以作为 candidate 导入，由服务端标高风险并进入严格审批；“风险高”本身不等于恶意包。
- 导出同样强制执行 secret scan；scanner 失败或命中秘密时不生成包。
- 导入采用临时目录和原子提交，失败不留下半导入状态；存储使用 revision/CAS 与跨进程锁，处理多个 MCP/Panel 实例并提供过期锁恢复。
- 冲突处理不得静默覆盖用户现有工具；保留、替换或生成副本必须由用户明确选择。“替换”只在单个 candidate 完成审阅/提升时原子发生，旧 revision 进入可恢复备份，导入整包阶段不能覆盖现有内容。

## 8. 凭据、迁移与数据安全

### 8.1 Secret store

Threat model：本设计防止 secret 落入普通文件、导出、日志、未鉴权 localhost route 或任意直接启动的 helper；不声称抵御已完全控制当前 OS 用户、能在 After Effects 进程内执行代码或能读取该用户 Credential Manager 的恶意软件。检测到这类本机入侵时应撤销 provider 凭据。

- macOS helper 使用 Security.framework/Keychain；Windows helper 使用 `CredWrite/CredRead/CredDelete`/Credential Manager。Panel 与 Python 不直接调用 shell 或第三方密码 CLI。
- Keychain service 固定为 `com.junkdoge.ae-mcp`，account 使用 `provider:<provider-uuid>:<slot>:v1`；Windows target 使用等价的 `ae-mcp/provider/<uuid>/<slot>/v1`。条目只对当前 OS 用户可用。
- helper 的 bundle ID、Team ID/designated requirement 和 Windows publisher identity 在升级中保持稳定；Phase 0 验证新旧包之间仍可读回。
- JSON 只保存 provider/字段标识和不含秘密的 opaque reference；调用者不能把 reference 当作路径、命令或任意系统凭据 key 使用。
- 不把敏感值 fallback 到普通 JSON、localStorage、日志或导出包。
- secret store 不可用时，相关 provider 明确不可用并给出修复提示，不静默降低安全等级。
- `set` 必须写入后读回校验；`delete` 幂等；更新使用 revision/CAS，测试可注入内存实现。

### 8.2 迁移

- 首次升级前备份 settings、skills/tools 和索引；provider 备份必须先脱敏，绝不复制当前 `providers.json` 中的明文 `apiKey`。
- provider secret 迁移使用可重入的两阶段 journal：
  1. 读取旧配置，在内存中为每个明文 secret 分配目标 reference；
  2. 写入系统凭据并逐项读回验证；
  3. 生成只含 reference 的脱敏备份与新 JSON，校验后原子替换；
  4. 写 committed marker，再清除旧明文临时文件与 journal 中的敏感片段；
  5. 崩溃重启时根据 phase 与 revision 幂等继续或回滚，不重复生成凭据。
- 回滚恢复“上一份逻辑配置 + 已写入的受保护 secret entries”，不把 secret 重新写回普通 JSON。自动降级到不认识 secret reference 的 v0.9.0 二进制不受支持；回滚由当前迁移器完成。
- 脱敏备份权限限制为当前用户，带 checksum、版本、创建时间和保留策略；默认保留最近三份/30 天，用户可立即删除。系统凭据中的旧版本 entry 仅在所有引用迁移完成并经过一个成功启动后清理。
- 普通 JSON 写入仍使用临时文件、校验和原子替换；APFS/NTFS 上不承诺物理“安全擦除”，但不得主动制造新的明文副本。
- 迁移有单调递增 schema version，支持从当前 v0.9.0 数据无损升级。现有 provider、skills、settings 与 key 引用继续工作。

## 9. 错误处理与可观测性

- 统一错误分类：配置、认证、权限、网络、协议、平台能力、迁移、包校验、AE 宿主。
- 用户可见错误包含可执行的修复建议；内部错误保留 cause/code 供诊断，但不直接泄露实现细节或 secret。
- provider 探测明确区分认证失败、网络失败、路径不支持和 dialect 不兼容。
- 路由日志可关联本地 request ID 与脱敏后的 upstream request ID；Tool Library 日志可关联 artifact hash。
- 诊断包默认脱敏，且不包含 provider 配置导出。
- 平台能力缺失只影响对应能力，不得清空配置、破坏 Tool Library 或导致无关功能崩溃。

## 10. 实施与 PR 顺序

采用小 PR 顺序合并，保持 `main` 可用：

1. **Phase 0 可行性与供应链 spike**：最小平台 helper、TCC/Keychain/Credential Manager、便携 Node/Python、依赖许可证、nested signing、ZXP/外层分发容器与不可变 artifact promotion。输出必须是可复现测试和已锁定决策；失败时回到设计审批。
2. **规范与测试骨架**：固定支持矩阵、平台能力/JSON-RPC 契约、CI matrix 和测试 fixture。
3. **macOS Panel/安装适配**：路径、CLI 发现、spawn env、Wizard、日志、离线 runtime 和依赖检查。
4. **macOS 截图与 secret store**：签名 helper、ScreenCaptureKit、TCC、Retina、多显示器和两阶段 secret 迁移。
5. **双平台打包骨架**：平台原生依赖、架构校验、签名、公证与可追踪产物。
6. **请求头路由闭环**：在最新 `main` 上吸收 PR #51，先补失败/安全测试，再实现 endpoint、header 与资源契约。
7. **Tool Library 存储与迁移**：模型、legacy skill view、索引、并发/原子存储、历史候选和备份恢复。
8. **Tool Library UI/MCP/导入导出**：完整 CRUD/Archive/Duplicate、渐进读取、敌对包隔离和 hash-bound 审批。
9. **最终 RC 与发布编排**：全量回归、四格 AE 实机矩阵、Windows Codex attestation、不可变产物原样发布。

每个 PR 运行相关单元/集成测试。安全、数据损坏和阻塞问题立即修复；不影响当前体验的隐性问题可登记，但必须在最终 RC 统一复测，并在影响完成定义时关闭。

## 11. 双平台 CI、实机验证与发布

### 11.1 自动化构建

- macOS runner 原生安装依赖、运行测试并构建 macOS arm64 载荷。
- Windows x64 runner 原生安装依赖、运行测试并构建 Windows x64 载荷。
- 最终 RC coordination PR 先按正常评审合入 protected `main`；合入后的 `main` SHA 才是候选 SHA。实机报告仍评论在该已合并 PR 下。候选之后不得 squash/rebase/改写；失败修复走新 PR 并产生新候选。
- 签名构建由 protected 默认分支上的固定 reusable/workflow-dispatch 定义执行；fork PR 或候选源码中的工作流修改不能直接取得签名 secret。签名 job 需要 protected Environment 人工批准，并硬校验候选 SHA 可达 protected `main`、runner 架构与 trusted workflow revision。
- 候选 SHA 只构建一次不可变 RC artifacts。构建锁定依赖，验证 portable runtime、sidecar/native package/helper 的 OS 与架构，生成 SHA-256、SBOM、许可证清单、签名结果、workflow run ID 和 artifact ID。
- 自动化测试和实机测试都必须下载该 run 的指定 artifact，不接受本地重建包。
- 通过后最终 release **原样提升同一字节**；禁止为了正式 tag 再构建。最终 tag 指向候选 SHA，release workflow 校验 tag SHA、Check、artifact ID 与 digest 全部一致。
- 失败候选永久标记 rejected；任何代码、依赖或签名变化都产生新 SHA/新 artifacts，并重新跑两个平台门禁。

### 11.2 macOS 实机

主要开发机下载指定 macOS RC artifact 后完成：

- 全新安装与旧版升级；
- Panel/host/sidecar/MCP 启动；
- Claude、Codex、ZCode 中处于支持范围内的通道 smoke；
- AE 命令、previewFrame、snapshot、权限拒绝与恢复；
- provider、Tool Library、重启持久化和回滚；
- macOS ZXP/分发容器安装后的 Gatekeeper、签名、公证与 hash 验证；
- AE 25.x 与 26.x 均执行同一 smoke 清单并生成 macOS attestation JSON。

固定 Mac 验证脚本生成 canonical `macos-attestation.json`，绑定 candidate SHA、workflow run/artifact ID、artifact SHA-256、macOS/AE 25/26 patch 版本、smoke 结果和失败证据。Allowlisted 身份上传报告后，验证 workflow 校验 schema、main SHA、artifact metadata/digest，并经 protected reviewer 生成 `macos-rc-attestation` Check；没有该 Check 不能发布。

### 11.3 Windows Codex 手工门禁

由于本机无法代表性地运行 Windows x64 After Effects，最终 Windows 实机验证交给一台 Windows x64 机器上的 Codex：

- 用户在 Windows 机器拉取 PR 指定的精确 branch/commit，并下载指定 workflow run/artifact ID 的 Windows RC；测试对象不能由 Windows 机器重建替代。
- Windows Codex 使用仓库生成的固定提示词，只测试和报告，不修改代码。
- 它运行仓库内固定验证脚本，验证安装、自动化测试、AE 25.x/26.x smoke、升级/回滚、签名与 artifact，并生成 canonical `windows-attestation.json`。
- 它在当前 PR 留下人类可读评论和机器可解析 JSON marker，至少包含：commit SHA、workflow run/artifact ID、artifact SHA-256、Windows/AE/Codex 版本、测试命令与结果、两版 AE smoke 清单、失败证据以及最终 `PASS`/`FAIL`。
- `issue_comment` workflow 只接受配置 allowlist 中的 GitHub 身份，校验 comment schema、评论所指 candidate SHA 等于当前 protected `main` 候选、artifact metadata/digest，并生成 `windows-rc-attestation` Check；评论是用户要求的呈现，Check 才是机械门禁。
- protected GitHub Environment 由指定 reviewer 对 attestation 做最终确认。只有 SHA、artifact digest、allowlisted author、Check 与人工 approval 全部匹配时 Windows 门禁才通过。
- Attestation workflow 监听 comment create/edit/delete。删除或修改作为依据的评论会撤销/重算 Check；同一 SHA/digest 后续出现有效 `FAIL` 时，旧 `PASS` 立即失效，直到出现更新 artifact 的新候选流程，不允许挑选历史有利评论。
- 失败返回主开发流程修复，再从新 SHA/新 artifact 重跑；旧 PASS 不能沿用。

### 11.4 原子发布门禁

公开发布必须同时满足：

- macOS 自动化与实机通过，且 `macos-rc-attestation` Check 有效；
- Windows 自动化构建通过；
- Windows Codex 对精确 release candidate artifact 留下合格 `PASS`，且 `windows-rc-attestation` Check 通过；
- 两个包的版本、commit、依赖与 hash 可追溯；
- 没有安全、数据损坏、安装阻塞或核心体验缺陷；
- 安装、升级、回滚、已知限制和 Windows 交接文档完整。

任一条件失败时，不创建最终 tag，也不发布两个平台中的任何一个。全部通过后，最终 tag 指向已验证 SHA，并把已验证 RC bytes 原样提升到 release；release workflow 对下载后的字节再次计算 hash。

## 12. 测试矩阵

### 12.1 macOS 与平台层

- POSIX/Windows 路径 fixture、用户目录、空/异常环境变量。
- CLI 显式覆盖、PATH、标准路径、多个版本与不存在场景。
- spawn 环境、退出、取消、超时、带空格路径；登录 shell 只作为带超时和输出上限的末级探测，验证 symlink、版本、架构并拒绝启动脚本污染结果。
- helper JSON-RPC schema、长度、未知操作、非授权路径和无网络监听；Terminal/Python 直启、错误 parent/signature/audit token、旧 pipe capability、secret enumeration 全部在 secret read/capture 前失败。
- Keychain/Credential Manager 的写入读回、更新 CAS、删除、拒绝、升级身份和不可用。
- 两阶段 secret 迁移在每个崩溃点的幂等继续/回滚；备份和 temp 不得出现明文 secret。
- Screen Recording 首次拒绝、后续授权、Retina、多显示器、遮挡、最小化、其他 Space、窗口消失和不得截桌面。
- fresh install、upgrade、rollback、架构错误依赖和 executable mode。

### 12.2 请求头路由

- Bearer、`x-api-key`、custom auth header、none。
- probe/model 分离认证与 provider-configured header precedence。
- 精确验证入站 allowlist、前缀规则、大小写、重复头、数量/长度上限和响应头 allowlist。
- 拒绝 provider 重新注入 Host、hop-by-hop、Cookie、proxy、认证头、CR/LF/NUL 和本地 route token。
- 缺失/错误 route token 返回 401 且上游请求数为零。
- CSPRNG/token 生命周期与 constant-time 验证。
- models、responses、responses/compact 的 endpoint/method/path/query；chat/completions 入站必须 404/405。
- `/responses/compact` 的 native 直连、chat-only 501 与 Codex 长上下文行为。
- unsupported Responses fields fail closed；受支持字段与 SSE/JSON fixture 精确转换。
- 流式/非流式、取消、超时、并发/body/header/SSE 上限、redirect、跨 origin、上游断连与脱敏错误 body。
- 同一 Provider 内 Responses/Chat 混合模型、逐模型 dialect false positive、精确模型缓存、旧 Provider 级缓存失效与显式 override。
- 使用真实 Codex 对要求特定元数据头的 chat-only mock/测试 provider 做集成 smoke。

### 12.3 Tool Library

- schema、CRUD、索引、搜索、排序、bundled 只读与历史提升。
- legacy `~/.ae-mcp/skills`、`AE_MCP_SKILL_DIR`、旧 `ae.skill*`、metadata sidecar、同名映射、bundled Duplicate 与命名空间兼容；`ae.skillUse execute=true` 必须复用同一 hash-bound grant，不能旁路。
- candidate/archived/deprecated 不可执行；saved/verified/pinned 均遵守四模式 × 风险矩阵。
- risk 重算、hash/args/target-bound grant、依赖变化、编辑撤销 verified、session allow 范围和 TOCTOU。
- 五种 kind 的解释边界、prompt/HTML 转义、recipe plan hash 与 capability 限制。
- `.aemcptools` round-trip、zip-slip、链接/特殊文件、Unicode/case 冲突、解压炸弹、大小/数量、hash 篡改、未知 schema、秘密扫描 fail-closed 和冲突处理。
- 导入/导出 scanner 失败、原子失败、并发 revision/lock、崩溃恢复、备份与 rollback。
- Tool Library 功能 PR 立即跑三后端审批适配回归；最终 RC 再执行完整四级端到端矩阵。

### 12.4 AE 与发布

- AE 25.x/26.x × macOS arm64/Windows x64 四格实机 smoke 全部通过；使用相同清单并记录准确 patch 版本。
- 双平台 ZXP 内容、manifest、架构、权限、依赖和 hash 检查。
- Mac/Windows attestation schema、allowlisted author、artifact ID/digest、protected-main candidate SHA 与 protected approval 自动校验；comment edit/delete/later FAIL 必须撤销旧 Check。
- 签名 workflow 必须来自 protected 默认分支，fork/未保护 SHA 无法取得签名 secret，runner 架构不匹配立即失败。
- release workflow 验证任一平台失败时不会创建最终 tag；通过时只提升已验证 bytes，并在发布前后复核 hash。

## 13. 四个目标的完成定义

| 目标 | 必须通过的验收条件 |
|---|---|
| macOS 完全适配 | macOS 14+ Apple Silicon 上全新安装、升级、Panel、MCP、AE 25/26、配置、Keychain、签名 helper、ScreenCaptureKit、多显示器/Retina、卸载/恢复通过；不依赖系统 Python/Node/uv 或 Windows 命令 |
| 请求头 Bug 闭环 | 认证、endpoint、转换、流式/非流式、query、compact 限制、资源上限与安全负例通过；无本地鉴权绕过、危险头、SSRF/redirect 泄密或日志泄密；Codex 长上下文结果已明确验证 |
| Tool Library 完整实现 | 数据模型、旧 skill 兼容、CRUD/Archive/Duplicate、搜索、历史提升、敌对包导入、导出、hash-bound 审批、迁移恢复和秘密防泄漏全部通过 |
| 双平台发布闭环 | protected `main` 的同一候选 SHA 一次构建两个不可变平台包；四格 AE 实机矩阵通过；Mac 与 Windows attestation Check 都绑定各自 artifact digest，Windows Codex 留下 `PASS` 评论；发布原样提升已验证 bytes |

不以“自动化通过但 AE 未验证”、不同 commit 的两个包或仅一个平台可安装作为完成。

## 14. 前置条件与外部依赖

实施期间需要具备：

- macOS 14+ Apple Silicon 上可安装 AE 25.x 与 26.x，并能授予签名 helper Screen Recording 权限；
- 一台 Windows 11 24H2 x64 机器，可安装 AE 25.x 与 26.x，至少在平台基础里程碑和最终 RC 两次可用；
- Windows Codex 对仓库/PR 的读取与评论权限，以及一个用于 attestation Check 的 allowlisted GitHub 身份和 protected Environment reviewer；
- 一个可用于 live smoke 的 chat-only OpenAI-compatible provider，以及覆盖已承诺认证方式的测试凭据；
- Adobe ZXP 证书、Apple Developer ID/notary 凭据、Windows Authenticode 证书及 protected CI secret；
- 对便携 CPython、Node、native helper 与 npm/Python dependencies 完成许可证审计和可再分发确认；
- 固定 Codex 版本的 Responses/compact fixture 与一个可进行长上下文 live smoke 的测试额度。

这些条件不阻塞无关单元实现，但缺失时会阻塞对应里程碑或最终发布。AE 25.x 任一平台无法取得时，不降低验证等级：要么补齐环境，要么重新向用户申请把 AE 25.x 从正式支持矩阵降为 best-effort。

## 15. 工作量评估

以下为单人主开发、已有代码基础可复用、评审与 Windows 交接响应正常时的工程量区间：

| 工作流 | 估算 |
|---|---:|
| Phase 0：runtime/helper/TCC/凭据/签名与供应链 spike | 5–8 人日 |
| 平台适配、离线 runtime、截图、secret store、安装、CI 与双平台打包 | 17–27 人日 |
| 请求头路由安全、转换与 compact/长上下文闭环 | 4–7 人日 |
| Tool Library 完整范围与敌对输入/审批安全 | 15–25 人日 |
| 四格 AE 回归、不可变 RC、Windows attestation、文档与发布演练 | 6–12 人日 |
| **总计** | **47–79 人日** |

少量工作可并行或复用，实际净人日可能低于简单相加；但 self-contained runtime、稳定签名 helper、四格 AE 实机矩阵和可信 artifact attestation 都是原估算未充分覆盖的工作。证书审批、AE 25 获取、真实 provider 行为和 Windows 人工反馈属于额外日历等待。该估算是实施计划输入，不是日历交付承诺。

## 16. 最终约束摘要

- CEP 是本阶段唯一生产宿主。
- 共享业务代码，明确隔离系统能力，但继续维护并测试两个平台产物。
- 核心包离线自包含；AI CLI 是可选通道，不是核心运行前置。
- provider 配置不可导出，secret 只存在系统凭据库；旧明文通过两阶段 journal 迁移，不进入备份。
- 请求头采用固定 allowlist、全来源 denylist 和认证层独占，不是全丢弃或全透传；chat-only compact 不做伪转换。
- Tool 导入按敌对 ZIP 处理，candidate 不可执行，grant 绑定实际 hash/args/target，verified/pinned 不绕过审批。
- 小 PR 顺序合并，四个目标完成前不公开发布。
- Mac/Windows 两端的实机 attestation Check、Windows Codex `PASS` 评论和被测 artifact digest 是双平台版本不可替代的发布门禁；正式发布只原样提升被测 bytes。
