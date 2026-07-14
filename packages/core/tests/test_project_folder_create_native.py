"""Typed Core contract for the first undoable native project mutation."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from ae_mcp.backends import native as N


_DEADLINE = 1_900_000_005_000
_SESSION = "11111111-1111-4111-8111-111111111111"
_HOST = "22222222-2222-4222-8222-222222222222"


def _descriptor() -> N.NativeCapabilityDescriptor:
    return N.NativeCapabilityDescriptor(
        detail="full",
        id=N.PROJECT_FOLDER_CREATE_CAPABILITY_ID,
        version=1,
        schema_version=1,
        summary="Create one folder at the root of the open After Effects project.",
        risk="write",
        mutability="mutating",
        idempotency="idempotency-key",
        cancellation="before-dispatch",
        undo="ae-undo-group",
        side_effect_summary=(
            "Creates one root project folder and one After Effects undo step."
        ),
        preconditions=("An After Effects project must be open.",),
        compatibility=N.NativeCompatibility(
            status="unverified",
            intended_platforms=("macos-arm64", "windows-x64"),
        ),
        input_contract_id="aemcp.contract.ae.project.folder.create.input.v1",
        result_contract_id="aemcp.contract.ae.project.folder.create.result.v1",
        contract_digest=N.PROJECT_FOLDER_CREATE_CONTRACT_DIGEST,
        input_schema=N._PROJECT_FOLDER_CREATE_INPUT_SCHEMA,
        result_schema=N._PROJECT_FOLDER_CREATE_RESULT_SCHEMA,
        requirements=(
            N.NativeRequirement(
                id="aemcp.requirement.native.project-folder-create",
                contract_version=1,
            ),
        ),
        examples=({"id": "folder-create", "kind": "positive"},),
    )


class FolderBackend(N.NativeInvokeBackend):
    name = "folder-fixture"

    def __init__(self, *, invoke_error: N.NativeBackendError | None = None) -> None:
        self.descriptor = _descriptor()
        self.registry_digest = N._capabilities_registry_digest((self.descriptor,))
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
        self.corrupt_count = False

    async def negotiate(self, **kwargs):
        self.calls.append(("negotiate", kwargs))
        return self.negotiation

    async def capabilities(self, **kwargs):
        self.calls.append(("capabilities", kwargs))
        return N.NativeCapabilities(
            session_id=_SESSION,
            detail="full",
            items=(self.descriptor,),
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
        value = N.ProjectFolderCreateValue(
            created=True,
            folder_item_id=17,
            folder_name=request.arguments["name"],
            parent_item_id=0,
            item_count_before=4,
            item_count_after=6 if self.corrupt_count else 5,
        )
        if self.cancel_during_invoke is not None:
            self.cancel_during_invoke.cancel()
        return N.NativeInvokeResult(
            capability_id=request.capability_id,
            capability_version=request.capability_version,
            engine="native-aegp",
            outcome="succeeded",
            replayed=False,
            value=value.model_dump(mode="json", by_alias=True),
            evidence=N.NativeExecutionEvidence(
                engine="native-aegp",
                host_instance_id=_HOST,
                session_id=_SESSION,
                request_id=request.request_id,
                capability_id=request.capability_id,
                capability_version=request.capability_version,
                started_at_unix_ms=_DEADLINE - 100,
                completed_at_unix_ms=_DEADLINE - 50,
                effect="committed",
                request_digest=N._invoke_request_digest(request, self.negotiation),
                postcondition=N.NativePostconditionEvidence(
                    verified=True,
                    kind="project-folder-created",
                    algorithm="sha256-rfc8785-jcs-v1",
                    digest=N._project_folder_create_digest(value),
                ),
                undo=N.NativeUndoEvidence(available=True, verified=True),
            ),
        )


@pytest.mark.asyncio
async def test_folder_create_binds_key_state_undo_and_native_evidence():
    backend = FolderBackend()
    execution = await N.invoke_project_folder_create(
        backend,
        request_id="core-folder-create-1",
        name="AI_😀_Folder",
        idempotency_key="folder-intent-0001",
        deadline_unix_ms=_DEADLINE,
    )

    request = backend.calls[-1][1][0]
    assert request.arguments == {
        "name": "AI_😀_Folder",
        "idempotencyKey": "folder-intent-0001",
    }
    assert execution.value.parent_item_id == 0
    assert execution.value.item_count_after == execution.value.item_count_before + 1
    assert execution.replayed is False
    assert execution.evidence.effect == "committed"
    assert execution.evidence.undo is not None
    assert execution.evidence.undo.group_id is None
    assert execution.audit_fields()["undoVerified"] is True


def test_folder_name_uses_utf16_units_and_rejects_controls_before_dispatch():
    with pytest.raises(ValidationError):
        N.ProjectFolderCreateArguments(
            name="😀" * 16,
            idempotency_key="folder-intent-0002",
        )
    with pytest.raises(ValidationError):
        N.ProjectFolderCreateArguments(
            name="bad\nname",
            idempotency_key="folder-intent-0002",
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
            hint="Inspect the existing root project folder before retrying.",
        ),
        details={"field": "params.arguments.idempotencyKey"},
    )
    backend = FolderBackend(invoke_error=duplicate)
    with pytest.raises(N.NativeBackendError) as raised:
        await N.invoke_project_folder_create(
            backend,
            request_id="core-folder-duplicate",
            name="AI Folder",
            idempotency_key="folder-intent-0003",
            deadline_unix_ms=_DEADLINE,
        )

    assert raised.value is duplicate
    assert raised.value.side_effect == "not-started"
    assert [name for name, _ in backend.calls].count("invoke") == 1


@pytest.mark.asyncio
async def test_post_dispatch_cancellation_does_not_hide_verified_success():
    backend = FolderBackend()
    token = N.NativeCancellationToken()
    backend.cancel_during_invoke = token

    execution = await N.invoke_project_folder_create(
        backend,
        request_id="core-folder-cancel-race",
        name="AI Folder",
        idempotency_key="folder-intent-0004",
        deadline_unix_ms=_DEADLINE,
        cancellation=token,
    )

    assert token.is_cancelled is True
    assert execution.evidence.effect == "committed"
