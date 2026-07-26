#!/usr/bin/env python3
"""Frozen Text, Shape, and Marker T5 and T6 acceptance specifications.

Expectation sources are deliberately concrete. Public request schemas come
from ``schemas_tsm.PUBLIC_SCHEMAS``; maintained text contracts come from
``backends/maintained_text.TEXT_TOOLS`` and ``VALUE_MODELS``; native capability
contracts come from ``native_text_shape_marker.CAPABILITY_CONTRACTS``. The
computed digests make driver tests fail whenever the published contract drifts.
"""

from __future__ import annotations

import dataclasses
import hashlib
from collections.abc import Mapping
from typing import Any, Literal

from ae_mcp.backends import maintained_text
from ae_mcp.backends import native_text_shape_marker as native_tsm
from ae_mcp.schemas_tsm import PUBLIC_SCHEMAS
from capability_package_runtime import PackageSpec, ToolCase, json_hash, require


TEXT_CONTRACT_SOURCE = (
    "packages/core/ae_mcp/backends/maintained_text.py:39-69,247-958"
)
NATIVE_HANDLER_SOURCE = (
    "packages/core/ae_mcp/handlers/text_shape_marker.py:42-137"
)
SCHEMA_SOURCE = "packages/core/ae_mcp/schemas_tsm.py:210-552"
NATIVE_CONTRACT_SOURCE = (
    "packages/core/ae_mcp/backends/native_text_shape_marker.py:87-660"
)
BRIEF_CALL_BUDGET_SOURCE = (
    "docs/capability-packages/text-shape-marker.md:1566-1609"
)
T6_POLICY_SOURCE = "docs/CAPABILITY_PACKAGE_WORKFLOW.md:151-179"
T6_BRIEF_SOURCE = "docs/capability-packages/text-shape-marker.md:1611-1640"

CALL_CEILING_AUTHORIZATION = {
    "brief": BRIEF_CALL_BUDGET_SOURCE,
    "tier": "t5",
    "authorizedCalls": 44,
    "normalWorkflowCeiling": 30,
    "reason": (
        "The frozen brief explicitly authorizes T5 to use exactly 44 public "
        "calls and requires abort before call 45; this authorization must not "
        "be re-clamped by downstream runners."
    ),
}

FIXTURE_RECIPE = (
    "Start formal AE with a new empty project and complete a public readiness read.",
    "Save once in place to the one active ephemeral-validation fixture path.",
    (
        "Create TSM Acceptance Fixture at 1920x1080, square pixels, 10 seconds, "
        "24 fps through ae_createComposition."
    ),
    "Reacquire the composition through ae_listProjectItems.",
    "Record ae_listCompositionLayers as the empty baseline.",
    "Create TSM Text with A😀中 é and create TSM Shape through public MCP.",
    "Create Triangle and Curve from the fixed paths and complete styles below.",
    "Use exact marker times 24/24 and 1000/1000 on distinct layer targets.",
    "Save only in place at the explicit restart checkpoint.",
)

REOPEN_PROCEDURE = {
    "checkpoint": "restart-formal-ae",
    "instruction": (
        "Save in place, quit formal After Effects, relaunch the exact formal "
        "application, and reopen the fixture through AE File > Open Recent."
    ),
    "requiredPath": "AE File > Open Recent",
    "forbiddenPaths": ("Finder", "file double-click", "LaunchServices"),
}


@dataclasses.dataclass(frozen=True)
class ContractExpectation:
    public_tool: str
    registry_name: str
    engine: Literal["maintained-jsx", "native-aegp"]
    kind: Literal["read", "write"]
    input_schema_sha256: str
    contract_id: str
    contract_digest: str
    template_id: str | None
    template_digest: str | None
    native_provenance: bool
    sources: tuple[str, ...]


def _template_digest(operation_file: str) -> str:
    common = (maintained_text.TEMPLATES / maintained_text.COMMON_TEMPLATE).read_bytes()
    operation = (maintained_text.TEMPLATES / operation_file).read_bytes()
    return hashlib.sha256(common + b"\0" + operation).hexdigest()


def _text_expectation(registry_name: str) -> ContractExpectation:
    template_id, operation_file, write = maintained_text.TEXT_TOOLS[registry_name]
    input_schema = PUBLIC_SCHEMAS[registry_name].model_json_schema()
    value_schema = maintained_text.VALUE_MODELS[registry_name].model_json_schema(
        by_alias=True
    )
    return ContractExpectation(
        public_tool=registry_name.replace(".", "_"),
        registry_name=registry_name,
        engine="maintained-jsx",
        kind="write" if write else "read",
        input_schema_sha256=json_hash(input_schema),
        contract_id=template_id,
        contract_digest=maintained_text.digest(
            {"inputSchema": input_schema, "valueSchema": value_schema}
        ),
        template_id=template_id,
        template_digest=_template_digest(operation_file),
        native_provenance=False,
        sources=(SCHEMA_SOURCE, TEXT_CONTRACT_SOURCE),
    )


