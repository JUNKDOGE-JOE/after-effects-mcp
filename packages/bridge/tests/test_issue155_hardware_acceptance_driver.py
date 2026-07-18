"""Focused mock contracts for the tracked #155 real-AE orchestrator."""

from __future__ import annotations

import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import math
import os
import plistlib
import stat
import sys
from decimal import Decimal
from fractions import Fraction
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
DRIVER_PATH = REPO_ROOT / "scripts/hardware/issue155_layer_timeline_acceptance.py"
EXPECTED_SHA = "1" * 40
HOST_ONE = "11111111-1111-4111-8111-111111111111"
HOST_TWO = "22222222-2222-4222-8222-222222222222"
SESSION_ONE = "33333333-3333-4333-8333-333333333333"
SESSION_TWO = "44444444-4444-4444-8444-444444444444"
PROJECT_ID = "55555555-5555-4555-8555-555555555555"
PROJECT_OBJECT = "66666666-6666-4666-8666-666666666666"
FIXTURE_BYTES = b"synthetic issue155 disposable fixture"


def _load_driver() -> ModuleType:
    spec = importlib.util.spec_from_file_location("issue155_hardware_acceptance", DRIVER_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


driver = _load_driver()


@pytest.mark.asyncio
async def test_stdin_checkpoint_serializes_nested_path_and_accepts_ack(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(driver.secrets, "token_hex", lambda _size: "abcdef123456")
    monkeypatch.setattr(
        driver.sys,
        "stdin",
        io.StringIO(
            '{"checkpointId":"preflight-ae-abcdef123456","status":"completed"}\n'
        ),
    )

    fixture = tmp_path / "AE 验证 工程" / "fixture 名称.aep"
    await driver.stdin_checkpoint(
        "preflight-ae",
        {"identity": {"formalAeApp": fixture.parent}, "fixtures": [fixture]},
    )

    checkpoint = json.loads(capsys.readouterr().out)
    assert checkpoint["details"] == {
        "identity": {"formalAeApp": os.fsdecode(fixture.parent)},
        "fixtures": [os.fsdecode(fixture)],
    }


def _uuid(index: int) -> str:
    return f"{index:08x}-0000-4000-8000-{index:012x}"


def _time(value: int, scale: int = 24) -> dict[str, Any]:
    divisor = math.gcd(abs(value), scale)
    numerator = value // divisor
    denominator = scale // divisor
    rational = str(numerator) if denominator == 1 else f"{numerator}/{denominator}"
    return {"value": value, "scale": scale, "secondsRational": rational}


def _ratio(numerator: int, denominator: int = 1) -> dict[str, Any]:
    divisor = math.gcd(abs(numerator), denominator)
    reduced_numerator = numerator // divisor
    reduced_denominator = denominator // divisor
    rational = (
        str(reduced_numerator)
        if reduced_denominator == 1
        else f"{reduced_numerator}/{reduced_denominator}"
    )
    return {
        "numerator": numerator,
        "denominator": denominator,
        "rational": rational,
    }


def _save_fixture(details: dict[str, Any]) -> None:
    fixture = Path(details["fixturePath"])
    fixture.parent.mkdir(parents=True, exist_ok=True)
    fixture.write_bytes(FIXTURE_BYTES)


def _write_native_load(
    identity_home: Path,
    instance_id: str,
    *,
    version: str = "26.3.0",
    build: str = "87",
) -> None:
    log = identity_home / "Library/Logs/AfterEffectsMCP/native-plugin-v1.jsonl"
    log.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "schemaVersion": 1,
        "event": "load",
        "timeUnixMs": 1_900_000_000_000,
        "provenance": "native-aegp",
        "instanceId": instance_id,
        "pluginVersion": "0.9.2",
        "compiledSdkVersion": "25.6.61",
        "sourceCommit": EXPECTED_SHA,
        "driverApi": {"major": 26, "minor": 3},
        "host": {"version": version, "build": build},
        "capabilities": list(driver.CAPABILITY_BY_TOOL.values()),
    }
    with log.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(record, separators=(",", ":")) + "\n")
    os.chmod(log, 0o600)


