export const EXTERNAL_CLIENTS = [
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    kind: 'mcp-stdio',
    installHint: 'Install Claude Desktop and open its MCP server settings.',
    loginHint: 'Sign in to Claude Desktop before starting the handshake.',
    docsUrl: 'https://support.anthropic.com/en/articles/10949351-getting-started-with-model-context-protocol-mcp-on-claude-for-desktop',
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    kind: 'mcp-stdio',
    installHint: 'Install Claude Code and add ae-mcp as a local MCP server.',
    loginHint: 'Run claude /login if Claude Code is not signed in.',
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code/mcp',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    kind: 'mcp-stdio',
    installHint: 'Open Cursor MCP settings and add this server config.',
    loginHint: 'Restart Cursor after saving MCP settings.',
    docsUrl: 'https://docs.cursor.com/context/model-context-protocol',
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    kind: 'mcp-doc',
    installHint: 'Follow the OpenClaw integration docs for adding external tools.',
    loginHint: 'Use the account and runtime required by your OpenClaw deployment.',
    docsUrl: 'https://github.com/bestK/OpenClaw',
    networkNote: 'OpenClaw is often long-running or Dockerized. Keep it on the same machine / 同机 as After Effects, or make sure it can reach 127.0.0.1:11488. MCP-client support is unverified; ae may need to be wrapped as an OpenClaw skill.',
  },
  {
    id: 'astrbot',
    name: 'AstrBot',
    kind: 'mcp-doc',
    installHint: 'AstrBot v3.5.0+ can add multiple MCP servers from the panel.',
    loginHint: 'Use the account and platform adapter required by your AstrBot deployment.',
    docsUrl: 'https://docs.astrbot.app/',
    networkNote: 'AstrBot is often long-running or Dockerized. Keep it on the same machine / 同机 as After Effects, or make sure it can reach 127.0.0.1:11488 before adding the MCP server in AstrBot v3.5.0+.',
  },
  {
    id: 'gemini-antigravity',
    name: 'Gemini Antigravity',
    kind: 'mcp-stdio',
    installHint: 'Add ae-mcp as a local stdio MCP server in Gemini Antigravity.',
    loginHint: 'Sign in to Gemini Antigravity before starting the handshake.',
    docsUrl: 'https://ai.google.dev/gemini-api/docs',
  },
  {
    id: 'opencode-external',
    name: 'opencode',
    kind: 'mcp-stdio',
    installHint: 'Use this external opencode config when the embedded panel flow is blocked.',
    loginHint: 'Sign in to opencode before starting the handshake.',
    docsUrl: 'https://opencode.ai/docs',
  },
];

// The ae-mcp server defaults the expert anti-error guidance ON, so we only need
// to emit an env var when the user has turned it OFF. Returns {} when enabled.
export function expertGuidanceEnv(on) {
  return on ? {} : { AE_MCP_EXPERT_GUIDANCE: '0' };
}

export function mcpConfigFor(client, port = 11488, expertGuidance = true) {
  return {
    mcpServers: {
      ae: {
        command: 'ae-mcp',
        env: {
          AE_MCP_BACKEND: 'ae-mcp',
          ...expertGuidanceEnv(expertGuidance !== false),
          AE_MCP_PLUGIN_URL: `http://127.0.0.1:${port}`,
        },
      },
    },
  };
}
