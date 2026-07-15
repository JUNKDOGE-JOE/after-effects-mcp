"""Typed Core contract for native project-item and composition-layer pages."""

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
PROTOCOL_FIXTURES = (
    Path(__file__).resolve().parents[3]
    / "native"
    / "ae-plugin"
    / "protocol"
    / "fixtures"
)


def locator(kind: str, object_id: str, *, generation: int = 7) -> dict[str, Any]:
    return {
        "kind": kind,
        "hostInstanceId": HOST,
        "sessionId": SESSION,
        "projectId": PROJECT,
        "generation": generation,
        "objectId": object_id,
    }


PROJECT_LOCATOR = locator("project", "44444444-4444-4444-8444-444444444444")
FOLDER_LOCATOR = locator("item", "55555555-5555-4555-8555-555555555555")
COMP_LOCATOR = locator("composition", "66666666-6666-4666-8666-666666666666")
LAYER_LOCATOR = locator("layer", "77777777-7777-4777-8777-777777777777")


def project_value() -> dict[str, Any]:
    return {
        "projectLocator": PROJECT_LOCATOR,
        "total": 2,
        "offset": 0,
        "limit": 25,
        "returned": 2,
        "hasMore": False,
        "nextOffset": None,
        "items": [
            {
                "locator": FOLDER_LOCATOR,
                "name": "Assets",
                "type": "folder",
                "parentLocator": PROJECT_LOCATOR,
            },
            {
                "locator": COMP_LOCATOR,
                "name": "Main",
                "type": "composition",
                "parentLocator": PROJECT_LOCATOR,
            },
        ],
    }


def layers_value() -> dict[str, Any]:
    return {
        "compositionLocator": COMP_LOCATOR,
        "compositionName": "Main",
        "total": 1,
        "offset": 0,
        "limit": 25,
        "returned": 1,
        "hasMore": False,
        "nextOffset": None,
        "layers": [
            {
                "locator": LAYER_LOCATOR,
                "stackIndex": 1,
                "name": "Title",
                "type": "text",
                "videoEnabled": True,
                "isThreeD": False,
                "locked": False,
                "parentLocator": None,
                "sourceItemLocator": None,
            }
        ],
    }


def test_core_navigation_schemas_and_digests_equal_protocol_descriptors():
    capabilities = json.loads(
        (PROTOCOL_FIXTURES / "capabilities.json").read_text(encoding="utf-8")
    )["response"]["result"]["items"]
    project = next(
        item for item in capabilities if item["id"] == N.PROJECT_ITEMS_LIST_CAPABILITY_ID
    )
    layers = next(
        item
        for item in capabilities
        if item["id"] == N.COMPOSITION_LAYERS_LIST_CAPABILITY_ID
    )
    assert project["inputSchema"] == N._PROJECT_ITEMS_LIST_INPUT_SCHEMA
    assert project["resultSchema"] == N._PROJECT_ITEMS_LIST_RESULT_SCHEMA
    assert project["contractDigest"] == N.PROJECT_ITEMS_LIST_CONTRACT_DIGEST
    assert layers["inputSchema"] == N._COMPOSITION_LAYERS_LIST_INPUT_SCHEMA
    assert layers["resultSchema"] == N._COMPOSITION_LAYERS_LIST_RESULT_SCHEMA
    assert layers["contractDigest"] == N.COMPOSITION_LAYERS_LIST_CONTRACT_DIGEST


