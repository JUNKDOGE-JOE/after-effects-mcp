"""Construction tests for the EXEC-route non-candidate HDEV driver."""

from __future__ import annotations

import importlib.util
import hashlib
import json
import os
import stat
import subprocess
import sys
from pathlib import Path
from types import ModuleType

import pytest


ROOT = Path(__file__).resolve().parents[3]
HARDWARE = ROOT / "scripts/hardware"
sys.path.insert(0, str(ROOT / "packages/core"))

from ae_mcp import schemas as S


def _load(name: str, path: Path) -> ModuleType:
    module_spec = importlib.util.spec_from_file_location(name, path)
    assert module_spec is not None and module_spec.loader is not None
    module = importlib.util.module_from_spec(module_spec)
    sys.modules[name] = module
    module_spec.loader.exec_module(module)
    return module


sys.path.insert(0, str(HARDWARE))
spec = _load("development_smoke_spec", HARDWARE / "development_smoke_spec.py")
driver = _load("development_smoke", HARDWARE / "development_smoke.py")

HOST = "11111111-1111-4111-8111-111111111111"
SESSION = "22222222-2222-4222-8222-222222222222"
PROJECT = "33333333-3333-4333-8333-333333333333"
COMP = "44444444-4444-4444-8444-444444444444"
LAYER = "55555555-5555-4555-8555-555555555555"
DIGEST = "a" * 64


def _locator(*, generation: int = 1) -> dict:
    return {
        "kind": "composition",
        "hostInstanceId": HOST,
        "sessionId": SESSION,
        "projectId": PROJECT,
        "generation": generation,
        "objectId": COMP,
    }


def _layer_locator(*, generation: int = 1) -> dict:
    return {
        **_locator(generation=generation),
        "kind": "layer",
        "objectId": LAYER,
    }


def _time(value: int, scale: int) -> dict:
    from fractions import Fraction

    return {
        "value": value,
        "scale": scale,
        "secondsRational": str(Fraction(value, scale)),
    }


def _program_digest(arguments: dict) -> str:
    return hashlib.sha256(json.dumps(
        arguments, ensure_ascii=False, separators=(",", ":"), sort_keys=True,
    ).encode("utf-8")).hexdigest()


def _bind_native_program(payload: dict, arguments: dict) -> None:
    payload["audit"]["programDigest"] = _program_digest(arguments)
    payload["operations"] = [
        {"index": index, "op": operation["op"], "status": "completed"}
        for index, operation in enumerate(arguments["operations"])
    ]
    if "operationKey" in arguments:
        payload["operationKey"] = arguments["operationKey"]
        payload["audit"]["operationKey"] = arguments["operationKey"]
        payload["undo"]["groupLabel"] = arguments["undoGroup"]
    else:
        payload.pop("operationKey", None)
        payload["audit"].pop("operationKey", None)
        payload["undo"].pop("groupLabel", None)


def _native_payload(
    outputs: dict,
    operations: list[str],
    *,
    write: bool = False,
) -> dict:
    request_id = "mcp-native-program"
    postcondition = {
        "verified": True,
        "kind": "native-program",
        "algorithm": "sha256-rfc8785-jcs-v1",
        "digest": DIGEST,
    }
    evidence = {
        "engine": "native-aegp",
        "hostInstanceId": HOST,
        "sessionId": SESSION,
        "requestId": request_id,
        "capabilityId": "ae.native.exec",
        "capabilityVersion": 1,
        "startedAtUnixMs": 1,
        "completedAtUnixMs": 2,
        "effect": "committed" if write else "none",
        "requestDigest": "b" * 64,
        "postcondition": postcondition,
    }
    return {
        "ok": True,
        "capabilityId": "ae.native.exec",
        **({"operationKey": "hdev-native-time-write-0001"} if write else {}),
        "outputs": outputs,
        "operations": [
            {"index": index, "op": operation, "status": "completed"}
            for index, operation in enumerate(operations)
        ],
        "undo": {
            "available": write,
            "verified": False,
            **({"groupLabel": "HDEV exact native time"} if write else {}),
        },
        "replayed": False,
        "provenance": {
            "engine": "native-aegp",
            "selectedWireVersion": 1,
            "pluginVersion": "0.9.2",
            "compiledSdkVersion": "2026",
            "sourceCommit": "c" * 40,
            "hostInstanceId": HOST,
            "sessionId": SESSION,
            "sessionGeneration": 1,
            "capabilitiesDigest": "d" * 64,
        },
        "audit": {
            "requestId": request_id,
            "capabilityId": "ae.native.exec",
            "capabilityVersion": 1,
            "effect": "committed" if write else "none",
            "requestDigest": "b" * 64,
            "postconditionAlgorithm": "sha256-rfc8785-jcs-v1",
            "postconditionDigest": DIGEST,
            "undoAvailable": write,
            "undoVerified": False,
            "programDigest": DIGEST,
            "replayed": False,
            "startedAtUnixMs": 1,
            "completedAtUnixMs": 2,
        },
        "evidence": evidence,
    }


