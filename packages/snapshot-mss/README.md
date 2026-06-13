# ae-mcp-snapshot-mss

## 中文

`ae-mcp-snapshot-mss` 是 ae-mcp 的跨平台截图 backend，基于 [mss](https://python-mss.readthedocs.io/) 和 Pillow。它通过 Python entry point 注册 snapshotter `mss`，供 `ae.snapshot` 和 preview 相关流程使用。

当前实现按屏幕区域截图；Windows 下可通过 HWND 转换到窗口矩形。它不是 AE Render Queue，也不负责 CEP 面板或 MCP server。

### 安装

ae-mcp 当前不在 PyPI。开发 checkout 中应与 core 和 bridge 一起安装：

```powershell
uv tool install --from packages/core ae-mcp --with packages/bridge --with packages/snapshot-mss
```

发布 tag 安装示例见根目录 README 和面板首跑向导。不要把单独的 PyPI 包名作为终端用户安装路径。

### 协议

MIT。

## English

`ae-mcp-snapshot-mss` is the cross-platform screenshot backend for ae-mcp, built on [mss](https://python-mss.readthedocs.io/) and Pillow. It registers the `mss` snapshotter through a Python entry point for `ae.snapshot` and preview-related flows.

The current implementation captures by screen rectangle; on Windows, HWND can be translated to a window rectangle. It is not AE Render Queue, and it does not provide the CEP panel or MCP server.

### Install

ae-mcp is not on PyPI. From a development checkout, install it together with core and bridge:

```powershell
uv tool install --from packages/core ae-mcp --with packages/bridge --with packages/snapshot-mss
```

For release-tag installation, see the root README and the panel first-run wizard. Do not use the standalone PyPI package name as the end-user install path.

### License

MIT.
