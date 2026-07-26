# Text, Shape, and Marker Authoring capability-package brief

Status: frozen for implementation

Task: TASK-025

Amendment: TASK-026 (in-place shape fill/stroke styling only)

Base: `4fbc7b426cd6556c9849853ceb8fdeff368e7534`

Delivery unit: one branch, one PR, one concentrated review, one frozen
candidate, one T5 candidate session, and one T6 clean-`main` session.

This document freezes the public surface and acceptance boundary. Parallel
implementation tracks may not rename a tool, change a field, relax a closed
enum, change an execution engine, or substitute a different response shape
without an explicit package re-freeze.

## User outcome and package boundary

Models can create and style ordinary text, create editable filled/stroked
Bezier shape groups, restyle those groups in place, and author layer or
composition markers through typed public MCP tools. Callers supply data, never
source code.

The same PR also repairs the CEP stage/install contract that blocked the prior
clean-`main` run: a production platform stage must contain the tracked
root-level `plugin/.debug` bytes required by the reviewed macOS development
installer. The current contradiction is explicit:

- `scripts/install-plugin-dev-macos.sh:24-31,74-78` requires `.debug`;
- `scripts/package/stage-platform-bundle.mjs:30-36` removes it;
- `scripts/package/verify-platform-bundle.mjs:307-316` rejects it; and
- `scripts/package/test/stage-platform-bundle.test.mjs:20-35` asserts it is
  absent.

Implementation must change those production-stage assertions together. The
only newly admitted development contract file is the root `.debug`; panel
source, tests, caches, and development dependencies remain excluded. Staging
must copy the tracked `plugin/.debug` byte-for-byte, include it in the bundle
manifest, and prove that the staged plug-in tree passes the unchanged dev
installer's required-file check without a manual patch.

The package freezes **17 public tools**:

| Family | Count | Tools | Execution |
| --- | ---: | --- | --- |
| Text | 6 | create, read, content, character style, paragraph style, fonts | typed template-generated JSX (`maintained-jsx`) |
| Shape | 7 | create layer, list groups, create group, set path, set fill style, set stroke style, reorder | native RPC / AEGP |
| Marker | 4 | list, create, set, delete | native RPC / AEGP |

The CEP `.debug` repair adds no public tool.

## Grounded conventions and common schema vocabulary

### Registry conventions

The canonical registry name remains dotted while the model-visible MCP name
replaces dots with underscores. This is the current `expose_tool_name`
contract (`packages/core/ae_mcp/server.py:290-309`). Pydantic emits the exact
advertised `inputSchema`, and the server validates that same schema before
calling a handler (`packages/core/ae_mcp/server.py:1148-1187`). Therefore each
entry below records both names and uses request field names exactly as the
model sees them.

All request objects are closed (`additionalProperties: false`), following
`_StrictModel` (`packages/core/ae_mcp/schemas.py:35-37`). All new writes require
an `idempotency_key`: 16-64 characters matching
`^[A-Za-z0-9][A-Za-z0-9._:-]*$`, following the existing write convention at
`packages/core/ae_mcp/schemas.py:671-714`. A key represents one business
intent. Rebinding it to different arguments or using it for another intent is
an error.

Model-visible requests use `snake_case`. Public response values and evidence
use the repository's existing `camelCase` wire shape. Reads and writes return
JSON, not a bare string.

### Closed common types

The following definitions are normative wherever referenced.

#### `CompositionLocator`, `LayerLocator`

Copy the complete locator unchanged from a fresh native read:

```text
{
  kind: "composition" | "layer",       // fixed by the referenced type
  hostInstanceId: UUID,
  sessionId: UUID,
  projectId: UUID,
  generation: integer [1, 9007199254740991],
  objectId: UUID
}
```

This is the current locator contract
(`packages/core/ae_mcp/schemas.py:95-127`). Same-context invariants compare
host, session, project, and generation, as existing property writes do
(`packages/core/ae_mcp/schemas.py:1136-1185`).

Text uses these same public locator types even though its implementation is
maintained JSX. The Core handler resolves the opaque locator through typed
native project/layer reads, passes only private project-item/layer coordinates
to the closed template, and verifies the expected composition name, layer name,
and text-layer type before reading or writing. The private coordinates are
never part of a request or response schema. A mismatch is `STALE_LOCATOR`,
`sideEffect: not-started`. After a text write, Core reacquires and returns the
fresh native layer locator.

#### `ExactTimeInput` and `ExactTime`

```text
ExactTimeInput = {
  value: int32,
  scale: uint32 [1, 4294967295]
}

ExactTime = {
  value: int32,
  scale: uint32 [1, 4294967295],
  secondsRational: canonical reduced string
}
```

This reuses the exact integer `A_Time` convention at
`packages/core/ae_mcp/schemas.py:591-609`; marker identity never uses a float
time or a shifting keyframe index.

#### `Color8`

```text
{
  red: integer [0,255],
  green: integer [0,255],
  blue: integer [0,255],
  alpha: integer [0,255]
}
```

This reuses `AeMediaColor` (`packages/core/ae_mcp/schemas.py:2128-2136`).
Text fill and stroke ignore `alpha` when AE exposes only RGB but preserve it as
255 in readback; shape fill and stroke use all four fields in the public
contract.

#### `BezierPath`

```text
BezierPath = {
  closed: boolean,
  vertices: array[2..128] of {
    position: [DecimalString, DecimalString],
    in_tangent: [DecimalString, DecimalString],
    out_tangent: [DecimalString, DecimalString]
  }
}
```

`DecimalString` is 1-32 characters, matches
`^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$`, and must represent a
finite, canonical binary-convertible value. A closed path requires at least
three vertices. Tangents are relative to the vertex position. This is exactly
the public codec already used by `ae_setLayerMaskPath`
(`packages/core/ae_mcp/schemas.py:2187-2230`), not a second path
representation. Native readback compares numeric decimal values, as the
existing adapter does (`packages/core/ae_mcp/backends/native_media.py:
641-664`).

#### `ShapeGroupRefInput` and `ShapeGroupRef`

```text
ShapeGroupRefInput = {
  layer_locator: LayerLocator,
  group_index: integer [1, 9007199254740991],
  stream_id: int32
}

ShapeGroupRef = {
  layerLocator: LayerLocator,
  groupIndex: integer [1, 9007199254740991],
  streamId: int32
}
```

`streamId` is the `AEGP_GetUniqueStreamID` value for the top-level
vector group. The pair `groupIndex` + `streamId` follows the existing
index-plus-stable-identity pattern used for masks. Writes reject a ref whose
current index no longer has that stream id. Reorder returns a fresh ref with
the new index.

This same group ref is the complete public address for both style setters.
`ae_listShapeGroups` returns it in every `ShapeGroup`; the setter name selects
the one fill or stroke child, and native code resolves that child by its closed
implementation match name only after validating the group index and stable
stream id. No caller supplies a child index, match name, property path, or new
style locator. A missing or duplicate fill/stroke child is
`UNREPRESENTABLE_SHAPE_GROUP`, `sideEffect: not-started`, rather than a best
guess.

#### `MarkerTargetInput`, `MarkerTarget`, `MarkerRefInput`, and `MarkerRef`

```text
MarkerTargetInput =
  { kind: "layer", layer_locator: LayerLocator }
  | { kind: "composition", composition_locator: CompositionLocator }

MarkerTarget =
  { kind: "layer", layerLocator: LayerLocator }
  | { kind: "composition", compositionLocator: CompositionLocator }

MarkerRefInput = {
  target: MarkerTargetInput,
  time: ExactTimeInput
}

MarkerRef = {
  target: MarkerTarget,
  time: ExactTime
}
```

The target plus exact time is marker identity. AE exposes markers as keyframes
on one marker stream but MarkerSuite3 exposes no stable marker object id.
Consequently array/keyframe indices are response metadata only and are never
accepted as write targets. `ae_setMarker` does not move a marker; its identity
must remain unchanged after the edit.

#### `CuePointParameter`

```text
{
  key: string, 1..255 Unicode scalar values,
  value: string, 0..1024 Unicode scalar values
}
```

Marker parameter arrays contain at most 64 entries and keys must be unique.
Order is preserved and returned exactly.

#### `MarkerState`