def _responses() -> list[tuple[bool, dict]]:
    baseline = _time(0, 1)
    changed = _time(5, 24)
    restored = _time(0, 1)
    discovery = {
        "projectLocator": {
            **_locator(), "kind": "project", "objectId": PROJECT,
        },
        "total": 1, "offset": 0, "limit": 50, "returned": 1,
        "hasMore": False, "nextOffset": None,
        "items": [{
            "locator": _locator(), "name": "HDEV Native EXEC Fixture",
            "type": "composition", "parentLocator": None,
        }],
    }
    undo_discovery = {
        **discovery,
        "projectLocator": {
            **_locator(generation=2), "kind": "project", "objectId": PROJECT,
        },
        "items": [{
            "locator": _locator(generation=2), "name": "HDEV Native EXEC Fixture",
            "type": "composition", "parentLocator": None,
        }],
    }
    layers = {
        "compositionLocator": _locator(),
        "compositionName": "HDEV Native EXEC Fixture",
        "total": 1, "offset": 0, "limit": 25, "returned": 1,
        "hasMore": False, "nextOffset": None,
        "layers": [{
            "locator": _layer_locator(), "stackIndex": 1,
            "name": "HDEV Native EXEC Layer", "type": "null",
            "videoEnabled": True, "isThreeD": False, "locked": False,
            "parentLocator": None, "sourceItemLocator": None,
        }],
    }
    return [
        (False, {"ok": True, "nativeExecutionPlane": {"available": True}}),
        (False, {"ok": True, "value": {
            "compositionName": "HDEV Native EXEC Fixture",
            "layerName": "HDEV Native EXEC Layer",
        }}),
        (False, _native_payload({"items": discovery}, ["project.items.list"])),
        (False, _native_payload(
            {"layers": layers, "time": {
                "compositionLocator": _locator(), "currentTime": baseline,
            }},
            ["composition.resolve", "composition.layers.list", "composition.time.read"],
        )),
        (False, _native_payload(
            {"time": {
                "changed": True, "compositionLocator": _locator(),
                "beforeTime": baseline, "afterTime": changed,
            }},
            ["composition.resolve", "composition.time.set"], write=True,
        )),
        (False, _native_payload(
            {"time": {
                "compositionLocator": _locator(), "currentTime": changed,
            }},
            ["composition.resolve", "composition.time.read"],
        )),
        (False, _native_payload({"items": undo_discovery}, ["project.items.list"])),
        (False, _native_payload(
            {"time": {
                "compositionLocator": _locator(), "currentTime": restored,
            }},
            ["composition.resolve", "composition.time.read"],
        )),
        (True, {"ok": False, "error": {
            "code": "INVALID_ARGUMENT", "sideEffect": "not-started",
        }}),
    ]


class FakeSession:
    def __init__(self, responses: list[tuple[bool, dict]], mutate=None) -> None:
        self.responses = list(responses)
        self.calls: list[tuple[str, dict]] = []
        self.tool_names = frozenset(tool for _, tool in spec.CALLS)
        self.mutate = mutate

    async def call(self, tool: str, arguments: dict):
        self.calls.append((tool, arguments))
        is_error, payload = self.responses.pop(0)
        if tool == "ae_nativeExec" and not is_error and payload.get("ok") is True:
            _bind_native_program(payload, arguments)
        if self.mutate is not None:
            self.mutate(len(self.calls), tool, arguments, payload)
        return is_error, payload


def _config(tmp_path: Path) -> object:
    fixture = tmp_path / "active" / "dev.aep"
    fixture.parent.mkdir()
    fixture.write_bytes(b"fixture")
    return driver.DevelopmentSmokeConfig(
        scenario=spec.SCENARIO_ID,
        selected_components=("core",),
        reused_components=("cep", "native"),
        checkout=ROOT,
        fixture_path=fixture,
        recovery_root=tmp_path / "recovery",
        evidence_dir=tmp_path / "evidence",
        formal_ae_app=tmp_path / "formal-ae.app",
        plugin_url="http://127.0.0.1:11488",
    )



