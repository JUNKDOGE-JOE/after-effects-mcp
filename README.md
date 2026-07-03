# ae-mcp

## 中文

ae-mcp 是一个**后端无关**的 MCP server，让 AI 客户端驱动 Adobe After Effects。v0.7.0 既支持外部 MCP 客户端，也提供一个完整的 CEP 面板产品：面板内可直接对话、审批工具调用、诊断连接，并一键安装本地依赖。

```text
MCP client
  -> packages/core (ae_mcp, Python stdio MCP server, 31 ae_ tools)
  -> backend (packages/bridge, httpx)
  -> CEP panel Node host (plugin/host, Express, 127.0.0.1:11488)
  -> CSInterface.evalScript
  -> ExtendScript (plugin/jsx/runtime.jsx + jsx_templates/*.jsx)
  -> After Effects
```

`packages/snapshot-mss` 提供跨平台 `mss` 截图后端，用于 `ae.snapshot` / preview 相关能力。

### v0.7.0 状态

- Python stdio MCP server 暴露 31 个 `ae_` 工具，工具名使用下划线形式（例如 `ae_ping`、`ae_previewFrame`），内部仍映射到 `ae.*` verbs。
- CEP 面板不再只是连接配置器：它包含内嵌 AI 对话、composer 便捷选择条、四档审批、首跑向导、活动流、kill switch 和连接诊断。
- 内嵌后端有三类：**Claude 订阅**（默认；面板 spawn 系统 Node 跑 Claude Agent SDK sidecar，复用 `claude` 登录态，零 key / 零 token 落盘）、**BYOK**（用户自己的 Anthropic API key agent loop，可配置 Anthropic-compatible Base URL）、**Codex**（spawn `codex app-server`，可复用 Codex 登录态，也可配置 OpenAI-compatible 自定义 provider）。
- OpenCode 在 v0.7.0 是**外接 MCP 客户端**，不是内嵌后端；内嵌 OpenCode 计划延后到 v0.7.1。
- 外部客户端可通过面板生成的 MCP config 接入：Claude Desktop、Claude Code、Cursor、OpenCode、OpenClaw、AstrBot、Gemini Antigravity 等。

OpenClaw、AstrBot 等 IM-bot 框架常驻或 Docker 化时，未必和 After Effects 在同一台机器。ae-mcp 默认通过 `127.0.0.1:11488` 打到 AE 面板，所以外接客户端必须与 AE 同机，或能访问该端口。

### 面板能力

- 内嵌聊天：Claude 订阅 / BYOK / Codex。
- Composer 选择条：模型（带成本标识，会话内切换不清空对话）、思考深度（后端原生 effort 档位）、快速模式、审批档。
- 审批四档：只读、手动、自动、免审。审批语义由工具 annotations 驱动，跨后端一致。
- 首跑向导：检测并安装 `uv`、Node、Claude CLI、ae-mcp；安装命令会先原文展示；登录会拉起可见终端；安装后不需要重启 AE。
- 活动流和 kill switch：可熔断所有 AI 操作。
- 连接诊断：检查 host、token、Python 客户端信号、AE project、ExtendScript ping，并检测 `uv` / `node` / `claude`。

### Tool Surface

| 分类 | Tools |
|---|---|
| Project | `ae_init`, `ae_overview`, `ae_layers`, `ae_readProps`, `ae_searchProject` |
| Mutation | `ae_exec`, `ae_applyEffect`, `ae_createLayer`, `ae_setProperty`, `ae_moveLayer`, `ae_selectLayers`, `ae_setTime` |
| Read-typed | `ae_getTime`, `ae_getProperties`, `ae_scanPropertyTree`, `ae_inspectPropertyCapabilities`, `ae_getExpressions`, `ae_validateExpressions`, `ae_getKeyframes` |
| Preview / capture | `ae_previewFrame`, `ae_snapshot` |
| Rigging | `ae_createRig` |
| Skill | `ae_skillList`, `ae_skillCreate`, `ae_skillEdit`, `ae_skillDelete`, `ae_skillUse` |
| Checkpoint | `ae_checkpoint`, `ae_revert` |
| Diagnostic | `ae_ping`, `ae_status` |

