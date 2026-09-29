# 多实例工程架构：实施 TODO 与功能包简报

状态：Windows 本地诊断通过，进入 `awaiting-macos-hardware` 交接阶段。用户批准上限为 74 文件 / 7,000 手写行；分支提交与现有 CI 已纳入本次授权，macOS 实机、正式 HDEV、合并与发布仍未完成。交接步骤见 [MULTI_INSTANCE_MACOS_HANDOFF.md](MULTI_INSTANCE_MACOS_HANDOFF.md)。
工作分支：codex/multi-instance-projects
基线：bcab87a0ec96b4409636ba6dd3ae5fb3f25d17c7（已核对远端 main）
工作区：本聊天的 multi-instance-projects 托管 worktree。
原工作区和既有 .codex/ 内容保持不动。

## 已确认的产品契约

- 本机单用户；标准 MCP 能力不依赖 Codex 专用聊天身份。
- 每个正式工程一个主 AE；不同工程独立并行，同工程正式修改串行。
- 同工程一个写入上下文，其余只读；明确交接后才能写。
- 聊天、MCP 会话、工程组、实例和工作绑定不混为一谈。
- 所有工程调用显式绑定；多实例入口缺少目标时不能猜当前活动工程。
- 连接器负责发现、启动和路由，不建立独立应用或常驻协调服务。
- 共享本机记录只保存实例、归属、启动占位和资源额度，不保存聊天。
- 主面板主动关闭即停止该工程接入，不自动重开或另起主实例绕过。
- 客户端断线、端口不响应、心跳过期不自动释放写入权或重放操作。
- 辅助 AE 不需要 MCP 面板，不启动模型 provider，仅接受受维护的读取任务。
- 主 AE 可以直接读取/Preview 当前内存状态，不要求为普通实时预览先保存。
- 辅助读取使用指定快照；不能将其称为主工程此刻的实时状态。
- Preview 与 Render 分开；本功能不能用 aerender 悄悄替换 Preview。
- 主 AE 与 worker 保留 `saveFrameToPng`；用户接受预览结果可能不含 AE 查看器中可见的 Guide Layer。
- 取帧不增加 Guide 开关，不自动改变 `guideLayer`、`enabled` 或其他图层可见性状态。用户或模型在预览前自行显式准备所需工程状态；仅启用 `enabled` 不保证 Guide Layer 进入图像。
- 原 Guide 像素断言的历史 FAIL 保留，当前处置为 `accepted limitation`；取消未实施的原生探针与 OS 窗口截图研究。
- 图层、合成不是独立 OS 进程；辅助实例按任务/资源分配，不一层一进程。

## 保存、检查点与快照

- 开始辅助快照读取前，主 AE 正常保存原工程，再用文件复制制作 checkpoint。
- 不将 checkpoint 路径传给 project.save(File)，不关闭重开主工程来切回原路径。
- 首次未命名工程必须先取得正式保存位置；取消时不能假装已经保存。
- AEP 旁已有 `Adobe After Effects Auto-Save` 或简体中文 `自动保存` 目录时，使用其下 ae-mcp/checkpoints/<工程标识>/；两者并存时英文目录优先，保持已有放置规则。
- 没有上述目录时，使用当前会话工作目录下 ae-mcp/checkpoints/<工程标识>/。
- 不解析 AE 的自定义自动保存偏好，不写入客户端安装目录。
- 会话工作目录由接入上下文明确提供；不能使用 CEP 碰巧继承的 process.cwd()。
- metadata 记录 checkpoint 实际路径；历史记录按旧布局仍可列出和恢复，不批量搬迁。
- 内部恢复脚本与索引留在既有状态根，不随 checkpoint AEP 搬进自动保存目录。
- worker 使用同一已确认版本的快照，不在稍后重新复制可能已经改变的原工程。
- 保存/复制失败默认返回明确结果；允许用户对该次失败明确授权继续。
- 继续授权只覆盖当前任务，保留失败与授权记录，不将其标为 checkpoint 成功。
- 保存失败时需要当前状态的读取交回主 AE；没有有效快照就不派发伪称最新的 worker。
- 超时先核实文件及 AE 状态，不盲目重试。
- 只清理 MCP 登记的自有文件；活动任务引用的快照受保护，不碰 Adobe 自动保存文件。

