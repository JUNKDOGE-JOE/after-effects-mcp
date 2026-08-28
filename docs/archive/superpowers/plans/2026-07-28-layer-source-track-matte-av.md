# Layer Source, Track Matte, and AV State Implementation Plan

> Archived 2026-08-28: this proposed native capability package is not part of the frozen native plane.

> **Required execution skill:** Use `superpowers:subagent-driven-development` for
> task-by-task execution with review checkpoints, or
> `superpowers:executing-plans` for inline execution.

**Goal:** Add eight explicit public MCP tools for layer source inspection and
replacement, modern arbitrary-layer Track Matte relationships, and audio/video
state, with typed evidence, bounded recovery, and one non-candidate real-AE
development smoke.

**Architecture:** Seven operations use the existing Core → native RPC → AEGP
main-thread path. `ae_setLayerSource` uses a fixed maintained-JSX template
behind a strict Core contract because the fixed SDK has no layer-source setter.
All writes perform before/after verification, stable idempotency handling,
audit recording, and expose Undo availability without claiming Undo was
executed. The HDEV runner performs and verifies the five real Undo operations.

**Tech Stack:** Python 3.13, Pydantic v2, pytest, C++20, Node.js protocol
conformance tests, Adobe After Effects 2026 AEGP SDK 25.6.61, ExtendScript
ECMAScript 3, MCP stdio client, existing macOS development sync/install flow.

**Approved design:**
`docs/superpowers/specs/2026-07-28-layer-source-track-matte-av-design.md`

## Global constraints

- Work only in
  `/Users/junk_doge/Documents/ae-mcp/.worktrees/issue-190-layer-source-track-matte-av`
  on `codex/issue-190-layer-source-track-matte-av`.
- Keep the package at exactly eight public tools:
  `ae_getLayerSource`, `ae_setLayerSource`, `ae_getLayerTrackMatte`,
  `ae_setLayerTrackMatte`, `ae_clearLayerTrackMatte`,
  `ae_getLayerAVState`, `ae_setLayerAudioEnabled`, and
  `ae_setLayerVideoEnabled`.
- Do not add a generic flag setter, generic JSX resolver, file import,
  expression repair, layer recreation, Windows validation, signing, packaging,
  or release workflow.
- Do not run or label candidate, release, or clean-main acceptance. The only
  real-host run is HDEV with `validationProfile=development`,
  `candidateRun=false`, and `candidateEvidence=false`.
- Do not use the adjacent-layer Track Matte model. The Matte locator may name
  any different AV-capable layer in the same composition.
- Treat a post-dispatch timeout, disconnect, malformed result, or failed
  readback as `POSSIBLY_SIDE_EFFECTING_FAILURE`. Reconcile state and audit
  before any retry.
- Use one `ephemeral-validation` fixture. Do not touch a production project.
- Before each implementation commit, run the focused tests named in that task
  and `git diff --check`.

## Contract map

| Public tool | Internal capability/contract | Engine | Mutation |
|---|---|---|---|
| `ae_getLayerSource` | `ae.layer.source.read` | native AEGP | no |
| `ae_setLayerSource` | `ae.layer.source.set` | maintained JSX | yes |
| `ae_getLayerTrackMatte` | `ae.layer.track-matte.read` | native AEGP | no |
| `ae_setLayerTrackMatte` | `ae.layer.track-matte.set` | native AEGP | yes |
| `ae_clearLayerTrackMatte` | `ae.layer.track-matte.clear` | native AEGP preferred | yes |
| `ae_getLayerAVState` | `ae.layer.av-state.read` | native AEGP | no |
| `ae_setLayerAudioEnabled` | `ae.layer.audio-enabled.set` | native AEGP | yes |
| `ae_setLayerVideoEnabled` | `ae.layer.video-enabled.set` | native AEGP | yes |

## Task 1: Freeze the public argument models and tool metadata

**Files:**

- Modify: `packages/core/ae_mcp/schemas.py`
- Modify: `packages/core/ae_mcp/annotations.py`
- Create: `packages/core/tests/test_layer_source_matte_av_package.py`

**Step 1: Write the failing schema tests**

In `test_layer_source_matte_av_package.py`, assert:

- all eight internal handler names exist in `schemas.HANDLER_SCHEMAS`;
- every locator field rejects a non-layer or wrong-context locator;
- `source_item_locator` accepts only item/composition locators;
- Track Matte set requires different same-composition layer locators and one of
  `alpha`, `inverted-alpha`, `luma`, `inverted-luma`;
- audio/video setters require a strict boolean and stable idempotency key;
- every model rejects unknown fields;
- read annotations are read-only and writes are destructive/idempotent in the
  same form as existing native layer tools.

