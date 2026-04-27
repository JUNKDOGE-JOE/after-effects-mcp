"""Typed 6 handlers: createLayer / setProperty / moveLayer / selectLayers /
setTime / getTime.

Each handler:
  1. loads its .jsx template (once, cached),
  2. substitutes placeholders with JSON-safe literals,
  3. dispatches via bridge.invoke_ae_exec under progress.run_with_timeout.

JSX templates live in ae_mcp/jsx_templates/*.jsx and use Python
string.Template substitution (${name} placeholders). Chose Template over
.format because JSX is full of single braces; $$ only matters for literal
dollar signs, which are rare in JSX.
"""

from __future__ import annotations

import json
import logging
from functools import lru_cache
from pathlib import Path
from string import Template
from typing import Any, Optional

from ae_mcp import bridge, progress, schemas
from ae_mcp.handlers import register

log = logging.getLogger("ae_mcp.handlers.typed")

_TEMPLATES_DIR = Path(__file__).resolve().parent.parent / "jsx_templates"


@lru_cache(maxsize=16)
def _load_template(name: str) -> Template:
    """Load a JSX template and wrap in string.Template for ${var} substitution.

    We use string.Template (not str.format) because JSX is full of single
    curly braces that would confuse .format(). With Template only `$name` is
    special; literal dollars would need `$$` (rare in JSX)."""
    path = _TEMPLATES_DIR / name
    if not path.exists():
        raise FileNotFoundError(f"jsx template missing: {path}")
    return Template(path.read_text(encoding="utf-8"))


def _comp_expr(comp_id: Optional[str]) -> str:
    """Build a JSX expression that evaluates to a CompItem or null."""
    if comp_id:
        return (
            "(function(){ var it = app.project.itemByID("
            + str(int(comp_id))
            + "); return (it && it instanceof CompItem) ? it : null; })()"
        )
    return (
        "(function(){ var it = app.project.activeItem; "
        "return (it && it instanceof CompItem) ? it : null; })()"
    )


def _json_literal(value: Any) -> str:
    """Return a JSON string suitable for splicing into JSX as a literal."""
    return json.dumps(value, ensure_ascii=False)


# ---------------------------------------------------------------------------
# ae.createLayer
# ---------------------------------------------------------------------------


async def _run_create_layer(args: schemas.AeCreateLayerArgs, ctx: Any) -> Any:
    tmpl = _load_template("create_layer.jsx")
    color_js = _json_literal(list(args.color[:3]) if args.color else None)
    size_w = float(args.size[0]) if args.size else -1.0
    size_h = float(args.size[1]) if args.size else -1.0
    duration = float(args.duration) if args.duration is not None else -1.0
    position_js = _json_literal(list(args.position) if args.position else None)

    jsx = tmpl.substitute(
        comp_expr=_comp_expr(args.comp_id),
        type=args.type,           # retained for parity; unused in template body
        type_str=_json_literal(args.type),
        name=_json_literal(args.name),
        color=color_js,
        size_w=size_w,
        size_h=size_h,
        duration=duration,
        position=position_js,
    )

    async def _call() -> Any:
        out = await bridge.invoke_ae_exec(
            code=jsx,
            undo_group_name=f"MCP createLayer: {args.name}",
            timeout_sec=30.0,
        )
        return _try_json_or_raw(out)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=40.0, start_msg=f"ae.createLayer {args.type}..."
    )


register("ae.createLayer", schemas.AeCreateLayerArgs, _run_create_layer)


# ---------------------------------------------------------------------------
# ae.setProperty
# ---------------------------------------------------------------------------


async def _run_set_property(args: schemas.AeSetPropertyArgs, ctx: Any) -> Any:
    tmpl = _load_template("set_property.jsx")
    jsx = tmpl.substitute(
        comp_expr=_comp_expr(args.comp_id),
        layer_id=int(args.layer_id),
        path=_json_literal(args.path),
        value=_json_literal(args.value),
        at_time=float(args.at_time) if args.at_time is not None else -1.0,
    )

    async def _call() -> Any:
        out = await bridge.invoke_ae_exec(
            code=jsx,
            undo_group_name=f"MCP setProperty: {args.path}",
            timeout_sec=30.0,
        )
        return _try_json_or_raw(out)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=40.0, start_msg="ae.setProperty..."
    )


