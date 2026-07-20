#!/usr/bin/env python3
"""Declarative package #157 matrix and its one disposable-fixture workflow."""

from __future__ import annotations

import dataclasses
from collections.abc import Mapping
from typing import Any

from capability_package_runtime import (
    AcceptanceFailure,
    AcceptanceRuntime,
    PackageSpec,
    PublicSession,
    ToolCase,
    json_hash,
    mapping,
    native_value,
    require,
)


DETAILS = "ae_getLayerPropertyKeyframeDetails"
ADD = "ae_addLayerPropertyKeyframe"
VALUE = "ae_setLayerPropertyKeyframeValue"
INTERPOLATION = "ae_setLayerPropertyKeyframeInterpolation"
EASE = "ae_setLayerPropertyKeyframeTemporalEase"
BEHAVIOR = "ae_setLayerPropertyKeyframeBehavior"
DELETE = "ae_deleteLayerPropertyKeyframe"

SPEC = PackageSpec(
    issue=157,
    slug="keyframe-authoring",
    title="Layer property keyframe authoring",
    native_novelty=False,
    t5_target_calls=28,
    t6_target_calls=28,
    tools=(
        ToolCase("details", DETAILS, "ae.layer.property.keyframe.details.read", "read", 8),
        ToolCase("add", ADD, "ae.layer.property.keyframe.add", "write", 5),
        ToolCase("value", VALUE, "ae.layer.property.keyframe.value.set", "write"),
        ToolCase(
            "interpolation", INTERPOLATION,
            "ae.layer.property.keyframe.interpolation.set", "write",
        ),
        ToolCase(
            "ease", EASE, "ae.layer.property.keyframe.temporal-ease.set", "write",
        ),
        ToolCase(
            "behavior", BEHAVIOR, "ae.layer.property.keyframe.behavior.set", "write", 2,
        ),
        ToolCase("delete", DELETE, "ae.layer.property.keyframe.delete", "write"),
    ),
    support_tools=(
        ToolCase("create-comp", "ae_createComposition", "ae.composition.create", "write"),
        ToolCase(
            "create-layer", "ae_createCompositionLayer",
            "ae.composition.layer.create", "write",
        ),
        ToolCase(
            "properties", "ae_listLayerProperties", "ae.layer.properties.list", "read",
        ),
        ToolCase(
            "property-write", "ae_setLayerPropertyValue", "ae.layer.property.set", "write",
        ),
        ToolCase("items", "ae_listProjectItems", "ae.project.items.list", "read"),
        ToolCase(
            "layers", "ae_listCompositionLayers", "ae.composition.layers.list", "read",
        ),
    ),
)

TIME = {"value": 1, "scale": 1}
SEED_START_TIME = {"value": 0, "scale": 1}
SEED_END_TIME = {"value": 2, "scale": 1}
SCALAR_0 = {"kind": "scalar", "value": "0"}
SCALAR_40 = {"kind": "scalar", "value": "40"}
SCALAR_50 = {"kind": "scalar", "value": "50"}
SCALAR_65 = {"kind": "scalar", "value": "65"}
SCALAR_80 = {"kind": "scalar", "value": "80"}
DETAIL_FIELDS = {
    "propertyLocator", "time", "temporalDimensionality", "valueType", "value",
    "inInterpolation", "outInterpolation", "temporalEaseDimensions", "behaviors",
}
MUTATION_FIELDS = {
    "changed", "layerLocator", "propertyLocator", "time", "keyframeCountBefore",
    "keyframeCountAfter", "beforeKeyframe", "afterKeyframe",
}
BEHAVIOR_FIELDS = {
    "temporalContinuous", "temporalAutoBezier", "spatialContinuous",
    "spatialAutoBezier", "roving",
}


def _locator(value: Any, kind: str) -> dict[str, Any]:
    locator = mapping(value, f"{kind} locator is invalid")
    require(locator.get("kind") == kind, f"expected {kind} locator")
    require(
        set(locator) == {
            "kind", "hostInstanceId", "sessionId", "projectId", "generation", "objectId",
        },
        f"{kind} locator is not closed",
    )
    require(
        isinstance(locator.get("generation"), int)
        and not isinstance(locator.get("generation"), bool)
        and locator["generation"] > 0,
        f"{kind} locator generation is invalid",
    )
    return locator