Run:

```bash
uv run pytest packages/core/tests/test_layer_source_matte_av_package.py -q
```

Expected: FAIL because the eight schemas and annotation entries do not exist.

**Step 2: Add the smallest strict argument models**

Add `AeGetLayerSourceArgs`, `AeSetLayerSourceArgs`,
`AeGetLayerTrackMatteArgs`, `AeSetLayerTrackMatteArgs`,
`AeClearLayerTrackMatteArgs`, `AeGetLayerAVStateArgs`,
`AeSetLayerAudioEnabledArgs`, and `AeSetLayerVideoEnabledArgs`.

Reuse the existing `NativeLocator`, `_AeLayerWriteArgs`, and
`IdempotencyKey` conventions. Add only cross-field validation needed to reject
self-Matte and obvious locator-context mismatches before dispatch.

Register the dotted handler keys in `HANDLER_SCHEMAS` and add the eight
`VERB_ANNOTATIONS` entries.

**Step 3: Run the focused test**

```bash
uv run pytest packages/core/tests/test_layer_source_matte_av_package.py -q
git diff --check
```

Expected: PASS.

**Step 4: Commit**

```bash
git add packages/core/ae_mcp/schemas.py \
  packages/core/ae_mcp/annotations.py \
  packages/core/tests/test_layer_source_matte_av_package.py
git commit -m "feat(core): define layer source matte and AV schemas"
```

## Task 2: Add the seven closed native Core capability contracts

**Files:**

- Create: `packages/core/ae_mcp/backends/native_layer_source_matte_av.py`
- Modify: `packages/core/tests/test_layer_source_matte_av_package.py`

**Step 1: Add failing model and descriptor tests**

Cover the seven native capability IDs and exact value shapes:

- source read: layer locator, nullable item/composition locator,
  `none|footage|composition`, nullable source name;
- Track Matte read: `active`, nullable Matte locator, and stored mode as
  separate facts;
- Track Matte set/clear: exact before/after relationship and mode;
- AV read: source capabilities and layer switches;
- audio/video writes: exact before/after switch with the complete AV state
  available for preservation checks.

Assert closed input/result JSON Schemas, stable contract digests, read/write
risk, idempotency, Undo metadata, and descriptor compatibility with the
repository's existing native contract validators.

Run:

```bash
uv run pytest packages/core/tests/test_layer_source_matte_av_package.py -q
```

Expected: FAIL because the backend module does not exist.

**Step 2: Implement the strict contract module**

Follow `native_layer_compositing.py` and
`native_layer_project_composition.py`:

- define Pydantic input, value, and execution models;
- define seven `CapabilityContract` instances with closed schemas;
- add per-capability invoke functions;
- route all three native writes through the existing `_invoke_layer_write`
  machinery;
- validate returned projection and preserved fields;
- map indeterminate post-dispatch outcomes through the existing
  `_possibly_side_effecting` contract.

Do not include the maintained-JSX source setter in native capability
negotiation.

**Step 3: Run the focused contract tests**

```bash
uv run pytest packages/core/tests/test_layer_source_matte_av_package.py -q
git diff --check
```

Expected: PASS.

**Step 4: Commit**

```bash
git add packages/core/ae_mcp/backends/native_layer_source_matte_av.py \
  packages/core/tests/test_layer_source_matte_av_package.py
git commit -m "feat(core): add native layer source matte and AV contracts"
```

## Task 3: Extend the native protocol schema, fixtures, and codec

**Files:**

- Modify: `native/ae-plugin/protocol/aegp-rpc.schema.json`
- Modify: `native/ae-plugin/protocol/conformance.mjs`
- Modify: `native/ae-plugin/protocol/protocol.test.mjs`
- Modify: `native/ae-plugin/protocol/README.md`
- Modify: `native/ae-plugin/protocol/fixtures/capabilities.json`
- Create:
  `native/ae-plugin/protocol/fixtures/invoke-layer-source-read.json`
- Create:
  `native/ae-plugin/protocol/fixtures/invoke-layer-track-matte-read.json`
- Create:
  `native/ae-plugin/protocol/fixtures/invoke-layer-track-matte-set.json`
- Create:
  `native/ae-plugin/protocol/fixtures/invoke-layer-track-matte-clear.json`
- Create:
  `native/ae-plugin/protocol/fixtures/invoke-layer-av-state-read.json`
- Create:
  `native/ae-plugin/protocol/fixtures/invoke-layer-audio-enabled-set.json`
- Create:
  `native/ae-plugin/protocol/fixtures/invoke-layer-video-enabled-set.json`
