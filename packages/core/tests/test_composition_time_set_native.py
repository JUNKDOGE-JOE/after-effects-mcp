"""Typed Core contract for the native undoable composition-time write."""

from __future__ import annotations

import json
import time
from fractions import Fraction
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from ae_mcp.backends import native as N


HOST = "22222222-2222-4222-8222-222222222222"
SESSION = "11111111-1111-4111-8111-111111111111"
ROOT = Path(__file__).resolve().parents[3]
SCHEMA_PATH = ROOT / "native" / "ae-plugin" / "protocol" / "aegp-rpc.schema.json"
FIXTURE_ROOT = ROOT / "native" / "ae-plugin" / "protocol" / "fixtures"


def _json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _locator(*, session_id: str = SESSION) -> dict[str, Any]:
    return {
        "kind": "composition",
        "hostInstanceId": HOST,
        "sessionId": session_id,
        "projectId": "44444444-4444-4444-8444-444444444444",
        "generation": 8,
        "objectId": "66666666-6666-4666-8666-666666666666",
    }


def _descriptor() -> N.NativeCapabilityDescriptor:
    raw = _json(FIXTURE_ROOT / "capabilities.json")["response"]["result"]["items"]
    return N.NativeCapabilityDescriptor.model_validate(
        next(item for item in raw if item["id"] == N.COMPOSITION_TIME_SET_CAPABILITY_ID)
    )


def _time(value: int, scale: int) -> dict[str, Any]:
    return {
        "value": value,
        "scale": scale,
        "secondsRational": str(Fraction(value, scale)),
    }


class CompositionTimeSetBackend(N.NativeInvokeBackend):
    name = "composition-time-set-fixture"

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
        self.tamper_postcondition = False
        self.malformed_transition = False

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
        target = request.arguments["targetTime"]
        before = _time(target["value"], target["scale"])
        if not self.malformed_transition:
            before = _time(0 if target["value"] != 0 else 1, target["scale"])
        value = {
            "changed": True,
            "compositionLocator": request.arguments["compositionLocator"],
            "beforeTime": before,
            "afterTime": _time(target["value"], target["scale"]),
        }
        try:
            digest = N._composition_time_set_digest(
                N.CompositionTimeSetValue.model_validate(value)
            )
        except ValidationError:
            digest = "e" * 64
        if self.tamper_postcondition:
            digest = "f" * 64
        return N.NativeInvokeResult(
            capability_id=request.capability_id,
            capability_version=request.capability_version,
            engine="native-aegp",
            outcome="succeeded",
            replayed=False,
            value=value,
            evidence=N.NativeExecutionEvidence(
                engine="native-aegp",
                host_instance_id=HOST,
                session_id=SESSION,
                request_id=request.request_id,
                capability_id=request.capability_id,
                capability_version=request.capability_version,
                started_at_unix_ms=request.deadline_unix_ms - 100,
                completed_at_unix_ms=request.deadline_unix_ms - 1,
                effect="committed",
                request_digest=N._invoke_request_digest(request, self.negotiation),
                postcondition=N.NativePostconditionEvidence(
                    verified=True,
                    kind="composition-time-set",
                    algorithm="sha256-rfc8785-jcs-v1",
                    digest=digest,
                ),
                undo=N.NativeUndoEvidence(available=True, verified=False),
            ),
        )


def test_core_write_contract_matches_protocol_and_digest():
    schema = _json(SCHEMA_PATH)
    input_schema = schema["$defs"]["compositionTimeSetInputSchemaContract"]["const"]
    result_schema = schema["$defs"]["compositionTimeSetResultSchemaContract"]["const"]

    assert N._COMPOSITION_TIME_SET_INPUT_SCHEMA == input_schema
    assert N._COMPOSITION_TIME_SET_RESULT_SCHEMA == result_schema
    assert input_schema["required"] == [
        "compositionLocator",
        "targetTime",
        "idempotencyKey",
    ]
    assert result_schema["required"] == [
        "changed",
        "compositionLocator",
        "beforeTime",
        "afterTime",
    ]
    assert N.COMPOSITION_TIME_SET_CONTRACT_DIGEST == N._sha256_closed_json(
        {"inputSchema": input_schema, "resultSchema": result_schema}
    )


