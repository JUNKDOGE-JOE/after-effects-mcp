"""Focused contracts for the shared runner and package #157 declaration/hooks."""

from __future__ import annotations

import contextlib
import copy
import hashlib
import importlib.util
import json
import plistlib
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
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
TRANSFORM = "88888888-8888-4888-8888-888888888888"
OPACITY = "99999999-9999-4999-8999-999999999999"
POSITION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"


def _load(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


sys.path.insert(0, str(HARDWARE))
runtime_module = _load("capability_package_runtime", HARDWARE / "capability_package_runtime.py")
package = _load("issue157_keyframe_authoring_spec", HARDWARE / "issue157_keyframe_authoring_spec.py")
acceptance_cli = _load(
    "issue157_keyframe_authoring_acceptance",
    HARDWARE / "issue157_keyframe_authoring_acceptance.py",
)


def _locator(
    kind: str, object_id: str, host: str, session: str, *, generation: int = 1
) -> dict[str, Any]:
    return {
        "kind": kind,
        "hostInstanceId": host,
        "sessionId": session,
        "projectId": PROJECT,
        "generation": generation,
        "objectId": object_id,
    }


class FakeAe:
    tool_names = frozenset(
        case.tool for case in (*package.SPEC.tools, *package.SPEC.support_tools)
    )

    def __init__(self) -> None:
        self.host = HOST_1
        self.session = SESSION_1
        self.generation = 1
        self.request = 0
        self.opacity_value = {"kind": "scalar", "value": "100"}
        self.position_value = {"kind": "two-d", "x": "320", "y": "180"}
        self.keyframes: dict[str, dict[int, dict[str, Any]]] = {OPACITY: {}, POSITION: {}}
        self.undo_stack: list[tuple[str, Any]] = []
        self.calls: list[str] = []
        self.add_times: list[int] = []
        self.contracts = {
            case.capability_id: hashlib.sha256(case.capability_id.encode()).hexdigest()
            for case in (*package.SPEC.tools, *package.SPEC.support_tools)
        }
        self.checkpoints: list[str] = []
        self.timeline: list[str] = []

    def locator(self, kind: str, object_id: str) -> dict[str, Any]:
        return _locator(
            kind, object_id, self.host, self.session, generation=self.generation
        )

    @staticmethod
    def _seconds(time_argument: dict[str, Any]) -> int:
        value = time_argument["value"]
        scale = time_argument["scale"]
        assert value % scale == 0
        return value // scale

    def _keyframe(self, target: str, seconds: int = 1) -> dict[str, Any] | None:
        return self.keyframes[target].get(seconds)

    def _set_keyframe(
        self, target: str, value: dict[str, Any] | None, seconds: int = 1
    ) -> None:
        if value is None:
            self.keyframes[target].pop(seconds, None)
        else:
            self.keyframes[target][seconds] = value

    def detail(self, target: str = OPACITY, seconds: int = 1) -> dict[str, Any]:
        keyframe = self._keyframe(target, seconds)
        assert keyframe is not None
        result = copy.deepcopy(keyframe)
        result["propertyLocator"] = self.locator("stream", target)
        return result

    def initial_detail(
        self, value: dict[str, Any], target: str = OPACITY, seconds: int = 1
    ) -> dict[str, Any]:
        spatial = target == POSITION
        dimensions = 2 if spatial else 1
        return {
            "propertyLocator": self.locator("stream", target),
            # AE returns the exact requested second in its native comp-time
            # scale; the representation need not preserve the request's 1/1.
            "time": {
                "value": seconds * 24576,
                "scale": 24576,
                "secondsRational": str(seconds),
            },
            "temporalDimensionality": dimensions,
            "valueType": "two-d-spatial" if spatial else "one-d",
            "value": copy.deepcopy(value),
            "inInterpolation": "linear",
            "outInterpolation": "linear",
            "temporalEaseDimensions": [
                {
                    "dimension": dimension,
                    "inEase": {"speed": "0", "influence": "33.333"},
                    "outEase": {"speed": "0", "influence": "33.333"},
                }
                for dimension in range(dimensions)
            ],
            "behaviors": {
                "temporalContinuous": False,
                "temporalAutoBezier": False,
                "spatialContinuous": False,
                "spatialAutoBezier": False,
                "roving": False,
            },
        }

    def undo(self) -> None:
        kind, value = self.undo_stack.pop()
        if kind == "property":
            self.opacity_value = value
        else:
            target, seconds, keyframe = value
            self._set_keyframe(target, keyframe, seconds)

    def restart(self) -> None:
        self.host = HOST_2
        self.session = SESSION_2

    def _success(
        self, tool: str, capability_id: str, value: dict[str, Any], *, write: bool
    ) -> tuple[bool, dict[str, Any]]:
        self.request += 1
        request_id = f"mcp-{self.request:032x}"
        digest = runtime_module.json_hash(
            {"capabilityId": capability_id, "capabilityVersion": 1, "value": value}
        )
        contract = self.contracts[capability_id]
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
                "contractDigest": contract,
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
                "contractDigest": contract,
                "effect": effect,
                "requestDigest": "a" * 64,
                "postconditionDigest": digest,
            },
            "evidence": evidence,
        }
        if write:
            payload["replayed"] = False
        return False, payload

    def _property_page(self, parent: dict[str, Any] | None) -> dict[str, Any]:
        if parent is None:
            properties = [
                {
                    "propertyLocator": self.locator("stream", TRANSFORM),
                    "matchName": "ADBE Transform Group",
                    "groupingType": "named-group",
                    "valueType": "none",
                    "canVaryOverTime": None,
                    "value": None,
                }
            ]
        else:
            properties = [
                {
                    "propertyLocator": self.locator("stream", OPACITY),
                    "matchName": "ADBE Opacity",
                    "groupingType": "leaf",
                    "valueType": "one-d",
                    "canVaryOverTime": True,
                    "value": copy.deepcopy(self.opacity_value),
                },
                {
                    "propertyLocator": self.locator("stream", POSITION),
                    "matchName": "ADBE Position",
                    "groupingType": "leaf",
                    "valueType": "two-d-spatial",
                    "canVaryOverTime": True,
                    "value": copy.deepcopy(self.position_value),
                },
            ]
        return {"hasMore": False, "properties": properties}

    def _mutation(
        self,
        before: dict[str, Any] | None,
        target: str,
        seconds: int,
        count_before: int,
    ) -> dict[str, Any]:
        keyframe = self._keyframe(target, seconds)
        return {
            "changed": True,
            "layerLocator": self.locator("layer", LAYER),
            "propertyLocator": self.locator("stream", target),
            "time": {
                "value": seconds * 24576,
                "scale": 24576,
                "secondsRational": str(seconds),
            },
            "keyframeCountBefore": count_before,
            "keyframeCountAfter": len(self.keyframes[target]),
            "beforeKeyframe": before,
            "afterKeyframe": self.detail(target, seconds) if keyframe is not None else None,
        }

    async def call(
        self, tool: str, arguments: dict[str, Any]
    ) -> tuple[bool, dict[str, Any]]:
        self.timeline.append(f"call:{tool}")
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
        elif tool == "ae_listLayerProperties":
            value = self._property_page(arguments.get("parent_property_locator"))
        elif tool == "ae_setLayerPropertyValue":
            self.undo_stack.append(("property", copy.deepcopy(self.opacity_value)))
            self.opacity_value = copy.deepcopy(arguments["value"])
            value = {"changed": True}
        elif tool == "ae_listProjectItems":
            value = {
                "hasMore": False,
                "items": [
                    {
                        "name": "Issue157 Keyframe Authoring Fixture",
                        "type": "composition",
                        "locator": self.locator("composition", COMP),
                    }
                ],
            }
        elif tool == "ae_listCompositionLayers":
            value = {
                "hasMore": False,
                "layers": [
                    {
                        "name": "KEYFRAME_TARGET",
                        "locator": self.locator("layer", LAYER),
                    }
                ],
            }
        elif tool == package.DETAILS:
            target = arguments["property_locator"]["objectId"]
            seconds = self._seconds(arguments["time"])
            if self._keyframe(target, seconds) is None:
                return True, {
                    "ok": False,
                    "error": {
                        "code": "PRECONDITION_FAILED",
                        "details": {
                            "capabilityId": case.capability_id,
                            "field": "params.arguments.time",
                        },
                    },
                }
            value = self.detail(target, seconds)
        else:
            target = arguments["property_locator"]["objectId"]
            seconds = self._seconds(arguments["time"])
            keyframe = self._keyframe(target, seconds)
            before = self.detail(target, seconds) if keyframe is not None else None
            count_before = len(self.keyframes[target])
            self.undo_stack.append(("keyframe", (target, seconds, copy.deepcopy(keyframe))))
            if tool == package.ADD:
                self.add_times.append(seconds)
                self._set_keyframe(
                    target, self.initial_detail(arguments["value"], target, seconds), seconds
                )
            elif tool == package.VALUE:
                assert keyframe is not None
                keyframe["value"] = copy.deepcopy(arguments["value"])
            elif tool == package.INTERPOLATION:
                assert keyframe is not None
                keyframe["inInterpolation"] = arguments["in_interpolation"]
                keyframe["outInterpolation"] = arguments["out_interpolation"]
            elif tool == package.EASE:
                assert keyframe is not None
                dimension = arguments["dimensions"][0]
                keyframe["temporalEaseDimensions"] = [
                    {
                        "dimension": 0,
                        "inEase": copy.deepcopy(dimension["in_ease"]),
                        "outEase": copy.deepcopy(dimension["out_ease"]),
                    }
                ]
            elif tool == package.BEHAVIOR:
                assert keyframe is not None
                field = {
                    "temporal-continuous": "temporalContinuous",
                    "spatial-continuous": "spatialContinuous",
                }[arguments["behavior"]]
                keyframe["behaviors"][field] = arguments["enabled"]
            elif tool == package.DELETE:
                self._set_keyframe(target, None, seconds)
            value = self._mutation(before, target, seconds, count_before)
        return self._success(tool, case.capability_id, value, write=case.kind == "write")


