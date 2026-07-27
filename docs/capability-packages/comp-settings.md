# Composition Settings capability-package brief

Status: frozen for implementation  
Package size: six public write tools  
Base: `7d983f2`  
Native novelty: none  
Fixture lifecycle: `ephemeral-validation`

## Amendment — `ae_previewFrame` image content (#177)

This amendment does not redesign the six-tool Composition Settings package.
The six public writes, schemas, native capabilities, suite, Undo model and
non-goals below remain intact. `ae_previewFrame` is an existing synchronous
read from another tool family; it accompanies the settings writes so the model
can inspect the pixels those writes affect.

### Additive MCP response shape and compatibility

The canonical handler result remains the existing JSON object:

```json
{
  "ok": true,
  "compId": "7",
  "compName": "Comp Settings Fixture",
  "captureId": "7a5fc9e3d2604f85a3d8469bd469ec6f",
  "frames": [
    {
      "time": 0,
      "path": "/temporary/session/frame.png",
      "width": 1440,
      "height": 1080,
      "sizeBytes": 10482,
      "sha256": "64 lower-case hex characters",
      "source": "comp",
      "method": "saveFrameToPng",
      "compId": "7"
    }
  ]
}
```

At the public MCP boundary a successful `ae_previewFrame` call returns:

1. the existing JSON object serialized as the first `TextContent` item; then
2. one `ImageContent` item with `mimeType="image/png"` for each entry in
   `frames`, in the same order.

`CallToolResult.structuredContent` also carries that same JSON object. This is
additive; item 0 remains byte-compatible for clients that have not adopted
structured content.

`captureId` and each frame's `sha256` are additive structured fields. Existing
callers that parse `content[0].text`, use `path`, or opt into the existing
`include_base64=true` field continue to work. `include_base64` retains its old
meaning: it controls duplication of PNG bytes inside the JSON frame object; it
does not turn first-class MCP image content on or off. The default remains
false so a normal call carries one inline copy of each image, not two.

The packaging layer reads the PNG produced by the existing render path. It
must decode as PNG, its decoded dimensions must equal the frame's structured
`width` and `height`, and its bytes must match the structured `sha256`. A
missing, corrupt, non-PNG or dimension-mismatched file is a failed tool call,
not a text-only success. This changes no renderer, capture method, fallback or
AE operation.

### Image-bearing acceptance evidence

For each preview call, evidence records the public request and the complete
MCP `CallToolResult`, then independently:

- parses item 0 as the backward-compatible JSON result;
- asserts the number of following `ImageContent` items equals
  `len(frames)`;
- base64-decodes each image item and verifies the PNG signature and complete
  Pillow decode;
- checks decoded dimensions against both the corresponding frame metadata and
  the expected composition dimensions;
- checks SHA-256 against the corresponding frame metadata; and
- records `captureId`, requested time, source/method and the settings-readback
  audit/postcondition IDs that precede the preview.

Checking only that image data is a non-empty string is explicitly
insufficient.

Composition background colour has two distinct alpha semantics. The typed
`backgroundColor` is a colour setting, so its alpha is 255 for the opaque
configured colour. In an `ae_previewFrame` PNG, an uncovered pixel has that
configured RGB but alpha 0: After Effects paints the composition background in
its viewport without compositing it into the exported alpha. Acceptance
therefore verifies the visible background by RGB and separately requires and
records the expected setting-alpha/rendered-alpha divergence. Treating the PNG
as full-RGBA equality with the typed setting is incorrect; conversely, silently
dropping alpha would fail to record the transparency that the preview preserves.

The cross-family acceptance cases added to the otherwise unchanged settings
sequence are:

1. **Before:** after the baseline settings read, preview the unobscured
   background at 1920x1080 and record its baseline colour.
2. **After combined writes:** after the independent readback of dimensions
   1440x1080 and background `(64,96,128,255)`, take a fresh preview and verify
   both the decoded 1440x1080 PNG dimensions and the visible background.
3. **Intermediate Undo:** after real Undo restores the background but before
   dimensions are Undone, take a fresh preview proving the baseline background
   at 1440x1080.
4. **Dimensions restored:** after real Undo restores dimensions, take a fresh
   preview proving 1920x1080 while the already-restored background remains
   visible.

The fixture's `Timing Witness` must leave a deterministic background sample
area unobscured; this is a clarification of its layout, not another setting or
tool. Frame-rate correctness continues to use exact settings readback and
reciprocal frame-duration evidence. A still PNG requested in decimal seconds
cannot independently prove the composition's rational frame rate, so the
visual evidence must not overclaim that it can.

These four calls raise the visual-check portion of the public-call budget from
20 to 24. Real-AE T5 then proved that each `ae_previewFrame` call advances the
native project graph generation: a locator acquired before the preview is stale
after it. The executable plan therefore follows every preview that has a later
locator consumer with a fresh `ae_listProjectItems` call. T5 uses four such
reacquisitions for 28 calls total; selective T6 needs three because its final
preview has no later locator consumer, for 17 calls total.

### Named risk dispositions

- **Payload size:** first-class MCP images necessarily carry base64 PNG data,
  but the default no longer duplicates those bytes in the JSON because
  `include_base64` remains false. Existing caller-selected `scale` and selected
  `times` remain the controls for contact-sheet or reduced-size reviews. The
  server does not silently downscale or truncate a requested frame: that would
  change what visual acceptance can prove. A native-resolution single frame
  remains supported, as it already was through `include_base64=true`.
- **Privacy:** a rendered frame can contain private project material. The tool
  description must say so and direct the model to preview only the
  user-authorized composition/times. No new desktop capture or wider data
  source is added. Default files remain in the per-session temporary preview
  directory with the existing age cleanup; an explicit `out_dir` remains the
  caller's responsibility.
- **Stale-frame confusion:** every call uses a fresh `captureId` and unique
  output names, and the structured SHA-256 binds each image item to the current
  call's frame metadata. The tool description must instruct the model to call
  preview after the latest write and use the newest `captureId`, never a prior
  image. Synchronous dispatch plus the existing wait for the newly named PNG
  means packaging cannot reuse an older call's file.

## Package outcome and frozen scope

A model can change the six ordinary composition settings that already have a
hardware-proven `AEGP_CompSuite12` setter path:

1. dimensions;
2. duration;
3. frame rate;
4. pixel aspect ratio;
5. background colour; and
6. display start time.

