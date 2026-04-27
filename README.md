# ae-mcp

## 中文

ae-mcp 是一个面向 Adobe After Effects 的 MCP 自动化项目。它让 Codex、Cursor、Claude Code 等 MCP 客户端可以通过 Python MCP server 和本地 CEP 面板驱动 AE。

```text
MCP client -> Python ae-mcp -> HTTP 127.0.0.1:11488 -> CEP panel -> AE ExtendScript
```

### 当前状态

simple RPC 插件链路已经实现：CEP 面板、HTTP bridge backend、30 个 `ae.*` verbs、实时 AE live tests、开发安装脚本和 ZXP 打包脚本。

当前验证结果：

- `uv run pytest -q`: 152 passed, 20 live tests deselected
- `uv run pytest packages/core/tests/live -o addopts='' -vv`: 20 passed, 需要 AE 打开并且 ae-mcp 面板绿灯

这已经达到一个可用的 AE 操作 MVP：agent 可以检查、修改、预览、checkpoint/revert、使用 skill，并创建基础 rig。`ae.generateImage` 明确不在范围内，图像生成交给 agent/model 侧，ae-mcp 负责导入和操作 AE。

### Verb Surface

| 分类 | Verbs |
|---|---|
| Project | `ae.init`, `ae.overview`, `ae.layers`, `ae.readProps`, `ae.searchProject` |
| Mutation | `ae.exec`, `ae.applyEffect`, `ae.createLayer`, `ae.setProperty`, `ae.moveLayer`, `ae.selectLayers`, `ae.setTime` |
| Read-typed | `ae.getTime`, `ae.getProperties`, `ae.scanPropertyTree`, `ae.inspectPropertyCapabilities`, `ae.getExpressions`, `ae.validateExpressions`, `ae.getKeyframes` |
| Preview | `ae.previewFrame` |
| Rigging | `ae.createRig` |
| Skill | `ae.skillList`, `ae.skillCreate`, `ae.skillEdit`, `ae.skillDelete`, `ae.skillUse` |
| Checkpoint | `ae.checkpoint`, `ae.revert` |
| Diagnostic | `ae.ping`, `ae.snapshot` |

`ae.previewFrame` 是快速 viewer capture，不走 Render Queue，也不会写真实渲染帧。`ae.snapshot` 是更底层的诊断截图能力。

任何写表达式的工作流都应该先跑 `ae.validateExpressions`，再做视觉检查。它会强制求值表达式并返回 `expressionError` 或 sample failure，避免把 agent 可以自动发现的问题交给用户。

### 剩余差距

- `ae.previewFrame` 目前抓取可见 AE 窗口/viewer 区域，还不是精准 Composition Viewer crop。
- `ae.createRig` 是 MVP，不是完整 rigging 系统；Puppet pin null binding、preset library、高级 controller template 还需要后续补。
- skill 系统已有持久化 CRUD/use，但还没有内置 skill library、import/export 和面板管理 UI。
- simple RPC 需要 CEP panel + Python package 双安装；单安装 MCP-over-HTTP 插件可以作为后续产品化方向。
- ZXP 打包脚本已经存在，但正式 release 前还需要 clean-machine signed install smoke。

### 安装

文档导览：

- [docs/INSTALL.md](docs/INSTALL.md): 安装、MCP 客户端配置、首次接入 smoke、常见排障
- [docs/WORKFLOW.md](docs/WORKFLOW.md): Agent + MCP + AE 插件如何协同工作，以及推荐的日常使用节奏
- [docs/REFERENCE.md](docs/REFERENCE.md): tool surface、参数、能力边界、返回语义
- [docs/RELEASE.md](docs/RELEASE.md): ZXP 打包、发布 smoke、发布前缺口

开发安装：

```powershell
uv sync --all-packages --group dev
cd plugin\host
npm ci
cd ..\..
.\scripts\install-plugin-dev.ps1
```

重启 After Effects，然后打开 `Window -> Extensions -> ae-mcp`。如果目标是让外部 Agent app 直接接入，请优先看 [docs/INSTALL.md](docs/INSTALL.md) 和 [docs/WORKFLOW.md](docs/WORKFLOW.md)。

### 测试

非 live 测试：

```powershell
uv run pytest
```

live 测试，需要 AE 打开且 ae-mcp 面板绿灯：

```powershell
$env:AE_MCP_LIVE_TESTS = "1"
$env:AE_MCP_BACKEND = "ae-mcp"
$env:AE_MCP_PLUGIN_URL = "http://127.0.0.1:11488"
uv run pytest packages/core/tests/live -o addopts='' -vv
```

### 打包

使用 Adobe `ZXPSignCmd`：

```powershell
.\scripts\package-zxp.ps1 -ZxpSignCmd C:\Tools\ZXPSignCmd.exe
```

更多 release 步骤见 [docs/RELEASE.md](docs/RELEASE.md)。

### 实现说明

ae-mcp 是独立实现，不包含其他产品的代码或资源文件。

设计目标包括：

- 面向 agent 的 AE 检查、修改、预览和 reusable workflow。
- 快速 viewer feedback，而不是每次都真实渲染。
- 基于 Adobe CEP、ExtendScript API 和 Model Context Protocol 的本地自动化链路。

第三方组件：

- `plugin/client/CSInterface.js` 是 Adobe CEP `CSInterface` v11，文件内保留 Adobe 原始许可声明。
- `ae-mcp-snapshot-mss` 使用 `mss` 和 Pillow 做屏幕截图。
- Python bridge 使用 `httpx`；CEP host 使用 Express。

