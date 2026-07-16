"""Authenticated CEP HTTP adapter for the typed native Core contract."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import respx
from httpx import ReadTimeout, Response

import ae_mcp_bridge
from ae_mcp.backends.native import (
    NativeBackendError,
    NativeCancellationToken,
    NativeInvokeRequest,
)
from ae_mcp_bridge import HttpBridge


_FIXTURES = Path(__file__).resolve().parents[3] / "native" / "ae-plugin" / "protocol" / "fixtures"
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


def _capabilities() -> dict:
    return {
        "sessionId": _SESSION,
        **_fixture("capabilities.json")["response"]["result"],
    }


def _invoke_result() -> dict:
    return {
        **_fixture("invoke-project-summary.json")["response"]["result"],
        "replayed": False,
    }


@pytest.mark.asyncio
async def test_native_backend_posts_lossless_typed_contract(token_file):
    captured: dict[str, dict] = {}

    def respond(name: str, result: dict):
        def _response(request):
            captured[name] = {
                "body": json.loads(request.content),
                "token": request.headers.get("X-AE-MCP-Token"),
                "client": request.headers.get("x-ae-mcp-client"),
            }
            return Response(200, json={"ok": True, "result": result})

        return _response

    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.post("/native/negotiate").mock(side_effect=respond("negotiate", _negotiation()))
        mock.post("/native/capabilities").mock(side_effect=respond("capabilities", _capabilities()))
        mock.post("/native/invoke").mock(side_effect=respond("invoke", _invoke_result()))
        backend = HttpBridge("http://127.0.0.1:11488")

        negotiation = await backend.negotiate(deadline_unix_ms=_DEADLINE)
        capabilities = await backend.capabilities(
            ids=None,
            detail="full",
            limit=100,
            deadline_unix_ms=_DEADLINE,
        )
        request = NativeInvokeRequest(
            request_id="invoke-summary-1",
            capability_id="ae.project.summary",
            capability_version=1,
            arguments={},
            deadline_unix_ms=_DEADLINE,
        )
        result = await backend.invoke(request)

    assert negotiation.host_instance_id == _HOST
    assert capabilities.session_id == _SESSION
    assert capabilities.items[0].capability_id == "ae.project.summary"
    assert result.evidence.request_id == "invoke-summary-1"
    assert captured["negotiate"]["body"] == {"deadlineUnixMs": _DEADLINE}
    assert captured["capabilities"]["body"] == {
        "detail": "full",
        "limit": 100,
        "deadlineUnixMs": _DEADLINE,
    }
    assert captured["invoke"]["body"] == request.model_dump(
        mode="json", by_alias=True
    )
    assert all(item["token"] == "native-test-token" for item in captured.values())
    assert all(item["client"] for item in captured.values())


@pytest.mark.parametrize(
    ("fixture_name", "capability_id"),
    [
        ("invoke-project-items-list.json", "ae.project.items.list"),
        ("invoke-composition-layers-list.json", "ae.composition.layers.list"),
        (
            "invoke-composition-selected-layers-list.json",
            "ae.composition.selected-layers.list",
        ),
        ("invoke-layer-properties-list.json", "ae.layer.properties.list"),
    ],
)
@pytest.mark.asyncio
async def test_native_navigation_reads_are_forwarded_losslessly(
    token_file,
    fixture_name,
    capability_id,
):
    vector = _fixture(fixture_name)
    wire_request = vector["request"]
    raw = {
        **vector["response"]["result"],
        "replayed": vector["response"]["replayed"],
    }
    request = NativeInvokeRequest(
        request_id=wire_request["requestId"],
        capability_id=capability_id,
        capability_version=wire_request["params"]["capabilityVersion"],
        arguments=wire_request["params"]["arguments"],
        deadline_unix_ms=wire_request["deadlineUnixMs"],
    )
    captured: dict = {}

    def respond(http_request):
        captured.update(json.loads(http_request.content))
        return Response(200, json={"ok": True, "result": raw})

    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.post("/native/invoke").mock(side_effect=respond)
        result = await HttpBridge("http://127.0.0.1:11488").invoke(request)

    assert captured == request.model_dump(mode="json", by_alias=True)
    assert result.model_dump(mode="json", by_alias=True, exclude_none=True) == raw
    assert result.value == vector["response"]["result"]["value"]
    assert result.evidence.effect == "none"
    assert result.evidence.undo is None


@pytest.mark.parametrize(
    ("fixture_name", "capability_id"),
    [
        ("invoke-project-items-list.json", "ae.project.items.list"),
        ("invoke-composition-layers-list.json", "ae.composition.layers.list"),
        (
            "invoke-composition-selected-layers-list.json",
            "ae.composition.selected-layers.list",
        ),
        ("invoke-layer-properties-list.json", "ae.layer.properties.list"),
    ],
)
@pytest.mark.asyncio
async def test_native_navigation_read_timeout_is_safe_to_retry(
    token_file,
    fixture_name,
    capability_id,
):
    wire_request = _fixture(fixture_name)["request"]
    request = NativeInvokeRequest(
        request_id=wire_request["requestId"],
        capability_id=capability_id,
        capability_version=wire_request["params"]["capabilityVersion"],
        arguments=wire_request["params"]["arguments"],
        deadline_unix_ms=wire_request["deadlineUnixMs"],
    )

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
async def test_native_bit_depth_set_preserves_key_replay_and_undo_evidence(token_file):
    request = NativeInvokeRequest(
        request_id="core-bit-depth-set-1",
        capability_id="ae.project.bit-depth.set",
        capability_version=1,
        arguments={
            "targetDepth": 16,
            "idempotencyKey": "bit-depth-intent-0001",
        },
        deadline_unix_ms=_DEADLINE,
    )
    captured: dict = {}
    raw = {
        "capabilityId": "ae.project.bit-depth.set",
        "capabilityVersion": 1,
        "engine": "native-aegp",
        "outcome": "succeeded",
        "replayed": False,
        "value": {
            "changed": True,
            "beforeBitsPerChannel": 8,
            "afterBitsPerChannel": 16,
        },
        "evidence": {
            "engine": "native-aegp",
            "hostInstanceId": _HOST,
            "sessionId": _SESSION,
            "requestId": request.request_id,
            "capabilityId": request.capability_id,
            "capabilityVersion": 1,
            "startedAtUnixMs": _DEADLINE - 100,
            "completedAtUnixMs": _DEADLINE - 50,
            "effect": "committed",
            "requestDigest": "b" * 64,
            "postcondition": {
                "verified": True,
                "kind": "project-bit-depth-set",
                "algorithm": "sha256-rfc8785-jcs-v1",
                "digest": "c" * 64,
            },
            "undo": {"available": True, "verified": False},
        },
    }

    def respond(http_request):
        captured.update(json.loads(http_request.content))
        return Response(200, json={"ok": True, "result": raw})

    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.post("/native/invoke").mock(side_effect=respond)
        result = await HttpBridge("http://127.0.0.1:11488").invoke(request)

    assert captured == request.model_dump(mode="json", by_alias=True)
    assert result.replayed is False
    assert result.value == {
        "changed": True,
        "beforeBitsPerChannel": 8,
        "afterBitsPerChannel": 16,
    }
    assert result.evidence.effect == "committed"
    assert result.evidence.undo is not None
    assert result.evidence.undo.available is True
    assert result.evidence.undo.verified is False
    assert result.evidence.undo.group_id is None


@pytest.mark.asyncio
async def test_native_bit_depth_transport_loss_preserves_side_effect_uncertainty(token_file):
    request = NativeInvokeRequest(
        request_id="core-bit-depth-timeout",
        capability_id="ae.project.bit-depth.set",
        capability_version=1,
        arguments={
            "targetDepth": 32,
            "idempotencyKey": "bit-depth-intent-0003",
        },
        deadline_unix_ms=_DEADLINE,
    )
    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.post("/native/invoke").mock(side_effect=ReadTimeout("lost response"))
        with pytest.raises(NativeBackendError) as raised:
            await HttpBridge("http://127.0.0.1:11488").invoke(request)

    assert raised.value.code == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert raised.value.side_effect == "may-have-occurred"
    assert raised.value.retryable is False
    assert raised.value.recovery.action == "inspect-state"
    assert raised.value.details == {"capabilityId": request.capability_id}


@pytest.mark.asyncio
async def test_native_composition_create_transport_loss_is_not_safe_to_retry(token_file):
    wire_request = _fixture("invoke-composition-create.json")["request"]
    request = NativeInvokeRequest(
        request_id="core-composition-create-timeout",
        capability_id="ae.composition.create",
        capability_version=1,
        arguments=wire_request["params"]["arguments"],
        deadline_unix_ms=_DEADLINE,
    )
    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.post("/native/invoke").mock(side_effect=ReadTimeout("lost response"))
        with pytest.raises(NativeBackendError) as raised:
            await HttpBridge("http://127.0.0.1:11488").invoke(request)

    assert raised.value.code == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert raised.value.side_effect == "may-have-occurred"
    assert raised.value.retryable is False
    assert raised.value.recovery.action == "inspect-state"
    assert "project items" in raised.value.recovery.hint
    assert raised.value.details == {"capabilityId": request.capability_id}


@pytest.mark.asyncio
async def test_native_composition_layer_create_preserves_replay_and_undo(token_file):
    vector = _fixture("invoke-composition-layer-create.json")
    wire_request = vector["request"]
    request = NativeInvokeRequest(
        request_id=wire_request["requestId"],
        capability_id="ae.composition.layer.create",
        capability_version=1,
        arguments=wire_request["params"]["arguments"],
        deadline_unix_ms=wire_request["deadlineUnixMs"],
    )
    raw = {
        **vector["response"]["result"],
        "replayed": True,
    }
    captured: dict = {}

    def respond(http_request):
        captured.update(json.loads(http_request.content))
        return Response(200, json={"ok": True, "result": raw})

    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.post("/native/invoke").mock(side_effect=respond)
        result = await HttpBridge("http://127.0.0.1:11488").invoke(request)

    assert captured == request.model_dump(mode="json", by_alias=True)
    assert result.replayed is True
    assert result.value["kind"] == "solid"
    assert result.evidence.effect == "committed"
    assert result.evidence.undo is not None
    assert result.evidence.undo.available is True
    assert result.evidence.undo.verified is False


@pytest.mark.asyncio
async def test_native_composition_layer_transport_loss_is_not_safe_to_retry(token_file):
    wire_request = _fixture("invoke-composition-layer-create.json")["request"]
    request = NativeInvokeRequest(
        request_id="core-composition-layer-timeout",
        capability_id="ae.composition.layer.create",
        capability_version=1,
        arguments=wire_request["params"]["arguments"],
        deadline_unix_ms=_DEADLINE,
    )
    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.post("/native/invoke").mock(side_effect=ReadTimeout("lost response"))
        with pytest.raises(NativeBackendError) as raised:
            await HttpBridge("http://127.0.0.1:11488").invoke(request)

    assert raised.value.code == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert raised.value.side_effect == "may-have-occurred"
    assert raised.value.retryable is False
    assert raised.value.recovery.action == "inspect-state"
    assert "composition layers" in raised.value.recovery.hint
    assert raised.value.details == {"capabilityId": request.capability_id}


@pytest.mark.asyncio
async def test_native_layer_effect_apply_preserves_replay_and_undo(token_file):
    vector = _fixture("invoke-layer-effect-apply.json")
    wire_request = vector["request"]
    request = NativeInvokeRequest(
        request_id=wire_request["requestId"],
        capability_id="ae.layer.effect.apply",
        capability_version=1,
        arguments=wire_request["params"]["arguments"],
        deadline_unix_ms=wire_request["deadlineUnixMs"],
    )
    raw = {**vector["response"]["result"], "replayed": True}
    captured: dict = {}

    def respond(http_request):
        captured.update(json.loads(http_request.content))
        return Response(200, json={"ok": True, "result": raw})

    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.post("/native/invoke").mock(side_effect=respond)
        result = await HttpBridge("http://127.0.0.1:11488").invoke(request)

    assert captured == request.model_dump(mode="json", by_alias=True)
    assert result.replayed is True
    assert result.value["matchName"] == "ADBE Slider Control"
    assert result.evidence.effect == "committed"
    assert result.evidence.undo is not None
    assert result.evidence.undo.available is True
    assert result.evidence.undo.verified is False


@pytest.mark.asyncio
async def test_native_layer_effect_transport_loss_is_not_safe_to_retry(token_file):
    wire_request = _fixture("invoke-layer-effect-apply.json")["request"]
    request = NativeInvokeRequest(
        request_id="core-layer-effect-timeout",
        capability_id="ae.layer.effect.apply",
        capability_version=1,
        arguments=wire_request["params"]["arguments"],
        deadline_unix_ms=_DEADLINE,
    )
    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.post("/native/invoke").mock(side_effect=ReadTimeout("lost response"))
        with pytest.raises(NativeBackendError) as raised:
            await HttpBridge("http://127.0.0.1:11488").invoke(request)

    assert raised.value.code == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert raised.value.side_effect == "may-have-occurred"
    assert raised.value.retryable is False
    assert raised.value.recovery.action == "inspect-state"
    assert "Effects group" in raised.value.recovery.hint
    assert raised.value.details == {"capabilityId": request.capability_id}


@pytest.mark.asyncio
async def test_native_layer_property_transport_loss_is_not_safe_to_retry(token_file):
    wire_request = _fixture("invoke-layer-property-set.json")["request"]
    request = NativeInvokeRequest(
        request_id="core-layer-property-timeout",
        capability_id="ae.layer.property.set",
        capability_version=1,
        arguments=wire_request["params"]["arguments"],
        deadline_unix_ms=_DEADLINE,
    )
    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.post("/native/invoke").mock(side_effect=ReadTimeout("lost response"))
        with pytest.raises(NativeBackendError) as raised:
            await HttpBridge("http://127.0.0.1:11488").invoke(request)

    assert raised.value.code == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert raised.value.side_effect == "may-have-occurred"
    assert raised.value.retryable is False
    assert raised.value.recovery.action == "inspect-state"
    assert "property" in raised.value.recovery.hint
    assert raised.value.details == {"capabilityId": request.capability_id}


@pytest.mark.asyncio
async def test_native_bit_depth_read_transport_loss_remains_safe_to_retry(token_file):
    request = NativeInvokeRequest(
        request_id="core-bit-depth-read-timeout",
        capability_id="ae.project.bit-depth.read",
        capability_version=1,
        arguments={},
        deadline_unix_ms=_DEADLINE,
    )
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
async def test_native_pairing_error_preserves_fingerprint_and_provenance(token_file):
    pairing = {
        "fingerprint": "12AB-34CD",
        "expiresInMs": 60_000,
        "hostInstanceId": _HOST,
        "sourceCommit": _SOURCE,
    }
    error = {
        "code": "NATIVE_PAIRING_REQUIRED",
        "message": "Approve the matching fingerprint in After Effects.",
        "retryable": True,
        "sideEffect": "not-started",
        "recovery": {
            "action": "approve-pairing",
            "hint": "Approve the fingerprint, then retry.",
        },
        "details": {
            "pairingFingerprint": pairing["fingerprint"],
            "pairingExpiresInMs": pairing["expiresInMs"],
            "hostInstanceId": pairing["hostInstanceId"],
            "sourceCommit": pairing["sourceCommit"],
        },
    }
    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.post("/native/negotiate").mock(
            return_value=Response(
                409,
                json={"ok": False, "error": error, "pairing": pairing},
            )
        )
        backend = HttpBridge("http://127.0.0.1:11488")
        with pytest.raises(NativeBackendError) as raised:
            await backend.negotiate(deadline_unix_ms=_DEADLINE)

    assert raised.value.code == "NATIVE_PAIRING_REQUIRED"
    assert raised.value.retryable is True
    assert raised.value.side_effect == "not-started"
    assert raised.value.recovery.action == "approve-pairing"
    assert raised.value.details == error["details"]


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
        (401, "UNAUTHORIZED", False, "reconnect", "NATIVE_BROKER_UNAUTHORIZED", "refresh-auth"),
        (403, "CLIENT_BLOCKED", False, "none", "NATIVE_CLIENT_BLOCKED", "review-client-access"),
        (503, "ACTIONS_PAUSED", True, "retry", "NATIVE_ACTIONS_PAUSED", "resume-actions"),
    ],
)
@pytest.mark.asyncio
async def test_native_broker_gate_errors_map_to_core_policy(
    token_file,
    status: int,
    host_code: str,
    host_retryable: bool,
    host_action: str,
    expected_code: str,
    expected_action: str,
):
    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.post("/native/negotiate").mock(
            return_value=Response(
                status,
                json={
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
                },
            )
        )
        backend = HttpBridge("http://127.0.0.1:11488")
        with pytest.raises(NativeBackendError) as raised:
            await backend.negotiate(deadline_unix_ms=_DEADLINE)

    assert raised.value.code == expected_code
    assert raised.value.side_effect == "not-started"
    assert raised.value.recovery.action == expected_action


@pytest.mark.parametrize("host_retryable", [False, True])
@pytest.mark.asyncio
async def test_internal_auth_required_is_a_fresh_pairing_outcome(
    token_file,
    host_retryable: bool,
):
    fixture = _broker_fixture("authRequired")
    body = fixture["body"]
    body["error"]["retryable"] = host_retryable
    if host_retryable:
        body["error"]["message"] = "native pairing was expired"
    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.post("/native/negotiate").mock(
            return_value=Response(
                fixture["status"],
                json=body,
            )
        )
        backend = HttpBridge("http://127.0.0.1:11488")
        with pytest.raises(NativeBackendError) as raised:
            await backend.negotiate(deadline_unix_ms=_DEADLINE)

    assert raised.value.code == "NATIVE_PAIRING_REJECTED"
    assert raised.value.code != "NATIVE_BROKER_UNAUTHORIZED"
    assert raised.value.recovery.action == "retry-pairing"
    assert str(raised.value) == body["error"]["message"]


@pytest.mark.asyncio
async def test_internal_contract_mismatch_maps_to_core_contract_error(token_file):
    fixture = _broker_fixture("contractMismatch")
    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.post("/native/negotiate").mock(
            return_value=Response(
                fixture["status"],
                json=fixture["body"],
            )
        )
        backend = HttpBridge("http://127.0.0.1:11488")
        with pytest.raises(NativeBackendError) as raised:
            await backend.negotiate(deadline_unix_ms=_DEADLINE)

    assert raised.value.code == "NATIVE_CONTRACT_MISMATCH"
    assert raised.value.recovery.action == "refresh-capabilities"
    assert str(raised.value) == fixture["body"]["error"]["message"]


@pytest.mark.asyncio
async def test_true_native_wire_error_uses_strict_native_validator(token_file):
    error = _fixture("errors.json")["responses"]["queueFull"]["error"]
    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.post("/native/negotiate").mock(
            return_value=Response(503, json={"ok": False, "error": error})
        )
        backend = HttpBridge("http://127.0.0.1:11488")
        with pytest.raises(NativeBackendError) as raised:
            await backend.negotiate(deadline_unix_ms=_DEADLINE)

    assert raised.value.code == "QUEUE_FULL"
    assert raised.value.recovery.action == "retry"
    assert raised.value.recovery.retry_after_ms == 250


@pytest.mark.asyncio
async def test_pairing_failure_without_closed_pairing_envelope_fails_closed(token_file):
    error = {
        "code": "NATIVE_PAIRING_REQUIRED",
        "message": "Pairing required.",
        "retryable": True,
        "sideEffect": "not-started",
        "recovery": {
            "action": "approve-pairing",
            "hint": "Approve the matching fingerprint.",
        },
        "details": {
            "pairingFingerprint": "12AB-34CD",
            "pairingExpiresInMs": 60_000,
            "hostInstanceId": _HOST,
            "sourceCommit": _SOURCE,
        },
    }
    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.post("/native/negotiate").mock(
            return_value=Response(409, json={"ok": False, "error": error})
        )
        backend = HttpBridge("http://127.0.0.1:11488")
        with pytest.raises(NativeBackendError) as raised:
            await backend.negotiate(deadline_unix_ms=_DEADLINE)

    assert raised.value.code == "NATIVE_CONTRACT_MISMATCH"


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
        mock.post("/native/negotiate").mock(
            return_value=Response(200, json=body)
        )
        backend = HttpBridge("http://127.0.0.1:11488")
        with pytest.raises(NativeBackendError) as raised:
            await backend.negotiate(deadline_unix_ms=_DEADLINE)

    assert raised.value.code == "NATIVE_CONTRACT_MISMATCH"


@pytest.mark.parametrize(
    "body",
    [
        {
            "ok": False,
            "error": {
                "code": "UNAUTHORIZED",
                "message": "unauthorized",
                "retryable": False,
                "sideEffect": "not-started",
                "recovery": {"action": "reconnect", "hint": "Reload token."},
            },
            "extra": True,
        },
        {
            "ok": False,
            "error": {
                "code": "UNAUTHORIZED",
                "message": "unauthorized",
                "retryable": False,
                "recovery": {"action": "reconnect", "hint": "Reload token."},
            },
        },
        {
            "ok": False,
            "error": {
                "code": "UNAUTHORIZED",
                "message": "unauthorized",
                "retryable": False,
                "sideEffect": "not-started",
                "recovery": {"action": "reconnect", "hint": "Reload token."},
                "extra": True,
            },
        },
        {
            "ok": False,
            "error": {
                "code": "UNAUTHORIZED",
                "message": "unauthorized",
                "retryable": False,
                "sideEffect": "not-started",
                "recovery": {
                    "action": "reconnect",
                    "hint": "Reload token.",
                    "extra": True,
                },
            },
        },
        {
            "ok": False,
            "error": {
                "code": "ACTIONS_PAUSED",
                "message": "paused",
                "retryable": True,
                "sideEffect": "not-started",
                "recovery": {"action": "none", "hint": "Resume actions."},
            },
        },
    ],
)
@pytest.mark.asyncio
async def test_malformed_broker_failure_envelopes_fail_closed(token_file, body):
    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.post("/native/negotiate").mock(
            return_value=Response(503 if body["error"]["code"] == "ACTIONS_PAUSED" else 401, json=body)
        )
        backend = HttpBridge("http://127.0.0.1:11488")
        with pytest.raises(NativeBackendError) as raised:
            await backend.negotiate(deadline_unix_ms=_DEADLINE)

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
        backend = HttpBridge("http://127.0.0.1:11488")
        with pytest.raises(NativeBackendError) as raised:
            await backend.negotiate(deadline_unix_ms=_DEADLINE)

    assert raised.value.code == "NATIVE_CONTRACT_MISMATCH"


@pytest.mark.asyncio
async def test_native_cancellation_before_dispatch_makes_no_http_request(token_file):
    cancellation = NativeCancellationToken()
    cancellation.cancel()
    async with respx.mock(
        base_url="http://127.0.0.1:11488",
        assert_all_called=False,
    ) as mock:
        route = mock.post("/native/negotiate").mock(
            return_value=Response(200, json={"ok": True, "result": _negotiation()})
        )
        backend = HttpBridge("http://127.0.0.1:11488")
        with pytest.raises(NativeBackendError) as raised:
            await backend.negotiate(
                deadline_unix_ms=_DEADLINE,
                cancellation=cancellation,
            )

    assert raised.value.code == "CANCELLED"
    assert route.called is False