class PairingFake(FakeAe):
    def __init__(self, *, required_responses: int = 1, reject_retry: bool = False) -> None:
        super().__init__()
        self.required_responses = required_responses
        self.reject_retry = reject_retry
        self.pairing_dispatches = 0

    async def call(
        self, tool: str, arguments: dict[str, Any]
    ) -> tuple[bool, dict[str, Any]]:
        self.pairing_dispatches += 1
        if self.pairing_dispatches <= self.required_responses:
            self.timeline.append(f"call:{tool}")
            self.calls.append(tool)
            return True, {
                "ok": False,
                "error": {
                    "code": "NATIVE_PAIRING_REQUIRED",
                    "message": "Authorize native pairing.",
                    "retryable": True,
                    "sideEffect": "not-started",
                    "recovery": {"action": "approve-pairing", "hint": "Authorize in AE."},
                    "details": {
                        "pairingFingerprint": "12AB-34CD",
                        "pairingExpiresInMs": 60_000,
                        "hostInstanceId": self.host,
                        "sourceCommit": EXPECTED_SHA,
                    },
                },
            }
        if self.reject_retry and self.pairing_dispatches == self.required_responses + 1:
            self.timeline.append(f"call:{tool}")
            self.calls.append(tool)
            return True, {
                "ok": False,
                "error": {
                    "code": "NATIVE_PAIRING_REJECTED",
                    "message": "Pairing was rejected.",
                    "retryable": True,
                    "sideEffect": "not-started",
                    "recovery": {"action": "retry-pairing", "hint": "Start again."},
                },
            }
        return await super().call(tool, arguments)