class _FakeSession:
    tool_names = frozenset((*driver.PACKAGE_TOOLS, *driver.SUPPORT_TOOLS))

    def __init__(self, *, wrong_duplicate_copy: bool = False) -> None:
        self.host = HOST_ONE
        self.session = SESSION_ONE
        self.generation = 1
        self._next_id = 100
        self._request = 0
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.compositions: dict[str, dict[str, Any]] = {}
        self.undo_stack: list[tuple[dict[str, Any], bool]] = []
        self.replays: dict[str, dict[str, Any]] = {}
        self.graph_rebinds = 0
        self.wrong_duplicate_copy = wrong_duplicate_copy
        self.restart_transitions: list[tuple[str, str, str, str]] = []
        self.contracts = {
            capability: hashlib.sha256(capability.encode()).hexdigest()
            for capability in driver.CAPABILITY_BY_TOOL.values()
        }

    def _new_id(self) -> str:
        self._next_id += 1
        return _uuid(self._next_id)

    def _invalidate(self) -> None:
        self.generation += 1

    def _project_locator(self) -> dict[str, Any]:
        return self._locator("project", PROJECT_OBJECT)

    def _locator(self, kind: str, object_id: str) -> dict[str, Any]:
        return {
            "kind": kind,
            "hostInstanceId": self.host,
            "sessionId": self.session,
            "projectId": PROJECT_ID,
            "generation": self.generation,
            "objectId": object_id,
        }

    def _find_comp(self, object_id: str) -> dict[str, Any] | None:
        return next(
            (comp for comp in self.compositions.values() if comp["id"] == object_id),
            None,
        )

    def _find_layer(self, object_id: str) -> tuple[dict[str, Any], dict[str, Any]] | None:
        for comp in self.compositions.values():
            for layer in comp["layers"]:
                if layer["id"] == object_id:
                    return comp, layer
        return None

    def _fresh(self, locator: dict[str, Any], kind: str) -> bool:
        if (
            locator.get("kind") != kind
            or locator.get("hostInstanceId") != self.host
            or locator.get("sessionId") != self.session
            or locator.get("projectId") != PROJECT_ID
            or locator.get("generation") != self.generation
        ):
            return False
        object_id = locator.get("objectId")
        if kind == "composition":
            return self._find_comp(object_id) is not None
        if kind == "layer":
            return self._find_layer(object_id) is not None
        return True

    def _layer_details(self, comp: dict[str, Any], layer: dict[str, Any]) -> dict[str, Any]:
        parent = layer["parent"]
        return {
            "layerLocator": self._locator("layer", layer["id"]),
            "compositionLocator": self._locator("composition", comp["id"]),
            "stackIndex": comp["layers"].index(layer) + 1,
            "name": layer["name"],
            "type": layer["type"],
            "videoEnabled": True,
            "isThreeD": False,
            "locked": False,
            "parentLocator": self._locator("layer", parent) if parent else None,
            "sourceItemLocator": (
                self._locator("item", layer["source"])
                if layer["source"] is not None
                else None
            ),
            "inPoint": copy.deepcopy(layer["inPoint"]),
            "duration": copy.deepcopy(layer["duration"]),
            "startTime": copy.deepcopy(layer["startTime"]),
            "stretch": copy.deepcopy(layer["stretch"]),
        }

    def _snapshot(self) -> dict[str, Any]:
        return copy.deepcopy(self.compositions)

    def _push_undo(self, *, invalidates_graph: bool = False) -> None:
        self.undo_stack.append((self._snapshot(), invalidates_graph))

    def _rebind_layer_ids(self, *, preserve: frozenset[str] = frozenset()) -> None:
        for comp in self.compositions.values():
            id_map = {
                layer["id"]: (
                    layer["id"] if layer["id"] in preserve else self._new_id()
                )
                for layer in comp["layers"]
            }
            for layer in comp["layers"]:
                layer["id"] = id_map[layer["id"]]
                layer["parent"] = id_map.get(layer["parent"])
        self.graph_rebinds += 1
        self._invalidate()

    def undo(self) -> None:
        assert self.undo_stack
        self.compositions, invalidates_graph = self.undo_stack.pop()
        if invalidates_graph:
            self._rebind_layer_ids()
        else:
            self._invalidate()

    def restart(self) -> None:
        previous_host = self.host
        previous_session = self.session
        self._rebind_layer_ids()
        self.host = HOST_TWO
        self.session = SESSION_TWO
        self.generation = 1
        self.restart_transitions.append(
            (previous_host, previous_session, self.host, self.session)
        )

    @staticmethod
    def _error(code: str) -> tuple[bool, dict[str, Any]]:
        return True, {
            "ok": False,
            "error": {
                "code": code,
                "retryable": False,
                "sideEffect": "not-started",
                "recovery": {"action": "change-arguments"},
            },
        }

    def _success(
        self,
        tool: str,
        value: dict[str, Any],
        *,
        replayed: bool = False,
    ) -> tuple[bool, dict[str, Any]]:
        self._request += 1
        request_id = f"request-{self._request}"
        capability = driver.CAPABILITY_BY_TOOL[tool]
        digest = driver._json_hash(
            {"capabilityId": capability, "capabilityVersion": 1, "value": value}
        )
        request_digest = hashlib.sha256(request_id.encode()).hexdigest()
        write = tool in driver.WRITE_TOOLS or tool in driver.SUPPORT_WRITE_TOOLS
        effect = "committed" if write else "none"
        contract = self.contracts[capability]
        evidence: dict[str, Any] = {
            "engine": "native-aegp",
            "hostInstanceId": self.host,
            "sessionId": self.session,
            "requestId": request_id,
            "capabilityId": capability,
            "capabilityVersion": 1,
            "startedAtUnixMs": 1_900_000_000_000,
            "completedAtUnixMs": 1_900_000_000_025,
            "effect": effect,
            "requestDigest": request_digest,
            "postcondition": {
                "verified": True,
                "kind": f"{capability}-postcondition",
                "algorithm": "sha256-rfc8785-jcs-v1",
                "digest": digest,
            },
        }
        if write:
            evidence["undo"] = {"available": True, "verified": False}
        return False, {
            "ok": True,
            **({"replayed": replayed} if write else {}),
            "value": value,
            "implementation": {
                "engine": "native-aegp",
                "capabilityId": capability,
                "capabilityVersion": 1,
                "contractDigest": contract,
                "risk": "write" if write else "read",
                "mutability": "mutating" if write else "read-only",
                "idempotency": "idempotency-key" if write else "idempotent",
                "undo": "ae-undo-group" if write else "not-applicable",
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
                "capabilityId": capability,
                "capabilityVersion": 1,
                "contractDigest": contract,
                "effect": effect,
                "requestDigest": request_digest,
                "postconditionAlgorithm": "sha256-rfc8785-jcs-v1",
                "postconditionDigest": digest,
                "startedAtUnixMs": 1_900_000_000_000,
                "completedAtUnixMs": 1_900_000_000_025,
            },
            "evidence": evidence,
        }

    async def call(
        self, tool: str, arguments: dict[str, Any]
    ) -> tuple[bool, dict[str, Any]]:
        self.calls.append((tool, copy.deepcopy(arguments)))
        if tool == "ae_createComposition":
            self._push_undo()
            self._invalidate()
            comp = {"id": self._new_id(), "name": arguments["name"], "layers": []}
            self.compositions[comp["name"]] = comp
            return self._success(
                tool,
                {
                    "changed": True,
                    "name": comp["name"],
                    "compositionLocator": self._locator("composition", comp["id"]),
                    "projectItemCountBefore": len(self.compositions) - 1,
                    "projectItemCountAfter": len(self.compositions),
                    "layerCount": 0,
                    "width": 640,
                    "height": 360,
                    "duration": _time(10, 1),
                    "frameRate": _ratio(24),
                    "pixelAspectRatio": _ratio(1),
                },
            )
        if tool == "ae_createCompositionLayer":
            locator = arguments["composition_locator"]
            if not self._fresh(locator, "composition"):
                return self._error("STALE_LOCATOR")
            comp = self._find_comp(locator["objectId"])
            assert comp is not None
            self._push_undo()
            layer = {
                "id": self._new_id(),
                "name": arguments["name"],
                "type": "null" if arguments["kind"] == "null" else "av",
                "parent": None,
                "source": None if arguments["kind"] == "null" else self._new_id(),
                "inPoint": _time(0),
                "duration": _time(240),
                "startTime": _time(0),
                "stretch": _ratio(1),
            }
            before_count = len(comp["layers"])
            comp["layers"].insert(0, layer)
            self._invalidate()
            value = {
                "changed": True,
                "kind": arguments["kind"],
                "name": layer["name"],
                "stackIndex": 1,
                "compositionLocator": self._locator("composition", comp["id"]),
                "layerLocator": self._locator("layer", layer["id"]),
                "sourceItemLocator": (
                    self._locator("item", layer["source"]) if layer["source"] else None
                ),
                "layerCountBefore": before_count,
                "layerCountAfter": before_count + 1,
                "projectItemCountBefore": len(self.compositions),
                "projectItemCountAfter": len(self.compositions),
            }
            if arguments["kind"] == "solid":
                value["solid"] = {
                    "color": arguments["color"],
                    "width": arguments["width"],
                    "height": arguments["height"],
                    "duration": _time(
                        arguments["duration"]["value"], arguments["duration"]["scale"]
                    ),
                }
            return self._success(tool, value)
        if tool == "ae_listProjectItems":
            items = [
                {
                    "compositionLocator": self._locator("composition", comp["id"]),
                    "name": comp["name"],
                    "type": "composition",
                    "parentLocator": None,
                }
                for comp in self.compositions.values()
            ]
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
        if tool == "ae_listCompositionLayers":
            locator = arguments["composition_locator"]
            if not self._fresh(locator, "composition"):
                return self._error("STALE_LOCATOR")
            comp = self._find_comp(locator["objectId"])
            assert comp is not None
            layers = []
            for index, layer in enumerate(comp["layers"], 1):
                details = self._layer_details(comp, layer)
                layers.append(
                    {
                        "locator": details["layerLocator"],
                        "stackIndex": index,
                        "name": layer["name"],
                        "type": layer["type"],
                        "videoEnabled": True,
                        "isThreeD": False,
                        "locked": False,
                        "parentLocator": details["parentLocator"],
                        "sourceItemLocator": details["sourceItemLocator"],
                    }
                )
            return self._success(
                tool,
                {
                    "compositionLocator": self._locator("composition", comp["id"]),
                    "compositionName": comp["name"],
                    "total": len(layers),
                    "offset": 0,
                    "limit": 25,
                    "returned": len(layers),
                    "hasMore": False,
                    "nextOffset": None,
                    "layers": layers,
                },
            )
        if tool == "ae_getLayerDetails":
            locator = arguments["layer_locator"]
            if not self._fresh(locator, "layer"):
                return self._error("STALE_LOCATOR")
            found = self._find_layer(locator["objectId"])
            assert found is not None
            return self._success(tool, self._layer_details(*found))

        key = arguments.get("idempotency_key")
        if tool in driver.WRITE_TOOLS and isinstance(key, str) and key in self.replays:
            stored = copy.deepcopy(self.replays[key])
            if tool == "ae_duplicateLayer":
                source = self._find_layer(stored["sourceLayerLocator"]["objectId"])
                copied = self._find_layer(stored["newLayerLocator"]["objectId"])
                assert source is not None and copied is not None
                comp, source_layer = source
                _copy_comp, copy_layer = copied
                stored["sourceLayerLocator"] = self._locator("layer", source_layer["id"])
                stored["newLayerLocator"] = self._locator("layer", copy_layer["id"])
                stored["compositionLocator"] = self._locator("composition", comp["id"])
                stored["newLayer"] = self._layer_details(comp, copy_layer)
            return self._success(tool, stored, replayed=True)

        if tool == "ae_renameLayer":
            found = self._require_layer(arguments["layer_locator"])
            if found is None:
                return self._error("STALE_LOCATOR")
            comp, layer = found
            if layer["name"] == arguments["name"]:
                return self._error("PRECONDITION_FAILED")
            self._push_undo()
            before = layer["name"]
            layer["name"] = arguments["name"]
            value = {
                "changed": True,
                "layerLocator": self._locator("layer", layer["id"]),
                "beforeName": before,
                "afterName": layer["name"],
            }
            self.replays[key] = copy.deepcopy(value)
            return self._success(tool, value)
        if tool == "ae_setLayerRange":
            if arguments["duration"]["value"] <= 0:
                return self._error("INVALID_ARGUMENT")
            found = self._require_layer(arguments["layer_locator"])
            if found is None:
                return self._error("STALE_LOCATOR")
            _comp, layer = found
            self._push_undo()
            before_in = copy.deepcopy(layer["inPoint"])
            before_duration = copy.deepcopy(layer["duration"])
            layer["inPoint"] = _time(
                arguments["in_point"]["value"], arguments["in_point"]["scale"]
            )
            layer["duration"] = _time(
                arguments["duration"]["value"], arguments["duration"]["scale"]
            )
            value = {
                "changed": True,
                "layerLocator": self._locator("layer", layer["id"]),
                "beforeInPoint": before_in,
                "beforeDuration": before_duration,
                "afterInPoint": copy.deepcopy(layer["inPoint"]),
                "afterDuration": copy.deepcopy(layer["duration"]),
            }
            self.replays[key] = copy.deepcopy(value)
            return self._success(tool, value)
        if tool == "ae_setLayerStartTime":
            found = self._require_layer(arguments["layer_locator"])
            if found is None:
                return self._error("STALE_LOCATOR")
            _comp, layer = found
            self._push_undo()
            before = copy.deepcopy(layer["startTime"])
            layer["startTime"] = _time(
                arguments["start_time"]["value"], arguments["start_time"]["scale"]
            )
            value = {
                "changed": True,
                "layerLocator": self._locator("layer", layer["id"]),
                "beforeStartTime": before,
                "afterStartTime": copy.deepcopy(layer["startTime"]),
            }
            self.replays[key] = copy.deepcopy(value)
            return self._success(tool, value)
        if tool == "ae_setLayerStretch":
            if arguments["stretch_percent"] == "0":
                return self._error("INVALID_ARGUMENT")
            found = self._require_layer(arguments["layer_locator"])
            if found is None:
                return self._error("STALE_LOCATOR")
            _comp, layer = found
            self._push_undo()
            before = copy.deepcopy(layer["stretch"])
            exact = Fraction(Decimal(arguments["stretch_percent"])) / 100
            layer["stretch"] = _ratio(exact.numerator, exact.denominator)
            value = {
                "changed": True,
                "layerLocator": self._locator("layer", layer["id"]),
                "beforeStretch": before,
                "afterStretch": copy.deepcopy(layer["stretch"]),
            }
            self.replays[key] = copy.deepcopy(value)
            return self._success(tool, value)
        if tool == "ae_reorderLayer":
            found = self._require_layer(arguments["layer_locator"])
            if found is None:
                return self._error("STALE_LOCATOR")
            comp, layer = found
            target = arguments["target_stack_index"]
            if not 1 <= target <= len(comp["layers"]):
                return self._error("INVALID_ARGUMENT")
            before = comp["layers"].index(layer) + 1
            if before == target:
                return self._error("PRECONDITION_FAILED")
            self._push_undo()
            comp["layers"].remove(layer)
            comp["layers"].insert(target - 1, layer)
            value = {
                "changed": True,
                "layerLocator": self._locator("layer", layer["id"]),
                "beforeStackIndex": before,
                "afterStackIndex": target,
            }
            self.replays[key] = copy.deepcopy(value)
            return self._success(tool, value)
        if tool == "ae_setLayerParent":
            found = self._require_layer(arguments["layer_locator"])
            if found is None:
                return self._error("STALE_LOCATOR")
            comp, layer = found
            parent_locator = arguments["parent_layer_locator"]
            if parent_locator is not None:
                parent_found = self._require_layer(parent_locator)
                if parent_found is None:
                    return self._error("STALE_LOCATOR")
                parent_comp, parent = parent_found
                if parent["id"] == layer["id"]:
                    return self._error("INVALID_ARGUMENT")
                if parent_comp["id"] != comp["id"]:
                    return self._error("PRECONDITION_FAILED")
                parent_id = parent["id"]
            else:
                parent_id = None
            if parent_id == layer["parent"]:
                return self._error("PRECONDITION_FAILED")
            self._push_undo()
            before_parent = layer["parent"]
            layer["parent"] = parent_id
            value = {
                "changed": True,
                "layerLocator": self._locator("layer", layer["id"]),
                "beforeParentLocator": (
                    self._locator("layer", before_parent) if before_parent else None
                ),
                "afterParentLocator": (
                    self._locator("layer", parent_id) if parent_id else None
                ),
            }
            self.replays[key] = copy.deepcopy(value)
            return self._success(tool, value)
        if tool == "ae_duplicateLayer":
            found = self._require_layer(arguments["layer_locator"])
            if found is None:
                return self._error("STALE_LOCATOR")
            comp, source = found
            self._push_undo(invalidates_graph=True)
            before_count = len(comp["layers"])
            copied = copy.deepcopy(source)
            copied["id"] = self._new_id()
            copied["name"] = arguments["new_name"]
            copied["parent"] = None
            if self.wrong_duplicate_copy:
                copied["stretch"] = _ratio(2)
            comp["layers"].insert(comp["layers"].index(source), copied)
            self._rebind_layer_ids(
                preserve=frozenset({source["id"], copied["id"]})
            )
            value = {
                "changed": True,
                "sourceLayerLocator": self._locator("layer", source["id"]),
                "newLayerLocator": self._locator("layer", copied["id"]),
                "compositionLocator": self._locator("composition", comp["id"]),
                "layerCountBefore": before_count,
                "layerCountAfter": before_count + 1,
                "newLayer": self._layer_details(comp, copied),
            }
            self.replays[key] = copy.deepcopy(value)
            return self._success(tool, value)
        if tool == "ae_duplicateComposition":
            locator = arguments["composition_locator"]
            if not self._fresh(locator, "composition"):
                return self._error("STALE_LOCATOR")
            source = self._find_comp(locator["objectId"])
            assert source is not None
            self._push_undo(invalidates_graph=True)
            duplicate = copy.deepcopy(source)
            duplicate["id"] = self._new_id()
            duplicate["name"] = arguments["new_name"]
            id_map = {layer["id"]: self._new_id() for layer in duplicate["layers"]}
            for layer in duplicate["layers"]:
                old = layer["id"]
                layer["id"] = id_map[old]
                layer["parent"] = id_map.get(layer["parent"])
            self.compositions[duplicate["name"]] = duplicate
            self._rebind_layer_ids()
            return self._success(
                tool,
                {
                    "changed": True,
                    "sourceCompositionLocator": self._locator("composition", source["id"]),
                    "newCompositionLocator": self._locator("composition", duplicate["id"]),
                    "projectItemCountBefore": len(self.compositions) - 1,
                    "projectItemCountAfter": len(self.compositions),
                    "sourceSettings": {"name": source["name"]},
                    "newSettings": {"name": duplicate["name"]},
                },
            )
        raise AssertionError(f"unexpected tool call: {tool}")

    def _require_layer(
        self, locator: dict[str, Any]
    ) -> tuple[dict[str, Any], dict[str, Any]] | None:
        if not self._fresh(locator, "layer"):
            return None
        return self._find_layer(locator["objectId"])


