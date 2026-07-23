#!/usr/bin/env python3
"""Declarative #167 Effect, Mask, and Footage milestone acceptance."""

from __future__ import annotations

import binascii
import os
import shutil
import struct
import zlib
from collections.abc import Mapping
from pathlib import Path
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


READ_TOOLS = (
    ToolCase("effects-installed", "ae_listInstalledEffects", "ae.native.media.read", "read"),
    ToolCase("effects-layer", "ae_listLayerEffects", "ae.native.media.read", "read", 6),
    ToolCase("effect-details", "ae_getLayerEffectDetails", "ae.native.media.read", "read", 2),
    ToolCase("masks-list", "ae_listLayerMasks", "ae.native.media.read", "read", 7),
    ToolCase("mask-details", "ae_getLayerMaskDetails", "ae.native.media.read", "read", 2),
    ToolCase("mask-path", "ae_getLayerMaskPath", "ae.native.media.read", "read", 2),
    ToolCase("footage-details", "ae_getFootageDetails", "ae.native.media.read", "read", 6),
    ToolCase(
        "footage-interpretation-read",
        "ae_getFootageInterpretation",
        "ae.native.media.read",
        "read",
        4,
    ),
)
WRITE_TOOLS = (
    ToolCase("effect-enabled", "ae_setLayerEffectEnabled", "ae.native.media.write", "write"),
    ToolCase("effect-reorder", "ae_reorderLayerEffect", "ae.native.media.write", "write"),
    ToolCase("effect-duplicate", "ae_duplicateLayerEffect", "ae.native.media.write", "write"),
    ToolCase("effect-delete", "ae_deleteLayerEffect", "ae.native.media.write", "write"),
    ToolCase("mask-create", "ae_createLayerMask", "ae.native.media.write", "write"),
    ToolCase("mask-properties", "ae_setLayerMaskProperties", "ae.native.media.write", "write"),
    ToolCase("mask-path-write", "ae_setLayerMaskPath", "ae.native.media.write", "write"),
    ToolCase("mask-duplicate", "ae_duplicateLayerMask", "ae.native.media.write", "write"),
    ToolCase("mask-delete", "ae_deleteLayerMask", "ae.native.media.write", "write"),
    ToolCase("footage-import", "ae_importFootage", "ae.native.media.write", "write"),
    ToolCase("footage-replace", "ae_replaceFootage", "ae.native.media.write", "write"),
    ToolCase(
        "footage-interpretation-write",
        "ae_setFootageInterpretation",
        "ae.native.media.write",
        "write",
    ),
    ToolCase("footage-proxy", "ae_setFootageProxy", "ae.native.media.write", "write"),
    ToolCase("item-use-proxy", "ae_setItemUseProxy", "ae.native.media.write", "write"),
)

SPEC = PackageSpec(
    issue=167,
    slug="native-effect-mask-footage-milestone",
    title="Native Effect Stack, Mask/Path, and Footage/Source Editing",
    native_novelty=True,
    milestone=True,
    t4_target_calls=11,
    t5_target_calls=56,
    t6_target_calls=56,
    t4_hard_limit=12,
    t5_hard_limit=56,
    t6_hard_limit=56,
    tools=(*READ_TOOLS, *WRITE_TOOLS),
    support_tools=(
        ToolCase("create-comp", "ae_createComposition", "ae.composition.create", "write"),
        ToolCase(
            "create-layer",
            "ae_createCompositionLayer",
            "ae.composition.layer.create",
            "write",
        ),
        ToolCase("apply-effect", "ae_applyLayerEffect", "ae.layer.effect.apply", "write", 2),
        ToolCase("items", "ae_listProjectItems", "ae.project.items.list", "read", 3),
        ToolCase("layers", "ae_listCompositionLayers", "ae.composition.layers.list", "read"),
    ),
)

EFFECT_MATCH_NAMES = ("CC Ball Action", "CC Bend It")
LAYER_NAME = "NATIVE_MEDIA_TARGET"


def _locator(value: Any, kinds: str | tuple[str, ...]) -> dict[str, Any]:
    locator = mapping(value, "native locator is invalid")
    expected = (kinds,) if isinstance(kinds, str) else kinds
    require(locator.get("kind") in expected, f"locator kind is not one of {expected}")
    require(set(locator) == {
        "kind", "hostInstanceId", "sessionId", "projectId", "generation", "objectId",
    }, "native locator is not closed")
    return locator


def _effect_reference(effect: Any, layer: Mapping[str, Any]) -> dict[str, Any]:
    value = mapping(effect, "effect reference is invalid")
    require(
        isinstance(value.get("effectIndex"), int)
        and isinstance(value.get("installedEffectKey"), int)
        and value["installedEffectKey"] != 0,
        "effect reference is incomplete",
    )
    return {
        "layer_locator": dict(layer),
        "effect_index": value["effectIndex"],
        "installed_effect_key": value["installedEffectKey"],
    }


