"""Focused contracts for the #165 Layer Transform semantic package."""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import pytest
from pydantic import ValidationError

from ae_mcp import schemas
from ae_mcp.annotations import VERB_ANNOTATIONS
from ae_mcp.backends import native as N
from ae_mcp.backends import native_layer_transform as LT
from ae_mcp.handlers import HANDLERS, load_all
from ae_mcp.handlers import native as native_handlers
from ae_mcp.server import build_server


HOST = "22222222-2222-4222-8222-222222222222"
SESSION = "11111111-1111-4111-8111-111111111111"
PROJECT = "44444444-4444-4444-8444-444444444444"
LAYER = "77777777-7777-4777-8777-777777777777"


def _locator(kind: str, object_id: str) -> N.NativeLocator:
    return N.NativeLocator(
        kind=kind,
        host_instance_id=HOST,
        session_id=SESSION,
        project_id=PROJECT,
        generation=3,
        object_id=object_id,
    )


LAYER_LOCATOR = _locator("layer", LAYER)
TRANSFORM_LOCATOR = _locator("stream", "10000000-0000-4000-8000-000000000001")


def _property(
    index: int,
    match_name: str,
    value: N.LayerPropertyPrimitiveValue | None,
    *,
    time_varying: bool | None = False,
) -> N.LayerProperty:
    is_group = value is None
    if isinstance(value, N.LayerPropertyScalarValue):
        value_type = "one-d"
    elif isinstance(value, N.LayerPropertyVectorValue):
        value_type = "two-d" if len(value.components) == 2 else "three-d"
    else:
        value_type = "none"
    return N.LayerProperty(
        property_locator=_locator(
            "stream", f"10000000-0000-4000-8000-{index + 1:012d}",
        ),
        property_index=index,
        name=match_name,
        match_name=match_name,
        grouping_type="named-group" if is_group else "leaf",
        child_count=7 if is_group else 0,
        hidden=False,
        disabled=False,
        modified=False,
        can_vary_over_time=None if is_group else True,
        time_varying=None if is_group else time_varying,
        value_type=value_type,
        value_status="group" if is_group else "sampled",
        value=value,
    )


def _vector(*values: str) -> N.LayerPropertyVectorValue:
    return N.LayerPropertyVectorValue(kind="vector", components=values)


def _scalar(value: str) -> N.LayerPropertyScalarValue:
    return N.LayerPropertyScalarValue(kind="scalar", value=value)


def _page(
    properties: tuple[N.LayerProperty, ...],
    *,
    parent: N.NativeLocator | None,
) -> Any:
    value = N.LayerPropertiesListValue(
        layer_locator=LAYER_LOCATOR,
        parent_property_locator=parent,
        layer_name="Transform Fixture",
        sample_time=N.LayerPropertySampleTime(value=0, scale=1, mode="comp-time"),
        total=len(properties),
        offset=0,
        limit=25,
        returned=len(properties),
        has_more=False,
        next_offset=None,
        properties=properties,
    )
    return SimpleNamespace(
        value=value,
        evidence=SimpleNamespace(
            postcondition=SimpleNamespace(digest=f"{len(properties):064x}"),
        ),
    )


def _tree(*, dimensions: int = 2, time_varying: str | None = None):
    root = _property(1, "ADBE Transform Group", None)
    # Use the stable test locator as the group parent.
    root = root.model_copy(update={"property_locator": TRANSFORM_LOCATOR})
    xyz = ("10", "20") if dimensions == 2 else ("10", "20", "30")
    fields: list[tuple[str, N.LayerPropertyPrimitiveValue]] = [
        ("ADBE Anchor Point", _vector(*xyz)),
        ("ADBE Position", _vector(*xyz)),
        ("ADBE Scale", _vector(*("100" for _ in range(dimensions)))),
        ("ADBE Rotate Z", _scalar("15")),
        ("ADBE Opacity", _scalar("80")),
    ]
    if dimensions == 3:
        fields.append(("ADBE Orientation", _vector("1", "2", "3")))
    children = tuple(
        _property(
            index,
            match_name,
            value,
            time_varying=match_name == time_varying,
        )
        for index, (match_name, value) in enumerate(fields, 1)
    )
    return _page((root,), parent=None), _page(children, parent=TRANSFORM_LOCATOR)


async def _install_tree(monkeypatch, *, dimensions: int = 2, time_varying: str | None = None):
    root, children = _tree(dimensions=dimensions, time_varying=time_varying)

    async def _list(*_args, parent_property_locator=None, **_kwargs):
        return root if parent_property_locator is None else children

    monkeypatch.setattr(LT, "invoke_layer_properties_list", _list)


