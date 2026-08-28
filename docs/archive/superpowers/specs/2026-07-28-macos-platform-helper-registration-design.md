# macOS Platform Helper Registration Design

> Archived 2026-08-28: platform-helper was removed, so this registration design is no longer active.

## Problem

The panel ships a valid macOS arm64 Platform Helper payload and a native XPC
transport, but the original implementation had two independent real-host
blockers:

1. no production or development startup path registered the bundled Mach
   service with the current user's launchd domain; and
2. Adobe's hardened `CEPHtmlEngine` does not carry
   `com.apple.security.cs.disable-library-validation`, so macOS rejects a
   non-Adobe-Team N-API addon before registration or XPC can begin.

The second fact was measured in real AE 26.3 after the registration unit was
installed: CEP Node 17.7.2 returned `ERR_DLOPEN_FAILED` because the Adobe process
and mapped addon have different Team IDs. Signing the addon with the product's
Developer ID does not solve that boundary; only Adobe could produce a library
that satisfies the host's same-Team requirement.

This is a transport-process placement defect, not a Provider credential,
protocol-version, or Keychain failure.

## Scope

Add the missing macOS registration lifecycle and move the macOS XPC client out
of the hardened Adobe process. The already-manifested Helper executable gains a
bounded `--client-stdio` mode: CEP spawns that exact verified binary, exchanges
one-line protocol frames over private inherited pipes, and the child opens the
existing Mach-service XPC connection. No TCP/UDP listener or plaintext
credential path is introduced.

The service authorizes either the legacy direct Adobe CEP peer or the broker
peer. A broker is accepted only when its native signature is valid for the
fixed Helper signing identifier, it is arm64, its direct parent is Adobe's
signed `CEPHtmlEngine Helper (Renderer)`, that renderer's direct parent is the
signed `CEPHtmlEngine`, and the stable ancestry then reaches a supported
trusted AE process. The XPC connection receives the matching broker code-signing
requirement before activation. This preserves the existing same-user,
audit-session, process-generation, Adobe ancestry, and rejected-peer
`backendAccessCount=0` boundaries.

The fix applies to both development and packaged panel installations. It does
not change Provider routing, accepted credentials, plaintext fallback policy,
Helper methods, protocol schemas, or release signing requirements.

Windows keeps its existing verified-helper spawn path.

## Design

### Verified payload boundary

Before invoking launchd, the host verifies the macOS helper root derived from
the loaded addon:

- `helper-manifest.json` is a regular, non-symbolic file with schema version 1,
  platform `macos-arm64`, and the expected Helper identifier;
- the manifest declares the exact reviewed seven-file macOS payload;
- every declared path resolves beneath the helper root and names a regular,
  non-symbolic file;
- each file matches its manifest SHA-256;
- the helper and launcher entrypoints match their reviewed relative paths.

This is the existing signed/helper security boundary, not a repository-source
identity check. Development may use its current locally built and explicitly
installed payload; release signing and audit gates remain unchanged.

### Per-user launchd registration

The host renders the bundled launchd template into a private state directory
outside Adobe's extension scan root. It substitutes only the verified absolute
Helper executable path, writes the result atomically with restrictive
permissions, and never accepts caller-provided plist content or executable
paths.

The transport invokes the fixed `/bin/launchctl` executable for the current
`gui/<uid>` domain. It first attempts to bootstrap the reviewed registration.
An already-loaded service is reused. Other launchctl failures become the
sanitized, retryable `HELPER_START_FAILED` lifecycle error.

The registration step completes before CEP spawns the stdio broker. The broker
opens XPC only after launchd registration is confirmed. The existing client then
performs the unchanged capabilities, protocol-version, method-set, Helper
version, and authenticated caller checks.

The panel does not boot out or restart an already-loaded Helper during routine
startup. This avoids disrupting another live After Effects panel. Updating a
loaded Helper remains an explicit install/restart operation.

### Failure and recovery behavior

No failure enables a plaintext Provider credential path. Missing or malformed
payloads fail closed with `PLATFORM_HELPER_REPAIR_REQUIRED`. Registration or
broker-spawn failures use `HELPER_START_FAILED`. XPC transport failures continue
to use `HELPER_UNAVAILABLE`; authorization and protocol errors retain their
current codes. Stderr is bounded and never copied into a public error.

The user-facing repair message remains bounded and does not expose helper
paths, launchctl output, credentials, or native error details.

## Verification

Tests are written before production changes and must demonstrate:

1. macOS transport cannot spawn its broker or issue a request until registration
   succeeds;
2. the exact reviewed manifest and payload are required before launchctl runs;
3. launchctl receives a fixed executable, current-user domain, and private
   generated plist;
4. an already-loaded service is reusable without bootout or process kill;
5. registration failure preserves the sanitized lifecycle code;
6. macOS CEP transport never attempts to load the N-API addon;
7. the broker accepts bounded frames, proxies XPC responses, and exits on EOF;
8. broker authorization requires the fixed broker identity, direct trusted CEP
   renderer, its trusted CEP parent, and supported trusted AE ancestry;
9. Windows startup behavior and all existing protocol/release guards remain
   unchanged.

Mutation proof removes the registration step and confirms the new transport
test fails, then restores it and confirms the test passes.

After focused host and panel tests, rebuild and component-sync only the changed
CEP panel. Real-machine verification uses the existing After Effects
installation and performs a read-only Helper `capabilities` call followed by
the pending non-candidate Claude Provider HDEV. It does not run packaged T5/T6,
install dependencies, or read/log plaintext credentials.
