"""Typed Core contract for the native composition-current-time read."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from ae_mcp.backends import native as N


HOST = "22222222-2222-4222-8222-222222222222"
SESSION = "11111111-1111-4111-8111-111111111111"
PROJECT = "33333333-3333-4333-8333-333333333333"
COMPOSITION = "66666666-6666-4666-8666-666666666666"
PROTOCOL_SCHEMA = (
    Path(__file__).resolve().parents[3]
    / "native"
    / "ae-plugin"
    / "protocol"
    / "aegp-rpc.schema.json"
)


def composition_locator(*, session_id: str = SESSION) -> dict[str, Any]:
    return {
        "kind": "composition",
        "hostInstanceId": HOST,
        "sessionId": session_id,
        "projectId": PROJECT,
        "generation": 7,
        "objectId": COMPOSITION,
    }


def descriptor() -> N.NativeCapabilityDescriptor:
    return N.NativeCapabilityDescriptor(
        detail="full",
        id=N.COMPOSITION_TIME_READ_CAPABILITY_ID,
        version=1,
        schema_version=1,
        summary="Read the current time of one After Effects composition.",
        risk="read",
        mutability="read-only",
        idempotency="idempotent",
        cancellation="before-dispatch",
        undo="not-applicable",
        side_effect_summary=(
            "Reads composition time without changing After Effects state."
        ),
        preconditions=(
            "An After Effects project must be open.",
            "compositionLocator must come from ae.project.items.list@1.",
        ),
        compatibility={
            "status": "unverified",
            "intendedPlatforms": ["macos-arm64", "windows-x64"],
        },
        input_contract_id=N.COMPOSITION_TIME_READ_INPUT_CONTRACT_ID,
        result_contract_id=N.COMPOSITION_TIME_READ_RESULT_CONTRACT_ID,
        contract_digest=N.COMPOSITION_TIME_READ_CONTRACT_DIGEST,
        input_schema=N._COMPOSITION_TIME_READ_INPUT_SCHEMA,
        result_schema=N._COMPOSITION_TIME_READ_RESULT_SCHEMA,
        requirements=({
            "id": "aemcp.requirement.native.composition-time-read",
            "contractVersion": 1,
        },),
        examples=({"id": "composition-time-read"},),
    )


class CompositionTimeBackend(N.NativeInvokeBackend):
    name = "composition-time-fixture"

    def __init__(self) -> None:
        self.items = (descriptor(),)
        capabilities_digest = N._capabilities_registry_digest(self.items)
        self.negotiation = N.NativeNegotiation(
            selected_wire_version=1,
            plugin_version="0.9.2",
            compiled_sdk_version="25.6.61",
            source_commit="a" * 40,
            host_instance_id=HOST,
            host_platform="macos-arm64",
            session_id=SESSION,
            session_generation=3,
            capabilities_digest=capabilities_digest,
        )
        self.requests: list[N.NativeInvokeRequest] = []
        self.value: dict[str, Any] = {
            "compositionLocator": composition_locator(),
            "currentTime": {
                "value": 60,
                "scale": 24,
                "secondsRational": "5/2",
            },
        }
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
        try:
            value = N.CompositionTimeReadValue.model_validate(self.value)
            digest = N._composition_time_read_digest(value)
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
            value=self.value,
            evidence=N.NativeExecutionEvidence(
                engine="native-aegp",
                host_instance_id=HOST,
                session_id=SESSION,
                request_id=request.request_id,
                capability_id=request.capability_id,
                capability_version=request.capability_version,
                started_at_unix_ms=request.deadline_unix_ms - 100,
                completed_at_unix_ms=request.deadline_unix_ms - 1,
                effect="none",
                request_digest=N._invoke_request_digest(request, self.negotiation),
                postcondition=N.NativePostconditionEvidence(
                    verified=True,
                    kind="composition-time-read",
                    algorithm="sha256-rfc8785-jcs-v1",
                    digest=digest,
                ),
            ),
        )


def test_core_contract_matches_protocol_and_has_only_two_result_fields():
    schema = json.loads(PROTOCOL_SCHEMA.read_text(encoding="utf-8"))
    input_schema = schema["$defs"]["compositionTimeReadInputSchemaContract"]["const"]
    result_schema = schema["$defs"]["compositionTimeReadResultSchemaContract"]["const"]

    assert N._COMPOSITION_TIME_READ_INPUT_SCHEMA == input_schema
    assert N._COMPOSITION_TIME_READ_RESULT_SCHEMA == result_schema
    assert result_schema["required"] == ["compositionLocator", "currentTime"]
    assert set(result_schema["properties"]) == {
        "compositionLocator",
        "currentTime",
    }
    assert N.COMPOSITION_TIME_READ_CONTRACT_DIGEST == N._sha256_closed_json(
        {"inputSchema": input_schema, "resultSchema": result_schema}
    )


def test_current_time_requires_the_exact_reduced_rational():
    assert N.CompositionCurrentTime(
        value=-60, scale=24, seconds_rational="-5/2"
    ).seconds_rational == "-5/2"
    assert N.CompositionCurrentTime(
        value=0, scale=24, seconds_rational="0"
    ).seconds_rational == "0"
    assert N.CompositionCurrentTime(
        value=48, scale=24, seconds_rational="2"
    ).seconds_rational == "2"

    for invalid in ("60/24", "2.5", "+5/2", "05/2", "5/-2"):
        with pytest.raises(ValidationError):
            N.CompositionCurrentTime(
                value=60,
                scale=24,
                seconds_rational=invalid,
            )


def test_composition_time_value_is_closed_and_requires_a_composition_locator():
    value = {
        "compositionLocator": composition_locator(),
        "currentTime": {"value": 3003, "scale": 1000, "secondsRational": "3003/1000"},
    }
    assert N.CompositionTimeReadValue.model_validate(value).current_time.value == 3003

    with pytest.raises(ValidationError):
        N.CompositionTimeReadValue.model_validate({**value, "compositionName": "Main"})
    with pytest.raises(ValidationError):
        N.CompositionTimeReadValue.model_validate({
            **value,
            "compositionLocator": {**composition_locator(), "kind": "item"},
        })


@pytest.mark.asyncio
async def test_invoke_composition_time_read_binds_locator_and_verified_evidence():
    backend = CompositionTimeBackend()
    execution = await N.invoke_composition_time_read(
        backend,
        request_id="composition-time-1",
        composition_locator=composition_locator(),
        deadline_unix_ms=int(time.time() * 1000) + 5_000,
    )

    assert backend.requests[0].arguments == {
        "compositionLocator": composition_locator(),
    }
    assert execution.engine == "native-aegp"
    assert execution.value.current_time.seconds_rational == "5/2"
    assert execution.evidence.effect == "none"
    assert execution.evidence.undo is None
    assert execution.evidence.postcondition.verified is True


@pytest.mark.asyncio
async def test_invoke_rejects_wrong_fraction_and_unbound_postcondition():
    backend = CompositionTimeBackend()
    backend.value["currentTime"]["secondsRational"] = "60/24"
    with pytest.raises(N.NativeBackendError) as malformed:
        await N.invoke_composition_time_read(
            backend,
            request_id="composition-time-malformed",
            composition_locator=composition_locator(),
            deadline_unix_ms=int(time.time() * 1000) + 5_000,
        )
    assert malformed.value.code == "NATIVE_CONTRACT_MISMATCH"

    backend = CompositionTimeBackend()
    backend.tamper_postcondition = True
    with pytest.raises(N.NativeBackendError) as tampered:
        await N.invoke_composition_time_read(
            backend,
            request_id="composition-time-tampered",
            composition_locator=composition_locator(),
            deadline_unix_ms=int(time.time() * 1000) + 5_000,
        )
    assert tampered.value.code == "NATIVE_CONTRACT_MISMATCH"
    assert tampered.value.side_effect == "not-started"


@pytest.mark.asyncio
async def test_stale_composition_locator_has_structured_refresh_recovery():
    backend = CompositionTimeBackend()
    stale = composition_locator(
        session_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    )
    with pytest.raises(N.NativeBackendError) as raised:
        await N.invoke_composition_time_read(
            backend,
            request_id="composition-time-stale",
            composition_locator=stale,
            deadline_unix_ms=int(time.time() * 1000) + 5_000,
        )

    assert raised.value.code == "STALE_LOCATOR"
    assert raised.value.side_effect == "not-started"
    assert raised.value.recovery.action == "refresh-locator"
    assert "ae_listProjectItems" in raised.value.recovery.hint
    assert raised.value.details == {
        "field": "params.arguments.compositionLocator",
        "capabilityId": N.COMPOSITION_TIME_READ_CAPABILITY_ID,
    }
