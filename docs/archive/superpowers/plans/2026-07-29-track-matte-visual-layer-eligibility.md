# Track Matte Visual-Layer Eligibility Implementation Plan

> Archived 2026-08-28: this completed native-fix plan is historical and the native plane now accepts no new capability work.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the erroneous `AEGP_ObjectType_AV`-only Track Matte gate so text, shape, and 3D-model visual layers participate in the existing #190 public Track Matte contract, then prove the fix with the unchanged 40-call non-candidate HDEV.

**Architecture:** Keep the existing pre-dispatch Track Matte safety boundary, but rename its internal carrier from source-oriented `av_capable` to `track_matte_capable`. The AEGP adapter maps `AV`, `TEXT`, `VECTOR`, and `3D_MODEL` to `true` and maps `CAMERA`, `LIGHT`, and `NONE` to `false`; the portable dispatcher continues to reject a known-ineligible target or Matte before Undo. Replace only the existing HDEV `MATTE_SOURCE` solid with a deterministic text layer so the same frozen public-call plan exercises the corrected native path.

**Tech Stack:** C++20, Adobe After Effects AEGP `LayerSuite9`, Node test runner, pytest, maintained HDEV Python/ExtendScript harness.

## Global Constraints

- Keep the public eight-tool schema and the 40-call HDEV plan unchanged.
- Do not add PID, start-token, process census, forced termination, T5, T6, release, pairing, signing, or generalized runner work.
- Preserve same-composition, distinct-layer, idempotency, audit, postcondition, uncertain-write, and genuine Undo contracts.
- Retain the existing structured error code for known non-visual Track Matte participants; change only its user-facing message from AV-source terminology to visual Track Matte terminology.
- Use one `ephemeral-validation` fixture and normal AE exit only.

---

### Task 1: Correct the native Track Matte eligibility predicate

**Files:**
- Modify: `native/ae-plugin/include/aemcp_native/host_dispatcher.hpp`
- Modify: `native/ae-plugin/src/core/host_dispatcher.cpp`
- Modify: `native/ae-plugin/src/aegp/plugin_entry.cpp`
- Test: `native/ae-plugin/tests/host_dispatcher_test.cpp`

**Interfaces:**
- Consumes: `AEGP_ObjectType` returned by `AEGP_GetLayerObjectType`.
- Produces: `HostResolvedLayer::track_matte_capable`, a boolean used only by the Track Matte set pre-dispatch guard.

- [ ] **Step 1: Write the failing native contract test**

Add a source-contract assertion beside the existing `plugin_entry.cpp` contract checks. It must require:

```cpp
bool track_matte_capable(AEGP_ObjectType object_type)
```

and require the helper to accept these exact constants:

```cpp
AEGP_ObjectType_AV
AEGP_ObjectType_TEXT
AEGP_ObjectType_VECTOR
AEGP_ObjectType_3D_MODEL
```

The test must also require `HostResolvedLayer` and the dispatcher to use the name `track_matte_capable`, not `av_capable`.

- [ ] **Step 2: Run the portable dispatcher test and verify RED**

Run:

```bash
c++ -std=c++20 -Wall -Wextra -Wpedantic -Werror -pthread \
  -I native/ae-plugin/include \
  native/ae-plugin/src/core/host_dispatcher.cpp \
  native/ae-plugin/tests/host_dispatcher_test.cpp \
  -o /tmp/ae-mcp-host-dispatcher-test \
  && /tmp/ae-mcp-host-dispatcher-test
```

Expected: FAIL because the helper and renamed carrier do not yet exist.

- [ ] **Step 3: Implement the minimal predicate**

Add this helper in the AEGP adapter:

```cpp
[[nodiscard]] bool track_matte_capable(AEGP_ObjectType object_type) {
  switch (object_type) {
    case AEGP_ObjectType_AV:
    case AEGP_ObjectType_TEXT:
    case AEGP_ObjectType_VECTOR:
    case AEGP_ObjectType_3D_MODEL:
      return true;
    case AEGP_ObjectType_NONE:
    case AEGP_ObjectType_LIGHT:
    case AEGP_ObjectType_CAMERA:
      return false;
  }
  return false;
}
```

Rename `HostResolvedLayer::av_capable` and the fake-host fields to
`track_matte_capable`. Use the helper when constructing the resolved layer.
Keep the existing error code, but change the error message to:

```text
target and Matte must both be Track-Matte-capable visual layers
```

- [ ] **Step 4: Run the focused native tests and verify GREEN**

Run the dispatcher command from Step 2, then:

```bash
c++ -std=c++20 -Wall -Wextra -Wpedantic -Werror -pthread \
  -I native/ae-plugin/include \
  native/ae-plugin/src/core/rpc_codec.cpp \
  native/ae-plugin/tests/rpc_codec_test.cpp \
  -o /tmp/ae-mcp-rpc-codec-test \
  && /tmp/ae-mcp-rpc-codec-test
```

Expected: both binaries print `PASS`.

### Task 2: Make the existing HDEV prove text-layer Track Matte support