表达式工作流建议先跑 `ae_validateExpressions`，再做视觉检查。大改前建议使用 `ae_checkpoint` 或在 `ae_exec` 上传 `checkpoint_label`。

### 安装

ae-mcp 当前不在 PyPI。不要使用公共 PyPI 上的同名包作为安装来源。

开发 checkout 中安装 Python 三件套：

```powershell
uv tool install --from packages/core ae-mcp --with packages/bridge --with packages/snapshot-mss
```

终端用户从发布 tag 安装：

```powershell
uv tool install --from git+https://github.com/JUNKDOGE-JOE/after-effects-mcp@v0.8.2#subdirectory=packages/core ae-mcp --with git+https://github.com/JUNKDOGE-JOE/after-effects-mcp@v0.8.2#subdirectory=packages/bridge --with git+https://github.com/JUNKDOGE-JOE/after-effects-mcp@v0.8.2#subdirectory=packages/snapshot-mss
```

面板安装使用 ZXP 包：推荐 aescripts ZXP Installer，也可用 ExMan Cmd。安装后打开 `Window -> Extensions -> ae-mcp`。

内嵌后端额外要求：

- Claude 订阅：本机 Node >= 18，已安装并登录 Claude Code（`claude`）。
- BYOK：Anthropic API key；需要代理或兼容服务时可在设置里填写 API Base URL 和自定义模型 ID。
- Codex：已安装 Codex CLI。官方账号路径需要 `codex login`；自定义 provider 路径在设置里填写 API Base URL、API Key 和模型 ID。

外部 MCP 客户端配置示例：

```json
{
  "mcpServers": {
    "ae": {
      "command": "ae-mcp",
      "env": {
        "AE_MCP_BACKEND": "ae-mcp",
        "AE_MCP_PLUGIN_URL": "http://127.0.0.1:11488"
      }
    }
  }
}
```

### 开发

仓库开发环境：

```powershell
uv sync --all-packages --group dev
cd plugin\host
npm ci
cd ..\sidecar
npm ci
cd ..\panel
npm ci
npm run build
cd ..\..
.\scripts\install-plugin-dev.ps1
```

macOS 开发脚本存在，但 v0.7.0 主要验证面仍以 Windows + AE live 为准。

### 测试

非 live 测试：

```powershell
uv run pytest
```

live 测试需要 AE 打开且 ae-mcp 面板运行：

```powershell
$env:AE_MCP_LIVE_TESTS = "1"
$env:AE_MCP_BACKEND = "ae-mcp"
$env:AE_MCP_PLUGIN_URL = "http://127.0.0.1:11488"
uv run pytest packages/core/tests/live -o addopts='' -vv
```

模型矩阵 smoke（Claude sidecar + Codex app-server）：

```powershell
node scripts/live-model-matrix.mjs
```

### 打包

发布 ZXP 需要 Adobe `ZXPSignCmd` 和证书密码：

```powershell
.\scripts\package-zxp.ps1 -ZxpSignCmd C:\Tools\ZXPSignCmd.exe -CertPassword <pw>
```

脚本会 staging `plugin/`、移除开发调试文件和 panel 源目录、安装 host/sidecar production dependencies、签名输出 `release/ae-mcp-panel.zxp`。完整发布流程见 [docs/RELEASE.md](docs/RELEASE.md)。

### 实现说明

ae-mcp 是独立实现，不包含其他产品的代码或资源文件。

第三方组件：

- `plugin/client/CSInterface.js` 是 Adobe CEP `CSInterface` v11，文件内保留 Adobe 原始许可声明。
- `ae-mcp-snapshot-mss` 使用 `mss` 和 Pillow 做屏幕截图。
- Python bridge 使用 `httpx`；CEP host 使用 Express；面板 UI 使用 React；Claude sidecar 使用 Claude Agent SDK。

