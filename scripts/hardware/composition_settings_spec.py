#!/usr/bin/env python3
"""Frozen Composition Settings plus previewFrame T5/T6 specifications.

Every package expectation is bound to the public Pydantic schema and either
the negotiated native capability contract or the preview handler source.  The
plans are deliberately package-owned; this is not a general plan language.
"""

from __future__ import annotations

import dataclasses
import hashlib
import inspect
from collections.abc import Mapping
from typing import Any, Literal

from ae_mcp import schemas, server
from ae_mcp.backends import native_project_composition as project_composition
from ae_mcp.handlers import core as core_handlers
from capability_package_runtime import PackageSpec, ToolCase, json_hash, require


BRIEF_SOURCE = "docs/capability-packages/comp-settings.md:1-1083"
SCHEMA_SOURCE = "packages/core/ae_mcp/schemas.py:656-714,846-910,1076-1133,1480-1519"
NATIVE_HANDLER_SOURCE = "packages/core/ae_mcp/handlers/native.py:1184-1239,1340-1435,2375-2404"
NATIVE_CONTRACT_SOURCE = (
    "packages/core/ae_mcp/backends/native_project_composition.py:"
    "278-428,1033-1160,1586-1712"
)
PREVIEW_HANDLER_SOURCE = (
    "packages/core/ae_mcp/handlers/core.py:518-792;"
    "packages/core/ae_mcp/server.py:309-359,1498-1522"
)
T6_POLICY_SOURCE = "docs/CAPABILITY_PACKAGE_WORKFLOW.md:151-179"
T4_REQUIRED = False
NO_T4_REASON = (
    "All six writes use already-proven AEGP_CompSuite12 settings machinery and "
    "previewFrame changes only Core MCP content packaging; no new native "
    "primitive, lifecycle rule, suite, or main-thread mechanism is introduced."
)

NORMAL_WORKFLOW_CALL_CEILING = 30
T5_CALL_JUSTIFICATION = {
    "toolCount": 7,
    "packageWrites": 6,
    "previewReads": 4,
    "supportAndIndependentReadbacks": 18,
    "totalCalls": 28,
    "normalWorkflowCeiling": NORMAL_WORKFLOW_CALL_CEILING,
    "withinDefaultCeiling": True,
    "reason": (
        "The six settings tools require one combined interaction sequence, five "
        "intermediate Undo readbacks, one compensating display-start write, "
        "fixture address discovery, four image-bearing preview checkpoints, and "
        "four project-item reads that reacquire locators after previewFrame "
        "invalidates the native project graph generation. Exactly 28 calls fit "
        "under the default 30-call ceiling; no extra authorization or invented "
        "headroom is used."
    ),
    "sources": (BRIEF_SOURCE, T6_POLICY_SOURCE),
}

FIXTURE_RECIPE = (
    "Create exactly one ephemeral-validation project at the active fixture path.",
    (
        "Create root composition Comp Settings Fixture at 1920x1080, duration "
        "10/1, frame rate 24/1, pixel aspect 1/1, background RGBA "
        "(16,32,48,255), display start 0/1, and work area start 2/1 duration 6/1."
    ),
    (
        "Add exactly one solid named Timing Witness, leaving a deterministic "
        "background sample area unobscured."
    ),
    (
        "Add Timing Witness Opacity keyframes at exact composition times 1/1, "
        "4/1, and 7/1 with deterministic values."
    ),
    "Save once in place; never use Save As and never create a second .aep.",
    (
        "Close and reopen the same fixture from formal After Effects through "
        "AE File > Open, then obtain only fresh public locators."
    ),
    (
        "After evidence extraction archive the one fixture to short-lived "
        "recovery: created 1, canonical 0, snapshots 0, archived 1, "
        "unclassified 0, Save As copies 0."
    ),
)


@dataclasses.dataclass(frozen=True)
class ContractExpectation:
    public_tool: str
    registry_name: str
    kind: Literal["read", "write"]
    capability_id: str
    input_schema_sha256: str
    contract_digest: str
    engine: Literal["native-aegp", "preview-mcp-content"]
    undo: Literal["ae-undo-group", "none", "not-applicable"]
    sources: tuple[str, ...]


