# ae-mcp-bridge

HTTP bridge between the `ae-mcp` MCP server and the `ae-mcp` CEP plugin
(`plugin/` in the repo). Talks to `127.0.0.1:11488` (configurable via
`AE_MCP_PLUGIN_URL`). The plugin exposes `/health` and `/exec` endpoints;
this package wraps them as the `Backend` ABC for ae-mcp core.

## Usage

    AE_MCP_BACKEND      = ae-mcp
    AE_MCP_PLUGIN_URL   = http://127.0.0.1:11488   # default
