# Snapshot Truthfulness and macOS Helper Repair Design

> Archived 2026-08-28: `ae_snapshot`, snapshot-mss, and platform-helper were removed.

Date: 2026-07-30

Issues: #178, #66

Status: Approved for written-spec review

## Goal

Deliver one deliberately batched product PR with two independently reviewable
outcomes:

1. `snapshot-mss` advertises only the platform support it actually implements.
2. A user can explicitly repair a stale macOS platform-helper registration from
   the panel without a developer shell command.

The two outcomes share a branch, PR, review, and CI run because the user
explicitly selected them as one delivery unit. They do not share implementation
state, and each keeps its own tests and acceptance disposition.

## Current Observed State

### Issue #178

`MssSnapshotter.supports_platform()` currently returns `True` on every platform,
but its AE-window lookup and capture path is implemented only for Windows. On
macOS and Linux, discovery can select the backend and expose `ae.snapshot`, but
the call then fails because no AE window handle can be resolved.

The macOS platform helper does not make this claim true. Its ScreenCaptureKit
backend remains a separate unfinished capability owned by #67.

### Issue #66

PR #196 already delivered the original positive-path registration mechanism:

- the panel verifies the staged helper payload;
- a private per-user launchd plist is materialized;
- an absent service is bootstrapped without a manual `launchctl` command;
- a service already pointing at the exact current helper is reused;
- the real CEP path reaches XPC through the verified helper's stdio broker.

The remaining reproduced gap is narrower than the old issue body. If the fixed
product launchd label is already registered to a different helper path, startup
fails closed with `PLATFORM_HELPER_REPAIR_REQUIRED`, but the panel provides no
supported action to replace that stale registration.

Signed install, update, rollback, uninstall, reboot, clean-machine acceptance,
and production attestation remain release work in #69 and #70.

## Design Decisions

### One PR, Two Independent Tracks

The PR will contain separate logical commits and test groups for #178 and #66.
No #178 code will depend on the helper repair path, and completing helper repair
will not cause `snapshot-mss` to claim macOS support.

### Track A: Truthful `snapshot-mss` Platform Support

`MssSnapshotter.supports_platform()` will return `True` only when
`sys.platform == "win32"`.

The existing discovery and public-tool filtering behavior remains unchanged:

```text
Windows
  -> snapshot-mss is eligible
  -> ae.snapshot can be selected and exposed

macOS or Linux
  -> snapshot-mss is ineligible
  -> it is not selected
  -> ae.status does not report it
  -> ae.snapshot is not exposed through tools/list
```

Tests will cover Windows, Darwin, and Linux predicates plus the discovery/tool
filtering consequence. User-facing package metadata and English/Chinese
documentation will stop calling this backend cross-platform.

This track does not implement macOS/Linux window lookup, ScreenCaptureKit, TCC
handling, full-screen fallback, or changes to the native `ae.previewFrame`
path.

### Track B: Explicit macOS Helper Repair

Routine startup behavior remains unchanged:

```text
service absent
  -> bootstrap current verified helper

service points to current verified helper
  -> reuse registration

service points to another path
  -> fail closed with PLATFORM_HELPER_REPAIR_REQUIRED
  -> offer explicit Repair Helper action
```

Repair is user-triggered and operates only on the repository's fixed,
product-owned launchd label. It will:

1. reverify the current staged helper manifest and payload;
2. inspect the current registration again;
3. boot out the fixed per-user service;
4. treat an already-absent service as a recoverable intermediate state;
5. atomically materialize the plist for the current verified helper;
6. bootstrap the service;
7. use `launchctl print` to verify that the loaded Program exactly matches the
   current verified helper;
8. recreate the panel transport and call `capabilities()` to prove a real
   helper handshake.

The normal startup path will not automatically boot out or restart a stale
registration. The repair path will not inspect or modify unrelated launchd
services.

### Panel State

The Repair Helper action is shown only for the specific
`PLATFORM_HELPER_REPAIR_REQUIRED` state. While repair is running, the action is
disabled so one panel instance cannot issue concurrent repairs.

On success, the panel replaces the failed transport/client, completes the
capability handshake, clears the repair-required state, and returns to its
normal ready state.

