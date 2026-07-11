"""Crash-resumable first-upgrade backup and migration marker handling."""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import shutil
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

from ae_mcp.platform_files import atomic_replace_bytes, fsync_parent
from ae_mcp.tool_secrets import RegexSecretScanner, SecretScanner, require_secret_free
from ae_mcp.tool_store import StoreLock, ToolStoreError, atomic_write_json


class ToolMigrationError(RuntimeError):
    code = "tool_migration_failed"

    def __init__(
        self,
        message: str = "Tool data migration failed",
        *,
        code: str | None = None,
    ) -> None:
        super().__init__(message)
        if code is not None:
            self.code = code


@dataclass(frozen=True)
class MigrationResult:
    migrated: bool
    backup_id: str | None


_BACKUP_ID = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$")


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _ensure_directory(path: Path) -> None:
    try:
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
    except OSError as exc:
        raise ToolMigrationError() from exc
    if path.is_symlink() or not path.is_dir():
        raise ToolMigrationError()
    if os.name != "nt":
        try:
            path.chmod(0o700)
        except OSError as exc:
            raise ToolMigrationError() from exc


def _read_json(path: Path) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise ToolMigrationError()
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ToolMigrationError() from exc
    if not isinstance(value, dict):
        raise ToolMigrationError()
    return cast(dict[str, Any], value)


