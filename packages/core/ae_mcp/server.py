"""MCP server entry (stdio transport).

Uses the low-level mcp.server.Server API so we can:
  - expose each verb's pydantic JSON schema as the tool's inputSchema,
  - fan-out to the HANDLERS registry by name,
  - surface structured {ok, error, ...} payloads uniformly.

Handlers receive (validated_model, ctx). `ctx` is the mcp.server.Context
object surfaced via the request_context; it owns report_progress.
"""

from __future__ import annotations

import json
import logging
from typing import Any, List

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

from ae_mcp.handlers import HANDLERS, load_all
from ae_mcp.instructions import SERVER_INSTRUCTIONS

log = logging.getLogger("ae_mcp.server")


def _filtered_tool_names() -> set:
    """Return verb names this server should expose, given active backend
    capabilities + whether a snapshotter is installed."""
    from ae_mcp.backends import discovery as _discovery
    from ae_mcp.snapshot import discovery as _snap_discovery
    try:
        backend = _discovery.select_backend()
        supported = backend.supported_verbs()
    except Exception as e:  # noqa: BLE001
        log.warning("backend selection failed; exposing no tools: %s", e)
        return set()
    if _snap_discovery.select_snapshotter() is None:
        supported = supported - {"ae.snapshot"}
    return supported


def _format_result(result: Any) -> str:
    """Coerce handler return value into MCP text content.

    Handlers return either a dict/list (preferred, serialised as JSON) or a
    str. Anything else is repr()'d as a last resort.
    """
    if isinstance(result, str):
        return result
    if isinstance(result, (dict, list)):
        try:
            return json.dumps(result, ensure_ascii=False)
        except (TypeError, ValueError):
            return repr(result)
    return repr(result)


def expose_tool_name(verb: str) -> str:
    """Map a canonical verb to its MCP-exposed tool name.

    Verbs are dotted internally ("ae.ping"), but the MCP spec requires tool
    names to match ``^[a-zA-Z0-9_-]{1,64}$``. Dots are illegal, and strict
    clients (e.g. Claude Desktop extensions) reject them at handshake time, so
    we expose dot-free names ("ae.ping" -> "ae_ping").
    """
    return verb.replace(".", "_")


def resolve_tool_name(name: str, handlers) -> "str | None":
    """Map an exposed tool name back to its canonical verb.

    Accepts both the exposed dot-free name ("ae_ping") and, for backward
    compatibility, the original dotted verb ("ae.ping"). Returns ``None`` if
    the name matches no registered verb.
    """
    if name in handlers:
        return name
    for verb in handlers:
        if expose_tool_name(verb) == name:
            return verb
    return None


def build_server() -> Server:
    """Construct the low-level MCP Server with all 15 verbs registered."""
    load_all()

    server: Server = Server("ae", instructions=SERVER_INSTRUCTIONS)

    @server.list_tools()
    async def _list_tools() -> List[Tool]:
        allowed = _filtered_tool_names()
        tools: List[Tool] = []
        for verb_name, (schema_cls, _run_fn) in HANDLERS.items():
            if verb_name not in allowed:
                continue
            # pydantic v2: .model_json_schema() returns the full JSON schema.
            try:
                input_schema = schema_cls.model_json_schema()
            except Exception as e:  # noqa: BLE001
                log.warning("schema for %s failed: %s", verb_name, e)
                input_schema = {"type": "object", "properties": {}}
            # Description pulled from the pydantic class docstring.
            desc = (schema_cls.__doc__ or f"ae-mcp verb {verb_name}").strip()
            tools.append(
                Tool(
                    name=expose_tool_name(verb_name),
                    description=desc,
                    inputSchema=input_schema,
                )
            )
        return tools

    @server.call_tool()
    async def _call_tool(name: str, arguments: dict | None) -> List[TextContent]:
        # Tools are exposed with dots replaced by underscores; map the exposed
        # name back to the canonical verb (the dotted name is accepted too).
        canonical = resolve_tool_name(name, HANDLERS)
        if canonical is None:
            payload = _format_result({"ok": False, "error": f"unknown tool: {name}"})
            return [TextContent(type="text", text=payload)]
        name = canonical

        schema_cls, run_fn = HANDLERS[name]

        try:
            validated = schema_cls(**(arguments or {}))
        except Exception as e:  # noqa: BLE001
            payload = _format_result({"ok": False, "error": f"schema: {e}"})
            return [TextContent(type="text", text=payload)]

        # Pull ctx from request context so handlers can emit progress.
        ctx = None
        try:
            ctx = server.request_context  # type: ignore[attr-defined]
        except LookupError:
            ctx = None

        try:
            result = await run_fn(validated, ctx)
        except Exception as e:  # noqa: BLE001
            log.exception("handler %s raised", name)
            payload = _format_result({"ok": False, "error": str(e)})
            return [TextContent(type="text", text=payload)]

        return [TextContent(type="text", text=_format_result(result))]

    return server


async def _run_async() -> None:
    """Async entry: stdio transport loop."""
    server = build_server()
    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options(),
        )


def run() -> None:
    """Blocking entry: initialise logging, start asyncio loop on stdio."""
    import asyncio

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )
    asyncio.run(_run_async())


if __name__ == "__main__":
    run()
