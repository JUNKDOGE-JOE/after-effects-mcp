#!/usr/bin/env python3
"""Run the tier-selected Composition Settings plus previewFrame acceptance plan."""

from __future__ import annotations

import asyncio
import base64
import copy
import hashlib
import io
import json
import os
from collections.abc import AsyncIterator, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import timedelta
from fractions import Fraction
from pathlib import Path
from typing import Any, Protocol

from capability_package_cli import parse_args
from capability_package_identity import IdentityConfig
from capability_package_runtime import (
    AcceptanceFailure, AcceptanceRuntime, EvidenceLog, FixturePolicy,
    PossiblySideEffectingStop, error_code, mapping, native_value, require,
    stdin_checkpoint,
)
from composition_settings_spec import (
    BRIEF_SOURCE, CONTRACTS, EVIDENCE_BY_TOOL, FIXTURE_RECIPE,
    NATIVE_CONTRACT_SOURCE, PREVIEW_HANDLER_SOURCE, SCHEMA_SOURCE, SPEC,
    T5_CALL_PLAN, T6_CALL_PLAN, T6_REPLAY_GROUNDS, T6_SKIPS,
)


@dataclass(frozen=True)
class PublicResult:
    is_error: bool
    payload: dict[str, Any]
    content: tuple[dict[str, Any], ...]
    structured_content: dict[str, Any] | None


class ImagePublicSession(Protocol):
    tool_names: frozenset[str]

    async def call(
        self, tool: str, arguments: Mapping[str, Any]
    ) -> tuple[bool, dict[str, Any]]: ...

    async def call_result(
        self, tool: str, arguments: Mapping[str, Any]
    ) -> PublicResult: ...


class _ImageSession:
    """Package-local MCP adapter retaining first-class image blocks."""

    def __init__(self, session: Any, tool_names: Sequence[str]) -> None:
        self._session = session
        self.tool_names = frozenset(tool_names)

    async def call_result(
        self, tool: str, arguments: Mapping[str, Any]
    ) -> PublicResult:
        result = await self._session.call_tool(tool, dict(arguments))
        content: list[dict[str, Any]] = []
        for item in result.content:
            kind = getattr(item, "type", None)
            if kind == "text":
                content.append({"type": "text", "text": item.text})
            elif kind == "image":
                content.append({
                    "type": "image", "data": item.data,
                    "mimeType": item.mimeType,
                    "_meta": copy.deepcopy(getattr(item, "meta", None)),
                })
            else:
                raise AcceptanceFailure(
                    f"{tool} returned unsupported MCP content type {kind!r}"
                )
        require(
            content and content[0].get("type") == "text",
            f"{tool} did not return JSON as content item 0",
        )
        try:
            payload = json.loads(content[0]["text"])
        except (TypeError, ValueError) as error:
            raise AcceptanceFailure(f"{tool} returned non-JSON text") from error
        require(isinstance(payload, dict), f"{tool} JSON payload is not an object")
        structured = getattr(result, "structuredContent", None)
        require(
            structured is None or isinstance(structured, dict),
            f"{tool} structuredContent is not an object",
        )
        return PublicResult(
            bool(result.isError), payload, tuple(content),
            copy.deepcopy(structured),
        )

    async def call(
        self, tool: str, arguments: Mapping[str, Any]
    ) -> tuple[bool, dict[str, Any]]:
        result = await self.call_result(tool, arguments)
        return result.is_error, result.payload


