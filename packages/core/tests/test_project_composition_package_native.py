"""Focused Core contracts for the #150 Project / Composition package."""

from __future__ import annotations

import time
from fractions import Fraction
from typing import Any

import pytest
from pydantic import ValidationError

from ae_mcp import schemas
from ae_mcp.annotations import VERB_ANNOTATIONS
from ae_mcp.backends import native as N
from ae_mcp.backends import native_project_composition as PC
from ae_mcp.handlers import HANDLERS, load_all
from ae_mcp.handlers import native as native_handlers
from ae_mcp import server as server_module


HOST = "22222222-2222-4222-8222-222222222222"
SESSION = "11111111-1111-4111-8111-111111111111"
PROJECT = "44444444-4444-4444-8444-444444444444"
REFRESHED_PROJECT = "88888888-8888-4888-8888-888888888888"
PROJECT_OBJECT = "55555555-5555-4555-8555-555555555555"
COMP_OBJECT = "66666666-6666-4666-8666-666666666666"
NEW_COMP_OBJECT = "77777777-7777-4777-8777-777777777777"
FRESH_SOURCE_OBJECT = "99999999-9999-4999-8999-999999999998"


PUBLIC_TOOLS = {
    "ae.getProjectContext": ("selection_offset", "selection_limit"),
    "ae.getProjectItemMetadata": ("item_locator",),
    "ae.getCompositionSettings": ("composition_locator",),
    "ae.setCompositionWorkArea": (
        "composition_locator", "start", "duration", "idempotency_key",
    ),
    "ae.renameProjectItem": ("item_locator", "name", "idempotency_key"),
    "ae.setProjectItemComment": ("item_locator", "comment", "idempotency_key"),
    "ae.setProjectItemLabel": ("item_locator", "label_id", "idempotency_key"),
    "ae.duplicateComposition": (
        "composition_locator", "new_name", "idempotency_key",
    ),
}

COMPOSITION_SETTING_PUBLIC_TOOLS = {
    "ae.setCompositionDimensions": (
        "composition_locator", "width", "height", "idempotency_key",
    ),
    "ae.setCompositionDuration": (
        "composition_locator", "duration", "idempotency_key",
    ),
    "ae.setCompositionFrameRate": (
        "composition_locator", "frame_rate", "idempotency_key",
    ),
    "ae.setCompositionPixelAspectRatio": (
        "composition_locator", "pixel_aspect_ratio", "idempotency_key",
    ),
    "ae.setCompositionBackgroundColor": (
        "composition_locator", "background_color", "idempotency_key",
    ),
    "ae.setCompositionDisplayStartTime": (
        "composition_locator", "display_start_time", "idempotency_key",
    ),
}


def _locator(
    kind: str,
    object_id: str,
    *,
    generation: int = 3,
    session_id: str = SESSION,
    project_id: str = PROJECT,
) -> dict[str, Any]:
    return {
        "kind": kind,
        "hostInstanceId": HOST,
        "sessionId": session_id,
        "projectId": project_id,
        "generation": generation,
        "objectId": object_id,
    }


def _time(value: int, scale: int) -> dict[str, Any]:
    return {
        "value": value,
        "scale": scale,
        "secondsRational": str(Fraction(value, scale)),
    }


def _ratio(numerator: int, denominator: int) -> dict[str, Any]:
    return {
        "numerator": numerator,
        "denominator": denominator,
        "rational": str(Fraction(numerator, denominator)),
    }


def _settings(name: str) -> dict[str, Any]:
    return {
        "name": name,
        "width": 1920,
        "height": 1080,
        "duration": _time(10, 1),
        "frameDuration": _time(1, 24),
        "frameRate": _ratio(24, 1),
        "pixelAspectRatio": _ratio(1, 1),
        "backgroundColor": {"red": 0, "green": 0, "blue": 0, "alpha": 255},
        "workArea": {"start": _time(0, 1), "duration": _time(10, 1)},
        "displayStartTime": _time(0, 1),
        "layerCount": 2,
    }


