"""Unit tests for skill_store rendering (no live AE).

render_skill drives ae.skillUse; it must substitute declared ${name}
placeholders while leaving idiomatic ExtendScript `$` sequences ($.writeln,
$.global, ...) untouched. Before #12 it used Template.substitute, which throws
"Invalid placeholder in string" on a bare `$.` — so a skill could save via
skillCreate yet fail on every skillUse.
"""
from __future__ import annotations

import hashlib
import json
import re

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
    data = json.loads(
        (_bundled_root() / "extendscript-cookbook.json").read_text(encoding="utf-8")
    )
    skill = Skill.from_dict(data)
    assert skill.template_type == "prompt"
    assert render_skill(skill, {}) == skill.template  # no-arg prompt renders verbatim


# --- All shipped bundled skills (batch 1 cookbook + batch 2 creative skills) ---

_EXPECTED_BUNDLED = {
    "ae-execution-guide",
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
    return sorted(
        p.stem for p in _bundled_root().glob("*.json") if p.name != "manifest.json"
    )


def test_all_expected_bundled_skills_present():
    assert _EXPECTED_BUNDLED.issubset(set(_real_bundled_names()))


@pytest.mark.parametrize("name", _real_bundled_names())
def test_each_bundled_skill_parses_renders_and_is_self_contained(name):
    """Every shipped bundled skill must parse, be a prompt, carry a recall
    description, and need no args (knowledge skills render verbatim)."""
    from ae_mcp.skill_store import _bundled_root, Skill, render_skill
    data = json.loads(
        (_bundled_root() / f"{name}.json").read_text(encoding="utf-8")
    )
    skill = Skill.from_dict(data)
    assert skill.name == name
    assert skill.template_type == "prompt"
    assert skill.description.strip()
    assert render_skill(skill, {}) == skill.template


def test_default_execution_guide_is_generated_complete_and_examples_validate():
    from ae_mcp import schemas as S
    from ae_mcp.native_exec_generated import PRIMITIVES
    from ae_mcp.skill_store import _bundled_root

    path = _bundled_root() / "ae-execution-guide.json"
    skill = Skill.from_dict(json.loads(path.read_text(encoding="utf-8")))
    assert skill.name == "ae-execution-guide"
    assert skill.template_type == "prompt"
    template = skill.template
    for heading in (
        "## Route choice",
        "## Program composition",
        "## JSX persistence",
        "## Readback",
        "## Undo",
        "## Uncertain native write",
        "## Visual verification",
        "## ExtendScript essentials",
        "## Native primitive reference",
    ):
        assert heading in template
    assert "Never invent locators" in template
    assert "project.items.list" in template
    assert "copy its returned locator verbatim" in template
    assert "canonical-identical replay" in template
    assert all(
        token in template
        for token in ("operationKey", "undoGroup", "operations", "program digest")
    )
    for lifecycle_rule in (
        "`ae_exec` is ephemeral",
        "user-requested save",
        '`action="save"`',
        '`status="saved"`',
        '`status="candidate"`',
        '`intent="model-curated"`',
        "model-judged reuse",
        "separate `ae_toolUse` call",
        "excluded from default discovery",
        "cannot be rendered or executed",
        "`expected_revision`",
        "`expected_content_hash`",
        "no automatic expiration or cleanup",
    ):
        assert lifecycle_rule in template

    stable, generated = template.split("<!-- GENERATED NATIVE REFERENCE -->", 1)
    assert len(re.findall(r"\b[\w'-]+\b", stable)) < 500
    for primitive in PRIMITIVES:
        assert generated.count(primitive["id"]) == 1

    exec_examples = re.findall(
        r"<!-- AE_EXEC_EXAMPLE -->\s*```json\s*(.*?)\s*```",
        template,
        flags=re.DOTALL,
    )
    native_examples = re.findall(
        r"<!-- AE_NATIVE_EXEC_EXAMPLE -->\s*```json\s*(.*?)\s*```",
        template,
        flags=re.DOTALL,
    )
    assert exec_examples and native_examples
    for example in exec_examples:
        S.AeExecArgs.model_validate(json.loads(example))
    for example in native_examples:
        S.AeNativeExecArgs.model_validate(json.loads(example))


def test_default_execution_guide_does_not_name_removed_public_tools():
    from ae_mcp.skill_store import _bundled_root
    from scripts.generate_native_exec import load_migration_manifest
    from pathlib import Path

    root = Path(__file__).resolve().parents[3]
    template = json.loads(
        (_bundled_root() / "ae-execution-guide.json").read_text(encoding="utf-8")
    )["template"]
    migration = load_migration_manifest(
        root / "native/ae-plugin/protocol/native-exec-migration.json"
    )
    removed = {
        tool_id.replace(".", "_")
        for tool_id, row in migration.public_tools.items()
        if row.disposition.startswith("REMOVE_TO_")
    }
    assert sorted(name for name in removed if name in template) == []


def test_bundled_manifest_sha_matches_default_execution_guide():
    from ae_mcp.skill_store import _bundled_root

    root = _bundled_root()
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    hashes = {row["path"]: row["sha256"] for row in manifest["artifacts"]}
    guide = root / "ae-execution-guide.json"
    assert hashes[guide.name] == hashlib.sha256(guide.read_bytes()).hexdigest()


def test_bundled_skills_surface_with_empty_user_dir(monkeypatch, tmp_path):
    """With an empty user skill dir, the real bundled skills still list."""
    monkeypatch.setenv("AE_MCP_SKILL_DIR", str(tmp_path / "empty-user"))
    from ae_mcp.skill_store import SkillStore
    names = {s.name for s in SkillStore().list()}
    assert _EXPECTED_BUNDLED.issubset(names)


def test_bundled_manifest_is_not_a_loadable_skill(tmp_path):
    from ae_mcp.skill_store import SkillError, SkillStore

    store = SkillStore(root=tmp_path / "user")
    with pytest.raises(SkillError, match="skill not found: manifest"):
        store.load("manifest")
    with pytest.raises(SkillError, match="skill not found: manifest"):
        store.delete("manifest")


def test_list_records_preserves_old_resolution_and_can_show_shadowed(tmp_path):
    bundled = _bundled(tmp_path)
    user = tmp_path / "user"
    store = SkillStore(root=user, bundled_root=bundled)
    store.create(
        Skill(
            name="extendscript-cookbook",
            description="user",
            template_type="prompt",
            template="USER",
            args_schema={},
        )
    )

    assert store.load("extendscript-cookbook").template == "USER"
    assert store.resolve("extendscript-cookbook").source == "user"
    visible = store.list_records()
    all_records = store.list_records(include_shadowed=True)
    assert [record.skill for record in visible] == store.list()
    assert len(
        [record for record in visible if record.skill.name == "extendscript-cookbook"]
    ) == 1
    assert {
        record.source
        for record in all_records
        if record.skill.name == "extendscript-cookbook"
    } == {"user", "bundled"}
