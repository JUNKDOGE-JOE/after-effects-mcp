#!/usr/bin/env python3
"""Declarative #162 matrix and one-fixture Layer Compositing workflow."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from capability_package_runtime import (
    AcceptanceRuntime,
    PackageSpec,
    PublicSession,
    ToolCase,
    json_hash,
    mapping,
    native_value,
    require,
)


READ = "ae_getLayerCompositingState"
SWITCHES = (
    ("ae_setLayerVisibility", "visibility", False),
    ("ae_setLayerSolo", "solo", True),
    ("ae_setLayerLocked", "locked", True),
    ("ae_setLayerShy", "shy", True),
    ("ae_setLayerMotionBlur", "motion-blur", True),
    ("ae_setLayerThreeD", "three-d", True),
    ("ae_setLayerAdjustment", "adjustment", True),
)
QUALITY = "ae_setLayerQuality"
BLEND = "ae_setLayerBlendingMode"

SPEC = PackageSpec(
    issue=162,
    slug="layer-switches-compositing",
    title="Layer switches and compositing",
    native_novelty=True,
    t4_target_calls=4,
    t5_target_calls=26,
    t6_target_calls=26,
    tools=(
        ToolCase("read", READ, "ae.layer.compositing.read", "read", 12),
        *(ToolCase(switch, tool, "ae.layer.switch.set", "write")
          for tool, switch, _enabled in SWITCHES),
        ToolCase("quality", QUALITY, "ae.layer.quality.set", "write"),
        ToolCase("blend", BLEND, "ae.layer.blending-mode.set", "write"),
    ),
    support_tools=(
        ToolCase("create-comp", "ae_createComposition", "ae.composition.create", "write"),
        ToolCase(
            "create-layer", "ae_createCompositionLayer",
            "ae.composition.layer.create", "write",
        ),
        ToolCase("items", "ae_listProjectItems", "ae.project.items.list", "read"),
        ToolCase(
            "layers", "ae_listCompositionLayers", "ae.composition.layers.list", "read",
        ),
    ),
)

STATE_FIELDS = {
    "layerLocator", "visibilityEnabled", "solo", "locked", "shy", "motionBlur",
    "threeD", "adjustment", "quality", "blendingMode", "preserveAlpha", "trackMatte",
}
BLENDING_MODES = {
    "normal", "dissolve", "add", "multiply", "screen", "overlay", "soft-light",
    "hard-light", "darken", "lighten", "difference", "hue", "saturation", "color",
    "luminosity", "color-dodge", "color-burn", "exclusion", "linear-dodge",
    "linear-burn", "linear-light", "vivid-light", "pin-light", "hard-mix",
    "lighter-color", "darker-color", "subtract", "divide",
}
SWITCH_VALUE_FIELDS = {
    "changed", "layerLocator", "switch", "beforeEnabled", "afterEnabled",
}


def _locator(value: Any, kind: str) -> dict[str, Any]:
    locator = mapping(value, f"{kind} locator is invalid")
    require(locator.get("kind") == kind, f"expected {kind} locator")
    require(set(locator) == {
        "kind", "hostInstanceId", "sessionId", "projectId", "generation", "objectId",
    }, f"{kind} locator is not closed")
    return locator


def _state(value: Any, layer: Mapping[str, Any]) -> dict[str, Any]:
    state = mapping(value, "layer compositing state is invalid")
    require(set(state) == STATE_FIELDS, "layer compositing state is not closed")
    require(_locator(state["layerLocator"], "layer") == dict(layer), "layer locator drift")
    for field in (
        "visibilityEnabled", "solo", "locked", "shy", "motionBlur", "threeD",
        "adjustment", "preserveAlpha",
    ):
        require(isinstance(state.get(field), bool), f"{field} is not boolean")
    require(state.get("quality") in {"wireframe", "draft", "best"}, "quality is invalid")
    require(state.get("blendingMode") in BLENDING_MODES, "blending mode is invalid")
    require(state.get("trackMatte") in {
        "none", "alpha", "inverted-alpha", "luma", "inverted-luma",
    }, "track matte is invalid")
    return state


def _semantic(state: Mapping[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in state.items() if key != "layerLocator"}


class Issue162Package:
    def __init__(self, runtime: AcceptanceRuntime, *, fixture_name: str) -> None:
        self.runtime = runtime
        self.fixture_name = fixture_name
        self.support = {case.tool: case for case in SPEC.support_tools}

    async def _call(
        self,
        session: PublicSession,
        tool: str,
        arguments: Mapping[str, Any],
        *,
        phase: str,
    ) -> dict[str, Any]:
        case = SPEC.case_by_tool.get(tool) or self.support[tool]
        return await self.runtime.call(
            session,
            tool,
            arguments,
            capability_id=case.capability_id,
            write=case.kind == "write",
            phase=phase,
            expected_replayed=False if case.kind == "write" else None,
        )

    async def _create_fixture(
        self, session: PublicSession, *, phase: str,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        self.runtime.require_fixture_absent()
        await self.runtime.checkpoint(
            "save-fixture",
            {
                "instruction": (
                    "Save the empty active project once at fixturePath; do not Save As a copy."
                ),
                "fixturePath": self.runtime.fixture.path,
                "activeFixtureCount": 1,
                "saveAsCopies": 0,
            },
        )
        self.runtime.mark_fixture_created()
        created = await self._call(
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
        )
        composition = _locator(native_value(created)["compositionLocator"], "composition")
        layer_payload = await self._call(
            session,
            "ae_createCompositionLayer",
            {
                "composition_locator": composition,
                "kind": "solid",
                "name": "COMPOSITING_TARGET",
                "color": {"red": 40, "green": 80, "blue": 120, "alpha": 255},
                "width": 640,
                "height": 360,
                "duration": {"value": 5, "scale": 1},
                "idempotency_key": self.runtime.intent("fixture-layer"),
            },
            phase=phase,
        )
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
        self,
        session: PublicSession,
        *,
        tool: str,
        layer: Mapping[str, Any],
        baseline: Mapping[str, Any],
        phase: str,
    ) -> None:
        await self.runtime.checkpoint(
            f"undo-{tool}",
            {
                "instruction": "Execute exactly one real After Effects Undo; do not Save As.",
                "fixturePath": self.runtime.fixture.path,
                "activeFixtureCount": 1,
                "saveAsCopies": 0,
            },
        )
        restored = await self._read(session, layer, phase=phase)
        require(_semantic(restored) == _semantic(baseline), f"{tool} Undo did not restore state")
        self.runtime.mark_tool_passed(tool, undo_executed=True, undo_verified=True)

    async def _write_switch(
        self,
        session: PublicSession,
        *,
        tool: str,
        switch: str,
        enabled: bool,
        layer: Mapping[str, Any],
        baseline: Mapping[str, Any],
        phase: str,
    ) -> None:
        payload = await self._call(
            session,
            tool,
            {
                "layer_locator": dict(layer),
                "enabled": enabled,
                "idempotency_key": self.runtime.intent(switch),
            },
            phase=phase,
        )
        value = mapping(native_value(payload), f"{tool} result is invalid")
        require(set(value) == SWITCH_VALUE_FIELDS, f"{tool} result is not closed")
        require(
            value.get("changed") is True
            and value.get("switch") == switch
            and value.get("afterEnabled") is enabled
            and value.get("beforeEnabled") is (not enabled),
            f"{tool} readback mismatch",
        )
        await self._undo_and_verify(
            session, tool=tool, layer=layer, baseline=baseline, phase=phase,
        )

    async def _accept(
        self, session: PublicSession,
    ) -> tuple[dict[str, Any], str]:
        _composition, layer = await self._create_fixture(
            session, phase=f"{self.runtime.mode}-fixture",
        )
        baseline = await self._read(session, layer, phase=f"{self.runtime.mode}-baseline")
        require(_semantic(baseline) == {
            "visibilityEnabled": True,
            "solo": False,
            "locked": False,
            "shy": False,
            "motionBlur": False,
            "threeD": False,
            "adjustment": False,
            "quality": "best",
            "blendingMode": "normal",
            "preserveAlpha": False,
            "trackMatte": "none",
        }, "fresh solid baseline is not deterministic")
        self.runtime.mark_tool_passed(READ)

        for tool, switch, enabled in SWITCHES:
            await self._write_switch(
                session,
                tool=tool,
                switch=switch,
                enabled=enabled,
                layer=layer,
                baseline=baseline,
                phase=f"{self.runtime.mode}-write",
            )

        quality_payload = await self._call(
            session,
            QUALITY,
            {
                "layer_locator": layer,
                "quality": "draft",
                "idempotency_key": self.runtime.intent("quality"),
            },
            phase=f"{self.runtime.mode}-write",
        )
        quality_value = mapping(native_value(quality_payload), "quality result is invalid")
        require(
            quality_value.get("beforeQuality") == "best"
            and quality_value.get("afterQuality") == "draft",
            "quality readback mismatch",
        )
        await self._undo_and_verify(
            session, tool=QUALITY, layer=layer, baseline=baseline,
            phase=f"{self.runtime.mode}-undo",
        )

        blend_payload = await self._call(
            session,
            BLEND,
            {
                "layer_locator": layer,
                "mode": "multiply",
                "idempotency_key": self.runtime.intent("blend"),
            },
            phase=f"{self.runtime.mode}-write",
        )
        blend_value = mapping(native_value(blend_payload), "blend result is invalid")
        require(
            blend_value.get("beforeMode") == "normal"
            and blend_value.get("afterMode") == "multiply"
            and blend_value.get("preserveAlpha") == baseline["preserveAlpha"]
            and blend_value.get("trackMatte") == baseline["trackMatte"],
            "blend readback or preserved fields mismatch",
        )
        await self._undo_and_verify(
            session, tool=BLEND, layer=layer, baseline=baseline,
            phase=f"{self.runtime.mode}-undo",
        )

        previous = self.runtime.expected_host_instance_id
        require(isinstance(previous, str), "initial native instance is not bound")
        await self.runtime.checkpoint(
            "restart-formal-ae",
            {
                "instruction": (
                    "Save in place, quit formal AE, relaunch formalAeApp by absolute path, "
                    "and open fixturePath without Finder/LaunchServices or Save As."
                ),
                "formalAeApp": self.runtime.identity.formal_ae_app,
                "fixturePath": self.runtime.fixture.path,
                "saveAsCopies": 0,
            },
        )
        return baseline, previous

    async def _reacquire(
        self, session: PublicSession, *, phase: str,
    ) -> dict[str, Any]:
        items_payload = await self._call(
            session, "ae_listProjectItems", {"offset": 0, "limit": 50}, phase=phase,
        )
        items = native_value(items_payload).get("items")
        require(isinstance(items, list), "project item page omitted items")
        compositions = [
            mapping(item, "project item is invalid") for item in items
            if isinstance(item, Mapping)
            and item.get("name") == self.fixture_name
            and item.get("type") == "composition"
        ]
        require(len(compositions) == 1, "fixture composition is not unique after restart")
        composition = _locator(compositions[0]["locator"], "composition")
        layers_payload = await self._call(
            session,
            "ae_listCompositionLayers",
            {"composition_locator": composition, "offset": 0, "limit": 25},
            phase=phase,
        )
        layers = native_value(layers_payload).get("layers")
        require(isinstance(layers, list), "layer page omitted layers")
        matches = [
            mapping(item, "layer item is invalid") for item in layers
            if isinstance(item, Mapping) and item.get("name") == "COMPOSITING_TARGET"
        ]
        require(len(matches) == 1, "fixture layer is not unique after restart")
        return _locator(matches[0]["locator"], "layer")

    async def run(self) -> dict[str, Any]:
        self.runtime.validate_machine_identity()
        await self.runtime.checkpoint(
            "prepare-formal-ae",
            {
                "instruction": "Launch only formalAeApp with one empty project and make pairing ready.",
                "formalAeApp": self.runtime.identity.formal_ae_app,
                "fixturePath": self.runtime.fixture.path,
                "candidateRun": self.runtime.mode in {"t5", "t6"},
                "candidateEvidence": False,
            },
        )
        first = self.runtime.bind_latest_native_load(stage="initial")
        required_tools = [case.tool for case in (*SPEC.tools, *SPEC.support_tools)]
        async with self.runtime.session_factory() as session:
            self.runtime.require_tools(session, required_tools)
            if self.runtime.mode == "preflight":
                _composition, layer = await self._create_fixture(session, phase="preflight")
                state = await self._read(session, layer, phase="preflight")
                archived = await self.runtime.archive_fixture()
                return {
                    "firstHostInstanceId": first,
                    "fixtureStateSha256": json_hash(_semantic(state)),
                    "archived": archived,
                }
            if self.runtime.mode == "t4":
                _composition, layer = await self._create_fixture(session, phase="t4-fixture")
                payload = await self._call(
                    session,
                    "ae_setLayerVisibility",
                    {
                        "layer_locator": layer,
                        "enabled": False,
                        "idempotency_key": self.runtime.intent("t4-visibility"),
                    },
                    phase="t4-write",
                )
                value = mapping(native_value(payload), "T4 visibility result is invalid")
                require(
                    value.get("beforeEnabled") is True
                    and value.get("afterEnabled") is False,
                    "T4 visibility write did not verify its readback",
                )
                await self.runtime.checkpoint(
                    "undo-ae_setLayerVisibility",
                    {
                        "instruction": "Execute exactly one real After Effects Undo.",
                        "fixturePath": self.runtime.fixture.path,
                        "activeFixtureCount": 1,
                        "saveAsCopies": 0,
                    },
                )
                restored = await self._read(session, layer, phase="t4-undo")
                require(restored["visibilityEnabled"] is True, "T4 Undo did not restore visibility")
                self.runtime.mark_tool_passed(
                    "ae_setLayerVisibility", undo_executed=True, undo_verified=True,
                )
                self.runtime.mark_tool_passed(READ)
                archived = await self.runtime.archive_fixture()
                require(self.runtime.ledger.total == 4, "#162 T4 must use exactly four public calls")
                return {
                    "firstHostInstanceId": first,
                    "nativeNoveltySmoke": "layer-flag-write",
                    "undoVerified": True,
                    "archived": archived,
                }
            baseline, previous = await self._accept(session)

        second = self.runtime.bind_latest_native_load(
            stage="restart", previous_instance_id=previous,
        )
        async with self.runtime.session_factory() as session:
            self.runtime.require_tools(session, required_tools)
            layer = await self._reacquire(session, phase=f"{self.runtime.mode}-restart")
            final = await self._read(session, layer, phase=f"{self.runtime.mode}-restart")
        require(_semantic(final) == _semantic(baseline), "restart changed compositing baseline")
        archived = await self.runtime.archive_fixture()
        require(self.runtime.ledger.total == 24, "#162 acceptance must use exactly 24 public calls")
        return {
            "baselineSha256": json_hash(_semantic(baseline)),
            "firstHostInstanceId": first,
            "restartHostInstanceId": second,
            "restartVerified": True,
            "archived": archived,
        }
