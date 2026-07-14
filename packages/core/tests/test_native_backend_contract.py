"""Contract tests for Core's native AEGP invocation boundary.

The checked-in protocol fixtures are synthetic contract vectors.  They are
useful here because Core must preserve their typed policy and provenance, but
they are not evidence that After Effects or the native plug-in ran.
"""
from __future__ import annotations

import hashlib
import inspect
import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from ae_mcp.backends.base import LegacyExtendScriptBackend
from ae_mcp.backends.native import (
    NativeBackendError,
    NativeCancellationToken,
    NativeCapabilities,
    NativeCapabilityDescriptor,
    NativeInvokeBackend,
    NativeInvokeRequest,
    NativeInvokeResult,
    NativeNegotiation,
    ProjectSummaryExecution,
    invoke_project_summary,
)


REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURE_ROOT = REPO_ROOT / "native" / "ae-plugin" / "protocol" / "fixtures"
PROJECT_SUMMARY_CONTRACT_DIGEST = (
    "baecd602479045f71288b2a7e0df645d4a5313453a34b89ced07178867ccaf9a"
)


def _fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURE_ROOT / name).read_text(encoding="utf-8"))


def _jcs_digest(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _descriptor() -> NativeCapabilityDescriptor:
    items = _fixture("capabilities.json")["response"]["result"]["items"]
    raw = next(item for item in items if item["id"] == "ae.project.summary")
    # The model deliberately accepts protocol aliases (id/version and camel
    # case) so transport adapters need no lossy hand-written field mapping.
    return NativeCapabilityDescriptor.model_validate(raw)


def _capabilities(
    descriptor: NativeCapabilityDescriptor | None = None,
) -> NativeCapabilities:
    response = _fixture("capabilities.json")["response"]
    result = response["result"]
    items = tuple(
        NativeCapabilityDescriptor.model_validate(item)
        for item in result["items"]
    )
    if descriptor is not None:
        items = tuple(
            descriptor if item.capability_id == "ae.project.summary" else item
            for item in items
        )
    return NativeCapabilities(
        session_id=response["sessionId"],
        detail=result["detail"],
        items=items,
        next_cursor=result["nextCursor"],
        query_digest=_jcs_digest(
            {
                "sessionId": response["sessionId"],
                "ids": None,
                "detail": "full",
                "limit": 100,
            }
        ),
        capabilities_digest=result["capabilitiesDigest"],
    )


def _negotiation() -> NativeNegotiation:
    result = _fixture("hello.json")["response"]["result"]
    return NativeNegotiation(
        selected_wire_version=result["selectedWireVersion"],
        plugin_version=result["pluginVersion"],
        compiled_sdk_version=result["compiledSdk"]["version"],
        source_commit="0" * 40,
        host_instance_id=result["host"]["instanceId"],
        host_platform=result["host"]["platform"],
        session_id=result["sessionId"],
        session_generation=result["sessionGeneration"],
        capabilities_digest=result["capabilitiesDigest"],
    )


def _invoke_result() -> NativeInvokeResult:
    raw = _fixture("invoke-project-summary.json")["response"]["result"]
    return NativeInvokeResult(
        capability_id=raw["capabilityId"],
        capability_version=raw["capabilityVersion"],
        engine=raw["engine"],
        outcome=raw["outcome"],
        replayed=False,
        value=raw["value"],
        evidence=raw["evidence"],
    )


def _invoke_result_with_evidence(**updates: Any) -> NativeInvokeResult:
    raw = _fixture("invoke-project-summary.json")["response"]["result"]
    evidence = dict(raw["evidence"])
    evidence.update(updates)
    return NativeInvokeResult(
        capability_id=raw["capabilityId"],
        capability_version=raw["capabilityVersion"],
        engine=raw["engine"],
        outcome=raw["outcome"],
        replayed=False,
        value=raw["value"],
        evidence=evidence,
    )


def _native_error(
    name: str,
    *,
    capability_id: str | None = None,
) -> NativeBackendError:
    raw = _fixture("errors.json")["responses"][name]["error"]
    if capability_id is not None:
        raw["details"]["capabilityId"] = capability_id
    return NativeBackendError.from_payload(raw)


class FixtureNativeBackend(NativeInvokeBackend):
    """Transport-free fake that exposes every call made by the binding."""

    name = "fixture-native"

    def __init__(
        self,
        *,
        descriptor: NativeCapabilityDescriptor | None = None,
        result: NativeInvokeResult | None = None,
        invoke_error: NativeBackendError | None = None,
    ) -> None:
        self.negotiation = _negotiation()
        self.capability_page = _capabilities(descriptor)
        self.result = result or _invoke_result()
        self.invoke_error = invoke_error
        self.calls: list[tuple[str, Any]] = []
        self.legacy_exec_calls: list[str] = []

    async def negotiate(
        self,
        *,
        deadline_unix_ms: int,
        cancellation: NativeCancellationToken | None = None,
    ) -> NativeNegotiation:
        self.calls.append(("negotiate", (deadline_unix_ms, cancellation)))
        return self.negotiation

    async def capabilities(
        self,
        *,
        ids: tuple[str, ...] | None,
        detail: str,
        limit: int,
        deadline_unix_ms: int,
        cancellation: NativeCancellationToken | None = None,
    ) -> NativeCapabilities:
        self.calls.append(
            (
                "capabilities",
                (ids, detail, limit, deadline_unix_ms, cancellation),
            )
        )
        return self.capability_page

    async def invoke(
        self,
        request: NativeInvokeRequest,
        *,
        cancellation: NativeCancellationToken | None = None,
    ) -> NativeInvokeResult:
        self.calls.append(("invoke", (request, cancellation)))
        if self.invoke_error is not None:
            raise self.invoke_error
        return self.result

    async def cancel(
        self,
        target_request_id: str,
        *,
        deadline_unix_ms: int,
    ) -> object:
        self.calls.append(("cancel", (target_request_id, deadline_unix_ms)))
        return {
            "targetRequestId": target_request_id,
            "state": "queued-cancelled",
            "terminalResponseExpected": True,
        }

    async def exec(self, code: str, **_: Any) -> str:
        """Tripwire: native bindings must never route through raw JSX."""
        self.legacy_exec_calls.append(code)
        raise AssertionError("native project summary attempted legacy JSX execution")


class NoCancellationBackend(NativeInvokeBackend):
    """Minimal implementation that intentionally uses the default cancel path."""

    name = "no-cancellation"

    async def negotiate(
        self,
        *,
        deadline_unix_ms: int,
        cancellation: NativeCancellationToken | None = None,
    ) -> NativeNegotiation:
        raise AssertionError("negotiate is not part of this cancellation test")

    async def capabilities(
        self,
        *,
        ids: tuple[str, ...] | None,
        detail: str,
        limit: int,
        deadline_unix_ms: int,
        cancellation: NativeCancellationToken | None = None,
    ) -> NativeCapabilities:
        raise AssertionError("capabilities is not part of this cancellation test")

    async def invoke(
        self,
        request: NativeInvokeRequest,
        *,
        cancellation: NativeCancellationToken | None = None,
    ) -> NativeInvokeResult:
        raise AssertionError("invoke is not part of this cancellation test")


def test_fixture_models_preserve_descriptor_result_and_error_policy():
    descriptor = _descriptor()
    result = _invoke_result()
    error = _native_error("possiblySideEffecting")

    assert descriptor.capability_id == "ae.project.summary"
    assert descriptor.capability_version == 1
    assert descriptor.contract_digest == PROJECT_SUMMARY_CONTRACT_DIGEST
    assert descriptor.risk == "read"
    assert descriptor.mutability == "read-only"
    assert descriptor.idempotency == "idempotent"
    assert descriptor.cancellation == "before-dispatch"
    assert descriptor.undo == "not-applicable"
    assert descriptor.input_schema == {
        "type": "object",
        "additionalProperties": False,
        "required": [],
        "properties": {},
    }

    assert result.capability_id == descriptor.capability_id
    assert result.capability_version == descriptor.capability_version
    assert result.engine == "native-aegp"
    assert result.evidence.engine == "native-aegp"
    assert result.evidence.effect == "none"
    assert result.evidence.postcondition.verified is True

    assert error.code == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert error.retryable is False
    assert error.side_effect == "may-have-occurred"
    assert error.recovery.action == "inspect-state"
    assert error.details == {"capabilityId": "ae.project.set_current_time"}


def test_http_native_invoke_result_requires_explicit_replay_status():
    raw = _fixture("invoke-project-summary.json")["response"]["result"]

    with pytest.raises(ValidationError):
        NativeInvokeResult.model_validate(raw)


def test_native_descriptor_cannot_be_relabelled_as_jsx():
    raw = _fixture("capabilities.json")["response"]["result"]["items"][0]
    raw["engine"] = "maintained-jsx"

    with pytest.raises(ValidationError):
        NativeCapabilityDescriptor.model_validate(raw)


def test_all_wire_error_fixtures_preserve_their_closed_details():
    responses = _fixture("errors.json")["responses"]

    parsed = {
        name: NativeBackendError.from_payload(response["error"])
        for name, response in responses.items()
    }

    assert parsed["wireVersionMismatch"].details == {
        "supportedWireVersions": {"minimum": 1, "maximum": 1}
    }
    assert parsed["staleLocator"].details == {
        "field": "arguments.layer",
        "capabilityId": "ae.layer.inspect",
        "currentGeneration": 8,
    }


@pytest.mark.parametrize(
    "mutate",
    [
        pytest.param(
            lambda raw: raw.update({"code": "NATIVE_CONTRACT_MISMATCH"}),
            id="core-only-code",
        ),
        pytest.param(
            lambda raw: raw.update({"details": None}),
            id="explicit-null-details",
        ),
        pytest.param(
            lambda raw: raw["details"].update({"unknown": True}),
            id="unknown-detail",
        ),
        pytest.param(
            lambda raw: raw.pop("details"),
            id="missing-required-capability-detail",
        ),
    ],
)
def test_invalid_wire_error_is_mapped_to_structured_contract_mismatch(mutate):
    raw = _fixture("errors.json")["responses"]["possiblySideEffecting"]["error"]
    mutate(raw)

    with pytest.raises(NativeBackendError) as raised:
        NativeBackendError.from_payload(raw)

    assert raised.value.code == "NATIVE_CONTRACT_MISMATCH"
    assert raised.value.retryable is False
    assert raised.value.side_effect == "not-started"
    assert raised.value.recovery.action == "refresh-capabilities"


def test_wire_version_error_requires_supported_range_detail():
    raw = _fixture("errors.json")["responses"]["wireVersionMismatch"]["error"]
    raw.pop("details")

    with pytest.raises(NativeBackendError) as raised:
        NativeBackendError.from_payload(raw)

    assert raised.value.code == "NATIVE_CONTRACT_MISMATCH"


@pytest.mark.asyncio
async def test_project_summary_binding_is_explicit_native_and_deadline_bound():
    backend = FixtureNativeBackend()
    cancellation = NativeCancellationToken()
    deadline_unix_ms = 1_900_000_005_000

    execution = await invoke_project_summary(
        backend,
        request_id="invoke-summary-1",
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )

    assert isinstance(execution, ProjectSummaryExecution)
    assert execution.project_open is False
    assert execution.project_name == "SYNTHETIC_CONTRACT_VECTOR"
    assert execution.item_count == 0
    assert execution.engine == "native-aegp"
    assert execution.implementation.capability_id == "ae.project.summary"
    assert (
        execution.implementation.contract_digest
        == PROJECT_SUMMARY_CONTRACT_DIGEST
    )
    assert execution.negotiation.session_id == _negotiation().session_id
    assert execution.evidence.postcondition.verified is True
    assert execution.audit_fields() == {
        "engine": "native-aegp",
        "capabilityId": "ae.project.summary",
        "capabilityVersion": 1,
        "contractDigest": PROJECT_SUMMARY_CONTRACT_DIGEST,
        "selectedWireVersion": 1,
        "pluginVersion": "0.0.0-synthetic",
        "compiledSdkVersion": "0.0.0",
        "sourceCommit": "0" * 40,
        "hostInstanceId": "22222222-2222-4222-8222-222222222222",
        "sessionId": "11111111-1111-4111-8111-111111111111",
        "sessionGeneration": 1,
        "capabilitiesDigest": _negotiation().capabilities_digest,
        "requestId": "invoke-summary-1",
        "effect": "none",
        "requestDigest": (
            "9df120d0b016b1313035b94329245474"
            "a0dc31bad5c0383a9ecde11db5fbdc8f"
        ),
        "postconditionAlgorithm": "sha256-rfc8785-jcs-v1",
        "postconditionDigest": (
            "64a69b209d2948d0766fe54b07a34af2"
            "0e007a1c9884315b109e3019d5f6f433"
        ),
        "startedAtUnixMs": 1_900_000_000_000,
        "completedAtUnixMs": 1_900_000_000_025,
    }

    assert [name for name, _ in backend.calls] == [
        "negotiate",
        "capabilities",
        "invoke",
    ]
    assert backend.calls[0][1] == (deadline_unix_ms, cancellation)
    assert backend.calls[1][1] == (
        None,
        "full",
        100,
        deadline_unix_ms,
        cancellation,
    )
    request, invoke_cancellation = backend.calls[2][1]
    assert request == NativeInvokeRequest(
        request_id="invoke-summary-1",
        capability_id="ae.project.summary",
        capability_version=1,
        arguments={},
        deadline_unix_ms=deadline_unix_ms,
    )
    assert invoke_cancellation is cancellation
    assert backend.legacy_exec_calls == []


@pytest.mark.asyncio
async def test_project_summary_rejects_untrusted_descriptor_before_dispatch():
    raw = _fixture("capabilities.json")["response"]["result"]["items"][0]
    raw["contractDigest"] = "f" * 64
    backend = FixtureNativeBackend(
        descriptor=NativeCapabilityDescriptor.model_validate(raw)
    )

    with pytest.raises(NativeBackendError) as raised:
        await invoke_project_summary(
            backend,
            request_id="bad-contract",
            deadline_unix_ms=1_900_000_005_000,
        )

    assert raised.value.code == "NATIVE_CONTRACT_MISMATCH"
    assert raised.value.retryable is False
    assert raised.value.side_effect == "not-started"
    assert raised.value.recovery.action == "refresh-capabilities"
    assert [name for name, _ in backend.calls] == ["negotiate", "capabilities"]
    assert backend.legacy_exec_calls == []


@pytest.mark.asyncio
async def test_project_summary_rejects_unbound_capabilities_query_digest():
    backend = FixtureNativeBackend()
    backend.capability_page = backend.capability_page.model_copy(
        update={"query_digest": "0" * 64}
    )

    with pytest.raises(NativeBackendError) as raised:
        await invoke_project_summary(
            backend,
            request_id="bad-query-digest",
            deadline_unix_ms=1_900_000_005_000,
        )

    assert raised.value.code == "NATIVE_CONTRACT_MISMATCH"
    assert [name for name, _ in backend.calls] == ["negotiate", "capabilities"]


@pytest.mark.asyncio
async def test_project_summary_rejects_unbound_registry_digest():
    backend = FixtureNativeBackend()
    backend.capability_page = backend.capability_page.model_copy(
        update={"capabilities_digest": "0" * 64}
    )

    with pytest.raises(NativeBackendError) as raised:
        await invoke_project_summary(
            backend,
            request_id="bad-registry-digest",
            deadline_unix_ms=1_900_000_005_000,
        )

    assert raised.value.code == "NATIVE_CONTRACT_MISMATCH"
    assert [name for name, _ in backend.calls] == ["negotiate", "capabilities"]


@pytest.mark.asyncio
async def test_project_summary_rejects_schema_tampering_before_dispatch():
    raw = _fixture("capabilities.json")["response"]["result"]["items"][0]
    raw["resultSchema"]["properties"]["itemCount"]["maximum"] = 10
    backend = FixtureNativeBackend(
        descriptor=NativeCapabilityDescriptor.model_validate(raw)
    )

    with pytest.raises(NativeBackendError) as raised:
        await invoke_project_summary(
            backend,
            request_id="tampered-result-schema",
            deadline_unix_ms=1_900_000_005_000,
        )

    assert raised.value.code == "NATIVE_CONTRACT_MISMATCH"
    assert [name for name, _ in backend.calls] == ["negotiate", "capabilities"]
    assert backend.legacy_exec_calls == []


@pytest.mark.asyncio
async def test_project_summary_rejects_incompatible_host_before_dispatch():
    raw = _fixture("capabilities.json")["response"]["result"]["items"][0]
    raw["compatibility"]["intendedPlatforms"] = ["windows-x64"]
    backend = FixtureNativeBackend(
        descriptor=NativeCapabilityDescriptor.model_validate(raw)
    )

    with pytest.raises(NativeBackendError) as raised:
        await invoke_project_summary(
            backend,
            request_id="incompatible-host",
            deadline_unix_ms=1_900_000_005_000,
        )

    assert raised.value.code == "NATIVE_CONTRACT_MISMATCH"
    assert [name for name, _ in backend.calls] == ["negotiate", "capabilities"]
    assert backend.legacy_exec_calls == []


@pytest.mark.asyncio
async def test_project_summary_rejects_result_bound_to_another_request():
    fixture_result = _fixture("invoke-project-summary.json")["response"]["result"]
    evidence = dict(fixture_result["evidence"])
    evidence["requestId"] = "different-native-request"
    backend = FixtureNativeBackend(
        result=NativeInvokeResult(
            capability_id=fixture_result["capabilityId"],
            capability_version=fixture_result["capabilityVersion"],
            engine=fixture_result["engine"],
            outcome=fixture_result["outcome"],
            replayed=False,
            value=fixture_result["value"],
            evidence=evidence,
        )
    )

    with pytest.raises(NativeBackendError) as raised:
        await invoke_project_summary(
            backend,
            request_id="invalid-result-evidence",
            deadline_unix_ms=1_900_000_005_000,
        )

    assert raised.value.code == "NATIVE_CONTRACT_MISMATCH"
    assert raised.value.retryable is False
    assert raised.value.side_effect == "not-started"
    assert [name for name, _ in backend.calls].count("invoke") == 1
    assert backend.legacy_exec_calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "evidence_update",
    [
        pytest.param({"requestDigest": "0" * 64}, id="request-digest"),
        pytest.param(
            {"completedAtUnixMs": 1_900_000_005_001},
            id="completed-after-deadline",
        ),
        pytest.param(
            {"undo": {"available": False, "verified": False}},
            id="unexpected-read-undo",
        ),
    ],
)
async def test_project_summary_rejects_unbound_execution_evidence(
    evidence_update: dict[str, Any],
):
    backend = FixtureNativeBackend(
        result=_invoke_result_with_evidence(**evidence_update)
    )

    with pytest.raises(NativeBackendError) as raised:
        await invoke_project_summary(
            backend,
            request_id="invoke-summary-1",
            deadline_unix_ms=1_900_000_005_000,
        )

    assert raised.value.code == "NATIVE_CONTRACT_MISMATCH"
    assert raised.value.side_effect == "not-started"
    assert [name for name, _ in backend.calls].count("invoke") == 1
    assert backend.legacy_exec_calls == []