def _time(value: Any, expected: Mapping[str, Any] = TIME) -> dict[str, Any]:
    checked = mapping(value, "keyframe time is invalid")
    require(
        set(checked) == {"value", "scale", "secondsRational"},
        "keyframe time shape is not closed",
    )
    raw_value = checked.get("value")
    raw_scale = checked.get("scale")
    expected_seconds = expected["value"] // expected["scale"]
    require(
        expected["value"] == expected_seconds * expected["scale"],
        "expected keyframe time is not an integral second",
    )
    require(
        isinstance(raw_value, int)
        and not isinstance(raw_value, bool)
        and -(2**31) <= raw_value <= (2**31) - 1
        and isinstance(raw_scale, int)
        and not isinstance(raw_scale, bool)
        and 1 <= raw_scale <= (2**32) - 1
        and raw_value * expected["scale"] == expected["value"] * raw_scale
        and checked.get("secondsRational") == str(expected_seconds),
        "keyframe time is not the exact requested time",
    )
    return checked


def _detail(
    value: Any,
    property_locator: Mapping[str, Any],
    *,
    expected_time: Mapping[str, Any] = TIME,
) -> dict[str, Any]:
    detail = mapping(value, "keyframe details are invalid")
    require(set(detail) == DETAIL_FIELDS, "keyframe details shape is not closed")
    require("keyframeIndex" not in detail, "keyframe index leaked into public identity")
    require(_locator(detail["propertyLocator"], "stream") == dict(property_locator), "property drift")
    _time(detail["time"], expected_time)
    require(detail.get("valueType") == "one-d", "opacity keyframe must be one-d")
    scalar = mapping(detail.get("value"), "keyframe scalar is invalid")
    require(set(scalar) == {"kind", "value"} and scalar["kind"] == "scalar", "bad scalar")
    require(detail.get("temporalDimensionality") == 1, "opacity ease must be one-dimensional")
    ease = detail.get("temporalEaseDimensions")
    require(isinstance(ease, list) and len(ease) == 1, "opacity ease dimension is invalid")
    require(mapping(ease[0], "ease dimension is invalid").get("dimension") == 0, "bad ease dimension")
    require(set(mapping(detail.get("behaviors"), "behaviors are invalid")) == BEHAVIOR_FIELDS, "bad behaviors")
    require(detail.get("inInterpolation") in {"none", "linear", "bezier", "hold"}, "bad in interpolation")
    require(detail.get("outInterpolation") in {"none", "linear", "bezier", "hold"}, "bad out interpolation")
    return detail


def _spatial_detail(
    value: Any,
    property_locator: Mapping[str, Any],
    *,
    expected_time: Mapping[str, Any] = TIME,
) -> dict[str, Any]:
    detail = mapping(value, "spatial keyframe details are invalid")
    require(set(detail) == DETAIL_FIELDS, "spatial keyframe details shape is not closed")
    require("keyframeIndex" not in detail, "keyframe index leaked into public identity")
    require(_locator(detail["propertyLocator"], "stream") == dict(property_locator), "property drift")
    _time(detail["time"], expected_time)
    value_type = detail.get("valueType")
    require(value_type in {"two-d-spatial", "three-d-spatial"}, "position keyframe is not spatial")
    dimensions = 2 if value_type == "two-d-spatial" else 3
    typed = mapping(detail.get("value"), "position keyframe value is invalid")
    expected_value_fields = {"kind", "x", "y"} | ({"z"} if dimensions == 3 else set())
    require(
        set(typed) == expected_value_fields
        and typed.get("kind") == ("two-d" if dimensions == 2 else "three-d"),
        "position keyframe value shape is invalid",
    )
    require(detail.get("temporalDimensionality") == dimensions, "position dimensionality mismatch")
    ease = detail.get("temporalEaseDimensions")
    require(isinstance(ease, list) and len(ease) == dimensions, "position ease dimensions are invalid")
    require(
        [mapping(item, "position ease dimension is invalid").get("dimension") for item in ease]
        == list(range(dimensions)),
        "position ease dimensions are not contiguous",
    )
    require(set(mapping(detail.get("behaviors"), "behaviors are invalid")) == BEHAVIOR_FIELDS, "bad behaviors")
    require(detail.get("inInterpolation") in {"none", "linear", "bezier", "hold"}, "bad in interpolation")
    require(detail.get("outInterpolation") in {"none", "linear", "bezier", "hold"}, "bad out interpolation")
    return detail


