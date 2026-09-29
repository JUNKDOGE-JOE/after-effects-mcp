# 多实例功能：macOS 实机交接

目标分支：`codex/multi-instance-projects`，仓库：`JUNKDOGE-JOE/after-effects-mcp`。
本文件供 macOS 上的下一执行会话使用。当前交付点是 Windows 开发诊断完成、准备 macOS 实机，
不是 `development-verified` 或 `release-accepted`。先以远端分支与草稿 PR 的当前 SHA/检查结果为准。

## 已完成与保持不变的约束

- 阅读 `AGENTS.md`、`docs/ARCHITECTURE_DIRECTION.md` 和 `docs/MULTI_INSTANCE_EXECUTION_PLAN.md`。
- 一个功能包、同一分支；批准上限 74 个去重文件、7,000 行非生成手写增删。先计算已用规模，再修复。
- 每个工程一个主 AE；不同工程可并行，同工程一个 writer、正式修改串行；明确交接才能写。
- worker 仅接受固定 checkpoint 上的 `ae_read` / `ae_previewFrame`，不启动模型或通用 MCP 面板。
- MCP 保持标准 stdio / HTTP，不依赖 Codex 聊天身份；不新增独立应用、常驻协调服务或第四 provider。
- Guide 缺失已由用户接受。保留 `saveFrameToPng`，不自动改 Guide 或图层可见性，不做原生/截图替代。
- 不改冻结的 23 个原生 primitive，不运行 codegen，不重建、替换原生插件；不合并、不打 tag、不发布。
- Windows 已验证双工程路由/执行重叠、两 worker、单 writer/交接、真实 Undo、旧快照、取消、
  目录准备故障后的单次继续、超时结果核实，以及关闭面板后的主 AE 保活/工程占用/手动重连。
- 中文目录修复的顺序为已有 `Adobe After Effects Auto-Save` → 已有 `自动保存` → 会话 work_dir。
  不解析 AE 的自定义自动保存偏好，不扫描任意目录；未证实的其他本地化名称不猜测。
- RAM 是准入估计，不是硬上限；默认总实例 4、worker 2。不要把资源估计写成性能保证。

Windows 中文目录实机补测也已通过：只有“自动保存”目录可用时，公开 checkpoint 返回其下路径，原 AEP 路径保持不变。
最新本地回归为 1,201 通过、93 跳过、0 失败（含 9 项冻结协议合约）。

Windows 原始项目、日志和本地 Git 恢复备份未推送。执行简报保留的早期短 SHA 是发布前的
本地诊断标识；未公开历史因构建产物路径清理而整理，不要在 Mac 上尝试 checkout 那些短 SHA。
Mac 必须自行采集真实证据，不能复用 Windows PASS 作为 macOS 验收。

## 1. 只读准备与源码确认

1. 先核对当前 Git dirty 状态、已安装 AE/CEP/原生组件、运行中的 AE、当前工程及未保存状态。
   不为部署强关用户 AE，不清空或覆盖生产工程，不盲目恢复上轮脚本。
2. 取回 `origin/codex/multi-instance-projects`，在干净、隔离且完全本地的 checkout 验证。
   记录实际 SHA；若已有本任务合适 worktree 则复用，不从用户脏工作区隐式构建。
3. 查看该 SHA 的 PR CI。现有 CI 只对 main push / pull_request 触发；不要推 main、打发布 tag，
   不添加工作流绕过。`macos-14` CI 是包装/脚本合约，不是真实 AE。
4. 当前面板仅支持 Apple Silicon 原生 `darwin-arm64`。检查 `uname -m`、Node/CEP 架构；
   Intel 或 Rosetta x64 不要标成受支持或试图在此包扩展。

```bash
git status --short
git rev-parse HEAD
uname -m
node -p 'process.version + " " + process.arch'
```

CI 使用 Node `24.17.0`；记录本机实际版本，不自动安装系统 Node 或 Adobe 软件。
优先复用与 lockfile 匹配的已有开发依赖；缺失时可按现有 lockfile 在本 checkout 中准备依赖：