```text
{
  ref: MarkerRef,
  markerIndex: integer [1, 9007199254740991],  // read-only metadata
  duration: ExactTime,                         // value must be >= 0
  comment: string, 0..1024 Unicode scalars,
  chapter: string, 0..128 Unicode scalars,
  url: string, 0..1024 Unicode scalars,
  frameTarget: string, 0..128 Unicode scalars,
  cuePointName: string, 0..64 Unicode scalars,
  cuePointParameters: CuePointParameter[0..64],
  navigation: boolean,
  protectedRegion: boolean,
  labelId: integer [0,16]
}
```

The bounds are package/API bounds. Header facts are narrower claims:
MarkerSuite3 defines the five string kinds
(`AE_GeneralPlug.h:1973-1984`), two flags (`:1986-1991`), parameter methods
(`:2027-2054`), duration (`:2056-2063`), and label (`:2065-2071`). T1/T2 must
enforce the package bounds even if AE accepts more.

### Response envelopes

All envelopes are closed.

#### Maintained-JSX read

```text
{
  ok: true,
  value: T,
  implementation: {
    engine: "maintained-jsx",
    contractId: string,
    contractVersion: 1,
    contractDigest: sha256,
    templateId: string,
    templateDigest: sha256,
    mutability: "read-only",
    callerCodeAccepted: false
  },
  provenance: {
    engine: "maintained-jsx",
    sourceCommit: 40-lowercase-hex,
    coreVersion: string,
    templateId: string,
    templateDigest: sha256,
    callerCodeAccepted: false
  },
  audit: {
    requestId: string,
    contractId: string,
    contractDigest: sha256,
    effect: "none",
    requestDigest: sha256,
    postconditionAlgorithm: "sha256-rfc8785-jcs-v1",
    postconditionDigest: sha256,
    startedAtUnixMs: positive integer,
    completedAtUnixMs: positive integer
  },
  evidence: {
    postcondition: {
      verified: true,
      kind: string,
      algorithm: "sha256-rfc8785-jcs-v1",
      digest: sha256
    }
  }
}
```

#### Maintained-JSX write

The read envelope changes as follows:

```text
{
  ok: true,
  replayed: boolean,
  value: T,
  implementation: {
    engine: "maintained-jsx",
    contractId: string,
    contractVersion: 1,
    contractDigest: sha256,
    templateId: string,
    templateDigest: sha256,
    mutability: "mutating",
    idempotency: "idempotency-key",
    undo: "ae-undo-group",
    callerCodeAccepted: false
  },
  provenance: { ...the maintained-JSX provenance above... },
  audit: {
    ...read audit fields...,
    idempotencyKey: string,
    replayed: boolean,
    effect: "committed",
    undoAvailable: true,
    undoVerified: false
  },
  evidence: {
    postcondition: { verified: true, kind: string,
                     algorithm: "sha256-rfc8785-jcs-v1", digest: sha256 },
    undo: { available: true, verified: false, groupId: string }
  }
}
```

The tool response distinguishes Undo availability from execution. T5/T6
records the subsequent real AE Undo and independent public readback in the
runner's per-tool evidence; the original response is not rewritten to pretend
that later action already happened.

These tools have **no native provenance**. They must not populate
`pluginVersion`, `compiledSdkVersion`, native `hostInstanceId`,
`capabilitiesDigest`, or an `engine: native-aegp` postcondition. Acceptance
binds them to Core source, the exact maintained template digest, the typed
request digest, the structured before/after value, and the persisted audit
record.

The engine distinction is already part of the repository vocabulary:
`maintained-jsx` and `ephemeral-jsx` are separate from `native-aegp`
(`packages/core/ae_mcp/backends/base.py:8-13,70-78`). Rendering is internal and
JSON-safe, following the maintained template mechanism at
`packages/core/ae_mcp/handlers/typed.py:36-68`. No request below has a `code`,
`script`, `expression`, or template field.

#### Native read/write

Native tools retain the existing closed public envelopes:

- read: `ok`, `value`, `implementation`, `provenance`, `audit`, `evidence`;
- write: those fields plus `replayed`;
- `implementation.engine` and `provenance.engine` are `native-aegp`;
- the response and audit carry the negotiated capability/contract identity,
  native host/session identity, request digest, postcondition digest, and
  timestamps; and
- writes additionally carry `idempotencyKey`, `undoAvailable`, and
  `undoVerified`.

The exact current shape is built in
`packages/core/ae_mcp/handlers/native.py:137-187,205-261`. Native postcondition
and Undo evidence are closed at
`packages/core/ae_mcp/backends/native.py:268-302`. As with JSX, native write
responses report the host Undo boundary as available but not externally
executed; T5/T6 verifies the real Undo separately.

Normatively, `NativeRead<T>` is:

```text
{
  ok: true,
  value: T,
  implementation: {
    engine: "native-aegp",
    capabilityId: string,
    capabilityVersion: 1,
    contractDigest: sha256,
    risk: "read",
    mutability: "read-only",
    idempotency: "idempotent",
    undo: "not-applicable"
  },
  provenance: {
    engine: "native-aegp",
    selectedWireVersion: 1,
    pluginVersion: string,
    compiledSdkVersion: string,
    sourceCommit: 40-lowercase-hex,
    hostInstanceId: UUID,
    sessionId: UUID,
    sessionGeneration: positive integer,
    capabilitiesDigest: sha256
  },
  audit: {
    requestId: string,
    capabilityId: string,
    capabilityVersion: 1,
    contractDigest: sha256,
    effect: "none",
    requestDigest: sha256,
    postconditionAlgorithm: "sha256-rfc8785-jcs-v1",
    postconditionDigest: sha256,
    startedAtUnixMs: positive integer,
    completedAtUnixMs: positive integer
  },
  evidence: {
    engine: "native-aegp",
    hostInstanceId: UUID,
    sessionId: UUID,
    requestId: string,
    capabilityId: string,
    capabilityVersion: 1,
    startedAtUnixMs: positive integer,
    completedAtUnixMs: positive integer,
    effect: "none",
    requestDigest: sha256,
    postcondition: {
      verified: true,
      kind: string,
      algorithm: "sha256-rfc8785-jcs-v1",
      digest: sha256
    }
  }
}
```

`NativeWrite<T>` changes `risk` to `"write"`, `mutability` to
`"mutating"`, `idempotency` to `"idempotency-key"`, `undo` to
`"ae-undo-group"`, and `effect` to `"committed"`; adds top-level
`replayed: boolean`; adds `idempotencyKey`, `replayed`, `undoAvailable: true`,
and `undoVerified: false` to `audit`; and adds
`undo: {available:true, verified:false, groupId:string}` to `evidence`.

All text, shape, and marker failures use one closed public error envelope:

```text
{
  ok: false,
  error: {
    code: string,
    message: string[1..512],
    retryable: boolean,
    sideEffect: "not-started" | "may-have-occurred",
    recovery: {
      action: string,
      hint: string[1..256],
      retryAfterMs: integer[1..30000] | omitted
    },
    details: object | omitted
  }
}
```

Validation, stale-target, font, unrepresentable-state, and no-op failures are
`not-started`. Only a failure after a write may be
`may-have-occurred`. This preserves the structured native policy shape at
`packages/core/ae_mcp/backends/native.py:349-423,457-540` for both engines.

## Frozen public text surface: 6 tools

Text routing is a decided product boundary. AEGP TextDocumentSuite1 only
supports text get/set and is frozen in AE 6.0
(`AE_GeneralPlug.h:1951-1966`); it cannot implement the frozen style schemas.
All six tools therefore use typed, repository-maintained JSX templates. Text
creation also stays JSX so the family has one provenance model and the
hardware run cannot discover a native/JSX split inside the family.

Templates create an empty text layer, read the existing TextDocument, mutate
that object, and set it back. This is the repository's documented safe
sequence (`packages/core/ae_mcp/instructions.py:152-161`). The caller cannot
alter the template.

### Text schema definitions

