"""Construction tests for the Windows Native EXEC development HDEV driver."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
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
spec = _load(
    "issue86_windows_native_exec_spec",
    HARDWARE / "issue86_windows_native_exec_spec.py",
)
driver = _load(
    "issue86_windows_native_exec_acceptance",
    HARDWARE / "issue86_windows_native_exec_acceptance.py",
)

OLD_HOST = "11111111-1111-4111-8111-111111111111"
OLD_SESSION = "22222222-2222-4222-8222-222222222222"
NEW_HOST = "33333333-3333-4333-8333-333333333333"
NEW_SESSION = "44444444-4444-4444-8444-444444444444"
OTHER_HOST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
PROJECT = "55555555-5555-4555-8555-555555555555"
OLD_COMP = "66666666-6666-4666-8666-666666666666"
NEW_COMP = "77777777-7777-4777-8777-777777777777"
OLD_LAYER = "88888888-8888-4888-8888-888888888888"
NEW_LAYER = "99999999-9999-4999-8999-999999999999"
SOURCE_COMMIT = "a" * 40
ARTIFACT_SHA = "b" * 64
POSTCONDITION = "c" * 64
CAPABILITIES = "d" * 64


def _digest(arguments: dict) -> str:
    return hashlib.sha256(
        json.dumps(
            arguments,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()


def _locator(host: str, session: str, object_id: str) -> dict:
    return {
        "kind": "composition",
        "hostInstanceId": host,
        "sessionId": session,
        "projectId": PROJECT,
        "generation": 1,
        "objectId": object_id,
    }


def _layer_locator(host: str, session: str, object_id: str) -> dict:
    return {
        **_locator(host, session, object_id),
        "kind": "layer",
    }


def _native_payload(
    outputs: dict,
    operations: list[str],
    *,
    host: str,
    session: str,
    request_id: str,
) -> dict:
    return {
        "ok": True,
        "capabilityId": "ae.native.exec",
        "outputs": outputs,
        "operations": [
            {"index": index, "op": operation, "status": "completed"}
            for index, operation in enumerate(operations)
        ],
        "undo": {"available": False, "verified": False},
        "replayed": False,
        "provenance": {
            "engine": "native-aegp",
            "selectedWireVersion": 1,
            "pluginVersion": "0.9.2",
            "compiledSdkVersion": "25.6.61",
            "sourceCommit": SOURCE_COMMIT,
            "hostInstanceId": host,
            "sessionId": session,
            "sessionGeneration": 1,
            "capabilitiesDigest": CAPABILITIES,
        },
        "audit": {
            "requestId": request_id,
            "capabilityId": "ae.native.exec",
            "capabilityVersion": 1,
            "effect": "none",
            "requestDigest": "e" * 64,
            "postconditionAlgorithm": "sha256-rfc8785-jcs-v1",
            "postconditionDigest": POSTCONDITION,
            "undoAvailable": False,
            "undoVerified": False,
            "programDigest": POSTCONDITION,
            "replayed": False,
            "startedAtUnixMs": 1,
            "completedAtUnixMs": 2,
        },
        "evidence": {
            "engine": "native-aegp",
            "hostInstanceId": host,
            "sessionId": session,
            "requestId": request_id,
            "capabilityId": "ae.native.exec",
            "capabilityVersion": 1,
            "startedAtUnixMs": 1,
            "completedAtUnixMs": 2,
            "effect": "none",
            "requestDigest": "e" * 64,
            "postcondition": {
                "verified": True,
                "kind": "native-program",
                "algorithm": "sha256-rfc8785-jcs-v1",
                "digest": POSTCONDITION,
            },
        },
    }


def _discovery(host: str, session: str, comp: str) -> dict:
    return {
        "projectLocator": {
            **_locator(host, session, comp),
            "kind": "project",
            "objectId": PROJECT,
        },
        "total": 1,
        "offset": 0,
        "limit": 50,
        "returned": 1,
        "hasMore": False,
        "nextOffset": None,
        "items": [
            {
                "locator": _locator(host, session, comp),
                "name": spec.FIXTURE_COMPOSITION_NAME,
                "type": "composition",
                "parentLocator": None,
            }
        ],
    }


def _state(host: str, session: str, comp: str, layer: str) -> dict:
    locator = _locator(host, session, comp)
    return {
        "settings": {
            "compositionLocator": locator,
            "name": spec.FIXTURE_COMPOSITION_NAME,
            "width": spec.FIXTURE_WIDTH,
            "height": spec.FIXTURE_HEIGHT,
            "duration": {"value": 2, "scale": 1, "secondsRational": "2"},
            "frameDuration": {
                "value": 1,
                "scale": spec.FIXTURE_FRAME_RATE,
                "secondsRational": f"1/{spec.FIXTURE_FRAME_RATE}",
            },
            "frameRate": {
                "numerator": spec.FIXTURE_FRAME_RATE,
                "denominator": 1,
            },
            "pixelAspectRatio": {"numerator": 1, "denominator": 1},
            "backgroundColor": {"red": 0, "green": 0, "blue": 0, "alpha": 255},
            "workArea": {
                "start": {"value": 0, "scale": 1, "secondsRational": "0"},
                "duration": {"value": 2, "scale": 1, "secondsRational": "2"},
            },
            "displayStartTime": {
                "value": 0,
                "scale": 1,
                "secondsRational": "0",
            },
            "layerCount": 1,
        },
        "layers": {
            "compositionLocator": locator,
            "compositionName": spec.FIXTURE_COMPOSITION_NAME,
            "total": 1,
            "offset": 0,
            "limit": 25,
            "returned": 1,
            "hasMore": False,
            "nextOffset": None,
            "layers": [
                {
                    "locator": _layer_locator(host, session, layer),
                    "stackIndex": 1,
                    "name": spec.FIXTURE_LAYER_NAME,
                    "type": "null",
                    "videoEnabled": True,
                    "isThreeD": False,
                    "locked": False,
                    "parentLocator": None,
                    "sourceItemLocator": None,
                }
            ],
        },
    }


def _responses() -> list[tuple[bool, dict]]:
    return [
        (False, {"ok": True, "nativeExecutionPlane": {
            "available": True,
            "adapter": "NativeInvokeBackend",
            "engine": "native-aegp",
        }}),
        (False, _native_payload(
            {"items": _discovery(OLD_HOST, OLD_SESSION, OLD_COMP)},
            ["project.items.list"],
            host=OLD_HOST,
            session=OLD_SESSION,
            request_id="pre-list",
        )),
        (False, _native_payload(
            _state(OLD_HOST, OLD_SESSION, OLD_COMP, OLD_LAYER),
            ["composition.resolve", "composition.settings.read", "composition.layers.list"],
            host=OLD_HOST,
            session=OLD_SESSION,
            request_id="pre-read",
        )),
        (False, {"ok": True, "nativeExecutionPlane": {
            "available": True,
            "adapter": "NativeInvokeBackend",
            "engine": "native-aegp",
        }}),
        (False, _native_payload(
            {"items": _discovery(NEW_HOST, NEW_SESSION, NEW_COMP)},
            ["project.items.list"],
            host=NEW_HOST,
            session=NEW_SESSION,
            request_id="post-list",
        )),
        (False, _native_payload(
            _state(NEW_HOST, NEW_SESSION, NEW_COMP, NEW_LAYER),
            ["composition.resolve", "composition.settings.read", "composition.layers.list"],
            host=NEW_HOST,
            session=NEW_SESSION,
            request_id="post-read",
        )),
    ]


class FakeSession:
    def __init__(self, responses: list[tuple[bool, dict]]) -> None:
        self.responses = list(responses)
        self.calls: list[tuple[str, dict]] = []
        self.tool_names = frozenset({"ae_status", "ae_nativeExec"})

    async def call(self, tool: str, arguments: dict):
        self.calls.append((tool, arguments))
        is_error, payload = self.responses.pop(0)
        if tool == "ae_nativeExec" and not is_error:
            payload["audit"]["programDigest"] = _digest(arguments)
            payload["operations"] = [
                {"index": index, "op": operation["op"], "status": "completed"}
                for index, operation in enumerate(arguments["operations"])
            ]
        return is_error, payload


def _endpoint(host: str, *, pid: int) -> dict:
    return {
        "descriptorName": f"d-{host}.endpoint",
        "hostInstanceId": host,
        "pid": pid,
        "pipeName": rf"\\.\pipe\aemcp-n1-{host[:12].replace('-', '')}",
        "wireVersion": 1,
        "sourceCommit": SOURCE_COMMIT,
    }


def _process(pid: int, image_path: Path | None, formal_ae_app: Path) -> driver.ProcessObservation:
    return driver.ProcessObservation(
        pid=pid,
        running=image_path is not None,
        image_path=None if image_path is None else str(image_path),
        matches_formal_executable=(
            image_path is not None
            and driver._windows_path(image_path) == driver._windows_path(formal_ae_app)
        ),
    )


def _event(event: str, host: str, **extra) -> dict:
    return {
        "schemaVersion": 1,
        "event": event,
        "timeUnixMs": 1,
        "provenance": "native-aegp",
        "instanceId": host,
        **extra,
    }


class FakeLifecycleProbe:
    def __init__(
        self,
        formal_ae_app: Path,
        *,
        stale_restart: bool = False,
        initial_target: bool = True,
        restart_wrong_path: bool = False,
    ) -> None:
        other_ae_app = formal_ae_app.parents[2] / "Adobe After Effects 2025" / "Support Files" / "AfterFX.exe"
        initial_endpoints = [_endpoint(OTHER_HOST, pid=900)]
        initial_processes = [_process(900, other_ae_app, formal_ae_app)]
        if initial_target:
            initial_endpoints.insert(0, _endpoint(OLD_HOST, pid=100))
            initial_processes.insert(0, _process(100, formal_ae_app, formal_ae_app))
        self.initial = driver.LifecycleObservation(
            endpoints=tuple(initial_endpoints),
            log_offset=10,
            events=(_event("load", OLD_HOST),),
            processes=tuple(initial_processes),
        )
        self.shutdowns = [
            driver.LifecycleObservation(
                endpoints=(_endpoint(OTHER_HOST, pid=900),),
                log_offset=20,
                events=(
                    _event("invoke.terminal", OLD_HOST, requestId="pre-list"),
                    _event("invoke.terminal", OLD_HOST, requestId="pre-read"),
                    _event("death", OLD_HOST),
                ),
                processes=(
                    _process(100, None, formal_ae_app),
                    _process(900, other_ae_app, formal_ae_app),
                ),
            ),
            driver.LifecycleObservation(
                endpoints=(_endpoint(OTHER_HOST, pid=900),),
                log_offset=40,
                events=(
                    _event("invoke.terminal", NEW_HOST, requestId="post-list"),
                    _event("invoke.terminal", NEW_HOST, requestId="post-read"),
                    _event("death", NEW_HOST),
                ),
                processes=(
                    _process(200, None, formal_ae_app),
                    _process(900, other_ae_app, formal_ae_app),
                ),
            ),
        ]
        restarted_host = OLD_HOST if stale_restart else NEW_HOST
        restarted_image = other_ae_app if restart_wrong_path else formal_ae_app
        self.started = driver.LifecycleObservation(
            endpoints=(
                _endpoint(restarted_host, pid=200),
                _endpoint(OTHER_HOST, pid=900),
            ),
            log_offset=30,
            events=(_event("load", restarted_host),),
            processes=(
                _process(200, restarted_image, formal_ae_app),
                _process(900, other_ae_app, formal_ae_app),
            ),
        )
        self.shutdown_targets: list[tuple[str, int]] = []
        self.restart_targets: list[tuple[str, int, int]] = []

    async def snapshot(self):
        return self.initial

    async def wait_for_shutdown(self, host_instance_id: str, pid: int, since_log_offset: int):
        del since_log_offset
        self.shutdown_targets.append((host_instance_id, pid))
        return self.shutdowns.pop(0)

    async def wait_for_start(
        self,
        previous_host_instance_id: str,
        previous_pid: int,
        launched_pid: int,
        since_log_offset: int,
    ):
        del since_log_offset
        self.restart_targets.append((previous_host_instance_id, previous_pid, launched_pid))
        return self.started


async def _launch_receipt(formal_ae_app: Path, *, pid: int = 200) -> driver.FormalAELaunch:
    return driver.FormalAELaunch(
        requested_executable=str(formal_ae_app),
        argv=(str(formal_ae_app),),
        spawned_pid=pid,
    )


def _write_json(path: Path, value: dict) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")
    return path


def _config(tmp_path: Path) -> object:
    fixture = tmp_path / "fixtures" / "active" / "issue86.aep"
    fixture.parent.mkdir(parents=True)
    fixture.write_bytes(b"ephemeral-aep")
    afterfx = tmp_path / "Adobe After Effects" / "Support Files" / "AfterFX.exe"
    afterfx.parent.mkdir(parents=True)
    afterfx.write_bytes(b"exe")
    plugins_root = (
        tmp_path / "Adobe After Effects" / "Support Files" / "Plug-ins" / "Extensions"
    )
    installed = plugins_root / "AeMcpNative.aex"
    installed.parent.mkdir(parents=True)
    installed.write_bytes(b"aex")
    build_receipt = _write_json(tmp_path / "receipts" / "build-receipt.json", {
        "schemaVersion": 1,
        "artifact": {
            "path": str(tmp_path / "build" / "AeMcpNative.aex"),
            "sha256": ARTIFACT_SHA,
            "bytes": 1024,
        },
        "productVersion": "0.9.2",
        "sourceCommit": SOURCE_COMMIT,
        "source": {"commit": SOURCE_COMMIT, "repositoryClean": True},
        "protocolSchemaSha256": "f" * 64,
        "sdk": {
            "name": "Adobe After Effects C/C++ Plug-in SDK",
            "claimedVersion": "25.6.61",
            "claimedBuild": 61,
            "archiveVerification": "sha256-verified",
            "rootVerification": "layout-and-content-verified",
        },
        "build": {"configuration": "development"},
    })
    build_receipt_sha = hashlib.sha256(build_receipt.read_bytes()).hexdigest()
    install_receipt = _write_json(tmp_path / "receipts" / "install.json", {
        "schemaVersion": 2,
        "operation": "install",
        "sourceCommit": SOURCE_COMMIT,
        "productVersion": "0.9.2",
        "buildReceipt": {
            "path": str(build_receipt),
            "sha256": build_receipt_sha,
        },
        "artifact": {
            "sourcePath": str(tmp_path / "build" / "AeMcpNative.aex"),
            "sourceSha256": ARTIFACT_SHA,
            "bytes": 1024,
        },
        "installed": {
            "path": str(installed),
            "sha256": ARTIFACT_SHA,
            "bytes": 1024,
            "mtimeMs": 1234,
        },
        "topology": {
            "kind": "windows-after-effects-per-app-extensions",
            "pluginsRoot": str(plugins_root),
            "artifactName": "AeMcpNative.aex",
        },
    })
    component_signals = _write_json(tmp_path / "receipts" / "signals.json", {
        "schemaVersion": 1,
        "capturedAtUnixMs": 1,
        "platform": {
            "system": "Windows",
            "architecture": "x64",
            "version": "10.0.26100",
        },
        "afterEffects": {
            "path": str(afterfx),
            "version": "25.6",
            "build": "61",
        },
        "components": {
            "core": {
                "canonicalPath": str(ROOT / "packages/core"),
                "version": "0.9.2",
                "sourceRevision": SOURCE_COMMIT,
                "bytes": 1,
                "mtimeMs": 11,
            },
            "cep": {
                "canonicalPath": str(ROOT / "plugin"),
                "version": "0.9.2",
                "sourceRevision": SOURCE_COMMIT,
                "bytes": 2,
                "mtimeMs": 12,
            },
            "native": {
                "canonicalPath": str(installed),
                "version": "0.9.2",
                "sourceRevision": SOURCE_COMMIT,
                "bytes": 1024,
                "mtimeMs": 1234,
            },
        },
    })
    return driver.Issue86Config(
        scenario=spec.SCENARIO_ID,
        selected_components=("native",),
        reused_components=("core", "cep"),
        checkout=ROOT,
        fixture_path=fixture,
        recovery_root=tmp_path / "fixtures" / "recovery",
        evidence_dir=tmp_path / "evidence",
        formal_ae_app=afterfx,
        endpoint_root=tmp_path / "AfterEffectsMCP",
        native_log_path=tmp_path / "AfterEffectsMCP" / "Logs" / "native-plugin-v1.jsonl",
        build_receipt_path=build_receipt,
        install_receipt_path=install_receipt,
        component_signals_path=component_signals,
        plugin_url="http://127.0.0.1:11488",
        lifecycle_timeout_seconds=1,
        lifecycle_poll_seconds=0.01,
        run_id="issue86-hdev-test-run",
    )


def test_frozen_plan_is_exactly_six_public_read_calls_and_schema_valid():
    assert spec.CALL_HARD_LIMIT == 6
    assert [row.tool for row in spec.CALL_PLAN] == [
        "ae_status", "ae_nativeExec", "ae_nativeExec",
        "ae_status", "ae_nativeExec", "ae_nativeExec",
    ]
    assert {row.phase for row in spec.CALL_PLAN} == {"before-restart", "after-restart"}
    assert all(row.request_disposition == "read-only" for row in spec.CALL_PLAN)

    S.AeNativeExecArgs.model_validate(spec.list_arguments())
    S.AeNativeExecArgs.model_validate(spec.read_arguments(_locator(
        OLD_HOST, OLD_SESSION, OLD_COMP,
    )))
    for arguments in (
        spec.list_arguments(),
        spec.read_arguments(_locator(OLD_HOST, OLD_SESSION, OLD_COMP)),
    ):
        assert "operationKey" not in arguments
        assert "undoGroup" not in arguments
        assert {row["op"] for row in arguments["operations"]} <= spec.READ_PRIMITIVES


@pytest.mark.asyncio
async def test_hdev_runs_six_reads_restarts_formal_ae_and_archives_one_fixture(tmp_path):
    config = _config(tmp_path)
    session = FakeSession(_responses())
    probe = FakeLifecycleProbe(config.formal_ae_app)
    checkpoints: list[tuple[str, dict]] = []
    launches: list[Path] = []

    async def checkpoint(kind: str, details: dict) -> None:
        checkpoints.append((kind, details))

    async def launch(formal_ae_app: Path) -> driver.FormalAELaunch:
        launches.append(formal_ae_app)
        return await _launch_receipt(formal_ae_app)

    result = await driver.run_issue86_hdev(
        config,
        session=session,
        checkpoint=checkpoint,
        lifecycle_probe=probe,
        launch_formal_ae=launch,
    )

    assert result.exit_code == 0
    assert result.summary["passed"] is True
    assert result.summary["publicCalls"] == {
        "target": 6,
        "hardLimit": 6,
        "total": 6,
        "withinLimit": True,
        "byTool": {"ae_nativeExec": 4, "ae_status": 2},
        "byPhase": {"after-restart": 3, "before-restart": 3},
    }
    assert [tool for tool, _ in session.calls] == [row.tool for row in spec.CALL_PLAN]
    assert all(tool != "ae_exec" for tool, _ in session.calls)
    assert launches == [config.formal_ae_app]
    assert [kind for kind, _ in checkpoints] == [
        "quit-before-windows-native-restart",
        "open-issue86-fixture-in-restarted-formal-ae",
        "quit-before-issue86-fixture-archive",
    ]
    for _kind, details in checkpoints:
        assert details["executionOwner"] == "authorized-agent-orchestrator"
        assert details["userActionRequired"] is False
        assert details["expectedApplication"]["process"] == "AfterFX.exe"
        assert details["fixturePath"] == str(config.fixture_path)
        assert details["lastVerifiedState"]
        assert details["expectedApplication"]["targetPid"] == details["lastVerifiedState"]["pid"]
    assert checkpoints[1][1]["action"] == "use-file-open-or-open-recent-inside-ae"
    assert probe.shutdown_targets == [(OLD_HOST, 100), (NEW_HOST, 200)]
    assert probe.restart_targets == [(OLD_HOST, 100, 200)]
    assert result.summary["restartFreshness"] == {
        "oldHostInstanceId": OLD_HOST,
        "oldSessionId": OLD_SESSION,
        "newHostInstanceId": NEW_HOST,
        "newSessionId": NEW_SESSION,
        "hostChanged": True,
        "sessionChanged": True,
        "endpointChanged": True,
        "pidChanged": True,
        "oldPid": 100,
        "newPid": 200,
        "launchPid": 200,
        "launchPidRelation": "direct",
    }
    assert result.summary["stateBeforeRestart"] == result.summary["stateAfterRestart"]
    assert result.summary["aepLifecycle"]["archived"] == 1
    assert result.summary["aepLifecycle"]["unclassified"] == 0
    assert not config.fixture_path.exists()

    call_rows = result.summary["callSummary"]
    assert len(call_rows) == 6
    assert all(row["requestDisposition"] == "read-only" for row in call_rows)
    assert all(row["resultDisposition"] == "PASS" for row in call_rows)
    assert all(row["undoResult"] == {
        "applicable": False,
        "executed": False,
        "verified": False,
    } for row in call_rows)
    native_rows = [row for row in call_rows if row["tool"] == "ae_nativeExec"]
    assert {row["auditId"] for row in native_rows} == {
        "pre-list", "pre-read", "post-list", "post-read",
    }
    assert all(row["postconditionId"] == POSTCONDITION for row in native_rows)
    assert set(result.summary["toolSummary"]) == {"ae_status", "ae_nativeExec"}
    assert result.summary["toolSummary"]["ae_nativeExec"]["publicCalls"] == 4
    assert result.summary["artifactBindings"]["buildReceipt"]["artifactSha256"] == ARTIFACT_SHA
    assert result.summary["artifactBindings"]["installReceipt"]["artifactSha256"] == ARTIFACT_SHA
    assert result.summary["componentSignals"]["components"]["native"]["bytes"] == 1024
    assert all(row["status"] == "PASS" for row in result.summary["defectLedger"])


@pytest.mark.asyncio
async def test_launcher_handoff_binds_fresh_endpoint_pid(tmp_path):
    config = _config(tmp_path)
    probe = FakeLifecycleProbe(config.formal_ae_app)

    async def handed_off_launch(formal_ae_app: Path) -> driver.FormalAELaunch:
        return await _launch_receipt(formal_ae_app, pid=250)

    result = await driver.run_issue86_hdev(
        config,
        session=FakeSession(_responses()),
        checkpoint=lambda *_: driver.completed_checkpoint(),
        lifecycle_probe=probe,
        launch_formal_ae=handed_off_launch,
    )

    assert result.exit_code == 0
    assert probe.restart_targets == [(OLD_HOST, 100, 250)]
    assert result.summary["restartFreshness"]["launchPid"] == 250
    assert result.summary["restartFreshness"]["newPid"] == 200
    assert result.summary["restartFreshness"]["launchPidRelation"] == "handed-off"


@pytest.mark.asyncio
async def test_public_failure_stops_without_restart_or_additional_calls(tmp_path):
    config = _config(tmp_path)
    responses = _responses()
    responses[1] = (True, {
        "ok": False,
        "error": {"code": "NATIVE_UNAVAILABLE", "sideEffect": "not-started"},
    })
    session = FakeSession(responses)
    probe = FakeLifecycleProbe(config.formal_ae_app)
    checkpoints: list[str] = []
    launches: list[Path] = []

    async def checkpoint(kind: str, _details: dict) -> None:
        checkpoints.append(kind)

    async def launch(formal_ae_app: Path) -> driver.FormalAELaunch:
        launches.append(formal_ae_app)
        return await _launch_receipt(formal_ae_app)

    result = await driver.run_issue86_hdev(
        config,
        session=session,
        checkpoint=checkpoint,
        lifecycle_probe=probe,
        launch_formal_ae=launch,
    )

    assert result.exit_code == 3
    assert result.summary["passed"] is False
    assert result.summary["publicCalls"]["total"] == 2
    assert checkpoints == []
    assert launches == []
    assert config.fixture_path.exists()
    assert result.summary["aepLifecycle"]["unclassified"] == 1
    rows = {row["case"]: row for row in result.summary["defectLedger"]}
    assert rows["pre-status"]["status"] == "PASS"
    assert rows["pre-list"]["status"] == "FAIL"
    assert rows["pre-read"]["status"] == "BLOCKED"
    assert rows["pre-list"]["sideEffectState"] == "not-started"


@pytest.mark.asyncio
async def test_stale_restart_endpoint_stops_before_post_restart_public_call(tmp_path):
    config = _config(tmp_path)
    session = FakeSession(_responses())
    probe = FakeLifecycleProbe(config.formal_ae_app, stale_restart=True)

    result = await driver.run_issue86_hdev(
        config,
        session=session,
        checkpoint=lambda *_: driver.completed_checkpoint(),
        lifecycle_probe=probe,
        launch_formal_ae=_launch_receipt,
    )

    assert result.exit_code == 3
    assert result.summary["publicCalls"]["total"] == 3
    assert [tool for tool, _ in session.calls] == [
        "ae_status", "ae_nativeExec", "ae_nativeExec",
    ]
    rows = {row["case"]: row for row in result.summary["defectLedger"]}
    assert rows["restart-freshness"]["status"] == "INDETERMINATE"
    assert rows["post-status"]["status"] == "BLOCKED"
    assert result.summary["aepLifecycle"]["unclassified"] == 1


@pytest.mark.asyncio
async def test_wrong_version_endpoint_cannot_satisfy_initial_target_lifecycle(tmp_path):
    config = _config(tmp_path)
    session = FakeSession(_responses())
    probe = FakeLifecycleProbe(config.formal_ae_app, initial_target=False)

    result = await driver.run_issue86_hdev(
        config,
        session=session,
        checkpoint=lambda *_: driver.completed_checkpoint(),
        lifecycle_probe=probe,
        launch_formal_ae=_launch_receipt,
    )

    assert result.exit_code == 3
    assert result.summary["publicCalls"]["total"] == 0
    assert session.calls == []
    rows = {row["case"]: row for row in result.summary["defectLedger"]}
    assert rows["initial-lifecycle"]["status"] == "INDETERMINATE"
    assert rows["pre-status"]["status"] == "BLOCKED"


@pytest.mark.asyncio
async def test_restart_endpoint_with_wrong_image_path_stops_before_post_calls(tmp_path):
    config = _config(tmp_path)
    session = FakeSession(_responses())
    probe = FakeLifecycleProbe(config.formal_ae_app, restart_wrong_path=True)

    result = await driver.run_issue86_hdev(
        config,
        session=session,
        checkpoint=lambda *_: driver.completed_checkpoint(),
        lifecycle_probe=probe,
        launch_formal_ae=_launch_receipt,
    )

    assert result.exit_code == 3
    assert result.summary["publicCalls"]["total"] == 3
    assert [tool for tool, _ in session.calls] == [
        "ae_status", "ae_nativeExec", "ae_nativeExec",
    ]
    rows = {row["case"]: row for row in result.summary["defectLedger"]}
    assert rows["restart-freshness"]["status"] == "INDETERMINATE"
    assert rows["post-status"]["status"] == "BLOCKED"


def test_receipt_binding_rejects_native_signal_drift(tmp_path):
    config = _config(tmp_path)
    signals = json.loads(config.component_signals_path.read_text(encoding="utf-8"))
    signals["components"]["native"]["mtimeMs"] += 1
    config.component_signals_path.write_text(json.dumps(signals), encoding="utf-8")

    with pytest.raises(driver.Issue86Failure, match="native mtime"):
        driver.load_component_bindings(config)


def test_receipt_binding_rejects_installed_path_outside_declared_topology(tmp_path):
    config = _config(tmp_path)
    receipt = json.loads(config.install_receipt_path.read_text(encoding="utf-8"))
    receipt["topology"]["pluginsRoot"] = str(tmp_path / "different" / "Extensions")
    config.install_receipt_path.write_text(json.dumps(receipt), encoding="utf-8")

    with pytest.raises(driver.Issue86Failure, match="topology drifted"):
        driver.load_component_bindings(config)


def test_receipt_binding_rejects_install_build_receipt_drift(tmp_path):
    config = _config(tmp_path)
    receipt = json.loads(config.install_receipt_path.read_text(encoding="utf-8"))
    receipt["buildReceipt"]["sha256"] = "0" * 64
    config.install_receipt_path.write_text(json.dumps(receipt), encoding="utf-8")

    with pytest.raises(driver.Issue86Failure, match="receipt identities drifted"):
        driver.load_component_bindings(config)


def test_call_budget_stops_before_public_call_seven():
    ledger = driver.CallLedger()
    for row in spec.CALL_PLAN:
        ledger.reserve(row.phase, row.tool)
    with pytest.raises(driver.Issue86Failure, match="budget exhausted"):
        ledger.reserve("after-restart", "ae_status")


def test_endpoint_descriptor_parser_is_unordered_but_closed_on_duplicates():
    text = "\n".join([
        "AEMCP_NATIVE_ENDPOINT_V1",
        f"source={SOURCE_COMMIT}",
        "wire=1",
        r"socket=\\.\pipe\aemcp-n1-123456abcdef",
        "startMicros=456",
        "pid=123",
        f"host={OLD_HOST}",
        "startSeconds=1234",
        "",
    ])
    parsed = driver.parse_endpoint_descriptor(text, f"d-{OLD_HOST}.endpoint")

    assert parsed["hostInstanceId"] == OLD_HOST
    assert parsed["pid"] == 123
    assert parsed["processGeneration"] == {
        "startSeconds": 1234,
        "startMicros": 456,
    }
    assert parsed["wireVersion"] == 1
    assert parsed["sourceCommit"] == SOURCE_COMMIT
    with pytest.raises(driver.Issue86Failure, match="duplicate"):
        driver.parse_endpoint_descriptor(
            text.replace("wire=1\n", "wire=1\nwire=1\n"),
            f"d-{OLD_HOST}.endpoint",
        )


@pytest.mark.asyncio
async def test_formal_ae_launch_argv_contains_only_the_exact_executable(tmp_path, monkeypatch):
    config = _config(tmp_path)
    calls: list[tuple[tuple[str, ...], dict]] = []

    async def create_subprocess_exec(*argv, **kwargs):
        calls.append((argv, kwargs))
        return type("SpawnedProcess", (), {"pid": 321})()

    monkeypatch.setattr(driver.os, "name", "nt")
    monkeypatch.setattr(driver.asyncio, "create_subprocess_exec", create_subprocess_exec)
    launch = await driver.launch_formal_after_effects(config.formal_ae_app)

    assert calls[0][0] == (str(config.formal_ae_app),)
    assert str(config.fixture_path) not in calls[0][0]
    assert launch == driver.FormalAELaunch(
        requested_executable=str(config.formal_ae_app),
        argv=(str(config.formal_ae_app),),
        spawned_pid=321,
    )


@pytest.mark.skipif(os.name != "nt", reason="QueryFullProcessImageNameW is Windows-only")
def test_process_image_lookup_uses_pid_specific_windows_api():
    image_path = driver.windows_process_image_path(os.getpid())

    assert image_path is not None
    assert Path(image_path).name.casefold().startswith("python")


@pytest.mark.parametrize("open_result", [0, 123], ids=["open-process", "query-image"])
def test_process_image_lookup_treats_access_denied_as_unmatched(monkeypatch, open_result):
    class FakeWindowsFunction:
        def __init__(self, result):
            self.result = result

        def __call__(self, *_args):
            return self.result

    kernel32 = type("FakeKernel32", (), {
        "OpenProcess": FakeWindowsFunction(open_result),
        "QueryFullProcessImageNameW": FakeWindowsFunction(0),
        "CloseHandle": FakeWindowsFunction(1),
    })()
    monkeypatch.setattr(driver.os, "name", "nt")
    monkeypatch.setattr(driver.ctypes, "WinDLL", lambda *_args, **_kwargs: kernel32)
    monkeypatch.setattr(driver.ctypes, "get_last_error", lambda: 5)

    assert driver.windows_process_image_path(63208) is None


@pytest.mark.asyncio
async def test_windows_probe_shutdown_ignores_inaccessible_other_endpoint(tmp_path, monkeypatch):
    config = _config(tmp_path)
    monkeypatch.setattr(
        driver,
        "read_endpoints",
        lambda _root: (_endpoint(OTHER_HOST, pid=900),),
    )
    monkeypatch.setattr(
        driver,
        "read_log",
        lambda _path, _offset: (20, (_event("death", OLD_HOST),)),
    )
    images = {100: None, 900: None}
    probe = driver.WindowsLifecycleProbe(
        config,
        process_image_lookup=lambda pid: images[pid],
    )

    observation = await probe.wait_for_shutdown(OLD_HOST, 100, 0)

    assert observation.process_running is False
    assert [row["hostInstanceId"] for row in observation.endpoints] == [OTHER_HOST]
    assert {row.pid for row in observation.processes} == {100, 900}


@pytest.mark.asyncio
async def test_inaccessible_endpoint_cannot_satisfy_formal_ae_restart(tmp_path, monkeypatch):
    config = driver.dataclasses.replace(
        _config(tmp_path),
        lifecycle_timeout_seconds=0.02,
        lifecycle_poll_seconds=0.005,
    )
    monkeypatch.setattr(
        driver,
        "read_endpoints",
        lambda _root: (_endpoint(NEW_HOST, pid=200),),
    )
    monkeypatch.setattr(
        driver,
        "read_log",
        lambda _path, _offset: (30, (_event("load", NEW_HOST),)),
    )
    probe = driver.WindowsLifecycleProbe(
        config,
        process_image_lookup=lambda _pid: None,
    )

    with pytest.raises(driver.LifecycleUncertain, match="PID/path-bound"):
        await probe.wait_for_start(OLD_HOST, 100, 250, 0)


def test_evidence_is_append_only_and_permanently_development_only(tmp_path):
    evidence = driver.DevelopmentEvidence(tmp_path / "evidence", run_id="issue86-hdev-evidence")
    first = evidence.record("first", {"value": 1})
    second = evidence.record("second", {"value": 2})
    summary = evidence.finish(
        passed=False,
        public_calls={},
        component_disposition={"selected": ["native"], "reused": ["core", "cep"]},
        aep_lifecycle={},
        defect_ledger=[],
        tool_summary={},
        details={},
    )

    events = [json.loads(line) for line in evidence.events_path.read_text().splitlines()]
    assert [row["evidenceId"] for row in events] == [first, second]
    assert [row["sequence"] for row in events] == [1, 2]
    for row in [*events, summary]:
        assert row["validationProfile"] == "development"
        assert row["candidateRun"] is False
        assert row["candidateEvidence"] is False


def test_cli_import_has_no_ae_side_effects_and_help_is_deterministic():
    completed = subprocess.run(
        [
            sys.executable,
            "-B",
            "-I",
            str(HARDWARE / "issue86_windows_native_exec_acceptance.py"),
            "--help",
        ],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 0, completed.stderr
    assert spec.SCENARIO_ID in completed.stdout
    assert "CHECKPOINT_REQUIRED" not in completed.stdout
    assert "candidate" not in completed.stdout.lower()


def test_config_requires_windows_afterfx_and_the_frozen_component_disposition(tmp_path):
    config = _config(tmp_path)
    assert config.formal_ae_app.name == "AfterFX.exe"
    with pytest.raises(driver.Issue86Failure, match="selected component"):
        driver.Issue86Config(
            **{
                **config.__dict__,
                "selected_components": ("core",),
                "reused_components": ("cep", "native"),
            }
        )
    wrong = tmp_path / "AfterFX.com"
    wrong.write_bytes(b"wrong")
    with pytest.raises(driver.Issue86Failure, match="AfterFX.exe"):
        driver.Issue86Config(**{**config.__dict__, "formal_ae_app": wrong})
