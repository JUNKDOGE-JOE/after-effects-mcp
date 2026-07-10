# ae-mcp

English | [简体中文](README.zh-CN.md)

ae-mcp is a backend-agnostic automation tool that keeps Adobe After Effects and AI agents in the same working context. Its MCP server exposes AE project state, tool execution, previews, screenshots, and checkpoints so an agent can understand and operate the current AE project during a conversation.

The MCP server is the core. Outside the MCP layer, ae-mcp also ships a CEP panel that wraps built-in agent chat, backend configuration, approval controls, diagnostics, and first-run setup. You can use ae-mcp from an external agent backend through MCP, or configure Claude / Codex / ZCode directly inside the AE panel.

The next release candidate is **v0.9.1 (unreleased)**. Version sources are synchronized for candidate construction; this is not a claim that the signed artifacts or four-cell AE acceptance matrix have passed.

## v0.9.1 Target Support Matrix

The unreleased v0.9.1 candidate targets only the following platform and host matrix. None of these cells is a release-accepted support claim until the four-cell hardware gate passes:

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

The MCP core is backend-agnostic: external clients can talk to AE through the stdio server, while the CEP panel can also host built-in agent chat. The existing panel layer handles backend setup, approvals, diagnostics, and activity history. The final v0.9.1 contract additionally requires first-run bundled-runtime verification, but that RuntimeManager behavior remains gated and is not claimed as delivered. Claude, Codex, and ZCode are built-in panel backends; OpenCode and other tools can still connect as external MCP clients.

## v0.9.1 Release Candidate Scope

- One protected `main` candidate SHA produces both native platform payloads; a failed or changed candidate must be rebuilt under a new SHA.
- Core operation is designed to be offline and self-contained in the signed release payload. System Python, system Node, `uv`, PyPI, and npm resolution are development inputs, not normal-user install prerequisites.
- Publishing remains gated on the approved signed-helper/provider/Tool Library milestones, per-file native-signature and product-acceptance coverage, signing and redistribution prerequisites, AE 25/26 smoke on both platforms, and valid Mac/Windows attestations. The native coverage policy is intentionally fail-closed, so landing a helper build or synchronizing v0.9.1 metadata cannot bypass those gates.
- UXP, Intel Mac, Windows ARM, provider-config export, and ZCode desktop captcha/runtime-header bridging are outside the v0.9.1 support scope.

## Install and First Run

Normal users install one immutable asset from the v0.9.1 release set. Do not use source archives or an online `uv`/PyPI install as a substitute for a signed release asset:

| Platform | Install asset | Auditable payload |
|---|---|---|
| macOS 14+ Apple Silicon arm64 | `ae-mcp-panel-v0.9.1-macos-arm64.dmg` | `ae-mcp-panel-v0.9.1-macos-arm64.zxp` |
| Windows 11 24H2+ x64 | `ae-mcp-panel-v0.9.1-windows-x64.zxp` | same ZXP |

The macOS DMG contains only the exact signed ZXP in a signed/notarized distribution container; it is not itself a ZXP installer. Both platforms require a separately supplied supported ZXP installer. Verify each download against `artifact-manifest-v0.9.1.json`, install the Mac ZXP from the DMG or the Windows ZXP, restart After Effects, and open `Window -> Extensions -> ae-mcp`. Under the final gated contract, the panel then installs the bundled runtime offline and exposes the stable `ae-mcp` launcher after verification.

These filenames describe the v0.9.1 contract. They are not available for general use until both attestation checks pass and the no-rebuild promotion workflow publishes them. See [Install](docs/INSTALL.md) and [Release](docs/RELEASE.md).

## Built-in Backends

| Backend | What it is for | Setup |
|---|---|---|
| Claude | Use Claude from the panel through subscription login or API direct mode. | Optional channel dependency: Claude Code CLI (`claude`) and its login. API direct mode instead needs an Anthropic API key or compatible provider. |
| Codex | Use Codex from the panel through CLI login, inherited config, or an OpenAI-compatible provider. | Optional channel dependency: Codex CLI and `codex login`; provider mode does not require that CLI. |
| ZCode | Use ZCode providers from the panel. | Optional channel dependency: the ZCode CLI/app-server supplied by a supported ZCode installation. API-key providers remain separate. |

Claude Code CLI is separate from Claude Desktop. Claude Desktop MCP configuration is not reused by the embedded Claude backend. Codex has the same distinction: the panel either talks to Codex CLI state or to providers configured for ae-mcp.

