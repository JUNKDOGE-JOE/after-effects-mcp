"""Typed Core contract for applying one installed effect through native AEGP."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from ae_mcp.backends import native as N
from ae_mcp.handlers import HANDLERS, load_all
from ae_mcp.handlers import native as native_handler
from ae_mcp.server import build_server


ROOT = Path(__file__).resolve().parents[3]
FIXTURE_ROOT = ROOT / "native" / "ae-plugin" / "protocol" / "fixtures"
HOST = "22222222-2222-4222-8222-222222222222"
SESSION = "11111111-1111-4111-8111-111111111111"


def _json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


VECTOR = _json(FIXTURE_ROOT / "invoke-layer-effect-apply.json")
INPUT = VECTOR["request"]["params"]["arguments"]
RESULT = VECTOR["response"]["result"]


def _descriptor() -> N.NativeCapabilityDescriptor:
    items = _json(FIXTURE_ROOT / "capabilities.json")["response"]["result"]["items"]
    return N.NativeCapabilityDescriptor.model_validate(
        next(item for item in items if item["id"] == N.LAYER_EFFECT_APPLY_CAPABILITY_ID)
    )


class ApplyBackend(N.NativeInvokeBackend):
    name = "layer-effect-apply-fixture"

    def __init__(self) -> None:
        self.items = (_descriptor(),)
        self.negotiation = N.NativeNegotiation(
            selected_wire_version=1,
            plugin_version="0.9.2",
            compiled_sdk_version="25.6.61",
            source_commit="a" * 40,
            host_instance_id=HOST,
            host_platform="macos-arm64",
            session_id=SESSION,
            session_generation=3,
            capabilities_digest=N._capabilities_registry_digest(self.items),
        )
        self.requests: list[N.NativeInvokeRequest] = []
        self.replayed = False
        self.tamper_postcondition = False

    async def negotiate(self, **_kwargs):
        return self.negotiation

    async def capabilities(self, *, ids, detail, limit, **_kwargs):
        assert ids is None and detail == "full" and limit == 100
        return N.NativeCapabilities(
            session_id=SESSION,
            detail="full",
            items=self.items,
            next_cursor=None,
            query_digest=N._capabilities_query_digest(
                session_id=SESSION, ids=None, detail="full", limit=100
            ),
            capabilities_digest=self.negotiation.capabilities_digest,
        )

    async def invoke(self, request, *, cancellation=None):
        del cancellation
        self.requests.append(request)
        raw = json.loads(json.dumps(RESULT))
        raw["evidence"]["requestId"] = request.request_id
        raw["evidence"]["startedAtUnixMs"] = request.deadline_unix_ms - 100
        raw["evidence"]["completedAtUnixMs"] = request.deadline_unix_ms - 1
        raw["evidence"]["requestDigest"] = N._invoke_request_digest(
            request, self.negotiation
        )
        value = N.LayerEffectApplyValue.model_validate(raw["value"])
        raw["evidence"]["postcondition"]["digest"] = (
            "0" * 64
            if self.tamper_postcondition
            else N._layer_effect_apply_digest(value)
        )
        raw["replayed"] = self.replayed
        return N.NativeInvokeResult.model_validate(raw)


def _deadline() -> int:
    return int(time.time() * 1000) + 5_000


async def _invoke(backend: ApplyBackend, *, request_id: str = "core-effect-apply-1"):
    return await N.invoke_layer_effect_apply(
        backend,
        request_id=request_id,
        layer_locator=INPUT["layerLocator"],
        effect_match_name=INPUT["effectMatchName"],
        idempotency_key=INPUT["idempotencyKey"],
        deadline_unix_ms=_deadline(),
    )


@pytest.mark.asyncio
async def test_apply_effect_binds_exact_match_name_and_returns_fresh_verified_locator():
    backend = ApplyBackend()
    execution = await _invoke(backend)

    assert backend.requests[0].arguments == INPUT
    assert execution.value.match_name == "ADBE Slider Control"
    assert execution.value.effect_count_after == execution.value.effect_count_before + 1
    assert (
        execution.value.matching_effect_count_after
        == execution.value.matching_effect_count_before + 1
    )
    assert execution.value.layer_locator.generation == 9
    assert execution.value.layer_locator.project_id != INPUT["layerLocator"]["projectId"]
    assert execution.evidence.undo is not None
    assert execution.evidence.undo.available is True
    assert execution.evidence.undo.verified is False
    assert execution.audit_fields()["undoVerified"] is False


@pytest.mark.asyncio
async def test_apply_effect_replay_is_exposed_without_dispatching_a_second_request():
    backend = ApplyBackend()
    backend.replayed = True
    execution = await _invoke(backend, request_id="core-effect-apply-replay")

    assert len(backend.requests) == 1
    assert execution.replayed is True
    assert execution.audit_fields()["replayed"] is True


def test_apply_effect_models_reject_wrong_locator_surrogates_and_unverified_counts():
    with pytest.raises(ValidationError):
        N.LayerEffectApplyArguments.model_validate(
            {
                "layerLocator": {**INPUT["layerLocator"], "kind": "composition"},
                "effectMatchName": INPUT["effectMatchName"],
                "idempotencyKey": INPUT["idempotencyKey"],
            }
        )
    with pytest.raises(ValidationError):
        N.LayerEffectApplyArguments.model_validate(
            {
                "layerLocator": INPUT["layerLocator"],
                "effectMatchName": "bad\ud800match",
                "idempotencyKey": INPUT["idempotencyKey"],
            }
        )
    malformed = dict(RESULT["value"])
    malformed["effectCountAfter"] = malformed["effectCountBefore"]
    with pytest.raises(ValidationError):
        N.LayerEffectApplyValue.model_validate(malformed)


@pytest.mark.asyncio
async def test_stale_layer_locator_fails_before_dispatch_with_refresh_recovery():
    backend = ApplyBackend()
    locator = dict(INPUT["layerLocator"])
    locator["sessionId"] = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    with pytest.raises(N.NativeBackendError) as raised:
        await N.invoke_layer_effect_apply(
            backend,
            request_id="core-effect-apply-stale",
            layer_locator=locator,
            effect_match_name=INPUT["effectMatchName"],
            idempotency_key="synthetic-effect-apply-stale",
            deadline_unix_ms=_deadline(),
        )

    assert backend.requests == []
    assert raised.value.code == "STALE_LOCATOR"
    assert raised.value.side_effect == "not-started"
    assert raised.value.recovery.action == "refresh-locator"


@pytest.mark.asyncio
async def test_tampered_effect_postcondition_is_uncertain_and_never_retried():
    backend = ApplyBackend()
    backend.tamper_postcondition = True
    with pytest.raises(N.NativeBackendError) as raised:
        await _invoke(backend, request_id="core-effect-apply-tampered")

    assert len(backend.requests) == 1
    assert raised.value.code == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert raised.value.retryable is False
    assert raised.value.side_effect == "may-have-occurred"
    assert raised.value.recovery.action == "inspect-state"


@pytest.mark.asyncio
async def test_public_handler_returns_typed_provenance_and_audit(monkeypatch):
    backend = ApplyBackend()
    monkeypatch.setattr(native_handler._discovery, "select_backend", lambda: backend)
    schema_cls, runner = HANDLERS["ae.applyLayerEffect"]

    response = await runner(
        schema_cls(
            layer_locator=INPUT["layerLocator"],
            effect_match_name=INPUT["effectMatchName"],
            idempotency_key=INPUT["idempotencyKey"],
        ),
        None,
    )

    assert response["ok"] is True
    assert response["value"]["matchName"] == INPUT["effectMatchName"]
    assert response["implementation"]["engine"] == "native-aegp"
    assert response["provenance"]["sourceCommit"] == "a" * 40
    assert response["audit"]["undoAvailable"] is True
    assert response["audit"]["undoVerified"] is False


@pytest.mark.asyncio
async def test_public_mcp_schema_rejects_malformed_match_name_before_dispatch(monkeypatch):
    load_all()
    schema_cls, _ = HANDLERS["ae.applyLayerEffect"]

    async def _must_not_dispatch(_validated, _ctx):
        pytest.fail("invalid public MCP arguments reached the native handler")

    monkeypatch.setitem(
        HANDLERS,
        "ae.applyLayerEffect",
        (schema_cls, _must_not_dispatch),
    )
    result = await build_server()._ae_call_tool(
        "ae_applyLayerEffect",
        {
            "layer_locator": INPUT["layerLocator"],
            "effect_match_name": "x" * 48,
            "idempotency_key": INPUT["idempotencyKey"],
        },
    )

    assert result.isError is True
    payload = json.loads(result.content[0].text)
    assert payload["error"]["code"] == "INVALID_ARGUMENT"
    assert payload["error"]["sideEffect"] == "not-started"
    assert payload["error"]["recovery"]["action"] == "change-arguments"
    assert payload["error"]["details"] == {
        "field": "arguments.effect_match_name",
        "capabilityId": "ae.layer.effect.apply",
    }
