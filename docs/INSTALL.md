# Install ae-mcp

This release uses the installed CEP panel as the MCP service. Install the ZXP
and matching AEX, open the panel in After Effects, then choose one of the two
supported client connections.

## 1. Install the After Effects assets

1. Download the ZXP and matching `.aex` from the same release.
2. Install the ZXP with a supported ZXP installer.
3. With After Effects closed, install the `.aex` in the native plug-in
   directory used by the selected After Effects host.
4. Start After Effects and open **Window > Extensions > ae-mcp**.

The panel must remain open because it owns the local service at
`http://127.0.0.1:11488/mcp`. Verify release checksums before installing both
files.

## 2. Claude Code

Claude Code connects directly to the panel URL:

```bash
claude mcp add --transport http ae http://127.0.0.1:11488/mcp
```

If the client was already running before the panel was installed, start a new
client session so it reloads its MCP configuration.

## 3. Claude Desktop

Claude Desktop uses the dependency-free stdio shim shipped in the installed
extension. It requires the system Node executable. Point the configuration at
the extension directory's `host/stdio-shim.js`:

```json
{
  "mcpServers": {
    "ae": {
      "command": "node",
      "args": ["<installed-extension>/host/stdio-shim.js"],
      "env": {
        "AE_MCP_HTTP_URL": "http://127.0.0.1:11488/mcp"
      }
    }
  }
}
```

Replace the placeholder with the installed extension's absolute directory.
Do not point Claude Desktop at source files from an unrelated checkout.

## 4. Verify the connection

Keep the panel open and call `ae_ping` from a fresh client session. If the
tool is unavailable, restart the client session after confirming that the
panel is visible. A closed panel, a different After Effects host, or a stale
client session can all make the endpoint appear unavailable.

## 5. Local development

Install the Node dependencies and build the panel:

```bash
(cd plugin/host && npm ci)
(cd plugin/panel && npm ci && npm run build)
```

Then deploy the development extension with the platform script:

```powershell
.\scripts\install-plugin-dev.ps1
```

```bash
./scripts/install-plugin-dev-macos.sh
```

The Adobe SDK is developer-supplied and must stay outside the repository. The
native input validator can be run before a native build:

```bash
node scripts/package/ae-sdk-input.mjs verify-input --platform macos-arm64
```