_WRITE_CAPABILITIES = {
    "ae.setCompositionDimensions":
        project_composition.COMPOSITION_DIMENSIONS_SET_CAPABILITY_ID,
    "ae.setCompositionDuration":
        project_composition.COMPOSITION_DURATION_SET_CAPABILITY_ID,
    "ae.setCompositionFrameRate":
        project_composition.COMPOSITION_FRAME_RATE_SET_CAPABILITY_ID,
    "ae.setCompositionPixelAspectRatio":
        project_composition.COMPOSITION_PIXEL_ASPECT_RATIO_SET_CAPABILITY_ID,
    "ae.setCompositionBackgroundColor":
        project_composition.COMPOSITION_BACKGROUND_COLOR_SET_CAPABILITY_ID,
    "ae.setCompositionDisplayStartTime":
        project_composition.COMPOSITION_DISPLAY_START_TIME_SET_CAPABILITY_ID,
}

_PUBLISHED_SCHEMA_MODELS = {
    "ae.getCompositionSettings": schemas.AeGetCompositionSettingsArgs,
    "ae.setCompositionDimensions": schemas.AeSetCompositionDimensionsArgs,
    "ae.setCompositionDuration": schemas.AeSetCompositionDurationArgs,
    "ae.setCompositionFrameRate": schemas.AeSetCompositionFrameRateArgs,
    "ae.setCompositionPixelAspectRatio":
        schemas.AeSetCompositionPixelAspectRatioArgs,
    "ae.setCompositionBackgroundColor":
        schemas.AeSetCompositionBackgroundColorArgs,
    "ae.setCompositionDisplayStartTime":
        schemas.AeSetCompositionDisplayStartTimeArgs,
}


def _published_schema(registry_name: str) -> type:
    if registry_name in _PUBLISHED_SCHEMA_MODELS:
        return _PUBLISHED_SCHEMA_MODELS[registry_name]
    return schemas.SCHEMAS[registry_name]


def _native_expectation(registry_name: str) -> ContractExpectation:
    capability_id = _WRITE_CAPABILITIES[registry_name]
    contract = project_composition.CAPABILITY_CONTRACTS[capability_id]
    return ContractExpectation(
        public_tool=registry_name.replace(".", "_"),
        registry_name=registry_name,
        kind="write",
        capability_id=capability_id,
        input_schema_sha256=json_hash(
            _published_schema(registry_name).model_json_schema()
        ),
        contract_digest=contract.contract_digest,
        engine="native-aegp",
        undo=(
            "none"
            if capability_id
            == project_composition.COMPOSITION_DISPLAY_START_TIME_SET_CAPABILITY_ID
            else "ae-undo-group"
        ),
        sources=(SCHEMA_SOURCE, NATIVE_HANDLER_SOURCE, NATIVE_CONTRACT_SOURCE),
    )


def _preview_contract_digest() -> str:
    """Bind the executable plan to both PNG production and MCP packaging."""

    return hashlib.sha256(
        (
            inspect.getsource(core_handlers._run_preview_frame)
            + "\0"
            + inspect.getsource(server._preview_frame_content)
        ).encode("utf-8")
    ).hexdigest()


def _preview_expectation() -> ContractExpectation:
    registry_name = "ae.previewFrame"
    return ContractExpectation(
        public_tool="ae_previewFrame",
        registry_name=registry_name,
        kind="read",
        capability_id="ae.preview-frame.mcp-image-content",
        input_schema_sha256=json_hash(
            _published_schema(registry_name).model_json_schema()
        ),
        contract_digest=_preview_contract_digest(),
        engine="preview-mcp-content",
        undo="not-applicable",
        sources=(SCHEMA_SOURCE, PREVIEW_HANDLER_SOURCE, BRIEF_SOURCE),
    )


