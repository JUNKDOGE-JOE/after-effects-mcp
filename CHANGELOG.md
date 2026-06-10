# 更新日志 / What's New

让 AI 操控 After Effects 更稳、更顺、更省心。
Making AI-driven After Effects more reliable, smoother, and worry-free.

格式参考 [Keep a Changelog](https://keepachangelog.com/)，版本遵循 [语义化版本](https://semver.org/)。
Format based on Keep a Changelog; versioning follows SemVer.

---

## 中文

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