The package intentionally contains six tools. It does not add a seventh or
eighth setting merely to increase the count: shutter angle/phase and
preserve-nested-frame-rate do not have setters in the pinned CompSuite12 and are
recorded as follow-ups in DONE-WHEN 8.

This is a process-regression package. Package #157 took 66 hours from scope
freeze to acceptance, used 22 T5 sessions and 154 public calls, and did not pass
its first hardware attempt. Its four avoidable surprises were public/native
typed-shape drift, time-dimensionality assumptions, an unrefreshed Undo menu,
and restart state that the runner had not modelled. Composition Settings keeps
the same time-conversion hazard on an already proven suite and a much smaller
blast radius. A realistic first T5 pass, not tool count, is the package's
principal outcome.

## DONE-WHEN 1 — Source-derived public names and complete schemas

The source of truth for naming and shape conventions is:

- `packages/core/ae_mcp/handlers/native.py:2299-2318`: canonical
  `ae.getCompositionSettings` and `ae.setCompositionWorkArea` registration;
- `packages/core/ae_mcp/server.py:290-298`: public MCP names replace `.` with
  `_`;
- `packages/core/ae_mcp/schemas.py:576-609,656-714,798-897`: strict
  composition locators, exact `value`/`scale` time inputs, positive ratios and
  stable idempotency keys;
- `packages/core/ae_mcp/handlers/native.py:1184-1239`: the public verified-write
  response envelope;
- `packages/core/ae_mcp/backends/native_project_composition.py:266-315`: the
  existing complete composition-settings snapshot and its cross-field
  invariants;
- `native/ae-plugin/include/aemcp_native/host_dispatcher.hpp:481-525`: native
  exact-ratio, settings and before/after write-result conventions;
- `native/ae-plugin/src/aegp/plugin_entry.cpp:2268-2437,9364-9433`: current
  CompSuite12 locator reacquisition, main-thread read/write, UtilitySuite Undo
  group, exact readback and settings conversion path; and
- pinned
  `ae25.6_61.64bit.AfterEffectsSDK/Examples/Headers/AE_GeneralPlug.h:649-862`:
  CompSuite12 version/declaration and the six setter members
  (`AEGP_SetCompBGColor` at 674, `AEGP_SetCompFrameRate` at 706,
  `AEGP_SetCompDisplayStartTime` at 794, `AEGP_SetCompDuration` at 798,
  `AEGP_SetCompPixelAspectRatio` at 808 and `AEGP_SetCompDimensions` at 825);
  and
- `native/ae-plugin/protocol/conformance.mjs:2585-2604` and
  `native/ae-plugin/src/core/rpc_codec.cpp:5915-5955`: negotiated descriptor,
  risk, contract and example conventions.

The frozen names are:

| Public MCP tool | Canonical Core verb | Native capability |
| --- | --- | --- |
| `ae_setCompositionDimensions` | `ae.setCompositionDimensions` | `ae.composition.dimensions.set` |
| `ae_setCompositionDuration` | `ae.setCompositionDuration` | `ae.composition.duration.set` |
| `ae_setCompositionFrameRate` | `ae.setCompositionFrameRate` | `ae.composition.frame-rate.set` |
| `ae_setCompositionPixelAspectRatio` | `ae.setCompositionPixelAspectRatio` | `ae.composition.pixel-aspect-ratio.set` |
| `ae_setCompositionBackgroundColor` | `ae.setCompositionBackgroundColor` | `ae.composition.background-color.set` |
| `ae_setCompositionDisplayStartTime` | `ae.setCompositionDisplayStartTime` | `ae.composition.display-start-time.set` |

Every tool follows this already existing vertical slice:

```text
public MCP tool
  -> strict Core schema and handler
  -> negotiated native RPC capability
  -> existing AEGP main-thread dispatcher
  -> existing composition-locator reacquisition
  -> AEGP_CompSuite12 setter
  -> same-suite/item-suite before/after readback
  -> typed result, audit and postcondition
```

No JSX fallback, new suite, locator type, lifecycle rule, dispatcher,
main-thread mechanism or resolver is permitted.

### Public request and response schemas

#### Shared definitions

These definitions are part of all six public contracts. Input objects use
snake_case because that is what a model sends. Results use the existing
camelCase native/public response convention.