### 开源协议

ae-mcp 项目代码使用 MIT License，见 [LICENSE](LICENSE)。

带有上游许可声明的文件，例如 Adobe `CSInterface.js`，按其文件内许可声明执行。

## English

ae-mcp is a **backend-agnostic** MCP server for driving Adobe After Effects from AI clients. In v0.7.0 it supports both external MCP clients and a full CEP panel product: built-in chat, tool approvals, connection diagnostics, and one-click local setup.

```text
MCP client
  -> packages/core (ae_mcp, Python stdio MCP server, 31 ae_ tools)
  -> backend (packages/bridge, httpx)
  -> CEP panel Node host (plugin/host, Express, 127.0.0.1:11488)
  -> CSInterface.evalScript
  -> ExtendScript (plugin/jsx/runtime.jsx + jsx_templates/*.jsx)
  -> After Effects
```

`packages/snapshot-mss` provides the cross-platform `mss` screenshot backend used by `ae.snapshot` / preview-related features.

### v0.7.0 Status

- The Python stdio MCP server exposes 31 `ae_` tools. MCP tool names use underscores, such as `ae_ping` and `ae_previewFrame`; internally they still map to `ae.*` verbs.
- The CEP panel is no longer just a connection configurator. It includes built-in AI chat, composer controls, four approval modes, a first-run wizard, an activity stream, a kill switch, and connection diagnostics.
- Embedded backends: **Claude subscription** (default; the panel spawns system Node to run a Claude Agent SDK sidecar, reusing the local `claude` login with no key/token stored), **BYOK** (Anthropic API key agent loop with an optional Anthropic-compatible base URL), and **Codex** (spawns `codex app-server`, reusing the Codex login or an OpenAI-compatible custom provider).
- OpenCode is an **external MCP client** in v0.7.0, not an embedded backend. Embedded OpenCode is deferred to v0.7.1.
- External clients can connect through the panel-generated MCP config: Claude Desktop, Claude Code, Cursor, OpenCode, OpenClaw, AstrBot, Gemini Antigravity, and similar clients.

Long-running or Dockerized IM-bot frameworks such as OpenClaw and AstrBot may not run on the same machine as After Effects. ae-mcp reaches AE through `127.0.0.1:11488`, so the external client must run on the AE machine or otherwise be able to reach that port.

### Panel Features

- Built-in chat: Claude subscription / BYOK / Codex.
- Composer controls: model with cost badges, per-session model switching without clearing the conversation, native reasoning effort, fast mode, and approval mode.
- Approval modes: read-only, manual, auto, bypass. Tool annotations drive consistent behavior across backends.
- First-run wizard: detects and installs `uv`, Node, Claude CLI, and ae-mcp; shows commands verbatim before running; opens visible login terminals; no AE restart required after Python-side install.
- Activity stream and kill switch for stopping all AI operations.
- Diagnostics for host, token, Python client signal, AE project, ExtendScript ping, plus `uv` / `node` / `claude` detection.

### Tool Surface

| Category | Tools |
|---|---|
| Project | `ae_init`, `ae_overview`, `ae_layers`, `ae_readProps`, `ae_searchProject` |
| Mutation | `ae_exec`, `ae_applyEffect`, `ae_createLayer`, `ae_setProperty`, `ae_moveLayer`, `ae_selectLayers`, `ae_setTime` |
| Read-typed | `ae_getTime`, `ae_getProperties`, `ae_scanPropertyTree`, `ae_inspectPropertyCapabilities`, `ae_getExpressions`, `ae_validateExpressions`, `ae_getKeyframes` |
| Preview / capture | `ae_previewFrame`, `ae_snapshot` |
| Rigging | `ae_createRig` |
| Skill | `ae_skillList`, `ae_skillCreate`, `ae_skillEdit`, `ae_skillDelete`, `ae_skillUse` |
| Checkpoint | `ae_checkpoint`, `ae_revert` |
| Diagnostic | `ae_ping`, `ae_status` |

