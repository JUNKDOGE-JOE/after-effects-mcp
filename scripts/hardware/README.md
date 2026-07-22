# Real-AE hardware drivers

These scripts call the same public MCP tools that a model sees. They do not
call Core handlers, the CEP HTTP bridge, or the native socket directly.

## Capability package #162

`issue162_layer_compositing_acceptance.py` is a thin wrapper around the shared
CLI/runtime; `issue162_layer_compositing_spec.py` contains only the ten-tool
matrix, one solid-layer recipe, semantic assertions, Undo steps, and restart
reacquisition. Seven fixed public switch tools intentionally share one closed
native capability, while the model never receives a generic SDK flag.

Run `preflight` before candidate freeze. It uses three public calls to prove
the exact deployed identity, create one disposable composition/solid fixture,
read compositing state, and archive the fixture without candidate evidence.
Because #162 is the first real-machine write use of LayerSuite9 flag/quality/
transfer setters, `t4` is one four-call non-candidate smoke: two previously
verified fixture-support writes, one visibility write, one real AE Undo, and
one compositing read that verifies restoration. It does not restart AE or run
the package matrix.

T5/T6 each use exactly 24 public calls: two fixture-support writes, one baseline
read, nine package writes, nine post-Undo reads, two restart locator reads, and
one final compositing read. They keep one `ephemeral-validation` fixture,
produce no Save As copies, restart only the explicit formal AE application,
and archive the fixture after structured evidence is complete.

```sh
PYTHONDONTWRITEBYTECODE=1 uv run --frozen python \
  scripts/hardware/issue162_layer_compositing_acceptance.py \
  --mode preflight \
  --expected-sha 0123456789abcdef0123456789abcdef01234567 \
  --fixture-path '/absolute/local/active/issue162-layer-compositing.aep' \
  --recovery-archive-root '/absolute/local/recovery/ae-mcp-fixtures' \
  --native-receipt /absolute/candidate/native/build-receipt.json \
  --native-manifest /absolute/candidate/native-plugin-manifest.json \
  --evidence-dir '/absolute/private/evidence/issue162-preflight'
```

## Capability package #157

`issue157_keyframe_authoring_acceptance.py` is the thin CLI and
`issue157_keyframe_authoring_spec.py` owns the package-specific matrix,
fixture recipe, target-field assertions, Undo semantics, and interaction
order. Stable exact-identity, public-MCP, evidence, call-budget, checkpoint,
and `.aep` lifecycle mechanics are shared by `capability_package_runtime.py`;
the shared code does not infer package semantics.

Run `preflight` before candidate freeze. It emits `candidateEvidence=false`,
uses exactly seven public calls, proves the deployed base launcher/CEP/native
identity and its existing support-tool contracts, creates/saves/archives one
disposable fixture, and verifies that the
Opacity property locator remains valid across a native property write and a
real AE Undo. It does not require or advertise the seven unbuilt package
capabilities. A preflight failure is T0-T2 work, not T4/T5 evidence.
Before the first Save, one public `ae_listProjectItems(offset=0, limit=1)` read
proves readiness and completes pairing. Only after that read succeeds does the
runner save the still-empty project, before composition creation or any locator
acquisition. Later archival saves the populated project in place. This avoids
both an abandoned AEP after pairing failure and locators invalidated by AE's
first-save project-generation advance while keeping `saveAsCopies=0`.

If the first call in a native-host epoch returns `NATIVE_PAIRING_REQUIRED` with
`sideEffect=not-started`, the runner emits one `pair-native` checkpoint and
retries the identical request once. The failed handshake is excluded from the
seven effective `publicCalls` and reported separately as `handshakeAttempts`.
Neither the short-lived fingerprint nor any token is written to evidence. A
rejection or a second pairing-required response in that epoch fails closed
without another retry. After the formal-AE restart, the new host instance starts
one new pairing epoch under the same rule.

T5/T6 each use exactly 28 public calls: all seven package tools, scalar and
spatial behavior paths, a real Undo for all six writes with post-Undo state
verification, one formal-AE restart, fresh Opacity/Position locator
reacquisition, and archival
of the single active fixture. Every public call,
including support and expected-error calls, is counted by one ledger; the
runner aborts before dispatching call 31. Package #157 has no new native suite,
lifecycle, or main-thread primitive, so it deliberately has no T4 mode.
The RuntimeManager current record, generation launcher and canonical
`$HOME/.ae-mcp/bin/ae-mcp` launcher must all report the same locked launcher
SHA-256; an alternate `--launcher` path is rejected.

After Effects retains per-keyframe temporal-ease speed only when the keyframe
has an adjacent keyframe on both sides; on an isolated keyframe AE applies the
influence but normalizes speed back to 0. The strict native/host/Core readback
rightly rejects that partial application as `POSSIBLY_SIDE_EFFECTING_FAILURE`,
so the driver seeds the two neighbor keys (0 at 0s, 80 at 2s) through the
public `ae_addLayerPropertyKeyframe` tool before any matrix write. Seeding
through ExtendScript or the GUI instead would advance the native project
generation and invalidate every locator the driver already holds; the first
post-seed write is then correctly rejected as `PRECONDITION_FAILED`. The
neighbor seeds are fixture preconditions, not tested operations: they receive
no Undo checkpoint, they are counted in the five `add` invocations, and each
write Undo still reverts only its own write group. Within the 28-call budget,
the INTERPOLATION write's own `beforeKeyframe` — AE state at the same exact
time through the same public surface — must equal the baseline, which verifies
the VALUE Undo without a dedicated details readback; every other write keeps
its independent post-Undo details readback, and the missing-keyframe error
contract is proven by the post-Undo-ADD probe. If any write returns
`POSSIBLY_SIDE_EFFECTING_FAILURE`, the driver exits with status 3 without
retrying, including when the session layer wraps the failure in an exception
group; inspect AE state and the native audit trail before deciding how to
recover.