register("ae.setProperty", schemas.AeSetPropertyArgs, _run_set_property)


# ---------------------------------------------------------------------------
# ae.moveLayer
# ---------------------------------------------------------------------------


async def _run_move_layer(args: schemas.AeMoveLayerArgs, ctx: Any) -> Any:
    tmpl = _load_template("move_layer.jsx")
    jsx = tmpl.substitute(
        comp_expr=_comp_expr(args.comp_id),
        layer_id=int(args.layer_id),
        to_index=int(args.to_index),
    )

    async def _call() -> Any:
        out = await bridge.invoke_ae_exec(
            code=jsx, undo_group_name="MCP moveLayer", timeout_sec=30.0
        )
        return _try_json_or_raw(out)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=40.0, start_msg="ae.moveLayer..."
    )


register("ae.moveLayer", schemas.AeMoveLayerArgs, _run_move_layer)


# ---------------------------------------------------------------------------
# ae.selectLayers
# ---------------------------------------------------------------------------


async def _run_select_layers(args: schemas.AeSelectLayersArgs, ctx: Any) -> Any:
    tmpl = _load_template("select_layers.jsx")

    sel: Any = args.layer_ids
    if isinstance(sel, list):
        selector_js = _json_literal([int(i) for i in sel])
    else:
        selector_js = _json_literal(sel)  # "all" | "none"

    jsx = tmpl.substitute(
        comp_expr=_comp_expr(args.comp_id),
        selector_js=selector_js,
    )

    async def _call() -> Any:
        out = await bridge.invoke_ae_exec(
            code=jsx, undo_group_name="MCP selectLayers", timeout_sec=20.0
        )
        return _try_json_or_raw(out)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=30.0, start_msg="ae.selectLayers..."
    )


register("ae.selectLayers", schemas.AeSelectLayersArgs, _run_select_layers)


# ---------------------------------------------------------------------------
# ae.setTime
# ---------------------------------------------------------------------------


async def _run_set_time(args: schemas.AeSetTimeArgs, ctx: Any) -> Any:
    tmpl = _load_template("set_time.jsx")
    jsx = tmpl.substitute(
        comp_expr=_comp_expr(args.comp_id),
        time=float(args.time),
    )

    async def _call() -> Any:
        out = await bridge.invoke_ae_exec(
            code=jsx, undo_group_name="MCP setTime", timeout_sec=20.0
        )
        return _try_json_or_raw(out)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=30.0, start_msg="ae.setTime..."
    )


register("ae.setTime", schemas.AeSetTimeArgs, _run_set_time)


# ---------------------------------------------------------------------------
# ae.getTime
# ---------------------------------------------------------------------------


async def _run_get_time(args: schemas.AeGetTimeArgs, ctx: Any) -> Any:
    tmpl = _load_template("get_time.jsx")
    jsx = tmpl.substitute(comp_expr=_comp_expr(args.comp_id))

    async def _call() -> Any:
        out = await bridge.invoke_ae_exec(code=jsx, timeout_sec=20.0)
        return _try_json_or_raw(out)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=30.0, start_msg="ae.getTime..."
    )


register("ae.getTime", schemas.AeGetTimeArgs, _run_get_time)


# ---------------------------------------------------------------------------
# Helper: parse bridge output as JSON, else wrap as {ok,content}.
# ---------------------------------------------------------------------------


def _try_json_or_raw(text: str) -> Any:
    if not text:
        return {"ok": True, "content": ""}
    stripped = text.lstrip()
    if stripped[:1] in ("{", "["):
        try:
            return json.loads(stripped)
        except json.JSONDecodeError:
            pass
    return {"ok": True, "content": text}


# ---------------------------------------------------------------------------
# Exposed for tests: render the raw JSX without dispatching.
# ---------------------------------------------------------------------------


