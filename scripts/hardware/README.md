# Real-AE hardware drivers

These scripts call the same public MCP tools that a model sees. They do not
call Core handlers, the CEP HTTP bridge, or the native socket directly.

## Shared capability-package runtime contract

This is the lookup contract for `capability_package_runtime.py`. It describes
the checked-in implementation, not a broader runner design. The shortest map is:

| Concern | Shared runtime owns | Package driver owns |
| --- | --- | --- |
| Public transport | MCP session creation and one-object JSON decoding | Requests, call order, and semantic assertions |
| Package declaration | Tool rows, capability IDs, kinds, and call limits | The actual `PackageSpec` values |
| Verification | Native envelope, provenance, audit, digest, effect, and basic Undo claims | Before/after projections, interaction invariants, and post-Undo readback |
| Lifecycle | One active ephemeral fixture's admission, identity, counters, recovery, and archive move | The fixture recipe and every AE action requested at a checkpoint |
| Evidence | Redacted event stream, summary, completion table, and public-call ledger | Calling `mark_tool_passed` only after package semantics really pass |

The module intentionally stops before becoming a plan language: exact request
builders, semantic projections, fixture recipes, Undo checks, and interaction
order remain package code
(`capability_package_runtime.py:2-9`).

### What the runtime provides

- `ToolCase` declares one public tool, native capability, read/write kind, and
  maximum primary invocations. `PackageSpec` requires 5-15 package tools
  (5-30 for a milestone), unique names/keys, and bounded T4/T5/T6 targets and
  hard limits. Support tools contribute required capabilities but do not get
  package matrix rows (`capability_package_runtime.py:127-206`).
- `CallLedger` accepts only `preflight`, `t4`, `t5`, and `t6`. Preflight is
  fixed at target/hard limit 7; other limits come from `PackageSpec`. Every call
  routed through `AcceptanceRuntime.call` is counted by tool and phase, including
  support calls and expected errors (`capability_package_runtime.py:247-294`,
  `805-855`).
- `LiveSessionFactory` launches only the supplied stable launcher, constructs a
  deliberately small environment, initializes MCP over stdio with a 45-second
  read timeout, and snapshots `tools/list`. A public result is accepted only
  when it contains exactly one text block decoding to a JSON object
  (`capability_package_runtime.py:422-476`).
- `validate_machine_identity` delegates to the exact-identity checker and saves
  its component signals, source revisions, contract digests, and formal-AE
  identity. `bind_latest_native_load` separately binds subsequent results to the
  newest valid formal-AE load record and optionally proves an AE restart changed
  the native instance (`capability_package_runtime.py:557-629`).
- Successful calls must agree on native engine, capability/version/contract,
  source revision, host and session, audit/request identities, effect, and
  verified postcondition digest. Writes additionally require the declared Undo
  envelope and replay flag (`capability_package_runtime.py:647-803`).
- `intent()` returns a run-scoped deterministic-shape idempotency key with a
  per-runtime counter; it is not stable across runs because the evidence run ID
  is part of its hash (`capability_package_runtime.py:631-636`).

### What a package driver must implement

The shared CLI constructs identity, fixture, evidence, session, and runtime
objects, calls `package_factory(runtime, fixture_name)`, then awaits
`package.run()` (`capability_package_cli.py:79-120`). A package driver therefore
must supply:

1. a concrete `PackageSpec` and factory;
2. an async `run()` that selects the behavior for `runtime.mode`;
3. the disposable fixture recipe, request arguments, operation ordering, and
   semantic before/after projections;
4. calls to `validate_machine_identity`, `bind_latest_native_load`,
   `require_tools`, and `runtime.call` at the appropriate points;
5. independent package assertions around every write and its real Undo or
   documented alternative;
6. `mark_tool_passed` only after that tool's complete acceptance row has passed;
   and
7. a details mapping returned from `run()` for the completion summary.

