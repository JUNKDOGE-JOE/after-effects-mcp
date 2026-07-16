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
    raw_items = _fixture("capabilities.json")["response"]["result"]["items"]
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
    raw_items = _fixture("capabilities.json")["response"]["result"]["items"]
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
    descriptors = _fixture("capabilities.json")["response"]["result"]["items"]
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


@pytest.mark.asyncio
async def test_project_summary_returns_typed_value_provenance_and_evidence(monkeypatch):
    execution = _summary_execution()
    sentinel_backend = object()
    captured: dict[str, Any] = {}

    async def _invoke(backend, **kwargs):
        captured["backend"] = backend
        captured.update(kwargs)
        return execution

    monkeypatch.setattr(native_handler, "_backend", lambda: sentinel_backend)
    monkeypatch.setattr(native_handler, "invoke_project_summary", _invoke)
    result = await native_handler._run_project_summary(
        schemas.AeProjectSummaryArgs(), None
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
async def test_bit_depth_read_public_tool_returns_native_state(monkeypatch):
    execution = _read_execution()
    captured: dict[str, Any] = {}

    async def _invoke(backend, **kwargs):
        captured["backend"] = backend
        captured.update(kwargs)
        return execution

    sentinel_backend = object()
    monkeypatch.setattr(native_handler, "_backend", lambda: sentinel_backend)
    monkeypatch.setattr(native_handler, "invoke_project_bit_depth_read", _invoke)
    result = await native_handler._run_get_project_bit_depth(
        schemas.AeGetProjectBitDepthArgs(), None
    )

    assert captured["backend"] is sentinel_backend
    assert result["value"] == {"bitsPerChannel": 8}
    assert result["implementation"]["risk"] == "read"
    assert result["audit"]["effect"] == "none"
    assert "undo" not in result["evidence"]


@pytest.mark.asyncio
async def test_bit_depth_set_public_tool_returns_transition_undo_and_audit(monkeypatch):
    execution = _set_execution()
    captured: dict[str, Any] = {}

    async def _invoke(backend, **kwargs):
        captured["backend"] = backend
        captured.update(kwargs)
        return execution

    sentinel_backend = object()
    monkeypatch.setattr(native_handler, "_backend", lambda: sentinel_backend)
    monkeypatch.setattr(native_handler, "invoke_project_bit_depth_set", _invoke)
    result = await native_handler._run_set_project_bit_depth(
        schemas.AeSetProjectBitDepthArgs(
            target_depth=16,
            idempotency_key="bit-depth-intent-0001",
        ),
        None,
    )

    assert captured["backend"] is sentinel_backend
    assert captured["target_depth"] == 16
    assert captured["idempotency_key"] == "bit-depth-intent-0001"
    assert result["value"] == {
        "changed": True,
        "beforeBitsPerChannel": 8,
        "afterBitsPerChannel": 16,
    }
    assert "state" not in result
    assert result["implementation"]["risk"] == "write"
    assert result["implementation"]["undo"] == "ae-undo-group"
    assert result["audit"]["effect"] == "committed"
    assert result["audit"]["undoAvailable"] is True
    assert result["audit"]["undoVerified"] is False
    assert "groupId" not in result["evidence"]["undo"]


@pytest.mark.asyncio
async def test_project_items_public_tool_returns_bounded_native_page(monkeypatch):
    execution = _project_graph_execution(layers=False)
    captured: dict[str, Any] = {}

    async def _invoke(backend, **kwargs):
        captured["backend"] = backend
        captured.update(kwargs)
        return execution

    sentinel_backend = object()
    monkeypatch.setattr(native_handler, "_backend", lambda: sentinel_backend)
    monkeypatch.setattr(native_handler, "invoke_project_items_list", _invoke)
    result = await native_handler._run_list_project_items(
        schemas.AeListProjectItemsArgs(), None
    )

    assert captured["backend"] is sentinel_backend
    assert captured["project_locator"] is None
    assert captured["offset"] == 0
    assert captured["limit"] == 25
    assert result["value"]["returned"] == 2
    assert result["value"]["items"][1]["type"] == "composition"
    assert result["implementation"]["capabilityId"] == "ae.project.items.list"
    assert result["audit"]["effect"] == "none"


@pytest.mark.asyncio
async def test_composition_layers_public_tool_forwards_exact_locator(monkeypatch):
    execution = _project_graph_execution(layers=True)
    captured: dict[str, Any] = {}

    async def _invoke(backend, **kwargs):
        captured["backend"] = backend
        captured.update(kwargs)
        return execution

    sentinel_backend = object()
    locator = execution.value.composition_locator.model_dump(
        mode="json", by_alias=True
    )
    monkeypatch.setattr(native_handler, "_backend", lambda: sentinel_backend)
    monkeypatch.setattr(native_handler, "invoke_composition_layers_list", _invoke)
    result = await native_handler._run_list_composition_layers(
        schemas.AeListCompositionLayersArgs(composition_locator=locator), None
    )

    assert captured["backend"] is sentinel_backend
    assert captured["composition_locator"] == locator
    assert result["value"]["layers"][0]["locked"] is False
    assert result["implementation"]["capabilityId"] == "ae.composition.layers.list"
    assert result["provenance"]["sourceCommit"] == "a" * 40


@pytest.mark.asyncio
async def test_composition_time_public_tool_forwards_locator_and_exact_time(monkeypatch):
    execution = _composition_time_execution()
    captured: dict[str, Any] = {}

    async def _invoke(backend, **kwargs):
        captured["backend"] = backend
        captured.update(kwargs)
        return execution

    sentinel_backend = object()
    locator = execution.value.composition_locator.model_dump(
        mode="json", by_alias=True
    )
    monkeypatch.setattr(native_handler, "_backend", lambda: sentinel_backend)
    monkeypatch.setattr(native_handler, "invoke_composition_time_read", _invoke)
    result = await native_handler._run_get_composition_time(
        schemas.AeGetCompositionTimeArgs(composition_locator=locator), None
    )

    assert captured["backend"] is sentinel_backend
    assert captured["composition_locator"] == locator
    assert result["value"] == {
        "compositionLocator": locator,
        "currentTime": {
            "value": 60,
            "scale": 24,
            "secondsRational": "5/2",
        },
    }
    assert "compositionName" not in result["value"]
    assert result["implementation"]["capabilityId"] == "ae.composition.time.read"
    assert result["implementation"]["engine"] == "native-aegp"
    assert result["evidence"]["postcondition"]["verified"] is True
    assert result["evidence"]["effect"] == "none"


@pytest.mark.asyncio
async def test_composition_time_set_public_tool_returns_transition_undo_and_audit(monkeypatch):
    execution = _composition_time_set_execution()
    captured: dict[str, Any] = {}

    async def _invoke(backend, **kwargs):
        captured["backend"] = backend
        captured.update(kwargs)
        return execution

    sentinel_backend = object()
    locator = execution.value.composition_locator.model_dump(
        mode="json", by_alias=True
    )
    monkeypatch.setattr(native_handler, "_backend", lambda: sentinel_backend)
    monkeypatch.setattr(native_handler, "invoke_composition_time_set", _invoke)
    result = await native_handler._run_set_composition_time(
        schemas.AeSetCompositionTimeArgs(
            composition_locator=locator,
            target_time={"value": 1, "scale": 1},
            idempotency_key="synthetic-comp-time-0001",
        ),
        None,
    )

    assert captured["backend"] is sentinel_backend
    assert captured["composition_locator"] == locator
    assert captured["target_time"] == {"value": 1, "scale": 1}
    assert captured["idempotency_key"] == "synthetic-comp-time-0001"
    assert result["value"]["beforeTime"] == {
        "value": 0, "scale": 1, "secondsRational": "0",
    }
    assert result["value"]["afterTime"] == {
        "value": 1, "scale": 1, "secondsRational": "1",
    }
    assert result["implementation"]["capabilityId"] == "ae.composition.time.set"
    assert result["implementation"]["undo"] == "ae-undo-group"
    assert result["audit"]["effect"] == "committed"
    assert result["audit"]["undoAvailable"] is True
    assert result["audit"]["undoVerified"] is False


@pytest.mark.asyncio
async def test_composition_time_set_real_mcp_surface_is_strict_and_structured(monkeypatch):
    from mcp.shared.memory import create_connected_server_and_client_session

    from ae_mcp import server as server_module

    schema_cls, _ = HANDLERS["ae.setCompositionTime"]
    dispatches: list[schemas.AeSetCompositionTimeArgs] = []

    async def _run(validated, _ctx):
        dispatches.append(validated)
        return {"ok": True, "value": {"changed": True}}

    monkeypatch.setitem(HANDLERS, "ae.setCompositionTime", (schema_cls, _run))
    monkeypatch.setattr(
        server_module, "_filtered_tool_names", lambda: {"ae.setCompositionTime"}
    )
    monkeypatch.setattr(
        server_module.approval_gate,
        "enforce",
        lambda *_args, **_kwargs: _none(),
    )
    server = server_module.build_server()
    locator = _composition_time_set_execution().value.composition_locator.model_dump(
        mode="json", by_alias=True
    )

    async with create_connected_server_and_client_session(server) as client:
        listed = await client.list_tools()
        assert [tool.name for tool in listed.tools] == ["ae_setCompositionTime"]
        public_schema = listed.tools[0].inputSchema
        assert set(public_schema["required"]) == {
            "composition_locator", "target_time", "idempotency_key",
        }
        assert public_schema["additionalProperties"] is False

        rejected = await client.call_tool(
            "ae_setCompositionTime",
            {
                "composition_locator": locator,
                "target_time": {"value": 1, "scale": 0},
                "idempotency_key": "synthetic-comp-time-0001",
            },
        )
        assert rejected.isError is True
        payload = json.loads(rejected.content[0].text)
        assert payload["error"]["code"] == "INVALID_ARGUMENT"
        assert payload["error"]["sideEffect"] == "not-started"
        assert payload["error"]["details"] == {
            "field": "arguments.target_time.scale",
            "capabilityId": "ae.composition.time.set",
        }
        assert dispatches == []

        accepted = await client.call_tool(
            "ae_setCompositionTime",
            {
                "composition_locator": locator,
                "target_time": {"value": 1, "scale": 1},
                "idempotency_key": "synthetic-comp-time-0001",
            },
        )
        assert accepted.isError is False
        assert len(dispatches) == 1


@pytest.mark.asyncio
async def test_composition_time_real_mcp_surface_is_strict_and_structured(monkeypatch):
    from mcp.shared.memory import create_connected_server_and_client_session

    from ae_mcp import server as server_module

    load_all()
    schema_cls, _ = HANDLERS["ae.getCompositionTime"]
    dispatches: list[schemas.AeGetCompositionTimeArgs] = []

    async def _run(validated, _ctx):
        dispatches.append(validated)
        return {
            "ok": True,
            "value": {
                "compositionLocator": validated.composition_locator.model_dump(
                    mode="json", by_alias=True
                ),
                "currentTime": {
                    "value": 60,
                    "scale": 24,
                    "secondsRational": "5/2",
                },
            },
        }

    monkeypatch.setitem(
        HANDLERS,
        "ae.getCompositionTime",
        (schema_cls, _run),
    )
    monkeypatch.setattr(
        server_module,
        "_filtered_tool_names",
        lambda: {"ae.getCompositionTime"},
    )
    monkeypatch.setattr(
        server_module.approval_gate,
        "enforce",
        lambda *_args, **_kwargs: _none(),
    )
    server = server_module.build_server()
    valid_locator = _composition_time_execution().value.composition_locator.model_dump(
        mode="json", by_alias=True
    )

    async with create_connected_server_and_client_session(server) as client:
        listed = await client.list_tools()
        assert [tool.name for tool in listed.tools] == ["ae_getCompositionTime"]
        public_schema = listed.tools[0].inputSchema
        assert public_schema["required"] == ["composition_locator"]
        assert set(public_schema["properties"]) == {"composition_locator"}
        assert public_schema["additionalProperties"] is False

        invalid_cases = (
            ({}, "arguments.composition_locator"),
            (
                {
                    "composition_locator": {
                        **valid_locator,
                        "kind": "project",
                    }
                },
                "arguments.composition_locator.kind",
            ),
            (
                {
                    "composition_locator": valid_locator,
                    "comp_id": 1,
                },
                "arguments.comp_id",
            ),
        )
        for arguments, expected_field in invalid_cases:
            rejected = await client.call_tool("ae_getCompositionTime", arguments)
            assert rejected.isError is True
            payload = json.loads(rejected.content[0].text)
            assert payload["ok"] is False
            assert payload["error"]["code"] == "INVALID_ARGUMENT"
            assert payload["error"]["sideEffect"] == "not-started"
            assert payload["error"]["recovery"] == {
                "action": "change-arguments",
                "hint": (
                    "Copy an unmodified composition_locator from "
                    "ae_listProjectItems and retry."
                ),
            }
            assert payload["error"]["details"] == {
                "field": expected_field,
                "capabilityId": "ae.composition.time.read",
            }
        assert dispatches == []

        accepted = await client.call_tool(
            "ae_getCompositionTime",
            {"composition_locator": valid_locator},
        )
        assert accepted.isError is False
        assert json.loads(accepted.content[0].text)["value"]["currentTime"] == {
            "value": 60,
            "scale": 24,
            "secondsRational": "5/2",
        }
        assert len(dispatches) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("runner", "args"),
    [
        (native_handler._run_project_summary, schemas.AeProjectSummaryArgs()),
        (native_handler._run_list_project_items, schemas.AeListProjectItemsArgs()),
        (
            native_handler._run_list_composition_layers,
            schemas.AeListCompositionLayersArgs(
                composition_locator={
                    "kind": "composition",
                    "hostInstanceId": "22222222-2222-4222-8222-222222222222",
                    "sessionId": "11111111-1111-4111-8111-111111111111",
                    "projectId": "44444444-4444-4444-8444-444444444444",
                    "generation": 8,
                    "objectId": "66666666-6666-4666-8666-666666666666",
                }
            ),
        ),
        (
            native_handler._run_list_selected_layers,
            schemas.AeListSelectedLayersArgs(
                composition_locator={
                    "kind": "composition",
                    "hostInstanceId": "22222222-2222-4222-8222-222222222222",
                    "sessionId": "11111111-1111-4111-8111-111111111111",
                    "projectId": "44444444-4444-4444-8444-444444444444",
                    "generation": 8,
                    "objectId": "66666666-6666-4666-8666-666666666666",
                }
            ),
        ),
        (
            native_handler._run_get_composition_time,
            schemas.AeGetCompositionTimeArgs(
                composition_locator={
                    "kind": "composition",
                    "hostInstanceId": "22222222-2222-4222-8222-222222222222",
                    "sessionId": "11111111-1111-4111-8111-111111111111",
                    "projectId": "44444444-4444-4444-8444-444444444444",
                    "generation": 8,
                    "objectId": "66666666-6666-4666-8666-666666666666",
                }
            ),
        ),
        (
            native_handler._run_set_composition_time,
            schemas.AeSetCompositionTimeArgs(
                composition_locator={
                    "kind": "composition",
                    "hostInstanceId": "22222222-2222-4222-8222-222222222222",
                    "sessionId": "11111111-1111-4111-8111-111111111111",
                    "projectId": "44444444-4444-4444-8444-444444444444",
                    "generation": 8,
                    "objectId": "66666666-6666-4666-8666-666666666666",
                },
                target_time={"value": 1, "scale": 1},
                idempotency_key="composition-time-intent-0001",
            ),
        ),
        (native_handler._run_get_project_bit_depth, schemas.AeGetProjectBitDepthArgs()),
        (
            native_handler._run_set_project_bit_depth,
            schemas.AeSetProjectBitDepthArgs(
                target_depth=16,
                idempotency_key="bit-depth-intent-0001",
            ),
        ),
        (
            native_handler._run_set_layer_property_value,
            schemas.AeSetLayerPropertyValueArgs(
                layer_locator={
                    "kind": "layer",
                    "hostInstanceId": "22222222-2222-4222-8222-222222222222",
                    "sessionId": "11111111-1111-4111-8111-111111111111",
                    "projectId": "44444444-4444-4444-8444-444444444444",
                    "generation": 8,
                    "objectId": "88888888-8888-4888-8888-888888888888",
                },
                property_locator={
                    "kind": "stream",
                    "hostInstanceId": "22222222-2222-4222-8222-222222222222",
                    "sessionId": "11111111-1111-4111-8111-111111111111",
                    "projectId": "44444444-4444-4444-8444-444444444444",
                    "generation": 8,
                    "objectId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                },
                value={"kind": "scalar", "value": "40"},
                idempotency_key="layer-property-intent-0001",
            ),
        ),
    ],
)
async def test_native_public_tools_never_fall_back_to_legacy_exec(
    monkeypatch, runner, args
):
    legacy = MockBackend()
    monkeypatch.setattr(native_handler._discovery, "select_backend", lambda: legacy)
    with pytest.raises(N.NativeBackendError) as raised:
        await runner(args, None)
    assert raised.value.code == "NATIVE_UNAVAILABLE"
    assert legacy.calls == []


def test_native_tool_registration_is_explicit():
    assert HANDLERS["ae.projectSummary"][0] is schemas.AeProjectSummaryArgs
    assert HANDLERS["ae.listProjectItems"][0] is schemas.AeListProjectItemsArgs
    assert (
        HANDLERS["ae.listCompositionLayers"][0]
        is schemas.AeListCompositionLayersArgs
    )
    assert (
        HANDLERS["ae.listSelectedLayers"][0]
        is schemas.AeListSelectedLayersArgs
    )
    assert HANDLERS["ae.getCompositionTime"][0] is schemas.AeGetCompositionTimeArgs
    assert HANDLERS["ae.setCompositionTime"][0] is schemas.AeSetCompositionTimeArgs
    assert HANDLERS["ae.getProjectBitDepth"][0] is schemas.AeGetProjectBitDepthArgs
    assert HANDLERS["ae.setProjectBitDepth"][0] is schemas.AeSetProjectBitDepthArgs
    assert (
        HANDLERS["ae.setLayerPropertyValue"][0]
        is schemas.AeSetLayerPropertyValueArgs
    )
    assert (
        HANDLERS["ae.createComposition"][0]
        is schemas.AeCreateCompositionArgs
    )
    assert (
        HANDLERS["ae.createCompositionLayer"][0]
        is schemas.AeCreateCompositionLayerArgs
    )
    assert HANDLERS["ae.applyLayerEffect"][0] is schemas.AeApplyLayerEffectArgs
    assert HANDLERS["ae.projectSummary"][1] is not HANDLERS["ae.overview"][1]


@pytest.mark.asyncio
async def test_mcp_dispatch_preserves_structured_native_error(monkeypatch):
    from ae_mcp import server as server_module

    error = N.NativeBackendError(
        "NATIVE_PAIRING_REQUIRED",
        "Approve the matching fingerprint in After Effects.",
        retryable=True,
        side_effect="not-started",
        recovery=N.NativeRecovery(
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
        "ae.getProjectBitDepth",
        (schemas.AeGetProjectBitDepthArgs, _raise),
    )
    monkeypatch.setattr(server_module, "_filtered_tool_names", lambda: set(HANDLERS))
    monkeypatch.setattr(
        server_module.approval_gate,
        "enforce",
        lambda *_args, **_kwargs: _none(),
    )

    response = await server_module.build_server()._ae_call_tool(
        "ae_getProjectBitDepth", {}
    )
    payload = json.loads(response.content[0].text)
    assert response.isError is True
    assert payload["error"]["code"] == "NATIVE_PAIRING_REQUIRED"
    assert payload["error"]["details"]["pairingFingerprint"] == "12AB-34CD"


@pytest.mark.asyncio
async def test_mcp_dispatch_preserves_pairing_rejection_as_structured_error(monkeypatch):
    from ae_mcp import server as server_module

    error = N.NativeBackendError(
        "NATIVE_PAIRING_REJECTED",
        "Native pairing expired before authorization.",
        retryable=True,
        side_effect="not-started",
        recovery=N.NativeRecovery(
            action="retry-pairing",
            hint="Start a fresh native pairing request and approve it in After Effects.",
        ),
    )

    async def _raise(_args, _ctx):
        raise error

    monkeypatch.setitem(
        HANDLERS,
        "ae.getProjectBitDepth",
        (schemas.AeGetProjectBitDepthArgs, _raise),
    )
    monkeypatch.setattr(server_module, "_filtered_tool_names", lambda: set(HANDLERS))
    monkeypatch.setattr(
        server_module.approval_gate,
        "enforce",
        lambda *_args, **_kwargs: _none(),
    )

    response = await server_module.build_server()._ae_call_tool(
        "ae_getProjectBitDepth", {}
    )
    payload = json.loads(response.content[0].text)
    assert response.isError is True
    assert payload["error"]["code"] == "NATIVE_PAIRING_REJECTED"
    assert payload["error"]["recovery"]["action"] == "retry-pairing"


async def _none():
    return None


class _NativeMock(MockBackend, N.NativeInvokeBackend):
    async def negotiate(self, **_kwargs):
        raise AssertionError("filtering must not negotiate")

    async def capabilities(self, **_kwargs) -> N.NativeCapabilities:
        raise AssertionError("filtering must not read capabilities")

    async def invoke(self, *_args, **_kwargs) -> N.NativeInvokeResult:
        raise AssertionError("filtering must not invoke")


def test_tool_filter_exposes_native_tools_only_for_native_adapter(monkeypatch):
    from ae_mcp import server as server_module
    from ae_mcp.backends import discovery as backend_discovery
    from ae_mcp.snapshot import discovery as snapshot_discovery

    monkeypatch.setattr(snapshot_discovery, "select_snapshotter", lambda: None)
    monkeypatch.setattr(backend_discovery, "select_backend", lambda: MockBackend())
    names = server_module._filtered_tool_names()
    assert "ae.projectSummary" not in names
    assert "ae.getProjectBitDepth" not in names
    assert "ae.setProjectBitDepth" not in names
    assert "ae.setLayerPropertyValue" not in names
    assert "ae.createCompositionLayer" not in names
    assert "ae.applyLayerEffect" not in names
    assert "ae.listSelectedLayers" not in names

    monkeypatch.setattr(backend_discovery, "select_backend", lambda: _NativeMock())
    names = server_module._filtered_tool_names()
    assert "ae.projectSummary" in names
    assert "ae.getProjectBitDepth" in names
    assert "ae.setProjectBitDepth" in names
    assert "ae.setLayerPropertyValue" in names
    assert "ae.createCompositionLayer" in names
    assert "ae.applyLayerEffect" in names
    assert "ae.listSelectedLayers" in names