Expression workflows should run `ae_validateExpressions` before visual review. For risky edits, use `ae_checkpoint` or pass `checkpoint_label` to `ae_exec`.

### Install

ae-mcp is not on PyPI. Do not use the public PyPI name as the install source.

Install the three Python packages from a development checkout:

```powershell
uv tool install --from packages/core ae-mcp --with packages/bridge --with packages/snapshot-mss
```

End users install from the release tag:

```powershell
uv tool install --from git+https://github.com/JUNKDOGE-JOE/after-effects-mcp@v0.8.2#subdirectory=packages/core ae-mcp --with git+https://github.com/JUNKDOGE-JOE/after-effects-mcp@v0.8.2#subdirectory=packages/bridge --with git+https://github.com/JUNKDOGE-JOE/after-effects-mcp@v0.8.2#subdirectory=packages/snapshot-mss
```

Install the panel from the ZXP package with aescripts ZXP Installer or ExMan Cmd. Then open `Window -> Extensions -> ae-mcp`.

Embedded backend requirements:

- Claude subscription: local Node >= 18 and a logged-in Claude Code CLI (`claude`).
- BYOK: an Anthropic API key; set API Base URL and a custom model ID in Settings when using a compatible proxy/provider.
- Codex: an installed Codex CLI. The official account path needs `codex login`; the custom-provider path uses API Base URL, API key, and model ID from Settings.

External MCP client config:

```json
{
  "mcpServers": {
    "ae": {
      "command": "ae-mcp",
      "env": {
        "AE_MCP_BACKEND": "ae-mcp",
        "AE_MCP_PLUGIN_URL": "http://127.0.0.1:11488"
      }
    }
  }
}
```

### Development

Repository development setup:

```powershell
uv sync --all-packages --group dev
cd plugin\host
npm ci
cd ..\sidecar
npm ci
cd ..\panel
npm ci
npm run build
cd ..\..
.\scripts\install-plugin-dev.ps1
```

The macOS development script exists, but v0.7.0 validation is primarily Windows + AE live.

### Test

Non-live:

```powershell
uv run pytest
```

Live, with AE open and the ae-mcp panel running:

```powershell
$env:AE_MCP_LIVE_TESTS = "1"
$env:AE_MCP_BACKEND = "ae-mcp"
$env:AE_MCP_PLUGIN_URL = "http://127.0.0.1:11488"
uv run pytest packages/core/tests/live -o addopts='' -vv
```

Model-matrix smoke for Claude sidecar + Codex app-server:

```powershell
node scripts/live-model-matrix.mjs
```

### Package

Packaging a release ZXP requires Adobe `ZXPSignCmd` and a certificate password:

```powershell
.\scripts\package-zxp.ps1 -ZxpSignCmd C:\Tools\ZXPSignCmd.exe -CertPassword <pw>
```

The script stages `plugin/`, strips development debug files and panel source, installs host/sidecar production dependencies, signs the package, and writes `release/ae-mcp-panel.zxp`. See [docs/RELEASE.md](docs/RELEASE.md) for the full release checklist.

### Implementation Notes

ae-mcp is an independent implementation. It does not include code or asset files from other products.

Third-party components:

- `plugin/client/CSInterface.js` is Adobe CEP `CSInterface` v11 and retains Adobe's original license notice in that file.
- `ae-mcp-snapshot-mss` uses `mss` and Pillow for screen capture.
- The Python bridge uses `httpx`; the CEP host uses Express; the panel UI uses React; the Claude sidecar uses the Claude Agent SDK.

### License

ae-mcp project code is MIT licensed. See [LICENSE](LICENSE).

Files carrying their own upstream license notices, such as Adobe `CSInterface.js`, are governed by those notices.