```text
FontRecord = {
  postScriptName: string, 1..255 Unicode scalars,
  family: string, 1..255 Unicode scalars,
  style: string, 0..255 Unicode scalars
}

FontSelection = {
  preferred_postscript_name: string, 1..255 Unicode scalars,
  fallback_postscript_names: array[0..4] of unique 1..255 scalar strings,
  on_missing: "error" | "use-first-installed-fallback"
}

TextCharacterStyle = {
  fontPostScriptName: string, 1..255 Unicode scalars,
  fontSizePixels: DecimalString, numeric range (0,1296],
  fillColor: Color8,
  strokeColor: Color8,
  strokeWidthPixels: DecimalString, numeric range [0,1000],
  strokeOverFill: boolean,
  tracking: integer [-10000,10000],
  autoLeading: boolean,
  leadingPixels: DecimalString | null, numeric range (0,12960] when non-null,
  fauxBold: boolean,
  fauxItalic: boolean
}

TextParagraphStyle = {
  justification:
    "left" | "right" | "center" |
    "full-last-left" | "full-last-right" |
    "full-last-center" | "full-last-full",
  firstLineIndentPixels: DecimalString,
  startIndentPixels: DecimalString,
  endIndentPixels: DecimalString,
  spaceBeforePixels: DecimalString,
  spaceAfterPixels: DecimalString
}

TextDocumentSnapshot = {
  layerLocator: LayerLocator,
  text: string, 0..32767 Unicode scalar values,
  textKind: "point" | "box",
  boxSize: null | {
    widthPixels: DecimalString,
    heightPixels: DecimalString
  },
  characterStyle: TextCharacterStyle,
  paragraphStyle: TextParagraphStyle,
  resolvedFont: {
    requestedPostScriptName: string | null,
    selectedPostScriptName: string,
    usedFallback: boolean
  }
}
```

Every style response is a complete snapshot, even though style write requests
are non-empty patches. If AE reports mixed per-character or per-paragraph
values that cannot be represented by one value, the read fails
`UNREPRESENTABLE_TEXT_STYLE` with the differing field; it must not return the
first character's style as if it represented the whole document.

### `ae_listInstalledFonts`

Canonical registry name: `ae.listInstalledFonts`

Execution: maintained JSX read, template id
`aemcp.text.fonts.list.v1`.

Request:

```text
{
  offset: integer [0,9007199254740991] = 0,
  limit: integer [1,100] = 50
}
```

Response `value`:

```text
{
  total: non-negative integer,
  offset: non-negative integer,
  limit: integer [1,100],
  returned: integer [0,100],
  hasMore: boolean,
  nextOffset: non-negative integer | null,
  fonts: FontRecord[0..100]
}
```

`returned == fonts.length`; pagination is deterministic by
`(postScriptName,family,style)`. Duplicate PostScript names are rejected as a
contract mismatch.

### `ae_createTextLayer`

Canonical registry name: `ae.createTextLayer`

Execution: maintained JSX write, template id
`aemcp.text.layer.create.v1`.

Request:

```text
{
  composition_locator: CompositionLocator,
  name: string, 1..255 Unicode scalar values,
  text: string, 0..32767 Unicode scalar values,
  text_kind: "point" | "box" = "point",
  box_size: null | {
    width_pixels: DecimalString, numeric range (0,30000],
    height_pixels: DecimalString, numeric range (0,30000]
  } = null,
  idempotency_key: IdempotencyKey
}
```

Invariant: `box_size` is required exactly when `text_kind == "box"`.
Horizontal text is the only orientation in this package.

Response `value`:

```text
{
  changed: true,
  compositionLocator: CompositionLocator,
  layerCountBefore: non-negative integer,
  layerCountAfter: layerCountBefore + 1,
  before: null,
  after: TextDocumentSnapshot
}
```

Core resolves `composition_locator` internally. The template uses
`comp.layers.addText("")` or
`comp.layers.addBoxText([width,height])`, assigns the exact name, reads the
new TextDocument, writes `text`, calls `setValue`, and returns a second
independent readback from the layer. It never constructs a fresh styled
TextDocument and assumes the fields stuck. Core then reacquires the created
text layer through native project/layer reads and returns its fresh
`compositionLocator` and `after.layerLocator`.

### `ae_getTextDocument`

Canonical registry name: `ae.getTextDocument`

Execution: maintained JSX read, template id
`aemcp.text.document.read.v1`.

Request:

```text
{ layer_locator: LayerLocator }
```

Response `value`: `TextDocumentSnapshot`.

The template must read every frozen field. A getter that throws or is absent
is a contract failure naming that field, never an omitted/null guess except
where this schema explicitly permits null.

### `ae_setTextContent`

Canonical registry name: `ae.setTextContent`

Execution: maintained JSX write, template id
`aemcp.text.content.set.v1`.

Request:

```text
{
  layer_locator: LayerLocator,
  text: string, 0..32767 Unicode scalar values,
  idempotency_key: IdempotencyKey
}
```

Response `value`:

```text
{
  changed: true,
  layerLocator: LayerLocator,
  before: TextDocumentSnapshot,
  after: TextDocumentSnapshot
}
```

Only `text` may differ. Requesting the current text is `INVALID_ARGUMENT`,
`sideEffect: not-started`.

### `ae_setTextCharacterStyle`

Canonical registry name: `ae.setTextCharacterStyle`

Execution: maintained JSX write, template id
`aemcp.text.character-style.set.v1`.

Request:

```text
{
  layer_locator: LayerLocator,
  style: {
    font: FontSelection | null,
    font_size_pixels: DecimalString | null,       // (0,1296]
    fill_color: Color8 | null,
    stroke_color: Color8 | null,
    stroke_width_pixels: DecimalString | null,    // [0,1000]
    stroke_over_fill: boolean | null,
    tracking: integer [-10000,10000] | null,
    auto_leading: boolean | null,
    leading_pixels: DecimalString | null,         // (0,12960]
    faux_bold: boolean | null,
    faux_italic: boolean | null
  },
  idempotency_key: IdempotencyKey
}
```

`style` is a non-empty patch. `leading_pixels` is forbidden when
`auto_leading == true`; setting `auto_leading == false` requires
`leading_pixels` in the same request. JSON null means "field not requested",
not "clear", except that the containing `font` may be omitted/null.

Font resolution occurs before mutation:

1. match `preferred_postscript_name` exactly against the same normalized
   inventory returned by `ae_listInstalledFonts`;
2. if absent and `on_missing == "error"`, fail `FONT_NOT_INSTALLED`,
   `sideEffect: not-started`, with the requested name;
3. if fallback is allowed, select the first listed fallback that is installed;
4. if none is installed, fail `FONT_FALLBACK_EXHAUSTED`,
   `sideEffect: not-started`, returning the ordered attempted names.

Response `value` has the same before/after shape as
`ae_setTextContent`. Only requested character-style fields and
`resolvedFont` may differ.

### `ae_setTextParagraphStyle`

Canonical registry name: `ae.setTextParagraphStyle`

Execution: maintained JSX write, template id
`aemcp.text.paragraph-style.set.v1`.

Request:

```text
{
  layer_locator: LayerLocator,
  style: {
    justification:
      "left" | "right" | "center" |
      "full-last-left" | "full-last-right" |
      "full-last-center" | "full-last-full" | null,
    first_line_indent_pixels: DecimalString | null,
    start_indent_pixels: DecimalString | null,
    end_indent_pixels: DecimalString | null,
    space_before_pixels: DecimalString | null,
    space_after_pixels: DecimalString | null
  },
  idempotency_key: IdempotencyKey
}
```

`style` is a non-empty patch. All decimal paragraph values must be finite and
in `[-30000,30000]`.

Response `value` has the same before/after shape as
`ae_setTextContent`. Only requested paragraph fields may differ.

## Frozen public shape surface: 7 tools

Shape tools are native-only. They use `AEGP_CreateVectorLayerInComp`
(`AE_GeneralPlug.h:841-843`) and the already-proven Comp, Layer, Utility,
Stream, DynamicStream, Keyframe, Memory, Project, Item, and MaskOutline
suites.

DynamicStreamSuite4 supplies traversal, add, name, stable stream id, and
reorder primitives (`AE_GeneralPlug.h:1640-1735`). MaskOutlineSuite3 supplies
open/closed state plus vertex create/read/write with relative tangents
(`:2382-2419`). The current plug-in already leases Stream/DynamicStream in the
native path (`native/ae-plugin/src/aegp/plugin_entry.cpp:7244-7259`) and
leases MaskOutlineSuite3 together with them for path work (`:7632-7645`).

The in-place style path stays inside this proven acquisition set. The current
plug-in already:

- resolves a layer root and a closed match-name child
  (`native/ae-plugin/src/aegp/plugin_entry.cpp:4490-4508`), then traverses
  indexed children, reads their dynamic flags and match names, and verifies
  their unique stream ids with DynamicStreamSuite4 and StreamSuite6
  (`:4905-4959`);
- samples `OneD` and `COLOR` leaf streams (`:4990-5017`), with the concrete
  scalar/color conversions at `:1321-1398`;
- leases KeyframeSuite5 with StreamSuite6, DynamicStreamSuite4, and
  UtilitySuite6 for an Undo-producing static primitive write
  (`:5830-5849`) and performs before-read, mutation, and independent
  after-readback at `:6097-6169`;
- changes an existing dynamic child's active-eyeball flag through
  `AEGP_SetDynamicStreamFlag` (`:7472-7518`); and
- reorders an existing dynamic child through `AEGP_ReorderStream`
  (`:7964-7975`).

Those operations reach the fill/stroke groups and their color, opacity, and
width leaves after resolving the already-addressable vector group. They cover
fill/stroke enablement, primitive style values, and stroke-over-fill child
ordering without another suite. The frozen create operation already writes
the fill streams after adding them; this amendment adds the stroke child and
freezes both creation and in-place restyling to use the same closed child
resolution and primitive stream-write/readback path. The only difference for
restyling is that it starts from an existing `ShapeGroupRefInput` instead of a
newly added group. If implementation discovers that any frozen field cannot
use this acquired set, it must stop and re-freeze; it may not acquire another
suite.

The top-level contents match names and child match names are implementation
constants, not caller input. `scripts/demo_ball_roll.py:41-50,56-62` is the
current repository example for `ADBE Root Vectors Group`,
`ADBE Vector Group`, `ADBE Vectors Group`, vector shape, and fill
construction. T1/T2 must prove the exact closed match-name sequence against
the native codec; no public request accepts a match name.

### Shape schema definitions

```text
ShapeFill = {
  enabled: boolean,
  color: Color8,
  opacityPercent: DecimalString, numeric range [0,100]
}

ShapeStroke = {
  enabled: boolean,
  color: Color8,
  opacityPercent: DecimalString, numeric range [0,100],
  widthPixels: DecimalString, numeric range [0,1000],
  strokeOverFill: boolean
}

ShapeGroup = {
  ref: ShapeGroupRef,
  name: string, 1..255 Unicode scalar values,
  path: BezierPath,
  fill: ShapeFill,
  stroke: ShapeStroke
}
```

Every package-authored group contains exactly one fill child and one stroke
child even when either is disabled. `enabled` is the active-eyeball state of
that child; disabling does not remove it or discard its other values.
`strokeOverFill` is the canonical relative child order: `true` means the
stroke child is above the fill child in the AE Contents list (the lower
zero-based stream index), and `false` means it is below. Top-level group order
is independent.

### `ae_createShapeLayer`

Canonical registry name: `ae.createShapeLayer`

Native capability: `ae.shape.layer.create@1`.

Request:

```text
{
  composition_locator: CompositionLocator,
  name: string, 1..255 Unicode scalar values,
  idempotency_key: IdempotencyKey
}
```

Response `value`:

```text
{
  changed: true,
  compositionLocator: CompositionLocator,  // fresh post-mutation generation
  layerLocator: LayerLocator,              // fresh
  name: string,
  stackIndex: positive integer,
  layerCountBefore: non-negative integer,
  layerCountAfter: layerCountBefore + 1
}
```

Path: CompSuite12 `AEGP_CreateVectorLayerInComp`, LayerSuite9 name and
identity readback, UtilitySuite6 one Undo group, graph invalidation, and fresh
locators.

### `ae_listShapeGroups`

Canonical registry name: `ae.listShapeGroups`

Native capability: `ae.shape.groups.list@1`.

Request:

```text
{
  layer_locator: LayerLocator,
  offset: integer [0,9007199254740991] = 0,
  limit: integer [1,50] = 25
}
```

Response `value`:

```text
{
  layerLocator: LayerLocator,
  total: non-negative integer,
  offset: non-negative integer,
  limit: integer [1,50],
  returned: integer [0,50],
  hasMore: boolean,
  nextOffset: non-negative integer | null,
  groups: ShapeGroup[0..50]
}
```

Only package-authored groups containing exactly one freeform Bezier path, one
fill, and one stroke are representable. The complete `ShapeGroup`, including
its public `ref` and both style snapshots, is the independent readback for
every shape write. Encountering another top-level shape construct is not
silently flattened; return `UNREPRESENTABLE_SHAPE_GROUP` with its one-based
index and observed child match names.

### `ae_createShapeGroup`

Canonical registry name: `ae.createShapeGroup`

Native capability: `ae.shape.group.create@1`.

Request:

```text
{
  layer_locator: LayerLocator,
  name: string, 1..255 Unicode scalar values,
  path: BezierPath,
  fill: {
    enabled: boolean,
    color: Color8,
    opacity_percent: DecimalString, numeric range [0,100] = "100"
  },
  stroke: {
    enabled: boolean,
    color: Color8,
    opacity_percent: DecimalString, numeric range [0,100] = "100",
    width_pixels: DecimalString, numeric range [0,1000],
    stroke_over_fill: boolean
  },
  idempotency_key: IdempotencyKey
}
```

Response `value`:

```text
{
  changed: true,
  layerLocator: LayerLocator,       // fresh if graph generation changes
  groupCountBefore: non-negative integer,
  groupCountAfter: groupCountBefore + 1,
  group: ShapeGroup
}
```

Within one Undo group, perform two passes:

1. call `AEGP_CanAddStream` and `AEGP_AddStream` to add the vector group,
   freeform path child, fill child, and stroke child, and set the group name;
   then dispose every acquired stream ref;
2. reacquire all children by closed match name, build the path through the
   shared `BezierPath`/MaskOutline codec, set the complete fill and stroke
   values/active-eyeball states/relative order through the same stream paths
   used by the two in-place setters, and independently enumerate/read back the
   complete `ShapeGroup`.

This two-pass rule follows the repository's known add-property invalidation
guard (`packages/core/ae_mcp/instructions.py:159-161`).

### `ae_setShapePath`

Canonical registry name: `ae.setShapePath`

Native capability: `ae.shape.path.set@1`.

Request:

```text
{
  group_ref: ShapeGroupRefInput,
  path: BezierPath,
  idempotency_key: IdempotencyKey
}
```

Response `value`:

```text
{
  changed: true,
  groupRef: ShapeGroupRef,
  beforePath: BezierPath,
  afterPath: BezierPath
}
```

This tool reuses the existing `ae.setLayerMaskPath` vertex conversion,
MaskOutline mutation, decimal comparison, audit, and postcondition behavior.
It adds only shape-group resolution. Requesting the current path is
`INVALID_ARGUMENT`, `sideEffect: not-started`.

### `ae_setShapeFillStyle`

Canonical registry name: `ae.setShapeFillStyle`

Native capability: `ae.shape.fill-style.set@1`.

Request:

```text
{
  group_ref: ShapeGroupRefInput,
  fill: {
    enabled: boolean,
    color: Color8,
    opacity_percent: DecimalString, numeric range [0,100]
  },
  idempotency_key: IdempotencyKey
}
```

Response `value`:

```text
{
  changed: true,
  groupRef: ShapeGroupRef,
  beforeFill: ShapeFill,
  afterFill: ShapeFill
}
```

This is a complete replacement of the representable fill style, not a patch:
all three fields are required and none is silently ignored. Resolve the group
ref, require exactly one fill child, read the complete before group, perform
the active-eyeball and primitive stream writes in one native AE Undo group,
then independently reacquire and read the complete `ShapeGroup`. The response
projects that verified snapshot to `afterFill`; group ref, name, path, stroke,
and top-level group order must be unchanged. A request equal to the current
fill is `INVALID_ARGUMENT`, `sideEffect: not-started`.

### `ae_setShapeStrokeStyle`

Canonical registry name: `ae.setShapeStrokeStyle`

Native capability: `ae.shape.stroke-style.set@1`.

Request:

```text
{
  group_ref: ShapeGroupRefInput,
  stroke: {
    enabled: boolean,
    color: Color8,
    opacity_percent: DecimalString, numeric range [0,100],
    width_pixels: DecimalString, numeric range [0,1000],
    stroke_over_fill: boolean
  },
  idempotency_key: IdempotencyKey
}
```

