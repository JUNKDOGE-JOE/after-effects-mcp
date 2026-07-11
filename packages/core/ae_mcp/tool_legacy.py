"""Virtual Tool Library artifacts backed by legacy and bundled skill files."""

from __future__ import annotations

import hashlib
import json
import re
import time
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

from ae_mcp.skill_store import (
    Skill,
    SkillRecord,
    SkillStore,
    skill_content_hash,
)
from ae_mcp.tool_artifact import (
    ArtifactKind,
    ArtifactRisk,
    ArtifactStatus,
    JsonValue,
    ToolArtifact,
    ToolArtifactDraft,
    ToolSource,
    ToolVerification,
    builtin_artifact_id,
    canonical_json_bytes,
    legacy_artifact_id,
)


_HEX_64 = re.compile(r"^[0-9a-f]{64}$")
_METADATA_KEYS = frozenset(
    {
        "category",
        "tags",
        "status",
        "verified",
        "verification",
        "compatibility",
        "declaredRisk",
        "lastUsedAt",
    }
)
_STATUSES = frozenset({"candidate", "saved", "pinned", "archived", "deprecated"})
_RISKS = frozenset({"read", "write", "destructive", "external"})
_EDIT_STATUS_TRANSITIONS = frozenset(
    {("candidate", "saved"), ("saved", "pinned"), ("pinned", "saved")}
)
_EDIT_KEYS = frozenset(
    {
        "description",
        "content",
        "args_schema",
        "kind",
        "category",
        "tags",
        "status",
        "compatibility",
        "declared_risk",
        "verification_action",
    }
)


class ToolLegacyError(ValueError):
    def __init__(self, message: str, *, code: str = "tool_legacy_error") -> None:
        super().__init__(message)
        self.code = code


class ToolReadOnly(ToolLegacyError):
    def __init__(self) -> None:
        super().__init__("Bundled tools are read-only.", code="tool_read_only")


@dataclass(frozen=True)
class LegacyMetadata:
    category: str
    tags: tuple[str, ...]
    status: ArtifactStatus
    verified: bool
    verification: ToolVerification | None
    compatibility: Mapping[str, JsonValue]
    declared_risk: ArtifactRisk
    last_used_at: int | None
    revision: int
    updated_at: int


@dataclass(frozen=True)
class _BundledManifest:
    product_version: str
    hashes: Mapping[str, str]


def _canonical_path(path: Path) -> Path:
    return Path(path).expanduser().resolve(strict=False)


def _source_path(path: Path) -> str:
    return unicodedata.normalize("NFC", str(_canonical_path(path)))


def _metadata_key(path: Path, content_hash: str) -> str:
    body: JsonValue = {
        "sourcePath": _source_path(path),
        "contentHash": content_hash,
    }
    return hashlib.sha256(canonical_json_bytes(body)).hexdigest()


def _json_mapping(value: Any, label: str) -> dict[str, JsonValue]:
    if not isinstance(value, Mapping):
        raise ToolLegacyError(f"{label} must be an object")
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
        decoded = json.loads(encoded)
    except (TypeError, ValueError, UnicodeError) as exc:
        raise ToolLegacyError(f"{label} must contain finite JSON values") from exc
    if not isinstance(decoded, dict):
        raise ToolLegacyError(f"{label} must be an object")
    return cast(dict[str, JsonValue], decoded)


