"""Local JSON storage for ae.skill* verbs."""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from string import Template
from typing import Any, Literal


_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_PLACEHOLDER_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


class SkillError(ValueError):
    """Raised for user-facing skill storage/rendering failures."""


def _skill_root() -> Path:
    configured = os.environ.get("AE_MCP_SKILL_DIR")
    if configured:
        return Path(configured)
    return Path.home() / ".ae-mcp" / "skills"


def _bundled_root() -> Path:
    return Path(__file__).resolve().parent / "skills_bundled"


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


@dataclass(frozen=True)
class SkillRecord:
    skill: Skill
    source: Literal["user", "bundled"]
    path: Path


def _artifact_kind(skill: Skill) -> Literal["jsx", "prompt-skill"]:
    if skill.template_type == "jsx":
        return "jsx"
    if skill.template_type == "prompt":
        return "prompt-skill"
    raise SkillError("unsupported skill template type")


def skill_content_hash(skill: Skill) -> str:
    from ae_mcp.tool_artifact import compute_content_hash

    return compute_content_hash(
        _artifact_kind(skill), skill.template, skill.args_schema
    )


class SkillStore:
    def __init__(self, root: Path | None = None, bundled_root: Path | None = None) -> None:
        self.root = root or _skill_root()
        self.bundled_root = bundled_root if bundled_root is not None else _bundled_root()

    def _path(self, name: str) -> Path:
        return self.root / f"{validate_name(name)}.json"

    def _read_dir(self, root: Path, *, bundled: bool = False) -> dict[str, Skill]:
        out: dict[str, Skill] = {}
        if not root.exists():
            return out
        for path in sorted(root.glob("*.json")):
            if bundled and path.name == "manifest.json":
                continue
            try:
                skill = Skill.from_dict(json.loads(path.read_text(encoding="utf-8")))
            except Exception:
                continue
            out[skill.name] = skill
        return out

    def _record(self, path: Path, source: Literal["user", "bundled"]) -> SkillRecord:
        canonical = path.expanduser().resolve(strict=True)
        skill = Skill.from_dict(json.loads(canonical.read_text(encoding="utf-8")))
        return SkillRecord(skill=skill, source=source, path=canonical)

    def _read_records(
        self, root: Path, source: Literal["user", "bundled"]
    ) -> list[SkillRecord]:
        if not root.exists():
            return []
        records: list[SkillRecord] = []
        for path in sorted(root.glob("*.json")):
            if source == "bundled" and path.name == "manifest.json":
                continue
            try:
                records.append(self._record(path, source))
            except Exception:
                continue
        return records

    def list(self) -> list[Skill]:
        merged = self._read_dir(self.bundled_root, bundled=True)
        merged.update(self._read_dir(self.root))  # user overrides bundled by name
        return [merged[name] for name in sorted(merged)]

    def list_records(self, *, include_shadowed: bool = False) -> list[SkillRecord]:
        bundled = self._read_records(self.bundled_root, "bundled")
        user = self._read_records(self.root, "user")
        if include_shadowed:
            bundled.sort(key=lambda record: (record.skill.name, str(record.path)))
            user.sort(key=lambda record: (record.skill.name, str(record.path)))
            return bundled + user
        merged = {record.skill.name: record for record in bundled}
        merged.update({record.skill.name: record for record in user})
        return [merged[name] for name in sorted(merged)]

    def resolve(self, name: str) -> SkillRecord:
        validated = validate_name(name)
        user = self._path(validated)
        if user.exists():
            return self._record(user, "user")
        bundled = self.bundled_root / f"{validated}.json"
        if validated != "manifest" and bundled.exists():
            return self._record(bundled, "bundled")
        raise SkillError(f"skill not found: {name}")

    def load(self, name: str) -> Skill:
        return self.resolve(name).skill

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

    def write_record(
        self,
        record: SkillRecord,
        skill: Skill,
        *,
        expected_content_hash: str,
    ) -> SkillRecord:
        from ae_mcp.tool_store import ToolRevisionConflict, atomic_write_json

        if not isinstance(record, SkillRecord) or record.source != "user":
            raise SkillError("cannot edit bundled skill")
        root = self.root.expanduser().resolve(strict=False)
        try:
            path = record.path.expanduser().resolve(strict=True)
        except FileNotFoundError as exc:
            raise SkillError(f"skill not found: {record.skill.name}") from exc
        if path.parent != root or path != record.path:
            raise SkillError("skill record path is outside the user skill root")
        current = self._record(path, "user")
        if current.skill.name != record.skill.name or skill.name != current.skill.name:
            raise SkillError("legacy skill rename is unsupported")
        if skill_content_hash(current.skill) != expected_content_hash:
            raise ToolRevisionConflict()
        skill_content_hash(skill)
        atomic_write_json(path, skill.to_dict())
        return SkillRecord(skill=skill, source="user", path=path)

    def delete(self, name: str) -> None:
        path = self._path(name)
        if not path.exists():
            validated = validate_name(name)
            bundled = self.bundled_root / f"{validated}.json"
            if validated != "manifest" and bundled.exists():
                raise SkillError(f"cannot delete bundled skill: {name}")
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
    # safe_substitute (not substitute) so idiomatic ExtendScript `$` sequences
    # like `$.writeln` / `$.global` pass through untouched instead of raising
    # "Invalid placeholder in string". Declared ${name} placeholders are still
    # substituted; only unknown bare-$ runs are left verbatim.
    return Template(skill.template).safe_substitute(rendered_values)
