# Layer Source, Track Matte, and AV State Design

**Date:** 2026-07-28

**Issue:** #190

**Status:** Draft for user review

## Outcome

Give a model explicit public MCP tools to inspect and change three related
layer relationships in current After Effects:

1. replace the existing project-item source of an ordinary AV layer;
2. inspect, set, and clear a modern arbitrary-layer Track Matte relationship;
3. inspect and change a layer's audio and video switches.

The public contract is engine-neutral. A tool returns the same typed state,
provenance, audit, postcondition, and recovery information whether the
underlying operation uses AEGP or a maintained JSX template.

The package uses AEGP for every operation supported by the acquired
`LayerSuite9` and `ItemSuite9`. Only source replacement uses maintained JSX,
because the fixed SDK exposes source reads but no setter while ExtendScript
provides `AVLayer.replaceSource()`.

This is an ordinary development package. It uses focused automated tests,
normal PR CI, and one non-candidate HDEV real-AE smoke. Candidate freeze,
packaged release validation, clean-main reinstallation, and release audit are
not part of this work.

## Current state and corrected Issue assumptions

Issue #190 currently describes Track Matte as an order-sensitive relationship
to the layer immediately above. That is no longer the product behavior in the
target host. After Effects 23 and later allow an arbitrary AV layer in the same
composition to be the Matte source.

The fixed local SDK and current repository show:

- `LayerSuite9` exposes `GetTrackMatteLayer`, `SetTrackMatte`, and
  `RemoveTrackMatte`;
- `LayerSuite9` exposes layer flags including `VIDEO_ACTIVE` and
  `AUDIO_ACTIVE`;
- `ItemSuite9` exposes source-item flags including `HAS_VIDEO` and
  `HAS_AUDIO`;
- the native plug-in already acquires and uses `LayerSuite9` and `ItemSuite9`;
- the existing native layer-details result already carries a source item
  locator and the video switch;
- the existing layer-compositing result carries the Track Matte type but not
  the Matte layer relationship;
- no fixed-SDK function replaces an existing layer's source;
- maintained JSX already has a repository pattern for resolving opaque native
  locators, running a fixed template, reacquiring locators, recording audit,
  and reporting Undo availability.

The Issue body must be aligned to this design before implementation starts. It
must remove the adjacent-layer assumption and must not claim an AEGP source
setter exists.

## Public MCP surface

The package keeps the eight explicit tools proposed by Issue #190. It does not
change the result contract of the existing `ae_getLayerDetails` or
`ae_getLayerCompositing` tools.

| Public tool | Engine | R/W | User-visible result |
|---|---|---:|---|
| `ae_getLayerSource` | AEGP | Read | Current layer and nullable source item |
| `ae_setLayerSource` | Maintained JSX | Write | Before/after source and fresh locators |
| `ae_getLayerTrackMatte` | AEGP | Read | Active relationship, Matte layer, and stored mode |
| `ae_setLayerTrackMatte` | AEGP | Write | Before/after target and mode |
| `ae_clearLayerTrackMatte` | AEGP preferred | Write | Removed relationship with stored mode preserved |
| `ae_getLayerAVState` | AEGP | Read | Source capabilities and layer switches |
| `ae_setLayerAudioEnabled` | AEGP | Write | Before/after audio switch |
| `ae_setLayerVideoEnabled` | AEGP | Write | Before/after video switch |

All public names use the repository's underscore convention. Internal
capability IDs use the existing dotted convention:

- `ae.layer.source.read`
- `ae.layer.source.set`
- `ae.layer.track-matte.read`
- `ae.layer.track-matte.set`
- `ae.layer.track-matte.clear`
- `ae.layer.av-state.read`
- `ae.layer.audio-enabled.set`
- `ae.layer.video-enabled.set`

### `ae_getLayerSource`

Input:

```json
{
  "layerLocator": "<current layer locator>"
}
```

Value:

```json
{
  "layerLocator": "<current layer locator>",
  "sourceItemLocator": "<item or composition locator, or null>",
  "sourceType": "none | footage | composition",
  "sourceName": "<name or null>"
}
```

