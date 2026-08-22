# ae-mcp

English | [简体中文](README.zh-CN.md)

**One-line setup prompt — paste this into Claude Code or another AI agent:**

```text
Install the ae-mcp ZXP and the native plug-in for my platform from the v0.10.0
release, open Window > Extensions
> ae-mcp in After Effects, then connect Claude Code with `claude mcp add
--transport http ae http://127.0.0.1:11488/mcp`; for Claude Desktop, configure
the extension's `host/stdio-shim.js` with the system Node executable and ask me
to start a new client session before testing `ae_ping`.
```

ae-mcp connects an After Effects CEP panel to AI clients through a local MCP
endpoint. The panel hosts the service at `http://127.0.0.1:11488/mcp`; the
host is a Node process using Express, and After Effects state is reached
through ExtendScript and the frozen native AEGP plane.

## Install and first run

1. Install the signed ZXP in After Effects.
2. Install the matching native plug-in beside the After Effects plug-ins
   selected for the host — the `.aex` on Windows, the `AeMcpNative.plugin`
   bundle on macOS. Keep the version pair from the same release. The ZXP
   carries no platform binaries and installs on both systems; only this
   native plug-in is built per platform, and `ae_nativeExec` is the one tool
   that needs it.
3. Start After Effects and open **Window > Extensions > ae-mcp**. Keep the panel
   open while an external client uses MCP.
4. Configure one of the two supported external connection forms below.

The panel itself is the MCP service. No separate repository server is needed.
External clients must run on the same machine as After Effects because the
default endpoint is loopback.

## Client connections

Claude Code uses the URL transport:

```bash
claude mcp add --transport http ae http://127.0.0.1:11488/mcp
```

Claude Desktop uses the dependency-free stdio shim shipped in the installed
extension. Set `command` to the system Node executable and point `args` at the
extension directory's `host/stdio-shim.js`:

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

Claude Desktop therefore needs a system Node installation. The shim keeps one
stdio request queue and forwards MCP responses to the panel host.

## Panel capabilities

- `ae_exec` for maintained ExtendScript operations.
- `ae_nativeExec` for the frozen native AEGP primitives.
- `ae_previewFrame`, `ae_validateExpressions`, `ae_snapshot`, and checkpoints.
- Bundled skills plus the local JSX Tool Library.
- Approval modes, activity history, diagnostics, and log export.
- Built-in Claude, Codex, and OpenCode channels when their local CLI login is
  available.

The public MCP tools are served by the CEP host. Writes should be followed by
an independent readback; potentially side-effecting failures must be
reconciled before retry, and Undo must be executed and verified separately.

## Development

Install the two Node workspaces and build the panel:

```bash
(cd plugin/host && npm ci)
(cd plugin/panel && npm ci && npm run build)
```

For a local CEP deployment, use the platform-specific script after the host
and panel are built:

```powershell
.\scripts\install-plugin-dev.ps1
```

```bash
./scripts/install-plugin-dev-macos.sh
```

The Adobe After Effects C/C++ Plug-in SDK is a developer-supplied input and
must remain outside this repository. Verify it before building the native
plug-in:

```bash
node scripts/package/ae-sdk-input.mjs verify-input --platform macos-arm64
```

For the frozen native plane, build into a new directory outside the repository.
The installer keeps transaction state under `native-plugin-dev-v1`; retain the
returned transaction ID if you install the result:

```bash
AE_SDK_ARCHIVE=/absolute/path/AfterEffectsSDK.zip
AE_SDK_ROOT=/absolute/path/AfterEffectsSDK
BUILD_DIR=/private/tmp/ae-mcp-native-dev
TRANSACTION_ID="paste-the-transaction-id-here"
node native/ae-plugin/build-macos.mjs \
  --sdk-archive "$AE_SDK_ARCHIVE" \
  --sdk-root "$AE_SDK_ROOT" \
  --output "$BUILD_DIR"
# The install state root is native-plugin-dev-v1.
node native/ae-plugin/install-dev-macos.mjs install --artifact-dir "$BUILD_DIR"
node native/ae-plugin/install-dev-macos.mjs rollback \
  --transaction "$TRANSACTION_ID"
```

The native plane is frozen; generated AEGP protocol files are checked in and
the capability-package code-generation pipeline is not part of normal
development.

## Tests and packaging

Run focused Node contracts locally:

```powershell
node --test scripts/package/test/verify-windows-zxp-stage.test.mjs
node --test scripts/package/test/zxp-payload-audit.test.mjs
```

The Windows ZXP staging command copies only the panel, host, JSX, shared
modules, icons, and generated host assets. It verifies the host's exact
Express `4.22.2` dependency and signs the ZXP once:

```powershell
.\scripts\package-zxp.ps1 -SkipSigning
```

The signed ZXP must contain no nested native binary other than an explicitly
handled `.aex` artifact, and it must remain below 20 MB.

See [Install](docs/INSTALL.md), [Reference](docs/REFERENCE.md), and
[Release](docs/RELEASE.md) for the maintained operational details.

## License

ae-mcp is released under the MIT License; see [LICENSE](LICENSE). Adobe's
`CSInterface.js` retains its upstream license notice.
