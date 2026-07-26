#!/usr/bin/env python3
"""Run the frozen tier-selected Text, Shape, and Marker acceptance plan."""

from __future__ import annotations

import copy
import json
import os
import stat
from collections.abc import Mapping, Sequence
from math import gcd
from pathlib import Path
from typing import Any

from capability_package_cli import run_cli
from capability_package_runtime import (
    AcceptanceFailure,
    AcceptanceRuntime,
    PublicSession,
    mapping,
    native_value,
    require,
)
from text_shape_marker_spec import (
    CALL_CEILING_AUTHORIZATION,
    CALL_PLAN,
    CONTRACTS,
    FIXTURE_RECIPE,
    MARKER_VALUE,
    PREFLIGHT_CALL_PLAN,
    REOPEN_PROCEDURE,
    SPEC,
    T4_CALL_PLAN,
    T5_CALL_PLAN,
    T6_CALL_PLAN,
    T6_REPLAY_GROUNDS,
    T6_SKIPS,
    T6_UNDO_MODELS,
)


def _locator(value: Any, kind: str) -> dict[str, Any]:
    locator = mapping(value, f"{kind} locator is invalid")
    require(locator.get("kind") == kind, f"expected {kind} locator")
    require(
        set(locator)
        == {
            "kind",
            "hostInstanceId",
            "sessionId",
            "projectId",
            "generation",
            "objectId",
        },
        f"{kind} locator is not closed",
    )
    return locator