`sourceItemLocator: null` is a valid read result for a layer without a project
item source. A source name is display metadata, never an identity.

### `ae_setLayerSource`

Input:

```json
{
  "layerLocator": "<current layer locator>",
  "sourceItemLocator": "<current footage or composition locator>",
  "idempotencyKey": "<stable key>"
}
```

The tool calls `replaceSource(newSource, false)`. Automatic expression repair
is deliberately absent from version 1. The tool accepts only an ordinary AV
layer that already has a replaceable source. It rejects:

- text and shape layers;
- null, camera, and light layers;
- adjustment layers;
- a target with no current source;
- folders and non-AV project items;
- a request whose new source is already active.

The successful value contains:

- the fresh composition, layer, and source locators;
- `beforeSourceItemLocator`;
- `afterSourceItemLocator`;
- a compact invariant snapshot showing that layer name, timing, parent,
  switches, and Track Matte relationship were not unexpectedly changed by
  source replacement.

Source dimensions, duration, media capabilities, and source-derived display
name are not invariants because changing the source can legitimately change
them.

### `ae_getLayerTrackMatte`

Value:

```json
{
  "layerLocator": "<current fill layer locator>",
  "active": true,
  "matteLayerLocator": "<current Matte layer locator, or null>",
  "mode": "none | alpha | inverted-alpha | luma | inverted-luma"
}
```

The relationship and stored mode are separate facts. `active` is equivalent to
`matteLayerLocator != null`. A cleared relationship may retain a non-`none`
mode if AE preserves the last selected mode.

### `ae_setLayerTrackMatte`

Input:

```json
{
  "layerLocator": "<current fill layer locator>",
  "matteLayerLocator": "<current Matte layer locator>",
  "mode": "alpha | inverted-alpha | luma | inverted-luma",
  "idempotencyKey": "<stable key>"
}
```

Both layers must be AV-capable layers in the same composition and must be
different objects. Their relative stack order is irrelevant. One operation
sets both the Matte target and mode and creates one Undo step.

### `ae_clearLayerTrackMatte`

Input:

```json
{
  "layerLocator": "<current fill layer locator>",
  "idempotencyKey": "<stable key>"
}
```

The public semantic is "remove the relationship and preserve AE's stored
mode." The preferred implementation is `LayerSuite9.RemoveTrackMatte`. A
narrow real-host development smoke must prove that it preserves the mode. If
the target host does not preserve it through AEGP, this one tool may use the
maintained JSX `removeTrackMatte()` method instead; its public contract does not
change.

Calling clear with no active Track Matte is a pre-dispatch no-op error rather
than a successful write.

### `ae_getLayerAVState`

Value:

```json
{
  "layerLocator": "<current layer locator>",
  "hasAudio": true,
  "audioEnabled": true,
  "hasVideo": true,
  "videoEnabled": true
}
```

`hasAudio` and `hasVideo` describe the current source item. `audioEnabled` and
`videoEnabled` describe the layer switches. A layer without a project-item
source reports both capability fields as `false`.

### Audio and video setters

Each setter accepts one current layer locator, one boolean `enabled`, and one
stable idempotency key. Enabling audio on a source without audio or enabling
video on a source without video fails before dispatch. A requested value equal
to the current value is a pre-dispatch no-op error.

Each successful write changes exactly one flag, preserves every other layer
flag and relationship, returns before/after state, and creates one Undo step.

## Explicit non-goals

- Importing a new file or creating a new project item as part of source
  replacement.
- Automatically fixing expressions after source replacement.
- Batch replacement across multiple layers.
- Source replacement for null, text, shape, camera, light, or adjustment
  layers.
- Recreating a layer to simulate source replacement.
- Cross-composition Track Matte relationships.
- Moving a Matte layer above its fill layer.
- Mask Path editing, Set Matte effects, gradient mattes, or keying.
- A generic arbitrary-JSX capability or a generic native flag setter.
- Windows-specific validation in this development slice.
- Candidate or packaged-release validation.