CONTRACTS = {
    expectation.public_tool: expectation
    for expectation in (
        *(_native_expectation(name) for name in _WRITE_CAPABILITIES),
        _preview_expectation(),
    )
}

SUPPORT_SCHEMAS = {
    name.replace(".", "_"): {
        "registryName": name,
        "inputSchemaSha256": json_hash(_published_schema(name).model_json_schema()),
        "source": SCHEMA_SOURCE,
    }
    for name in (
        "ae.listProjectItems",
        "ae.getCompositionSettings",
        "ae.listCompositionLayers",
        "ae.listLayerProperties",
        "ae.listLayerPropertyKeyframes",
    )
}

EVIDENCE_BY_TOOL = {
    "ae_setCompositionDimensions": {
        "readback": True,
        "visual": True,
        "reason": "PNG decoded dimensions independently show the visible canvas size.",
        "source": BRIEF_SOURCE,
    },
    "ae_setCompositionDuration": {
        "readback": True,
        "visual": False,
        "reason": "A still frame cannot establish composition duration.",
        "source": BRIEF_SOURCE,
    },
    "ae_setCompositionFrameRate": {
        "readback": True,
        "visual": False,
        "reason": (
            "A still PNG requested in decimal seconds cannot independently "
            "establish a rational frame rate or reciprocal frame duration."
        ),
        "source": BRIEF_SOURCE,
    },
    "ae_setCompositionPixelAspectRatio": {
        "readback": True,
        "visual": False,
        "reason": "The package proves the exact ratio and display-aspect equation by readback.",
        "source": BRIEF_SOURCE,
    },
    "ae_setCompositionBackgroundColor": {
        "readback": True,
        "visual": True,
        "reason": "The decoded PNG must contain the unobscured exact background colour.",
        "source": BRIEF_SOURCE,
    },
    "ae_setCompositionDisplayStartTime": {
        "readback": True,
        "visual": False,
        "reason": "A still frame cannot establish the timeline display origin.",
        "source": BRIEF_SOURCE,
    },
    "ae_previewFrame": {
        "readback": False,
        "visual": True,
        "reason": (
            "Image content corroborates dimensions and background only; it "
            "never substitutes for a settings or keyframe postcondition."
        ),
        "source": BRIEF_SOURCE,
    },
}


@dataclasses.dataclass(frozen=True)
class PlanCall:
    ordinal: int
    key: str
    tool: str
    arguments: Mapping[str, Any]
    disposition: Literal["read", "write"]
    state_assertion: str
    undo_of: str | None = None
    restore_method: str | None = None


def _call(
    key: str,
    tool: str,
    arguments: Mapping[str, Any],
    disposition: Literal["read", "write"],
    state_assertion: str,
    *,
    undo_of: str | None = None,
    restore_method: str | None = None,
) -> PlanCall:
    return PlanCall(
        0, key, tool, arguments, disposition, state_assertion,
        undo_of, restore_method,
    )