class ToolDataMigrator:
    def __init__(
        self,
        root: Path,
        *,
        legacy_roots: Sequence[Path] | None = None,
        scanner: SecretScanner | None = None,
        fault_hook: Callable[[str], None] | None = None,
        now: Callable[[], int] | None = None,
    ) -> None:
        self.root = Path(root).expanduser().absolute()
        self.index_path = self.root / "index.json"
        self.artifacts_dir = self.root / "artifacts"
        self.legacy_metadata_path = self.root / "legacy-metadata.json"
        self.marker_path = self.root / "migration-v1.json"
        self.backups_dir = self.root / "backups"
        self.legacy_roots = tuple(
            Path(path).expanduser().absolute()
            for path in (
                legacy_roots if legacy_roots is not None else (self.root.parent / "skills",)
            )
        )
        self.scanner = scanner or RegexSecretScanner()
        self.fault_hook = fault_hook or (lambda _stage: None)
        self._now = now or (lambda: int(time.time() * 1000))

    def _marker(self) -> dict[str, Any] | None:
        if self.marker_path.is_symlink():
            raise ToolMigrationError()
        if not self.marker_path.exists():
            return None
        value = _read_json(self.marker_path)
        if (
            value.get("schemaVersion") != 1
            or not isinstance(value.get("backupId"), str)
            or not _BACKUP_ID.fullmatch(value["backupId"])
            or isinstance(value.get("migratedAt"), bool)
            or not isinstance(value.get("migratedAt"), int)
        ):
            raise ToolMigrationError()
        return value

    def _validate_primary_schema(self) -> None:
        for path in (self.index_path, self.legacy_metadata_path):
            if path.is_symlink():
                raise ToolMigrationError()
            if not path.exists():
                continue
            value = _read_json(path)
            if value.get("schemaVersion") != 1:
                raise ToolMigrationError(
                    "Tool data schema is unsupported",
                    code="tool_migration_schema_unsupported",
                )

    def _source_files(self) -> list[tuple[str, str, Path]]:
        sources: list[tuple[str, str, Path]] = []
        for legacy_root in self.legacy_roots:
            if not legacy_root.exists():
                continue
            if legacy_root.is_symlink() or not legacy_root.is_dir():
                raise ToolMigrationError()
            for path in sorted(legacy_root.rglob("*")):
                if path.is_symlink():
                    raise ToolMigrationError()
                if path.is_file():
                    relative = path.relative_to(legacy_root).as_posix()
                    sources.append(("legacy", f"{legacy_root.name}/{relative}", path))
        for path, name in (
            (self.index_path, "index.json"),
            (self.legacy_metadata_path, "legacy-metadata.json"),
        ):
            if path.exists():
                if path.is_symlink() or not path.is_file():
                    raise ToolMigrationError()
                sources.append(("native", name, path))
        if self.artifacts_dir.exists():
            if self.artifacts_dir.is_symlink() or not self.artifacts_dir.is_dir():
                raise ToolMigrationError()
            for path in sorted(self.artifacts_dir.glob("*.json")):
                if path.is_symlink() or not path.is_file():
                    raise ToolMigrationError()
                sources.append(("native", f"artifacts/{path.name}", path))
        sources.sort(key=lambda item: (item[0], item[1]))
        return sources

    def _scan_sources(self) -> list[dict[str, str]]:
        result: list[dict[str, str]] = []
        for kind, name, path in self._source_files():
            try:
                data = path.read_bytes()
            except OSError as exc:
                raise ToolMigrationError() from exc
            require_secret_free(self.scanner, name=name, data=data)
            result.append({"kind": kind, "name": name, "sha256": _sha256(data)})
        return result

    def _prepared_backup(self) -> tuple[str, dict[str, Any]] | None:
        if not self.backups_dir.exists():
            return None
        prepared: list[tuple[int, str, dict[str, Any]]] = []
        for manifest_path in self.backups_dir.glob("*/manifest.json"):
            value = _read_json(manifest_path)
            backup_id = manifest_path.parent.name
            if (
                value.get("state") == "prepared"
                and value.get("schemaVersion") == 1
                and value.get("backupId") == backup_id
                and _BACKUP_ID.fullmatch(backup_id)
                and isinstance(value.get("createdAt"), int)
            ):
                prepared.append((value["createdAt"], backup_id, value))
        if not prepared:
            return None
        prepared.sort(reverse=True)
        _created_at, backup_id, manifest = prepared[0]
        return backup_id, manifest

    def _remove_incomplete_backups(self, lock: StoreLock) -> None:
        if not self.backups_dir.exists():
            return
        for path in self.backups_dir.iterdir():
            if path.is_symlink() or not path.is_dir() or not _BACKUP_ID.fullmatch(path.name):
                raise ToolMigrationError()
            if (path / "manifest.json").exists():
                continue
            if not path.name.startswith("migration-"):
                raise ToolMigrationError()
            lock.assert_current()
            shutil.rmtree(path)
        fsync_parent(self.backups_dir)

    def _create_backup(
        self,
        lock: StoreLock,
        sources: list[dict[str, str]],
    ) -> tuple[str, dict[str, Any]]:
        backup_id = f"migration-{self._now()}-{secrets.token_hex(6)}"
        backup = self.backups_dir / backup_id
        backup_artifacts = backup / "artifacts"
        lock.assert_current()
        _ensure_directory(backup_artifacts)
        lock.assert_current()
        had_index = self.index_path.exists()
        index_bytes = (
            self.index_path.read_bytes()
            if had_index
            else b'{"artifacts":[],"revision":0,"schemaVersion":1}\n'
        )
        lock.assert_current()
        atomic_replace_bytes(backup / "index.json", index_bytes, mode=0o600)
        artifact_records: list[dict[str, str]] = []
        if self.artifacts_dir.exists():
            for source in sorted(self.artifacts_dir.glob("*.json")):
                data = source.read_bytes()
                lock.assert_current()
                atomic_replace_bytes(backup_artifacts / source.name, data, mode=0o600)
                artifact_records.append({"name": source.name, "sha256": _sha256(data)})
        had_legacy_metadata = self.legacy_metadata_path.exists()
        legacy_metadata_sha256: str | None = None
        if had_legacy_metadata:
            data = self.legacy_metadata_path.read_bytes()
            lock.assert_current()
            atomic_replace_bytes(backup / "legacy-metadata.json", data, mode=0o600)
            legacy_metadata_sha256 = _sha256(data)
        manifest: dict[str, Any] = {
            "schemaVersion": 1,
            "backupId": backup_id,
            "createdAt": self._now(),
            "state": "prepared",
            "hadIndex": had_index,
            "indexSha256": _sha256(index_bytes),
            "hadLegacyMetadata": had_legacy_metadata,
            "legacyMetadataSha256": legacy_metadata_sha256,
            "artifacts": artifact_records,
            "sources": sources,
        }
        lock.assert_current()
        atomic_write_json(backup / "manifest.json", manifest)
        fsync_parent(backup)
        return backup_id, manifest

    def migrate_from_v0_9(self) -> MigrationResult:
        marker = self._marker()
        if marker is not None:
            return MigrationResult(migrated=False, backup_id=cast(str, marker["backupId"]))
        try:
            with StoreLock(self.root) as lock:
                marker = self._marker()
                if marker is not None:
                    return MigrationResult(
                        migrated=False, backup_id=cast(str, marker["backupId"])
                    )
                self._validate_primary_schema()
                sources = self._scan_sources()
                lock.assert_current()
                _ensure_directory(self.backups_dir)
                _ensure_directory(self.artifacts_dir)
                lock.assert_current()
                self._remove_incomplete_backups(lock)
                prepared = self._prepared_backup()
                if prepared is None:
                    backup_id, _manifest = self._create_backup(lock, sources)
                else:
                    backup_id, _manifest = prepared
                self.fault_hook("after-backup")
                lock.assert_current()
                if not self.index_path.exists():
                    atomic_write_json(
                        self.index_path,
                        {"schemaVersion": 1, "revision": 0, "artifacts": []},
                    )
                self.fault_hook("after-index")
                lock.assert_current()
                if not self.legacy_metadata_path.exists():
                    atomic_write_json(
                        self.legacy_metadata_path,
                        {"schemaVersion": 1, "revision": 0, "entries": {}},
                    )
                self.fault_hook("before-marker")
                lock.assert_current()
                atomic_write_json(
                    self.marker_path,
                    {
                        "schemaVersion": 1,
                        "backupId": backup_id,
                        "migratedAt": self._now(),
                    },
                )
                lock.assert_current()
        except (OSError, ToolStoreError) as exc:
            raise ToolMigrationError() from exc
        return MigrationResult(migrated=True, backup_id=backup_id)

    def _backup(self, backup_id: str) -> tuple[Path, dict[str, Any]]:
        if not isinstance(backup_id, str) or not _BACKUP_ID.fullmatch(backup_id):
            raise ToolMigrationError(
                "Tool migration backup id is invalid",
                code="tool_migration_invalid_backup",
            )
        backup = self.backups_dir / backup_id
        manifest = _read_json(backup / "manifest.json")
        if manifest.get("backupId") != backup_id or manifest.get("schemaVersion") != 1:
            raise ToolMigrationError()
        return backup, manifest

    def _verified_backup_file(self, path: Path, expected_hash: object) -> bytes:
        if not isinstance(expected_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_hash):
            raise ToolMigrationError()
        try:
            data = path.read_bytes()
        except OSError as exc:
            raise ToolMigrationError() from exc
        if _sha256(data) != expected_hash:
            raise ToolMigrationError()
        return data

    def rollback(self, backup_id: str) -> None:
        backup, manifest = self._backup(backup_id)
        index_data = self._verified_backup_file(backup / "index.json", manifest.get("indexSha256"))
        raw_artifacts = manifest.get("artifacts")
        if not isinstance(raw_artifacts, list):
            raise ToolMigrationError()
        artifact_data: dict[str, bytes] = {}
        for record in raw_artifacts:
            if not isinstance(record, Mapping) or set(record) != {"name", "sha256"}:
                raise ToolMigrationError()
            name = record.get("name")
            if not isinstance(name, str) or Path(name).name != name or not name.endswith(".json"):
                raise ToolMigrationError()
            artifact_data[name] = self._verified_backup_file(
                backup / "artifacts" / name, record.get("sha256")
            )
        legacy_data: bytes | None = None
        if manifest.get("hadLegacyMetadata") is True:
            legacy_data = self._verified_backup_file(
                backup / "legacy-metadata.json", manifest.get("legacyMetadataSha256")
            )
        try:
            with StoreLock(self.root) as lock:
                _ensure_directory(self.artifacts_dir)
                for current in self.artifacts_dir.glob("*.json"):
                    lock.assert_current()
                    current.unlink()
                for name, data in artifact_data.items():
                    lock.assert_current()
                    atomic_replace_bytes(self.artifacts_dir / name, data, mode=0o600)
                lock.assert_current()
                if manifest.get("hadIndex") is True:
                    atomic_replace_bytes(self.index_path, index_data, mode=0o600)
                else:
                    self.index_path.unlink(missing_ok=True)
                lock.assert_current()
                if legacy_data is not None:
                    atomic_replace_bytes(self.legacy_metadata_path, legacy_data, mode=0o600)
                else:
                    self.legacy_metadata_path.unlink(missing_ok=True)
                manifest["state"] = "rolled-back"
                atomic_write_json(backup / "manifest.json", manifest)
                self.marker_path.unlink(missing_ok=True)
                fsync_parent(self.root)
        except (OSError, ToolStoreError) as exc:
            raise ToolMigrationError() from exc

    def prune_backups(self, *, retain_count: int = 3, retain_days: int = 30) -> None:
        if (
            isinstance(retain_count, bool)
            or not isinstance(retain_count, int)
            or retain_count < 0
            or isinstance(retain_days, bool)
            or not isinstance(retain_days, int)
            or retain_days < 0
        ):
            raise ToolMigrationError(
                "Tool migration retention is invalid",
                code="tool_migration_invalid_retention",
            )
        if not self.backups_dir.exists():
            return
        backups: list[tuple[int, Path]] = []
        for path in self.backups_dir.iterdir():
            if path.is_symlink() or not path.is_dir() or not _BACKUP_ID.fullmatch(path.name):
                raise ToolMigrationError()
            manifest = _read_json(path / "manifest.json")
            created_at = manifest.get("createdAt")
            if isinstance(created_at, bool) or not isinstance(created_at, int):
                raise ToolMigrationError()
            backups.append((created_at, path))
        backups.sort(key=lambda item: (item[0], item[1].name), reverse=True)
        cutoff = self._now() - retain_days * 24 * 60 * 60 * 1000
        try:
            with StoreLock(self.root) as lock:
                for position, (created_at, path) in enumerate(backups):
                    if position < retain_count and created_at >= cutoff:
                        continue
                    lock.assert_current()
                    shutil.rmtree(path)
                fsync_parent(self.backups_dir)
        except (OSError, ToolStoreError) as exc:
            raise ToolMigrationError() from exc


__all__ = ["MigrationResult", "ToolDataMigrator", "ToolMigrationError"]