@pytest.mark.asyncio
async def test_project_summary_maps_invalid_value_to_structured_contract_error():
    raw = _fixture("invoke-project-summary.json")["response"]["result"]
    invalid_result = NativeInvokeResult(
        capability_id=raw["capabilityId"],
        capability_version=raw["capabilityVersion"],
        engine=raw["engine"],
        outcome=raw["outcome"],
        replayed=False,
        value={"projectOpen": False, "projectName": "missing item count"},
        evidence=raw["evidence"],
    )
    backend = FixtureNativeBackend(result=invalid_result)

    with pytest.raises(NativeBackendError) as raised:
        await invoke_project_summary(
            backend,
            request_id="invoke-summary-1",
            deadline_unix_ms=1_900_000_005_000,
        )

    assert raised.value.code == "NATIVE_CONTRACT_MISMATCH"
    assert raised.value.recovery.action == "refresh-capabilities"


@pytest.mark.asyncio
async def test_native_failure_is_not_retried_or_fallen_back_to_legacy_exec():
    expected = _native_error(
        "possiblySideEffecting",
        capability_id="ae.project.summary",
    )
    backend = FixtureNativeBackend(invoke_error=expected)

    with pytest.raises(NativeBackendError) as raised:
        await invoke_project_summary(
            backend,
            request_id="possibly-side-effecting",
            deadline_unix_ms=1_900_000_005_000,
        )

    assert raised.value is expected
    assert raised.value.retryable is False
    assert raised.value.side_effect == "may-have-occurred"
    assert [name for name, _ in backend.calls].count("invoke") == 1
    assert backend.legacy_exec_calls == []


