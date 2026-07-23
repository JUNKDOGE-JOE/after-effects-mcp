"""Public MCP handlers explicitly bound to typed native AEGP capabilities."""

from __future__ import annotations

import asyncio
import time
import uuid
from typing import Any

from ae_mcp import progress, schemas
from ae_mcp.backends import discovery as _discovery
from ae_mcp.backends.native import (
    NativeBackendError,
    NativeCancellationToken,
    NativeInvokeBackend,
    NativeRecovery,
    invoke_composition_layers_list,
    invoke_selected_composition_layers_list,
    invoke_composition_time_read,
    invoke_composition_time_set,
    invoke_composition_create,
    invoke_composition_layer_create,
    invoke_layer_effect_apply,
    invoke_layer_properties_list,
    invoke_layer_property_keyframes_list,
    invoke_layer_property_set,
    invoke_project_bit_depth_read,
    invoke_project_bit_depth_set,
    invoke_project_items_list,
    invoke_project_summary,
)
from ae_mcp.backends.native_project_composition import (
    invoke_composition_duplicate,
    invoke_composition_settings_read,
    invoke_composition_work_area_set,
    invoke_project_context_read,
    invoke_project_item_comment_set,
    invoke_project_item_label_set,
    invoke_project_item_metadata_read,
    invoke_project_item_name_set,
)
from ae_mcp.backends.native_layer_timeline import (
    invoke_layer_details_read,
    invoke_layer_duplicate,
    invoke_layer_name_set,
    invoke_layer_order_set,
    invoke_layer_parent_set,
    invoke_layer_range_set,
    invoke_layer_start_time_set,
    invoke_layer_stretch_set,
    stretch_percent_to_ratio,
)
from ae_mcp.backends.native_layer_compositing import (
    LayerSwitch,
    invoke_layer_blending_mode_set,
    invoke_layer_compositing_read,
    invoke_layer_quality_set,
    invoke_layer_switch_set,
)
from ae_mcp.backends.native_layer_transform import (
    LayerTransformRead,
    LayerTransformWrite,
    TransformField,
    read_layer_transform,
    set_layer_transform,
)
from ae_mcp.backends.native_keyframe_authoring import (
    invoke_keyframe_add,
    invoke_keyframe_behavior_set,
    invoke_keyframe_delete,
    invoke_keyframe_details_read,
    invoke_keyframe_interpolation_set,
    invoke_keyframe_temporal_ease_set,
    invoke_keyframe_value_set,
)
from ae_mcp.handlers import register


_PROJECT_SUMMARY_TIMEOUT_MS = 10_000
_PROJECT_BIT_DEPTH_READ_TIMEOUT_MS = 10_000
_PROJECT_BIT_DEPTH_SET_TIMEOUT_MS = 10_000
_PROJECT_ITEMS_LIST_TIMEOUT_MS = 10_000
_COMPOSITION_LAYERS_LIST_TIMEOUT_MS = 10_000
_SELECTED_COMPOSITION_LAYERS_LIST_TIMEOUT_MS = 10_000
_COMPOSITION_TIME_READ_TIMEOUT_MS = 10_000
_COMPOSITION_TIME_SET_TIMEOUT_MS = 10_000
_COMPOSITION_CREATE_TIMEOUT_MS = 10_000
_COMPOSITION_LAYER_CREATE_TIMEOUT_MS = 10_000
_LAYER_EFFECT_APPLY_TIMEOUT_MS = 10_000
_LAYER_PROPERTIES_LIST_TIMEOUT_MS = 10_000
_LAYER_PROPERTY_KEYFRAMES_LIST_TIMEOUT_MS = 10_000
_LAYER_PROPERTY_SET_TIMEOUT_MS = 10_000
_PROJECT_CONTEXT_READ_TIMEOUT_MS = 10_000
_PROJECT_ITEM_METADATA_READ_TIMEOUT_MS = 10_000
_COMPOSITION_SETTINGS_READ_TIMEOUT_MS = 10_000
_COMPOSITION_WORK_AREA_SET_TIMEOUT_MS = 10_000
_PROJECT_ITEM_NAME_SET_TIMEOUT_MS = 10_000
_PROJECT_ITEM_COMMENT_SET_TIMEOUT_MS = 10_000
_PROJECT_ITEM_LABEL_SET_TIMEOUT_MS = 10_000
_COMPOSITION_DUPLICATE_TIMEOUT_MS = 10_000
_LAYER_DETAILS_READ_TIMEOUT_MS = 10_000
_LAYER_NAME_SET_TIMEOUT_MS = 10_000
_LAYER_RANGE_SET_TIMEOUT_MS = 10_000
_LAYER_START_TIME_SET_TIMEOUT_MS = 10_000
_LAYER_STRETCH_SET_TIMEOUT_MS = 10_000
_LAYER_ORDER_SET_TIMEOUT_MS = 10_000
_LAYER_PARENT_SET_TIMEOUT_MS = 10_000
_LAYER_DUPLICATE_TIMEOUT_MS = 10_000
_LAYER_COMPOSITING_READ_TIMEOUT_MS = 10_000
_LAYER_COMPOSITING_WRITE_TIMEOUT_MS = 10_000
_LAYER_TRANSFORM_TIMEOUT_MS = 20_000
_KEYFRAME_DETAILS_READ_TIMEOUT_MS = 10_000
_KEYFRAME_WRITE_TIMEOUT_MS = 10_000


def _backend() -> NativeInvokeBackend:
    backend = _discovery.select_backend()
    if isinstance(backend, NativeInvokeBackend):
        return backend
    raise NativeBackendError(
        "NATIVE_UNAVAILABLE",
        "The selected AE adapter does not expose the native AEGP execution plane.",
        retryable=True,
        side_effect="not-started",
        recovery=NativeRecovery(
            action="reconnect",
            hint="Select the ae-mcp bridge with native AEGP support, then retry.",
        ),
    )


def _native_read_response(execution: Any) -> dict[str, Any]:
    implementation = execution.implementation
    audit = execution.audit_fields()
    return {
        "ok": True,
        "value": execution.value.model_dump(mode="json", by_alias=True),
        "implementation": {
            "engine": execution.engine,
            "capabilityId": implementation.capability_id,
            "capabilityVersion": implementation.capability_version,
            "contractDigest": implementation.contract_digest,
            "risk": implementation.risk,
            "mutability": implementation.mutability,
            "idempotency": implementation.idempotency,
            "undo": implementation.undo,
        },
        "provenance": {
            key: audit[key]
            for key in (
                "engine",
                "selectedWireVersion",
                "pluginVersion",
                "compiledSdkVersion",
                "sourceCommit",
                "hostInstanceId",
                "sessionId",
                "sessionGeneration",
                "capabilitiesDigest",
            )
        },
        "audit": {
            key: audit[key]
            for key in (
                "requestId",
                "capabilityId",
                "capabilityVersion",
                "contractDigest",
                "effect",
                "requestDigest",
                "postconditionAlgorithm",
                "postconditionDigest",
                "startedAtUnixMs",
                "completedAtUnixMs",
            )
        },
        "evidence": execution.evidence.model_dump(
            mode="json",
            by_alias=True,
            exclude_none=True,
        ),
    }


def _layer_transform_read_response(result: LayerTransformRead) -> dict[str, Any]:
    response = _native_read_response(result.execution)
    response["value"] = result.value
    response["implementation"]["semanticAdapter"] = "core-layer-transform-v1"
    response["implementation"]["nativeCapabilities"] = [
        "ae.layer.properties.list",
    ]
    response["evidence"]["semanticProjection"] = {
        "verified": True,
        "kind": "core-layer-transform-projection-v1",
        "algorithm": "sha256-rfc8785-jcs-v1",
        "digest": result.projection_digest,
        "sourcePostconditionDigests": list(result.source_postcondition_digests),
    }
    return response


