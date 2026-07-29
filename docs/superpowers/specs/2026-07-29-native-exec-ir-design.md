# Native EXEC IR Design

**Date:** 2026-07-29

**Status:** User-approved design

## Problem

ae-mcp currently exposes many operation-specific public tools. A simple AEGP
call is repeatedly described by public schemas, Core handlers, capability
descriptors, contract-digest fields, request and result variants, dispatch
branches, encoders, fixtures, and package-specific hardware runners.

This has two product costs:

1. adding a thin SDK operation has a large, mostly mechanical implementation
   cost; and
2. the model sees overlapping JSX, typed-tool, and native-tool routes and must
   guess which route to use.

The plugin already has the flexible `ae_exec` model for ExtendScript. Native
AEGP should use the same product model: one constrained execution entry point
over a curated set of compiled native primitives.

## Goals

- Expose one public `ae_nativeExec` tool that executes a bounded linear native
  program.
- Keep `ae_exec` as the single execution route for operations supported by the
  maintained After Effects scripting object model.
- Remove operation-specific public tools that can be expressed by either EXEC
  route.
- Define every native primitive once in one ordered registry.
- Generate capability metadata, validation projection, documentation, and the
  bundled execution skill from that registry.
- Keep AEGP handles inside one request and one AE host instance.
- Preserve main-thread execution, typed primitive adapters, real Undo, audit,
  postcondition evidence, stable write keys, and uncertain-write
  reconciliation.
- Complete ordinary development with focused CI and one non-candidate HDEV.

## Non-goals

- Arbitrary C++ evaluation, runtime compilation, JIT, or a general FFI.
- Automatic wrapping of every function found in the Adobe SDK headers.
- Cross-request or externally visible raw AEGP handles.
- Backward compatibility for the old operation-specific public request and
  response schemas.
- A second long-lived public surface that exposes both old tools and
  `ae_nativeExec`.
- A general workflow language with loops, branches, callbacks, or expressions.
- Automatic rollback after a partially executed native program.
- New PID, process-census, restart-identity, pairing, release-identity, or
  generalized acceptance infrastructure.

## Public MCP Surface

The final public surface has two execution tools:

- `ae_exec` for ExtendScript;
- `ae_nativeExec` for curated AEGP-only primitives.

The following non-execution control and observation tools remain independently
public because execution code cannot replace their host integration:

- expression validation;
- frame preview and visual inspection;
- Undo state and explicit Undo verification;
- tool/skill index, search, inspect, and use;
- connection, status, and bounded diagnostics.

Operation-specific JSX convenience tools and operation-specific native tools
are removed from public registration. They are not retained as aliases or
deprecated duplicate routes.

The model-facing selection rule is:

```text
Maintained AE scripting object model can perform the operation -> ae_exec
Only a curated AEGP primitive provides the required semantics -> ae_nativeExec
Visual correctness must be checked -> ae_previewFrame
```

## Native Program IR

`ae_nativeExec` accepts one bounded, linear program:

```json
{
  "operationKey": "required-for-programs-containing-writes",
  "undoGroup": "required-for-programs-containing-writes",
  "operations": [
    {
      "op": "composition.resolve",
      "args": {
        "locator": {
          "contextId": "example",
          "hostInstanceId": "example",
          "objectId": "example"
        }
      },
      "saveAs": "composition"
    },
    {
      "op": "layer.resolve",
      "args": {
        "composition": {"ref": "composition"},
        "locator": {
          "contextId": "example",
          "hostInstanceId": "example",
          "objectId": "example"
        }
      },
      "saveAs": "layer"
    },
    {
      "op": "layer.getSourceItem",
      "args": {"layer": {"ref": "layer"}},
      "saveAs": "source"
    },
    {
      "op": "item.describe",
      "args": {"item": {"ref": "source"}},
      "returnAs": "result"
    }
  ]
}
```

V1 supports only:

- an ordered `operations` array;
- primitive IDs in `op`;
- JSON arguments in `args`;
- references to earlier named values through `{"ref": "<name>"}`;
- `saveAs` for request-local intermediate values; and
- `returnAs` for explicitly exported JSON-safe results.

There are no loops, conditions, arbitrary expressions, nested programs, or
cross-request variables.

