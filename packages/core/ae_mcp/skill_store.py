"""Local JSON storage for ae.skill* verbs."""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from string import Template
from typing import Any


_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_PLACEHOLDER_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


class SkillError(ValueError):
    """Raised for user-facing skill storage/rendering failures."""


def _skill_root() -> Path:
    configured = os.environ.get("AE_MCP_SKILL_DIR")
    if configured:
        return Path(configured)
    return Path.home() / ".ae-mcp" / "skills"


def validate_name(name: str) -> str:
    if not _NAME_RE.fullmatch(name):
        raise SkillError("invalid skill name")
    return name


@dataclass(frozen=True)
class Skill:
    name: str
    description: str
    template_type: str
    template: str
    args_schema: dict[str, dict[str, Any]]

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Skill":
        return cls(
            name=validate_name(str(data["name"])),
            description=str(data.get("description") or ""),
            template_type=str(data.get("template_type") or "jsx"),
            template=str(data["template"]),
            args_schema=dict(data.get("args_schema") or {}),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "template_type": self.template_type,
            "template": self.template,
            "args_schema": self.args_schema,
        }


class SkillStore:
    def __init__(self, root: Path | None = None) -> None:
        self.root = root or _skill_root()

    def _path(self, name: str) -> Path:
        return self.root / f"{validate_name(name)}.json"

    def list(self) -> list[Skill]:
        if not self.root.exists():
            return []
        skills: list[Skill] = []
        for path in sorted(self.root.glob("*.json")):
            try:
                skills.append(Skill.from_dict(json.loads(path.read_text(encoding="utf-8"))))
            except Exception:
                continue
        return skills

    def load(self, name: str) -> Skill:
        path = self._path(name)
        if not path.exists():
            raise SkillError(f"skill not found: {name}")
        return Skill.from_dict(json.loads(path.read_text(encoding="utf-8")))

    def create(self, skill: Skill, *, overwrite: bool = False) -> Skill:
        path = self._path(skill.name)
        if path.exists() and not overwrite:
            raise SkillError(f"skill exists: {skill.name}")
        self.root.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(skill.to_dict(), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        return skill

    def edit(self, name: str, updates: dict[str, Any]) -> Skill:
        current = self.load(name).to_dict()
        for key, value in updates.items():
            if value is not None:
                current[key] = value
        skill = Skill.from_dict(current)
        return self.create(skill, overwrite=True)

    def delete(self, name: str) -> None:
        path = self._path(name)
        if not path.exists():
            raise SkillError(f"skill not found: {name}")
        path.unlink()


def _value_for_template(skill: Skill, value: Any) -> str:
    if skill.template_type == "jsx":
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def render_skill(skill: Skill, provided_args: dict[str, Any]) -> str:
    values: dict[str, Any] = {}
    for arg_name, meta in skill.args_schema.items():
        if arg_name in provided_args:
            values[arg_name] = provided_args[arg_name]
        elif isinstance(meta, dict) and "default" in meta:
            values[arg_name] = meta["default"]

    for arg_name, value in provided_args.items():
        values[arg_name] = value

    placeholders = set(_PLACEHOLDER_RE.findall(skill.template))
    missing = sorted(name for name in placeholders if name not in values)
    if missing:
        raise SkillError("missing skill args: " + ", ".join(missing))

    rendered_values = {
        name: _value_for_template(skill, values[name])
        for name in placeholders
    }
    return Template(skill.template).substitute(rendered_values)