def _mask_reference(mask: Any, layer: Mapping[str, Any]) -> dict[str, Any]:
    value = mapping(mask, "mask reference is invalid")
    require(
        isinstance(value.get("maskIndex"), int)
        and isinstance(value.get("maskId"), int)
        and value["maskId"] != 0,
        "mask reference is incomplete",
    )
    return {
        "layer_locator": dict(layer),
        "mask_index": value["maskIndex"],
        "mask_id": value["maskId"],
    }


def _png_bytes(rgba: tuple[int, int, int, int]) -> bytes:
    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + kind
            + payload
            + struct.pack(">I", binascii.crc32(kind + payload) & 0xFFFFFFFF)
        )

    width = height = 2
    scanline = b"\x00" + bytes(rgba) * width
    pixels = scanline * height
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(pixels, 9))
        + chunk(b"IEND", b"")
    )


class Issue167Package:
    def __init__(self, runtime: AcceptanceRuntime, *, fixture_name: str) -> None:
        self.runtime = runtime
        self.fixture_name = fixture_name
        self.cases = {
            case.tool: case for case in (*SPEC.tools, *SPEC.support_tools)
        }
        self.asset_root = runtime.fixture.path.with_suffix(".assets")
        self.assets = {
            "main": self.asset_root / "issue167-main.png",
            "replacement": self.asset_root / "issue167-replacement.png",
            "proxy": self.asset_root / "issue167-proxy.png",
        }

    async def _call(
        self,
        session: PublicSession,
        tool: str,
        arguments: Mapping[str, Any],
        *,
        phase: str,
    ) -> dict[str, Any]:
        case = self.cases[tool]
        return await self.runtime.call(
            session,
            tool,
            arguments,
            capability_id=case.capability_id,
            write=case.kind == "write",
            phase=phase,
            expected_replayed=False if case.kind == "write" else None,
        )

    def _create_assets(self) -> None:
        require(
            not os.path.lexists(self.asset_root),
            "active fixture asset directory already exists",
        )
        self.asset_root.mkdir(mode=0o700, parents=False, exist_ok=False)
        colors = {
            "main": (220, 40, 40, 180),
            "replacement": (40, 220, 40, 180),
            "proxy": (40, 40, 220, 180),
        }
        for key, path in self.assets.items():
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(_png_bytes(colors[key]))

    async def _save_empty_fixture(self) -> None:
        self.runtime.require_fixture_absent()
        await self.runtime.checkpoint("save-fixture", {
            "instruction": (
                "In formal After Effects, perform the initial naming save once to "
                "fixturePath. Do not create a Save As copy."
            ),
            "fixturePath": self.runtime.fixture.path,
            "activeFixtureCount": 1,
            "saveAsCopies": 0,
        })
        self.runtime.mark_fixture_created()

    async def _create_fixture(
        self,
        session: PublicSession,
        *,
        phase: str,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        await self._save_empty_fixture()
        composition_payload = await self._call(session, "ae_createComposition", {
            "name": self.fixture_name,
            "width": 640,
            "height": 360,
            "duration": {"value": 5, "scale": 1},
            "frame_rate": {"numerator": 24, "denominator": 1},
            "pixel_aspect_ratio": {"numerator": 1, "denominator": 1},
            "idempotency_key": self.runtime.intent("fixture-composition"),
        }, phase=phase)
        composition = _locator(
            native_value(composition_payload)["compositionLocator"], "composition"
        )
        layer_payload = await self._call(session, "ae_createCompositionLayer", {
            "composition_locator": composition,
            "kind": "solid",
            "name": LAYER_NAME,
            "color": {"red": 30, "green": 70, "blue": 110, "alpha": 255},
            "width": 320,
            "height": 180,
            "duration": {"value": 5, "scale": 1},
            "idempotency_key": self.runtime.intent("fixture-layer"),
        }, phase=phase)
        layer = _locator(native_value(layer_payload)["layerLocator"], "layer")
        return composition, layer

    async def _checkpoint_undo(self, tool: str) -> None:
        await self.runtime.checkpoint(f"undo-{tool}", {
            "instruction": (
                "Execute exactly one real After Effects Undo in the active disposable "
                "fixture, then acknowledge. Do not Save As."
            ),
            "tool": tool,
            "fixturePath": self.runtime.fixture.path,
            "activeFixtureCount": 1,
            "saveAsCopies": 0,
        })

    async def _checkpoint_redo(self, purpose: str) -> None:
        await self.runtime.checkpoint(f"redo-{purpose}", {
            "instruction": (
                "Execute exactly one real After Effects Redo to restore the verified "
                "fixture setup, then acknowledge. Do not Save As."
            ),
            "purpose": purpose,
            "fixturePath": self.runtime.fixture.path,
            "activeFixtureCount": 1,
            "saveAsCopies": 0,
        })

    async def _checkpoint_restart(self) -> None:
        await self.runtime.checkpoint("restart-formal-ae", {
            "instruction": (
                "Save in place, quit formal AE, launch formalAeApp by absolute path, "
                "then open fixturePath from formal AE File > Open; never Finder or "
                "LaunchServices."
            ),
            "formalAeApp": self.runtime.identity.formal_ae_app,
            "fixturePath": self.runtime.fixture.path,
            "saveAsCopies": 0,
        })

    async def _list_effects(
        self,
        session: PublicSession,
        layer: Mapping[str, Any],
        *,
        phase: str,
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        payload = await self._call(session, "ae_listLayerEffects", {
            "layer_locator": dict(layer), "offset": 0, "limit": 50,
        }, phase=phase)
        value = native_value(payload)
        effects = value.get("effects")
        require(isinstance(effects, list), "effect list omitted effects")
        return _locator(value["layerLocator"], "layer"), [
            mapping(item, "effect list row is invalid") for item in effects
        ]

    async def _list_masks(
        self,
        session: PublicSession,
        layer: Mapping[str, Any],
        *,
        phase: str,
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        payload = await self._call(session, "ae_listLayerMasks", {
            "layer_locator": dict(layer), "offset": 0, "limit": 50,
        }, phase=phase)
        value = native_value(payload)
        masks = value.get("masks")
        require(isinstance(masks, list), "mask list omitted masks")
        return _locator(value["layerLocator"], "layer"), [
            mapping(item, "mask list row is invalid") for item in masks
        ]

    async def _effect_details(
        self,
        session: PublicSession,
        effect: Mapping[str, Any],
        layer: Mapping[str, Any],
        *,
        phase: str,
    ) -> dict[str, Any]:
        payload = await self._call(
            session,
            "ae_getLayerEffectDetails",
            _effect_reference(effect, layer),
            phase=phase,
        )
        return mapping(native_value(payload)["effect"], "effect details are invalid")

    async def _mask_details(
        self,
        session: PublicSession,
        mask: Mapping[str, Any],
        layer: Mapping[str, Any],
        *,
        phase: str,
    ) -> dict[str, Any]:
        payload = await self._call(
            session,
            "ae_getLayerMaskDetails",
            _mask_reference(mask, layer),
            phase=phase,
        )
        return mapping(native_value(payload)["mask"], "mask details are invalid")

    async def _mask_path(
        self,
        session: PublicSession,
        mask: Mapping[str, Any],
        layer: Mapping[str, Any],
        *,
        phase: str,
    ) -> dict[str, Any]:
        payload = await self._call(
            session,
            "ae_getLayerMaskPath",
            _mask_reference(mask, layer),
            phase=phase,
        )
        return mapping(native_value(payload)["path"], "mask path is invalid")

    async def _project_items(
        self,
        session: PublicSession,
        *,
        phase: str,
    ) -> list[dict[str, Any]]:
        payload = await self._call(
            session,
            "ae_listProjectItems",
            {"offset": 0, "limit": 50},
            phase=phase,
        )
        items = native_value(payload).get("items")
        require(isinstance(items, list), "project item list omitted items")
        return [mapping(item, "project item row is invalid") for item in items]

    async def _refresh_layer(
        self,
        session: PublicSession,
        *,
        phase: str,
    ) -> dict[str, Any]:
        items = await self._project_items(session, phase=phase)
        return await self._reacquire_layer(session, items, phase=phase)

    @staticmethod
    def _one_footage(items: list[dict[str, Any]]) -> dict[str, Any]:
        footage = [item for item in items if item.get("type") == "footage"]
        require(len(footage) == 1, "fixture must contain exactly one footage item")
        return _locator(footage[0]["locator"], "item")

    @staticmethod
    def _items_matching_locator(
        items: list[dict[str, Any]],
        target: Mapping[str, Any],
    ) -> list[dict[str, Any]]:
        return [
            item
            for item in items
            if isinstance(item.get("locator"), Mapping)
            and item["locator"].get("projectId") == target.get("projectId")
            and item["locator"].get("objectId") == target.get("objectId")
        ]

    async def _footage_details(
        self,
        session: PublicSession,
        item: Mapping[str, Any],
        *,
        phase: str,
    ) -> dict[str, Any]:
        payload = await self._call(
            session,
            "ae_getFootageDetails",
            {"item_locator": dict(item)},
            phase=phase,
        )
        return native_value(payload)

    async def _footage_interpretation(
        self,
        session: PublicSession,
        item: Mapping[str, Any],
        *,
        phase: str,
    ) -> dict[str, Any]:
        payload = await self._call(
            session,
            "ae_getFootageInterpretation",
            {"item_locator": dict(item), "proxy": False},
            phase=phase,
        )
        return mapping(
            native_value(payload)["interpretation"],
            "footage interpretation is invalid",
        )

    async def _apply_effects(
        self,
        session: PublicSession,
        layer: Mapping[str, Any],
        *,
        phase: str,
    ) -> dict[str, Any]:
        installed_payload = await self._call(
            session,
            "ae_listInstalledEffects",
            {"offset": 0, "limit": 50},
            phase=phase,
        )
        installed = native_value(installed_payload).get("effects")
        require(isinstance(installed, list), "installed effect registry omitted effects")
        available = {
            item.get("matchName") for item in installed if isinstance(item, Mapping)
        }
        require(
            set(EFFECT_MATCH_NAMES).issubset(available),
            "required built-in acceptance effects are not installed",
        )
        current = dict(layer)
        for index, match_name in enumerate(EFFECT_MATCH_NAMES):
            payload = await self._call(session, "ae_applyLayerEffect", {
                "layer_locator": current,
                "effect_match_name": match_name,
                "idempotency_key": self.runtime.intent(f"fixture-effect-{index}"),
            }, phase=phase)
            current = _locator(native_value(payload)["layerLocator"], "layer")
        self.runtime.mark_tool_passed("ae_listInstalledEffects")
        return current

    async def _run_effects(
        self,
        session: PublicSession,
        layer: Mapping[str, Any],
        *,
        phase: str,
    ) -> dict[str, Any]:
        layer, baseline = await self._list_effects(session, layer, phase=phase)
        require(
            [item["matchName"] for item in baseline] == list(EFFECT_MATCH_NAMES),
            "fixture effect stack is not deterministic",
        )
        self.runtime.mark_tool_passed("ae_listLayerEffects")
        details = await self._effect_details(session, baseline[0], layer, phase=phase)
        require(details.get("active") is True, "fresh effect must be enabled")
        self.runtime.mark_tool_passed("ae_getLayerEffectDetails")

        payload = await self._call(session, "ae_setLayerEffectEnabled", {
            **_effect_reference(baseline[0], layer),
            "enabled": False,
            "idempotency_key": self.runtime.intent("effect-enabled"),
        }, phase=phase)
        require(native_value(payload).get("afterEnabled") is False, "effect disable readback failed")
        await self._checkpoint_undo("ae_setLayerEffectEnabled")
        restored = await self._effect_details(session, baseline[0], layer, phase=phase)
        require(restored.get("active") is True, "effect enabled Undo failed")
        self.runtime.mark_tool_passed(
            "ae_setLayerEffectEnabled", undo_executed=True, undo_verified=True
        )

        payload = await self._call(session, "ae_reorderLayerEffect", {
            **_effect_reference(baseline[0], layer),
            "target_index": 2,
            "idempotency_key": self.runtime.intent("effect-reorder"),
        }, phase=phase)
        layer = _locator(native_value(payload)["layerLocator"], "layer")
        await self._checkpoint_undo("ae_reorderLayerEffect")
        layer, restored_stack = await self._list_effects(session, layer, phase=phase)
        require(restored_stack == baseline, "effect reorder Undo failed")
        self.runtime.mark_tool_passed(
            "ae_reorderLayerEffect", undo_executed=True, undo_verified=True
        )

        payload = await self._call(session, "ae_duplicateLayerEffect", {
            **_effect_reference(restored_stack[0], layer),
            "idempotency_key": self.runtime.intent("effect-duplicate"),
        }, phase=phase)
        layer = _locator(native_value(payload)["layerLocator"], "layer")
        await self._checkpoint_undo("ae_duplicateLayerEffect")
        layer = await self._refresh_layer(
            session,
            phase=f"{phase}-effect-duplicate-undo-refresh",
        )
        layer, restored_stack = await self._list_effects(session, layer, phase=phase)
        require(restored_stack == baseline, "effect duplicate Undo failed")
        self.runtime.mark_tool_passed(
            "ae_duplicateLayerEffect", undo_executed=True, undo_verified=True
        )

        payload = await self._call(session, "ae_deleteLayerEffect", {
            **_effect_reference(restored_stack[1], layer),
            "idempotency_key": self.runtime.intent("effect-delete"),
        }, phase=phase)
        layer = _locator(native_value(payload)["layerLocator"], "layer")
        await self._checkpoint_undo("ae_deleteLayerEffect")
        layer = await self._refresh_layer(
            session,
            phase=f"{phase}-effect-delete-undo-refresh",
        )
        layer, restored_stack = await self._list_effects(session, layer, phase=phase)
        require(restored_stack == baseline, "effect delete Undo failed")
        self.runtime.mark_tool_passed(
            "ae_deleteLayerEffect", undo_executed=True, undo_verified=True
        )
        return layer

    async def _run_masks(
        self,
        session: PublicSession,
        layer: Mapping[str, Any],
        *,
        phase: str,
    ) -> dict[str, Any]:
        layer, baseline = await self._list_masks(session, layer, phase=phase)
        require(not baseline, "fixture layer unexpectedly has masks")
        self.runtime.mark_tool_passed("ae_listLayerMasks")

        payload = await self._call(session, "ae_createLayerMask", {
            "layer_locator": dict(layer),
            "idempotency_key": self.runtime.intent("mask-create"),
        }, phase=phase)
        value = native_value(payload)
        layer = _locator(value["layerLocator"], "layer")
        await self._checkpoint_undo("ae_createLayerMask")
        layer, restored = await self._list_masks(session, layer, phase=phase)
        require(restored == baseline, "mask create Undo failed")
        self.runtime.mark_tool_passed(
            "ae_createLayerMask", undo_executed=True, undo_verified=True
        )
        await self._checkpoint_redo("mask-create-setup")
        layer, current = await self._list_masks(session, layer, phase=phase)
        require(len(current) == 1, "mask create Redo did not restore one mask")
        mask = current[0]

        details = await self._mask_details(session, mask, layer, phase=phase)
        path = await self._mask_path(session, mask, layer, phase=phase)
        self.runtime.mark_tool_passed("ae_getLayerMaskDetails")
        self.runtime.mark_tool_passed("ae_getLayerMaskPath")

        payload = await self._call(session, "ae_setLayerMaskProperties", {
            **_mask_reference(mask, layer),
            "properties": {
                "mode": "subtract",
                "inverted": True,
                "color": {"red": 32, "green": 96, "blue": 160, "alpha": 255},
                "roto_bezier": True,
                "locked": True,
            },
            "idempotency_key": self.runtime.intent("mask-properties"),
        }, phase=phase)
        changed = mapping(native_value(payload)["mask"], "mask property result is invalid")
        require(
            changed.get("mode") == "subtract"
            and changed.get("inverted") is True
            and changed.get("locked") is True
            and changed.get("rotoBezier") is True,
            "mask property write readback failed",
        )
        await self._checkpoint_undo("ae_setLayerMaskProperties")
        restored_details = await self._mask_details(session, mask, layer, phase=phase)
        require(restored_details == details, "mask property Undo failed")
        self.runtime.mark_tool_passed(
            "ae_setLayerMaskProperties", undo_executed=True, undo_verified=True
        )

        triangle = [
            {"position": ["40", "40"], "in_tangent": ["0", "0"], "out_tangent": ["0", "0"]},
            {"position": ["280", "40"], "in_tangent": ["0", "0"], "out_tangent": ["0", "0"]},
            {"position": ["160", "140"], "in_tangent": ["0", "0"], "out_tangent": ["0", "0"]},
        ]
        payload = await self._call(session, "ae_setLayerMaskPath", {
            **_mask_reference(mask, layer),
            "closed": True,
            "vertices": triangle,
            "idempotency_key": self.runtime.intent("mask-path"),
        }, phase=phase)
        require(native_value(payload)["path"].get("closed") is True, "mask path write failed")
        await self._checkpoint_undo("ae_setLayerMaskPath")
        restored_path = await self._mask_path(session, mask, layer, phase=phase)
        require(restored_path == path, "mask path Undo failed")
        self.runtime.mark_tool_passed(
            "ae_setLayerMaskPath", undo_executed=True, undo_verified=True
        )

        payload = await self._call(session, "ae_duplicateLayerMask", {
            **_mask_reference(mask, layer),
            "target_index": 2,
            "idempotency_key": self.runtime.intent("mask-duplicate"),
        }, phase=phase)
        layer = _locator(native_value(payload)["layerLocator"], "layer")
        await self._checkpoint_undo("ae_duplicateLayerMask")
        layer, restored = await self._list_masks(session, layer, phase=phase)
        require(restored == current, "mask duplicate Undo failed")
        self.runtime.mark_tool_passed(
            "ae_duplicateLayerMask", undo_executed=True, undo_verified=True
        )

        payload = await self._call(session, "ae_deleteLayerMask", {
            **_mask_reference(restored[0], layer),
            "idempotency_key": self.runtime.intent("mask-delete"),
        }, phase=phase)
        layer = _locator(native_value(payload)["layerLocator"], "layer")
        await self._checkpoint_undo("ae_deleteLayerMask")
        layer, restored = await self._list_masks(session, layer, phase=phase)
        require(restored == current, "mask delete Undo failed")
        self.runtime.mark_tool_passed(
            "ae_deleteLayerMask", undo_executed=True, undo_verified=True
        )
        return layer

    async def _run_footage(
        self,
        session: PublicSession,
        *,
        phase: str,
    ) -> dict[str, Any]:
        payload = await self._call(session, "ae_importFootage", {
            "source_path": str(self.assets["main"]),
            "idempotency_key": self.runtime.intent("footage-import"),
        }, phase=phase)
        imported_value = native_value(payload)
        imported = _locator(imported_value["itemLocator"], "item")
        before_count = imported_value.get("beforeItemCount")
        after_count = imported_value.get("afterItemCount")
        require(
            isinstance(before_count, int)
            and after_count == before_count + 1,
            "footage import item-count evidence is invalid",
        )
        await self._checkpoint_undo("ae_importFootage")
        without_item = await self._project_items(session, phase=phase)
        require(
            len(without_item) == before_count
            and not self._items_matching_locator(without_item, imported),
            "footage import Undo left the imported project item",
        )
        self.runtime.mark_tool_passed(
            "ae_importFootage", undo_executed=True, undo_verified=True
        )
        await self._checkpoint_redo("footage-import-setup")
        restored_items = await self._project_items(session, phase=phase)
        restored_imports = self._items_matching_locator(restored_items, imported)
        require(
            len(restored_items) == after_count and len(restored_imports) == 1,
            "footage import Redo did not restore the imported project item",
        )
        item = _locator(restored_imports[0]["locator"], "item")
        require(
            item["projectId"] == imported["projectId"],
            "footage import Redo returned another project",
        )

        details = await self._footage_details(session, item, phase=phase)
        require(details.get("sourcePath") == str(self.assets["main"]),
                "imported footage path readback failed")
        interpretation = await self._footage_interpretation(session, item, phase=phase)
        self.runtime.mark_tool_passed("ae_getFootageDetails")
        self.runtime.mark_tool_passed("ae_getFootageInterpretation")

        payload = await self._call(session, "ae_replaceFootage", {
            "item_locator": item,
            "source_path": str(self.assets["replacement"]),
            "idempotency_key": self.runtime.intent("footage-replace"),
        }, phase=phase)
        require(native_value(payload).get("proxy") is False, "main footage replacement was not bound")
        await self._checkpoint_undo("ae_replaceFootage")
        restored = await self._footage_details(session, item, phase=phase)
        require(restored.get("sourcePath") == str(self.assets["main"]),
                "footage replacement Undo failed")
        self.runtime.mark_tool_passed(
            "ae_replaceFootage", undo_executed=True, undo_verified=True
        )

        payload = await self._call(session, "ae_setFootageInterpretation", {
            "item_locator": item,
            "proxy": False,
            "interpretation": {
                "alpha_mode": "premultiplied",
                "premultiply_color": {
                    "red": 12, "green": 24, "blue": 36, "alpha": 255,
                },
            },
            "idempotency_key": self.runtime.intent("footage-interpretation"),
        }, phase=phase)
        changed = mapping(
            native_value(payload)["interpretation"],
            "footage interpretation result is invalid",
        )
        require(changed.get("alphaMode") == "premultiplied",
                "footage interpretation write readback failed")
        await self._checkpoint_undo("ae_setFootageInterpretation")
        restored_interpretation = await self._footage_interpretation(
            session, item, phase=phase
        )
        require(restored_interpretation == interpretation,
                "footage interpretation Undo failed")
        self.runtime.mark_tool_passed(
            "ae_setFootageInterpretation", undo_executed=True, undo_verified=True
        )

        payload = await self._call(session, "ae_setFootageProxy", {
            "item_locator": item,
            "source_path": str(self.assets["proxy"]),
            "idempotency_key": self.runtime.intent("footage-proxy"),
        }, phase=phase)
        require(native_value(payload).get("proxy") is True, "proxy footage write was not bound")
        await self._checkpoint_undo("ae_setFootageProxy")
        restored = await self._footage_details(session, item, phase=phase)
        require(restored.get("hasProxy") is False, "proxy footage Undo failed")
        self.runtime.mark_tool_passed(
            "ae_setFootageProxy", undo_executed=True, undo_verified=True
        )
        await self._checkpoint_redo("footage-proxy-setup")

        payload = await self._call(session, "ae_setItemUseProxy", {
            "item_locator": item,
            "enabled": True,
            "idempotency_key": self.runtime.intent("item-use-proxy"),
        }, phase=phase)
        require(native_value(payload).get("afterEnabled") is True,
                "proxy selection write readback failed")
        await self._checkpoint_undo("ae_setItemUseProxy")
        restored = await self._footage_details(session, item, phase=phase)
        require(restored.get("hasProxy") is True and restored.get("usingProxy") is False,
                "proxy selection Undo failed")
        self.runtime.mark_tool_passed(
            "ae_setItemUseProxy", undo_executed=True, undo_verified=True
        )
        return item

    async def _reacquire_layer(
        self,
        session: PublicSession,
        items: list[dict[str, Any]],
        *,
        phase: str,
    ) -> dict[str, Any]:
        compositions = [
            item for item in items
            if item.get("type") == "composition" and item.get("name") == self.fixture_name
        ]
        require(len(compositions) == 1, "fixture composition is not unique after reopen")
        composition = _locator(compositions[0]["locator"], "composition")
        payload = await self._call(session, "ae_listCompositionLayers", {
            "composition_locator": composition, "offset": 0, "limit": 25,
        }, phase=phase)
        layers = native_value(payload).get("layers")
        require(isinstance(layers, list), "layer list omitted layers")
        targets = [
            mapping(layer, "layer row is invalid")
            for layer in layers
            if isinstance(layer, Mapping) and layer.get("name") == LAYER_NAME
        ]
        require(len(targets) == 1, "fixture layer is not unique after reopen")
        return _locator(targets[0]["locator"], "layer")

    async def _archive_assets(self, archived: Mapping[str, Any]) -> dict[str, Any]:
        require(self.asset_root.is_dir() and not self.asset_root.is_symlink(),
                "fixture assets are missing before archive")
        archive_path = Path(archived["archivePath"])
        destination = archive_path.parent / "assets"
        require(not os.path.lexists(destination), "fixture asset archive already exists")
        shutil.move(str(self.asset_root), str(destination))
        require(not os.path.lexists(self.asset_root), "active fixture assets remained")
        return {
            "archived": True,
            "files": sorted(path.name for path in destination.iterdir()),
            "sha256": {
                path.name: self.runtime._sha256_file(path, "fixture asset")
                for path in sorted(destination.iterdir())
            },
        }

    async def _run_preflight_initial(
        self,
        session: PublicSession,
    ) -> None:
        _composition, _layer = await self._create_fixture(
            session, phase="preflight-fixture"
        )

    async def _run_t4_initial(
        self,
        session: PublicSession,
    ) -> None:
        _composition, layer = await self._create_fixture(session, phase="t4-fixture")
        installed_payload = await self._call(
            session,
            "ae_listInstalledEffects",
            {"offset": 0, "limit": 50},
            phase="t4-setup",
        )
        installed = native_value(installed_payload).get("effects")
        require(isinstance(installed, list), "installed effect registry omitted effects")
        require(
            EFFECT_MATCH_NAMES[0]
            in {
                item.get("matchName")
                for item in installed
                if isinstance(item, Mapping)
            },
            "required built-in T4 effect is not installed",
        )
        payload = await self._call(session, "ae_applyLayerEffect", {
            "layer_locator": layer,
            "effect_match_name": EFFECT_MATCH_NAMES[0],
            "idempotency_key": self.runtime.intent("t4-fixture-effect"),
        }, phase="t4-setup")
        layer = _locator(native_value(payload)["layerLocator"], "layer")
        self.runtime.mark_tool_passed("ae_listInstalledEffects")
        layer, effects = await self._list_effects(session, layer, phase="t4-effect")
        self.runtime.mark_tool_passed("ae_listLayerEffects")
        payload = await self._call(session, "ae_setLayerEffectEnabled", {
            **_effect_reference(effects[0], layer),
            "enabled": False,
            "idempotency_key": self.runtime.intent("t4-effect-enabled"),
        }, phase="t4-effect")
        require(native_value(payload).get("afterEnabled") is False, "T4 effect write failed")
        await self._checkpoint_undo("ae_setLayerEffectEnabled")
        details = await self._effect_details(session, effects[0], layer, phase="t4-effect")
        require(details.get("active") is True, "T4 effect Undo failed")
        self.runtime.mark_tool_passed("ae_getLayerEffectDetails")
        self.runtime.mark_tool_passed(
            "ae_setLayerEffectEnabled", undo_executed=True, undo_verified=True
        )

        payload = await self._call(session, "ae_createLayerMask", {
            "layer_locator": layer,
            "idempotency_key": self.runtime.intent("t4-mask-create"),
        }, phase="t4-mask")
        layer = _locator(native_value(payload)["layerLocator"], "layer")
        await self._checkpoint_undo("ae_createLayerMask")
        layer, masks = await self._list_masks(session, layer, phase="t4-mask")
        require(not masks, "T4 mask Undo failed")
        self.runtime.mark_tool_passed("ae_listLayerMasks")
        self.runtime.mark_tool_passed(
            "ae_createLayerMask", undo_executed=True, undo_verified=True
        )

        payload = await self._call(session, "ae_importFootage", {
            "source_path": str(self.assets["main"]),
            "idempotency_key": self.runtime.intent("t4-footage-import"),
        }, phase="t4-footage")
        imported_value = native_value(payload)
        imported = _locator(imported_value["itemLocator"], "item")
        before_count = imported_value.get("beforeItemCount")
        require(
            isinstance(before_count, int)
            and imported_value.get("afterItemCount") == before_count + 1,
            "T4 footage import item-count evidence is invalid",
        )
        await self._checkpoint_undo("ae_importFootage")
        items = await self._project_items(session, phase="t4-footage")
        require(
            len(items) == before_count
            and not self._items_matching_locator(items, imported),
            "T4 footage Undo left the imported project item",
        )
        self.runtime.mark_tool_passed(
            "ae_importFootage", undo_executed=True, undo_verified=True
        )
        require(self.runtime.ledger.total == 11, "T4 must use exactly eleven public calls")

    async def _run_acceptance_initial(
        self,
        session: PublicSession,
    ) -> dict[str, str]:
        _composition, layer = await self._create_fixture(
            session, phase=f"{self.runtime.mode}-fixture"
        )
        layer = await self._apply_effects(
            session, layer, phase=f"{self.runtime.mode}-effects"
        )
        layer = await self._run_effects(
            session, layer, phase=f"{self.runtime.mode}-effects"
        )
        layer = await self._run_masks(
            session, layer, phase=f"{self.runtime.mode}-masks"
        )
        item = await self._run_footage(
            session, phase=f"{self.runtime.mode}-footage"
        )
        before_restart = {
            "effects": json_hash((await self._list_effects(
                session, layer, phase=f"{self.runtime.mode}-pre-restart"
            ))[1]),
            "masks": json_hash((await self._list_masks(
                session, layer, phase=f"{self.runtime.mode}-pre-restart"
            ))[1]),
            "footage": json_hash(await self._footage_details(
                session, item, phase=f"{self.runtime.mode}-pre-restart"
            )),
            "interpretation": json_hash(await self._footage_interpretation(
                session, item, phase=f"{self.runtime.mode}-pre-restart"
            )),
        }
        return before_restart

    async def _verify_restarted_state(
        self,
        first_instance: str,
        before_restart: Mapping[str, str],
    ) -> dict[str, Any]:
        await self._checkpoint_restart()
        second = self.runtime.bind_latest_native_load(
            stage=f"{self.runtime.mode}-restart",
            previous_instance_id=first_instance,
        )
        async with self.runtime.session_factory() as restarted:
            self.runtime.require_tools(restarted, self.cases)
            items = await self._project_items(
                restarted, phase=f"{self.runtime.mode}-restart"
            )
            layer = await self._reacquire_layer(
                restarted, items, phase=f"{self.runtime.mode}-restart"
            )
            item = self._one_footage(items)
            layer, effects = await self._list_effects(
                restarted, layer, phase=f"{self.runtime.mode}-restart"
            )
            layer, masks = await self._list_masks(
                restarted, layer, phase=f"{self.runtime.mode}-restart"
            )
            footage = await self._footage_details(
                restarted, item, phase=f"{self.runtime.mode}-restart"
            )
            interpretation = await self._footage_interpretation(
                restarted, item, phase=f"{self.runtime.mode}-restart"
            )
        after_restart = {
            "effects": json_hash(effects),
            "masks": json_hash(masks),
            "footage": json_hash(footage),
            "interpretation": json_hash(interpretation),
        }
        require(
            dict(before_restart) == after_restart,
            "formal AE restart changed fixture state",
        )
        for case in SPEC.tools:
            require(
                self.runtime.matrix[case.tool]["status"] == "passed",
                f"{case.tool} did not pass the acceptance matrix",
            )
        require(
            self.runtime.ledger.total == 56,
            f"#167 {self.runtime.mode} must use exactly 56 public calls",
        )
        return {
            "firstHostInstanceId": first_instance,
            "restartHostInstanceId": second,
            "restartVerified": True,
            "stateSha256": after_restart,
        }

    async def _archive_completed_fixture(self) -> dict[str, Any]:
        archived = await self.runtime.archive_fixture()
        assets = await self._archive_assets(archived)
        return {"archived": archived, "assets": assets}

    async def run(self) -> dict[str, Any]:
        self.runtime.validate_machine_identity()
        self._create_assets()
        try:
            await self.runtime.checkpoint("prepare-formal-ae", {
                "instruction": (
                    "Launch only formalAeApp. Complete any native pairing as one "
                    "continuous automation action. Do not open the fixture through Finder."
                ),
                "formalAeApp": self.runtime.identity.formal_ae_app,
                "fixturePath": self.runtime.fixture.path,
                "candidateRun": self.runtime.mode in {"t5", "t6"},
                "candidateEvidence": False,
            })
            first = self.runtime.bind_latest_native_load(
                stage=f"{self.runtime.mode}-initial"
            )
            required = list(self.cases)
            async with self.runtime.session_factory() as session:
                self.runtime.require_tools(session, required)
                if self.runtime.mode == "preflight":
                    await self._run_preflight_initial(session)
                    initial: dict[str, str] | None = None
                elif self.runtime.mode == "t4":
                    await self._run_t4_initial(session)
                    initial = None
                else:
                    initial = await self._run_acceptance_initial(session)

            if self.runtime.mode == "preflight":
                await self._checkpoint_restart()
                second = self.runtime.bind_latest_native_load(
                    stage="preflight-restart",
                    previous_instance_id=first,
                )
                async with self.runtime.session_factory() as restarted:
                    self.runtime.require_tools(restarted, self.cases)
                    items = await self._project_items(
                        restarted, phase="preflight-reopen"
                    )
                    await self._reacquire_layer(
                        restarted, items, phase="preflight-reopen"
                    )
                require(
                    self.runtime.ledger.total == 4,
                    "preflight must use exactly four public calls",
                )
                result = {
                    "restartVerified": True,
                    "firstHostInstanceId": first,
                    "restartHostInstanceId": second,
                }
            elif self.runtime.mode == "t4":
                result = {"nativeNoveltySmoke": True}
            else:
                require(initial is not None, "acceptance initial state is missing")
                result = await self._verify_restarted_state(first, initial)

            result.update(await self._archive_completed_fixture())
            return result
        except BaseException:
            if (
                self.runtime.ledger.total == 0
                and self.asset_root.is_dir()
            ):
                destination = (
                    self.runtime.fixture.recovery_root
                    / f"{self.runtime.evidence.run_id}-assets"
                )
                destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                require(
                    not os.path.lexists(destination),
                    "zero-call asset recovery destination already exists",
                )
                shutil.move(str(self.asset_root), str(destination))
                self.runtime.evidence.record(
                    "fixture-assets-recovered-before-first-call",
                    {
                        "lifecycle": "ephemeral-validation",
                        "sourceAbsent": True,
                        "fileCount": len(self.assets),
                        "cleanupCondition": (
                            "zero public calls and no AE mutation; remove after "
                            "the failed preflight is diagnosed"
                        ),
                    },
                )
            raise


__all__ = ["EFFECT_MATCH_NAMES", "Issue167Package", "READ_TOOLS", "SPEC", "WRITE_TOOLS"]