class EpochPairingFake(FakeAe):
    def __init__(self) -> None:
        super().__init__()
        self.pending_hosts: set[str] = set()
        self.paired_hosts: set[str] = set()

    async def call(
        self, tool: str, arguments: dict[str, Any]
    ) -> tuple[bool, dict[str, Any]]:
        if self.host not in self.paired_hosts:
            if self.host in self.pending_hosts:
                self.paired_hosts.add(self.host)
                return await super().call(tool, arguments)
            self.pending_hosts.add(self.host)
            self.timeline.append(f"call:{tool}")
            self.calls.append(tool)
            return True, {
                "ok": False,
                "error": {
                    "code": "NATIVE_PAIRING_REQUIRED",
                    "message": "Authorize native pairing.",
                    "retryable": True,
                    "sideEffect": "not-started",
                    "recovery": {"action": "approve-pairing", "hint": "Authorize in AE."},
                    "details": {
                        "pairingFingerprint": "12AB-34CD",
                        "pairingExpiresInMs": 60_000,
                        "hostInstanceId": self.host,
                        "sourceCommit": EXPECTED_SHA,
                    },
                },
            }
        return await super().call(tool, arguments)


def make_runtime(tmp_path: Path, mode: str, fake: FakeAe):
    fixture = tmp_path / f"{mode}.aep"
    evidence = runtime_module.EvidenceLog(
        tmp_path / "evidence", spec=package.SPEC, mode=mode, expected_sha=EXPECTED_SHA
    )

    @contextlib.asynccontextmanager
    async def factory():
        yield fake

    async def checkpoint(kind: str, details: dict[str, Any]) -> None:
        fake.checkpoints.append(kind)
        fake.timeline.append(f"checkpoint:{kind}")
        if kind == "save-fixture":
            fixture.write_bytes(b"synthetic disposable fixture")
            fake.generation += 1
        elif kind.startswith("undo-"):
            fake.undo()
        elif kind == "restart-formal-ae":
            fake.restart()

    identity = runtime_module.IdentityConfig(
        expected_sha=EXPECTED_SHA,
        native_receipt=tmp_path / "receipt.json",
        native_manifest=tmp_path / "manifest.json",
        capabilities_fixture=tmp_path / "capabilities.json",
        formal_ae_app=tmp_path / "Formal AE.app",
        identity_home=tmp_path,
    )
    runner = runtime_module.AcceptanceRuntime(
        spec=package.SPEC,
        mode=mode,
        identity=identity,
        fixture=runtime_module.FixturePolicy(
            path=fixture,
            recovery_root=tmp_path / "recovery",
            fixture_id="Issue157 Keyframe Authoring Fixture",
        ),
        session_factory=factory,
        checkpoint=checkpoint,
        evidence=evidence,
    )
    def validate(*, required_capability_ids=None) -> None:
        selected = required_capability_ids or fake.contracts
        runner.contract_digests.update(
            {capability: fake.contracts[capability] for capability in selected}
        )

    runner.validate_machine_identity = validate

    def bind(*, stage: str, previous_instance_id: str | None = None) -> str:
        assert previous_instance_id is None or fake.host != previous_instance_id
        runner.expected_host_instance_id = fake.host
        runner.pairing_checkpoint_used = False
        runner.pairing_epoch_start_total = runner.ledger.total
        return fake.host

    runner.bind_latest_native_load = bind
    return runner, evidence