**Files:**
- Modify: `scripts/hardware/issue190_layer_source_matte_av_spec.py`
- Modify: `scripts/hardware/issue190_layer_source_matte_av_acceptance.py`
- Test: `packages/bridge/tests/test_issue190_layer_source_matte_av_driver.py`
- Modify: `scripts/hardware/README.md`

**Interfaces:**
- Consumes: the existing role name `MATTE_SOURCE` and unchanged 40-call plan addresses.
- Produces: the same locator role backed by a text layer rather than a solid.

- [ ] **Step 1: Write the failing fixture test**

Extend the fixture-script test to require:

```javascript
matteSource = mainComp.layers.addText('MATTE_SOURCE');
matteSource.name = 'MATTE_SOURCE';
```

and reject the old `addSolid(..., 'MATTE_SOURCE', ...)` construction. Assert
that `CALL_HARD_LIMIT` and `len(CALL_PLAN)` both remain `40`.

- [ ] **Step 2: Run the driver test and verify RED**

Run:

```bash
env PYTHONPATH=packages/core:packages/bridge:packages/snapshot-mss \
  .venv/bin/python -m pytest -q \
  packages/bridge/tests/test_issue190_layer_source_matte_av_driver.py
```

Expected: FAIL because `MATTE_SOURCE` is still created with `addSolid`.

- [ ] **Step 3: Replace only the fixture layer construction**

Create `MATTE_SOURCE` with `addText('MATTE_SOURCE')`, assign its explicit name,
and leave its creation position unchanged so the baseline stack order,
`MATTE_SPACER` adjacency, reorder target, locators, public calls, and Undo
checkpoints remain unchanged. Add a `roleTypes` entry to `FIXTURE_SPEC`:

```python
"roleTypes": {"MATTE_SOURCE": "text"},
```

Update the hardware README to call `MATTE_SOURCE` a deterministic text layer.

- [ ] **Step 4: Run the focused HDEV construction tests and verify GREEN**

Run the command from Step 2.

Expected: all tests pass and the plan still contains exactly 40 public calls.

### Task 3: Verify, deploy the bounded fix, and replay HDEV once

**Files:**
- No new product files.
- HDEV evidence remains outside the repository.

**Interfaces:**
- Consumes: the exact branch HEAD built from Tasks 1 and 2.
- Produces: one replacement non-candidate HDEV receipt demonstrating a text-layer Matte through public MCP.

- [ ] **Step 1: Run the complete lower-tier verification**

Run:

```bash
env PYTHONPATH=packages/core:packages/bridge:packages/snapshot-mss \
  .venv/bin/python -m pytest -q
node --test native/ae-plugin/protocol/protocol.test.mjs
(cd plugin/host && npm test)
(cd plugin/panel && npm test)
(cd plugin/sidecar && npm test)
node --test scripts/package/test/*.test.mjs
node --test scripts/release/test/*.test.mjs
node scripts/check-repository-governance.mjs
git diff --check
```

Expected: zero failures; platform-declared skips and the existing release todo
remain explicitly reported.

- [ ] **Step 2: Commit and push the blocker fix**

Commit only the approved predicate, fixture, tests, and documentation:

```bash
git add \
  native/ae-plugin/include/aemcp_native/host_dispatcher.hpp \
  native/ae-plugin/src/core/host_dispatcher.cpp \
  native/ae-plugin/src/aegp/plugin_entry.cpp \
  native/ae-plugin/tests/host_dispatcher_test.cpp \
  scripts/hardware/issue190_layer_source_matte_av_spec.py \
  scripts/hardware/issue190_layer_source_matte_av_acceptance.py \
  packages/bridge/tests/test_issue190_layer_source_matte_av_driver.py \
  scripts/hardware/README.md \
  docs/superpowers/specs/2026-07-28-layer-source-track-matte-av-design.md \
  docs/superpowers/plans/2026-07-29-track-matte-visual-layer-eligibility.md
git commit -m "fix(native): admit visual Track Matte layers"
git push
```

- [ ] **Step 3: Wait for focused CI**

Require the Linux packaging/native job, Windows Python job, and Windows
JS/contract job for the exact pushed HEAD to complete successfully.

- [ ] **Step 4: Run the unchanged-budget real-AE HDEV**

After component-selective native/Core sync and read-only doctor, run from the
exact checkout:

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

Expected:

- `40/40` public MCP calls pass;
- `MATTE_SOURCE` resolves as a text layer;
- Alpha set/read/reorder stability and Luma clear/read all use that exact text-layer locator;
- five real Undo operations execute and verify;
- one fixture is archived with zero active, unclassified, or evidence-snapshot fixtures;
- AE exits normally and no forced termination is attempted;
- every summary remains `validationProfile=development`,
  `candidateRun=false`, and `candidateEvidence=false`.

- [ ] **Step 5: Mark PR ready and merge only after all gates agree**

Require no unresolved Critical or Important review finding, exact-HEAD focused
CI success, the replacement HDEV result above, a clean worktree, and an
unchanged PR head SHA. Then mark PR #199 ready and merge it with the repository
default merge method.
