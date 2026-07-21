# #157 Keyframe Authoring & Timing package brief

Status: frozen for implementation
Parent: #61
Base: `1ae298869f2d002203309070b151dbc09eaf489d`

## User outcome

Models can create and edit ordinary After Effects property keyframes through the
public MCP surface. The package fills the gap between the existing native
property/keyframe reads and the non-keyframed-only property setter.

## Public surface

| Public MCP tool | Native capability | Effect |
| --- | --- | --- |
| `ae_getLayerPropertyKeyframeDetails` | `ae.layer.property.keyframe.details.read` | read |
| `ae_addLayerPropertyKeyframe` | `ae.layer.property.keyframe.add` | write |
| `ae_setLayerPropertyKeyframeValue` | `ae.layer.property.keyframe.value.set` | write |
| `ae_setLayerPropertyKeyframeInterpolation` | `ae.layer.property.keyframe.interpolation.set` | write |
| `ae_setLayerPropertyKeyframeTemporalEase` | `ae.layer.property.keyframe.temporal-ease.set` | write |
| `ae_setLayerPropertyKeyframeBehavior` | `ae.layer.property.keyframe.behavior.set` | write |
| `ae_deleteLayerPropertyKeyframe` | `ae.layer.property.keyframe.delete` | write |

Every keyframe target is a property locator plus exact composition time
`{value, scale}`. Public writes also require the layer locator that produced the
property locator and a stable idempotency key. Public keyframe indices are not
accepted because insert/delete operations can change them.

Typed values reuse the existing scalar/vector/color property value union.
Interpolation is a closed `linear | bezier | hold` enum. Temporal ease selects
one value dimension and supplies closed incoming/outgoing `{speed, influence}`
objects. Behavior changes exactly one closed flag per call:

- `temporal-continuous`
- `temporal-auto-bezier`
- `spatial-continuous`
- `spatial-auto-bezier`
- `roving`

`ae_getLayerPropertyKeyframeDetails` returns exact time, typed value,
incoming/outgoing interpolation, per-dimension temporal ease, and all five
behavior booleans. A missing exact-time keyframe is a structured precondition
failure, never a nearest-keyframe match.

Writes return the complete before/after detail state. Add has `before=null`;
delete has `after=null`. The response, independent readback, audit and
postcondition must agree. A possibly side-effecting failure must be reconciled
against AE state and audit before any retry.

## Shared native path

- Existing project/layer/property locator registry and generation binding
- `AEGP_LayerSuite9`, `AEGP_DynamicStreamSuite4`, `AEGP_StreamSuite6`
- Existing `AEGP_KeyframeSuite5`, extended from read to undoable write calls
- Existing `AEGP_UtilitySuite6` Undo groups, main-thread dispatcher, typed RPC,
  audit, deadlines and idempotency

The package newly exercises KeyframeSuite5 mutation methods and exact-time
re-resolution, but it does not introduce a new suite, locator lifecycle or
main-thread mechanism. Keyframe changes do not alter project graph topology,
so the property locator must remain valid across a write and its real Undo; T2
and the non-candidate preflight prove that assumption before candidate freeze.

## Fixture and interaction matrix

One `ephemeral-validation` fixture contains one composition and one layer with:

- Opacity for scalar value, interpolation, temporal ease and temporal behavior
- Position only for spatial-behavior validation

Each write runs once on its primary path and its typed response must contain
native before/after readback bound to the audit/postcondition. It then receives
exactly one real AE Undo followed by an independent public details read. This
avoids duplicating an already verified post-write read merely to spend a
hardware call. The behavior tool additionally proves `spatial-continuous` on a
Position keyframe with its own real Undo/readback; the package Add tool seeds
that spatial keyframe after its primary add/Undo path. Add/delete interact on
the same deterministic Opacity keyframe. Invalid
dimensions, invalid flag/stream combinations, duplicate/missing times,
idempotent replay and load/error combinations belong to T2 rather than hardware
acceptance.

## Acceptance and efficiency gates

The executable path is:

```text
public MCP -> Core -> native RPC -> AEGP main thread -> AE state
           -> typed result -> audit -> independent postcondition
```

- Candidate preflight produces no candidate evidence. It proves deployable
  exact identity, formal AE path, GUI/pairing, fixture reset/archive and logs.
- Planned T4 count is zero: suite acquisition, locator lifecycle and the
  main-thread dispatcher are already proven. If T2 exposes a genuinely new
  host-only primitive that cannot be falsified below hardware, one narrow T4
  may be promoted explicitly; preflight calls may not be relabelled as T4 to
  evade the call budget.
- T5 and T6 use exactly 28 total public calls and abort before call 31. Every
  support, negative, package and restart call counts.
- At most two concentrated review rounds.
- Normally one candidate build and one full CI run; one replacement is allowed
  only for a reproduced acceptance blocker.
- The tracked shared runner owns identity, call accounting, evidence and AEP
  lifecycle. This package contributes only declarative cases and fixture hooks.

The fixture lifecycle is `ephemeral-validation`, with one active fixture,
`saveAsCopies=0`, deterministic reset/rebuild and structured evidence. After
evidence extraction the AEP moves to short recovery and is removed after T6 and
Issue closure unless a non-rebuildable defect explicitly references it.

## Non-goals

Keyframe time moves, spatial tangents, expressions, bulk curves, full Graph
Editor semantics, transform wrappers, layer switches, JSX routing/fallback,
Windows, signing/notarization, installer hardening, Provider and Tool Library.