def write_json(path: Path, value: dict[str, Any]) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    path.write_bytes(payload)
    return hashlib.sha256(payload).hexdigest()


def make_identity_config(tmp_path: Path) -> runtime_module.IdentityConfig:
    home = tmp_path / "home"
    receipt_path = tmp_path / "receipt.json"
    receipt_hash = write_json(
        receipt_path,
        {"sourceCommit": EXPECTED_SHA, "source": {"commit": EXPECTED_SHA}},
    )
    manifest_path = tmp_path / "native-manifest.json"
    write_json(
        manifest_path,
        {
            "sourceCommitSha": EXPECTED_SHA,
            "artifact": {
                "receiptSha256": receipt_hash,
                "bundleTreeSha256": "b" * 64,
                "executableSha256": "c" * 64,
                "piplSha256": "d" * 64,
            },
        },
    )
    write_json(
        home / "Library/Application Support/Adobe/CEP/extensions/com.aemcp.panel/bundle-manifest.json",
        {"sourceCommitSha": EXPECTED_SHA},
    )
    relative = f"0.9.2-{EXPECTED_SHA}/macos-arm64"
    current = home / ".ae-mcp/runtime/current"
    current.parent.mkdir(parents=True, exist_ok=True)
    current.write_text(relative, encoding="utf-8")
    runtime_manifest = home / ".ae-mcp/runtime" / relative / "runtime-manifest.json"
    runtime_hash = write_json(runtime_manifest, {"sourceCommitSha": EXPECTED_SHA})
    launcher_bytes = b"#!/bin/sh\nexit 0\n"
    launcher_hash = hashlib.sha256(launcher_bytes).hexdigest()
    generation_root = home / ".ae-mcp/runtime" / relative.split("/", 1)[0]
    write_json(
        generation_root / "install-record.json",
        {
            "relative": relative,
            "sourceCommitSha": EXPECTED_SHA,
            "runtimeManifestSha256": runtime_hash,
            "launcherSha256": launcher_hash,
        },
    )
    for launcher in (generation_root / "ae-mcp-launcher", home / ".ae-mcp/bin/ae-mcp"):
        launcher.parent.mkdir(parents=True, exist_ok=True)
        launcher.write_bytes(launcher_bytes)
        launcher.chmod(0o755)
    capabilities = tmp_path / "capabilities.json"
    write_json(
        capabilities,
        {
            "response": {
                "result": {
                    "items": [
                        {
                            "id": case.capability_id,
                            "contractDigest": hashlib.sha256(
                                case.capability_id.encode()
                            ).hexdigest(),
                        }
                        for case in (*package.SPEC.tools, *package.SPEC.support_tools)
                    ]
                }
            }
        },
    )
    app = tmp_path / "Formal AE.app"
    executable = app / "Contents/MacOS/After Effects"
    executable.parent.mkdir(parents=True, exist_ok=True)
    executable.write_bytes(b"formal-ae")
    plist = {
        "CFBundleIdentifier": "com.adobe.AfterEffects.application",
        "CFBundleShortVersionString": "26.3.0",
        "CFBundleVersion": "26.3.0.87",
        "CFBundleExecutable": "After Effects",
    }
    (app / "Contents/Info.plist").write_bytes(plistlib.dumps(plist))
    return runtime_module.IdentityConfig(
        expected_sha=EXPECTED_SHA,
        native_receipt=receipt_path,
        native_manifest=manifest_path,
        capabilities_fixture=capabilities,
        formal_ae_app=app,
        identity_home=home,
    )