def _native_expectation(registry_name: str) -> ContractExpectation:
    capability_id = {
        "ae.createShapeLayer": "ae.shape.layer.create",
        "ae.listShapeGroups": "ae.shape.groups.list",
        "ae.createShapeGroup": "ae.shape.group.create",
        "ae.setShapePath": "ae.shape.path.set",
        "ae.setShapeFillStyle": "ae.shape.fill-style.set",
        "ae.setShapeStrokeStyle": "ae.shape.stroke-style.set",
        "ae.reorderShapeGroup": "ae.shape.group.reorder",
        "ae.listMarkers": "ae.marker.list",
        "ae.createMarker": "ae.marker.create",
        "ae.setMarker": "ae.marker.set",
        "ae.deleteMarker": "ae.marker.delete",
    }[registry_name]
    contract = native_tsm.CAPABILITY_CONTRACTS[capability_id]
    return ContractExpectation(
        public_tool=registry_name.replace(".", "_"),
        registry_name=registry_name,
        engine="native-aegp",
        kind="read" if contract.risk == "read" else "write",
        input_schema_sha256=json_hash(PUBLIC_SCHEMAS[registry_name].model_json_schema()),
        contract_id=capability_id,
        contract_digest=contract.contract_digest,
        template_id=None,
        template_digest=None,
        native_provenance=True,
        sources=(SCHEMA_SOURCE, NATIVE_HANDLER_SOURCE, NATIVE_CONTRACT_SOURCE),
    )


CONTRACTS = {
    name.replace(".", "_"): (
        _text_expectation(name)
        if name in maintained_text.TEXT_TOOLS
        else _native_expectation(name)
    )
    for name in PUBLIC_SCHEMAS
}


TRIANGLE_PATH = {
    "closed": True,
    "vertices": [
        {"position": ["0", "-180"], "in_tangent": ["0", "0"], "out_tangent": ["0", "0"]},
        {"position": ["-160", "100"], "in_tangent": ["0", "0"], "out_tangent": ["0", "0"]},
        {"position": ["160", "100"], "in_tangent": ["0", "0"], "out_tangent": ["0", "0"]},
    ],
}
TRIANGLE_RESTYLED_PATH = {
    "closed": True,
    "vertices": [
        {"position": ["0", "-200"], "in_tangent": ["0", "0"], "out_tangent": ["0", "0"]},
        {"position": ["-180", "120"], "in_tangent": ["0", "0"], "out_tangent": ["0", "0"]},
        {"position": ["180", "120"], "in_tangent": ["0", "0"], "out_tangent": ["0", "0"]},
    ],
}
CURVE_PATH = {
    "closed": False,
    "vertices": [
        {"position": ["-220", "-140"], "in_tangent": ["0", "0"], "out_tangent": ["80", "120"]},
        {"position": ["220", "140"], "in_tangent": ["-80", "-120"], "out_tangent": ["0", "0"]},
    ],
}


def _fill(red: int, green: int, blue: int, opacity: str = "100") -> dict[str, Any]:
    return {
        "enabled": True,
        "color": {"red": red, "green": green, "blue": blue, "alpha": 255},
        "opacity_percent": opacity,
    }


def _stroke(
    red: int,
    green: int,
    blue: int,
    width: str,
    *,
    over: bool,
    opacity: str = "100",
) -> dict[str, Any]:
    return {
        "enabled": True,
        "color": {"red": red, "green": green, "blue": blue, "alpha": 255},
        "opacity_percent": opacity,
        "width_pixels": width,
        "stroke_over_fill": over,
    }


TRIANGLE_FILL = _fill(220, 40, 60)
TRIANGLE_STROKE = _stroke(20, 30, 40, "8", over=False)
CURVE_FILL = _fill(30, 160, 90, "62.5")
CURVE_STROKE = _stroke(240, 180, 20, "11", over=True)
RESTYLED_FILL = _fill(40, 80, 230, "75")
RESTYLED_STROKE = _stroke(250, 250, 250, "19.25", over=True, opacity="88")

