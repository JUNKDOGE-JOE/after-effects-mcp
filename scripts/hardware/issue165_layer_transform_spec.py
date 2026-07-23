#!/usr/bin/env python3
"""Declarative #165 matrix and one-fixture Layer Transform workflow."""

from __future__ import annotations

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


READ = "ae_getLayerTransform"
WRITES = (
    ("ae_setLayerAnchorPoint", "anchor-point", "anchorPoint", "anchor_point", ["40", "50"]),
    ("ae_setLayerPosition", "position", "position", "position", ["220", "140"]),
    ("ae_setLayerScale", "scale", "scalePercent", "scale_percent", ["120", "80"]),
    ("ae_setLayerRotation", "rotation", "rotationDegrees", "rotation_degrees", "18"),
    ("ae_setLayerOpacity", "opacity", "opacityPercent", "opacity_percent", "72"),
)
ORIENTATION = (
    "ae_setLayerOrientation", "orientation", "orientationDegrees",
    "orientation_degrees", ["10", "20", "30"],
)

SPEC = PackageSpec(
    issue=165,
    slug="layer-transform-editing",
    title="Layer Transform Editing",
    native_novelty=False,
    t4_target_calls=3,
    t5_target_calls=26,
    t6_target_calls=26,
    tools=(
        ToolCase("read", READ, "ae.layer.properties.list", "read", 15),
        *(ToolCase(field, tool, "ae.layer.property.set", "write")
          for tool, field, _state, _argument, _value in WRITES),
        ToolCase("orientation", ORIENTATION[0], "ae.layer.property.set", "write"),
    ),
    support_tools=(
        ToolCase("create-comp", "ae_createComposition", "ae.composition.create", "write"),
        ToolCase(
            "create-layer", "ae_createCompositionLayer",
            "ae.composition.layer.create", "write",
        ),
        ToolCase("enable-3d", "ae_setLayerThreeD", "ae.layer.switch.set", "write"),
        ToolCase("items", "ae_listProjectItems", "ae.project.items.list", "read"),
        ToolCase(
            "layers", "ae_listCompositionLayers", "ae.composition.layers.list", "read",
        ),
    ),
)

STATE_FIELDS = {
    "layerLocator", "layerName", "dimensions", "anchorPoint", "position",
    "scalePercent", "rotationDegrees", "opacityPercent", "orientationDegrees",
}


def _locator(value: Any, kind: str) -> dict[str, Any]:
    locator = mapping(value, f"{kind} locator is invalid")
    require(locator.get("kind") == kind, f"expected {kind} locator")
    require(set(locator) == {
        "kind", "hostInstanceId", "sessionId", "projectId", "generation", "objectId",
    }, f"{kind} locator is not closed")
    return locator


def _state(value: Any, layer: Mapping[str, Any]) -> dict[str, Any]:
    state = mapping(value, "layer transform state is invalid")
    require(set(state) == STATE_FIELDS, "layer transform state is not closed")
    require(_locator(state["layerLocator"], "layer") == dict(layer), "layer locator drift")
    dimensions = state.get("dimensions")
    require(dimensions in {2, 3}, "transform dimensions are invalid")
    for field in ("anchorPoint", "position", "scalePercent"):
        require(
            isinstance(state.get(field), list) and len(state[field]) == dimensions,
            f"{field} dimensions are invalid",
        )
    require(isinstance(state.get("rotationDegrees"), str), "rotation is invalid")
    require(isinstance(state.get("opacityPercent"), str), "opacity is invalid")
    orientation = state.get("orientationDegrees")
    require(
        orientation is None if dimensions == 2
        else isinstance(orientation, list) and len(orientation) == 3,
        "orientation does not match layer dimensions",
    )
    return state


