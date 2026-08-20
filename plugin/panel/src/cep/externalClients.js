export const EXTERNAL_CLIENTS = [
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    kind: 'mcp-shim',
    installHint: 'Claude Desktop uses the bundled stdio-to-HTTP shim and requires system Node.',
    loginHint: 'Sign in to Claude Desktop before using the connection.',
    docsUrl: 'https://support.anthropic.com/en/articles/10949351-getting-started-with-model-context-protocol-mcp-on-claude-for-desktop',
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    kind: 'mcp-http',
    installHint: 'Add the panel host as a Streamable HTTP MCP server.',
    loginHint: 'Run claude /login if Claude Code is not signed in.',
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code/mcp',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    kind: 'mcp-http',
    installHint: 'Open Cursor MCP settings and add the local panel URL.',
    loginHint: 'Restart Cursor after saving MCP settings.',
    docsUrl: 'https://docs.cursor.com/context/model-context-protocol',
  },
];

// The host defaults expert anti-error guidance ON. This helper remains only
// for the legacy ZCode provider route until its serial cleanup lands.
export function expertGuidanceEnv(on) {
  return on ? {} : { AE_MCP_EXPERT_GUIDANCE: '0' };
}

export function httpConfigFor(client, port = 11488, extensionRoot = '<extension root>') {
  const id = typeof client === 'string' ? client : (client && client.id);
  const url = `http://127.0.0.1:${port}/mcp`;
  const shimPath = String(extensionRoot).replace(/[\\/]+$/, '') + '/host/stdio-shim.js';
  if (id === 'claude-desktop') {
    return {
      mcpServers: {
        ae: {
          command: 'node',
          args: [shimPath],
          env: { AE_MCP_HTTP_URL: url },
        },
      },
    };
  }
  if (id === 'claude-code') {
    return `claude mcp add --transport http ae ${url}`;
  }
  if (id === 'cursor') return { mcpServers: { ae: { url } } };
  return { mcpServers: { ae: { type: 'http', url } } };
}

export function externalClientConfigText({
  client,
  port = 11488,
  extensionRoot = '<extension root>',
} = {}) {
  const config = httpConfigFor(client, port, extensionRoot);
  return typeof config === 'string' ? config : JSON.stringify(config, null, 2);
}