MARKER_TIME_A = {"value": 24, "scale": 24}
MARKER_TIME_B = {"value": 1000, "scale": 1000}
MARKER_VALUE = {
    "duration": {"value": 12, "scale": 24},
    "comment": "TSM 😀 acceptance",
    "chapter": "chapter",
    "url": "https://example.invalid/tsm",
    "frame_target": "frame",
    "cue_point_name": "cue",
    "cue_point_parameters": [{"key": "owner", "value": "text-shape-marker"}],
    "navigation": True,
    "protected_region": False,
    "label_id": 3,
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


def _call(
    key: str,
    tool: str,
    arguments: Mapping[str, Any],
    disposition: Literal["read", "write"],
    state_assertion: str,
    *,
    undo_of: str | None = None,
) -> PlanCall:
    return PlanCall(
        ordinal=0,
        key=key,
        tool=tool,
        arguments=arguments,
        disposition=disposition,
        state_assertion=state_assertion,
        undo_of=undo_of,
    )


_ROWS = (
    _call("readiness", "ae_projectSummary", {}, "read", "Formal AE project readiness is real and native."),
    _call("composition-create", "ae_createComposition", {
        "name": "TSM Acceptance Fixture", "width": 1920, "height": 1080,
        "duration": {"value": 10, "scale": 1},
        "frame_rate": {"numerator": 24, "denominator": 1},
        "pixel_aspect_ratio": {"numerator": 1, "denominator": 1},
        "idempotency_key": "$operation_key:composition-create",
    }, "write", "Create the one empty 10-second fixture composition."),
    _call("composition-reacquire", "ae_listProjectItems", {"offset": 0, "limit": 50}, "read", "Reacquire the named composition through a public project read."),
    _call("empty-layer-baseline", "ae_listCompositionLayers", {"composition_locator": "$composition_locator", "offset": 0, "limit": 25}, "read", "Record an empty composition layer list."),
    _call("fonts", "ae_listInstalledFonts", {"offset": 0, "limit": 100}, "read", "Record deterministic installed-font inventory."),
    _call("text-create", "ae_createTextLayer", {
        "composition_locator": "$composition_locator", "name": "TSM Text",
        "text": "A😀中 é", "text_kind": "point", "box_size": None,
        "idempotency_key": "$operation_key:text-create",
    }, "write", "Create point text and independently read back its complete document."),
    _call("text-read", "ae_getTextDocument", {"layer_locator": "$text_layer_locator"}, "read", "Complete text snapshot equals the create readback."),
    _call("text-content-set", "ae_setTextContent", {
        "layer_locator": "$text_layer_locator", "text": "Restyled 😀中 é",
        "idempotency_key": "$operation_key:text-content-set",
    }, "write", "Only content changes; character and paragraph styles remain equal."),
    _call("text-content-undo-read", "ae_getTextDocument", {"layer_locator": "$text_layer_locator"}, "read", "Undo restores the complete pre-content TextDocument.", undo_of="text-content-set"),
    _call("text-character-set", "ae_setTextCharacterStyle", {
        "layer_locator": "$text_layer_locator", "style": {
            "font": "$font_selection", "font_size_pixels": "72",
            "fill_color": {"red": 40, "green": 80, "blue": 230, "alpha": 255},
            "stroke_color": {"red": 250, "green": 250, "blue": 250, "alpha": 255},
            "stroke_width_pixels": "6", "stroke_over_fill": True, "tracking": 42,
            "auto_leading": False, "leading_pixels": "84",
            "faux_bold": True, "faux_italic": False,
        }, "idempotency_key": "$operation_key:text-character-set",
    }, "write", "Only the requested complete character projection changes."),
    _call("text-character-undo-read", "ae_getTextDocument", {"layer_locator": "$text_layer_locator"}, "read", "Undo restores the complete pre-character-style TextDocument.", undo_of="text-character-set"),
    _call("text-paragraph-set", "ae_setTextParagraphStyle", {
        "layer_locator": "$text_layer_locator", "style": {
            "justification": "center", "first_line_indent_pixels": "12",
            "start_indent_pixels": "8", "end_indent_pixels": "9",
            "space_before_pixels": "10", "space_after_pixels": "11",
        }, "idempotency_key": "$operation_key:text-paragraph-set",
    }, "write", "Only the requested paragraph projection changes."),
    _call("text-paragraph-undo-read", "ae_getTextDocument", {"layer_locator": "$text_layer_locator"}, "read", "Undo restores the complete pre-paragraph-style TextDocument.", undo_of="text-paragraph-set"),
    _call("shape-layer-create", "ae_createShapeLayer", {
        "composition_locator": "$composition_locator", "name": "TSM Shape",
        "idempotency_key": "$operation_key:shape-layer-create",
    }, "write", "Create one empty vector layer and retain its fresh locator."),
    _call("triangle-create", "ae_createShapeGroup", {
        "layer_locator": "$shape_layer_locator", "name": "Triangle",
        "path": TRIANGLE_PATH, "fill": TRIANGLE_FILL, "stroke": TRIANGLE_STROKE,
        "idempotency_key": "$operation_key:triangle-create",
    }, "write", "Create Triangle atomically with complete path, fill, and stroke."),
    _call("curve-create", "ae_createShapeGroup", {
        "layer_locator": "$shape_layer_locator", "name": "Curve",
        "path": CURVE_PATH, "fill": CURVE_FILL, "stroke": CURVE_STROKE,
        "idempotency_key": "$operation_key:curve-create",
    }, "write", "Create Curve atomically with a distinct complete style."),
    _call("groups-before-restyle", "ae_listShapeGroups", {"layer_locator": "$shape_layer_locator", "offset": 0, "limit": 25}, "read", "List exactly Triangle and Curve and acquire stable group refs."),
    _call("fill-restyle", "ae_setShapeFillStyle", {
        "group_ref": "$triangle_ref", "fill": RESTYLED_FILL,
        "idempotency_key": "$operation_key:fill-restyle",
    }, "write", "Create-then-restyle fill preserves path, stroke, and group order."),
    _call("stroke-restyle", "ae_setShapeStrokeStyle", {
        "group_ref": "$triangle_ref", "stroke": RESTYLED_STROKE,
        "idempotency_key": "$operation_key:stroke-restyle",
    }, "write", "Create-then-restyle stroke preserves restyled fill and path."),
    _call("group-reorder", "ae_reorderShapeGroup", {
        "group_ref": "$triangle_ref", "target_index": "$triangle_other_index",
        "idempotency_key": "$operation_key:group-reorder",
    }, "write", "Restyle-then-reorder preserves fill, stroke, paths, and stream ids."),
    _call("group-reorder-undo-read", "ae_listShapeGroups", {"layer_locator": "$shape_layer_locator", "offset": 0, "limit": 25}, "read", "Undo restores group order while both restyles remain exact.", undo_of="group-reorder"),
    _call("stroke-restyle-undo-read", "ae_listShapeGroups", {"layer_locator": "$shape_layer_locator", "offset": 0, "limit": 25}, "read", "Restyle-then-Undo restores the complete prior stroke while fill stays restyled.", undo_of="stroke-restyle"),
    _call("fill-restyle-undo-read", "ae_listShapeGroups", {"layer_locator": "$shape_layer_locator", "offset": 0, "limit": 25}, "read", "Restyle-then-Undo restores the complete prior fill independently.", undo_of="fill-restyle"),
    _call("shape-path-set", "ae_setShapePath", {
        "group_ref": "$triangle_ref", "path": TRIANGLE_RESTYLED_PATH,
        "idempotency_key": "$operation_key:shape-path-set",
    }, "write", "Path topology changes while name and both styles remain exact."),
    _call("shape-path-undo-read", "ae_listShapeGroups", {"layer_locator": "$shape_layer_locator", "offset": 0, "limit": 25}, "read", "Undo restores exact path topology and decimal values.", undo_of="shape-path-set"),
    _call("text-marker-create", "ae_createMarker", {
        "target": "$text_marker_target", "time": MARKER_TIME_A, "marker": MARKER_VALUE,
        "idempotency_key": "$operation_key:text-marker-create",
    }, "write", "Create the complete Unicode marker on the text layer."),
    _call("shape-marker-create", "ae_createMarker", {
        "target": "$shape_marker_target", "time": MARKER_TIME_B, "marker": MARKER_VALUE,
        "idempotency_key": "$operation_key:shape-marker-create",
    }, "write", "Create equal-rational-time marker on the independent shape target."),
    _call("text-marker-isolation-read", "ae_listMarkers", {"target": "$text_marker_target", "offset": 0, "limit": 25}, "read", "Text target contains exactly its one canonical one-second marker."),
    _call("shape-marker-isolation-read", "ae_listMarkers", {"target": "$shape_marker_target", "offset": 0, "limit": 25}, "read", "Shape target contains exactly its distinct canonical one-second marker."),
    _call("text-marker-set", "ae_setMarker", {
        "marker_ref": "$text_marker_ref", "patch": {"comment": "TSM edited 😀", "chapter": "edited"},
        "idempotency_key": "$operation_key:text-marker-set",
    }, "write", "Patch preserves exact target/time identity and all unrequested fields."),
    _call("text-marker-set-undo-read", "ae_listMarkers", {"target": "$text_marker_target", "offset": 0, "limit": 25}, "read", "Undo restores the complete marker before value.", undo_of="text-marker-set"),
    _call("shape-marker-delete", "ae_deleteMarker", {
        "marker_ref": "$shape_marker_ref",
        "idempotency_key": "$operation_key:shape-marker-delete",
    }, "write", "Delete only the exact shape-target marker."),
    _call("shape-marker-delete-undo-read", "ae_listMarkers", {"target": "$shape_marker_target", "offset": 0, "limit": 25}, "read", "Undo restores the complete deleted marker.", undo_of="shape-marker-delete"),
    _call("cross-family-layers", "ae_listCompositionLayers", {"composition_locator": "$composition_locator", "offset": 0, "limit": 25}, "read", "Text and shape layers coexist with refreshed public locators."),
    _call("cross-family-text", "ae_getTextDocument", {"layer_locator": "$text_layer_locator"}, "read", "Marker and shape activity left text content and styles unchanged."),
    _call("cross-family-shapes", "ae_listShapeGroups", {"layer_locator": "$shape_layer_locator", "offset": 0, "limit": 25}, "read", "Marker activity left order, paths, fills, and strokes unchanged."),
    _call("shape-marker-create-undo-read", "ae_listMarkers", {"target": "$shape_marker_target", "offset": 0, "limit": 25}, "read", "Undo shape-marker create restores its empty target stream.", undo_of="shape-marker-create"),
    _call("text-marker-create-undo-read", "ae_listMarkers", {"target": "$text_marker_target", "offset": 0, "limit": 25}, "read", "Undo text-marker create restores its empty target stream.", undo_of="text-marker-create"),
    _call("curve-create-undo-read", "ae_listShapeGroups", {"layer_locator": "$shape_layer_locator", "offset": 0, "limit": 25}, "read", "Undo Curve creation removes exactly Curve.", undo_of="curve-create"),
    _call("triangle-create-undo-read", "ae_listShapeGroups", {"layer_locator": "$shape_layer_locator", "offset": 0, "limit": 25}, "read", "Undo Triangle creation restores the empty shape layer.", undo_of="triangle-create"),
    _call("shape-layer-create-undo-read", "ae_listCompositionLayers", {"composition_locator": "$composition_locator", "offset": 0, "limit": 25}, "read", "Undo shape-layer creation leaves only TSM Text.", undo_of="shape-layer-create"),
    _call("text-layer-create-undo-read", "ae_listCompositionLayers", {"composition_locator": "$composition_locator", "offset": 0, "limit": 25}, "read", "Undo text-layer creation equals the recorded empty baseline.", undo_of="text-create"),
    _call("post-restart-composition-reacquire", "ae_listProjectItems", {"offset": 0, "limit": 50}, "read", "After File > Open Recent, reacquire the composition in the new host/session."),
    _call("post-restart-empty-baseline", "ae_listCompositionLayers", {"composition_locator": "$composition_locator", "offset": 0, "limit": 25}, "read", "Final restarted layer state equals the original empty baseline."),
)
T5_CALL_PLAN = tuple(
    dataclasses.replace(row, ordinal=index) for index, row in enumerate(_ROWS, 1)
)


def _t5_row(key: str) -> PlanCall:
    matches = [row for row in T5_CALL_PLAN if row.key == key]
    require(len(matches) == 1, f"T5 plan row {key!r} is not unique")
    return matches[0]


_T6_ROWS = tuple(
    _t5_row(key)
    for key in (
        "readiness",
        "composition-create",
        "composition-reacquire",
        "empty-layer-baseline",
        "fonts",
        "text-create",
        "text-read",
        "text-character-set",
        "text-character-undo-read",
        "shape-layer-create",
        "triangle-create",
        "curve-create",
        "groups-before-restyle",
        "stroke-restyle",
        "group-reorder",
        "group-reorder-undo-read",
        "shape-path-set",
        "shape-path-undo-read",
        "text-marker-create",
        "shape-marker-create",
        "text-marker-isolation-read",
        "shape-marker-isolation-read",
        "text-marker-set",
        "text-marker-set-undo-read",
        "shape-marker-delete",
        "cross-family-layers",
        "cross-family-text",
        "cross-family-shapes",
        "post-restart-composition-reacquire",
    )
) + (
    _call(
        "post-restart-family-layers",
        "ae_listCompositionLayers",
        {"composition_locator": "$composition_locator", "offset": 0, "limit": 25},
        "read",
        "After File > Open Recent, both package-created layer families remain.",
    ),
)
T6_CALL_PLAN = tuple(
    dataclasses.replace(row, ordinal=index) for index, row in enumerate(_T6_ROWS, 1)
)

# Compatibility for package-owned semantic assertions that use the full
# candidate plan as their source of exact expected arguments.
CALL_PLAN = T5_CALL_PLAN

T6_REPLAY_GROUNDS = {
    "new-native-primitive-first-clean-build": (
        "ae_createShapeLayer",
        "ae_listShapeGroups",
        "ae_createShapeGroup",
        "ae_setShapePath",
        "ae_setShapeStrokeStyle",
        "ae_reorderShapeGroup",
        "ae_listMarkers",
        "ae_createMarker",
        "ae_setMarker",
        "ae_deleteMarker",
    ),
    "representative-shared-proven-primitive-family": (
        "ae_listInstalledFonts",
        "ae_createTextLayer",
        "ae_getTextDocument",
        "ae_setTextCharacterStyle",
    ),
    "changed-after-candidate": (),
    "install-staging-generated-bundle-component-identity": (
        "ae_projectSummary",
    ),
    "distinct-undo-model": (
        "maintained-jsx-text-document",
        "native-shape-graph",
        "native-shape-stream",
        "native-marker-keyframe",
    ),
}

T6_SKIPS = {
    "ae_setTextContent": {
        "replayedBy": "ae_setTextCharacterStyle",
        "grounds": (
            "shared primitive",
            "shared Undo model",
            "shared locator scheme",
            "byte-identical to the candidate",
        ),
        "detail": "thin maintained-JSX TextDocument setter",
        "sources": (T6_POLICY_SOURCE, T6_BRIEF_SOURCE),
    },
    "ae_setTextParagraphStyle": {
        "replayedBy": "ae_setTextCharacterStyle",
        "grounds": (
            "shared primitive",
            "shared Undo model",
            "shared locator scheme",
            "byte-identical to the candidate",
        ),
        "detail": "thin maintained-JSX TextDocument setter",
        "sources": (T6_POLICY_SOURCE, T6_BRIEF_SOURCE),
    },
    "ae_setShapeFillStyle": {
        "replayedBy": "ae_setShapeStrokeStyle",
        "grounds": (
            "shared primitive",
            "shared Undo model",
            "shared locator scheme",
            "byte-identical to the candidate",
        ),
        "detail": "thin native static-stream style setter",
        "sources": (T6_POLICY_SOURCE, T6_BRIEF_SOURCE),
    },
}

T6_UNDO_MODELS = {
    "maintained-jsx-text-document": {
        "representative": "text-character-set",
        "tools": (
            "ae_createTextLayer",
            "ae_setTextCharacterStyle",
        ),
    },
    "native-shape-graph": {
        "representative": "group-reorder",
        "tools": (
            "ae_createShapeLayer",
            "ae_createShapeGroup",
            "ae_reorderShapeGroup",
        ),
    },
    "native-shape-stream": {
        "representative": "shape-path-set",
        "tools": (
            "ae_setShapePath",
            "ae_setShapeStrokeStyle",
        ),
    },
    "native-marker-keyframe": {
        "representative": "text-marker-set",
        "tools": (
            "ae_createMarker",
            "ae_setMarker",
            "ae_deleteMarker",
        ),
    },
}


@dataclasses.dataclass(frozen=True)
class AddressLink:
    consumer_call: int
    consumer_field: str
    producer_call: int
    producer_path: str


T5_ADDRESS_LINKS = (
    AddressLink(4, "composition_locator", 3, "value.items[TSM Acceptance Fixture].locator"),
    AddressLink(6, "composition_locator", 3, "value.items[TSM Acceptance Fixture].locator"),
    AddressLink(7, "layer_locator", 6, "value.after.layerLocator"),
    AddressLink(8, "layer_locator", 7, "value.layerLocator"),
    AddressLink(9, "layer_locator", 8, "value.layerLocator"),
    AddressLink(10, "layer_locator", 9, "value.layerLocator"),
    AddressLink(11, "layer_locator", 10, "value.layerLocator"),
    AddressLink(12, "layer_locator", 11, "value.layerLocator"),
    AddressLink(13, "layer_locator", 12, "value.layerLocator"),
    AddressLink(14, "composition_locator", 6, "value.compositionLocator"),
    AddressLink(15, "layer_locator", 14, "value.layerLocator"),
    AddressLink(16, "layer_locator", 15, "value.layerLocator"),
    AddressLink(17, "layer_locator", 16, "value.layerLocator"),
    AddressLink(18, "group_ref", 17, "value.groups[Triangle].ref"),
    AddressLink(19, "group_ref", 18, "value.groupRef"),
    AddressLink(20, "group_ref", 19, "value.groupRef"),
    AddressLink(21, "layer_locator", 20, "value.layerLocator"),
    AddressLink(22, "layer_locator", 21, "value.layerLocator"),
    AddressLink(23, "layer_locator", 22, "value.layerLocator"),
    AddressLink(24, "group_ref", 23, "value.groups[Triangle].ref"),
    AddressLink(25, "layer_locator", 24, "value.groupRef.layerLocator"),
    AddressLink(26, "target.layer_locator", 13, "value.layerLocator"),
    AddressLink(27, "target.layer_locator", 25, "value.layerLocator"),
    AddressLink(28, "target", 26, "value.after.ref.target"),
    AddressLink(29, "target", 27, "value.after.ref.target"),
    AddressLink(30, "marker_ref", 28, "value.markers[0].ref"),
    AddressLink(31, "target", 30, "value.after.ref.target"),
    AddressLink(32, "marker_ref", 29, "value.markers[0].ref"),
    AddressLink(33, "target", 32, "value.before.ref.target"),
    AddressLink(34, "composition_locator", 14, "value.compositionLocator"),
    AddressLink(35, "layer_locator", 34, "value.layers[TSM Text].locator"),
    AddressLink(36, "layer_locator", 34, "value.layers[TSM Shape].locator"),
    AddressLink(37, "target", 33, "value.target"),
    AddressLink(38, "target", 31, "value.target"),
    AddressLink(39, "layer_locator", 36, "value.layerLocator"),
    AddressLink(40, "layer_locator", 39, "value.layerLocator"),
    AddressLink(41, "composition_locator", 34, "value.compositionLocator"),
    AddressLink(42, "composition_locator", 41, "value.compositionLocator"),
    AddressLink(44, "composition_locator", 43, "value.items[TSM Acceptance Fixture].locator"),
)
ADDRESS_LINKS = T5_ADDRESS_LINKS

_T6_PRODUCERS = {
    "composition_locator": {
        "composition-reacquire": "value.items[TSM Acceptance Fixture].locator",
        "text-create": "value.compositionLocator",
        "shape-layer-create": "value.compositionLocator",
        "cross-family-layers": "value.compositionLocator",
        "post-restart-composition-reacquire": (
            "value.items[TSM Acceptance Fixture].locator"
        ),
    },
    "text_layer_locator": {
        "text-create": "value.after.layerLocator",
        "text-read": "value.layerLocator",
        "text-character-set": "value.layerLocator",
        "text-character-undo-read": "value.layerLocator",
        "cross-family-layers": "value.layers[TSM Text].locator",
        "cross-family-text": "value.layerLocator",
    },
    "shape_layer_locator": {
        "shape-layer-create": "value.layerLocator",
        "triangle-create": "value.layerLocator",
        "curve-create": "value.layerLocator",
        "groups-before-restyle": "value.layerLocator",
        "stroke-restyle": "value.groupRef.layerLocator",
        "group-reorder": "value.layerLocator",
        "group-reorder-undo-read": "value.layerLocator",
        "shape-path-set": "value.groupRef.layerLocator",
        "shape-path-undo-read": "value.layerLocator",
        "cross-family-layers": "value.layers[TSM Shape].locator",
        "cross-family-shapes": "value.layerLocator",
    },
    "triangle_ref": {
        "groups-before-restyle": "value.groups[Triangle].ref",
        "stroke-restyle": "value.groupRef",
        "group-reorder-undo-read": "value.groups[Triangle].ref",
        "shape-path-set": "value.groupRef",
        "shape-path-undo-read": "value.groups[Triangle].ref",
    },
    "text_marker_target": {
        "text-create": "value.after.layerLocator",
        "text-character-undo-read": "value.layerLocator",
        "text-marker-create": "value.after.ref.target",
        "text-marker-isolation-read": "value.target",
        "text-marker-set": "value.after.ref.target",
        "text-marker-set-undo-read": "value.target",
        "cross-family-layers": "value.layers[TSM Text].locator",
    },
    "shape_marker_target": {
        "shape-layer-create": "value.layerLocator",
        "shape-path-undo-read": "value.layerLocator",
        "shape-marker-create": "value.after.ref.target",
        "shape-marker-isolation-read": "value.target",
        "shape-marker-delete": "value.before.ref.target",
        "cross-family-layers": "value.layers[TSM Shape].locator",
    },
    "text_marker_ref": {
        "text-marker-isolation-read": "value.markers[0].ref",
    },
    "shape_marker_ref": {
        "shape-marker-isolation-read": "value.markers[0].ref",
    },
}

_ADDRESS_FIELDS = {
    "composition_locator",
    "layer_locator",
    "group_ref",
    "target",
    "marker_ref",
}


def _symbolic_addresses(
    value: Any, *, field: str = ""
) -> tuple[tuple[str, str], ...]:
    if isinstance(value, str) and value.startswith("$") and not value.startswith(
        "$operation_key:"
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


def _derive_address_links(
    plan: tuple[PlanCall, ...],
    producers: Mapping[str, Mapping[str, str]],
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
        for context_key, by_call in producers.items():
            if row.key in by_call:
                latest[context_key] = (row.ordinal, by_call[row.key])
    return tuple(links)


T6_ADDRESS_LINKS = _derive_address_links(T6_CALL_PLAN, _T6_PRODUCERS)

TEXT_LOCATOR_CHAIN = {
    "ae_createTextLayer": "call 3 ae_listProjectItems supplies value.items[TSM Acceptance Fixture].locator",
    "ae_getTextDocument": "call 6 ae_createTextLayer supplies value.after.layerLocator",
    "ae_setTextContent": "call 7 ae_getTextDocument supplies value.layerLocator",
    "ae_setTextCharacterStyle": "call 9 ae_getTextDocument supplies value.layerLocator",
    "ae_setTextParagraphStyle": "call 11 ae_getTextDocument supplies value.layerLocator",
}

PACKAGE_TOOLS = tuple(CONTRACTS)
SPEC = PackageSpec(
    issue=170,
    slug="text-shape-marker-authoring",
    title="Text, Shape, and Marker Authoring",
    native_novelty=True,
    milestone=True,
    t4_target_calls=4,
    t4_hard_limit=4,
    t5_target_calls=44,
    t5_hard_limit=44,
    t6_target_calls=30,
    t6_hard_limit=30,
    tools=tuple(
        ToolCase(
            expectation.registry_name.removeprefix("ae.").replace(".", "-"),
            public_tool,
            expectation.contract_id,
            expectation.kind,
            max(
                sum(row.tool == public_tool for row in T5_CALL_PLAN),
                sum(row.tool == public_tool for row in T6_CALL_PLAN),
            ),
        )
        for public_tool, expectation in CONTRACTS.items()
    ),
    support_tools=(
        ToolCase("readiness", "ae_projectSummary", "ae.project.summary", "read"),
        ToolCase("create-comp", "ae_createComposition", "ae.composition.create", "write"),
        ToolCase("items", "ae_listProjectItems", "ae.project.items.list", "read", 2),
        ToolCase("layers", "ae_listCompositionLayers", "ae.composition.layers.list", "read", 5),
    ),
)

require(len(T5_CALL_PLAN) == 44, "TSM T5 plan must contain exactly 44 calls")
require(
    [row.ordinal for row in T5_CALL_PLAN] == list(range(1, 45)),
    "TSM T5 ordinals must be exactly 1..44",
)
require(len(T6_CALL_PLAN) == 30, "TSM T6 plan must contain exactly 30 calls")
require(
    [row.ordinal for row in T6_CALL_PLAN] == list(range(1, 31)),
    "TSM T6 ordinals must be exactly 1..30",
)
require(
    set(CONTRACTS) == set(PACKAGE_TOOLS),
    "TSM public contract expectations must cover all 17 package tools",
)
require(
    all(
        link.producer_call < link.consumer_call
        for links in (T5_ADDRESS_LINKS, T6_ADDRESS_LINKS)
        for link in links
    ),
    "every TSM T5/T6 address must be produced by an earlier public call",
)
require(
    set(T6_SKIPS) == set(PACKAGE_TOOLS) - {row.tool for row in T6_CALL_PLAN},
    "every omitted T6 package tool must have exactly one skip justification",
)
require(
    all(
        set(skip["grounds"])
        == {
            "shared primitive",
            "shared Undo model",
            "shared locator scheme",
            "byte-identical to the candidate",
        }
        for skip in T6_SKIPS.values()
    ),
    "every T6 skip must carry all four policy grounds",
)


__all__ = [
    "ADDRESS_LINKS",
    "BRIEF_CALL_BUDGET_SOURCE",
    "CALL_CEILING_AUTHORIZATION",
    "CALL_PLAN",
    "CONTRACTS",
    "FIXTURE_RECIPE",
    "MARKER_TIME_A",
    "MARKER_TIME_B",
    "MARKER_VALUE",
    "PACKAGE_TOOLS",
    "REOPEN_PROCEDURE",
    "SPEC",
    "T5_ADDRESS_LINKS",
    "T5_CALL_PLAN",
    "T6_ADDRESS_LINKS",
    "T6_CALL_PLAN",
    "T6_REPLAY_GROUNDS",
    "T6_BRIEF_SOURCE",
    "T6_POLICY_SOURCE",
    "T6_SKIPS",
    "T6_UNDO_MODELS",
    "TEXT_LOCATOR_CHAIN",
]
