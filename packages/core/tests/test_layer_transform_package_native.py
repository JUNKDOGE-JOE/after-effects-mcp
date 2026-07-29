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
    hidden: bool = False,
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
        hidden=hidden,
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


def _tree(
    *, dimensions: int = 2, time_varying: str | None = None,
    hidden_orientation: bool = False,
):
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
            hidden=hidden_orientation and match_name == "ADBE Orientation",
        )
        for index, (match_name, value) in enumerate(fields, 1)
    )
    return _page((root,), parent=None), _page(children, parent=TRANSFORM_LOCATOR)


async def _install_tree(monkeypatch, *, dimensions: int = 2, time_varying: str | None = None):
    root, children = _tree(dimensions=dimensions, time_varying=time_varying)

    async def _list(*_args, parent_property_locator=None, **_kwargs):
        return root if parent_property_locator is None else children

    monkeypatch.setattr(LT, "invoke_layer_properties_list", _list)


async def _install_hidden_2d_tree(monkeypatch):
    root, children = _tree(dimensions=3, hidden_orientation=True)

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
async def test_hidden_ae26_3d_streams_project_as_2d(monkeypatch):
    await _install_hidden_2d_tree(monkeypatch)
    result = await LT.read_layer_transform(
        object(), layer_locator=LAYER_LOCATOR, deadline_unix_ms=10_000,
    )

    assert result.value["dimensions"] == 2
    assert result.value["anchorPoint"] == ["10", "20"]
    assert result.value["position"] == ["10", "20"]
    assert result.value["scalePercent"] == ["100", "100"]
    assert result.value["orientationDegrees"] is None


@pytest.mark.asyncio
async def test_hidden_ae26_3d_stream_write_preserves_native_z(monkeypatch):
    await _install_hidden_2d_tree(monkeypatch)
    captured: dict[str, Any] = {}

    async def _set(_backend, **kwargs):
        captured.update(kwargs)
        return SimpleNamespace(
            value=N.LayerPropertySetValue(
                changed=True,
                layer_locator=LAYER_LOCATOR,
                property_locator=kwargs["property_locator"],
                value_type="three-d-spatial",
                before_value=_vector("10", "20", "30"),
                after_value=kwargs["value"],
            ),
            evidence=SimpleNamespace(
                postcondition=SimpleNamespace(digest="e" * 64),
            ),
        )

    monkeypatch.setattr(LT, "invoke_layer_property_set", _set)
    result = await LT.set_layer_transform(
        object(), layer_locator=LAYER_LOCATOR, field="position",
        value={"kind": "vector", "components": ["50", "60"]},
        idempotency_key="issue165-position-ae26", deadline_unix_ms=10_000,
    )

    assert captured["value"].components == ("50", "60", "30")
    assert result.value["before"] == ["10", "20"]
    assert result.value["after"] == ["50", "60"]


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
