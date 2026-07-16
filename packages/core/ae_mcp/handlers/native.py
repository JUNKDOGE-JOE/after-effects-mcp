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
    invoke_layer_properties_list,
    invoke_layer_property_set,
    invoke_project_bit_depth_read,
    invoke_project_bit_depth_set,
    invoke_project_items_list,
    invoke_project_summary,
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
_LAYER_PROPERTIES_LIST_TIMEOUT_MS = 10_000
_LAYER_PROPERTY_SET_TIMEOUT_MS = 10_000


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
    "ae.listLayerProperties",
    schemas.AeListLayerPropertiesArgs,
    _run_list_layer_properties,
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


__all__ = [
    "_run_get_composition_time",
    "_run_get_project_bit_depth",
    "_run_list_composition_layers",
    "_run_list_layer_properties",
    "_run_list_project_items",
    "_run_project_summary",
    "_run_set_project_bit_depth",
    "_run_set_composition_time",
    "_run_set_layer_property_value",
]
