"""Focused contracts for the declarative #165 hardware workflow."""

from __future__ import annotations

import contextlib
import copy
import hashlib
import importlib.util
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest


ROOT = Path(__file__).resolve().parents[3]
HARDWARE = ROOT / "scripts/hardware"
EXPECTED_SHA = "1" * 40
HOST_1 = "11111111-1111-4111-8111-111111111111"
HOST_2 = "22222222-2222-4222-8222-222222222222"
SESSION_1 = "33333333-3333-4333-8333-333333333333"
SESSION_2 = "44444444-4444-4444-8444-444444444444"
PROJECT = "55555555-5555-4555-8555-555555555555"
COMP = "66666666-6666-4666-8666-666666666666"
LAYER = "77777777-7777-4777-8777-777777777777"


def _load(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


sys.path.insert(0, str(HARDWARE))
runtime_module = _load("capability_package_runtime", HARDWARE / "capability_package_runtime.py")
package = _load("issue165_layer_transform_spec", HARDWARE / "issue165_layer_transform_spec.py")


def _locator(kind: str, object_id: str, host: str, session: str) -> dict[str, Any]:
    return {
        "kind": kind, "hostInstanceId": host, "sessionId": session,
        "projectId": PROJECT, "generation": 1, "objectId": object_id,
    }


class FakeAe:
    tool_names = frozenset(
        case.tool for case in (*package.SPEC.tools, *package.SPEC.support_tools)
    )

    def __init__(self) -> None:
        self.host = HOST_1
        self.session = SESSION_1
        self.request = 0
        self.three_d = False
        self.state: dict[str, Any] = {
            "anchorPoint": ["100", "50"],
            "position": ["320", "180"],
            "scalePercent": ["100", "100"],
            "rotationDegrees": "0",
            "opacityPercent": "100",
            "orientationDegrees": None,
        }
        self.undo_stack: list[tuple[bool, dict[str, Any]]] = []
        self.checkpoints: list[str] = []
        self.contracts = {
            capability_id: hashlib.sha256(capability_id.encode()).hexdigest()
            for capability_id in package.SPEC.required_capability_ids
        }

    def locator(self, kind: str, object_id: str) -> dict[str, Any]:
        return _locator(kind, object_id, self.host, self.session)

    def read_state(self) -> dict[str, Any]:
        return {
            "layerLocator": self.locator("layer", LAYER),
            "layerName": "TRANSFORM_TARGET",
            "dimensions": 3 if self.three_d else 2,
            **copy.deepcopy(self.state),
        }

    def undo(self) -> None:
        self.three_d, self.state = self.undo_stack.pop()

    def restart(self) -> None:
        self.host = HOST_2
        self.session = SESSION_2

    def success(
        self, capability_id: str, value: dict[str, Any], *, write: bool,
    ) -> tuple[bool, dict[str, Any]]:
        self.request += 1
        request_id = f"mcp-{self.request:032x}"
        digest = runtime_module.json_hash({
            "capabilityId": capability_id, "capabilityVersion": 1, "value": value,
        })
        effect = "committed" if write else "none"
        evidence: dict[str, Any] = {
            "engine": "native-aegp", "hostInstanceId": self.host,
            "sessionId": self.session, "requestId": request_id,
            "capabilityId": capability_id, "capabilityVersion": 1,
            "effect": effect, "requestDigest": "a" * 64,
            "postcondition": {
                "verified": True, "kind": "fixture",
                "algorithm": "sha256-rfc8785-jcs-v1", "digest": digest,
            },
        }
        if write:
            evidence["undo"] = {"available": True, "verified": False}
        payload = {
            "ok": True, "value": copy.deepcopy(value),
            "implementation": {
                "engine": "native-aegp", "capabilityId": capability_id,
                "capabilityVersion": 1, "contractDigest": self.contracts[capability_id],
            },
            "provenance": {
                "engine": "native-aegp", "sourceCommit": EXPECTED_SHA,
                "hostInstanceId": self.host, "sessionId": self.session,
            },
            "audit": {
                "requestId": request_id, "capabilityId": capability_id,
                "contractDigest": self.contracts[capability_id], "effect": effect,
                "requestDigest": "a" * 64, "postconditionDigest": digest,
            },
            "evidence": evidence,
        }
        if write:
            payload["replayed"] = False
        return False, payload

    async def call(
        self, tool: str, arguments: dict[str, Any],
    ) -> tuple[bool, dict[str, Any]]:
        case = next(
            item for item in (*package.SPEC.tools, *package.SPEC.support_tools)
            if item.tool == tool
        )
        if tool == "ae_createComposition":
            value = {"compositionLocator": self.locator("composition", COMP)}
        elif tool == "ae_createCompositionLayer":
            value = {
                "compositionLocator": self.locator("composition", COMP),
                "layerLocator": self.locator("layer", LAYER),
            }
        elif tool == package.READ:
            value = self.read_state()
        elif tool == "ae_listProjectItems":
            value = {"hasMore": False, "items": [{
                "name": "Issue165 Layer Transform Fixture", "type": "composition",
                "locator": self.locator("composition", COMP),
            }]}
        elif tool == "ae_listCompositionLayers":
            value = {"hasMore": False, "layers": [{
                "name": "TRANSFORM_TARGET", "locator": self.locator("layer", LAYER),
            }]}
        elif tool == "ae_setLayerThreeD":
            self.undo_stack.append((self.three_d, copy.deepcopy(self.state)))
            self.three_d = True
            self.state.update({
                "anchorPoint": ["100", "50", "0"],
                "position": ["320", "180", "0"],
                "scalePercent": ["100", "100", "100"],
                "orientationDegrees": ["0", "0", "0"],
            })
            value = {
                "changed": True, "layerLocator": self.locator("layer", LAYER),
                "switch": "three-d", "beforeEnabled": False, "afterEnabled": True,
            }
        else:
            self.undo_stack.append((self.three_d, copy.deepcopy(self.state)))
            write = next(item for item in (*package.WRITES, package.ORIENTATION) if item[0] == tool)
            _tool, semantic, state_field, argument_field, desired = write
            before = copy.deepcopy(self.state[state_field])
            self.state[state_field] = copy.deepcopy(arguments[argument_field])
            value = {
                "changed": True, "field": semantic,
                "layerLocator": self.locator("layer", LAYER),
                "before": before, "after": copy.deepcopy(desired),
            }
        return self.success(case.capability_id, value, write=case.kind == "write")


def make_runtime(tmp_path: Path, mode: str, fake: FakeAe):
    fixture = tmp_path / f"{mode}.aep"
    evidence = runtime_module.EvidenceLog(
        tmp_path / "evidence", spec=package.SPEC, mode=mode, expected_sha=EXPECTED_SHA,
    )

    @contextlib.asynccontextmanager
    async def factory():
        yield fake

    async def checkpoint(kind: str, _details: dict[str, Any]) -> None:
        fake.checkpoints.append(kind)
        if kind == "save-fixture":
            fixture.write_bytes(b"synthetic disposable fixture")
        elif kind.startswith("undo-"):
            fake.undo()
        elif kind == "restart-formal-ae":
            fake.restart()

    runner = runtime_module.AcceptanceRuntime(
        spec=package.SPEC, mode=mode,
        identity=runtime_module.IdentityConfig(
            expected_sha=EXPECTED_SHA,
            native_receipt=tmp_path / "receipt.json",
            native_manifest=tmp_path / "manifest.json",
            capabilities_fixture=tmp_path / "capabilities.json",
            formal_ae_app=tmp_path / "Formal AE.app", identity_home=tmp_path,
        ),
        fixture=runtime_module.FixturePolicy(
            path=fixture, recovery_root=tmp_path / "recovery",
            fixture_id="Issue165 Layer Transform Fixture",
        ),
        session_factory=factory, checkpoint=checkpoint, evidence=evidence,
    )

    def validate(*, required_capability_ids=None) -> None:
        selected = required_capability_ids or package.SPEC.required_capability_ids
        runner.contract_digests.update({key: fake.contracts[key] for key in selected})

    runner.validate_machine_identity = validate

    def bind(*, stage: str, previous_instance_id: str | None = None) -> str:
        del stage
        assert previous_instance_id is None or fake.host != previous_instance_id
        runner.expected_host_instance_id = fake.host
        runner.pairing_epoch_start_total = runner.ledger.total
        return fake.host

    runner.bind_latest_native_load = bind
    return runner, evidence


def test_package_is_seven_tools_over_two_existing_native_contracts_without_t4() -> None:
    assert len(package.SPEC.tools) == 7
    assert {case.capability_id for case in package.SPEC.tools} == {
        "ae.layer.properties.list", "ae.layer.property.set",
    }
    assert package.SPEC.native_novelty is False
    assert package.SPEC.t5_target_calls == package.SPEC.t6_target_calls == 26


@pytest.mark.asyncio
async def test_preflight_saves_reopens_and_archives_one_zero_evidence_fixture(tmp_path: Path) -> None:
    fake = FakeAe()
    runner, evidence = make_runtime(tmp_path, "preflight", fake)
    details = await package.Issue165Package(
        runner, fixture_name="Issue165 Layer Transform Fixture",
    ).run()
    assert runner.ledger.total == 6
    assert details["restartVerified"] is True
    assert fake.checkpoints.count("restart-formal-ae") == 1
    assert evidence.candidate_evidence is False
    assert runner.aep_lifecycle.created == runner.aep_lifecycle.archived == 1
    assert not runner.fixture.path.exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["t5", "t6"])
async def test_acceptance_uses_26_calls_six_real_undo_checks_and_one_restart(
    tmp_path: Path, mode: str,
) -> None:
    fake = FakeAe()
    runner, _evidence = make_runtime(tmp_path, mode, fake)
    details = await package.Issue165Package(
        runner, fixture_name="Issue165 Layer Transform Fixture",
    ).run()
    assert runner.ledger.total == 26
    assert details["restartVerified"] is True
    assert details["firstHostInstanceId"] != details["restartHostInstanceId"]
    assert fake.checkpoints.count("restart-formal-ae") == 1
    assert sum(item.startswith("undo-") for item in fake.checkpoints) == 6
    assert all(row["status"] == "passed" for row in runner.matrix.values())
    assert all(
        row["undo"]["verified"] is True
        for name, row in runner.matrix.items() if name != package.READ
    )
    assert runner.aep_lifecycle.created == runner.aep_lifecycle.archived == 1
    assert not runner.fixture.path.exists()