## 公开 MCP 契约（实现命名冻结）

新增三个有界入口；已有 AE 工具保留业务实现，通过公共包装携带目标上下文。

| 工具 | 动作与主要参数 | 边界 |
| --- | --- | --- |
| ae_instances | list；start(project_path, work_dir)；stop(instance_id, save_policy) | start 创建主实例；辅助实例由读任务管理。stop 必须明确请求，默认拒绝丢弃未保存内容 |
| ae_workspace | bind(instance_id 或 project_path, access, work_dir)；inspect；release；transfer；reconcile | access=read/write；唯一 writer；交接等待已派发任务核实，旧写入资格失效；release 不关闭 AE |
| ae_readJob | submit(context_id, checkpoint_id, requests)；status(job_id)；result(job_id, offset, limit)；cancel(job_id) | 消费有效 checkpoint；只接受 ae_read / ae_previewFrame，不接受任意脚本；结果有界、逐项报告 |

- workspace_id：工程组；instance_id：本次 AE 运行；context_id：读/写工作绑定。
- 写入权由目标主 host 校验，context_id 可关联工程组，不要求调用者重复手填所有字段。
- 既有工具统一接收 context_id；明确单工程的面板/直连会话可绑定默认上下文。
- 通用多工程入口不得依赖共享的“当前 AE”，也不得依赖 Codex threadId。
- 只读角色限制落在真实派发边界；任意 JSX、恢复脚本、可执行 Tool Library/skill 不能绕过。
- 普通 schema/JSON-RPC/MCP 版本保持兼容；不依赖客户端支持新的 Tasks 扩展或专用 UI。
- 对外错误区分缺少上下文、已有写入者、源工程已变、checkpoint 失败、任务取消中和结果未知。
- worker 取消先停止后续派发；不能宣称同步 AE 脚本已经被强行中断。
- 批量任务状态位于所属 CEP host；不承诺面板重启/系统重启后恢复。
- 外部继续授权沿用客户端权限契约；面板继续授权走现有审批入口，绑定具体失败与任务。
- 节点之间的请求/响应保留实例、工程、快照、任务来源信息，日志不记录 Provider/API 密钥。

## 执行 TODO（一个功能包，不按版本拆分）

### 1. 准备与验收合同
- [x] 只读复核架构方向、信任边界、分支和安装位置。
- [x] 建立隔离 worktree 和 codex/multi-instance-projects 分支。
- [x] 核对远端 main 与基线一致。
- [x] 列出产品契约、公开入口、文件范围及验收路径。
- [x] 确认本简报的文件/手写行规模上限。
- [x] 把本简报明确的方向变更同步到 ARCHITECTURE_DIRECTION.md，保留原生冻结和三 provider 约束。

### 2. 工程归属与实例登记
- [x] 实现实例登记、正常关闭标记、原子启动占位及实际端口记录。
- [x] 实现工程组与工作上下文，唯一 writer、只读绑定和明确交接。
- [x] 将真实工程切换与旧上下文失效绑定；不把保存到新位置当成同一输出路径。
- [x] 实现公共工具参数包装及目标 host 的派发校验。
- [x] 同一主 AE 的完整任务有序执行，保留现有 JSX 超时锁与哨兵排空。
- [x] 不同工程执行队列互不阻塞。

