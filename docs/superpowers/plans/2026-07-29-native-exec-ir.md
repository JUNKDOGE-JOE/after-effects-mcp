# Native EXEC IR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace operation-specific JSX/native public tools with `ae_exec` and one bounded `ae_nativeExec` program tool backed by a single generated primitive registry and a default execution skill.

**Architecture:** A declarative native primitive registry is the only hand-maintained source of primitive IDs, schemas, mutability, required suites, documentation, and executor symbols. Generated portable C++ metadata drives admission and discovery; a generated binding projection connects the same ordered rows to SDK-backed executors in the plug-in. Core validates and transports one linear program, while the plug-in owns request-local AEGP handles, one Undo group for writes, common evidence, and partial-failure reporting.

**Tech Stack:** Python 3.10+/Pydantic/pytest, C++20 portable native tests, Adobe AEGP SDK plug-in build, Node 24 protocol tests, JSON Schema, bundled skill JSON.

## Global Constraints

- Final public execution tools are `ae_exec` and `ae_nativeExec`; operation-specific public aliases are removed.
- Maintained JSX-equivalent operations do not enter the native primitive registry.
- Native programs are bounded linear operation arrays with backward references only; V1 has no loops, branches, nested programs, arbitrary expressions, or cross-request handles.
- Read programs need no operation key. Write programs require a stable `operationKey` and `undoGroup`.
- A write program uses one real AE Undo group but is not advertised as atomic and is never silently rolled back.
- A possibly-side-effecting result must be reconciled by readback and audit before retry.
- No new process/PID/restart/release-identity or package-runner framework.
- Verification is focused CI plus one non-candidate HDEV using the existing development-smoke framework.

---

## File Structure

### New source-of-truth and generated files

- `native/ae-plugin/protocol/native-exec-migration.json` — disposition for every removed execution tool and all 67 legacy native capability IDs.
- `native/ae-plugin/protocol/native-primitives.json` — the only hand-maintained primitive catalog.
- `scripts/generate_native_exec.py` — validates both manifests and writes all projections.
- `native/ae-plugin/include/aemcp_native/native_primitive_registry.generated.hpp` — ordered portable registry metadata.
- `native/ae-plugin/src/aegp/native_primitive_bindings.generated.inc` — ordered SDK executor bindings from the same rows.
- `native/ae-plugin/protocol/native_exec.generated.mjs` — protocol/fixture projection.
- `packages/core/ae_mcp/native_exec_generated.py` — Core primitive metadata and JSON schemas.
- `packages/core/ae_mcp/skills_bundled/ae-execution-guide.json` — bundled default guide with generated primitive reference.

### New native runtime units

- `native/ae-plugin/include/aemcp_native/native_program.hpp` — program, operation, value, evidence, and failure types.
- `native/ae-plugin/src/core/native_program.cpp` — portable program admission, reference validation, digesting, and common result encoding.
- `native/ae-plugin/tests/native_program_test.cpp` — portable RED/GREEN coverage for the IR.
- `native/ae-plugin/src/aegp/native_program_executor.hpp` — SDK executor interface and request-local handle frame.
- `native/ae-plugin/src/aegp/native_program_executor.cpp` — AEGP primitive adapters and sequential execution.

### Existing integration units

- `native/ae-plugin/include/aemcp_native/rpc_codec.hpp`
- `native/ae-plugin/src/core/rpc_codec.cpp`
- `native/ae-plugin/include/aemcp_native/native_rpc_connection.hpp`
- `native/ae-plugin/src/core/native_rpc_connection.cpp`
- `native/ae-plugin/include/aemcp_native/host_dispatcher.hpp`
- `native/ae-plugin/src/core/host_dispatcher.cpp`
- `native/ae-plugin/src/aegp/plugin_entry.cpp`
- `packages/core/ae_mcp/schemas.py`
- `packages/core/ae_mcp/backends/native.py`
- `packages/core/ae_mcp/handlers/native.py`
- `packages/core/ae_mcp/server.py`
- `packages/core/ae_mcp/backends/base.py`
- `packages/core/ae_mcp/instructions.py`
- `packages/core/ae_mcp/skills_bundled/manifest.json`
- `scripts/hardware/development_smoke.py`
- `scripts/hardware/development_smoke_spec.py`

---

### Task 1: Freeze the migration manifest and primitive catalog

**Files:**
- Create: `native/ae-plugin/protocol/native-exec-migration.json`
- Create: `native/ae-plugin/protocol/native-primitives.json`
- Create: `scripts/generate_native_exec.py`
- Create: `packages/core/tests/test_native_exec_generation.py`
- Modify: `scripts/generate_text_shape_marker_capabilities.py`

**Interfaces:**
- Produces: `load_migration_manifest(path) -> MigrationManifest`
- Produces: `load_primitive_registry(path) -> PrimitiveRegistry`
- Produces: `generate_all(root: Path, *, check: bool) -> None`
- Produces: `validate_sources(root: Path) -> None`
- Consumes later: every generated native/Core/protocol/skill projection.

- [ ] **Step 1: Write a failing manifest-coverage test**

```python
def test_native_exec_migration_covers_legacy_registry_exactly():
    legacy = {
        item["id"]
        for item in json.loads(LEGACY_FULL.read_text())["items"]
    }
    migration = load_migration_manifest(MIGRATION)
    assert len(legacy) == 67
    assert set(migration.native_capabilities) == legacy
    assert all(
        row.disposition in {"JSX_EQUIVALENT", "NATIVE_PRIMITIVE"}
        for row in migration.native_capabilities.values()
    )
```