def _semantic(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {
            key: _semantic(item)
            for key, item in value.items()
            if key not in {"layerLocator", "compositionLocator"}
        }
    if isinstance(value, list):
        return [_semantic(item) for item in value]
    return value


def _marker_target(value: Any) -> dict[str, Any]:
    target = mapping(value, "marker target is invalid")
    if target.get("kind") == "layer":
        locator = target.get("layerLocator", target.get("layer_locator"))
        return {"kind": "layer", "layer_locator": _locator(locator, "layer")}
    locator = target.get("compositionLocator", target.get("composition_locator"))
    return {
        "kind": "composition",
        "composition_locator": _locator(locator, "composition"),
    }


def _exact_time_matches(
    value: Any,
    expected_seconds_rational: str,
) -> bool:
    if not isinstance(value, Mapping) or set(value) != {
        "value",
        "scale",
        "secondsRational",
    }:
        return False
    numerator = value.get("value")
    scale = value.get("scale")
    if (
        not isinstance(numerator, int)
        or isinstance(numerator, bool)
        or not isinstance(scale, int)
        or isinstance(scale, bool)
        or scale <= 0
    ):
        return False
    divisor = gcd(abs(numerator), scale)
    reduced_numerator = numerator // divisor
    reduced_scale = scale // divisor
    canonical = (
        str(reduced_numerator)
        if reduced_scale == 1
        else f"{reduced_numerator}/{reduced_scale}"
    )
    return (
        value.get("secondsRational")
        == canonical
        == expected_seconds_rational
    )


def _marker_ref(value: Any) -> dict[str, Any]:
    ref = mapping(value, "marker ref is invalid")
    return {
        "target": _marker_target(ref.get("target")),
        "time": mapping(ref.get("time"), "marker time is invalid"),
    }


class TextShapeMarkerPackage:
    """Package-owned executor; the shared runtime remains package-neutral."""

    def __init__(self, runtime: AcceptanceRuntime, *, fixture_name: str) -> None:
        self.runtime = runtime
        self.fixture_name = fixture_name
        self.support = {case.tool: case for case in SPEC.support_tools}
        self.operation_keys: dict[str, str] = {}
        self.context: dict[str, Any] = {}
        self.responses: dict[str, dict[str, Any]] = {}
        self.plan = {
            "preflight": PREFLIGHT_CALL_PLAN,
            "t4": T4_CALL_PLAN,
            "t5": T5_CALL_PLAN,
            "t6": T6_CALL_PLAN,
        }[self.runtime.mode]
        self.session_stage = ""
        self.session_component_identities: dict[str, dict[str, Any]] = {}

    def _record_component_identity(
        self, tool: str, payload: Mapping[str, Any]
    ) -> None:
        """Record invariant identity once, then only observed per-tool deltas."""

        require(bool(self.session_stage), "component identity session is not bound")
        provenance = payload.get("provenance")
        observed = (
            {
                key: provenance[key]
                for key in (
                    "selectedWireVersion",
                    "pluginVersion",
                    "compiledSdkVersion",
                    "hostInstanceId",
                    "sessionId",
                    "capabilitiesDigest",
                    "sourceCommit",
                )
                if isinstance(provenance, Mapping) and key in provenance
            }
            if isinstance(provenance, Mapping)
            else {}
        )
        baseline = self.session_component_identities.get(self.session_stage)
        if baseline is None:
            baseline = {
                "componentSignals": copy.deepcopy(self.runtime.component_signals),
                "sourceRevisions": copy.deepcopy(self.runtime.source_revisions),
                "formalAeIdentity": copy.deepcopy(self.runtime.formal_ae_identity),
                "nativeResponseIdentity": observed,
            }
            self.session_component_identities[self.session_stage] = baseline
            self.runtime.evidence.record(
                "component-identity-session",
                {"stage": self.session_stage, "identity": baseline},
            )
        native_baseline = baseline["nativeResponseIdentity"]
        delta = {
            key: value
            for key, value in observed.items()
            if key in native_baseline and native_baseline[key] != value
        }
        self.runtime.evidence.record(
            "tool-component-identity-delta",
            {
                "stage": self.session_stage,
                "tool": tool,
                "delta": delta,
            },
        )

    def _record_t6_reduction(self) -> None:
        if self.runtime.mode != "t6":
            return
        for tool, skip in T6_SKIPS.items():
            row = self.runtime.matrix[tool]
            row["status"] = "skipped-t6"
            row["t6Skip"] = copy.deepcopy(skip)
        representatives = {
            model: contract["representative"]
            for model, contract in T6_UNDO_MODELS.items()
        }
        for model, contract in T6_UNDO_MODELS.items():
            representative_tool = next(
                row.tool
                for row in self.plan
                if row.key == contract["representative"]
            )
            for tool in contract["tools"]:
                undo = self.runtime.matrix[tool]["undo"]
                undo["model"] = model
                undo["required"] = tool == representative_tool
                undo["coveredBy"] = representative_tool
        self.runtime.evidence.record(
            "t6-plan-reduction",
            {
                "calls": len(self.plan),
                "skips": T6_SKIPS,
                "replayGrounds": T6_REPLAY_GROUNDS,
                "undoRepresentatives": representatives,
            },
        )

    def operation_key(self, intent: str) -> str:
        """Mint once per evidence session; reconciliation reuses this exact key."""

        if intent not in self.operation_keys:
            self.operation_keys[intent] = self.runtime.intent(intent)
        return self.operation_keys[intent]

    def _resolve(self, value: Any) -> Any:
        if isinstance(value, str) and value.startswith("$operation_key:"):
            return self.operation_key(value.split(":", 1)[1])
        if isinstance(value, str) and value.startswith("$"):
            key = value[1:]
            require(key in self.context, f"plan address {value} was not produced")
            return copy.deepcopy(self.context[key])
        if isinstance(value, Mapping):
            return {key: self._resolve(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [self._resolve(item) for item in value]
        return value

    async def _text_call(
        self,
        session: PublicSession,
        tool: str,
        arguments: Mapping[str, Any],
        *,
        phase: str,
    ) -> dict[str, Any]:
        expectation = CONTRACTS[tool]
        case = SPEC.case_by_tool[tool]
        self.runtime.ledger.ensure_capacity(tool=tool)
        is_error, payload = await session.call(tool, dict(arguments))
        sequence = self.runtime.ledger.reserve(tool=tool, phase=phase)
        self.runtime.evidence.record(
            "public-tool-request",
            {"call": sequence, "phase": phase, "tool": tool, "arguments": arguments},
        )
        self.runtime.evidence.record(
            "public-tool-response",
            {
                "call": sequence,
                "phase": phase,
                "tool": tool,
                "isError": is_error,
                "payload": payload,
            },
        )
        require(not is_error and payload.get("ok") is True, f"{tool} failed")
        implementation = mapping(
            payload.get("implementation"), f"{tool} omitted implementation"
        )
        provenance = mapping(payload.get("provenance"), f"{tool} omitted provenance")
        audit = mapping(payload.get("audit"), f"{tool} omitted audit")
        evidence = mapping(payload.get("evidence"), f"{tool} omitted evidence")
        postcondition = mapping(
            evidence.get("postcondition"), f"{tool} omitted postcondition"
        )
        require(
            implementation.get("engine") == "maintained-jsx"
            and implementation.get("contractId") == expectation.contract_id
            and implementation.get("contractDigest") == expectation.contract_digest
            and implementation.get("templateId") == expectation.template_id
            and implementation.get("templateDigest") == expectation.template_digest
            and implementation.get("callerCodeAccepted") is False,
            f"{tool} maintained contract drifted",
        )
        require(
            provenance.get("engine") == "maintained-jsx"
            and provenance.get("templateId") == expectation.template_id
            and provenance.get("templateDigest") == expectation.template_digest
            and not any(
                key in provenance
                for key in (
                    "selectedWireVersion",
                    "pluginVersion",
                    "compiledSdkVersion",
                    "hostInstanceId",
                    "sessionId",
                    "capabilitiesDigest",
                )
            ),
            f"{tool} unexpectedly reported native provenance",
        )
        require(
            audit.get("contractDigest") == expectation.contract_digest
            and audit.get("effect")
            == ("committed" if expectation.kind == "write" else "none")
            and postcondition.get("verified") is True
            and postcondition.get("digest") == audit.get("postconditionDigest"),
            f"{tool} audit/postcondition mismatch",
        )
        if expectation.kind == "write":
            require(
                payload.get("replayed") is False
                and audit.get("undoAvailable") is True
                and audit.get("undoVerified") is False
                and mapping(evidence.get("undo"), f"{tool} omitted Undo")
                == {
                    "available": True,
                    "verified": False,
                    "groupId": evidence["undo"]["groupId"],
                },
                f"{tool} write/Undo contract mismatch",
            )
        row = self.runtime.matrix[tool]
        row["invocations"] += 1
        require(
            row["invocations"] <= case.max_primary_calls,
            f"{tool} exceeded its declared primary-call bound",
        )
        request_id = audit.get("requestId")
        require(isinstance(request_id, str) and request_id, f"{tool} requestId invalid")
        row["auditRequestIds"].append(request_id)
        return payload

    async def _call(
        self,
        session: PublicSession,
        tool: str,
        arguments: Mapping[str, Any],
        *,
        phase: str,
    ) -> dict[str, Any]:
        if tool in CONTRACTS and CONTRACTS[tool].engine == "maintained-jsx":
            payload = await self._text_call(
                session, tool, arguments, phase=phase
            )
        else:
            expectation = CONTRACTS.get(tool)
            case = SPEC.case_by_tool.get(tool) or self.support[tool]
            capability_id = (
                expectation.contract_id
                if expectation is not None
                else case.capability_id
            )
            payload = await self.runtime.call(
                session,
                tool,
                arguments,
                capability_id=capability_id,
                write=case.kind == "write",
                phase=phase,
                expected_replayed=False if case.kind == "write" else None,
            )
        self._record_component_identity(tool, payload)
        return payload

    def _named(self, rows: Any, name: str, label: str) -> dict[str, Any]:
        require(isinstance(rows, list), f"{label} rows are invalid")
        matches = [
            mapping(row, f"{label} row is invalid")
            for row in rows
            if isinstance(row, Mapping) and row.get("name") == name
        ]
        require(len(matches) == 1, f"{label} {name!r} is not unique")
        return matches[0]

    def _capture(self, key: str, payload: Mapping[str, Any]) -> None:
        value = native_value(payload)
        if key == "composition-create":
            self.context["composition_locator"] = _locator(
                value.get("compositionLocator"), "composition"
            )
        elif key == "composition-reacquire":
            item = self._named(value.get("items"), self.fixture_name, "composition")
            self.context["composition_locator"] = _locator(
                item.get("locator"), "composition"
            )
        elif key == "fonts":
            fonts = value.get("fonts")
            require(isinstance(fonts, list) and fonts, "font inventory is empty")
            first = mapping(fonts[0], "font record is invalid")
            selected = first.get("postScriptName")
            require(isinstance(selected, str) and selected, "PostScript name is invalid")
            self.context["font_selection"] = {
                "preferred_postscript_name": selected,
                "fallback_postscript_names": [],
                "on_missing": "error",
            }
        elif key == "text-create":
            self.context["composition_locator"] = _locator(
                value.get("compositionLocator"), "composition"
            )
            after = mapping(value.get("after"), "text create omitted after")
            self.context["text_layer_locator"] = _locator(
                after.get("layerLocator"), "layer"
            )
            self.context["text_marker_target"] = {
                "kind": "layer",
                "layer_locator": copy.deepcopy(self.context["text_layer_locator"]),
            }
        elif key.startswith("text-") and "layerLocator" in value:
            self.context["text_layer_locator"] = _locator(
                value.get("layerLocator"), "layer"
            )
            self.context["text_marker_target"] = {
                "kind": "layer",
                "layer_locator": copy.deepcopy(self.context["text_layer_locator"]),
            }
        elif key == "shape-layer-create":
            self.context["composition_locator"] = _locator(
                value.get("compositionLocator"), "composition"
            )
            self.context["shape_layer_locator"] = _locator(
                value.get("layerLocator"), "layer"
            )
            self.context["shape_marker_target"] = {
                "kind": "layer",
                "layer_locator": copy.deepcopy(self.context["shape_layer_locator"]),
            }
        elif key in {"triangle-create", "curve-create"}:
            self.context["shape_layer_locator"] = _locator(
                value.get("layerLocator"), "layer"
            )
            self.context["shape_marker_target"] = {
                "kind": "layer",
                "layer_locator": copy.deepcopy(self.context["shape_layer_locator"]),
            }
        elif key in {
            "groups-before-restyle",
            "group-reorder-undo-read",
            "stroke-restyle-undo-read",
            "fill-restyle-undo-read",
            "shape-path-undo-read",
            "cross-family-shapes",
            "curve-create-undo-read",
            "triangle-create-undo-read",
        }:
            self.context["shape_layer_locator"] = _locator(
                value.get("layerLocator"), "layer"
            )
            self.context["shape_marker_target"] = {
                "kind": "layer",
                "layer_locator": copy.deepcopy(self.context["shape_layer_locator"]),
            }
            groups = value.get("groups")
            if isinstance(groups, list) and any(
                isinstance(group, Mapping) and group.get("name") == "Triangle"
                for group in groups
            ):
                triangle = self._named(groups, "Triangle", "shape group")
                self.context["triangle_ref"] = mapping(
                    triangle.get("ref"), "Triangle ref is invalid"
                )
                self.context["triangle_other_index"] = (
                    2 if self.context["triangle_ref"].get("groupIndex") == 1 else 1
                )
        elif key in {"fill-restyle", "stroke-restyle", "shape-path-set"}:
            ref = mapping(value.get("groupRef"), f"{key} groupRef is invalid")
            self.context["triangle_ref"] = ref
            self.context["shape_layer_locator"] = _locator(
                ref.get("layerLocator"), "layer"
            )
            self.context["shape_marker_target"] = {
                "kind": "layer",
                "layer_locator": copy.deepcopy(self.context["shape_layer_locator"]),
            }
        elif key == "group-reorder":
            self.context["shape_layer_locator"] = _locator(
                value.get("layerLocator"), "layer"
            )
            self.context["shape_marker_target"] = {
                "kind": "layer",
                "layer_locator": copy.deepcopy(self.context["shape_layer_locator"]),
            }
        elif key == "text-marker-create":
            after = mapping(value.get("after"), "text marker create omitted after")
            self.context["text_marker_target"] = _marker_target(
                mapping(after.get("ref"), "text marker ref invalid").get("target")
            )
        elif key == "t4-marker-create":
            after = mapping(value.get("after"), "T4 marker create omitted after")
            self.context["t4_marker_target"] = _marker_target(
                mapping(after.get("ref"), "T4 marker ref invalid").get("target")
            )
        elif key == "shape-marker-create":
            after = mapping(value.get("after"), "shape marker create omitted after")
            self.context["shape_marker_target"] = _marker_target(
                mapping(after.get("ref"), "shape marker ref invalid").get("target")
            )
        elif key == "text-marker-isolation-read":
            marker = mapping(value.get("markers")[0], "text marker is invalid")
            self.context["text_marker_ref"] = _marker_ref(marker.get("ref"))
        elif key == "shape-marker-isolation-read":
            marker = mapping(value.get("markers")[0], "shape marker is invalid")
            self.context["shape_marker_ref"] = _marker_ref(marker.get("ref"))
        elif key in {"cross-family-layers", "post-restart-family-layers"}:
            self.context["composition_locator"] = _locator(
                value.get("compositionLocator"), "composition"
            )
            self.context["text_layer_locator"] = _locator(
                self._named(value.get("layers"), "TSM Text", "layer").get("locator"),
                "layer",
            )
            self.context["shape_layer_locator"] = _locator(
                self._named(value.get("layers"), "TSM Shape", "layer").get("locator"),
                "layer",
            )
            self.context["text_marker_target"] = {
                "kind": "layer",
                "layer_locator": copy.deepcopy(self.context["text_layer_locator"]),
            }
            self.context["shape_marker_target"] = {
                "kind": "layer",
                "layer_locator": copy.deepcopy(self.context["shape_layer_locator"]),
            }
        elif key in {
            "empty-layer-baseline",
            "shape-layer-create-undo-read",
            "text-layer-create-undo-read",
            "post-restart-empty-baseline",
        }:
            self.context["composition_locator"] = _locator(
                value.get("compositionLocator"), "composition"
            )
        elif key == "post-restart-composition-reacquire":
            item = self._named(value.get("items"), self.fixture_name, "composition")
            self.context["composition_locator"] = _locator(
                item.get("locator"), "composition"
            )

    def _assert_state(self, key: str, payload: Mapping[str, Any]) -> None:
        value = native_value(payload)
        if key in {"t4-marker-empty", "t4-marker-undo-read"}:
            require(
                value.get("total") == 0 and value.get("markers") == [],
                f"{key} did not prove an empty marker stream",
            )
        elif key == "t4-marker-create":
            require(
                value.get("changed") is True
                and value.get("before") is None
                and isinstance(value.get("after"), Mapping),
                "T4 marker create did not report a committed insertion",
            )
            self._assert_t4_marker(value["after"])
        elif key == "t4-marker-readback":
            markers = value.get("markers")
            require(
                value.get("total") == 1
                and isinstance(markers, list)
                and len(markers) == 1,
                "T4 marker readback did not return exactly one marker",
            )
            self._assert_t4_marker(markers[0])
        elif key == "empty-layer-baseline":
            require(value.get("total") == 0 and value.get("layers") == [], "baseline is not empty")
            self.context["empty_baseline"] = _semantic(value)
        elif key == "text-read":
            created = native_value(self.responses["text-create"])["after"]
            require(_semantic(value) == _semantic(created), "text create readback drifted")
        elif key.endswith("-undo-read") and key.startswith("text-"):
            source = {
                "text-content-undo-read": "text-content-set",
                "text-character-undo-read": "text-character-set",
                "text-paragraph-undo-read": "text-paragraph-set",
            }.get(key)
            if source:
                before = native_value(self.responses[source])["before"]
                require(_semantic(value) == _semantic(before), f"{source} Undo drifted")
        elif key == "groups-before-restyle":
            groups = value.get("groups")
            require(
                isinstance(groups, list)
                and [group.get("name") for group in groups] == ["Triangle", "Curve"],
                "shape group order/content is invalid before restyle",
            )
        elif key == "fill-restyle":
            require(value.get("afterFill") == self._resolve(
                next(row for row in CALL_PLAN if row.key == key).arguments["fill"]
            ), "fill restyle readback mismatch")
        elif key == "stroke-restyle":
            require(value.get("afterStroke") == self._resolve(
                next(row for row in CALL_PLAN if row.key == key).arguments["stroke"]
            ), "stroke restyle readback mismatch")
        elif key in {"text-marker-isolation-read", "shape-marker-isolation-read"}:
            require(value.get("total") == 1 and len(value.get("markers", [])) == 1,
                    f"{key} did not prove target isolation")
        elif key in {
            "shape-marker-create-undo-read",
            "text-marker-create-undo-read",
        }:
            require(value.get("total") == 0 and value.get("markers") == [],
                    f"{key} did not restore empty marker stream")
        elif key == "triangle-create-undo-read":
            require(value.get("total") == 0 and value.get("groups") == [],
                    "Triangle Undo did not restore empty shape layer")
        elif key == "shape-layer-create-undo-read":
            layers = value.get("layers")
            require(
                isinstance(layers, list)
                and [layer.get("name") for layer in layers] == ["TSM Text"],
                "shape layer Undo did not leave exactly TSM Text",
            )
        elif key in {"text-layer-create-undo-read", "post-restart-empty-baseline"}:
            require(
                _semantic(value) == self.context["empty_baseline"],
                f"{key} did not equal the empty baseline",
            )
        elif key == "post-restart-family-layers":
            layers = value.get("layers")
            require(
                isinstance(layers, list)
                and {layer.get("name") for layer in layers}
                == {"TSM Text", "TSM Shape"},
                "post-restart family layers did not preserve both package targets",
            )

    def _assert_t4_marker(self, candidate: Any) -> None:
        marker = mapping(candidate, "T4 marker state is invalid")
        ref = mapping(marker.get("ref"), "T4 marker ref is invalid")
        target = _marker_target(ref.get("target"))
        expected_target = mapping(
            self.context.get("t4_marker_target"),
            "T4 marker expected target is missing",
        )
        actual_locator = mapping(
            target.get("composition_locator"),
            "T4 marker target locator is invalid",
        )
        expected_locator = mapping(
            expected_target.get("composition_locator"),
            "T4 marker expected locator is invalid",
        )
        time_value = mapping(ref.get("time"), "T4 marker time is invalid")
        duration = mapping(marker.get("duration"), "T4 marker duration is invalid")
        require(
            target.get("kind") == expected_target.get("kind") == "composition"
            and {
                key: actual_locator.get(key)
                for key in (
                    "kind",
                    "hostInstanceId",
                    "sessionId",
                    "projectId",
                    "objectId",
                )
            }
            == {
                key: expected_locator.get(key)
                for key in (
                    "kind",
                    "hostInstanceId",
                    "sessionId",
                    "projectId",
                    "objectId",
                )
            },
            "T4 marker target identity drifted",
        )
        require(
            marker.get("markerIndex") == 1,
            "T4 marker index drifted",
        )
        require(
            _exact_time_matches(time_value, "1"),
            "T4 marker exact time drifted",
        )
        require(
            _exact_time_matches(duration, "1/2"),
            "T4 marker duration drifted",
        )
        require(
            {
                "comment": marker.get("comment"),
                "chapter": marker.get("chapter"),
                "url": marker.get("url"),
                "frame_target": marker.get("frameTarget"),
                "cue_point_name": marker.get("cuePointName"),
                "cue_point_parameters": marker.get("cuePointParameters"),
                "navigation": marker.get("navigation"),
                "protected_region": marker.get("protectedRegion"),
                "label_id": marker.get("labelId"),
            }
            == {
                key: MARKER_VALUE[key]
                for key in (
                    "comment",
                    "chapter",
                    "url",
                    "frame_target",
                    "cue_point_name",
                    "cue_point_parameters",
                    "navigation",
                    "protected_region",
                    "label_id",
                )
            },
            "T4 marker complete field projection drifted",
        )

    async def _undo(self, write_key: str) -> None:
        await self.runtime.checkpoint(
            f"undo-{write_key}",
            {
                "instruction": "Execute exactly one real After Effects Undo.",
                "fixturePath": self.runtime.fixture.path,
                "activeFixtureCount": 1,
                "saveAsCopies": 0,
            },
        )

    async def _restart(self) -> None:
        await self.runtime.checkpoint(
            REOPEN_PROCEDURE["checkpoint"],
            {
                **REOPEN_PROCEDURE,
                "formalAeApp": self.runtime.identity.formal_ae_app,
                "fixturePath": self.runtime.fixture.path,
                "saveAsCopies": 0,
            },
        )

    async def _execute_rows(
        self,
        session: PublicSession,
        rows: Sequence[Any],
    ) -> None:
        for row in rows:
            if row.undo_of is not None:
                await self._undo(row.undo_of)
            payload = await self._call(
                session,
                row.tool,
                self._resolve(row.arguments),
                phase=f"{self.runtime.mode}-{row.key}",
            )
            self.responses[row.key] = payload
            self._assert_state(row.key, payload)
            self._capture(row.key, payload)
            if row.tool in CONTRACTS:
                self.runtime.mark_tool_passed(row.tool)
            if row.undo_of is not None:
                self.runtime.mark_tool_passed(
                    next(
                        plan.tool
                        for plan in self.plan
                        if plan.key == row.undo_of
                    ),
                    undo_executed=True,
                    undo_verified=True,
                )

    @property
    def _t4_handoff_path(self) -> Path:
        fixture = self.runtime.fixture.path
        return fixture.with_name(f"{fixture.name}.tsm-preflight.json")

    async def _create_fixture_after_readiness(
        self,
        session: PublicSession,
        rows: Sequence[Any],
    ) -> None:
        require(
            rows and rows[0].key == "readiness",
            "fixture creation must begin with the frozen public readiness row",
        )
        await self._execute_rows(session, rows[:1])
        await self.runtime.checkpoint(
            "save-fixture",
            {
                "instruction": FIXTURE_RECIPE[1],
                "fixturePath": self.runtime.fixture.path,
                "activeFixtureCount": 1,
                "saveAsCopies": 0,
            },
        )
        self.runtime.mark_fixture_created()
        await self._execute_rows(session, rows[1:])

    def _write_t4_handoff(self, host_instance_id: str) -> dict[str, Any]:
        path = self._t4_handoff_path
        require(not os.path.lexists(path), "T4 preflight handoff already exists")
        size, digest = self.runtime.saved_fixture_identity()
        locator = _locator(self.context.get("composition_locator"), "composition")
        require(
            locator["hostInstanceId"] == host_instance_id,
            "preflight composition locator does not belong to the bound AE host",
        )
        payload = {
            "schemaVersion": 1,
            "fixtureId": self.runtime.fixture.fixture_id,
            "fixtureBytes": size,
            "fixtureSha256": digest,
            "expectedSha": self.runtime.identity.expected_sha,
            "hostInstanceId": host_instance_id,
            "compositionLocator": locator,
        }
        descriptor = os.open(
            path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            stat.S_IRUSR | stat.S_IWUSR,
        )
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"))
            stream.write("\n")
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
        self.runtime.evidence.record(
            "t4-preflight-handoff-created",
            {
                "path": path,
                "fixtureId": payload["fixtureId"],
                "fixtureBytes": size,
                "fixtureSha256": digest,
                "hostInstanceId": host_instance_id,
            },
        )
        return payload

    def _load_t4_handoff(self, host_instance_id: str) -> dict[str, Any]:
        path = self._t4_handoff_path
        try:
            info = path.lstat()
        except FileNotFoundError as error:
            raise AcceptanceFailure(
                "T4 requires the handoff from the immediately preceding TSM preflight"
            ) from error
        require(
            stat.S_ISREG(info.st_mode)
            and not path.is_symlink()
            and stat.S_IMODE(info.st_mode) == 0o600
            and 0 < info.st_size <= 64 * 1024,
            "T4 preflight handoff is invalid",
        )
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, ValueError) as error:
            raise AcceptanceFailure("T4 preflight handoff is unreadable") from error
        handoff = mapping(payload, "T4 preflight handoff is not an object")
        require(
            set(handoff)
            == {
                "schemaVersion",
                "fixtureId",
                "fixtureBytes",
                "fixtureSha256",
                "expectedSha",
                "hostInstanceId",
                "compositionLocator",
            },
            "T4 preflight handoff is not closed",
        )
        require(
            handoff["schemaVersion"] == 1
            and handoff["fixtureId"] == self.runtime.fixture.fixture_id
            and handoff["expectedSha"] == self.runtime.identity.expected_sha
            and handoff["hostInstanceId"] == host_instance_id,
            "T4 preflight handoff identity drifted",
        )
        require(
            self.runtime.saved_fixture_identity()
            == (handoff["fixtureBytes"], handoff["fixtureSha256"]),
            "T4 preflight fixture identity drifted",
        )
        locator = _locator(handoff["compositionLocator"], "composition")
        require(
            locator["hostInstanceId"] == host_instance_id,
            "T4 preflight locator belongs to another AE host",
        )
        self.context["t4_marker_target"] = {
            "kind": "composition",
            "composition_locator": locator,
        }
        self.runtime.evidence.record(
            "t4-preflight-handoff-consumed",
            {
                "path": path,
                "fixtureId": handoff["fixtureId"],
                "fixtureSha256": handoff["fixtureSha256"],
                "hostInstanceId": host_instance_id,
            },
        )
        return dict(handoff)

    def _delete_t4_handoff(self) -> None:
        path = self._t4_handoff_path
        info = path.lstat()
        require(
            stat.S_ISREG(info.st_mode) and not path.is_symlink(),
            "refusing to remove an invalid T4 handoff",
        )
        path.unlink()
        self.runtime.evidence.record(
            "t4-preflight-handoff-removed",
            {"path": path, "sourceAbsent": True},
        )

    async def run(self) -> dict[str, Any]:
        native_ids = tuple(
            expectation.contract_id
            for expectation in CONTRACTS.values()
            if expectation.native_provenance
        ) + tuple(case.capability_id for case in SPEC.support_tools)
        self.runtime.validate_machine_identity(
            required_capability_ids=tuple(dict.fromkeys(native_ids))
        )
        if self.runtime.mode == "t4":
            require(
                os.path.lexists(self.runtime.fixture.path),
                "T4 requires the existing disposable preflight fixture",
            )
        else:
            self.runtime.require_fixture_absent()
            require(
                not os.path.lexists(self._t4_handoff_path),
                "stale T4 preflight handoff exists without an active fixture",
            )
        await self.runtime.checkpoint(
            "prepare-formal-ae",
            {
                "instruction": (
                    "Keep the immediately preceding preflight fixture open in the "
                    "same formal AE process; do not save, reopen, or use Finder."
                    if self.runtime.mode == "t4"
                    else FIXTURE_RECIPE[0]
                ),
                "formalAeApp": self.runtime.identity.formal_ae_app,
                "fixturePath": self.runtime.fixture.path,
                "activeFixtureCount": 1,
                "saveAsCopies": 0,
                "candidateRun": self.runtime.mode in {"t5", "t6"},
                "candidateEvidence": False,
            },
        )
        first = self.runtime.bind_latest_native_load(stage="initial")
        required = [case.tool for case in (*SPEC.tools, *SPEC.support_tools)]
        self.session_stage = "initial"
        async with self.runtime.session_factory() as session:
            self.runtime.require_tools(session, required)
            if self.runtime.mode == "preflight":
                await self._create_fixture_after_readiness(session, self.plan)
                handoff = self._write_t4_handoff(first)
                require(
                    self.runtime.ledger.total == len(PREFLIGHT_CALL_PLAN),
                    "TSM preflight must use exactly four public calls",
                )
                return {
                    "firstHostInstanceId": first,
                    "publicReadinessBeforeFirstSave": True,
                    "activeFixtureForT4": True,
                    "t4Handoff": handoff,
                }
            if self.runtime.mode == "t4":
                self._load_t4_handoff(first)
                self.runtime.mark_fixture_created()
                await self._execute_rows(session, self.plan)
                require(
                    self.runtime.ledger.total == 4
                    and self.runtime.ledger.hard_limit == 4,
                    "TSM T4 must use exactly four public calls",
                )
                archived = await self.runtime.archive_fixture()
                self._delete_t4_handoff()
                return {
                    "firstHostInstanceId": first,
                    "nativeNoveltySmoke": "MarkerSuite3",
                    "undoVerified": True,
                    "archived": archived,
                }

            self._record_t6_reduction()
            restart_index = next(
                index
                for index, row in enumerate(self.plan)
                if row.key == "post-restart-composition-reacquire"
            )
            await self._create_fixture_after_readiness(
                session, self.plan[:restart_index]
            )

        await self._restart()
        second = self.runtime.bind_latest_native_load(
            stage="restart", previous_instance_id=first
        )
        self.session_stage = "restart"
        async with self.runtime.session_factory() as session:
            self.runtime.require_tools(session, required)
            await self._execute_rows(session, self.plan[restart_index:])

        require(
            self.runtime.ledger.total == len(self.plan),
            f"TSM {self.runtime.mode.upper()} must use exactly {len(self.plan)} public calls",
        )
        require(
            self.runtime.ledger.hard_limit == len(self.plan),
            (
                "TSM T5 call ceiling must abort before call 45"
                if self.runtime.mode == "t5"
                else "TSM T6 call ceiling must abort before call 31"
            ),
        )
        archived = await self.runtime.archive_fixture()
        return {
            "selectedPlan": self.runtime.mode,
            "selectedPlanCalls": len(self.plan),
            "callCeilingAuthorization": (
                CALL_CEILING_AUTHORIZATION
                if self.runtime.mode == "t5"
                else None
            ),
            "t6SkippedTools": T6_SKIPS if self.runtime.mode == "t6" else {},
            "t6ReplayGrounds": (
                T6_REPLAY_GROUNDS if self.runtime.mode == "t6" else {}
            ),
            "firstHostInstanceId": first,
            "restartHostInstanceId": second,
            "restartVerified": True,
            "componentIdentitySessions": tuple(
                self.session_component_identities
            ),
            "perToolComponentIdentity": "deltas-only",
            "operationKeyCount": len(self.operation_keys),
            "reconciliationReusesOriginalKey": True,
            "archived": archived,
        }


def main(argv: Sequence[str] | None = None) -> int:
    return run_cli(
        argv,
        spec=SPEC,
        fixture_default="TSM Acceptance Fixture",
        client_name="text-shape-marker-acceptance",
        package_factory=lambda runtime, name: TextShapeMarkerPackage(
            runtime, fixture_name=name
        ),
    )


if __name__ == "__main__":
    raise SystemExit(main())
