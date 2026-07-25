# Threat model

This describes `9c8ec9f`, not a future hosted service. ae-mcp is local automation for one interactive OS user, and a configured MCP client is trusted to exercise that user's After Effects authority. Approval prompts reduce mistakes; they do not make a hostile client safe (`packages/core/ae_mcp/approval_gate.py::enforce`, `packages/core/ae_mcp/annotations.py::VERB_ANNOTATIONS`).

## Deployment shapes that exist

**Released:** v0.9.2 is Windows 11 x64 / AE 25. Panel agents and configured external clients both spawn the Python core over MCP stdio. Core calls the CEP Node host over token-authenticated HTTP on `127.0.0.1:11488`; the host reaches AE through `CSInterface.evalScript` (`README.md`, `plugin/panel/src/cep/mcpClient.js::start`, `packages/core/ae_mcp/server.py::_run_async`, `packages/bridge/ae_mcp_bridge/__init__.py::HttpBridge`, `plugin/host/server.js::start`). The current-user Windows Platform Helper handles secrets and capture, not MCP transport (`docs/platform/PLATFORM_HELPER_SECURITY.md`).

**Development-only, not released:** v0.9.3 macOS builds add a bundled runtime and arm64 AEGP plug-in reached over a per-user Unix-domain socket. Its socket and descriptor are owner-only; admission verifies effective UID, audit-token PID, stable process identity, CPU type, and ancestry to the current AE process (`docs/RUNTIME_MANAGER.md`, `native/ae-plugin/src/platform/macos/endpoint_registry_macos.cpp::{private_directory,private_socket,verify}`, `native/ae-plugin/src/platform/macos/peer_identity_macos.cpp::MacPeerIdentityBackend`, `native/ae-plugin/src/platform/macos/mac_ipc_server.cpp::admit_peer`).

**Hypothetical and unsupported:** non-loopback MCP/HTTP, a remote AE host, a shared multi-user daemon, and multi-tenant/service-account use. `AE_MCP_PLUGIN_URL` is configurable, but the CEP server binds only `127.0.0.1`; configuration is not a remote-server implementation (`packages/bridge/ae_mcp_bridge/__init__.py::HttpBridge.from_env`, `plugin/host/server.js::start`). Linux, Intel Mac, and Windows ARM are outside the release matrix (`README.md`).

## Who these shapes defend against

The Windows shape rejects a local process that lacks `~/.ae-mcp/auth-token`; `/exec` and native routes compare it before dispatch. MCP schemas reject malformed arguments, and panel clients can require write approval (`plugin/host/auth-token.js::tokenMatches`, `plugin/host/server.js::{nativeRequestGate,buildApp}`, `packages/core/ae_mcp/server.py::_call_tool`, `plugin/panel/src/cep/mcpClient.js::handleServerRequest`).

It does **not** defend against a malicious configured MCP client, an allowed model action, a same-user process that reads the token, compromised AE/CEP, an administrator, or OS compromise. POSIX mode `0600` has no effect on Windows, so the token is not a Windows sandbox (`plugin/host/auth-token.js::writeToken`). Client labels and pause are operator controls, not identity (`plugin/host/server.js::{touchClient,setPaused}`).

The macOS development shape additionally rejects other UIDs, peers outside the live AE tree, changed peers/endpoints, and malformed prefaces before native RPC (`native/ae-plugin/src/platform/macos/mac_ipc_server.cpp::{handle_connection,admit_peer,same_peer}`, `native/ae-plugin/src/platform/macos/endpoint_registry_macos.cpp::verify`).

It does **not** defend against hostile same-user code inside AE or its admitted tree, the public JSX route, modified development installs, or kernel/administrator compromise. Development installs are not release-signing evidence (`docs/INSTALL.md`).

## Actual trust boundaries

The **user boundary** is one OS account; no cross-user principal is supported. **Process boundaries** are client-to-core stdio, core-to-CEP loopback HTTP, CEP-to-AE `evalScript`, macOS CEP-to-AEGP Unix socket, and separate Helper IPC (`packages/core/ae_mcp/server.py::_run_async`, `plugin/host/server.js::buildApp`, `plugin/host/jsx-bridge.js`, `native/ae-plugin/src/platform/macos/mac_ipc_server.cpp`, `docs/platform/PLATFORM_HELPER_SECURITY.md`).