def _semantic(detail: Mapping[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in detail.items() if key != "propertyLocator"}


def _mutation(
    value: Any,
    *,
    layer: Mapping[str, Any],
    prop: Mapping[str, Any],
    operation: str,
    spatial: bool = False,
    expected_add_value: Mapping[str, Any] | None = None,
    expected_time: Mapping[str, Any] = TIME,
) -> dict[str, Any]:
    changed = mapping(value, f"{operation} mutation is invalid")
    require(set(changed) == MUTATION_FIELDS, f"{operation} mutation shape is not closed")
    require(changed.get("changed") is True, f"{operation} did not report changed=true")
    require(_locator(changed["layerLocator"], "layer") == dict(layer), "layer drift")
    require(_locator(changed["propertyLocator"], "stream") == dict(prop), "property drift")
    _time(changed["time"], expected_time)
    before = changed.get("beforeKeyframe")
    after = changed.get("afterKeyframe")
    count_before = changed.get("keyframeCountBefore")
    count_after = changed.get("keyframeCountAfter")
    require(isinstance(count_before, int) and isinstance(count_after, int), "bad keyframe counts")

    def validate(detail: Any) -> dict[str, Any]:
        if spatial:
            return _spatial_detail(detail, prop, expected_time=expected_time)
        return _detail(detail, prop, expected_time=expected_time)

    if operation == "add":
        require(before is None and count_after == count_before + 1, "add count/state mismatch")
        checked_after = validate(after)
        require(
            expected_add_value is None or checked_after["value"] == dict(expected_add_value),
            "add value mismatch",
        )
    elif operation == "delete":
        require(after is None and count_after + 1 == count_before, "delete count/state mismatch")
        validate(before)
    else:
        require(count_after == count_before, f"{operation} changed keyframe count")
        validate(before)
        validate(after)
    return changed


@dataclasses.dataclass(frozen=True)
class FixtureState:
    composition: dict[str, Any]
    layer: dict[str, Any]
    transform: dict[str, Any]
    opacity: dict[str, Any]
    opacity_value: dict[str, Any]
    position: dict[str, Any]
    position_value: dict[str, Any]


class Issue157Package:
    """Package-owned sequence; the shared runtime owns only stable mechanics."""

    def __init__(self, runtime: AcceptanceRuntime, *, fixture_name: str) -> None:
        self.runtime = runtime
        self.fixture_name = fixture_name

    async def _call(
        self,
        session: PublicSession,
        tool: str,
        arguments: Mapping[str, Any],
        *,
        phase: str,
        expected_error: str | None = None,
        replayed: bool | None = None,
    ) -> dict[str, Any]:
        case = next(
            case for case in (*SPEC.tools, *SPEC.support_tools) if case.tool == tool
        )
        return await self.runtime.call(
            session,
            tool,
            arguments,
            capability_id=case.capability_id,
            write=case.kind == "write",
            phase=phase,
            expected_error=expected_error,
            expected_replayed=replayed,
        )

    async def _properties(
        self,
        session: PublicSession,
        layer: Mapping[str, Any],
        parent: Mapping[str, Any] | None,
        *,
        phase: str,
    ) -> list[dict[str, Any]]:
        arguments: dict[str, Any] = {
            "layer_locator": dict(layer), "offset": 0, "limit": 25,
        }
        if parent is not None:
            arguments["parent_property_locator"] = dict(parent)
        payload = await self._call(session, "ae_listLayerProperties", arguments, phase=phase)
        value = native_value(payload)
        require(value.get("hasMore") is False, "fixture property page was truncated")
        properties = value.get("properties")
        require(isinstance(properties, list), "property page omitted properties")
        return [mapping(item, "property item is invalid") for item in properties]

    @staticmethod
    def _one_match(items: list[dict[str, Any]], match_name: str) -> dict[str, Any]:
        matches = [item for item in items if item.get("matchName") == match_name]
        require(len(matches) == 1, f"expected one {match_name} property")
        return matches[0]

    async def _create_fixture(self, session: PublicSession, *, phase: str) -> FixtureState:
        self.runtime.require_fixture_absent()
        readiness = await self._call(
            session,
            "ae_listProjectItems",
            {"offset": 0, "limit": 1},
            phase=f"{phase}-readiness",
        )
        require(
            isinstance(native_value(readiness).get("items"), list),
            "readiness probe did not return a project item page",
        )
        await self.runtime.checkpoint(
            "save-fixture",
            {
                "instruction": (
                    "Save the empty active project once at fixturePath before any locator is acquired; "
                    "do not Save As a copy."
                ),
                "fixturePath": self.runtime.fixture.path,
                "activeFixtureCount": 1,
                "saveAsCopies": 0,
            },
        )
        self.runtime.mark_fixture_created()
        comp = await self._call(
            session,
            "ae_createComposition",
            {
                "name": self.fixture_name,
                "width": 640,
                "height": 360,
                "duration": {"value": 5, "scale": 1},
                "frame_rate": {"numerator": 24, "denominator": 1},
                "pixel_aspect_ratio": {"numerator": 1, "denominator": 1},
                "idempotency_key": self.runtime.intent("fixture-composition"),
            },
            phase=phase,
            replayed=False,
        )
        composition = _locator(native_value(comp)["compositionLocator"], "composition")
        layer_payload = await self._call(
            session,
            "ae_createCompositionLayer",
            {
                "composition_locator": composition,
                "kind": "solid",
                "name": "KEYFRAME_TARGET",
                "color": {"red": 40, "green": 80, "blue": 120, "alpha": 255},
                "width": 640,
                "height": 360,
                "duration": {"value": 5, "scale": 1},
                "idempotency_key": self.runtime.intent("fixture-layer"),
            },
            phase=phase,
            replayed=False,
        )
        value = native_value(layer_payload)
        layer = _locator(value["layerLocator"], "layer")
        roots = await self._properties(session, layer, None, phase=phase)
        transform_item = self._one_match(roots, "ADBE Transform Group")
        transform = _locator(transform_item["propertyLocator"], "stream")
        children = await self._properties(session, layer, transform, phase=phase)
        opacity_item = self._one_match(children, "ADBE Opacity")
        position_item = self._one_match(children, "ADBE Position")
        require(
            opacity_item.get("groupingType") == "leaf"
            and opacity_item.get("valueType") == "one-d"
            and opacity_item.get("canVaryOverTime") is True,
            "fixture opacity is not a keyframeable scalar leaf",
        )
        opacity = _locator(opacity_item["propertyLocator"], "stream")
        opacity_value = mapping(opacity_item.get("value"), "opacity value is invalid")
        require(
            position_item.get("groupingType") == "leaf"
            and position_item.get("valueType") in {"two-d-spatial", "three-d-spatial"}
            and position_item.get("canVaryOverTime") is True,
            "fixture position is not a keyframeable spatial leaf",
        )
        position = _locator(position_item["propertyLocator"], "stream")
        position_value = mapping(position_item.get("value"), "position value is invalid")
        return FixtureState(
            composition, layer, transform, opacity, opacity_value, position, position_value
        )

    async def _reacquire(self, session: PublicSession, *, phase: str) -> FixtureState:
        items_payload = await self._call(
            session, "ae_listProjectItems", {"offset": 0, "limit": 50}, phase=phase
        )
        items = native_value(items_payload).get("items")
        require(isinstance(items, list), "project item page omitted items")
        comps = [
            mapping(item, "project item is invalid") for item in items
            if isinstance(item, Mapping)
            and item.get("name") == self.fixture_name
            and item.get("type") == "composition"
        ]
        require(len(comps) == 1, "fixture composition is not unique after restart")
        composition = _locator(comps[0].get("locator"), "composition")
        layers_payload = await self._call(
            session,
            "ae_listCompositionLayers",
            {"composition_locator": composition, "offset": 0, "limit": 25},
            phase=phase,
        )
        layers = native_value(layers_payload).get("layers")
        require(isinstance(layers, list), "layer page omitted layers")
        matching = [item for item in layers if isinstance(item, Mapping) and item.get("name") == "KEYFRAME_TARGET"]
        require(len(matching) == 1, "fixture layer is not unique after restart")
        layer = _locator(mapping(matching[0], "layer is invalid").get("locator"), "layer")
        roots = await self._properties(session, layer, None, phase=phase)
        transform = _locator(self._one_match(roots, "ADBE Transform Group")["propertyLocator"], "stream")
        children = await self._properties(session, layer, transform, phase=phase)
        opacity_item = self._one_match(children, "ADBE Opacity")
        position_item = self._one_match(children, "ADBE Position")
        return FixtureState(
            composition,
            layer,
            transform,
            _locator(opacity_item["propertyLocator"], "stream"),
            mapping(opacity_item.get("value"), "opacity value is invalid"),
            _locator(position_item["propertyLocator"], "stream"),
            mapping(position_item.get("value"), "position value is invalid"),
        )

    async def _details(
        self,
        session: PublicSession,
        fixture: FixtureState,
        *,
        phase: str,
        missing: bool = False,
        property_locator: Mapping[str, Any] | None = None,
        spatial: bool = False,
    ) -> dict[str, Any]:
        target = dict(property_locator) if property_locator is not None else fixture.opacity
        payload = await self._call(
            session,
            DETAILS,
            {"property_locator": target, "time": TIME},
            phase=phase,
            expected_error="PRECONDITION_FAILED" if missing else None,
        )
        if missing:
            error = mapping(payload.get("error"), "missing-keyframe error is invalid")
            details = mapping(error.get("details"), "missing-keyframe details are invalid")
            require(details.get("capabilityId") == SPEC.tools[0].capability_id, "error capability mismatch")
            require(details.get("field") == "params.arguments.time", "error field mismatch")
            return payload
        validator = _spatial_detail if spatial else _detail
        return validator(native_value(payload), target)

    async def _undo_and_read(
        self,
        session: PublicSession,
        fixture: FixtureState,
        *,
        tool: str,
        before: Mapping[str, Any] | None,
        phase: str,
        property_locator: Mapping[str, Any] | None = None,
        spatial: bool = False,
    ) -> dict[str, Any] | None:
        await self.runtime.checkpoint(
            f"undo-{tool}",
            {
                "instruction": "Execute exactly one real After Effects Undo; do not save a copy.",
                "fixturePath": self.runtime.fixture.path,
                "activeFixtureCount": 1,
                "saveAsCopies": 0,
            },
        )
        if before is None:
            await self._details(
                session,
                fixture,
                phase=phase,
                missing=True,
                property_locator=property_locator,
                spatial=spatial,
            )
            restored = None
        else:
            restored = await self._details(
                session,
                fixture,
                phase=phase,
                property_locator=property_locator,
                spatial=spatial,
            )
            require(_semantic(restored) == _semantic(before), f"{tool} Undo did not restore state")
        self.runtime.mark_tool_passed(tool, undo_executed=True, undo_verified=True)
        return restored

    async def _write(
        self,
        session: PublicSession,
        fixture: FixtureState,
        tool: str,
        operation: str,
        extras: Mapping[str, Any],
        *,
        phase: str,
        property_locator: Mapping[str, Any] | None = None,
        spatial: bool = False,
        time: Mapping[str, Any] = TIME,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        target = dict(property_locator) if property_locator is not None else fixture.opacity
        arguments = {
            "layer_locator": fixture.layer,
            "property_locator": target,
            "time": time,
            "idempotency_key": self.runtime.intent(operation),
            **dict(extras),
        }
        payload = await self._call(session, tool, arguments, phase=phase, replayed=False)
        changed = _mutation(
            native_value(payload),
            layer=fixture.layer,
            prop=target,
            operation=operation,
            spatial=spatial,
            expected_add_value=extras.get("value") if operation == "add" else None,
            expected_time=time,
        )
        return payload, changed

    async def _preflight(self, session: PublicSession) -> dict[str, Any]:
        fixture = await self._create_fixture(session, phase="preflight-fixture")
        original_locator = dict(fixture.opacity)
        original_value = dict(fixture.opacity_value)
        await self._call(
            session,
            "ae_setLayerPropertyValue",
            {
                "layer_locator": fixture.layer,
                "property_locator": fixture.opacity,
                "value": SCALAR_50,
                "idempotency_key": self.runtime.intent("preflight-property-write"),
            },
            phase="preflight-locator",
            replayed=False,
        )
        await self.runtime.checkpoint(
            "undo-preflight-property-write",
            {"instruction": "Execute exactly one real AE Undo, then acknowledge.", "saveAsCopies": 0},
        )
        children = await self._properties(
            session, fixture.layer, fixture.transform, phase="preflight-locator"
        )
        opacity = self._one_match(children, "ADBE Opacity")
        require(opacity.get("propertyLocator") == original_locator, "property locator changed across write/Undo")
        require(opacity.get("value") == original_value, "property value was not restored by Undo")
        archived = await self.runtime.archive_fixture()
        return {
            "preflight": "passed",
            "candidateEvidence": False,
            "propertyLocatorStableAcrossUndo": True,
            "archived": archived,
        }

    async def _accept(self, session: PublicSession) -> tuple[dict[str, Any], str]:
        phase = f"{self.runtime.mode}-package"
        fixture = await self._create_fixture(session, phase=phase)
        # After Effects retains per-keyframe temporal-ease speed only when the
        # keyframe has an adjacent keyframe on both sides; on an isolated
        # keyframe AE applies the influence but normalizes speed back to 0
        # (verified on the candidate build through the public tool and through
        # ExtendScript), which the strict native/host/Core readback rightly
        # rejects as POSSIBLY_SIDE_EFFECTING_FAILURE. Seed the two neighbor
        # keys through the public ADD tool before any matrix write so the ease
        # write proves exact speed retention. Seeding through ExtendScript
        # instead would advance the native project generation and invalidate
        # every locator the driver already holds (reproduced on candidate
        # fb96659: the first post-seed write was rejected PRECONDITION_FAILED
        # with zero side effects). The neighbors are fixture preconditions,
        # not tested operations: they receive no Undo checkpoint, and each
        # write Undo still reverts only its own write group.
        for seed_time, seed_value in (
            (SEED_START_TIME, SCALAR_0),
            (SEED_END_TIME, SCALAR_80),
        ):
            await self._write(
                session,
                fixture,
                ADD,
                "add",
                {"value": seed_value},
                phase=f"{phase}-seed-neighbors",
                time=seed_time,
            )
        _payload, added = await self._write(session, fixture, ADD, "add", {"value": SCALAR_40}, phase=phase)
        await self._undo_and_read(session, fixture, tool=ADD, before=None, phase=phase)
        _seed_payload, seed = await self._write(session, fixture, ADD, "add", {"value": SCALAR_40}, phase=phase)
        baseline = _detail(seed["afterKeyframe"], fixture.opacity)
        self.runtime.mark_tool_passed(DETAILS)
        for tool, operation, extras, assertion in (
            (VALUE, "value", {"value": SCALAR_65}, lambda after: after["value"] == SCALAR_65),
            (
                INTERPOLATION,
                "interpolation",
                {"in_interpolation": "bezier", "out_interpolation": "hold"},
                lambda after: after["inInterpolation"] == "bezier" and after["outInterpolation"] == "hold",
            ),
            (
                EASE,
                "ease",
                {"dimensions": [{"dimension": 0, "in_ease": {"speed": "10", "influence": "25"}, "out_ease": {"speed": "20", "influence": "75"}}]},
                lambda after: after["temporalEaseDimensions"][0]["inEase"] == {"speed": "10", "influence": "25"}
                and after["temporalEaseDimensions"][0]["outEase"] == {"speed": "20", "influence": "75"},
            ),
            (
                BEHAVIOR,
                "behavior",
                {"behavior": "temporal-continuous", "enabled": True},
                lambda after: after["behaviors"]["temporalContinuous"] is True,
            ),
            (DELETE, "delete", {}, lambda after: after is None),
        ):
            _payload, changed = await self._write(
                session, fixture, tool, operation, extras, phase=phase
            )
            if tool is not VALUE:
                # Every later loop write starts from the baseline keyframe, so
                # its own beforeKeyframe proves the previous write's Undo. The
                # INTERPOLATION beforeKeyframe is AE state at the same exact
                # time through the same public surface; requiring it to equal
                # the baseline verifies the VALUE Undo without spending a
                # dedicated details readback.
                require(
                    _semantic(changed["beforeKeyframe"]) == _semantic(baseline),
                    f"{tool} did not start from the baseline keyframe",
                )
                if tool is INTERPOLATION:
                    self.runtime.mark_tool_passed(VALUE, undo_verified=True)
            require(assertion(changed.get("afterKeyframe")), f"{tool} target field mismatch")
            if tool is VALUE:
                await self.runtime.checkpoint(
                    f"undo-{tool}",
                    {
                        "instruction": "Execute exactly one real After Effects Undo; do not save a copy.",
                        "fixturePath": self.runtime.fixture.path,
                        "activeFixtureCount": 1,
                        "saveAsCopies": 0,
                    },
                )
                self.runtime.mark_tool_passed(VALUE, undo_executed=True)
            else:
                await self._undo_and_read(
                    session, fixture, tool=tool, before=baseline, phase=phase
                )
        _position_seed_payload, position_seed = await self._write(
            session,
            fixture,
            ADD,
            "add",
            {"value": fixture.position_value},
            phase=phase,
            property_locator=fixture.position,
            spatial=True,
        )
        position_baseline = _spatial_detail(
            position_seed["afterKeyframe"], fixture.position
        )
        _spatial_behavior_payload, spatial_behavior = await self._write(
            session,
            fixture,
            BEHAVIOR,
            "behavior",
            # AE marks position keyframes spatially continuous by default, so
            # the writable change direction is disabling it; enabling would be
            # a no-op the native precondition rightly rejects INVALID_ARGUMENT.
            {"behavior": "spatial-continuous", "enabled": False},
            phase=phase,
            property_locator=fixture.position,
            spatial=True,
        )
        require(
            spatial_behavior["afterKeyframe"]["behaviors"]["spatialContinuous"] is False,
            "spatial behavior target field mismatch",
        )
        await self._undo_and_read(
            session,
            fixture,
            tool=BEHAVIOR,
            before=position_baseline,
            phase=phase,
            property_locator=fixture.position,
            spatial=True,
        )
        old_instance = self.runtime.expected_host_instance_id
        require(isinstance(old_instance, str), "initial native instance is not bound")
        await self.runtime.checkpoint(
            "restart-formal-ae",
            {
                "instruction": (
                    "Save in place, quit formal AE, relaunch the exact formal app, and open fixturePath. "
                    "Do not use Finder/LaunchServices and do not Save As."
                ),
                "formalAeApp": self.runtime.identity.formal_ae_app,
                "fixturePath": self.runtime.fixture.path,
                "saveAsCopies": 0,
            },
        )
        return {
            "opacityBaselineSha256": json_hash(_semantic(baseline)),
            "positionBaselineSha256": json_hash(_semantic(position_baseline)),
        }, old_instance

    async def run(self) -> dict[str, Any]:
        require(not (self.runtime.mode == "t4" and not SPEC.native_novelty), "#157 has no T4")
        support_capabilities = tuple(case.capability_id for case in SPEC.support_tools)
        self.runtime.validate_machine_identity(
            required_capability_ids=(
                support_capabilities
                if self.runtime.mode == "preflight"
                else SPEC.required_capability_ids
            )
        )
        await self.runtime.checkpoint(
            "prepare-formal-ae",
            {
                "instruction": "Launch only formalAeApp with one empty project and make GUI/pairing ready.",
                "formalAeApp": self.runtime.identity.formal_ae_app,
                "fixturePath": self.runtime.fixture.path,
                "candidateRun": self.runtime.mode in {"t5", "t6"},
                "candidateEvidence": False,
            },
        )
        first = self.runtime.bind_latest_native_load(stage="initial")
        required_tools = [
            case.tool
            for case in (
                SPEC.support_tools
                if self.runtime.mode == "preflight"
                else (*SPEC.tools, *SPEC.support_tools)
            )
        ]
        if self.runtime.mode == "preflight":
            async with self.runtime.session_factory() as session:
                self.runtime.require_tools(session, required_tools)
                details = await self._preflight(session)
            require(self.runtime.ledger.total == 7, "preflight must use exactly seven public calls")
            return details
        async with self.runtime.session_factory() as session:
            self.runtime.require_tools(session, required_tools)
            state, previous = await self._accept(session)
        second = self.runtime.bind_latest_native_load(stage="restart", previous_instance_id=previous)
        async with self.runtime.session_factory() as session:
            self.runtime.require_tools(session, required_tools)
            reacquired = await self._reacquire(session, phase=f"{self.runtime.mode}-restart")
            final = await self._details(session, reacquired, phase=f"{self.runtime.mode}-restart")
            final_position = await self._details(
                session,
                reacquired,
                phase=f"{self.runtime.mode}-restart",
                property_locator=reacquired.position,
                spatial=True,
            )
        require(
            json_hash(_semantic(final)) == state["opacityBaselineSha256"],
            "restart changed opacity keyframe",
        )
        require(
            json_hash(_semantic(final_position)) == state["positionBaselineSha256"],
            "restart changed position keyframe",
        )
        archived = await self.runtime.archive_fixture()
        require(self.runtime.ledger.total == 28, "#157 acceptance must use exactly 28 public calls")
        return {
            **state,
            "firstHostInstanceId": first,
            "restartHostInstanceId": second,
            "restartVerified": True,
            "archived": archived,
        }
