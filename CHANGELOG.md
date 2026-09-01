# 更新日志 / What's New

让 AI 操控 After Effects 更稳、更顺、更省心。
Making AI-driven After Effects more reliable, smoother, and worry-free.

格式参考 [Keep a Changelog](https://keepachangelog.com/)，版本遵循 [语义化版本](https://semver.org/)。
Format based on Keep a Changelog; versioning follows SemVer.

---

## 中文

### Unreleased

- **内置模型清单换到当前一代**——Claude 通道可选模型改为 Fable 5.1、Opus 5、Sonnet 5、Haiku 4.5，默认 Opus 5；id 统一使用不带日期后缀的官方别名，价格档位随之更新（Sonnet 5 降到 $2/$10）。Codex 通道的离线回退清单对齐 codex-cli 0.144.1 的 `model/list`（默认 GPT-5.6-Sol，并标注支持 fast 档的模型），实时清单仍然优先。设置页的默认模型下拉不再自带一份过期的硬编码列表。注意：Fable 5.1 需要 Claude Code ≥ 2.1.251，更旧的 CLI 会在回合里返回带版本要求的 400 提示，切换模型或执行 `claude update` 即可。

### [0.10.5] — 2026-08-28

- **新增 `ae-mcp-jkdg` npm 连接器与官方 MCP Registry 清单**——Claude Desktop 等仅支持 stdio 的客户端可通过 `npx -y ae-mcp-jkdg` 连接本机 AE 面板；连接器与产品 major.minor 配对，扩展本体仍须从 GitHub Releases 单独安装。
- **面板不可达时给出可执行修复提示**——stdio 连接失败会直接提醒安装 ae-mcp 扩展并保持 After Effects 面板打开，不再只返回底层网络错误。
- **接入文档更准确**——README 新增 Glama 徽章和 npx 接入方式，并清理已退役的 `ae_ping`、`ae_snapshot` 工具名。
- **测试套件不再读写你的真实 `~/.ae-mcp`（#330）**——宿主状态目录统一经可注入的 `AE_MCP_STATE_DIR` 解析（保留 `AE_MCP_HOME` 兼容与 `AE_MCP_LOG_DIR`/`AE_MCP_TOOL_DIR`/`AE_MCP_SKILL_DIR` 细粒度覆盖），全部集成测试改用临时目录。此前开发机面板留下的黑名单等状态能让套件莫名必败，跑测试也可能反过来污染真实用户目录。
- **OpenCode 不再抱着重启前的死连接（#333）**——面板每次启动生成宿主代次并写入实例标记，跨代次的常驻 OpenCode 实例会被回收重建；回合中识别 `-32000 Connection closed`/`Not connected` 类传输失败后自动重建并重试一次，仍失败则给出「重载面板或新建会话」的明确指引。此前面板重载后 ae 工具会整组静默消失，重启 AE 也未必自愈。
- **「文档 / GitHub」按钮真的能打开了（#334）**——外链统一走三级回退（CEP → CSInterface → 宿主代开），全部失败时面板给出可见提示；文档地址按面板语言路由，中英链接后续可独立更新。
- **成功执行的脚本自动留底，上下文被压缩后可一键重跑（#338）**——`ae_exec`/`ae_execRecover` 成功后把脚本自动存入 Tool Library 成为 candidate（同内容去重、已沉淀内容不重复建、不进默认搜索列表）；执行信封新增 `artifactId`；占位符守卫拒绝时直接列出本会话最近可重跑条目和 `ae_toolUse {"name":"<id>"}` 用法，对话历史被压缩也不再丢脚本。留底自动清理（7 天 / 每会话 20 条 / 全局 200 条），捕获失败绝不影响执行结果本身。
- **占位符连环重试有了断路器和数字（#339）**——同一会话连续第 2 次占位符拒绝起，错误换成更短更硬、只留一条出路的升级文案并标注连败次数；每次拒绝记入活动日志（`placeholder_rejected` + 连败数 + 脚本摘要），诊断导出能回答"这错到底发生了多少次"。守卫匹配从两句硬编码短语升级为"精确 marker + 形状×词族双门启发式"，客户端换措辞也拦得住，并有防误伤回归矩阵保证正常脚本不被误拒。
- **Tool Library 有了第一个写动词 `ae_toolSave`（#344，工具面 12→13）**——一个动词四种用法：把捕获的 candidate 沉淀为正式工具（可改名/描述/标签，沉淀后进入默认搜索）、直接新建 `jsx`/`prompt-skill` 工件、更新已有用户工件（revision 递增）、管理状态（saved/pinned/archived/deprecated，禁止回退 candidate）。bundled 与 legacy 工件保持只读；每次写入走审批卡（含操作类别与内容摘要），审批等待期间工件被改动会拒绝覆盖，入库前照常做密钥扫描。
- **用户 skill 统一进库（#340）**——`ae_toolSave` 创建的 prompt-skill（saved/pinned）现进入 `ae_skillUse` 的列表与解析（支持按名与精确 id，条目标注来源），重名优先级固定为 库 > legacy 用户目录 > 内置；审批改为绑定工件 id 与内容哈希，内容修订后旧审批立即失效；prompt-skill 保持仅渲染（执行请求给出明确错误）；legacy 目录继续只读兼容、不迁移。
- **工具库能分发了：导出 / 导入 + 面板管理页（#341）**——saved/pinned 工具可导出为自包含 JSON（host 落盘到状态根 `exports/`，面板显示完整路径可复制）；导入走内容哈希防篡改校验、密钥扫描与重复检测，落库标记 `imported` 来源且默认不受信任；工具页提供「工具库」管理区：候选与已保存双列表，沉淀 / 置顶 / 归档 / 恢复 / 删除 / 一键清空候选 / 粘贴或选文件导入，全部操作走与 `/exec` 同级的令牌鉴权路由。构建侧新增 bundled 清单生成器脚本（导出件或库工件 → 内置 skill 格式 + manifest SHA-256 更新，带 dry-run）。
- **库有了使用数字，动词学会推销自己（#342）**——`ae_toolUse`/`ae_skillUse` 成功后记录 `lastUsedAt` 与新增的 `useCount`（存量库自动兼容，绝不误报损坏）；活动日志新增使用与沉淀漏斗事件（use/render/promote/create/update/status + 工件 id），诊断能回答"多少候选被重放、多少被沉淀、哪些工具在吃灰"；四个库动词的描述改为工作流导向，服务器指引与内置 ae-execution-guide 同步加入「重复操作先搜库 → 命中即重放 → 值得留就沉淀」路径。

### [0.10.3] — 2026-08-26

- **OpenCode 静默回合有了停顿看门狗（#327）**——provider 长时间无输出、无工具活动时，回合会被明确终止并给出原因，不再无限显示"生成中"。正常的长任务不受影响：只要模型仍在推进（哪怕几分钟不吐字），回合照常继续。
- **`ae_nativeExec` 不再返回恒为 false 的 `undo.verified` 字段（#310）**——该字段承诺的验证从未实现，返回它只会误导调用方；现从协议中移除，文档同步更新。
- **ZXP 内置 OpenCode，全新安装开箱即有可用通道（#321）**——Windows 发布包随附经 SHA-256 校验的官方 OpenCode 可执行文件，面板自动优先使用内置版本（显式环境变量覆盖仍然最高优先），不再要求用户自行安装任何 CLI。构建期由钉版拉取脚本获取产物，正式构建缺产物会直接失败而不是悄悄发出不完整的包。
- **登录不再需要终端**——Claude 通道新增「打开登录窗口」按钮（登录后本页自动刷新）；Codex 通道新增「一键登录」：面板在隔离环境里代跑登录、自动帮你打开浏览器验证页，失败时才回退为可复制命令。所有修复提示不再出现"请在终端运行 X"式的裸指令。
- **向导一键安装 Claude Code**——首启向导可直接代跑 Anthropic 官方安装器（明确标注来源），装完点重新检测即可识别；另提供可选的「加入系统 PATH」按钮（免管理员、保留原有 PATH 变量类型、不用会截断 PATH 的 setx），方便你在自己的终端里也能使用。
- **全新安装默认使用 OpenCode Provider 通道**——三个通道中唯一无需 CLI 登录的一个；已有用户的选择保持不变。
- **AI 回复不再被工具卡撕成两截（#322）**——三条通道统一在插入工具、审批、提问卡片之前先把已生成的文字完整落屏。此前配置了 API Key 时，最后几十个字符会被扣在防泄漏缓冲里，等你答完问题才出现在卡片下面，甚至把一个单词拆成两半。
- **AE 开着也能装好 CLI（#321）**——Windows 上「重新检测」现在会重读注册表里的用户/系统 PATH，并认识 Claude 官方安装器（`~\.local\bin`）、scoop、OpenCode 官方安装器的默认位置。装完 CLI 直接点重新检测即可，不必重启 After Effects。
- **智能体不再被自己的历史带进死循环（#323）**——修复一起真实事故：为省 token 而脱敏的历史脚本占位符被模型当成代码原样发回，先是执行一句注释永远失败，重试时还会把存档的恢复脚本覆写掉，单个任务连败四十余次。现在主机直接拦下占位符并明确告知重写完整脚本，恢复存档不再会被覆写；占位符文本也改为自带「不要把这句注释当代码发回」的指令。
- **报错终于带上修复提示（#323）**——错误提示此前只在「脚本跑完但没返回值」的旁路上生效，真正抛 ExtendScript 异常时从未附带；现已修复,并新增滑块 ±100 万上限、颜色数组、失效对象、NO_VALUE 属性组四条实战提示。返回值约定（最后一条语句必须是裸表达式）与 `ae_previewFrame` 参数冲突的报错现在会直接给出正确写法示例。
- **诊断包能还原真实故障了（#323）**——活动日志新增工具名、调用通道、客户端归因；失败时记录脚本摘要与命中的提示；宿主执行成功但被判失败的调用（如返回 undefined）不再伪装成成功；skill 调用留痕；导出包合并历史进程的错误。OpenCode 内建工具（read/apply_patch 等）在界面与导出中不再被误标为 `mcp__ae__` 前缀（#324）。

### [0.10.2] — 2026-08-23

- **失败恢复从 `ae_exec` 中拆出**——恢复操作改由独立的 `ae_execRecover` 接收 `recoveryId` 与可选修正脚本，`ae_exec` 只接受正常脚本执行参数，避免模型把恢复编号误当脚本内容。本项把公开工具从 11 个增加到 12 个。旧的 `ae_exec({recoveryId})` 调用方式不再受理，会返回一条指明改用 `ae_execRecover` 的错误；不提供兼容垫片——在同一个 schema 里并列两个可选字段正是这次要消除的歧义来源。
- **OpenCode 自定义模型可按模型设置上下文窗口**——Provider 管理器为每个模型提供 32K / 64K / 128K（推荐）/ 200K 与自定义数值；旧配置自动沿用 128K。面板拒绝小于 32K 或大于 2M 的值，并按窗口自动预留合理的回复空间，避免把 32K 模型同时声明成 32K 输出而导致每轮都压缩。填大不会增加模型真实能力，界面明确提示过大可能来不及压缩、过小会更频繁压缩。
- **Luna 的属性读取不再被本地拒绝**——`ae_read` 现在接受按属性完整路径排序；Luna 在真实长会话里生成这种合法请求时，可以直接读取而不会在到达 AE 前失败。
- **低档模型的脚本返回要求更明确**——主机现在明确区分普通脚本末尾的结果与函数包装内必须 `return` 的结果，减少“AE 已执行、面板却只能判失败”的可避免恢复流程。
- **审批卡会真正显示，档位与当前会话一致**——手动档下每个写操作都会弹出审批卡，并可展开查看真实调用参数。审批身份改用被调工具自身的名字（恢复操作显示为 `ae_execRecover` 而不是 `ae_exec`）；授权绑定的内容指纹按完整调用计算，而不是卡片上那段 200 字预览，避免前缀相同的两个脚本被当成同一次已授权操作。用户取消、审批对话框不可用、审批超时、明确拒绝现在是四条不同的提示，不再一律显示为「用户拒绝」。
- **长任务持续显示进度，运行中切换会话会先确认**——回合运行期间持续显示已用时长与预计 token。任务尚未结束时新建或切换会话会先弹出确认框：「取消」让当前任务继续跑完，「停止并继续」才停止当前任务并切换，不再静默中断。
- **OpenCode 失败后会话仍然可用**——provider 或 socket 失败会保留真实失败原因，并允许在同一个会话里重试，而不是让会话卡在永久忙碌状态。（issue 里要求的「自动一次性重试 / 退避」尚未实现。）
- **OpenCode 长会话的请求不再膨胀**——发送前会精简历史里已经执行过的旧脚本正文；工具结果与 AE 回读保持不变，主要缓解第 6、7 轮之后的请求体积增长。代价是模型无法引用旧脚本原文，除非重新提供。
- **中文跨数据块不再乱码**——Claude、Codex、OpenCode 三条通道的分块输出统一按完整 UTF-8 边界解码。

### [0.10.1] — 2026-08-23

#### ✨ 新增

- **Provider 管理器一键探测模型（#306）**——填好 Base URL 与 API Key 后，「探测模型」按钮对 `<baseURL>/v1/models` 发一次请求（Anthropic 方言用 `x-api-key` + `anthropic-version`，OpenAI 兼容方言用 `Authorization: Bearer`），把返回的模型 id 去重后追加到已填内容之后。请求由 CEP 的 Node 侧发出——面板是 `file://` 页面而 provider 主机不给 CORS 头，浏览器 `fetch` 走不通；`http://` 需显式确认，所有可见错误按 key 脱敏。Phase 3 拆除 legacy provider 机制时一并删掉的模型发现能力就此补回。
- **`ae_previewFrame` 区间拼图与 A/B 像素差分**——新增 `range:{start,end,count}` 等距采样、`layout:'grid'` 带时间码对比表，以及可引用本次时刻或最近 50 次进程内捕获的 `compare`；差分返回热力图、并排图、变化比例 / 像素数 / 均值 / 最大差值与外接框，所有合成、重采样和缩放均由 CEP 宿主的零依赖 PNG 路径完成，不依赖 Chromium canvas。
- **`ae_exec` 失败恢复信封与快照差分归因**——已派发的脚本失败时会把可编辑 `.jsx` 与元数据写入 `~/.ae-mcp/checkpoints/<project>/recovery/`，返回 `recoveryId`、绝对 `scriptPath`、`errorLine`、对应的 `errorSource`、`$.writeln` 输出、工程 revision 前后值，以及通过失败前后快照识别新增 / 删除 / 改动图层和工程项的有上限 `touched`；改文件或内联传入修正后的 `code` 后用 `ae_exec({recoveryId})` 重跑，默认先还原到本次失败前由 `checkpoint_label` 创建的 checkpoint，`retryMode:'continue'` 可明确保留当前失败状态。`$.writeln` 捕获每次调用安装并在 `finally` 拆除；旧 `/exec` HTTP 路由不开 diagnostics，形状不变。
- **面板会话管理（#231）**——内嵌聊天现可新建会话、搜索和按最近活动查看历史、切换后恢复完整转录与真实后端上下文（Codex 持久 thread、Claude `--resume`、OpenCode session）、改名、归档 / 还原并经二次确认永久删除；本地索引与转录原子保存于 `~/.ae-mcp/sessions`。面板重载或 AE 重启后只恢复已落盘历史，审批 / 提问等中断状态会取消，绝不自动续跑进行中的回合。删除会话会同步清理本地文件并 best-effort 删除 Codex / OpenCode 后端会话；Claude CLI 没有对应删除 API，因此不会删除其自管会话文件。
- **可用于排障的诊断包**——设置里的「导出日志」现在真正持久化面板与 CEP 宿主事件（`~/.ae-mcp/logs/host-YYYY-MM-DD.jsonl`，面板重载后仍可导出），导出包按段独立容错并全段脱敏：环境（AE/CEP/OS/Node/Chromium）、现跑一次的 diagnostics、`/exec` `/native/*` activity、宿主日志内存与磁盘尾部、面板日志、claude/codex/opencode 后端 stderr、Python server 日志（新增 `server-YYYY-MM-DD.log` 文件日志，含启动信息）以及 `previewFrame` 的 comp PNG / viewer 回落分支统计（Phase 0 §6.3 取证）。
- **实验性 CEP 内嵌 MCP Streamable HTTP spike（#261）**——宿主新增本机免口令 `/mcp`（Origin/Host 白名单）的 `ae_status` / `ae_exec` 最小闭环、会话 SSE 与长调用 progress 通知，`ae_exec` 与 `/exec` 共用同一条执行链；用真实 31 秒调用的 Node 15（CEP 11 同级）CI 门槛验证。**尚未接入 approval gate，不应视为完整迁移或发布承诺**。
- **Phase 1 批 1：CEP 内嵌 MCP server 长出完整执行语义与读工具（#261 / #264）**——仍是实验性、面板内开关切换前不对外承诺。①**每会话配置**：面板可为每个对话开独立的 `/mcp/c/<token>` 入口，外部客户端走默认「外部」策略；`ae_exec` 接入**审批门**（逐字移植 Python 动词门的语义与决策记录，`readonly/manual/auto/none` 四档；待批项走进程内队列供面板弹卡）、**best-effort 自动 checkpoint**（checkpoint 存储整体移植，`AE_MCP_HOME/checkpoints`、按工程路径分组、`AE_MCP_CHECKPOINT_KEEP`）与 Python 一致的 JSX 结果解析和错误提示。②`ae_status` 吸收 `ping` / `diagnose`（`depth` 参数）；新增 `ae_previewFrame`——只走 `saveFrameToPng`，PNG 完成轮询、回报真实写出尺寸、`scale`、多帧预算、MCP image content，零依赖 PNG 子集解码；不再有查看器截屏回落。③**新工具 `ae_read`**：工程 / 合成 / 图层 / 属性 / 关键帧 / 合成设置的分页 + 排序 + 过滤结构化读取（JSX 反射，输出形状对齐 native 读 primitive，绝不 checkpoint、绝不开 undo group）。
- **Phase 1 批 2：面板可切到 CEP 内嵌 MCP server，工具面补齐到 8 个（#261 / #264）**——仍是实验性开关，默认不变。①**面板接线**：设置 → 连接 → 「MCP server engine」可选 `CEP host（实验性）`；该模式下每个聊天会话自动在宿主注册独立 conversation（审批芯片 / 专家指导即时生效），内置 codex / opencode / claude 三个后端的 MCP 改走 `http://127.0.0.1:<port>/mcp/c/<token>`，宿主审批弹成现有审批卡，外部客户端页显示 HTTP 接法；Tool Library 与工具搜索仍走 Python。②`ae_checkpoint`（create / list）、`ae_revert`（同目录原子替换 + 重开，失败分支带 `stage`）、`ae_validateExpressions` 移植到宿主；`initialize.instructions` 按会话的专家指导开关给出；新增仓库内真机验收套件 `npm run test:live-mcp`。③**`ae_nativeExec` 进宿主**：走进程内 native AEGP 客户端，生成契约校验、请求 / 后置摘要、结果 11 项核对与 Python 逐字对齐（canonical JSON 已与 Python 交叉核对），零依赖 JSON Schema 子集校验器对生成契约之外的关键字 fail-closed；`native_exec.generated.json` 作为 ESM 生成物的 CJS 孪生随仓库提交。宿主 `tools/list` 现为 `ae_status, ae_exec, ae_previewFrame, ae_read, ae_checkpoint, ae_revert, ae_validateExpressions, ae_nativeExec`。
- **Phase 2 批 1：宿主工具面补齐到 11 个、客户端身份改按 MCP session、claude 后端换 CLI（#262 / #264）**——①**Tool Library 进宿主**：`ae_toolSearch`（吸收 `toolIndex` / `toolInspect`：无参=列表、`query`=搜索、`name`=单工件详情）、`ae_toolUse`（执行已存 JSX 工具，`plan_hash` 在审批消费与派发前两处独立校验，防「授权后改内容重放」）、`ae_skillUse`（吸收 `skillList`；`execute=true` 保持 #269 透传形状）；磁盘布局与 Python 时代 `~/.ae-mcp` 完全兼容（对真实 32 工件存储只读验证通过），8 个内置技能随插件目录打包（与 Python 侧逐字节一致）。②**`/mcp` 客户端身份 = `initialize.clientInfo` + session id**：kill switch 与按客户端阻断改在每次 `tools/call` 前判定并返回结构化 JSON-RPC 错误（`ACTIONS_PAUSED` / `CLIENT_BLOCKED`），被阻断客户端的新 `initialize` 直接拒绝，阻断名单原子持久化到 `~/.ae-mcp/blocked-clients.json`（损坏时 fail-open 并记宿主日志）；设置页新增「活动 MCP 会话」（来源 / 版本 / 最近活跃 / 阻断开关）；旧 `/exec` 的 `x-ae-mcp-client` 语义不变。③**外部客户端**：Claude Desktop 经零依赖 stdio→HTTP shim 接入（跑在系统 Node；单行请求失败回 JSON-RPC 错误、队列不掉）；Claude Code / Cursor 保持 URL-only。④**claude 面板后端换 CLI 二进制（§2.2，决策 8）**：不再经 Agent SDK sidecar 进程，改为每个聊天会话直连一个用户机器上的 `claude` CLI 2.x（stream-json；`--permission-prompt-tool stdio` 把每次工具调用路由进面板现有四档审批门，AskUserQuestion 走同一控制通道回到问题表单；换模型/效率/附件用 `--resume <session_id>` 重启进程保上下文；`--strict-mcp-config` + 空 `--setting-sources` 隔离，不继承用户全局 MCP）；Windows 下把 npm `.cmd` shim 严格解析到包内原生 `claude.exe`（支持 `AE_MCP_CLAUDE_CLI` 覆盖）；订阅探针改为 `claude auth status --json`，未安装/过旧给出引导。协议形状全部对照 CLI 2.1.227 真实 wire 转录实测；`plugin/sidecar/` 留树休眠，删除清扫在下一批。
- **Phase 2 批 2：面板全面切换到 CEP 宿主、删除 platform-helper、自定义 Provider 改走 OpenCode（#262 / #263）**——①**面板脱 Python**：MCP 引擎开关删除（内置 claude / codex / opencode 后端一律经每会话 `/mcp/c/<token>`），Tools UI / Tool Library 客户端改为宿主进程内调用（HTTP 回落）并适配 11 工具折叠面；向导重写为「宿主自检 → AI CLI 检测 → 外部客户端接入」，系统 Node 只作为 Claude Desktop shim 的可选依赖。②**platform-helper 全删（约 -19k 行）**：原生树、宿主客户端/传输/注册、面板修复链、打包与嵌套签名接线、professional CI 随之移除。③**自定义 Provider 改写 OpenCode 配置**（决策 7）：「填 Base URL + API Key」前端保留，key 原子 merge 进 OpenCode 自己的 `auth.json`（既有条目保留、0600），provider 定义由面板注入内嵌 OpenCode 配置（`@ai-sdk` loader 已实测内置于 OpenCode 二进制、无运行时拉包；HTTPS 强制、明确确认才允许 HTTP）；旧 helper 存储的 provider 不迁移，UI 标记「需重填 key」；claude / codex 的自定义 API 通道下线，OpenCode 成为 Provider 聊天通道（写操作由宿主会话审批门把关）。**THREAT_MODEL 相应改写：provider 凭据改由各 CLI 自己的存储持有，是有意的安全边界调整**。④**Python / sidecar / 运行时载荷退役（收官清扫，约 -115k 行）**：`packages/`（core / bridge / snapshot-mss）、`plugin/sidecar/`、RuntimeManager 与 portable runtime、runtime BOM/evidence、sidecar staging 全部删除；宿主移除 Python 桥接跟踪（`/health` 不再有 `pythonVersion`）；CI 收敛为纯 Node 三 job（Windows JS+契约、CEP 11 同级引擎、macOS 打包契约），workflows 内 python 命中为 0；**ZXP 改为 direct payload 一次签名**（面板 dist + 宿主 + jsx + shared + generated/skills + 可选 .aex），打包器拒绝 ≥20 MB 产物（本批实测 staging 约 7 MB，旧包 87 MB）；README / 安装文档双语重写为两条接入路径——Claude Code 一条 `/mcp` URL、Claude Desktop 系统 Node shim。`uv tool install ae-mcp` 旧启动器随 Python 一并退场，不做兼容承诺。

#### 🐛 修复 / 改进

- **首跑向导的「连接外部客户端」改成一段可复制的提示词**——原来要先在 Claude Desktop / Claude Code / Cursor 三者里单选，再照抄对应的配置块，每支持一个新客户端就多一份配置要维护，用户拿到 JSON 后还得自己判断该放进哪个文件。现在只给一段话，粘给你正在用的 AI 客户端，由它自己完成 MCP 注册；提示词里的地址与 stdio shim 路径取自**本次安装的真实端口与扩展目录**，不是占位符。下方保留一行裸 URL 作为手工出口，可选的系统 Node 检测改为常驻（只有 Claude Desktop 这类只支持 stdio 的客户端需要）。设置页的逐客户端配置作为高级入口保持不变。
- **OpenCode 子进程生命周期闭环**——面板卸载时显式终止全部聊天后端；OpenCode 改用固定的工作目录与配置目录（`~/.ae-mcp/opencode/`），不再每次启动都在临时目录生成一套 60 MB 的依赖、也不再泄漏目录；实例写入带 PID 的所有权标记，启动前核对进程映像名后回收上一个面板上下文留下的孤儿实例（PID 被系统复用或属于另一个仍在运行的 AE 实例时不终止），旧版本遗留的临时目录由异步、有界的清扫逐步删除。启动流程新增代际守卫，重置期间仍在进行的旧启动会被取消并终止其进程，启动中进程崩溃立即失败；账户探针有 40 秒总期限和可中止请求，卡住超过宽限期后可从设置页重置并重新检测。就绪轮询的每次 `/mcp` 请求带独立超时：opencode 刚绑定端口、尚未开始处理时到达的首个请求会被接受却永不应答，此前这一条请求就能拖死整个 30 秒就绪期限，让重载 / 重检后的探针稳定超时。
- **重启 / 重载 / 切回后沿用的 OpenCode 会话不再回合永忙**——OpenCode 按目录隔离会话与事件流，此前每次启动的随机临时目录让沿用的会话在另一个实例里运行、事件永远到不了面板；固定目录后事件正常到达，旧版本留在已删除临时目录中的会话首次发送返回 503 时会自动重建一次新会话。
- **OpenCode 的思考过程不再混进回复正文**——opencode 1.17 的 reasoning 增量与正文增量同为 `field:"text"`，现在按 part 类型路由：思考只点亮「思考中」，正文只收文本 part；未知 part 保持旧行为。
- **三通道冷启动阶段提示**——Claude、Codex 与 OpenCode 在首个模型增量前报告启动进程、建立会话和派发请求阶段；对话区从点击发送起持续显示当前阶段，收到文本、工具、审批、提问、思考或终态后自动收起，不再在 CLI 冷启动期间留下空白反馈。
- **对话页会话入口常驻可见**——对话转录区上方新增当前会话条，标题可直接打开会话历史，新会话按钮始终可见；长标题会省略显示并保留完整悬浮提示，欢迎页同样提供入口。
- **Codex 隔离登录指引可直接执行**——Codex 通道未登录时，设置页通道卡会显示面板实际使用的隔离 `CODEX_HOME`（不读取系统 `~/.codex`）及按平台生成的 PowerShell / POSIX 登录命令，并提供一键复制；聊天错误 `AUTH_REQUIRED` 的详情也会带上该目录，避免系统范围的 `codex login` 成功后面板仍显示未登录。
- **三通道错误可诊断、日志不再被一行秘密“吃掉”**——claude / codex / opencode 聊天错误现在返回稳定类别码、可折叠脱敏详情与双语排障指引，覆盖 CLI 缺失 / 过旧 / 架构不符 / 探针失败、spawn / exit、登录、MCP、会话 / 回合启动、RPC 超时、上游 HTTP / 模型、事件流、取消与不确定传输；修复 claude `is_error` 路径调用不存在函数导致回合永忙且无错误条目的吞错缺陷。导出日志新增 `## backend errors (last 50)`，三个后端 stderr tail 改为逐行清洗，使某行 `sessionId` / Authorization / 带密钥 URL / 请求体不会截掉后续 `ECONNREFUSED` 与栈帧；chat error 同步持久化进 host log。设置页同时显示 Codex 失败探针详情，区分 Claude 探针超时 / 失败与未登录，并为 `ARCH_MISMATCH` / `PROBE_FAILED` 提供专属文案。
- **ExtendScript 传输信封批量 ASCII 转义**——纯 ASCII 结果走零回调快路径，300 KB 的 `/exec` / `ae_exec` 从 5–6 秒降至亚秒级；需要转义的长结果按 8192 个 UTF-16 单元分块，每块只做一次合并正则替换，连续非 ASCII 段交给引擎原生 `escape()`，避开 ExtendScript 整串 `replace` 的超线性成本。结构化 JSON 同时改用数组汇集后一次 `join`，避免 O(n²) 字符串累加；初始化探针不等价或引擎异常时仍回退原逐字符实现。
- **Phase 3：provider 收敛到三通道，删除自研 wire-protocol 机器（#263）**——聊天后端注册表现在恰好三条：`subscription`（claude CLI）、`codex`（codex CLI）、`opencode`（所有自定义 / 第三方 provider 的统一入口）；未知后端 id 一律**抛错**而不是静默兜底（旧行为会悄悄落回 claude 描述符 / 拒收附件的 byokLoop）。删除 76 个文件、约 3.5 万行：zcode 后端全家、byok / claude-api 通道、`universalProviderRoute` / `providerCapabilityProbe` / `codexResponsesRoute` / provider 各 codec 与旧 `providerStore` 等自实现任意端点协议的全部机器；claude 后端剥离自定义 API 路由半边（连同「Provider CLI request failed.」类错误改写），codex 后端剥离 `~/.codex/config.toml` provider 继承通道（环境隔离决策：codex=预建隔离 `CODEX_HOME`、claude=`--strict-mcp-config`，两通道都选隔离，#230）。存活的 provider 层约 590 行（OpenCode 注册表 / Provider Manager 前端）。**行为变化**：旧 provider 存量不再以「需重填 key」占位列出，升级用户需在 Provider Manager 中整体重新添加（Base URL + Key + 模型，与 #256 的既定口径一致）；codex 自定义模型输入框与 cc-switch 导入随旧通道下线。
- **OpenCode 通道真机加固(#263 收尾)**——Provider 新增**接口方言**选项(Anthropic `/v1/messages` 默认 / OpenAI 兼容 `/v1/chat/completions`,后者对混合模型列表的中转通常全家可用);修复七个真机缺陷:npm direct-exe shim 解析(opencode 装机即 ARCH_MISMATCH)、OpenCode 1.17 会话创建 400、注入 baseURL 补 `/v1`、探针双重启动竞态(宿主/注册表就绪门)、模型偏好被启动竞态重置、回复渲染在用户消息上方(派发即确认)、**每次发送重复 spawn OpenCode 且事件流挂死旧实例**(回合永忙无报错、孤儿进程堆积的根因,改为复用活实例);session 错误对象按嵌套提取不再显示 `[object Object]`,探针不再留存含明文 key 的 provider 载荷。
- **`ae.diagnose` 本机探针忽略代理环境变量**——本机 `/health` 探针不再继承 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`，代理返回的 502 不再被当成本机宿主不可达。（#267）
- **Tool Library `argsSchema` 接受属性描述**——每个属性现在可带不超过 1024 字符的字符串 `description`，legacy skill 不再“能列出、不能执行”。（#268）
- **`ae.skillUse(execute=true)` 恢复 v0.9.0 透传返回形状**——技能脚本自己的 JSON 结果原样放在顶层，不再包 `{ok,name,template_type,result}`，也不再出现外层 `ok:true` 包住内层 `ok:false` 的矛盾；v0.9.2–v0.9.6 期间按 `result.*` 读取的调用方需改回顶层字段。执行仍走审批引擎，`execute=false` 不变。（#269）
- **ExtendScript 超时不再提前放行串行锁（#260）**——调用方仍会按原期限收到超时，但 Bridge 会等迟到回调或排空哨兵返回后才继续，期间 `/health`、`/exec`、`ae.status` 与 `ae.diagnose` 报告 `degraded`；错误 disposition 收敛为三值：从未进入 AE、可安全重试的 `not_dispatched`，已派发但结果未知的 `uncertain`，以及已执行并明确报错的 `failed`。
- **依赖清扫：`npm audit` 归零**——`plugin/sidecar` 锁文件把 `fast-uri` 升到 3.1.5（修 CVE-2026-13676 / GHSA-4c8g-83qw-93j6 以及其后的 GHSA-v2hh-gcrm-f6hx、GHSA-7p8r-x3mc-p8w7，仍在 ajv 声明的 `^3.0.1` 范围内，不引入 `overrides`），同批升级 `ip-address` 10.5.0、`hono` 4.13.3、`@hono/node-server` 1.19.17、`body-parser` 2.3.0；`plugin/host` 的 `express` 4.22.1→4.22.2（连带 `qs` 6.15.3、`body-parser` 1.20.6）。两个工作区 `npm audit` 均为 0；这些包只在本机回环路径上工作，属扫描器噪音清理而非已确认可达的漏洞。由 #271（@anupamme / OrbisAI 扫描报告）触发。
- **`ae_exec` 非字符串结果不再被摧毁（#254）**——ExtendScript 侧新增 ES3 安全序列化器：数字 / 布尔 / `null` / 纯 Object / 纯 Array 结果在 AE 内序列化为规范 JSON 文本原样带回（`structuredContent.contentType: "json"`，`content` 恒为字符串），字符串结果保持原语义（`contentType: "text"`）。此前对象变成 `"[object Object]"` 解析错误、数组变成 `ok:true` 的 `"1,two,[object Object]"` 静默损毁。宿主对象（CompItem / Layer 等）不做深遍历、保持 `String(v)` 叶节点；循环引用 / 深度超 12 / 序列化超 1,000,000 字符按确定性错误返回并提示改用更小的投影；`ae_exec` 路径彻底移除「结果看着像 JSON 就尝试解析」的猜测逻辑，其余工具的结果解析不受影响。
- **一个 ZXP 通吃 Windows 与 macOS**——Python 运行时与 platform-helper 退役后，签名 ZXP 里已不含任何平台二进制（842 个条目、零 `.node` / `.dll` / `.dylib` / `.exe`，宿主依赖树也没有任何 `os` / `cpu` 限定包），因此本版起只发一个不带平台后缀的 ZXP，两个系统共用。按平台分别构建的只剩原生插件——Windows 的 `.aex` 与 macOS 的 `AeMcpNative.plugin`——而它只被 `ae_nativeExec` 一个工具使用，其余十个工具没有它照常工作。
- **工程**——两处只在 macOS 上暴露的测试环境依赖已修：审批超时用例改用 mock timers 推进（计时器是有意 `unref()` 的，Node 20 的 runner 此前会先行退出，#303）；Windows dev-install 夹具先 `realpath` 系统临时目录再建树（macOS 的 `/var` 是符号链接，安装守卫按设计拒绝，#302）。两处都只动测试，不动被测代码。

### [0.9.6] — 2026-08-19

#### 🐛 修复 / 改进

- **兼容 Anthropic / AWS Bedrock 的工具 schema 限制**——`ae_nativeExec` 广告给 MCP 客户端的 `inputSchema` 不再在顶层带 `allOf`（Anthropic 直连与 Bedrock 会以 `input_schema does not support oneOf, allOf, or anyOf at the top level` 拒绝整个请求，经中转站接 Bedrock 的 Claude Code 用户首当其冲）；23 个原语的嵌套判别 schema、服务端完整的读/写程序校验与结构化错误契约保持不变，并新增守卫测试禁止任何工具在 schema 顶层出现组合子。
- **README 一行安装提示词重写**——按真实安装回报的卡点补齐：刚装的 `uv` 要用完整路径调用、启动器用绝对路径、MCP server 注册到用户级作用域（附 Claude Code 的 `claude mcp add -s user …` 原句）、不动其他 MCP 条目并回显最终配置、明确 MCP 工具只在新会话加载（调不到 `ae_ping` 时新开会话再验）。
- **AE 2023/2024 Windows 运行时补完（#235）**——CEP 11（Node 15 / V8 8.8）缺 `Object.hasOwn` / `Array.prototype.at` / `structuredClone`，Host 与面板各注入无依赖 polyfill shim；`node:` 裸 specifier 禁用改为清单式合约测试；AEX、Platform Helper 与传输 .node 插件统一静态 CRT（/MT）链接并由 PE 导入表校验强制（顺带修正 8 字节节名 `.fptable` 的验证器误报）。AE 2023/2024 真机矩阵仍在 #215 验证。
- **`ae_previewFrame` 如实汇报写出的像素（#242）**——尺寸从写出的 PNG 回读（查看器半分辨率不再报 "dimensions do not match"）；帧文件等到 IEND + 大小稳定 + 可解码才算写完（不再间歇 "not a decodable image"）；预算按帧增长、`times` 上限 8；降采样捕获接受并在正文给出警告。
- **`ae_snapshot` 默认落盘路径（#243）**——无 `out_path` 时落到系统临时目录下的绝对路径（UUID 命名），不再解析到 MCP 进程的工作目录（`[Errno 13] Permission denied: 'ae_viewer_….png'`）。
- **面板输入框不再被锁死成 8px（#243）**——composer 下限 72→96px、启动期非法测量值丢弃；CSXS MinSize 300×280、默认尺寸 480×420（@tomaszteee 在 Windows 11 / AE 2026 定位并验证）。
- **审批两道门的默认方向写成文档（#243）**——verb 面未配置时放行（客户端自带权限系统），Tool Library / skill 面回落 `manual`；写进模块 docstring、调用点与 `docs/REFERENCE.md`（环境变量首次成文），三条测试钉住，行为不变。
- **工程**——macOS 合并门跑完整 Python/JS 套件、bridge 的 Windows 生命周期探针测试不再改写共享 stdlib 模块（#244）；新增 `CONTRIBUTORS.md` 记录 git 记不下来的贡献（#245）；`docs/ARCHITECTURE_DIRECTION.md` 记录两进程方向与 2026-08-19 的 owner 决策（#266 / #272）。

### [0.9.5] — 2026-08-12

#### ✨ 新增

- **代理提问表单全通道可用（#228/#219）**——codex（`request_user_input`）与 claude（`AskUserQuestion`）后端都会弹出结构化提问表单：选项、推荐标记、自定义输入、提交/取消，答案回填进模型上下文；免审与只读档同样可提问——审批档位只约束操作，不再吞掉提问。
- **渠道选择改为用户显式启用（#229/#60）**——移除自动挑选与锁定机制；Claude 订阅、Codex CLI、自定义 Provider 各通道由用户逐一启用，可并存，模型列表按当前后端切换。

#### 🐛 修复 / 改进

- **AEX 按 AE 2023 套件基线构建（#215 代码侧）**——CompSuite 获取降至 v11（v12 仅为两个本插件不使用的文字创建函数增加参数），单一 `AeMcpNative.aex` 面向 AE 2023–2026；23/24 真机矩阵仍在 #215 验证中。
- **codex 自定义 Provider 通道配置隔离（#230 部分）**——聊天进程运行于私有 `CODEX_HOME`，用户全局 `~/.codex` 的 MCP 服务器与工具不再进入面板会话；CLI 登录通道保持原状并继续跟踪。
- **部署与载荷完整性**——CEP 扫描路径去除重复扩展注册（修复 AE 启动主线程死锁），部署产物迁至扫描路径外并自动清扫历史遗留；host/sidecar 的 vendored 依赖纳入部署前门闸，空壳载荷在部署时即失败而非上机后面板装死。
- **对话体验**——聊天气泡保留换行与空行；已回答的提问卡片显示真实选项文本；探针失败原因如实透出（#222）；渠道诊断显示 codex 实际入口（#225）；probe 与自定义 Provider 配置解耦（#226）。

### [0.9.4] — 2026-08-04

#### 修复

- 恢复 v0.9.3 ZXP 误删的 Windows Platform Helper，使 Provider 管理器重新使用 Windows Credential Manager 保存凭据；Helper manifest 与三个声明二进制在签名前逐项校验。
- 新增 Windows 最小 ZXP 契约测试：必须保留生产 Host 依赖、Helper 与现有在线 `uv tool install` 首跑向导，同时拒绝 bundled Python/Node、Windows RuntimeManager manifest 与嵌套 AEX。
- 修正文档：外部 Python runtime 不在 ZXP 内，但清洁环境可通过面板首跑向导联网安装；AEX 仍作为独立 Release 资产手动安装。

### [0.9.3] — 2026-08-03

#### 发布范围

- 新增 Windows x64 原生执行宿主的正式发布资产；ZXP 与 AEX 均从最终 `main` 提交重新构建，并分别使用本次新建的自签名身份签名。
- 固定资产为 `ae-mcp-panel-v0.9.3-windows-x64.zxp`、`AeMcpNative-v0.9.3-windows-x64.aex` 与 `SHA256SUMS-v0.9.3.txt`。
- AEX 由用户在关闭 AE 后手动复制到所选宿主的 `Support Files\Plug-ins\Extensions\AeMcpNative.aex`。本版继续使用现有外部 runtime/launcher，不提供零环境安装、一体化安装器、Windows RuntimeManager 或自动升级/修复/回滚/卸载。

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

### Unreleased

- **Built-in model lists moved to the current generation** — the Claude channel now offers Fable 5.1, Opus 5, Sonnet 5, and Haiku 4.5 with Opus 5 as the default; ids are the official date-free aliases and the price tiers follow (Sonnet 5 drops to $2/$10). The Codex channel's offline fallback mirrors the `model/list` inventory of codex-cli 0.144.1 (GPT-5.6-Sol default, fast-capable models flagged); the live list still wins. The Settings default-model dropdown no longer carries its own stale hardcoded list. Note: Fable 5.1 requires Claude Code ≥ 2.1.251; older CLIs return a 400 naming the required version — switch models or run `claude update`.

### [0.10.5] — 2026-08-28

- **Added the `ae-mcp-jkdg` npm connector and official MCP Registry manifest** — stdio-only clients such as Claude Desktop can connect to the local AE panel with `npx -y ae-mcp-jkdg`. The connector is paired with the product by major.minor; the extension itself still comes separately from GitHub Releases.
- **Unreachable-panel errors now include an actionable fix** — stdio connection failures tell users to install the ae-mcp extension and keep the After Effects panel open instead of exposing only a low-level network error.
- **Connection docs are more accurate** — the READMEs add the Glama badge and npx setup while removing the retired `ae_ping` and `ae_snapshot` tool names.
- **The test suites no longer read or write your real `~/.ae-mcp` (#330)** — host state paths resolve through an injectable `AE_MCP_STATE_DIR` root (with `AE_MCP_HOME` compatibility and the fine-grained `AE_MCP_LOG_DIR`/`AE_MCP_TOOL_DIR`/`AE_MCP_SKILL_DIR` overrides), and every integration fixture now uses a temp directory. Panel state left on a dev machine could previously make the suite fail inexplicably — and running the tests could pollute the real user directory.
- **OpenCode no longer clings to a dead host connection after a restart (#333)** — the panel stamps each boot with a host generation and recycles persistent OpenCode instances across generations; mid-turn `-32000 Connection closed`/`Not connected` transport failures rebuild the instance and retry the turn once, with a clear "reload the panel or start a new session" hint if that also fails. Previously the ae tools silently vanished from the session after a panel reload, and even restarting AE did not always recover.
- **The Docs / GitHub buttons actually open now (#334)** — external links go through a three-tier fallback (CEP → CSInterface → host-side open) with a visible error when every tier fails, and the docs link routes by panel language with independently updatable zh/en targets.
- **Successful scripts are captured automatically and can be rerun after context compaction (#338)** — `ae_exec`/`ae_execRecover` now store each successful script in the Tool Library as a candidate (deduplicated by content, never duplicating promoted artifacts, hidden from default search); the exec envelope gains an `artifactId`, and the placeholder guard lists this conversation's recent rerunnable entries with the exact `ae_toolUse {"name":"<id>"}` call. Candidates prune themselves (7-day TTL / 20 per conversation / 200 global), and a capture failure never affects the execution result.
- **Placeholder retry loops now hit a circuit breaker — and leave numbers (#339)** — from the second consecutive placeholder rejection in a session, the error switches to a shorter, harder message with exactly one way out and the streak count; every rejection lands in the activity log (`placeholder_rejected` + streak + script summary) so diagnostics can finally answer "how often does this happen". Matching goes beyond two hard-coded phrases to exact markers plus a shape×word-family heuristic, with a false-positive regression matrix keeping real scripts unblocked.
- **The Tool Library gets its first write verb, `ae_toolSave` (#344, 12→13 tools)** — one verb, four uses: promote a captured candidate into a proper tool (rename/description/tags; visible in default search afterwards), create new `jsx`/`prompt-skill` artifacts, update existing user artifacts (revision bump), and manage status (saved/pinned/archived/deprecated; never back to candidate). Bundled and legacy artifacts stay read-only; every write goes through an approval card with an operation summary, artifacts changed during approval are refused, and the secret scan still guards every save.
- **User skills are unified into the library (#340)** — prompt-skills created with `ae_toolSave` (saved/pinned) now appear in `ae_skillUse` listing and resolution (by name or exact id, with a source label), and name collisions resolve library > legacy user directory > bundled. Approval now binds to the artifact id and content hash, so a content revision invalidates stale approvals; prompt skills stay render-only with an explicit error, and the legacy directory remains read-compatible without migration.
- **The Tool Library can be distributed: export / import plus a panel manager (#341)** — saved/pinned tools export as self-contained JSON (written host-side under the state root's `exports/`, with the full path shown and copyable in the panel); imports go through content-hash tamper checks, the secret scan, and duplicate detection, landing with an `imported` source and no trust. The Tools page provides a Tool Library section: candidate and saved lists with promote / pin / archive / restore / delete / clear-candidates and paste-or-file import, all through token-guarded routes at the same level as `/exec`. A build-side generator script turns exported wires or library artifacts into bundled-skill format with manifest SHA-256 updates (dry-run included).
- **The library now has usage numbers, and its verbs sell the workflow (#342)** — successful `ae_toolUse`/`ae_skillUse` runs record `lastUsedAt` and the new `useCount` (existing libraries normalize automatically — never falsely reported as corrupt); the activity log gains funnel events (use/render/promote/create/update/status with artifact ids) so diagnostics can answer how many candidates get replayed, promoted, or sit unused; all four library verb descriptions are rewritten workflow-first, and the server instructions plus the bundled ae-execution-guide teach search-first → replay → promote.

### [0.10.3] — 2026-08-26

- **Silent OpenCode turns get a stall watchdog (#327)** — when a provider produces no output and no tool activity for an extended period, the turn now ends with a clear reason instead of spinning "generating" forever. Healthy long tasks are unaffected: as long as the model keeps progressing, the turn continues.
- **`ae_nativeExec` no longer returns the always-false `undo.verified` field (#310)** — the promised verification never existed, so the field only misled callers; it is removed from the protocol and the reference updated.
- **OpenCode ships inside the ZXP — a fresh install has a working channel out of the box (#321)** — the Windows package bundles the official OpenCode executable (SHA-256-verified, pinned version fetched at build time; release builds fail rather than silently ship without it). The panel prefers the bundled copy automatically, with the explicit env-var override still winning.
- **Signing in no longer needs a terminal** — the Claude channel gains an Open-sign-in-window button (the page refreshes automatically once you're in); the Codex channel gains one-click sign-in that runs the login inside the panel's isolated environment and opens the browser verification page for you, falling back to a copyable command only when that fails. No fix hint tells you to "run X in a terminal" anymore.
- **The wizard installs Claude Code for you** — one click runs Anthropic's official installer (provenance clearly labeled); Re-check finds it immediately. An optional add-to-PATH button registers CLI directories on the user PATH without admin rights, preserving the value type and never using the PATH-truncating setx.
- **Fresh installs default to the OpenCode Provider channel** — the only channel needing no CLI sign-in; existing users keep their stored choice.
- **AI replies are no longer torn apart by tool cards (#322)** — all three channels flush pending assistant text before inserting a tool, approval, or question card. Previously, with an API key configured, the last few dozen characters were withheld in the leak-prevention buffer and only appeared below the card after you answered — sometimes splitting a word in half.
- **CLIs installed while AE is open are now detected (#321)** — on Windows, Re-check re-reads the registry user/system PATH and knows the official install locations (Claude's `~\.local\bin`, scoop shims, OpenCode's `~\.opencode\bin`). No more restarting After Effects after installing a CLI.
- **Agents can no longer be trapped by their own redacted history (#323)** — fixes a real incident: the placeholder that hides old scripts from history (to save tokens) was imitated by the model and sent back as code, executing a bare comment forever and even overwriting the stored recovery script on retry — one task failed 40+ times. The host now rejects placeholder code with clear guidance, recovery scripts can no longer be overwritten by it, and the placeholder text itself now says never to send it back.
- **Errors finally carry fix hints (#323)** — hints previously fired only on the "ran but returned nothing" side path, never on actual ExtendScript exceptions; that is fixed, with four new field-driven hints (slider ±1,000,000 clamp, color arity, invalid object, NO_VALUE groups). The completion-value contract (the last statement must be a bare expression) and `ae_previewFrame` parameter conflicts now state the correct call shapes inline.
- **Diagnostics bundles can reconstruct real failures (#323)** — activity entries now carry the tool name, transport, and client attribution; failures record a bounded script head and which hint fired; calls the bridge saw as success but the MCP layer failed (e.g. undefined results) are no longer disguised as successes; skill invocations leave a trace; exports merge errors from prior panel processes. OpenCode built-in tools (read/apply_patch/…) are no longer mislabeled with an `mcp__ae__` prefix (#324).

### [0.10.2] — 2026-08-23

- **Failure recovery is split out of `ae_exec`** — a dedicated `ae_execRecover` now accepts `recoveryId` and optional corrected code, while `ae_exec` accepts only normal script-execution arguments so models cannot mistake a recovery id for script text. This increases the public surface from 11 tools to 12. The previous `ae_exec({recoveryId})` shape is rejected with an error naming `ae_execRecover`; no compatibility shim is provided, because two optional fields sharing one schema is the ambiguity this change exists to remove.
- **Per-model context windows for custom OpenCode models** — Provider Manager now offers 32K / 64K / 128K (recommended) / 200K presets plus a custom value for every model; existing configurations keep the 128K default. Values below 32K or above 2M are rejected, and the advertised output reserve scales with the chosen window so a 32K model is not also declared as having 32K of output capacity. The UI warns that a larger number cannot increase a provider's real capacity, while a smaller number compacts more often.
- **Luna property reads no longer fail local validation** — `ae_read` now accepts sorting properties by their full match path, so this valid request shape from Luna reaches After Effects instead of failing before dispatch.
- **Clearer script-result guidance for smaller models** — host instructions now distinguish a bare script's final value from the explicit `return` required inside an IIFE, reducing avoidable recoveries where AE changed but the panel received `undefined`.
- **The approval card actually appears, and its tier matches the conversation** — in manual tier every write raises an approval card whose real call arguments can be expanded. Approval identity now uses the invoked tool's own name (a retry shows as `ae_execRecover`, not `ae_exec`), and the authorization content hash covers the complete call instead of the card's 200-character preview, so two scripts sharing a prefix are no longer treated as the same approved operation. User cancellation, an unavailable approval dialog, an approval timeout, and an explicit denial are now four distinct messages rather than one generic "user denied".
- **Long turns keep reporting progress, and switching sessions mid-run asks first** — a running turn continuously reports elapsed time and estimated tokens. Creating or switching sessions while a turn is unfinished raises a confirmation: "cancel" leaves the running task alone, and only "stop and continue" stops it before switching. Turns are no longer dropped silently.
- **An OpenCode failure leaves the session usable** — a provider or socket failure preserves the real cause and allows a retry in the same conversation instead of leaving the session permanently busy. (The automatic one-shot retry/backoff the issue asks for is still not implemented.)
- **OpenCode long sessions stop inflating their requests** — already-executed script bodies are trimmed from the outbound history copy before sending. Tool results and AE readbacks are unchanged; this mainly relieves the request growth seen after the sixth or seventh turn. The tradeoff is that the model cannot quote an old script body unless it is supplied again.
- **Chunked output no longer corrupts multi-byte text** — the Claude, Codex, and OpenCode channels all decode streamed chunks on complete UTF-8 boundaries.

### [0.10.1] — 2026-08-23

#### ✨ Added

- **One-click model discovery in the Provider Manager (#306)** — with a Base URL and API key in the form, "Probe models" issues a single request to `<baseURL>/v1/models` (`x-api-key` plus `anthropic-version` for the Anthropic dialect, `Authorization: Bearer` for the OpenAI-compatible one) and appends the returned ids, deduplicated, after whatever is already typed. The request leaves from the CEP Node side because the panel is a `file://` page and provider hosts send no CORS headers, so browser `fetch` cannot reach them; `http://` requires explicit confirmation, and every visible error is redacted against the key. This restores the model discovery that was removed together with the legacy provider machinery in Phase 3.
- **`ae_previewFrame` interval grids and A/B pixel diffs** — adds evenly spaced `range:{start,end,count}` sampling, labeled `layout:'grid'` contact sheets, and `compare` selectors for current times or the 50 most recent in-process captures; comparisons return heatmap and side-by-side artifacts plus changed ratio/pixels, mean/max difference, and a bounding box, with all composition, resampling, and scaling handled by the CEP host's dependency-free PNG path rather than Chromium canvas.
- **`ae_exec` failure-recovery envelopes and snapshot-diff attribution** — dispatched script failures now persist an editable `.jsx` plus metadata under `~/.ae-mcp/checkpoints/<project>/recovery/` and return a `recoveryId`, absolute `scriptPath`, `errorLine` with its `errorSource`, captured `$.writeln` output, before/after project revisions, and bounded `touched` evidence identifying added, removed, or changed layers and project items from before/after snapshots. Edit the file or provide corrected inline `code`, then retry with `ae_exec({recoveryId})`; the default restores the checkpoint created by `checkpoint_label` before the failed call, while `retryMode:'continue'` explicitly preserves the failed state. Per-call `$.writeln` capture is always removed in `finally`; the legacy HTTP `/exec` route does not enable diagnostics and keeps its existing shape.
- **Panel session management (#231)** — embedded chat can now create sessions, search and sort history by recent activity, switch back into the full transcript and real backend context (persistent Codex threads, Claude `--resume`, and OpenCode sessions), rename, archive / restore, and permanently delete after inline confirmation. The local index and transcripts are written atomically under `~/.ae-mcp/sessions`. Panel reloads and AE restarts restore only persisted history: interrupted approvals and questions are cancelled, and an in-progress turn is never redispatched automatically. Deletion removes the local transcript and best-effort deletes Codex / OpenCode backend sessions; Claude CLI has no matching delete API, so its CLI-owned session files remain.
- **A diagnostics bundle that can actually diagnose something** — Settings → "Export log" now persists panel and CEP-host events (`~/.ae-mcp/logs/host-YYYY-MM-DD.jsonl`, still exportable after a panel reload) and writes independently fault-tolerant, fully redacted sections: environment (AE/CEP/OS/Node/Chromium), a fresh diagnostics run, `/exec` and `/native/*` activity, host log memory + disk tail, panel log, claude/codex/opencode backend stderr, the Python server log (new `server-YYYY-MM-DD.log` file log with a startup line) and a `previewFrame` comp-PNG vs viewer-fallback branch summary (the Phase 0 §6.3 evidence).
- **Experimental CEP-hosted MCP Streamable HTTP spike (#261)** — the host now mounts a local, token-free `/mcp` (Origin/Host allowlist) with a minimal `ae_status` / `ae_exec` loop, session-bound SSE and progress notifications for long calls; `ae_exec` shares the `/exec` execution chain. Gated by a new Node 15 (CEP 11 peer-engine) CI job that runs a real 31-second call. **No approval gate yet — not a finished migration or a release commitment.**
- **Phase 1 batch 1: the CEP-hosted MCP server grows real execution semantics and read tools (#261 / #264)** — still experimental; no commitment until the panel switch exists. (1) **Per-conversation configuration**: the panel can open an isolated `/mcp/c/<token>` entry per conversation while external clients get the default "external" policy; `ae_exec` gains the **approval gate** (the Python verb gate's semantics and decision record ported verbatim, `readonly/manual/auto/none`; pending approvals go to an in-process queue for the panel to surface), **best-effort auto-checkpoint** (the checkpoint store ported wholesale: `AE_MCP_HOME/checkpoints`, keyed by project path, `AE_MCP_CHECKPOINT_KEEP`) and Python-compatible JSX result parsing and error hints. (2) `ae_status` absorbs `ping` / `diagnose` via `depth`; new `ae_previewFrame` — `saveFrameToPng` only, PNG completion polling, real written size, `scale`, multi-frame budget, MCP image content, dependency-free PNG-subset decoding; no viewer-screenshot fallback. (3) **New `ae_read`**: paginated + sortable + filterable structured reads of project / comps / layers / properties / keyframes / comp settings (JSX reflection, output shaped like the native read primitives, never checkpoints, never opens an undo group).
- **Phase 1 batch 2: the panel can switch to the CEP-hosted MCP server; the hosted tool surface reaches 8 (#261 / #264)** — still an experimental switch, default unchanged. (1) **Panel wiring**: Settings → Connection → "MCP server engine" offers `CEP host (experimental)`; in that mode every chat session registers its own host conversation (approval chip / expert guidance apply live), the built-in codex / opencode / claude backends point their MCP at `http://127.0.0.1:<port>/mcp/c/<token>`, host approvals surface as the existing approval card, and the external-clients page shows the HTTP setup; Tool Library and tool search stay on Python. (2) `ae_checkpoint` (create / list), `ae_revert` (same-directory atomic replace + reopen, failures carry `stage`) and `ae_validateExpressions` ported to the host; `initialize.instructions` follows the session's expert-guidance policy; a maintained real-AE acceptance suite ships as `npm run test:live-mcp`. (3) **`ae_nativeExec` in the host**: runs over the in-process native AEGP client with the generated-contract validation, request / postcondition digests and the 11-way result check ported verbatim from Python (canonical JSON cross-checked against Python); a dependency-free JSON Schema subset validator fails closed on any keyword outside the generated contract; `native_exec.generated.json` is committed as the CJS twin of the ESM artifact. The hosted `tools/list` is now `ae_status, ae_exec, ae_previewFrame, ae_read, ae_checkpoint, ae_revert, ae_validateExpressions, ae_nativeExec`.
- **Phase 2 batch 1: the hosted tool surface reaches 11, client identity moves to MCP sessions, and the claude backend switches to the CLI (#262 / #264)** — (1) **The Tool Library lands in the host**: `ae_toolSearch` (absorbs `toolIndex` / `toolInspect`: no args = index, `query` = search, `name` = one artifact's detail), `ae_toolUse` (runs a stored JSX tool; the `plan_hash` binding is checked independently at approval consumption and again before dispatch, blocking "approve, then swap the content" replays) and `ae_skillUse` (absorbs `skillList`; `execute=true` keeps the #269 pass-through shape); the on-disk layout stays fully compatible with the Python-era `~/.ae-mcp` store (verified read-only against a real 32-artifact store), and the 8 bundled skills ship inside the extension byte-identical to the Python set. (2) **`/mcp` client identity = `initialize.clientInfo` + session id**: the kill switch and per-client blocking are decided before every `tools/call` and answer with structured JSON-RPC errors (`ACTIONS_PAUSED` / `CLIENT_BLOCKED`); a blocked client's new `initialize` is refused outright; the blocklist persists atomically to `~/.ae-mcp/blocked-clients.json` (fail-open on corruption, logged); Settings gains an "Active MCP sessions" list (source / version / last active / block toggle); the legacy `/exec` `x-ae-mcp-client` semantics are unchanged. (3) **External clients**: Claude Desktop connects through a zero-dependency stdio→HTTP shim (system Node; a failed line answers a JSON-RPC error instead of killing the queue); Claude Code / Cursor stay URL-only. (4) **The claude panel backend switches to the CLI binary (§2.2, decision 8)**: no more Agent SDK sidecar process — each chat session drives one user-installed `claude` CLI 2.x over stream-json (`--permission-prompt-tool stdio` routes every tool call through the panel's existing four-tier approval gate, and AskUserQuestion returns through the same control channel into the question form; model/effort/attachment changes restart the process with `--resume <session_id>` preserving context; `--strict-mcp-config` plus empty `--setting-sources` keeps user-global MCP servers out). Windows strictly resolves the npm `.cmd` shim to the in-package native `claude.exe` (with an `AE_MCP_CLAUDE_CLI` override); the subscription probe becomes `claude auth status --json` with install/upgrade guidance. All protocol shapes were verified against real CLI 2.1.227 wire transcripts; `plugin/sidecar/` stays in-tree, dormant, for the deletion sweep batch.
- **Phase 2 batch 2: the panel goes host-only, platform-helper is deleted, custom Providers move to OpenCode (#262 / #263)** — (1) **Panel off Python**: the MCP engine switch is gone (claude / codex / opencode backends always use the per-conversation `/mcp/c/<token>`); the Tools UI / Tool Library client talks to the host in-process (HTTP fallback) and adapts to the folded 11-tool surface; the wizard becomes host health → AI CLI detection → external clients, with system Node only as the optional Claude Desktop shim dependency. (2) **platform-helper deleted (~-19k lines)**: the native tree, host client/transport/registration, panel repair chain, packaging + nested-signing wiring and its dedicated CI are removed. (3) **Custom Providers write OpenCode config** (decision 7): the fill-a-key front-end stays; keys merge atomically into OpenCode's own `auth.json` (existing entries preserved, 0600); provider definitions are injected into the embedded OpenCode config by the panel (the `@ai-sdk` loader is verified to be bundled inside the OpenCode binary — no runtime npm fetch; HTTPS enforced unless explicitly confirmed); legacy helper-stored providers are not migrated (the UI marks them re-enter-key); the claude / codex custom API channels are retired and OpenCode becomes the Provider chat channel, write-gated by the host conversation approval gate. **THREAT_MODEL is rewritten accordingly: provider credentials are held by each CLI's own store — an intentional security-boundary adjustment.** (4) **The Python / sidecar / runtime payload retires (final sweep, ~-115k lines)**: `packages/` (core / bridge / snapshot-mss), `plugin/sidecar/`, the RuntimeManager and portable runtime, runtime BOM/evidence and sidecar staging are deleted; the host drops the Python bridge tracking (no more `pythonVersion` in `/health`); CI converges to three Node-only jobs (Windows JS+contracts, CEP 11 peer-engine, macOS packaging contract) with zero python matches in workflows; **the ZXP becomes a direct, single-signed payload** (panel dist + host + jsx + shared + generated/skills + optional .aex) and the packer refuses artifacts at or above 20 MB (this batch stages at ~7 MB vs the old 87 MB package); the bilingual README/INSTALL are rewritten around the two client paths — Claude Code via one `/mcp` URL, Claude Desktop via the system-Node shim. The legacy `uv tool install ae-mcp` launcher retires with Python, with no compatibility promise.

#### 🐛 Fixes / Improvements

- **OpenCode child-process lifecycle is now closed end to end** — unloading the panel explicitly resets every chat backend. OpenCode runs from stable workspace and configuration directories under `~/.ae-mcp/opencode/` instead of a fresh temporary directory per launch (no more 60 MB dependency reinstall or leaked directories). Instances write PID ownership markers; before starting, the panel verifies the executable image and terminates the orphan left by a previous panel context (never a reused PID or an instance owned by another running AE), while legacy temporary directories are removed by an asynchronous, bounded sweep. Generation guards cancel and kill a start still in flight when the backend is reset, a crash during startup fails immediately, and account probes have a 40-second total deadline with abortable requests plus a Settings recheck escape hatch after the pending grace period. Each readiness poll now has its own request timeout: a request that lands right after OpenCode binds its port can be accepted yet never answered, and that single request used to consume the whole 30-second readiness deadline, making probes after a reload or recheck time out.
- **Resumed OpenCode sessions no longer hang after a restart, reload, or switch** — OpenCode scopes sessions and its event stream per directory; with per-launch temporary directories a resumed session ran in a different instance whose events never reached the panel. With stable directories the events arrive, and a legacy session whose temporary directory is gone (HTTP 503 on the first send) is recreated once automatically.
- **OpenCode reasoning stays out of the reply text** — opencode 1.17 streams reasoning and text increments with the same `field:"text"`; they are now routed by part type, so thinking only drives the “Thinking…” indicator and only text parts reach the bubble; unknown parts keep the previous behavior.
- **Cold-start progress across all three channels** — Claude, Codex, and OpenCode report process startup, session creation, and request dispatch before the first model increment. The chat transcript shows the active stage immediately after Send and clears it when text, tools, approvals, questions, thinking, or a terminal event arrives, eliminating the silent gap during CLI startup.
- **Discoverable session controls in the chat view** — a persistent session bar above the transcript opens session history from the current title and keeps New session visible, including on the welcome view. Long titles truncate cleanly while retaining the full hover title.
- **Codex isolated-login guidance is directly actionable** — when the Codex channel is logged out, its Settings card now shows the isolated `CODEX_HOME` the panel actually uses (without reading the system `~/.codex`), generates the platform-appropriate PowerShell or POSIX login command, and offers one-click copy. Chat `AUTH_REQUIRED` error details also include that directory, making clear that a system-wide `codex login` does not sign the panel in.
- **Diagnosable failures across all three chat channels, without one secret line swallowing the log tail** — claude / codex / opencode chat failures now carry stable category codes, collapsed redacted details, and bilingual troubleshooting hints for CLI resolution, spawn / exit, authentication, MCP, session / turn start, RPC timeout, upstream HTTP / model, event stream, cancellation, and uncertain transport failures. This also fixes the claude `is_error` path calling a nonexistent function, which left the turn permanently busy with no error entry. Log exports add `## backend errors (last 50)` and redact each backend stderr line independently, so a `sessionId`, Authorization header, credential-bearing URL, or request body cannot erase later `ECONNREFUSED` and stack-frame evidence; chat errors are also persisted to the host log. Settings now preserves failed Codex probe detail, distinguishes Claude probe timeout / failure from logged-out state, and gives `ARCH_MISMATCH` / `PROBE_FAILED` dedicated guidance.
- **Batched ASCII escaping for the ExtendScript transport envelope** — pure-ASCII results use a zero-callback fast path, cutting 300 KB `/exec` / `ae_exec` calls from 5–6 seconds to sub-second latency. Long results that need escaping are split into 8192-UTF-16-unit chunks, each using one merged regexp replacement; contiguous non-ASCII runs are handed to the engine's native `escape()`, avoiding ExtendScript's superlinear whole-string `replace`. Structured JSON also collects parts for one final `join` instead of O(n²) accumulation, while the initialization probe still falls back to the character loop on any mismatch or engine error.
- **`ae.diagnose` local probe ignores proxy environment variables** — The local `/health` probe no longer inherits `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`, so a proxy-generated 502 is no longer mistaken for an unreachable local host. (#267)
- **Tool Library `argsSchema` accepts property descriptions** — Each property may now include a string `description` of at most 1024 characters, so legacy skills no longer “list successfully but fail to execute.” (#268)
- **`ae.skillUse(execute=true)` restores the v0.9.0 pass-through response shape** — The skill script's own JSON result is returned unchanged at the top level instead of being wrapped in `{ok,name,template_type,result}`, eliminating contradictory outer `ok:true` / inner `ok:false` responses. Callers that read `result.*` in v0.9.2–v0.9.6 must switch back to top-level fields. Execution still uses the approval engine, and `execute=false` is unchanged. (#269)
- **ExtendScript timeouts no longer release the serialization lock early (#260)** — Callers still receive a timeout on schedule, while the bridge waits for a late callback or drain sentinel before proceeding and reports `degraded` through `/health`, `/exec`, `ae.status`, and `ae.diagnose`. Error dispositions are a closed three-value set: `not_dispatched` for scripts that never entered AE and are safe to retry, `uncertain` for dispatched scripts whose result is unknown, and `failed` for scripts that executed and returned a definite error.
- **Dependency sweep: `npm audit` clean** — the `plugin/sidecar` lockfile moves `fast-uri` to 3.1.5 (fixes CVE-2026-13676 / GHSA-4c8g-83qw-93j6 plus the later GHSA-v2hh-gcrm-f6hx and GHSA-7p8r-x3mc-p8w7, staying inside ajv's declared `^3.0.1` range with no `overrides`), alongside `ip-address` 10.5.0, `hono` 4.13.3, `@hono/node-server` 1.19.17 and `body-parser` 2.3.0; `plugin/host` bumps `express` 4.22.1→4.22.2 (with `qs` 6.15.3 and `body-parser` 1.20.6). Both workspaces now audit at 0. These packages only ever see loopback traffic here, so this is scanner-noise cleanup rather than a confirmed reachable vulnerability. Prompted by #271 (@anupamme / OrbisAI scan report).

- **One ZXP for Windows and macOS** — with the Python runtime and the platform helper retired, the signed ZXP holds no platform binaries at all (842 entries, zero `.node` / `.dll` / `.dylib` / `.exe`, and no `os`- or `cpu`-constrained package anywhere in the host dependency tree), so this release ships a single ZXP without a platform suffix for both systems. Only the native plug-in is still built per platform — the `.aex` on Windows and the `AeMcpNative.plugin` bundle on macOS — and `ae_nativeExec` is the one tool that uses it; the other ten work without it.
- **Engineering** — two test-environment dependencies that only surfaced on macOS are fixed: the approval-timeout cases now drive the deliberately `unref()`'d timer with mock timers, so the Node 20 runner no longer exits first (#303), and the Windows dev-install fixture resolves the system temp directory with `realpath` before building its tree, because macOS `/var` is a symlink that the installer guard rejects by design (#302). Both changes touch tests only, never the code under test.

### [0.9.6] — 2026-08-19

#### 🐛 Fixed / Improved

- **The wizard's "connect an external client" page is now one copyable prompt** — it used to make the reader pick between Claude Desktop, Claude Code and Cursor and then copy the matching config blob, so every additional client meant another config to maintain and the reader still had to work out which file it belonged in. It now shows a single prompt to paste into whichever AI client the reader already uses, letting that client perform the MCP registration; the address and stdio shim path inside it come from **this install's real port and extension directory**, not placeholders. The bare URL stays below it as a manual exit, and the optional system-Node check is always visible now that no client is selected (only stdio-only clients such as Claude Desktop need it). The Settings page keeps its per-client configs as the advanced entry point.
- **Anthropic / AWS Bedrock tool-schema compatibility** — the `inputSchema` that `ae_nativeExec` advertises to MCP clients no longer carries a top-level `allOf` (the Anthropic API and Bedrock reject the whole request with `input_schema does not support oneOf, allOf, or anyOf at the top level`; Claude Code users routed to Bedrock through a relay hit it first). The nested discriminated schemas for all 23 primitives, full server-side read/write program validation, and the structured error contract are unchanged, and a guard test now forbids top-level combinators on every advertised tool.
- **README one-line install prompt rewritten** — it now covers the snags seen in real installs: call a freshly installed `uv` by full path, use the launcher's absolute path, register the MCP server at user scope (with the exact Claude Code `claude mcp add -s user …` line), leave other MCP entries alone and echo the final entry, and state that MCP tools only load in a new session (open one before verifying with `ae_ping`).
- **AE 2023/2024 Windows runtime compatibility completed (#235)** — CEP 11 (Node 15 / V8 8.8) lacks `Object.hasOwn` / `Array.prototype.at` / `structuredClone`, so the host and the panel each load a dependency-free polyfill shim; the bare `node:` specifier ban became a manifest-driven contract test; the AEX, Platform Helper and transport `.node` addon all link the static CRT (/MT), enforced by a PE import-table verifier (which also fixes a false positive on the 8-byte `.fptable` section name). The AE 2023/2024 real-host matrix is still tracked in #215.
- **`ae_previewFrame` reports the pixels that were written (#242)** — dimensions are read back from the PNG on disk (a viewer at half resolution no longer fails "dimensions do not match"); a frame counts as written only after IEND + a stable size + a successful decode (no more intermittent "not a decodable image"); the budget grows per frame and `times` is capped at 8; downsampled captures are accepted with a warning in the text.
- **`ae_snapshot` default output path (#243)** — without `out_path` the capture lands at an absolute, UUID-named path under the system temp directory instead of the MCP process's working directory (`[Errno 13] Permission denied: 'ae_viewer_….png'`).
- **Panel composer no longer latches shut at 8px (#243)** — composer floor 72→96px, bogus startup measurements rejected; CSXS MinSize 300×280, default size 480×420 (diagnosed and verified on Windows 11 / AE 2026 by @tomaszteee).
- **Approval gates documented (#243)** — the verb surface allows when unconfigured (the MCP client's own permission system is the gate) while the Tool Library / skill surfaces fall back to `manual`; written into the module docstring, both call sites and `docs/REFERENCE.md` (the environment variables appear there for the first time), pinned by three tests, no behaviour change.
- **Engineering** — the macOS merge gate runs the full Python/JS suites and the bridge Windows-lifecycle probe tests stop mutating shared stdlib modules (#244); `CONTRIBUTORS.md` credits the contributions git cannot record (#245); `docs/ARCHITECTURE_DIRECTION.md` records the two-process direction and the 2026-08-19 owner decisions (#266 / #272).

### [0.9.5] — 2026-08-12

#### ✨ Added

- **Agent question form on every channel (#228/#219)** — both the codex (`request_user_input`) and claude (`AskUserQuestion`) backends now raise the structured question form: options, recommended markers, custom input, submit/cancel, with answers fed back into the model context. The no-review and read-only tiers can ask too — approval tiers gate operations, not questions.
- **Explicitly user-enabled channels (#229/#60)** — auto-pick and channel locks are gone; the Claude subscription, Codex CLI, and custom-provider channels are enabled individually, can coexist, and the model list follows the active backend.

#### 🐛 Fixed / Improved

- **AEX built on the AE 2023 suite baseline (#215, code side)** — CompSuite acquisition drops to v11 (v12 only adds a parameter to two text-creation calls this plugin never makes), so one `AeMcpNative.aex` targets AE 2023–2026; the 23/24 real-host matrix stays tracked in #215.
- **Codex custom-provider channel config isolation (partial #230)** — the chat process runs in a private `CODEX_HOME`, so MCP servers from the user's global `~/.codex` no longer enter panel sessions; the CLI-login channel is unchanged and stays tracked.
- **Deployment and payload integrity** — duplicate extension registrations are swept out of the CEP scan path (fixing an AE startup main-thread deadlock), deployment artifacts move outside the scan path with automatic legacy cleanup, and the vendored host/sidecar dependencies join the pre-deploy gate so a gutted checkout fails the deploy instead of shipping a dead panel.
- **Conversation polish** — chat bubbles preserve line breaks; answered question cards show the actual chosen option text; provider probe failures surface their real reason (#222); channel diagnostics show the actual codex entry point (#225); the probe is decoupled from custom-provider configuration (#226).

### [0.9.4] — 2026-08-04

#### Fixed

- Restore Windows Platform Helper, which was mistakenly omitted from the v0.9.3 ZXP, so Provider Manager again stores credentials through Windows Credential Manager. Packaging verifies the Helper manifest and all three declared binaries before signing.
- Add a minimal Windows ZXP contract test that requires production Host dependencies, Helper, and the existing online `uv tool install` first-run wizard while rejecting bundled Python/Node, Windows RuntimeManager manifests, and nested AEX files.
- Correct the installation docs: the external Python runtime is not inside the ZXP, but a clean environment can install it online through the Panel's first-run wizard. The AEX remains a separate manual-install Release asset.

### [0.9.3] — 2026-08-03

#### Release scope

- Publish the Windows x64 native execution host as a release asset. The ZXP and AEX are rebuilt from the final `main` commit and signed with newly created self-signed identities.
- Fixed assets are `ae-mcp-panel-v0.9.3-windows-x64.zxp`, `AeMcpNative-v0.9.3-windows-x64.aex`, and `SHA256SUMS-v0.9.3.txt`.
- With AE closed, users manually copy the AEX to the selected host as `Support Files\Plug-ins\Extensions\AeMcpNative.aex`. The existing external runtime/launcher remains required; this release has no zero-environment install, integrated installer, Windows RuntimeManager, or automatic upgrade/repair/rollback/uninstall lifecycle.

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
