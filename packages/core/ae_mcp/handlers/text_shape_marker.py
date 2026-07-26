"""Public handlers for the frozen Text, Shape, and Marker package."""

from __future__ import annotations

import asyncio
import time
import uuid
from typing import Any

from ae_mcp import progress
from ae_mcp.backends import discovery as _discovery
from ae_mcp.backends.native import NativeCancellationToken
from ae_mcp.backends.maintained_text import execute_text_tool
from ae_mcp.backends.native_text_shape_marker import invoke_tsm_native
from ae_mcp.handlers import register
from ae_mcp.handlers.native import (
    _backend,
    _native_read_response,
    _project_package_write_response,
)
from ae_mcp.schemas_tsm import (
    AeCreateMarkerArgs,
    AeCreateShapeGroupArgs,
    AeCreateShapeLayerArgs,
    AeDeleteMarkerArgs,
    AeCreateTextLayerArgs,
    AeGetTextDocumentArgs,
    AeListInstalledFontsArgs,
    AeListMarkersArgs,
    AeListShapeGroupsArgs,
    AeReorderShapeGroupArgs,
    AeSetMarkerArgs,
    AeSetShapeFillStyleArgs,
    AeSetShapePathArgs,
    AeSetShapeStrokeStyleArgs,
    AeSetTextCharacterStyleArgs,
    AeSetTextContentArgs,
    AeSetTextParagraphStyleArgs,
)


NATIVE_TOOLS = {
    "ae.createShapeLayer": ("ae.shape.layer.create", AeCreateShapeLayerArgs),
    "ae.listShapeGroups": ("ae.shape.groups.list", AeListShapeGroupsArgs),
    "ae.createShapeGroup": ("ae.shape.group.create", AeCreateShapeGroupArgs),
    "ae.setShapePath": ("ae.shape.path.set", AeSetShapePathArgs),
    "ae.setShapeFillStyle": ("ae.shape.fill-style.set", AeSetShapeFillStyleArgs),
    "ae.setShapeStrokeStyle": (
        "ae.shape.stroke-style.set",
        AeSetShapeStrokeStyleArgs,
    ),
    "ae.reorderShapeGroup": ("ae.shape.group.reorder", AeReorderShapeGroupArgs),
    "ae.listMarkers": ("ae.marker.list", AeListMarkersArgs),
    "ae.createMarker": ("ae.marker.create", AeCreateMarkerArgs),
    "ae.setMarker": ("ae.marker.set", AeSetMarkerArgs),
    "ae.deleteMarker": ("ae.marker.delete", AeDeleteMarkerArgs),
}

TEXT_TOOLS = {
    "ae.listInstalledFonts": AeListInstalledFontsArgs,
    "ae.createTextLayer": AeCreateTextLayerArgs,
    "ae.getTextDocument": AeGetTextDocumentArgs,
    "ae.setTextContent": AeSetTextContentArgs,
    "ae.setTextCharacterStyle": AeSetTextCharacterStyleArgs,
    "ae.setTextParagraphStyle": AeSetTextParagraphStyleArgs,
}


def _text_runner(public_name: str):
    async def run(args: Any, ctx: Any) -> dict[str, Any]:
        async def call():
            return await execute_text_tool(
                _discovery.select_backend(),
                None if public_name == "ae.listInstalledFonts" else _backend(),
                tool=public_name,
                args=args,
            )

        return await progress.run_with_timeout(
            ctx,
            call(),
            timeout_sec=40.0,
            start_msg=f"{public_name} maintained text template...",
        )

    run.__name__ = f"_run_{public_name.replace('.', '_')}"
    return run


def _native_runner(public_name: str, capability_id: str):
    write = public_name not in {"ae.listShapeGroups", "ae.listMarkers"}

    async def run(args: Any, ctx: Any) -> dict[str, Any]:
        cancellation = NativeCancellationToken()
        deadline_unix_ms = int(time.time() * 1000) + 20_000
        request_id = f"mcp-{uuid.uuid4().hex}"

        async def call():
            return await invoke_tsm_native(
                _backend(),
                capability_id=capability_id,
                arguments=args.model_dump(mode="json", by_alias=False),
                request_id=request_id,
                deadline_unix_ms=deadline_unix_ms,
                cancellation=cancellation,
            )

        try:
            execution = await progress.with_heartbeat(
                ctx,
                call(),
                start_msg=f"{public_name} native AEGP {'write' if write else 'read'}...",
            )
        except asyncio.CancelledError:
            cancellation.cancel()
            raise
        response = (
            _project_package_write_response(execution)
            if write
            else _native_read_response(execution)
        )
        response["value"] = execution.value.model_dump(mode="json", by_alias=True)
        return response

    run.__name__ = f"_run_{public_name.replace('.', '_')}"
    return run


for _public_name, (_capability_id, _schema) in NATIVE_TOOLS.items():
    register(
        _public_name,
        _schema,
        _native_runner(_public_name, _capability_id),
    )

for _public_name, _schema in TEXT_TOOLS.items():
    register(_public_name, _schema, _text_runner(_public_name))
