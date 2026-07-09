# ae-mcp

[English](README.md) | 简体中文

ae-mcp 是一个**后端无关**的 After Effects 自动化工具，用来让 AE 与 AI agent 保持同一个工作上下文。它通过 MCP server 暴露 AE 工程状态、工具调用、预览、截图和检查点，让 agent 能在对话中理解并操作当前 AE 项目。

MCP server 是核心。在 MCP 本体之外，ae-mcp 还包装了一套 CEP 面板插件，提供面板内对话、后端配置、审批、诊断和首跑安装。你可以根据自己的工作流选择：在外部 agent 后端里通过 MCP 使用 ae-mcp，或者直接在 AE 面板内配置 Claude / Codex / ZCode 后端进行对话。

当前版本线为 **v0.9.0**。

## 支持平台

ae-mcp 仅支持以下平台与宿主矩阵：

- macOS 14.0 Sonoma 或更新版本，原生运行于 Apple Silicon arm64；不支持 Intel Mac 和 Rosetta。
- Windows 11 24H2（11.0.26100）或更新版本，运行于 x64；不支持 Windows ARM。
- After Effects 25.x 和 26.x，对应 CEP host 范围 `[25.0,26.9]`。

## 架构

```text
面板内对话或外部 MCP 客户端
  -> packages/core (ae_mcp, Python stdio MCP server, 32 个 ae_ 工具)
  -> backend (packages/bridge, httpx)
  -> CEP panel Node host (plugin/host, Express, 127.0.0.1:11488)
  -> CSInterface.evalScript
  -> ExtendScript (plugin/jsx/runtime.jsx + jsx_templates/*.jsx)
  -> After Effects
```

`ae_previewFrame` 通过 `CompItem.saveFrameToPng` 渲染真实合成像素，viewer snapshot 只作为 fallback。`packages/snapshot-mss` 提供跨平台 `mss` 截图后端，用于 `ae_snapshot` 屏幕捕获。

MCP core 本身保持后端无关：外部客户端可以通过 stdio server 与 AE 对话，CEP 面板也可以在 AE 内承载内嵌 agent 对话。面板层负责后端配置、审批、诊断、活动历史和首跑依赖安装。Claude、Codex、ZCode 是面板内置后端；OpenCode 和其他工具仍可以作为外部 MCP 客户端接入。

## v0.9.0 更新

- 加入统一 Provider 管理器，把自定义模型 provider 从各个后端的分散设置中收拢到同一处。
- Provider 管理器支持新增、编辑、删除和探测 OpenAI-compatible / Anthropic provider，配置保存在本机 `~/.ae-mcp/providers.json`。
- 重新整理设置页的信息架构：后端凭证通道和可编辑 provider 记录分层展示；可改项可以展开查看和编辑，也可以收起成紧凑状态行，让设置页更容易扫读。
- Claude API 直连、Codex OpenAI-compatible provider、ZCode provider 配置在适用处统一到同一套 provider 管理模型。旧版 Claude BYOK 偏好会自动迁移。
- OpenCode 目前仍作为**外部 MCP 客户端**使用。内嵌 OpenCode 已实现，但在审批 gating 验证完成前暂不暴露。

## 安装和首次启动

普通用户建议先安装 ZXP 面板，再让首跑向导安装本地依赖。

1. 使用 aescripts ZXP Installer 或 ExMan Cmd 安装 ZXP 包。
2. 安装完成后重启 After Effects。
3. 在 AE 中打开 `Window -> Extensions -> ae-mcp`。
4. 按首跑向导完成依赖检测、安装和登录。

首跑向导会自动检测并安装运行所需的本地工具：`uv`、Node、Claude CLI、`ae-mcp`。每条安装命令都会先原文展示，再执行；需要登录时会拉起可见终端窗口。向导装完 Python 侧依赖后不需要再次重启 AE。

ae-mcp 当前不在 PyPI。不要把公共 PyPI 上的同名包作为安装来源。

如果需要从 release tag 直接安装 Python 包：

```powershell
uv tool install --from git+https://github.com/JUNKDOGE-JOE/after-effects-mcp@v0.9.0#subdirectory=packages/core ae-mcp --with git+https://github.com/JUNKDOGE-JOE/after-effects-mcp@v0.9.0#subdirectory=packages/bridge --with git+https://github.com/JUNKDOGE-JOE/after-effects-mcp@v0.9.0#subdirectory=packages/snapshot-mss
```