class _FakeFactory:
    def __init__(self, session: _FakeSession) -> None:
        self.session = session

    @contextlib.asynccontextmanager
    async def __call__(self):
        yield self.session


def _config(
    tmp_path: Path, *, mode: str, stretch_percent: str = "150"
) -> Any:
    identity = tmp_path / "identity"
    native = tmp_path / "native"
    native.mkdir(parents=True)
    receipt = native / "build-receipt.json"
    receipt.write_text(
        json.dumps(
            {"sourceCommit": EXPECTED_SHA, "source": {"commit": EXPECTED_SHA}}
        )
        + "\n",
        encoding="utf-8",
    )
    receipt_hash = hashlib.sha256(receipt.read_bytes()).hexdigest()
    manifest = native / "native-plugin-manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "sourceCommitSha": EXPECTED_SHA,
                "artifact": {
                    "receiptSha256": receipt_hash,
                    "bundleTreeSha256": "b" * 64,
                    "executableSha256": "c" * 64,
                    "piplSha256": "d" * 64,
                },
            }
        )
        + "\n",
        encoding="utf-8",
    )
    cep = identity / "Library/Application Support/Adobe/CEP/extensions/com.aemcp.panel/bundle-manifest.json"
    cep.parent.mkdir(parents=True)
    cep.write_text(json.dumps({"sourceCommitSha": EXPECTED_SHA}) + "\n", encoding="utf-8")
    relative = f"0.9.2-{EXPECTED_SHA}/macos-arm64"
    current = identity / ".ae-mcp/runtime/current"
    current.parent.mkdir(parents=True)
    current.write_text(relative + "\n", encoding="utf-8")
    runtime_manifest = current.parent / relative / "runtime-manifest.json"
    runtime_manifest.parent.mkdir(parents=True)
    runtime_manifest.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "platform": "macos-arm64",
                "node": {"assetSha256": "f" * 64},
                "python": {"assetSha256": "a" * 64},
                "files": [],
            }
        )
        + "\n",
        encoding="utf-8",
    )
    runtime_manifest_hash = hashlib.sha256(runtime_manifest.read_bytes()).hexdigest()
    record = current.parent / relative.split("/", 1)[0] / "install-record.json"
    record.parent.mkdir(parents=True, exist_ok=True)
    record.write_text(
        json.dumps(
            {
                "relative": relative,
                "sourceCommitSha": EXPECTED_SHA,
                "runtimeManifestSha256": runtime_manifest_hash,
                "launcherSha256": "e" * 64,
            }
        )
        + "\n",
        encoding="utf-8",
    )
    capabilities = tmp_path / "capabilities.json"
    capabilities.write_text(
        json.dumps(
            {
                "response": {
                    "result": {
                        "items": [
                            {
                                "id": capability,
                                "contractDigest": hashlib.sha256(
                                    capability.encode()
                                ).hexdigest(),
                            }
                            for capability in driver.CAPABILITY_BY_TOOL.values()
                        ]
                    }
                }
            }
        )
        + "\n",
        encoding="utf-8",
    )
    formal_app = tmp_path / "formal/Adobe After Effects 2026.app"
    plist_path = formal_app / "Contents/Info.plist"
    executable = formal_app / "Contents/MacOS/After Effects"
    executable.parent.mkdir(parents=True)
    plist_path.write_bytes(
        plistlib.dumps(
            {
                "CFBundleIdentifier": "com.adobe.AfterEffects.application",
                "CFBundleShortVersionString": "26.3.0",
                "CFBundleVersion": "26.3.0.87",
                "CFBundleExecutable": "After Effects",
            }
        )
    )
    executable.write_bytes(b"synthetic formal AE executable")
    return driver.RunConfig(
        mode=mode,
        expected_sha=EXPECTED_SHA,
        stretch_percent=stretch_percent,
        fixture_path=tmp_path / "active/issue155-fixture.aep",
        recovery_archive_root=tmp_path / "recovery-archive",
        formal_ae_app=formal_app,
        identity_home=identity,
        native_receipt=receipt,
        native_manifest=manifest,
        contract_fixture=capabilities,
    )