## Architecture

### Native read and write path

Seven tools use the existing native vertical slice:

```text
public MCP tool
  -> strict Core schema and handler
  -> bridge /native/invoke
  -> native RPC codec
  -> AEGP main-thread dispatcher
  -> LayerSuite9 / ItemSuite9
  -> independent AEGP readback
  -> typed result, provenance, audit, and postcondition
```

The native package adds closed capability contracts and typed codec branches.
It does not add a new SDK suite, resolver framework, or main-thread mechanism.

Every native write:

- has a stable operation ID and idempotency key;
- reads before state;
- enters one named AE Undo group;
- performs one SDK mutation;
- reads after state independently;
- verifies the requested projection and preserved fields;
- returns fresh locator state and audit evidence.

### Maintained-JSX source replacement path

`ae_setLayerSource` reuses the maintained-text design rather than the generic
`ae_exec` public tool:

```text
public ae_setLayerSource
  -> strict Core schema
  -> native locator-to-address resolution
  -> authenticated CEP /exec with graph invalidation
  -> fixed source_replace.jsx template in one Undo group
  -> structured JSX before/after result
  -> fresh native project/layer reads
  -> locator reacquisition and independent postcondition
  -> maintained-JSX provenance and audit
```

Before `/exec`, Core resolves:

- the target composition project-item position and expected name;
- the target layer stack position, expected name, type, and current source;
- the requested source project-item position, expected name, and type.

The fixed JSX template rechecks those bounded attributes immediately before
mutation. Any mismatch returns `STALE_LOCATOR` without calling
`replaceSource()`. Names are guards, not identities. The combination of a
previous exact native locator match, current project/layer position, type,
name, and current source is the existing maintained-JSX addressing boundary;
this package does not invent a raw-ID export or generalized resolver.

The template is ECMAScript 3, returns structured JSON, guards every fallible
lookup, and never throws across a possible edit. It calls
`replaceSource(newSource, false)` only after the complete precondition check.

The CEP `/exec` bridge invalidates the connected native graph before evaluating
the template. Therefore every locator issued before `ae_setLayerSource` is
stale after dispatch, even when the visible project structure appears
unchanged. Core must reacquire and return fresh composition, layer, and source
locators. User-facing instructions must tell callers to rediscover other
project locators before their next native graph call.

### No engine fallback

Engine selection is fixed by the capability:

- source replacement is maintained JSX;
- native reads, Track Matte set, and AV writes are AEGP;
- Track Matte clear is AEGP unless the one bounded host check disproves its
  required preserve-mode semantic.

A runtime failure does not fall back from one engine to another. The only
allowed implementation-route change is the pre-implementation
`RemoveTrackMatte` semantic decision described above.

## Locator and state invariants

- Every input locator must match the current host, session, project, and graph
  generation.
- The Track Matte fill and source locators must resolve in the same
  composition.
- A layer cannot be its own Track Matte.
- Source replacement accepts an item only from the current project namespace.
- A display name never resolves an otherwise unmatched locator.
- All writes return fresh locator state.
- After source replacement, every previously issued native graph locator is
  stale because `/exec` invalidated the namespace.
- After a real Undo, the runner reacquires project, composition, and layer
  locators before verification.
- Reordering a modern Track Matte source must not change the target
  relationship or mode.
- Audio and video setters preserve source, timing, hierarchy, Track Matte,
  blending, and every unrelated flag.

## Errors, idempotency, and recovery

### Pre-dispatch failures

The following errors are non-retryable as submitted and carry
`sideEffect: not-started`:

- `STALE_LOCATOR`
- `LAYER_SOURCE_NOT_REPLACEABLE`
- `SOURCE_ITEM_NOT_AV`
- `TRACK_MATTE_COMPOSITION_MISMATCH`
- `TRACK_MATTE_SELF_REFERENCE`
- `LAYER_HAS_NO_AUDIO`
- `LAYER_HAS_NO_VIDEO`
- `VALUE_UNCHANGED`

