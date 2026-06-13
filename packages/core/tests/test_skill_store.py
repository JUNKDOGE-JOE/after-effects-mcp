"""Unit tests for skill_store rendering (no live AE).

render_skill drives ae.skillUse; it must substitute declared ${name}
placeholders while leaving idiomatic ExtendScript `$` sequences ($.writeln,
$.global, ...) untouched. Before #12 it used Template.substitute, which throws
"Invalid placeholder in string" on a bare `$.` — so a skill could save via
skillCreate yet fail on every skillUse.
"""
from __future__ import annotations

import pytest

from ae_mcp.skill_store import Skill, SkillError, SkillStore, render_skill


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


# --- SkillStore: bundled-dir merge / fallback / delete-guard ---

def _bundled(tmp_path):
    b = tmp_path / "bundled"
    b.mkdir()
    (b / "extendscript-cookbook.json").write_text(
        '{"name":"extendscript-cookbook","description":"d",'
        '"template_type":"prompt","template":"BODY","args_schema":{}}',
        encoding="utf-8",
    )
    return b


def test_list_includes_bundled(tmp_path):
    store = SkillStore(root=tmp_path / "user", bundled_root=_bundled(tmp_path))
    names = [s.name for s in store.list()]
    assert "extendscript-cookbook" in names


def test_user_skill_overrides_bundled(tmp_path):
    user = tmp_path / "user"
    store = SkillStore(root=user, bundled_root=_bundled(tmp_path))
    store.create(
        Skill(name="extendscript-cookbook", description="u",
              template_type="prompt", template="USER", args_schema={}),
        overwrite=True,
    )
    loaded = store.load("extendscript-cookbook")
    assert loaded.template == "USER"


def test_user_skill_overrides_bundled_in_list(tmp_path):
    user = tmp_path / "user"
    store = SkillStore(root=user, bundled_root=_bundled(tmp_path))
    store.create(
        Skill(name="extendscript-cookbook", description="u",
              template_type="prompt", template="USER", args_schema={}),
        overwrite=True,
    )
    by_name = {s.name: s for s in store.list()}
    # user copy wins, and the name is not duplicated
    assert by_name["extendscript-cookbook"].template == "USER"
    assert [s.name for s in store.list()].count("extendscript-cookbook") == 1


def test_load_falls_back_to_bundled(tmp_path):
    store = SkillStore(root=tmp_path / "user", bundled_root=_bundled(tmp_path))
    assert store.load("extendscript-cookbook").template == "BODY"


def test_delete_bundled_raises(tmp_path):
    store = SkillStore(root=tmp_path / "user", bundled_root=_bundled(tmp_path))
    with pytest.raises(SkillError) as exc:
        store.delete("extendscript-cookbook")
    assert "cannot delete bundled skill" in str(exc.value)


def test_delete_unknown_still_raises_not_found(tmp_path):
    store = SkillStore(root=tmp_path / "user", bundled_root=_bundled(tmp_path))
    with pytest.raises(SkillError) as exc:
        store.delete("nope")
    assert "skill not found" in str(exc.value)


def test_create_writes_only_user_root(tmp_path):
    bundled = _bundled(tmp_path)
    user = tmp_path / "user"
    store = SkillStore(root=user, bundled_root=bundled)
    store.create(
        Skill(name="my-skill", description="x", template_type="jsx",
              template="T", args_schema={}),
    )
    # written under user root, never under the bundled (read-only) dir
    assert (user / "my-skill.json").exists()
    assert not (bundled / "my-skill.json").exists()


def test_real_bundled_cookbook_parses_and_renders():
    from ae_mcp.skill_store import _bundled_root, Skill, render_skill
    import json
    data = json.loads(
        (_bundled_root() / "extendscript-cookbook.json").read_text(encoding="utf-8")
    )
    skill = Skill.from_dict(data)
    assert skill.template_type == "prompt"
    assert render_skill(skill, {}) == skill.template  # no-arg prompt renders verbatim


# --- All shipped bundled skills (batch 1 cookbook + batch 2 creative skills) ---

_EXPECTED_BUNDLED = {
    "extendscript-cookbook",
    "kinetic-typography",
    "ease-and-timing",
    "grade-stack",
    "render-order",
    "project-organization",
    "glow-recipes",
}


def _real_bundled_names():
    from ae_mcp.skill_store import _bundled_root
    return sorted(p.stem for p in _bundled_root().glob("*.json"))


def test_all_expected_bundled_skills_present():
    assert _EXPECTED_BUNDLED.issubset(set(_real_bundled_names()))


@pytest.mark.parametrize("name", _real_bundled_names())
def test_each_bundled_skill_parses_renders_and_is_self_contained(name):
    """Every shipped bundled skill must parse, be a prompt, carry a recall
    description, and need no args (knowledge skills render verbatim)."""
    from ae_mcp.skill_store import _bundled_root, Skill, render_skill
    import json
    data = json.loads(
        (_bundled_root() / f"{name}.json").read_text(encoding="utf-8")
    )
    skill = Skill.from_dict(data)
    assert skill.name == name
    assert skill.template_type == "prompt"
    assert skill.description.strip()
    assert render_skill(skill, {}) == skill.template


def test_bundled_skills_surface_with_empty_user_dir(monkeypatch, tmp_path):
    """With an empty user skill dir, the real bundled skills still list."""
    monkeypatch.setenv("AE_MCP_SKILL_DIR", str(tmp_path / "empty-user"))
    from ae_mcp.skill_store import SkillStore
    names = {s.name for s in SkillStore().list()}
    assert _EXPECTED_BUNDLED.issubset(names)
