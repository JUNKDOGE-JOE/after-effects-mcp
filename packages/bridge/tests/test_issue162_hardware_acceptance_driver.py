"""Focused contracts for the declarative #162 hardware acceptance workflow."""

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
package = _load(
    "issue162_layer_compositing_spec",
    HARDWARE / "issue162_layer_compositing_spec.py",
)
cli = _load("capability_package_cli", HARDWARE / "capability_package_cli.py")


def _locator(kind: str, object_id: str, host: str, session: str) -> dict[str, Any]:
    return {
        "kind": kind,
        "hostInstanceId": host,
        "sessionId": session,
        "projectId": PROJECT,
        "generation": 1,
        "objectId": object_id,
    }


class FakeAe:
    tool_names = frozenset(
        case.tool for case in (*package.SPEC.tools, *package.SPEC.support_tools)
    )

    def __init__(self) -> None:
        self.host = HOST_1
        self.session = SESSION_1
        self.request = 0
        self.state = {
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
        }
        self.undo_stack: list[dict[str, Any]] = []
        self.calls: list[str] = []
        self.checkpoints: list[str] = []
        self.contracts = {
            capability_id: hashlib.sha256(capability_id.encode()).hexdigest()
            for capability_id in package.SPEC.required_capability_ids
        }

    def locator(self, kind: str, object_id: str) -> dict[str, Any]:
        return _locator(kind, object_id, self.host, self.session)

    def read_state(self) -> dict[str, Any]:
        return {"layerLocator": self.locator("layer", LAYER), **copy.deepcopy(self.state)}

    def undo(self) -> None:
        self.state = self.undo_stack.pop()

    def restart(self) -> None:
        self.host = HOST_2
        self.session = SESSION_2

    def success(
        self, capability_id: str, value: dict[str, Any], *, write: bool
    ) -> tuple[bool, dict[str, Any]]:
        self.request += 1
        request_id = f"mcp-{self.request:032x}"
        digest = runtime_module.json_hash(
            {"capabilityId": capability_id, "capabilityVersion": 1, "value": value}
        )
        effect = "committed" if write else "none"
        evidence: dict[str, Any] = {
            "engine": "native-aegp",
            "hostInstanceId": self.host,
            "sessionId": self.session,
            "requestId": request_id,
            "capabilityId": capability_id,
            "capabilityVersion": 1,
            "effect": effect,
            "requestDigest": "a" * 64,
            "postcondition": {
                "verified": True,
                "kind": "fixture",
                "algorithm": "sha256-rfc8785-jcs-v1",
                "digest": digest,
            },
        }
        if write:
            evidence["undo"] = {"available": True, "verified": False}
        payload: dict[str, Any] = {
            "ok": True,
            "value": copy.deepcopy(value),
            "implementation": {
                "engine": "native-aegp",
                "capabilityId": capability_id,
                "capabilityVersion": 1,
                "contractDigest": self.contracts[capability_id],
            },
            "provenance": {
                "engine": "native-aegp",
                "sourceCommit": EXPECTED_SHA,
                "hostInstanceId": self.host,
                "sessionId": self.session,
            },
            "audit": {
                "requestId": request_id,
                "capabilityId": capability_id,
                "contractDigest": self.contracts[capability_id],
                "effect": effect,
                "requestDigest": "a" * 64,
                "postconditionDigest": digest,
            },
            "evidence": evidence,
        }
        if write:
            payload["replayed"] = False
        return False, payload

    async def call(
        self, tool: str, arguments: dict[str, Any]
    ) -> tuple[bool, dict[str, Any]]:
        self.calls.append(tool)
        case = next(
            case for case in (*package.SPEC.tools, *package.SPEC.support_tools)
            if case.tool == tool
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
            value = {
                "hasMore": False,
                "items": [{
                    "name": "Issue162 Layer Compositing Fixture",
                    "type": "composition",
                    "locator": self.locator("composition", COMP),
                }],
            }
        elif tool == "ae_listCompositionLayers":
            value = {
                "hasMore": False,
                "layers": [{
                    "name": "COMPOSITING_TARGET",
                    "locator": self.locator("layer", LAYER),
                }],
            }
        else:
            self.undo_stack.append(copy.deepcopy(self.state))
            if tool == package.QUALITY:
                before = self.state["quality"]
                self.state["quality"] = arguments["quality"]
                value = {
                    "changed": before != arguments["quality"],
                    "layerLocator": self.locator("layer", LAYER),
                    "beforeQuality": before,
                    "afterQuality": arguments["quality"],
                }
            elif tool == package.BLEND:
                before = self.state["blendingMode"]
                self.state["blendingMode"] = arguments["mode"]
                value = {
                    "changed": before != arguments["mode"],
                    "layerLocator": self.locator("layer", LAYER),
                    "beforeMode": before,
                    "afterMode": arguments["mode"],
                    "preserveAlpha": self.state["preserveAlpha"],
                    "trackMatte": self.state["trackMatte"],
                }
            else:
                switch = next(item for item in package.SWITCHES if item[0] == tool)[1]
                field = {
                    "visibility": "visibilityEnabled",
                    "solo": "solo",
                    "locked": "locked",
                    "shy": "shy",
                    "motion-blur": "motionBlur",
                    "three-d": "threeD",
                    "adjustment": "adjustment",
                }[switch]
                before = self.state[field]
                self.state[field] = arguments["enabled"]
                value = {
                    "changed": before != arguments["enabled"],
                    "layerLocator": self.locator("layer", LAYER),
                    "switch": switch,
                    "beforeEnabled": before,
                    "afterEnabled": arguments["enabled"],
                }
        return self.success(case.capability_id, value, write=case.kind == "write")


def make_runtime(tmp_path: Path, mode: str, fake: FakeAe):
    fixture = tmp_path / f"{mode}.aep"
    evidence = runtime_module.EvidenceLog(
        tmp_path / "evidence", spec=package.SPEC, mode=mode, expected_sha=EXPECTED_SHA
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
        spec=package.SPEC,
        mode=mode,
        identity=runtime_module.IdentityConfig(
            expected_sha=EXPECTED_SHA,
            native_receipt=tmp_path / "receipt.json",
            native_manifest=tmp_path / "manifest.json",
            capabilities_fixture=tmp_path / "capabilities.json",
            formal_ae_app=tmp_path / "Formal AE.app",
            identity_home=tmp_path,
        ),
        fixture=runtime_module.FixturePolicy(
            path=fixture,
            recovery_root=tmp_path / "recovery",
            fixture_id="Issue162 Layer Compositing Fixture",
        ),
        session_factory=factory,
        checkpoint=checkpoint,
        evidence=evidence,
    )

    def validate(*, required_capability_ids=None) -> None:
        selected = required_capability_ids or package.SPEC.required_capability_ids
        runner.contract_digests.update(
            {capability: fake.contracts[capability] for capability in selected}
        )

    runner.validate_machine_identity = validate

    def bind(*, stage: str, previous_instance_id: str | None = None) -> str:
        del stage
        assert previous_instance_id is None or fake.host != previous_instance_id
        runner.expected_host_instance_id = fake.host
        runner.pairing_epoch_start_total = runner.ledger.total
        return fake.host

    runner.bind_latest_native_load = bind
    return runner, evidence


def test_package_maps_ten_public_tools_to_four_deduplicated_native_contracts() -> None:
    assert len(package.SPEC.tools) == 10
    assert len({case.capability_id for case in package.SPEC.tools}) == 4
    assert package.SPEC.required_capability_ids[:4] == (
        "ae.layer.compositing.read",
        "ae.layer.switch.set",
        "ae.layer.quality.set",
        "ae.layer.blending-mode.set",
    )
    assert package.SPEC.t5_target_calls == package.SPEC.t6_target_calls == 26
    assert package.SPEC.t4_target_calls == 4
    assert package.SPEC.native_novelty is True


@pytest.mark.asyncio
async def test_preflight_uses_one_disposable_fixture_without_candidate_evidence(
    tmp_path: Path,
) -> None:
    fake = FakeAe()
    runner, evidence = make_runtime(tmp_path, "preflight", fake)
    await package.Issue162Package(
        runner, fixture_name="Issue162 Layer Compositing Fixture"
    ).run()
    assert runner.ledger.total == 3
    assert evidence.candidate_evidence is False
    assert runner.aep_lifecycle.created == runner.aep_lifecycle.archived == 1
    assert not runner.fixture.path.exists()


@pytest.mark.asyncio
async def test_t4_is_one_native_write_one_undo_and_one_package_read(tmp_path: Path) -> None:
    fake = FakeAe()
    runner, evidence = make_runtime(tmp_path, "t4", fake)
    details = await package.Issue162Package(
        runner, fixture_name="Issue162 Layer Compositing Fixture"
    ).run()
    assert details["nativeNoveltySmoke"] == "layer-flag-write"
    assert details["undoVerified"] is True
    assert runner.ledger.total == 4
    assert runner.ledger.by_tool["ae_setLayerVisibility"] == 1
    assert runner.ledger.by_tool[package.READ] == 1
    assert sum(item.startswith("undo-") for item in fake.checkpoints) == 1
    assert "restart-formal-ae" not in fake.checkpoints
    assert evidence.candidate_evidence is False
    assert runner.aep_lifecycle.created == runner.aep_lifecycle.archived == 1
    assert not runner.fixture.path.exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["t5", "t6"])