VALUE_MODELS = {
    PC.PROJECT_CONTEXT_READ_CAPABILITY_ID: PC.ProjectContextValue,
    PC.PROJECT_ITEM_METADATA_READ_CAPABILITY_ID: PC.ProjectItemMetadataValue,
    PC.COMPOSITION_SETTINGS_READ_CAPABILITY_ID: PC.CompositionSettingsValue,
    PC.COMPOSITION_WORK_AREA_SET_CAPABILITY_ID: PC.CompositionWorkAreaSetValue,
    PC.PROJECT_ITEM_NAME_SET_CAPABILITY_ID: PC.ProjectItemNameSetValue,
    PC.PROJECT_ITEM_COMMENT_SET_CAPABILITY_ID: PC.ProjectItemCommentSetValue,
    PC.PROJECT_ITEM_LABEL_SET_CAPABILITY_ID: PC.ProjectItemLabelSetValue,
    PC.COMPOSITION_DUPLICATE_CAPABILITY_ID: PC.CompositionDuplicateValue,
    PC.COMPOSITION_DISPLAY_START_TIME_SET_CAPABILITY_ID:
        PC.CompositionSettingsSetValue,
    PC.COMPOSITION_FRAME_RATE_SET_CAPABILITY_ID:
        PC.CompositionSettingsSetValue,
}


def _descriptor(contract: PC.CapabilityContract) -> N.NativeCapabilityDescriptor:
    undo = (
        "not-applicable"
        if contract.risk == "read"
        else "none"
        if contract.capability_id == PC.COMPOSITION_DISPLAY_START_TIME_SET_CAPABILITY_ID
        else "ae-undo-group"
    )
    return N.NativeCapabilityDescriptor(
        detail="full",
        id=contract.capability_id,
        version=PC.CAPABILITY_VERSION,
        schema_version=1,
        summary=contract.summary,
        risk=contract.risk,
        mutability="read-only" if contract.risk == "read" else "mutating",
        idempotency=contract.idempotency,
        cancellation="before-dispatch",
        undo=undo,
        side_effect_summary=contract.side_effect_summary,
        preconditions=contract.preconditions,
        compatibility=N.NativeCompatibility(
            status="verified",
            intended_platforms=("macos-arm64",),
            minimum_host_major=25,
            maximum_host_major=26,
        ),
        input_contract_id=contract.input_contract_id,
        result_contract_id=contract.result_contract_id,
        contract_digest=contract.contract_digest,
        input_schema=contract.input_schema,
        result_schema=contract.result_schema,
        requirements=(N.NativeRequirement(id=contract.requirement_id, contract_version=1),),
        examples=({"arguments": {}},),
    )


