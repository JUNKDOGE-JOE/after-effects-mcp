# macOS Platform Helper Registration Design

## Problem

The panel ships a valid macOS arm64 Platform Helper payload and a native XPC
transport, but no production or development startup path registers the bundled
Mach service with the current user's launchd domain. The addon can therefore
load successfully while its first request fails with the native error
`Couldn’t communicate with a helper application.` The panel then maps that
transport failure to a generic Provider initialization repair message.

This is a missing lifecycle step, not a Provider credential, protocol-version,
or caller-authorization failure.

## Scope

Add the missing macOS registration lifecycle to the panel-owned Platform Helper
transport. The fix applies to both development and packaged panel installations.
It does not change Provider routing, accepted credentials, plaintext fallback
policy, Helper methods, protocol schemas, caller authorization, or release
signing requirements.

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

The registration step completes before the native addon opens its XPC
connection. The existing client then performs the unchanged capabilities,
protocol-version, method-set, Helper-version, and authenticated Adobe CEP caller
checks.

The panel does not boot out or restart an already-loaded Helper during routine
startup. This avoids disrupting another live After Effects panel. Updating a
loaded Helper remains an explicit install/restart operation.

### Failure and recovery behavior

No failure enables a plaintext Provider credential path. Missing or malformed
payloads fail closed with `PLATFORM_HELPER_REPAIR_REQUIRED`. Registration
execution failures use `HELPER_START_FAILED`. XPC transport failures continue to
use `HELPER_UNAVAILABLE`; authorization and protocol errors retain their current
codes.

The user-facing repair message remains bounded and does not expose helper
paths, launchctl output, credentials, or native error details.

## Verification

Tests are written before production changes and must demonstrate:

1. macOS transport cannot issue a native request until registration succeeds;
2. the exact reviewed manifest and payload are required before launchctl runs;
3. launchctl receives a fixed executable, current-user domain, and private
   generated plist;
4. an already-loaded service is reusable without bootout or process kill;
5. registration failure preserves the sanitized lifecycle code;
6. Windows startup behavior and all existing authorization/protocol guards
   remain unchanged.

Mutation proof removes the registration step and confirms the new transport
test fails, then restores it and confirms the test passes.

After focused host and panel tests, rebuild and component-sync only the changed
CEP panel. Real-machine verification uses the existing After Effects
installation and performs a read-only Helper `capabilities` call followed by
the pending non-candidate Claude Provider HDEV. It does not run packaged T5/T6,
install dependencies, or read/log plaintext credentials.