def _nonnegative_integer(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ToolLegacyError(f"{label} must be a non-negative integer")
    return value


def _verification(value: Any) -> ToolVerification | None:
    if value is None:
        return None
    if not isinstance(value, Mapping) or set(value) != {
        "method",
        "verifiedAt",
        "evidenceHash",
    }:
        raise ToolLegacyError("legacy verification is invalid")
    evidence = value["evidenceHash"]
    if evidence is not None and (
        not isinstance(evidence, str) or not _HEX_64.fullmatch(evidence)
    ):
        raise ToolLegacyError("legacy verification evidence is invalid")
    try:
        return ToolVerification(
            method=cast(Any, value["method"]),
            verified_at=_nonnegative_integer(value["verifiedAt"], "verifiedAt"),
            evidence_hash=cast(str | None, evidence),
        )
    except ValueError as exc:
        raise ToolLegacyError("legacy verification is invalid") from exc


def _verification_wire(value: ToolVerification | None) -> JsonValue:
    if value is None:
        return None
    return {
        "method": value.method,
        "verifiedAt": value.verified_at,
        "evidenceHash": value.evidence_hash,
    }


def _normalize_metadata_patch(value: Mapping[str, Any]) -> dict[str, JsonValue]:
    unknown = sorted(set(value) - _METADATA_KEYS)
    if unknown:
        raise ToolLegacyError(
            "legacy metadata contains unknown keys: " + ", ".join(unknown)
        )
    output: dict[str, JsonValue] = {}
    if "category" in value:
        category = value["category"]
        if not isinstance(category, str) or not category or len(category) > 128:
            raise ToolLegacyError("legacy metadata category is invalid")
        output["category"] = unicodedata.normalize("NFC", category)
    if "tags" in value:
        tags = value["tags"]
        if not isinstance(tags, (list, tuple)) or len(tags) > 32:
            raise ToolLegacyError("legacy metadata tags are invalid")
        normalized_tags = []
        for tag in tags:
            if not isinstance(tag, str) or not tag or len(tag) > 64:
                raise ToolLegacyError("legacy metadata tag is invalid")
            normalized_tags.append(unicodedata.normalize("NFC", tag))
        if len(set(normalized_tags)) != len(normalized_tags):
            raise ToolLegacyError("legacy metadata tags must be unique")
        output["tags"] = normalized_tags
    if "status" in value:
        if value["status"] not in _STATUSES:
            raise ToolLegacyError("legacy metadata status is invalid")
        output["status"] = cast(str, value["status"])
    if "verified" in value:
        if type(value["verified"]) is not bool:
            raise ToolLegacyError("legacy metadata verified is invalid")
        output["verified"] = cast(bool, value["verified"])
    if "verification" in value:
        output["verification"] = _verification_wire(_verification(value["verification"]))
    if "compatibility" in value:
        output["compatibility"] = _json_mapping(
            value["compatibility"], "legacy compatibility"
        )
    if "declaredRisk" in value:
        if value["declaredRisk"] not in _RISKS:
            raise ToolLegacyError("legacy metadata risk is invalid")
        output["declaredRisk"] = cast(str, value["declaredRisk"])
    if "lastUsedAt" in value:
        last_used = value["lastUsedAt"]
        if last_used is not None:
            last_used = _nonnegative_integer(last_used, "lastUsedAt")
        output["lastUsedAt"] = cast(int | None, last_used)
    verified = output.get("verified")
    verification = output.get("verification")
    if verified is True and verification is None:
        raise ToolLegacyError("verified legacy metadata requires verification")
    if verified is False and verification is not None:
        raise ToolLegacyError("unverified legacy metadata cannot carry verification")
    return output


class LegacyMetadataStore:
    def __init__(self, path: Path, *, now: Any = None) -> None:
        self.path = Path(path)
        self._now = now or (lambda: int(time.time() * 1000))

    def _empty(self) -> dict[str, JsonValue]:
        return {"schemaVersion": 1, "revision": 0, "entries": {}}

    def _read(self) -> dict[str, JsonValue]:
        if not self.path.exists():
            return self._empty()
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception as exc:
            raise ToolLegacyError(
                "Legacy metadata is invalid.", code="tool_legacy_metadata_invalid"
            ) from exc
        if not isinstance(value, dict) or set(value) != {
            "schemaVersion",
            "revision",
            "entries",
        }:
            raise ToolLegacyError(
                "Legacy metadata is invalid.", code="tool_legacy_metadata_invalid"
            )
        if value["schemaVersion"] != 1:
            raise ToolLegacyError(
                "Legacy metadata is invalid.", code="tool_legacy_metadata_invalid"
            )
        _nonnegative_integer(value["revision"], "legacy metadata revision")
        if not isinstance(value["entries"], dict):
            raise ToolLegacyError(
                "Legacy metadata is invalid.", code="tool_legacy_metadata_invalid"
            )
        return cast(dict[str, JsonValue], value)

    def store_revision(self) -> int:
        return cast(int, self._read()["revision"])

    def _entry(self, path: Path, content_hash: str) -> Mapping[str, Any] | None:
        if not _HEX_64.fullmatch(content_hash):
            raise ToolLegacyError("legacy content hash is invalid")
        state = self._read()
        entries = cast(dict[str, Any], state["entries"])
        value = entries.get(_metadata_key(path, content_hash))
        if value is None:
            return None
        if not isinstance(value, Mapping):
            raise ToolLegacyError(
                "Legacy metadata is invalid.", code="tool_legacy_metadata_invalid"
            )
        if value.get("sourcePath") != _source_path(path) or value.get(
            "contentHash"
        ) != content_hash:
            raise ToolLegacyError(
                "Legacy metadata is invalid.", code="tool_legacy_metadata_invalid"
            )
        return value

    def get(
        self,
        path: Path,
        content_hash: str,
        *,
        default_risk: ArtifactRisk,
        default_updated_at: int,
    ) -> LegacyMetadata:
        entry = self._entry(path, content_hash)
        patch: Mapping[str, Any] = {}
        revision = 1
        updated_at = default_updated_at
        if entry is not None:
            if set(entry) != {
                "sourcePath",
                "contentHash",
                "revision",
                "updatedAt",
                "metadata",
            }:
                raise ToolLegacyError(
                    "Legacy metadata is invalid.", code="tool_legacy_metadata_invalid"
                )
            revision = _nonnegative_integer(entry["revision"], "legacy entry revision")
            if revision < 1:
                raise ToolLegacyError(
                    "Legacy metadata is invalid.", code="tool_legacy_metadata_invalid"
                )
            updated_at = _nonnegative_integer(entry["updatedAt"], "legacy updatedAt")
            if not isinstance(entry["metadata"], Mapping):
                raise ToolLegacyError(
                    "Legacy metadata is invalid.", code="tool_legacy_metadata_invalid"
                )
            patch = _normalize_metadata_patch(entry["metadata"])
        category = cast(str, patch.get("category", "workflow"))
        tags = tuple(cast(list[str], patch.get("tags", [])))
        status = cast(ArtifactStatus, patch.get("status", "saved"))
        verified = cast(bool, patch.get("verified", False))
        verification = _verification(patch.get("verification"))
        if verified and verification is None:
            raise ToolLegacyError(
                "Legacy metadata is invalid.", code="tool_legacy_metadata_invalid"
            )
        if not verified and verification is not None:
            raise ToolLegacyError(
                "Legacy metadata is invalid.", code="tool_legacy_metadata_invalid"
            )
        return LegacyMetadata(
            category=category,
            tags=tags,
            status=status,
            verified=verified,
            verification=verification,
            compatibility=cast(
                Mapping[str, JsonValue], patch.get("compatibility", {})
            ),
            declared_risk=cast(
                ArtifactRisk, patch.get("declaredRisk", default_risk)
            ),
            last_used_at=cast(int | None, patch.get("lastUsedAt")),
            revision=revision,
            updated_at=updated_at,
        )

    def compare_and_set(
        self,
        path: Path,
        content_hash: str,
        patch: Mapping[str, Any],
        *,
        expected_revision: int,
    ) -> int:
        from ae_mcp.tool_store import ToolStoreRevisionConflict, atomic_write_json

        if not _HEX_64.fullmatch(content_hash):
            raise ToolLegacyError("legacy content hash is invalid")
        state = self._read()
        current_revision = cast(int, state["revision"])
        if current_revision != expected_revision:
            raise ToolStoreRevisionConflict()
        entries = dict(cast(dict[str, Any], state["entries"]))
        key = _metadata_key(path, content_hash)
        current = entries.get(key)
        current_patch: dict[str, JsonValue] = {}
        entry_revision = 1
        if isinstance(current, Mapping):
            if not isinstance(current.get("metadata"), Mapping):
                raise ToolLegacyError(
                    "Legacy metadata is invalid.", code="tool_legacy_metadata_invalid"
                )
            current_patch = _normalize_metadata_patch(current["metadata"])
            entry_revision = _nonnegative_integer(
                current.get("revision"), "legacy entry revision"
            )
        merged = dict(current_patch)
        merged.update(_normalize_metadata_patch(patch))
        normalized = _normalize_metadata_patch(merged)
        next_revision = current_revision + 1
        entries[key] = {
            "sourcePath": _source_path(path),
            "contentHash": content_hash,
            "revision": entry_revision + 1,
            "updatedAt": _nonnegative_integer(self._now(), "legacy updatedAt"),
            "metadata": normalized,
        }
        atomic_write_json(
            self.path,
            {
                "schemaVersion": 1,
                "revision": next_revision,
                "entries": entries,
            },
        )
        return next_revision


def _normalized_file_digest(path: Path) -> str:
    # Git stores bundled fixtures with LF while Windows checkouts may use CRLF.
    data = path.read_bytes().replace(b"\r\n", b"\n")
    return hashlib.sha256(data).hexdigest()


def _load_bundled_manifest(root: Path) -> _BundledManifest:
    root = Path(root)
    skill_paths = sorted(path for path in root.glob("*.json") if path.name != "manifest.json")
    manifest_path = root / "manifest.json"
    if not skill_paths and not manifest_path.exists():
        return _BundledManifest(product_version="", hashes={})
    try:
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ToolLegacyError(
            "Bundled skill manifest is invalid.", code="tool_bundled_integrity"
        ) from exc
    if not isinstance(raw, dict) or set(raw) != {
        "schemaVersion",
        "productVersion",
        "artifacts",
    }:
        raise ToolLegacyError(
            "Bundled skill manifest is invalid.", code="tool_bundled_integrity"
        )
    if raw["schemaVersion"] != 1 or not isinstance(raw["productVersion"], str):
        raise ToolLegacyError(
            "Bundled skill manifest is invalid.", code="tool_bundled_integrity"
        )
    artifacts = raw["artifacts"]
    if not isinstance(artifacts, list):
        raise ToolLegacyError(
            "Bundled skill manifest is invalid.", code="tool_bundled_integrity"
        )
    hashes: dict[str, str] = {}
    for entry in artifacts:
        if not isinstance(entry, dict) or set(entry) != {"path", "sha256"}:
            raise ToolLegacyError(
                "Bundled skill manifest is invalid.", code="tool_bundled_integrity"
            )
        name = entry["path"]
        digest = entry["sha256"]
        if (
            not isinstance(name, str)
            or Path(name).name != name
            or not name.endswith(".json")
            or name == "manifest.json"
            or not isinstance(digest, str)
            or not _HEX_64.fullmatch(digest)
            or name in hashes
        ):
            raise ToolLegacyError(
                "Bundled skill manifest is invalid.", code="tool_bundled_integrity"
            )
        hashes[name] = digest
    if set(hashes) != {path.name for path in skill_paths}:
        raise ToolLegacyError(
            "Bundled skill manifest is invalid.", code="tool_bundled_integrity"
        )
    for path in skill_paths:
        if _normalized_file_digest(path) != hashes[path.name]:
            raise ToolLegacyError(
                "Bundled skill manifest is invalid.", code="tool_bundled_integrity"
            )
    return _BundledManifest(
        product_version=raw["productVersion"], hashes=hashes
    )


def _kind(skill: Skill) -> ArtifactKind:
    if skill.template_type == "jsx":
        return "jsx"
    if skill.template_type == "prompt":
        return "prompt-skill"
    raise ToolLegacyError(
        "Legacy skill template type is unsupported.", code="tool_legacy_invalid"
    )


def _default_risk(kind: ArtifactKind) -> ArtifactRisk:
    return "write" if kind == "jsx" else "read"


def _milliseconds(seconds: float) -> int:
    return max(0, int(seconds * 1000))


class LegacySkillAdapter:
    def __init__(
        self,
        *,
        skill_store: SkillStore | None = None,
        metadata_store: LegacyMetadataStore | None = None,
    ) -> None:
        self.skill_store = skill_store or SkillStore()
        self.metadata_store = metadata_store or LegacyMetadataStore(
            Path.home() / ".ae-mcp" / "tools" / "legacy-metadata.json"
        )

    def _records_and_manifest(
        self,
    ) -> tuple[list[SkillRecord], _BundledManifest]:
        records = self.skill_store.list_records(include_shadowed=True)
        bundled = [record for record in records if record.source == "bundled"]
        manifest = _load_bundled_manifest(self.skill_store.bundled_root)
        if {record.path.name for record in bundled} != set(manifest.hashes):
            raise ToolLegacyError(
                "Bundled skill manifest is invalid.", code="tool_bundled_integrity"
            )
        for record in bundled:
            if record.path.name != f"{record.skill.name}.json":
                raise ToolLegacyError(
                    "Bundled skill manifest is invalid.", code="tool_bundled_integrity"
                )
        return records, manifest

    def _artifact(
        self, record: SkillRecord, manifest: _BundledManifest
    ) -> ToolArtifact:
        kind = _kind(record.skill)
        content_hash = skill_content_hash(record.skill)
        info = record.path.stat()
        created_at = _milliseconds(info.st_ctime)
        file_updated_at = _milliseconds(info.st_mtime)
        if record.source == "bundled":
            digest = manifest.hashes.get(record.path.name)
            if digest is None:
                raise ToolLegacyError(
                    "Bundled skill manifest is invalid.", code="tool_bundled_integrity"
                )
            artifact_id = builtin_artifact_id(record.skill.name)
            source = ToolSource(
                type="bundled",
                ref=str(record.path),
                client=None,
                product_version=manifest.product_version,
                provenance={"manifestSha256": digest},
            )
            metadata = LegacyMetadata(
                category="workflow",
                tags=(),
                status="saved",
                verified=True,
                verification=ToolVerification(
                    method="signed-manifest", verified_at=0, evidence_hash=digest
                ),
                compatibility={},
                declared_risk=_default_risk(kind),
                last_used_at=None,
                revision=1,
                updated_at=file_updated_at,
            )
        else:
            artifact_id = legacy_artifact_id(record.path)
            source = ToolSource(
                type="legacy",
                ref=str(record.path),
                client=None,
                product_version=None,
                provenance={"contentHash": content_hash},
            )
            metadata = self.metadata_store.get(
                record.path,
                content_hash,
                default_risk=_default_risk(kind),
                default_updated_at=file_updated_at,
            )
        artifact = ToolArtifact(
            id=artifact_id,
            name=record.skill.name,
            description=record.skill.description,
            kind=kind,
            category=metadata.category,
            tags=metadata.tags,
            compatibility=metadata.compatibility,
            declared_risk=metadata.declared_risk,
            source=source,
            status=metadata.status,
            verified=metadata.verified,
            verification=metadata.verification,
            content=record.skill.template,
            args_schema=record.skill.args_schema,
            content_hash=content_hash,
            schema_version=1,
            revision=metadata.revision,
            created_at=created_at,
            updated_at=max(file_updated_at, metadata.updated_at),
            last_used_at=metadata.last_used_at,
        )
        try:
            return ToolArtifact.from_dict(artifact.to_dict())
        except (TypeError, ValueError) as exc:
            raise ToolLegacyError(
                "Legacy skill is invalid.", code="tool_legacy_invalid"
            ) from exc

    def list(self) -> list[ToolArtifact]:
        records, manifest = self._records_and_manifest()
        return [self._artifact(record, manifest) for record in records]

    def _find(
        self, artifact_id: str
    ) -> tuple[SkillRecord, ToolArtifact, _BundledManifest]:
        records, manifest = self._records_and_manifest()
        for record in records:
            expected = (
                builtin_artifact_id(record.skill.name)
                if record.source == "bundled"
                else legacy_artifact_id(record.path)
            )
            if expected == artifact_id:
                return record, self._artifact(record, manifest), manifest
        raise ToolLegacyError("Tool not found.", code="tool_not_found")

    def get(self, artifact_id: str) -> ToolArtifact:
        _record, artifact, _manifest = self._find(artifact_id)
        return artifact

    def edit(
        self,
        artifact_id: str,
        patch: Mapping[str, Any],
        *,
        expected_revision: int,
        expected_content_hash: str,
    ) -> ToolArtifact:
        from ae_mcp.tool_store import ToolRevisionConflict

        record, artifact, _manifest = self._find(artifact_id)
        if record.source == "bundled":
            raise ToolReadOnly()
        unknown = sorted(set(patch) - _EDIT_KEYS)
        if unknown:
            raise ToolLegacyError("Legacy edit contains unsupported fields.")
        if (
            artifact.revision != expected_revision
            or artifact.content_hash != expected_content_hash
        ):
            raise ToolRevisionConflict()
        patch = dict(patch)
        new_status = patch.get("status", artifact.status)
        if (
            not isinstance(new_status, str)
            or new_status not in _STATUSES
            or (
                new_status != artifact.status
                and (artifact.status, new_status) not in _EDIT_STATUS_TRANSITIONS
            )
        ):
            raise ToolLegacyError(
                "Legacy status transition is invalid.",
                code="tool_store_invalid_request",
            )
        metadata_keys = frozenset(
            {
                "category",
                "tags",
                "status",
                "compatibility",
                "declared_risk",
                "verification_action",
            }
        )
        skill_keys = frozenset({"description", "content", "args_schema", "kind"})
        verification_action = patch.get("verification_action")
        if verification_action not in {None, "mark-reviewed", "clear"}:
            raise ToolLegacyError("Legacy verification action is invalid.")
        ordinary_metadata = set(patch) & (metadata_keys - {"verification_action"})
        if set(patch) & skill_keys and (
            ordinary_metadata or verification_action == "mark-reviewed"
        ):
            raise ToolLegacyError(
                "Legacy metadata and content edits require separate transactions.",
                code="tool_legacy_transaction_required",
            )
        if set(patch) & skill_keys and verification_action == "clear":
            patch.pop("verification_action")
        if set(patch) & metadata_keys:
            metadata_patch = {
                ("declaredRisk" if key == "declared_risk" else key): value
                for key, value in patch.items()
                if key != "verification_action"
            }
            verification_action = patch.get("verification_action")
            if verification_action == "mark-reviewed":
                metadata_patch.update(
                    {
                        "verified": True,
                        "verification": {
                            "method": "user-reviewed",
                            "verifiedAt": int(time.time() * 1000),
                            "evidenceHash": artifact.content_hash,
                        },
                    }
                )
            elif verification_action == "clear":
                metadata_patch.update({"verified": False, "verification": None})
            elif verification_action is not None:
                raise ToolLegacyError("Legacy verification action is invalid.")
            store_revision = self.metadata_store.store_revision()
            _current_record, current, _current_manifest = self._find(artifact_id)
            if (
                current.revision != expected_revision
                or current.content_hash != expected_content_hash
            ):
                raise ToolRevisionConflict()
            self.metadata_store.compare_and_set(
                record.path,
                expected_content_hash,
                metadata_patch,
                expected_revision=store_revision,
            )
            return self.get(artifact.id)
        template_type = record.skill.template_type
        if "kind" in patch:
            if patch["kind"] == "jsx":
                template_type = "jsx"
            elif patch["kind"] == "prompt-skill":
                template_type = "prompt"
            else:
                raise ToolLegacyError("Legacy skill kind is unsupported.")
        description = patch.get("description", record.skill.description)
        content = patch.get("content", record.skill.template)
        if not isinstance(description, str) or len(description) > 4096:
            raise ToolLegacyError("Legacy skill description is invalid.")
        if not isinstance(content, str):
            raise ToolLegacyError("Legacy skill content is invalid.")
        args_schema = patch.get("args_schema", record.skill.args_schema)
        if not isinstance(args_schema, Mapping):
            raise ToolLegacyError("Legacy skill args schema is invalid.")
        updated = Skill(
            name=record.skill.name,
            description=description,
            template_type=template_type,
            template=content,
            args_schema=cast(Any, _json_mapping(args_schema, "legacy args schema")),
        )
        try:
            skill_content_hash(updated)
        except (TypeError, ValueError) as exc:
            raise ToolLegacyError("Legacy skill content is invalid.") from exc
        self.skill_store.write_record(
            record,
            updated,
            expected_content_hash=expected_content_hash,
        )
        return self.get(artifact.id)

    def archive(
        self,
        artifact_id: str,
        *,
        expected_revision: int,
        expected_content_hash: str,
    ) -> ToolArtifact:
        from ae_mcp.tool_store import ToolRevisionConflict

        record, artifact, _manifest = self._find(artifact_id)
        if record.source == "bundled":
            raise ToolReadOnly()
        if (
            artifact.revision != expected_revision
            or artifact.content_hash != expected_content_hash
        ):
            raise ToolRevisionConflict()
        store_revision = self.metadata_store.store_revision()
        _current_record, current, _current_manifest = self._find(artifact_id)
        if (
            current.revision != expected_revision
            or current.content_hash != expected_content_hash
        ):
            raise ToolRevisionConflict()
        self.metadata_store.compare_and_set(
            record.path,
            expected_content_hash,
            {"status": "archived"},
            expected_revision=store_revision,
        )
        return self.get(artifact.id)

    def delete(
        self,
        artifact_id: str,
        *,
        expected_revision: int,
        expected_content_hash: str,
    ) -> None:
        from ae_mcp.tool_store import ToolRevisionConflict

        record, artifact, _manifest = self._find(artifact_id)
        if record.source == "bundled":
            raise ToolReadOnly()
        if (
            artifact.revision != expected_revision
            or artifact.content_hash != expected_content_hash
        ):
            raise ToolRevisionConflict()
        current = self.skill_store._record(record.path, "user")
        if skill_content_hash(current.skill) != expected_content_hash:
            raise ToolRevisionConflict()
        record.path.unlink()

    def duplicate(
        self,
        artifact_id: str,
        *,
        name: str,
        expected_content_hash: str,
    ) -> ToolArtifactDraft:
        from ae_mcp.tool_store import ToolRevisionConflict

        _record, artifact, _manifest = self._find(artifact_id)
        if artifact.content_hash != expected_content_hash:
            raise ToolRevisionConflict()
        try:
            return ToolArtifactDraft(
                name=name,
                description=artifact.description,
                kind=artifact.kind,
                category=artifact.category,
                tags=artifact.tags,
                compatibility=artifact.compatibility,
                declared_risk=artifact.declared_risk,
                source=ToolSource(
                    type="user",
                    ref=f"duplicate:{artifact.id}",
                    client=None,
                    product_version=None,
                    provenance={"sourceContentHash": artifact.content_hash},
                ),
                status="saved",
                content=artifact.content,
                args_schema=artifact.args_schema,
            )
        except (TypeError, ValueError) as exc:
            raise ToolLegacyError("Duplicate tool name is invalid.") from exc


__all__ = [
    "LegacyMetadata",
    "LegacyMetadataStore",
    "LegacySkillAdapter",
    "ToolLegacyError",
    "ToolReadOnly",
]
