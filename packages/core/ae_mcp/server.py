"""MCP server entry (stdio transport).

Uses the low-level mcp.server.Server API so we can:
  - expose each verb's pydantic JSON schema as the tool's inputSchema,
  - fan-out to the HANDLERS registry by name,
  - surface structured {ok, error, ...} payloads uniformly.

Handlers receive (validated_model, ctx). `ctx` is the mcp.server.Context
object surfaced via the request_context; it owns report_progress.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any, List

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import CallToolResult, TextContent, Tool

from ae_mcp import approval_gate, client_identity
from ae_mcp.annotations import VERB_ANNOTATIONS
from ae_mcp.error_hints import append_hint
from ae_mcp.handlers import HANDLERS, load_all
from ae_mcp.instructions import SERVER_INSTRUCTIONS

log = logging.getLogger("ae_mcp.server")

# Matches a leading dotted verb token at the very start of a docstring, e.g.
# "ae.init — bootstrap …". Only the leading token is rewritten so the rest of
# the description (which may legitimately mention dotted names) is untouched.
_LEADING_VERB = re.compile(r"^(ae\.[A-Za-z][A-Za-z0-9]*)")


def _filtered_tool_names() -> set:
    """Return verb names this server should expose.

    Always includes ae.status so clients have a diagnostic entry point even
    when backend selection fails. Other verbs depend on backend capabilities
    and whether a snapshotter is available.
    """
    from ae_mcp.backends import discovery as _discovery
    from ae_mcp.snapshot import discovery as _snap_discovery
    try:
        backend = _discovery.select_backend()
        supported = backend.supported_verbs()
    except Exception as e:  # noqa: BLE001
        log.warning(
            "backend selection failed; exposing only ae.status "
            "(tool name ae_status) for diagnostics: %s",
            e,
        )
        return {"ae.status"}
    try:
        snapshotter = _snap_discovery.select_snapshotter()
    except Exception as e:  # noqa: BLE001
        log.warning("snapshotter selection failed; hiding ae.snapshot: %s", e)
        snapshotter = None
    if snapshotter is None:
        supported = supported - {"ae.snapshot"}
    return supported | {"ae.status"}


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


def build_reverse_map(handlers) -> "dict[str, str]":
    """Build an ``exposed name -> canonical verb`` map for O(1) resolution.

    ``resolve_tool_name`` otherwise falls back to a linear scan for the common
    (underscore-name) call path. Precomputing this map once — after
    ``load_all()`` has populated HANDLERS — keeps the hot path O(1) while
    preserving identical fallback semantics.
    """
    return {expose_tool_name(verb): verb for verb in handlers}


def tool_description(schema_cls, verb: str) -> str:
    """Build a Tool description that LEADS with the exposed underscore name.

    The description is sourced from the pydantic schema docstring, which opens
    with the dotted verb ("ae.init — …"). Strict clients can only call the
    advertised (underscore) name, so we rewrite *only* the leading dotted-verb
    token to its exposed form; the remainder of the docstring is untouched.
    """
    doc = (schema_cls.__doc__ or "").strip()
    exposed = expose_tool_name(verb)
    if not doc:
        return f"ae-mcp verb {exposed}"
    m = _LEADING_VERB.match(doc)
    if m and m.group(1) == verb:
        return exposed + doc[m.end():]
    # Docstring doesn't open with this verb token (defensive): prepend the
    # exposed name so the description still leads with the callable name.
    return f"{exposed} — {doc}"


def resolve_tool_name(name: str, handlers, reverse_map=None) -> "str | None":
    """Map an exposed tool name back to its canonical verb.

    Accepts both the exposed dot-free name ("ae_ping") and, for backward
    compatibility, the original dotted verb ("ae.ping"). Returns ``None`` if
    the name matches no registered verb.

    ``reverse_map`` (from :func:`build_reverse_map`) makes the underscore-name
    path O(1); when omitted, a linear scan is used so direct/programmatic
    callers still resolve correctly.
    """
    # Dotted-name fast path (back-compat for direct callers).
    if name in handlers:
        return name
    if reverse_map is not None:
        return reverse_map.get(name)
    for verb in handlers:
        if expose_tool_name(verb) == name:
            return verb
    return None


def build_server() -> Server:
    """Construct the low-level MCP Server with all registered verbs."""
    load_all()

    # Reverse map (exposed name -> canonical verb) for O(1) resolution on the
    # common underscore-name call path. Built once, after load_all() has
    # populated HANDLERS.
    reverse_map = build_reverse_map(HANDLERS)

    # Collision guard: expose_tool_name() is lossy (dots -> underscores), so a
    # future verb could collapse onto another's exposed name and make
    # _list_tools emit duplicate Tool names. Fail loudly if that ever happens.
    if len(reverse_map) != len(HANDLERS):
        seen: dict[str, str] = {}
        collisions: list[str] = []
        for verb in HANDLERS:
            exposed = expose_tool_name(verb)
            if exposed in seen:
                collisions.append(f"{seen[exposed]!r} and {verb!r} -> {exposed!r}")
            else:
                seen[exposed] = verb
        raise RuntimeError(
            "exposed tool-name collision(s): " + "; ".join(collisions)
        )

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
            # Description leads with the EXPOSED (underscore) name so strict
            # clients see the name they can actually call.
            tools.append(
                Tool(
                    name=expose_tool_name(verb_name),
                    description=tool_description(schema_cls, verb_name),
                    inputSchema=input_schema,
                    annotations=VERB_ANNOTATIONS.get(verb_name),
                )
            )
        return tools

    @server.call_tool()
    async def _call_tool(name: str, arguments: dict | None) -> CallToolResult:
        try:
            params = server.request_context.session.client_params  # type: ignore[union-attr]
            ci = getattr(params, "clientInfo", None) or getattr(params, "client_info", None)
            client_identity.set_client(ci.name, ci.version)
        except Exception:  # noqa: BLE001
            client_identity.set_client(None, None)

        # Return CallToolResult explicitly so MCP clients can branch on the
        # protocol-level isError flag. The JSON payload still carries ok:false
        # for human/model-readable details and remains byte-for-byte stable.
        # Tools are exposed with dots replaced by underscores; map the exposed
        # name back to the canonical verb (the dotted name is accepted too).
        canonical = resolve_tool_name(name, HANDLERS, reverse_map)
        if canonical is None:
            payload = _format_result({"ok": False, "error": f"unknown tool: {name}"})
            return CallToolResult(
                content=[TextContent(type="text", text=payload)],
                isError=True,
            )
        name = canonical

        schema_cls, run_fn = HANDLERS[name]

        try:
            validated = schema_cls(**(arguments or {}))
        except Exception as e:  # noqa: BLE001
            payload = _format_result({"ok": False, "error": f"schema: {e}"})
            return CallToolResult(
                content=[TextContent(type="text", text=payload)],
                isError=True,
            )

        # Pull ctx from request context so handlers can emit progress.
        ctx = None
        try:
            ctx = server.request_context  # type: ignore[attr-defined]
        except LookupError:
            ctx = None

        gated = await approval_gate.enforce(canonical, ctx)
        if gated is not None:
            payload = _format_result(gated)
            return CallToolResult(
                content=[TextContent(type="text", text=payload)],
                isError=True,
            )

        try:
            result = await run_fn(validated, ctx)
        except Exception as e:  # noqa: BLE001
            log.exception("handler %s raised", name)
            payload = _format_result({"ok": False, "error": append_hint(str(e))})
            return CallToolResult(
                content=[TextContent(type="text", text=payload)],
                isError=True,
            )

        if isinstance(result, dict) and result.get("ok") is False and "error" in result:
            result = {**result, "error": append_hint(str(result["error"]))}

        return CallToolResult(
            content=[TextContent(type="text", text=_format_result(result))],
            isError=isinstance(result, dict) and result.get("ok") is False,
        )

    # Expose the dispatch closures + reverse map for testing. The decorators
    # above already registered them via the MCP request_handlers registry;
    # these handles let tests drive dispatch directly without changing any
    # runtime behaviour.
    server._ae_list_tools = _list_tools  # type: ignore[attr-defined]
    server._ae_call_tool = _call_tool  # type: ignore[attr-defined]
    server._ae_reverse_map = reverse_map  # type: ignore[attr-defined]

    return server


async def _run_async() -> None:
    """Async entry: stdio transport loop."""
    server = build_server()
    asyncio.create_task(_startup_probe())
    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options(),
        )


async def _startup_probe(get_backend=None) -> None:
    """Best-effort startup backend health probe; never blocks server startup."""
    if get_backend is None:
        from ae_mcp.handlers.core import _backend as get_backend
    try:
        backend = get_backend()
        ok = await backend.health_check(timeout_sec=5.0)
        if not ok:
            log.info("startup backend health_check returned false")
    except Exception as e:  # noqa: BLE001
        log.debug("startup backend health_check failed: %s", e)


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