def render_create_layer(args: schemas.AeCreateLayerArgs) -> str:
    tmpl = _load_template("create_layer.jsx")
    color_js = _json_literal(list(args.color[:3]) if args.color else None)
    size_w = float(args.size[0]) if args.size else -1.0
    size_h = float(args.size[1]) if args.size else -1.0
    duration = float(args.duration) if args.duration is not None else -1.0
    position_js = _json_literal(list(args.position) if args.position else None)
    return tmpl.substitute(
        comp_expr=_comp_expr(args.comp_id),
        type=args.type,
        type_str=_json_literal(args.type),
        name=_json_literal(args.name),
        color=color_js,
        size_w=size_w,
        size_h=size_h,
        duration=duration,
        position=position_js,
    )


def render_set_property(args: schemas.AeSetPropertyArgs) -> str:
    tmpl = _load_template("set_property.jsx")
    return tmpl.substitute(
        comp_expr=_comp_expr(args.comp_id),
        layer_id=int(args.layer_id),
        path=_json_literal(args.path),
        value=_json_literal(args.value),
        at_time=float(args.at_time) if args.at_time is not None else -1.0,
    )


def render_move_layer(args: schemas.AeMoveLayerArgs) -> str:
    tmpl = _load_template("move_layer.jsx")
    return tmpl.substitute(
        comp_expr=_comp_expr(args.comp_id),
        layer_id=int(args.layer_id),
        to_index=int(args.to_index),
    )


def render_select_layers(args: schemas.AeSelectLayersArgs) -> str:
    tmpl = _load_template("select_layers.jsx")
    sel: Any = args.layer_ids
    if isinstance(sel, list):
        selector_js = _json_literal([int(i) for i in sel])
    else:
        selector_js = _json_literal(sel)
    return tmpl.substitute(
        comp_expr=_comp_expr(args.comp_id),
        selector_js=selector_js,
    )


def render_set_time(args: schemas.AeSetTimeArgs) -> str:
    tmpl = _load_template("set_time.jsx")
    return tmpl.substitute(comp_expr=_comp_expr(args.comp_id), time=float(args.time))


def render_get_time(args: schemas.AeGetTimeArgs) -> str:
    tmpl = _load_template("get_time.jsx")
    return tmpl.substitute(comp_expr=_comp_expr(args.comp_id))


# ---------------------------------------------------------------------------
# ae.getProperties
# ---------------------------------------------------------------------------


def render_get_properties(args: schemas.AeGetPropertiesArgs) -> str:
    tmpl = _load_template("get_properties.jsx")
    return tmpl.substitute(
        comp_expr=_comp_expr(args.comp_id),
        layer_ids_js=_json_literal([int(i) for i in args.layer_ids]),
        query_js=_json_literal(args.query),
        offset=int(args.offset),
        limit=int(args.limit),
    )


async def _run_get_properties(args: schemas.AeGetPropertiesArgs, ctx: Any) -> Any:
    jsx = render_get_properties(args)

    async def _call() -> Any:
        out = await bridge.invoke_ae_exec(code=jsx, timeout_sec=20.0)
        return _try_json_or_raw(out)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=30.0, start_msg="ae.getProperties..."
    )


register("ae.getProperties", schemas.AeGetPropertiesArgs, _run_get_properties)


# ---------------------------------------------------------------------------
# ae.scanPropertyTree
# ---------------------------------------------------------------------------


def render_scan_property_tree(args: schemas.AeScanPropertyTreeArgs) -> str:
    tmpl = _load_template("scan_property_tree.jsx")
    return tmpl.substitute(
        comp_expr=_comp_expr(args.comp_id),
        layer_id=int(args.layer_id),
        max_depth=int(args.max_depth),
        include_values="true" if args.include_values else "false",
    )


async def _run_scan_property_tree(args: schemas.AeScanPropertyTreeArgs, ctx: Any) -> Any:
    jsx = render_scan_property_tree(args)

    async def _call() -> Any:
        out = await bridge.invoke_ae_exec(code=jsx, timeout_sec=30.0)
        return _try_json_or_raw(out)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=40.0, start_msg="ae.scanPropertyTree..."
    )