The runtime validates the native response envelope, but it does not know whether
a package-specific value is correct. `mark_tool_passed` merely changes the row
and optional Undo counters; it performs no readback itself
(`capability_package_runtime.py:857-870`). `EvidenceLog.finish` serializes the
matrix it is given and does not require every row to be passed
(`capability_package_runtime.py:348-390`). Matrix completeness is therefore a
driver invariant, not an automatic runtime gate.

### Checkpoint semantics

`runtime.checkpoint(kind, details)` records `checkpoint-requested`, awaits the
configured handler, then records `checkpoint-completed`
(`capability_package_runtime.py:638-641`). The default stdin handler:

1. emits one JSON `CHECKPOINT_REQUIRED` line with a random checkpoint ID;
2. reads exactly one line from stdin; and
3. accepts only JSON with that same ID and `status="completed"`.

EOF, malformed JSON, a mismatched ID, or any other status fails the run
(`capability_package_runtime.py:479-507`). Completion is only an
acknowledgement. The handler does not inspect AE or prove the requested GUI
action occurred; the driver must perform the public readback or other
postcondition after the acknowledgement.

### Fixture lifecycle hooks

- `FixturePolicy` requires an absolute `.aep` path, absolute recovery root,
  positive retention, and exactly the `ephemeral-validation` lifecycle
  (`capability_package_runtime.py:209-222`).
- Call `require_fixture_absent()` before creation. It rejects any existing path,
  including a symlink, rather than overwriting it
  (`capability_package_runtime.py:872-876`).
- After the first in-place save, `mark_fixture_created()` requires a nonempty
  regular non-symlink file, hashes it, sets `created=1`, and records
  `activeFixtureCount=1` and `saveAsCopies=0`
  (`capability_package_runtime.py:878-911`).
- `recover_zero_call_fixture()` acts only when the ledger is still zero, the
  fixture was marked created, and the path still exists. It moves that exact
  file to a new run directory under recovery and records a cleanup condition;
  it does not delete it (`capability_package_runtime.py:913-956`).
- `archive_fixture()` first checkpoints a save-in-place, close, and formal-AE
  quit. It rejects recovery roots inside Adobe scan roots, then moves the file
  into a unique run directory and verifies size and SHA-256 after the move
  (`capability_package_runtime.py:962-1020`).

The shared CLI invokes zero-call recovery only from its failed-run `finally`
block (`capability_package_cli.py:123-152`). A custom wrapper gets no automatic
recovery merely by constructing `AcceptanceRuntime`; it must reproduce that
finally-path or use the shared CLI.

### Mode selection

The ledger recognizes all four modes, but the runtime does not decide whether a
package is entitled to T4 or what each mode does
(`capability_package_runtime.py:247-266`). The shared CLI exposes all four
choices (`capability_package_cli.py:37-50`); a package-specific CLI may expose a
smaller set. The package's `run()` owns the mode branch and must reject an
inapplicable mode.

`EvidenceLog` labels only T5/T6 as candidate runs, and
`candidateEvidence=true` is assigned only when such a run finishes with
`passed=true`. Preflight and T4 remain non-candidate even when successful
(`capability_package_runtime.py:300-317`, `348-373`).

### Evidence emission and failure edges

The evidence directory is forced to mode `0700`. The runtime writes an
append-only NDJSON event stream and exclusive summary JSON/completion Markdown
files at mode `0600`; values are redacted before persistence
(`capability_package_runtime.py:297-390`). Keys matching token, secret,
fingerprint, socket, private path, fixture/project path, or home are replaced
entirely. Private macOS and Windows user-path substrings in other strings are
also replaced (`capability_package_runtime.py:40-47`, `110-124`).

Three edges are easy to misread:

- `AcceptanceRuntime.call` checks capacity before dispatch but reserves the
  ledger entry and emits request/response events only after `session.call`
  returns. A transport exception can therefore leave the count unchanged; zero
  new ledger entries do not prove a write was not dispatched
  (`capability_package_runtime.py:805-827`).
