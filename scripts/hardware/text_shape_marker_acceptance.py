#!/usr/bin/env python3
"""Run the frozen Text, Shape, and Marker T4/T5/T6 acceptance plan."""

from __future__ import annotations

import copy
from collections.abc import Mapping, Sequence
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
    REOPEN_PROCEDURE,
    SPEC,
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
            return await self._text_call(session, tool, arguments, phase=phase)
        expectation = CONTRACTS.get(tool)
        case = SPEC.case_by_tool.get(tool) or self.support[tool]
        capability_id = (
            expectation.contract_id if expectation is not None else case.capability_id
        )
        return await self.runtime.call(
            session,
            tool,
            arguments,
            capability_id=capability_id,
            write=case.kind == "write",
            phase=phase,
            expected_replayed=False if case.kind == "write" else None,
        )

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
        if key == "composition-reacquire":
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
        elif key == "cross-family-layers":
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
        if key == "empty-layer-baseline":
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

    async def run(self) -> dict[str, Any]:
        native_ids = tuple(
            expectation.contract_id
            for expectation in CONTRACTS.values()
            if expectation.native_provenance
        ) + tuple(case.capability_id for case in SPEC.support_tools)
        self.runtime.validate_machine_identity(
            required_capability_ids=tuple(dict.fromkeys(native_ids))
        )
        self.runtime.require_fixture_absent()
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

        if self.runtime.mode == "preflight":
            raise AcceptanceFailure(
                "TSM zero-evidence preflight is owned by the prepared runtime workflow"
            )
        if self.runtime.mode == "t4":
            raise AcceptanceFailure(
                "Use the dedicated four-call MarkerSuite3 novelty smoke before candidate acceptance"
            )

        first = self.runtime.bind_latest_native_load(stage="initial")
        required = [case.tool for case in (*SPEC.tools, *SPEC.support_tools)]
        async with self.runtime.session_factory() as session:
            self.runtime.require_tools(session, required)
            for row in CALL_PLAN:
                if row.ordinal == 43:
                    await self._restart()
                    break
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
                if row.tool in CONTRACTS and row.disposition == "read":
                    self.runtime.mark_tool_passed(row.tool)
                if row.undo_of is not None:
                    self.runtime.mark_tool_passed(
                        next(
                            plan.tool
                            for plan in CALL_PLAN
                            if plan.key == row.undo_of
                        ),
                        undo_executed=True,
                        undo_verified=True,
                    )

        second = self.runtime.bind_latest_native_load(
            stage="restart", previous_instance_id=first
        )
        async with self.runtime.session_factory() as session:
            self.runtime.require_tools(session, required)
            for row in CALL_PLAN[42:]:
                payload = await self._call(
                    session,
                    row.tool,
                    self._resolve(row.arguments),
                    phase=f"{self.runtime.mode}-{row.key}",
                )
                self.responses[row.key] = payload
                self._assert_state(row.key, payload)
                self._capture(row.key, payload)

        require(
            self.runtime.ledger.total == CALL_CEILING_AUTHORIZATION["authorizedCalls"],
            "TSM T5/T6 must use exactly 44 public calls",
        )
        require(
            self.runtime.ledger.hard_limit == 44,
            "TSM call ceiling must abort before call 45",
        )
        archived = await self.runtime.archive_fixture()
        return {
            "callCeilingAuthorization": CALL_CEILING_AUTHORIZATION,
            "firstHostInstanceId": first,
            "restartHostInstanceId": second,
            "restartVerified": True,
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
