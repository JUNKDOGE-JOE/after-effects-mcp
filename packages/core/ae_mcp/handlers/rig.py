"""Handler for ae.createRig."""
from __future__ import annotations

import json
from pathlib import Path
from string import Template
from typing import Any

from ae_mcp import progress, schemas
from ae_mcp.backends import discovery as _discovery
from ae_mcp.handlers import register
from ae_mcp.jsx_prelude import with_prelude
from ae_mcp.jsx_result import parse_jsx_result as _try_json


_TEMPLATES = Path(__file__).resolve().parent.parent / "jsx_templates"


def _backend():
    return _discovery.select_backend()


def _load_jsx(name: str) -> Template:
    return Template((_TEMPLATES / name).read_text(encoding="utf-8"))


async def _run_create_rig(args: schemas.AeCreateRigArgs, ctx: Any) -> Any:
    from ae_mcp.handlers.typed import _comp_expr  # type: ignore

    # Typed `controls` (if given) flow into the existing options['controls']
    # path the JSX already understands, taking precedence over a raw value.
    options = dict(args.options)
    if args.controls is not None:
        options["controls"] = [c.model_dump() for c in args.controls]

    jsx = with_prelude(_load_jsx("create_rig.jsx").substitute(
        comp_expr=_comp_expr(args.comp_id),
        target_layer_id=json.dumps(args.target_layer_id),
        rig_type=json.dumps(args.rig_type),
        name=json.dumps(args.name, ensure_ascii=False),
        options=json.dumps(options, ensure_ascii=False),
    ))

    async def _call() -> Any:
        out = await _backend().exec(
            code=jsx,
            undo_group=f"MCP create rig: {args.name}",
            timeout_sec=60.0,
        )
        return _try_json(out)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=75.0, start_msg=f"ae.createRig {args.rig_type}..."
    )


register("ae.createRig", schemas.AeCreateRigArgs, _run_create_rig)