## Panel Features

- Built-in chat with Claude, Codex, and ZCode.
- Composer controls for model selection, reasoning effort, fast mode, and approval mode. Model switching is session-local and does not clear the conversation.
- Four approval modes: read-only, manual, auto, and bypass. Tool annotations drive consistent behavior across backends.
- Unified Provider Manager with expandable editable records for OpenAI-compatible and Anthropic providers.
- Activity stream for agent operations.
- Kill switch to stop all AI operations immediately.
- Current diagnostics cover host status, access token, Python client signal, AE project state, ExtendScript ping, and optional channel CLIs. Installed-runtime diagnostics belong to the gated RuntimeManager contract.
- Log export for issue reports and debugging.
- AE expert guidance injection. This optional setting adds AE command and data-structure guidance to reduce scripting mistakes at the cost of extra prompt tokens.

## Screenshots

<table>
  <tr><td><img src="docs/images/en/settings-provider-manager-collapsed.png" width="380"><br>Settings: backend channels and compact Provider Manager rows</td><td><img src="docs/images/en/settings-provider-manager-expanded.png" width="380"><br>Settings: expanded provider editor with local API key storage</td></tr>
  <tr><td><img src="docs/images/en/settings-general-language.png" width="380"><br>Settings: general options, language switch, logs, and About</td><td><img src="docs/images/en/wizard-install.png" width="380"><br>Historical v0.9.0 development wizard: online `uv` and PATH launcher setup; not the v0.9.1 bundled-runtime UX</td></tr>
  <tr><td><img src="docs/images/en/wizard-connect-clients.png" width="380"><br>First-run wizard: built-in chat and external MCP client setup</td><td><img src="docs/images/en/chat-home.png" width="380"><br>Chat home: starter suggestions and composer controls</td></tr>
  <tr><td><img src="docs/images/en/chat-approval.png" width="380"><br>Tool approval card for gated high-risk operations</td><td><img src="docs/images/en/activity-stream.png" width="380"><br>Activity stream: agent operation history</td></tr>
</table>

## External MCP Clients

The final v0.9.1 panel-generated MCP config for external clients has this shape:

```json
{
  "mcpServers": {
    "ae": {
      "command": "/Users/<USER>/.ae-mcp/bin/ae-mcp",
      "env": {
        "AE_MCP_BACKEND": "ae-mcp",
        "AE_MCP_PLUGIN_URL": "http://127.0.0.1:11488"
      }
    }
  }
}
```

This is the final stable-launcher contract. Replace `<USER>` with the actual macOS account name; the final Panel generator must emit that expanded absolute path. On Windows, use the expanded absolute path for `%USERPROFILE%\.ae-mcp\bin\ae-mcp.exe`. The approved RuntimeManager implementation must replace the current Panel generator's bare PATH `ae-mcp`; the fail-closed native/product-acceptance build guard prevents publishing v0.9.1 while that mismatch remains.

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

Close every After Effects / AfterFX process before a development deployment. Each installer preflights the source, copies and verifies a unique same-parent staging directory, atomically retains the old panel as a backup, and prints an absolute restore command.

macOS development setup:

```bash
uv sync --all-packages --group dev
(cd plugin/host && npm ci)
(cd plugin/sidecar && npm ci)
(cd plugin/panel && npm ci && npm run build)
./scripts/install-plugin-dev-macos.sh
```

Windows development setup:

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

## Package and Release

Maintainers create v0.9.1 artifacts only through the protected `build-rc.yml` workflow. The exact Mac arm64 and Windows x64 bytes are bound to `artifact-manifest-v0.9.1.json`, validated by `macos-rc-attestation` and `windows-rc-attestation`, then promoted by `release.yml` without rebuilding. Signing credentials, redistribution approvals, AE 25/26 installations, and a Windows x64 verifier are external prerequisites; see [docs/RELEASE.md](docs/RELEASE.md).

## Implementation Notes

Third-party components:

- `plugin/client/CSInterface.js` is Adobe CEP `CSInterface` v11 and retains Adobe's original license notice in that file.
- `ae-mcp-snapshot-mss` uses `mss` and Pillow for screen capture.
- The Python bridge uses `httpx`; the CEP host uses Express; the panel UI uses React; the Claude sidecar uses the Claude Agent SDK.

## License

ae-mcp project code is MIT licensed. See [LICENSE](LICENSE).

Files carrying their own upstream license notices, such as Adobe `CSInterface.js`, are governed by those notices.
