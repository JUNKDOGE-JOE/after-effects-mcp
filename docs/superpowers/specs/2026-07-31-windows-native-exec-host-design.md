# Windows x64 Native EXEC Host Design

Date: 2026-07-31

Issue: #86

Status: User-approved frozen scope; written-spec review

## Goal

Build the Windows x64 After Effects `.aex` host from shared product-owned
source, and validate the existing unified Native EXEC chain end to end on a
real Windows AE 25/26 host:

1. an MSVC x64 build of the existing native plug-in source with the pinned
   developer-supplied SDK from #71;
2. a Windows platform adapter: PiPL/resource, entry export, and a same-user
   named-pipe endpoint mirroring the macOS Unix-socket registry;
3. a reversible development install in the Windows Common Plug-ins topology;
4. real-host lifecycle validation (load, IdleHook, unload, quit, restart);
5. one real read-only program executed through the public `ae_nativeExec`
   tool, cross-checked against actual AE state.

This Issue proves the existing registry on Windows. It does not extend the
capability set, does not add transport authentication, and does not produce
a signed or installable product.

## Current Observed State

- #71 (pinned SDK inputs), #72 (versioned RPC contract), #73 (macOS host and
  main-thread dispatcher), and #76 (MCP/Core-to-AEGP broker bridge) are all
  closed and merged.
- #88 (Windows named-pipe mutual authentication) was closed NOT_PLANNED on
  2026-07-28 after PR #197 established the trusted single-user same-host
  product boundary. Peer authentication, pairing, endpoint-substitution, and
  cross-user/session defenses are unsupported product goals, not deferred
  implementation work.
- `native/ae-plugin` contains no Windows code: no `_WIN32` guards, no
  `src/platform/windows/`, and no named-pipe implementation. The only
  platform adapter is `src/platform/macos/`.
- The macOS transport is a Unix domain socket registry
  (`src/platform/macos/endpoint_registry_macos.cpp`, socket directory
  `aemcp-n1`, UUID-v4-scoped endpoint names) plus `src/core/transport_auth.cpp`,
  `src/core/native_rpc_connection.cpp`, and `src/core/rpc_codec.cpp`.
- The CEP/host client (`plugin/host/native-aegp-client.js`) connects with
  `net.createConnection({ path })`, which on Windows accepts `\\.\pipe\`
  paths; the client-side adaptation is endpoint discovery and naming, not a
  new protocol.
- The macOS build is `native/ae-plugin/build-macos.mjs` with pinned-SDK
  policy from `scripts/package/ae-sdk-input.mjs`, Rez PiPL source at
  `resources/AeMcpNative_PiPL.r`, and verification in `verify-macos.mjs`.
- The old standalone `ae.project.summary` tool referenced by the original
  Issue text was retired in PR #200; the unified public surface is
  `ae_nativeExec`.

## Considered Approaches

### Chosen: minimal platform adapter on the shared execution plane

Add `src/platform/windows/` with the smallest adapter that lets the existing
registry/dispatcher/protocol run unchanged: entry export, PiPL compiled into
a `.rc`/resource, and a named-pipe endpoint server with the same registry
semantics as macOS. One build script, one verifier, one reversible dev
install. Validate through the public MCP surface only.

### Rejected: port the retired standalone tool or add a Windows-specific capability

`ae.project.summary` no longer exists as a tool (the string survives only as
an internal negotiated native capability/contract ID in
`packages/core/ae_mcp/backends/native.py`, never as a public MCP tool). A
Windows-only capability would fork the capability contract and violate the
Issue's non-goals. The
existing read-only Native EXEC registry already contains programs sufficient
for acceptance.

### Rejected: implement the #88 authenticated transport first

#88 was closed NOT_PLANNED as a product-scope decision. Implementing it now
would contradict PR #197's boundary and expand #86 far beyond its approved
scope. The Windows pipe uses same-user ACL/filesystem protection only,
consistent with the AGENTS.md local development trust model.

### Rejected: Authenticode signing or production installer in this Issue

Those belong to #80, which consumes the real `.aex` this Issue produces.
Signing here would block the package on release credentials and installer
lifecycle work that has its own acceptance matrix.

## Design Decisions

### 1. Windows platform adapter layout

Create `native/ae-plugin/src/platform/windows/` containing:

- the AEGP entry-point export (`PF_Cmd`-style entry / `DllMain`) wired to the
  existing `plugin_entry.cpp` dispatch, with no behavior change on macOS;
- a named-pipe endpoint registry (`endpoint_registry_windows.cpp`) mirroring
  the macOS semantics: one pipe per host instance, UUID-v4-scoped pipe names
  under `\\.\pipe\aemcp-n1-`, bounded descriptor/metadata, stale-endpoint
  cleanup on start, and restart invalidation;
- the pipe server accept loop feeding the existing
  `native_rpc_connection`/`rpc_codec` framing unchanged.

The adapter compiles only under `_WIN32`. Shared sources in `src/core` and
`src/aegp` must build identically on both platforms; any required seam uses
the existing platform-header pattern rather than scattered `#ifdef` blocks
inside shared logic.

### 2. PiPL and resource