- A decoded `POSSIBLY_SIDE_EFFECTING_FAILURE` is recorded, then immediately
  raises `PossiblySideEffectingStop`. The runtime never retries it
  (`capability_package_runtime.py:828-840`).
- Every individual NDJSON event carries `candidateEvidence=false`; only the
  final summary can set it true after a passing T5/T6 run. Consumers must read
  the summary rather than infer candidate status from an event row
  (`capability_package_runtime.py:324-380`).

## Ordinary development HDEV

`development_smoke.py` is the permanently non-candidate real-AE proof for
ordinary AE-changing PRs. Scenario `core-native-write-undo@1` performs exactly
seven public MCP calls: readiness, composition creation, complete settings
before/after one background write, post-Undo locator reacquisition, and
complete restored settings. It never runs T5/T6, never uses the stable
RuntimeManager launcher, and every event and summary records
`validationProfile=development`, `candidateRun=false`, and
`candidateEvidence=false`.

Run it through the component-selective CLI after read-only doctor and exact
formal-AE launch, or directly:

```bash
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python3 -B -I \
  scripts/hardware/development_smoke.py \
  --scenario core-native-write-undo@1 \
  --selected-components core \
  --reused-components cep,native \
  --checkout "$PWD" \
  --fixture-path "$HOME/Library/Application Support/AfterEffectsMCP/fixtures/active/hdev-core-native.aep" \
  --recovery-archive-root "$HOME/Library/Application Support/AfterEffectsMCP/fixtures/recovery" \
  --evidence-dir "$HOME/Library/Application Support/AfterEffectsMCP/evidence/hdev-core-native" \
  --formal-ae-app "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app"
```

The first checkpoint saves one empty `ephemeral-validation` project. The
driver never creates a Save As copy. After one explicit real Undo and
independent public readback, the final checkpoint closes formal AE; only then
does the driver archive the exact fixture. Stop immediately on an incompatible
wire/capability/RPC digest, strict product-version mismatch, failed native load,
`POSSIBLY_SIDE_EFFECTING_FAILURE`, corrupted fixture baseline, or AE crash.
Never retry an uncertain write.

### Issue #190 layer source, Track Matte, and AV HDEV

`issue190_layer_source_matte_av_acceptance.py` is the package-specific,
current-checkout HDEV for the eight Issue #190 public tools. Run it only after
the read-only development doctor confirms the canonical component pointers,
install receipts, compatible component/protocol versions, file sizes, and
modification times. Reuse unchanged CEP and dependency state; do not turn this
ordinary development run into a full runtime hash walk or reinstall unchanged
components. The `selected-components` and `reused-components` arguments must
describe the components actually synchronized for this checkout.

From the exact checkout being tested:

```bash
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -B -I \
  scripts/hardware/issue190_layer_source_matte_av_acceptance.py \
  --scenario issue190-layer-source-matte-av@1 \
  --selected-components core,native \
  --reused-components cep \
  --checkout "$PWD" \
  --evidence-dir "$HOME/Library/Application Support/AfterEffectsMCP/evidence/hdev-issue190" \
  --formal-ae-app "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app"
```

The driver derives a fresh run-ID `.aep` beneath the canonical
`$HOME/Library/Application Support/AfterEffectsMCP/fixtures/active` root; the
CLI does not accept an external fixture or recovery path. Before touching AE it
creates an exclusive `O_EXCL` ownership manifest that binds the run ID,
`ephemeral-validation` lifecycle, active/recovery/evidence roots, and cleanup
condition. It refuses an existing target, symlink, path escape, or mismatched
manifest.

