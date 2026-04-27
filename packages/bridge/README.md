# ae-mcp-bridge

## 中文

`ae-mcp-bridge` 是 `ae-mcp` MCP server 和 `ae-mcp` CEP 插件之间的 HTTP bridge。

默认连接 `http://127.0.0.1:11488`，可通过 `AE_MCP_PLUGIN_URL` 修改。CEP 插件提供 `/health` 和 `/exec` endpoint；本包把它们包装成 ae-mcp core 的 `Backend` 实现。

### 使用

```text
AE_MCP_BACKEND=ae-mcp
AE_MCP_PLUGIN_URL=http://127.0.0.1:11488
```

### 协议

MIT。

## English

`ae-mcp-bridge` is the HTTP bridge between the `ae-mcp` MCP server and the `ae-mcp` CEP plugin.

It talks to `http://127.0.0.1:11488` by default, configurable through `AE_MCP_PLUGIN_URL`. The CEP plugin exposes `/health` and `/exec`; this package wraps those endpoints as an ae-mcp core `Backend`.

### Usage

```text
AE_MCP_BACKEND=ae-mcp
AE_MCP_PLUGIN_URL=http://127.0.0.1:11488
```

### License

MIT.