- Modify: `native/ae-plugin/include/aemcp_native/rpc_codec.hpp`
- Modify: `native/ae-plugin/src/core/rpc_codec.cpp`
- Modify: `native/ae-plugin/tests/rpc_codec_test.cpp`

**Step 1: Add failing protocol and codec vectors**

Add positive vectors for all seven capabilities and negative vectors for:

- extra arguments;
- wrong locator kinds;
- self-Matte and cross-composition Matte;
- `none` passed to Track Matte set;
- missing idempotency keys;
- inconsistent `active`/nullable Matte state;
- unchanged write results;
- invalid source-type/capability/switch combinations.

Update protocol tests to require all seven descriptors in the capability
registry and to decode/encode their dynamic success results.

Add C++ codec tests for exact request variants, result variants, canonical
postcondition digests, and descriptor contract digests.

Run:

```bash
node --test native/ae-plugin/protocol/protocol.test.mjs
c++ -std=c++20 -Wall -Wextra -Wpedantic -Werror -pthread \
  -I native/ae-plugin/include \
  native/ae-plugin/src/core/rpc_codec.cpp \
  native/ae-plugin/tests/rpc_codec_test.cpp \
  -o /tmp/ae-mcp-rpc-codec-test
```

Expected: protocol assertions fail and the codec test does not compile until
the new variants exist.

**Step 2: Implement schema and codec branches**

Add closed invoke schemas, typed C++ request/result structures, constants,
decode branches, encode branches, canonical value encoders, postcondition
digest functions, and full descriptor generation.

Keep project item names as bounded display metadata. Locators remain the only
identity. Update the protocol README's compile-time capability count and
allowlist description.

**Step 3: Run the protocol and codec tests**

```bash
node --test native/ae-plugin/protocol/protocol.test.mjs
c++ -std=c++20 -Wall -Wextra -Wpedantic -Werror -pthread \
  -I native/ae-plugin/include \
  native/ae-plugin/src/core/rpc_codec.cpp \
  native/ae-plugin/tests/rpc_codec_test.cpp \
  -o /tmp/ae-mcp-rpc-codec-test
/tmp/ae-mcp-rpc-codec-test
git diff --check
```

Expected: PASS.

**Step 4: Commit**

```bash
git add native/ae-plugin/protocol \
  native/ae-plugin/include/aemcp_native/rpc_codec.hpp \
  native/ae-plugin/src/core/rpc_codec.cpp \
  native/ae-plugin/tests/rpc_codec_test.cpp
git commit -m "feat(native): define layer source matte and AV protocol"
```

## Task 4: Add dispatcher requests, host interfaces, and portable behavior

**Files:**

- Modify: `native/ae-plugin/include/aemcp_native/host_dispatcher.hpp`
- Modify: `native/ae-plugin/src/core/host_dispatcher.cpp`
- Modify: `native/ae-plugin/tests/host_dispatcher_test.cpp`

**Step 1: Write failing dispatcher tests**

Add one read test for each native read, one successful transition for each
write, and explicit failure tests for:

- stale or wrong-kind locators;
- cross-composition and self-Matte requests;
- no active Matte on clear;
- missing audio/video capability on enable;
- unchanged requested values;
- a post-dispatch failure classified as possibly side-effecting;
- balanced Undo start/end and no Undo on rejected requests.

Use a fake host implementation whose counters prove each accepted request
performs one mutation and one independent after-read.

Run:

```bash
c++ -std=c++20 -Wall -Wextra -Wpedantic -Werror -pthread \
  -I native/ae-plugin/include \
  native/ae-plugin/src/core/host_dispatcher.cpp \
  native/ae-plugin/tests/host_dispatcher_test.cpp \
  -o /tmp/ae-mcp-host-dispatcher-test
```

Expected: compile failure until the request kinds and host methods exist.

**Step 2: Implement the dispatcher**

Add closed request payloads and completion variants. Reuse the current
main-thread queue, cancellation-before-dispatch rule, locator validation,
idempotency ledger boundary, and Undo-group helpers.

For Track Matte set, validate both locators in the same composition before
opening Undo. For audio/video writes, read capability and current flag before
opening Undo. Every accepted write reads the complete owned state after the
mutation and rejects a mismatched postcondition.

**Step 3: Run the portable dispatcher test**

```bash
c++ -std=c++20 -Wall -Wextra -Wpedantic -Werror -pthread \
  -I native/ae-plugin/include \
  native/ae-plugin/src/core/host_dispatcher.cpp \
  native/ae-plugin/tests/host_dispatcher_test.cpp \
  -o /tmp/ae-mcp-host-dispatcher-test
/tmp/ae-mcp-host-dispatcher-test
git diff --check
```

