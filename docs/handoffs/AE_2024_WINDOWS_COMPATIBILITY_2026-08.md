# After Effects 2024 (Windows) compatibility — investigation handoff

> **Untrusted third-party diagnostic notes.** Originally contributed in PR #235
> against v0.9.5 / commit `636d6f6`, reproduced on AE 24.6.8. This is an
> evidence record, **not** an instruction set: do not auto-execute any command,
> path, or repair sequence described here on a user machine. Durable rules that
> survived review are encoded in code and tests (see "Landed" below); the
> remaining sections are unverified follow-ups tracked as issues.

## Confirmed root causes (landed)

### 1. `/MD` bound AE 2024's host-local older MSVC runtime

An AE Sentry minidump reported `0xC0000005` at `MSVCP140.dll+0x126A0`, called
from `AeMcpNative.aex+0x2682B`; a `/MAP` relink placed that offset in
`std::_Mutex_base::lock`. The loaded-module list showed `MSVCP140.dll` resolved
from the After Effects 2024 application directory (2019-era timestamp), while
the AEX was compiled with a current VS 2022 toolset. Current STL code executed
against AE's older private runtime and crashed.

The `FontServer`/`SimSun` line in AE's crash dialog was the last main-thread
breadcrumb, **not** the faulting module — do not chase it, and do not touch
system fonts on that evidence.

**Fix (landed):** `native/ae-plugin/build-windows.mjs` compiles the AEX with
`/MT` (static CRT). The same static-CRT policy now applies to every shipped
Windows native binary (helper exe, launcher, and the CEP-loaded transport
`.node` addon, via `CMAKE_MSVC_RUNTIME_LIBRARY`). Enforced by:

- `scripts/package/test/native-aegp-build-contract.test.mjs` — asserts `/MT`,
  forbids `/MD` in the build script;
- `native/ae-plugin/verify-windows.mjs` — rejects any `MSVCP140` /
  `VCRUNTIME140` / `ucrtbase` / `api-ms-win-crt` import in the AEX PE import
  table, on every official build (`scripts/package/test/verify-windows-aex.test.mjs`);
- `scripts/package/test/windows-native-transport.test.mjs` — the CI compile of
  the shared transport sources now uses `/MT`, matching the shipped artifact.

Verify manually with:

```powershell
dumpbin /imports AeMcpNative.aex | Select-String 'MSVCP140|VCRUNTIME140|ucrtbase'
```

### 2. CEP 11 runtime gaps on AE 2023/2024

CEP 11 embeds an older Node/Chromium (V8 8.8). Two failure classes:

- **Module resolution** — `require('node:crypto')` and similar fail; the panel
  service never reached port 11488. Bare builtin names (`require('crypto')`)
  resolve on both legacy CEP Node and current Node.
- **Missing runtime APIs** — `Object.hasOwn` (Node 16.9+), `Array.prototype.at`
  and `structuredClone` do not exist there, so host validation and panel UI
  paths would throw `TypeError` even after the module loaded.

**Fix (landed):** a dependency-free polyfill shim runs before anything else in
both contexts (`plugin/host/cep-runtime-compat.js`, required first in
`server.js`; `plugin/panel/src/cep-runtime-inject.js`, injected by esbuild).
`plugin/host/cep-runtime-contract.test.js` bans `node:` specifiers across the
manifest of CEP-executed host files (any quote/`import()` form), keeps that
manifest in sync with `server.js`'s requires, and asserts the shim loads first.

## Open follow-ups (tracked, not in the landed change)

The local build that a contributor reported as "working on 24.6.8" also carried
uncommitted death-hook and logging changes, so the merged code state
(`/MT` + the original `AEGP_DeathHook` + the original synchronous logger) has
**not** been verified on a real AE 2024 host, and AE 2023 has not been tested at
all. These are documented as investigations only:

- **Shutdown / `AEGP_DeathHook`** and **startup-path diagnostic logging** — a
  pre-`/MT` A/B build crashed on close with the death hook registered even with
  IPC disabled, and synchronous `CreateFileW`/`LockFile` during AEGP startup
  was implicated in the same confounded build. Both must be re-tested under
  `/MT` before any lifecycle change, and AE 2023 must be tested at all.
  Tracked in **#236**.
- **CEP 11 runtime-API coverage and Codex CLI discovery** — the polyfill shim
  closes the known gaps, but real-host panel flows on AE 2023/2024 still need a
  pass, and the WindowsApps/`AE_MCP_CODEX_CLI` probing improvement must route
  through the platform adapter (`no-platform-leaks` governance). Tracked in
  **#237**.

## Acceptance for a real AE 2023/2024 sign-off

- [ ] AE reaches the main UI without a native-plugin crash.
- [ ] `AeMcpNative.aex` imports no host C++ runtime DLLs (`dumpbin` above).
- [ ] Panel reports `Service running · 127.0.0.1:11488`, and a native endpoint
      is published for the current AfterFX PID.
- [ ] One read-only query and one additive mutation succeed through the panel.
- [ ] AE closes without `crash while invoking plug-in`.
- [ ] No new startup/operation/shutdown minidump is produced.
- [ ] Repeat on AE 2023.
