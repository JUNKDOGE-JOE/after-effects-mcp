"""Focused Core contract tests for the single bounded native EXEC route."""

from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from typing import Any

import pytest
from pydantic import ValidationError

from ae_mcp import schemas as S
from ae_mcp.backends import native as N
from ae_mcp.handlers import HANDLERS, load_all
from ae_mcp.native_exec_generated import PRIMITIVES


_HOST = "22222222-2222-4222-8222-222222222222"
_SESSION = "11111111-1111-4111-8111-111111111111"
_PROJECT = "33333333-3333-4333-8333-333333333333"
_OBJECT = "44444444-4444-4444-8444-444444444444"
_DEADLINE = 1_900_000_005_000


def _canonical_digest(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _composition_locator() -> dict[str, Any]:
    return {
        "kind": "composition",
        "hostInstanceId": _HOST,
        "sessionId": _SESSION,
        "projectId": _PROJECT,
        "generation": 1,
        "objectId": _OBJECT,
    }


def _project_locator() -> dict[str, Any]:
    return {
        **_composition_locator(),
        "kind": "project",
    }


def _layer_locator() -> dict[str, Any]:
    return {
        **_composition_locator(),
        "kind": "layer",
        "objectId": "55555555-5555-4555-8555-555555555555",
    }


def _layer_properties_program() -> dict[str, Any]:
    return {
        "operations": [
            {
                "op": "composition.resolve",
                "args": {"locator": _composition_locator()},
                "saveAs": "composition",
            },
            {
                "op": "layer.resolve",
                "args": {
                    "composition": {"ref": "composition"},
                    "locator": _layer_locator(),
                },
                "saveAs": "layer",
            },
            {
                "op": "layer.properties.list",
                "args": {"layer": {"ref": "layer"}, "offset": 0, "limit": 1},
                "returnAs": "properties",
            },
        ]
    }


def _read_program() -> dict[str, Any]:
    return {
        "operations": [
            {
                "op": "project.items.list",
                "args": {"offset": 0, "limit": 1},
                "returnAs": "items",
            }
        ]
    }


def _write_program() -> dict[str, Any]:
    return {
        "operationKey": "native-program-write-0001",
        "undoGroup": "Native program write",
        "operations": [
            {
                "op": "composition.resolve",
                "args": {"locator": _composition_locator()},
                "saveAs": "composition",
            },
            {
                "op": "composition.time.set",
                "args": {
                    "composition": {"ref": "composition"},
                    "targetTime": {"value": 5, "scale": 24},
                },
                "returnAs": "time",
            },
        ],
    }


def test_native_exec_schema_is_generated_closed_and_discriminated():
    schema = S.AeNativeExecArgs.model_json_schema()
    forbidden = {"allOf", "anyOf", "else", "if", "not", "oneOf", "then"}
    assert not forbidden.intersection(schema)
    assert "allOf" in S.NATIVE_EXEC_INPUT_SCHEMA
    operation_union = schema["properties"]["operations"]["items"]["oneOf"]
    assert len(operation_union) == 23
    assert {
        row["properties"]["op"]["const"] for row in operation_union
    } == {row["id"] for row in PRIMITIVES}

    parsed = S.AeNativeExecArgs.model_validate(_read_program())
    assert parsed.model_dump(
        mode="json", by_alias=True, exclude_none=True
    ) == _read_program()

    with pytest.raises(ValidationError):
        S.AeNativeExecArgs.model_validate(
            {
                "operations": [
                    {"op": "not.a.primitive", "args": {}, "returnAs": "bad"}
                ]
            }
        )
    with pytest.raises(ValidationError):
        S.AeNativeExecArgs.model_validate(
            {
                "operations": [
                    {
                        "op": "project.items.list",
                        "args": {"offset": 0, "limit": 1, "extra": True},
                    }
                ]
            }
        )


def test_native_exec_read_write_envelopes_and_operation_bound_are_strict():
    S.AeNativeExecArgs.model_validate(_read_program())
    S.AeNativeExecArgs.model_validate(_write_program())

    read_with_write_metadata = {
        **_read_program(),
        "operationKey": "native-program-read-0001",
        "undoGroup": "Must be rejected",
    }
    with pytest.raises(ValidationError):
        S.AeNativeExecArgs.model_validate(read_with_write_metadata)

    write_without_key = _write_program()
    write_without_key.pop("operationKey")
    with pytest.raises(ValidationError):
        S.AeNativeExecArgs.model_validate(write_without_key)

    write_without_undo = _write_program()
    write_without_undo.pop("undoGroup")
    with pytest.raises(ValidationError):
        S.AeNativeExecArgs.model_validate(write_without_undo)

    maximum = [
        {
            **_read_program()["operations"][0],
            "returnAs": f"items{index}",
        }
        for index in range(64)
    ]
    S.AeNativeExecArgs.model_validate({"operations": maximum})
    with pytest.raises(ValidationError):
        S.AeNativeExecArgs.model_validate({"operations": maximum + maximum[:1]})


def test_native_exec_undo_group_uses_the_common_terminal_bound():
    accepted = _write_program()
    accepted["undoGroup"] = "u" * 128
    S.AeNativeExecArgs.model_validate(accepted)

    rejected = _write_program()
    rejected["undoGroup"] = "u" * 129
    with pytest.raises(ValidationError):
        S.AeNativeExecArgs.model_validate(rejected)


def test_native_exec_references_are_backward_only_and_typed():
    S.AeNativeExecArgs.model_validate(_write_program())

    forward = _write_program()
    forward["operations"] = list(reversed(forward["operations"]))
    with pytest.raises(ValidationError, match="earlier"):
        S.AeNativeExecArgs.model_validate(forward)

    wrong_kind = _write_program()
    wrong_kind["operations"][0]["op"] = "project.items.list"
    wrong_kind["operations"][0]["args"] = {
        "offset": 0,
        "limit": 1,
    }
    wrong_kind["operations"][0]["saveAs"] = "items"
    wrong_kind["operations"][1]["args"]["composition"] = {"ref": "items"}
    with pytest.raises(ValidationError, match="expects CompositionHandle, got Json"):
        S.AeNativeExecArgs.model_validate(wrong_kind)


def test_native_exec_optional_parent_property_allows_a_root_properties_list():
    root_properties = {
        "operations": [
            {
                "op": "composition.resolve",
                "args": {"locator": _composition_locator()},
                "saveAs": "composition",
            },
            {
                "op": "layer.resolve",
                "args": {
                    "composition": {"ref": "composition"},
                    "locator": _layer_locator(),
                },
                "saveAs": "layer",
            },
            {
                "op": "layer.properties.list",
                "args": {
                    "layer": {"ref": "layer"},
                    "offset": 0,
                    "limit": 25,
                },
                "returnAs": "properties",
            },
        ]
    }
    S.AeNativeExecArgs.model_validate(root_properties)

    missing_required_layer = deepcopy(root_properties)
    del missing_required_layer["operations"][2]["args"]["layer"]
    with pytest.raises(ValidationError):
        S.AeNativeExecArgs.model_validate(missing_required_layer)


def test_native_program_request_digest_is_canonical_and_argument_bound():
    args = S.AeNativeExecArgs.model_validate(_write_program())
    request = N.NativeProgramRequest.from_args(
        request_id="mcp-native-program-1",
        args=args,
        deadline_unix_ms=_DEADLINE,
    )
    assert request.capability_id == "ae.native.exec"
    assert request.capability_version == 1
    assert request.arguments == _write_program()
    assert request.program_digest == _canonical_digest(_write_program())

    changed = _write_program()
    changed["operations"][1]["args"]["targetTime"]["value"] = 6
    changed_request = N.NativeProgramRequest.from_args(
        request_id="mcp-native-program-2",
        args=S.AeNativeExecArgs.model_validate(changed),
        deadline_unix_ms=_DEADLINE,
    )
    assert changed_request.program_digest != request.program_digest


def _negotiation() -> N.NativeNegotiation:
    return N.NativeNegotiation(
        selected_wire_version=1,
        plugin_version="test-plugin",
        compiled_sdk_version="2026",
        source_commit="a" * 40,
        host_instance_id=_HOST,
        host_platform="macos-arm64",
        session_id=_SESSION,
        session_generation=1,
        capabilities_digest="b" * 64,
    )


def _program_success(
    request: N.NativeProgramRequest,
    negotiation: N.NativeNegotiation,
) -> N.NativeProgramInvokeResult:
    operations = [
        {"index": 0, "op": "project.items.list", "status": "completed"}
    ]
    outputs = {
        "items": {
            "projectLocator": _project_locator(),
            "total": 0,
            "offset": 0,
            "limit": 1,
            "returned": 0,
            "hasMore": False,
            "nextOffset": None,
            "items": [],
        }
    }
    return N.NativeProgramInvokeResult.model_validate(
        {
            "capabilityId": "ae.native.exec",
            "outputs": outputs,
            "operations": operations,
            "evidence": {
                "engine": "native-aegp",
                "hostInstanceId": _HOST,
                "sessionId": _SESSION,
                "requestId": request.request_id,
                "capabilityId": "ae.native.exec",
                "capabilityVersion": 1,
                "startedAtUnixMs": request.deadline_unix_ms - 100,
                "completedAtUnixMs": request.deadline_unix_ms - 50,
                "effect": "none",
                "requestDigest": _canonical_digest(
                    {
                        "wireVersion": negotiation.selected_wire_version,
                        "kind": "request",
                        "sessionId": negotiation.session_id,
                        "requestId": request.request_id,
                        "method": "invoke",
                        "deadlineUnixMs": request.deadline_unix_ms,
                        "params": {
                            "capabilityId": request.capability_id,
                            "capabilityVersion": request.capability_version,
                            "arguments": request.arguments,
                        },
                    }
                ),
                "postcondition": {
                    "verified": True,
                    "kind": "native-program",
                    "algorithm": "sha256-rfc8785-jcs-v1",
                    "digest": _canonical_digest(
                        {"operations": operations, "outputs": outputs}
                    ),
                },
            },
            "undo": {"available": False, "verified": False},
            "replayed": False,
        }
    )


def _program_success_with_outputs(
    request: N.NativeProgramRequest,
    negotiation: N.NativeNegotiation,
    outputs: dict[str, Any],
) -> N.NativeProgramInvokeResult:
    operations = [
        {"index": index, "op": operation["op"], "status": "completed"}
        for index, operation in enumerate(request.arguments["operations"])
    ]
    return N.NativeProgramInvokeResult.model_validate(
        {
            "capabilityId": "ae.native.exec",
            "outputs": outputs,
            "operations": operations,
            "evidence": {
                "engine": "native-aegp",
                "hostInstanceId": _HOST,
                "sessionId": _SESSION,
                "requestId": request.request_id,
                "capabilityId": "ae.native.exec",
                "capabilityVersion": 1,
                "startedAtUnixMs": request.deadline_unix_ms - 100,
                "completedAtUnixMs": request.deadline_unix_ms - 50,
                "effect": "none",
                "requestDigest": _canonical_digest(
                    {
                        "wireVersion": negotiation.selected_wire_version,
                        "kind": "request",
                        "sessionId": negotiation.session_id,
                        "requestId": request.request_id,
                        "method": "invoke",
                        "deadlineUnixMs": request.deadline_unix_ms,
                        "params": {
                            "capabilityId": request.capability_id,
                            "capabilityVersion": request.capability_version,
                            "arguments": request.arguments,
                        },
                    }
                ),
                "postcondition": {
                    "verified": True,
                    "kind": "native-program",
                    "algorithm": "sha256-rfc8785-jcs-v1",
                    "digest": _canonical_digest(
                        {"operations": operations, "outputs": outputs}
                    ),
                },
            },
            "undo": {"available": False, "verified": False},
            "replayed": False,
        }
    )


def _program_failure_error(
    request: N.NativeProgramRequest,
    negotiation: N.NativeNegotiation,
) -> N.NativeBackendError:
    completed = [
        {"index": 0, "op": "composition.resolve", "status": "completed"}
    ]
    outputs: dict[str, Any] = {}
    return N.NativeBackendError.from_payload(
        {
            "code": "POSSIBLY_SIDE_EFFECTING_FAILURE",
            "message": "Native program completion became uncertain.",
            "retryable": False,
            "sideEffect": "may-have-occurred",
            "recovery": {
                "action": "inspect-state",
                "hint": "Inspect After Effects state and audit evidence before retrying.",
            },
            "details": {
                "capabilityId": "ae.native.exec",
                "operationKey": "native-program-write-0001",
                "disposition": "possibly-side-effecting",
                "completedOperations": completed,
                "failedOperation": {
                    "index": 1,
                    "op": "composition.time.set",
                    "status": "failed",
                },
                "outputs": outputs,
                "evidence": {
                    "engine": "native-aegp",
                    "hostInstanceId": negotiation.host_instance_id,
                    "sessionId": negotiation.session_id,
                    "requestId": request.request_id,
                    "capabilityId": "ae.native.exec",
                    "capabilityVersion": 1,
                    "startedAtUnixMs": _DEADLINE - 100,
                    "completedAtUnixMs": _DEADLINE - 50,
                    "effect": "may-have-occurred",
                    "requestDigest": _canonical_digest(
                        {
                            "wireVersion": negotiation.selected_wire_version,
                            "kind": "request",
                            "sessionId": negotiation.session_id,
                            "requestId": request.request_id,
                            "method": "invoke",
                            "deadlineUnixMs": request.deadline_unix_ms,
                            "params": {
                                "capabilityId": request.capability_id,
                                "capabilityVersion": request.capability_version,
                                "arguments": request.arguments,
                            },
                        }
                    ),
                    "postcondition": {
                        "verified": False,
                        "kind": "native-program",
                        "algorithm": "sha256-rfc8785-jcs-v1",
                        "digest": _canonical_digest(
                            {"operations": completed, "outputs": outputs}
                        ),
                    },
                },
                "undo": {
                    "available": True,
                    "verified": False,
                    "groupLabel": "Native program write",
                },
            },
        }
    )


class _ProgramBackend(N.NativeInvokeBackend):
    name = "program-test"

    def __init__(self) -> None:
        self.negotiation = _negotiation()
        self.requests: list[N.NativeProgramRequest] = []
        self.invoke_error: N.NativeBackendError | None = None
        self.invoke_result: N.NativeProgramInvokeResult | None = None

    async def negotiate(self, **_kwargs) -> N.NativeNegotiation:
        return self.negotiation

    async def capabilities(self, **_kwargs) -> N.NativeCapabilities:
        raise AssertionError("ae.native.exec must not query legacy capability wrappers")

    async def invoke(
        self,
        request: N.NativeProgramRequest,
        *,
        cancellation: N.NativeCancellationToken | None = None,
    ) -> N.NativeProgramInvokeResult:
        del cancellation
        self.requests.append(request)
        if self.invoke_error is not None:
            raise self.invoke_error
        if self.invoke_result is not None:
            return self.invoke_result
        return _program_success(request, self.negotiation)


@pytest.mark.asyncio
async def test_native_exec_negotiates_once_invokes_once_and_projects_common_success():
    backend = _ProgramBackend()
    execution = await N.invoke_native_program(
        backend,
        request_id="mcp-native-program-3",
        args=S.AeNativeExecArgs.model_validate(_read_program()),
        deadline_unix_ms=_DEADLINE,
    )

    assert len(backend.requests) == 1
    assert execution.request.program_digest == _canonical_digest(_read_program())
    assert execution.result.outputs["items"]["items"] == []
    assert execution.result.outputs["items"]["projectLocator"] == _project_locator()
    assert execution.result.evidence.request_id == "mcp-native-program-3"


@pytest.mark.asyncio
async def test_native_exec_validates_exported_values_against_generated_result_schema():
    backend = _ProgramBackend()
    args = S.AeNativeExecArgs.model_validate(_layer_properties_program())
    request = N.NativeProgramRequest.from_args(
        request_id="mcp-native-program-result-schema",
        args=args,
        deadline_unix_ms=_DEADLINE,
    )
    output = {
        "layerLocator": _layer_locator(),
        "parentPropertyLocator": None,
        "layerName": "Layer",
        "sampleTime": {"value": -3, "scale": 24},
        "total": 0,
        "offset": 0,
        "limit": 1,
        "returned": 0,
        "hasMore": False,
        "nextOffset": None,
        "properties": [],
    }
    backend.invoke_result = _program_success_with_outputs(
        request,
        backend.negotiation,
        {"properties": output},
    )
    with pytest.raises(N.NativeBackendError) as raised:
        await N.invoke_native_program(
            backend,
            request_id=request.request_id,
            args=args,
            deadline_unix_ms=request.deadline_unix_ms,
        )
    assert raised.value.code == "NATIVE_CONTRACT_MISMATCH"


@pytest.mark.asyncio
async def test_native_exec_rebinds_unverifiable_write_failure_to_real_operation_key():
    backend = _ProgramBackend()
    backend.invoke_error = N.NativeBackendError(
        "POSSIBLY_SIDE_EFFECTING_FAILURE",
        "Native program failure was bound to another operation.",
        retryable=False,
        side_effect="may-have-occurred",
        recovery=N.NativeRecovery(
            action="inspect-state",
            hint="Inspect state before retrying.",
        ),
        details={
            "capabilityId": "ae.native.exec",
            "operationKey": "native-program-write-other",
        },
    )
    with pytest.raises(N.NativeBackendError) as raised:
        await N.invoke_native_program(
            backend,
            request_id="mcp-native-program-key-binding",
            args=S.AeNativeExecArgs.model_validate(_write_program()),
            deadline_unix_ms=_DEADLINE,
        )
    assert raised.value.code == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert raised.value.details == {
        "capabilityId": "ae.native.exec",
        "operationKey": "native-program-write-0001",
    }


@pytest.mark.asyncio
async def test_native_exec_accepts_a_request_bound_partial_failure():
    backend = _ProgramBackend()
    args = S.AeNativeExecArgs.model_validate(_write_program())
    request = N.NativeProgramRequest.from_args(
        request_id="mcp-native-program-failure",
        args=args,
        deadline_unix_ms=_DEADLINE,
    )
    backend.invoke_error = _program_failure_error(request, backend.negotiation)

    with pytest.raises(N.NativeBackendError) as raised:
        await N.invoke_native_program(
            backend,
            request_id=request.request_id,
            args=args,
            deadline_unix_ms=request.deadline_unix_ms,
        )
    assert raised.value is backend.invoke_error
    assert raised.value.details is not None
    assert raised.value.details["completedOperations"] == [
        {"index": 0, "op": "composition.resolve", "status": "completed"}
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("path", "replacement"),
    [
        (("evidence", "requestId"), "mcp-native-program-other"),
        (("evidence", "hostInstanceId"), "66666666-6666-4666-8666-666666666666"),
        (("evidence", "sessionId"), "77777777-7777-4777-8777-777777777777"),
        (("evidence", "requestDigest"), "d" * 64),
        (("completedOperations", 0, "op"), "project.items.list"),
        (("failedOperation", "op"), "project.items.list"),
        (("evidence", "postcondition", "digest"), "e" * 64),
        (("undo", "groupLabel"), "Another Undo group"),
    ],
)
async def test_native_exec_rebinds_untrusted_partial_failure_evidence(
    path,
    replacement,
):
    backend = _ProgramBackend()
    args = S.AeNativeExecArgs.model_validate(_write_program())
    request = N.NativeProgramRequest.from_args(
        request_id="mcp-native-program-failure",
        args=args,
        deadline_unix_ms=_DEADLINE,
    )
    error = _program_failure_error(request, backend.negotiation)
    payload = error.payload.model_dump(mode="json", by_alias=True, exclude_none=True)
    target = payload["details"]
    for part in path[:-1]:
        target = target[part]
    target[path[-1]] = replacement
    backend.invoke_error = N.NativeBackendError.from_payload(payload)

    with pytest.raises(N.NativeBackendError) as raised:
        await N.invoke_native_program(
            backend,
            request_id=request.request_id,
            args=args,
            deadline_unix_ms=request.deadline_unix_ms,
        )
    assert raised.value.code == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert raised.value.details == {
        "capabilityId": "ae.native.exec",
        "operationKey": "native-program-write-0001",
    }


@pytest.mark.asyncio
async def test_native_exec_handler_returns_common_result_and_preserves_uncertainty(
    monkeypatch,
):
    from ae_mcp.handlers import native as handler

    backend = _ProgramBackend()
    monkeypatch.setattr(handler._discovery, "select_backend", lambda: backend)
    _, run = HANDLERS["ae.nativeExec"]
    success = await run(S.AeNativeExecArgs.model_validate(_read_program()), None)
    assert success["ok"] is True
    assert success["capabilityId"] == "ae.native.exec"
    assert success["outputs"]["items"]["items"] == []
    assert success["outputs"]["items"]["nextOffset"] is None
    assert success["outputs"]["items"]["projectLocator"] == _project_locator()
    assert success["audit"]["programDigest"] == _canonical_digest(_read_program())

    backend.invoke_error = N.NativeBackendError(
        "POSSIBLY_SIDE_EFFECTING_FAILURE",
        "Native program terminal was lost after dispatch.",
        retryable=False,
        side_effect="may-have-occurred",
        recovery=N.NativeRecovery(
            action="inspect-state",
            hint="Run a read-only program and inspect audit evidence before retrying.",
        ),
        details={
            "capabilityId": "ae.native.exec",
            "operationKey": "native-program-write-0001",
        },
    )
    with pytest.raises(N.NativeBackendError) as raised:
        await run(S.AeNativeExecArgs.model_validate(_write_program()), None)
    assert raised.value.code == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert raised.value.details == {
        "capabilityId": "ae.native.exec",
        "operationKey": "native-program-write-0001",
    }


def test_common_native_program_failure_preserves_partial_evidence():
    request = N.NativeProgramRequest.from_args(
        request_id="mcp-native-program-failure",
        args=S.AeNativeExecArgs.model_validate(_write_program()),
        deadline_unix_ms=_DEADLINE,
    )
    error = _program_failure_error(request, _negotiation())
    assert error.side_effect == "may-have-occurred"
    assert error.details is not None
    assert error.details["operationKey"] == "native-program-write-0001"
    assert error.details["completedOperations"] == [
        {"index": 0, "op": "composition.resolve", "status": "completed"}
    ]
    assert error.details["failedOperation"]["index"] == 1


def test_native_exec_handler_is_registered_canonically():
    load_all()
    assert HANDLERS["ae.nativeExec"][0] is S.AeNativeExecArgs