@pytest.mark.asyncio
async def test_t4_duplicate_path_is_public_replayed_undoable_and_archived(
    tmp_path: Path,
) -> None:
    session = _FakeSession()
    checkpoints: list[str] = []

    async def checkpoint(kind: str, details: dict[str, Any]) -> None:
        checkpoints.append(kind)
        if kind == "preflight-ae":
            _write_native_load(tmp_path / "identity", session.host)
        elif kind == "save-fixture":
            _save_fixture(details)
        if kind.startswith("undo-"):
            session.undo()

    evidence = driver.EvidenceLog(
        tmp_path / "evidence", mode="t4", expected_sha=EXPECTED_SHA
    )
    acceptance = driver.PackageAcceptance(
        _config(tmp_path, mode="t4"),
        session_factory=_FakeFactory(session),
        checkpoint=checkpoint,
        evidence=evidence,
    )

    result = await acceptance.run()

    assert result["coveredTools"] == ["ae_duplicateLayer", "ae_getLayerDetails"]
    assert result["writeCount"] == 1
    assert result["undoVerifiedTools"] == ["ae_duplicateLayer"]
    assert checkpoints == [
        "preflight-ae",
        "save-fixture",
        "undo-duplicate",
        "archive-fixture",
    ]
    duplicate_calls = [call for call in session.calls if call[0] == "ae_duplicateLayer"]
    assert len(duplicate_calls) == 2
    assert duplicate_calls[0][1] == duplicate_calls[1][1]
    replayed = session.replays[duplicate_calls[0][1]["idempotency_key"]]
    assert (
        replayed["sourceLayerLocator"]["objectId"]
        == duplicate_calls[0][1]["layer_locator"]["objectId"]
    )
    assert session.graph_rebinds == 2
    assert len(session.compositions) == 1
    assert len(next(iter(session.compositions.values()))["layers"]) == 4
    assert not os.path.lexists(acceptance.config.fixture_path)
    archived = list(acceptance.config.recovery_archive_root.rglob("*.aep"))
    assert len(archived) == 1 and archived[0].read_bytes() == FIXTURE_BYTES
    assert acceptance.aep_lifecycle == driver.AepLifecycleCounters(
        created=1,
        archived=1,
        logical_bytes_moved=len(FIXTURE_BYTES),
    )