class PackageBackend(N.NativeInvokeBackend):
    name = "project-composition-package-fixture"

    def __init__(self) -> None:
        self.items = tuple(_descriptor(contract) for contract in PC.CAPABILITY_CONTRACTS.values())
        self.negotiation = self._negotiation()
        self.requests: list[N.NativeInvokeRequest] = []
        self.tamper_postcondition: str | None = None

    def _negotiation(self) -> N.NativeNegotiation:
        return N.NativeNegotiation(
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

    def _value(self, request: N.NativeInvokeRequest) -> dict[str, Any]:
        arguments = request.arguments
        capability = request.capability_id
        project_locator = _locator("project", PROJECT_OBJECT)
        comp_locator = arguments.get("compositionLocator", _locator("composition", COMP_OBJECT))
        item_locator = arguments.get("itemLocator", _locator("composition", COMP_OBJECT))
        summary = {
            "locator": _locator("composition", COMP_OBJECT),
            "name": "Fixture Comp",
            "type": "composition",
            "parentLocator": project_locator,
        }
        if capability == PC.PROJECT_CONTEXT_READ_CAPABILITY_ID:
            return {
                "projectLocator": project_locator,
                "generation": 3,
                "activeItem": summary,
                "mostRecentlyUsedComposition": summary,
                "selection": {
                    "total": 1,
                    "offset": arguments["selectionOffset"],
                    "limit": arguments["selectionLimit"],
                    "returned": 1,
                    "hasMore": False,
                    "nextOffset": None,
                    "items": [summary],
                },
            }
        if capability == PC.PROJECT_ITEM_METADATA_READ_CAPABILITY_ID:
            return {
                "itemLocator": item_locator,
                "name": "Fixture Comp",
                "type": "composition",
                "parentLocator": project_locator,
                "comment": "",
                "labelId": 0,
                "width": 1920,
                "height": 1080,
                "duration": _time(10, 1),
                "pixelAspectRatio": _ratio(1, 1),
                "layerCount": 2,
            }
        if capability == PC.COMPOSITION_SETTINGS_READ_CAPABILITY_ID:
            name = "Fixture Duplicate" if comp_locator["objectId"] == NEW_COMP_OBJECT else "Fixture Comp"
            return {"compositionLocator": comp_locator, **_settings(name)}
        if capability == PC.COMPOSITION_DISPLAY_START_TIME_SET_CAPABILITY_ID:
            before = _settings("Fixture Comp")
            after = {
                **before,
                "displayStartTime": _time(
                    arguments["displayStartTime"]["value"],
                    arguments["displayStartTime"]["scale"],
                ),
            }
            return {
                "changed": True,
                "compositionLocator": comp_locator,
                "before": before,
                "after": after,
            }
        if capability == PC.COMPOSITION_WORK_AREA_SET_CAPABILITY_ID:
            return {
                "changed": True,
                "compositionLocator": comp_locator,
                "beforeWorkArea": {"start": _time(0, 1), "duration": _time(10, 1)},
                "afterWorkArea": {
                    "start": _time(arguments["start"]["value"], arguments["start"]["scale"]),
                    "duration": _time(arguments["duration"]["value"], arguments["duration"]["scale"]),
                },
            }
        if capability == PC.PROJECT_ITEM_NAME_SET_CAPABILITY_ID:
            return {"changed": True, "itemLocator": item_locator, "beforeName": "Fixture Comp", "afterName": arguments["name"]}
        if capability == PC.PROJECT_ITEM_COMMENT_SET_CAPABILITY_ID:
            return {"changed": True, "itemLocator": item_locator, "beforeComment": "", "afterComment": arguments["comment"]}
        if capability == PC.PROJECT_ITEM_LABEL_SET_CAPABILITY_ID:
            return {"changed": True, "itemLocator": item_locator, "beforeLabelId": 0, "afterLabelId": arguments["labelId"]}
        if capability == PC.COMPOSITION_DUPLICATE_CAPABILITY_ID:
            source_settings = _settings("Fixture Comp")
            new_settings = _settings(arguments["newName"])
            return {
                "changed": True,
                "sourceCompositionLocator": _locator(
                    "composition", FRESH_SOURCE_OBJECT, generation=4, project_id=REFRESHED_PROJECT,
                ),
                "newCompositionLocator": _locator(
                    "composition", NEW_COMP_OBJECT, generation=4, project_id=REFRESHED_PROJECT,
                ),
                "projectItemCountBefore": 1,
                "projectItemCountAfter": 2,
                "sourceSettings": source_settings,
                "newSettings": new_settings,
            }
        raise AssertionError(capability)

    async def invoke(self, request, *, cancellation=None):
        del cancellation
        self.requests.append(request)
        raw_value = self._value(request)
        value = VALUE_MODELS[request.capability_id].model_validate(raw_value)
        contract = PC.CAPABILITY_CONTRACTS[request.capability_id]
        digest = PC._value_digest(request.capability_id, value)
        if self.tamper_postcondition == request.capability_id:
            digest = "f" * 64
        is_write = contract.risk == "write"
        return N.NativeInvokeResult(
            capability_id=request.capability_id,
            capability_version=request.capability_version,
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
                capability_version=request.capability_version,
                started_at_unix_ms=request.deadline_unix_ms - 100,
                completed_at_unix_ms=request.deadline_unix_ms - 1,
                effect="committed" if is_write else "none",
                request_digest=N._invoke_request_digest(request, self.negotiation),
                postcondition=N.NativePostconditionEvidence(
                    verified=True,
                    kind=contract.postcondition_kind,
                    algorithm="sha256-rfc8785-jcs-v1",
                    digest=digest,
                ),
                undo=(
                    N.NativeUndoEvidence(
                        available=request.capability_id
                        != PC.COMPOSITION_DISPLAY_START_TIME_SET_CAPABILITY_ID,
                        verified=False,
                    )
                    if is_write
                    else None
                ),
            ),
        )


class RescaledFrameRateBackend(PackageBackend):
    def __init__(self, *, after_duration_value: int = 250) -> None:
        super().__init__()
        self.after_duration_value = after_duration_value

    def _value(self, request: N.NativeInvokeRequest) -> dict[str, Any]:
        if request.capability_id != PC.COMPOSITION_FRAME_RATE_SET_CAPABILITY_ID:
            return super()._value(request)
        before = _settings("Fixture Comp")
        after = {
            **before,
            "duration": _time(self.after_duration_value, 25),
            "frameDuration": _time(1, 25),
            "frameRate": _ratio(25, 1),
            "workArea": {
                "start": _time(0, 25),
                "duration": _time(250, 25),
            },
            "displayStartTime": _time(0, 25),
        }
        return {
            "changed": True,
            "compositionLocator": request.arguments["compositionLocator"],
            "before": before,
            "after": after,
        }


