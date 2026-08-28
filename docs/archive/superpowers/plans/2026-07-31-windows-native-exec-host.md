# Windows x64 Native EXEC Host Implementation Plan

> Archived 2026-08-28: the native host is implemented and frozen; this build-out plan is historical.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Windows x64 `.aex` host from shared product source and validate the existing unified `ae_nativeExec` chain on real Windows AE 25/26, with one read-only public acceptance program.

**Architecture:** A new `src/platform/windows/` adapter (entry export, PiPL resource, same-user named-pipe endpoint registry) plugs into the unchanged shared core (`rpc_codec`, `native_rpc_connection`, `host_dispatcher`, Native EXEC registry). A build/verify script pair mirrors `build-macos.mjs`/`verify-macos.mjs`; a reversible dev-install script places the artifact in the Windows Common Plug-ins topology. The CEP client reuses `net.createConnection({ path })` with Windows pipe endpoint discovery.

**Tech Stack:** MSVC x64 C++ (pinned Windows AE SDK from #71), Node.js 24.17.0 ESM and `node:test`, PowerShell or Node driver scripts, existing `scripts/package/ae-sdk-input.mjs` policy, Windows named pipes, real Windows AE 25/26 hardware.

**Execution venue:** Tasks 1-3 can be prepared anywhere but their build/test steps require a Windows machine with MSVC and the pinned SDK. Tasks 4-5 require the real Windows AE 25/26 host. Continue execution from a Windows-host fork/clone of this branch.

## Global Constraints

- No new native primitives or capabilities; the existing Native EXEC registry is the acceptance surface.
- No transport authentication, pairing, tokens, peer-process validation, or cross-user/session defenses (#88 closed NOT_PLANNED; PR #197 boundary). Same-user pipe ACL only.
- No Authenticode signing, production installer, upgrade/rollback, or uninstall lifecycle — that is #80.
- No write tools, Undo claims, or release-matrix claims — that is #81.
- Do not vendor or redistribute Adobe SDK headers, samples, documentation, PiPLtool, or extraction utilities.
- Shared `src/core` and `src/aegp` sources must compile identically on macOS and Windows; platform seams follow the existing `src/platform/<os>/` header pattern, not scattered `#ifdef` blocks in shared logic.
- Fail fast on every locked external input before compiling (pinned SDK, MSVC, Windows SDK, output ownership) per AGENTS.md section 7.
- One artifact per build; no byte-for-byte double-build reproducibility.
- Use a dedicated disposable AE project for any AE-state validation; never the user's production project.
- T5/T6 hardware budget: roughly 5-7 public `ae_nativeExec` calls per run.
- Every implementation task uses red-green-refactor and ends with a focused commit.

## File and Interface Map

- `native/ae-plugin/src/platform/windows/endpoint_registry_windows.{hpp,cpp}`
  - Owns pipe naming (`\\.\pipe\aemcp-n1-` + UUID-v4 instance scope), metadata bounds, stale-endpoint cleanup, and the accept loop feeding `native_rpc_connection`.
- `native/ae-plugin/src/platform/windows/plugin_entry_windows.cpp`
  - Owns `DllMain` and the AEGP entry export, delegating to the existing `plugin_entry.cpp` dispatch.
- `native/ae-plugin/resources/AeMcpNative_PiPL.win.rc`
  - Owns the Windows resource carrying the same PiPL values as `AeMcpNative_PiPL.r`.
- `native/ae-plugin/build-windows.mjs` (or `.ps1`)
  - Owns prerequisite fail-fast checks, the MSVC compile/link, and the build receipt.
- `native/ae-plugin/verify-windows.mjs`
  - Owns PE architecture/export/resource verification and the canonical receipt shape.
- `native/ae-plugin/install-dev-windows.mjs` (or `.ps1`)
  - Owns the reversible Common Plug-ins development install and its receipt.
- `plugin/host/native-aegp-client.js`
  - Narrowly owns Windows endpoint discovery; protocol flow unchanged.
- `native/ae-plugin/tests/*windows*_test.cpp` and focused `.mjs` contract tests
  - Own registry naming/ACL-boundary and PE-verifier falsification without real AE.

---

### Task 1: Windows build prerequisites, PiPL resource, and entry point

**Files:**
- Create: `native/ae-plugin/src/platform/windows/plugin_entry_windows.cpp`
- Create: `native/ae-plugin/src/platform/windows/endpoint_registry_windows.hpp` (interface only at this step)
- Create: `native/ae-plugin/resources/AeMcpNative_PiPL.win.rc`
- Create: `native/ae-plugin/build-windows.mjs`
- Create: `scripts/package/test/native-aegp-build-contract.test.mjs` (extend existing contract coverage narrowly for the Windows script)

**Interfaces:**
- Consumes: `loadAeSdkPolicy`, `verifyAeSdkInput` from `scripts/package/ae-sdk-input.mjs`.
- Produces:
  - `checkWindowsBuildPrerequisites(input: { sdkArchive?: string, sdkRoot?: string }): Promise<{ sdkRoot: string, msvcVersion: string, windowsSdkVersion: string }>`
  - `buildWindowsAex(input: { sdkRoot: string, outputPath: string }): Promise<{ artifactPath: string, sha256: string, receipt: object }>`
- Entry export must resolve to the same `plugin_entry.cpp` dispatch table used by the macOS build.

- [ ] **Step 1: Write failing prerequisite tests**

Cover: missing SDK archive/root, unpinned SDK version, missing MSVC, missing
Windows SDK headers, and a non-owned output path. Each must fail before any
compile starts with an `AE_*`-prefixed structured error, mirroring the macOS
build error taxonomy.

- [ ] **Step 2: Implement the prerequisite check and build skeleton**

Implement `checkWindowsBuildPrerequisites` and the compile/link invocation
producing a single `.aex`. Run on the Windows machine: confirm fail-fast
behavior for each missing input, then a successful compile against the
pinned SDK.

- [ ] **Step 3: Author the PiPL resource and entry export**

Port the PiPL values (name, match name, category, entry point) from
`resources/AeMcpNative_PiPL.r` into the Windows resource, keeping the product
version token substitution identical to `build-macos.mjs`. Wire
`DllMain`/entry export to the existing dispatch. macOS sources remain
untouched.

- [ ] **Step 4: Commit**

Commit the resource, entry source, build script, and tests.

### Task 2: PE verifier and build receipt

**Files:**
- Create: `native/ae-plugin/verify-windows.mjs`
- Create: `scripts/package/test/verify-windows-aex.test.mjs` (new focused test file; do not overload the macOS verifier tests)

**Interfaces:**
- Produces:
  - `verifyWindowsAex(input: { artifactPath: string, expectedCommit: string }): Promise<{ result: "PASS", artifactSha256: string, architecture: "x64", entryExport: string, receipt: object }>`
- CLI mirrors `verify-macos.mjs` conventions: explicit `--artifact`,
  `--output`, and pinned-SDK identity flags.

- [ ] **Step 1: Write failing verifier tests with PE fixtures**

Cover: wrong architecture (x86/arm64 fixture rejected), missing entry
export, missing/altered AE resource, unexpected extra executable entry
surface, and hash/receipt consistency. Use small synthetic PE fixtures; do
not require a real `.aex` in unit tests.

- [ ] **Step 2: Implement the verifier**

Parse PE headers (architecture, export table, resource section) without
third-party dependencies, emit the canonical receipt (commit, artifact
hash, SDK identity, compiler version), and fail closed on every mismatch.

- [ ] **Step 3: Verify the real artifact**

On the Windows machine, run the verifier against the Task 1 artifact and
record the receipt.

- [ ] **Step 4: Commit**

Commit verifier, tests, and the recorded receipt schema.

### Task 3: Same-user named-pipe endpoint adapter and client discovery

**Files:**
- Create: `native/ae-plugin/src/platform/windows/endpoint_registry_windows.cpp`
- Create: `native/ae-plugin/tests/endpoint_registry_windows_test.cpp`
- Modify: `plugin/host/native-aegp-client.js` (Windows endpoint discovery only)
- Modify: `plugin/host/native-aegp-client.test.js` (discovery-path cases)

**Interfaces:**
- Mirrors `endpoint_registry_macos.cpp` semantics:
  - one pipe per host instance, name `\\.\pipe\aemcp-n1-<uuid-v4>`;
  - bounded descriptor/metadata (same 1024-byte bound as macOS);
  - stale-endpoint cleanup on start; restart invalidates old endpoints;
  - same-user ACL on pipe creation; no peer authentication beyond the OS
    same-user boundary.
- Client: `discoverWindowsEndpoints(registryRoot): Array<{ pipePath: string, instanceId: string }>` feeding the existing
  `net.createConnection({ path })` flow.

- [ ] **Step 1: Write failing registry contract tests**

Cover naming scheme, UUID validation, metadata bounds, stale-entry cleanup,
and ACL creation flags. Mark the same-user ACL boundary explicitly so a
future reviewer cannot mistake its absence of peer authentication for an
oversight — record the #88 NOT_PLANNED disposition in the test comment.

- [ ] **Step 2: Implement the pipe endpoint registry and accept loop**

Implement creation, registration, accept, framing handoff to
`native_rpc_connection`, and cleanup. Shared codec/connection code must not
change.

- [ ] **Step 3: Implement Windows client discovery**

Add the discovery path to `native-aegp-client.js`; prove with unit tests
that discovery picks the current instance's pipe and ignores stale names.
Protocol, deadlines, cancellation, and admission remain unchanged.

- [ ] **Step 4: Commit**

Commit adapter, client discovery, and tests.

### Task 4: Reversible development install and lifecycle smoke (Windows AE host)

**Files:**
- Create: `native/ae-plugin/install-dev-windows.mjs` (or `.ps1`)
- Create: install receipt schema alongside the macOS dev-install receipt conventions

**Interfaces:**
- Produces:
  - `installDevWindowsAex(input: { artifactPath: string }): Promise<{ installedPath: string, receipt: object }>`
  - `removeDevWindowsAex(input: { receiptPath: string }): Promise<{ removed: true }>`
- Installs into the supported Windows Common Plug-ins topology for AE
  25/26; records canonical path, hash, size, mtime; removes exactly what it
  installed.

- [ ] **Step 1: Zero-evidence hardware preflight**

Per AGENTS.md section 4: prove the Windows host, AE 25/26 install paths,
GUI access, fixture location, and log directories in one preflight. Create
or reset, save, and reopen one disposable fixture from inside AE. No
acceptance evidence is produced here.

- [ ] **Step 2: Install and T4 native-novelty smoke**

Install the `.aex`, launch AE, and run the narrowest smoke: plug-in loads,
pipe endpoint registers, one IdleHook-dispatched no-op/read-only registry
probe succeeds, plug-in unloads on removal, AE quits cleanly. This is the
single allowed native-novelty smoke for the package.

- [ ] **Step 3: Restart invalidation check**

Restart AE; prove the old endpoint is stale and a fresh instance registers.

- [ ] **Step 4: Commit**

Commit the install script and receipt schema.

### Task 5: Public acceptance — T5 candidate and T6 clean-main

**Files:**
- Create: `scripts/hardware/issue86_windows_native_exec_acceptance.py` (and spec file, following the `issue190_*` acceptance-driver pattern)
- Evidence directory per the project's evidence conventions, outside Adobe scan roots

**Interfaces:**
- Acceptance calls only the public MCP surface: `ae_nativeExec` with one
  real read-only program; typed result cross-checked against independently
  read AE state through the same public surface.
- Budget: roughly 5-7 public calls for T5 and again for T6.

- [ ] **Step 1: Freeze the candidate**

After concentrated review has no unresolved blocker and all sources/tests
are committed, designate the candidate. Run T3 (relevant full regression +
required CI) once before any acceptance evidence.

- [ ] **Step 2: T5 candidate acceptance**

On real Windows AE 25/26 with the candidate build receipts: run the
read-only `ae_nativeExec` program, cross-check the typed result against AE
state, record load/IdleHook/unload/quit/restart evidence, and bind commit,
artifact hash, SDK identity, AE build, and Windows version/arch.

- [ ] **Step 3: Merge and T6 clean-main revalidation**

Merge, rebuild/reinstall from a clean `main`, and replay the same public
acceptance once. Touch the same read-only path; verify restart freshness.

- [ ] **Step 4: Close #86 with the completion report**

Report per AGENTS.md section 9, including the fixture lifecycle counts,
build receipts, and the explicit statement that signing/installer belongs
to #80 and write/Undo/release-matrix coverage belongs to #81.

---

## Integrated Verification and Review Gate

1. All focused unit/contract tests (registry, verifier, client discovery,
   build prerequisites) green.
2. Existing macOS native compile tests, protocol conformance, and required
   GitHub CI green — proving the Windows adapter changed no shared behavior.
3. One concentrated Subagent review (at most two rounds), explicitly
   checking: macOS/shared protocol unchanged, no authentication/pairing
   leaked into the pipe path, no signing/installer scope leaked from #80,
   and no new primitives.
4. T4 smoke, T5 candidate acceptance, and T6 clean-`main` revalidation on
   real Windows AE 25/26 within the frozen call budgets.
5. Stop conditions of AGENTS.md section 10 apply before #80 begins.
