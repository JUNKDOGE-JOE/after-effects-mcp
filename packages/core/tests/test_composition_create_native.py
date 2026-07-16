"""Typed Core contract for native root-composition creation."""

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


VECTOR = _json(FIXTURE_ROOT / "invoke-composition-create.json")
INPUT = VECTOR["request"]["params"]["arguments"]
RESULT = VECTOR["response"]["result"]
LAYERS_VECTOR = _json(FIXTURE_ROOT / "invoke-composition-layers-list.json")
LAYERS_RESULT = LAYERS_VECTOR["response"]["result"]


def _descriptor(capability_id: str) -> N.NativeCapabilityDescriptor:
    items = _json(FIXTURE_ROOT / "capabilities.json")["response"]["result"]["items"]
    return N.NativeCapabilityDescriptor.model_validate(
        next(item for item in items if item["id"] == capability_id)
    )


class CreateBackend(N.NativeInvokeBackend):
    name = "composition-create-fixture"

    def __init__(self) -> None:
        self.items = (
            _descriptor(N.COMPOSITION_CREATE_CAPABILITY_ID),
            _descriptor(N.COMPOSITION_LAYERS_LIST_CAPABILITY_ID),
        )
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
        self.replay_check_stale = False

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
        if request.capability_id == N.COMPOSITION_LAYERS_LIST_CAPABILITY_ID:
            if self.replay_check_stale:
                raise N._structured_error(
                    "STALE_LOCATOR",
                    "compositionLocator no longer resolves",
                    details={
                        "field": "params.arguments.compositionLocator",
                        "capabilityId": N.COMPOSITION_LAYERS_LIST_CAPABILITY_ID,
                    },
                )
            raw = json.loads(json.dumps(LAYERS_RESULT))
            raw["value"].update(
                {
                    "compositionLocator": request.arguments["compositionLocator"],
                    "compositionName": INPUT["name"],
                    "total": 0,
                    "offset": request.arguments["offset"],
                    "limit": request.arguments["limit"],
                    "returned": 0,
                    "hasMore": False,
                    "nextOffset": None,
                    "layers": [],
                }
            )
            raw["evidence"]["requestId"] = request.request_id
            raw["evidence"]["startedAtUnixMs"] = request.deadline_unix_ms - 100
            raw["evidence"]["completedAtUnixMs"] = request.deadline_unix_ms - 1
            raw["evidence"]["requestDigest"] = N._invoke_request_digest(
                request, self.negotiation
            )
            value = N.CompositionLayersListValue.model_validate(raw["value"])
            raw["evidence"]["postcondition"]["digest"] = (
                N._composition_layers_list_digest(value)
            )
            raw["replayed"] = False
            return N.NativeInvokeResult.model_validate(raw)
        raw = json.loads(json.dumps(RESULT))
        raw["evidence"]["requestId"] = request.request_id
        raw["evidence"]["startedAtUnixMs"] = request.deadline_unix_ms - 100
        raw["evidence"]["completedAtUnixMs"] = request.deadline_unix_ms - 1
        raw["evidence"]["requestDigest"] = N._invoke_request_digest(
            request, self.negotiation
        )
        value = N.CompositionCreateValue.model_validate(raw["value"])
        raw["evidence"]["postcondition"]["digest"] = (
            "0" * 64
            if self.tamper_postcondition
            else N._composition_create_digest(value)
        )
        raw["replayed"] = self.replayed
        return N.NativeInvokeResult.model_validate(raw)


def _deadline() -> int:
    return int(time.time() * 1000) + 5_000


@pytest.mark.asyncio
async def test_create_binds_exact_settings_and_returns_verified_fresh_locator():
    backend = CreateBackend()
    execution = await N.invoke_composition_create(
        backend,
        request_id="core-composition-create-1",
        name=INPUT["name"],
        width=INPUT["width"],
        height=INPUT["height"],
        duration=INPUT["duration"],
        frame_rate=INPUT["frameRate"],
        pixel_aspect_ratio=INPUT["pixelAspectRatio"],
        idempotency_key=INPUT["idempotencyKey"],
        deadline_unix_ms=_deadline(),
    )

    assert backend.requests[0].arguments == INPUT
    assert execution.value.project_item_count_after == 2
    assert execution.value.project_item_count_before == 1
    assert execution.value.layer_count == 0
    assert execution.value.duration.seconds_rational == "5"
    assert execution.value.frame_rate.rational == "24"
    assert execution.value.composition_locator.generation == 9
    assert execution.evidence.undo is not None
    assert execution.evidence.undo.available is True
    assert execution.evidence.undo.verified is False
    assert execution.audit_fields()["undoVerified"] is False