### 3. 外部客户端与冷启动
- [x] 改造 stdio 全局请求队列，保留初始化顺序，允许不同实例请求重叠。
- [x] 每个目标维护独立的下游 MCP 会话，不将一个 host 的 session ID 用于另一个。
- [x] 连接器在 AE 未启动时提供发现/启动入口；不复制 AE 业务 handler。
- [x] 实现有界启动与就绪检查，不因启动慢、面板未开而反复创建 AE。
- [x] 验证新主 AE 自动打开正确 CEP 面板的链路；标准 stdio 从零启动两个主 AE，公开读取确认工程。
- [x] 保留 --url 显式直连；HTTP 客户端接入已存在的本机端点。
- [x] 同步现有 npm connector 的分发副本，不引入新安装器、后台服务或发布渠道。

### 4. 面板与现有执行面
- [x] 支持可用端口分配与实际端口回传，面板显示真实连接状态。
- [x] 面板会话携带工程上下文和明确工作目录。
- [x] 三 provider 使用所属实例端点；运行状态不再把端口当作工程身份。
- [x] 明确共享登录/库与实例/会话运行状态的边界，避免配置相互覆盖。
- [x] 关闭面板停止接入、停止新派发并收尾自建 worker，不自动复活。
- [x] 既有原生客户端选择所属 AE endpoint；无法确认时明确失败，不选第一个。
- [x] 不修改 .aex 或 23 个原生 primitive。

### 5. Checkpoint 与快照
- [x] 实现工程旁已有自动保存目录优先、会话 cwd 回落。
- [x] 保存成功和源路径未变是正常复制的前置条件。
- [x] metadata 支持外置 AEP；旧布局、recovery、list、revert 和清理仍正确。
- [x] 增加失败后针对当前任务的明确继续授权及来源标记。
- [x] 从固定 checkpoint 派生辅助读取输入；标记快照与当前工程的关系。
- [x] 活动快照不被留存清理删除；旧 checkpoint 不随客户端切换搬迁。

### 6. 只读任务与 Preview 限制
- [x] 实现无面板辅助 AE 的启动脚本、有限任务入口、就绪/结果协议。
- [x] 复用受维护的 read/preview 模板；禁止任意 JSX 与写入旁路。
- [x] 实现 ae_readJob 的提交、状态、分页结果、取消和逐项失败结果。
- [x] 预览必须固定合成和时间，不能依赖另一个实例的 activeItem。
- [x] 主 AE 与 worker 取帧不修改 Guide Layer 状态，不加切换参数。
- [x] 保留 saveFrameToPng 的 Guide 缺失实测，按用户最新决定记录为 accepted limitation，不以 Render 替代，也不把历史 FAIL 改成 PASS。
- [x] 结果注明原始快照和采样配置，主工程变化后不冒充实时结果。
- [x] 保留主实例直接 read/preview 路径与既有响应图片预算。

### 7. 资源、取消与清理
- [x] 启动中的实例也占资源名额，避免并发启动越过预算。
- [x] 统一预算计入启动占位并为主 AE 留余量；本机验证两个 worker 的启动、取消及退出。RAM 数值仍是入场估计，未作跨负载性能调优。
- [x] 整批读取结束回收自建 worker，不默认长期驻留。
- [x] 取消/超时/关闭主面板分别处理，不盲目重试未知写入。
- [x] 禁止关闭、覆盖、移动用户主工程；临时工程有任务归属及回收条件。

### 8. 审查、测试与真实 AE 验收
- [x] 修改后执行最低可证伪层的语法/定向测试。
- [x] 完成一次集中独立 diff 审查，修复当前验收路径 blocker。
- [x] 生成物与文档齐备后运行相关本地 T3；远程 CI 未运行，不自动推送。
- [x] 使用正式 Windows AE 26.5 与可重建 disposable fixture 完成本机诊断及状态核对。
- [x] 完成本地诊断矩阵并保留请求、结果、来源和真实 Undo；Guide 按 accepted limitation 处置，故障注入覆盖目录准备失败。
- [x] 汇总最终 disposition 与 .aep 创建、删除、归档数量；任务 AE 全部退出，活动 fixture 已清空。
- [ ] 正式 HDEV 的零证据预检、运行及交付证据门禁未在本轮宣称完成；远程 CI、PR、合并也尚未完成。
- [x] 用户已另行批准备份部署到现有 CEP 安装并进行本机诊断；推送、PR、合并和发布仍不在范围内。