Expected: PASS.

**Step 4: Commit**

```bash
git add native/ae-plugin/include/aemcp_native/host_dispatcher.hpp \
  native/ae-plugin/src/core/host_dispatcher.cpp \
  native/ae-plugin/tests/host_dispatcher_test.cpp
git commit -m "feat(native): dispatch layer source matte and AV operations"
```

## Task 5: Wire native capability negotiation and RPC completion

**Files:**

- Modify:
  `native/ae-plugin/include/aemcp_native/native_rpc_connection.hpp`
- Modify: `native/ae-plugin/src/core/native_rpc_connection.cpp`
- Modify: `native/ae-plugin/tests/native_rpc_connection_test.cpp`

**Step 1: Add failing connection tests**

Assert:

- filtered and full capability queries include the seven new descriptors;
- runtime contract digests are required and bound to the correct descriptors;
- each invoke decodes to the correct dispatcher request;
- successful completions encode the exact result and postcondition digest;
- idempotent replays do not redispatch;
- failures after dispatch keep the stable request/operation identity and return
  the possibly-side-effecting contract.

Run:

```bash
c++ -std=c++20 -Wall -Wextra -Wpedantic -Werror -pthread \
  -I native/ae-plugin/include \
  native/ae-plugin/src/core/host_dispatcher.cpp \
  native/ae-plugin/src/core/rpc_codec.cpp \
  native/ae-plugin/src/core/native_rpc_connection.cpp \
  native/ae-plugin/tests/native_rpc_connection_test.cpp \
  -o /tmp/ae-mcp-native-rpc-connection-test
```

Expected: compile/test failure because runtime digests and completion routing
are absent.

**Step 2: Implement negotiation and completion routing**

Add seven runtime digest fields, capability include predicates, exact descriptor
counting, invoke-to-dispatch mapping, result validation, success encoding, and
postcondition digest selection.

Do not add source replacement to the native registry.

**Step 3: Run the connection test**

```bash
c++ -std=c++20 -Wall -Wextra -Wpedantic -Werror -pthread \
  -I native/ae-plugin/include \
  native/ae-plugin/src/core/host_dispatcher.cpp \
  native/ae-plugin/src/core/rpc_codec.cpp \
  native/ae-plugin/src/core/native_rpc_connection.cpp \
  native/ae-plugin/tests/native_rpc_connection_test.cpp \
  -o /tmp/ae-mcp-native-rpc-connection-test
/tmp/ae-mcp-native-rpc-connection-test
git diff --check
```

Expected: PASS.

**Step 4: Commit**

```bash
git add native/ae-plugin/include/aemcp_native/native_rpc_connection.hpp \
  native/ae-plugin/src/core/native_rpc_connection.cpp \
  native/ae-plugin/tests/native_rpc_connection_test.cpp
git commit -m "feat(native): expose layer source matte and AV capabilities"
```

## Task 6: Implement the AEGP host adapter with the fixed SDK

**Files:**

- Modify: `native/ae-plugin/src/aegp/plugin_entry.cpp`

**Step 1: Record the exact fixed-SDK operations in code-level tests**

Extend the existing host-adapter seams used by portable dispatcher tests so
the expected operations are explicit:

- source read: `AEGP_GetLayerSourceItem`, item type, item name, fresh item
  locator registration;
- Track Matte read/set/clear:
  `AEGP_GetTrackMatteLayer`, `AEGP_SetTrackMatte`,
  `AEGP_RemoveTrackMatte`;
- AV capability read: `AEGP_GetItemFlags` with `HAS_AUDIO`/`HAS_VIDEO`;
- AV switch read/write: `AEGP_GetLayerFlags` and `AEGP_SetLayerFlag` with
  `AUDIO_ACTIVE`/`VIDEO_ACTIVE`.

Keep the SDK header names private to the adapter; public descriptors continue
to use product-owned requirement IDs.

**Step 2: Implement the host adapter**

Map the five public Matte modes to the SDK enum without using stack adjacency.
Resolve both Matte layers through the current locator registry and reject
composition mismatch before calling the SDK. Register returned source/Matte
handles as fresh opaque locators; never serialize a handle.

Track Matte clear must use `AEGP_RemoveTrackMatte` in this implementation. Do
not switch it to JSX unless Task 12's bounded real-host semantic check proves
that the stored mode is not preserved.

**Step 3: Run portable regressions**

```bash
/tmp/ae-mcp-host-dispatcher-test
/tmp/ae-mcp-rpc-codec-test
/tmp/ae-mcp-native-rpc-connection-test
git diff --check
```