Their recovery hint tells the caller to refresh locators or change arguments.
None may create an Undo entry or an audit record claiming an attempted AE
write.

### Possibly side-effecting failures

A transport timeout, disconnect, malformed success payload, or failed
post-write readback after dispatch does not prove that AE remained unchanged.
It returns:

- `POSSIBLY_SIDE_EFFECTING_FAILURE`;
- `retryable: false`;
- `sideEffect: possible`;
- the stable operation ID and idempotency key;
- a recovery action requiring fresh state and audit reconciliation.

The caller must not repeat the write. It first calls the matching read tool
with fresh locators, compares the observed state with the requested
postcondition and recorded before state, and inspects the audit outcome.

### Idempotency outcome

Core records a bounded outcome for every write key:

- accepted but not dispatched;
- dispatched and completed;
- dispatched and indeterminate.

Reusing a completed key returns the recorded result without another AE
mutation. Reusing an indeterminate key returns the same reconciliation
requirement and never redispatches. The maintained JSX audit records dispatch
intent before `/exec` and the typed completion only after native reacquisition
and postcondition verification.

## Provenance, audit, and Undo

Native operations report the existing native-AEGP engine, capability and
contract digests, component/protocol versions, host/session identity,
operation ID, and postcondition digest.

Source replacement reports:

- `implementation.engine: maintained-jsx`;
- a fixed template ID and template digest;
- Core component version and managed source revision;
- host/session/project identity before invalidation;
- the reacquired project generation;
- operation ID and idempotency key;
- before/after source state;
- postcondition digest.

Audit records redact private file paths and never include source media bytes.

A successful write response reports `undo.available: true` and
`undo.verified: false`. It never implies that Undo has run. The HDEV runner
executes one real AE Undo for each of the five public write tools, reacquires
locators, and verifies the exact before state through the public read tool.

## Development fixture

The HDEV fixture is one `ephemeral-validation` project outside the repository
and Adobe scan roots. It is created or reset by a deterministic harness recipe
and contains one main composition with:

- `RELINK_TARGET`, sourced from `SOURCE_COMP_A`;
- an unused `SOURCE_COMP_B` project item for replacement;
- `MATTE_FILL`;
- `MATTE_SOURCE`;
- `MATTE_SPACER`, keeping the Matte source non-adjacent;
- `VIDEO_SWITCH`, backed by a deterministic visual source;
- `AUDIO_SWITCH`, backed by a generated short PCM WAV with no personal data.

Harness choreography may create compositions, solids, and import the generated
WAV through controlled ExtendScript. Every product operation under acceptance
is still invoked through its public MCP tool.

The fixture contains no production media. One HDEV run has one active fixture,
no Save As accumulation, and no retained `.aep` after structured evidence is
extracted. The runner archives it to the recoverable development fixture root
and reports created, archived, active, unclassified, and retained counts.

No preview frame is required. Source, Matte, audio, and video behavior are
state relationships that the dedicated read tools can prove more directly
than a static PNG.

## Automated development checks

Use the lowest focused checks that falsify each edit:

- Core schema, handler, strict-result, no-op, stale-locator, and
  possibly-side-effecting tests.
- Maintained-JSX rendering, escaping, target recheck, before/after projection,
  audit, idempotency replay, and uncertain-dispatch tests.
- Native host-dispatcher and codec tests for all seven AEGP capabilities.
- Capability negotiation, descriptor digest, schema fixture, generated
  capability registry, and dynamic success-result coverage.
- Affected bridge `/exec` graph-invalidation tests without changing the CEP
  endpoint.
- Native compile using the already authorized local SDK input.
- Focused package integration and repository governance checks.
- Normal PR CI.

The development workflow reuses unchanged dependencies and the existing CEP
service. It synchronizes only the changed Core and native components. It does
not bootstrap dependencies, build a portable runtime, package a release, walk
the installed runtime tree for hashes, or reinstall unchanged components.

## Non-candidate HDEV interaction matrix

HDEV is permanently labeled:

```json
{
  "validationProfile": "development",
  "candidateRun": false,
  "candidateEvidence": false
}
```

