from __future__ import annotations

from typing import Any
import inspect

import pytest
from pydantic import ValidationError

from ae_mcp import schemas
from ae_mcp.annotations import VERB_ANNOTATIONS
from ae_mcp.handlers import HANDLERS, load_all
from ae_mcp.schemas_tsm import (
    AeCreateMarkerArgs,
    AeCreateShapeGroupArgs,
    AeCreateTextLayerArgs,
    AeFontSelection,
    AeMarkerPatch,
    AeSetShapeFillStyleArgs,
    AeSetShapePathArgs,
    AeSetTextCharacterStyleArgs,
)


TSM_NAMES = {
    "ae.listInstalledFonts",
    "ae.createTextLayer",
    "ae.getTextDocument",
    "ae.setTextContent",
    "ae.setTextCharacterStyle",
    "ae.setTextParagraphStyle",
    "ae.createShapeLayer",
    "ae.listShapeGroups",
    "ae.createShapeGroup",
    "ae.setShapePath",
    "ae.setShapeFillStyle",
    "ae.setShapeStrokeStyle",
    "ae.reorderShapeGroup",
    "ae.listMarkers",
    "ae.createMarker",
    "ae.setMarker",
    "ae.deleteMarker",
}

LOCATOR = {
    "kind": "layer",
    "hostInstanceId": "11111111-1111-4111-8111-111111111111",
    "sessionId": "22222222-2222-4222-8222-222222222222",
    "projectId": "33333333-3333-4333-8333-333333333333",
    "generation": 1,
    "objectId": "44444444-4444-4444-8444-444444444444",
}
KEY = "tsm-test-key-0001"
COLOR = {"red": 1, "green": 2, "blue": 3, "alpha": 255}
VERTEX = {
    "position": ["0", "0"],
    "in_tangent": ["0", "0"],
    "out_tangent": ["1e0", "0.5"],
}


def walk_keys(value: Any) -> set[str]:
    if isinstance(value, dict):
        return set(value) | {
            key for item in value.values() for key in walk_keys(item)
        }
    if isinstance(value, list):
        return {key for item in value for key in walk_keys(item)}
    return set()


def test_all_frozen_requests_are_closed_and_have_no_executable_or_path_inputs():
    load_all()
    assert TSM_NAMES <= schemas.SCHEMAS.keys()
    forbidden = {
        "code",
        "jsx",
        "script",
        "expression",
        "match_name",
        "matchName",
        "property_path",
        "propertyPath",
        "template",
    }
    for name in TSM_NAMES:
        schema = schemas.SCHEMAS[name].model_json_schema()
        assert schema["additionalProperties"] is False, name
        assert not (walk_keys(schema) & forbidden), name
        registered_schema, handler = HANDLERS[name]
        assert registered_schema is schemas.SCHEMAS[name]
        assert inspect.iscoroutinefunction(handler)


def test_frozen_annotations_distinguish_reads_bounded_writes_and_delete():
    reads = {
        "ae.listInstalledFonts",
        "ae.getTextDocument",
        "ae.listShapeGroups",
        "ae.listMarkers",
    }
    for name in TSM_NAMES:
        annotation = VERB_ANNOTATIONS[name]
        assert annotation.readOnlyHint is (name in reads)
        assert annotation.idempotentHint is True
        assert annotation.destructiveHint is (name == "ae.deleteMarker")


def test_unicode_scalar_bounds_count_astral_and_combining_sequences_not_utf16_units():
    value = "A😀中 e\u0301"
    parsed = AeCreateTextLayerArgs(
        composition_id="1",
        name="😀",
        text=value,
        idempotency_key=KEY,
    )
    assert parsed.text == value
    assert len(parsed.name) == 1
    with pytest.raises(ValidationError, match="unicode|string"):
        AeCreateTextLayerArgs(
            composition_id="1",
            name="\ud800",
            text=value,
            idempotency_key=KEY,
        )
    with pytest.raises(ValidationError, match="255"):
        AeCreateTextLayerArgs(
            composition_id="1",
            name="😀" * 256,
            text=value,
            idempotency_key=KEY,
        )


