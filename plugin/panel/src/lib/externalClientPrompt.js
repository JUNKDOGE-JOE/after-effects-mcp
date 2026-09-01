const PROMPTS = {
  zh: ({ url, shimPath }) => `帮我把 After Effects 接进来。ae-mcp 面板已经在这台机器上运行，MCP 服务地址是 ${url}。

请按你自己支持的接入方式二选一：
- 支持 Streamable HTTP MCP server 的客户端（Claude Code、Cursor 等）：把上面这个地址加成名为 ae 的服务器；如果你的客户端有作用域概念，注册到用户级；不要改动我已有的其它 MCP 条目；改完把最终配置回显给我。
- 只支持 stdio 的客户端（Claude Desktop 等）：用系统 Node（18 以上）执行 ${shimPath}，并设置环境变量 AE_MCP_HTTP_URL=${url}。

完成后提醒我两件事：MCP 工具只在新会话里加载，要新开一个会话再调用 ae_status 验证；ae-mcp 面板必须保持打开，关掉或重载面板之后客户端需要重连。`,
  en: ({ url, shimPath }) => `Connect After Effects for me. The ae-mcp panel is already running on this machine and serves MCP at ${url}.

Use whichever form your client supports:
- Clients that accept a Streamable HTTP MCP server (Claude Code, Cursor, and similar): add that URL as a server named ae; register it at user scope if your client has scopes; leave my other MCP entries untouched; print the final configuration back to me.
- stdio-only clients (Claude Desktop and similar): run ${shimPath} with system Node 18 or newer and set the environment variable AE_MCP_HTTP_URL=${url}.

When you are done, remind me of two things: MCP tools load only in a new session, so start a fresh session and call ae_status to verify; and the ae-mcp panel must stay open — clients need to reconnect after it closes or reloads.`,
};

export function externalClientSetupPrompt({
  lang = 'zh',
  port = 11488,
  extensionRoot = '<extension root>',
} = {}) {
  const url = `http://127.0.0.1:${port}/mcp`;
  const shimPath = String(extensionRoot).replace(/[\\/]+$/, '') + '/host/stdio-shim.js';
  const renderPrompt = PROMPTS[lang] || PROMPTS.zh;
  return renderPrompt({ url, shimPath });
}