@pytest.mark.asyncio
async def test_preflight_is_non_candidate_seven_calls_and_proves_locator_undo(tmp_path: Path):
    fake = FakeAe()
    fake.tool_names = frozenset(case.tool for case in package.SPEC.support_tools)
    runner, evidence = make_runtime(tmp_path, "preflight", fake)
    details = await package.Issue157Package(
        runner, fixture_name="Issue157 Keyframe Authoring Fixture"
    ).run()
    assert details["propertyLocatorStableAcrossUndo"] is True
    assert evidence.candidate_evidence is False
    assert runner.ledger.total == 7
    assert runner.aep_lifecycle.created == runner.aep_lifecycle.archived == 1
    assert not runner.fixture.path.exists()
    assert set(runner.contract_digests) == {
        case.capability_id for case in package.SPEC.support_tools
    }
    probe = fake.timeline.index("call:ae_listProjectItems")
    saved = fake.timeline.index("checkpoint:save-fixture")
    created = fake.timeline.index("call:ae_createComposition")
    assert probe < saved < created


@pytest.mark.asyncio
async def test_first_pairing_required_checkpoints_once_then_keeps_seven_effective_calls(
    tmp_path: Path,
):
    fake = PairingFake()
    fake.tool_names = frozenset(case.tool for case in package.SPEC.support_tools)
    runner, evidence = make_runtime(tmp_path, "preflight", fake)
    await package.Issue157Package(
        runner, fixture_name="Issue157 Keyframe Authoring Fixture"
    ).run()
    assert runner.ledger.total == 7
    assert runner.ledger.handshake_attempts == 1
    assert len(fake.calls) == 8
    assert fake.checkpoints.count("pair-native") == 1
    persisted = evidence.events_path.read_text(encoding="utf-8")
    assert "12AB-34CD" not in persisted
    assert "pairingFingerprint" not in persisted


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("required_responses", "reject_retry", "message", "handshakes"),
    [
        (2, False, "still required", 2),
        (1, True, "was rejected", 2),
    ],
)
async def test_pairing_retry_failure_is_fail_closed_without_effective_call(
    tmp_path: Path,
    required_responses: int,
    reject_retry: bool,
    message: str,
    handshakes: int,
):
    fake = PairingFake(
        required_responses=required_responses,
        reject_retry=reject_retry,
    )
    fake.tool_names = frozenset(case.tool for case in package.SPEC.support_tools)
    runner, _evidence = make_runtime(tmp_path, "preflight", fake)
    with pytest.raises(runtime_module.AcceptanceFailure, match=message):
        await package.Issue157Package(
            runner, fixture_name="Issue157 Keyframe Authoring Fixture"
        ).run()
    assert runner.ledger.total == 0
    assert runner.ledger.handshake_attempts == handshakes
    assert fake.checkpoints.count("pair-native") == 1
    assert not runner.fixture.path.exists()
    assert runner.aep_lifecycle.created == 0
    assert not fake.keyframes[OPACITY]