Response `value`:

```text
{
  changed: true,
  groupRef: ShapeGroupRef,
  beforeStroke: ShapeStroke,
  afterStroke: ShapeStroke
}
```

This is likewise a complete replacement: all five fields are required.
Resolve exactly one stroke and one fill child within the verified group; write
the stroke active-eyeball, color, opacity, and width streams and, when needed,
use `AEGP_ReorderStream` to establish the requested fill/stroke relative
order. One native AE Undo group covers the entire operation. Independent
complete-group readback must prove the requested `ShapeStroke`; group ref,
name, path, fill values/enabled state, and top-level group order must be
unchanged. A request equal to the current stroke is `INVALID_ARGUMENT`,
`sideEffect: not-started`.

Two tools are frozen instead of one overloaded style patch because fill and
stroke have different state and invariants, and stroke alone owns width and
relative ordering. Each request is a closed, complete replacement with every
field required; callers copy the current snapshot from
`ae_listShapeGroups`, change intentional values, and cannot mistake an absent
field for an ignored write.

### `ae_reorderShapeGroup`

Canonical registry name: `ae.reorderShapeGroup`

Native capability: `ae.shape.group.reorder@1`.

Request:

```text
{
  group_ref: ShapeGroupRefInput,
  target_index: integer [1,9007199254740991],
  idempotency_key: IdempotencyKey
}
```

Response `value`:

```text
{
  changed: true,
  layerLocator: LayerLocator,
  streamId: int32,
  beforeIndex: positive integer,
  afterIndex: positive integer,
  groups: array[1..50] of {
    groupIndex: positive integer,
    streamId: int32,
    name: string
  }
}
```

Path: resolve `group_ref`, call DynamicStreamSuite4
`AEGP_ReorderStream` (`AE_GeneralPlug.h:1691-1701`), then reacquire and verify
the complete bounded group order. Same-index requests fail before dispatch.

## Frozen public marker surface: 4 tools

Marker tools are native-only. MarkerSuite3 is the package's only newly
acquired suite. Marker values live in an existing marker stream:

- layer target: StreamSuite6 `AEGP_GetNewLayerStream` with
  `AEGP_LayerStream_MARKER` (`AE_GeneralPlug.h:1274,1477-1481`);
- composition target: CompSuite12 `AEGP_GetNewCompMarkerStream`
  (`:845-848`); and
- placement/edit/delete: the already-proven KeyframeSuite5 exact-time calls
  (`:1822-1855,1915-1933`).

Every proposed tool maps to concrete MarkerSuite3 methods:

| Tool | MarkerSuite3 calls | Proven companion calls |
| --- | --- | --- |
| `ae_listMarkers` | `GetMarkerString` for all five kinds; `GetMarkerFlag` for both flags; `CountCuePointParams` + `GetIndCuePointParam`; `GetMarkerDuration`; `GetMarkerLabel` | `GetStreamNumKFs`, `GetKeyframeTime`, `GetNewKeyframeValue`, then StreamSuite value disposal |
| `ae_createMarker` | `NewMarker`; `SetMarkerString`; `SetMarkerFlag`; `InsertCuePointParam` + `SetIndCuePointParam`; `SetMarkerDuration`; `SetMarkerLabel`; `DisposeMarker` | `StartAddKeyframes`, `AddKeyframes`, `SetAddKeyframe`, `EndAddKeyframes` |
| `ae_setMarker` | `DuplicateMarker`; requested `SetMarkerString`/`SetMarkerFlag`/parameter insert-delete-set/`SetMarkerDuration`/`SetMarkerLabel`; all getters for before/after; `DisposeMarker` | exact-time resolution plus `SetKeyframeValue` |
| `ae_deleteMarker` | all getters for the complete before value and `DuplicateMarker`/`DisposeMarker` ownership before deletion | exact-time resolution plus `DeleteKeyframe` |

The MarkerSuite3 signatures are pinned at
`AE_GeneralPlug.h:1993-2073`. No marker operation uses a suite outside the
proven set plus MarkerSuite3.

### `ae_listMarkers`

Canonical registry name: `ae.listMarkers`

Native capability: `ae.marker.list@1`.

Request:

```text
{
  target: MarkerTargetInput,
  offset: integer [0,9007199254740991] = 0,
  limit: integer [1,50] = 25
}
```

Response `value`:

```text
{
  target: MarkerTarget,
  total: non-negative integer,
  offset: non-negative integer,
  limit: integer [1,50],
  returned: integer [0,50],
  hasMore: boolean,
  nextOffset: non-negative integer | null,
  markers: MarkerState[0..50]
}
```

Markers are strictly ordered by exact rational time. Duplicate exact times are
a contract failure.

### `ae_createMarker`

Canonical registry name: `ae.createMarker`

Native capability: `ae.marker.create@1`.

Request:

```text
{
  target: MarkerTargetInput,
  time: ExactTimeInput,
  marker: {
    duration: ExactTimeInput = {value:0, scale:1},
    comment: string[0..1024] = "",
    chapter: string[0..128] = "",
    url: string[0..1024] = "",
    frame_target: string[0..128] = "",
    cue_point_name: string[0..64] = "",
    cue_point_parameters: CuePointParameter[0..64] = [],
    navigation: boolean = false,
    protected_region: boolean = false,
    label_id: integer [0,16] = 0
  },
  idempotency_key: IdempotencyKey
}
```

Invariant: marker duration is non-negative. An existing marker at the exact
time is `PRECONDITION_FAILED`, `sideEffect: not-started`.

Response `value`:

```text
{
  changed: true,
  before: null,
  after: MarkerState
}
```

### `ae_setMarker`

Canonical registry name: `ae.setMarker`

Native capability: `ae.marker.set@1`.

Request:

```text
{
  marker_ref: MarkerRefInput,
  patch: {
    duration: ExactTimeInput | null,
    comment: string[0..1024] | null,
    chapter: string[0..128] | null,
    url: string[0..1024] | null,
    frame_target: string[0..128] | null,
    cue_point_name: string[0..64] | null,
    cue_point_parameters: CuePointParameter[0..64] | null,
    navigation: boolean | null,
    protected_region: boolean | null,
    label_id: integer [0,16] | null
  },
  idempotency_key: IdempotencyKey
}
```

`patch` is non-empty. Null means "not requested"; strings, including empty
strings, are explicit replacements. Marker time is not patchable.

Response `value`:

```text
{
  changed: true,
  before: MarkerState,
  after: MarkerState
}
```

`before.ref == after.ref == marker_ref` after canonical time reduction. Only
requested fields may differ. A no-op patch is `INVALID_ARGUMENT`,
`sideEffect: not-started`.

### `ae_deleteMarker`

Canonical registry name: `ae.deleteMarker`

Native capability: `ae.marker.delete@1`.

Request:

```text
{
  marker_ref: MarkerRefInput,
  idempotency_key: IdempotencyKey
}
```

Response `value`:

```text
{
  changed: true,
  before: MarkerState,
  after: null
}
```

A missing exact-time marker is `PRECONDITION_FAILED`,
`sideEffect: not-started`; no nearest-marker match is permitted.

## Suite closure and native novelty

The full package suite inventory is:

| Area | Suites |
| --- | --- |
| Text | none; maintained JSX |
| Shape | already-proven Comp12, DynamicStream4, Item9, Keyframe5, Layer9, MaskOutline3, Memory1, Proj6, Stream6, Utility6 |
| Marker | the same proven Comp12, Item9, Keyframe5, Layer9, Memory1, Proj6, Stream6, Utility6, plus **new MarkerSuite3** |
| CEP staging | none |

Collection, Effect, Footage, Mask, and Register remain in the repository's
proven inventory but are not needed by these new operations. No package tool
requires TextDocumentSuite1, TextLayerSuite1, an expression setter, or another
unbudgeted AEGP suite.

### T4 decision

Exactly **one** narrow T4 is required, for MarkerSuite3:

1. public `ae_listMarkers` proves an empty marker stream;
2. public `ae_createMarker` writes one Unicode marker containing a duration,
   one flag, one cue parameter, and a label;
3. public `ae_listMarkers` verifies every written field and exact time;
4. execute one real AE Undo; then public `ae_listMarkers` verifies the stream
   is empty.

