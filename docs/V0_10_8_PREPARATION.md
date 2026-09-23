# v0.10.8 修复准备

状态：用户已确认剪贴板粘贴及开关实机通过；其余界面、接入与模型验收仍有缺项。不是
`development-verified` 或 `release-accepted`。

基线：`9033566`（当前 `origin/main`）；分支：`codex/v0.10.8-panel-fixes`。
本次处理 [#388](https://github.com/JUNKDOGE-JOE/after-effects-mcp/issues/388)、
[#389](https://github.com/JUNKDOGE-JOE/after-effects-mcp/issues/389)、
[#390](https://github.com/JUNKDOGE-JOE/after-effects-mcp/issues/390)，以及用户补充的
Opus 5.5、GPT-6 Sol/Luna 模型支持及最新旗舰默认值。用户另批准粘贴宿主路由修复，
用户确认 Ctrl+V 成功后批准继续设置开关；范围为 25 个文件、约 750 行手写新增内容。
版本号仍为 0.10.7；版本更新、候选打包和发布留到验收边界。

## 改动与已有证据

| Issue | 实现 | 已验证 | 未验证 |
| --- | --- | --- | --- |
| #388 | Composer 捕获文件粘贴，复用 FilePond 和附件存储；设置提供可持久化开关；保留文字粘贴 | 无 TMC 时 Ctrl+V 实机成功；6783995 安装后用户明确回复“我测完了，过”，确认本轮开关实机验收 | TMC 启用时的 Ctrl+V 劫持为已知兼容性限制；通过关闭面板附件粘贴避让 |
| #389 | 菜单最高为 AE 面板可视高度的 60%，同时受展开方向实际空余空间约束；内部滚动，保留全部模型 | 浏览器面板高度 300、680、1080 时，100 项菜单分别为 180、408、648px；矮面板滚轮可到达并选择第 100 项；3 项时约 107px | AE CEP 不同面板尺寸、滚动条拖动和选中状态 |
| #390 | README 中英文和面板复制提示词以当前客户端为目标；操作前只读检查文件、版本、注册与连接；只补缺失或损坏项，有可用新版则升级，已就绪则直接验证；保留用户设置及其它配置 | 双语入口契约测试覆盖检查、只装文件、只配客户端、不重复安装、升级及不降级；保留动态端口与 shim 路径 | 两种客户端中验证四类已有安装状态、配置范围、刷新及 `ae_status` 读回 |
| 模型支持 | Claude 增加 `claude-opus-5-5` 和 CLI 2.1.280 最低版本检查；Codex 补充 Sol/Luna 离线条目，实时目录仍完整替换离线条目 | Claude 模型/推理档位传参、旧 CLI 拒绝；Codex Sol/Luna 传参、隐藏项和能力差异测试；已安装 Codex 0.155.0 的实时目录返回两个模型 | 真实面板中三种模型的请求、响应和 AE 工具调用 |

菜单比例按面板的 CSS 可视高度计算，而不是整块显示器的物理像素；停靠面板缩放
和系统 DPI 缩放均使用其实际可用区域。模型不足时按内容高度显示。

FilePond 4.32.12 的粘贴监听器会忽略其根节点之外的可编辑控件。
Composer 的 textarea 位于 FilePond 根节点外，因此仅开启 `allowPaste`
无法覆盖输入框粘贴。此次修复针对该可观察的源码路径；尚未证明所有 Windows
剪贴板文件格式都会由 CEP 暴露为 `clipboardData.files/items`。

浏览器检查使用生产组件与临时页面，附件就绪状态由测试页面提供，不能视为真实
附件存储或 provider 接收证据。测试页面未调用 AI 服务，也未修改 AE 工程。

- 首轮附件等定向测试：47/47 通过；本轮模型、比例高度和提示词定向测试：91/91 通过。
- 默认模型调整后：86 项相关测试通过，面板重新构建及 bundle 一致性检查通过。
- 最新面板全量测试：673 项，672 通过，1 项跳过，无失败。
- 面板构建、bundle 一致性和 `git diff --check` 通过。
- 一轮本地 diff 检查；未运行独立评审、远程 CI、HDEV、T5 或 T6。
- 无新增 provider、原生能力、安装基础设施或发布工作流。

## 模型版本与来源

本机面板解析器选中 Codex 0.153.4，其实时目录没有 Sol/Luna；对照本机已安装的
Codex 0.155.0，使用同一面板探测流程和隔离环境，目录包含 `gpt-6-sol` 和
`gpt-6-luna`。Sol 提供 low/medium/high/xhigh/max/ultra，Luna 到 max，
两者均报告 Fast。成功返回的实时目录仍优先，不能用离线条目伪装账号可用性。

本机 Claude Code 为 2.1.257，低于 Opus 5.5 要求的 2.1.280；现有版本检查会在
派发前提示更新。未自动升级或切换 CLI，未发送真实模型请求。
按用户补充要求，Claude 默认改为 Opus 5.5；Codex 的离线和实时默认均优先
GPT-6 Astra。实时目录没有 Astra 时仍遵循该目录的可用模型，已保存的用户模型
选择继续保留，不强制迁移。
Opus 5.5 价格档位采用官方输入 $4/MTok、输出 $20/MTok，推理档位为
low/medium/high/xhigh/max。

官方依据：[Claude Code 模型配置](https://code.claude.com/docs/en/model-config)、
[Opus 5.5 发布说明](https://www.anthropic.com/claude-opus-5-5)、
[GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol)、
[GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)。

## 真实验收计划

1. 使用可回退的开发安装，记录基线安装收据和版本；进入真实 AE CEP 面板。
2. #388：分别复制本地文件、多文件、截图、普通文字；检查仅添加一次、数量和大小
   限制、失败后草稿保留、选择文件和拖放不回归；向支持相应输入的模型发送测试附件，
   要求返回附件中的已知内容。
3. #389：用大量模型在不同面板高度检查滚轮、滚动条、首末项选择和选中标识。
4. #390：分别在 Claude Code 与非 Claude Code 客户端覆盖“已有注册缺文件、已有
   文件缺注册、两者均为最新版、已有旧版”四种情形；核对只处理必要部分、其它配置
   保留；按该客户端要求刷新后调用公开 `ae_status`。
5. 使用支持目标模型的 CLI 版本，分别验证 Opus 5.5、GPT-6 Sol/Luna 的模型选择、
   推理档位、请求和响应；通过公开 `ae_status` 验证真实 AE 工具链。
6. 全部通过后再更新 Issue 状态、冻结 0.10.8 候选和执行适用的发布验收。

用户已手动替换面板 bundle 并启动 AE 2026。已安装 bundle 与 `e6a9b58` 构建的
SHA-256 一致；只做此变更文件的身份核对，未重新扫描完整安装。
`.aep` 生命周期：创建、保留 canonical、保留 evidence snapshot、归档、未分类
均为 0；移动或释放空间为 0。

## 真实 AE 后台诊断结果

用户要求不占用鼠标后，全部测试通过公开 MCP 与生产后端模块调用已安装 CLI，
无鼠标、键盘或窗口焦点操作，也未修改生产工程或用户客户端配置。
这是后台开发诊断，`validationProfile=development`、`candidateRun=false`、
`candidateEvidence=false`，不替代正式 HDEV/T5/T6 或完整 CEP 界面验收。

| 检查 | 结果 | 证据与限制 |
| --- | --- | --- |
| HTTP → 真实 AE | PASS | 公开 `ae_status` 正常；`ae_read` 前后均为 0 个工程条目 |
| 已安装 stdio shim → 真实 AE | PASS | 系统 Node 启动已安装 `host/stdio-shim.js`，公开 `ae_status` 返回 `ok=true` |
| 无路径 PNG 暂存 | PASS | 生产 attachmentStore 写入 5239 字节，读回与输入一致，MIME 为 image/png；完成后临时副本已清理 |
| GPT-6 Astra / Codex 0.153.4 | PASS | 正确读出图片中的 AE MCP TEST 7319、蓝色方块及橙色圆形；`ae_status`、`ae_read` 均成功 |
| GPT-6 Sol / Codex 0.155.0 | PASS | 同一图片识别正确；两项公开 AE 只读调用均成功 |
| GPT-6 Luna / Codex 0.155.0 | INDETERMINATE | 附件已收到，形状颜色识别正确，AE 两项调用成功；文字把 7319 读成 319，精确识别子项 FAIL，不能宣称附件理解全通过 |
| Opus 5.5 / Claude Code 2.1.257 | BLOCKED | 生产后端派发前返回 CLI_TOO_OLD，要求至少 2.1.280；未升级 CLI |
| 测试会话清理 | PASS with recovery | 三个测试会话的现有 thread/delete 路径返回未成功；随后确认记录存在，仅将这三个测试会话通过 thread/archive 可恢复归档 |

三个 Codex 模型共完成 6 次公开只读工具调用，均收到成功 tool-result。
Sol/Luna 使用本机已有 0.155.0 显式诊断路径，未更改面板默认解析到的 0.153.4。
AE 保持由用户打开的空工程；没有创建、保存、渲染或修改项目。

尚未验证：真实 CEP 的资源管理器 Ctrl+C/Ctrl+V、截图粘贴事件、鼠标滚轮与滚动条；
#390 在两个真实客户端中按四种已有安装状态执行配置；Opus 5.5 的成功请求。
不把后台附件暂存与模型传递测试当作操作系统剪贴板事件验收。

本地结构化证据文件：`background-results.json`、`stdio-public-status.json`、
`project-after.json`、`test-session-recovery.json`，位于系统临时目录的本次
`ae-mcp-0108-hardware-*` 目录；含测试会话标识的原始日志不进入仓库。
诊断过程中发现的会话删除问题保留为后续调查项，本批不扩大产品改动。

## 可选优化，尚未实施

模型列表重新打开时让当前选中模型自动进入可见区域。它能减少长列表重复定位，
预计仅涉及菜单滚动定位；不增加搜索、收藏、分组或模型目录机制。

## #388 实机反馈与宿主快捷键修复候选

用户手测报告：Ctrl+V 不能添加附件，或文件进入 AE 项目面板而不是附件栏；
截图为 AE“源文件标题有误”错误 `86::1`。此项记为真实 CEP 用户验收 FAIL，
此前浏览器组件测试及后台附件暂存通过不能覆盖这条缺陷。

源码未向 CEP 注册聊天区的剪贴板快捷键。Adobe 的
[CEP 12 文档](https://github.com/Adobe-CEP/CEP-Resources/blob/master/CEP_12.x/Documentation/CEP%2012%20HTML%20Extension%20Cookbook.md#register-an-interest-in-specific-key-events)
说明，非文本控件聚焦时按键可能转发给宿主，需提前注册 key interest。
用户反馈与此机制一致，但当前未抓取其现场焦点/键盘事件，不把机制推断当作复测成功。

- Composer 挂载时注册 Windows Ctrl+C、Ctrl+V 和 Shift+Insert，卸载时释放。
- 聊天区的对应 keydown/keyup 只停止冒泡，不 preventDefault，以保留浏览器原生
  copy/paste 和 clipboardData。
- 与已有图片预览 Esc 共用按消费者合并的注册列表；关闭预览不会清掉粘贴键，
  聊天区卸载也不会清掉仍在使用的预览 Esc；卸载整个页面时统一释放。
- 不注册全局系统快捷键，不增加原生插件，不通过 AE 导入命令接收文件。
- 定向测试 41/41；面板全量 671 项，670 通过、1 跳过、0 失败；构建和 bundle
  一致性检查通过。仅重建工作目录的 app.js，未替换正在运行的安装或操作界面。

复测顺序：替换并重新加载新面板 → 点击文字输入框 → 资源管理器复制单个 PNG →
Ctrl+V → 确认附件栏恰好新增 1 项且 AE 项目列表无新增。再测无路径截图、普通文字，
以及打开/关闭工具图片预览后再次粘贴。若仍失败，保留“按键没到面板”与“按键到了但
clipboardData 没文件”这两个诊断分支，不把文件导入项目当作附件添加成功。

### 最新实机定位：TMC Clipboard 冲突

用户重新授权 GUI 后，在真实 AE 2026 上对 `fa3b74a` 完成受控对照；安装 bundle
与构建文件 SHA-256 一致，初始工程条目数为 0。

| 操作 | 实测 |
| --- | --- |
| 资源管理器复制测试 PNG，点击聊天 textarea，Ctrl+V 一次 | 附件未增加，AE 工程变为 1 项；撤销菜单明确显示 `Paste from Clipboard (TMC)` |
| 通过 AE 菜单撤销该测试操作 | 公开 `ae_read` 确认工程恢复 0 项 |
| 保持同一剪贴板，再聚焦同一 textarea，Shift+Insert 一次 | 附件出现 `attachment-image.png` 和“已就绪”，公开 `ae_read` 确认工程仍为 0 项 |

本机存在 `MediaCore/TMC/TMCClipboard.aex`，与撤销动作名称相符。
结论：面板接收文件的链路可用；本机 Ctrl+V 被 TMC Clipboard 操作抢先处理。
Ctrl+V 兼容性仍为 FAIL，Shift+Insert 替代入口实测 PASS；不宣称整个 #388 已通过。
未禁用、移动或修改 TMC，也未改变其快捷键。测试附件保留在草稿中供用户查看。
导入已撤销且没有保存工程；AE 无标题工程的改动标记没有强行清除。
本地结构化记录：本次临时证据目录下 `paste-routing-live.json`。

### 剪贴板附件粘贴开关

设置 → 通用新增中英文“剪贴板附件粘贴”开关，默认开启，偏好使用
`ae_mcp_clipboard_attachments` 保存。关闭后不添加剪贴板附件、不注册或拦截
Ctrl+C/Ctrl+V，保留文字粘贴、添加文件和拖放；已有草稿和附件不被清空。
取消 Alt+Shift+V 等备用热键。关闭时附件区文案改为“拖放文件”。
43 项定向测试通过；面板全量 673 项，672 通过、1 跳过，构建和 bundle 一致性通过。
后台浏览器组件验证开关可切换，关闭时模拟 CEP 注册为空、开启时恢复 Ctrl+C/V，
草稿保留。随后将 6783995 安装至真实 AE，用户接手并明确确认本轮实机回归通过；
用户结果与后台组件测试分开记录，不将模拟注册当成 CEP 实机证据。

### TMC 临时停用对照

用户明确要求不保存关闭当前含 QQ 图片的无标题工程。AE 退出后，仅把
TMCClipboard.aex 移出 Adobe 扫描目录，重启同一正式 AE 2026 做测试：
资源管理器复制 PNG → 点击聊天输入框 → Ctrl+V，附件显示“已就绪”；
公开 ae_read 确认工程条目数前后均为 0，测试 PASS。
测试后关闭空工程，将 TMCClipboard.aex 恢复到原路径，前后 SHA-256 一致。
没有修改其它 TMC 插件，没有创建或保存 .aep。本地证据为
ctrl-v-without-tmc.json、tmc-disable-result.json、tmc-restore-result.json。
用户随后要求恢复成功环境亲测，重新临时停用 TMC 后交回 AE；用户回复
“ok，去做开关吧”，确认该环境下的标准 Ctrl+V 通过。

### 当前剩余验收与交付

- #389：尚无真实 AE 中比例高度、首末项及滚动条的用户确认记录。
- #390：尚未在两种客户端实际执行增量配置/升级提示词；HTTP/stdio 连通已验证。
- 模型：Opus 5.5 成功调用待新版 Claude CLI；Codex 需确认面板选用含 Sol/Luna 的
  CLI。Luna 图像数字漏读保留为质量观察，不能伪装为完整识别通过。
- 远端核对：三个 Issue 仍 OPEN，本分支无 PR，最新 Release 为 v0.10.7。
- 发布前尚需集中评审、正式 CI/开发验收收尾、0.10.8 版本与打包、发布验收及发布。

## 改动清单

共 25 个文件：实现 12、测试 9、文档 3、生成 bundle 1。
工作流/基础设施、配置/schema/fixture、机械版本更新均为 0。
临时浏览器检查页面与测试日志位于系统临时目录，不进入源码或发布包。
所有变更只保存在本地修复分支；未推送、合并或发布。