**Filesystem boundaries** distribute capabilities, not isolation from the same user: the token is per-user; macOS endpoint entries require owner-only modes (`plugin/host/auth-token.js`, `native/ae-plugin/src/platform/macos/endpoint_registry_macos.cpp::{private_directory,private_regular,private_socket}`). **Untrusted input** is provider/model output, MCP names/JSON over stdio, loopback HTTP JSON, and native auth/RPC frames. It crosses at `plugin/panel/src/lib/agentLoop.js::createAgentLoop`, `packages/core/ae_mcp/server.py::_call_tool`, `plugin/host/server.js::buildApp`, and `native/ae-plugin/src/core/{transport_auth.cpp,rpc_codec.cpp}`. Caller-selected projects/media are data, not new network principals.

## `ae_exec` sets the ceiling

`AeExecArgs.code` is explicitly “Full JSX source.” `_run_exec` passes it unchanged as `code=args.code` to `backend.exec`; `HttpBridge.exec` posts it to `/exec`, which sends it to `jsxBridge.evalScript` (`packages/core/ae_mcp/schemas.py::AeExecArgs`, `packages/core/ae_mcp/handlers/core.py::_run_exec`, `packages/bridge/ae_mcp_bridge/__init__.py::HttpBridge.exec`, `plugin/host/server.js::buildApp`). An admitted MCP caller therefore has arbitrary execution in AE's ExtendScript environment.

Typed schemas, native capabilities, locators, idempotency, audit, and pairing are therefore correctness/recovery controls, not a sandbox against an admitted caller. `ae_exec` is destructive and approval-gated, but approval does not inspect or confine JSX (`packages/core/ae_mcp/annotations.py::VERB_ANNOTATIONS`, `packages/core/ae_mcp/approval_gate.py::enforce`). `ae_readProps` likewise sends caller JSX to `Backend.exec` despite its read-only description (`packages/core/ae_mcp/schemas.py::AeReadPropsArgs`, `packages/core/ae_mcp/handlers/core.py::_run_read_props`).

**Finding: retain `ae_exec` as public for this trusted-local-client product.** If untrusted clients become supported, `ae_exec`, `ae_readProps`, and stored-JSX execution must be removed or isolated before claiming least privilege.

## Pairing verdict: REMOVE

Remove the connection-code/fingerprint ceremony from the local single-user path in separate follow-up work. The socket already admits only the same UID with stable peer identity and current-AE ancestry. A click adds consent only after those checks (`native/ae-plugin/src/platform/macos/mac_ipc_server.cpp::admit_peer`, `native/ae-plugin/src/aegp/plugin_entry.cpp::command_hook`).

That consent is outside the defended actors and cannot stop a hostile same-UID process reading the HTTP token and using public `ae_exec`. The development flag already auto-confirms the admitted binding; release builds compile the click back in (`native/ae-plugin/src/platform/macos/mac_ipc_server.cpp::handle_connection`, `native/ae-plugin/build-macos.mjs`). Keep peer/endpoint checks, protocol validation, and action approval. This verdict says nothing about remote or multi-user authentication.

## Re-evaluate when

Write a new model before shipping non-loopback/forwarded transport; cross-user/shared-service operation; intentionally hostile clients/provider output; unsigned third-party CEP/AE plug-ins or sidecars in the admitted tree; public-MCP access to stored credentials; isolation/removal of arbitrary JSX; or a promise to resist hostile same-UID processes (`plugin/host/server.js::start`, `docs/platform/PLATFORM_HELPER_SECURITY.md`, `packages/core/ae_mcp/handlers/core.py::{_run_exec,_run_read_props}`).

## Deliberately not covered

This is not a signing/notarization or remote-auth design, provider privacy or secret-store audit, sandbox/DoS analysis, AE/OS vulnerability assessment, or proof of Undo/audit correctness. See `docs/RELEASE.md`, `docs/platform/PLATFORM_HELPER_SECURITY.md`, and `docs/CAPABILITY_PACKAGE_WORKFLOW.md`.