@pytest.mark.asyncio
async def test_t5_runs_seven_tools_in_28_calls_with_real_undo_and_restart(tmp_path: Path):
    fake = FakeAe()
    runner, _evidence = make_runtime(tmp_path, "t5", fake)
    details = await package.Issue157Package(
        runner, fixture_name="Issue157 Keyframe Authoring Fixture"
    ).run()
    assert runner.ledger.total == 28
    assert details["restartVerified"] is True
    assert details["firstHostInstanceId"] != details["restartHostInstanceId"]
    assert set(runner.matrix) == {case.tool for case in package.SPEC.tools}
    assert all(row["status"] == "passed" for row in runner.matrix.values())
    assert all(
        row["undo"]["verified"] is True
        for tool, row in runner.matrix.items()
        if tool != package.DETAILS
    )
    assert runner.matrix[package.ADD]["invocations"] == 5
    assert runner.matrix[package.BEHAVIOR]["invocations"] == 2
    assert runner.matrix[package.BEHAVIOR]["undo"]["executed"] == 2
    assert runner.matrix[package.DETAILS]["invocations"] == 8
    assert fake.calls.count(package.DETAILS) == 8
    position_keyframe = fake.keyframes[POSITION][1]
    assert position_keyframe is not None
    assert position_keyframe["behaviors"]["spatialContinuous"] is False
    assert not runner.fixture.path.exists()