Also assert that every currently registered operation-specific public tool is
listed in `publicTools`, and that `ae.exec`, control-plane, preview, validation,
status, and Tool/Skill Library verbs are excluded.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
uv run pytest packages/core/tests/test_native_exec_generation.py -q
```

Expected: collection/import failure because `scripts.generate_native_exec` and
the two manifests do not exist.

- [ ] **Step 3: Write the migration manifest**

Classify these legacy capabilities as `NATIVE_PRIMITIVE` because their retained
contract requires native graph bootstrap or exact AEGP time/ratio/property
semantics:

```text
ae.project.items.list
ae.composition.layers.list
ae.composition.selected-layers.list
ae.composition.time.read
ae.composition.time.set
ae.composition.settings.read
ae.composition.duration.set
ae.composition.frame-rate.set
ae.composition.pixel-aspect-ratio.set
ae.composition.display-start-time.set
ae.layer.properties.list
ae.layer.property.keyframes.list
ae.layer.property.set
ae.layer.property.keyframe.details.read
ae.layer.property.keyframe.add
ae.layer.property.keyframe.value.set
ae.layer.property.keyframe.interpolation.set
ae.layer.property.keyframe.temporal-ease.set
ae.layer.property.keyframe.behavior.set
ae.layer.property.keyframe.delete
```

Classify the other 47 legacy native capability IDs as `JSX_EQUIVALENT`.
Each row must include `reason`, `replacement` (`ae_exec` or one or more
primitive IDs), and the source file that previously implemented it.

Enumerate operation-specific public tools from `HANDLERS`/`server.py` in
`publicTools`, with disposition `REMOVE_TO_AE_EXEC`,
`REMOVE_TO_AE_NATIVE_EXEC`, or `KEEP_CONTROL_PLANE`. Do not infer dispositions
at runtime.

- [ ] **Step 4: Write the primitive catalog**

Define exactly these V1 operation IDs:

```text
composition.resolve
layer.resolve
property.resolve
project.items.list
composition.layers.list
composition.selectedLayers.list
composition.time.read
composition.time.set
composition.settings.read
composition.duration.set
composition.frameRate.set
composition.pixelAspectRatio.set
composition.displayStartTime.set
layer.properties.list
property.keyframes.list
property.value.set
property.keyframe.details.read
property.keyframe.add
property.keyframe.value.set
property.keyframe.interpolation.set
property.keyframe.temporalEase.set
property.keyframe.behavior.set
property.keyframe.delete
```

Every row declares:

```json
{
  "id": "composition.time.read",
  "mutability": "read",
  "requiredSuite": "AEGP_CompSuite12",
  "inputSchema": {},
  "resultSchema": {},
  "executor": "execute_composition_time_read",
  "summary": "Read the exact current composition time.",
  "example": {}
}
```

Use the existing closed schemas for locators, exact time, exact ratio, property
values, interpolation, temporal ease, and behavior. Resolver results use
internal handle kinds and are marked `exportable: false`.

- [ ] **Step 5: Implement manifest and catalog validation**

Reject duplicate IDs/executor names, unknown dispositions, missing
justifications, a native migration row without valid replacement primitive
IDs, a JSX row without `ae_exec`, exported handles, write primitives without
write result evidence, and registry rows not ordered by the catalog's explicit
`order`.

Move only reusable canonical-JSON/schema helpers out of
`generate_text_shape_marker_capabilities.py`; do not retain two generators that
both rewrite the native registry fixture.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
uv run pytest packages/core/tests/test_native_exec_generation.py -q
uv run python scripts/generate_native_exec.py --validate
```

Expected: manifest/catalog tests pass and source validation exits 0 without
requiring generated outputs before Task 2.

- [ ] **Step 7: Commit**

```bash
git add native/ae-plugin/protocol/native-exec-migration.json \
  native/ae-plugin/protocol/native-primitives.json \
  scripts/generate_native_exec.py \
  scripts/generate_text_shape_marker_capabilities.py \
  packages/core/tests/test_native_exec_generation.py
git commit -m "test: freeze native exec migration catalog"
```

---

### Task 2: Generate one primitive registry and replace metadata carriers

**Files:**
- Create: `native/ae-plugin/include/aemcp_native/native_primitive_registry.generated.hpp`
- Create: `native/ae-plugin/src/aegp/native_primitive_bindings.generated.inc`
- Create: `native/ae-plugin/protocol/native_exec.generated.mjs`
- Create: `packages/core/ae_mcp/native_exec_generated.py`
- Modify: `scripts/generate_native_exec.py`
- Modify: `native/ae-plugin/protocol/aegp-rpc.schema.json`
- Modify: `native/ae-plugin/protocol/protocol.test.mjs`
- Modify: `native/ae-plugin/include/aemcp_native/native_rpc_connection.hpp`
- Modify: `native/ae-plugin/include/aemcp_native/rpc_codec.hpp`
- Modify: `native/ae-plugin/src/core/native_rpc_connection.cpp`
- Modify: `native/ae-plugin/src/core/rpc_codec.cpp`
- Modify: `native/ae-plugin/tests/rpc_codec_test.cpp`
- Modify: `native/ae-plugin/tests/native_rpc_connection_test.cpp`

**Interfaces:**
- Produces: `std::span<const NativePrimitiveDescriptor> native_primitive_registry()`
- Produces: `find_native_primitive(std::string_view) -> const NativePrimitiveDescriptor*`
- Produces: `kNativeExecRegistryDigest`
- Produces: Python `PRIMITIVES`, `NATIVE_EXEC_INPUT_SCHEMA`, and digest constants.

- [ ] **Step 1: Write failing C++ registry tests**

Add tests asserting:

```cpp
require(native_primitive_registry().size() == 23, "primitive count drifted");
require(find_native_primitive("composition.time.read") != nullptr,
        "exact-time read missing");
require(find_native_primitive("ae.layer.track-matte.set") == nullptr,
        "JSX-equivalent legacy capability leaked into primitive registry");
require(std::ranges::all_of(native_primitive_registry(), unique_ids),
        "duplicate primitive ID");
```

Add a capabilities-encoding test that selects descriptors through an ordered
`std::vector<std::size_t>` and checks summary/full output and digest without
setting any per-capability Boolean or digest fields.

Add protocol conformance coverage that generated primitive IDs such as
`composition.time.read` and lower-camel segments such as
`composition.selectedLayers.list` are valid discovery IDs. The Task 2
capabilities result contains the 23 generated primitive descriptors, not the
67 legacy `ae.*` capability descriptors. Keep the still-internal legacy invoke
fixtures valid only until Task 3 replaces their wire admission.

- [ ] **Step 2: Verify RED**

Run the portable codec and connection compile commands from `.github/workflows/ci.yml`.

Expected: compilation fails because the generated registry API does not exist.

- [ ] **Step 3: Generate the registry projections**

Generate:

```cpp
enum class PrimitiveMutability { kRead, kWrite };
enum class PrimitiveValueKind { kJson, kCompositionHandle, kLayerHandle, kPropertyHandle };

struct NativePrimitiveDescriptor {
  std::string_view id;
  PrimitiveMutability mutability;
  std::string_view required_suite;
  std::string_view input_schema_json;
  std::string_view result_schema_json;
  std::string_view summary;
  std::string_view executor_symbol;
  PrimitiveValueKind result_kind;
  bool exportable;
};
```

The generated binding include expands the same ordered rows through:

```cpp
AEMCP_NATIVE_PRIMITIVE(
    "composition.time.read",
    execute_composition_time_read)
```

No hand-maintained C++ list may repeat these IDs.

- [ ] **Step 4: Collapse capabilities metadata carriers**

Replace all individual contract digest/include members in
`NativeRpcRuntimeInfo` and `CapabilitiesSuccess` with:

```cpp
std::vector<std::size_t> selected_primitive_indices;
std::string query_digest;
```

Read compiled contract and registry digests directly from the generated
registry. Change query filtering, selected counts, full/summary encoding, and
complete-registry digest verification to iterate the selected indices.

This task owns the narrow capabilities-discovery protocol transition required
by the unified registry. Update the shared capability-ID/schema conformance so
the generated primitive descriptors validate without adding a second
hand-maintained primitive-ID list. The transitional schema may continue to
accept legacy `ae.*` invoke IDs until Task 3, but the capabilities response
must emit only generated primitive rows. Task 3 still owns replacement of the
wire invoke arguments with the bounded native program.

At this task boundary, old invoke paths may still compile internally, but old
capability metadata must no longer be carried as parallel scalar fields.

- [ ] **Step 5: Generate and check all projections**

Run:

```bash
uv run python scripts/generate_native_exec.py
uv run python scripts/generate_native_exec.py --check
```

Expected: second command exits 0 with no diff.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
node --test native/ae-plugin/protocol/protocol.test.mjs
c++ -std=c++20 -Wall -Wextra -Wpedantic -Werror -pthread \
  -I native/ae-plugin/include \
  native/ae-plugin/src/core/rpc_codec.cpp \
  native/ae-plugin/tests/rpc_codec_test.cpp \
  -o /tmp/ae-mcp-rpc-codec-test
/tmp/ae-mcp-rpc-codec-test
c++ -std=c++20 -Wall -Wextra -Wpedantic -Werror -pthread \
  -I native/ae-plugin/include \
  native/ae-plugin/src/core/host_dispatcher.cpp \
  native/ae-plugin/src/core/rpc_codec.cpp \
  native/ae-plugin/src/core/native_rpc_connection.cpp \
  native/ae-plugin/tests/native_rpc_connection_test.cpp \
  -o /tmp/ae-mcp-native-rpc-connection-test
/tmp/ae-mcp-native-rpc-connection-test
```

- [ ] **Step 7: Commit**

```bash
git add scripts/generate_native_exec.py \
  native/ae-plugin/include/aemcp_native/native_primitive_registry.generated.hpp \
  native/ae-plugin/src/aegp/native_primitive_bindings.generated.inc \
  native/ae-plugin/protocol/native_exec.generated.mjs \
  packages/core/ae_mcp/native_exec_generated.py \
  native/ae-plugin/include/aemcp_native/native_rpc_connection.hpp \
  native/ae-plugin/include/aemcp_native/rpc_codec.hpp \
  native/ae-plugin/src/core/native_rpc_connection.cpp \
  native/ae-plugin/src/core/rpc_codec.cpp \
  native/ae-plugin/tests/rpc_codec_test.cpp \
  native/ae-plugin/tests/native_rpc_connection_test.cpp
