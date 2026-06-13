# ae-mcp-bridge

## 中文

`ae-mcp-bridge` 是 `ae-mcp` Python MCP server 到 AE CEP 面板的 HTTP backend。它通过 Python entry point 提供 backend 名称 `ae-mcp`，让 `packages/core` 的 31 个 `ae_` 工具可以调用本机面板。

默认连接：

```text
http://127.0.0.1:11488
```

可用环境变量修改：

```text
AE_MCP_BACKEND=ae-mcp
AE_MCP_PLUGIN_URL=http://127.0.0.1:11488
```

链路：

```text
ae_mcp server -> ae-mcp-bridge (httpx) -> plugin/host Express -> CSInterface.evalScript -> ExtendScript
```

本包只负责 HTTP backend，不包含 CEP 面板、内嵌 AI 对话或截图实现。截图 backend 在 `ae-mcp-snapshot-mss`。

### 安装

ae-mcp 当前不在 PyPI。开发 checkout 中应与 core 和 snapshot 一起安装：

```powershell
uv tool install --from packages/core ae-mcp --with packages/bridge --with packages/snapshot-mss
```

发布 tag 安装示例见根目录 README 和面板首跑向导。不要单独用公共 PyPI 名称安装 `ae-mcp`。

### 协议

MIT。

## English

`ae-mcp-bridge` is the HTTP backend from the `ae-mcp` Python MCP server to the AE CEP panel. It provides the Python entry point named `ae-mcp`, allowing the 31 `ae_` tools in `packages/core` to call the local panel.

Default target:

```text
http://127.0.0.1:11488
```

Environment:

```text
AE_MCP_BACKEND=ae-mcp
AE_MCP_PLUGIN_URL=http://127.0.0.1:11488
```

Path:

```text
ae_mcp server -> ae-mcp-bridge (httpx) -> plugin/host Express -> CSInterface.evalScript -> ExtendScript
```

This package is only the HTTP backend. It does not include the CEP panel, embedded AI chat, or screenshot implementation. The screenshot backend lives in `ae-mcp-snapshot-mss`.

### Install

ae-mcp is not on PyPI. From a development checkout, install it together with core and snapshot:

```powershell
uv tool install --from packages/core ae-mcp --with packages/bridge --with packages/snapshot-mss
```

For release-tag installation, see the root README and the panel first-run wizard. Do not install `ae-mcp` from the public PyPI name.

### License

MIT.
