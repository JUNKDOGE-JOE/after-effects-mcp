# ae-mcp 安装 / Install

## 中文

ae-mcp 使用 simple RPC 链路：

```text
MCP client -> ae-mcp launcher -> Python ae_mcp server -> HTTP 127.0.0.1:11488 -> CEP panel -> AE ExtendScript
```

这条链路有两个独立安装面：

1. AE 侧插件：CEP 面板，负责开本地 HTTP host 并把请求转给 ExtendScript。
2. Agent 侧 MCP server：`ae-mcp` 命令，负责把 MCP 工具请求转成对面板的 HTTP 调用。

如果只装其中一边，用户的 Agent 都无法真正驱动 AE。

### 平台状态

- Windows 是当前唯一做过 CI 和 live 验证的平台。
- macOS 已补安装脚本、路径和文档，但还没有进行实机验证。
- 如果你在 macOS 上试跑发现问题，请提 GitHub issue，并附上 AE 版本、macOS 版本、Python 版本和面板日志。

### 开发安装

在仓库根目录运行：

```powershell
uv sync --all-packages --group dev
cd plugin\host
npm ci
cd ..\..
.\scripts\install-plugin-dev.ps1
```

这适合仓库维护者和本地开发。它会把 workspace 里的 `ae-mcp`、`ae-mcp-bridge` 和 `ae-mcp-snapshot-mss` 都装进当前环境。

macOS 开发安装脚本：

```bash
uv sync --all-packages --group dev
cd plugin/host
npm ci
cd ../..
./scripts/install-plugin-dev-macos.sh
```

这个 macOS 脚本会：

- 向 `com.adobe.CSXS.*` 写入 `PlayerDebugMode=1`
- 把 `plugin/` 复制到 `~/Library/Application Support/Adobe/CEP/extensions/com.aemcp.panel`

注意：这条路径目前未做实机验证。

### 用户安装：让 Agent 接入

如果你是从仓库 checkout 直接使用，而不是在这个仓库里开发，推荐分两步：

1. 安装 Python 侧 MCP 组件到你的 Agent 可见环境：

```powershell
pip install .\packages\core .\packages\bridge .\packages\snapshot-mss
```

macOS shell 示例：

```bash
pip install ./packages/core ./packages/bridge ./packages/snapshot-mss
```

这一步会提供：

- `ae-mcp` launcher
- `ae-mcp` backend entry point
- `ae.previewFrame` 需要的 snapshotter

> **三个包必须一起安装。** `ae-mcp-bridge` 和 `ae-mcp-snapshot-mss` 在各自的
> `pyproject.toml` 里按名字依赖 `ae-mcp>=0.3.0`，而这个名字在 PyPI 上并不存在
> （仓库尚未发布到 PyPI）。所以不要单独跑 `pip install ./packages/bridge`，
> 那会因为找不到 `ae-mcp` 而失败。请把三个路径放在同一条 `pip install` 命令里
> （core 在最前，让 bridge/snapshot 的依赖在同一次解析中就地命中），或者用
> `uv sync --all-packages`（见上方开发安装）。
>
> **供应链提示：** 一旦 `ae-mcp` 这个名字以后被发布到公共 PyPI，第三方就可能抢注
> 同名包。在该名字由本项目正式发布前，请始终从本仓库的本地路径安装这三个包，
> 不要让 pip 去公共索引拉取名为 `ae-mcp` 的包。

2. 安装并打开 AE 面板：

```powershell
cd plugin\host
npm ci
cd ..\..
.\scripts\install-plugin-dev.ps1
```

macOS shell 示例：

```bash
cd plugin/host
npm ci
cd ../..
./scripts/install-plugin-dev-macos.sh
```

然后重启 After Effects，打开 `Window -> Extensions -> ae-mcp`。面板应显示绿色状态：`Listening on 127.0.0.1:11488`。

### MCP 客户端配置

推荐使用 `ae-mcp` launcher，而不是 `python -m ae_mcp`。

原因：

- `ae-mcp` 更适合 GUI 启动的 Agent app。
- 它避免依赖某个特定 shell/venv 是否被继承。
- 如果你的 Agent app 不继承 PATH，可以把 `command` 改成已安装 launcher 的完整路径；Windows 通常是 `ae-mcp.exe`，macOS/Linux 通常是 `ae-mcp`。