@pytest.mark.asyncio
async def test_t5_continuous_package_matrix_covers_all_tools_undo_restart_and_summary(
    tmp_path: Path,
) -> None:
    session = _FakeSession()
    checkpoints: list[str] = []

    async def checkpoint(kind: str, details: dict[str, Any]) -> None:
        checkpoints.append(kind)
        assert details.get("saveAsCopies", 0) == 0
        if kind in {"preflight-ae", "save-fixture", "restart-ae", "archive-fixture"}:
            assert details["formalAfterEffects"]["bundleId"] == (
                "com.adobe.AfterEffects.application"
            )
            assert details["formalAfterEffects"]["version"] == "26.3.0"
            assert details["formalAfterEffects"]["build"] == "26.3.0.87"
        if kind == "preflight-ae":
            _write_native_load(tmp_path / "identity", session.host)
        elif kind == "save-fixture":
            _save_fixture(details)
        elif kind.startswith("undo-"):
            session.undo()
        elif kind == "restart-ae":
            assert "Save the one active ephemeral fixture in place" in details["instruction"]
            assert "still untitled" not in details["instruction"]
            assert "Do not use Save As" in details["instruction"]
            session.restart()
            _write_native_load(tmp_path / "identity", session.host)

    evidence = driver.EvidenceLog(
        tmp_path / "evidence", mode="t5", expected_sha=EXPECTED_SHA
    )
    acceptance = driver.PackageAcceptance(
        _config(tmp_path, mode="t5", stretch_percent="125.5"),
        session_factory=_FakeFactory(session),
        checkpoint=checkpoint,
        evidence=evidence,
    )

    result = await acceptance.run()

    assert result["coveredTools"] == sorted(driver.PACKAGE_TOOLS)
    assert result["writeCount"] == 7
    assert result["undoVerifiedTools"] == sorted(driver.WRITE_TOOLS)
    assert result["restartChecked"] is True
    assert checkpoints == [
        "preflight-ae",
        "save-fixture",
        "undo-rename",
        "undo-range",
        "undo-start-time",
        "undo-stretch",
        "undo-reorder",
        "undo-parent",
        "undo-cross-composition-witness",
        "undo-duplicate-copy-rename",
        "undo-duplicate-copy-reorder",
        "undo-duplicate",
        "restart-ae",
        "archive-fixture",
    ]
    assert all(row["status"] == "passed" for row in result["perToolMatrix"].values())
    assert result["perToolMatrix"]["ae_renameLayer"]["undo"]["executed"] == 2
    assert result["perToolMatrix"]["ae_reorderLayer"]["undo"]["executed"] == 2
    for tool in driver.WRITE_TOOLS - {"ae_renameLayer", "ae_reorderLayer"}:
        assert result["perToolMatrix"][tool]["undo"] == {
            "required": True,
            "executed": 1,
            "verified": True,
        }
    assert result["fixture"]["id"] == "Issue155 Layer Timeline Fixture"
    assert result["fixture"]["lifecycle"] == "ephemeral-validation"
    assert result["fixture"]["activeFixtureCount"] == 0
    assert result["fixture"]["saveAsCopies"] == 0
    assert result["fixture"]["layers"] == ["BG", "Subject", "CTRL", "Child"]
    assert result["fixture"]["archived"]["sourceAbsent"] is True
    assert len(session.compositions) == 1
    assert session.graph_rebinds == 5
    assert session.restart_transitions == [
        (HOST_ONE, SESSION_ONE, HOST_TWO, SESSION_TWO)
    ]
    assert not os.path.lexists(acceptance.config.fixture_path)
    assert len(list(acceptance.config.recovery_archive_root.rglob("*.aep"))) == 1

    evidence.record("run-passed", result)
    evidence.finish(
        passed=True,
        details=result,
        efficiency=driver.EfficiencyCounters(
            review_rounds=2,
            candidate_builds=1,
            full_ci_runs=1,
            t4_runs=1,
            candidate_hardware_runs=1,
            main_hardware_runs=0,
            first_hardware_pass=True,
            gui_pairing_interruptions=0,
            scope_frozen_unix_ms=1_900_000_000_000,
        ),
        aep_lifecycle=acceptance.aep_lifecycle,
    )
    summary = json.loads(evidence.summary_path.read_text(encoding="utf-8"))
    markdown = evidence.markdown_path.read_text(encoding="utf-8")
    assert summary["packageIssue"] == 155
    assert summary["details"]["efficiency"]["includedTools"] == 8
    assert summary["details"]["aepLifecycle"] == {
        "created": 1,
        "canonicalRetained": 0,
        "evidenceSnapshotsRetained": 0,
        "archived": 1,
        "unclassified": 0,
        "logicalBytesMoved": len(FIXTURE_BYTES),
        "physicalBytesReleased": 0,
    }
    for tool in driver.PACKAGE_TOOLS:
        assert f"`{tool}`" in markdown
    assert "one active fixture; no Save As copies" in markdown
    if os.name == "posix":
        assert stat.S_IMODE(evidence.root.stat().st_mode) == 0o700
        assert stat.S_IMODE(evidence.events_path.stat().st_mode) == 0o600
        assert stat.S_IMODE(evidence.summary_path.stat().st_mode) == 0o600
        assert stat.S_IMODE(evidence.markdown_path.stat().st_mode) == 0o600