This is one four-public-call T4 smoke in one existing disposable preflight
fixture. It is not candidate evidence.

Shape property-group construction, restyling, and reordering are new package
operations but **not a second native mechanism and do not receive a separate
T4**:

- they use the already-acquired DynamicStreamSuite4 and existing
  `StreamRefOwner`/dispose lifecycle;
- `AEGP_AddStream` returns the same `AEGP_StreamRefH` ownership type already
  traversed and disposed by the plug-in;
- fill/stroke values reuse the proven `OneD`/`COLOR` primitive stream
  conversion and Undo-producing static-write path; enablement and relative
  order reuse the proven active-eyeball and dynamic-child reorder calls;
- the two-pass reacquisition rule handles invalidated property references;
- graph generation invalidation, fresh locator return, Utility Undo grouping,
  audit, postcondition, and main-thread dispatch are existing mechanisms; and
- T1/T2 must falsify add/reacquire/reorder/index-and-stream-id behavior before
  candidate freeze.

The novelty is new calls within a proven lifecycle, not a new suite,
object-lifetime rule, or main-thread mechanism. If T1/T2 disproves that
statement by revealing a different ownership rule, the package must stop and
re-freeze rather than silently adding a second T4.

## Capability and interaction matrix

### Text family

| Tool | R/W | Primary state | Required interaction |
| --- | --- | --- | --- |
| `ae_listInstalledFonts` | R | normalized installed font inventory | feeds deterministic primary/fallback selection |
| `ae_createTextLayer` | W | point and box layer creation; Unicode content | creates target for all text and cross-family marker rows |
| `ae_getTextDocument` | R | complete representable document/style | independent readback for all three setters |
| `ae_setTextContent` | W | Unicode/UTF-16 content | style must remain unchanged |
| `ae_setTextCharacterStyle` | W | font resolution, size, fill/stroke, tracking, leading | content and paragraph style must remain unchanged |
| `ae_setTextParagraphStyle` | W | justification and paragraph spacing/indents | content and character style must remain unchanged |

Acceptance uses point text for the main sequence and T2 covers the complete
box-text request/result contract. Hardware also creates one box text layer only
if a point/box host fact remains unresolved after T2; that extra case must be
included in the frozen 44-call ledger, not appended ad hoc.

### Shape family

| Tool | R/W | Primary state | Required interaction |
| --- | --- | --- | --- |
| `ae_createShapeLayer` | W | one empty vector layer | target for group and marker tools |
| `ae_listShapeGroups` | R | ordered group refs, paths, complete fill/stroke states | supplies every write address and verifies every shape write |
| `ae_createShapeGroup` | W | group + Bezier path + fill + stroke atomically | called twice to make group and style ordering observable |
| `ae_setShapePath` | W | open/closed topology, vertices, relative tangents | preserves group id, name, fill, stroke, and order |
| `ae_setShapeFillStyle` | W | fill enabled, color, opacity | create-then-restyle; preserves path, stroke, and group order |
| `ae_setShapeStrokeStyle` | W | stroke enabled, color, opacity, width, fill/stroke order | restyle-then-reorder and restyle-then-Undo |
| `ae_reorderShapeGroup` | W | top-level group ordering | preserves stream ids and complete group content |

### Marker family

| Tool | R/W | Primary state | Required interaction |
| --- | --- | --- | --- |
| `ae_listMarkers` | R | exact-time ordered complete marker values | layer and composition targets |
| `ae_createMarker` | W | new complete marker value | text layer and shape layer targets at equal rational time |
| `ae_setMarker` | W | non-empty patch at stable exact-time identity | preserves unrequested fields and identity |
| `ae_deleteMarker` | W | exact marker removal | Undo restores complete before value |

### Cross-family combinations

T5 exercises all of these combinations in the same fixture:

1. the text and shape layers coexist and are reacquired through public layer
   reads after each graph-changing create;
2. one Unicode layer marker is created on the new text layer and one marker is
   created at the numerically equal rational time on the new shape layer;
3. the two target streams remain independent despite equal time and marker
   content;
4. create `Triangle`, then restyle its fill and stroke in place using the
   `ShapeGroupRef` returned by `ae_listShapeGroups`; text content/style and the
   group's path remain unchanged;
5. restyle `Triangle`, then reorder the top-level shape groups; refreshed
   list readback must preserve both restyled values and both stable group
   stream ids;
6. restyle fill and stroke separately, execute one real Undo after each, and
   use `ae_listShapeGroups` to prove exact restoration while the text and
   marker families remain unchanged;
7. shape group order/path/fill/stroke remains unchanged while text and shape
   markers are created, edited, deleted, and undone; and
8. a final composition-layer read proves family teardown returned the fixture
   to the recorded empty-composition baseline.

T6 uses the same fixture recipe but the policy-reduced plan. It proves that
both layer families coexist, both equal-time marker streams remain isolated,
the representative stroke restyle survives shape-group reorder and independent
readback, and both layers survive the formal-AE restart/reopen. T6 does not
repeat the T5-only fill restyle, the two omitted text setters, or per-write
teardown.

## Undo and uncertain-failure model

| Tool class | Undo contract |
| --- | --- |
| all reads | not applicable |
| `ae_createTextLayer` | one maintained-JSX AE Undo group; Undo removes exactly the created layer |
| the three text setters | one maintained-JSX AE Undo group around one TextDocument `setValue`; Undo restores the complete before snapshot |
| `ae_createShapeLayer` | one native AE Undo group; Undo removes the created layer |
| `ae_createShapeGroup` | one native AE Undo group for group/path/fill/stroke construction; Undo removes exactly that group |
| `ae_setShapePath` | one native AE Undo group; Undo restores exact topology and decimals |
| `ae_setShapeFillStyle` | one native AE Undo group; Undo restores enabled, color, and opacity exactly |
| `ae_setShapeStrokeStyle` | one native AE Undo group; Undo restores enabled, color, opacity, width, and stroke-over-fill order exactly |
| `ae_reorderShapeGroup` | one native AE Undo group; Undo restores index order and stream ids |
| marker create/set/delete | one native AE Undo group; Undo respectively removes, restores before, or restores deleted marker |

JSX `setValue` Undo is not accepted by assertion. Before candidate freeze:

- T1 template tests prove every text write renders exactly one closed template,
  passes only JSON literals, enters one named Undo boundary, performs the
  expected creation or TextDocument `setValue`, obtains after-readback before
  returning, and cannot catch a mutation failure and report success;
- T1 response tests require `undo.available == true` and
  `undo.verified == false`, bind the group id to the audit record, and reject a
  response that lacks before/after state;
- T2 Core/bridge integration drives each rendered template through the
  maintained-JSX backend contract, applies the test Undo callback, and requires
  the independent public read to equal the before snapshot; and
- T2 driver tests fail if a text write row omits the real-Undo checkpoint or
  accepts `undoAvailable` as `undoVerified`.

T5 executes every listed write checkpoint against real AE. T6 executes one
real Undo for each distinct package Undo model: maintained-JSX TextDocument,
native shape graph, native shape stream, and native marker keyframe. If AE does
not record an expected Undo, that row fails loudly with the complete expected
and actual snapshot; it is not skipped or relabeled.

Any timeout/disconnect after a write dispatch is
`POSSIBLY_SIDE_EFFECTING_FAILURE`, `sideEffect: may-have-occurred`. Stop that
family, inspect public AE state plus the persisted audit record, reconcile the
fixture, and never retry with a new or old key until the outcome is known.

## One disposable fixture and deterministic lifecycle

Lifecycle: `ephemeral-validation`.

There is exactly one active `.aep` in T4, T5, or T6 and no Save As copies.
The issue/evidence directory stores the fixture id, recipe, source/component
receipts, public requests/responses, state hashes, audit, Undo results, and
lifecycle counters—not another `.aep`.

### Deterministic rebuild recipe

1. Start formal AE with a new empty project. Run a public readiness read before
   the first save.
2. Save once in place to the explicit active fixture path outside Adobe scan
   roots.
3. Through public MCP, create one composition named
   `TSM Acceptance Fixture`, 1920x1080, square pixels, 10 seconds, 24 fps.