register("ae.scanPropertyTree", schemas.AeScanPropertyTreeArgs, _run_scan_property_tree)


# ---------------------------------------------------------------------------
# ae.inspectPropertyCapabilities
# ---------------------------------------------------------------------------


def render_inspect_property_capabilities(args: schemas.AeInspectPropertyCapabilitiesArgs) -> str:
    tmpl = _load_template("inspect_property_capabilities.jsx")
    return tmpl.substitute(
        comp_expr=_comp_expr(args.comp_id),
        layer_id=int(args.layer_id),
        path=_json_literal(args.path),
    )


async def _run_inspect_property_capabilities(
    args: schemas.AeInspectPropertyCapabilitiesArgs, ctx: Any
) -> Any:
    jsx = render_inspect_property_capabilities(args)

    async def _call() -> Any:
        out = await bridge.invoke_ae_exec(code=jsx, timeout_sec=15.0)
        return _try_json_or_raw(out)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=20.0, start_msg="ae.inspectPropertyCapabilities..."
    )


register("ae.inspectPropertyCapabilities",
         schemas.AeInspectPropertyCapabilitiesArgs,
         _run_inspect_property_capabilities)


# ---------------------------------------------------------------------------
# ae.getExpressions
# ---------------------------------------------------------------------------


def render_get_expressions(args: schemas.AeGetExpressionsArgs) -> str:
    tmpl = _load_template("get_expressions.jsx")
    return tmpl.substitute(
        comp_expr=_comp_expr(args.comp_id),
        layer_ids_js=_json_literal(list(args.layer_ids)) if args.layer_ids else "null",
        prop_filter_js=_json_literal(args.prop) if args.prop else "null",
        max_results=int(args.max_results),
    )


async def _run_get_expressions(args: schemas.AeGetExpressionsArgs, ctx: Any) -> Any:
    jsx = render_get_expressions(args)

    async def _call() -> Any:
        out = await bridge.invoke_ae_exec(code=jsx, timeout_sec=30.0)
        return _try_json_or_raw(out)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=40.0, start_msg="ae.getExpressions..."
    )


register("ae.getExpressions", schemas.AeGetExpressionsArgs, _run_get_expressions)


# ---------------------------------------------------------------------------
# ae.getKeyframes
# ---------------------------------------------------------------------------


def render_get_keyframes(args: schemas.AeGetKeyframesArgs) -> str:
    tmpl = _load_template("get_keyframes.jsx")
    return tmpl.substitute(
        comp_expr=_comp_expr(args.comp_id),
        layer_id=int(args.layer_id),
        path=_json_literal(args.path),
    )


async def _run_get_keyframes(args: schemas.AeGetKeyframesArgs, ctx: Any) -> Any:
    jsx = render_get_keyframes(args)

    async def _call() -> Any:
        out = await bridge.invoke_ae_exec(code=jsx, timeout_sec=20.0)
        return _try_json_or_raw(out)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=30.0, start_msg="ae.getKeyframes..."
    )


register("ae.getKeyframes", schemas.AeGetKeyframesArgs, _run_get_keyframes)


# ---------------------------------------------------------------------------
# ae.searchProject
# ---------------------------------------------------------------------------


def render_search_project(args: schemas.AeSearchProjectArgs) -> str:
    tmpl = _load_template("search_project.jsx")
    return tmpl.substitute(
        query_js=_json_literal(args.query),
        scope_js=_json_literal(list(args.scope)),
        limit=int(args.limit),
    )


async def _run_search_project(args: schemas.AeSearchProjectArgs, ctx: Any) -> Any:
    jsx = render_search_project(args)

    async def _call() -> Any:
        out = await bridge.invoke_ae_exec(code=jsx, timeout_sec=30.0)
        return _try_json_or_raw(out)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=40.0, start_msg="ae.searchProject..."
    )


register("ae.searchProject", schemas.AeSearchProjectArgs, _run_search_project)