@pytest.mark.asyncio
async def test_restart_state_drift_rejects_acceptance_before_fixture_archive(
    tmp_path: Path,
) -> None:
    session = _FakeSession()
    checkpoints: list[str] = []

    async def checkpoint(kind: str, details: dict[str, Any]) -> None:
        checkpoints.append(kind)
        if kind == "preflight-ae":
            _write_native_load(tmp_path / "identity", session.host)
        elif kind == "save-fixture":
            _save_fixture(details)
        elif kind.startswith("undo-"):
            session.undo()
        elif kind == "restart-ae":
            session.restart()
            composition = next(iter(session.compositions.values()))
            subject = next(
                layer for layer in composition["layers"] if layer["name"] == "Subject"
            )
            subject["duration"] = _time(239)
            _write_native_load(tmp_path / "identity", session.host)

    acceptance = driver.PackageAcceptance(
        _config(tmp_path, mode="t5", stretch_percent="125.5"),
        session_factory=_FakeFactory(session),
        checkpoint=checkpoint,
        evidence=driver.EvidenceLog(
            tmp_path / "restart-drift", mode="t5", expected_sha=EXPECTED_SHA
        ),
    )

    with pytest.raises(
        driver.AcceptanceFailure,
        match="restart changed the verified post-Undo fixture baseline",
    ):
        await acceptance.run()

    assert checkpoints[-1] == "restart-ae"
    assert "archive-fixture" not in checkpoints
    assert acceptance.config.fixture_path.read_bytes() == FIXTURE_BYTES
    assert not acceptance.config.recovery_archive_root.exists()
    assert acceptance.aep_lifecycle == driver.AepLifecycleCounters(created=1)


@pytest.mark.asyncio
async def test_duplicate_rejects_wrong_copy_semantics_and_does_not_claim_archive(
    tmp_path: Path,
) -> None:
    session = _FakeSession(wrong_duplicate_copy=True)
    checkpoints: list[str] = []

    async def checkpoint(kind: str, details: dict[str, Any]) -> None:
        checkpoints.append(kind)
        if kind == "preflight-ae":
            _write_native_load(tmp_path / "identity", session.host)
        elif kind == "save-fixture":
            _save_fixture(details)

    evidence = driver.EvidenceLog(
        tmp_path / "wrong-copy", mode="t4", expected_sha=EXPECTED_SHA
    )
    acceptance = driver.PackageAcceptance(
        _config(tmp_path, mode="t4"),
        session_factory=_FakeFactory(session),
        checkpoint=checkpoint,
        evidence=evidence,
    )

    with pytest.raises(driver.AcceptanceFailure, match="stable semantics"):
        await acceptance.run()

    assert checkpoints == ["preflight-ae", "save-fixture"]
    assert acceptance.config.fixture_path.read_bytes() == FIXTURE_BYTES
    assert not acceptance.config.recovery_archive_root.exists()
    assert acceptance.aep_lifecycle == driver.AepLifecycleCounters(created=1)
    evidence.finish(
        passed=False,
        details={"perToolMatrix": acceptance.matrix},
        efficiency=driver.EfficiencyCounters(),
        aep_lifecycle=acceptance.aep_lifecycle,
    )
    failed_summary = json.loads(evidence.summary_path.read_text(encoding="utf-8"))
    assert failed_summary["passed"] is False
    assert failed_summary["details"]["aepLifecycle"]["archived"] == 0