4. Reacquire the composition through `ae_listProjectItems`.
5. Record the empty composition layer list as baseline.
6. During the matrix, `ae_createTextLayer` creates `TSM Text` with
   `A😀中 é`; `ae_createShapeLayer` creates `TSM Shape`; two
   `ae_createShapeGroup` calls create `Triangle` and `Curve` with fixed paths
   and distinct complete fill/stroke styles. `Triangle` is then restyled in
   place through each explicit style setter.
7. Marker cases use exact times `{value:24,scale:24}` and
   `{value:1000,scale:1000}` to prove canonical equality at one second without
   conflating target identity.
8. Save only in place at the runner's explicit save/restart checkpoint.

All fixture inputs and expected values live in the tracked package acceptance
spec. No arbitrary JSX or GUI drawing constructs the tested state.

### Reset procedure

- Text setters are invoked and individually undone immediately; each
  `ae_getTextDocument` must equal the pre-write snapshot.
- Shape fill style, stroke style, path, and reorder are invoked and
  individually undone; every Undo is verified by `ae_listShapeGroups`. Group
  creation remains only until cross-family marker checks finish, then each
  group create is undone in reverse order and verified by the same read.
- Marker set and delete are invoked and individually undone. Marker creates
  are undone after cross-target checks, and `ae_listMarkers` must return each
  target to its empty baseline.
- After all child writes are unwound, undo shape-layer creation and text-layer
  creation in reverse order. A public composition-layer read must equal the
  recorded empty baseline.
- If a baseline comparison fails, stop. Do not create another project. Reconcile
  state/audit, then reset or deterministically rebuild the same active slot.

After evidence extraction, close formal AE, move the exact fixture to the
short-lived recovery archive, clear the active slot, and report:
`created=1`, `canonicalRetained=0`, `evidenceSnapshotsRetained=0`,
`archived=1`, `unclassified=0`, plus logical/physical bytes moved or released.
Remove the recovery copy after successful T6 and package closure unless an
unresolved non-rebuildable defect explicitly references it.

## Executable T4/T5/T6 acceptance

The mixed executable path is frozen before implementation:

```text
text public MCP tool
  -> typed Core handler
  -> internal maintained JSX template
  -> CEP evalScript transport
  -> AE TextDocument/layer state
  -> typed before/after result
  -> Core/template provenance + audit + postcondition

shape/marker public MCP tool
  -> Core native adapter
  -> typed native RPC
  -> AEGP main-thread dispatcher
  -> AE state
  -> typed before/after result
  -> native provenance + audit + postcondition
```

The runner branches on the frozen engine per tool. Seeing native provenance
on a text tool, missing native provenance on a shape/marker tool, or a
maintained-JSX result with no template/audit binding is an immediate contract
failure before semantic acceptance.

### Public-call budget

**T5 uses exactly 44 public MCP calls and aborts before call 45.** This brief
explicitly authorizes T5 to exceed the workflow's normal 30-call ceiling. The
authorization is carried by
`scripts/hardware/text_shape_marker_spec.py:CALL_CEILING_AUTHORIZATION`; no
downstream ledger or CLI may clamp T5 back to 30 calls.

**T6 uses a distinct 30-call plan and aborts before call 31.** It uses the same
driver and fixture recipe, selected by `--mode t6`; a second driver is
forbidden because the tier plans must not drift apart.

The exception is justified by 17 package tools, 13 write tools, independent
post-Undo public readback for every write, two shape groups required to prove
top-level ordering, separate fill/stroke restyles required to prove independent
enablement and stroke-over-fill ordering, two marker targets required to prove
cross-family isolation, and one formal-AE restart/reopen check. Removing calls
would merge availability, write-readback, Undo verification, style
independence, or cross-target identity into unsupported assumptions.

The 44-call ledger is closed:

| Calls | Purpose |
| ---: | --- |
| 4 | readiness, create/reacquire composition, empty-layer baseline |
| 9 | all six text tools plus three independent setter post-Undo reads |
| 15 | all seven shape tools, second group creation, fill/stroke/path/reorder Undo reads, group/layer teardown reads |
| 10 | all four marker tools, text+shape targets, set/delete/create Undo reads, equal-time isolation |
| 3 | explicit cross-family layer/text/shape state reads while both families coexist |
| 1 | text-layer create Undo and empty-composition verification |
| 2 | post-restart project/composition reacquisition and final empty-baseline check |
| **44** | total |

The T6 30-call ledger is closed:

| Calls | Purpose |
| ---: | --- |
| 4 | readiness, create/reacquire composition, empty-layer baseline |
| 5 | font inventory, text create/read, representative character setter and Undo read |
| 9 | shape layer, two groups, all distinct native shape primitives except the thin fill setter, and two Undo reads |
| 7 | all four marker tools across two targets, isolation reads, and representative marker Undo read |
| 3 | explicit cross-family layer/text/shape state reads |
| 2 | post-restart project reacquisition and retained-family layer read |
| **30** | total |

### T6 replay grounds and omissions

The 30-call plan is derived from all five section-8 workflow grounds:

1. First clean build: replay every new native shape/marker primitive. The fill
   setter is the one permitted exception because it is the same static-stream
   primitive as the replayed stroke setter.
2. Shared proven families: replay font inventory, text creation, complete text
   read, and the character-style setter as the maintained-JSX representative.
3. Post-candidate changes: the frozen plan currently has none. If a tool
   implementation changes after T5, including a replacement-candidate change,
   it must be added to T6 before the clean-main run.
4. Install/staging/generated/component identity: replay
   `ae_projectSummary`, require all 17 public tools, and bind the separately
   verified installed component set and generated contract digests.
5. Undo models: execute and read back one real Undo for maintained-JSX
   TextDocument, native shape graph, native shape stream, and native marker
   keyframe mutation.

Exactly three T5 package tools are omitted:

| Skipped in T6 | Replayed representative | Required grounds |
| --- | --- | --- |
| `ae_setTextContent` | `ae_setTextCharacterStyle` | shared primitive, shared Undo model, shared layer-locator scheme, byte-identical to the candidate |
| `ae_setTextParagraphStyle` | `ae_setTextCharacterStyle` | shared primitive, shared Undo model, shared layer-locator scheme, byte-identical to the candidate |
| `ae_setShapeFillStyle` | `ae_setShapeStrokeStyle` | shared primitive, shared Undo model, shared shape-group-ref locator scheme, byte-identical to the candidate |

Byte identity is a precondition for each omission, not an assumption that may
survive a post-candidate edit. If it is not true at T6 preparation, replay the
changed tool.

### Address-chain construction

The executable plan contains no hand-authored AE numeric id and no locator
from outside the session. Every address is copied from an earlier public
response. For the text family specifically:

| Text tool | Earlier public call that supplies its locator |
| --- | --- |
| `ae_createTextLayer` | call 3 `ae_listProjectItems` → the named fixture composition's `locator` |
| `ae_getTextDocument` | call 6 `ae_createTextLayer` → `value.after.layerLocator` |
| `ae_setTextContent` | call 7 `ae_getTextDocument` → `value.layerLocator` |
| `ae_setTextCharacterStyle` | call 9 post-Undo `ae_getTextDocument` → `value.layerLocator` |
| `ae_setTextParagraphStyle` | call 11 post-Undo `ae_getTextDocument` → `value.layerLocator` |

Call 6 also returns a fresh `value.compositionLocator`; call 14
`ae_createShapeLayer` consumes it after text-layer creation. Shape group,
marker, cross-family, teardown, and post-restart addresses are similarly
linked in `scripts/hardware/text_shape_marker_spec.py:T5_ADDRESS_LINKS`.
Bridge-side construction tests require every producer ordinal to precede its
consumer ordinal and require every address-bearing T5 call to have one such
link.

The T6 chain is constructed independently in
`scripts/hardware/text_shape_marker_spec.py:T6_ADDRESS_LINKS`. In particular,
the shorter plan reacquires the composition at call 3, creates text at call 6,
creates the shape layer from call 6's fresh composition locator at call 10,
and reacquires the composition again at call 29 before the final layer read.
Construction fails during module import if any T6 consumer loses its earlier
producer.

GUI Undo, save-in-place, File > Open Recent, AE quit/relaunch, and moving the
closed `.aep` to recovery are checkpoints rather than public MCP dispatches,
but their evidence is still recorded. Every actual MCP support, package,
negative, recovery, or unexpected extra call increments the ledger. There is
no uncounted retry allowance.

