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
    invoke_project_folder_create,
    invoke_project_summary,
)
from ae_mcp.handlers import register


_PROJECT_SUMMARY_TIMEOUT_MS = 10_000
_PROJECT_FOLDER_CREATE_TIMEOUT_MS = 10_000


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


async def _run_project_create_folder(
    args: schemas.AeProjectCreateFolderArgs,
    ctx: Any,
) -> dict[str, Any]:
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + _PROJECT_FOLDER_CREATE_TIMEOUT_MS
    request_id = f"mcp-{uuid.uuid4().hex}"

    async def _call():
        return await invoke_project_folder_create(
            _backend(),
            request_id=request_id,
            name=args.name,
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
                "ae.projectCreateFolder native AEGP write; "
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
        "created": value["created"],
        "replayed": execution.replayed,
        "value": value,
        "state": {
            "before": {"projectItemCount": value["itemCountBefore"]},
            "after": {
                "projectItemCount": value["itemCountAfter"],
                "folder": {
                    "itemId": value["folderItemId"],
                    "name": value["folderName"],
                    "parentItemId": value["parentItemId"],
                },
            },
        },
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
    "ae.projectCreateFolder",
    schemas.AeProjectCreateFolderArgs,
    _run_project_create_folder,
)


__all__ = ["_run_project_create_folder", "_run_project_summary"]