The operations count is bounded. The exact bound is a protocol constant tested
at the admission layer, not a user-configurable setting. Existing frame-size,
deadline, cancellation, and main-thread budgets remain authoritative; the
implementation must not add unrelated resource guards.

## Request-local Handle Frame

AEGP handles are represented internally as typed request-local values. They:

- are created only by trusted resolver or primitive adapters;
- carry the current host and project context internally;
- can be consumed only by primitives declaring the matching handle type;
- never serialize into the public response;
- never survive completion, failure, cancellation, reconnect, or host restart.

External callers receive only JSON scalars, structured values, stable locators,
and evidence. A later request must resolve a fresh handle from a stable locator.

## Primitive Registry

One ordered compiled registry is the sole source of native primitive metadata:

```cpp
struct NativePrimitiveEntry {
  std::string_view id;
  PrimitiveMutability mutability;
  std::string_view required_suite;
  JsonSchemaView input_schema;
  JsonSchemaView result_schema;
  PrimitiveExecutor execute;
};
```

Each entry declares one thin AEGP operation. The entry does not define a public
workflow or duplicate an operation already provided by maintained JSX.

The registry generates or directly drives:

- primitive lookup;
- registry ordering;
- input and result schema projection;
- read/write program classification;
- suite availability admission;
- dispatcher selection;
- audit primitive names;
- full and summary primitive descriptors;
- contract and registry digests;
- protocol fixtures;
- the native primitive reference in the bundled execution skill.

Per-capability digest fields, include fields, hand-written selection counts, and
parallel full-registry tests are removed. The runtime carries a selected ordered
view of registry entries rather than one Boolean and one digest field per
operation.

Primitive executors remain strongly typed C++ adapters. The table must not
become raw function reflection, untyped varargs, or a generic pointer-calling
mechanism.

## Primitive Admission Policy

Every existing operation-specific capability receives exactly one migration
disposition:

### `JSX_EQUIVALENT`

The maintained AE scripting object model provides the required product
semantics. Remove the native public capability and route the documented
workflow through `ae_exec`. Do not add an equivalent native primitive merely
to preserve old code.

### `NATIVE_PRIMITIVE`

The operation has an explicit AEGP-only justification, such as exact native
time/ratio semantics, an SDK-only graph or media structure, or another observed
semantic not available through maintained JSX. Extract the thinnest reusable
primitive and register it.

### `CONTROL_PLANE`

The operation controls or observes the MCP/host integration rather than editing
AE through JSX or AEGP. Keep it as a separate public control tool.

The default disposition is `JSX_EQUIVALENT`. A capability may enter
`NATIVE_PRIMITIVE` only with a source-backed statement of the missing JSX
semantic. “The native implementation already exists” is not a justification.

The implementation owns a machine-readable migration manifest containing all
old public execution tools and all 67 current native capability IDs. Tests fail
if any old entry has no disposition, appears in multiple categories, or a
`NATIVE_PRIMITIVE` lacks its justification and replacement primitive IDs.

## Validation and Execution

Before scheduling AE main-thread work, Core/native admission validates:

1. the request envelope;
2. the operations count;
3. every primitive ID;
4. every primitive argument schema;
5. uniqueness and ordering of named values;
6. references only to earlier compatible values;
7. read/write program classification;
8. `operationKey` and `undoGroup` presence for write programs; and
9. the program digest bound to the operation key.

After admission, the native runtime executes operations sequentially on the AE
main thread. A program containing any write primitive runs inside one real AE
Undo group. Read-only programs do not create Undo history.

The successful response exposes only requested named outputs and one common
evidence envelope. Individual primitives do not define separate public success
envelopes.

## Failure and Replay Semantics

The program is not advertised as atomic.

If validation fails, no operation is dispatched and the response is
`not-started`.

If execution fails, the response records:

- the failing operation position and primitive ID;
- the last completed operation;
- the completed-operation list;
- whether any write began;
- `not-started`, `completed`, or `possibly-side-effecting`;
- audit and reconciliation identifiers; and
- any public named outputs that remain trustworthy.

The runtime does not silently run Undo or claim rollback. A
`possibly-side-effecting` outcome must be reconciled with a new read-only
program and audit evidence before any retry.

