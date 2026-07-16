"""Typed Core contract for native null and solid composition-layer creation."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from ae_mcp.backends import native as N
from ae_mcp.handlers import HANDLERS, load_all
from ae_mcp.server import build_server


ROOT = Path(__file__).resolve().parents[3]
FIXTURE_ROOT = ROOT / "native" / "ae-plugin" / "protocol" / "fixtures"
HOST = "22222222-2222-4222-8222-222222222222"
SESSION = "11111111-1111-4111-8111-111111111111"


def _json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


VECTOR = _json(FIXTURE_ROOT / "invoke-composition-layer-create.json")
INPUT = VECTOR["request"]["params"]["arguments"]
RESULT = VECTOR["response"]["result"]


def _descriptor() -> N.NativeCapabilityDescriptor:
    items = _json(FIXTURE_ROOT / "capabilities.json")["response"]["result"]["items"]
    return N.NativeCapabilityDescriptor.model_validate(
        next(item for item in items if item["id"] == N.COMPOSITION_LAYER_CREATE_CAPABILITY_ID)
    )


class CreateBackend(N.NativeInvokeBackend):
    name = "composition-layer-create-fixture"

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
        value = N.CompositionLayerCreateValue.model_validate(raw["value"])
        raw["evidence"]["postcondition"]["digest"] = (
            "0" * 64
            if self.tamper_postcondition
            else N._composition_layer_create_digest(value)
        )
        raw["replayed"] = self.replayed
        return N.NativeInvokeResult.model_validate(raw)


def _deadline() -> int:
    return int(time.time() * 1000) + 5_000


@pytest.mark.asyncio
async def test_create_solid_binds_exact_options_and_returns_fresh_verified_locators():
    backend = CreateBackend()
    execution = await N.invoke_composition_layer_create(
        backend,
        request_id="core-composition-layer-create-1",
        composition_locator=INPUT["compositionLocator"],
        kind="solid",
        name="SYNTHETIC_SOLID",
        color=INPUT["color"],
        width=640,
        height=360,
        duration={"value": 5, "scale": 1},
        idempotency_key="synthetic-layer-create-0001",
        deadline_unix_ms=_deadline(),
    )

    assert backend.requests[0].arguments == INPUT
    assert execution.value.layer_count_after == execution.value.layer_count_before + 1
    assert execution.value.composition_locator.generation == 9
    assert execution.value.composition_locator.project_id != INPUT["compositionLocator"]["projectId"]
    assert execution.value.solid is not None
    assert execution.value.solid.duration.seconds_rational == "5"
    assert execution.evidence.undo is not None
    assert execution.evidence.undo.available is True
    assert execution.evidence.undo.verified is False
    assert execution.audit_fields()["undoVerified"] is False


@pytest.mark.asyncio
async def test_verified_transport_replay_is_exposed_without_changing_the_value():
    backend = CreateBackend()
    backend.replayed = True
    execution = await N.invoke_composition_layer_create(
        backend,
        request_id="core-composition-layer-create-replay",
        composition_locator=INPUT["compositionLocator"],
        kind="solid",
        name="SYNTHETIC_SOLID",
        color=INPUT["color"],
        width=640,
        height=360,
        duration={"value": 5, "scale": 1},
        idempotency_key="synthetic-layer-create-0001",
        deadline_unix_ms=_deadline(),
    )

    assert len(backend.requests) == 1
    assert execution.replayed is True
    assert execution.audit_fields()["replayed"] is True


def test_create_models_reject_null_options_surrogates_and_unverified_counts():
    with pytest.raises(ValidationError):
        N.CompositionLayerCreateArguments.model_validate(
            {
                "compositionLocator": INPUT["compositionLocator"],
                "kind": "null",
                "name": "Null",
                "width": 640,
                "idempotencyKey": "synthetic-null-create-0001",
            }
        )
    with pytest.raises(ValidationError):
        N.CompositionLayerCreateArguments.model_validate(
            {
                "compositionLocator": INPUT["compositionLocator"],
                "kind": "null",
                "name": "bad\ud800name",
                "idempotencyKey": "synthetic-null-create-0002",
            }
        )
    malformed = dict(RESULT["value"])
    malformed["layerCountAfter"] = malformed["layerCountBefore"]
    with pytest.raises(ValidationError):
        N.CompositionLayerCreateValue.model_validate(malformed)


@pytest.mark.asyncio
async def test_stale_locator_fails_before_dispatch_with_refresh_recovery():
    backend = CreateBackend()
    locator = dict(INPUT["compositionLocator"])
    locator["sessionId"] = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    with pytest.raises(N.NativeBackendError) as raised:
        await N.invoke_composition_layer_create(
            backend,
            request_id="core-composition-layer-create-stale",
            composition_locator=locator,
            kind="null",
            name="Null",
            color=None,
            width=None,
            height=None,
            duration=None,
            idempotency_key="synthetic-null-create-0003",
            deadline_unix_ms=_deadline(),
        )

    assert backend.requests == []
    assert raised.value.code == "STALE_LOCATOR"
    assert raised.value.side_effect == "not-started"
    assert raised.value.recovery.action == "refresh-locator"


@pytest.mark.asyncio
async def test_tampered_postcondition_is_uncertain_and_never_retried():
    backend = CreateBackend()
    backend.tamper_postcondition = True
    with pytest.raises(N.NativeBackendError) as raised:
        await N.invoke_composition_layer_create(
            backend,
            request_id="core-composition-layer-create-tampered",
            composition_locator=INPUT["compositionLocator"],
            kind="solid",
            name="SYNTHETIC_SOLID",
            color=INPUT["color"],
            width=640,
            height=360,
            duration={"value": 5, "scale": 1},
            idempotency_key="synthetic-layer-create-0004",
            deadline_unix_ms=_deadline(),
        )

    assert len(backend.requests) == 1
    assert raised.value.code == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert raised.value.retryable is False
    assert raised.value.side_effect == "may-have-occurred"
    assert raised.value.recovery.action == "inspect-state"


@pytest.mark.asyncio
async def test_public_mcp_schema_is_registered_and_rejects_before_dispatch(monkeypatch):
    load_all()
    schema_cls, _ = HANDLERS["ae.createCompositionLayer"]

    async def _must_not_dispatch(_validated, _ctx):
        pytest.fail("invalid public MCP arguments reached the native handler")

    monkeypatch.setitem(
        HANDLERS,
        "ae.createCompositionLayer",
        (schema_cls, _must_not_dispatch),
    )
    result = await build_server()._ae_call_tool(
        "ae_createCompositionLayer",
        {
            "composition_locator": INPUT["compositionLocator"],
            "kind": "null",
            "name": "Null",
            "width": 640,
            "idempotency_key": "synthetic-null-create-0005",
        },
    )

    assert result.isError is True
    payload = json.loads(result.content[0].text)
    assert payload["error"]["code"] == "INVALID_ARGUMENT"
    assert payload["error"]["sideEffect"] == "not-started"
    assert payload["error"]["recovery"]["action"] == "change-arguments"
    assert payload["error"]["details"] == {
        "field": "arguments",
        "capabilityId": "ae.composition.layer.create",
    }