def _deadline() -> int:
    return int(time.time() * 1000) + 5_000


def test_public_schema_names_are_frozen_closed_and_annotated():
    load_all()
    for verb, expected_fields in PUBLIC_TOOLS.items():
        schema_cls, _handler = HANDLERS[verb]
        schema = schema_cls.model_json_schema()
        assert schema["additionalProperties"] is False
        assert set(schema["properties"]) == set(expected_fields)
        assert VERB_ANNOTATIONS[verb].destructiveHint is False
        assert VERB_ANNOTATIONS[verb].idempotentHint is True
    assert VERB_ANNOTATIONS["ae.getProjectContext"].readOnlyHint is True
    assert VERB_ANNOTATIONS["ae.duplicateComposition"].readOnlyHint is False


def test_native_contracts_are_closed_and_digest_bound():
    assert len(PC.CAPABILITY_CONTRACTS) == 14
    for contract in PC.CAPABILITY_CONTRACTS.values():
        assert contract.input_schema["additionalProperties"] is False
        assert contract.result_schema["additionalProperties"] is False
        assert contract.contract_digest == N._sha256_closed_json({
            "inputSchema": contract.input_schema,
            "resultSchema": contract.result_schema,
        })
    display_start = _descriptor(
        PC.CAPABILITY_CONTRACTS[PC.COMPOSITION_DISPLAY_START_TIME_SET_CAPABILITY_ID]
    )
    assert display_start.undo == "none"
    PC._validate_descriptor(
        display_start,
        host_platform="macos-arm64",
        contract=PC.CAPABILITY_CONTRACTS[
            PC.COMPOSITION_DISPLAY_START_TIME_SET_CAPABILITY_ID
        ],
    )


@pytest.mark.asyncio
async def test_composition_setting_tools_are_registered_and_listed(monkeypatch):
    load_all()
    assert set(COMPOSITION_SETTING_PUBLIC_TOOLS) <= set(HANDLERS)
    for verb, expected_fields in COMPOSITION_SETTING_PUBLIC_TOOLS.items():
        schema_cls, _handler = HANDLERS[verb]
        schema = schema_cls.model_json_schema()
        assert schema["additionalProperties"] is False
        assert set(schema["properties"]) == set(expected_fields)
    monkeypatch.setattr(
        server_module,
        "_filtered_tool_names",
        lambda: set(COMPOSITION_SETTING_PUBLIC_TOOLS),
    )
    server = server_module.build_server()
    listed = await server._ae_list_tools()
    assert {tool.name for tool in listed} == {
        name.replace(".", "_") for name in COMPOSITION_SETTING_PUBLIC_TOOLS
    }


@pytest.mark.asyncio
async def test_display_start_time_reports_non_undoable_write():
    execution = await PC.invoke_composition_setting_set(
        PackageBackend(),
        request_id="package-display-start-1",
        capability_id=PC.COMPOSITION_DISPLAY_START_TIME_SET_CAPABILITY_ID,
        arguments={
            "compositionLocator": _locator("composition", COMP_OBJECT),
            "displayStartTime": {"value": -1, "scale": 24},
            "idempotencyKey": "display-start-intent-0001",
        },
        deadline_unix_ms=_deadline(),
    )
    assert execution.implementation.undo == "none"
    assert execution.evidence.undo is not None
    assert execution.evidence.undo.available is False
    assert execution.evidence.undo.verified is False
    assert execution.evidence.undo.group_id is None
    assert execution.value.before.display_start_time == PC.ExactTime(
        value=0, scale=1, seconds_rational="0"
    )
    assert execution.value.after.display_start_time == PC.ExactTime(
        value=-1, scale=24, seconds_rational="-1/24"
    )