The runner has a bounded target of at most 40 public MCP calls, excluding
controlled harness-only fixture reset and real Undo commands.

| Scenario | Required public evidence |
|---|---|
| Source read | `ae_getLayerSource` returns `SOURCE_COMP_A` with native provenance |
| Source replace | `ae_setLayerSource` changes A to B through maintained JSX; fresh read returns B |
| Source preservation | Existing public reads show timing, parent, switches, Matte relationship, and one representative keyed transform remain unchanged |
| Source Undo | Real Undo, fresh locator acquisition, public read returns A |
| Matte read | Baseline has no active relationship |
| Matte set | Set non-adjacent `MATTE_SOURCE` as Alpha Matte; public read returns exact locator and mode |
| Matte reorder | Reorder Matte relative to `MATTE_SPACER`; public read still returns the same relationship |
| Matte set Undo | Undo the set after restoring the interaction baseline; public read returns no relationship |
| Matte clear | Set Luma Matte, clear it, verify inactive with stored Luma mode |
| Matte clear Undo | Real Undo restores the exact Matte locator and Luma mode |
| Audio read/write | Read `hasAudio=true`; disable audio; independent read returns false |
| Audio Undo | Real Undo and fresh read restore audio enabled |
| Video read/write | Read `hasVideo=true`; disable video; independent read returns false |
| Video Undo | Real Undo and fresh read restore video enabled |
| Cross-comp Matte negative | Structured mismatch error, zero write, no Undo entry |
| Self-Matte negative | Structured self-reference error, zero write |
| Invalid source target | Null or text target is rejected before `/exec` |
| No-audio/no-video negative | Unsupported enable request is rejected before native dispatch |
| Idempotency | Reusing one completed key does not create a second AE change |
| Uncertain write simulation | Driver refuses retry until state and audit are reconciled |

Reorder is an existing public MCP dependency used only to prove modern
Track Matte relationship stability. Its fixture change is restored before the
next scenario and is not added to the #190 acceptance disposition.

## Development done-when

The development package is ready for review when:

- Issue #190 is aligned with this frozen scope and no longer claims adjacent
  Track Matte semantics or an AEGP source setter;
- all eight public tools have closed schemas, typed responses, capability
  descriptors, and generated registry coverage;
- every public write has a stable idempotency outcome and explicit uncertain
  failure behavior;
- independent diff review finds no unresolved current blocker;
- focused automated checks and normal PR CI pass;
- one current-checkout HDEV run exercises every included public tool;
- source replacement proves maintained-JSX provenance, graph invalidation,
  fresh locators, audit, and public readback;
- Track Matte proves a non-adjacent source remains bound after reorder;
- all five public write tools execute a real Undo followed by fresh public
  readback of the exact before state;
- negative cases prove `sideEffect: not-started`;
- the fixture ledger reports no active or unclassified `.aep`;
- the PR reports HDEV as non-candidate development evidence and makes no
  release-acceptance claim.

## Stop and ask

Stop before implementation or further writes when:

- the Issue cannot be aligned to the approved eight-tool scope;
- source replacement would require arbitrary user-supplied JSX, layer
  recreation, or a generic resolver framework;
- the maintained-JSX address recheck cannot distinguish the requested target
  before mutation;
- neither AEGP nor maintained JSX can implement Track Matte clear while
  preserving the agreed stored-mode semantic;
- the target AE host contradicts arbitrary non-adjacent Matte behavior;
- audio or video capability cannot be distinguished from its enabled switch;
- an installed component or protocol is actually incompatible with the
  current development path;
- a possible write remains unreconciled in AE state and audit;
- the fixture baseline cannot be restored or AE crashes/corrupts the project;
- a proposed fix expands into signing, release packaging, Windows, import
  management, expression rewriting, or unrelated framework work.

Ordinary assertion failures should be collected across independent,
trustworthy HDEV cases before editing source. Stop the sweep immediately only
when a possible write is unreconciled, the fixture cannot be restored, or
subsequent evidence would be untrustworthy.