class CompositionSettingsSessionFactory:
    """Package-local factory because the generic runner drops image blocks."""

    def __init__(self, launcher: Path, *, client_name: str, home: Path) -> None:
        self.launcher = launcher
        self.client_name = client_name
        self.home = home

    @asynccontextmanager
    async def __call__(self) -> AsyncIterator[ImagePublicSession]:
        try:
            from mcp import ClientSession, StdioServerParameters
            from mcp.client.stdio import stdio_client
            from mcp.types import Implementation
        except ImportError as error:  # pragma: no cover
            raise AcceptanceFailure("hardware runner requires mcp") from error
        require(self.launcher.is_file(), "stable ae-mcp launcher is missing")
        environment = {
            "AE_MCP_BACKEND": "ae-mcp",
            "AE_MCP_PLUGIN_URL": os.environ.get(
                "AE_MCP_PLUGIN_URL", "http://127.0.0.1:11488"
            ),
            "HOME": str(self.home),
            "LANG": os.environ.get("LANG", "en_US.UTF-8"),
            "PATH": "/usr/bin:/bin",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONUNBUFFERED": "1",
            "TMPDIR": os.environ.get("TMPDIR", "/private/tmp"),
        }
        params = StdioServerParameters(
            command=str(self.launcher), args=[], env=environment
        )
        async with stdio_client(params) as (read, write):
            async with ClientSession(
                read, write, read_timeout_seconds=timedelta(seconds=75),
                client_info=Implementation(name=self.client_name, version="1"),
            ) as session:
                await session.initialize()
                listed = await session.list_tools()
                yield _ImageSession(session, [tool.name for tool in listed.tools])


def _locator(value: Any, kind: str) -> dict[str, Any]:
    locator = mapping(value, f"{kind} locator is invalid")
    require(
        set(locator) == {
            "kind", "hostInstanceId", "sessionId", "projectId",
            "generation", "objectId",
        } and locator.get("kind") == kind,
        f"{kind} locator is not closed",
    )
    return locator


def _time(value: Any) -> Fraction:
    exact = mapping(value, "exact time is invalid")
    require(
        set(exact) == {"value", "scale", "secondsRational"}
        and type(exact.get("value")) is int
        and type(exact.get("scale")) is int
        and exact["scale"] > 0,
        "exact time shape drifted",
    )
    result = Fraction(exact["value"], exact["scale"])
    require(exact["secondsRational"] == str(result), "time rational is not canonical")
    return result


def _ratio(value: Any) -> Fraction:
    ratio = mapping(value, "exact ratio is invalid")
    require(
        set(ratio) == {"numerator", "denominator", "rational"}
        and type(ratio.get("numerator")) is int
        and type(ratio.get("denominator")) is int
        and ratio["denominator"] > 0,
        "exact ratio shape drifted",
    )
    result = Fraction(ratio["numerator"], ratio["denominator"])
    require(ratio["rational"] == str(result), "ratio is not canonical")
    return result


def _snapshot(value: Any) -> dict[str, Any]:
    state = mapping(value, "composition settings snapshot is invalid")
    require(set(state) == {
        "name", "width", "height", "duration", "frameDuration", "frameRate",
        "pixelAspectRatio", "backgroundColor", "workArea",
        "displayStartTime", "layerCount",
    }, "composition settings snapshot is not closed")
    work = mapping(state["workArea"], "work area is invalid")
    colour = mapping(state["backgroundColor"], "background colour is invalid")
    require(set(work) == {"start", "duration"}, "work area is not closed")
    require(
        set(colour) == {"red", "green", "blue", "alpha"},
        "background colour is not closed",
    )
    frame_duration = _time(state["frameDuration"])
    frame_rate = _ratio(state["frameRate"])
    require(frame_duration * frame_rate == 1, "frame reciprocal drifted")
    return {
        "name": state["name"], "width": state["width"], "height": state["height"],
        "duration": _time(state["duration"]),
        "frameDuration": frame_duration, "frameRate": frame_rate,
        "pixelAspectRatio": _ratio(state["pixelAspectRatio"]),
        "backgroundColor": dict(colour),
        "workArea": {"start": _time(work["start"]), "duration": _time(work["duration"])},
        "displayStartTime": _time(state["displayStartTime"]),
        "layerCount": state["layerCount"],
    }


BASELINE_STATE = {
    "name": "Comp Settings Fixture", "width": 1920, "height": 1080,
    "duration": Fraction(10), "frameDuration": Fraction(1, 24),
    "frameRate": Fraction(24), "pixelAspectRatio": Fraction(1),
    "backgroundColor": {"red": 16, "green": 32, "blue": 48, "alpha": 255},
    "workArea": {"start": Fraction(2), "duration": Fraction(6)},
    "displayStartTime": Fraction(0), "layerCount": 1,
}