_PREVIEW = {"time": 0.0, "include_base64": False, "scale": 1.0}
_T5_ROWS = (
    _call("composition-reacquire", "ae_listProjectItems", {"offset": 0, "limit": 50},
          "read", "Acquire the named fixture composition through a public native read."),
    _call("baseline-settings", "ae_getCompositionSettings",
          {"composition_locator": "$composition_locator"}, "read",
          "Verify the complete frozen baseline settings snapshot."),
    _call("baseline-preview", "ae_previewFrame", _PREVIEW, "read",
          "Decode a 1920x1080 PNG containing the baseline background colour."),
    _call("baseline-preview-reacquire", "ae_listProjectItems",
          {"offset": 0, "limit": 50}, "read",
          "Reacquire the composition after preview invalidates native locators."),
    _call("timing-layers", "ae_listCompositionLayers",
          {"composition_locator": "$composition_locator", "offset": 0, "limit": 25},
          "read", "Locate exactly the Timing Witness layer."),
    _call("transform-group", "ae_listLayerProperties",
          {"layer_locator": "$timing_layer_locator", "offset": 0, "limit": 25},
          "read", "Locate the Timing Witness Transform group."),
    _call("opacity-property", "ae_listLayerProperties", {
        "layer_locator": "$timing_layer_locator",
        "parent_property_locator": "$transform_property_locator",
        "offset": 0, "limit": 25,
    }, "read", "Locate the Timing Witness Opacity leaf."),
    _call("display-start-set", "ae_setCompositionDisplayStartTime", {
        "composition_locator": "$composition_locator",
        "display_start_time": {"value": -1, "scale": 1},
        "idempotency_key": "$operation_key:display-start-set",
    }, "write", "Set display start to -1 exactly with no AE Undo group."),
    _call("display-start-read", "ae_getCompositionSettings",
          {"composition_locator": "$composition_locator"}, "read",
          "Independently verify only display start changed."),
    _call("timing-keyframes", "ae_listLayerPropertyKeyframes",
          {"property_locator": "$opacity_property_locator", "offset": 0, "limit": 25},
          "read", "Verify keyframes remain at exact comp times 1, 4, and 7 seconds."),
    _call("display-start-compensate", "ae_setCompositionDisplayStartTime", {
        "composition_locator": "$composition_locator",
        "display_start_time": {"value": 0, "scale": 1},
        "idempotency_key": "$operation_key:display-start-compensate",
    }, "write", "Restore display start to 0 with a separate verified public write.",
          restore_method="compensating-public-write"),
    _call("frame-rate-set", "ae_setCompositionFrameRate", {
        "composition_locator": "$composition_locator",
        "frame_rate": {"numerator": 25, "denominator": 1},
        "idempotency_key": "$operation_key:frame-rate-set",
    }, "write", "Set exact frame rate 25/1 and reciprocal frame duration 1/25."),
    _call("duration-set", "ae_setCompositionDuration", {
        "composition_locator": "$composition_locator",
        "duration": {"value": 8, "scale": 1},
        "idempotency_key": "$operation_key:duration-set",
    }, "write", "Set duration to the unchanged work-area end after the rate write."),
    _call("dimensions-set", "ae_setCompositionDimensions", {
        "composition_locator": "$composition_locator",
        "width": 1440, "height": 1080,
        "idempotency_key": "$operation_key:dimensions-set",
    }, "write", "Set exact 1440x1080 dimensions."),
    _call("pixel-aspect-set", "ae_setCompositionPixelAspectRatio", {
        "composition_locator": "$composition_locator",
        "pixel_aspect_ratio": {"numerator": 4, "denominator": 3},
        "idempotency_key": "$operation_key:pixel-aspect-set",
    }, "write", "Set 4/3 pixels and preserve effective 16:9 display aspect."),
    _call("background-set", "ae_setCompositionBackgroundColor", {
        "composition_locator": "$composition_locator",
        "background_color": {"red": 64, "green": 96, "blue": 128, "alpha": 255},
        "idempotency_key": "$operation_key:background-set",
    }, "write", "Set the exact visible RGBA8 background."),
    _call("combined-read", "ae_getCompositionSettings",
          {"composition_locator": "$composition_locator"}, "read",
          "Verify every paired interaction and the complete combined state."),
    _call("combined-preview", "ae_previewFrame", _PREVIEW, "read",
          "Decode 1440x1080 PNG containing the changed background."),
    _call("combined-preview-reacquire", "ae_listProjectItems",
          {"offset": 0, "limit": 50}, "read",
          "Reacquire the composition after preview invalidates native locators."),
    _call("background-undo-read", "ae_getCompositionSettings",
          {"composition_locator": "$composition_locator"}, "read",
          "After one real Undo, only background is restored.", undo_of="background-set"),
    _call("background-undo-preview", "ae_previewFrame", _PREVIEW, "read",
          "Decode 1440x1080 PNG containing the baseline background."),
    _call("background-undo-preview-reacquire", "ae_listProjectItems",
          {"offset": 0, "limit": 50}, "read",
          "Reacquire the composition after preview invalidates native locators."),
    _call("pixel-aspect-undo-read", "ae_getCompositionSettings",
          {"composition_locator": "$composition_locator"}, "read",
          "After one real Undo, only pixel aspect is additionally restored.",
          undo_of="pixel-aspect-set"),
    _call("dimensions-undo-read", "ae_getCompositionSettings",
          {"composition_locator": "$composition_locator"}, "read",
          "After one real Undo, dimensions are additionally restored.",
          undo_of="dimensions-set"),
    _call("dimensions-undo-preview", "ae_previewFrame", _PREVIEW, "read",
          "Decode 1920x1080 PNG containing the already-restored background."),
    _call("dimensions-undo-preview-reacquire", "ae_listProjectItems",
          {"offset": 0, "limit": 50}, "read",
          "Reacquire the composition after preview invalidates native locators."),
    _call("duration-undo-read", "ae_getCompositionSettings",
          {"composition_locator": "$composition_locator"}, "read",
          "After one real Undo, duration is additionally restored.",
          undo_of="duration-set"),
    _call("frame-rate-undo-read", "ae_getCompositionSettings",
          {"composition_locator": "$composition_locator"}, "read",
          "After one real Undo, the complete baseline is restored.",
          undo_of="frame-rate-set"),
)
T5_CALL_PLAN = tuple(
    dataclasses.replace(row, ordinal=index)
    for index, row in enumerate(_T5_ROWS, 1)
)