Add `resources/AeMcpNative_PiPL.win.rc` (or the closest equivalent accepted
by the pinned SDK's resource flow) carrying the same PiPL values as the
macOS Rez source: plug-in name, match name, category, and entry point. The
Windows build must not invent a second identity; match name and version
tokens come from the same product manifest substitution used by
`build-macos.mjs`.

### 3. Build and verification scripts

Create `native/ae-plugin/build-windows.ps1` or `build-windows.mjs` (matching
the chosen Windows toolchain driver) and `verify-windows.mjs`:

- fail fast before compiling on every locked external input per AGENTS.md
  section 7: pinned SDK archive/root from `ae-sdk-input.mjs`, MSVC toolchain
  presence and version, Windows SDK headers, Node headers if needed, and
  output-path ownership;
- produce exactly one x64 `.aex` PE artifact;
- the verifier asserts PE architecture (x64), the expected entry export and
  AE resource, and the absence of unexpected executable entry surface, and
  records the artifact hash, SDK identity, compiler version, and source
  commit as a build receipt;
- no byte-for-byte double-build reproducibility requirement.

### 4. Same-user named-pipe transport

The pipe endpoint is protected at the Windows ACL level for the current
user/session only. Consistent with the #88 disposition, the adapter will
not:

- validate peer process identity, signer, session, or architecture beyond
  what the OS same-user pipe ACL already enforces;
- add pairing, tokens, fingerprints, or a connection-code ceremony;
- write secrets, raw audit tokens, or request payloads to world-readable
  locations.

`plugin/host/native-aegp-client.js` gains a Windows endpoint-discovery path
that enumerates the same registry naming scheme and calls the existing
`net.createConnection({ path })` flow; the protocol, deadlines, cancellation,
and admission rules are untouched.

### 5. Reversible development install

Create `native/ae-plugin/install-dev-windows.ps1` (or `.mjs`) that copies the
built `.aex` into the supported Windows Common Plug-ins topology for AE
25/26, records an install receipt (canonical path, hash, size, mtime), and
removes exactly what it installed. It does not touch the production
installer, registry-based upgrade/rollback, or signing; those are #80.

### 6. Real-host lifecycle validation

On a real Windows AE 25/26 host, validate through observable AE behavior:

- deterministic load and endpoint registration;
- IdleHook/main-thread dispatch of the read-only acceptance program;
- unload/DeathHook on plug-in removal;
- AE quit without hanging the host;
- restart invalidating stale endpoints and establishing a fresh instance.

All AE suite calls must run on the approved AE thread/IdleHook context.

### 7. Public acceptance surface

Acceptance uses only the public MCP tool a model would call:

- `ae_nativeExec` executing one real read-only program against a disposable
  fixture, with the typed result cross-checked against independently read AE
  state;
- T5 (candidate) and T6 (clean-`main`) hardware budgets of roughly 5-7
  public calls each, per the frozen brief;
- evidence binds commit, artifact hash, SDK identity, AE version/build,
  Windows version/architecture, public request/result, and sanitized
  lifecycle logs.

No write tool, Undo claim, Authenticode claim, or installer claim is made in
this Issue.

## Expected Change Surface

- `native/ae-plugin/src/platform/windows/` (new adapter sources/headers)
- `native/ae-plugin/resources/AeMcpNative_PiPL.win.rc` or equivalent
- `native/ae-plugin/build-windows.*` and `verify-windows.mjs`
- `native/ae-plugin/install-dev-windows.*`
- `plugin/host/native-aegp-client.js` narrowly: Windows endpoint discovery
- focused contract tests for the Windows registry naming/ACL boundary and
  the PE verifier, runnable without real AE
- `docs/INSTALL.md`/`docs/REFERENCE.md` only if needed to describe the
  development install path

The exact list may contract during test-first implementation. Expansion into
transport authentication, signing, installer lifecycle, new primitives, or
process guardrails requires a reproduced blocker and explicit scope review.

## Verification

Implementation follows red-green-refactor:

1. focused unit/contract tests for the endpoint registry naming, metadata
   bounds, and stale-entry cleanup;
2. focused PE-verifier tests (architecture, export, resource, receipt);
3. existing native compile tests and protocol conformance suites unchanged
   and green on macOS;
4. one fresh external Windows build producing the verified `.aex`;
5. reversible development install with receipt;
6. T4 native-novelty smoke (first Windows load + IdleHook dispatch);
7. T5 candidate acceptance on real Windows AE 25/26; and
8. T6 clean-`main` revalidation.

T5/T6 run on the Windows host; the macOS acceptance loop must remain green
without re-running beyond the normal clean-`main` check.

## Review and Scope Control

Use one concentrated Subagent review by default and no more than two rounds.
Classify findings under `AGENTS.md` section 5:

- only a reproduced failure in the Windows build/adapter/acceptance path is
  a current blocker;
- credible Windows hardening beyond the single-user boundary is a follow-up
  recorded as a new issue (or against #80/#81 only when it directly concerns
  their packaging/release-matrix scope);
- reviving #88-style authentication, pairing, or process defenses is out of
  scope by product decision.

The review must explicitly check that macOS/shared protocol behavior is
unchanged and that no authentication or signing claim leaked into the
Windows path.

## Completion and Issue Closure

#86 is complete when:

- a fresh external build produces the verified PE x64 `.aex` with a build
  receipt;
- the reversible development install works on the real host;
- real Windows AE 25/26 load/IdleHook/unload/quit/restart evidence exists;
- the public `ae_nativeExec` read-only acceptance passed at T5 and T6 within
  the frozen call budget;
- required CI and concentrated review have no unresolved blocker;
- the closure comment records that Authenticode/installer lifecycle remains
  with #80 and write/Undo/release-matrix coverage remains with #81.

Closing #86 means the Windows host runs the existing Native EXEC chain. It
does not mean the Windows product is signed, installable, or releasable.
