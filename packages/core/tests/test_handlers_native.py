"""Public MCP surface for the explicitly bound native project-summary read."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from ae_mcp import schemas
from ae_mcp.backends.mock import MockBackend
from ae_mcp.backends.native import (
    NativeBackendError,
    NativeCapabilities,
    NativeCapabilityDescriptor,
    NativeInvokeBackend,
    NativeInvokeResult,
    NativeNegotiation,
    NativeExecutionEvidence,
    NativePostconditionEvidence,
    NativeRecovery,
    NativeUndoEvidence,
    ProjectFolderCreateExecution,
    ProjectFolderCreateValue,
    PROJECT_FOLDER_CREATE_CONTRACT_DIGEST,
    ProjectSummaryExecution,
    ProjectSummaryValue,
)
from ae_mcp.handlers import HANDLERS, load_all
from ae_mcp.handlers import native as native_handler


_FIXTURES = Path(__file__).resolve().parents[3] / "native" / "ae-plugin" / "protocol" / "fixtures"


def _fixture(name: str) -> dict[str, Any]:
    return json.loads((_FIXTURES / name).read_text(encoding="utf-8"))


def _execution() -> ProjectSummaryExecution:
    hello = _fixture("hello.json")["response"]["result"]
    raw_result = _fixture("invoke-project-summary.json")["response"]["result"]
    descriptor = NativeCapabilityDescriptor.model_validate(
        _fixture("capabilities.json")["response"]["result"]["items"][0]
    )
    negotiation = NativeNegotiation(
        selected_wire_version=hello["selectedWireVersion"],
        plugin_version=hello["pluginVersion"],
        compiled_sdk_version=hello["compiledSdk"]["version"],
        source_commit="a" * 40,
        host_instance_id=hello["host"]["instanceId"],
        host_platform=hello["host"]["platform"],
        session_id=hello["sessionId"],
        session_generation=hello["sessionGeneration"],
        capabilities_digest=hello["capabilitiesDigest"],
    )
    result = NativeInvokeResult.model_validate({**raw_result, "replayed": False})
    return ProjectSummaryExecution(
        implementation=descriptor,
        negotiation=negotiation,
        value=ProjectSummaryValue.model_validate(result.value),
        evidence=result.evidence,
    )


def _folder_execution() -> ProjectFolderCreateExecution:
    summary = _execution()
    descriptor = NativeCapabilityDescriptor(
        detail="full",
        id="ae.project.folder.create",
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
        compatibility={
            "status": "unverified",
            "intendedPlatforms": ["macos-arm64", "windows-x64"],
        },
        input_contract_id="aemcp.contract.ae.project.folder.create.input.v1",
        result_contract_id="aemcp.contract.ae.project.folder.create.result.v1",
        contract_digest=PROJECT_FOLDER_CREATE_CONTRACT_DIGEST,
        input_schema={"type": "object"},
        result_schema={"type": "object"},
        requirements=(
            {
                "id": "aemcp.requirement.native.project-folder-create",
                "contractVersion": 1,
            },
        ),
        examples=({"id": "folder-create"},),
    )
    value = ProjectFolderCreateValue(
        created=True,
        folder_item_id=17,
        folder_name="AI Folder",
        parent_item_id=0,
        item_count_before=4,
        item_count_after=5,
    )
    evidence = NativeExecutionEvidence(
        engine="native-aegp",
        host_instance_id=summary.negotiation.host_instance_id,
        session_id=summary.negotiation.session_id,
        request_id="core-folder-create-1",
        capability_id="ae.project.folder.create",
        capability_version=1,
        started_at_unix_ms=1_900_000_000_000,
        completed_at_unix_ms=1_900_000_000_025,
        effect="committed",
        request_digest="b" * 64,
        postcondition=NativePostconditionEvidence(
            verified=True,
            kind="project-folder-created",
            algorithm="sha256-rfc8785-jcs-v1",
            digest="c" * 64,
        ),
        undo=NativeUndoEvidence(available=True, verified=True),
    )
    return ProjectFolderCreateExecution(
        implementation=descriptor,
        negotiation=summary.negotiation,
        transport_request_id="core-folder-create-1",
        idempotency_key="folder-intent-0001",
        replayed=False,
        value=value,
        evidence=evidence,
    )


@pytest.fixture(autouse=True)
def _load_handlers():
    load_all()


@pytest.mark.asyncio
async def test_project_summary_returns_typed_value_provenance_and_evidence(monkeypatch):
    execution = _execution()
    sentinel_backend = object()
    captured: dict[str, Any] = {}

    async def _invoke(backend, **kwargs):
        captured["backend"] = backend
        captured.update(kwargs)
        return execution

    monkeypatch.setattr(native_handler, "_backend", lambda: sentinel_backend)
    monkeypatch.setattr(native_handler, "invoke_project_summary", _invoke)

    result = await native_handler._run_project_summary(
        schemas.AeProjectSummaryArgs(),
        None,
    )

    assert captured["backend"] is sentinel_backend
    assert captured["request_id"].startswith("mcp-")
    assert captured["cancellation"].is_cancelled is False
    assert result["ok"] is True
    assert result["value"] == {
        "projectOpen": False,
        "projectName": "SYNTHETIC_CONTRACT_VECTOR",
        "itemCount": 0,
    }
    assert result["implementation"] == {
        "engine": "native-aegp",
        "capabilityId": "ae.project.summary",
        "capabilityVersion": 1,
        "contractDigest": execution.implementation.contract_digest,
        "risk": "read",
        "mutability": "read-only",
        "idempotency": "idempotent",
    }
    assert result["provenance"]["sourceCommit"] == "a" * 40
    assert result["audit"]["requestId"] == "invoke-summary-1"
    assert result["audit"]["effect"] == "none"
    assert result["evidence"]["engine"] == "native-aegp"
    assert result["evidence"]["postcondition"]["verified"] is True


@pytest.mark.asyncio
async def test_project_folder_public_tool_returns_state_risk_undo_and_audit(monkeypatch):
    execution = _folder_execution()
    captured: dict[str, Any] = {}

    async def _invoke(backend, **kwargs):
        captured["backend"] = backend
        captured.update(kwargs)
        return execution

    sentinel_backend = object()
    monkeypatch.setattr(native_handler, "_backend", lambda: sentinel_backend)
    monkeypatch.setattr(native_handler, "invoke_project_folder_create", _invoke)

    result = await native_handler._run_project_create_folder(
        schemas.AeProjectCreateFolderArgs(
            name="AI Folder",
            idempotency_key="folder-intent-0001",
        ),
        None,
    )

    assert captured["backend"] is sentinel_backend
    assert captured["name"] == "AI Folder"
    assert captured["idempotency_key"] == "folder-intent-0001"
    assert captured["request_id"].startswith("mcp-")
    assert result["created"] is True
    assert result["replayed"] is False
    assert result["state"] == {
        "before": {"projectItemCount": 4},
        "after": {
            "projectItemCount": 5,
            "folder": {"itemId": 17, "name": "AI Folder", "parentItemId": 0},
        },
    }
    assert result["implementation"]["risk"] == "write"
    assert result["implementation"]["mutability"] == "mutating"
    assert result["implementation"]["idempotency"] == "idempotency-key"
    assert result["implementation"]["undo"] == "ae-undo-group"
    assert result["audit"]["effect"] == "committed"
    assert result["audit"]["undoAvailable"] is True
    assert result["audit"]["undoVerified"] is True
    assert "groupId" not in result["evidence"]["undo"]


@pytest.mark.asyncio
async def test_project_folder_never_falls_back_to_legacy_exec(monkeypatch):
    legacy = MockBackend()
    monkeypatch.setattr(native_handler._discovery, "select_backend", lambda: legacy)

    with pytest.raises(NativeBackendError) as raised:
        await native_handler._run_project_create_folder(
            schemas.AeProjectCreateFolderArgs(
                name="AI Folder",
                idempotency_key="folder-intent-0001",
            ),
            None,
        )

    assert raised.value.code == "NATIVE_UNAVAILABLE"
    assert legacy.calls == []


@pytest.mark.asyncio
async def test_project_summary_never_falls_back_to_legacy_exec(monkeypatch):
    legacy = MockBackend()
    monkeypatch.setattr(native_handler._discovery, "select_backend", lambda: legacy)

    with pytest.raises(NativeBackendError) as raised:
        await native_handler._run_project_summary(
            schemas.AeProjectSummaryArgs(),
            None,
        )

    assert raised.value.code == "NATIVE_UNAVAILABLE"
    assert legacy.calls == []


def test_project_summary_registration_is_distinct_from_overview():
    assert HANDLERS["ae.projectSummary"][0] is schemas.AeProjectSummaryArgs
    assert HANDLERS["ae.projectSummary"][1] is not HANDLERS["ae.overview"][1]
    assert HANDLERS["ae.projectCreateFolder"][0] is schemas.AeProjectCreateFolderArgs


@pytest.mark.asyncio
async def test_mcp_dispatch_preserves_structured_native_error(monkeypatch):
    from ae_mcp import server as server_module

    error = NativeBackendError(
        "NATIVE_PAIRING_REQUIRED",
        "Approve the matching fingerprint in After Effects.",
        retryable=True,
        side_effect="not-started",
        recovery=NativeRecovery(
            action="approve-pairing",
            hint="Approve the fingerprint, then retry.",
        ),
        details={
            "pairingFingerprint": "12AB-34CD",
            "pairingExpiresInMs": 60_000,
            "hostInstanceId": "22222222-2222-4222-8222-222222222222",
            "sourceCommit": "a" * 40,
        },
    )

    async def _raise(_args, _ctx):
        raise error

    monkeypatch.setitem(
        HANDLERS,
        "ae.projectSummary",
        (schemas.AeProjectSummaryArgs, _raise),
    )
    monkeypatch.setattr(
        server_module,
        "_filtered_tool_names",
        lambda: set(HANDLERS),
    )
    monkeypatch.setattr(
        server_module.approval_gate,
        "enforce",
        lambda *_args, **_kwargs: _none(),
    )

    response = await server_module.build_server()._ae_call_tool(
        "ae_projectSummary",
        {},
    )
    payload = json.loads(response.content[0].text)

    assert response.isError is True
    assert payload["ok"] is False
    assert isinstance(payload["error"], dict)
    assert payload["error"]["code"] == "NATIVE_PAIRING_REQUIRED"
    assert payload["error"]["details"]["pairingFingerprint"] == "12AB-34CD"


@pytest.mark.asyncio
async def test_mcp_dispatch_preserves_pairing_rejection_as_structured_error(monkeypatch):
    from ae_mcp import server as server_module

    error = NativeBackendError(
        "NATIVE_PAIRING_REJECTED",
        "Native pairing expired before authorization.",
        retryable=True,
        side_effect="not-started",
        recovery=NativeRecovery(
            action="retry-pairing",
            hint="Start a fresh native pairing request and approve it in After Effects.",
        ),
    )

    async def _raise(_args, _ctx):
        raise error

    monkeypatch.setitem(
        HANDLERS,
        "ae.projectSummary",
        (schemas.AeProjectSummaryArgs, _raise),
    )
    monkeypatch.setattr(
        server_module,
        "_filtered_tool_names",
        lambda: set(HANDLERS),
    )
    monkeypatch.setattr(
        server_module.approval_gate,
        "enforce",
        lambda *_args, **_kwargs: _none(),
    )

    response = await server_module.build_server()._ae_call_tool(
        "ae_projectSummary",
        {},
    )
    payload = json.loads(response.content[0].text)

    assert response.isError is True
    assert payload["error"]["code"] == "NATIVE_PAIRING_REJECTED"
    assert payload["error"]["recovery"]["action"] == "retry-pairing"


async def _none():
    return None


class _NativeMock(MockBackend, NativeInvokeBackend):
    async def negotiate(self, **_kwargs):
        raise AssertionError("filtering must not negotiate")

    async def capabilities(self, **_kwargs) -> NativeCapabilities:
        raise AssertionError("filtering must not read capabilities")

    async def invoke(self, *_args, **_kwargs) -> NativeInvokeResult:
        raise AssertionError("filtering must not invoke")


def test_tool_filter_exposes_native_tools_only_for_native_adapter(monkeypatch):
    from ae_mcp import server as server_module
    from ae_mcp.backends import discovery as backend_discovery
    from ae_mcp.snapshot import discovery as snapshot_discovery

    monkeypatch.setattr(
        snapshot_discovery,
        "select_snapshotter",
        lambda: None,
    )
    monkeypatch.setattr(backend_discovery, "select_backend", lambda: MockBackend())
    assert "ae.projectSummary" not in server_module._filtered_tool_names()
    assert "ae.projectCreateFolder" not in server_module._filtered_tool_names()

    monkeypatch.setattr(backend_discovery, "select_backend", lambda: _NativeMock())
    assert "ae.projectSummary" in server_module._filtered_tool_names()
    assert "ae.projectCreateFolder" in server_module._filtered_tool_names()
