# ae-mcp

English | [简体中文](README.zh-CN.md)

ae-mcp is a backend-agnostic automation tool that keeps Adobe After Effects and AI agents in the same working context. Its MCP server exposes AE project state, tool execution, previews, screenshots, and checkpoints so an agent can understand and operate the current AE project during a conversation.

The MCP server is the core. Outside the MCP layer, ae-mcp also ships a CEP panel that wraps built-in agent chat, backend configuration, approval controls, diagnostics, and first-run setup. You can use ae-mcp from an external agent backend through MCP, or configure Claude / Codex / ZCode directly inside the AE panel.

The current release line is **v0.9.0**.

## Supported Platforms

ae-mcp supports only the following platform and host matrix:

- macOS 14.0 Sonoma or newer on native Apple Silicon arm64. Intel Macs and Rosetta are not supported.
- Windows 11 24H2 (11.0.26100) or newer on x64. Windows on ARM is not supported.
- After Effects 25.x and 26.x, represented by the CEP host range `[25.0,26.9]`.

## Architecture

```text
Embedded panel chat or external MCP client
  -> packages/core (ae_mcp, Python stdio MCP server, 32 ae_ tools)
  -> backend (packages/bridge, httpx)
  -> CEP panel Node host (plugin/host, Express, 127.0.0.1:11488)
  -> CSInterface.evalScript
  -> ExtendScript (plugin/jsx/runtime.jsx + jsx_templates/*.jsx)
  -> After Effects
```

`ae_previewFrame` renders real comp pixels through `CompItem.saveFrameToPng`, with viewer snapshot only as a fallback. `packages/snapshot-mss` provides the cross-platform `mss` screenshot backend for `ae_snapshot` screen capture.

The MCP core is backend-agnostic: external clients can talk to AE through the stdio server, while the CEP panel can also host built-in agent chat. The panel layer handles backend setup, approvals, diagnostics, activity history, and first-run dependency installation. Claude, Codex, and ZCode are built-in panel backends; OpenCode and other tools can still connect as external MCP clients.

## v0.9.0 Update

- Added a unified Provider Manager for custom model providers instead of scattering provider setup across backend-specific settings.
- Provider Manager can add, edit, delete, and probe OpenAI-compatible and Anthropic providers. Provider config is stored locally at `~/.ae-mcp/providers.json`.
- Redesigned Settings around backend credential channels and editable provider records. Editable items can expand for details and collapse back into compact status rows, keeping the settings page easier to scan.
- Claude API direct, Codex OpenAI-compatible providers, and ZCode provider configuration now share the same provider-management model where applicable. Legacy Claude BYOK preferences migrate automatically.
- OpenCode remains an **external MCP client**. Embedded OpenCode is implemented but not exposed yet, pending approval-gating verification.

## Install and First Run

For normal users, install the panel first and let the first-run wizard install the local dependencies.

1. Install the ZXP package with aescripts ZXP Installer or ExMan Cmd.
2. Restart After Effects after installing the ZXP.
3. Open `Window -> Extensions -> ae-mcp`.
4. Follow the first-run wizard.

The wizard detects and installs the required local tools: `uv`, Node, Claude CLI, and `ae-mcp`. Every install command is shown verbatim before it runs. Login actions open a visible terminal window. After the wizard installs Python-side dependencies, AE does not need another restart.

ae-mcp is not on PyPI. Do not use the public PyPI name as the install source.

If you need the Python packages directly from a release tag:

```powershell
uv tool install --from git+https://github.com/JUNKDOGE-JOE/after-effects-mcp@v0.9.0#subdirectory=packages/core ae-mcp --with git+https://github.com/JUNKDOGE-JOE/after-effects-mcp@v0.9.0#subdirectory=packages/bridge --with git+https://github.com/JUNKDOGE-JOE/after-effects-mcp@v0.9.0#subdirectory=packages/snapshot-mss
```

For a development checkout:

```powershell
uv tool install --from packages/core ae-mcp --with packages/bridge --with packages/snapshot-mss
```

## Built-in Backends

| Backend | What it is for | Setup |
|---|---|---|
| Claude | Use Claude from the panel through subscription login or API direct mode. | Install Node >= 18 and log in with Claude Code CLI (`claude`). API direct mode needs an Anthropic API key or compatible provider. |
| Codex | Use Codex from the panel through CLI login, inherited config, or an OpenAI-compatible provider. | Install Codex CLI and run `codex login`, inherit `~/.codex/config.toml`, or configure a provider in Provider Manager. |
| ZCode | Use ZCode providers from the panel. | Install ZCode desktop. API-key or OAuth coding-plan providers can be used in the panel. |

Claude Code CLI is separate from Claude Desktop. Claude Desktop MCP configuration is not reused by the embedded Claude backend. Codex has the same distinction: the panel either talks to Codex CLI state or to providers configured for ae-mcp.

## Panel Features

- Built-in chat with Claude, Codex, and ZCode.
- Composer controls for model selection, reasoning effort, fast mode, and approval mode. Model switching is session-local and does not clear the conversation.
- Four approval modes: read-only, manual, auto, and bypass. Tool annotations drive consistent behavior across backends.
- Unified Provider Manager with expandable editable records for OpenAI-compatible and Anthropic providers.
- Activity stream for agent operations.
- Kill switch to stop all AI operations immediately.
- Diagnostics for host status, access token, Python client signal, AE project state, ExtendScript ping, and local `uv` / `node` / `claude` availability.
- Log export for issue reports and debugging.
- AE expert guidance injection. This optional setting adds AE command and data-structure guidance to reduce scripting mistakes at the cost of extra prompt tokens.