Expected: PASS.

**Step 4: Commit the source used by the native builder**

```bash
git add native/ae-plugin/src/aegp/plugin_entry.cpp
git commit -m "feat(native): implement layer source matte and AV AEGP adapter"
```

The native builder snapshots committed `HEAD`, so do not build from an
uncommitted adapter change.

**Step 5: Build the real plug-in with the authorized local SDK input**

Use a new private output directory outside the repository:

```bash
ISSUE190_BUILD_ROOT="$(mktemp -d /private/tmp/ae-mcp-issue190-build.XXXXXX)"
node native/ae-plugin/build-macos.mjs \
  --sdk-archive "$AE_MCP_SDK_ARCHIVE" \
  --sdk-root "$AE_MCP_SDK_ROOT" \
  --output "$ISSUE190_BUILD_ROOT/native"
```

Expected: the SDK compile, bundle verification, and ad-hoc signing all pass.
If either environment variable is unset, use the already recorded authorized
absolute SDK archive/root from the development environment; do not download a
different SDK.

If the SDK compile fails on adapter code, first add the smallest portable
regression to `native/ae-plugin/tests/host_dispatcher_test.cpp`, make it fail,
repair `plugin_entry.cpp`, rerun the portable tests, commit those exact two
files with `fix(native): repair issue 190 SDK adapter`, and rebuild into a new
private output root.

## Task 7: Connect the seven native public tools through Core

**Files:**

- Modify: `packages/core/ae_mcp/handlers/native.py`
- Modify: `packages/core/ae_mcp/server.py`
- Modify: `packages/core/tests/test_layer_source_matte_av_package.py`

**Step 1: Add failing handler and public-call tests**

For each native tool, assert:

- public underscore name maps to the expected dotted handler and capability;
- the handler passes exact native arguments and deadline/cancellation values;
- typed success rejects a wrong capability, stale session, wrong result shape,
  altered postcondition digest, or mismatched write projection;
- pre-dispatch failures remain `sideEffect: not-started`;
- possibly-side-effecting failures are never retried;
- every successful write exposes `undo.available=true` and
  `undo.verified=false`.

Run:

```bash
uv run pytest packages/core/tests/test_layer_source_matte_av_package.py -q
```

Expected: FAIL because handlers and server validation mappings are missing.

**Step 2: Implement the handlers and mappings**

Import the new backend module, add seven `_run_*` functions, register the
dotted handlers, and extend `_PROJECT_COMPOSITION_VALIDATION` with exact
capability IDs and recovery hints.

Use fresh locator language in write error hints. Do not add implicit engine
fallback.

**Step 3: Run focused Core tests**

```bash
uv run pytest \
  packages/core/tests/test_layer_source_matte_av_package.py \
  packages/core/tests/test_layer_compositing_package_native.py -q
git diff --check
```

Expected: PASS.

**Step 4: Commit**

```bash
git add packages/core/ae_mcp/handlers/native.py \
  packages/core/ae_mcp/server.py \
  packages/core/tests/test_layer_source_matte_av_package.py
git commit -m "feat(core): expose native layer source matte and AV tools"
```

## Task 8: Implement bounded maintained-JSX source replacement

**Files:**

- Create: `packages/core/ae_mcp/backends/maintained_layer_source.py`
- Create: `packages/core/ae_mcp/jsx_templates/layer_source_replace.jsx`
- Modify: `packages/core/ae_mcp/handlers/native.py`
- Modify: `packages/core/ae_mcp/server.py`
- Create: `packages/core/tests/test_maintained_layer_source.py`
- Modify: `packages/core/tests/test_layer_source_matte_av_package.py`

**Step 1: Add failing renderer and execution tests**

Cover:

- exact fixed template ID and digest;
- JSON escaping of names and no unresolved template placeholder;
- no caller-provided JSX;
- native locator-to-address resolution by exact locator equality;
- bounded guards for project item position/name/type, composition
  position/name, layer position/name/type, and current source;
- rejection of text, shape, null, camera, light, adjustment, source-less,
  already-active, folder, and non-AV targets before `replaceSource`;
- `replaceSource(newSource, false)` exactly once and inside one Undo group;
- graph invalidation on `/exec`;
- fresh project/composition/layer/source locator reacquisition after `/exec`;
- independent native source readback;
- before/after invariant projection;
- idempotency replay and key conflict;
- append-only redacted audit;
- malformed/timeout/disconnect/postcondition failures becoming
  `POSSIBLY_SIDE_EFFECTING_FAILURE` without redispatch.

Run:

```bash
uv run pytest packages/core/tests/test_maintained_layer_source.py -q
```