```json
{
  "$defs": {
    "uuid": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "sha256": {
      "type": "string",
      "pattern": "^[0-9a-f]{64}$"
    },
    "compositionLocator": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "kind", "hostInstanceId", "sessionId", "projectId", "generation", "objectId"
      ],
      "properties": {
        "kind": { "const": "composition" },
        "hostInstanceId": { "$ref": "#/$defs/uuid" },
        "sessionId": { "$ref": "#/$defs/uuid" },
        "projectId": { "$ref": "#/$defs/uuid" },
        "generation": {
          "type": "integer", "minimum": 1, "maximum": 9007199254740991
        },
        "objectId": { "$ref": "#/$defs/uuid" }
      }
    },
    "timeInput": {
      "type": "object",
      "additionalProperties": false,
      "required": ["value", "scale"],
      "properties": {
        "value": {
          "type": "integer", "minimum": -2147483648, "maximum": 2147483647
        },
        "scale": {
          "type": "integer", "minimum": 1, "maximum": 4294967295
        }
      }
    },
    "positiveTimeInput": {
      "type": "object",
      "additionalProperties": false,
      "required": ["value", "scale"],
      "properties": {
        "value": {
          "type": "integer", "minimum": 1, "maximum": 2147483647
        },
        "scale": {
          "type": "integer", "minimum": 1, "maximum": 4294967295
        }
      }
    },
    "exactTime": {
      "type": "object",
      "additionalProperties": false,
      "required": ["value", "scale", "secondsRational"],
      "properties": {
        "value": {
          "type": "integer", "minimum": -2147483648, "maximum": 2147483647
        },
        "scale": {
          "type": "integer", "minimum": 1, "maximum": 4294967295
        },
        "secondsRational": {
          "type": "string",
          "minLength": 1,
          "maxLength": 28,
          "pattern": "^(?:0|-?[1-9][0-9]*(?:/[1-9][0-9]*)?)$"
        }
      }
    },
    "ratioInput": {
      "type": "object",
      "additionalProperties": false,
      "required": ["numerator", "denominator"],
      "properties": {
        "numerator": {
          "type": "integer", "minimum": 1, "maximum": 2147483647
        },
        "denominator": {
          "type": "integer", "minimum": 1, "maximum": 2147483647
        }
      }
    },
    "exactRatio": {
      "type": "object",
      "additionalProperties": false,
      "required": ["numerator", "denominator", "rational"],
      "properties": {
        "numerator": {
          "type": "integer", "minimum": 1, "maximum": 2147483647
        },
        "denominator": {
          "type": "integer", "minimum": 1, "maximum": 2147483647
        },
        "rational": {
          "type": "string",
          "minLength": 1,
          "maxLength": 28,
          "pattern": "^[1-9][0-9]*(?:/[1-9][0-9]*)?$"
        }
      }
    },
    "color": {
      "type": "object",
      "additionalProperties": false,
      "required": ["red", "green", "blue", "alpha"],
      "properties": {
        "red": { "type": "integer", "minimum": 0, "maximum": 255 },
        "green": { "type": "integer", "minimum": 0, "maximum": 255 },
        "blue": { "type": "integer", "minimum": 0, "maximum": 255 },
        "alpha": { "const": 255 }
      }
    },
    "idempotencyKey": {
      "type": "string",
      "minLength": 16,
      "maxLength": 64,
      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]*$"
    },
    "workArea": {
      "type": "object",
      "additionalProperties": false,
      "required": ["start", "duration"],
      "properties": {
        "start": { "$ref": "#/$defs/exactTime" },
        "duration": { "$ref": "#/$defs/exactTime" }
      }
    },
    "settingsSnapshot": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "name", "width", "height", "duration", "frameDuration", "frameRate",
        "pixelAspectRatio", "backgroundColor", "workArea",
        "displayStartTime", "layerCount"
      ],
      "properties": {
        "name": { "type": "string", "maxLength": 1024 },
        "width": { "type": "integer", "minimum": 1, "maximum": 30000 },
        "height": { "type": "integer", "minimum": 1, "maximum": 30000 },
        "duration": { "$ref": "#/$defs/exactTime" },
        "frameDuration": { "$ref": "#/$defs/exactTime" },
        "frameRate": { "$ref": "#/$defs/exactRatio" },
        "pixelAspectRatio": { "$ref": "#/$defs/exactRatio" },
        "backgroundColor": { "$ref": "#/$defs/color" },
        "workArea": { "$ref": "#/$defs/workArea" },
        "displayStartTime": { "$ref": "#/$defs/exactTime" },
        "layerCount": {
          "type": "integer", "minimum": 0, "maximum": 9007199254740991
        }
      }
    }
  }
}
```

`backgroundColor` is added to the existing
`ae_getCompositionSettings` result snapshot so that the existing read remains
the one independent public verifier for every package tool. This is an
extension of one existing read result, not a seventh package tool or a new
native mechanism; CompSuite12 already supplies `AEGP_GetCompBGColor`.

#### Full request schemas

All six requests are closed objects. Omitted or extra fields are invalid.

```json
{
  "ae_setCompositionDimensions": {
    "type": "object",
    "additionalProperties": false,
    "required": ["composition_locator", "width", "height", "idempotency_key"],
    "properties": {
      "composition_locator": { "$ref": "#/$defs/compositionLocator" },
      "width": { "type": "integer", "minimum": 1, "maximum": 30000 },
      "height": { "type": "integer", "minimum": 1, "maximum": 30000 },
      "idempotency_key": { "$ref": "#/$defs/idempotencyKey" }
    }
  },
  "ae_setCompositionDuration": {
    "type": "object",
    "additionalProperties": false,
    "required": ["composition_locator", "duration", "idempotency_key"],
    "properties": {
      "composition_locator": { "$ref": "#/$defs/compositionLocator" },
      "duration": { "$ref": "#/$defs/positiveTimeInput" },
      "idempotency_key": { "$ref": "#/$defs/idempotencyKey" }
    }
  },
  "ae_setCompositionFrameRate": {
    "type": "object",
    "additionalProperties": false,
    "required": ["composition_locator", "frame_rate", "idempotency_key"],
    "properties": {
      "composition_locator": { "$ref": "#/$defs/compositionLocator" },
      "frame_rate": { "$ref": "#/$defs/ratioInput" },
      "idempotency_key": { "$ref": "#/$defs/idempotencyKey" }
    }
  },
  "ae_setCompositionPixelAspectRatio": {
    "type": "object",
    "additionalProperties": false,
    "required": ["composition_locator", "pixel_aspect_ratio", "idempotency_key"],
    "properties": {
      "composition_locator": { "$ref": "#/$defs/compositionLocator" },
      "pixel_aspect_ratio": { "$ref": "#/$defs/ratioInput" },
      "idempotency_key": { "$ref": "#/$defs/idempotencyKey" }
    }
  },
  "ae_setCompositionBackgroundColor": {
    "type": "object",
    "additionalProperties": false,
    "required": ["composition_locator", "background_color", "idempotency_key"],
    "properties": {
      "composition_locator": { "$ref": "#/$defs/compositionLocator" },
      "background_color": { "$ref": "#/$defs/color" },
      "idempotency_key": { "$ref": "#/$defs/idempotencyKey" }
    }
  },
  "ae_setCompositionDisplayStartTime": {
    "type": "object",
    "additionalProperties": false,
    "required": ["composition_locator", "display_start_time", "idempotency_key"],
    "properties": {
      "composition_locator": { "$ref": "#/$defs/compositionLocator" },
      "display_start_time": { "$ref": "#/$defs/timeInput" },
      "idempotency_key": { "$ref": "#/$defs/idempotencyKey" }
    }
  }
}
```

The semantic preconditions that cannot be expressed by JSON Schema are:

- a write must differ from the current value;
- duration must be frame-aligned and must not end before the existing work-area
  end;
- display start time must be frame-aligned;
- a frame-rate ratio must survive the frozen A_FpLong-to-frame-duration
  normalization contract in DONE-WHEN 3; and
- all targets must be fresh locators for the same open project/session.

#### Full success response schema