@pytest.mark.asyncio
async def test_t5_seeds_ease_neighbors_through_public_adds_before_the_matrix(tmp_path: Path):
    fake = FakeAe()
    runner, _evidence = make_runtime(tmp_path, "t5", fake)
    await package.Issue157Package(
        runner, fixture_name="Issue157 Keyframe Authoring Fixture"
    ).run()
    # AE retains temporal-ease speed only with adjacent segments; the two
    # neighbor keys are seeded through the public ADD tool before the matrix
    # baseline so no ExtendScript checkpoint can advance the native project
    # generation and invalidate the driver's locators.
    assert "seed-temporal-ease-neighbors" not in fake.checkpoints
    assert fake.add_times[:2] == [0, 2]
    assert fake.add_times[2:] == [1, 1, 1]
    timeline = fake.timeline
    add_calls = [index for index, entry in enumerate(timeline) if entry == f"call:{package.ADD}"]
    assert timeline.index(f"call:{package.EASE}") > add_calls[1]
    # The ease write still runs after the interpolation Undo and is followed
    # by exactly one Undo checkpoint of its own.
    interpolation_undo_at = timeline.index(
        "checkpoint:undo-ae_setLayerPropertyKeyframeInterpolation"
    )
    ease_write_at = timeline.index(f"call:{package.EASE}")
    ease_undo_at = timeline.index("checkpoint:undo-ae_setLayerPropertyKeyframeTemporalEase")
    assert interpolation_undo_at < ease_write_at < ease_undo_at
    assert runner.ledger.total == 28


@pytest.mark.asyncio
async def test_pairing_is_scoped_to_each_native_host_epoch(tmp_path: Path):
    fake = EpochPairingFake()
    runner, _evidence = make_runtime(tmp_path, "t5", fake)
    details = await package.Issue157Package(
        runner, fixture_name="Issue157 Keyframe Authoring Fixture"
    ).run()
    assert runner.ledger.total == 28
    assert runner.ledger.handshake_attempts == 2
    assert fake.checkpoints.count("pair-native") == 2
    assert details["firstHostInstanceId"] != details["restartHostInstanceId"]


@pytest.mark.parametrize(
    ("passed", "eligible"),
    [(False, False), (True, True)],
)
def test_only_a_passing_candidate_run_is_eligible_evidence(
    tmp_path: Path, passed: bool, eligible: bool
):
    fake = FakeAe()
    runner, evidence = make_runtime(tmp_path / str(passed), "t5", fake)
    evidence.finish(
        passed=passed,
        details={},
        ledger=runner.ledger,
        matrix=runner.matrix,
        aep_lifecycle=runner.aep_lifecycle,
    )
    summary = json.loads(evidence.summary_path.read_text(encoding="utf-8"))
    assert summary["candidateRun"] is True
    assert summary["candidateEvidence"] is eligible


def test_keyframe_time_accepts_native_comp_scale_and_rejects_drift() -> None:
    assert package._time(
        {"value": 24576, "scale": 24576, "secondsRational": "1"}
    )["secondsRational"] == "1"

    with pytest.raises(runtime_module.AcceptanceFailure, match="exact requested time"):
        package._time(
            {"value": 24575, "scale": 24576, "secondsRational": "24575/24576"}
        )
    with pytest.raises(runtime_module.AcceptanceFailure, match="exact requested time"):
        package._time(
            {"value": 24576, "scale": 24576, "secondsRational": "24576/24576"}
        )


def test_keyframe_time_accepts_seed_seconds_in_native_comp_scale() -> None:
    assert package._time(
        {"value": 0, "scale": 24576, "secondsRational": "0"}, package.SEED_START_TIME
    )["secondsRational"] == "0"
    assert package._time(
        {"value": 49152, "scale": 24576, "secondsRational": "2"}, package.SEED_END_TIME
    )["secondsRational"] == "2"
    with pytest.raises(runtime_module.AcceptanceFailure, match="exact requested time"):
        package._time(
            {"value": 24576, "scale": 24576, "secondsRational": "1"},
            package.SEED_END_TIME,
        )