开发 checkout 中安装：

```powershell
uv tool install --from packages/core ae-mcp --with packages/bridge --with packages/snapshot-mss
```

## 选择并登录后端

ae-mcp 是后端无关的。面板内对话支持三类内嵌后端，按你的账号和工作流选择即可。

| 后端 | 适合场景 | 登录 / 配置方式 |
|---|---|---|
| Claude | 通过 Claude 订阅或 API 直连在面板内运行 agent。 | 本机 Node >= 18，并安装、登录 Claude Code CLI（`claude`）。API 直连需要 Anthropic API key 或兼容 provider。 |
| Codex | 通过 Codex CLI、Codex 配置继承，或 OpenAI-compatible provider 在面板内运行 agent。 | 安装 Codex CLI 并执行 `codex login`，或继承 `~/.codex/config.toml`，也可以在 Provider 管理器中配置自定义 provider。 |
| ZCode | 在面板内使用 ZCode provider。 | 安装 ZCode 桌面端。API key 或 OAuth coding-plan provider 可在面板中使用。 |

这里的 Claude Code 指 Claude Code CLI，不是 Claude Desktop。Claude Desktop 里配置的 MCP 插件不会被内嵌 Claude 后端读取。Codex 也类似：面板读取的是 Codex CLI 状态，或者 ae-mcp 自己的 Provider 管理器配置。

## 主面板

面板最常用的是内嵌对话。你可以直接输入提示词，让 agent 检查工程、创建图层、改属性、写表达式、预览画面或执行更复杂的 AE 自动化任务。

Composer 快捷控制包含：

- 模型选择，带成本标识；会话内切换模型不会清空对话。
- 思考深度，对应后端原生 effort / reasoning 档位。
- 快速模式，用更高 token 消耗换更快响应，具体成本取决于后端厂商定价。
- 审批模式，用于控制工具调用放行策略。

### 审批四档

审批语义由工具 annotations 驱动，跨后端保持一致。

| 模式 | 行为 |
|---|---|
| 只读 | 只放行读取类操作。 |
| 手动 | 每个工具调用都需要确认。 |
| 自动 | 常规操作自动放行，高风险操作仍会拦下确认。 |
| 免审 | 全部自动放行，请谨慎使用。 |

## 活动流与安全

- 活动流会记录 agent 执行过的操作，方便回看发生了什么。
- Kill switch 可以一键熔断所有 AI 操作，发现方向不对时可以立刻停手。
- 撤销仍走 AE 自己的 Undo 体系。插件会尽量把操作封装进 undo group，通常可以直接在 AE 里 `Ctrl+Z`。
- 对风险较高的大改，建议使用 `ae_checkpoint` 或在 `ae_exec` 中传入 `checkpoint_label`，后续可通过 `ae_revert` 回到检查点。检查点功能需要 AE 工程先保存到磁盘。
- 诊断页会检查 host、访问 token、Python 客户端信号、AE project、ExtendScript ping，以及本机 `uv` / `node` / `claude` 可用性。
- 日志导出可以把面板日志、host 信息和 sidecar tail 汇总出来，方便提交 issue 时定位问题。

## 设置项

设置页主要包含：

- 后端凭证通道：Claude / Codex / ZCode 各自的登录状态、API key、provider 和通道优先级。
- Provider 管理器：新增、编辑、删除 OpenAI-compatible 与 Anthropic provider，并通过 `/v1/models` 探测模型列表；可改项支持展开和收起。
- MCP 配置生成：为 Claude Desktop、Claude Code、Cursor、OpenCode、OpenClaw、AstrBot、Gemini Antigravity、ZCode 等外部客户端生成配置。
- 访问 token：面板与 agent 后端之间的握手密钥，普通用户通常不用手动修改。
- 连接来源管理：查看尝试连接面板的后端名称，必要时屏蔽预期外来源，避免串线。
- AE 专家防错指导：在会话开始时向 agent 注入 AE 命令和数据结构提示，以减少脚本错误。它会占用额外输入 token，可按需关闭。

## 截图