## 公开 MCP 验收矩阵

| 场景 | 可观察通过条件 |
| --- | --- |
| 从零启动 | 标准 MCP 调用启动主 AE，正确面板就绪，首次 ae_read 返回目标工程 |
| 动态端口 | 默认端口被占用时仍接入正确实例，不碰占用该端口的其他服务 |
| 两工程 | 同一客户端/连接交错操作 A、B，不串工程；执行时间确实重叠 |
| 唯一 writer | 第二上下文默认只读；未交接写入在派发前失败；交接后旧资格失效 |
| 未知结果 | 超时后不创建第二主写实例、不盲目重试、不假装未发生 |
| 保存与路径 | 操作前保存包含当前修改；主 AE 始终指向原路径；checkpoint 可列出和定位 |
| 目录选择 | 已有自动保存目录和 cwd 回落都覆盖；工作目录缺失时不猜 |
| 失败继续 | 保存/复制失败有准确层级；仅明确当前任务授权后继续；来源不虚报 |
| 辅助只读 | 多 worker 读不同合成并返回快照来源；写类请求与脚本旁路被拒绝 |
| Guide Layer | 已接受限制：输出可能不含 Guide；取帧不改图层状态、不承诺与查看器完全一致；原像素断言 FAIL 保留并注明 accepted limitation |
| 快照新旧 | 主工程继续变化，旧结果仍标为旧快照；提交修改前确认当前前提 |
| 真实写/Undo | 受控主工程修改、状态读回、真实 Undo 与恢复状态一致 |
| 关闭/取消 | 不再派发；已派发状态核实；只回收自建 worker，不关闭用户主 AE |
| 兼容性 | 标准 stdio 与 HTTP 测试客户端不依赖 Codex 专用信息；既有单实例行为明确保留 |

fixture 生命周期：ephemeral-validation。一套确定性配方，主工程和 worker 副本均明确归属；
跨工程场景所需第二项目是同一 fixture 集合的受控组成，另记录数量，不使用生产项目。
证据：validationProfile=development，candidateRun=false，candidateEvidence=false。
实机平台：本机 Windows / 正式 AE 2026。其他既有平台保持代码兼容，不将未跑平台标成已验证。
AE 原生 primitive 不新增，native novelty=none。
任何已派发可能写入先核实再重试；主项目不自动归档，测试副本提取证据后进入可恢复归档。

## 预计范围与规模确认

以下保留最初的规模估算供范围追踪，不作为最终实数；最终为 71 个去重文件、约 5,500 手写行。

| 分类 | 预计文件数（去重后） | 预计手写行 | 状态 |
| --- | ---: | ---: | --- |
| 实现：host/connector/panel/JSX | 28–36 | 2,000–3,600 | 已实施，最终总量见收尾记录 |
| 单元/合同/集成测试 | 12–18 | 1,200–2,100 | 本地相关 T3 已完成 |
| 验收配方/runner | 1–2 | 100–200 | 本机诊断已完成 |
| 配置/schema 接线 | 1–2 | 50–150 | 已实施 |
| 文档 | 3–4 | 200–350 | 已更新 |
| 新 CI/安装/服务基础设施 | 0 | 0 | 明确不做 |
| 生成 bundle/vendor 同步 | 2–5 | 不计手写行，单独报告 | 已生成与同步 |
| 机械版本变更 | 0 | 0 | 本任务不发版 |

用户当前批准的整体边界：最多 74 个去重文件、7,000 行非生成手写新增/修改；超过后重新报告范围。该上限调整不授权已取消的 Guide 原生或 OS 截图路线。
主要接点：plugin/host/server.js、stdio-shim.js、native-aegp-client.js、mcp/{index,tools,session,
conversations,checkpoint-store,checkpoint-ops,recovery-store}.js；新增 instance-registry、
instance-launcher、workspace/router、read-jobs、worker-policy 和对应工具/测试；
plugin/panel/src/cep/hostBridge.js、三 provider、platform/paths、App/session 接线；
plugin/jsx 的主启动/worker 入口与既有模板；clients/ae-mcp-jkdg；现有文档与验收 runner。
所有实现共用一个分支/worktree，最多三个不重叠实施轨；共享接口由主控整合。