class CompositionSettingsPackage:
    """Package-owned executor for the frozen T5 and selective T6 plans."""

    def __init__(self, runtime: AcceptanceRuntime, *, fixture_name: str) -> None:
        require(runtime.mode in {"t5", "t6"}, "Composition Settings has no T4 plan")
        self.runtime = runtime
        self.fixture_name = fixture_name
        self.plan = T5_CALL_PLAN if runtime.mode == "t5" else T6_CALL_PLAN
        self.support = {case.tool: case for case in SPEC.support_tools}
        self.context: dict[str, Any] = {}
        self.responses: dict[str, dict[str, Any]] = {}
        self.operation_keys: dict[str, str] = {}
        self.expected_state: dict[str, Any] | None = None
        self.capture_ids: set[str] = set()

    def operation_key(self, intent: str) -> str:
        if intent not in self.operation_keys:
            self.operation_keys[intent] = self.runtime.intent(intent)
        return self.operation_keys[intent]

    def reconciliation_key(self, intent: str) -> str:
        require(intent in self.operation_keys, "cannot reconcile unknown intent")
        return self.operation_keys[intent]

    def reconciliation_record(self, intent: str) -> dict[str, str]:
        return {
            "intent": intent,
            "idempotencyKey": self.reconciliation_key(intent),
            "action": "read-state-and-audit-without-redispatch",
            "duplicateContract": "DUPLICATE_REQUEST; replayed=true is not assumed",
            "source": NATIVE_CONTRACT_SOURCE,
        }

    def _resolve(self, value: Any) -> Any:
        if isinstance(value, str) and value.startswith("$operation_key:"):
            return self.operation_key(value.split(":", 1)[1])
        if isinstance(value, str) and value.startswith("$"):
            require(value[1:] in self.context, f"address {value} was not produced")
            return copy.deepcopy(self.context[value[1:]])
        if isinstance(value, Mapping):
            return {key: self._resolve(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [self._resolve(item) for item in value]
        return value

    @staticmethod
    def _named(rows: Any, name: str, label: str) -> dict[str, Any]:
        require(isinstance(rows, list), f"{label} rows are invalid")
        matches = [
            mapping(row, f"{label} row invalid") for row in rows
            if isinstance(row, Mapping) and row.get("name") == name
        ]
        require(len(matches) == 1, f"{label} {name!r} is not unique")
        return matches[0]

    @staticmethod
    def _property(rows: Any, match_name: str) -> dict[str, Any]:
        require(isinstance(rows, list), "property rows are invalid")
        matches = [
            mapping(row, "property row invalid") for row in rows
            if isinstance(row, Mapping) and row.get("matchName") == match_name
        ]
        require(len(matches) == 1, f"property {match_name!r} is not unique")
        return matches[0]

    def _capture(self, key: str, payload: Mapping[str, Any]) -> None:
        if key.endswith("-preview"):
            return
        value = native_value(payload)
        if key == "composition-reacquire":
            item = self._named(value.get("items"), self.fixture_name, "composition")
            self.context["composition_locator"] = _locator(
                item.get("locator"), "composition"
            )
        elif "compositionLocator" in value:
            self.context["composition_locator"] = _locator(
                value.get("compositionLocator"), "composition"
            )
        if key == "timing-layers":
            layer = self._named(value.get("layers"), "Timing Witness", "layer")
            self.context["timing_layer_locator"] = _locator(
                layer.get("locator"), "layer"
            )
        elif key == "transform-group":
            self.context["timing_layer_locator"] = _locator(
                value.get("layerLocator"), "layer"
            )
            self.context["transform_property_locator"] = _locator(
                self._property(value.get("properties"), "ADBE Transform Group")
                .get("propertyLocator"), "stream"
            )
        elif key == "opacity-property":
            self.context["timing_layer_locator"] = _locator(
                value.get("layerLocator"), "layer"
            )
            self.context["opacity_property_locator"] = _locator(
                self._property(value.get("properties"), "ADBE Opacity")
                .get("propertyLocator"), "stream"
            )
        elif key == "timing-keyframes":
            self.context["opacity_property_locator"] = _locator(
                value.get("propertyLocator"), "stream"
            )

    async def _display_call(
        self, session: ImagePublicSession, arguments: Mapping[str, Any], *, phase: str
    ) -> dict[str, Any]:
        tool = "ae_setCompositionDisplayStartTime"
        expectation = CONTRACTS[tool]
        self.runtime.ledger.ensure_capacity(tool=tool)
        is_error, payload = await session.call(tool, dict(arguments))
        sequence = self.runtime.ledger.reserve(tool=tool, phase=phase)
        self.runtime.evidence.record("public-tool-request", {
            "call": sequence, "phase": phase, "tool": tool, "arguments": arguments,
        })
        self.runtime.evidence.record("public-tool-response", {
            "call": sequence, "phase": phase, "tool": tool,
            "isError": is_error, "payload": payload,
        })
        require(
            not is_error and error_code(payload) is None and payload.get("ok") is True,
            f"{tool} failed",
        )
        implementation = mapping(payload.get("implementation"), "implementation absent")
        provenance = mapping(payload.get("provenance"), "provenance absent")
        audit = mapping(payload.get("audit"), "audit absent")
        evidence = mapping(payload.get("evidence"), "evidence absent")
        postcondition = mapping(evidence.get("postcondition"), "postcondition absent")
        undo = mapping(evidence.get("undo"), "Undo evidence absent")
        require(
            implementation.get("engine") == "native-aegp"
            and implementation.get("capabilityId") == expectation.capability_id
            and implementation.get("capabilityVersion") == 1
            and implementation.get("contractDigest") == expectation.contract_digest
            and implementation.get("undo") == "none",
            "display-start implementation drifted",
        )
        require(
            undo == {"available": False, "verified": False}
            and "groupId" not in undo
            and audit.get("undoAvailable") is False
            and audit.get("undoVerified") is False,
            "display-start opened or claimed an Undo group",
        )
        require(
            payload.get("replayed") is False
            and audit.get("effect") == evidence.get("effect") == "committed"
            and audit.get("idempotencyKey") == arguments["idempotency_key"]
            and audit.get("requestId") == evidence.get("requestId")
            and audit.get("contractDigest") == expectation.contract_digest
            and postcondition.get("verified") is True
            and postcondition.get("algorithm") == "sha256-rfc8785-jcs-v1"
            and postcondition.get("digest") == audit.get("postconditionDigest"),
            "display-start audit/postcondition drifted",
        )
        require(
            provenance.get("engine") == "native-aegp"
            and provenance.get("hostInstanceId") == evidence.get("hostInstanceId")
            and provenance.get("sessionId") == evidence.get("sessionId"),
            "display-start provenance drifted",
        )
        row = self.runtime.matrix[tool]
        row["invocations"] += 1
        require(
            row["invocations"] <= SPEC.case_by_tool[tool].max_primary_calls,
            "display-start exceeded its declared call bound",
        )
        row["auditRequestIds"].append(audit["requestId"])
        row["undo"].update({
            "required": False, "executed": 0, "verified": False,
            "model": "compensating-public-write", "groupOpened": False,
        })
        return payload

    async def _native_call(
        self, session: ImagePublicSession, tool: str,
        arguments: Mapping[str, Any], *, phase: str
    ) -> dict[str, Any]:
        if tool == "ae_setCompositionDisplayStartTime":
            return await self._display_call(session, arguments, phase=phase)
        expectation = CONTRACTS.get(tool)
        case = SPEC.case_by_tool.get(tool) or self.support[tool]
        return await self.runtime.call(
            session, tool, arguments,
            capability_id=(
                expectation.capability_id if expectation else case.capability_id
            ),
            write=case.kind == "write", phase=phase,
            expected_replayed=False if case.kind == "write" else None,
        )

    def _latest_audit(self) -> str:
        for payload in reversed(tuple(self.responses.values())):
            audit = payload.get("audit")
            if isinstance(audit, Mapping) and isinstance(audit.get("requestId"), str):
                return audit["requestId"]
        raise AcceptanceFailure("preview has no preceding settings audit")

    async def _preview_call(
        self, session: ImagePublicSession, arguments: Mapping[str, Any], *, phase: str
    ) -> dict[str, Any]:
        tool = "ae_previewFrame"
        self.runtime.ledger.ensure_capacity(tool=tool)
        result = await session.call_result(tool, dict(arguments))
        sequence = self.runtime.ledger.reserve(tool=tool, phase=phase)
        self.runtime.evidence.record("public-tool-request", {
            "call": sequence, "phase": phase, "tool": tool,
            "arguments": arguments, "source": SCHEMA_SOURCE,
        })
        self.runtime.evidence.record("public-tool-response", {
            "call": sequence, "phase": phase, "tool": tool,
            "isError": result.is_error, "content": result.content,
            "structuredContent": result.structured_content,
            "source": PREVIEW_HANDLER_SOURCE,
        })
        payload = result.payload
        require(not result.is_error and payload.get("ok") is True, "preview failed")
        require(
            result.structured_content == payload
            and json.loads(result.content[0]["text"]) == payload,
            "preview text/structured result drifted",
        )
        frames = payload.get("frames")
        require(
            isinstance(frames, list) and len(frames) == len(result.content) - 1 == 1,
            "preview image count drifted",
        )
        capture_id = payload.get("captureId")
        require(
            isinstance(capture_id, str) and len(capture_id) == 32
            and capture_id not in self.capture_ids,
            "preview captureId is stale",
        )
        self.capture_ids.add(capture_id)
        require(payload.get("compName") == self.fixture_name, "wrong comp previewed")
        expected = mapping(self.expected_state, "preview expected state absent")
        background_rgb = tuple(
            expected["backgroundColor"][key] for key in ("red", "green", "blue")
        )
        setting_alpha = expected["backgroundColor"]["alpha"]
        verified = []
        for index, frame_value in enumerate(frames):
            frame = mapping(frame_value, "frame metadata invalid")
            block = mapping(result.content[index + 1], "image block invalid")
            require(
                block.get("type") == "image"
                and block.get("mimeType") == "image/png"
                and frame.get("source") == "comp"
                and frame.get("method") == "saveFrameToPng"
                and "base64" not in frame,
                "preview did not use first-class comp PNG",
            )
            try:
                png = base64.b64decode(block.get("data"), validate=True)
            except (TypeError, ValueError) as error:
                raise AcceptanceFailure("preview base64 invalid") from error
            require(png.startswith(b"\x89PNG\r\n\x1a\n"), "preview is not PNG")
            from PIL import Image
            with Image.open(io.BytesIO(png)) as image:
                image.load()
                require(image.format == "PNG", "preview decode is not PNG")
                dimensions = image.size
                rgb_matches = 0
                transparent_rgb_matches = 0
                matching_rgb_alpha_counts: dict[str, int] = {}
                for pixel in image.convert("RGBA").get_flattened_data():
                    if pixel[:3] != background_rgb:
                        continue
                    rgb_matches += 1
                    alpha_key = str(pixel[3])
                    matching_rgb_alpha_counts[alpha_key] = (
                        matching_rgb_alpha_counts.get(alpha_key, 0) + 1
                    )
                    if pixel[3] == 0:
                        transparent_rgb_matches += 1
            digest = hashlib.sha256(png).hexdigest()
            require(
                dimensions == (expected["width"], expected["height"])
                == (frame.get("width"), frame.get("height")),
                "preview dimensions drifted",
            )
            require(digest == frame.get("sha256"), "preview SHA drifted")
            require(rgb_matches > 0, "preview lacks expected background RGB")
            require(
                setting_alpha == 255 and transparent_rgb_matches > 0,
                "preview lacks expected transparent background pixels",
            )
            verified.append({
                "captureId": capture_id, "requestedTime": arguments.get("time"),
                "dimensions": dimensions, "sha256": digest,
                "source": frame.get("source"), "method": frame.get("method"),
                "matchingBackgroundRgbPixels": rgb_matches,
                "matchingBackgroundRgbAlphaCounts": matching_rgb_alpha_counts,
                "alphaDivergence": {
                    "status": "observed-expected",
                    "typedSettingAlpha": setting_alpha,
                    "uncoveredRenderedAlpha": 0,
                    "transparentMatchingRgbPixels": transparent_rgb_matches,
                    "semantic": (
                        "AE paints the composition background RGB in its viewport "
                        "without compositing it into exported alpha."
                    ),
                },
                "precedingSettingsAuditRequestId": self._latest_audit(),
                "evidenceLimits": EVIDENCE_BY_TOOL[tool],
            })
        self.runtime.evidence.record("preview-image-verification", {
            "call": sequence, "frames": verified, "source": BRIEF_SOURCE,
        })
        row = self.runtime.matrix[tool]
        row["invocations"] += 1
        require(
            row["invocations"] <= SPEC.case_by_tool[tool].max_primary_calls,
            "preview exceeded its declared call bound",
        )
        row["auditRequestIds"].append(capture_id)
        return payload

    async def _call(
        self, session: ImagePublicSession, tool: str,
        arguments: Mapping[str, Any], *, phase: str
    ) -> dict[str, Any]:
        if tool == "ae_previewFrame":
            return await self._preview_call(session, arguments, phase=phase)
        return await self._native_call(session, tool, arguments, phase=phase)

    def _write_transition(self, row: Any, payload: Mapping[str, Any]) -> None:
        value = native_value(payload)
        require(value.get("changed") is True, f"{row.key} did not change")
        before, after = _snapshot(value.get("before")), _snapshot(value.get("after"))
        require(before == self.expected_state, f"{row.key} before drifted")
        expected = copy.deepcopy(before)
        arguments = self._resolve(row.arguments)
        if row.tool == "ae_setCompositionDisplayStartTime":
            target = arguments["display_start_time"]
            expected["displayStartTime"] = Fraction(target["value"], target["scale"])
        elif row.tool == "ae_setCompositionFrameRate":
            target = arguments["frame_rate"]
            expected["frameRate"] = Fraction(target["numerator"], target["denominator"])
            expected["frameDuration"] = 1 / expected["frameRate"]
        elif row.tool == "ae_setCompositionDuration":
            target = arguments["duration"]
            expected["duration"] = Fraction(target["value"], target["scale"])
        elif row.tool == "ae_setCompositionDimensions":
            expected.update(width=arguments["width"], height=arguments["height"])
        elif row.tool == "ae_setCompositionPixelAspectRatio":
            target = arguments["pixel_aspect_ratio"]
            expected["pixelAspectRatio"] = Fraction(
                target["numerator"], target["denominator"]
            )
        elif row.tool == "ae_setCompositionBackgroundColor":
            expected["backgroundColor"] = copy.deepcopy(arguments["background_color"])
        require(after == expected, f"{row.key} after drifted")
        if row.tool == "ae_setCompositionPixelAspectRatio":
            require(
                Fraction(after["width"], after["height"])
                * after["pixelAspectRatio"] == Fraction(16, 9),
                "effective display aspect is not 16:9",
            )
        self.expected_state = expected

    def _assert_state(self, row: Any, payload: Mapping[str, Any]) -> None:
        if row.tool == "ae_previewFrame":
            return
        value = native_value(payload)
        if row.key == "composition-reacquire":
            item = self._named(value.get("items"), self.fixture_name, "composition")
            require(item.get("type") == "composition", "fixture is not a comp")
        elif row.tool.startswith("ae_setComposition"):
            self._write_transition(row, payload)
        elif row.tool == "ae_getCompositionSettings":
            state_value = dict(value)
            state_value.pop("compositionLocator", None)
            state = _snapshot(state_value)
            if row.key == "baseline-settings":
                require(state == BASELINE_STATE, "fixture baseline drifted")
                self.expected_state = copy.deepcopy(BASELINE_STATE)
            else:
                require(state == self.expected_state, f"{row.key} drifted")
        elif row.key == "timing-layers":
            require(
                value.get("total") == 1
                and [item.get("name") for item in value.get("layers", [])]
                == ["Timing Witness"],
                "fixture layer recipe drifted",
            )
        elif row.key == "timing-keyframes":
            frames = value.get("keyframes")
            require(
                value.get("total") == 3 and isinstance(frames, list)
                and len(frames) == 3,
                "fixture keyframe count drifted",
            )
            actual = [
                Fraction(frame["time"]["value"], frame["time"]["scale"])
                for frame in frames
            ]
            require(actual == [1, 4, 7], "display start moved keyframe times")

    async def _undo(self, write_key: str) -> None:
        payload = self.responses[write_key]
        implementation = mapping(payload.get("implementation"), "implementation absent")
        undo = mapping(
            mapping(payload.get("evidence"), "evidence absent").get("undo"),
            "Undo evidence absent",
        )
        require(
            implementation.get("undo") == "ae-undo-group"
            and undo == {"available": True, "verified": False},
            f"{write_key} is not one Undo group",
        )
        await self.runtime.checkpoint(f"undo-{write_key}", {
            "instruction": (
                "Refresh Edit, verify the expected ae-mcp composition-setting "
                "Undo label, execute exactly one real Undo, refresh, and verify "
                "the label changed."
            ),
            "fixturePath": self.runtime.fixture.path,
            "activeFixtureCount": 1, "saveAsCopies": 0, "source": BRIEF_SOURCE,
        })
        self.expected_state = _snapshot(native_value(payload)["before"])

    def _record_t6_reduction(self) -> None:
        if self.runtime.mode != "t6":
            return
        for tool, skip in T6_SKIPS.items():
            row = self.runtime.matrix[tool]
            row["status"], row["t6Skip"] = "skipped-t6", copy.deepcopy(skip)
            row["undo"].update(required=False, coveredBy=skip["replayedBy"])
        self.runtime.evidence.record("t6-plan-reduction", {
            "calls": len(self.plan), "skips": T6_SKIPS,
            "replayGrounds": T6_REPLAY_GROUNDS,
            "source": "docs/CAPABILITY_PACKAGE_WORKFLOW.md:151-179",
        })

    async def _execute_rows(
        self, session: ImagePublicSession, rows: Sequence[Any]
    ) -> None:
        for row in rows:
            if row.undo_of is not None:
                await self._undo(row.undo_of)
            payload = await self._call(
                session, row.tool, self._resolve(row.arguments),
                phase=f"{self.runtime.mode}-{row.key}",
            )
            self.responses[row.key] = payload
            self._assert_state(row, payload)
            self._capture(row.key, payload)
            if row.tool in CONTRACTS:
                self.runtime.mark_tool_passed(row.tool)
            if row.undo_of is not None:
                write_tool = next(
                    candidate.tool for candidate in self.plan
                    if candidate.key == row.undo_of
                )
                self.runtime.mark_tool_passed(
                    write_tool, undo_executed=True, undo_verified=True
                )
            if row.restore_method is not None:
                require(
                    row.restore_method == "compensating-public-write"
                    and row.tool == "ae_setCompositionDisplayStartTime",
                    "restore method drifted",
                )
                self.runtime.evidence.record("compensating-write-verified", {
                    "write": row.key, "restoreMethod": row.restore_method,
                    "undoAvailable": False, "undoVerified": False,
                    "undoGroupOpened": False,
                    "postcondition": "independently-verified-full-snapshot",
                    "source": BRIEF_SOURCE,
                })

    async def run(self) -> dict[str, Any]:
        required_native = tuple(
            expectation.capability_id for expectation in CONTRACTS.values()
            if expectation.engine == "native-aegp"
        ) + tuple(case.capability_id for case in SPEC.support_tools)
        self.runtime.validate_machine_identity(
            required_capability_ids=tuple(dict.fromkeys(required_native))
        )
        self.runtime.require_fixture_absent()
        await self.runtime.checkpoint("prepare-composition-settings-fixture", {
            "recipe": FIXTURE_RECIPE,
            "formalAeApp": self.runtime.identity.formal_ae_app,
            "fixturePath": self.runtime.fixture.path,
            "fixtureLifecycle": "ephemeral-validation",
            "activeFixtureCount": 1, "saveAsCopies": 0,
            "candidateRun": True, "candidateEvidence": False,
            "source": BRIEF_SOURCE,
        })
        require(os.path.isfile(self.runtime.fixture.path), "prepared fixture missing")
        self.runtime.mark_fixture_created()
        first = self.runtime.bind_latest_native_load(stage="initial")
        self._record_t6_reduction()
        required = [case.tool for case in (*SPEC.tools, *SPEC.support_tools)]
        async with self.runtime.session_factory() as session:
            self.runtime.require_tools(session, required)
            await self._execute_rows(session, self.plan)
        require(
            self.runtime.ledger.total == len(self.plan)
            and self.runtime.ledger.hard_limit == len(self.plan),
            "plan call count/fence drifted",
        )
        display = self.runtime.matrix["ae_setCompositionDisplayStartTime"]["undo"]
        require(
            display["groupOpened"] is False and display["executed"] == 0
            and display["verified"] is False,
            "display start incorrectly claimed real Undo",
        )
        archived = await self.runtime.archive_fixture()
        return {
            "selectedPlan": self.runtime.mode, "selectedPlanCalls": len(self.plan),
            "t6SkippedTools": T6_SKIPS if self.runtime.mode == "t6" else {},
            "t6ReplayGrounds": T6_REPLAY_GROUNDS if self.runtime.mode == "t6" else {},
            "firstHostInstanceId": first, "componentIdentitySessions": 1,
            "operationKeyCount": len(self.operation_keys),
            "reconciliationReusesOriginalKey": True,
            "duplicateRequestContract": "DUPLICATE_REQUEST; replayed=true is not assumed",
            "fixtureRecipe": FIXTURE_RECIPE, "archived": archived,
        }


def _leaf(error: BaseException, leaf_type: type) -> BaseException | None:
    if isinstance(error, leaf_type):
        return error
    for child in getattr(error, "exceptions", ()):
        found = _leaf(child, leaf_type)
        if found is not None:
            return found
    return None


async def _run(arguments: Any) -> int:
    require(arguments.mode in {"t5", "t6"}, "only T5/T6 plans are exposed")
    identity = IdentityConfig(
        expected_sha=arguments.expected_sha,
        native_receipt=arguments.native_receipt,
        native_manifest=arguments.native_manifest,
        capabilities_fixture=arguments.contract_fixture,
        formal_ae_app=arguments.formal_ae_app,
        identity_home=arguments.identity_home,
    )
    fixture = FixturePolicy(
        path=arguments.fixture_path, recovery_root=arguments.recovery_archive_root,
        fixture_id=arguments.fixture_name,
    )
    evidence = EvidenceLog(
        arguments.evidence_dir, spec=SPEC, mode=arguments.mode,
        expected_sha=arguments.expected_sha,
    )
    runtime = AcceptanceRuntime(
        spec=SPEC, mode=arguments.mode, identity=identity, fixture=fixture,
        session_factory=CompositionSettingsSessionFactory(
            arguments.launcher, client_name="composition-settings-acceptance",
            home=arguments.identity_home,
        ),
        checkpoint=stdin_checkpoint, evidence=evidence,
    )
    package = CompositionSettingsPackage(runtime, fixture_name=arguments.fixture_name)
    passed, details = False, {}
    try:
        details = await package.run()
        passed = True
        return 0
    except PossiblySideEffectingStop as error:
        details = {
            "stopReason": "possibly-side-effecting", "message": str(error),
            "reconciliation": [
                package.reconciliation_record(intent)
                for intent in package.operation_keys
            ],
        }
        return 3
    except AcceptanceFailure as error:
        details = {"failure": str(error)}
        return 2
    except BaseException as error:  # noqa: BLE001
        uncertain = _leaf(error, PossiblySideEffectingStop)
        if uncertain is None:
            raise
        details = {"stopReason": "possibly-side-effecting", "message": str(uncertain)}
        return 3
    finally:
        if not passed:
            recovered = runtime.recover_zero_call_fixture()
            if recovered is not None:
                details = {**details, "zeroCallFixtureRecovery": recovered}
        evidence.finish(
            passed=passed,
            details={
                **details, "componentSignals": runtime.component_signals,
                "sourceRevisions": runtime.source_revisions,
                "contractDigests": runtime.contract_digests,
                "formalAeIdentity": runtime.formal_ae_identity,
            },
            ledger=runtime.ledger, matrix=runtime.matrix,
            aep_lifecycle=runtime.aep_lifecycle,
        )
        print(json.dumps({
            "event": "PASS" if passed else "FAIL", "mode": arguments.mode,
            "candidateRun": True,
            "candidateEvidence": evidence.candidate_evidence,
            "publicCalls": runtime.ledger.total,
            "summarySha256": hashlib.sha256(
                evidence.summary_path.read_bytes()
            ).hexdigest(),
        }, separators=(",", ":")), flush=True)


def main(argv: Sequence[str] | None = None) -> int:
    return asyncio.run(_run(parse_args(
        argv, fixture_default="Comp Settings Fixture"
    )))


if __name__ == "__main__":
    raise SystemExit(main())
