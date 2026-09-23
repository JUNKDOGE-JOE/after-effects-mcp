const PROMPTS = {
  zh: ({ url, shimPath }) => `请为正在接收并执行此提示词的当前客户端配置 ae-mcp。当前客户端就是目标，不要默认选择 Claude Code，也不要配置其它客户端。ae-mcp 面板已经在这台机器上运行，MCP 服务地址是 ${url}。

操作前先只读检查本机 ae-mcp 扩展、对应平台原生插件的文件和版本，以及当前客户端已有的 MCP 注册及实际连接状态；不要仅凭文件或配置条目存在就认定可用。对照官方最新稳定发布的本平台可用资产：客户端已正确注册就保留配置，只补装缺失或损坏的文件；文件完整且版本适用就只补配缺失或错误的客户端注册；两者都已就绪且为最新版就直接验证，不重复安装。发现可用新版时升级已有组件，保留用户设置及其它 MCP 配置，不降级；无法确认版本或缺少本平台资产时说明情况，不盲目覆盖。

先确定当前客户端实际支持的配置方式与位置；只有确实无法识别目标客户端时才询问我，不要静默回退到 Claude Code。需要配置时按当前客户端能力二选一：
- 支持 Streamable HTTP：把上面这个地址加成名为 ae 的服务器。
- 只支持 stdio：用系统 Node（18 以上）执行 ${shimPath}，并设置环境变量 AE_MCP_HTTP_URL=${url}；按当前客户端格式分别填写 command、args 和 env，路径作为独立参数。

保留已有的其它 MCP 配置；支持作用域时优先用户级。无法自动修改时，给出当前客户端准确的手动步骤，不要改为配置另一个客户端。只回显 ae 条目的配置，不要输出其它配置中的密钥。

配置后按当前客户端要求刷新、重连或新建会话，再调用 ae_status 验证；如果需要我操作，说明具体步骤及验证尚未完成。ae-mcp 面板必须保持打开，关掉或重载面板之后客户端需要重连。`,
  en: ({ url, shimPath }) => `Configure ae-mcp for the current client receiving and executing this prompt. This current client is the target: do not default to Claude Code or configure another client. The ae-mcp panel is already running on this machine and serves MCP at ${url}.

Before making changes, inspect the local ae-mcp extension and platform-native plug-in files and versions, plus this client's existing MCP registration and actual connection, read-only. Existence alone does not prove readiness. Compare with the latest official stable release assets available for this platform: keep a correct client registration and install only missing or damaged files; when files are complete and their versions suitable, only add or repair client registration; when both are ready and current, verify without reinstalling. Upgrade existing components when a newer version is available, preserving user settings and other MCP configuration; do not downgrade. If versions cannot be established or platform assets are unavailable, explain rather than blindly overwrite.

First identify this client's supported configuration method and location. Ask me only if the target client truly cannot be identified; never silently fall back to Claude Code. When configuration is needed, choose by this client's capabilities:
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