@pytest.mark.asyncio
async def test_transform_read_projects_ai_friendly_values_and_binds_source_evidence(monkeypatch):
    await _install_tree(monkeypatch, dimensions=3)
    result = await LT.read_layer_transform(
        object(), layer_locator=LAYER_LOCATOR, deadline_unix_ms=10_000,
    )

    assert result.value == {
        "layerLocator": LAYER_LOCATOR.model_dump(mode="json", by_alias=True),
        "layerName": "Transform Fixture",
        "dimensions": 3,
        "anchorPoint": ["10", "20", "30"],
        "position": ["10", "20", "30"],
        "scalePercent": ["100", "100", "100"],
        "rotationDegrees": "15",
        "opacityPercent": "80",
        "orientationDegrees": ["1", "2", "3"],
    }
    assert len(result.projection_digest) == 64
    assert len(result.source_postcondition_digests) == 2


@pytest.mark.asyncio
async def test_transform_write_discovers_locator_and_returns_semantic_transition(monkeypatch):
    await _install_tree(monkeypatch, dimensions=2)
    captured: dict[str, Any] = {}

    async def _set(_backend, **kwargs):
        captured.update(kwargs)
        changed = N.LayerPropertySetValue(
            changed=True,
            layer_locator=LAYER_LOCATOR,
            property_locator=kwargs["property_locator"],
            value_type="two-d",
            before_value=_vector("10", "20"),
            after_value=_vector("50", "60"),
        )
        return SimpleNamespace(
            value=changed,
            evidence=SimpleNamespace(
                postcondition=SimpleNamespace(digest="c" * 64),
            ),
        )

    monkeypatch.setattr(LT, "invoke_layer_property_set", _set)
    result = await LT.set_layer_transform(
        object(),
        layer_locator=LAYER_LOCATOR,
        field="position",
        value={"kind": "vector", "components": ["50", "60"]},
        idempotency_key="issue165-position-1",
        deadline_unix_ms=10_000,
    )

    assert captured["value"] == _vector("50", "60")
    assert captured["idempotency_key"] == "issue165-position-1"
    assert result.value["field"] == "position"
    assert result.value["before"] == ["10", "20"]
    assert result.value["after"] == ["50", "60"]
    assert len(result.projection_digest) == 64


@pytest.mark.asyncio
async def test_transform_setter_rejects_wrong_dimensions_before_dispatch(monkeypatch):
    await _install_tree(monkeypatch, dimensions=2)
    dispatched = False

    async def _set(*_args, **_kwargs):
        nonlocal dispatched
        dispatched = True

    monkeypatch.setattr(LT, "invoke_layer_property_set", _set)
    with pytest.raises(N.NativeBackendError) as exc:
        await LT.set_layer_transform(
            object(), layer_locator=LAYER_LOCATOR, field="position",
            value={"kind": "vector", "components": ["1", "2", "3"]},
            idempotency_key="issue165-position-2", deadline_unix_ms=10_000,
        )
    assert exc.value.payload.code == "INVALID_ARGUMENT"
    assert exc.value.payload.side_effect == "not-started"
    assert dispatched is False


@pytest.mark.asyncio
async def test_orientation_requires_3d_before_dispatch(monkeypatch):
    await _install_tree(monkeypatch, dimensions=2)
    with pytest.raises(N.NativeBackendError, match="Orientation requires a 3D layer"):
        await LT.set_layer_transform(
            object(), layer_locator=LAYER_LOCATOR, field="orientation",
            value={"kind": "vector", "components": ["1", "2", "3"]},
            idempotency_key="issue165-orientation", deadline_unix_ms=10_000,
        )



@pytest.mark.asyncio
async def test_equal_current_value_still_reaches_native_idempotency_ledger(monkeypatch):
    await _install_tree(monkeypatch, dimensions=2)
    dispatched = False

    async def _set(_backend, **kwargs):
        nonlocal dispatched
        dispatched = True
        return SimpleNamespace(
            value=N.LayerPropertySetValue(
                changed=True,
                layer_locator=LAYER_LOCATOR,
                property_locator=kwargs["property_locator"],
                value_type="one-d",
                before_value=_scalar("70"),
                after_value=_scalar("80"),
            ),
            evidence=SimpleNamespace(
                postcondition=SimpleNamespace(digest="d" * 64),
            ),
        )

    monkeypatch.setattr(LT, "invoke_layer_property_set", _set)
    await LT.set_layer_transform(
        object(), layer_locator=LAYER_LOCATOR, field="opacity",
        value={"kind": "scalar", "value": "80"},
        idempotency_key="issue165-opacity-replay", deadline_unix_ms=10_000,
    )
    assert dispatched is True


