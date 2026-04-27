# ae-mcp 安装 / Install

## 中文

ae-mcp 使用 simple RPC 链路：

```text
MCP client -> Python ae-mcp -> HTTP 127.0.0.1:11488 -> CEP panel -> AE ExtendScript
```

### 开发安装

在仓库根目录运行：

```powershell
uv sync --all-packages --group dev
cd plugin\host
npm ci
cd ..\..
.\scripts\install-plugin-dev.ps1
```

重启 After Effects，然后打开 `Window -> Extensions -> ae-mcp`。面板应显示绿色状态：`Listening on 127.0.0.1:11488`。

### MCP 客户端配置

可以使用面板里显示的配置块，或手动配置：

```json
{
  "ae": {
    "command": "python",
    "args": ["-m", "ae_mcp"],
    "env": {
      "AE_MCP_BACKEND": "ae-mcp",
      "AE_MCP_PLUGIN_URL": "http://127.0.0.1:11488"
    }
  }
}
```

先运行 `ae.ping`，再在简单 comp 里试 `ae.previewFrame` 和 `ae.createRig`。

### 预期 smoke 结果

AE 打开且面板绿灯时，完整 live suite 应通过：

```powershell
$env:AE_MCP_LIVE_TESTS = "1"
$env:AE_MCP_BACKEND = "ae-mcp"
$env:AE_MCP_PLUGIN_URL = "http://127.0.0.1:11488"
uv run pytest packages/core/tests/live -o addopts='' -vv
```

当前预期结果：`20 passed`。

### 排障

- 菜单里没有面板：重新运行 `scripts/install-plugin-dev.ps1`，然后重启 AE。
- 面板红灯：查看面板里的 `Last error` 和日志区域。
- 端口冲突：在面板中修改端口，并同步更新 `AE_MCP_PLUGIN_URL`。
- `evalScript` 超时：先关闭 AE 模态弹窗；如果仍然卡住，重启 AE。
- `ae.snapshot` 是诊断截图；`ae.previewFrame` 是快速 viewer capture，不是真实渲染。

## English

ae-mcp uses the simple RPC path:

```text
MCP client -> Python ae-mcp -> HTTP 127.0.0.1:11488 -> CEP panel -> AE ExtendScript
```

### Developer Install

Run from the repository root:

```powershell
uv sync --all-packages --group dev
cd plugin\host
npm ci
cd ..\..
.\scripts\install-plugin-dev.ps1
```

Restart After Effects, then open `Window -> Extensions -> ae-mcp`. The panel should show a green status line: `Listening on 127.0.0.1:11488`.

### MCP Client Config

Use the block shown in the panel, or configure manually:

```json
{
  "ae": {
    "command": "python",
    "args": ["-m", "ae_mcp"],
    "env": {
      "AE_MCP_BACKEND": "ae-mcp",
      "AE_MCP_PLUGIN_URL": "http://127.0.0.1:11488"
    }
  }
}
```

Run `ae.ping` first. Then try `ae.previewFrame` and `ae.createRig` in a simple comp.

### Expected Smoke Result

With After Effects open and the panel green, the full local live suite should pass:

```powershell
$env:AE_MCP_LIVE_TESTS = "1"
$env:AE_MCP_BACKEND = "ae-mcp"
$env:AE_MCP_PLUGIN_URL = "http://127.0.0.1:11488"
uv run pytest packages/core/tests/live -o addopts='' -vv
```

Current expected result: `20 passed`.

### Troubleshooting

- Panel missing from the menu: rerun `scripts/install-plugin-dev.ps1`, then restart AE.
- Panel red: read the panel `Last error` line and log area.
- Port conflict: edit the port in the panel and update `AE_MCP_PLUGIN_URL`.
- `evalScript` timeouts: close AE modal dialogs first; restart AE if calls still hang.
- `ae.snapshot` is diagnostic capture. `ae.previewFrame` is fast viewer capture, not a true render.