## 不包含的工作

独立桌面应用、常驻 broker、恢复旧 packages 服务端、新 provider、Guide 原生探针、OS 窗口截图、原生 primitive/codegen、
远程/多用户/配对、整套手动编辑版本系统、通用 AEP 合并、跨重启作业恢复、新 CI/runner 拓扑、
新安装器/更新渠道、自动推送/合并/发布、自动改动现有用户插件安装。

## 当前进度

当前状态为 `local-diagnostics-passed`。产品实现、公开接口接线及集中审查修复已落入本分支；
源 `05a35bfa436e9dbbd2a4944a57bb7fc2f3b9e9d3` 的本地相关 T3 共 1,281 项：1,188 通过、93 平台/权限跳过、0 失败。
后续 `remaining-matrix.json` 五项和 `panel-lifecycle-final.json` 四项均 PASS，具体范围与限制见下方最终收尾。
Guide 缺失为 accepted limitation，历史 FAIL 保留；目录准备失败的继续流程不冒充真实 AE 保存或复制中失败的覆盖。
远程 CI、PR、合并和正式 HDEV 尚未完成，不宣称 `development-verified` 或 `release-accepted`。
原工作区分支 codex/readme-sponsors，未跟踪 .codex/ 已保留。
源代码、测试及生成物位于隔离分支；生成物单独计数。用户已另行授权并完成本地 CEP 运行文件备份部署；未推送、合并或发布。

实施记录：已完成两轮集中审查。首轮相关 T3 共 1,264 项，1,168 通过、93 平台/权限跳过、3 项失败；失败分别为旧工具列表断言、旧面板回调断言及平台职责边界。修复已完成，修复集 T3 复跑共 1,265 项：1,172 通过、93 平台/权限跳过、0 失败。被测代码提交为 365b4dd；后续本文件只记录证据，不改变运行源码。用户已批准将文件上限调整为 70，手写行上限仍为 7,000。随后用户批准了现有安装的备份部署与可重建工程的本机诊断。


## 本机诊断记录（2026-09-29）

以下保留该轮当时的结果；后续 resolution 见“最终本地诊断收尾（2026-09-30）”。
该轮状态：`diagnostic-incomplete`，`validationProfile=development`，`candidateRun=false`，
`candidateEvidence=false`；这不是正式 HDEV 通过或 `development-verified`。
首次部署为 62ed86f 的 28 个运行文件，运行代码对应已完成本地 T3 的 365b4dd；
14 个已有文件已备份，14 个新增路径已登记。没有修改原生插件或 provider 凭据。

| 实测项 | 结果与限制 |
| --- | --- |
| 零 AE 的标准 stdio | PASS：initialize、16 工具、空实例列表；不等于 AE 冷启动通过。 |
| 自动打开 CEP 面板 | 修复后 PASS：CEP StartOn 事件替代菜单调用；标准 stdio 从零启动 A/B，无 GUI 介入，公开读取返回正确工程。 |
| 双工程路由与端口冲突 | PASS：A/B 使用两个 AE PID 和不同端点；B 写入不影响 A；两次 800 ms 探针的 AE 执行区间实测重叠 819 ms。 |
| 单 writer 与交接 | PASS：第二 writer 被拒绝；显式交接后旧 context 无法写入。 |
| 真实写入与 Undo | PASS：B 合成改名，公开读取确认，再实际 Undo 并读回原名。 |
| checkpoint | PASS：cwd 回落与相邻 Auto-Save 优先均实测；正常保存后复制，A 仍指向原工程。 |
| 多合成 worker | PASS：两项分别由 worker_index 0/1 执行；绿图像素正确，两个进程均退出。 |
| Guide Layer Preview | FAIL：主/辅 saveFrameToPng 的红色 Guide 位置均为黑；AE 读回 guideLayer/ enabled 为 true，没有修改这些状态。 |
| 关闭主面板 | PARTIAL：关闭 B 面板后端点拒绝连接且不自动重开；registry/ticket 未即时记录关闭，待 AE 退出才更新。不能声称即时 worker 取消已验收。 |
| 客户端断开与退出 | 修复后 PASS：Windows 主 AE detached，stdio 结束后仍运行，另一连接读回同一工程再 stop(refuse-dirty)；worker 仍非 detached。全部任务 AE 已退出。 |