@pytest.mark.asyncio
async def test_frame_rate_accepts_equivalent_ae_timebase_rescaling():
    execution = await PC.invoke_composition_setting_set(
        RescaledFrameRateBackend(),
        request_id="package-frame-rate-rescale-1",
        capability_id=PC.COMPOSITION_FRAME_RATE_SET_CAPABILITY_ID,
        arguments={
            "compositionLocator": _locator("composition", COMP_OBJECT),
            "frameRate": {"numerator": 25, "denominator": 1},
            "idempotencyKey": "frame-rate-rescale-intent-0001",
        },
        deadline_unix_ms=_deadline(),
    )

    assert execution.value.after.frame_rate == PC.ExactRatio(
        numerator=25, denominator=1, rational="25"
    )
    assert execution.value.after.duration == PC.ExactTime(
        value=250, scale=25, seconds_rational="10"
    )
    assert execution.value.after.work_area.duration == PC.ExactTime(
        value=250, scale=25, seconds_rational="10"
    )


@pytest.mark.asyncio
async def test_frame_rate_rejects_a_real_untargeted_time_change():
    with pytest.raises(N.NativeBackendError) as raised:
        await PC.invoke_composition_setting_set(
            RescaledFrameRateBackend(after_duration_value=251),
            request_id="package-frame-rate-duration-drift-1",
            capability_id=PC.COMPOSITION_FRAME_RATE_SET_CAPABILITY_ID,
            arguments={
                "compositionLocator": _locator("composition", COMP_OBJECT),
                "frameRate": {"numerator": 25, "denominator": 1},
                "idempotencyKey": "frame-rate-duration-drift-intent-0001",
            },
            deadline_unix_ms=_deadline(),
        )

    assert raised.value.code == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert raised.value.side_effect == "may-have-occurred"


def test_project_item_metadata_preserves_native_optional_fact_omission():
    raw = {
        "itemLocator": _locator("item", COMP_OBJECT),
        "name": "Root folder",
        "type": "folder",
        "parentLocator": None,
        "comment": "",
        "labelId": 0,
    }
    value = PC.ProjectItemMetadataValue.model_validate(raw)
    expected = N._sha256_closed_json({
        "capabilityId": PC.PROJECT_ITEM_METADATA_READ_CAPABILITY_ID,
        "capabilityVersion": PC.CAPABILITY_VERSION,
        "value": raw,
    })
    assert PC._value_digest(PC.PROJECT_ITEM_METADATA_READ_CAPABILITY_ID, value) == expected
    result_schema = PC.CAPABILITY_CONTRACTS[
        PC.PROJECT_ITEM_METADATA_READ_CAPABILITY_ID
    ].result_schema
    assert "width" not in result_schema["required"]
    assert result_schema["properties"]["parentLocator"]["anyOf"][-1] == {
        "type": "null",
    }


def test_public_validation_error_is_structured_and_actionable():
    with pytest.raises(ValidationError) as raised:
        schemas.AeSetProjectItemLabelArgs.model_validate({
            "item_locator": _locator("composition", COMP_OBJECT),
            "label_id": 17,
            "idempotency_key": "project-label-intent-0001",
        })
    error = server_module._project_composition_validation_error(
        "ae.setProjectItemLabel", raised.value
    )
    assert error["code"] == "INVALID_ARGUMENT"
    assert error["sideEffect"] == "not-started"
    assert error["recovery"]["action"] == "change-arguments"
    assert error["details"] == {
        "field": "arguments.label_id",
        "capabilityId": PC.PROJECT_ITEM_LABEL_SET_CAPABILITY_ID,
    }


@pytest.mark.asyncio
async def test_three_reads_bind_wire_arguments_values_and_evidence():
    backend = PackageBackend()
    context = await PC.invoke_project_context_read(
        backend,
        request_id="package-context-1",
        selection_offset=0,
        selection_limit=50,
        deadline_unix_ms=_deadline(),
    )
    metadata = await PC.invoke_project_item_metadata_read(
        backend,
        request_id="package-metadata-1",
        item_locator=_locator("composition", COMP_OBJECT),
        deadline_unix_ms=_deadline(),
    )
    settings = await PC.invoke_composition_settings_read(
        backend,
        request_id="package-settings-1",
        composition_locator=_locator("composition", COMP_OBJECT),
        deadline_unix_ms=_deadline(),
    )

    assert backend.requests[0].arguments == {"selectionOffset": 0, "selectionLimit": 50}
    assert backend.requests[1].arguments == {"itemLocator": _locator("composition", COMP_OBJECT)}
    assert backend.requests[2].arguments == {"compositionLocator": _locator("composition", COMP_OBJECT)}
    assert context.value.generation == 3
    assert metadata.value.layer_count == 2
    assert settings.value.frame_rate.rational == "24"
    assert settings.value.frame_duration.seconds_rational == "1/24"
    assert all(item.evidence.effect == "none" for item in (context, metadata, settings))