git commit -m "refactor(native): generate primitive registry metadata"
```

---

### Task 3: Implement portable native-program admission

**Files:**
- Create: `native/ae-plugin/include/aemcp_native/native_program.hpp`
- Create: `native/ae-plugin/src/core/native_program.cpp`
- Create: `native/ae-plugin/tests/native_program_test.cpp`
- Modify: `native/ae-plugin/protocol/native-primitives.json`
- Modify: `scripts/generate_native_exec.py`
- Regenerate: `native/ae-plugin/include/aemcp_native/native_primitive_registry.generated.hpp`
- Regenerate: `native/ae-plugin/protocol/native_exec.generated.mjs`
- Regenerate: `packages/core/ae_mcp/native_exec_generated.py`
- Modify: `native/ae-plugin/include/aemcp_native/rpc_codec.hpp`
- Modify: `native/ae-plugin/src/core/rpc_codec.cpp`
- Modify: `native/ae-plugin/src/core/native_rpc_connection.cpp`
- Modify: `native/ae-plugin/tests/native_rpc_connection_test.cpp`
- Modify: `native/ae-plugin/protocol/aegp-rpc.schema.json`
- Modify: `native/ae-plugin/protocol/conformance.mjs`
- Modify: `native/ae-plugin/protocol/protocol.test.mjs`
- Create/Modify/Delete: `native/ae-plugin/protocol/fixtures/*.json` as required by the breaking invoke-wire switch
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `parse_native_program(JsonObject) -> NativeProgram`
- Produces: `validate_native_program(const NativeProgram&, registry) -> ProgramAdmission`
- Produces: `digest_native_program(const NativeProgram&) -> std::string`
- Produces: `NativeProgramParams` as the only model-facing invoke arguments.

- [ ] **Step 1: Write RED tests for the linear IR**

Cover:

- one read operation needs no key;
- write operation without `operationKey` and `undoGroup` fails;
- unknown primitive fails;
- duplicate `saveAs` fails;
- forward and unknown refs fail;
- a composition handle cannot satisfy a layer-handle argument;
- resolver handles cannot be exported;
- 65 operations fail when `kMaxNativeProgramOperations == 64`;
- program digest changes when operation arguments change;
- old `capabilityId: ae.layer.track-matte.set` invoke fails admission.

The registry is also the sole source of argument-level reference typing.
Declare top-level `referenceArguments` on each source row and generate it into
portable metadata; admission must never infer expected handle kinds from
primitive IDs or argument names. Freeze this V1 map:

```text
composition.resolve                         no refs; literal locator
layer.resolve                               composition: CompositionHandle; literal locator
property.resolve                            layer: LayerHandle; literal locator
project.items.list                          no refs
composition.* except composition.resolve   composition: CompositionHandle
layer.properties.list                       layer: LayerHandle; optional parentProperty: PropertyHandle
property.keyframes.list                     property: PropertyHandle
property.keyframe.details.read              property: PropertyHandle
property.value.set and keyframe writes      layer: LayerHandle, property: PropertyHandle
```

The source `inputSchema` describes the remaining JSON-safe literal arguments.
Generated model-facing argument schemas merge those literals with strict
`{"ref":"<earlier-name>"}` objects at the declared reference arguments.
Remove legacy per-operation locator fields that those refs replace and remove
legacy per-operation `idempotencyKey` fields; one program-level
`operationKey` owns write replay fencing.

- [ ] **Step 2: Compile and verify RED**

Compile `native_program_test.cpp` with `rpc_codec.cpp`; expected failure is
missing `NativeProgram` and parser symbols.

- [ ] **Step 3: Implement the program types**

Use:

```cpp
inline constexpr std::size_t kMaxNativeProgramOperations = 64;

struct NativeProgramOperation {
  std::string primitive_id;
  JsonObject arguments;
  std::optional<std::string> save_as;
  std::optional<std::string> return_as;
};

struct NativeProgram {
  std::string operation_key;
  std::string undo_group;
  std::vector<NativeProgramOperation> operations;
};
```

Keep JSON DOM/parser helpers in the portable runtime instead of duplicating
them in codec and executor.

- [ ] **Step 4: Implement closed admission**

Validate the whole program before creating a dispatcher request. Produce a
`ProgramAdmission` containing the ordered descriptors, named-value type map,
`contains_write`, and program digest.

Replace the wire-level operation-specific `InvokeParams` fields with
`NativeProgramParams`. Old typed host structs remain internal until their
executors are migrated; they are no longer wire parse targets.

The model-facing operation object uses `op`, `args`, optional `saveAs`, and
optional `returnAs`. `arguments` remains only the internal C++ field name.
Because `native_rpc_connection.cpp` consumes parsed params, update its
transitional branch so the repository continues to compile after the wire
replacement. Until Task 4 installs the dispatcher request, an admitted native
program may return a structured native-unavailable/not-yet-wired result; do
not retain an operation-specific wire fallback.

- [ ] **Step 5: Update protocol schema and tests**

The only model-facing native invoke capability becomes `ae.native.exec` with
arguments:

```json
{
  "operationKey": "optional for read-only",
  "undoGroup": "optional for read-only",
  "operations": []
}
```

The schema references generated primitive argument definitions and rejects
additional properties.

Task 3 is the intentional breaking root-wire switch. Replace the active
operation-specific invoke conformance matrix with native-program positive and
negative fixtures. Remove obsolete operation-specific invoke descriptors,
goldens, and helper paths from active protocol conformance when they have no
remaining non-wire consumer; do not preserve them behind a compatibility
schema. Keep and adapt independent framing, hello, session, capabilities,
cancel, graph invalidation, limits, and generic error tests. Task 5 will add
the new common native-program result/evidence transcript matrix, so legacy
per-operation result fixtures are not a reason to retain the old invoke wire.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
c++ -std=c++20 -Wall -Wextra -Wpedantic -Werror -pthread \
  -I native/ae-plugin/include \
  native/ae-plugin/src/core/native_program.cpp \
  native/ae-plugin/src/core/rpc_codec.cpp \
  native/ae-plugin/tests/native_program_test.cpp \
  -o /tmp/ae-mcp-native-program-test
/tmp/ae-mcp-native-program-test
node --test native/ae-plugin/protocol/protocol.test.mjs
c++ -std=c++20 -Wall -Wextra -Wpedantic -Werror -pthread \
  -I native/ae-plugin/include \
  native/ae-plugin/src/core/host_dispatcher.cpp \
  native/ae-plugin/src/core/rpc_codec.cpp \
  native/ae-plugin/src/core/native_rpc_connection.cpp \
  native/ae-plugin/tests/native_rpc_connection_test.cpp \
  -o /tmp/ae-mcp-native-rpc-connection-test
/tmp/ae-mcp-native-rpc-connection-test
```

- [ ] **Step 7: Commit**

```bash
git add native/ae-plugin/include/aemcp_native/native_program.hpp \
  native/ae-plugin/src/core/native_program.cpp \
  native/ae-plugin/tests/native_program_test.cpp \
  native/ae-plugin/include/aemcp_native/rpc_codec.hpp \
  native/ae-plugin/src/core/rpc_codec.cpp \
  native/ae-plugin/protocol/aegp-rpc.schema.json \
  native/ae-plugin/protocol/protocol.test.mjs \
  .github/workflows/ci.yml
git commit -m "feat(native): admit bounded native programs"
```

---

### Task 4: Execute programs with request-local AEGP handles

**Files:**
- Create: `native/ae-plugin/src/aegp/native_program_executor.hpp`
- Create: `native/ae-plugin/src/aegp/native_program_executor.cpp`
- Modify: `native/ae-plugin/include/aemcp_native/host_dispatcher.hpp`
- Modify: `native/ae-plugin/src/core/host_dispatcher.cpp`
- Modify: `native/ae-plugin/src/aegp/plugin_entry.cpp`
- Modify: `native/ae-plugin/build-macos.mjs`
- Modify: `native/ae-plugin/tests/host_dispatcher_test.cpp`

**Interfaces:**
- Produces: `HostApi::execute_native_program(const NativeProgram&, host_instance_id, session_id, TimePoint)`
- Produces: request-local `NativeHandleFrame`
- Produces: `NativeProgramHostResult` with ordered operation outcomes and named exports.

- [ ] **Step 1: Write a failing host-dispatch test**

Use a fake `HostApi` that records one program dispatch. Assert:

- the dispatcher submits the whole program once;
- a read program does not begin Undo;
- a write program begins and ends exactly one Undo group;
- an executor failure after a completed write reports completed operation
  indices and `possibly-side-effecting`;
- dispatcher timeout before host entry reports `not-started`.

- [ ] **Step 2: Verify RED**

Compile/run the portable host dispatcher test. Expected failure: no native
program request/result variant or HostApi entry point.

- [ ] **Step 3: Add one native-program dispatcher request**

Add one request/completion pair to `HostDispatcher`; do not add one pair per
primitive. Bind replay fencing to `operationKey + programDigest`.

Rename the existing layer-specific Undo entry points to general
`begin_undo_group(label)` / `end_undo_group()` and update their existing
callers without changing observed Undo behavior.

- [ ] **Step 4: Implement the request-local handle frame**

Inside the AEGP executor, store typed non-exportable handles:

```cpp
using NativeHandle = std::variant<
    ScopedCompositionHandle,
    ScopedLayerHandle,
    ScopedPropertyHandle>;

class NativeHandleFrame {
 public:
  void save(std::string name, NativeHandle value);
  const NativeHandle& require(std::string_view name, HandleKind expected) const;
};
```

The scoped wrappers own only the lifecycle required by their AEGP suites.
Clear the frame on success, failure, timeout, cancellation, and host shutdown.

- [ ] **Step 5: Bind the 23 generated executors**

Implement thin adapters for the exact IDs from Task 1. Resolver adapters create
non-exportable handles. Other adapters consume typed refs and return JSON-safe
values using existing exact-time, exact-ratio, property-value, keyframe,
provenance, and postcondition helpers.

Include `native_primitive_bindings.generated.inc` to construct the executor
array. Do not write a second ID switch.

- [ ] **Step 6: Verify portable and SDK builds**

Run:

```bash
c++ -std=c++20 -Wall -Wextra -Wpedantic -Werror -pthread \
  -I native/ae-plugin/include \
  native/ae-plugin/src/core/native_program.cpp \
  native/ae-plugin/src/core/host_dispatcher.cpp \
  native/ae-plugin/tests/host_dispatcher_test.cpp \
  -o /tmp/ae-mcp-host-dispatcher-test
/tmp/ae-mcp-host-dispatcher-test
node native/ae-plugin/build-macos.mjs --help
```

Then run the repository's contract-checked development native build with the
already configured Adobe SDK input. Do not install or launch AE in this task.

- [ ] **Step 7: Commit**

```bash
git add native/ae-plugin/src/aegp/native_program_executor.hpp \
  native/ae-plugin/src/aegp/native_program_executor.cpp \
  native/ae-plugin/include/aemcp_native/host_dispatcher.hpp \
  native/ae-plugin/src/core/host_dispatcher.cpp \
  native/ae-plugin/src/aegp/plugin_entry.cpp \
  native/ae-plugin/build-macos.mjs \
  native/ae-plugin/tests/host_dispatcher_test.cpp
git commit -m "feat(native): execute request-local AEGP programs"
```

---

### Task 5: Wire common program results, replay, and evidence

**Files:**
- Modify: `native/ae-plugin/protocol/aegp-rpc.schema.json`
- Modify: `native/ae-plugin/protocol/protocol.test.mjs`
- Modify: `native/ae-plugin/include/aemcp_native/host_dispatcher.hpp`
- Modify: `native/ae-plugin/src/core/host_dispatcher.cpp`
- Modify: `native/ae-plugin/src/aegp/native_program_executor.cpp`
- Modify: `native/ae-plugin/src/aegp/plugin_entry.cpp`
- Modify: `native/ae-plugin/include/aemcp_native/native_rpc_connection.hpp`
- Modify: `native/ae-plugin/src/core/native_rpc_connection.cpp`
- Modify: `native/ae-plugin/include/aemcp_native/rpc_codec.hpp`
- Modify: `native/ae-plugin/src/core/rpc_codec.cpp`
- Modify: `native/ae-plugin/tests/native_rpc_connection_test.cpp`
- Modify: `native/ae-plugin/tests/rpc_codec_test.cpp`
- Modify: `plugin/host/native-aegp-client.js`
- Modify: `plugin/host/native-aegp-client.test.js`

**Interfaces:**
- Produces: one `NativeProgramSuccess` response envelope.
- Produces: one `NativeProgramFailure` with `not-started`, `completed`, or `possibly-side-effecting`.
- Preserves: audit/request/postcondition IDs and same-key replay semantics.

- [ ] **Step 1: Write failing connection tests**

Add one read and one write program wire request. Assert:

- progress is emitted for the program, not once per primitive;
- success contains named `outputs`, ordered operation summaries, common
  evidence, and no raw handles;
- same operation key + same digest returns the recorded terminal response
  without redispatch;
- same key + different digest returns conflict;
- disconnect after write dispatch preserves a possibly-side-effecting terminal
  outcome;
- persistent diagnostic serialization recognizes `ae.native.exec`.

- [ ] **Step 2: Verify RED**

Run portable codec/connection tests; expected failure is missing program
terminal encoding and connection routing.

- [ ] **Step 3: Implement one result encoder**

Encode:

```json
{
  "capabilityId": "ae.native.exec",
  "outputs": {},
  "operations": [
    {"index": 0, "op": "composition.resolve", "status": "completed"}
  ],
  "evidence": {},
  "undo": {}
}
```

Do not add per-primitive success encoder functions. Canonicalize the public
outputs and completed-operation list into the postcondition digest.

- [ ] **Step 4: Update the CEP native client**

The client sends one program request, preserves request/operation keys,
validates the common response, and maps transport uncertainty to the existing
Core `POSSIBLY_SIDE_EFFECTING_FAILURE` contract.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
node --test plugin/host/native-aegp-client.test.js
```

and the portable codec/connection commands from Task 2.

- [ ] **Step 6: Commit**

```bash
git add native/ae-plugin/include/aemcp_native/native_rpc_connection.hpp \
  native/ae-plugin/src/core/native_rpc_connection.cpp \
  native/ae-plugin/include/aemcp_native/rpc_codec.hpp \
  native/ae-plugin/src/core/rpc_codec.cpp \
  native/ae-plugin/tests/native_rpc_connection_test.cpp \
  native/ae-plugin/tests/rpc_codec_test.cpp \
  plugin/host/native-aegp-client.js \
  plugin/host/native-aegp-client.test.js
git commit -m "feat(native): return common native program evidence"
```

---

### Task 6: Expose `ae_nativeExec` through Core

**Files:**
- Modify: `packages/core/ae_mcp/schemas.py`
- Modify: `packages/core/ae_mcp/backends/native.py`
- Modify: `packages/core/ae_mcp/handlers/native.py`
- Modify: `packages/core/ae_mcp/annotations.py`
- Modify: `packages/core/ae_mcp/server.py`
- Create: `packages/core/tests/test_native_exec.py`
- Create: `packages/core/tests/test_server_native_tools.py`
- Modify: `packages/core/tests/test_schemas.py`
- Modify: `packages/core/tests/test_annotations.py`
- Modify: `packages/bridge/ae_mcp_bridge/__init__.py`
- Modify: `packages/bridge/tests/test_http_native_bridge.py`
- Modify: `scripts/generate_native_exec.py`
- Modify: `packages/core/tests/test_native_exec_generation.py`
- Regenerate: `native/ae-plugin/protocol/aegp-rpc.schema.json`
- Regenerate: `native/ae-plugin/protocol/native_exec.generated.mjs`
- Regenerate: `packages/core/ae_mcp/native_exec_generated.py`
- Modify: `native/ae-plugin/src/core/native_program.cpp`
- Modify: `native/ae-plugin/tests/native_program_test.cpp`

**Interfaces:**
- Produces: `AeNativeExecArgs`
- Produces: `NativeProgramRequest`
- Produces: public handler registered as canonical `ae.nativeExec` and exposed as `ae_nativeExec`.

- [ ] **Step 1: Write failing Core schema/handler tests**

Test the generated discriminated operation schema, read/write envelope rules,
maximum 64 operations, backward-only refs, backend program digest, common
success projection, and possibly-side-effecting error mapping.

Assert `ae.nativeExec` is exposed only for `NativeInvokeBackend`; `ae.exec`
remains available through the JSX backend.

- [ ] **Step 2: Verify RED**

Run:

```bash
uv run pytest packages/core/tests/test_native_exec.py \
  packages/core/tests/test_schemas.py \
  packages/core/tests/test_annotations.py -q
```

Expected: missing `AeNativeExecArgs` and handler registration.

- [ ] **Step 3: Add generated Pydantic-facing schema**

`AeNativeExecArgs` consumes the generated operation union and performs only
cross-operation validation that JSON Schema cannot express:

```python
class AeNativeExecArgs(_StrictModel):
    operation_key: str | None = None
    undo_group: str | None = None
    operations: list[NativeProgramOperation]
```

Require keys only when a generated primitive row is mutating.

- [ ] **Step 4: Add one backend and handler route**

Create one `NativeProgramRequest`, negotiate the single native-exec contract,
invoke it once, and return the common result. Use the existing progress,
cancellation, audit, uncertain-write, and timeout mechanisms without
capability-specific wrappers. The concrete HTTP bridge must route
`ae.native.exec` through the common program result model, treat the presence of
`operationKey` as the write signal, and preserve that real key in uncertain
write details; legacy invoke parsing remains unchanged.

The migration-coverage validator must exclude the two final canonical execution
surfaces, `ae.exec` and `ae.nativeExec`, from the operation-specific removal
manifest. This amendment does not generate or install the Task 7 Skill.

- [ ] **Step 5: Verify GREEN**

Run the tests from Step 2 plus:

```bash
uv run pytest packages/core/tests/test_handlers_native.py \
  packages/core/tests/test_server_native_tools.py -q
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/ae_mcp/schemas.py \
  packages/core/ae_mcp/backends/native.py \
  packages/core/ae_mcp/handlers/native.py \
  packages/core/ae_mcp/annotations.py \
  packages/core/ae_mcp/server.py \
  packages/core/tests/test_native_exec.py \
  packages/core/tests/test_schemas.py \
  packages/core/tests/test_annotations.py
git commit -m "feat(core): expose bounded native exec programs"
```

---

### Task 7: Build and pressure-test the default execution skill

**Required sub-skill:** Use `superpowers:writing-skills`.

**Files:**
- Modify: `scripts/generate_native_exec.py`
- Create: `packages/core/ae_mcp/skills_bundled/ae-execution-guide.json`
- Modify: `packages/core/ae_mcp/skills_bundled/manifest.json`
- Modify: `packages/core/ae_mcp/instructions.py`
- Modify: `packages/core/tests/test_skill_store.py`
- Modify: `packages/core/tests/test_server_instructions.py`
- Modify: `packages/core/tests/test_native_exec_generation.py`
- Create: `packages/core/tests/fixtures/native-exec-skill-pressure.json`
- Modify: `packages/core/ae_mcp/tool_secrets.py`
- Modify: `packages/core/tests/test_tool_secrets.py`
- Modify: `packages/core/tests/test_tool_legacy.py`

**Interfaces:**
- Produces: trusted bundled `builtin:skill:ae-execution-guide`.
- Produces: short always-on routing rule in server instructions.
- Consumes: generated primitive registry; no hand-maintained primitive list.

- [ ] **Step 1: Run RED pressure scenarios without the skill**

Use fresh subagents for three bounded scenarios:

1. “Disable a layer and verify it” — expected correct route is `ae_exec`.
2. “Read exact composition rational time through AEGP” — expected route is
   `ae_nativeExec`.
3. “Retry a timed-out native write” — expected behavior is readback/audit
   reconciliation, not blind retry.

Record the baseline route choice and exact rationalizations in
`packages/core/tests/fixtures/native-exec-skill-pressure.json`.

- [ ] **Step 2: Write failing skill tests**

Assert:

- server instructions name only the two execution routes;
- instructions point to `builtin:skill:ae-execution-guide`;
- the bundled skill contains route choice, program composition, readback,
  Undo, uncertain write, and visual verification sections;
- every generated primitive appears exactly once;
- removed tool names do not appear;
- every JSON example validates through `AeNativeExecArgs` or `AeExecArgs`;
- manifest SHA-256 matches the skill file.

- [ ] **Step 3: Verify RED**

Run:

```bash
uv run pytest packages/core/tests/test_skill_store.py \
  packages/core/tests/test_server_instructions.py \
  packages/core/tests/test_native_exec_generation.py -q
```

Expected: missing guide and old typed-tool instructions still present.

- [ ] **Step 4: Generate the skill**

Keep the stable decision and workflow prose under 500 words. Generate the
primitive reference and examples from `native-primitives.json`. Consolidate
still-correct ExtendScript guidance from `extendscript-cookbook.json`; do not
copy removed tool instructions.

Update `_BASE_INSTRUCTIONS` to a short route rule and the skill ID. Remove the
long operation-specific native-tool walkthrough.

- [ ] **Step 5: Re-run pressure scenarios with the skill**

Each fresh agent must choose the expected route and avoid removed tools. Add
the passing results to the pressure fixture and close only the observed
loopholes.

- [ ] **Step 6: Verify GREEN**

Run the tests from Step 3 and:

```bash
uv run python scripts/generate_native_exec.py --check
```

- [ ] **Step 7: Commit**

```bash
git add scripts/generate_native_exec.py \
  packages/core/ae_mcp/skills_bundled/ae-execution-guide.json \
  packages/core/ae_mcp/skills_bundled/manifest.json \
  packages/core/ae_mcp/instructions.py \
  packages/core/tests/fixtures/native-exec-skill-pressure.json \
  packages/core/tests/test_skill_store.py \
  packages/core/tests/test_server_instructions.py \
  packages/core/tests/test_native_exec_generation.py
git commit -m "feat(core): ship the default AE execution guide"
```

---

### Task 8: Remove the operation-specific public surface

**Files:**
- Modify: `packages/core/ae_mcp/server.py`
- Modify: `packages/core/ae_mcp/backends/base.py`
- Modify: `packages/core/ae_mcp/handlers/__init__.py`
- Modify/Delete: operation-specific registrations in `packages/core/ae_mcp/handlers/*.py`
- Modify: `packages/core/ae_mcp/schemas.py`
- Modify: `packages/core/ae_mcp/schemas_tsm.py`
- Modify: `packages/core/ae_mcp/annotations.py`
- Modify: `packages/core/tests/test_tool_names.py`
- Modify: `packages/core/tests/test_backend_base.py`
- Modify: `packages/core/tests/test_server_native_tools.py`
- Modify: `packages/core/tests/test_schemas.py`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/REFERENCE.md`
- Modify: `docs/WORKFLOW.md`
- Modify: `scripts/generate_native_exec.py`
- Modify: `packages/core/tests/test_native_exec_generation.py`

**Interfaces:**
- Final public execution surface: `ae.exec` and `ae.nativeExec`.
- Final control/observation surface: only rows approved by the migration manifest.

- [ ] **Step 1: Write a failing exact-public-surface test**

Build the expected execution/control set from the migration manifest and assert:

```python
assert "ae.exec" in public
assert "ae.nativeExec" in public
assert not (public & removed_operation_specific_tools)
```

Also assert no removed tool is in `ALL_VERBS`, handler registration, annotations,
server native exposure, public schemas, README tables, reference, workflow, or
server instructions.

- [ ] **Step 2: Verify RED**

Run public-surface and schema tests. Expected: removed tools remain registered.

- [ ] **Step 3: Delete public registrations and schemas**

Remove operation-specific handlers and public Pydantic models when they have no
internal native-program use. Move reusable closed value models into
`native_exec_generated.py` or a private `native_values.py`; do not preserve
public tool-shaped model names.

Keep `ae.exec`, `ae.nativeExec`, preview, expression validation, explicit Undo
verification, tool/skill library, status, connection, and bounded diagnostics.

- [ ] **Step 4: Rewrite public documentation**

Replace long tool matrices with:

- the two execution routes;
- the default skill;
- the native program envelope;
- locator/readback/Undo rules;
- how to inspect the generated primitive catalog.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
uv run pytest packages/core/tests/test_tool_names.py \
  packages/core/tests/test_backend_base.py \
  packages/core/tests/test_server_native_tools.py \
  packages/core/tests/test_schemas.py \
  packages/core/tests/test_server_instructions.py -q
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/ae_mcp/server.py \
  packages/core/ae_mcp/backends/base.py \
  packages/core/ae_mcp/handlers \
  packages/core/ae_mcp/schemas.py \
  packages/core/ae_mcp/schemas_tsm.py \
  packages/core/ae_mcp/annotations.py \
  packages/core/tests/test_tool_names.py \
  packages/core/tests/test_backend_base.py \
  packages/core/tests/test_server_native_tools.py \
  packages/core/tests/test_schemas.py \
  README.md README.zh-CN.md docs/REFERENCE.md docs/WORKFLOW.md
git commit -m "refactor(core): replace typed tools with two exec routes"
```

**Execution record (2026-07-30):** Task 8 completed in commits
`1a4e229..75249cb`. The exact-surface removal also touched
`packages/core/ae_mcp/backends/maintained_layer_source.py` to make its two
still-consumed locator inputs genuinely private, retired obsolete
operation-specific tests, and removed the no-longer-public TSM schema test.
The final public tool and public `BaseModel` surfaces both equal the approved
final 16. Two concentrated/scoped review rounds ended CLEAN. The unchanged
direct-invoke golden mismatch remains owned by Task 9.

---

### Task 9: Delete legacy native protocol and dispatcher carriers

**Files:**
- Modify: `native/ae-plugin/include/aemcp_native/host_dispatcher.hpp`
- Modify: `native/ae-plugin/src/core/host_dispatcher.cpp`
- Modify: `native/ae-plugin/include/aemcp_native/rpc_codec.hpp`
- Modify: `native/ae-plugin/src/core/rpc_codec.cpp`
- Modify: `native/ae-plugin/include/aemcp_native/native_rpc_connection.hpp`
- Modify: `native/ae-plugin/src/core/native_rpc_connection.cpp`
- Modify: `native/ae-plugin/src/aegp/plugin_entry.cpp`
- Delete: `native/ae-plugin/include/aemcp_native/text_shape_marker_capabilities.generated.hpp`
- Delete: `native/ae-plugin/protocol/text_shape_marker_capabilities.generated.mjs`
- Modify: `native/ae-plugin/protocol/fixtures/capabilities.json`
- Modify: `native/ae-plugin/protocol/fixtures/capability-registry-full.json`
- Modify: `native/ae-plugin/protocol/fixtures/hello.json`
- Modify: native portable tests.

**Interfaces:**
- Keeps: only program-level request/completion/replay/evidence variants.
- Removes: legacy per-capability wire parsing, result encoding, descriptor
  functions, dispatch branches, digest/include carriers, and advertised arrays.

- [ ] **Step 1: Write failing carrier-absence tests**

Add source-contract assertions rejecting:

- any of the 67 legacy capability IDs outside the migration manifest;
- `include_project_*`, `include_layer_*`, or per-capability
  `*_contract_digest` members;
- operation-specific public invoke parsers/encoders;
- `kAdvertisedNativeCapabilities`;
- old TSM generated capability arrays.

Allow old IDs only in migration evidence and historical docs under
`docs/superpowers/specs|plans`.

- [ ] **Step 2: Verify RED**

Run the source-contract test and portable native tests. Expected: old carriers
are found.

- [ ] **Step 3: Remove dead native variants and branches**

Delete only code with no primitive executor consumer. When a primitive reuses
an old typed host value or SDK helper, move that type/helper under the
native-program runtime instead of deleting and reimplementing it.

`rpc_codec.cpp` must retain one native-program parser and one common encoder.
`native_rpc_connection.cpp` must retain one program dispatch branch.
`host_dispatcher.cpp` must retain one program request branch.

- [ ] **Step 4: Regenerate protocol fixtures**

The capabilities registry advertises only `ae.native.exec`; its full schema
contains the generated primitive union and its summary points models to the
default skill. Recompute one registry digest.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
uv run python scripts/generate_native_exec.py --check
node --test native/ae-plugin/protocol/protocol.test.mjs
```

Then run all three portable C++ native tests from CI.

- [ ] **Step 6: Commit**

```bash
git add -u native/ae-plugin
git add native/ae-plugin/protocol/fixtures/capabilities.json \
  native/ae-plugin/protocol/fixtures/capability-registry-full.json \
  native/ae-plugin/protocol/fixtures/hello.json
git commit -m "refactor(native): remove legacy capability carriers"
```

---

### Task 10: Rebase ordinary HDEV on the two EXEC routes

**Files:**
- Modify: `scripts/hardware/development_smoke_spec.py`
- Modify: `scripts/hardware/development_smoke.py`
- Modify: `packages/core/tests/test_development_smoke.py`
- Modify: `scripts/hardware/README.md`
- Delete or archive from active documentation: operation-specific package runner references whose public tools no longer exist.

**Interfaces:**
- Reuses: existing `DevelopmentEvidence`, `DevelopmentCallLedger`, fixture, session, and archive lifecycle.
- Produces: scenario `native-exec-ir@1`.

- [ ] **Step 1: Write failing scenario tests**

Define an 8-call maximum scenario:

1. readiness/status;
2. `ae_exec` creates the disposable composition/layer fixture;
3. `ae_nativeExec` resolves composition/layer and reads exact native state;
4. `ae_nativeExec` performs one exact native write;
5. independent `ae_nativeExec` readback;
6. explicit real Undo checkpoint;
7. independent `ae_nativeExec` restored-state readback;
8. structurally invalid `ae_nativeExec` rejected before dispatch.

Assert no legacy operation-specific public tool name appears in the call plan.

- [ ] **Step 2: Verify RED**

Run:

```bash
uv run pytest packages/core/tests/test_development_smoke.py -q
```

Expected: old `core-native-write-undo@1` calls dedicated typed tools.

- [ ] **Step 3: Update the existing runner**

Reuse the current fixture creation, evidence, call ledger, uncertain-write stop,
Undo checkpoint, and archive path. Change only the scenario-specific requests
and semantic predicates. Do not create another runner or evidence class.

- [ ] **Step 4: Verify GREEN**

Run the test from Step 2. Do not launch AE yet.

- [ ] **Step 5: Commit**

```bash
git add scripts/hardware/development_smoke_spec.py \
  scripts/hardware/development_smoke.py \
  packages/core/tests/test_development_smoke.py \
  scripts/hardware/README.md
git commit -m "test(hardware): cover the two exec routes"
```

---

### Task 11: Focused verification, review, and one HDEV

**Files:**
- Modify only files required by reproduced blockers.
- Record the final HDEV summary in the existing evidence location; do not commit private paths or raw `.aep` files.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: review receipt, focused CI receipt, and one non-candidate HDEV receipt.

- [ ] **Step 1: Run generated-file and Python verification**

```bash
uv run python scripts/generate_native_exec.py --check
uv run pytest \
  packages/core/tests/test_native_exec_generation.py \
  packages/core/tests/test_native_exec.py \
  packages/core/tests/test_schemas.py \
  packages/core/tests/test_annotations.py \
  packages/core/tests/test_server_native_tools.py \
  packages/core/tests/test_tool_names.py \
  packages/core/tests/test_backend_base.py \
  packages/core/tests/test_skill_store.py \
  packages/core/tests/test_server_instructions.py \
  packages/core/tests/test_development_smoke.py -q
```

- [ ] **Step 2: Run protocol and CEP verification**

```bash
node --test native/ae-plugin/protocol/protocol.test.mjs
node --test plugin/host/native-aegp-client.test.js
```

- [ ] **Step 3: Run portable native verification**

Compile and run `native_program_test`, `host_dispatcher_test`,
`rpc_codec_test`, and `native_rpc_connection_test` with the exact CI flags.

- [ ] **Step 4: Build the SDK-backed plug-in**

Run the contract-checked development build with the configured Adobe SDK.
Record source revision, canonical output path, component version, size, and
modification time. Do not perform a full payload hash walk.

- [ ] **Step 5: Request one concentrated review**

Classify findings under `AGENTS.md §5`. Fix only reproduced correctness,
recovery, audit, or acceptance blockers. Do not accept new generalized
hardening or runner infrastructure.

- [ ] **Step 6: Run focused CI once**

Run the scoped repository CI jobs covering Python Core, native protocol,
portable C++, CEP client, generated files, bundled skill, and public surface.

- [ ] **Step 7: Run one non-candidate HDEV**

Use `scripts/hardware/development_smoke.py --scenario native-exec-ir@1` with one
fresh `ephemeral-validation` fixture. Verify the exact eight-call budget,
public MCP route, real AE state, native provenance, audit, postcondition, one
real Undo, and restored readback.

- [ ] **Step 8: Commit only reproduced fixes**

If no fixes were required, do not create an empty commit. If fixes were
required, rerun only their affected lower tiers and commit them together:

```bash
git commit -m "fix: close native exec acceptance blockers"
```

- [ ] **Step 9: Prepare completion receipt**

Report:

- final public tool list;
- legacy tool/capability migration counts;
- primitive count and registry digest;
- removed carrier counts/LOC;
- focused test/CI results;
- HDEV public calls and result;
- real Undo evidence;
- fixture lifecycle counts;
- remaining follow-ups classified outside P0.