async def test_acceptance_runs_24_calls_nine_undo_checks_and_one_restart(
    tmp_path: Path, mode: str
) -> None:
    fake = FakeAe()
    runner, _evidence = make_runtime(tmp_path, mode, fake)
    details = await package.Issue162Package(
        runner, fixture_name="Issue162 Layer Compositing Fixture"
    ).run()
    assert runner.ledger.total == 24
    assert details["restartVerified"] is True
    assert details["firstHostInstanceId"] != details["restartHostInstanceId"]
    assert fake.checkpoints.count("restart-formal-ae") == 1
    assert sum(item.startswith("undo-") for item in fake.checkpoints) == 9
    assert all(row["status"] == "passed" for row in runner.matrix.values())
    assert all(
        row["undo"]["verified"] is True
        for tool, row in runner.matrix.items()
        if tool != package.READ
    )
    assert runner.aep_lifecycle.created == runner.aep_lifecycle.archived == 1
    assert not runner.fixture.path.exists()


def test_shared_cli_requires_the_canonical_launcher(tmp_path: Path) -> None:
    arguments = [
        "--mode", "t5",
        "--expected-sha", EXPECTED_SHA,
        "--fixture-path", str(tmp_path / "fixture.aep"),
        "--recovery-archive-root", str(tmp_path / "recovery"),
        "--native-receipt", str(tmp_path / "receipt.json"),
        "--native-manifest", str(tmp_path / "manifest.json"),
        "--evidence-dir", str(tmp_path / "evidence"),
        "--identity-home", str(tmp_path),
    ]
    parsed = cli.parse_args(arguments, fixture_default="fixture")
    assert parsed.launcher == tmp_path / ".ae-mcp/bin/ae-mcp"
    with pytest.raises(SystemExit):
        cli.parse_args(
            [*arguments, "--launcher", str(tmp_path / "other/ae-mcp")],
            fixture_default="fixture",
        )