Expected: FAIL because the backend and template do not exist.

**Step 2: Implement the fixed ES3 template**

The template must:

- use `var`, ordinary functions, and traditional loops only;
- guard every lookup and return structured `{ok:false,error:...}` instead of
  throwing;
- recheck the resolved bounded address immediately before mutation;
- capture the agreed invariant snapshot before and after;
- call `replaceSource(newSource, false)` only after all guards pass;
- return no private path or media bytes.

**Step 3: Implement the maintained backend**

Use the established maintained-text execution shape without introducing a
generic resolver:

- resolve only the two project items, one composition, and one target layer;
- produce a fixed request JSON literal and template digest;
- call CEP `/exec` with `native_project_graph_effect="invalidate"`;
- reacquire locators through native project/layer lists and the new source read;
- validate the exact source transition and invariants;
- return maintained-JSX implementation/provenance/audit/postcondition evidence;
- store bounded completed/indeterminate idempotency outcomes;
- use a package-specific private audit path with an environment override for
  tests.

Add `_run_set_layer_source`, handler registration, and public validation
mapping.

**Step 4: Run maintained and package tests**

```bash
uv run pytest \
  packages/core/tests/test_maintained_layer_source.py \
  packages/core/tests/test_maintained_text.py \
  packages/core/tests/test_layer_source_matte_av_package.py -q
git diff --check
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/core/ae_mcp/backends/maintained_layer_source.py \
  packages/core/ae_mcp/jsx_templates/layer_source_replace.jsx \
  packages/core/ae_mcp/handlers/native.py \
  packages/core/ae_mcp/server.py \
  packages/core/tests/test_maintained_layer_source.py \
  packages/core/tests/test_layer_source_matte_av_package.py
git commit -m "feat(core): add maintained layer source replacement"
```

## Task 9: Finish public discovery and caller guidance

**Files:**

- Modify: `packages/core/ae_mcp/instructions.py`
- Modify: `packages/core/tests/test_instructions.py`
- Modify: `packages/core/tests/test_layer_source_matte_av_package.py`

**Step 1: Add failing discovery and instruction assertions**

Assert that `tools/list` exposes exactly the eight underscore names with their
strict schemas and that model instructions state:

- use fresh locators for every call;
- source replacement invalidates the whole native graph, so rediscover all
  locators after it;
- arbitrary same-composition Matte does not depend on layer adjacency;
- an uncertain write requires state/audit reconciliation before retry;
- Undo availability is not Undo verification.

Run:

```bash
uv run pytest \
  packages/core/tests/test_layer_source_matte_av_package.py \
  packages/core/tests/test_instructions.py -q
```

Expected: FAIL until discovery expectations and instructions are complete.

**Step 2: Update instructions and finish registrations**

Add concise guidance beside the existing native locator and post-`/exec`
sections. Confirm the public schemas, handler registry, annotations, validation
map, and tool discovery all agree on the same eight names.

**Step 3: Run the focused tests**

```bash
uv run pytest \
  packages/core/tests/test_layer_source_matte_av_package.py \
  packages/core/tests/test_instructions.py \
  packages/core/tests/test_schemas.py -q
git diff --check
```

Expected: PASS.

**Step 4: Commit**

```bash
git add packages/core/ae_mcp/instructions.py \
  packages/core/tests/test_instructions.py \
  packages/core/tests/test_layer_source_matte_av_package.py
git commit -m "docs(core): guide layer source matte and AV calls"
```

## Task 10: Build the non-candidate HDEV runner and defect ledger

**Files:**

- Create: `scripts/hardware/issue190_layer_source_matte_av_spec.py`
- Create: `scripts/hardware/issue190_layer_source_matte_av_acceptance.py`
- Create:
  `packages/bridge/tests/test_issue190_layer_source_matte_av_driver.py`
- Modify: `scripts/hardware/README.md`

**Step 1: Write failing pure-driver tests**

Freeze a call ledger with a hard maximum of 40 public MCP calls and cover the
approved interaction matrix:

- source read, replacement, preservation, and Undo;
- non-adjacent Matte set, reorder stability, set Undo;
- Luma Matte clear with stored-mode preservation and clear Undo;
- audio disable and Undo;
- video disable and Undo;
- cross-composition Matte, self-Matte, invalid source, no-audio/no-video
  negatives;
- completed-key replay;
- uncertain-write stop without retry.

Assert every case records `PASS`, `FAIL`, `BLOCKED`, or `INDETERMINATE` with
failing layer, side-effect state, reconciliation, dependency impact, and
evidence IDs. Assert fixture counts finish with zero active and zero
unclassified projects.

