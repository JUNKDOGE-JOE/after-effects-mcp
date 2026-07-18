"""Focused contracts for the tracked #150 real-AE acceptance driver."""

from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import json
import math
import stat
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
DRIVER_PATH = REPO_ROOT / "scripts/hardware/issue150_project_composition_acceptance.py"
EXPECTED_SHA = "1" * 40
HOST_ONE = "11111111-1111-4111-8111-111111111111"
HOST_TWO = "22222222-2222-4222-8222-222222222222"
SESSION_ONE = "33333333-3333-4333-8333-333333333333"
SESSION_TWO = "44444444-4444-4444-8444-444444444444"
PROJECT_ID = "55555555-5555-4555-8555-555555555555"
REFRESHED_PROJECT_ID = "99999999-9999-4999-8999-999999999999"
SOURCE_ID = "66666666-6666-4666-8666-666666666666"
DUPLICATE_ID = "77777777-7777-4777-8777-777777777777"
FRESH_SOURCE_ID = "88888888-8888-4888-8888-888888888887"


def _load_driver() -> ModuleType:
    spec = importlib.util.spec_from_file_location("issue150_hardware_acceptance", DRIVER_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


driver = _load_driver()


def _time(value: int, scale: int = 24) -> dict[str, Any]:
    divisor = math.gcd(abs(value), scale)
    numerator = value // divisor
    denominator = scale // divisor
    rational = str(numerator) if denominator == 1 else f"{numerator}/{denominator}"
    return {"value": value, "scale": scale, "secondsRational": rational}


def _ratio(numerator: int, denominator: int = 1) -> dict[str, Any]:
    divisor = math.gcd(numerator, denominator)
    reduced_numerator = numerator // divisor
    reduced_denominator = denominator // divisor
    return {
        "numerator": numerator,
        "denominator": denominator,
        "rational": str(reduced_numerator)
        if reduced_denominator == 1
        else f"{reduced_numerator}/{reduced_denominator}",
    }


class _FakeT4Session:
    tool_names = frozenset((*driver.PACKAGE_TOOLS, *driver.SUPPORT_TOOLS))

    def __init__(self) -> None:
        self.host = HOST_ONE
        self.session = SESSION_ONE
        self.generation = 1
        self.project_id = PROJECT_ID
        self.source_id = SOURCE_ID
        self.duplicate_exists = False
        self.name = "Fixture Comp"
        self.comment = "baseline"
        self.label_id = 3
        self.work_area_start = _time(0)
        self.work_area_duration = _time(120)
        self.selection_collateral = False
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self._request = 0

    def _locator(self, *, duplicate: bool = False) -> dict[str, Any]:
        return {
            "kind": "composition",
            "hostInstanceId": self.host,
            "sessionId": self.session,
            "projectId": self.project_id,
            "generation": self.generation,
            "objectId": DUPLICATE_ID if duplicate else self.source_id,
        }

    def _project_locator(self) -> dict[str, Any]:
        return {
            "kind": "project",
            "hostInstanceId": self.host,
            "sessionId": self.session,
            "projectId": self.project_id,
            "generation": self.generation,
            "objectId": PROJECT_ID,
        }

    def _entry(self, *, duplicate: bool = False) -> dict[str, Any]:
        return {
            "itemLocator": self._locator(duplicate=duplicate),
            "name": "Fixture Copy" if duplicate else self.name,
            "type": "composition",
            "parentLocator": None,
        }

    def _metadata(self, *, duplicate: bool = False) -> dict[str, Any]:
        return {
            "itemLocator": self._locator(duplicate=duplicate),
            "name": "Fixture Copy" if duplicate else self.name,
            "type": "composition",
            "parentLocator": None,
            "comment": self.comment,
            "labelId": self.label_id,
            "width": 1920,
            "height": 1080,
            "duration": _time(240),
            "pixelAspectRatio": _ratio(1),
            "layerCount": 2,
        }

    def _settings(self, *, duplicate: bool = False) -> dict[str, Any]:
        return {
            "compositionLocator": self._locator(duplicate=duplicate),
            "name": "Fixture Copy" if duplicate else self.name,
            "width": 1920,
            "height": 1080,
            "duration": _time(240),
            "frameDuration": _time(1),
            "frameRate": _ratio(24),
            "pixelAspectRatio": _ratio(1),
            "workArea": {
                "start": dict(self.work_area_start),
                "duration": dict(self.work_area_duration),
            },
            "displayStartTime": _time(0),
            "layerCount": 2,
        }

    def _success(self, tool: str, value: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
        self._request += 1
        request_id = f"request-{self._request}"
        capability = driver.CAPABILITY_BY_TOOL[tool]
        digest = driver._json_hash({
            "capabilityId": capability,
            "capabilityVersion": 1,
            "value": value,
        })
        request_digest = hashlib.sha256(f"request-{self._request}".encode()).hexdigest()
        contract_digest, risk, mutability, idempotency, undo_semantics, _effect = (
            driver.FROZEN_DESCRIPTOR_BY_TOOL[tool]
        )
        evidence: dict[str, Any] = {
            "engine": "native-aegp",
            "hostInstanceId": self.host,
            "sessionId": self.session,
            "requestId": request_id,
            "capabilityId": capability,
            "capabilityVersion": 1,
            "startedAtUnixMs": 1_900_000_000_000,
            "completedAtUnixMs": 1_900_000_000_025,
            "effect": "committed" if tool in driver.WRITE_TOOLS else "none",
            "requestDigest": request_digest,
            "postcondition": {
                "verified": True,
                "kind": driver.POSTCONDITION_KIND_BY_TOOL[tool],
                "algorithm": "sha256-rfc8785-jcs-v1",
                "digest": digest,
            },
        }
        if tool in driver.WRITE_TOOLS:
            evidence["undo"] = {"available": True, "verified": False}
        return False, {
            "ok": True,
            **({"replayed": False} if tool in driver.WRITE_TOOLS else {}),
            "value": value,
            "implementation": {
                "engine": "native-aegp",
                "capabilityId": capability,
                "capabilityVersion": 1,
                "contractDigest": contract_digest,
                "risk": risk,
                "mutability": mutability,
                "idempotency": idempotency,
                "undo": undo_semantics,
            },
            "provenance": {
                "engine": "native-aegp",
                "sourceCommit": EXPECTED_SHA,
                "selectedWireVersion": 1,
                "pluginVersion": "0.9.2",
                "compiledSdkVersion": "25.6.61",
                "hostInstanceId": self.host,
                "sessionId": self.session,
                "sessionGeneration": 1,
                "capabilitiesDigest": "a" * 64,
            },
            "audit": {
                "requestId": request_id,
                **({"evidenceRequestId": request_id} if tool in driver.WRITE_TOOLS else {}),
                "capabilityId": capability,
                "capabilityVersion": 1,
                "contractDigest": contract_digest,
                "effect": "committed" if tool in driver.WRITE_TOOLS else "none",
                **({
                    "replayed": False,
                    "undoAvailable": True,
                    "undoVerified": False,
                } if tool in driver.WRITE_TOOLS else {}),
                "requestDigest": request_digest,
                "postconditionAlgorithm": "sha256-rfc8785-jcs-v1",
                "postconditionDigest": digest,
                "startedAtUnixMs": 1_900_000_000_000,
                "completedAtUnixMs": 1_900_000_000_025,
            },
            "evidence": evidence,
        }

    @staticmethod
    def _error(code: str) -> tuple[bool, dict[str, Any]]:
        return True, {"ok": False, "error": {"code": code}}

    async def call(self, tool: str, arguments: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
        self.calls.append((tool, dict(arguments)))
        if tool == "ae_getProjectContext":
            entry = self._entry()
            collateral_entry = self._entry(duplicate=True)
            return self._success(
                tool,
                {
                    "projectLocator": self._project_locator(),
                    "generation": self.generation,
                    "activeItem": entry,
                    "mostRecentlyUsedComposition": entry,
                    "selection": {
                        "total": 1,
                        "offset": 0,
                        "limit": 50,
                        "returned": 1,
                        "hasMore": False,
                        "nextOffset": None,
                        "items": [collateral_entry] if self.selection_collateral else [entry],
                    },
                },
            )
        if tool == "ae_getProjectItemMetadata":
            locator = arguments["item_locator"]
            if not self._fresh(locator):
                return self._error("STALE_LOCATOR")
            duplicate = locator["objectId"] == DUPLICATE_ID
            if duplicate and not self.duplicate_exists:
                return self._error("STALE_LOCATOR")
            return self._success(tool, self._metadata(duplicate=duplicate))
        if tool == "ae_getCompositionSettings":
            locator = arguments["composition_locator"]
            if not self._fresh(locator):
                return self._error("STALE_LOCATOR")
            duplicate = locator["objectId"] == DUPLICATE_ID
            return self._success(tool, self._settings(duplicate=duplicate))
        if tool == "ae_listProjectItems":
            items = [self._entry()]
            if self.duplicate_exists:
                items.append(self._entry(duplicate=True))
            return self._success(
                tool,
                {
                    "projectLocator": self._project_locator(),
                    "total": len(items),
                    "offset": 0,
                    "limit": 50,
                    "hasMore": False,
                    "nextOffset": None,
                    "items": items,
                },
            )
        if tool == "ae_duplicateComposition":
            assert set(arguments) == {"composition_locator", "new_name", "idempotency_key"}
            assert arguments["new_name"] == "Fixture Copy"
            before_count = 1
            self.duplicate_exists = True
            self.generation += 1
            self.project_id = REFRESHED_PROJECT_ID
            self.source_id = FRESH_SOURCE_ID
            source_settings = self._settings()
            source_settings.pop("compositionLocator")
            new_settings = self._settings(duplicate=True)
            new_settings.pop("compositionLocator")
            return self._success(
                tool,
                {
                    "changed": True,
                    "sourceCompositionLocator": self._locator(),
                    "newCompositionLocator": self._locator(duplicate=True),
                    "projectItemCountBefore": before_count,
                    "projectItemCountAfter": before_count + 1,
                    "sourceSettings": source_settings,
                    "newSettings": new_settings,
                },
            )
        if tool == "ae_setCompositionWorkArea":
            assert set(arguments) == {"composition_locator", "start", "duration", "idempotency_key"}
            before = {
                "start": dict(self.work_area_start),
                "duration": dict(self.work_area_duration),
            }
            self.work_area_start = _time(arguments["start"]["value"], arguments["start"]["scale"])
            self.work_area_duration = _time(
                arguments["duration"]["value"],
                arguments["duration"]["scale"],
            )
            return self._success(
                tool,
                {
                    "changed": True,
                    "compositionLocator": self._locator(),
                    "beforeWorkArea": before,
                    "afterWorkArea": {
                        "start": dict(self.work_area_start),
                        "duration": dict(self.work_area_duration),
                    },
                },
            )
        if tool == "ae_renameProjectItem":
            assert set(arguments) == {"item_locator", "name", "idempotency_key"}
            before = self.name
            self.name = arguments["name"]
            return self._success(
                tool,
                {
                    "changed": True,
                    "itemLocator": self._locator(),
                    "beforeName": before,
                    "afterName": self.name,
                },
            )
        if tool == "ae_setProjectItemComment":
            assert set(arguments) == {"item_locator", "comment", "idempotency_key"}
            before = self.comment
            self.comment = arguments["comment"]
            return self._success(
                tool,
                {
                    "changed": True,
                    "itemLocator": self._locator(),
                    "beforeComment": before,
                    "afterComment": self.comment,
                },
            )
        if tool == "ae_setProjectItemLabel":
            assert set(arguments) == {"item_locator", "label_id", "idempotency_key"}
            before = self.label_id
            self.label_id = arguments["label_id"]
            return self._success(
                tool,
                {
                    "changed": True,
                    "itemLocator": self._locator(),
                    "beforeLabelId": before,
                    "afterLabelId": self.label_id,
                },
            )
        raise AssertionError(f"unexpected tool call: {tool}")

    def _fresh(self, locator: dict[str, Any]) -> bool:
        return (
            locator.get("hostInstanceId") == self.host
            and locator.get("sessionId") == self.session
            and locator.get("generation") == self.generation
        )

    def undo_duplicate(self) -> None:
        assert self.duplicate_exists
        self.duplicate_exists = False
        self.generation += 1

    def restart(self) -> None:
        self.host = HOST_TWO
        self.session = SESSION_TWO
        self.generation = 1


class _FakeFactory:
    def __init__(self, session: _FakeT4Session) -> None:
        self.session = session

    @contextlib.asynccontextmanager
    async def __call__(self):
        yield self.session


def _config(tmp_path: Path | None = None, *, mode: str = "t4") -> Any:
    config = driver.RunConfig(
        mode=mode,
        expected_sha=EXPECTED_SHA,
        fixture_composition_name="Fixture Comp",
        renamed_name="Fixture Renamed",
        duplicate_name="Fixture Copy",
        comment_value="acceptance comment",
        label_id=6,
        work_area_start={"value": 24, "scale": 24},
        work_area_duration={"value": 48, "scale": 24},
    )
    if tmp_path is None:
        return config
    native_root = tmp_path / "native"
    native_root.mkdir(parents=True)
    receipt_path = native_root / "build-receipt.json"
    receipt_path.write_text(json.dumps({
        "sourceCommit": EXPECTED_SHA,
        "source": {"commit": EXPECTED_SHA},
    }) + "\n", encoding="utf-8")
    receipt_hash = hashlib.sha256(receipt_path.read_bytes()).hexdigest()
    manifest_path = native_root / "native-plugin-manifest.json"
    manifest_path.write_text(json.dumps({
        "sourceCommitSha": EXPECTED_SHA,
        "artifact": {
            "receiptSha256": receipt_hash,
            "bundleTreeSha256": "b" * 64,
            "executableSha256": "c" * 64,
            "piplSha256": "d" * 64,
        },
    }) + "\n", encoding="utf-8")
    cep = tmp_path / "Library/Application Support/Adobe/CEP/extensions/com.aemcp.panel/bundle-manifest.json"
    cep.parent.mkdir(parents=True)
    cep.write_text(json.dumps({"sourceCommitSha": EXPECTED_SHA}) + "\n", encoding="utf-8")
    relative = f"0.9.2-{EXPECTED_SHA}/macos-arm64"
    current = tmp_path / ".ae-mcp/runtime/current"
    current.parent.mkdir(parents=True)
    current.write_text(relative + "\n", encoding="utf-8")
    record = current.parent / relative.split("/", 1)[0] / "install-record.json"
    record.parent.mkdir(parents=True)
    record.write_text(json.dumps({
        "relative": relative,
        "sourceCommitSha": EXPECTED_SHA,
        "runtimeManifestSha256": "e" * 64,
    }) + "\n", encoding="utf-8")
    return driver.dataclasses.replace(
        config,
        identity_home=tmp_path,
        native_receipt=receipt_path,
        native_manifest=manifest_path,
    )


@pytest.mark.asyncio
async def test_t4_driver_uses_public_tools_and_proves_duplicate_undo(tmp_path: Path) -> None:
    session = _FakeT4Session()
    checkpoints: list[str] = []

    async def checkpoint(kind: str, _details: dict[str, Any]) -> None:
        checkpoints.append(kind)
        if kind == "undo-duplicate":
            session.undo_duplicate()

    evidence = driver.EvidenceLog(tmp_path / "evidence", mode="t4", expected_sha=EXPECTED_SHA)
    acceptance = driver.PackageAcceptance(
        _config(tmp_path),
        session_factory=_FakeFactory(session),
        checkpoint=checkpoint,
        evidence=evidence,
    )

    result = await acceptance.run()

    assert result["coveredTools"] == [
        "ae_duplicateComposition",
        "ae_getCompositionSettings",
        "ae_getProjectContext",
        "ae_getProjectItemMetadata",
        "ae_listProjectItems",
    ]
    assert checkpoints == ["preflight-ae", "undo-duplicate"]
    assert sum(tool == "ae_duplicateComposition" for tool, _ in session.calls) == 1
    assert any(
        tool == "ae_getProjectItemMetadata" and arguments["item_locator"]["objectId"] == DUPLICATE_ID
        for tool, arguments in session.calls
    )

    item_locator = {
        **session._locator(),
        "kind": "item",
        "objectId": "88888888-8888-4888-8888-888888888888",
    }
    metadata_value: dict[str, Any] = {
        "itemLocator": item_locator,
        "name": "Root folder",
        "type": "folder",
        "parentLocator": None,
        "comment": "",
        "labelId": 0,
    }

    class MinimalMetadataSession:
        async def call(self, tool: str, arguments: dict[str, Any]):
            assert tool == "ae_getProjectItemMetadata"
            assert arguments == {"item_locator": item_locator}
            return session._success(tool, dict(metadata_value))

    metadata = await acceptance._metadata(MinimalMetadataSession(), item_locator)
    assert metadata == metadata_value
    metadata_value["width"] = None
    with pytest.raises(driver.AcceptanceFailure, match="metadata.width is invalid"):
        await acceptance._metadata(MinimalMetadataSession(), item_locator)


@pytest.mark.asyncio
async def test_t5_driver_covers_all_tools_undo_and_restart_stale_locator(tmp_path: Path) -> None:
    session = _FakeT4Session()
    checkpoints: list[str] = []
    restart_call_index: int | None = None
    pre_restart_generation: int | None = None

    async def checkpoint(kind: str, _details: dict[str, Any]) -> None:
        nonlocal restart_call_index, pre_restart_generation
        checkpoints.append(kind)
        if kind == "preflight-ae":
            return
        if kind == "undo-work-area":
            session.work_area_start = _time(0)
            session.work_area_duration = _time(120)
        elif kind == "undo-rename":
            session.name = "Fixture Comp"
        elif kind == "undo-comment":
            session.comment = "baseline"
        elif kind == "undo-label":
            session.label_id = 3
        elif kind == "undo-duplicate":
            session.undo_duplicate()
        elif kind == "restart-ae":
            restart_call_index = len(session.calls)
            pre_restart_generation = session.generation
            session.restart()
        else:  # pragma: no cover - makes a new checkpoint an explicit test failure
            raise AssertionError(f"unexpected checkpoint: {kind}")

    evidence = driver.EvidenceLog(tmp_path / "evidence", mode="t5", expected_sha=EXPECTED_SHA)
    acceptance = driver.PackageAcceptance(
        _config(tmp_path, mode="t5"),
        session_factory=_FakeFactory(session),
        checkpoint=checkpoint,
        evidence=evidence,
    )

    result = await acceptance.run()

    assert result["coveredTools"] == sorted((*driver.PACKAGE_TOOLS, *driver.SUPPORT_TOOLS))
    assert result["writeCount"] == 5
    assert result["undoCheckpoints"] == 5
    assert result["restartChecked"] is True
    assert checkpoints == [
        "preflight-ae",
        "undo-work-area",
        "undo-rename",
        "undo-comment",
        "undo-label",
        "undo-duplicate",
        "restart-ae",
    ]
    for tool in driver.WRITE_TOOLS:
        assert sum(called == tool for called, _ in session.calls) == 1
    idempotency_keys = [
        arguments["idempotency_key"]
        for tool, arguments in session.calls
        if tool in driver.WRITE_TOOLS
    ]
    assert len(idempotency_keys) == len(set(idempotency_keys)) == 5
    assert restart_call_index is not None
    stale_read = next(
        arguments
        for tool, arguments in session.calls[restart_call_index:]
        if tool == "ae_getProjectItemMetadata"
        and arguments["item_locator"]["hostInstanceId"] == HOST_ONE
    )
    assert stale_read["item_locator"]["generation"] == pre_restart_generation == 3


@pytest.mark.asyncio
async def test_ambiguous_write_stops_without_retry(tmp_path: Path) -> None:
    class AmbiguousSession:
        tool_names = frozenset(driver.PACKAGE_TOOLS)
        call_count = 0

        async def call(self, _tool: str, _arguments: dict[str, Any]):
            self.call_count += 1
            return True, {"ok": False, "error": {"code": "POSSIBLY_SIDE_EFFECTING_FAILURE"}}

    session = AmbiguousSession()
    evidence = driver.EvidenceLog(tmp_path / "evidence", mode="t5", expected_sha=EXPECTED_SHA)
    acceptance = driver.PackageAcceptance(
        driver.dataclasses.replace(_config(), mode="t5"),
        session_factory=_FakeFactory(session),
        checkpoint=lambda *_args: None,
        evidence=evidence,
    )

    with pytest.raises(driver.PossiblySideEffectingStop):
        await acceptance._call(
            session,
            "ae_renameProjectItem",
            {
                "item_locator": {"objectId": "source-1"},
                "name": "never retry",
                "idempotency_key": "issue150:test:ambiguous",
            },
        )

    assert session.call_count == 1


@pytest.mark.asyncio
async def test_driver_rejects_selection_only_collateral_and_partial_undo(tmp_path: Path) -> None:
    async def no_checkpoint(_kind: str, _details: dict[str, Any]) -> None:
        return None

    class CollateralSession(_FakeT4Session):
        async def call(self, tool: str, arguments: dict[str, Any]):
            response = await super().call(tool, arguments)
            if tool == "ae_renameProjectItem":
                self.selection_collateral = True
            return response

    collateral = CollateralSession()
    acceptance = driver.PackageAcceptance(
        _config(),
        session_factory=_FakeFactory(collateral),
        checkpoint=no_checkpoint,
        evidence=driver.EvidenceLog(tmp_path / "collateral", mode="t5", expected_sha=EXPECTED_SHA),
    )
    with pytest.raises(driver.AcceptanceFailure, match="rename semantic delta mismatch"):
        await acceptance._exercise_rename(collateral)

    partial = _FakeT4Session()
    acceptance = driver.PackageAcceptance(
        _config(),
        session_factory=_FakeFactory(partial),
        checkpoint=no_checkpoint,
        evidence=driver.EvidenceLog(tmp_path / "partial", mode="t5", expected_sha=EXPECTED_SHA),
    )
    with pytest.raises(driver.AcceptanceFailure, match="Undo did not restore label"):
        await acceptance._exercise_label(partial)


def test_machine_identity_and_jcs_binding_fail_closed(tmp_path: Path) -> None:
    config = _config(tmp_path, mode="t5")
    acceptance = driver.PackageAcceptance(
        config,
        session_factory=_FakeFactory(_FakeT4Session()),
        checkpoint=lambda *_args: None,
        evidence=driver.EvidenceLog(tmp_path / "identity-evidence", mode="t5", expected_sha=EXPECTED_SHA),
    )
    current = tmp_path / ".ae-mcp/runtime/current"
    relative = current.read_text(encoding="utf-8").strip()
    record = current.parent / relative.split("/", 1)[0] / "install-record.json"
    record_payload = json.loads(record.read_text(encoding="utf-8"))
    record_payload["sourceCommitSha"] = "f" * 40
    record.write_text(json.dumps(record_payload) + "\n", encoding="utf-8")
    with pytest.raises(driver.AcceptanceFailure, match="current/install record"):
        acceptance._validate_machine_identity()

    t4_config = _config(tmp_path / "t4", mode="t4")
    t4_cep = (
        t4_config.identity_home
        / "Library/Application Support/Adobe/CEP/extensions/com.aemcp.panel/bundle-manifest.json"
    )
    t4_cep.write_text(json.dumps({"sourceCommitSha": "f" * 40}) + "\n", encoding="utf-8")
    t4_acceptance = driver.PackageAcceptance(
        t4_config,
        session_factory=_FakeFactory(_FakeT4Session()),
        checkpoint=lambda *_args: None,
        evidence=driver.EvidenceLog(tmp_path / "t4-evidence", mode="t4", expected_sha=EXPECTED_SHA),
    )
    with pytest.raises(driver.AcceptanceFailure, match="CEP bundle manifest"):
        t4_acceptance._validate_machine_identity()

    session = _FakeT4Session()
    _is_error, payload = session._success("ae_getProjectContext", {"synthetic": True})
    payload["evidence"]["postcondition"]["digest"] = "0" * 64
    payload["audit"]["postconditionDigest"] = "0" * 64
    with pytest.raises(driver.AcceptanceFailure, match="does not match typed value"):
        acceptance._validate_native_success(payload, "ae_getProjectContext")

    _is_error, payload = session._success("ae_getProjectContext", {"synthetic": True})
    payload["implementation"]["contractDigest"] = "f" * 64
    payload["audit"]["contractDigest"] = "f" * 64
    with pytest.raises(driver.AcceptanceFailure, match="frozen contract digest"):
        acceptance._validate_native_success(payload, "ae_getProjectContext")


def test_evidence_redacts_sensitive_values_and_uses_private_permissions(tmp_path: Path) -> None:
    evidence = driver.EvidenceLog(tmp_path / "private", mode="t5", expected_sha=EXPECTED_SHA)
    evidence.record(
        "probe",
        {
            "pairingFingerprint": "ABCD-EFGH",
            "message": "fixture at /Users/example/Secret Project.aep",
            "safe": "visible",
        },
    )
    evidence.finish(passed=True, details={"fixturePath": "/private/tmp/fixture.aep"})

    event = evidence.events_path.read_text(encoding="utf-8")
    summary = json.loads(evidence.summary_path.read_text(encoding="utf-8"))
    assert "ABCD-EFGH" not in event
    assert "/Users/example" not in event
    assert "visible" in event
    assert summary["details"]["fixturePath"] == "<redacted>"
    assert stat.S_IMODE(evidence.events_path.stat().st_mode) == 0o600
    assert stat.S_IMODE(evidence.summary_path.stat().st_mode) == 0o600
    assert stat.S_IMODE(evidence.root.stat().st_mode) == 0o700