_T6_KEYS = (
    "composition-reacquire",
    "baseline-settings",
    "baseline-preview",
    "baseline-preview-reacquire",
    "display-start-set",
    "display-start-read",
    "display-start-compensate",
    "dimensions-set",
    "background-set",
    "combined-read",
    "combined-preview",
    "combined-preview-reacquire",
    "background-undo-read",
    "background-undo-preview",
    "background-undo-preview-reacquire",
    "dimensions-undo-read",
    "dimensions-undo-preview",
)
_T5_BY_KEY = {row.key: row for row in T5_CALL_PLAN}
T6_CALL_PLAN = tuple(
    dataclasses.replace(_T5_BY_KEY[key], ordinal=index)
    for index, key in enumerate(_T6_KEYS, 1)
)

T6_REPLAY_GROUNDS = {
    "new-native-primitive-first-clean-build": (),
    "representative-shared-proven-primitive-family": (
        "ae_setCompositionDimensions",
        "ae_setCompositionDisplayStartTime",
        "ae_previewFrame",
    ),
    "changed-after-candidate": (),
    "install-staging-generated-bundle-component-identity": (
        "session-component-receipts",
        "ae_previewFrame",
    ),
    "distinct-undo-model": (
        "native-composition-setting-ae-undo-group",
        "native-composition-display-start-compensating-write",
    ),
}

_SKIP_GROUNDS = (
    "shared primitive",
    "shared Undo model",
    "shared locator scheme",
    "byte-identical to the candidate",
)
T6_SKIPS = {
    "ae_setCompositionFrameRate": {
        "replayedBy": "ae_setCompositionDimensions",
        "grounds": _SKIP_GROUNDS,
        "detail": "thin CompSuite12 setting adapter already proven at T5",
        "sources": (T6_POLICY_SOURCE, NATIVE_HANDLER_SOURCE, NATIVE_CONTRACT_SOURCE),
    },
    "ae_setCompositionDuration": {
        "replayedBy": "ae_setCompositionDimensions",
        "grounds": _SKIP_GROUNDS,
        "detail": "thin CompSuite12 setting adapter already proven at T5",
        "sources": (T6_POLICY_SOURCE, NATIVE_HANDLER_SOURCE, NATIVE_CONTRACT_SOURCE),
    },
    "ae_setCompositionPixelAspectRatio": {
        "replayedBy": "ae_setCompositionDimensions",
        "grounds": _SKIP_GROUNDS,
        "detail": "thin CompSuite12 setting adapter already proven at T5",
        "sources": (T6_POLICY_SOURCE, NATIVE_HANDLER_SOURCE, NATIVE_CONTRACT_SOURCE),
    },
}