def test_write_value_rejects_rationally_equal_before_and_after_times():
    with pytest.raises(ValidationError):
        N.CompositionTimeSetValue.model_validate(
            {
                "changed": True,
                "compositionLocator": _locator(),
                "beforeTime": _time(1, 2),
                "afterTime": _time(2, 4),
            }
        )


@pytest.mark.asyncio
async def test_invoke_binds_exact_target_idempotency_undo_and_postcondition():
    backend = CompositionTimeSetBackend()
    execution = await N.invoke_composition_time_set(
        backend,
        request_id="composition-time-set-1",
        composition_locator=_locator(),
        target_time={"value": 5, "scale": 2},
        idempotency_key="composition-time-intent-0001",
        deadline_unix_ms=int(time.time() * 1000) + 5_000,
    )

    assert len(backend.requests) == 1
    assert backend.requests[0].arguments == {
        "compositionLocator": _locator(),
        "targetTime": {"value": 5, "scale": 2},
        "idempotencyKey": "composition-time-intent-0001",
    }
    assert execution.value.after_time.seconds_rational == "5/2"
    assert execution.evidence.effect == "committed"
    assert execution.evidence.undo is not None
    assert execution.evidence.undo.available is True
    assert execution.evidence.undo.verified is False
    assert execution.audit_fields()["undoVerified"] is False


@pytest.mark.asyncio
async def test_stale_locator_fails_before_dispatch_with_refresh_recovery():
    backend = CompositionTimeSetBackend()
    with pytest.raises(N.NativeBackendError) as raised:
        await N.invoke_composition_time_set(
            backend,
            request_id="composition-time-set-stale",
            composition_locator=_locator(
                session_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
            ),
            target_time={"value": 1, "scale": 1},
            idempotency_key="composition-time-intent-0002",
            deadline_unix_ms=int(time.time() * 1000) + 5_000,
        )

    assert backend.requests == []
    assert raised.value.code == "STALE_LOCATOR"
    assert raised.value.side_effect == "not-started"
    assert raised.value.recovery.action == "refresh-locator"


@pytest.mark.asyncio
async def test_unverified_write_result_is_side_effecting_and_never_retried():
    backend = CompositionTimeSetBackend()
    backend.tamper_postcondition = True
    with pytest.raises(N.NativeBackendError) as raised:
        await N.invoke_composition_time_set(
            backend,
            request_id="composition-time-set-tampered",
            composition_locator=_locator(),
            target_time={"value": 1, "scale": 1},
            idempotency_key="composition-time-intent-0003",
            deadline_unix_ms=int(time.time() * 1000) + 5_000,
        )

    assert len(backend.requests) == 1
    assert raised.value.code == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert raised.value.side_effect == "may-have-occurred"
    assert raised.value.retryable is False
    assert raised.value.recovery.action == "inspect-state"


@pytest.mark.asyncio
async def test_no_state_transition_is_a_side_effecting_verification_failure():
    backend = CompositionTimeSetBackend()
    backend.malformed_transition = True
    with pytest.raises(N.NativeBackendError) as raised:
        await N.invoke_composition_time_set(
            backend,
            request_id="composition-time-set-noop",
            composition_locator=_locator(),
            target_time={"value": 1, "scale": 1},
            idempotency_key="composition-time-intent-0004",
            deadline_unix_ms=int(time.time() * 1000) + 5_000,
        )

    assert len(backend.requests) == 1
    assert raised.value.code == "POSSIBLY_SIDE_EFFECTING_FAILURE"