The fixed harness-only ExtendScript closes only an empty untitled project. It
blocks every other saved or nonempty untitled project before close/save and
may reuse only the exact runner-owned fixture with the matching embedded owner
marker and manifest. It never overwrites an existing unowned path. Its exact
named roles are `SOURCE_COMP_A`,
`SOURCE_COMP_B`, `RELINK_TARGET`, `MATTE_FILL`, `MATTE_SOURCE`,
`MATTE_SPACER`, `VIDEO_SWITCH`, and `AUDIO_SWITCH`; the anonymous 250 ms PCM
WAV is generated beneath the approved fixture area. Product reads and writes
use public MCP only. Harness-only code performs the five real-Undo checkpoints,
and every Undo is followed by public locator reacquisition and exact readback.
After success or failure, the driver saves in place only when ownership still
matches, closes formal AE when it is running, and moves the `.aep`, manifest,
and WAV to a per-run recovery directory with zero active and zero unclassified
fixtures. A reconciled/restored or pre-dispatch failure is short-lived
recovery. An unreconciled write or post-dispatch crash is a classified evidence
snapshot with reason, cleanup condition, and `baselineRestored=false`; if AE is
already gone, the driver archives the disk fixture without claiming that Undo
or baseline restoration occurred. It never resets/deletes an unreconciled
fixture or accumulates Save As copies. Base HDEV, checkpoint, and process
inspection exceptions enter this same finalizer. If normal guarded close fails,
the runner may use the exact owned-process shutdown checkpoint only after the
run-bound manifest, fixture, formal app, and process ownership are proven; it
never stops an unverified AE process. If stop cannot be confirmed, the runner
raises without emitting a falsely complete lifecycle summary.

The frozen ledger dispatches exactly 40 public MCP calls and aborts before call
41. It covers source replacement/preservation/replay/Undo, non-adjacent Track
Matte set and reorder stability, Luma clear with stored-mode preservation,
audio/video disable and Undo, and all five structured negative cases. A
write stays pending until its frozen public readback passes. A
`POSSIBLY_SIDE_EFFECTING_FAILURE` or post-dispatch transport loss reuses the
original operation key, response/audit identifiers, and only already-planned
readback calls to classify it as committed-reconciled,
not-occurred-reconciled, or unreconciled; it is never retried. A successful
source replacement remains pending across its entire ordered verification
group: project reacquisition, layer reacquisition, source readback, and keyed
transform witness. Failure at any of those rows enters the same associated
harness Undo and frozen locator-reacquisition/baseline reads before any
independent case can continue. A BEFORE-state reconciliation never relabels an
unsatisfied frozen AFTER predicate as PASS: the read row records the observed
state as FAIL while the write separately records
`not-occurred-reconciled`.

All five negative probes are mutating public tools with fresh stable operation
keys. Their expected structured `sideEffect=not-started` result is the only
safe negative PASS. Possible side effect, post-dispatch transport loss, or
unexpected success stops immediately as unreconciled and preserves a
classified evidence snapshot; because no frozen negative-state read exists,
the driver never invents reconciliation or retries the probe.
An unreconciled write stops immediately and preserves the fixture. Its defect
ledger records every case as `PASS`, `FAIL`,
`BLOCKED`, or `INDETERMINATE`, including the failing layer, side-effect state,
reconciliation, dependency impact, and evidence IDs.

This command is development-only. Every event and summary permanently records
`validationProfile=development`, `candidateRun=false`, and
`candidateEvidence=false`. Its output is not candidate, packaged-release, or
release-acceptance evidence and must never be promoted or relabeled as such.

## Native editing milestone #167

`issue167_native_media_acceptance.py` drives the frozen 22-tool Effect Stack,
Mask/Path, and Footage/Source milestone. Its package-specific file owns one
deterministic solid-layer fixture plus three generated 2x2 RGBA footage assets;
the shared runtime still owns component-set identity, public-MCP evidence, call
accounting, and recoverable `.aep` lifecycle.