The T4 four-call marker smoke is separate from T5/T6 and does not consume
candidate evidence.

### Session continuity, reopen, contracts, and replay fence

- Save in place, quit formal AE, relaunch that exact formal application, and
  reopen the fixture through **AE File > Open Recent**. Never use Finder,
  double-click, or LaunchServices.
- Bind post-restart reads to the new formal host/session and reacquire every
  locator/index. T5 compares the empty fixture baseline before archive; T6
  verifies that both retained package layers survived restart.
- Record the verified component identity once for each pre/post-restart
  session. Per-tool evidence carries only component-identity deltas; it does
  not repeat the invariant component set.
- At T1/T2 the driver must load actual `tools/list`, compare each of the 17
  advertised input schemas to the frozen package expectation, and compare
  native capability/result contract digests or maintained-JSX
  contract/template digests as appropriate. Missing fields, extra fields,
  wrong engines, and stale fixture expectations fail before hardware.
- Native idempotency fences are process-lifetime safety state; successful or
  ambiguous entries are retained until AE restart
  (`native/ae-plugin/include/aemcp_native/host_dispatcher.hpp:1837-1848`).
  Every T5 run, every T6 run, and every post-restart repeated write therefore
  gets a fresh operation key. Reuse a key only to query/reconcile the same
  intent in the same process. Alternatively, restart the host between complete
  rounds. Never reuse T5 keys in T6.
- The maintained-JSX write adapter must enforce the same business-key
  non-rebinding rule in Core. Its T1/T2 replay tests prove identical arguments
  return the recorded result with `replayed=true`, while different arguments
  under the same key fail before JSX dispatch.

## T0-T2 obligations before candidate freeze

These tests are part of implementation scope even though this freeze commit
contains no tests.

### T0

- formatting and Markdown/link checks for this package brief;
- Python/JSON schema syntax for all new models and fixtures;
- JSX template parse/static checks under the classic ECMAScript 3 constraints;
- C++ formatting/compile of affected native declarations;
- generated public capability and protocol artifacts are current; and
- staging filter/verifier syntax plus tracked `.debug` byte fixture.

### T1: public schema and adapter contracts

1. Generate `tools/list`; assert all 17 exact exposed names, closed request
   schemas, defaults, bounds, enums, conditional invariants, annotations, and
   no caller-code field.
2. Assert every response model is closed and rejects missing/extra fields,
   wrong engine/provenance, request/result mismatch, false postconditions,
   malformed Unicode, non-finite decimals, duplicate cue keys, duplicate
   marker times, stale group ids, and no-op patches.
3. Font tests cover preferred installed, preferred missing/error, ordered
   fallback selection, exhausted fallback, duplicate inventory records, and
   PostScript-name exactness. Tests must not depend on a particular maintainer
   font being installed.
4. Render each text template with hostile strings (`"`, `\`, newline, U+2028,
   astral characters); assert they appear only as JSON literals and never
   change program structure. Verify template digest/audit binding.
5. UTF-16 tests round-trip ASCII, CJK, a surrogate-pair emoji, and a combining
   sequence without measuring UTF-16 code units as Unicode scalar length.
6. TextDocument tests round-trip every frozen character/paragraph field and
   reject mixed/unrepresentable styles with expected field names.
7. Reuse the exact existing mask-path request model and numeric comparator for
   shape paths. Open/closed topology, 2/3/min/max vertices, relative tangents,
   exponent decimals, signed-zero/noncanonical values, NaN, infinity, and
   underflow are covered.
8. Shape construction/style fixtures assert add/reacquire ordering, closed
   match names, stream-ref disposal, unique stream ids, complete
   fill/stroke readback, independent active-eyeball state, color/opacity/width
   primitive types, both stroke-over-fill orders, top-level group order, and
   graph invalidation/fresh locators. Each style request schema requires every
   field and rejects omitted, extra, and no-op values.
9. Marker codec tests map all five strings, both flags, ordered cue params,
   duration, label, exact time, target discriminator, and before/after/null
   write results to the MarkerSuite3/Keyframe wire shapes.
10. Marker time tests compare rationals by cross multiplication, reject
    duplicate exact times at different scales, and preserve target+time
    identity after `ae_setMarker`.
11. The driver expectation tests validate both provenance branches, the T5
    44-call abort-before-45 authorization, the T6 30-call count and every skip
    ground, both address chains, tier-specific Undo checkpoints, File > Open
    Recent checkpoint text, once-per-session component identity with per-tool
    deltas, fresh-key-per-run behavior, and the frozen fixture recipe.

### T2: package integration and fail-loud host boundaries

1. Core/CEP maintained-JSX integration proves typed rendering, one dispatch,
   idempotent replay/no redispatch, persisted redacted audit, structured
   before/after readback, and the text Undo callback/readback cycle.
2. Native protocol/codec/dispatcher integration covers all eleven native tools,
   every MarkerSuite3 call family, exact-time keyframe resolution, marker
   allocation/disposal, and structured error side-effect classification.
3. Native shape integration covers `CanAddStream`/`AddStream`, two-pass
   reacquisition, MaskOutline vertex construction, fill/stroke child
   resolution from `ShapeGroupRefInput`, primitive style writes,
   active-eyeball changes, style-child and top-level `ReorderStream`, fresh
   locators, complete before/after, audit/postcondition, and one Undo boundary
   per write.
4. Interaction corpus creates two shape groups, restyles and restores fill and
   stroke independently, reorders and restores them, edits and restores path
   topology, places equal-time markers on distinct target kinds/layers, and
   proves no family changes another family's state.
5. Staging integration changes the production fixture expectation to
   `.debug == present`, asserts byte equality and manifest hash against tracked
   `plugin/.debug`, lets the production verifier accept that one root file,
   continues rejecting all other development files, and runs the unchanged
   dev installer required-file contract against the staged tree. Missing,
   symbolic, relocated, untracked, or byte-different `.debug` fails closed.
6. Fixture/runner mocks prove a pre-first-call failure recovers and clears the
   active slot; a possibly side-effecting write stops; a restored baseline may
   continue independent cases; and lifecycle counts are exact.

Facts that the non-AE tiers cannot settle must fail loudly in T4/T5/T6:

- actual host font inventory and the chosen installed fallback;
- whether every frozen TextDocument getter/setter exists and preserves the
  requested value on the target AE build;
- whether real AE records each maintained-JSX `setValue`/layer creation in one
  Undo step;
- whether shape AddStream/reacquisition preserves the expected stream ids,
  style leaf types, active-eyeball states, and both child/top-level ordering
  semantics on the real host; and
- MarkerSuite3 allocation/string/parameter/duration/label fidelity.

For each, the runner records the field or operation plus complete
`expected` and `actual` values and marks the case `FAIL`; it never skips,
guesses, substitutes a default, or weakens the schema during hardware.

## Explicit non-goals

- No implementation, handler, schema source, native source, JSX template,
  generated capability artifact, test, runner, or script change belongs in
  this design commit.
- No render queue, output module, render, export, asynchronous AE operation, or
  background job.
- No text animator, range selector, per-character mixed style editing,
  vertical text, path text, text-on-shape, glyph outline conversion, or
  arbitrary TextDocument field outside the frozen schemas.
- No caller-supplied code, JSX, expression, match name, property path, or
  template fragment. `ae_exec` remains categorically separate.
- No expression authoring. StreamSuite expression methods are not used.
- No parametric rectangle/ellipse/star/polystar, gradient fill/stroke,
  dash/cap/join/miter stroke controls, shape operator/repeater/trim path,
  merge paths, or arbitrary unrepresentable shape group. Solid fill and
  stroke editing is limited to the two frozen in-place style tools.
- No marker time move, nearest-marker matching, marker bulk import/export, XMP
  synchronization, or render/output markers.
- No new AEGP suite besides MarkerSuite3; no new locator framework, transport,
  main-thread mechanism, generalized AEGP/JSX resolver, or plan language.
- No pairing, signing, notarization, Windows, installer redesign, runtime
  manager migration, release packaging redesign beyond the exact `.debug`
  stage/install contract, or unrelated security hardening.
- No GitHub Issue creation, backlog reprioritization, `AGENTS.md`,
  `scripts/check-repository-governance.mjs`, or `REQUIRED_RULES` change.
- No AE/hardware action during design; no push, PR, merge, or next-package
  work.