@pytest.mark.asyncio
async def test_read_side_composition_names_accept_sdk_names_beyond_write_limit():
    long_name = "x" * 300

    class LongCompositionNameBackend(PackageBackend):
        def _value(self, request: N.NativeInvokeRequest) -> dict[str, Any]:
            value = super()._value(request)
            if request.capability_id == PC.COMPOSITION_SETTINGS_READ_CAPABILITY_ID:
                value["name"] = long_name
            elif request.capability_id == PC.COMPOSITION_DUPLICATE_CAPABILITY_ID:
                value["sourceSettings"]["name"] = long_name
            return value

    backend = LongCompositionNameBackend()
    locator = _locator("composition", COMP_OBJECT)
    settings = await PC.invoke_composition_settings_read(
        backend,
        request_id="package-long-settings-name-1",
        composition_locator=locator,
        deadline_unix_ms=_deadline(),
    )
    duplicated = await PC.invoke_composition_duplicate(
        backend,
        request_id="package-long-duplicate-source-name-1",
        composition_locator=locator,
        new_name="Bounded duplicate",
        idempotency_key="duplicate-long-source-0001",
        deadline_unix_ms=_deadline(),
    )

    assert settings.value.name == long_name
    assert duplicated.value.source_settings.name == long_name
    assert duplicated.value.new_settings.name == "Bounded duplicate"
    assert PC.CAPABILITY_CONTRACTS[
        PC.COMPOSITION_SETTINGS_READ_CAPABILITY_ID
    ].result_schema["properties"]["name"] == {
        "type": "string",
        "maxLength": 1024,
    }


@pytest.mark.asyncio
async def test_five_writes_bind_exact_targets_undo_and_postconditions():
    backend = PackageBackend()
    locator = _locator("composition", COMP_OBJECT)
    work = await PC.invoke_composition_work_area_set(
        backend, request_id="package-work-area-1", composition_locator=locator,
        start={"value": 1, "scale": 1}, duration={"value": 2, "scale": 1},
        idempotency_key="work-area-intent-0001", deadline_unix_ms=_deadline(),
    )
    renamed = await PC.invoke_project_item_name_set(
        backend, request_id="package-name-1", item_locator=locator, name="Renamed",
        idempotency_key="rename-item-intent-0001", deadline_unix_ms=_deadline(),
    )
    commented = await PC.invoke_project_item_comment_set(
        backend, request_id="package-comment-1", item_locator=locator, comment="note",
        idempotency_key="comment-item-intent-0001", deadline_unix_ms=_deadline(),
    )
    labelled = await PC.invoke_project_item_label_set(
        backend, request_id="package-label-1", item_locator=locator, label_id=5,
        idempotency_key="label-item-intent-0001", deadline_unix_ms=_deadline(),
    )
    duplicated = await PC.invoke_composition_duplicate(
        backend, request_id="package-duplicate-1", composition_locator=locator,
        new_name="Fixture Duplicate", idempotency_key="duplicate-intent-0001",
        deadline_unix_ms=_deadline(),
    )

    assert work.value.after_work_area.start.seconds_rational == "1"
    assert renamed.value.after_name == "Renamed"
    assert commented.value.after_comment == "note"
    assert labelled.value.after_label_id == 5
    assert duplicated.value.new_composition_locator.generation == 4
    assert duplicated.value.source_composition_locator.object_id != locator["objectId"]
    assert duplicated.value.source_composition_locator.project_id == REFRESHED_PROJECT
    assert (
        duplicated.value.source_composition_locator.context()
        == duplicated.value.new_composition_locator.context()
    )
    assert duplicated.value.new_settings.name == "Fixture Duplicate"
    for execution in (work, renamed, commented, labelled, duplicated):
        assert execution.evidence.effect == "committed"
        assert execution.evidence.undo is not None
        assert execution.evidence.undo.available is True
        assert execution.evidence.undo.verified is False
        assert execution.audit_fields()["undoVerified"] is False