@pytest.mark.asyncio
async def test_verified_transport_replay_is_revalidated_before_exposure():
    backend = CreateBackend()
    backend.replayed = True
    execution = await N.invoke_composition_create(
        backend,
        request_id="core-composition-create-replay",
        name=INPUT["name"],
        width=INPUT["width"],
        height=INPUT["height"],
        duration=INPUT["duration"],
        frame_rate=INPUT["frameRate"],
        pixel_aspect_ratio=INPUT["pixelAspectRatio"],
        idempotency_key=INPUT["idempotencyKey"],
        deadline_unix_ms=_deadline(),
    )

    assert len(backend.requests) == 2
    assert (
        backend.requests[1].capability_id
        == N.COMPOSITION_LAYERS_LIST_CAPABILITY_ID
    )
    assert execution.replayed is True
    assert execution.audit_fields()["replayed"] is True


@pytest.mark.asyncio
async def test_transport_replay_with_stale_composition_requires_state_inspection():
    backend = CreateBackend()
    backend.replayed = True
    backend.replay_check_stale = True

    with pytest.raises(N.NativeBackendError) as raised:
        await N.invoke_composition_create(
            backend,
            request_id="core-composition-create-stale-replay",
            name=INPUT["name"],
            width=INPUT["width"],
            height=INPUT["height"],
            duration=INPUT["duration"],
            frame_rate=INPUT["frameRate"],
            pixel_aspect_ratio=INPUT["pixelAspectRatio"],
            idempotency_key=INPUT["idempotencyKey"],
            deadline_unix_ms=_deadline(),
        )

    assert len(backend.requests) == 2
    assert raised.value.code == "DUPLICATE_REQUEST"
    assert raised.value.retryable is False
    assert raised.value.side_effect == "not-started"
    assert raised.value.recovery.action == "inspect-state"
    assert raised.value.details == {
        "field": "params.arguments.idempotencyKey",
        "capabilityId": N.COMPOSITION_CREATE_CAPABILITY_ID,
    }


def test_create_models_reject_surrogates_non_positive_duration_and_bad_counts():
    for bad in (
        {**INPUT, "name": "bad\ud800name"},
        {**INPUT, "duration": {"value": 0, "scale": 1}},
        {**INPUT, "frameRate": {"numerator": 0, "denominator": 1}},
    ):
        with pytest.raises(ValidationError):
            N.CompositionCreateArguments.model_validate(bad)
    malformed = dict(RESULT["value"])
    malformed["projectItemCountAfter"] = malformed["projectItemCountBefore"]
    with pytest.raises(ValidationError):
        N.CompositionCreateValue.model_validate(malformed)


@pytest.mark.asyncio
async def test_tampered_postcondition_is_uncertain_and_never_retried():
    backend = CreateBackend()
    backend.tamper_postcondition = True
    with pytest.raises(N.NativeBackendError) as raised:
        await N.invoke_composition_create(
            backend,
            request_id="core-composition-create-tampered",
            name=INPUT["name"],
            width=INPUT["width"],
            height=INPUT["height"],
            duration=INPUT["duration"],
            frame_rate=INPUT["frameRate"],
            pixel_aspect_ratio=INPUT["pixelAspectRatio"],
            idempotency_key="synthetic-comp-create-0003",
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
    schema_cls, _ = HANDLERS["ae.createComposition"]

    async def _must_not_dispatch(_validated, _ctx):
        pytest.fail("invalid public MCP arguments reached the native handler")

    monkeypatch.setitem(HANDLERS, "ae.createComposition", (schema_cls, _must_not_dispatch))
    result = await build_server()._ae_call_tool(
        "ae_createComposition",
        {
            "name": "SYNTHETIC_COMP",
            "duration": {"value": 0, "scale": 1},
            "idempotency_key": "synthetic-comp-create-0004",
        },
    )

    assert result.isError is True
    payload = json.loads(result.content[0].text)
    assert payload["error"]["code"] == "INVALID_ARGUMENT"
    assert payload["error"]["sideEffect"] == "not-started"
    assert payload["error"]["recovery"]["action"] == "change-arguments"
    assert payload["error"]["details"] == {
        "field": "arguments",
        "capabilityId": "ae.composition.create",
    }