Run:

```bash
uv run pytest \
  packages/bridge/tests/test_issue190_layer_source_matte_av_driver.py -q
```

Expected: FAIL because the spec and driver do not exist.

**Step 2: Implement the frozen spec**

Define:

- one `ephemeral-validation` fixture;
- `SOURCE_COMP_A`, `SOURCE_COMP_B`, `RELINK_TARGET`, `MATTE_FILL`,
  `MATTE_SOURCE`, `MATTE_SPACER`, `VIDEO_SWITCH`, and `AUDIO_SWITCH`;
- deterministic harness-only creation/reset choreography;
- a generated short PCM WAV with no personal data;
- five write/Undo checkpoints;
- exact public readback predicates;
- bounded defect collection and immediate stop rules for unreconciled writes,
  baseline loss, incompatible components, crash, or corruption.

**Step 3: Implement the driver**

Reuse the existing HDEV runtime and evidence conventions, but keep this package
spec separate. Every event and summary must permanently contain:

```json
{
  "validationProfile": "development",
  "candidateRun": false,
  "candidateEvidence": false
}
```

Use public MCP only for product operations. Harness-only ExtendScript may
create/reset the disposable fixture and invoke real AE Undo. Reacquire all
locators after source replacement and after each Undo.

**Step 4: Run driver tests**

```bash
uv run pytest \
  packages/bridge/tests/test_issue190_layer_source_matte_av_driver.py \
  packages/bridge/tests/test_development_smoke_driver.py -q
git diff --check
```

Expected: PASS.

**Step 5: Document the development command**

In `scripts/hardware/README.md`, document the exact current-checkout HDEV
command, fixture lifecycle, call bound, component reuse, and the fact that its
output is not candidate or release evidence.

**Step 6: Commit**

```bash
git add scripts/hardware/issue190_layer_source_matte_av_spec.py \
  scripts/hardware/issue190_layer_source_matte_av_acceptance.py \
  packages/bridge/tests/test_issue190_layer_source_matte_av_driver.py \
  scripts/hardware/README.md
git commit -m "test(hardware): add issue 190 development smoke"
```

## Task 11: Run the focused integration gate and review the diff

**Files:**

- Modify only files required by reproduced failures in this package.

**Step 1: Run all affected Python tests**

```bash
uv run pytest \
  packages/core/tests/test_layer_source_matte_av_package.py \
  packages/core/tests/test_maintained_layer_source.py \
  packages/core/tests/test_maintained_text.py \
  packages/core/tests/test_layer_compositing_package_native.py \
  packages/core/tests/test_instructions.py \
  packages/core/tests/test_schemas.py \
  packages/bridge/tests/test_issue190_layer_source_matte_av_driver.py \
  packages/bridge/tests/test_development_smoke_driver.py -q
```

Expected: PASS.

**Step 2: Run all affected protocol and portable native tests**

```bash
node --test native/ae-plugin/protocol/protocol.test.mjs
/tmp/ae-mcp-host-dispatcher-test
/tmp/ae-mcp-rpc-codec-test
/tmp/ae-mcp-native-rpc-connection-test
```

Expected: PASS.

**Step 3: Run repository policy checks**

```bash
node scripts/check-repository-governance.mjs
node --test scripts/package/test/capability-package-index.test.mjs
git diff --check
```

Expected: PASS.

**Step 4: Perform one concentrated independent diff review**

Review the full branch diff against the approved design and classify every
finding as:

1. reproduced current blocker;
2. follow-up;
3. out of scope.

Repair only reproduced current blockers. If a repair changes a public contract
or write boundary, rerun the affected focused tests and repeat one focused
review. Do not expand the package into release, Windows, import, expression
repair, or generalized resolver work.

**Step 5: Commit any review fixes**

For each reproduced blocker, return to the owning task above, add the smallest
failing regression in that task's named test file, repair only that task's
named implementation files, rerun its exact focused command, then stage those
named files and commit `fix: address issue 190 review blockers`. Skip this
step when the review finds no blocker.

## Task 12: Run one real-AE HDEV and make the Track Matte clear decision

**Files:**

- HDEV evidence only outside the repository, unless a reproduced blocker
  requires a source fix.

**Step 1: Preflight current development components**

Record source revision, dirty state, canonical component paths, install
receipts, versions, sizes, modification times, formal AE path, fixture roots,
and log roots. Reuse unchanged dependencies and CEP. Sync only changed Core and
native components.

Do not perform a runtime tree hash walk, pairing ceremony, portable-runtime
build, release installation, or candidate freeze.

**Step 2: Build/install the current native and Core development components**