def _layer_transform_write_response(result: LayerTransformWrite) -> dict[str, Any]:
    execution = result.execution
    implementation = execution.implementation
    audit = execution.audit_fields()
    response = {
        "ok": True,
        "replayed": execution.replayed,
        "value": result.value,
        "implementation": {
            "engine": execution.engine,
            "capabilityId": implementation.capability_id,
            "capabilityVersion": implementation.capability_version,
            "contractDigest": implementation.contract_digest,
            "risk": implementation.risk,
            "mutability": implementation.mutability,
            "idempotency": implementation.idempotency,
            "cancellation": implementation.cancellation,
            "undo": implementation.undo,
            "sideEffectSummary": implementation.side_effect_summary,
            "preconditions": list(implementation.preconditions),
            "semanticAdapter": "core-layer-transform-v1",
            "nativeCapabilities": [
                "ae.layer.properties.list",
                "ae.layer.property.set",
            ],
        },
        "provenance": {
            key: audit[key]
            for key in (
                "engine", "selectedWireVersion", "pluginVersion",
                "compiledSdkVersion", "sourceCommit", "hostInstanceId",
                "sessionId", "sessionGeneration", "capabilitiesDigest",
            )
        },
        "audit": {
            key: audit[key]
            for key in (
                "requestId", "evidenceRequestId", "idempotencyKey", "replayed",
                "capabilityId", "capabilityVersion", "contractDigest", "effect",
                "requestDigest", "postconditionAlgorithm", "postconditionDigest",
                "undoAvailable", "undoVerified", "startedAtUnixMs", "completedAtUnixMs",
            )
        },
        "evidence": execution.evidence.model_dump(
            mode="json", by_alias=True, exclude_none=True,
        ),
    }
    response["evidence"]["semanticProjection"] = {
        "verified": True,
        "kind": "core-layer-transform-write-projection-v1",
        "algorithm": "sha256-rfc8785-jcs-v1",
        "digest": result.projection_digest,
        "sourcePostconditionDigest": execution.evidence.postcondition.digest,
    }
    return response