诊断在同一可重建 fixture 集合中使用 A/B 两个项目。测试 runner 的失败分类、
完整分页结果检查和清理失败时的证据落盘缺口也归入本轮修复。该次诊断保留了 Guide 像素断言及其 FAIL；
后续验收按用户最新决定接受这一限制，不改写原始证据。
每个案例、公开请求/结果、Undo 和状态核实保存于本地 validation root；
`evidence/defect-ledger.json` 是机器可读总账，`evidence/tool-summary.json` 汇总每个公开工具；
原始 `evidence.json`、`supplement-evidence.json`、`exit-evidence.json` 随 fixture 移入
`recovery/20260929-multi-instance/`。`evidence/cold-start-recheck.json`、
`detach-reconnect.json`、`viewer-observation.json` 保存窄复验。此处不提交机器私有路径。

Guide 缺失是原验收条件下的真实失败，原始记录与上表 FAIL 保持不变。用户随后明确接受
该限制，当前 disposition 为 `accepted limitation`，不再作为本包阻断；这不代表已实现
包含 Guide 的取帧。冻结的 23 个 primitive 不变，不以 Render Queue、隐式关闭 guideLayer
或临时改图层可见性绕过。未实施的原生取帧探针和窗口截图研究已取消。


### 首次诊断收尾与当时限制（历史记录）

该次本机诊断收尾时实际去重 70 文件，手写增删约 5,300 行，仍在批准的 7,000 行内。
实现 38 文件、单元/合同测试 24、实机配方 1、配置 1、文档 3、生成物 3；
新 CI/基础设施 0、机械版本变更 0。该次收尾的上述文件均已本地提交；当时没有遗留 staged 或 untracked 产品文件。

- 正式 AE 为 Windows 26.5；两个 primary 从零启动和重连均通过标准 MCP，未用 Codex 专用字段。
- 两个已复现启动/lifetime 阻断各做一次窄修复复验，没有重新跑完整硬件矩阵。
  最终定向测试 29 项：28 通过、1 Windows 符号链接权限跳过；runner 语法/help、XML、bundle 与 diff 检查通过。
- 主 AE 查看器现场可见红 Guide 与蓝内容；同期公开 PNG 的 Guide 点为 `[0,0,0]`，内容点为 `[0,0,255]`。
  不把取到图像等同于 Guide Preview 验收通过，也未改变 Guide 显示选项。
- `.aep` 共创建 6 份（A/B、2 checkpoint、2 worker 临时复制）；worker 已删除自己的 2 份，4 份移入短期可恢复归档。
  canonical 保留 0、evidence-snapshot 保留 0、未分类 0；逻辑移动 665,062 字节，同卷移动释放物理空间 0。
  归档可在诊断审阅后且 2026-10-06 之后清理；未创建自动删除任务。
- 原版与两次修复部署均有备份/收据。现有 CEP 保留该开发构建；原生插件未改。
  关闭面板的即时 registry/ticket 更新、worker 取消、未知写入、保存失败继续等剩余硬件矩阵未标成通过。
- Windows 首次 stdio 退出连带关闭 AE 时留下本任务隔离状态根的 registry.lock；确认所有 PID 消失、记录均 closed 后，
  手动将该锁归档。修复后正常 stop 与独立重连通过；没有添加按时间抢锁或跨重启恢复机制。