@pytest.mark.asyncio
async def test_mismatched_invoke_error_preserves_side_effect_uncertainty():
    backend = FixtureNativeBackend(
        invoke_error=_native_error("possiblySideEffecting")
    )

    with pytest.raises(NativeBackendError) as raised:
        await invoke_project_summary(
            backend,
            request_id="invoke-summary-1",
            deadline_unix_ms=1_900_000_005_000,
        )

    assert raised.value.code == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert raised.value.retryable is False
    assert raised.value.side_effect == "may-have-occurred"
    assert raised.value.recovery.action == "inspect-state"
    assert raised.value.details == {"capabilityId": "ae.project.summary"}
    assert raised.value.__cause__ is backend.invoke_error
    assert [name for name, _ in backend.calls].count("invoke") == 1
    assert backend.legacy_exec_calls == []


@pytest.mark.asyncio
async def test_safe_mismatched_invoke_error_becomes_contract_mismatch():
    backend = FixtureNativeBackend(invoke_error=_native_error("staleLocator"))

    with pytest.raises(NativeBackendError) as raised:
        await invoke_project_summary(
            backend,
            request_id="invoke-summary-1",
            deadline_unix_ms=1_900_000_005_000,
        )

    assert raised.value.code == "NATIVE_CONTRACT_MISMATCH"
    assert raised.value.side_effect == "not-started"
    assert raised.value.__cause__ is backend.invoke_error


