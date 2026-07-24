"""Focused contracts for the bounded #167 hardware acceptance workflow."""

from __future__ import annotations

import contextlib
import importlib.util
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest


ROOT = Path(__file__).resolve().parents[3]
HARDWARE = ROOT / "scripts/hardware"


def _load(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


sys.path.insert(0, str(HARDWARE))
runtime_module = _load(
    "capability_package_runtime",
    HARDWARE / "capability_package_runtime.py",
)
package = _load(
    "issue167_native_media_spec",
    HARDWARE / "issue167_native_media_spec.py",
)


def _cases(count: int):
    return tuple(
        runtime_module.ToolCase(
            f"case-{index}",
            f"ae_fixtureTool{index}",
            "ae.fixture.read",
            "read",
        )
        for index in range(count)
    )


def test_milestone_freeze_is_explicit_and_bounded() -> None:
    assert package.SPEC.issue == 167
    assert package.SPEC.milestone is True
    assert len(package.SPEC.tools) == 22
    assert len(package.SPEC.write_tools) == 14
    assert package.SPEC.t4_target_calls == 6
    assert package.SPEC.t4_hard_limit == 7
    assert package.SPEC.t5_target_calls == package.SPEC.t5_hard_limit == 60
    assert package.SPEC.t6_target_calls == package.SPEC.t6_hard_limit == 60
    assert len({case.tool for case in package.SPEC.tools}) == 22


def test_normal_package_limit_stays_closed_while_milestone_is_explicit() -> None:
    with pytest.raises(
        runtime_module.AcceptanceFailure,
        match="capability package must contain 5..15 tools",
    ):
        runtime_module.PackageSpec(
            issue=1,
            slug="too-large",
            title="Too large",
            native_novelty=False,
            tools=_cases(16),
        )

    milestone = runtime_module.PackageSpec(
        issue=2,
        slug="bounded-milestone",
        title="Bounded milestone",
        native_novelty=True,
        milestone=True,
        tools=_cases(22),
        t4_target_calls=11,
        t4_hard_limit=12,
        t5_target_calls=56,
        t5_hard_limit=56,
        t6_target_calls=56,
        t6_hard_limit=56,
    )
    assert len(milestone.tools) == 22


def test_fixture_assets_are_small_deterministic_rgba_pngs() -> None:
    first = package._png_bytes((1, 2, 3, 4))
    second = package._png_bytes((1, 2, 3, 4))
    different = package._png_bytes((4, 3, 2, 1))
    assert first == second
    assert first != different
    assert first.startswith(b"\x89PNG\r\n\x1a\n")
    assert first[12:16] == b"IHDR"
    assert int.from_bytes(first[16:20], "big") == 2
    assert int.from_bytes(first[20:24], "big") == 2


@pytest.mark.asyncio
async def test_project_item_reads_respect_the_public_page_limit(tmp_path: Path) -> None:
    class Runtime:
        fixture = SimpleNamespace(path=tmp_path / "fixture.aep")

        def __init__(self) -> None:
            self.arguments = None

        async def call(self, _session, tool, arguments, **_metadata):
            assert tool == "ae_listProjectItems"
            self.arguments = arguments
            return {"value": {"items": []}}

    runtime = Runtime()
    runner = package.Issue167Package(runtime, fixture_name="fixture")
    assert await runner._project_items(object(), phase="fixture-reopen") == []
    assert runtime.arguments == {"offset": 0, "limit": 50}


class _BoundaryRuntime:
    def __init__(self, tmp_path: Path, mode: str) -> None:
        self.mode = mode
        self.fixture = SimpleNamespace(
            path=tmp_path / "active.aep",
            recovery_root=tmp_path / "recovery",
        )
        self.identity = SimpleNamespace(formal_ae_app=Path("/Applications/Formal AE.app"))
        self.ledger = SimpleNamespace(total=0)
        self.aep_lifecycle = SimpleNamespace(created=0)
        self.evidence = SimpleNamespace(run_id="run")
        self.session_open = False
        self.checkpoints: list[str] = []
        self.binds: list[tuple[str, str | None]] = []

    def validate_machine_identity(self) -> None:
        return None

    async def checkpoint(self, kind: str, _details) -> None:
        if kind in {"restart-formal-ae", "archive-fixture"}:
            assert self.session_open is False
        self.checkpoints.append(kind)

    def bind_latest_native_load(
        self,
        *,
        stage: str,
        previous_instance_id: str | None = None,
    ) -> str:
        self.binds.append((stage, previous_instance_id))
        return "first" if previous_instance_id is None else "second"

    @contextlib.asynccontextmanager
    async def session_factory(self):
        assert self.session_open is False
        self.session_open = True
        try:
            yield object()
        finally:
            self.session_open = False

    def require_tools(self, _session, _required) -> None:
        assert self.session_open is True


class _BoundaryPackage(package.Issue167Package):
    def _create_assets(self) -> None:
        return None

    async def _run_preflight_initial(self, _session) -> None:
        assert self.runtime.session_open is True

    async def _run_t4_initial(self, _session) -> None:
        assert self.runtime.session_open is True

    async def _run_acceptance_initial(self, _session):
        assert self.runtime.session_open is True
        return {"state": "before"}

    async def _project_items(self, _session, *, phase: str):
        assert self.runtime.session_open is True
        assert phase == "preflight-reopen"
        return []

    async def _reacquire_layer(self, _session, _items, *, phase: str):
        assert self.runtime.session_open is True
        assert phase == "preflight-reopen"
        self.runtime.ledger.total = 4
        return {}

    async def _verify_restarted_state(self, first_instance, before_restart):
        assert self.runtime.session_open is False
        assert first_instance == "first"
        assert before_restart == {"state": "before"}
        return {"restartVerified": True}

    async def _archive_completed_fixture(self):
        assert self.runtime.session_open is False
        return {"archived": {"sourceAbsent": True}, "assets": {"archived": True}}


def _locator(kind: str, object_id: str) -> dict[str, object]:
    return {
        "kind": kind,
        "hostInstanceId": "11111111-1111-4111-8111-111111111111",
        "sessionId": "22222222-2222-4222-8222-222222222222",
        "projectId": "33333333-3333-4333-8333-333333333333",
        "generation": 1,
        "objectId": object_id,
    }


class _T4Runtime:
    mode = "t4"

    def __init__(self, tmp_path: Path) -> None:
        self.fixture = SimpleNamespace(path=tmp_path / "fixture.aep")
        self.ledger = SimpleNamespace(total=0)
        self.calls: list[str] = []
        self.passed: list[str] = []

    async def checkpoint(self, _kind: str, _details) -> None:
        return None

    def mark_tool_passed(self, tool: str, **_details) -> None:
        self.passed.append(tool)

    def intent(self, purpose: str) -> str:
        return f"issue167-{purpose}"


class _T4Package(package.Issue167Package):
    async def _create_fixture(self, _session, *, phase: str):
        assert phase == "t4-fixture"
        await self._call(_session, "ae_createComposition", {}, phase=phase)
        await self._call(_session, "ae_createCompositionLayer", {}, phase=phase)
        return _locator("composition", "44444444-4444-4444-8444-444444444444"), (
            _locator("layer", "55555555-5555-4555-8555-555555555555")
        )

    async def _call(self, _session, tool: str, _arguments, *, phase: str):
        assert phase.startswith("t4-")
        if tool == "ae_listInstalledEffects":
            assert _arguments == {"offset": 0, "limit": 50}
        self.runtime.calls.append(tool)
        self.runtime.ledger.total += 1
        layer = _locator("layer", "55555555-5555-4555-8555-555555555555")
        if tool == "ae_createComposition":
            value = {
                "compositionLocator": _locator(
                    "composition", "44444444-4444-4444-8444-444444444444"
                )
            }
        elif tool == "ae_createCompositionLayer":
            value = {"layerLocator": layer}
        elif tool == "ae_listInstalledEffects":
            value = {"effects": [{"matchName": package.EFFECT_MATCH_NAMES[0]}]}
        elif tool == "ae_applyLayerEffect":
            assert _arguments["effect_match_name"] == package.EFFECT_MATCH_NAMES[0]
            assert "match_name" not in _arguments
            value = {"layerLocator": layer}
        elif tool == "ae_listLayerEffects":
            value = {
                "layerLocator": layer,
                "effects": [{
                    "effectIndex": 1,
                    "installedEffectKey": 7,
                    "matchName": package.EFFECT_MATCH_NAMES[0],
                }],
            }
        elif tool == "ae_setLayerEffectEnabled":
            value = {"afterEnabled": False}
        elif tool == "ae_getLayerEffectDetails":
            value = {"effect": {"active": True}}
        elif tool == "ae_createLayerMask":
            value = {"layerLocator": layer}
        elif tool == "ae_listLayerMasks":
            value = {"layerLocator": layer, "masks": []}
        elif tool == "ae_importFootage":
            value = {
                "itemLocator": _locator(
                    "item", "66666666-6666-4666-8666-666666666666"
                ),
                "beforeItemCount": 3,
                "afterItemCount": 4,
            }
        elif tool == "ae_listProjectItems":
            value = {
                "items": [
                    {
                        "type": "footage",
                        "locator": _locator(
                            "item", "77777777-7777-4777-8777-777777777777"
                        ),
                    },
                    {
                        "type": "composition",
                        "name": "fixture",
                        "locator": _locator(
                            "composition", "88888888-8888-4888-8888-888888888888"
                        ),
                    },
                    {
                        "type": "folder",
                        "locator": _locator(
                            "item", "99999999-9999-4999-8999-999999999999"
                        ),
                    },
                ],
            }
        elif tool == "ae_listCompositionLayers":
            value = {
                "layers": [{
                    "name": package.LAYER_NAME,
                    "locator": layer,
                }],
            }
        else:
            raise AssertionError(f"unexpected T4 tool {tool}")
        return {"value": value}


@pytest.mark.asyncio
async def test_t4_smoke_uses_exactly_six_public_calls(tmp_path: Path) -> None:
    runtime = _T4Runtime(tmp_path)
    runner = _T4Package(runtime, fixture_name="fixture")
    await runner._run_t4_initial(object())
    assert runtime.calls == [
        "ae_createComposition",
        "ae_createCompositionLayer",
        "ae_createLayerMask",
        "ae_listProjectItems",
        "ae_listCompositionLayers",
        "ae_listLayerMasks",
    ]

def test_footage_locator_matching_ignores_other_fixture_footage(
    tmp_path: Path,
) -> None:
    runner = package.Issue167Package(_T4Runtime(tmp_path), fixture_name="fixture")
    imported = _locator("item", "66666666-6666-4666-8666-666666666666")
    baseline = {
        "type": "footage",
        "locator": _locator("item", "77777777-7777-4777-8777-777777777777"),
    }
    restored = {"type": "footage", "locator": dict(imported)}

    assert runner._items_matching_locator([baseline], imported) == []
    assert runner._items_matching_locator([baseline, restored], imported) == [restored]


@pytest.mark.asyncio
async def test_acceptance_effect_discovery_respects_the_public_page_limit(
    tmp_path: Path,
) -> None:
    class Runtime:
        fixture = SimpleNamespace(path=tmp_path / "fixture.aep")

        @staticmethod
        def intent(purpose: str) -> str:
            return f"issue167-{purpose}"

        @staticmethod
        def mark_tool_passed(_tool: str, **_details) -> None:
            return None

    class EffectsPackage(package.Issue167Package):
        def __init__(self) -> None:
            super().__init__(Runtime(), fixture_name="fixture")
            self.discovery_arguments = None
            self.apply_arguments = []

        async def _call(self, _session, tool: str, arguments, *, phase: str):
            assert phase == "t5-effects"
            if tool == "ae_listInstalledEffects":
                self.discovery_arguments = arguments
                return {
                    "value": {
                        "effects": [
                            {"matchName": match_name}
                            for match_name in package.EFFECT_MATCH_NAMES
                        ]
                    }
                }
            assert tool == "ae_applyLayerEffect"
            self.apply_arguments.append(arguments)
            return {"value": {"layerLocator": arguments["layer_locator"]}}

    runner = EffectsPackage()
    layer = _locator("layer", "77777777-7777-4777-8777-777777777777")
    assert await runner._apply_effects(object(), layer, phase="t5-effects") == layer
    assert runner.discovery_arguments == {"offset": 0, "limit": 50}
    assert [
        arguments["effect_match_name"] for arguments in runner.apply_arguments
    ] == list(package.EFFECT_MATCH_NAMES)
    assert all(
        "match_name" not in arguments for arguments in runner.apply_arguments
    )


@pytest.mark.asyncio
async def test_structural_effect_undo_reacquires_a_fresh_layer_locator(
    tmp_path: Path,
) -> None:
    class Runtime:
        fixture = SimpleNamespace(path=tmp_path / "fixture.aep")

        def __init__(self) -> None:
            self.passed: list[str] = []

        @staticmethod
        def intent(purpose: str) -> str:
            return f"issue167-{purpose}"

        def mark_tool_passed(self, tool: str, **_details) -> None:
            self.passed.append(tool)

    class EffectsPackage(package.Issue167Package):
        def __init__(self) -> None:
            super().__init__(Runtime(), fixture_name="fixture")
            self.generation = 1
            self.refreshes: list[str] = []
            self.baseline = [
                {
                    "effectIndex": 1,
                    "installedEffectKey": 7,
                    "matchName": package.EFFECT_MATCH_NAMES[0],
                },
                {
                    "effectIndex": 2,
                    "installedEffectKey": 8,
                    "matchName": package.EFFECT_MATCH_NAMES[1],
                },
            ]

        def layer(self):
            locator = _locator(
                "layer", "77777777-7777-4777-8777-777777777777"
            )
            locator["generation"] = self.generation
            return locator

        async def _call(self, _session, tool: str, _arguments, *, phase: str):
            assert phase == "t5-effects"
            if tool == "ae_setLayerEffectEnabled":
                return {"value": {"afterEnabled": False}}
            if tool in {
                "ae_reorderLayerEffect",
                "ae_duplicateLayerEffect",
                "ae_deleteLayerEffect",
            }:
                return {"value": {"layerLocator": self.layer()}}
            raise AssertionError(f"unexpected effect tool {tool}")

        async def _list_effects(self, _session, layer, *, phase: str):
            assert phase == "t5-effects"
            assert layer["generation"] == self.generation, "STALE_LOCATOR"
            return self.layer(), [dict(effect) for effect in self.baseline]

        async def _effect_details(self, _session, _effect, layer, *, phase: str):
            assert phase == "t5-effects"
            assert layer["generation"] == self.generation, "STALE_LOCATOR"
            return {"active": True}

        async def _checkpoint_undo(self, tool: str) -> None:
            if tool in {"ae_duplicateLayerEffect", "ae_deleteLayerEffect"}:
                self.generation += 1

        async def _project_items(self, _session, *, phase: str):
            self.refreshes.append(phase)
            return [{"type": "composition", "name": "fixture"}]

        async def _reacquire_layer(self, _session, _items, *, phase: str):
            assert phase == self.refreshes[-1]
            return self.layer()

    runner = EffectsPackage()
    restored, effects = await runner._run_effects(
        object(), runner.layer(), phase="t5-effects"
    )

    assert restored == runner.layer()
    assert effects == runner.baseline
    assert runner.refreshes == [
        "t5-effects-effect-duplicate-undo-refresh",
        "t5-effects-effect-delete-undo-refresh",
    ]
    assert runner.runtime.passed == [
        "ae_listLayerEffects",
        "ae_getLayerEffectDetails",
        "ae_setLayerEffectEnabled",
        "ae_reorderLayerEffect",
        "ae_duplicateLayerEffect",
        "ae_deleteLayerEffect",
    ]


@pytest.mark.asyncio
async def test_structural_mask_history_reacquires_a_fresh_layer_locator(
    tmp_path: Path,
) -> None:
    class Runtime:
        fixture = SimpleNamespace(path=tmp_path / "fixture.aep")

        def __init__(self) -> None:
            self.passed: list[str] = []

        @staticmethod
        def intent(purpose: str) -> str:
            return f"issue167-{purpose}"

        def mark_tool_passed(self, tool: str, **_details) -> None:
            self.passed.append(tool)

    class MasksPackage(package.Issue167Package):
        def __init__(self) -> None:
            super().__init__(Runtime(), fixture_name="fixture")
            self.generation = 1
            self.mask_count = 0
            self.refreshes: list[str] = []
            self.details = {
                "maskIndex": 1,
                "maskId": 7,
                "mode": "add",
                "inverted": False,
                "locked": False,
                "rotoBezier": False,
            }
            self.path = {"closed": False, "vertices": []}

        def layer(self):
            locator = _locator(
                "layer", "77777777-7777-4777-8777-777777777777"
            )
            locator["generation"] = self.generation
            return locator

        def masks(self):
            return [
                {"maskIndex": index + 1, "maskId": 7 + index}
                for index in range(self.mask_count)
            ]

        def require_fresh(self, layer) -> None:
            assert layer["generation"] == self.generation, "STALE_LOCATOR"

        async def _call(self, _session, tool: str, arguments, *, phase: str):
            assert phase == "t5-masks"
            self.require_fresh(arguments["layer_locator"])
            if tool == "ae_createLayerMask":
                assert self.mask_count == 0
                self.generation += 1
                self.mask_count = 1
                return {"value": {"layerLocator": self.layer()}}
            if tool == "ae_setLayerMaskProperties":
                return {
                    "value": {
                        "mask": {
                            **self.details,
                            "mode": "subtract",
                            "inverted": True,
                            "locked": True,
                            "rotoBezier": True,
                        }
                    }
                }
            if tool == "ae_setLayerMaskPath":
                return {"value": {"path": {"closed": True, "vertices": []}}}
            if tool == "ae_duplicateLayerMask":
                assert self.mask_count == 1
                self.generation += 1
                self.mask_count = 2
                return {"value": {"layerLocator": self.layer()}}
            if tool == "ae_deleteLayerMask":
                assert self.mask_count == 1
                self.generation += 1
                self.mask_count = 0
                return {"value": {"layerLocator": self.layer()}}
            raise AssertionError(f"unexpected mask tool {tool}")

        async def _list_masks(self, _session, layer, *, phase: str):
            assert phase == "t5-masks"
            self.require_fresh(layer)
            return self.layer(), self.masks()

        async def _mask_details(self, _session, _mask, layer, *, phase: str):
            assert phase == "t5-masks"
            self.require_fresh(layer)
            return dict(self.details)

        async def _mask_path(self, _session, _mask, layer, *, phase: str):
            assert phase == "t5-masks"
            self.require_fresh(layer)
            return dict(self.path)

        async def _checkpoint_undo(self, tool: str) -> None:
            if tool == "ae_createLayerMask":
                assert self.mask_count == 1
                self.generation += 1
                self.mask_count = 0
            elif tool == "ae_duplicateLayerMask":
                assert self.mask_count == 2
                self.generation += 1
                self.mask_count = 1
            elif tool == "ae_deleteLayerMask":
                assert self.mask_count == 0
                self.generation += 1
                self.mask_count = 1

        async def _checkpoint_redo(self, purpose: str) -> None:
            assert purpose == "mask-create-setup"
            assert self.mask_count == 0
            self.generation += 1
            self.mask_count = 1

        async def _project_items(self, _session, *, phase: str):
            self.refreshes.append(phase)
            return [{"type": "composition", "name": "fixture"}]

        async def _reacquire_layer(self, _session, _items, *, phase: str):
            assert phase == self.refreshes[-1]
            return self.layer()

    runner = MasksPackage()
    restored, masks = await runner._run_masks(
        object(), runner.layer(), phase="t5-masks"
    )

    assert restored == runner.layer()
    assert masks == runner.masks()
    assert runner.refreshes == [
        "t5-masks-mask-create-undo-refresh",
        "t5-masks-mask-create-redo-refresh",
        "t5-masks-mask-duplicate-undo-refresh",
        "t5-masks-mask-delete-undo-refresh",
    ]
    assert runner.runtime.passed == [
        "ae_listLayerMasks",
        "ae_createLayerMask",
        "ae_getLayerMaskDetails",
        "ae_getLayerMaskPath",
        "ae_setLayerMaskProperties",
        "ae_setLayerMaskPath",
        "ae_duplicateLayerMask",
        "ae_deleteLayerMask",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["preflight", "t4", "t5", "t6"])
async def test_sessions_close_before_restart_or_archive(
    tmp_path: Path,
    mode: str,
) -> None:
    runtime = _BoundaryRuntime(tmp_path, mode)
    result = await _BoundaryPackage(runtime, fixture_name="fixture").run()
    assert runtime.session_open is False
    assert result["archived"]["sourceAbsent"] is True
    if mode == "preflight":
        assert runtime.checkpoints == ["prepare-formal-ae", "restart-formal-ae"]
        assert runtime.binds == [
            ("preflight-initial", None),
            ("preflight-restart", "first"),
        ]
    else:
        assert runtime.checkpoints == ["prepare-formal-ae"]
        assert runtime.binds == [(f"{mode}-initial", None)]
