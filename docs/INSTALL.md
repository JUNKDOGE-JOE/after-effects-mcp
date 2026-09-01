# Install ae-mcp

This release uses the installed CEP panel as the MCP service. Install the ZXP
and matching AEX, open the panel in After Effects, then choose one of the two
supported client connections.

## 1. Install the After Effects assets

1. Download the ZXP and the native plug-in for your platform from the same
   release — `AeMcpNative-<version>-windows-x64.aex` on Windows,
   `AeMcpNative-<version>-macos-arm64.plugin.zip` on macOS.
2. Install the ZXP with a supported ZXP installer. One ZXP serves both
   Windows and macOS. It bundles the OpenCode runtime for Windows (about
   60 MB); on macOS the panel uses an `opencode` found on PATH instead.
3. With After Effects closed, install the native plug-in in the plug-in
   directory used by the selected After Effects host. `ae_nativeExec` is the
   only tool that needs it, so a release that has not yet published the
   native plug-in for your platform is still usable through the other 12.

   On Windows, copy the file into the selected host with administrator
   rights:

   ```text
   <After Effects>\Support Files\Plug-ins\Extensions\AeMcpNative.aex
   ```

   On macOS, unzip the download and place the whole `AeMcpNative.plugin`
   bundle in the per-user MediaCore directory, then clear the download
   quarantine so After Effects can load it:

   ```bash
   mkdir -p ~/Library/Application\ Support/Adobe/Common/Plug-ins/7.0/MediaCore/ae-mcp
   ditto -x -k AeMcpNative-<version>-macos-arm64.plugin.zip /tmp/ae-mcp-plugin
   mv /tmp/ae-mcp-plugin/AeMcpNative.plugin \
     ~/Library/Application\ Support/Adobe/Common/Plug-ins/7.0/MediaCore/ae-mcp/
   xattr -dr com.apple.quarantine \
     ~/Library/Application\ Support/Adobe/Common/Plug-ins/7.0/MediaCore/ae-mcp/AeMcpNative.plugin
   ```

   The macOS bundle is ad-hoc signed and not notarized, so verify its
   SHA-256 against the release checksum file before installing it. Keep the
   bundle intact — copying only the executable out of it does not work.
4. Start After Effects and open **Window > Extensions > ae-mcp**.

The panel must remain open because it owns the local service at
`http://127.0.0.1:11488/mcp`. Verify release checksums before installing the
files you downloaded.

## 2. Claude Code

Claude Code connects directly to the panel URL:

```bash
claude mcp add --transport http ae http://127.0.0.1:11488/mcp
```

If the client was already running before the panel was installed, start a new
client session so it reloads its MCP configuration.

## 3. Stdio-only clients

Claude Desktop and other stdio-only clients use the published connector. It
requires system Node 18 or newer and forwards to the panel's `/mcp` endpoint:

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

As an advanced alternative, run the dependency-free shim shipped inside the
installed extension. Point Node at that extension's `host/stdio-shim.js`:

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
Do not point a client at source files from an unrelated checkout. Both stdio
forms reach `http://127.0.0.1:11488/mcp`; the connector does not install the
After Effects extension itself.

## 4. Verify the 13-tool surface

Keep the panel open and call `ae_status` from a fresh client session. The host
must advertise exactly these 13 tools:

| Area | Tools |
| --- | --- |
| Status | `ae_status` |
| ExtendScript and recovery | `ae_exec`, `ae_execRecover` |
| Read and visual verification | `ae_read`, `ae_previewFrame`, `ae_validateExpressions` |
| Project checkpoints | `ae_checkpoint`, `ae_revert` |
| Frozen native AEGP | `ae_nativeExec` |
| Tool Library and skills | `ae_toolSearch`, `ae_toolUse`, `ae_toolSave`, `ae_skillUse` |

If the tool is unavailable, restart the client session after confirming that
the panel is visible. A closed panel, a different After Effects host, or a
stale client session can all make the endpoint appear unavailable.

Successful `ae_exec` and `ae_execRecover` calls capture rerunnable Tool Library
candidates. Repeated tasks can follow `ae_toolSearch` → `ae_toolUse` →
`ae_toolSave`; import/export and candidate management live on the panel's Tools
page. Persistent state defaults to `~/.ae-mcp` and can be relocated with
`AE_MCP_STATE_DIR`. See [Tool Library](TOOL_LIBRARY.md) for lifecycle, cleanup,
distribution, and developer details.

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