@dataclasses.dataclass(frozen=True)
class AddressLink:
    consumer_call: int
    consumer_field: str
    producer_call: int
    producer_path: str


_ADDRESS_FIELDS = {
    "composition_locator",
    "layer_locator",
    "parent_property_locator",
    "property_locator",
}


def _symbolic_addresses(
    value: Any, *, field: str = ""
) -> tuple[tuple[str, str], ...]:
    if (
        isinstance(value, str)
        and value.startswith("$")
        and not value.startswith("$operation_key:")
    ):
        return ((field, value[1:]),) if field in _ADDRESS_FIELDS else ()
    if isinstance(value, Mapping):
        return tuple(
            address
            for key, item in value.items()
            for address in _symbolic_addresses(item, field=key)
        )
    if isinstance(value, (list, tuple)):
        return tuple(
            address
            for item in value
            for address in _symbolic_addresses(item, field=field)
        )
    return ()


_PRODUCERS = {
    "composition_locator": {
        "composition-reacquire": "value.items[Comp Settings Fixture].locator",
        "baseline-preview-reacquire":
            "value.items[Comp Settings Fixture].locator",
        "combined-preview-reacquire":
            "value.items[Comp Settings Fixture].locator",
        "background-undo-preview-reacquire":
            "value.items[Comp Settings Fixture].locator",
        "dimensions-undo-preview-reacquire":
            "value.items[Comp Settings Fixture].locator",
        "baseline-settings": "value.compositionLocator",
        "timing-layers": "value.compositionLocator",
        "display-start-set": "value.compositionLocator",
        "display-start-read": "value.compositionLocator",
        "display-start-compensate": "value.compositionLocator",
        "frame-rate-set": "value.compositionLocator",
        "duration-set": "value.compositionLocator",
        "dimensions-set": "value.compositionLocator",
        "pixel-aspect-set": "value.compositionLocator",
        "background-set": "value.compositionLocator",
        "combined-read": "value.compositionLocator",
        "background-undo-read": "value.compositionLocator",
        "pixel-aspect-undo-read": "value.compositionLocator",
        "dimensions-undo-read": "value.compositionLocator",
        "duration-undo-read": "value.compositionLocator",
        "frame-rate-undo-read": "value.compositionLocator",
    },
    "timing_layer_locator": {
        "timing-layers": "value.layers[Timing Witness].locator",
        "transform-group": "value.layerLocator",
        "opacity-property": "value.layerLocator",
    },
    "transform_property_locator": {
        "transform-group": "value.properties[ADBE Transform Group].propertyLocator",
    },
    "opacity_property_locator": {
        "opacity-property": "value.properties[ADBE Opacity].propertyLocator",
        "timing-keyframes": "value.propertyLocator",
    },
}


def _preview_locator_violations(
    plan: tuple[PlanCall, ...],
) -> tuple[str, ...]:
    """Return consumers that reuse a locator invalidated by previewFrame."""

    stale = set[str]()
    violations: list[str] = []
    for row in plan:
        for field, context_key in _symbolic_addresses(row.arguments):
            if context_key in stale:
                violations.append(
                    f"{row.key}.{field} reuses stale ${context_key}"
                )
        for context_key, producers in _PRODUCERS.items():
            if row.key in producers:
                stale.discard(context_key)
        if row.tool == "ae_previewFrame":
            stale.update(_PRODUCERS)
    return tuple(violations)


def _derive_address_links(
    plan: tuple[PlanCall, ...],
) -> tuple[AddressLink, ...]:
    latest: dict[str, tuple[int, str]] = {}
    links: list[AddressLink] = []
    for row in plan:
        for field, context_key in _symbolic_addresses(row.arguments):
            require(
                context_key in latest,
                f"{row.key} consumes ${context_key} before this plan produces it",
            )
            producer_call, producer_path = latest[context_key]
            links.append(
                AddressLink(row.ordinal, field, producer_call, producer_path)
            )
        for context_key, producers in _PRODUCERS.items():
            if row.key in producers:
                latest[context_key] = (row.ordinal, producers[row.key])
    return tuple(links)