@pytest.mark.asyncio
async def test_nonempty_project_stops_before_save_or_any_support_write(
    tmp_path: Path,
) -> None:
    session = _FakeSession()
    session.compositions["User Project"] = {
        "id": session._new_id(),
        "name": "User Project",
        "layers": [],
    }
    checkpoints: list[str] = []

    async def checkpoint(kind: str, _details: dict[str, Any]) -> None:
        checkpoints.append(kind)
        if kind == "preflight-ae":
            _write_native_load(tmp_path / "identity", session.host)

    acceptance = driver.PackageAcceptance(
        _config(tmp_path, mode="t5"),
        session_factory=_FakeFactory(session),
        checkpoint=checkpoint,
        evidence=driver.EvidenceLog(
            tmp_path / "nonempty", mode="t5", expected_sha=EXPECTED_SHA
        ),
    )

    with pytest.raises(driver.AcceptanceFailure, match="active project is not empty"):
        await acceptance.run()

    assert checkpoints == ["preflight-ae"]
    assert not os.path.lexists(acceptance.config.fixture_path)
    assert not any(
        tool in driver.SUPPORT_WRITE_TOOLS or tool in driver.WRITE_TOOLS
        for tool, _arguments in session.calls
    )
    assert acceptance.aep_lifecycle == driver.AepLifecycleCounters()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("version", "build", "instance_id", "message"),
    [
        ("26.5.0", "62", HOST_ONE, "host version mismatch"),
        ("26.3.0", "999", HOST_ONE, "host build mismatch"),
        ("26.3.0", "87", HOST_TWO, "latest formal AE native load"),
    ],
)
async def test_beta_wrong_build_and_old_native_load_are_rejected_before_writes(
    tmp_path: Path,
    version: str,
    build: str,
    instance_id: str,
    message: str,
) -> None:
    session = _FakeSession()

    async def checkpoint(kind: str, _details: dict[str, Any]) -> None:
        assert kind == "preflight-ae"
        _write_native_load(
            tmp_path / "identity",
            instance_id,
            version=version,
            build=build,
        )

    acceptance = driver.PackageAcceptance(
        _config(tmp_path, mode="t4"),
        session_factory=_FakeFactory(session),
        checkpoint=checkpoint,
        evidence=driver.EvidenceLog(
            tmp_path / "bad-load", mode="t4", expected_sha=EXPECTED_SHA
        ),
    )

    with pytest.raises(driver.AcceptanceFailure, match=message):
        await acceptance.run()
    assert not any(
        tool in driver.SUPPORT_WRITE_TOOLS or tool in driver.WRITE_TOOLS
        for tool, _arguments in session.calls
    )
    assert acceptance.aep_lifecycle == driver.AepLifecycleCounters()


@pytest.mark.asyncio
async def test_existing_fixture_path_fails_before_checkpoint_or_public_call(
    tmp_path: Path,
) -> None:
    session = _FakeSession()
    config = _config(tmp_path, mode="t4")
    config.fixture_path.parent.mkdir(parents=True)
    config.fixture_path.write_bytes(b"user data")
    checkpoints: list[str] = []
    acceptance = driver.PackageAcceptance(
        config,
        session_factory=_FakeFactory(session),
        checkpoint=lambda kind, _details: checkpoints.append(kind),
        evidence=driver.EvidenceLog(
            tmp_path / "existing", mode="t4", expected_sha=EXPECTED_SHA
        ),
    )
    with pytest.raises(driver.AcceptanceFailure, match="already exists"):
        await acceptance.run()
    assert config.fixture_path.read_bytes() == b"user data"
    assert checkpoints == [] and session.calls == []

    config.fixture_path.unlink()
    if os.name != "nt":
        config.fixture_path.symlink_to(tmp_path / "missing-target.aep")
        with pytest.raises(driver.AcceptanceFailure, match="already exists"):
            await acceptance.run()
        assert config.fixture_path.is_symlink()


@pytest.mark.asyncio
async def test_possibly_side_effecting_write_stops_without_retry(tmp_path: Path) -> None:
    class AmbiguousSession:
        tool_names = frozenset(driver.PACKAGE_TOOLS)
        calls = 0

        async def call(self, _tool: str, _arguments: dict[str, Any]):
            self.calls += 1
            return True, {
                "ok": False,
                "error": {
                    "code": "POSSIBLY_SIDE_EFFECTING_FAILURE",
                    "sideEffect": "may-have-occurred",
                },
            }

    session = AmbiguousSession()
    acceptance = driver.PackageAcceptance(
        _config(tmp_path, mode="t5"),
        session_factory=_FakeFactory(session),
        checkpoint=lambda *_args: None,
        evidence=driver.EvidenceLog(
            tmp_path / "ambiguous", mode="t5", expected_sha=EXPECTED_SHA
        ),
    )
    acceptance._validate_machine_identity()
    with pytest.raises(driver.PossiblySideEffectingStop):
        await acceptance._call(
            session,
            "ae_renameLayer",
            {
                "layer_locator": {"synthetic": True},
                "name": "do not retry",
                "idempotency_key": "issue155:ambiguous:test",
            },
        )
    assert session.calls == 1