def test_native_boundary_has_no_legacy_inheritance_fallback_or_resolver():
    assert not issubclass(NativeInvokeBackend, LegacyExtendScriptBackend)
    parameters = inspect.signature(invoke_project_summary).parameters
    assert "legacy_backend" not in parameters
    assert "fallback" not in parameters
    assert "resolver" not in parameters


@pytest.mark.asyncio
async def test_cancellation_token_is_observable_without_transport_coupling():
    token = NativeCancellationToken()
    assert token.is_cancelled is False

    token.cancel()

    assert token.is_cancelled is True
    await token.wait()


@pytest.mark.asyncio
async def test_pre_cancelled_project_summary_fails_before_negotiation():
    backend = FixtureNativeBackend()
    token = NativeCancellationToken()
    token.cancel()

    with pytest.raises(NativeBackendError) as raised:
        await invoke_project_summary(
            backend,
            request_id="cancel-before-negotiate",
            deadline_unix_ms=1_900_000_005_000,
            cancellation=token,
        )

    assert raised.value.code == "CANCELLED"
    assert raised.value.retryable is False
    assert raised.value.side_effect == "not-started"
    assert raised.value.recovery.action == "none"
    assert backend.calls == []
    assert backend.legacy_exec_calls == []


@pytest.mark.asyncio
async def test_expired_project_summary_deadline_fails_before_negotiation():
    backend = FixtureNativeBackend()

    with pytest.raises(NativeBackendError) as raised:
        await invoke_project_summary(
            backend,
            request_id="deadline-before-negotiate",
            deadline_unix_ms=1,
        )

    assert raised.value.code == "DEADLINE_EXCEEDED"
    assert raised.value.retryable is True
    assert raised.value.side_effect == "not-started"
    assert raised.value.recovery.action == "retry"
    assert backend.calls == []
    assert backend.legacy_exec_calls == []


@pytest.mark.asyncio
async def test_default_native_cancel_fails_explicitly_when_not_supported():
    with pytest.raises(NativeBackendError) as raised:
        await NoCancellationBackend().cancel(
            "invoke-summary-1",
            deadline_unix_ms=1_900_000_005_000,
        )

    assert raised.value.code == "NATIVE_UNSUPPORTED"
    assert raised.value.retryable is False
    assert raised.value.side_effect == "not-started"
    assert raised.value.recovery.action == "refresh-capabilities"
