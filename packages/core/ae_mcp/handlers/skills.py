"""Handlers for ae.skill* verbs."""
from __future__ import annotations

import json
from typing import Any

from ae_mcp import progress, schemas
from ae_mcp.backends import discovery as _discovery
from ae_mcp.handlers import register
from ae_mcp.jsx_result import parse_jsx_result as _try_json
from ae_mcp.skill_store import Skill, SkillError, SkillStore, render_skill


def _backend():
    return _discovery.select_backend()


def _store() -> SkillStore:
    return SkillStore()


def _skill_meta(skill: Skill, include_templates: bool = False) -> dict[str, Any]:
    meta: dict[str, Any] = {
        "name": skill.name,
        "description": skill.description,
        "template_type": skill.template_type,
        "args": list(skill.args_schema.keys()),
    }
    if include_templates:
        meta["template"] = skill.template
        meta["args_schema"] = skill.args_schema
    return meta


def _error(exc: Exception) -> dict[str, Any]:
    return {"ok": False, "error": str(exc)}


async def _run_skill_list(args: schemas.AeSkillListArgs, ctx: Any) -> Any:
    try:
        return {
            "ok": True,
            "skills": [
                _skill_meta(skill, include_templates=args.include_templates)
                for skill in _store().list()
            ],
        }
    except Exception as e:  # noqa: BLE001
        return _error(e)


async def _run_skill_create(args: schemas.AeSkillCreateArgs, ctx: Any) -> Any:
    try:
        skill = Skill(
            name=str(args.name),
            description=args.description,
            template_type=args.template_type,
            template=args.template,
            args_schema=args.args_schema,
        )
        saved = _store().create(skill, overwrite=args.overwrite)
        return {"ok": True, "skill": _skill_meta(saved, include_templates=True)}
    except Exception as e:  # noqa: BLE001
        return _error(e)


async def _run_skill_edit(args: schemas.AeSkillEditArgs, ctx: Any) -> Any:
    try:
        updates = {
            "description": args.description,
            "template_type": args.template_type,
            "template": args.template,
            "args_schema": args.args_schema,
        }
        saved = _store().edit(str(args.name), updates)
        return {"ok": True, "skill": _skill_meta(saved, include_templates=True)}
    except Exception as e:  # noqa: BLE001
        return _error(e)


async def _run_skill_delete(args: schemas.AeSkillDeleteArgs, ctx: Any) -> Any:
    try:
        _store().delete(str(args.name))
        return {"ok": True, "deleted": str(args.name)}
    except Exception as e:  # noqa: BLE001
        return _error(e)


async def _run_skill_use(args: schemas.AeSkillUseArgs, ctx: Any) -> Any:
    try:
        skill = _store().load(str(args.name))
        rendered = render_skill(skill, args.args)
        if not args.execute:
            return {
                "ok": True,
                "name": skill.name,
                "template_type": skill.template_type,
                "rendered": rendered,
            }
        if skill.template_type != "jsx":
            return {"ok": False, "error": "only jsx skills can be executed"}

        async def _call() -> Any:
            out = await _backend().exec(code=rendered, timeout_sec=60.0)
            return _try_json(out)

        return await progress.run_with_timeout(
            ctx, _call(), timeout_sec=75.0, start_msg=f"ae.skillUse {skill.name}..."
        )
    except Exception as e:  # noqa: BLE001
        return _error(e)


register("ae.skillList", schemas.AeSkillListArgs, _run_skill_list)
register("ae.skillCreate", schemas.AeSkillCreateArgs, _run_skill_create)
register("ae.skillEdit", schemas.AeSkillEditArgs, _run_skill_edit)
register("ae.skillDelete", schemas.AeSkillDeleteArgs, _run_skill_delete)
register("ae.skillUse", schemas.AeSkillUseArgs, _run_skill_use)