def test_layer_details_exact_shapes_and_contract_fixture_fail_closed(
    tmp_path: Path,
) -> None:
    session = _FakeSession()
    comp = {"id": _uuid(10), "name": "Fixture", "layers": []}
    layer = {
        "id": _uuid(11),
        "name": "Layer",
        "type": "av",
        "parent": None,
        "source": _uuid(12),
        "inPoint": _time(0),
        "duration": _time(24),
        "startTime": _time(-12),
        "stretch": _ratio(-3, 2),
    }
    comp["layers"].append(layer)
    details = session._layer_details(comp, layer)
    assert driver._layer_details(details) == details
    malformed = dict(details)
    malformed["unexpected"] = True
    with pytest.raises(driver.AcceptanceFailure, match="shape is not closed"):
        driver._layer_details(malformed)
    malformed = copy.deepcopy(details)
    malformed["stretch"]["rational"] = "-1.5"
    with pytest.raises(driver.AcceptanceFailure, match="not canonical"):
        driver._layer_details(malformed)

    composition_source = copy.deepcopy(details)
    composition_source["sourceItemLocator"] = session._locator(
        "composition", comp["id"]
    )
    assert driver._layer_details(composition_source) == composition_source
    invalid_source = copy.deepcopy(details)
    invalid_source["sourceItemLocator"] = session._locator("layer", layer["id"])
    with pytest.raises(driver.AcceptanceFailure, match="locator kind must be one of"):
        driver._layer_details(invalid_source)

    config = _config(tmp_path, mode="t5")
    capabilities = json.loads(config.contract_fixture.read_text(encoding="utf-8"))
    capabilities["response"]["result"]["items"] = [
        item
        for item in capabilities["response"]["result"]["items"]
        if item["id"] != "ae.layer.duplicate"
    ]
    config.contract_fixture.write_text(json.dumps(capabilities) + "\n", encoding="utf-8")
    acceptance = driver.PackageAcceptance(
        config,
        session_factory=_FakeFactory(session),
        checkpoint=lambda *_args: None,
        evidence=driver.EvidenceLog(
            tmp_path / "contract", mode="t5", expected_sha=EXPECTED_SHA
        ),
    )
    with pytest.raises(driver.AcceptanceFailure, match="omitted required IDs"):
        acceptance._validate_machine_identity()


def test_component_manifests_and_formal_ae_identity_fail_closed(
    tmp_path: Path,
) -> None:
    config = _config(tmp_path, mode="t5")
    session = _FakeSession()

    def acceptance() -> Any:
        return driver.PackageAcceptance(
            config,
            session_factory=_FakeFactory(session),
            checkpoint=lambda *_args: None,
            evidence=driver.EvidenceLog(
                tmp_path / f"identity-{len(list(tmp_path.glob('identity-*')))}",
                mode="t5",
                expected_sha=EXPECTED_SHA,
            ),
        )

    valid = acceptance()
    valid._validate_machine_identity()
    assert driver.SHA256.fullmatch(
        valid._component_hashes["runtimeManifestFileSha256"]
    )
    assert driver.SHA256.fullmatch(
        valid._component_hashes["formalAeExecutableSha256"]
    )

    native = json.loads(config.native_manifest.read_text(encoding="utf-8"))
    native["artifact"]["bundleTreeSha256"] = "not-a-sha"
    config.native_manifest.write_text(json.dumps(native) + "\n", encoding="utf-8")
    with pytest.raises(driver.AcceptanceFailure, match="full lowercase SHA-256"):
        acceptance()._validate_machine_identity()

    native["artifact"]["bundleTreeSha256"] = "b" * 64
    config.native_manifest.write_text(json.dumps(native) + "\n", encoding="utf-8")
    relative = f"0.9.2-{EXPECTED_SHA}/macos-arm64"
    record_path = (
        config.identity_home
        / ".ae-mcp/runtime"
        / relative.split("/", 1)[0]
        / "install-record.json"
    )
    record = json.loads(record_path.read_text(encoding="utf-8"))
    record["runtimeManifestSha256"] = "not-a-sha"
    record_path.write_text(json.dumps(record) + "\n", encoding="utf-8")
    with pytest.raises(driver.AcceptanceFailure, match="full lowercase SHA-256"):
        acceptance()._validate_machine_identity()

    runtime_manifest = config.identity_home / ".ae-mcp/runtime" / relative / "runtime-manifest.json"
    record["runtimeManifestSha256"] = "0" * 64
    record_path.write_text(json.dumps(record) + "\n", encoding="utf-8")
    assert hashlib.sha256(runtime_manifest.read_bytes()).hexdigest() != "0" * 64
    with pytest.raises(driver.AcceptanceFailure, match="not bound"):
        acceptance()._validate_machine_identity()

    record["runtimeManifestSha256"] = hashlib.sha256(runtime_manifest.read_bytes()).hexdigest()
    record_path.write_text(json.dumps(record) + "\n", encoding="utf-8")
    plist_path = config.formal_ae_app / "Contents/Info.plist"
    info = plistlib.loads(plist_path.read_bytes())
    info["CFBundleIdentifier"] = "com.adobe.AfterEffects.beta"
    plist_path.write_bytes(plistlib.dumps(info))
    with pytest.raises(driver.AcceptanceFailure, match="bundle identifier mismatch"):
        acceptance()._validate_machine_identity()


def test_evidence_redacts_paths_and_fixture_lifecycle_arguments_are_strict(
    tmp_path: Path,
) -> None:
    evidence = driver.EvidenceLog(
        tmp_path / "private", mode="t6", expected_sha=EXPECTED_SHA
    )
    evidence.record(
        "probe",
        {
            "pairingFingerprint": "ABCD-EFGH",
            "fixturePath": "/Users/example/Secret.aep",
            "message": "temporary /private/tmp/issue155.aep",
            "archiveRoot": tmp_path / "recovery",
            "safe": "visible",
        },
    )
    event = evidence.events_path.read_text(encoding="utf-8")
    assert "ABCD-EFGH" not in event
    assert "/Users/example" not in event
    assert "/private/tmp" not in event
    assert str(tmp_path) not in event
    assert "visible" in event

    base_args = [
        "--mode",
        "t5",
        "--expected-sha",
        EXPECTED_SHA,
        "--fixture-path",
        str(tmp_path / "active.aep"),
        "--recovery-archive-root",
        str(tmp_path / "recovery"),
        "--native-receipt",
        str(tmp_path / "receipt.json"),
        "--native-manifest",
        str(tmp_path / "manifest.json"),
        "--evidence-dir",
        str(tmp_path / "evidence"),
    ]
    parsed = driver.parse_args([*base_args, "--stretch-percent", "150"])
    assert parsed.stretch_percent == "150"
    invalid_stretches = (
        "0",
        "0.0",
        "9900.1",
        "-9901",
        "NaN",
        "Infinity",
        "1e2",
        "01",
        ".5",
        "1.0000001",
        "9899.999999",
    )
    for invalid_stretch in invalid_stretches:
        with pytest.raises(SystemExit):
            driver.parse_args(
                [*base_args, "--stretch-percent", invalid_stretch]
            )
    assert driver.parse_args(
        [*base_args, "--stretch-percent", "-9900.000000"]
    ).stretch_percent == "-9900.000000"
    assert driver.parse_args(
        [*base_args, "--stretch-percent", "2147.483647"]
    ).stretch_percent == "2147.483647"