def _semantic(state: Mapping[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in state.items() if key != "layerLocator"}


class Issue165Package:
    def __init__(self, runtime: AcceptanceRuntime, *, fixture_name: str) -> None:
        self.runtime = runtime
        self.fixture_name = fixture_name
        self.support = {case.tool: case for case in SPEC.support_tools}

    async def _call(
        self, session: PublicSession, tool: str, arguments: Mapping[str, Any], *, phase: str,
    ) -> dict[str, Any]:
        case = SPEC.case_by_tool.get(tool) or self.support[tool]
        return await self.runtime.call(
            session, tool, arguments,
            capability_id=case.capability_id,
            write=case.kind == "write",
            phase=phase,
            expected_replayed=False if case.kind == "write" else None,
        )

    async def _create_fixture(
        self, session: PublicSession, *, phase: str,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        self.runtime.require_fixture_absent()
        await self.runtime.checkpoint("save-fixture", {
            "instruction": "Save the empty formal-AE project once in place; never Save As.",
            "fixturePath": self.runtime.fixture.path,
            "activeFixtureCount": 1,
            "saveAsCopies": 0,
        })
        self.runtime.mark_fixture_created()
        created = await self._call(session, "ae_createComposition", {
            "name": self.fixture_name,
            "width": 640, "height": 360,
            "duration": {"value": 5, "scale": 1},
            "frame_rate": {"numerator": 24, "denominator": 1},
            "pixel_aspect_ratio": {"numerator": 1, "denominator": 1},
            "idempotency_key": self.runtime.intent("fixture-composition"),
        }, phase=phase)
        composition = _locator(native_value(created)["compositionLocator"], "composition")
        layer_payload = await self._call(session, "ae_createCompositionLayer", {
            "composition_locator": composition,
            "kind": "solid", "name": "TRANSFORM_TARGET",
            "color": {"red": 40, "green": 80, "blue": 120, "alpha": 255},
            "width": 200, "height": 100,
            "duration": {"value": 5, "scale": 1},
            "idempotency_key": self.runtime.intent("fixture-layer"),
        }, phase=phase)
        layer = _locator(native_value(layer_payload)["layerLocator"], "layer")
        return composition, layer

    async def _read(
        self, session: PublicSession, layer: Mapping[str, Any], *, phase: str,
    ) -> dict[str, Any]:
        payload = await self._call(
            session, READ, {"layer_locator": dict(layer)}, phase=phase,
        )
        return _state(native_value(payload), layer)

    async def _undo_and_verify(
        self, session: PublicSession, *, tool: str, layer: Mapping[str, Any],
        baseline: Mapping[str, Any], phase: str,
    ) -> None:
        await self.runtime.checkpoint(f"undo-{tool}", {
            "instruction": "Execute exactly one real After Effects Undo; do not Save As.",
            "fixturePath": self.runtime.fixture.path,
            "activeFixtureCount": 1,
            "saveAsCopies": 0,
        })
        restored = await self._read(session, layer, phase=phase)
        require(_semantic(restored) == _semantic(baseline), f"{tool} Undo did not restore state")
        self.runtime.mark_tool_passed(tool, undo_executed=True, undo_verified=True)

    async def _write_and_undo(
        self, session: PublicSession, *, case: tuple[Any, ...],
        layer: Mapping[str, Any], baseline: Mapping[str, Any], phase: str,
    ) -> None:
        tool, semantic_field, state_field, argument_field, desired = case
        payload = await self._call(session, tool, {
            "layer_locator": dict(layer),
            argument_field: desired,
            "idempotency_key": self.runtime.intent(semantic_field),
        }, phase=phase)
        changed = mapping(native_value(payload), f"{tool} result is invalid")
        require(set(changed) == {"changed", "field", "layerLocator", "before", "after"},
                f"{tool} result is not closed")
        require(changed.get("changed") is True and changed.get("field") == semantic_field,
                f"{tool} semantic field mismatch")
        require(changed.get("after") == desired, f"{tool} native readback mismatch")
        after = await self._read(session, layer, phase=phase)
        require(after.get(state_field) == desired, f"{tool} public state verification failed")
        await self._undo_and_verify(
            session, tool=tool, layer=layer, baseline=baseline, phase=phase,
        )

    async def _reacquire(
        self, session: PublicSession, *, phase: str,
    ) -> dict[str, Any]:
        items_payload = await self._call(
            session, "ae_listProjectItems", {"offset": 0, "limit": 50}, phase=phase,
        )
        items = native_value(items_payload).get("items")
        require(isinstance(items, list), "project item page omitted items")
        matches = [
            mapping(item, "project item is invalid") for item in items
            if isinstance(item, Mapping) and item.get("name") == self.fixture_name
            and item.get("type") == "composition"
        ]
        require(len(matches) == 1, "fixture composition is not unique after reopen")
        composition = _locator(matches[0]["locator"], "composition")
        layers_payload = await self._call(session, "ae_listCompositionLayers", {
            "composition_locator": composition, "offset": 0, "limit": 25,
        }, phase=phase)
        layers = native_value(layers_payload).get("layers")
        require(isinstance(layers, list), "layer page omitted layers")
        layers = [
            mapping(item, "layer item is invalid") for item in layers
            if isinstance(item, Mapping) and item.get("name") == "TRANSFORM_TARGET"
        ]
        require(len(layers) == 1, "fixture layer is not unique after reopen")
        return _locator(layers[0]["locator"], "layer")

    async def _checkpoint_restart(self) -> None:
        await self.runtime.checkpoint("restart-formal-ae", {
            "instruction": (
                "Save in place, quit formal AE, launch formalAeApp by absolute path, "
                "then open fixturePath from formal AE File > Open; never Finder/LaunchServices."
            ),
            "formalAeApp": self.runtime.identity.formal_ae_app,
            "fixturePath": self.runtime.fixture.path,
            "saveAsCopies": 0,
        })

    async def run(self) -> dict[str, Any]:
        self.runtime.validate_machine_identity()
        await self.runtime.checkpoint("prepare-formal-ae", {
            "instruction": (
                "Launch only formalAeApp and complete pairing in one continuous automated action."
            ),
            "formalAeApp": self.runtime.identity.formal_ae_app,
            "fixturePath": self.runtime.fixture.path,
            "candidateRun": self.runtime.mode in {"t5", "t6"},
            "candidateEvidence": False,
        })
        first = self.runtime.bind_latest_native_load(stage="initial")
        required = [case.tool for case in (*SPEC.tools, *SPEC.support_tools)]

        if self.runtime.mode == "t4":
            raise AcceptanceFailure("#165 adds no native primitive; T4 is intentionally omitted")

        async with self.runtime.session_factory() as session:
            self.runtime.require_tools(session, required)
            _composition, layer = await self._create_fixture(
                session, phase=f"{self.runtime.mode}-fixture",
            )
            baseline = await self._read(
                session, layer, phase=f"{self.runtime.mode}-baseline",
            )
            self.runtime.mark_tool_passed(READ)

            if self.runtime.mode == "preflight":
                previous = first
                await self._checkpoint_restart()
            else:
                require(baseline["dimensions"] == 2, "fresh solid must start as 2D")
                for case in WRITES:
                    await self._write_and_undo(
                        session, case=case, layer=layer, baseline=baseline,
                        phase=f"{self.runtime.mode}-write",
                    )
                await self._call(session, "ae_setLayerThreeD", {
                    "layer_locator": layer, "enabled": True,
                    "idempotency_key": self.runtime.intent("enable-3d"),
                }, phase=f"{self.runtime.mode}-setup")
                three_d_baseline = await self._read(
                    session, layer, phase=f"{self.runtime.mode}-3d-baseline",
                )
                require(three_d_baseline["dimensions"] == 3, "3D promotion did not expose 3D transforms")
                await self._write_and_undo(
                    session, case=ORIENTATION, layer=layer, baseline=three_d_baseline,
                    phase=f"{self.runtime.mode}-write",
                )
                baseline = three_d_baseline
                previous = first
                await self._checkpoint_restart()

        second = self.runtime.bind_latest_native_load(
            stage="restart", previous_instance_id=previous,
        )
        async with self.runtime.session_factory() as session:
            self.runtime.require_tools(session, required)
            layer = await self._reacquire(session, phase=f"{self.runtime.mode}-restart")
            final = await self._read(session, layer, phase=f"{self.runtime.mode}-restart")
        require(_semantic(final) == _semantic(baseline), "reopen changed transform baseline")
        archived = await self.runtime.archive_fixture()
        expected_calls = 6 if self.runtime.mode == "preflight" else 26
        require(
            self.runtime.ledger.total == expected_calls,
            f"#165 {self.runtime.mode} must use exactly {expected_calls} public calls",
        )
        return {
            "baselineSha256": json_hash(_semantic(baseline)),
            "firstHostInstanceId": first,
            "restartHostInstanceId": second,
            "restartVerified": True,
            "archived": archived,
        }


__all__ = ["Issue165Package", "ORIENTATION", "READ", "SPEC", "WRITES"]