### 用户最新决定与 keep/drop（2026-09-29）

用户明确接受 Guide Layer 可能不出现在预览中。保留现有 `saveFrameToPng`，由用户或模型
在预览前显式准备所需状态，取帧本身不自动调整 Guide 或图层可见性。
即使 `enabled=true`，只要仍为 `guideLayer=true`，也不能承诺该层会进入 PNG；
模型不能仅凭 PNG 缺失就断言 Guide 图层被关闭或删除。

| 处置 | 内容 |
| --- | --- |
| Keep | 多工程主实例、单 writer、显式工作上下文、多合成只读 worker、checkpoint 与现有 Preview 路径。 |
| Keep | 原始 Guide 实测 FAIL、像素证据及未修改图层状态的读回；单独记录 accepted limitation，不改写 PASS。 |
| Drop | 尚未实施的原生 Guide 探针及相关 SDK、构建、AEX 替换/重启验证提案；不新增原生能力，不运行 codegen。 |
| Drop | OS 窗口截图研究与作为 Preview 后备实现的路线。 |

此前“待授权”原生提案已撤销，未创建探针源文件、未构建或部署原生探针。
本包文件上限调整为 **74 个去重文件**，非生成手写新增/修改上限仍为 **7,000 行**。
后续工作继续完成保留范围内的修复与验收，不把这个规模调整解释为恢复已取消路线的授权。

## 最终本地诊断收尾（2026-09-30）

状态：`local-diagnostics-passed`，`validationProfile=development`，`candidateRun=false`，
`candidateEvidence=false`。这是本地诊断结果，不代替正式 HDEV、远程 CI、PR 或合并门禁，
也不是 `development-verified` 或 `release-accepted`。
被测源为 `05a35bfa436e9dbbd2a4944a57bb7fc2f3b9e9d3`；相应本地 T3 为
1,281 项、1,188 PASS、93 平台/权限跳过、0 FAIL。跳过项不算通过。
`evidence/installed-final-receipt.json` 核对本包 **30 个变更运行文件**与被测源一致，
`nativeChanged=false`；范围仅为变更运行文件，不是完整发布 payload 身份验收。
此前的部署收据另存为 `installed-receipt-before-lifecycle.json`，保留历史来源。

`evidence/remaining-matrix.json` 的五项公开 MCP 诊断均 PASS：

| 场景 | 观察到的结果 |
| --- | --- |
| 只读任务拒写 | 写类请求在 worker 派发前被拒绝。 |
| 固定快照 | 主工程发生变化后，worker 仍读取指定旧快照并保留来源。 |
| 取消与回收 | 取消停止后续读取派发，并确认 worker 进程退出。 |
| 失败后的明确继续 | checkpoint 目录准备故障阻止编辑；必须引用该次 failure id 明确继续，授权只消费一次。故障发生在目录准备阶段，不是 AE 原工程保存失败，也不是复制执行中失败。 |
| 未知写入 | 结果未知时禁止重放；读取实际状态、引用观测并明确 reconcile 后才恢复写入。 |

GUI 恢复后，`evidence/panel-lifecycle-final.json` 的四项均 PASS：

| 场景 | 观察到的结果 |
| --- | --- |
| 当前 fixture 与快照 | 公开读取当前工程，并成功生成本次固定快照。 |
| 关闭主面板 | 两个已启动 worker 的 PID 均退出，主 AE 仍以同一 PID 存活；旧上下文被拒绝，重复启动同工程返回 `PROJECT_OCCUPIED`，占用没有被释放。 |
| 手动重开同一 AE | GUI 手动重开面板，AE PID 不变，实例及 context 均为新身份；旧 context 继续被拒绝。 |
| 明确退出 | 公开 stop 确认主 AE 退出并释放工程，没有遗留 registry.lock。 |

这些复验解决了上方“关闭主面板 PARTIAL”等生命周期缺口；原始表格与原始证据保留当时状态。
Guide 的处理是用户接受限制，并非修复后通过：红色 Guide 点为黑的历史 FAIL 仍保留。
仍使用 `saveFrameToPng`，不自动修改 Guide 状态，不进行已撤销的原生或 OS 截图研究。