T5_ADDRESS_LINKS = _derive_address_links(T5_CALL_PLAN)
T6_ADDRESS_LINKS = _derive_address_links(T6_CALL_PLAN)

PACKAGE_TOOLS = tuple(CONTRACTS)
SPEC = PackageSpec(
    issue=187,
    slug="composition-settings-preview-frame",
    title="Composition Settings plus previewFrame",
    native_novelty=False,
    # PackageSpec predates zero-T4 packages and requires a positive placeholder.
    # T4_REQUIRED above and the driver mode guard are the governing declaration.
    t4_target_calls=1,
    t4_hard_limit=1,
    t5_target_calls=len(T5_CALL_PLAN),
    t5_hard_limit=len(T5_CALL_PLAN),
    t6_target_calls=len(T6_CALL_PLAN),
    t6_hard_limit=len(T6_CALL_PLAN),
    tools=tuple(
        ToolCase(
            expectation.registry_name.removeprefix("ae.").replace(".", "-"),
            public_tool,
            expectation.capability_id,
            expectation.kind,
            max(
                sum(row.tool == public_tool for row in T5_CALL_PLAN),
                sum(row.tool == public_tool for row in T6_CALL_PLAN),
            ),
        )
        for public_tool, expectation in CONTRACTS.items()
    ),
    support_tools=(
        ToolCase(
            "items", "ae_listProjectItems", "ae.project.items.list", "read", 5,
        ),
        ToolCase(
            "settings", "ae_getCompositionSettings",
            project_composition.COMPOSITION_SETTINGS_READ_CAPABILITY_ID, "read", 8,
        ),
        ToolCase(
            "layers", "ae_listCompositionLayers",
            "ae.composition.layers.list", "read",
        ),
        ToolCase(
            "properties", "ae_listLayerProperties",
            "ae.layer.properties.list", "read", 2,
        ),
        ToolCase(
            "keyframes", "ae_listLayerPropertyKeyframes",
            "ae.layer.property.keyframes.list", "read",
        ),
    ),
)

require(len(T5_CALL_PLAN) == 28, "Composition Settings T5 must be exactly 28 calls")
require(len(T6_CALL_PLAN) == 17, "Composition Settings T6 must be exactly 17 calls")
require(T5_CALL_PLAN != T6_CALL_PLAN, "T5 and T6 plans must be distinct")
require(
    [row.ordinal for row in T5_CALL_PLAN] == list(range(1, 29))
    and [row.ordinal for row in T6_CALL_PLAN] == list(range(1, 18)),
    "Composition Settings plan ordinals are not contiguous",
)
require(
    T5_CALL_JUSTIFICATION["withinDefaultCeiling"] is True
    and len(T5_CALL_PLAN) <= NORMAL_WORKFLOW_CALL_CEILING,
    "T5 must fit under the default workflow ceiling",
)
require(
    not _preview_locator_violations(T5_CALL_PLAN)
    and not _preview_locator_violations(T6_CALL_PLAN),
    "T5/T6 must reacquire every locator consumed after previewFrame",
)
require(
    all(
        link.producer_call < link.consumer_call
        for links in (T5_ADDRESS_LINKS, T6_ADDRESS_LINKS)
        for link in links
    ),
    "every T5/T6 address must be produced earlier in the same plan",
)
require(
    set(T6_SKIPS)
    == set(CONTRACTS)
    - {row.tool for row in T6_CALL_PLAN if row.tool in CONTRACTS},
    "every skipped T6 package tool must have exactly one justification",
)
require(
    all(set(skip["grounds"]) == set(_SKIP_GROUNDS) for skip in T6_SKIPS.values()),
    "every T6 skip must carry all thin-setter policy grounds",
)
require(
    set(EVIDENCE_BY_TOOL) == set(CONTRACTS),
    "every package tool must declare its evidence form",
)