@pytest.mark.asyncio
async def test_rename_accepts_a_long_existing_name_but_keeps_new_name_bounded():
    class LongExistingNameBackend(PackageBackend):
        def _value(self, request: N.NativeInvokeRequest) -> dict[str, Any]:
            value = super()._value(request)
            if request.capability_id == PC.PROJECT_ITEM_NAME_SET_CAPABILITY_ID:
                value["beforeName"] = "x" * 300
            return value

    backend = LongExistingNameBackend()
    renamed = await PC.invoke_project_item_name_set(
        backend,
        request_id="package-long-name-1",
        item_locator=_locator("composition", COMP_OBJECT),
        name="Bounded replacement",
        idempotency_key="rename-long-name-0001",
        deadline_unix_ms=_deadline(),
    )

    assert len(renamed.value.before_name) == 300
    assert renamed.value.after_name == "Bounded replacement"
    result_schema = PC.CAPABILITY_CONTRACTS[
        PC.PROJECT_ITEM_NAME_SET_CAPABILITY_ID
    ].result_schema
    assert result_schema["properties"]["beforeName"] == {
        "type": "string",
        "maxLength": 1024,
    }
    assert result_schema["properties"]["afterName"] == {
        "type": "string",
        "minLength": 1,
        "maxLength": 255,
    }


@pytest.mark.asyncio
async def test_stale_locator_fails_before_dispatch():
    backend = PackageBackend()
    with pytest.raises(N.NativeBackendError) as raised:
        await PC.invoke_project_item_name_set(
            backend,
            request_id="package-stale-1",
            item_locator=_locator(
                "composition", COMP_OBJECT,
                session_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            ),
            name="Renamed",
            idempotency_key="rename-item-intent-0002",
            deadline_unix_ms=_deadline(),
        )
    assert backend.requests == []
    assert raised.value.code == "STALE_LOCATOR"
    assert raised.value.recovery.action == "refresh-locator"


@pytest.mark.asyncio
async def test_descriptor_drift_is_rejected_before_dispatch():
    backend = PackageBackend()
    first = backend.items[0].model_copy(update={"summary": "drifted"})
    backend.items = (first, *backend.items[1:])
    backend.negotiation = backend._negotiation()
    with pytest.raises(N.NativeBackendError) as raised:
        await PC.invoke_project_context_read(
            backend,
            request_id="package-drift-1",
            selection_offset=0,
            selection_limit=50,
            deadline_unix_ms=_deadline(),
        )
    assert backend.requests == []
    assert raised.value.code == "NATIVE_CONTRACT_MISMATCH"


@pytest.mark.asyncio
async def test_tampered_write_evidence_preserves_side_effect_uncertainty():
    backend = PackageBackend()
    backend.tamper_postcondition = PC.COMPOSITION_WORK_AREA_SET_CAPABILITY_ID
    with pytest.raises(N.NativeBackendError) as raised:
        await PC.invoke_composition_work_area_set(
            backend,
            request_id="package-tamper-1",
            composition_locator=_locator("composition", COMP_OBJECT),
            start={"value": 1, "scale": 1},
            duration={"value": 2, "scale": 1},
            idempotency_key="work-area-intent-0002",
            deadline_unix_ms=_deadline(),
        )
    assert len(backend.requests) == 1
    assert raised.value.code == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert raised.value.side_effect == "may-have-occurred"
    assert raised.value.retryable is False


@pytest.mark.asyncio
async def test_public_handlers_map_snake_case_inputs_to_camel_case_native_wire(monkeypatch):
    backend = PackageBackend()
    monkeypatch.setattr(native_handlers._discovery, "select_backend", lambda: backend)
    context = await native_handlers._run_get_project_context(
        schemas.AeGetProjectContextArgs(), None
    )
    renamed = await native_handlers._run_rename_project_item(
        schemas.AeRenameProjectItemArgs(
            item_locator=_locator("composition", COMP_OBJECT),
            name="Renamed",
            idempotency_key="rename-item-intent-0003",
        ),
        None,
    )
    assert context["ok"] is True
    assert context["implementation"]["capabilityId"] == PC.PROJECT_CONTEXT_READ_CAPABILITY_ID
    assert context["implementation"]["undo"] == "not-applicable"
    assert renamed["ok"] is True
    assert renamed["audit"]["effect"] == "committed"
    assert backend.requests[0].arguments == {"selectionOffset": 0, "selectionLimit": 50}
    assert set(backend.requests[1].arguments) == {"itemLocator", "name", "idempotencyKey"}