```bash
(cd plugin/host && npm ci)
(cd plugin/panel && npm ci && npm run build)
node plugin/panel/verify-bundle.mjs
git diff -- plugin/client/dist
```

构建产物应可重现且不含本机绝对路径。不要用外部 node_modules 链接构建后直接提交路径注释。
如组件或协议版本明确不兼容，先停止相应路径；源码 SHA 不同本身不代表原生组件不兼容。

## 2. 备份部署与零证据 preflight

只部署 CEP，保留当前兼容原生安装。确认全部 AE 已正常关闭且没有待核实写入后，复用：

```bash
./scripts/install-plugin-dev-macos.sh
```

目标：`~/Library/Application Support/Adobe/CEP/extensions/com.aemcp.panel`。
备份：`~/Library/Application Support/AfterEffectsMCP/cep-panel-dev-v1`，位于 Adobe 扫描根外。
该脚本校验并替换完整 CEP 树，但不生成持久 JSON receipt；保存安装输出、恢复命令、
源码 SHA/dirty 状态、规范安装路径、组件版本及关键文件大小/mtime。不要把它当发布身份验收。

设一个明确的本地验证根，原始日志和 AEP 不提交 Git：

```bash
VALIDATION_ROOT="$HOME/ae-mcp-validation/multi-instance"
mkdir -p "$VALIDATION_ROOT"
```

核实正式 AE 的绝对可执行路径，排除 Beta；例如：
`/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/After Effects`。
不通过文件双击或 LaunchServices 打开 fixture，以免进入其他 AE。
启动专用空 AE 时也应显式继承上述状态根和 work_dir：

```bash
AE_MCP_STATE_DIR="$VALIDATION_ROOT/state" AE_MCP_WORK_DIR="$VALIDATION_ROOT" "$AE_BIN" -m
```

该命令的 Mac 多实例行为属于本轮待验证点；观察真实 PID/窗口后再操作，不因慢启动重复执行。

preflight 使用独立、可重建的测试 AE，证明 GUI、面板、MCP、保存/在 AE 内重新打开、日志路径可用。
可以通过 AE 自身新建空工程并手动打开面板，但必须先确认目标是本任务专用实例；
不要把 `app.newProject()` 当作可在未知用户工程上调用的初始化方法。
记录 `ephemeral-validation` 生命周期和重建配方，始终只维护一套 A/B fixture。
正常 GUI 操作按用户授权执行；遇到无法自动操作的系统确认才请求一次必要协助。
无关可选权限提示按已有 Skip → Continue 恢复，不扩权限，不做连接码配对。

## 3. 现有可执行 recipe

```bash
node plugin/host/tests/live-mcp/multi-instance.mjs \
  --run --validation-root "$VALIDATION_ROOT" \
  --url "http://127.0.0.1:<实际端口>/mcp"
```

**前置是已登记、未保存且没有任何项目项的空白主 AE**。即便是已经保存的空 AEP 也不满足；
该脚本会拒绝覆盖。不要直接运行旧的 `test:live-mcp` / `tests/live-mcp/run.mjs`，其生命周期不同。
如果 `active/multi-instance` 已存在，先核实旧 fixture 和任务，再恢复、归档或按配方重置，不能盲删。
recipe 会建立 A/B、测普通预览、checkpoint、两 worker、跨工程读写和 Undo，并保存 `evidence.json`。
Guide 像素只记录 accepted limitation，普通蓝/绿内容和来源仍严格校验。
结束后主 A 可能仍打开；检查剩余实例并显式退出，再归档，不把进程出现或 starting 视为通过。

recipe 建好 A/B 后，复用这些文件验证“零 AE 进程下打开已有工程”，不要新建一批 fixture：

```bash
env -u AE_MCP_HTTP_URL \
  AE_MCP_STATE_DIR="$VALIDATION_ROOT/state" \
  AE_MCP_AFTER_EFFECTS="$AE_BIN" \
  node "$HOME/Library/Application Support/Adobe/CEP/extensions/com.aemcp.panel/host/stdio-shim.js"
```