默认配置：

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

如果端口在面板里改过，记得同步更新 `AE_MCP_PLUGIN_URL`。

### 首次接入 smoke

1. 启动 After Effects。
2. 打开 `Window -> Extensions -> ae-mcp`。
3. 确认面板绿灯。
4. 把面板里的 `MCP config` 复制到你的 Agent 客户端配置文件。
5. 在 Agent 里先运行 `ae.ping`。
6. 再在一个简单 comp 里试 `ae.previewFrame` 和 `ae.createRig`。

更完整的日常协作流程见 [docs/WORKFLOW.md](WORKFLOW.md)。

### 预期 smoke 结果

AE 打开且面板绿灯时，完整 live suite 应通过：

```powershell
$env:AE_MCP_LIVE_TESTS = "1"
$env:AE_MCP_BACKEND = "ae-mcp"
$env:AE_MCP_PLUGIN_URL = "http://127.0.0.1:11488"
uv run pytest packages/core/tests/live -o addopts='' -vv
```

当前预期结果：`24 passed`。

### 排障

- 菜单里没有面板：重新运行 `scripts/install-plugin-dev.ps1`，然后重启 AE。
- macOS 菜单里没有面板：重新运行 `scripts/install-plugin-dev-macos.sh`，然后重启 AE。
- 面板红灯：查看面板里的 `Last error` 和日志区域。
- `ae-mcp` 命令找不到：把 `command` 改成安装环境里的 launcher 绝对路径；Windows 通常是 `ae-mcp.exe`，macOS/Linux 通常是 `ae-mcp`。
- 报 `AE_MCP_BACKEND='ae-mcp' but no such backend installed`：说明当前 Python 环境缺 `ae-mcp-bridge`。
- 端口冲突：在面板中修改端口，并同步更新 `AE_MCP_PLUGIN_URL`。面板会把改过的端口记到 `localStorage`，重启后仍然保留（不会再被重置回 11488）。
- `evalScript` 超时：先关闭 AE 模态弹窗；如果仍然卡住，重启 AE。
- `ae.snapshot` 是诊断截图；`ae.previewFrame` 是快速 viewer capture，不是真实渲染。
- macOS 试跑问题：请提 GitHub issue，并附上 AE 版本、macOS 版本、Python 版本和面板日志。

## English

ae-mcp uses the simple RPC path:

```text
MCP client -> ae-mcp launcher -> Python ae_mcp server -> HTTP 127.0.0.1:11488 -> CEP panel -> AE ExtendScript
```

This path has two separate install surfaces:

1. The AE-side plugin: a CEP panel that exposes the local HTTP host and forwards work into ExtendScript.
2. The Agent-side MCP server: the `ae-mcp` command that translates MCP tool calls into HTTP requests to the panel.

If either side is missing, the user's Agent cannot actually drive After Effects.

### Platform Status

- Windows is the only platform currently covered by CI and live verification.
- macOS now has an install script, documented paths, and setup guidance, but has not yet been hardware-verified.
- If you try the macOS path and hit issues, please open a GitHub issue with your AE version, macOS version, Python version, and panel logs.

### Developer Install

Run from the repository root:

```powershell
uv sync --all-packages --group dev
cd plugin\host
npm ci
cd ..\..
.\scripts\install-plugin-dev.ps1
```

This is for maintainers and local development. It installs the workspace copies of `ae-mcp`, `ae-mcp-bridge`, and `ae-mcp-snapshot-mss` into the active environment.

macOS developer install script:

```bash
uv sync --all-packages --group dev
cd plugin/host
npm ci
cd ../..
./scripts/install-plugin-dev-macos.sh
```

This macOS script:

- writes `PlayerDebugMode=1` into `com.adobe.CSXS.*`
- copies `plugin/` into `~/Library/Application Support/Adobe/CEP/extensions/com.aemcp.panel`

Note: this path is not yet hardware-verified.

### User Install: connect an Agent

If you are using the repo checkout directly rather than developing inside this repo, use two steps:

1. Install the Python-side MCP components into the environment your Agent app can launch:

```powershell
pip install .\packages\core .\packages\bridge .\packages\snapshot-mss
```

macOS shell example:

```bash
pip install ./packages/core ./packages/bridge ./packages/snapshot-mss
```

This provides:

- the `ae-mcp` launcher
- the `ae-mcp` backend entry point
- the snapshotter required by `ae.previewFrame`

> **The three packages must be installed together.** `ae-mcp-bridge` and
> `ae-mcp-snapshot-mss` declare a by-name dependency on `ae-mcp>=0.3.0` in their
> `pyproject.toml`, but that name is not published on PyPI (this repo is not on
> PyPI yet). A standalone `pip install ./packages/bridge` therefore fails — pip
> cannot resolve `ae-mcp`. Pass all three paths in a single `pip install`
> command (core first, so the bridge/snapshot dependency resolves against the
> local copy in the same run), or use `uv sync --all-packages` (see Developer
> Install above).
>
> **Supply-chain note:** if the name `ae-mcp` is ever published to the public
> PyPI by someone else, a third party could squat that name. Until this project
> formally publishes the name, always install the three packages from this
> repo's local paths and do not let pip pull an `ae-mcp` package from the public
> index.

2. Install and open the AE panel:

```powershell
cd plugin\host
npm ci
cd ..\..
.\scripts\install-plugin-dev.ps1
```

macOS shell example:

```bash
cd plugin/host
npm ci
cd ../..
./scripts/install-plugin-dev-macos.sh
```

Then restart After Effects and open `Window -> Extensions -> ae-mcp`. The panel should show a green status line: `Listening on 127.0.0.1:11488`.

### MCP Client Config

Prefer the `ae-mcp` launcher instead of `python -m ae_mcp`.

Why:

- `ae-mcp` is more reliable for GUI-launched Agent apps.
- It avoids depending on a specific shell or inherited virtualenv.
- If your Agent app does not inherit PATH, replace `command` with the full path to the installed launcher; on Windows this is usually `ae-mcp.exe`, while on macOS/Linux it is usually `ae-mcp`.

Default config:

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

If you change the panel port, update `AE_MCP_PLUGIN_URL` to match.

### First-Run Smoke

1. Launch After Effects.
2. Open `Window -> Extensions -> ae-mcp`.
3. Confirm the panel is green.
4. Copy the `MCP config` block from the panel into your Agent client's config file.
5. Run `ae.ping` first from the Agent.
6. Then try `ae.previewFrame` and `ae.createRig` in a simple comp.

For the day-to-day collaboration flow, see [docs/WORKFLOW.md](WORKFLOW.md).

### Expected Smoke Result

With After Effects open and the panel green, the full local live suite should pass:

```powershell
$env:AE_MCP_LIVE_TESTS = "1"
$env:AE_MCP_BACKEND = "ae-mcp"
$env:AE_MCP_PLUGIN_URL = "http://127.0.0.1:11488"
uv run pytest packages/core/tests/live -o addopts='' -vv
```

Current expected result: `24 passed`.

### Troubleshooting

- Panel missing from the menu: rerun `scripts/install-plugin-dev.ps1`, then restart AE.
- Panel missing on macOS: rerun `scripts/install-plugin-dev-macos.sh`, then restart AE.
- Panel red: read the panel `Last error` line and log area.
- `ae-mcp` command not found: change `command` to the absolute path of the installed launcher; on Windows this is usually `ae-mcp.exe`, while on macOS/Linux it is usually `ae-mcp`.
- `AE_MCP_BACKEND='ae-mcp' but no such backend installed`: the current Python environment is missing `ae-mcp-bridge`.
- Port conflict: edit the port in the panel and update `AE_MCP_PLUGIN_URL`. The panel persists the changed port in `localStorage`, so it survives a restart (it no longer resets to 11488).
- `evalScript` timeouts: close AE modal dialogs first; restart AE if calls still hang.
- `ae.snapshot` is diagnostic capture. `ae.previewFrame` is fast viewer capture, not a true render.
- macOS trial issues: please open a GitHub issue with your AE version, macOS version, Python version, and panel logs.