On failure, the panel remains in a repairable state and shows the existing
sanitized diagnostic code. It does not blindly retry. A missing service during
the explicit `bootout` step is the only ignored launchctl condition because the
desired next state is already reached.

### Error and Recovery Boundary

The repair API returns structured outcomes for:

- current helper payload verification failure;
- `bootout` failure other than service-not-found;
- plist materialization failure;
- `bootstrap` failure;
- loaded Program mismatch after bootstrap;
- transport creation or `capabilities()` handshake failure.

No PID tracking, start-token comparison, process census, generalized runner
framework, routine full-tree hash walk, or automatic multi-instance
coordination is added. A newly discovered edge case is a current blocker only
if it reproduces on this explicit repair acceptance path; otherwise it is a
follow-up or out of scope under AGENTS.md section 5.

## Expected Change Surface

Track A is expected to touch:

- `packages/snapshot-mss/ae_mcp_snapshot_mss/__init__.py`
- `packages/snapshot-mss/tests/test_mss_snapshot.py`
- snapshot discovery/public-tool tests only if needed to expose the behavioral
  consequence directly
- `packages/snapshot-mss/pyproject.toml`
- `packages/snapshot-mss/README.md`
- `README.md`
- `README.zh-CN.md`

Track B is expected to touch:

- `plugin/host/platform-helper-registration.js`
- `plugin/host/platform-helper-registration.test.js`
- `plugin/host/platform-helper-transport.js`
- `plugin/host/platform-helper-transport.test.js`
- `plugin/panel/src/cep/hostBridge.js`
- focused host-bridge tests
- the panel settings state/action wiring and focused tests
- generated `plugin/client/dist/app.js`

The exact file list may contract after test-first implementation. Expanding
into Swift protocol code, RuntimeManager, installer/uninstaller, signing,
notarization, Keychain policy, ScreenCaptureKit, or AEGP is out of scope unless
the approved acceptance path reproduces a blocker there.

## Verification

### Track A

- red-first predicate tests for Windows, Darwin, and Linux;
- discovery/public-tool filtering test proving unsupported platforms do not
  expose `ae.snapshot`;
- existing mocked Windows capture tests remain green;
- documentation and package metadata no longer claim cross-platform support.

No AE hardware run is required because the capture implementation and Windows
runtime path do not change.

### Track B Focused Tests

Registration tests cover:

- absent registration bootstrap;
- exact-path idempotent reuse;
- stale-path startup fail-closed;
- explicit stale-path replacement;
- service already absent during repair;
- bootstrap failure;
- post-bootstrap Program mismatch.

Host/panel tests cover:

- Repair Helper appears only for the repair-required state;
- the action is single-flight in the UI;
- success rebuilds the transport and completes `capabilities()`;
- failure leaves a sanitized, retryable repair state;
- Windows behavior remains unchanged.

The affected host/panel suites, generated-bundle checks, packaging contracts,
and required CI must pass.

### Real macOS/AE Acceptance

Before merge, one prepared narrow HDEV will:

1. create a controlled stale registration for the product-owned label;
2. start the real AE panel and observe the repair-required state;
3. trigger Repair Helper through the panel;
4. verify the loaded Program is the current verified helper;
5. call `capabilities()` from the real CEP path and verify protocol/method
   metadata and authenticated caller state;
6. set, read back, and delete one non-sensitive temporary secret;
7. complete one representative public MCP read to prove the panel/Core path
   remains live.

No `.aep` fixture or AE project mutation is required.

After merge, a clean-`main` build repeats only the minimal helper
repair/handshake smoke. This is not an AEGP capability package and does not run
native T5/T6 or create candidate project evidence.

## Review and Closure

Use one concentrated subagent review by default and no more than two rounds.
Only a reproduced acceptance blocker expands the implementation. CI and HDEV
results are evidence for the separate per-issue dispositions:

- close #178 when the truthful predicate, filtering consequence, documentation,
  and required CI are verified;
- close #66 when explicit repair passes focused tests, real AE HDEV, merge, and
  the clean-`main` repair/handshake smoke;
- leave signed installer lifecycle and production attestation in #69/#70;
- leave macOS capture implementation and truthful ScreenCaptureKit capability
  reporting in #67.