def test_box_text_and_character_leading_invariants_are_frozen():
    with pytest.raises(ValidationError, match="box_size"):
        AeCreateTextLayerArgs(
            composition_id="1",
            name="Box",
            text="x",
            text_kind="box",
            idempotency_key=KEY,
        )
    with pytest.raises(ValidationError, match="auto_leading"):
        AeSetTextCharacterStyleArgs(
            target={
                "composition_id": "1",
                "layer_index": 1,
                "expected_name": "Text",
            },
            style={"auto_leading": False},
            idempotency_key=KEY,
        )
    with pytest.raises(ValidationError, match="forbidden"):
        AeSetTextCharacterStyleArgs(
            target={
                "composition_id": "1",
                "layer_index": 1,
                "expected_name": "Text",
            },
            style={"auto_leading": True, "leading_pixels": "12"},
            idempotency_key=KEY,
        )


def test_font_fallback_is_ordered_unique_and_exact():
    selection = AeFontSelection(
        preferred_postscript_name="ExactPS",
        fallback_postscript_names=["Fallback-Bold", "Fallback-Regular"],
        on_missing="use-first-installed-fallback",
    )
    assert selection.fallback_postscript_names == [
        "Fallback-Bold",
        "Fallback-Regular",
    ]
    with pytest.raises(ValidationError, match="unique"):
        AeFontSelection(
            preferred_postscript_name="ExactPS",
            fallback_postscript_names=["Fallback", "Fallback"],
            on_missing="use-first-installed-fallback",
        )


def test_shape_path_reuses_mask_vertex_codec_and_rejects_noncanonical_values():
    args = AeSetShapePathArgs(
        group_ref={
            "layer_locator": LOCATOR,
            "group_index": 1,
            "stream_id": -7,
        },
        path={"closed": False, "vertices": [VERTEX, VERTEX]},
        idempotency_key=KEY,
    )
    assert args.path.vertices[0].out_tangent == ("1e0", "0.5")
    for invalid in ("-0", "1e-9999"):
        bad = {**VERTEX, "position": [invalid, "0"]}
        with pytest.raises(ValidationError, match="canonical"):
            AeSetShapePathArgs(
                group_ref={
                    "layer_locator": LOCATOR,
                    "group_index": 1,
                    "stream_id": -7,
                },
                path={"closed": False, "vertices": [bad, VERTEX]},
                idempotency_key=KEY,
            )
    with pytest.raises(ValidationError, match="three"):
        AeSetShapePathArgs(
            group_ref={
                "layer_locator": LOCATOR,
                "group_index": 1,
                "stream_id": -7,
            },
            path={"closed": True, "vertices": [VERTEX, VERTEX]},
            idempotency_key=KEY,
        )


def test_shape_create_defaults_but_style_replacement_requires_every_field():
    created = AeCreateShapeGroupArgs(
        layer_locator=LOCATOR,
        name="Triangle",
        path={"closed": True, "vertices": [VERTEX, VERTEX, VERTEX]},
        fill={"enabled": True, "color": COLOR},
        stroke={
            "enabled": True,
            "color": COLOR,
            "width_pixels": "2",
            "stroke_over_fill": True,
        },
        idempotency_key=KEY,
    )
    assert created.fill.opacity_percent == "100"
    assert created.stroke.opacity_percent == "100"
    with pytest.raises(ValidationError, match="opacity_percent"):
        AeSetShapeFillStyleArgs(
            group_ref={
                "layer_locator": LOCATOR,
                "group_index": 1,
                "stream_id": 9,
            },
            fill={"enabled": True, "color": COLOR},
            idempotency_key=KEY,
        )


def test_marker_defaults_exact_time_bounds_and_unique_cue_keys():
    target = {"kind": "layer", "layer_locator": LOCATOR}
    marker = AeCreateMarkerArgs(
        target=target,
        time={"value": 24, "scale": 24},
        marker={},
        idempotency_key=KEY,
    )
    assert marker.marker.duration.value == 0
    assert marker.marker.duration.scale == 1
    with pytest.raises(ValidationError, match="unique"):
        AeCreateMarkerArgs(
            target=target,
            time={"value": 1, "scale": 1},
            marker={
                "cue_point_parameters": [
                    {"key": "x", "value": "1"},
                    {"key": "x", "value": "2"},
                ]
            },
            idempotency_key=KEY,
        )
    with pytest.raises(ValidationError, match="at least one"):
        AeMarkerPatch()
