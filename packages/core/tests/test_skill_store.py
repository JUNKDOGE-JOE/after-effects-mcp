"""Unit tests for skill_store rendering (no live AE).

render_skill drives ae.skillUse; it must substitute declared ${name}
placeholders while leaving idiomatic ExtendScript `$` sequences ($.writeln,
$.global, ...) untouched. Before #12 it used Template.substitute, which throws
"Invalid placeholder in string" on a bare `$.` — so a skill could save via
skillCreate yet fail on every skillUse.
"""
from __future__ import annotations

import pytest

from ae_mcp.skill_store import Skill, render_skill


def _skill(template: str, args_schema=None, template_type: str = "jsx") -> Skill:
    return Skill(
        name="probe",
        description="",
        template_type=template_type,
        template=template,
        args_schema=args_schema or {},
    )


def test_render_passes_through_extendscript_dollar_and_substitutes_arg():
    skill = _skill(
        '$.writeln("x"); var c = app.project.itemByID(${comp_id});',
        args_schema={"comp_id": {"type": "number"}},
    )
    out = render_skill(skill, {"comp_id": 42})
    # ExtendScript `$.writeln` survives verbatim.
    assert '$.writeln("x")' in out
    # Declared placeholder is still substituted (jsx => JSON literal).
    assert "itemByID(42)" in out


def test_render_handles_multiple_bare_dollar_idioms():
    skill = _skill('$.global; $.engineName; var n = ${name};',
                   args_schema={"name": {"type": "string"}})
    out = render_skill(skill, {"name": "hero"})
    assert "$.global" in out
    assert "$.engineName" in out
    assert '"hero"' in out


def test_render_prompt_type_substitutes_plainly():
    skill = _skill("Use $.writeln then set ${val}",
                   args_schema={"val": {"type": "string"}},
                   template_type="prompt")
    out = render_skill(skill, {"val": "go"})
    assert "$.writeln" in out
    # prompt type substitutes the raw string, not a JSON literal.
    assert "set go" in out


def test_render_missing_arg_still_raises():
    skill = _skill("$.writeln(${needed});",
                   args_schema={"needed": {"type": "string"}})
    with pytest.raises(Exception) as exc:
        render_skill(skill, {})
    assert "missing skill args" in str(exc.value)
