"""Core contracts shared by every bounded native program."""

from __future__ import annotations

import hashlib
import inspect
import json

import pytest
from pydantic import ValidationError

from ae_mcp.backends.base import LegacyExtendScriptBackend
from ae_mcp.backends.native import (
    NativeBackendError,
    NativeCancellationToken,
    NativeCapabilities,
    NativeInvokeBackend,
    NativeProgramInvokeResult,
    NativeProgramRequest,
    NativeRecovery,
)


_DEADLINE = 1_900_000_005_000
_SESSION = "11111111-1111-4111-8111-111111111111"
_HOST = "22222222-2222-4222-8222-222222222222"


def _program_request(*, write: bool) -> NativeProgramRequest:
    arguments = {
        "operations": [
            {
                "op": "project.items.list",
                "args": {"offset": 0, "limit": 1},
                "returnAs": "items",
            }
        ]
    }
    if write:
        arguments = {
            "operationKey": "native-program-contract-0001",
            "undoGroup": "Native program contract",
            "operations": [
                {
                    "op": "composition.resolve",
                    "args": {
                        "locator": {
                            "kind": "composition",
                            "hostInstanceId": _HOST,
                            "sessionId": _SESSION,
                            "projectId": "33333333-3333-4333-8333-333333333333",
                            "generation": 1,
                            "objectId": "44444444-4444-4444-8444-444444444444",
                        }
                    },
                    "saveAs": "composition",
                },
                {
                    "op": "composition.time.set",
                    "args": {
                        "composition": {"ref": "composition"},
                        "targetTime": {"value": 1, "scale": 24},
                    },
                    "returnAs": "time",
                },
            ],
        }
    return NativeProgramRequest(
        request_id=f"native-contract-{'write' if write else 'read'}",
        arguments=arguments,
        deadline_unix_ms=_DEADLINE,
    )


def _program_result(request: NativeProgramRequest) -> dict:
    write = request.arguments.get("operationKey") is not None
    operations = [
        {"index": index, "op": operation["op"], "status": "completed"}
        for index, operation in enumerate(request.arguments["operations"])
    ]
    outputs = (
        {"time": {"value": 1, "scale": 24}}
        if write
        else {"items": {"items": [], "nextOffset": None}}
    )
    digest = hashlib.sha256(
        json.dumps(
            {"operations": operations, "outputs": outputs},
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()
    return {
        "capabilityId": "ae.native.exec",
        **(
            {"operationKey": request.arguments["operationKey"]}
            if write
            else {}
        ),
        "outputs": outputs,
        "operations": operations,
        "evidence": {
            "engine": "native-aegp",
            "hostInstanceId": _HOST,
            "sessionId": _SESSION,
            "requestId": request.request_id,
            "capabilityId": "ae.native.exec",
            "capabilityVersion": 1,
            "startedAtUnixMs": _DEADLINE - 100,
            "completedAtUnixMs": _DEADLINE - 50,
            "effect": "committed" if write else "none",
            "requestDigest": request.program_digest,
            "postcondition": {
                "verified": True,
                "kind": "native-program",
                "algorithm": "sha256-rfc8785-jcs-v1",
                "digest": digest,
            },
        },
        "undo": (
            {
                "available": True,
                "verified": False,
                "groupLabel": request.arguments["undoGroup"],
            }
            if write
            else {"available": False, "verified": False}
        ),
        "replayed": False,
    }


@pytest.mark.parametrize("write", [False, True])
def test_native_program_models_preserve_the_common_contract(write):
    request = _program_request(write=write)
    result = NativeProgramInvokeResult.model_validate(_program_result(request))

    assert request.capability_id == "ae.native.exec"
    assert request.capability_version == 1
    assert result.capability_id == "ae.native.exec"
    assert result.operation_key == (
        request.arguments.get("operationKey") if write else None
    )
    assert result.undo.available is write
    assert result.evidence.request_digest == request.program_digest


def test_native_program_request_rejects_operation_specific_capability_alias():
    raw = _program_request(write=False).model_dump(
        mode="json", by_alias=True
    )
    raw["capabilityId"] = "ae.project.summary"

    with pytest.raises(ValidationError):
        NativeProgramRequest.model_validate(raw)


def test_native_program_success_rejects_inconsistent_write_evidence():
    request = _program_request(write=True)
    raw = _program_result(request)
    raw["evidence"]["effect"] = "none"

    with pytest.raises(ValidationError):
        NativeProgramInvokeResult.model_validate(raw)


def test_native_program_uncertainty_keeps_operation_key_and_inspect_state_policy():
    error = NativeBackendError(
        "POSSIBLY_SIDE_EFFECTING_FAILURE",
        "Native program completion became uncertain.",
        retryable=False,
        side_effect="may-have-occurred",
        recovery=NativeRecovery(
            action="inspect-state",
            hint="Inspect After Effects state and audit evidence before retrying.",
        ),
        details={
            "capabilityId": "ae.native.exec",
            "operationKey": "native-program-contract-0001",
        },
    )

    assert error.retryable is False
    assert error.side_effect == "may-have-occurred"
    assert error.recovery.action == "inspect-state"
    assert error.details == {
        "capabilityId": "ae.native.exec",
        "operationKey": "native-program-contract-0001",
    }


def test_native_boundary_has_no_legacy_inheritance_fallback_or_resolver():
    assert not issubclass(NativeInvokeBackend, LegacyExtendScriptBackend)
    source = inspect.getsource(NativeInvokeBackend)
    assert "resolver" not in source
    assert "LegacyExtendScriptBackend" not in source


def test_cancellation_token_is_observable_without_transport_coupling():
    token = NativeCancellationToken()
    assert token.is_cancelled is False
    token.cancel()
    assert token.is_cancelled is True


class _NoCancellationBackend(NativeInvokeBackend):
    async def negotiate(self, **_kwargs):
        raise AssertionError("not used")

    async def capabilities(self, **_kwargs) -> NativeCapabilities:
        raise AssertionError("not used")

    async def invoke(self, *_args, **_kwargs):
        raise AssertionError("not used")


@pytest.mark.asyncio
async def test_default_native_cancel_fails_explicitly_when_not_supported():
    with pytest.raises(NativeBackendError) as raised:
        await _NoCancellationBackend().cancel(
            "native-program-contract-read",
            deadline_unix_ms=_DEADLINE,
        )

    assert raised.value.code == "NATIVE_UNSUPPORTED"
    assert raised.value.retryable is False