All six tools return the same complete settings transition. Keeping a complete
snapshot makes adjacent effects—especially duration/work-area and
frame-rate/frame-duration—observable rather than hiding them behind a
single-field response.

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "ok", "replayed", "value", "implementation",
    "provenance", "audit", "evidence"
  ],
  "properties": {
    "ok": { "const": true },
    "replayed": { "type": "boolean" },
    "value": {
      "type": "object",
      "additionalProperties": false,
      "required": ["changed", "compositionLocator", "before", "after"],
      "properties": {
        "changed": { "const": true },
        "compositionLocator": { "$ref": "#/$defs/compositionLocator" },
        "before": { "$ref": "#/$defs/settingsSnapshot" },
        "after": { "$ref": "#/$defs/settingsSnapshot" }
      }
    },
    "implementation": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "engine", "capabilityId", "capabilityVersion", "contractDigest",
        "risk", "mutability", "idempotency", "cancellation", "undo",
        "sideEffectSummary", "preconditions"
      ],
      "properties": {
        "engine": { "const": "native-aegp" },
        "capabilityId": {
          "enum": [
            "ae.composition.dimensions.set",
            "ae.composition.duration.set",
            "ae.composition.frame-rate.set",
            "ae.composition.pixel-aspect-ratio.set",
            "ae.composition.background-color.set",
            "ae.composition.display-start-time.set"
          ]
        },
        "capabilityVersion": { "const": 1 },
        "contractDigest": { "$ref": "#/$defs/sha256" },
        "risk": { "const": "write" },
        "mutability": { "const": "mutating" },
        "idempotency": { "const": "idempotency-key" },
        "cancellation": { "const": "before-dispatch" },
        "undo": { "enum": ["ae-undo-group", "none"] },
        "sideEffectSummary": {
          "type": "string", "minLength": 1, "maxLength": 160
        },
        "preconditions": {
          "type": "array",
          "maxItems": 16,
          "items": { "type": "string", "minLength": 1, "maxLength": 128 }
        }
      }
    },
    "provenance": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "engine", "selectedWireVersion", "pluginVersion",
        "compiledSdkVersion", "sourceCommit", "hostInstanceId",
        "sessionId", "sessionGeneration", "capabilitiesDigest"
      ],
      "properties": {
        "engine": { "const": "native-aegp" },
        "selectedWireVersion": { "const": 1 },
        "pluginVersion": { "type": "string", "minLength": 1, "maxLength": 64 },
        "compiledSdkVersion": {
          "type": "string", "minLength": 1, "maxLength": 64
        },
        "sourceCommit": {
          "type": "string", "pattern": "^[0-9a-f]{40}$"
        },
        "hostInstanceId": { "$ref": "#/$defs/uuid" },
        "sessionId": { "$ref": "#/$defs/uuid" },
        "sessionGeneration": {
          "type": "integer", "minimum": 1, "maximum": 9007199254740991
        },
        "capabilitiesDigest": { "$ref": "#/$defs/sha256" }
      }
    },
    "audit": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "requestId", "evidenceRequestId", "idempotencyKey", "replayed",
        "capabilityId", "capabilityVersion", "contractDigest", "effect",
        "requestDigest", "postconditionAlgorithm", "postconditionDigest",
        "undoAvailable", "undoVerified", "startedAtUnixMs", "completedAtUnixMs"
      ],
      "properties": {
        "requestId": { "type": "string", "minLength": 1, "maxLength": 128 },
        "evidenceRequestId": {
          "type": "string", "minLength": 1, "maxLength": 128
        },
        "idempotencyKey": { "$ref": "#/$defs/idempotencyKey" },
        "replayed": { "type": "boolean" },
        "capabilityId": {
          "type": "string", "pattern": "^[a-z][a-z0-9.-]{2,95}$"
        },
        "capabilityVersion": { "const": 1 },
        "contractDigest": { "$ref": "#/$defs/sha256" },
        "effect": { "const": "committed" },
        "requestDigest": { "$ref": "#/$defs/sha256" },
        "postconditionAlgorithm": { "const": "sha256-rfc8785-jcs-v1" },
        "postconditionDigest": { "$ref": "#/$defs/sha256" },
        "undoAvailable": { "type": "boolean" },
        "undoVerified": { "const": false },
        "startedAtUnixMs": {
          "type": "integer", "minimum": 1, "maximum": 9007199254740991
        },
        "completedAtUnixMs": {
          "type": "integer", "minimum": 1, "maximum": 9007199254740991
        }
      }
    },
    "evidence": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "engine", "hostInstanceId", "sessionId", "requestId",
        "capabilityId", "capabilityVersion", "startedAtUnixMs",
        "completedAtUnixMs", "effect", "requestDigest", "postcondition"
      ],
      "properties": {
        "engine": { "const": "native-aegp" },
        "hostInstanceId": { "$ref": "#/$defs/uuid" },
        "sessionId": { "$ref": "#/$defs/uuid" },
        "requestId": { "type": "string", "minLength": 1, "maxLength": 128 },
        "capabilityId": {
          "type": "string", "pattern": "^[a-z][a-z0-9.-]{2,95}$"
        },
        "capabilityVersion": { "const": 1 },
        "startedAtUnixMs": {
          "type": "integer", "minimum": 1, "maximum": 9007199254740991
        },
        "completedAtUnixMs": {
          "type": "integer", "minimum": 1, "maximum": 9007199254740991
        },
        "effect": { "const": "committed" },
        "requestDigest": { "$ref": "#/$defs/sha256" },
        "postcondition": {
          "type": "object",
          "additionalProperties": false,
          "required": ["verified", "kind", "algorithm", "digest"],
          "properties": {
            "verified": { "const": true },
            "kind": {
              "type": "string",
              "minLength": 1,
              "maxLength": 64,
              "pattern": "^[a-z][a-z0-9_-]*$"
            },
            "algorithm": { "const": "sha256-rfc8785-jcs-v1" },
            "digest": { "$ref": "#/$defs/sha256" }
          }
        },
        "undo": {
          "oneOf": [
            { "type": "null" },
            {
              "type": "object",
              "additionalProperties": false,
              "required": ["available", "verified"],
              "properties": {
                "available": { "type": "boolean" },
                "verified": { "const": false },
                "groupId": {
                  "oneOf": [
                    { "type": "null" },
                    { "type": "string", "minLength": 1, "maxLength": 128 }
                  ]
                }
              }
            }
          ]
        }
      }
    }
  }
}
```

For the five Undoable tools, the normal response reports Undo availability but
does not pretend the later real Undo has already happened: `undoVerified` and
`evidence.undo.verified` are false. T5/T6 runner evidence separately records
the executed Undo and its independent postcondition. Display start instead
returns `undo.available=false` and `undo.verified=false` and follows the
compensating-write rule in DONE-WHEN 4. Errors continue to use the existing
structured native error envelope, including `sideEffect`, `recovery.action`,
request/audit identity and `POSSIBLY_SIDE_EFFECTING_FAILURE`; this package adds
no error shape.

## DONE-WHEN 2 — Capability and interaction matrix

| Tool | Direct field | Required adjacent observations | Must be exercised with |
| --- | --- | --- | --- |
| dimensions | `width`, `height` | pixel aspect, layer/keyframe identity | pixel aspect ratio |
| duration | `duration` | work-area start/duration/end, frame duration | frame rate |
| frame rate | `frameRate`, reciprocal `frameDuration` | duration and work area in seconds | duration |
| pixel aspect ratio | `pixelAspectRatio` | dimensions and effective display aspect | dimensions |
| background colour | `backgroundColor` | all time, ratio and dimension fields unchanged | final combined settings state |
| display start time | `displayStartTime` | keyframe times and duration unchanged | existing keyframes |

The acceptance run must not validate these as six isolated mutations:

1. **Frame rate + duration + work area together.** Start at 24 fps, duration
   10 seconds and work area `[2s, 8s)`. Set frame rate to 25 fps, then duration
   to 8 seconds. The combined read must show 25 fps, frame duration 1/25,
   duration 8 seconds and the unchanged work area `[2s, 8s)`. The chosen
   duration equals, but does not cross, the work-area end, so the case exposes
   unit/conversion mistakes without depending on undocumented clipping.
2. **Dimensions + pixel aspect together.** Start at 1920x1080 with 1/1 pixels;
   set dimensions to 1440x1080 and pixel aspect to 4/3. The combined read must
   show both writes and preserve the effective 16:9 display aspect:
   `width * parNumerator / (height * parDenominator)`.
3. **Display start + existing keyframe times together.** The fixture contains
   Opacity keyframes at exact composition times 1, 4 and 7 seconds. Set display
   start to -1 second. The displayed timeline origin changes; the three stored
   keyframe times, composition duration and work area must not.
4. **All five Undoable settings together.** After the combined state is
   observed, Undo background, pixel aspect, dimensions, duration and frame
   rate in reverse order. Each intermediate full-settings read must show only
   the top Undo group restored and all earlier groups still applied.

Background colour is deliberately included in the combined-state and reverse
Undo sequence. It adds no interaction theory, but it detects a stale whole
snapshot or an Undo group accidentally spanning multiple public calls.

## DONE-WHEN 3 — Time-dimensionality and conversion contract

This section is normative. Implementation and acceptance must not replace it
with decimal seconds or a tolerance.

### Representations

`AEGP_SetCompDuration`, `AEGP_GetItemDuration`,
`AEGP_SetCompDisplayStartTime`, `AEGP_GetCompDisplayStartTime` and
`AEGP_GetCompFrameDuration` use `A_Time`:

```text
A_Time.value : signed A_long numerator
A_Time.scale : positive A_u_long ticks per second
seconds      : value / scale
```

The public request represents duration and display start as
`{"value": integer, "scale": positive integer}`. It never accepts a JSON float.
Native results add `secondsRational`, the reduced canonical decimal-free form
already produced by `canonical_seconds_rational` in
`native/ae-plugin/src/aegp/plugin_entry.cpp:9402-9406`.

Frame rate is different. The public request is the exact positive ratio
`numerator / denominator` frames per second. CompSuite12's setter receives
`A_FpLong`, so the native adapter performs the one unavoidable floating
conversion `numerator / denominator` immediately before
`AEGP_SetCompFrameRate`. Readback does not trust that floating value:
`AEGP_GetCompFrameDuration` returns an `A_Time`, and the public frame rate is
the reduced exact reciprocal
`frameDuration.scale / frameDuration.value`, as implemented for the existing
read at `native/ae-plugin/src/aegp/plugin_entry.cpp:9408-9423`.

Pixel aspect uses `A_Ratio` and remains the exact positive
`numerator / denominator` pair. It is not a time, frame count or decimal.

### Equality, normalization, rounding and snapping

Two public/native times are equal by rational cross multiplication:

```text
left.value * right.scale == right.value * left.scale
```

The raw pair need not be byte-identical. For example, `48/24` and `2/1` are the
same two seconds. Returned `secondsRational` must be the reduced canonical form
of the returned pair. No epsilon, stringified float or frame-number comparison
is allowed.

The frozen public contract does **not** silently accept an AE time snap.
Duration and display-start requests must be exactly frame-aligned against the
pre-write `frameDuration`:

```text
requested.value * frameDuration.scale
is divisible by
requested.scale * frameDuration.value
```

Core rejects a non-aligned value before dispatch. AE may normalize an
`A_Time`'s scale or reduce its fraction, but the post-write seconds must remain
rationally equal to the request. If AE returns a different instant, the write
is a reconciled `POSSIBLY_SIDE_EFFECTING_FAILURE`, never a successful “nearest
frame” result.

For duration, Core also proves before dispatch:

```text
workArea.start + workArea.duration <= requested duration
```

This prevents the package from depending on AE's clipping policy. The duration
postcondition requires:

- `after.duration` rationally equals the requested duration;
- `after.workArea` equals `before.workArea` field by field and rationally;
- `after.frameDuration`, `after.frameRate`, `after.displayStartTime`,
  dimensions, pixel aspect, background colour and layer count equal `before`;
  and
- the exact request, typed response, full native readback, independent public
  read and postcondition digest agree.

For frame rate, the adapter must not guess how an arbitrary rational survives
the `A_FpLong` setter. The postcondition requires both:

```text
after.frameRate.numerator * request.denominator
  == request.numerator * after.frameRate.denominator

