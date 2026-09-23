const PROMPTS = {
  zh: ({ url, shimPath }) => `请为正在接收并执行此提示词的当前客户端配置 ae-mcp。当前客户端就是目标，不要默认选择 Claude Code，也不要配置其它客户端。ae-mcp 面板已经在这台机器上运行，MCP 服务地址是 ${url}。

先确定当前客户端实际支持的配置方式与位置；只有确实无法识别目标客户端时才询问我，不要静默回退到 Claude Code。按当前客户端能力二选一：
- 支持 Streamable HTTP：把上面这个地址加成名为 ae 的服务器。
- 只支持 stdio：用系统 Node（18 以上）执行 ${shimPath}，并设置环境变量 AE_MCP_HTTP_URL=${url}；按当前客户端格式分别填写 command、args 和 env，路径作为独立参数。

保留已有的其它 MCP 配置；支持作用域时优先用户级。无法自动修改时，给出当前客户端准确的手动步骤，不要改为配置另一个客户端。只回显 ae 条目的配置，不要输出其它配置中的密钥。

配置后按当前客户端要求刷新、重连或新建会话，再调用 ae_status 验证；如果需要我操作，说明具体步骤及验证尚未完成。ae-mcp 面板必须保持打开，关掉或重载面板之后客户端需要重连。`,
  en: ({ url, shimPath }) => `Configure ae-mcp for the current client receiving and executing this prompt. This current client is the target: do not default to Claude Code or configure another client. The ae-mcp panel is already running on this machine and serves MCP at ${url}.

First identify this client's supported configuration method and location. Ask me only if the target client truly cannot be identified; never silently fall back to Claude Code. Choose by this client's capabilities:
- Streamable HTTP: add that URL as a server named ae.
- stdio only: run ${shimPath} with system Node 18 or newer and set AE_MCP_HTTP_URL=${url}; use this client's command, args, and env format, with the path as a separate argument.

Preserve all other MCP configuration; prefer user scope when supported. If automatic editing is unavailable, give precise manual steps for this client rather than configuring another client. Show only the ae entry, without secrets from other configuration.

Refresh, reconnect, or start a new session as this client requires, then call ae_status to verify. If I must act first, explain the exact steps and that verification is still pending. The ae-mcp panel must stay open; clients need to reconnect after it closes or reloads.`,
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