def test_public_schemas_are_closed_low_ambiguity_and_annotated():
    load_all()
    expected = {
        "ae.getLayerTransform": {"layer_locator"},
        "ae.setLayerAnchorPoint": {"layer_locator", "idempotency_key", "anchor_point"},
        "ae.setLayerPosition": {"layer_locator", "idempotency_key", "position"},
        "ae.setLayerScale": {"layer_locator", "idempotency_key", "scale_percent"},
        "ae.setLayerRotation": {"layer_locator", "idempotency_key", "rotation_degrees"},
        "ae.setLayerOpacity": {"layer_locator", "idempotency_key", "opacity_percent"},
        "ae.setLayerOrientation": {"layer_locator", "idempotency_key", "orientation_degrees"},
    }
    for verb, fields in expected.items():
        schema_cls, _handler = HANDLERS[verb]
        schema = schema_cls.model_json_schema()
        assert schema["additionalProperties"] is False
        assert set(schema["properties"]) == fields
        assert "property_locator" not in schema["properties"]
        assert "match_name" not in schema["properties"]
        assert VERB_ANNOTATIONS[verb].destructiveHint is False
        assert VERB_ANNOTATIONS[verb].idempotentHint is True
    assert VERB_ANNOTATIONS["ae.getLayerTransform"].readOnlyHint is True
    for verb in tuple(expected)[1:]:
        assert VERB_ANNOTATIONS[verb].readOnlyHint is False


def test_public_schema_rejects_non_finite_underflow_negative_zero_and_opacity_range():
    locator = LAYER_LOCATOR.model_dump(mode="json", by_alias=True)
    base = {"layer_locator": locator, "idempotency_key": "issue165-valid-key"}
    for value in ("1e309", "1e-4000", "-0"):
        with pytest.raises(ValidationError):
            schemas.AeSetLayerRotationArgs(**base, rotation_degrees=value)
    with pytest.raises(ValidationError):
        schemas.AeSetLayerOpacityArgs(**base, opacity_percent="101")
    with pytest.raises(ValidationError):
        schemas.AeSetLayerOrientationArgs(**base, orientation_degrees=["1", "2"])


@pytest.mark.asyncio
async def test_public_transport_returns_structured_transform_validation_without_dispatch(monkeypatch):
    load_all()
    schema_cls, _handler = HANDLERS["ae.setLayerOpacity"]

    async def _must_not_dispatch(_validated, _ctx):
        pytest.fail("invalid transform arguments reached the native handler")

    monkeypatch.setitem(
        HANDLERS, "ae.setLayerOpacity", (schema_cls, _must_not_dispatch),
    )
    result = await build_server()._ae_call_tool(
        "ae_setLayerOpacity",
        {
            "layer_locator": LAYER_LOCATOR.model_dump(mode="json", by_alias=True),
            "opacity_percent": "101",
            "idempotency_key": "issue165-invalid-opacity",
        },
    )
    assert result.isError is True
    payload = json.loads(result.content[0].text)
    assert payload["ok"] is False
    assert payload["error"]["code"] == "INVALID_ARGUMENT"
    assert payload["error"]["sideEffect"] == "not-started"
    assert payload["error"]["details"] == {
        "field": "arguments.opacity_percent",
        "capabilityId": "ae.layer.property.set",
    }


@pytest.mark.asyncio
async def test_public_wrappers_bind_each_semantic_field_without_exposing_generic_choice(monkeypatch):
    calls: list[tuple[str, dict[str, Any], str]] = []

    async def _capture(_args, _ctx, *, field, value, label):
        calls.append((field, value, label))
        return {"ok": True}

    monkeypatch.setattr(native_handlers, "_run_set_layer_transform", _capture)
    locator = LAYER_LOCATOR.model_dump(mode="json", by_alias=True)
    key = "issue165-wrapper-key"
    cases = (
        (native_handlers._run_set_layer_anchor_point, schemas.AeSetLayerAnchorPointArgs(
            layer_locator=locator, idempotency_key=key, anchor_point=["1", "2"],
        ), "anchor-point", {"kind": "vector", "components": ["1", "2"]}),
        (native_handlers._run_set_layer_rotation, schemas.AeSetLayerRotationArgs(
            layer_locator=locator, idempotency_key=key, rotation_degrees="12",
        ), "rotation", {"kind": "scalar", "value": "12"}),
        (native_handlers._run_set_layer_opacity, schemas.AeSetLayerOpacityArgs(
            layer_locator=locator, idempotency_key=key, opacity_percent="75",
        ), "opacity", {"kind": "scalar", "value": "75"}),
    )
    for handler, args, expected_field, expected_value in cases:
        assert await handler(args, None) == {"ok": True}
        assert calls[-1][0] == expected_field
        assert calls[-1][1] == expected_value