after.frameDuration.value * after.frameRate.numerator
  == after.frameDuration.scale * after.frameRate.denominator
```

The first proves the host-selected rate equals the requested rational; the
second proves the returned duration is its exact reciprocal. A different
host-selected rate is not rounded into success. The acceptance value is 25/1,
whose binary floating conversion is exact. Support for fractional rates such
as 30000/1001 remains schema-valid only if the T2 normalization corpus in
DONE-WHEN 7 proves the same exact round trip against the pinned host contract;
otherwise Core must reject that ratio before dispatch until a separately
measured policy is frozen. This is the one genuinely host-sensitive rounding
question and is deliberately not guessed here.

The frame-rate postcondition additionally requires duration, work area,
display-start seconds, dimensions, pixel aspect, background and layer count to
remain rationally/structurally unchanged. The subsequent duration write is
then checked against the new frame duration.

For display start, the exact returned time must be rationally equal to the
request. The fixture's keyframes remain at 1, 4 and 7 seconds; they are not
offset by the display origin. The independent keyframe page compares each
`time.value/time.scale` rationally to the fixture recipe. Duration and work
area remain unchanged.

For dimensions and pixel aspect, there is no time conversion. Integer
dimensions compare exactly; ratios compare by cross multiplication and must be
returned in reduced canonical form. Background channels compare as exact
8-bit integers after the native getter conversion. The T2 colour codec test
must establish the AEGP floating-channel-to-8-bit rule; a channel that does not
round-trip exactly is rejected before candidate freeze rather than accepted
with an ad-hoc tolerance.

### Per-tool postcondition target

| Tool | Required target comparison |
| --- | --- |
| dimensions | exact `width` and `height`; every non-target snapshot field unchanged |
| duration | rational duration equality; work area unchanged and still within duration; every other field unchanged |
| frame rate | rational fps equality plus exact reciprocal frame duration; duration/work area seconds and all other fields unchanged |
| pixel aspect | rational equality; dimensions unchanged; expected effective display aspect in the paired case |
| background colour | exact RGBA8 equality; every non-target field unchanged |
| display start | rational time equality; keyframe times, duration/work area and every non-target field unchanged |

## DONE-WHEN 4 — Undo and recovery model

Each public call is one operation/request ID and, where the SDK operation
participates in AE Undo, one
`AEGP_StartUndoGroup("ae-mcp: Set composition …")` /
`AEGP_EndUndoGroup()` pair. Calls are never grouped across public requests.

| Tool | Frozen Undo disposition | State the runner must restore |
| --- | --- | --- |
| dimensions | individually Undoable; one AE group | prior width and height; pixel aspect and all other snapshot fields remain as they were immediately before Undo |
| duration | individually Undoable; one AE group | prior duration and any duration-coupled work-area state; in this fixture work area is unchanged by write and Undo |
| frame rate | individually Undoable; one AE group | prior frame rate and reciprocal frame duration; duration, work area and keyframe seconds unchanged |
| pixel aspect | individually Undoable; one AE group | prior pixel-aspect ratio; dimensions remain at the immediately preceding state |
| background colour | individually Undoable; one AE group | prior RGBA8 background colour only |
| display start time | **not Undoable by AE**; `undo="none"`, no AE Undo group | `undo.available=false` and `undo.verified=false`; the runner uses a labelled compensating public write with a distinct idempotency key to restore the exact prior display start and independently verifies the full postcondition |

The non-Undoable display-start setter is an explicit CompSuite behavior, not a
new mechanism. Its success response reports `undo.available=false` and
`undo.verified=false`; it does not open `AEGP_StartUndoGroup` or
`AEGP_EndUndoGroup`, and does not claim an Undo entry, availability, execution
or restoration. T5/T6 label the second call
`restoreMethod="compensating-public-write"` and never relabel that compensation
as real Undo. Its acceptance records the SDK citation, public request and
response, native and public before/after readback, audit and postcondition
evidence, plus the compensating call's independently verified full
postcondition.

The non-Undoable citation currently rests on the published Adobe After Effects
SDK guide, **not** on the pinned `AE_GeneralPlug.h`: the SDK is
developer-supplied and is not vendored in this repository. T0-T2 must verify
the guide's statement against the pinned header before the package's hardware
acceptance; record that check in the package evidence. Until a hardware run
proves that this exact setter restores the prior state, no real AE Undo may be
reported or inferred from a successful Undo-group call or an Edit-menu label.

For the five Undoable tools, availability and verification are distinct:

1. the write response may report `undoAvailable=true`, `undoVerified=false`;
2. the runner refreshes the AE Edit menu until the expected top Undo label is
   visible;
3. it executes exactly one real AE Undo;
4. it refreshes again until the label changes; and
5. it calls `ae_getCompositionSettings` and compares the full expected
   intermediate snapshot.

If a timeout/disconnect occurs after dispatch, the runner binds the terminal
audit and reads the full composition settings before retrying. It stops
immediately if state or audit cannot reconcile whether a write occurred.

## DONE-WHEN 5 — Disposable fixture and deterministic reset

There is one active `.aep`, classified `ephemeral-validation`, named by the
runner fixture ID rather than by candidate SHA. The deterministic recipe is:

1. create a new project through the existing fixture runner;
2. create root composition `Comp Settings Fixture`:
   - 1920x1080;
   - duration 10/1 seconds;
   - frame rate 24/1;
   - pixel aspect 1/1;
   - opaque background RGBA `(16, 32, 48, 255)`;
   - display start 0/1;
   - work-area start 2/1 and duration 6/1;
3. add one solid named `Timing Witness`;
4. add Opacity keyframes at 1/1, 4/1 and 7/1 seconds with deterministic values;
5. save once to the centralized active-fixture path;
6. close and reopen it from the formal AE process using AE File/Open;
7. open `Comp Settings Fixture` in the active Composition viewer, because
   `ae_previewFrame` omits `comp_id` and therefore targets the active comp; and
8. obtain fresh locators and verify the complete recipe through public reads.

Reset never uses Save As and never creates another `.aep`. With reconciled
state, it repeatedly Undoes to the saved baseline or closes without saving and
reopens the same active fixture. If the baseline cannot be proven, the runner
closes the fixture, deterministically rebuilds that same active path, and
re-verifies the recipe. After structured evidence extraction, it moves the one
fixture to short-lived recovery and clears the active slot. Expected counts per
T5/T6 session are: created `1`, canonical retained `0`, evidence snapshots
retained `0`, archived `1`, unclassified `0`, Save As copies `0`.

## DONE-WHEN 7 — T0-T2 gates before hardware

Candidate freeze is blocked until these named tests exist and pass. The names
are the frozen design targets; implementation may place shared cases in the
nearest existing test file but must preserve one-to-one coverage in the test
IDs.

### T0 — every edit

- `test_comp_settings_generated_descriptors_are_current`
- `test_comp_settings_protocol_json_is_syntax_valid`
- formatting/lint for touched Core, protocol, native and runner files

### T1 — each adapter/tool

- `test_comp_settings_public_tool_names_and_closed_input_schemas`: asserts the
  six exact exposed names, snake_case model inputs, required fields, bounds,
  no floats and no extra properties.
- `test_comp_settings_public_success_shapes_round_trip`: parses positive
  descriptor examples through native codec, Core model and the public response
  for all six tools; verifies `value.before/after`, provenance, audit and
  evidence types. This is the direct guard for #157's **typed-shape surprise**.
- `test_comp_settings_native_error_shapes_preserve_side_effect`: covers
  invalid, stale, deadline, duplicate and possibly-side-effecting outcomes.
- `test_comp_settings_postcondition_rejects_adjacent_state_drift`: mutates one
  non-target field in each after snapshot and requires failure.
- `test_comp_settings_idempotent_replay_is_byte_stable`: same key/request
  returns the same transition/evidence and never dispatches twice.
- `test_preview_frame_registration_and_tools_list_exposure`: proves
  `ae.previewFrame` remains in `HANDLERS` and `ae_previewFrame` is emitted by
  the actual `tools/list` path with the visual-loop/privacy guidance.
- `test_preview_frame_mcp_content_decodes_at_reported_dimensions`: calls the
  public dispatch boundary, preserves item 0's JSON shape, decodes every
  following `ImageContent` item as PNG, and verifies dimensions and SHA-256.

### T2 — package integration and runner

- `test_comp_settings_time_dimension_contract`: a table-driven corpus for
  equivalent/non-equivalent `A_Time`, negative display starts, positive
  durations, frame alignment, overflow-safe cross multiplication, work-area
  end checks, reciprocal frame duration and ratio reduction. This is the
  direct guard for #157's **time-dimensionality surprise**.
- `test_comp_settings_frame_rate_fp_round_trip_policy`: proves 24/1 and 25/1
  exactly and records whether 30000/1001 survives the pinned A_FpLong/host
  normalization. If the fractional case is genuinely not knowable without a
  one-time measurement, the test must encode the measured pinned-host result
  before candidate freeze and the public pre-dispatch allow/reject policy must
  match it. T5 is not the place to discover or redefine this behavior.
- `test_comp_settings_color_codec_round_trip`: proves the exact RGBA8 to
  `AEGP_ColorVal` to RGBA8 mapping for boundary and fixture colours; no
  tolerance is invented.
- `test_comp_settings_interaction_corpus`: runs the frozen frame
  rate/duration/work-area, dimensions/pixel-aspect and display-start/keyframe
  combinations against a stateful fake host and asserts every intermediate
  snapshot.
- `test_comp_settings_runner_refreshes_undo_menu_before_and_after_click`:
  simulates a stale menu label, delayed refresh, expected label, click and
  post-click label transition; the runner must not click stale coordinates.
  This is the direct guard for #157's **Undo-menu-refresh surprise**.
- `test_comp_settings_runner_records_nonundoable_display_start_restore`:
  requires no Undo group or Undo claim, `undo.available=false`,
  `undo.verified=false`, a labelled second public call with a distinct
  idempotency key, and its independently verified restored full postcondition.
- `test_comp_settings_display_start_nonundoable_citation_matches_pinned_header`:
  before hardware acceptance, records the developer-supplied pinned-header
  check against the published SDK guide citation; it fails if the rule is not
  verified during T0-T2.
- `test_comp_settings_runner_restart_reacquires_state`: serializes the
  checkpoint, changes host/session/generation, reopens the same fixture through
  formal AE, reacquires every locator, re-verifies the baseline and resumes
  only from the last verified case. This is the direct guard for #157's
  **restart-state surprise**.
- `test_comp_settings_runner_call_budget_is_twenty_eight`: counts the original
  20 support/package/restore/Undo-readback calls, four amended
  `ae_previewFrame` calls and four required post-preview locator reacquisitions;
  it remains within the default 30-call ceiling and fails before call 29.
- `test_preview_invalidates_locators_until_project_items_reacquires_them`:
  dynamically walks both plans and fails if any locator consumer follows a
  preview without the relevant locator first being produced by a fresh public
  read. Its mutation case removes one reacquisition and must fail.
- `test_comp_settings_fixture_reset_is_single_slot`: proves no Save As,
  deterministic same-path rebuild, reconciliation before reset and final
  lifecycle counts.
- affected native compile, protocol golden, Core/CEP integration and generated
  descriptor checks.

The unknown fractional-frame-rate normalization and colour quantization
questions are explicitly lower-tier contract inputs. They must be settled and
encoded before candidate freeze; implementation may narrow semantic
acceptance, but must not guess at T5 or weaken exact postconditions into
tolerances.

## DONE-WHEN 6 — Executable T5 and T6 acceptance

Every package call must produce:

```text
public request
-> Core typed handler
-> native RPC descriptor/capability
-> AEGP main-thread setter
-> complete same-suite/item-suite before/after readback
-> typed public value
-> native provenance
-> terminal audit
-> verified postcondition digest
```

T5 and T6 use **distinct plans**, per section 8 of
`docs/CAPABILITY_PACKAGE_WORKFLOW.md`. T5 is the full candidate acceptance at 28
public calls — within the default 30-call ceiling, so this brief claims no
authorization to exceed it. T6 is the clean-`main` replay at 17 calls, skipping
`ae_setCompositionFrameRate`, `ae_setCompositionDuration` and
`ae_setCompositionPixelAspectRatio`, each replayed by
`ae_setCompositionDimensions`, and each recording the grounds that permit the
skip.

Both plans are frozen in `scripts/hardware/composition_settings_spec.py` as
`T5_CALL_PLAN` and `T6_CALL_PLAN`, with `T6_SKIPS` carrying the per-tool
justification. The spec is the executable contract: where this prose and the
spec disagree, the spec wins and this section is the defect.

The settings script below is the T5 plan, with the four `ae_previewFrame` calls
placed at the checkpoints defined by the #177 amendment above:

| Call | Public tool | Purpose |
| ---: | --- | --- |
| 1 | `ae_listProjectItems` | fresh composition locator |
| 2 | `ae_getCompositionSettings` | full deterministic baseline |
| 3 | `ae_previewFrame` | baseline 1920x1080/background visual proof |
| 4 | `ae_listProjectItems` | reacquire after preview invalidates native locators |
| 5 | `ae_listCompositionLayers` | fresh timing-witness layer locator |
| 6 | `ae_listLayerProperties` | locate Transform group |
| 7 | `ae_listLayerProperties` | locate Opacity property |
| 8 | `ae_setCompositionDisplayStartTime` | set -1/1; non-Undoable write, no AE Undo group, `undo.available=false`, `undo.verified=false` |
| 9 | `ae_getCompositionSettings` | display origin changed, other settings stable |
| 10 | `ae_listLayerPropertyKeyframes` | keyframe times remain 1/1, 4/1, 7/1 |
| 11 | `ae_setCompositionDisplayStartTime` | labelled `compensating-public-write` restore to 0/1 with new key; independently verify full postcondition |
| 12 | `ae_setCompositionFrameRate` | 24/1 -> 25/1 |
| 13 | `ae_setCompositionDuration` | 10/1 -> 8/1 after new frame duration |
| 14 | `ae_setCompositionDimensions` | 1920x1080 -> 1440x1080 |
| 15 | `ae_setCompositionPixelAspectRatio` | 1/1 -> 4/3 |
| 16 | `ae_setCompositionBackgroundColor` | `(16,32,48,255)` -> `(64,96,128,255)` |
| 17 | `ae_getCompositionSettings` | verify all paired/combined interactions |
| 18 | `ae_previewFrame` | changed 1440x1080/background visual proof |
| 19 | `ae_listProjectItems` | reacquire after preview invalidates native locators |
| 20 | `ae_getCompositionSettings` | after real Undo background |
| 21 | `ae_previewFrame` | restored-background visual proof |
| 22 | `ae_listProjectItems` | reacquire after preview invalidates native locators |
| 23 | `ae_getCompositionSettings` | after real Undo pixel aspect |
| 24 | `ae_getCompositionSettings` | after real Undo dimensions |
| 25 | `ae_previewFrame` | restored-dimensions visual proof |
| 26 | `ae_listProjectItems` | reacquire after preview invalidates native locators |
| 27 | `ae_getCompositionSettings` | after real Undo duration |
| 28 | `ae_getCompositionSettings` | after real Undo frame rate; baseline restored |

Between calls 17-28, the runner performs the five real AE Undo UI actions
described in DONE-WHEN 4; GUI actions are evidence events, not public MCP calls.
Call 28 must equal call 2 in every settings field, and the display-start
compensation at call 11 must already have restored that field. Each write's
embedded full native readback proves its immediate result; calls 17-28 provide
independent public state verification and exact intermediate Undo states.

T5 is **28 public calls, hard stop before call 29**: the original 20-call
settings sequence, four image-bearing `ae_previewFrame` checks, and four
post-preview locator reacquisitions. T6 is an independent **17-call** plan:
its original 14 selective-replay calls plus three reacquisitions after the
previews that still have later locator consumers. Its final preview remains the
terminal call and needs no otherwise-unused reacquisition.
Preflight produces no candidate evidence. Planned T4 count is zero because
CompSuite12, locator reacquisition, main-thread dispatch, setter invocation,
readback, audit and Undo-group machinery are already hardware-proven. T6
rebuilds/reinstalls clean `main`, reopens the deterministic fixture from formal
AE, reacquires locators and executes its selective plan rather than reusing the
T5 installation.

Per tool, acceptance requires:

- request and success response validate against DONE-WHEN 1;
- `implementation.engine="native-aegp"` and the exact capability ID agree;
- source/build receipt, host/session and protocol provenance are present;
- `value.before`, `value.after`, audit and postcondition digest agree;
- the DONE-WHEN 3 target and non-target comparisons pass;
- for five Undoable tools, one real Undo restores the exact intermediate
  snapshot; and
- for display start, no AE Undo group or Undo claim occurs,
  `undo.available=false`, `undo.verified=false`, and the labelled separate
  compensating public write restores the baseline with an independently
  verified full postcondition without being called Undo.

## DONE-WHEN 8 — Deferred follow-ups

These findings are settled scope inputs, not questions for this package.

### Shutter angle and phase

Pinned SDK evidence:
`ae25.6_61.64bit.AfterEffectsSDK/Examples/Headers/AE_GeneralPlug.h`,
lines 710-713 contain the `AEGP_CompSuite12` member
`AEGP_GetCompShutterAnglePhase(AEGP_CompH, A_Ratio*, A_Ratio*)`.
The symbol is present as a getter; there is no corresponding
`AEGP_SetCompShutterAnglePhase` member in the complete CompSuite12 declaration
at lines 652-862.

Reaching this setting requires a new native mutation mechanism outside
CompSuite12 (or a later SDK suite that exposes a setter), followed by its own
provenance, audit, postcondition, Undo and real-AE lifecycle proof. It is not a
schema-only addition.

### Preserve nested frame rate

Pinned SDK evidence:
`ae25.6_61.64bit.AfterEffectsSDK/Examples/Headers/AE_GeneralPlug.h`, complete
`AEGP_CompSuite12` declaration at lines 652-862: no member line names
preserve-nested-frame-rate, preserve-frame-rate, nested-frame-rate, or an
equivalent get/set operation.

Reaching this setting requires discovering and proving a different native SDK
suite or another genuinely native execution primitive, then defining its
readback and Undo behavior. That native novelty is explicitly outside this
zero-novelty package.

## DONE-WHEN 9 — Explicit non-goals

- shutter angle or shutter phase;
- preserve nested frame rate;
- motion-blur sample count, adaptive sample limit, composition flags,
  downsample factor, drop-frame display, work-area editing or current-time
  editing;
- bulk/patch composition settings;
- changing existing keyframe values or times;
- automatic work-area clipping, duration truncation or accepting nearest-frame
  snaps;
- expanding fractional-frame-rate support without the frozen T2 policy;
- JSX routing or fallback;
- a new native suite, resolver, locator, dispatcher, main-thread mechanism,
  authentication/pairing mechanism or fixture framework;
- Windows expansion, signing, notarization, installer or RuntimeManager
  hardening;
- implementation, handler/schema/native code or tests in this design commit;
- GitHub Issue/PR creation, backlog mutation, push, merge or hardware work.
