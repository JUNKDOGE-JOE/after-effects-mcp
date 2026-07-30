"""CEP HTTP transport for the single native-program invocation contract."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
import respx
from httpx import ReadTimeout, Response

import ae_mcp_bridge
from ae_mcp.backends.native import (
    NativeBackendError,
    NativeCancellationToken,
    NativeProgramInvokeResult,
    NativeProgramRequest,
)
from ae_mcp_bridge import HttpBridge


_FIXTURES = (
    Path(__file__).resolve().parents[3]
    / "native"
    / "ae-plugin"
    / "protocol"
    / "fixtures"
)
_DEADLINE = 1_900_000_005_000
_SESSION = "11111111-1111-4111-8111-111111111111"
_HOST = "22222222-2222-4222-8222-222222222222"
_SOURCE = "a" * 40


@pytest.fixture
def token_file(tmp_path, monkeypatch):
    token = tmp_path / "auth-token"
    token.write_text("native-test-token", encoding="utf-8")
    monkeypatch.setattr(ae_mcp_bridge, "_token_path", lambda: token)
    return token


def _fixture(name: str) -> dict:
    return json.loads((_FIXTURES / name).read_text(encoding="utf-8"))


def _broker_fixture(name: str) -> dict:
    return _fixture("broker-http-errors.json")[name]


def _negotiation() -> dict:
    result = _fixture("hello.json")["response"]["result"]
    return {
        "selectedWireVersion": result["selectedWireVersion"],
        "pluginVersion": result["pluginVersion"],
        "compiledSdkVersion": result["compiledSdk"]["version"],
        "sourceCommit": _SOURCE,
        "hostInstanceId": result["host"]["instanceId"],
        "hostPlatform": result["host"]["platform"],
        "sessionId": result["sessionId"],
        "sessionGeneration": result["sessionGeneration"],
        "capabilitiesDigest": result["capabilitiesDigest"],
    }


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
            "operationKey": "native-program-write-bridge-0001",
            "undoGroup": "Native program bridge write",
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
        request_id=(
            "bridge-native-program-write"
            if write
            else "bridge-native-program-read"
        ),
        arguments=arguments,
        deadline_unix_ms=_DEADLINE,
    )


def _program_result(request: NativeProgramRequest) -> dict:
    write = "operationKey" in request.arguments
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
@pytest.mark.asyncio
async def test_native_program_success_uses_common_request_and_result(
    token_file,
    write,
):
    request = _program_request(write=write)
    raw = _program_result(request)
    captured = {}

    def respond(http_request):
        captured["body"] = json.loads(http_request.content)
        captured["token"] = http_request.headers["X-AE-MCP-Token"]
        return Response(200, json={"ok": True, "result": raw})

    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.post("/native/invoke").mock(side_effect=respond)
        result = await HttpBridge("http://127.0.0.1:11488").invoke(request)

    assert isinstance(result, NativeProgramInvokeResult)
    assert captured == {
        "body": request.model_dump(mode="json", by_alias=True),
        "token": "native-test-token",
    }
    assert result.capability_id == "ae.native.exec"
    assert result.operation_key == (
        request.arguments.get("operationKey") if write else None
    )
    assert result.undo.available is write


@pytest.mark.asyncio
async def test_native_program_read_transport_loss_is_safe_to_retry(token_file):
    request = _program_request(write=False)

    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.post("/native/invoke").mock(side_effect=ReadTimeout("lost response"))
        with pytest.raises(NativeBackendError) as raised:
            await HttpBridge("http://127.0.0.1:11488").invoke(request)

    assert raised.value.code == "DEADLINE_EXCEEDED"
    assert raised.value.side_effect == "not-started"
    assert raised.value.retryable is True
    assert raised.value.recovery.action == "retry"
    assert raised.value.details is None


@pytest.mark.asyncio
async def test_native_program_write_invalid_terminal_preserves_operation_key(
    token_file,
):
    request = _program_request(write=True)
    raw = _program_result(request)
    del raw["undo"]["groupLabel"]

    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.post("/native/invoke").mock(
            return_value=Response(200, json={"ok": True, "result": raw})
        )
        with pytest.raises(NativeBackendError) as raised:
            await HttpBridge("http://127.0.0.1:11488").invoke(request)

    assert raised.value.code == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert raised.value.details == {
        "capabilityId": "ae.native.exec",
        "operationKey": request.arguments["operationKey"],
    }


@pytest.mark.asyncio
async def test_native_program_write_transport_loss_preserves_operation_key(
    token_file,
):
    request = _program_request(write=True)

    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.post("/native/invoke").mock(side_effect=ReadTimeout("lost response"))
        with pytest.raises(NativeBackendError) as raised:
            await HttpBridge("http://127.0.0.1:11488").invoke(request)

    assert raised.value.code == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert raised.value.details == {
        "capabilityId": "ae.native.exec",
        "operationKey": request.arguments["operationKey"],
    }


@pytest.mark.asyncio
async def test_native_program_wire_failure_preserves_common_partial_evidence(
    token_file,
):
    request = _program_request(write=True)
    completed = [
        {"index": 0, "op": "composition.resolve", "status": "completed"}
    ]
    outputs: dict = {}
    partial_digest = hashlib.sha256(
        json.dumps(
            {"operations": completed, "outputs": outputs},
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()
    error = {
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
            "operationKey": request.arguments["operationKey"],
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
                "hostInstanceId": _HOST,
                "sessionId": _SESSION,
                "requestId": request.request_id,
                "capabilityId": "ae.native.exec",
                "capabilityVersion": 1,
                "startedAtUnixMs": _DEADLINE - 100,
                "completedAtUnixMs": _DEADLINE - 50,
                "effect": "may-have-occurred",
                "requestDigest": request.program_digest,
                "postcondition": {
                    "verified": False,
                    "kind": "native-program",
                    "algorithm": "sha256-rfc8785-jcs-v1",
                    "digest": partial_digest,
                },
            },
            "undo": {
                "available": True,
                "verified": False,
                "groupLabel": request.arguments["undoGroup"],
            },
        },
    }

    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.post("/native/invoke").mock(
            return_value=Response(500, json={"ok": False, "error": error})
        )
        with pytest.raises(NativeBackendError) as raised:
            await HttpBridge("http://127.0.0.1:11488").invoke(request)

    assert raised.value.code == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert raised.value.details is not None
    assert raised.value.details["operationKey"] == request.arguments[
        "operationKey"
    ]
    assert raised.value.details["completedOperations"] == completed


@pytest.mark.parametrize(
    (
        "status",
        "host_code",
        "host_retryable",
        "host_action",
        "expected_code",
        "expected_action",
    ),
    [
        (
            401,
            "UNAUTHORIZED",
            False,
            "reconnect",
            "NATIVE_BROKER_UNAUTHORIZED",
            "refresh-auth",
        ),
        (
            403,
            "CLIENT_BLOCKED",
            False,
            "none",
            "NATIVE_CLIENT_BLOCKED",
            "review-client-access",
        ),
        (
            503,
            "ACTIONS_PAUSED",
            True,
            "retry",
            "NATIVE_ACTIONS_PAUSED",
            "resume-actions",
        ),
    ],
)
@pytest.mark.asyncio
async def test_native_broker_gate_errors_map_to_core_policy(
    token_file,
    status,
    host_code,
    host_retryable,
    host_action,
    expected_code,
    expected_action,
):
    body = {
        "ok": False,
        "error": {
            "code": host_code,
            "message": host_code,
            "retryable": host_retryable,
            "sideEffect": "not-started",
            "recovery": {
                "action": host_action,
                "hint": "broker-specific recovery",
            },
        },
    }
    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.post("/native/negotiate").mock(
            return_value=Response(status, json=body)
        )
        with pytest.raises(NativeBackendError) as raised:
            await HttpBridge("http://127.0.0.1:11488").negotiate(
                deadline_unix_ms=_DEADLINE
            )

    assert raised.value.code == expected_code
    assert raised.value.side_effect == "not-started"
    assert raised.value.recovery.action == expected_action


@pytest.mark.asyncio
async def test_internal_contract_mismatch_maps_to_core_contract_error(token_file):
    fixture = _broker_fixture("contractMismatch")
    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.post("/native/negotiate").mock(
            return_value=Response(fixture["status"], json=fixture["body"])
        )
        with pytest.raises(NativeBackendError) as raised:
            await HttpBridge("http://127.0.0.1:11488").negotiate(
                deadline_unix_ms=_DEADLINE
            )

    assert raised.value.code == "NATIVE_CONTRACT_MISMATCH"
    assert raised.value.recovery.action == "refresh-capabilities"


@pytest.mark.asyncio
async def test_true_native_wire_error_uses_strict_native_validator(token_file):
    error = _fixture("errors.json")["responses"]["queueFull"]["error"]
    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.post("/native/negotiate").mock(
            return_value=Response(503, json={"ok": False, "error": error})
        )
        with pytest.raises(NativeBackendError) as raised:
            await HttpBridge("http://127.0.0.1:11488").negotiate(
                deadline_unix_ms=_DEADLINE
            )

    assert raised.value.code == "QUEUE_FULL"
    assert raised.value.recovery.action == "retry"
    assert raised.value.recovery.retry_after_ms == 250


@pytest.mark.asyncio
async def test_failure_envelope_with_http_200_fails_closed(token_file):
    body = {
        "ok": False,
        "error": {
            "code": "UNAUTHORIZED",
            "message": "unauthorized",
            "retryable": False,
            "sideEffect": "not-started",
            "recovery": {"action": "reconnect", "hint": "Reload token."},
        },
    }
    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.post("/native/negotiate").mock(return_value=Response(200, json=body))
        with pytest.raises(NativeBackendError) as raised:
            await HttpBridge("http://127.0.0.1:11488").negotiate(
                deadline_unix_ms=_DEADLINE
            )

    assert raised.value.code == "NATIVE_CONTRACT_MISMATCH"


@pytest.mark.asyncio
async def test_native_success_envelope_fails_closed_on_extra_member(token_file):
    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.post("/native/negotiate").mock(
            return_value=Response(
                200,
                json={"ok": True, "result": _negotiation(), "unchecked": True},
            )
        )
        with pytest.raises(NativeBackendError) as raised:
            await HttpBridge("http://127.0.0.1:11488").negotiate(
                deadline_unix_ms=_DEADLINE
            )

    assert raised.value.code == "NATIVE_CONTRACT_MISMATCH"


@pytest.mark.asyncio
async def test_native_cancellation_before_dispatch_makes_no_http_request(
    token_file,
):
    cancellation = NativeCancellationToken()
    cancellation.cancel()
    async with respx.mock(
        base_url="http://127.0.0.1:11488",
        assert_all_called=False,
    ) as mock:
        route = mock.post("/native/negotiate").mock(
            return_value=Response(
                200, json={"ok": True, "result": _negotiation()}
            )
        )
        with pytest.raises(NativeBackendError) as raised:
            await HttpBridge("http://127.0.0.1:11488").negotiate(
                deadline_unix_ms=_DEADLINE,
                cancellation=cancellation,
            )

    assert raised.value.code == "CANCELLED"
    assert route.called is False