def descriptor(*, layers: bool) -> N.NativeCapabilityDescriptor:
    if layers:
        return N.NativeCapabilityDescriptor(
            detail="full",
            id=N.COMPOSITION_LAYERS_LIST_CAPABILITY_ID,
            version=1,
            schema_version=1,
            summary="List a bounded page of layers in one After Effects composition.",
            risk="read",
            mutability="read-only",
            idempotency="idempotent",
            cancellation="before-dispatch",
            undo="not-applicable",
            side_effect_summary="Reads composition layers without changing After Effects state.",
            preconditions=(
                "An After Effects project must be open.",
                "compositionLocator must come from ae.project.items.list@1.",
            ),
            compatibility={
                "status": "unverified",
                "intendedPlatforms": ["macos-arm64", "windows-x64"],
            },
            input_contract_id=N.COMPOSITION_LAYERS_LIST_INPUT_CONTRACT_ID,
            result_contract_id=N.COMPOSITION_LAYERS_LIST_RESULT_CONTRACT_ID,
            contract_digest=N.COMPOSITION_LAYERS_LIST_CONTRACT_DIGEST,
            input_schema=N._COMPOSITION_LAYERS_LIST_INPUT_SCHEMA,
            result_schema=N._COMPOSITION_LAYERS_LIST_RESULT_SCHEMA,
            requirements=({
                "id": "aemcp.requirement.native.composition-layers-list",
                "contractVersion": 1,
            },),
            examples=({"id": "composition-layers-list"},),
        )
    return N.NativeCapabilityDescriptor(
        detail="full",
        id=N.PROJECT_ITEMS_LIST_CAPABILITY_ID,
        version=1,
        schema_version=1,
        summary="List a bounded page of items in the open After Effects project.",
        risk="read",
        mutability="read-only",
        idempotency="idempotent",
        cancellation="before-dispatch",
        undo="not-applicable",
        side_effect_summary="Reads project items without changing After Effects state.",
        preconditions=("An After Effects project must be open.",),
        compatibility={
            "status": "unverified",
            "intendedPlatforms": ["macos-arm64", "windows-x64"],
        },
        input_contract_id=N.PROJECT_ITEMS_LIST_INPUT_CONTRACT_ID,
        result_contract_id=N.PROJECT_ITEMS_LIST_RESULT_CONTRACT_ID,
        contract_digest=N.PROJECT_ITEMS_LIST_CONTRACT_DIGEST,
        input_schema=N._PROJECT_ITEMS_LIST_INPUT_SCHEMA,
        result_schema=N._PROJECT_ITEMS_LIST_RESULT_SCHEMA,
        requirements=({
            "id": "aemcp.requirement.native.project-items-list",
            "contractVersion": 1,
        },),
        examples=({"id": "project-items-list"},),
    )


class ProjectGraphBackend(N.NativeInvokeBackend):
    name = "project-graph-fixture"

    def __init__(self) -> None:
        self.items = (descriptor(layers=False), descriptor(layers=True))
        digest = N._capabilities_registry_digest(self.items)
        self.negotiation = N.NativeNegotiation(
            selected_wire_version=1,
            plugin_version="0.9.2",
            compiled_sdk_version="25.6",
            source_commit="a" * 40,
            host_instance_id=HOST,
            host_platform="macos-arm64",
            session_id=SESSION,
            session_generation=3,
            capabilities_digest=digest,
        )
        self.requests: list[N.NativeInvokeRequest] = []
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
        if request.capability_id == N.PROJECT_ITEMS_LIST_CAPABILITY_ID:
            raw_value = project_value()
            value = N.ProjectItemsListValue.model_validate(raw_value)
            kind = "project-items-list"
            digest = N._project_items_list_digest(value)
        else:
            raw_value = layers_value()
            value = N.CompositionLayersListValue.model_validate(raw_value)
            kind = "composition-layers-list"
            digest = N._composition_layers_list_digest(value)
        if self.tamper_postcondition:
            digest = "f" * 64
        return N.NativeInvokeResult(
            capability_id=request.capability_id,
            capability_version=1,
            engine="native-aegp",
            outcome="succeeded",
            replayed=False,
            value=raw_value,
            evidence=N.NativeExecutionEvidence(
                engine="native-aegp",
                host_instance_id=HOST,
                session_id=SESSION,
                request_id=request.request_id,
                capability_id=request.capability_id,
                capability_version=1,
                started_at_unix_ms=request.deadline_unix_ms - 100,
                completed_at_unix_ms=request.deadline_unix_ms - 1,
                effect="none",
                request_digest=N._invoke_request_digest(request, self.negotiation),
                postcondition=N.NativePostconditionEvidence(
                    verified=True,
                    kind=kind,
                    algorithm="sha256-rfc8785-jcs-v1",
                    digest=digest,
                ),
            ),
        )


@pytest.mark.asyncio
async def test_project_items_list_binds_bounded_arguments_and_verified_page():
    backend = ProjectGraphBackend()
    execution = await N.invoke_project_items_list(
        backend,
        request_id="project-items-1",
        project_locator=None,
        offset=0,
        limit=25,
        deadline_unix_ms=int(time.time() * 1000) + 5_000,
    )
    assert execution.engine == "native-aegp"
    assert execution.value.total == 2
    assert execution.value.items[1].locator.kind == "composition"
    assert backend.requests[0].arguments == {"offset": 0, "limit": 25}
    assert execution.audit_fields()["effect"] == "none"