def test_identity_binds_generation_and_canonical_stable_launcher(tmp_path: Path):
    identity = make_identity_config(tmp_path)
    required = tuple(case.capability_id for case in package.SPEC.tools)
    proof = runtime_module.verify_exact_identity(
        identity, required_capability_ids=required
    )
    stable = identity.identity_home / ".ae-mcp/bin/ae-mcp"
    expected_hash = hashlib.sha256(stable.read_bytes()).hexdigest()
    assert proof.component_hashes["stableLauncherSha256"] == expected_hash
    assert proof.component_hashes["runtimeGenerationLauncherSha256"] == expected_hash

    stable.write_bytes(b"#!/bin/sh\nexit 1\n")
    stable.chmod(0o755)
    with pytest.raises(runtime_module.IdentityFailure, match="launcher identity mismatch"):
        runtime_module.verify_exact_identity(identity, required_capability_ids=required)


def test_cli_launcher_is_canonical_under_identity_home(tmp_path: Path):
    common = [
        "--mode", "t5",
        "--expected-sha", EXPECTED_SHA,
        "--fixture-path", str(tmp_path / "fixture.aep"),
        "--recovery-archive-root", str(tmp_path / "recovery"),
        "--native-receipt", str(tmp_path / "receipt.json"),
        "--native-manifest", str(tmp_path / "manifest.json"),
        "--evidence-dir", str(tmp_path / "evidence"),
        "--identity-home", str(tmp_path),
    ]
    parsed = acceptance_cli.parse_args(common)
    assert parsed.launcher == tmp_path / ".ae-mcp/bin/ae-mcp"
    with pytest.raises(SystemExit):
        acceptance_cli.parse_args(
            [*common, "--launcher", str(tmp_path / "other/ae-mcp")]
        )


@pytest.mark.asyncio
async def test_call_budget_aborts_before_dispatching_call_31(tmp_path: Path):
    fake = FakeAe()
    runner, _evidence = make_runtime(tmp_path, "t5", fake)
    runner.contract_digests.update(fake.contracts)
    runner.expected_host_instance_id = fake.host
    for index in range(30):
        await runner.call(
            fake,
            "ae_listProjectItems",
            {"offset": 0, "limit": 50},
            capability_id="ae.project.items.list",
            write=False,
            phase=f"support-{index}",
        )
    with pytest.raises(runtime_module.AcceptanceFailure, match="budget exhausted"):
        await runner.call(
            fake,
            "ae_listProjectItems",
            {"offset": 0, "limit": 50},
            capability_id="ae.project.items.list",
            write=False,
            phase="overflow",
        )
    assert fake.calls.count("ae_listProjectItems") == 30


def test_package_has_no_t4_and_declares_one_read_six_writes():
    assert package.SPEC.native_novelty is False
    assert [case.kind for case in package.SPEC.tools].count("read") == 1
    assert [case.kind for case in package.SPEC.tools].count("write") == 6
    assert package.SPEC.t5_target_calls == package.SPEC.t6_target_calls == 28


def test_identity_validation_can_freeze_only_base_support_contracts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    fake = FakeAe()
    runner, _evidence = make_runtime(tmp_path, "preflight", fake)
    del runner.validate_machine_identity
    observed: list[str] = []

    def verify(_identity, *, required_capability_ids):
        observed.extend(required_capability_ids)
        return SimpleNamespace(
            component_hashes={},
            contract_digests={
                capability: fake.contracts[capability]
                for capability in required_capability_ids
            },
            formal_ae_identity={},
        )

    monkeypatch.setattr(runtime_module, "verify_exact_identity", verify)
    support = tuple(case.capability_id for case in package.SPEC.support_tools)
    runner.validate_machine_identity(required_capability_ids=support)
    assert tuple(observed) == support
    assert set(runner.contract_digests) == set(support)
