"""AI-friendly Layer Transform projection over existing native stream tools.

The public surface intentionally hides property match names and locators.  Core
discovers the canonical Transform group through the already verified native
property-list capability, then delegates writes to the existing native
property-set capability.  No JSX or implementation resolver is involved.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any, Literal, Mapping

from ae_mcp.backends.native import (
    LayerPropertiesListExecution,
    LayerProperty,
    LayerPropertyPrimitiveValue,
    LayerPropertyScalarValue,
    LayerPropertySetExecution,
    LayerPropertyVectorValue,
    NativeBackendError,
    NativeCancellationToken,
    NativeInvokeBackend,
    NativeLocator,
    NativeRecovery,
    _sha256_closed_json,
    invoke_layer_properties_list,
    invoke_layer_property_set,
)


TransformField = Literal[
    "anchor-point", "position", "scale", "rotation", "opacity", "orientation",
]

_TRANSFORM_GROUP = "ADBE Transform Group"
_FIELD_MATCH_NAMES: dict[TransformField, str] = {
    "anchor-point": "ADBE Anchor Point",
    "position": "ADBE Position",
    "scale": "ADBE Scale",
    "rotation": "ADBE Rotate Z",
    "opacity": "ADBE Opacity",
    "orientation": "ADBE Orientation",
}
_VECTOR_FIELDS = frozenset({"anchor-point", "position", "scale", "orientation"})


@dataclass(frozen=True)
class TransformDiscovery:
    layer_locator: NativeLocator
    layer_name: str
    dimensions: Literal[2, 3]
    native_dimensions: Literal[2, 3]
    properties: Mapping[TransformField, LayerProperty]
    executions: tuple[LayerPropertiesListExecution, ...]


@dataclass(frozen=True)
class LayerTransformRead:
    value: dict[str, Any]
    projection_digest: str
    source_postcondition_digests: tuple[str, ...]
    execution: LayerPropertiesListExecution


@dataclass(frozen=True)
class LayerTransformWrite:
    field: TransformField
    value: dict[str, Any]
    projection_digest: str
    execution: LayerPropertySetExecution


def _request_id() -> str:
    return f"mcp-{uuid.uuid4().hex}"


def _error(
    code: str,
    message: str,
    *,
    hint: str,
    field: str | None = None,
) -> NativeBackendError:
    details: dict[str, Any] = {"capabilityId": "ae.layer.properties.list"}
    if field is not None:
        details["field"] = field
    return NativeBackendError(
        code,
        message,
        retryable=False,
        side_effect="not-started",
        recovery=NativeRecovery(action="change-arguments", hint=hint),
        details=details,
    )


async def _list_page(
    backend: NativeInvokeBackend,
    *,
    layer_locator: NativeLocator | Mapping[str, Any],
    parent_property_locator: NativeLocator | Mapping[str, Any] | None,
    offset: int,
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None,
) -> LayerPropertiesListExecution:
    return await invoke_layer_properties_list(
        backend,
        request_id=_request_id(),
        layer_locator=layer_locator,
        parent_property_locator=parent_property_locator,
        offset=offset,
        limit=25,
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )


def _one(properties: tuple[LayerProperty, ...], match_name: str) -> LayerProperty:
    matches = tuple(prop for prop in properties if prop.match_name == match_name)
    if len(matches) != 1:
        raise _error(
            "NATIVE_CONTRACT_MISMATCH" if len(matches) > 1 else "INVALID_ARGUMENT",
            f"Layer does not expose exactly one canonical {match_name} stream.",
            hint=(
                "Refresh the layer locator. Separated dimensions and non-standard "
                "layer transform layouts are not supported by this capability package."
            ),
        )
    return matches[0]


def _sampled_vector(prop: LayerProperty, field: TransformField) -> LayerPropertyVectorValue:
    if (
        prop.grouping_type != "leaf"
        or prop.value_status != "sampled"
        or not isinstance(prop.value, LayerPropertyVectorValue)
    ):
        raise _error(
            "INVALID_ARGUMENT",
            f"Layer {field} is not one directly sampled vector stream.",
            hint=(
                "Use an ordinary 2D/3D transform stream. Separated dimensions, "
                "unsupported stream types, and missing samples are outside this package."
            ),
            field=field,
        )
    return prop.value


def _sampled_scalar(prop: LayerProperty, field: TransformField) -> LayerPropertyScalarValue:
    if (
        prop.grouping_type != "leaf"
        or prop.value_status != "sampled"
        or not isinstance(prop.value, LayerPropertyScalarValue)
    ):
        raise _error(
            "INVALID_ARGUMENT",
            f"Layer {field} is not one directly sampled scalar stream.",
            hint="Refresh the layer locator and use a standard non-separated transform stream.",
            field=field,
        )
    return prop.value


async def discover_layer_transform(
    backend: NativeInvokeBackend,
    *,
    layer_locator: NativeLocator | Mapping[str, Any],
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> TransformDiscovery:
    """Discover and validate one canonical transform group without exposing it."""

    executions: list[LayerPropertiesListExecution] = []
    roots: list[LayerProperty] = []
    offset = 0
    while True:
        page = await _list_page(
            backend,
            layer_locator=layer_locator,
            parent_property_locator=None,
            offset=offset,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )
        executions.append(page)
        roots.extend(page.value.properties)
        transform_matches = tuple(
            prop for prop in roots if prop.match_name == _TRANSFORM_GROUP
        )
        if transform_matches:
            break
        if not page.value.has_more or page.value.next_offset is None:
            break
        offset = page.value.next_offset

    transform = _one(tuple(roots), _TRANSFORM_GROUP)
    if transform.grouping_type == "leaf":
        raise _error(
            "NATIVE_CONTRACT_MISMATCH",
            "The canonical Transform stream was not a property group.",
            hint="Refresh native capabilities and the layer locator before retrying.",
        )

    children: list[LayerProperty] = []
    offset = 0
    while True:
        page = await _list_page(
            backend,
            layer_locator=layer_locator,
            parent_property_locator=transform.property_locator,
            offset=offset,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )
        executions.append(page)
        children.extend(page.value.properties)
        if not page.value.has_more or page.value.next_offset is None:
            break
        offset = page.value.next_offset

    child_tuple = tuple(children)
    required: dict[TransformField, LayerProperty] = {
        field: _one(child_tuple, match_name)
        for field, match_name in _FIELD_MATCH_NAMES.items()
        if field != "orientation"
    }
    anchor = _sampled_vector(required["anchor-point"], "anchor-point")
    position = _sampled_vector(required["position"], "position")
    scale = _sampled_vector(required["scale"], "scale")
    native_dimensions = len(position.components)
    if native_dimensions not in {2, 3} or any(
        len(value.components) != native_dimensions for value in (anchor, scale)
    ):
        raise _error(
            "NATIVE_CONTRACT_MISMATCH",
            "Anchor point, position, and scale dimensions did not agree.",
            hint="Refresh the layer locator and inspect the native property tree.",
        )
    _sampled_scalar(required["rotation"], "rotation")
    _sampled_scalar(required["opacity"], "opacity")

    orientation_matches = tuple(
        prop for prop in child_tuple
        if prop.match_name == _FIELD_MATCH_NAMES["orientation"]
    )
    if native_dimensions == 3:
        if len(orientation_matches) != 1:
            raise _error(
                "NATIVE_CONTRACT_MISMATCH",
                "A 3D layer did not expose exactly one Orientation stream.",
                hint="Refresh the layer locator after enabling the 3D switch.",
            )
        orientation = orientation_matches[0]
        _sampled_vector(orientation, "orientation")
        dimensions: Literal[2, 3] = 2 if orientation.hidden else 3
        if dimensions == 3:
            required["orientation"] = orientation
    elif orientation_matches and not orientation_matches[0].hidden:
        raise _error(
            "NATIVE_CONTRACT_MISMATCH",
            "A 2D transform exposed a visible Orientation stream.",
            hint="Refresh the layer locator and inspect the native property tree.",
        )
    else:
        dimensions = 2
    if len(orientation_matches) > 1:
        raise _error(
            "NATIVE_CONTRACT_MISMATCH",
            "Layer exposed duplicate Orientation streams.",
            hint="Refresh the layer locator and inspect the native property tree.",
        )

    last = executions[-1]
    return TransformDiscovery(
        layer_locator=last.value.layer_locator,
        layer_name=last.value.layer_name,
        dimensions=dimensions,
        native_dimensions=native_dimensions,
        properties=required,
        executions=tuple(executions),
    )


def _semantic_value(
    value: LayerPropertyPrimitiveValue,
    *,
    dimensions: Literal[2, 3] | None = None,
) -> str | list[str]:
    if isinstance(value, LayerPropertyScalarValue):
        return value.value
    if isinstance(value, LayerPropertyVectorValue):
        components = value.components
        if dimensions == 2 and len(components) == 3:
            components = components[:2]
        return list(components)
    raise TypeError("transform projection accepted a non scalar/vector value")


async def read_layer_transform(
    backend: NativeInvokeBackend,
    *,
    layer_locator: NativeLocator | Mapping[str, Any],
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> LayerTransformRead:
    discovery = await discover_layer_transform(
        backend,
        layer_locator=layer_locator,
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    props = discovery.properties
    value: dict[str, Any] = {
        "layerLocator": discovery.layer_locator.model_dump(mode="json", by_alias=True),
        "layerName": discovery.layer_name,
        "dimensions": discovery.dimensions,
        "anchorPoint": _semantic_value(
            props["anchor-point"].value, dimensions=discovery.dimensions,
        ),
        "position": _semantic_value(
            props["position"].value, dimensions=discovery.dimensions,
        ),
        "scalePercent": _semantic_value(
            props["scale"].value, dimensions=discovery.dimensions,
        ),
        "rotationDegrees": _semantic_value(props["rotation"].value),
        "opacityPercent": _semantic_value(props["opacity"].value),
        "orientationDegrees": (
            _semantic_value(props["orientation"].value)
            if "orientation" in props else None
        ),
    }
    source_digests = tuple(
        execution.evidence.postcondition.digest
        for execution in discovery.executions
    )
    projection_digest = _sha256_closed_json({
        "kind": "core-layer-transform-projection-v1",
        "sourcePostconditionDigests": list(source_digests),
        "value": value,
    })
    return LayerTransformRead(
        value=value,
        projection_digest=projection_digest,
        source_postcondition_digests=source_digests,
        execution=discovery.executions[-1],
    )


async def set_layer_transform(
    backend: NativeInvokeBackend,
    *,
    layer_locator: NativeLocator | Mapping[str, Any],
    field: TransformField,
    value: LayerPropertyPrimitiveValue | Mapping[str, Any],
    idempotency_key: str,
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> LayerTransformWrite:
    discovery = await discover_layer_transform(
        backend,
        layer_locator=layer_locator,
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    prop = discovery.properties.get(field)
    if prop is None:
        raise _error(
            "INVALID_ARGUMENT",
            "Orientation requires a 3D layer.",
            hint="Call ae_setLayerThreeD first, refresh the layer locator, then retry.",
            field="orientation_degrees",
        )
    requested: LayerPropertyPrimitiveValue
    if field in _VECTOR_FIELDS:
        requested = LayerPropertyVectorValue.model_validate(value)
        sampled = _sampled_vector(prop, field)
        if len(requested.components) != discovery.dimensions:
            raise _error(
                "INVALID_ARGUMENT",
                f"{field} requires exactly {discovery.dimensions} components for this layer.",
                hint="Call ae_getLayerTransform and match its reported dimensions.",
                field=field,
            )
        if discovery.dimensions == 2 and discovery.native_dimensions == 3:
            requested = LayerPropertyVectorValue(
                kind="vector",
                components=(*requested.components, sampled.components[2]),
            )
    else:
        requested = LayerPropertyScalarValue.model_validate(value)
        _sampled_scalar(prop, field)
    execution = await invoke_layer_property_set(
        backend,
        request_id=_request_id(),
        layer_locator=discovery.layer_locator,
        property_locator=prop.property_locator,
        value=requested,
        idempotency_key=idempotency_key,
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    changed = execution.value
    semantic = {
        "changed": True,
        "field": field,
        "layerLocator": changed.layer_locator.model_dump(mode="json", by_alias=True),
        "before": _semantic_value(
            changed.before_value, dimensions=discovery.dimensions,
        ),
        "after": _semantic_value(
            changed.after_value, dimensions=discovery.dimensions,
        ),
    }
    projection_digest = _sha256_closed_json({
        "kind": "core-layer-transform-write-projection-v1",
        "sourcePostconditionDigest": execution.evidence.postcondition.digest,
        "value": semantic,
    })
    return LayerTransformWrite(
        field=field,
        value=semantic,
        projection_digest=projection_digest,
        execution=execution,
    )


__all__ = [
    "LayerTransformRead",
    "LayerTransformWrite",
    "TransformDiscovery",
    "TransformField",
    "discover_layer_transform",
    "read_layer_transform",
    "set_layer_transform",
]