最终范围为 **71 个去重文件、约 5,500 行非生成手写新增/修改**，在 **74 文件 / 7,000 行**
批准上限内；生成物仍单独计数。无新 CI/服务基础设施、无机械版本变更，原生插件未修改。
运行代码源为上述本地提交；本次文档收尾由后续文档提交记录，未推送、创建 PR、合并或发布。

最终 fixture 账本为 `evidence/fixture-lifecycle.json`，使用同一确定性配方，生命周期为 `ephemeral-validation`：

- 累计创建 `.aep` **16 份**；正常 worker 已删除自己的 **7 份**副本，剩余 **9 份**已归档，其中包含 **2 份中断 worker 副本**。
- canonical 保留 **0**、evidence-snapshot 保留 **0**、未分类 **0**；活动 fixture 已清空，收尾核对任务 AE 进程为 **0**。
- 最终可恢复归档为 `recovery/20260930-multi-instance-final/`，逻辑移动 **1,502,451 字节**；同卷归档移动释放物理空间 **0**。已删除副本的释放空间未单独计量。
- 归档在审阅完成且 **2026-10-07** 之后可清理，未创建自动删除任务；没有移动或覆盖用户生产工程。

早期的 6 份项目与 70 文件数字属于首次诊断历史，最终累计数字以上述账本和收尾范围为准，不重复相加。


## 提交分支与 macOS 交接准备（2026-09-30）

用户授权继续完成 Windows 侧准备、提交本功能分支并交接给 macOS 实机验证。
原来的“不自动推送”边界在本功能分支上已获得明确更新；不合并 main、不打发布 tag、不发布。
现有 CI 只对 main push / PR 触发，因此使用草稿 PR 跑既有流程，不新增 CI 工作流。
CI 当前结果以该 PR 的检查记录为准；macOS packaging job 不能代替真实 AE 验证。

- 已补齐简体中文 `自动保存` 目录识别。英文目录优先；不存在匹配目录时才回落会话工作目录。
  没有猜测其他本地化名字，也没有读取自定义自动保存设置或搬迁历史 checkpoint。
- 真实文件系统合同覆盖中文目录、英文/中文并存、同名文件阻挡及回落。
- Windows 公开 MCP 实测：只有中文目录可用时，checkpoint 落在其 `ae-mcp/checkpoints` 子目录，
  主 AE 工程路径保持原位，普通内容读回正确，随后正常退出。
- 此补测首次被 AE 的“上次会话发生崩溃”提示阻塞，尚未执行 checkpoint；
  选择 Continue 保留首选项后，在同一实例恢复并通过。没有据此认定是哪一个组件导致此前异常退出。
- 最新本地回归包括 host 407、panel 685、connector/package 193、冻结协议 9 项：
  合计 1,294 项，1,201 PASS、93 平台/权限跳过、0 FAIL；bundle freshness 通过。
- 发布检查发现旧构建产物含本机绝对依赖路径。改用本 checkout 的现有依赖副本重建后路径已消除；
  未公开历史保留本地可恢复 Git bundle 后整理，避免旧路径仍随历史 blob 推送。
  先前 Windows 记录中的短 SHA 保留为本地诊断标识，不作为 Mac 可 checkout 的远端提交。
- 中文补测再生成 1 份 checkpoint；最终累计 AEP 17，7 份正常 worker 副本已删除，10 份归档。
  归档逻辑字节 1,669,618；仍有 2 份面板中断 worker 副本在归档中，活动 fixture/任务 AE 均为 0。

当前仅支持 Apple Silicon 原生 darwin-arm64。下一阶段按交接文档核实 Mac 的 `-m -r`、
CEP StartOn、AE PID 父链、worker 在父 CEP 退出后的生命周期与实际状态根继承。
Windows 和模拟测试结果不提前记成 macOS PASS。