@pytest.mark.asyncio
async def test_hdev_runs_exec_and_native_exec_with_real_undo_and_one_archive(tmp_path):
    session = FakeSession(_responses())
    checkpoints: list[tuple[str, dict]] = []
    config = _config(tmp_path)

    async def checkpoint(kind: str, details: dict) -> None:
        checkpoints.append((kind, details))

    async def ae_running() -> bool:
        return False

    result = await driver.run_development_smoke(
        config,
        session=session,
        checkpoint=checkpoint,
        after_effects_running=ae_running,
    )

    assert result.exit_code == 0
    assert result.summary["passed"] is True
    assert result.summary["publicCalls"]["total"] == 9
    assert [tool for tool, _ in session.calls] == [tool for _, tool in spec.CALLS]
    assert [tool for _, tool in spec.CALLS] == [
        "ae_status", "ae_exec", "ae_nativeExec", "ae_nativeExec",
        "ae_nativeExec", "ae_nativeExec", "ae_nativeExec", "ae_nativeExec",
        "ae_nativeExec",
    ]
    assert session.calls[1][1]["undo_group_name"] == "Create HDEV Native EXEC fixture"
    assert session.calls[2][1] == {"operations": [{
        "op": "project.items.list", "args": {"offset": 0, "limit": 50},
        "returnAs": "items",
    }]}
    assert session.calls[4][1]["operationKey"] == "hdev-native-time-write-0001"
    assert session.calls[4][1]["undoGroup"] == "HDEV exact native time"
    assert session.calls[7][1]["operations"][0]["args"]["locator"]["generation"] == 2
    assert session.calls[8][1] == {"operations": []}
    assert [kind for kind, _ in checkpoints] == [
        "save-empty-project",
        "undo-native-time",
        "close-formal-ae",
    ]
    assert result.summary["aepLifecycle"] == {
        "created": 1,
        "canonicalRetained": 0,
        "evidenceSnapshotsRetained": 0,
        "archived": 1,
        "unclassified": 0,
        "saveAsCopies": 0,
    }
    assert len(list((tmp_path / "recovery").glob("*.aep"))) == 1
    assert not config.fixture_path.exists()


@pytest.mark.asyncio
async def test_every_intended_native_program_validates_against_generated_schema(tmp_path):
    session = FakeSession(_responses())
    result = await driver.run_development_smoke(
        _config(tmp_path),
        session=session,
        checkpoint=lambda *_: driver.completed_checkpoint(),
        after_effects_running=lambda: driver.completed_process_check(False),
    )

    assert result.exit_code == 0
    intended = [
        arguments for tool, arguments in session.calls
        if tool == "ae_nativeExec" and arguments != {"operations": []}
    ]
    assert len(intended) == 6
    assert [arguments for tool, arguments in session.calls
            if tool == "ae_nativeExec" and arguments == {"operations": []}] == [
        {"operations": []},
    ]
    for arguments in intended:
        S.AeNativeExecArgs.model_validate(arguments)


@pytest.mark.asyncio
@pytest.mark.parametrize("drift", [
    "program-digest",
    "operation-summary",
    "operation-key",
    "audit-operation-key",
    "undo-group",
    "request-digest",
    "capabilities-digest",
])
async def test_terminal_drift_fails_instead_of_passing(tmp_path, drift):
    def mutate(call_number, tool, _arguments, payload) -> None:
        if tool != "ae_nativeExec":
            return
        if drift == "program-digest" and call_number == 3:
            payload["audit"]["programDigest"] = "e" * 64
        elif drift == "operation-summary" and call_number == 3:
            payload["operations"][0]["op"] = "composition.time.read"
        elif drift == "operation-key" and call_number == 5:
            payload["operationKey"] = "hdev-native-time-write-drifted"
        elif drift == "audit-operation-key" and call_number == 5:
            payload["audit"]["operationKey"] = "hdev-native-time-write-drifted"
        elif drift == "undo-group" and call_number == 5:
            payload["undo"]["groupLabel"] = "Drifted undo group"
        elif drift == "request-digest" and call_number == 3:
            payload["audit"]["requestDigest"] = "e" * 64
        elif drift == "capabilities-digest" and call_number == 4:
            payload["provenance"]["capabilitiesDigest"] = "e" * 64

    result = await driver.run_development_smoke(
        _config(tmp_path),
        session=FakeSession(_responses(), mutate=mutate),
        checkpoint=lambda *_: driver.completed_checkpoint(),
        after_effects_running=lambda: driver.completed_process_check(False),
    )

    assert result.exit_code == 2
    assert result.summary["passed"] is False


