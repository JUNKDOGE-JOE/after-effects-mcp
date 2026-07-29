"""Public MCP surfaces explicitly bound to typed native AEGP capabilities."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from ae_mcp import schemas
from ae_mcp.backends import native as N
from ae_mcp.backends.mock import MockBackend
from ae_mcp.handlers import HANDLERS, load_all
from ae_mcp.handlers import native as native_handler


_FIXTURES = Path(__file__).resolve().parents[3] / "native" / "ae-plugin" / "protocol" / "fixtures"


def _fixture(name: str) -> dict[str, Any]:
    return json.loads((_FIXTURES / name).read_text(encoding="utf-8"))


def _summary_execution() -> N.ProjectSummaryExecution:
    hello = _fixture("hello.json")["response"]["result"]
    raw_result = _fixture("invoke-project-summary.json")["response"]["result"]
    raw_items = _fixture("capability-registry-full.json")["items"]
    descriptor = N.NativeCapabilityDescriptor.model_validate(
        next(item for item in raw_items if item["id"] == "ae.project.summary")
    )
    negotiation = N.NativeNegotiation(
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
    result = N.NativeInvokeResult.model_validate({**raw_result, "replayed": False})
    return N.ProjectSummaryExecution(
        implementation=descriptor,
        negotiation=negotiation,
        value=N.ProjectSummaryValue.model_validate(result.value),
        evidence=result.evidence,
    )


def _bit_depth_descriptor(*, write: bool) -> N.NativeCapabilityDescriptor:
    if write:
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
            compatibility={
                "status": "unverified",
                "intendedPlatforms": ["macos-arm64", "windows-x64"],
            },
            input_contract_id="aemcp.contract.ae.project.bit-depth.set.input.v1",
            result_contract_id="aemcp.contract.ae.project.bit-depth.set.result.v1",
            contract_digest=N.PROJECT_BIT_DEPTH_SET_CONTRACT_DIGEST,
            input_schema=N._PROJECT_BIT_DEPTH_SET_INPUT_SCHEMA,
            result_schema=N._PROJECT_BIT_DEPTH_SET_RESULT_SCHEMA,
            requirements=(
                {
                    "id": "aemcp.requirement.native.project-bit-depth-set",
                    "contractVersion": 1,
                },
            ),
            examples=({"id": "bit-depth-set"},),
        )
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
        compatibility={
            "status": "unverified",
            "intendedPlatforms": ["macos-arm64", "windows-x64"],
        },
        input_contract_id="aemcp.contract.ae.project.bit-depth.read.input.v1",
        result_contract_id="aemcp.contract.ae.project.bit-depth.read.result.v1",
        contract_digest=N.PROJECT_BIT_DEPTH_READ_CONTRACT_DIGEST,
        input_schema=N._PROJECT_BIT_DEPTH_READ_INPUT_SCHEMA,
        result_schema=N._PROJECT_BIT_DEPTH_READ_RESULT_SCHEMA,
        requirements=(
            {
                "id": "aemcp.requirement.native.project-bit-depth-read",
                "contractVersion": 1,
            },
        ),
        examples=({"id": "bit-depth-read"},),
    )


def _read_execution() -> N.ProjectBitDepthReadExecution:
    summary = _summary_execution()
    return N.ProjectBitDepthReadExecution(
        implementation=_bit_depth_descriptor(write=False),
        negotiation=summary.negotiation,
        value=N.ProjectBitDepthReadValue(bits_per_channel=8),
        evidence=N.NativeExecutionEvidence(
            engine="native-aegp",
            host_instance_id=summary.negotiation.host_instance_id,
            session_id=summary.negotiation.session_id,
            request_id="core-bit-depth-read-1",
            capability_id=N.PROJECT_BIT_DEPTH_READ_CAPABILITY_ID,
            capability_version=1,
            started_at_unix_ms=1_900_000_000_000,
            completed_at_unix_ms=1_900_000_000_010,
            effect="none",
            request_digest="b" * 64,
            postcondition=N.NativePostconditionEvidence(
                verified=True,
                kind="project-bit-depth-read",
                algorithm="sha256-rfc8785-jcs-v1",
                digest="c" * 64,
            ),
        ),
    )


def _set_execution() -> N.ProjectBitDepthSetExecution:
    summary = _summary_execution()
    return N.ProjectBitDepthSetExecution(
        implementation=_bit_depth_descriptor(write=True),
        negotiation=summary.negotiation,
        transport_request_id="core-bit-depth-set-1",
        idempotency_key="bit-depth-intent-0001",
        replayed=False,
        value=N.ProjectBitDepthSetValue(
            changed=True,
            before_bits_per_channel=8,
            after_bits_per_channel=16,
        ),
        evidence=N.NativeExecutionEvidence(
            engine="native-aegp",
            host_instance_id=summary.negotiation.host_instance_id,
            session_id=summary.negotiation.session_id,
            request_id="core-bit-depth-set-1",
            capability_id=N.PROJECT_BIT_DEPTH_SET_CAPABILITY_ID,
            capability_version=1,
            started_at_unix_ms=1_900_000_000_000,
            completed_at_unix_ms=1_900_000_000_025,
            effect="committed",
            request_digest="d" * 64,
            postcondition=N.NativePostconditionEvidence(
                verified=True,
                kind="project-bit-depth-set",
                algorithm="sha256-rfc8785-jcs-v1",
                digest="e" * 64,
            ),
            undo=N.NativeUndoEvidence(available=True, verified=False),
        ),
    )


def _project_graph_execution(*, layers: bool):
    fixture_name = (
        "invoke-composition-layers-list.json"
        if layers
        else "invoke-project-items-list.json"
    )
    capability_id = (
        N.COMPOSITION_LAYERS_LIST_CAPABILITY_ID
        if layers
        else N.PROJECT_ITEMS_LIST_CAPABILITY_ID
    )
    hello = _fixture("hello.json")["response"]["result"]
    raw_items = _fixture("capability-registry-full.json")["items"]
    descriptor = N.NativeCapabilityDescriptor.model_validate(
        next(item for item in raw_items if item["id"] == capability_id)
    )
    negotiation = N.NativeNegotiation(
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
    fixture = _fixture(fixture_name)
    raw_result = fixture["response"]["result"]
    result = N.NativeInvokeResult.model_validate(
        {**raw_result, "replayed": fixture["response"]["replayed"]}
    )
    if layers:
        return N.CompositionLayersListExecution(
            implementation=descriptor,
            negotiation=negotiation,
            value=N.CompositionLayersListValue.model_validate(result.value),
            evidence=result.evidence,
        )
    return N.ProjectItemsListExecution(
        implementation=descriptor,
        negotiation=negotiation,
        value=N.ProjectItemsListValue.model_validate(result.value),
        evidence=result.evidence,
    )


def _composition_time_execution() -> N.CompositionTimeReadExecution:
    summary = _summary_execution()
    locator = {
        "kind": "composition",
        "hostInstanceId": summary.negotiation.host_instance_id,
        "sessionId": summary.negotiation.session_id,
        "projectId": "33333333-3333-4333-8333-333333333333",
        "generation": 7,
        "objectId": "66666666-6666-4666-8666-666666666666",
    }
    value = N.CompositionTimeReadValue.model_validate({
        "compositionLocator": locator,
        "currentTime": {
            "value": 60,
            "scale": 24,
            "secondsRational": "5/2",
        },
    })
    return N.CompositionTimeReadExecution(
        implementation=N.NativeCapabilityDescriptor(
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
        ),
        negotiation=summary.negotiation,
        value=value,
        evidence=N.NativeExecutionEvidence(
            engine="native-aegp",
            host_instance_id=summary.negotiation.host_instance_id,
            session_id=summary.negotiation.session_id,
            request_id="composition-time-read-1",
            capability_id=N.COMPOSITION_TIME_READ_CAPABILITY_ID,
            capability_version=1,
            started_at_unix_ms=1_900_000_000_000,
            completed_at_unix_ms=1_900_000_000_001,
            effect="none",
            request_digest="b" * 64,
            postcondition=N.NativePostconditionEvidence(
                verified=True,
                kind="composition-time-read",
                algorithm="sha256-rfc8785-jcs-v1",
                digest=N._composition_time_read_digest(value),
            ),
        ),
    )


def _composition_time_set_execution() -> N.CompositionTimeSetExecution:
    summary = _summary_execution()
    descriptors = _fixture("capability-registry-full.json")["items"]
    descriptor = N.NativeCapabilityDescriptor.model_validate(
        next(item for item in descriptors if item["id"] == "ae.composition.time.set")
    )
    fixture = _fixture("invoke-composition-time-set.json")
    raw_result = fixture["response"]["result"]
    result = N.NativeInvokeResult.model_validate(
        {**raw_result, "replayed": fixture["response"]["replayed"]}
    )
    return N.CompositionTimeSetExecution(
        implementation=descriptor,
        negotiation=summary.negotiation,
        transport_request_id=result.evidence.request_id,
        idempotency_key=fixture["request"]["params"]["arguments"]["idempotencyKey"],
        replayed=result.replayed,
        value=N.CompositionTimeSetValue.model_validate(result.value),
        evidence=result.evidence,
    )


@pytest.fixture(autouse=True)
def _load_handlers():
    load_all()


def test_native_tool_registration_exposes_only_native_exec():
    assert HANDLERS["ae.nativeExec"][0] is schemas.AeNativeExecArgs
    assert "ae.projectSummary" not in HANDLERS
    assert "ae.getProjectBitDepth" not in HANDLERS
    assert "ae.setProjectBitDepth" not in HANDLERS
    assert "ae.setLayerPropertyValue" not in HANDLERS
    assert "ae.createCompositionLayer" not in HANDLERS
    assert "ae.applyLayerEffect" not in HANDLERS
    assert "ae.listSelectedLayers" not in HANDLERS


async def _none():
    return None


class _NativeMock(MockBackend, N.NativeInvokeBackend):
    async def negotiate(self, **_kwargs):
        raise AssertionError("filtering must not negotiate")

    async def capabilities(self, **_kwargs) -> N.NativeCapabilities:
        raise AssertionError("filtering must not read capabilities")

    async def invoke(self, *_args, **_kwargs) -> N.NativeInvokeResult:
        raise AssertionError("filtering must not invoke")


def test_tool_filter_exposes_native_exec_only_for_native_adapter(monkeypatch):
    from ae_mcp import server as server_module
    from ae_mcp.backends import discovery as backend_discovery
    from ae_mcp.snapshot import discovery as snapshot_discovery

    monkeypatch.setattr(snapshot_discovery, "select_snapshotter", lambda: None)
    monkeypatch.setattr(backend_discovery, "select_backend", lambda: MockBackend())
    names = server_module._filtered_tool_names()
    assert "ae.exec" in names
    assert "ae.nativeExec" not in names

    monkeypatch.setattr(backend_discovery, "select_backend", lambda: _NativeMock())
    names = server_module._filtered_tool_names()
    assert "ae.exec" in names
    assert "ae.nativeExec" in names