`AE_BIN` 必须来自前面的正式 AE 路径核实。此入口接受标准 MCP JSON Lines；先 initialize，
再调用 `ae_instances.start(project_path, work_dir)`。工程和目录均需现存绝对路径。
轮询 list 至 running，bind 后用公开 ae_read 确认实际项目；不要假定固定端口。
至少另起一个独立 MCP 连接读回同一实例，且关闭第一个 stdio 客户端后主 AE 应继续存活。

## 4. Mac 必须取得的实机证据

| 场景 | 必须观察到的结果 |
| --- | --- |
| 正式 AE 冷启动 | 直接 executable 的 `-m -r` 创建独立 AE PID、执行脚本；CEP StartOn 注册正确工程，无菜单 toggle 误关 |
| 环境与 PID | 测试状态根/work_dir 被 AE 和 CEP 继承；手动面板通过 ps 父链找到 AE PID，不能拿 CEP PID 冒充 |
| 两工程 | 两个不同 AE PID/端点；交错调用不串项目，两个短执行区间真实重叠 |
| writer | 第二 writer 拒绝，显式 transfer 后旧 writer 资格失效 |
| 两 worker | 不依赖 MCP 面板/provider；两个合成结果有 checkpoint/time/worker 来源，普通像素正确 |
| 固定快照 | K 后临时改名主合成，主读见新名、worker 仍见 K 的旧名；最后真实 Undo 并读回 |
| 取消 | 批次尚有未开始项时 cancel；停止后续派发，最终无不明 worker 清理；不声称强行中断同步脚本 |
| 目录与路径 | 已有英文/简中目录和 cwd 回落；正常保存后复制，主工程始终指向原路径 |
| 失败继续 | 在 fixture 内制造目录准备故障，编辑未派发；同操作/同 failure id 明确确认仅消费一次；不得把此项称为真实 AE 保存失败 |
| 不确定写入 | 用受控短超时诱发 uncertain；普通写入受阻；读回取得 observation_id，明确 reconcile 后才能 Undo/继续 |
| 关闭面板 | 主 AE 保活且工程仍被占用；旧 context 拒绝，同项目再 start 拒绝；worker 最终退出 |
| 手动重开 | 同 AE PID，新宿主/上下文；旧 context 仍拒绝，不自动重放旧命令 |
| 正常退出 | 显式 stop 后 AE PID 确认消失，工程占用释放，无残留 registry.lock |

macOS 不得套用 Windows 的子进程 Job Object 行为。要实测 CEP 退出后 worker 的关闭标记、
登记核实或现有 120 秒 idle 退出是否奏效，并记录时延；不要据 Windows PASS 承诺 Mac 即时退出。
若 worker 切换到非本任务项目，停止自动回收该实例，保留状态并核实，不能按 PID 盲杀。

额外边界：Guide 包含已明确不做；实际客户端 CLI 登录/交互覆盖须与标准 MCP 测试分开报告。
失败后继续只涵盖明确注入并核实的层级；没有实际触发的故障不能算 PASS。

## 5. 失败处理与交付

先收齐不影响真实性的独立失败，写机器可读 PASS/FAIL/BLOCKED/INDETERMINATE 清单。
任何可能写入未核实时立即停相关执行，不盲重试，不改写历史证据，不因慢启动重复起 AE。
先用最小测试复现并集中修复；保持原有 JSX 超时锁及哨兵排空。超出 74 文件/7,000 行或改变
产品工作流时先报告范围，不能借 Mac 验证新增原生能力、安装器或后台服务。

完成报告包含：精确被测源码/安装记录、公开请求与结构化响应、实例/项目/快照来源、
前后状态、Undo 执行与核实、取消/断线/恢复结果、日志引用、CI 链接、平台/版本及剩余限制。
只运行源码和真正安装匹配的测试，原始私有路径/凭据不推送。
AEP 记录创建、正常删除、归档、保留及未分类计数；退出任务 AE，将测试副本放入短期可恢复归档。
中断 CEP 后的遗留 worker 快照不能说成自动清理成功；确认其进程已退出后按本任务归属归档。

Mac 未过前保留草稿 PR，不合并、不发布。只报告实际完成的验收层级；未完成的正式 HDEV/
发布 T5/T6 门禁保持未完成，不能仅凭 CI 绿色或 Windows 结果标记 release-accepted。