@pytest.mark.asyncio
async def test_uncertain_write_stops_with_exit_three_without_retry(tmp_path):
    responses = _responses()
    responses[4] = (True, {
        "ok": False,
        "error": {
            "code": "POSSIBLY_SIDE_EFFECTING_FAILURE",
            "sideEffect": "may-have-occurred",
        },
    })
    session = FakeSession(responses)

    result = await driver.run_development_smoke(
        _config(tmp_path),
        session=session,
        checkpoint=lambda *_: driver.completed_checkpoint(),
        after_effects_running=lambda: driver.completed_process_check(False),
    )

    assert result.exit_code == 3
    assert result.summary["passed"] is False
    assert result.summary["stopReason"] == "possibly-side-effecting"
    assert len(session.calls) == 5
    assert sum(
        1 for tool, arguments in session.calls
        if tool == "ae_nativeExec" and "operationKey" in arguments
    ) == 1


@pytest.mark.asyncio
async def test_call_budget_stops_before_call_eight(tmp_path):
    session = FakeSession(_responses())
    runner = driver.DevelopmentSmokeRunner(
        _config(tmp_path),
        checkpoint=lambda *_: driver.completed_checkpoint(),
        after_effects_running=lambda: driver.completed_process_check(False),
    )
    runner.ledger.total = spec.CALL_HARD_LIMIT

    with pytest.raises(driver.DevelopmentSmokeFailure, match="budget exhausted"):
        await runner.public_call(session, "overflow", "ae_status", {})
    assert session.calls == []


def test_candidate_evidence_is_permanently_false_and_files_are_private(tmp_path):
    evidence = driver.DevelopmentEvidence(tmp_path / "evidence")
    evidence.record("probe", {"value": 1})
    summary = evidence.finish(
        passed=True,
        public_calls={
            "target": 9, "hardLimit": 9, "total": 9,
            "byTool": {}, "byPhase": {},
        },
        component_disposition={
            "selected": ["core"], "reused": ["cep", "native"],
        },
        aep_lifecycle={
            "created": 1, "canonicalRetained": 0,
            "evidenceSnapshotsRetained": 0, "archived": 1,
            "unclassified": 0, "saveAsCopies": 0,
        },
    )

    assert summary["validationProfile"] == "development"
    assert summary["candidateRun"] is False
    assert summary["candidateEvidence"] is False
    event = json.loads(evidence.events_path.read_text().splitlines()[0])
    assert event["candidateRun"] is False
    assert event["candidateEvidence"] is False
    if os.name != "nt":
        assert stat.S_IMODE(evidence.root.stat().st_mode) == 0o700
        assert stat.S_IMODE(evidence.events_path.stat().st_mode) == 0o600
        assert stat.S_IMODE(evidence.summary_path.stat().st_mode) == 0o600


def test_component_disposition_is_closed_disjoint_and_complete(tmp_path):
    with pytest.raises(driver.DevelopmentSmokeFailure):
        driver.DevelopmentSmokeConfig(
            **{
                **_config(tmp_path).__dict__,
                "selected_components": ("core", "cep"),
                "reused_components": ("cep", "native"),
            }
        )


def test_driver_starts_under_the_isolated_interpreter_used_by_the_cli():
    completed = subprocess.run(
        [
            sys.executable,
            "-B",
            "-I",
            str(HARDWARE / "development_smoke.py"),
            "--help",
        ],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 0, completed.stderr
    assert "native-exec-ir@1" not in completed.stderr


@pytest.mark.skipif(
    os.name == "nt",
    reason="a bare interpreter symlink cannot model a Windows virtualenv entrypoint",
)
def test_checkout_verification_preserves_the_virtualenv_entrypoint(tmp_path):
    checkout = tmp_path / "checkout"
    interpreter = checkout / ".venv/bin/python3"
    core_package = checkout / "packages/core/ae_mcp"
    bridge_package = checkout / "packages/bridge/ae_mcp_bridge"
    interpreter.parent.mkdir(parents=True)
    core_package.mkdir(parents=True)
    bridge_package.mkdir(parents=True)
    interpreter.symlink_to(Path(sys.executable))
    (core_package / "__init__.py").write_text("", encoding="utf-8")
    (core_package / "__main__.py").write_text("", encoding="utf-8")
    (bridge_package / "__init__.py").write_text("", encoding="utf-8")

    verified_interpreter, core_root, bridge_root = driver._verify_checkout_core(checkout)

    assert verified_interpreter == interpreter
    assert verified_interpreter.resolve() == Path(sys.executable).resolve()
    assert core_root == checkout / "packages/core"
    assert bridge_root == checkout / "packages/bridge"