Run the zero-evidence `preflight` before candidate freeze. It uses four public
calls to save, restart, reopen inside formal AE, reacquire, and archive one
fixture. The justified native-novelty T4 uses exactly six calls for the
previously reproduced mask-properties path. T5/T6 use exactly 60 calls each,
touch all 22 public tools, verify 13 writes with real Undo, and verify
`ae_setLayerMaskProperties` through before/after readback while explicitly
reporting that one-step Undo is not guaranteed. They restart formal AE, compare
effect/mask/footage state hashes, and archive the single `.aep` plus generated
assets. The runner never uses Finder, LaunchServices, or Save As.

## Capability package #162

`issue162_layer_compositing_acceptance.py` is a thin wrapper around the shared
CLI/runtime; `issue162_layer_compositing_spec.py` contains only the ten-tool
matrix, one solid-layer recipe, semantic assertions, Undo steps, and restart
reacquisition. Seven fixed public switch tools intentionally share one closed
native capability, while the model never receives a generic SDK flag.

Run `preflight` before candidate freeze. It uses three public calls to prove
the deployed component-set identity, create one disposable composition/solid fixture,
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
order. Stable component-set identity, public-MCP, evidence, call-budget, checkpoint,
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
proves readiness. Only after that read succeeds does the
runner save the still-empty project, before composition creation or any locator
acquisition. Later archival saves the populated project in place. This avoids
both an abandoned AEP after admission failure and locators invalidated by AE's
first-save project-generation advance while keeping `saveAsCopies=0`.

Local transport admission is automatic only for the same user and a client
process whose ancestry reaches the current formal AE host. The native challenge
still binds the endpoint and peer identity. Admission failure is
`sideEffect=not-started` and fails closed without a connection-code checkpoint
or a retry ceremony.

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
  --requested-source-revision 0123456789abcdef0123456789abcdef01234567 \
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
- `t5`: one candidate component-set run covering all eight package tools, all five
  writes and their real Undo/readback checkpoints, then AE restart/reconnect
  and stale-locator rejection.
- `t6`: the same package matrix rebuilt and reinstalled from the clean merge
  commit.

Example (use only a disposable fixture project):

```sh
PYTHONDONTWRITEBYTECODE=1 uv run --frozen python \
  scripts/hardware/issue150_project_composition_acceptance.py \
  --mode t5 \
  --requested-source-revision 0123456789abcdef0123456789abcdef01234567 \
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

T4, T5 and T6 fail closed unless the canonical CEP manifest, RuntimeManager
schema-v2 `current` generation, referenced shared layer, stable launcher
receipt, supplied native receipt/manifest, and public native provenance form a
compatible component set. Each component retains its own source revision.
Routine starts verify canonical paths, component/protocol versions, sizes,
modes, and modification times; content hashing is reserved for a contradictory
signal or an explicitly requested release/security audit.

The package staging/verifier and native development installer use the
`development` identity profile by default. It keeps protocol, product-version,
platform, architecture, entrypoint, load, and Adobe scan-root protections, but
records source-revision drift and does not gate on full payload hashes or deep
receipt identity. Release and security-audit entry points must select
`--profile release-audit`; the release workflows and signing freeze do so
explicitly. Product-version equality remains strict in both profiles because
the current product contract has no version compatibility range.

The frozen package matrix has eight public acceptance rows: three reads and
five writes. `ae_listProjectItems` is an existing support read used only for
independent project-count and duplicate readback; its descriptor is pinned by
the driver, but it is not a ninth package acceptance row.

The orchestrator reads each `CHECKPOINT_REQUIRED` line, performs the authorized
GUI action, and writes exactly one acknowledgement line:

```json
{"checkpointId":"the-emitted-id","status":"completed"}
```

Undo and restart are deliberately explicit checkpoints. Local admission has no
connection code or fingerprint checkpoint. Private paths are redacted before
evidence is persisted. Evidence files use mode `0600` in a `0700` directory.

The shared #157/#162 CLI retains the legacy option spelling `--expected-sha`;
it records the requested package source revision and is not an equality
requirement across installed components. The #150/#155 standalone drivers use
`--requested-source-revision` and retain `--expected-sha` only as a deprecated
one-release alias.

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
