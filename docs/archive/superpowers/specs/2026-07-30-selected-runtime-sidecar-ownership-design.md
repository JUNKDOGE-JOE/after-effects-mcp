# Selected Runtime Sidecar Ownership Design

> Archived 2026-08-28: RuntimeManager and sidecar ownership were removed with the former runtime plane.

## Context

Issue #148 now has one remaining outcome after PR #201: the production Claude
Agent sidecar must come from the verified runtime generation selected by
RuntimeManager. Today `resolveSidecarPath()` constructs a path below the
extension bundle and explicitly does not consult RuntimeManager's selection.
That can pair the selected Node executable with sidecar code from a different
payload generation.

The sidecar is an auxiliary Node process used by the panel's embedded Claude
and Provider flows. It is not the MCP Core, the CEP host, or the in-process
AEGP plug-in.

## Decision

The panel will consume RuntimeManager's existing verified selection receipt
instead of adding another runtime-pointer reader or a general payload registry.

On macOS production paths:

1. RuntimeManager finishes `ensureReady()` and returns its existing
   `componentReceipt`.
2. The panel passes that selected runtime result to `resolveSidecarPath()`.
3. The resolver validates that the receipt describes the expected
   `core-runtime` component for the active platform and carries an absolute
   canonical path within RuntimeManager's runtime root.
4. The resolver derives
   `node/sidecar/agent-sidecar.mjs` below that canonical runtime directory.
5. Claude login probing waits until this selected path is available. It never
   probes the extension bundle's production runtime as an interim fallback.

RuntimeManager already verifies the selected runtime manifest and its file
inventory before returning the receipt. The sidecar resolver therefore does
not rehash the runtime tree or independently parse `runtime/current`.

## Platform Behavior

- A `.debug` development extension continues to use
  `<extension>/sidecar/agent-sidecar.mjs`.
- Windows keeps its existing bundled path
  `<extension>/runtime/windows-x64/node/sidecar/agent-sidecar.mjs`; Windows has
  no RuntimeManager selection contract in this Issue.
- macOS production requires the verified RuntimeManager selection. It does not
  fall back to an extension-owned sidecar path.

## Error Contract

Before a macOS production selection is ready, Claude probing remains pending
and does not spawn Node.

An incompatible selection produces a bounded compatibility error before
sidecar dispatch. Incompatible means that the receipt:

- is not for component `core-runtime`;
- does not match the active platform;
- lacks an absolute canonical path; or
- resolves outside RuntimeManager's runtime root.

A selected sidecar that cannot be started is reported with its selected path;
the panel does not retry another payload copy. Existing RuntimeManager errors
remain authoritative when no verified generation can be selected.

## Wiring

`App.jsx` will derive the sidecar selection from `runtimeActivation.result`.
The Claude backend will be recreated when the selected path changes, matching
the existing React dependency behavior. The automatic login probe will run
only after a valid development, Windows, or selected macOS path exists.

No new RuntimeManager method or cross-payload abstraction is introduced.

## Verification

Test-driven changes will cover:

- macOS production chooses the active verified generation even when an
  extension-bundled sidecar also exists;
- retained and fallback RuntimeManager results select their own canonical
  generation payload;
- absent or incompatible macOS selections do not resolve or spawn an extension
  fallback;
- `.debug` development behavior remains unchanged;
- Windows behavior remains unchanged; and
- App wiring waits for runtime activation and passes the selected result into
  the resolver.

Run the focused panel tests for Claude authentication, RuntimeManager, and
runtime activation wiring. Expand to the complete panel test suite after the
focused tests pass. A single ordinary non-candidate HDEV is required only if
the implementation changes the installed-runtime behavior beyond this tested
path selection.

## Non-Goals

- PID, start-token, heartbeat, process-restart census, or generalized runner
  infrastructure.
- RuntimeManager lock, pruning, repair, or pointer-lifecycle changes.
- Full runtime-tree hashing on routine startup.
- Windows RuntimeManager work.
- Claude sidecar protocol or Provider feature changes.
- macOS helper registration, ScreenCaptureKit, signing, notarization, or
  installer work.

## Completion

Issue #148 is complete when macOS production Sidecar selection is derived only
from RuntimeManager's verified active result, incompatible selections fail
before dispatch without another payload fallback, development and Windows
behavior remain unchanged, and the focused plus complete panel suites pass.
