# ae-mcp-jkdg

`ae-mcp-jkdg` is a dependency-free stdio connector for the local MCP server
hosted by the ae-mcp panel inside After Effects. It is not the MCP server or the
After Effects extension itself.

## Prerequisites

Install the ae-mcp ZXP from the
[GitHub Releases](https://github.com/JUNKDOGE-JOE/after-effects-mcp/releases),
start After Effects, and keep **Window > Extensions > ae-mcp** open while the
client is connected. If you need `ae_nativeExec`, install the matching native
plug-in separately: the `.aex` on Windows or the `AeMcpNative.plugin` bundle on
macOS. The ZXP does not contain either platform's native plug-in.

## Claude Desktop

```json
{
  "mcpServers": {
    "ae": {
      "command": "npx",
      "args": ["-y", "ae-mcp-jkdg"]
    }
  }
}
```

This package requires Node.js 18 or later. It forwards stdio JSON-RPC to
`http://127.0.0.1:11488/mcp` by default.

Claude Code, Cursor, and other clients with Streamable HTTP support do not need
this connector. For example, Claude Code can connect directly:

```bash
claude mcp add --transport http ae http://127.0.0.1:11488/mcp
```

## Custom endpoint

Set `AE_MCP_HTTP_URL` or pass `--url=<http url>`:

```bash
npx -y ae-mcp-jkdg --url=http://127.0.0.1:11488/mcp
```

If the connector reports that the panel is unreachable, confirm that After
Effects is running, the ae-mcp panel is open, and the configured port matches
the panel host.

## 中文

本包只是把 stdio 转发到本机 ae-mcp 面板，不包含 After Effects 扩展本体。请先从
GitHub Releases 安装 ZXP，并在连接期间保持 **Window > Extensions > ae-mcp**
面板打开。如需 `ae_nativeExec`，还须另装对应平台的原生插件：Windows 使用
`.aex`，macOS 使用 `AeMcpNative.plugin` 包。端口不是默认值时，可设置
`AE_MCP_HTTP_URL` 或使用 `--url`。