Use the repository's existing daily development sync/install commands from
`docs/INSTALL.md` and the build receipt from Task 6. Keep the installed
component versions/protocol compatible and record the exact receipt.

**Step 3: Run the bounded HDEV command**

Run `scripts/hardware/issue190_layer_source_matte_av_acceptance.py` with:

- this checkout;
- the formal After Effects application;
- the single active fixture path;
- private recovery/evidence roots;
- changed components selected and unchanged components listed as reused.

Complete the five real Undo checkpoints. The run must stay at or below 40
public calls and exercise every public tool.

**Step 4: Decide Track Matte clear from observed host state**

After native `AEGP_RemoveTrackMatte`, require a fresh
`ae_getLayerTrackMatte` read to report:

- `active=false`;
- `matteLayerLocator=null`;
- stored `mode=luma`.

If that passes, retain the native implementation.

If it fails while the fixture and evidence remain trustworthy, stop the run,
record the exact observed mode, and implement only
`ae_clearLayerTrackMatte` through a fixed maintained-JSX
`removeTrackMatte()` template. Reuse the Task 8 safety, audit, invalidation,
reacquisition, and uncertain-failure pattern. Remove the unused native clear
descriptor, invoke branch, runtime digest, and fixture so capability discovery
continues to describe the actual execution plane; the native count becomes six
and the maintained-JSX count becomes two. Rerun the affected lower tests and
this one HDEV once.

If neither route preserves the stored mode, stop and ask the user rather than
changing the public semantic.

**Step 5: Verify the evidence ledger**

Require:

- all eight tools called publicly;
- five writes, five executed Undo operations, five fresh public readbacks;
- native AEGP provenance for seven tools when native clear preserves the mode,
  otherwise six;
- maintained-JSX provenance and graph invalidation for source replacement and,
  only if required by the observed clear semantic, Track Matte clear;
- non-adjacent Matte stability after reorder;
- every negative case `sideEffect=not-started`;
- no unreconciled indeterminate result;
- fixture counts: created 1, active 0, unclassified 0, archived 1, retained 0;
- `validationProfile=development`;
- `candidateRun=false`;
- `candidateEvidence=false`.

Do not describe this as candidate, release, or clean-main acceptance.

**Step 6: Commit only a reproduced HDEV blocker fix**

If HDEV exposed a current blocker, first reproduce it in the smallest lower
tier, return to that task's exact test and implementation file list, fix it,
rerun the affected automated checks, stage those named files, and commit
`fix: repair issue 190 HDEV blocker`.

If the HDEV passes without source changes, make no evidence-only source commit.

## Task 13: Run normal PR CI and prepare the development handoff

**Files:**

- No repository file changes by default. The PR body links the redacted
  external HDEV summary.

**Step 1: Run the repository regression once before push**

```bash
uv run pytest -q
node --test native/ae-plugin/protocol/protocol.test.mjs
node scripts/check-repository-governance.mjs
git diff --check
git status --short
```

Expected: all commands pass and the worktree is clean after the final commit.

**Step 2: Push and open one draft PR**

The PR must link Issue #190 and report:

- the eight public tools and per-tool development disposition;
- source revision and component receipts;
- public request/response, before/after state, provenance, audit, and
  postcondition evidence;
- five real Undo results;
- fixture lifecycle counts;
- review rounds and HDEV public-call count;
- remaining risks classified as follow-up or out of scope;
- an explicit statement that HDEV is non-candidate development evidence.

Do not claim packaged-release or clean-main acceptance.

**Step 3: Wait for normal PR CI**

Use the ordinary PR checks. Diagnose any failure at the smallest reproducing
test, batch related blockers, and push one focused fix set. Do not start a
release candidate workflow.

**Step 4: Stop at review handoff**

When normal PR CI is green and the HDEV evidence is attached, hand the draft PR
to the user/reviewer. Do not merge, start another package, or begin
candidate/release validation without a new explicit instruction.

## Final self-review checklist

Before executing this plan, verify:

- every approved public tool appears in the contract map, Core tasks, tests,
  HDEV matrix, and PR handoff;
- all five writes have idempotency, uncertain-failure, audit, postcondition,
  and real Undo coverage;
- source replacement is the only default maintained-JSX write;
- Track Matte is arbitrary same-composition, never adjacency-based;
- source capability and layer enabled state remain separate;
- every post-`/exec` and post-Undo path reacquires locators;
- no step invokes candidate, release, clean-main, Windows, packaging, imports,
  expression repair, a generic resolver, or signing work beyond the existing
  development builder's automatic ad-hoc signature;
- no unresolved implementation marker, placeholder test, or unspecified
  implementation step remains.