### 开源协议

ae-mcp 项目代码使用 MIT License，见 [LICENSE](LICENSE)。

带有上游许可声明的文件，例如 Adobe `CSInterface.js`，按其文件内许可声明执行。

## English

ae-mcp is an MCP automation project for Adobe After Effects. It lets MCP clients such as Codex, Cursor, and Claude Code drive AE through a Python MCP server and a local CEP panel.

```text
MCP client -> Python ae-mcp -> HTTP 127.0.0.1:11488 -> CEP panel -> AE ExtendScript
```

### Status

The simple RPC plugin path is implemented: CEP panel, HTTP bridge backend, 30 `ae.*` verbs, live AE verification, development install scripts, and ZXP packaging scripts.

Current verification:

- `uv run pytest -q`: 152 passed, 20 live tests deselected
- `uv run pytest packages/core/tests/live -o addopts='' -vv`: 20 passed with AE open and the ae-mcp panel green

This is a usable AE operation MVP: agents can inspect, mutate, preview, checkpoint/revert, use skills, and create basic rigs in After Effects. `ae.generateImage` is intentionally out of scope; image generation belongs on the agent/model side.

### Verb Surface

| Category | Verbs |
|---|---|
| Project | `ae.init`, `ae.overview`, `ae.layers`, `ae.readProps`, `ae.searchProject` |
| Mutation | `ae.exec`, `ae.applyEffect`, `ae.createLayer`, `ae.setProperty`, `ae.moveLayer`, `ae.selectLayers`, `ae.setTime` |
| Read-typed | `ae.getTime`, `ae.getProperties`, `ae.scanPropertyTree`, `ae.inspectPropertyCapabilities`, `ae.getExpressions`, `ae.validateExpressions`, `ae.getKeyframes` |
| Preview | `ae.previewFrame` |
| Rigging | `ae.createRig` |
| Skill | `ae.skillList`, `ae.skillCreate`, `ae.skillEdit`, `ae.skillDelete`, `ae.skillUse` |
| Checkpoint | `ae.checkpoint`, `ae.revert` |
| Diagnostic | `ae.ping`, `ae.snapshot` |

`ae.previewFrame` is fast viewer capture. It does not run Render Queue or write a true rendered frame. `ae.snapshot` remains the lower-level diagnostic screenshot primitive.

Expression-bearing workflows should run `ae.validateExpressions` before visual review. It force-evaluates expressions and reports `expressionError` or sample failures so agents can catch machine-detectable problems before handing work to users.

### Remaining Gaps

- `ae.previewFrame` captures the visible AE window/viewer area; it is not yet a precise Composition Viewer crop.
- `ae.createRig` is an MVP, not a complete rigging system. Puppet pin null binding, preset libraries, and advanced controller templates are future work.
- The skill system supports persistent CRUD/use, but does not yet include a bundled skill library, import/export, or panel management UI.
- simple RPC intentionally requires both the CEP panel and Python package. A single-install MCP-over-HTTP plugin remains a later productization path.
- ZXP packaging scripts exist, but a clean-machine signed install smoke is still required before public release.

### Install

Document guide:

- [docs/INSTALL.md](docs/INSTALL.md): installation, MCP client config, first-run smoke, and troubleshooting
- [docs/WORKFLOW.md](docs/WORKFLOW.md): how the Agent, MCP server, and AE plugin work together in day-to-day use
- [docs/REFERENCE.md](docs/REFERENCE.md): tool surface, arguments, capability boundaries, and return shapes
- [docs/RELEASE.md](docs/RELEASE.md): ZXP packaging, release smoke, and known pre-release gaps

Developer install:

```powershell
uv sync --all-packages --group dev
cd plugin\host
npm ci
cd ..\..
.\scripts\install-plugin-dev.ps1
```

Restart After Effects, then open `Window -> Extensions -> ae-mcp`. If the goal is to connect an external Agent app, start with [docs/INSTALL.md](docs/INSTALL.md) and [docs/WORKFLOW.md](docs/WORKFLOW.md).

### Test

Non-live:

```powershell
uv run pytest
```

Live, with AE open and the ae-mcp panel green:

```powershell
$env:AE_MCP_LIVE_TESTS = "1"
$env:AE_MCP_BACKEND = "ae-mcp"
$env:AE_MCP_PLUGIN_URL = "http://127.0.0.1:11488"
uv run pytest packages/core/tests/live -o addopts='' -vv
```

### Package

Use Adobe `ZXPSignCmd`:

```powershell
.\scripts\package-zxp.ps1 -ZxpSignCmd C:\Tools\ZXPSignCmd.exe
```

See [docs/RELEASE.md](docs/RELEASE.md) for the release checklist.

### Implementation Notes

ae-mcp is an independent implementation. It does not include code or asset files from other products.

Design goals include:

- Agent-facing AE inspection, mutation, preview, and reusable workflows.
- Fast viewer feedback instead of forcing a true render every time.
- A local automation path built on Adobe CEP, ExtendScript APIs, and the Model Context Protocol.

Third-party components:

- `plugin/client/CSInterface.js` is Adobe CEP `CSInterface` v11 and retains Adobe's original license notice in that file.
- `ae-mcp-snapshot-mss` uses `mss` and Pillow for screen capture.
- The Python bridge uses `httpx`; the CEP host uses Express.

### License

ae-mcp project code is MIT licensed. See [LICENSE](LICENSE).

Files carrying their own upstream license notices, such as Adobe `CSInterface.js`, are governed by those notices.