@pytest.mark.asyncio
async def test_composition_layers_list_consumes_exact_locator_without_jsx():
    backend = ProjectGraphBackend()
    execution = await N.invoke_composition_layers_list(
        backend,
        request_id="composition-layers-1",
        composition_locator=N.NativeLocator.model_validate(COMP_LOCATOR),
        offset=0,
        limit=25,
        deadline_unix_ms=int(time.time() * 1000) + 5_000,
    )
    assert execution.value.layers[0].stack_index == 1
    assert execution.value.layers[0].locked is False
    assert backend.requests[0].arguments == {
        "compositionLocator": COMP_LOCATOR,
        "offset": 0,
        "limit": 25,
    }
    assert execution.value.composition_locator.kind == "composition"


def test_project_graph_values_reject_broken_page_and_locator_context():
    broken_page = project_value()
    broken_page["returned"] = 1
    with pytest.raises(ValidationError):
        N.ProjectItemsListValue.model_validate(broken_page)

    stale_context = layers_value()
    stale_context["layers"][0]["locator"] = locator(
        "layer", "77777777-7777-4777-8777-777777777777", generation=8
    )
    with pytest.raises(ValidationError):
        N.CompositionLayersListValue.model_validate(stale_context)

    stalled_projects = project_value()
    stalled_projects.update(
        total=1,
        returned=0,
        hasMore=True,
        nextOffset=0,
        items=[],
    )
    with pytest.raises(ValidationError):
        N.ProjectItemsListValue.model_validate(stalled_projects)

    stalled_layers = layers_value()
    stalled_layers.update(
        total=1,
        returned=0,
        hasMore=True,
        nextOffset=0,
        layers=[],
    )
    with pytest.raises(ValidationError):
        N.CompositionLayersListValue.model_validate(stalled_layers)


@pytest.mark.asyncio
async def test_project_graph_read_rejects_unbound_postcondition_as_contract_mismatch():
    backend = ProjectGraphBackend()
    backend.tamper_postcondition = True
    with pytest.raises(N.NativeBackendError) as raised:
        await N.invoke_project_items_list(
            backend,
            request_id="project-items-tampered",
            project_locator=None,
            offset=0,
            limit=25,
            deadline_unix_ms=int(time.time() * 1000) + 5_000,
        )
    assert raised.value.code == "NATIVE_CONTRACT_MISMATCH"
    assert raised.value.side_effect == "not-started"


@pytest.mark.asyncio
async def test_stale_navigation_locator_has_a_model_actionable_recovery_path():
    backend = ProjectGraphBackend()
    stale = {**COMP_LOCATOR, "sessionId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}
    with pytest.raises(N.NativeBackendError) as raised:
        await N.invoke_composition_layers_list(
            backend,
            request_id="composition-layers-stale",
            composition_locator=stale,
            offset=0,
            limit=25,
            deadline_unix_ms=int(time.time() * 1000) + 5_000,
        )
    assert raised.value.code == "STALE_LOCATOR"
    assert raised.value.side_effect == "not-started"
    assert raised.value.recovery.action == "refresh-locator"
    assert "ae_listProjectItems" in raised.value.recovery.hint
    assert raised.value.details == {
        "field": "params.arguments.compositionLocator",
        "capabilityId": N.COMPOSITION_LAYERS_LIST_CAPABILITY_ID,
    }
    assert "currentGeneration" not in raised.value.details

    stale_project = {
        **PROJECT_LOCATOR,
        "hostInstanceId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }
    with pytest.raises(N.NativeBackendError) as project_raised:
        await N.invoke_project_items_list(
            backend,
            request_id="project-items-stale",
            project_locator=stale_project,
            offset=1,
            limit=25,
            deadline_unix_ms=int(time.time() * 1000) + 5_000,
        )
    assert project_raised.value.details == {
        "field": "params.arguments.projectLocator",
        "capabilityId": N.PROJECT_ITEMS_LIST_CAPABILITY_ID,
    }
    assert "currentGeneration" not in project_raised.value.details
