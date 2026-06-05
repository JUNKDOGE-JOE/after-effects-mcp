# 更新日志 / What's New

让 AI 操控 After Effects 更稳、更顺、更省心。
Making AI-driven After Effects more reliable, smoother, and worry-free.

格式参考 [Keep a Changelog](https://keepachangelog.com/)，版本遵循 [语义化版本](https://semver.org/)。
Format based on Keep a Changelog; versioning follows SemVer.

---

## 中文

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