## Screenshots

<table>
  <tr><td><img src="docs/images/en/settings-provider-manager-collapsed.png" width="380"><br>Settings: backend channels and compact Provider Manager rows</td><td><img src="docs/images/en/settings-provider-manager-expanded.png" width="380"><br>Settings: expanded provider editor with local API key storage</td></tr>
  <tr><td><img src="docs/images/en/settings-general-language.png" width="380"><br>Settings: general options, language switch, logs, and About</td><td><img src="docs/images/en/wizard-install.png" width="380"><br>First-run wizard: local service install with uv / ae-mcp checks</td></tr>
  <tr><td><img src="docs/images/en/wizard-connect-clients.png" width="380"><br>First-run wizard: built-in chat and external MCP client setup</td><td><img src="docs/images/en/chat-home.png" width="380"><br>Chat home: starter suggestions and composer controls</td></tr>
  <tr><td><img src="docs/images/en/chat-approval.png" width="380"><br>Tool approval card for gated high-risk operations</td><td><img src="docs/images/en/activity-stream.png" width="380"><br>Activity stream: agent operation history</td></tr>
</table>

## External MCP Clients

Use the panel-generated MCP config for external clients. A minimal config looks like this:

```json
{
  "mcpServers": {
    "ae": {
      "command": "ae-mcp",
      "env": {
        "AE_MCP_BACKEND": "ae-mcp",
        "AE_MCP_PLUGIN_URL": "http://127.0.0.1:11488"
      }
    }
  }
}
```

External clients must run on the same machine as After Effects, or otherwise be able to reach `127.0.0.1:11488` on the AE machine. This matters for long-running or Dockerized IM-bot frameworks such as OpenClaw and AstrBot.

## Tool Surface

| Category | Tools |
|---|---|
| Project | `ae_init`, `ae_overview`, `ae_layers`, `ae_readProps`, `ae_searchProject` |
| Mutation | `ae_exec`, `ae_applyEffect`, `ae_createLayer`, `ae_setProperty`, `ae_moveLayer`, `ae_selectLayers`, `ae_setTime` |
| Read-typed | `ae_getTime`, `ae_getProperties`, `ae_scanPropertyTree`, `ae_inspectPropertyCapabilities`, `ae_getExpressions`, `ae_validateExpressions`, `ae_getKeyframes` |
| Preview / capture | `ae_previewFrame`, `ae_snapshot` |
| Rigging | `ae_createRig` |
| Skill | `ae_skillList`, `ae_skillCreate`, `ae_skillEdit`, `ae_skillDelete`, `ae_skillUse` |
| Checkpoint | `ae_checkpoint`, `ae_revert` |
| Diagnostic | `ae_ping`, `ae_status`, `ae_diagnose` |

Expression workflows should run `ae_validateExpressions` before visual review. For risky edits, use `ae_checkpoint` or pass `checkpoint_label` to `ae_exec`.

## Usage Notes

AI is not a finished-motion-design replacement. ae-mcp works best when you keep creative direction, taste, and final compositing judgment in human hands, while delegating repetitive operations, procedural animation, expression work, project cleanup, and refactoring of reusable AE structures.

For visual work, ask the agent to preview frames and verify intermediate results. For larger edits, create checkpoints so the project can return to a known good state.

## Development

Repository development setup:

```powershell
uv sync --all-packages --group dev
cd plugin\host
npm ci
cd ..\sidecar
npm ci
cd ..\panel
npm ci
npm run build
cd ..\..
.\scripts\install-plugin-dev.ps1
```

## Test

Non-live:

```powershell
uv run pytest
```

Live, with AE open and the ae-mcp panel running:

```powershell
$env:AE_MCP_LIVE_TESTS = "1"
$env:AE_MCP_BACKEND = "ae-mcp"
$env:AE_MCP_PLUGIN_URL = "http://127.0.0.1:11488"
uv run pytest packages/core/tests/live -o addopts='' -vv
```

Model-matrix smoke for Claude sidecar + Codex app-server:

```powershell
node scripts/live-model-matrix.mjs
```

## Package

Packaging a release ZXP requires Adobe `ZXPSignCmd` and a certificate password:

```powershell
.\scripts\package-zxp.ps1 -ZxpSignCmd C:\Tools\ZXPSignCmd.exe -CertPassword <pw>
```

The script stages `plugin/`, strips development debug files and panel source, installs host/sidecar production dependencies, signs the package, and writes `release/ae-mcp-panel.zxp`. See [docs/RELEASE.md](docs/RELEASE.md) for the full release checklist.

## Implementation Notes

Third-party components:

- `plugin/client/CSInterface.js` is Adobe CEP `CSInterface` v11 and retains Adobe's original license notice in that file.
- `ae-mcp-snapshot-mss` uses `mss` and Pillow for screen capture.
- The Python bridge uses `httpx`; the CEP host uses Express; the panel UI uses React; the Claude sidecar uses the Claude Agent SDK.

## License

ae-mcp project code is MIT licensed. See [LICENSE](LICENSE).

Files carrying their own upstream license notices, such as Adobe `CSInterface.js`, are governed by those notices.