<table>
  <tr><td><img src="docs/images/zh-CN/settings-provider-manager-collapsed.png" width="380"><br>设置页：后端通道与收起状态的 Provider 管理器</td><td><img src="docs/images/zh-CN/settings-provider-manager-expanded.png" width="380"><br>设置页：展开编辑 provider，本地保存 API key</td></tr>
  <tr><td><img src="docs/images/zh-CN/settings-general-language.png" width="380"><br>设置页：通用选项、界面语言、日志与关于</td><td><img src="docs/images/zh-CN/wizard-install.png" width="380"><br>首跑向导：安装本地服务并检测 uv / ae-mcp</td></tr>
  <tr><td><img src="docs/images/zh-CN/wizard-connect-clients.png" width="380"><br>首跑向导：选择面板内对话或外部 MCP 客户端</td><td><img src="docs/images/zh-CN/chat-home.png" width="380"><br>聊天首页：启动建议与 composer 快捷选择条</td></tr>
  <tr><td><img src="docs/images/zh-CN/chat-approval.png" width="380"><br>工具审批卡片：高风险操作确认</td><td><img src="docs/images/zh-CN/activity-stream.png" width="380"><br>活动流：agent 操作历史</td></tr>
</table>

## 通过 MCP 接入外部客户端

面板内对话覆盖 Claude、Codex、ZCode 三类后端。如果你使用 Cursor、Claude Desktop、Claude Code、OpenCode、OpenClaw、AstrBot、Gemini Antigravity、ZCode 等外部客户端，可以通过面板生成的 MCP config 接入。

最小配置示例：

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

关键限制：ae-mcp 默认通过 `127.0.0.1:11488` 连到 AE 面板，所以外部客户端必须和 After Effects 在同一台机器上，或者能访问 AE 所在机器的这个端口。OpenClaw、AstrBot 这类常驻或 Docker 化的 IM-bot 框架尤其要注意。

## 工具能力

| 分类 | Tools |
|---|---|
| Project | `ae_init`, `ae_overview`, `ae_layers`, `ae_readProps`, `ae_searchProject` |
| Mutation | `ae_exec`, `ae_applyEffect`, `ae_createLayer`, `ae_setProperty`, `ae_moveLayer`, `ae_selectLayers`, `ae_setTime` |
| Read-typed | `ae_getTime`, `ae_getProperties`, `ae_scanPropertyTree`, `ae_inspectPropertyCapabilities`, `ae_getExpressions`, `ae_validateExpressions`, `ae_getKeyframes` |
| Preview / capture | `ae_previewFrame`, `ae_snapshot` |
| Rigging | `ae_createRig` |
| Skill | `ae_skillList`, `ae_skillCreate`, `ae_skillEdit`, `ae_skillDelete`, `ae_skillUse` |
| Checkpoint | `ae_checkpoint`, `ae_revert` |
| Diagnostic | `ae_ping`, `ae_status`, `ae_diagnose` |

表达式工作流建议先跑 `ae_validateExpressions`，再做视觉检查。大改前建议使用 `ae_checkpoint` 或在 `ae_exec` 上传 `checkpoint_label`。

## 使用建议

AI 目前还不能稳定替代动效师、合成师或设计师的最终判断。更可靠的使用方式是分工协作：

- 人来负责审美把控、画面方向、基础工程结构和最终合成判断。
- AI 更适合处理重复性操作、结构相似工程的批量处理、逻辑性强的程序化动画、表达式编写、工程整理，以及在画面不变的前提下重构工程结构。

做视觉任务时，建议让 agent 多用 `ae_previewFrame` 检查中间结果。做大范围修改前，建议先建检查点。

## 开发

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

## 测试

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

## 打包

发布 ZXP 需要 Adobe `ZXPSignCmd` 和证书密码：

```powershell
.\scripts\package-zxp.ps1 -ZxpSignCmd C:\Tools\ZXPSignCmd.exe -CertPassword <pw>
```

脚本会 staging `plugin/`、移除开发调试文件和 panel 源目录、安装 host/sidecar production dependencies、签名输出 `release/ae-mcp-panel.zxp`。完整发布流程见 [docs/RELEASE.md](docs/RELEASE.md)。

## 实现说明

第三方组件：

- `plugin/client/CSInterface.js` 是 Adobe CEP `CSInterface` v11，文件内保留 Adobe 原始许可声明。
- `ae-mcp-snapshot-mss` 使用 `mss` 和 Pillow 做屏幕截图。
- Python bridge 使用 `httpx`；CEP host 使用 Express；面板 UI 使用 React；Claude sidecar 使用 Claude Agent SDK。

## 开源协议

ae-mcp 项目代码使用 MIT License，见 [LICENSE](LICENSE)。

带有上游许可声明的文件，例如 Adobe `CSInterface.js`，按其文件内许可声明执行。