async def _run_project_summary(
    args: schemas.AeProjectSummaryArgs,
    ctx: Any,
) -> dict[str, Any]:
    del args
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _PROJECT_SUMMARY_TIMEOUT_MS
    request_id = f"mcp-{uuid.uuid4().hex}"

    async def _call():
        return await invoke_project_summary(
            _backend(),
            request_id=request_id,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    try:
        execution = await progress.with_heartbeat(
            ctx,
            _call(),
            start_msg="ae.projectSummary native AEGP read...",
        )
    except asyncio.CancelledError:
        cancellation.cancel()
        raise

    implementation = execution.implementation
    audit = execution.audit_fields()
    return {
        "ok": True,
        "value": execution.value.model_dump(mode="json", by_alias=True),
        "implementation": {
            "engine": execution.engine,
            "capabilityId": implementation.capability_id,
            "capabilityVersion": implementation.capability_version,
            "contractDigest": implementation.contract_digest,
            "risk": implementation.risk,
            "mutability": implementation.mutability,
            "idempotency": implementation.idempotency,
        },
        "provenance": {
            key: audit[key]
            for key in (
                "engine",
                "selectedWireVersion",
                "pluginVersion",
                "compiledSdkVersion",
                "sourceCommit",
                "hostInstanceId",
                "sessionId",
                "sessionGeneration",
                "capabilitiesDigest",
            )
        },
        "audit": {
            key: audit[key]
            for key in (
                "requestId",
                "capabilityId",
                "capabilityVersion",
                "contractDigest",
                "effect",
                "requestDigest",
                "postconditionAlgorithm",
                "postconditionDigest",
                "startedAtUnixMs",
                "completedAtUnixMs",
            )
        },
        "evidence": execution.evidence.model_dump(
            mode="json",
            by_alias=True,
            exclude_none=True,
        ),
    }


async def _run_list_project_items(
    args: schemas.AeListProjectItemsArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _PROJECT_ITEMS_LIST_TIMEOUT_MS
    request_id = f"mcp-{uuid.uuid4().hex}"
    project_locator = (
        args.project_locator.model_dump(mode="json", by_alias=True)
        if args.project_locator is not None
        else None
    )

    async def _call():
        return await invoke_project_items_list(
            _backend(),
            request_id=request_id,
            project_locator=project_locator,
            offset=args.offset,
            limit=args.limit,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    try:
        execution = await progress.with_heartbeat(
            ctx,
            _call(),
            start_msg="ae.listProjectItems native AEGP read...",
        )
    except asyncio.CancelledError:
        cancellation.cancel()
        raise
    return _native_read_response(execution)


async def _run_list_composition_layers(
    args: schemas.AeListCompositionLayersArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _COMPOSITION_LAYERS_LIST_TIMEOUT_MS
    request_id = f"mcp-{uuid.uuid4().hex}"
    composition_locator = args.composition_locator.model_dump(
        mode="json", by_alias=True
    )

    async def _call():
        return await invoke_composition_layers_list(
            _backend(),
            request_id=request_id,
            composition_locator=composition_locator,
            offset=args.offset,
            limit=args.limit,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    try:
        execution = await progress.with_heartbeat(
            ctx,
            _call(),
            start_msg="ae.listCompositionLayers native AEGP read...",
        )
    except asyncio.CancelledError:
        cancellation.cancel()
        raise
    return _native_read_response(execution)


async def _run_list_selected_layers(
    args: schemas.AeListSelectedLayersArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = (
        int(time.time() * 1000) + _SELECTED_COMPOSITION_LAYERS_LIST_TIMEOUT_MS
    )
    request_id = f"mcp-{uuid.uuid4().hex}"
    composition_locator = args.composition_locator.model_dump(
        mode="json", by_alias=True
    )

    async def _call():
        return await invoke_selected_composition_layers_list(
            _backend(),
            request_id=request_id,
            composition_locator=composition_locator,
            offset=args.offset,
            limit=args.limit,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    try:
        execution = await progress.with_heartbeat(
            ctx,
            _call(),
            start_msg="ae.listSelectedLayers native AEGP read...",
        )
    except asyncio.CancelledError:
        cancellation.cancel()
        raise
    return _native_read_response(execution)


async def _run_get_composition_time(
    args: schemas.AeGetCompositionTimeArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _COMPOSITION_TIME_READ_TIMEOUT_MS
    request_id = f"mcp-{uuid.uuid4().hex}"
    composition_locator = args.composition_locator.model_dump(
        mode="json", by_alias=True
    )

    async def _call():
        return await invoke_composition_time_read(
            _backend(),
            request_id=request_id,
            composition_locator=composition_locator,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    try:
        execution = await progress.with_heartbeat(
            ctx,
            _call(),
            start_msg="ae.getCompositionTime native AEGP read...",
        )
    except asyncio.CancelledError:
        cancellation.cancel()
        raise
    return _native_read_response(execution)


async def _run_set_composition_time(
    args: schemas.AeSetCompositionTimeArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _COMPOSITION_TIME_SET_TIMEOUT_MS
    request_id = f"mcp-{uuid.uuid4().hex}"

    async def _call():
        return await invoke_composition_time_set(
            _backend(),
            request_id=request_id,
            composition_locator=args.composition_locator.model_dump(
                mode="json", by_alias=True
            ),
            target_time=args.target_time.model_dump(mode="json", by_alias=True),
            idempotency_key=args.idempotency_key,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    call_task = asyncio.create_task(_call())
    try:
        execution = await progress.with_heartbeat(
            ctx,
            asyncio.shield(call_task),
            start_msg=(
                "ae.setCompositionTime native AEGP write; after dispatch, "
                "wait for the verified terminal result..."
            ),
        )
    except asyncio.CancelledError:
        cancellation.cancel()
        execution = await asyncio.shield(call_task)

    implementation = execution.implementation
    audit = execution.audit_fields()
    return {
        "ok": True,
        "replayed": execution.replayed,
        "value": execution.value.model_dump(mode="json", by_alias=True),
        "implementation": {
            "engine": execution.engine,
            "capabilityId": implementation.capability_id,
            "capabilityVersion": implementation.capability_version,
            "contractDigest": implementation.contract_digest,
            "risk": implementation.risk,
            "mutability": implementation.mutability,
            "idempotency": implementation.idempotency,
            "cancellation": implementation.cancellation,
            "undo": implementation.undo,
            "sideEffectSummary": implementation.side_effect_summary,
            "preconditions": list(implementation.preconditions),
        },
        "provenance": {
            key: audit[key]
            for key in (
                "engine",
                "selectedWireVersion",
                "pluginVersion",
                "compiledSdkVersion",
                "sourceCommit",
                "hostInstanceId",
                "sessionId",
                "sessionGeneration",
                "capabilitiesDigest",
            )
        },
        "audit": {
            key: audit[key]
            for key in (
                "requestId",
                "evidenceRequestId",
                "idempotencyKey",
                "replayed",
                "capabilityId",
                "capabilityVersion",
                "contractDigest",
                "effect",
                "requestDigest",
                "postconditionAlgorithm",
                "postconditionDigest",
                "undoAvailable",
                "undoVerified",
                "startedAtUnixMs",
                "completedAtUnixMs",
            )
        },
        "evidence": execution.evidence.model_dump(
            mode="json",
            by_alias=True,
            exclude_none=True,
        ),
    }


async def _run_create_composition(
    args: schemas.AeCreateCompositionArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _COMPOSITION_CREATE_TIMEOUT_MS
    request_id = f"mcp-{uuid.uuid4().hex}"

    async def _call():
        return await invoke_composition_create(
            _backend(),
            request_id=request_id,
            name=args.name,
            width=args.width,
            height=args.height,
            duration=args.duration.model_dump(mode="json", by_alias=True),
            frame_rate=args.frame_rate.model_dump(mode="json", by_alias=True),
            pixel_aspect_ratio=args.pixel_aspect_ratio.model_dump(
                mode="json", by_alias=True
            ),
            idempotency_key=args.idempotency_key,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    call_task = asyncio.create_task(_call())
    try:
        execution = await progress.with_heartbeat(
            ctx,
            asyncio.shield(call_task),
            start_msg=(
                "ae.createComposition native AEGP write; after dispatch, "
                "wait for the verified terminal result..."
            ),
        )
    except asyncio.CancelledError:
        cancellation.cancel()
        execution = await asyncio.shield(call_task)

    implementation = execution.implementation
    audit = execution.audit_fields()
    return {
        "ok": True,
        "replayed": execution.replayed,
        "value": execution.value.model_dump(mode="json", by_alias=True),
        "implementation": {
            "engine": execution.engine,
            "capabilityId": implementation.capability_id,
            "capabilityVersion": implementation.capability_version,
            "contractDigest": implementation.contract_digest,
            "risk": implementation.risk,
            "mutability": implementation.mutability,
            "idempotency": implementation.idempotency,
            "cancellation": implementation.cancellation,
            "undo": implementation.undo,
            "sideEffectSummary": implementation.side_effect_summary,
            "preconditions": list(implementation.preconditions),
        },
        "provenance": {
            key: audit[key]
            for key in (
                "engine", "selectedWireVersion", "pluginVersion",
                "compiledSdkVersion", "sourceCommit", "hostInstanceId",
                "sessionId", "sessionGeneration", "capabilitiesDigest",
            )
        },
        "audit": {
            key: audit[key]
            for key in (
                "requestId", "evidenceRequestId", "idempotencyKey", "replayed",
                "capabilityId", "capabilityVersion", "contractDigest", "effect",
                "requestDigest", "postconditionAlgorithm", "postconditionDigest",
                "undoAvailable", "undoVerified", "startedAtUnixMs", "completedAtUnixMs",
            )
        },
        "evidence": execution.evidence.model_dump(
            mode="json", by_alias=True, exclude_none=True
        ),
    }


async def _run_create_composition_layer(
    args: schemas.AeCreateCompositionLayerArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _COMPOSITION_LAYER_CREATE_TIMEOUT_MS
    request_id = f"mcp-{uuid.uuid4().hex}"

    async def _call():
        return await invoke_composition_layer_create(
            _backend(),
            request_id=request_id,
            composition_locator=args.composition_locator.model_dump(
                mode="json", by_alias=True
            ),
            kind=args.kind,
            name=args.name,
            color=(
                args.color.model_dump(mode="json", by_alias=True)
                if args.color is not None
                else None
            ),
            width=args.width,
            height=args.height,
            duration=(
                args.duration.model_dump(mode="json", by_alias=True)
                if args.duration is not None
                else None
            ),
            idempotency_key=args.idempotency_key,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    call_task = asyncio.create_task(_call())
    try:
        execution = await progress.with_heartbeat(
            ctx,
            asyncio.shield(call_task),
            start_msg=(
                "ae.createCompositionLayer native AEGP write; after dispatch, "
                "wait for the verified terminal result..."
            ),
        )
    except asyncio.CancelledError:
        cancellation.cancel()
        execution = await asyncio.shield(call_task)

    implementation = execution.implementation
    audit = execution.audit_fields()
    return {
        "ok": True,
        "replayed": execution.replayed,
        "value": execution.value.model_dump(mode="json", by_alias=True),
        "implementation": {
            "engine": execution.engine,
            "capabilityId": implementation.capability_id,
            "capabilityVersion": implementation.capability_version,
            "contractDigest": implementation.contract_digest,
            "risk": implementation.risk,
            "mutability": implementation.mutability,
            "idempotency": implementation.idempotency,
            "cancellation": implementation.cancellation,
            "undo": implementation.undo,
            "sideEffectSummary": implementation.side_effect_summary,
            "preconditions": list(implementation.preconditions),
        },
        "provenance": {
            key: audit[key]
            for key in (
                "engine",
                "selectedWireVersion",
                "pluginVersion",
                "compiledSdkVersion",
                "sourceCommit",
                "hostInstanceId",
                "sessionId",
                "sessionGeneration",
                "capabilitiesDigest",
            )
        },
        "audit": {
            key: audit[key]
            for key in (
                "requestId",
                "evidenceRequestId",
                "idempotencyKey",
                "replayed",
                "capabilityId",
                "capabilityVersion",
                "contractDigest",
                "effect",
                "requestDigest",
                "postconditionAlgorithm",
                "postconditionDigest",
                "undoAvailable",
                "undoVerified",
                "startedAtUnixMs",
                "completedAtUnixMs",
            )
        },
        "evidence": execution.evidence.model_dump(
            mode="json", by_alias=True, exclude_none=True
        ),
    }


async def _run_apply_layer_effect(
    args: schemas.AeApplyLayerEffectArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _LAYER_EFFECT_APPLY_TIMEOUT_MS
    request_id = f"mcp-{uuid.uuid4().hex}"

    async def _call():
        return await invoke_layer_effect_apply(
            _backend(),
            request_id=request_id,
            layer_locator=args.layer_locator.model_dump(mode="json", by_alias=True),
            effect_match_name=args.effect_match_name,
            idempotency_key=args.idempotency_key,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    call_task = asyncio.create_task(_call())
    try:
        execution = await progress.with_heartbeat(
            ctx,
            asyncio.shield(call_task),
            start_msg=(
                "ae.applyLayerEffect native AEGP write; after dispatch, "
                "wait for the verified terminal result..."
            ),
        )
    except asyncio.CancelledError:
        cancellation.cancel()
        execution = await asyncio.shield(call_task)

    implementation = execution.implementation
    audit = execution.audit_fields()
    return {
        "ok": True,
        "replayed": execution.replayed,
        "value": execution.value.model_dump(mode="json", by_alias=True),
        "implementation": {
            "engine": execution.engine,
            "capabilityId": implementation.capability_id,
            "capabilityVersion": implementation.capability_version,
            "contractDigest": implementation.contract_digest,
            "risk": implementation.risk,
            "mutability": implementation.mutability,
            "idempotency": implementation.idempotency,
            "cancellation": implementation.cancellation,
            "undo": implementation.undo,
            "sideEffectSummary": implementation.side_effect_summary,
            "preconditions": list(implementation.preconditions),
        },
        "provenance": {
            key: audit[key]
            for key in (
                "engine", "selectedWireVersion", "pluginVersion",
                "compiledSdkVersion", "sourceCommit", "hostInstanceId",
                "sessionId", "sessionGeneration", "capabilitiesDigest",
            )
        },
        "audit": {
            key: audit[key]
            for key in (
                "requestId", "evidenceRequestId", "idempotencyKey", "replayed",
                "capabilityId", "capabilityVersion", "contractDigest", "effect",
                "requestDigest", "postconditionAlgorithm", "postconditionDigest",
                "undoAvailable", "undoVerified", "startedAtUnixMs", "completedAtUnixMs",
            )
        },
        "evidence": execution.evidence.model_dump(
            mode="json", by_alias=True, exclude_none=True
        ),
    }


async def _run_list_layer_properties(
    args: schemas.AeListLayerPropertiesArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _LAYER_PROPERTIES_LIST_TIMEOUT_MS
    request_id = f"mcp-{uuid.uuid4().hex}"
    layer_locator = args.layer_locator.model_dump(mode="json", by_alias=True)
    parent_property_locator = (
        args.parent_property_locator.model_dump(mode="json", by_alias=True)
        if args.parent_property_locator is not None
        else None
    )

    async def _call():
        return await invoke_layer_properties_list(
            _backend(),
            request_id=request_id,
            layer_locator=layer_locator,
            parent_property_locator=parent_property_locator,
            offset=args.offset,
            limit=args.limit,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    try:
        execution = await progress.with_heartbeat(
            ctx,
            _call(),
            start_msg="ae.listLayerProperties native AEGP read...",
        )
    except asyncio.CancelledError:
        cancellation.cancel()
        raise
    return _native_read_response(execution)


async def _run_list_layer_property_keyframes(
    args: schemas.AeListLayerPropertyKeyframesArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = (
        int(time.time() * 1000) + _LAYER_PROPERTY_KEYFRAMES_LIST_TIMEOUT_MS
    )
    request_id = f"mcp-{uuid.uuid4().hex}"
    property_locator = args.property_locator.model_dump(
        mode="json", by_alias=True
    )

    async def _call():
        return await invoke_layer_property_keyframes_list(
            _backend(),
            request_id=request_id,
            property_locator=property_locator,
            offset=args.offset,
            limit=args.limit,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    try:
        execution = await progress.with_heartbeat(
            ctx,
            _call(),
            start_msg="ae.listLayerPropertyKeyframes native AEGP read...",
        )
    except asyncio.CancelledError:
        cancellation.cancel()
        raise
    return _native_read_response(execution)


async def _run_get_project_bit_depth(
    args: schemas.AeGetProjectBitDepthArgs,
    ctx: Any,
) -> dict[str, Any]:
    del args
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _PROJECT_BIT_DEPTH_READ_TIMEOUT_MS
    request_id = f"mcp-{uuid.uuid4().hex}"

    async def _call():
        return await invoke_project_bit_depth_read(
            _backend(),
            request_id=request_id,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    try:
        execution = await progress.with_heartbeat(
            ctx,
            _call(),
            start_msg="ae.getProjectBitDepth native AEGP read...",
        )
    except asyncio.CancelledError:
        cancellation.cancel()
        raise

    implementation = execution.implementation
    audit = execution.audit_fields()
    return {
        "ok": True,
        "value": execution.value.model_dump(mode="json", by_alias=True),
        "implementation": {
            "engine": execution.engine,
            "capabilityId": implementation.capability_id,
            "capabilityVersion": implementation.capability_version,
            "contractDigest": implementation.contract_digest,
            "risk": implementation.risk,
            "mutability": implementation.mutability,
            "idempotency": implementation.idempotency,
        },
        "provenance": {
            key: audit[key]
            for key in (
                "engine",
                "selectedWireVersion",
                "pluginVersion",
                "compiledSdkVersion",
                "sourceCommit",
                "hostInstanceId",
                "sessionId",
                "sessionGeneration",
                "capabilitiesDigest",
            )
        },
        "audit": {
            key: audit[key]
            for key in (
                "requestId",
                "capabilityId",
                "capabilityVersion",
                "contractDigest",
                "effect",
                "requestDigest",
                "postconditionAlgorithm",
                "postconditionDigest",
                "startedAtUnixMs",
                "completedAtUnixMs",
            )
        },
        "evidence": execution.evidence.model_dump(
            mode="json",
            by_alias=True,
            exclude_none=True,
        ),
    }


async def _run_set_project_bit_depth(
    args: schemas.AeSetProjectBitDepthArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _PROJECT_BIT_DEPTH_SET_TIMEOUT_MS
    request_id = f"mcp-{uuid.uuid4().hex}"

    async def _call():
        return await invoke_project_bit_depth_set(
            _backend(),
            request_id=request_id,
            target_depth=args.target_depth,
            idempotency_key=args.idempotency_key,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    call_task = asyncio.create_task(_call())
    try:
        execution = await progress.with_heartbeat(
            ctx,
            asyncio.shield(call_task),
            start_msg=(
                "ae.setProjectBitDepth native AEGP write; "
                "after dispatch, wait for the verified terminal result..."
            ),
        )
    except asyncio.CancelledError:
        # Cancellation is cooperative only before native dispatch. Shield the
        # accepted mutation so the UI never claims a continuing AE write stopped.
        cancellation.cancel()
        execution = await asyncio.shield(call_task)

    implementation = execution.implementation
    audit = execution.audit_fields()
    value = execution.value.model_dump(mode="json", by_alias=True)
    return {
        "ok": True,
        "replayed": execution.replayed,
        "value": value,
        "implementation": {
            "engine": execution.engine,
            "capabilityId": implementation.capability_id,
            "capabilityVersion": implementation.capability_version,
            "contractDigest": implementation.contract_digest,
            "risk": implementation.risk,
            "mutability": implementation.mutability,
            "idempotency": implementation.idempotency,
            "cancellation": implementation.cancellation,
            "undo": implementation.undo,
            "sideEffectSummary": implementation.side_effect_summary,
            "preconditions": list(implementation.preconditions),
        },
        "provenance": {
            key: audit[key]
            for key in (
                "engine",
                "selectedWireVersion",
                "pluginVersion",
                "compiledSdkVersion",
                "sourceCommit",
                "hostInstanceId",
                "sessionId",
                "sessionGeneration",
                "capabilitiesDigest",
            )
        },
        "audit": {
            key: audit[key]
            for key in (
                "requestId",
                "evidenceRequestId",
                "idempotencyKey",
                "replayed",
                "capabilityId",
                "capabilityVersion",
                "contractDigest",
                "effect",
                "requestDigest",
                "postconditionAlgorithm",
                "postconditionDigest",
                "undoAvailable",
                "undoVerified",
                "startedAtUnixMs",
                "completedAtUnixMs",
            )
        },
        "evidence": execution.evidence.model_dump(
            mode="json",
            by_alias=True,
            exclude_none=True,
        ),
    }


async def _run_set_layer_property_value(
    args: schemas.AeSetLayerPropertyValueArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _LAYER_PROPERTY_SET_TIMEOUT_MS
    request_id = f"mcp-{uuid.uuid4().hex}"

    async def _call():
        return await invoke_layer_property_set(
            _backend(),
            request_id=request_id,
            layer_locator=args.layer_locator.model_dump(mode="json", by_alias=True),
            property_locator=args.property_locator.model_dump(
                mode="json", by_alias=True
            ),
            value=args.value.model_dump(mode="json", by_alias=True),
            idempotency_key=args.idempotency_key,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    call_task = asyncio.create_task(_call())
    try:
        execution = await progress.with_heartbeat(
            ctx,
            asyncio.shield(call_task),
            start_msg=(
                "ae.setLayerPropertyValue native AEGP write; after dispatch, "
                "wait for the verified terminal result..."
            ),
        )
    except asyncio.CancelledError:
        cancellation.cancel()
        execution = await asyncio.shield(call_task)

    implementation = execution.implementation
    audit = execution.audit_fields()
    return {
        "ok": True,
        "replayed": execution.replayed,
        "value": execution.value.model_dump(mode="json", by_alias=True),
        "implementation": {
            "engine": execution.engine,
            "capabilityId": implementation.capability_id,
            "capabilityVersion": implementation.capability_version,
            "contractDigest": implementation.contract_digest,
            "risk": implementation.risk,
            "mutability": implementation.mutability,
            "idempotency": implementation.idempotency,
            "cancellation": implementation.cancellation,
            "undo": implementation.undo,
            "sideEffectSummary": implementation.side_effect_summary,
            "preconditions": list(implementation.preconditions),
        },
        "provenance": {
            key: audit[key]
            for key in (
                "engine",
                "selectedWireVersion",
                "pluginVersion",
                "compiledSdkVersion",
                "sourceCommit",
                "hostInstanceId",
                "sessionId",
                "sessionGeneration",
                "capabilitiesDigest",
            )
        },
        "audit": {
            key: audit[key]
            for key in (
                "requestId",
                "evidenceRequestId",
                "idempotencyKey",
                "replayed",
                "capabilityId",
                "capabilityVersion",
                "contractDigest",
                "effect",
                "requestDigest",
                "postconditionAlgorithm",
                "postconditionDigest",
                "undoAvailable",
                "undoVerified",
                "startedAtUnixMs",
                "completedAtUnixMs",
            )
        },
        "evidence": execution.evidence.model_dump(
            mode="json",
            by_alias=True,
            exclude_none=True,
        ),
    }


def _project_package_write_response(execution: Any) -> dict[str, Any]:
    """Public response shared by verified native capability-package writes."""

    implementation = execution.implementation
    audit = execution.audit_fields()
    return {
        "ok": True,
        "replayed": execution.replayed,
        "value": execution.value.model_dump(mode="json", by_alias=True),
        "implementation": {
            "engine": execution.engine,
            "capabilityId": implementation.capability_id,
            "capabilityVersion": implementation.capability_version,
            "contractDigest": implementation.contract_digest,
            "risk": implementation.risk,
            "mutability": implementation.mutability,
            "idempotency": implementation.idempotency,
            "cancellation": implementation.cancellation,
            "undo": implementation.undo,
            "sideEffectSummary": implementation.side_effect_summary,
            "preconditions": list(implementation.preconditions),
        },
        "provenance": {
            key: audit[key]
            for key in (
                "engine",
                "selectedWireVersion",
                "pluginVersion",
                "compiledSdkVersion",
                "sourceCommit",
                "hostInstanceId",
                "sessionId",
                "sessionGeneration",
                "capabilitiesDigest",
            )
        },
        "audit": {
            key: audit[key]
            for key in (
                "requestId",
                "evidenceRequestId",
                "idempotencyKey",
                "replayed",
                "capabilityId",
                "capabilityVersion",
                "contractDigest",
                "effect",
                "requestDigest",
                "postconditionAlgorithm",
                "postconditionDigest",
                "undoAvailable",
                "undoVerified",
                "startedAtUnixMs",
                "completedAtUnixMs",
            )
        },
        "evidence": execution.evidence.model_dump(
            mode="json",
            by_alias=True,
            exclude_none=True,
        ),
    }


async def _await_project_package_write(
    call: Any,
    *,
    cancellation: NativeCancellationToken,
    ctx: Any,
    start_msg: str,
) -> Any:
    call_task = asyncio.create_task(call())
    try:
        return await progress.with_heartbeat(
            ctx,
            asyncio.shield(call_task),
            start_msg=start_msg,
        )
    except asyncio.CancelledError:
        cancellation.cancel()
        return await asyncio.shield(call_task)


async def _run_get_project_context(
    args: schemas.AeGetProjectContextArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _PROJECT_CONTEXT_READ_TIMEOUT_MS

    async def _call():
        return await invoke_project_context_read(
            _backend(),
            request_id=f"mcp-{uuid.uuid4().hex}",
            selection_offset=args.selection_offset,
            selection_limit=args.selection_limit,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    try:
        execution = await progress.with_heartbeat(
            ctx,
            _call(),
            start_msg="ae.getProjectContext native AEGP read...",
        )
    except asyncio.CancelledError:
        cancellation.cancel()
        raise
    return _native_read_response(execution)


async def _run_get_project_item_metadata(
    args: schemas.AeGetProjectItemMetadataArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _PROJECT_ITEM_METADATA_READ_TIMEOUT_MS

    async def _call():
        return await invoke_project_item_metadata_read(
            _backend(),
            request_id=f"mcp-{uuid.uuid4().hex}",
            item_locator=args.item_locator.model_dump(mode="json", by_alias=True),
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    try:
        execution = await progress.with_heartbeat(
            ctx,
            _call(),
            start_msg="ae.getProjectItemMetadata native AEGP read...",
        )
    except asyncio.CancelledError:
        cancellation.cancel()
        raise
    response = _native_read_response(execution)
    # Unsupported type-specific facts are absent on the native wire. Keep the
    # public value byte-for-byte consistent with the verified postcondition.
    response["value"] = execution.value.model_dump(
        mode="json",
        by_alias=True,
        exclude_none=True,
    )
    return response


async def _run_get_composition_settings(
    args: schemas.AeGetCompositionSettingsArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _COMPOSITION_SETTINGS_READ_TIMEOUT_MS

    async def _call():
        return await invoke_composition_settings_read(
            _backend(),
            request_id=f"mcp-{uuid.uuid4().hex}",
            composition_locator=args.composition_locator.model_dump(
                mode="json", by_alias=True
            ),
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    try:
        execution = await progress.with_heartbeat(
            ctx,
            _call(),
            start_msg="ae.getCompositionSettings native AEGP read...",
        )
    except asyncio.CancelledError:
        cancellation.cancel()
        raise
    return _native_read_response(execution)


async def _run_set_composition_work_area(
    args: schemas.AeSetCompositionWorkAreaArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _COMPOSITION_WORK_AREA_SET_TIMEOUT_MS

    async def _call():
        return await invoke_composition_work_area_set(
            _backend(),
            request_id=f"mcp-{uuid.uuid4().hex}",
            composition_locator=args.composition_locator.model_dump(
                mode="json", by_alias=True
            ),
            start=args.start.model_dump(mode="json", by_alias=True),
            duration=args.duration.model_dump(mode="json", by_alias=True),
            idempotency_key=args.idempotency_key,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    execution = await _await_project_package_write(
        _call,
        cancellation=cancellation,
        ctx=ctx,
        start_msg=(
            "ae.setCompositionWorkArea native AEGP write; after dispatch, "
            "wait for verified readback..."
        ),
    )
    return _project_package_write_response(execution)


async def _run_rename_project_item(
    args: schemas.AeRenameProjectItemArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _PROJECT_ITEM_NAME_SET_TIMEOUT_MS

    async def _call():
        return await invoke_project_item_name_set(
            _backend(),
            request_id=f"mcp-{uuid.uuid4().hex}",
            item_locator=args.item_locator.model_dump(mode="json", by_alias=True),
            name=args.name,
            idempotency_key=args.idempotency_key,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    execution = await _await_project_package_write(
        _call,
        cancellation=cancellation,
        ctx=ctx,
        start_msg="ae.renameProjectItem native AEGP write; wait for verified readback...",
    )
    return _project_package_write_response(execution)


async def _run_set_project_item_comment(
    args: schemas.AeSetProjectItemCommentArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _PROJECT_ITEM_COMMENT_SET_TIMEOUT_MS

    async def _call():
        return await invoke_project_item_comment_set(
            _backend(),
            request_id=f"mcp-{uuid.uuid4().hex}",
            item_locator=args.item_locator.model_dump(mode="json", by_alias=True),
            comment=args.comment,
            idempotency_key=args.idempotency_key,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    execution = await _await_project_package_write(
        _call,
        cancellation=cancellation,
        ctx=ctx,
        start_msg="ae.setProjectItemComment native AEGP write; wait for verified readback...",
    )
    return _project_package_write_response(execution)


async def _run_set_project_item_label(
    args: schemas.AeSetProjectItemLabelArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _PROJECT_ITEM_LABEL_SET_TIMEOUT_MS

    async def _call():
        return await invoke_project_item_label_set(
            _backend(),
            request_id=f"mcp-{uuid.uuid4().hex}",
            item_locator=args.item_locator.model_dump(mode="json", by_alias=True),
            label_id=args.label_id,
            idempotency_key=args.idempotency_key,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    execution = await _await_project_package_write(
        _call,
        cancellation=cancellation,
        ctx=ctx,
        start_msg="ae.setProjectItemLabel native AEGP write; wait for verified readback...",
    )
    return _project_package_write_response(execution)


async def _run_duplicate_composition(
    args: schemas.AeDuplicateCompositionArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _COMPOSITION_DUPLICATE_TIMEOUT_MS

    async def _call():
        return await invoke_composition_duplicate(
            _backend(),
            request_id=f"mcp-{uuid.uuid4().hex}",
            composition_locator=args.composition_locator.model_dump(
                mode="json", by_alias=True
            ),
            new_name=args.new_name,
            idempotency_key=args.idempotency_key,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    execution = await _await_project_package_write(
        _call,
        cancellation=cancellation,
        ctx=ctx,
        start_msg="ae.duplicateComposition native AEGP write; wait for verified identity...",
    )
    return _project_package_write_response(execution)


async def _run_get_layer_details(
    args: schemas.AeGetLayerDetailsArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _LAYER_DETAILS_READ_TIMEOUT_MS

    async def _call():
        return await invoke_layer_details_read(
            _backend(),
            request_id=f"mcp-{uuid.uuid4().hex}",
            layer_locator=args.layer_locator.model_dump(mode="json", by_alias=True),
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    try:
        execution = await progress.with_heartbeat(
            ctx,
            _call(),
            start_msg="ae.getLayerDetails native AEGP read...",
        )
    except asyncio.CancelledError:
        cancellation.cancel()
        raise
    return _native_read_response(execution)


async def _run_get_layer_compositing_state(
    args: schemas.AeGetLayerCompositingStateArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _LAYER_COMPOSITING_READ_TIMEOUT_MS

    async def _call():
        return await invoke_layer_compositing_read(
            _backend(), request_id=f"mcp-{uuid.uuid4().hex}",
            layer_locator=args.layer_locator.model_dump(mode="json", by_alias=True),
            deadline_unix_ms=deadline_unix_ms, cancellation=cancellation,
        )

    try:
        execution = await progress.with_heartbeat(
            ctx, _call(), start_msg="ae.getLayerCompositingState native AEGP read...",
        )
    except asyncio.CancelledError:
        cancellation.cancel()
        raise
    return _native_read_response(execution)


async def _run_get_layer_transform(
    args: schemas.AeGetLayerTransformArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _LAYER_TRANSFORM_TIMEOUT_MS

    async def _call():
        return await read_layer_transform(
            _backend(),
            layer_locator=args.layer_locator.model_dump(mode="json", by_alias=True),
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    try:
        result = await progress.with_heartbeat(
            ctx,
            _call(),
            start_msg="ae.getLayerTransform native AEGP semantic read...",
        )
    except asyncio.CancelledError:
        cancellation.cancel()
        raise
    return _layer_transform_read_response(result)


async def _run_set_layer_transform(
    args: Any,
    ctx: Any,
    *,
    field: TransformField,
    value: dict[str, Any],
    label: str,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _LAYER_TRANSFORM_TIMEOUT_MS

    async def _call():
        return await set_layer_transform(
            _backend(),
            layer_locator=args.layer_locator.model_dump(mode="json", by_alias=True),
            field=field,
            value=value,
            idempotency_key=args.idempotency_key,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    result = await _await_project_package_write(
        _call,
        cancellation=cancellation,
        ctx=ctx,
        start_msg=f"{label} native AEGP write; wait for verified readback...",
    )
    return _layer_transform_write_response(result)


async def _run_set_layer_anchor_point(
    args: schemas.AeSetLayerAnchorPointArgs, ctx: Any,
) -> dict[str, Any]:
    return await _run_set_layer_transform(
        args, ctx, field="anchor-point",
        value={"kind": "vector", "components": args.anchor_point},
        label="ae.setLayerAnchorPoint",
    )


async def _run_set_layer_position(
    args: schemas.AeSetLayerPositionArgs, ctx: Any,
) -> dict[str, Any]:
    return await _run_set_layer_transform(
        args, ctx, field="position",
        value={"kind": "vector", "components": args.position},
        label="ae.setLayerPosition",
    )


async def _run_set_layer_scale(
    args: schemas.AeSetLayerScaleArgs, ctx: Any,
) -> dict[str, Any]:
    return await _run_set_layer_transform(
        args, ctx, field="scale",
        value={"kind": "vector", "components": args.scale_percent},
        label="ae.setLayerScale",
    )


async def _run_set_layer_rotation(
    args: schemas.AeSetLayerRotationArgs, ctx: Any,
) -> dict[str, Any]:
    return await _run_set_layer_transform(
        args, ctx, field="rotation",
        value={"kind": "scalar", "value": args.rotation_degrees},
        label="ae.setLayerRotation",
    )


async def _run_set_layer_opacity(
    args: schemas.AeSetLayerOpacityArgs, ctx: Any,
) -> dict[str, Any]:
    return await _run_set_layer_transform(
        args, ctx, field="opacity",
        value={"kind": "scalar", "value": args.opacity_percent},
        label="ae.setLayerOpacity",
    )


async def _run_set_layer_orientation(
    args: schemas.AeSetLayerOrientationArgs, ctx: Any,
) -> dict[str, Any]:
    return await _run_set_layer_transform(
        args, ctx, field="orientation",
        value={"kind": "vector", "components": args.orientation_degrees},
        label="ae.setLayerOrientation",
    )


async def _run_set_layer_switch(
    args: Any, ctx: Any, *, switch: LayerSwitch, label: str,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _LAYER_COMPOSITING_WRITE_TIMEOUT_MS

    async def _call():
        return await invoke_layer_switch_set(
            _backend(), request_id=f"mcp-{uuid.uuid4().hex}",
            layer_locator=args.layer_locator.model_dump(mode="json", by_alias=True),
            switch=switch, enabled=args.enabled, idempotency_key=args.idempotency_key,
            deadline_unix_ms=deadline_unix_ms, cancellation=cancellation,
        )

    execution = await _await_project_package_write(
        _call, cancellation=cancellation, ctx=ctx,
        start_msg=f"{label} native AEGP write; wait for verified readback...",
    )
    return _project_package_write_response(execution)


async def _run_set_layer_visibility(args: schemas.AeSetLayerVisibilityArgs, ctx: Any) -> dict[str, Any]:
    return await _run_set_layer_switch(args, ctx, switch="visibility", label="ae.setLayerVisibility")


async def _run_set_layer_solo(args: schemas.AeSetLayerSoloArgs, ctx: Any) -> dict[str, Any]:
    return await _run_set_layer_switch(args, ctx, switch="solo", label="ae.setLayerSolo")


async def _run_set_layer_locked(args: schemas.AeSetLayerLockedArgs, ctx: Any) -> dict[str, Any]:
    return await _run_set_layer_switch(args, ctx, switch="locked", label="ae.setLayerLocked")


async def _run_set_layer_shy(args: schemas.AeSetLayerShyArgs, ctx: Any) -> dict[str, Any]:
    return await _run_set_layer_switch(args, ctx, switch="shy", label="ae.setLayerShy")


async def _run_set_layer_motion_blur(args: schemas.AeSetLayerMotionBlurArgs, ctx: Any) -> dict[str, Any]:
    return await _run_set_layer_switch(args, ctx, switch="motion-blur", label="ae.setLayerMotionBlur")


async def _run_set_layer_three_d(args: schemas.AeSetLayerThreeDArgs, ctx: Any) -> dict[str, Any]:
    return await _run_set_layer_switch(args, ctx, switch="three-d", label="ae.setLayerThreeD")


async def _run_set_layer_adjustment(args: schemas.AeSetLayerAdjustmentArgs, ctx: Any) -> dict[str, Any]:
    return await _run_set_layer_switch(args, ctx, switch="adjustment", label="ae.setLayerAdjustment")


async def _run_set_layer_quality(
    args: schemas.AeSetLayerQualityArgs, ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _LAYER_COMPOSITING_WRITE_TIMEOUT_MS

    async def _call():
        return await invoke_layer_quality_set(
            _backend(), request_id=f"mcp-{uuid.uuid4().hex}",
            layer_locator=args.layer_locator.model_dump(mode="json", by_alias=True),
            quality=args.quality, idempotency_key=args.idempotency_key,
            deadline_unix_ms=deadline_unix_ms, cancellation=cancellation,
        )

    execution = await _await_project_package_write(
        _call, cancellation=cancellation, ctx=ctx,
        start_msg="ae.setLayerQuality native AEGP write; wait for verified readback...",
    )
    return _project_package_write_response(execution)


async def _run_set_layer_blending_mode(
    args: schemas.AeSetLayerBlendingModeArgs, ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _LAYER_COMPOSITING_WRITE_TIMEOUT_MS

    async def _call():
        return await invoke_layer_blending_mode_set(
            _backend(), request_id=f"mcp-{uuid.uuid4().hex}",
            layer_locator=args.layer_locator.model_dump(mode="json", by_alias=True),
            mode=args.mode, idempotency_key=args.idempotency_key,
            deadline_unix_ms=deadline_unix_ms, cancellation=cancellation,
        )

    execution = await _await_project_package_write(
        _call, cancellation=cancellation, ctx=ctx,
        start_msg="ae.setLayerBlendingMode native AEGP write; wait for verified readback...",
    )
    return _project_package_write_response(execution)


async def _run_rename_layer(
    args: schemas.AeRenameLayerArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _LAYER_NAME_SET_TIMEOUT_MS

    async def _call():
        return await invoke_layer_name_set(
            _backend(),
            request_id=f"mcp-{uuid.uuid4().hex}",
            layer_locator=args.layer_locator.model_dump(mode="json", by_alias=True),
            name=args.name,
            idempotency_key=args.idempotency_key,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    execution = await _await_project_package_write(
        _call,
        cancellation=cancellation,
        ctx=ctx,
        start_msg="ae.renameLayer native AEGP write; wait for verified readback...",
    )
    return _project_package_write_response(execution)


async def _run_set_layer_range(
    args: schemas.AeSetLayerRangeArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _LAYER_RANGE_SET_TIMEOUT_MS

    async def _call():
        return await invoke_layer_range_set(
            _backend(),
            request_id=f"mcp-{uuid.uuid4().hex}",
            layer_locator=args.layer_locator.model_dump(mode="json", by_alias=True),
            in_point=args.in_point.model_dump(mode="json", by_alias=True),
            duration=args.duration.model_dump(mode="json", by_alias=True),
            idempotency_key=args.idempotency_key,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    execution = await _await_project_package_write(
        _call,
        cancellation=cancellation,
        ctx=ctx,
        start_msg="ae.setLayerRange native AEGP write; wait for exact timing readback...",
    )
    return _project_package_write_response(execution)


async def _run_set_layer_start_time(
    args: schemas.AeSetLayerStartTimeArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _LAYER_START_TIME_SET_TIMEOUT_MS

    async def _call():
        return await invoke_layer_start_time_set(
            _backend(),
            request_id=f"mcp-{uuid.uuid4().hex}",
            layer_locator=args.layer_locator.model_dump(mode="json", by_alias=True),
            start_time=args.start_time.model_dump(mode="json", by_alias=True),
            idempotency_key=args.idempotency_key,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    execution = await _await_project_package_write(
        _call,
        cancellation=cancellation,
        ctx=ctx,
        start_msg="ae.setLayerStartTime native AEGP write; wait for exact timing readback...",
    )
    return _project_package_write_response(execution)


async def _run_set_layer_stretch(
    args: schemas.AeSetLayerStretchArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _LAYER_STRETCH_SET_TIMEOUT_MS
    stretch = stretch_percent_to_ratio(args.stretch_percent)

    async def _call():
        return await invoke_layer_stretch_set(
            _backend(),
            request_id=f"mcp-{uuid.uuid4().hex}",
            layer_locator=args.layer_locator.model_dump(mode="json", by_alias=True),
            stretch=stretch,
            idempotency_key=args.idempotency_key,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    execution = await _await_project_package_write(
        _call,
        cancellation=cancellation,
        ctx=ctx,
        start_msg="ae.setLayerStretch native AEGP write; wait for exact ratio readback...",
    )
    return _project_package_write_response(execution)


async def _run_reorder_layer(
    args: schemas.AeReorderLayerArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _LAYER_ORDER_SET_TIMEOUT_MS

    async def _call():
        return await invoke_layer_order_set(
            _backend(),
            request_id=f"mcp-{uuid.uuid4().hex}",
            layer_locator=args.layer_locator.model_dump(mode="json", by_alias=True),
            target_stack_index=args.target_stack_index,
            idempotency_key=args.idempotency_key,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    execution = await _await_project_package_write(
        _call,
        cancellation=cancellation,
        ctx=ctx,
        start_msg="ae.reorderLayer native AEGP write; wait for stack readback...",
    )
    return _project_package_write_response(execution)


async def _run_set_layer_parent(
    args: schemas.AeSetLayerParentArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _LAYER_PARENT_SET_TIMEOUT_MS
    parent = (
        args.parent_layer_locator.model_dump(mode="json", by_alias=True)
        if args.parent_layer_locator is not None
        else None
    )

    async def _call():
        return await invoke_layer_parent_set(
            _backend(),
            request_id=f"mcp-{uuid.uuid4().hex}",
            layer_locator=args.layer_locator.model_dump(mode="json", by_alias=True),
            parent_layer_locator=parent,
            idempotency_key=args.idempotency_key,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    execution = await _await_project_package_write(
        _call,
        cancellation=cancellation,
        ctx=ctx,
        start_msg="ae.setLayerParent native AEGP write; wait for hierarchy readback...",
    )
    return _project_package_write_response(execution)


async def _run_duplicate_layer(
    args: schemas.AeDuplicateLayerArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _LAYER_DUPLICATE_TIMEOUT_MS

    async def _call():
        return await invoke_layer_duplicate(
            _backend(),
            request_id=f"mcp-{uuid.uuid4().hex}",
            layer_locator=args.layer_locator.model_dump(mode="json", by_alias=True),
            new_name=args.new_name,
            idempotency_key=args.idempotency_key,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    execution = await _await_project_package_write(
        _call,
        cancellation=cancellation,
        ctx=ctx,
        start_msg="ae.duplicateLayer native AEGP write; wait for fresh locator readback...",
    )
    return _project_package_write_response(execution)


def _keyframe_write_target(
    args: Any,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    return (
        args.layer_locator.model_dump(mode="json", by_alias=True),
        args.property_locator.model_dump(mode="json", by_alias=True),
        args.time.model_dump(mode="json", by_alias=True),
    )


async def _run_get_layer_property_keyframe_details(
    args: schemas.AeGetLayerPropertyKeyframeDetailsArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _KEYFRAME_DETAILS_READ_TIMEOUT_MS

    async def _call():
        return await invoke_keyframe_details_read(
            _backend(),
            request_id=f"mcp-{uuid.uuid4().hex}",
            property_locator=args.property_locator.model_dump(
                mode="json", by_alias=True
            ),
            time=args.time.model_dump(mode="json", by_alias=True),
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    try:
        execution = await progress.with_heartbeat(
            ctx,
            _call(),
            start_msg="ae.getLayerPropertyKeyframeDetails native AEGP read...",
        )
    except asyncio.CancelledError:
        cancellation.cancel()
        raise
    return _native_read_response(execution)


async def _run_add_layer_property_keyframe(
    args: schemas.AeAddLayerPropertyKeyframeArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _KEYFRAME_WRITE_TIMEOUT_MS
    layer, prop, target_time = _keyframe_write_target(args)

    async def _call():
        return await invoke_keyframe_add(
            _backend(),
            request_id=f"mcp-{uuid.uuid4().hex}",
            layer_locator=layer,
            property_locator=prop,
            time=target_time,
            value=args.value.model_dump(mode="json", by_alias=True),
            idempotency_key=args.idempotency_key,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    execution = await _await_project_package_write(
        _call,
        cancellation=cancellation,
        ctx=ctx,
        start_msg="ae.addLayerPropertyKeyframe native AEGP write; wait for verified readback...",
    )
    return _project_package_write_response(execution)


async def _run_set_layer_property_keyframe_value(
    args: schemas.AeSetLayerPropertyKeyframeValueArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _KEYFRAME_WRITE_TIMEOUT_MS
    layer, prop, target_time = _keyframe_write_target(args)

    async def _call():
        return await invoke_keyframe_value_set(
            _backend(),
            request_id=f"mcp-{uuid.uuid4().hex}",
            layer_locator=layer,
            property_locator=prop,
            time=target_time,
            value=args.value.model_dump(mode="json", by_alias=True),
            idempotency_key=args.idempotency_key,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    execution = await _await_project_package_write(
        _call,
        cancellation=cancellation,
        ctx=ctx,
        start_msg="ae.setLayerPropertyKeyframeValue native AEGP write; wait for verified readback...",
    )
    return _project_package_write_response(execution)


async def _run_set_layer_property_keyframe_interpolation(
    args: schemas.AeSetLayerPropertyKeyframeInterpolationArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _KEYFRAME_WRITE_TIMEOUT_MS
    layer, prop, target_time = _keyframe_write_target(args)

    async def _call():
        return await invoke_keyframe_interpolation_set(
            _backend(),
            request_id=f"mcp-{uuid.uuid4().hex}",
            layer_locator=layer,
            property_locator=prop,
            time=target_time,
            in_interpolation=args.in_interpolation,
            out_interpolation=args.out_interpolation,
            idempotency_key=args.idempotency_key,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    execution = await _await_project_package_write(
        _call,
        cancellation=cancellation,
        ctx=ctx,
        start_msg=(
            "ae.setLayerPropertyKeyframeInterpolation native AEGP write; "
            "wait for verified readback..."
        ),
    )
    return _project_package_write_response(execution)


async def _run_set_layer_property_keyframe_temporal_ease(
    args: schemas.AeSetLayerPropertyKeyframeTemporalEaseArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _KEYFRAME_WRITE_TIMEOUT_MS
    layer, prop, target_time = _keyframe_write_target(args)

    async def _call():
        return await invoke_keyframe_temporal_ease_set(
            _backend(),
            request_id=f"mcp-{uuid.uuid4().hex}",
            layer_locator=layer,
            property_locator=prop,
            time=target_time,
            dimensions=tuple(
                item.model_dump(mode="json", by_alias=True)
                for item in args.dimensions
            ),
            idempotency_key=args.idempotency_key,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    execution = await _await_project_package_write(
        _call,
        cancellation=cancellation,
        ctx=ctx,
        start_msg=(
            "ae.setLayerPropertyKeyframeTemporalEase native AEGP write; "
            "wait for verified readback..."
        ),
    )
    return _project_package_write_response(execution)


async def _run_set_layer_property_keyframe_behavior(
    args: schemas.AeSetLayerPropertyKeyframeBehaviorArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _KEYFRAME_WRITE_TIMEOUT_MS
    layer, prop, target_time = _keyframe_write_target(args)

    async def _call():
        return await invoke_keyframe_behavior_set(
            _backend(),
            request_id=f"mcp-{uuid.uuid4().hex}",
            layer_locator=layer,
            property_locator=prop,
            time=target_time,
            behavior=args.behavior,
            enabled=args.enabled,
            idempotency_key=args.idempotency_key,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    execution = await _await_project_package_write(
        _call,
        cancellation=cancellation,
        ctx=ctx,
        start_msg="ae.setLayerPropertyKeyframeBehavior native AEGP write; wait for verified readback...",
    )
    return _project_package_write_response(execution)


async def _run_delete_layer_property_keyframe(
    args: schemas.AeDeleteLayerPropertyKeyframeArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _KEYFRAME_WRITE_TIMEOUT_MS
    layer, prop, target_time = _keyframe_write_target(args)

    async def _call():
        return await invoke_keyframe_delete(
            _backend(),
            request_id=f"mcp-{uuid.uuid4().hex}",
            layer_locator=layer,
            property_locator=prop,
            time=target_time,
            idempotency_key=args.idempotency_key,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )

    execution = await _await_project_package_write(
        _call,
        cancellation=cancellation,
        ctx=ctx,
        start_msg="ae.deleteLayerPropertyKeyframe native AEGP write; wait for verified deletion...",
    )
    return _project_package_write_response(execution)


register(
    "ae.getProjectContext",
    schemas.AeGetProjectContextArgs,
    _run_get_project_context,
)
register(
    "ae.getProjectItemMetadata",
    schemas.AeGetProjectItemMetadataArgs,
    _run_get_project_item_metadata,
)
register(
    "ae.getCompositionSettings",
    schemas.AeGetCompositionSettingsArgs,
    _run_get_composition_settings,
)
register(
    "ae.setCompositionWorkArea",
    schemas.AeSetCompositionWorkAreaArgs,
    _run_set_composition_work_area,
)
register(
    "ae.renameProjectItem",
    schemas.AeRenameProjectItemArgs,
    _run_rename_project_item,
)
register(
    "ae.setProjectItemComment",
    schemas.AeSetProjectItemCommentArgs,
    _run_set_project_item_comment,
)
register(
    "ae.setProjectItemLabel",
    schemas.AeSetProjectItemLabelArgs,
    _run_set_project_item_label,
)
register(
    "ae.duplicateComposition",
    schemas.AeDuplicateCompositionArgs,
    _run_duplicate_composition,
)
register(
    "ae.getLayerDetails",
    schemas.AeGetLayerDetailsArgs,
    _run_get_layer_details,
)
register("ae.getLayerCompositingState", schemas.AeGetLayerCompositingStateArgs, _run_get_layer_compositing_state)
register("ae.setLayerVisibility", schemas.AeSetLayerVisibilityArgs, _run_set_layer_visibility)
register("ae.setLayerSolo", schemas.AeSetLayerSoloArgs, _run_set_layer_solo)
register("ae.setLayerLocked", schemas.AeSetLayerLockedArgs, _run_set_layer_locked)
register("ae.setLayerShy", schemas.AeSetLayerShyArgs, _run_set_layer_shy)
register("ae.setLayerMotionBlur", schemas.AeSetLayerMotionBlurArgs, _run_set_layer_motion_blur)
register("ae.setLayerThreeD", schemas.AeSetLayerThreeDArgs, _run_set_layer_three_d)
register("ae.setLayerAdjustment", schemas.AeSetLayerAdjustmentArgs, _run_set_layer_adjustment)
register("ae.setLayerQuality", schemas.AeSetLayerQualityArgs, _run_set_layer_quality)
register("ae.setLayerBlendingMode", schemas.AeSetLayerBlendingModeArgs, _run_set_layer_blending_mode)
register("ae.getLayerTransform", schemas.AeGetLayerTransformArgs, _run_get_layer_transform)
register("ae.setLayerAnchorPoint", schemas.AeSetLayerAnchorPointArgs, _run_set_layer_anchor_point)
register("ae.setLayerPosition", schemas.AeSetLayerPositionArgs, _run_set_layer_position)
register("ae.setLayerScale", schemas.AeSetLayerScaleArgs, _run_set_layer_scale)
register("ae.setLayerRotation", schemas.AeSetLayerRotationArgs, _run_set_layer_rotation)
register("ae.setLayerOpacity", schemas.AeSetLayerOpacityArgs, _run_set_layer_opacity)
register("ae.setLayerOrientation", schemas.AeSetLayerOrientationArgs, _run_set_layer_orientation)
register(
    "ae.renameLayer",
    schemas.AeRenameLayerArgs,
    _run_rename_layer,
)
register(
    "ae.setLayerRange",
    schemas.AeSetLayerRangeArgs,
    _run_set_layer_range,
)
register(
    "ae.setLayerStartTime",
    schemas.AeSetLayerStartTimeArgs,
    _run_set_layer_start_time,
)
register(
    "ae.setLayerStretch",
    schemas.AeSetLayerStretchArgs,
    _run_set_layer_stretch,
)
register(
    "ae.reorderLayer",
    schemas.AeReorderLayerArgs,
    _run_reorder_layer,
)
register(
    "ae.setLayerParent",
    schemas.AeSetLayerParentArgs,
    _run_set_layer_parent,
)
register(
    "ae.duplicateLayer",
    schemas.AeDuplicateLayerArgs,
    _run_duplicate_layer,
)
register(
    "ae.projectSummary",
    schemas.AeProjectSummaryArgs,
    _run_project_summary,
)
register(
    "ae.listProjectItems",
    schemas.AeListProjectItemsArgs,
    _run_list_project_items,
)
register(
    "ae.listCompositionLayers",
    schemas.AeListCompositionLayersArgs,
    _run_list_composition_layers,
)
register(
    "ae.listSelectedLayers",
    schemas.AeListSelectedLayersArgs,
    _run_list_selected_layers,
)
register(
    "ae.getCompositionTime",
    schemas.AeGetCompositionTimeArgs,
    _run_get_composition_time,
)
register(
    "ae.setCompositionTime",
    schemas.AeSetCompositionTimeArgs,
    _run_set_composition_time,
)
register(
    "ae.createComposition",
    schemas.AeCreateCompositionArgs,
    _run_create_composition,
)
register(
    "ae.createCompositionLayer",
    schemas.AeCreateCompositionLayerArgs,
    _run_create_composition_layer,
)
register(
    "ae.applyLayerEffect",
    schemas.AeApplyLayerEffectArgs,
    _run_apply_layer_effect,
)
register(
    "ae.listLayerProperties",
    schemas.AeListLayerPropertiesArgs,
    _run_list_layer_properties,
)
register(
    "ae.listLayerPropertyKeyframes",
    schemas.AeListLayerPropertyKeyframesArgs,
    _run_list_layer_property_keyframes,
)
register(
    "ae.getProjectBitDepth",
    schemas.AeGetProjectBitDepthArgs,
    _run_get_project_bit_depth,
)
register(
    "ae.setProjectBitDepth",
    schemas.AeSetProjectBitDepthArgs,
    _run_set_project_bit_depth,
)
register(
    "ae.setLayerPropertyValue",
    schemas.AeSetLayerPropertyValueArgs,
    _run_set_layer_property_value,
)
register(
    "ae.getLayerPropertyKeyframeDetails",
    schemas.AeGetLayerPropertyKeyframeDetailsArgs,
    _run_get_layer_property_keyframe_details,
)
register(
    "ae.addLayerPropertyKeyframe",
    schemas.AeAddLayerPropertyKeyframeArgs,
    _run_add_layer_property_keyframe,
)
register(
    "ae.setLayerPropertyKeyframeValue",
    schemas.AeSetLayerPropertyKeyframeValueArgs,
    _run_set_layer_property_keyframe_value,
)
register(
    "ae.setLayerPropertyKeyframeInterpolation",
    schemas.AeSetLayerPropertyKeyframeInterpolationArgs,
    _run_set_layer_property_keyframe_interpolation,
)
register(
    "ae.setLayerPropertyKeyframeTemporalEase",
    schemas.AeSetLayerPropertyKeyframeTemporalEaseArgs,
    _run_set_layer_property_keyframe_temporal_ease,
)
register(
    "ae.setLayerPropertyKeyframeBehavior",
    schemas.AeSetLayerPropertyKeyframeBehaviorArgs,
    _run_set_layer_property_keyframe_behavior,
)
register(
    "ae.deleteLayerPropertyKeyframe",
    schemas.AeDeleteLayerPropertyKeyframeArgs,
    _run_delete_layer_property_keyframe,
)


__all__ = [
    "_run_duplicate_layer",
    "_run_duplicate_composition",
    "_run_get_composition_settings",
    "_run_get_layer_details",
    "_run_get_layer_compositing_state",
    "_run_get_layer_transform",
    "_run_get_project_context",
    "_run_get_project_item_metadata",
    "_run_get_composition_time",
    "_run_get_project_bit_depth",
    "_run_create_composition",
    "_run_create_composition_layer",
    "_run_apply_layer_effect",
    "_run_list_composition_layers",
    "_run_list_layer_properties",
    "_run_list_layer_property_keyframes",
    "_run_list_project_items",
    "_run_project_summary",
    "_run_rename_layer",
    "_run_rename_project_item",
    "_run_reorder_layer",
    "_run_set_composition_work_area",
    "_run_set_project_item_comment",
    "_run_set_project_item_label",
    "_run_set_project_bit_depth",
    "_run_set_composition_time",
    "_run_set_layer_property_value",
    "_run_set_layer_parent",
    "_run_set_layer_range",
    "_run_set_layer_start_time",
    "_run_set_layer_stretch",
    "_run_set_layer_visibility",
    "_run_set_layer_solo",
    "_run_set_layer_locked",
    "_run_set_layer_shy",
    "_run_set_layer_motion_blur",
    "_run_set_layer_three_d",
    "_run_set_layer_adjustment",
    "_run_set_layer_quality",
    "_run_set_layer_blending_mode",
    "_run_set_layer_anchor_point",
    "_run_set_layer_position",
    "_run_set_layer_scale",
    "_run_set_layer_rotation",
    "_run_set_layer_opacity",
    "_run_set_layer_orientation",
    "_run_get_layer_property_keyframe_details",
    "_run_add_layer_property_keyframe",
    "_run_set_layer_property_keyframe_value",
    "_run_set_layer_property_keyframe_interpolation",
    "_run_set_layer_property_keyframe_temporal_ease",
    "_run_set_layer_property_keyframe_behavior",
    "_run_delete_layer_property_keyframe",
]
