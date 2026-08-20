# CEP host MCP endpoint

The CEP Node host exposes a Streamable HTTP MCP endpoint at
`http://127.0.0.1:11488/mcp`. It shares the host's authenticated execution
and audit boundaries with `/exec` and dispatches public tools to After Effects.

Claude Code connects to the URL directly. Claude Desktop starts the installed
extension's dependency-free `host/stdio-shim.js` with system Node; the shim
serializes stdio requests and forwards them to the same URL.

The panel must stay open. A fresh client session is required after installing
the extension so the client reloads its MCP configuration.
