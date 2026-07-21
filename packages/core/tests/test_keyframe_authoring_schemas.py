"""Public schema contract for the #157 keyframe-authoring package."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from ae_mcp import schemas as S


HOST = "11111111-1111-4111-8111-111111111111"
SESSION = "22222222-2222-4222-8222-222222222222"
PROJECT = "33333333-3333-4333-8333-333333333333"
LAYER = "44444444-4444-4444-8444-444444444444"
STREAM = "55555555-5555-4555-8555-555555555555"


def locator(kind: str, object_id: str, *, session: str = SESSION) -> dict:
    return {
        "kind": kind,
        "hostInstanceId": HOST,
        "sessionId": session,
        "projectId": PROJECT,
        "generation": 7,
        "objectId": object_id,
    }


def target() -> dict:
    return {
        "layer_locator": locator("layer", LAYER),
        "property_locator": locator("stream", STREAM),
        "time": {"value": 12, "scale": 24},
        "idempotency_key": "issue157-keyframe-intent-0001",
    }


def scalar(value: str = "50") -> dict:
    return {"kind": "scalar", "value": value}


def ease(dimension: int = 0) -> dict:
    return {
        "dimension": dimension,
        "in_ease": {"speed": "0", "influence": "33.333"},
        "out_ease": {"speed": "25", "influence": "66.667"},
    }


def test_read_uses_locator_and_exact_time_never_public_index():
    request = S.AeGetLayerPropertyKeyframeDetailsArgs(
        property_locator=locator("stream", STREAM),
        time={"value": 1, "scale": 24},
    )
    assert request.time.value == 1
    schema = request.model_json_schema()
    assert schema["additionalProperties"] is False
    assert set(schema["properties"]) == {"property_locator", "time"}
    with pytest.raises(ValidationError):
        S.AeGetLayerPropertyKeyframeDetailsArgs(
            property_locator=locator("stream", STREAM),
            time={"value": 1, "scale": 24},
            keyframe_index=1,
        )


@pytest.mark.parametrize(
    ("model", "extra"),
    [
        (S.AeAddLayerPropertyKeyframeArgs, {"value": scalar()}),
        (S.AeSetLayerPropertyKeyframeValueArgs, {"value": scalar("75")}),
        (
            S.AeSetLayerPropertyKeyframeInterpolationArgs,
            {"in_interpolation": "bezier", "out_interpolation": "linear"},
        ),
        (S.AeSetLayerPropertyKeyframeTemporalEaseArgs, {"dimensions": [ease()]}),
        (
            S.AeSetLayerPropertyKeyframeBehaviorArgs,
            {"behavior": "temporal-auto-bezier", "enabled": True},
        ),
        (S.AeDeleteLayerPropertyKeyframeArgs, {}),
    ],
)
def test_write_schemas_are_closed_and_require_one_stable_intent(model, extra):
    request = model(**target(), **extra)
    assert request.property_locator.kind == "stream"
    assert request.layer_locator.kind == "layer"
    schema = model.model_json_schema()
    assert schema["additionalProperties"] is False
    with pytest.raises(ValidationError):
        model(**target(), **extra, keyframe_index=1)


def test_write_locators_must_share_one_current_context():
    request = target()
    request["property_locator"] = locator(
        "stream",
        STREAM,
        session="66666666-6666-4666-8666-666666666666",
    )
    with pytest.raises(ValidationError, match="share the layer_locator"):
        S.AeAddLayerPropertyKeyframeArgs(**request, value=scalar())


@pytest.mark.parametrize("bad_time", [{"value": 0, "scale": 0}, {"value": 2**31, "scale": 1}])
def test_exact_time_is_int32_over_positive_uint32(bad_time):
    request = target()
    request["time"] = bad_time
    with pytest.raises(ValidationError):
        S.AeDeleteLayerPropertyKeyframeArgs(**request)


def test_interpolation_rejects_none_and_unknown_values():
    with pytest.raises(ValidationError):
        S.AeSetLayerPropertyKeyframeInterpolationArgs(
            **target(),
            in_interpolation="none",
            out_interpolation="linear",
        )
    with pytest.raises(ValidationError):
        S.AeSetLayerPropertyKeyframeInterpolationArgs(
            **target(),
            in_interpolation="spline",
            out_interpolation="linear",
        )


def test_temporal_ease_is_contiguous_and_uses_percent_influence():
    request = S.AeSetLayerPropertyKeyframeTemporalEaseArgs(
        **target(),
        dimensions=[ease(0), ease(1)],
    )
    assert request.dimensions[1].dimension == 1
    assert request.dimensions[0].in_ease.influence == "33.333"
    with pytest.raises(ValidationError, match="contiguous"):
        S.AeSetLayerPropertyKeyframeTemporalEaseArgs(
            **target(), dimensions=[ease(1)]
        )
    invalid = ease()
    invalid["in_ease"]["influence"] = "100.001"
    with pytest.raises(ValidationError, match="0..100"):
        S.AeSetLayerPropertyKeyframeTemporalEaseArgs(
            **target(), dimensions=[invalid]
        )


def test_behavior_changes_one_explicit_flag():
    request = S.AeSetLayerPropertyKeyframeBehaviorArgs(
        **target(), behavior="roving", enabled=False
    )
    assert request.behavior == "roving"
    assert request.enabled is False
    with pytest.raises(ValidationError):
        S.AeSetLayerPropertyKeyframeBehaviorArgs(
            **target(), behavior="all", enabled=True
        )
