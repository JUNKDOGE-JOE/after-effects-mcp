"""Typed Core contracts for native project bit-depth read and undoable set."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from ae_mcp.backends import native as N


_DEADLINE = 1_900_000_005_000
_SESSION = "11111111-1111-4111-8111-111111111111"
_HOST = "22222222-2222-4222-8222-222222222222"


def _read_descriptor() -> N.NativeCapabilityDescriptor:
    return N.NativeCapabilityDescriptor(
        detail="full",
        id=N.PROJECT_BIT_DEPTH_READ_CAPABILITY_ID,
        version=1,
        schema_version=1,
        summary="Read the open After Effects project's bit depth.",
        risk="read",
        mutability="read-only",
        idempotency="idempotent",
        cancellation="before-dispatch",
        undo="not-applicable",
        side_effect_summary=(
            "Reads project bit depth without changing After Effects state."
        ),
        preconditions=("An After Effects project must be open.",),
        compatibility=N.NativeCompatibility(
            status="unverified",
            intended_platforms=("macos-arm64", "windows-x64"),
        ),
        input_contract_id="aemcp.contract.ae.project.bit-depth.read.input.v1",
        result_contract_id="aemcp.contract.ae.project.bit-depth.read.result.v1",
        contract_digest=N.PROJECT_BIT_DEPTH_READ_CONTRACT_DIGEST,
        input_schema=N._PROJECT_BIT_DEPTH_READ_INPUT_SCHEMA,
        result_schema=N._PROJECT_BIT_DEPTH_READ_RESULT_SCHEMA,
        requirements=(
            N.NativeRequirement(
                id="aemcp.requirement.native.project-bit-depth-read",
                contract_version=1,
            ),
        ),
        examples=({"id": "bit-depth-read", "kind": "positive"},),
    )


def _set_descriptor() -> N.NativeCapabilityDescriptor:
    return N.NativeCapabilityDescriptor(
        detail="full",
        id=N.PROJECT_BIT_DEPTH_SET_CAPABILITY_ID,
        version=1,
        schema_version=1,
        summary="Set the open After Effects project's bit depth.",
        risk="write",
        mutability="mutating",
        idempotency="idempotency-key",
        cancellation="before-dispatch",
        undo="ae-undo-group",
        side_effect_summary=(
            "Changes project bit depth and creates one After Effects Undo step."
        ),
        preconditions=(
            "An After Effects project must be open.",
            "targetDepth must differ from the current project bit depth.",
        ),
        compatibility=N.NativeCompatibility(
            status="unverified",
            intended_platforms=("macos-arm64", "windows-x64"),
        ),
        input_contract_id="aemcp.contract.ae.project.bit-depth.set.input.v1",
        result_contract_id="aemcp.contract.ae.project.bit-depth.set.result.v1",
        contract_digest=N.PROJECT_BIT_DEPTH_SET_CONTRACT_DIGEST,
        input_schema=N._PROJECT_BIT_DEPTH_SET_INPUT_SCHEMA,
        result_schema=N._PROJECT_BIT_DEPTH_SET_RESULT_SCHEMA,
        requirements=(
            N.NativeRequirement(
                id="aemcp.requirement.native.project-bit-depth-set",
                contract_version=1,
            ),
        ),
        examples=({"id": "bit-depth-set", "kind": "positive"},),
    )


class BitDepthBackend(N.NativeInvokeBackend):
    name = "bit-depth-fixture"

    def __init__(self, *, invoke_error: N.NativeBackendError | None = None) -> None:
        self.descriptors = (_read_descriptor(), _set_descriptor())
        self.registry_digest = N._capabilities_registry_digest(self.descriptors)
        self.negotiation = N.NativeNegotiation(
            selected_wire_version=1,
            plugin_version="0.0.0-test",
            compiled_sdk_version="25.6.61",
            source_commit="a" * 40,
            host_instance_id=_HOST,
            host_platform="macos-arm64",
            session_id=_SESSION,
            session_generation=1,
            capabilities_digest=self.registry_digest,
        )
        self.invoke_error = invoke_error
        self.calls: list[tuple[str, Any]] = []
        self.cancel_during_invoke: N.NativeCancellationToken | None = None
        self.malformed_set_transition = False

    async def negotiate(self, **kwargs):
        self.calls.append(("negotiate", kwargs))
        return self.negotiation

    async def capabilities(self, **kwargs):
        self.calls.append(("capabilities", kwargs))
        return N.NativeCapabilities(
            session_id=_SESSION,
            detail="full",
            items=self.descriptors,
            next_cursor=None,
            query_digest=N._capabilities_query_digest(
                session_id=_SESSION,
                ids=kwargs["ids"],
                detail=kwargs["detail"],
                limit=kwargs["limit"],
            ),
            capabilities_digest=self.registry_digest,
        )

    async def invoke(self, request, **kwargs):
        self.calls.append(("invoke", (request, kwargs)))
        if self.invoke_error is not None:
            raise self.invoke_error
        if self.cancel_during_invoke is not None:
            self.cancel_during_invoke.cancel()

        if request.capability_id == N.PROJECT_BIT_DEPTH_READ_CAPABILITY_ID:
            value = N.ProjectBitDepthReadValue(bits_per_channel=8)
            digest = N._project_bit_depth_read_digest(value)
            effect = "none"
            undo = None
            kind = "project-bit-depth-read"
            raw_value = value.model_dump(mode="json", by_alias=True)
        else:
            after = request.arguments["targetDepth"]
            before = after if self.malformed_set_transition else (8 if after != 8 else 16)
            raw_value = {
                "changed": True,
                "beforeBitsPerChannel": before,
                "afterBitsPerChannel": after,
            }
            digest = (
                "0" * 64
                if self.malformed_set_transition
                else N._project_bit_depth_set_digest(
                    N.ProjectBitDepthSetValue.model_validate(raw_value)
                )
            )
            effect = "committed"
            undo = N.NativeUndoEvidence(available=True, verified=False)
            kind = "project-bit-depth-set"

        return N.NativeInvokeResult(
            capability_id=request.capability_id,
            capability_version=request.capability_version,
            engine="native-aegp",
            outcome="succeeded",
            replayed=False,
            value=raw_value,
            evidence=N.NativeExecutionEvidence(
                engine="native-aegp",
                host_instance_id=_HOST,
                session_id=_SESSION,
                request_id=request.request_id,
                capability_id=request.capability_id,
                capability_version=request.capability_version,
                started_at_unix_ms=_DEADLINE - 100,
                completed_at_unix_ms=_DEADLINE - 50,
                effect=effect,
                request_digest=N._invoke_request_digest(request, self.negotiation),
                postcondition=N.NativePostconditionEvidence(
                    verified=True,
                    kind=kind,
                    algorithm="sha256-rfc8785-jcs-v1",
                    digest=digest,
                ),
                undo=undo,
            ),
        )


@pytest.mark.asyncio
async def test_bit_depth_read_binds_real_state_without_undo():
    backend = BitDepthBackend()
    execution = await N.invoke_project_bit_depth_read(
        backend,
        request_id="core-bit-depth-read-1",
        deadline_unix_ms=_DEADLINE,
    )

    request = backend.calls[-1][1][0]
    assert request.arguments == {}
    assert execution.value.bits_per_channel == 8
    assert execution.evidence.effect == "none"
    assert execution.evidence.undo is None


@pytest.mark.asyncio
async def test_bit_depth_set_binds_target_key_readback_and_undo_availability():
    backend = BitDepthBackend()
    execution = await N.invoke_project_bit_depth_set(
        backend,
        request_id="core-bit-depth-set-1",
        target_depth=16,
        idempotency_key="bit-depth-intent-0001",
        deadline_unix_ms=_DEADLINE,
    )

    request = backend.calls[-1][1][0]
    assert request.arguments == {
        "targetDepth": 16,
        "idempotencyKey": "bit-depth-intent-0001",
    }
    assert execution.value.before_bits_per_channel == 8
    assert execution.value.after_bits_per_channel == 16
    assert execution.replayed is False
    assert execution.evidence.effect == "committed"
    assert execution.evidence.undo is not None
    assert execution.evidence.undo.available is True
    assert execution.evidence.undo.verified is False
    assert execution.evidence.undo.group_id is None


def test_bit_depth_models_reject_unsupported_and_no_change_values():
    with pytest.raises(ValidationError):
        N.ProjectBitDepthSetArguments(
            target_depth=24,
            idempotency_key="bit-depth-intent-0002",
        )
    with pytest.raises(ValidationError):
        N.ProjectBitDepthReadValue(bits_per_channel=24)
    with pytest.raises(ValidationError):
        N.ProjectBitDepthSetValue(
            changed=True,
            before_bits_per_channel=16,
            after_bits_per_channel=16,
        )


@pytest.mark.asyncio
async def test_duplicate_key_is_typed_and_never_retried_or_fallen_back():
    duplicate = N.NativeBackendError(
        "DUPLICATE_REQUEST",
        "The idempotency key is already claimed.",
        retryable=False,
        side_effect="not-started",
        recovery=N.NativeRecovery(
            action="inspect-state",
            hint="Inspect project bit depth before retrying.",
        ),
        details={"field": "params.arguments.idempotencyKey"},
    )
    backend = BitDepthBackend(invoke_error=duplicate)
    with pytest.raises(N.NativeBackendError) as raised:
        await N.invoke_project_bit_depth_set(
            backend,
            request_id="core-bit-depth-duplicate",
            target_depth=16,
            idempotency_key="bit-depth-intent-0003",
            deadline_unix_ms=_DEADLINE,
        )

    assert raised.value is duplicate
    assert raised.value.side_effect == "not-started"
    assert [name for name, _ in backend.calls].count("invoke") == 1


@pytest.mark.asyncio
async def test_malformed_post_dispatch_transition_preserves_uncertainty():
    backend = BitDepthBackend()
    backend.malformed_set_transition = True
    with pytest.raises(N.NativeBackendError) as raised:
        await N.invoke_project_bit_depth_set(
            backend,
            request_id="core-bit-depth-malformed",
            target_depth=16,
            idempotency_key="bit-depth-intent-0004",
            deadline_unix_ms=_DEADLINE,
        )

    assert raised.value.code == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert raised.value.side_effect == "may-have-occurred"


@pytest.mark.asyncio
async def test_post_dispatch_cancellation_does_not_hide_verified_success():
    backend = BitDepthBackend()
    token = N.NativeCancellationToken()
    backend.cancel_during_invoke = token

    execution = await N.invoke_project_bit_depth_set(
        backend,
        request_id="core-bit-depth-cancel-race",
        target_depth=32,
        idempotency_key="bit-depth-intent-0005",
        deadline_unix_ms=_DEADLINE,
        cancellation=token,
    )

    assert token.is_cancelled is True
    assert execution.evidence.effect == "committed"