Read programs do not require an operation key. Write programs require a stable
operation key. Reusing a completed key with the same program digest returns the
recorded terminal outcome; reusing it with a different digest is rejected.

## Default Execution Skill

Ship a read-only bundled skill:

```text
builtin:skill:ae-execution-guide
```

Server instructions always contain a short routing rule and the skill ID.
The full skill is loaded on demand before a complex AE operation rather than
being injected into every prompt.

The skill contains:

1. stable routing rules for `ae_exec`, `ae_nativeExec`, expression validation,
   frame preview, readback, and Undo;
2. goal-oriented ExtendScript and native-program recipes;
3. write, readback, uncertain-result, and Undo workflows; and
4. a generated native primitive reference.

The primitive reference is generated from `NativePrimitiveEntry`; it is not a
second hand-maintained primitive catalog. Skill examples are parsed and
admitted by automated tests.

The existing ExtendScript cookbook content that remains correct is consolidated
into this guide. The guide must not teach removed operation-specific public
tools.

## Migration Strategy

The public change is a single breaking switch in one PR. Intermediate commits
may build the new path before deleting the old path, but the candidate build
must not expose both surfaces.

Implementation order:

1. add the primitive registry, program schema, validator, request-local frame,
   and native runtime;
2. add `ae_nativeExec` through the existing public MCP -> Core -> native bridge;
3. migrate only entries admitted as `NATIVE_PRIMITIVE`;
4. generate primitive metadata and the default execution skill;
5. prove representative `ae_exec` and `ae_nativeExec` vertical slices;
6. remove operation-specific public tools and the 67-capability public
   registry;
7. delete unreferenced digest/include carriers, variants, encoders, handlers,
   schemas, fixtures, docs, and package-specific acceptance code; and
8. regenerate the public reference and bundled-skill manifest.

Existing AEGP suite adapters, locator resolution, main-thread scheduling,
typed values, Undo, audit, postcondition, replay fencing, and uncertain-write
coordination may be reused. Reuse does not authorize retaining their old public
tool wrappers.

## Testing

### Focused automated tests

- registry IDs are unique and ordered;
- generated descriptor, schema, digest, fixture, and skill projections agree;
- the migration manifest covers every removed tool and all 67 native
  capabilities exactly once;
- every migrated native primitive has an AEGP-only justification;
- unknown primitives, forward references, duplicate names, type mismatches,
  and invalid write envelopes fail before dispatch;
- read-only programs do not create Undo groups;
- write programs require and bind operation keys and program digests;
- request-local handles cannot serialize or cross requests;
- partial execution and possibly-side-effecting outcomes retain trustworthy
  evidence and prohibit blind retry;
- old operation-specific public tools are absent;
- only the approved execution and control-plane surface remains;
- skill recipes parse against the current public schemas and primitive
  registry;
- native compile, Core/bridge integration, and generated-file checks pass.

### One non-candidate HDEV

Use one disposable `ephemeral-validation` fixture and the existing development
smoke infrastructure:

1. use `ae_exec` for one workflow previously represented by a JSX convenience
   tool;
2. use `ae_nativeExec` to resolve a composition and layer and perform a native
   read through request-local references;
3. perform one representative native write program;
4. verify typed before/after, provenance, audit, and postcondition;
5. run an independent read-only program to verify AE state;
6. perform real Undo;
7. run another independent read-only program to verify restoration; and
8. prove one structurally invalid program is rejected before AE dispatch.

This ordinary development package uses focused CI and one non-candidate HDEV.
It does not replay 67 legacy tool cases, create a new runner framework, or run
candidate/release T5/T6.

## Acceptance

The redesign is accepted when:

- the public MCP surface exposes the two EXEC routes plus the approved
  control/observation tools and no operation-specific duplicate tools;
- the migration manifest accounts for all removed public execution tools and
  all 67 old native capability IDs;
- every primitive is defined once and every metadata consumer uses the ordered
  registry projection;
- no per-capability digest/include carrier remains;
- the default execution skill is bundled, trusted, internally consistent, and
  contains no removed tool references;
- focused automated tests and CI pass;
- the single non-candidate HDEV proves the public vertical slices, real AE
  state, audit, postcondition, and real Undo; and
- remaining unsupported AEGP SDK operations are documented as future primitive
  candidates rather than exposed speculatively.