```sh
PYTHONDONTWRITEBYTECODE=1 uv run --frozen python \
  scripts/hardware/issue157_keyframe_authoring_acceptance.py \
  --mode preflight \
  --expected-sha 0123456789abcdef0123456789abcdef01234567 \
  --fixture-path '/absolute/local/active/issue157-keyframes.aep' \
  --recovery-archive-root '/absolute/local/recovery/ae-mcp-fixtures' \
  --native-receipt /absolute/candidate/native/build-receipt.json \
  --native-manifest /absolute/candidate/native-plugin-manifest.json \
  --evidence-dir '/absolute/private/evidence/issue157-preflight'
```

## Capability package #155

`issue155_layer_timeline_acceptance.py` is the frozen driver for the Layer
Timeline Editing package. T5/T6 exercise all eight public tools in one formal
AE session, verify all seven writes with real Undo/readback, save the single
active fixture in place, restart formal AE, reacquire fresh locators, and prove
the post-restart state still matches the stable post-Undo baseline. T4 is the
narrow duplication primitive smoke.

The fixture lifecycle is always `ephemeral-validation`. The exact fixture path
must be an absent absolute `.aep` path before preflight. The runner permits one
first save and no Save As copies; after successful acceptance it moves the
closed fixture into a unique run directory under the explicit recovery archive
root. That root must be outside every Adobe CEP and plug-in scan root.

```sh
PYTHONDONTWRITEBYTECODE=1 uv run --frozen python \
  scripts/hardware/issue155_layer_timeline_acceptance.py \
  --mode t5 \
  --expected-sha 0123456789abcdef0123456789abcdef01234567 \
  --fixture-path '/absolute/local/active/issue155-layer-timeline.aep' \
  --recovery-archive-root '/absolute/local/recovery/ae-mcp-fixtures' \
  --stretch-percent 125.5 \
  --native-receipt /absolute/candidate/native/build-receipt.json \
  --native-manifest /absolute/candidate/native-plugin-manifest.json \
  --evidence-dir '/absolute/private/evidence/issue155-t5'
```

At `restart-ae`, save the current exact fixture in place before quitting. Start
only the explicit formal AE application path and reopen the fixture through AE,
never Finder/LaunchServices. The driver binds every response to the latest
formal native load record, requires both host instance and session to change,
and rejects any fixture-state drift before archival.

## Capability package #150

`issue150_project_composition_acceptance.py` is the frozen hardware driver for
the Project / Composition Context & Mutation package.

- `t4`: one narrow native-novelty smoke for composition duplication and real
  After Effects Undo.
- `t5`: one exact-candidate run covering all eight package tools, all five
  writes and their real Undo/readback checkpoints, then AE restart/reconnect
  and stale-locator rejection.
- `t6`: the same package matrix rebuilt and reinstalled from the clean merge
  commit.

Example (use only a disposable fixture project):

```sh
PYTHONDONTWRITEBYTECODE=1 uv run --frozen python \
  scripts/hardware/issue150_project_composition_acceptance.py \
  --mode t5 \
  --expected-sha 0123456789abcdef0123456789abcdef01234567 \
  --fixture-composition-name 'Issue150 Fixture' \
  --renamed-name 'Issue150 Renamed' \
  --duplicate-name 'Issue150 Duplicate' \
  --comment-value 'Issue #150 acceptance' \
  --label-id 6 \
  --work-area-start 24/24 \
  --work-area-duration 48/24 \
  --native-receipt /absolute/candidate/native/build-receipt.json \
  --native-manifest /absolute/candidate/native-plugin-manifest.json \
  --evidence-dir "$HOME/Library/Application Support/AfterEffectsMCP/issue150/evidence"
```

T4, T5 and T6 all fail closed unless the canonical CEP
`bundle-manifest.json`, RuntimeManager `current` pointer and selected
`install-record.json`, supplied native receipt/manifest, and every public
response report the same full candidate SHA. Component and artifact hashes
are recorded in the private evidence log.

The frozen package matrix has eight public acceptance rows: three reads and
five writes. `ae_listProjectItems` is an existing support read used only for
independent project-count and duplicate readback; its descriptor is pinned by
the driver, but it is not a ninth package acceptance row.

The orchestrator reads each `CHECKPOINT_REQUIRED` line, performs the authorized
GUI action, and writes exactly one acknowledgement line:

```json
{"checkpointId":"the-emitted-id","status":"completed"}
```

Pairing, Undo and restart are deliberately explicit checkpoints. Pairing
fingerprints and private paths are available only in the live checkpoint and
are redacted before evidence is persisted. Evidence files use mode `0600` in a
`0700` directory.

Before completing the emitted `preflight-ae` checkpoint, open only the
disposable #150 project in the formal After Effects app, make the named source
composition active, and select it in the Project panel. The driver resolves the
fixture only through public project-context results. Keep the disposable
project at 49 items or fewer so the duplicate and independent count readback
remain in the bounded first page. After restart, restore the same
active/selected state if After Effects did not preserve it.

If any write returns `POSSIBLY_SIDE_EFFECTING_FAILURE`, the driver exits with
status 3 without retrying. Inspect AE state and the native audit trail before
deciding how to recover.

Every write is surrounded by a normalized complete semantic snapshot. The
driver rejects collateral changes, then requires a real GUI Undo and proves
the complete snapshot returned to its baseline. It also recomputes each typed
postcondition digest using the RFC 8785/JCS-compatible package value shape.
