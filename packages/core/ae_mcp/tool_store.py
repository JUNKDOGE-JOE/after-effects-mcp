"""Crash-safe native persistence for Tool Library artifacts."""

from __future__ import annotations

import errno
import json
import os
import re
import secrets
import socket
import stat
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import AbstractSet, Any, cast
from uuid import UUID, uuid4

from ae_mcp.platform_files import atomic_replace_bytes, fsync_parent
from ae_mcp.tool_artifact import (
    ArtifactKind,
    ArtifactRisk,
    ArtifactStatus,
    JsonValue,
    ToolArtifact,
    ToolArtifactDraft,
    ToolSource,
    ToolSummary,
    canonical_json_bytes,
    compute_content_hash,
    new_user_artifact_id,
)
from ae_mcp.tool_secrets import (
    RegexSecretScanner,
    SecretScanError,
    SecretScanner,
    require_secret_free,
    require_secret_free_json,
)


class ToolStoreError(RuntimeError):
    code = "tool_store_error"

    def __init__(self, message: str = "Tool store operation failed") -> None:
        super().__init__(message)


class ToolRevisionConflict(ToolStoreError):
    code = "tool_revision_conflict"

    def __init__(self) -> None:
        super().__init__("Tool artifact revision conflict")


class ToolStoreRevisionConflict(ToolStoreError):
    code = "tool_store_revision_conflict"

    def __init__(self) -> None:
        super().__init__("Tool store revision conflict")


class ToolNotFound(ToolStoreError):
    code = "tool_not_found"

    def __init__(self) -> None:
        super().__init__("Tool artifact was not found")


class ToolStoreLocked(ToolStoreError):
    code = "tool_store_locked"

    def __init__(self) -> None:
        super().__init__("Tool store lock is unavailable")


class ToolStoreCorrupt(ToolStoreError):
    code = "tool_store_corrupt"

    def __init__(self) -> None:
        super().__init__("Tool store data is invalid")


class ToolStoreRootChanged(ToolStoreError):
    code = "tool_store_root_changed"

    def __init__(self) -> None:
        super().__init__("Tool store root changed during mutation")


class ToolStoreWriteError(ToolStoreError):
    code = "tool_store_write_failed"

    def __init__(self) -> None:
        super().__init__("Tool store write failed")


class ToolStoreValidationError(ToolStoreError):
    code = "tool_store_invalid_request"

    def __init__(self) -> None:
        super().__init__("Tool store request is invalid")


@dataclass(frozen=True)
class StoreMutation:
    kind: str
    artifact_ids: tuple[str, ...]
    store_revision: int


def atomic_write_json(path: Path, value: object) -> None:
    try:
        data = canonical_json_bytes(cast(JsonValue, value)) + b"\n"
        atomic_replace_bytes(Path(path), data, mode=0o600)
    except (TypeError, ValueError) as exc:
        raise ToolStoreValidationError() from exc
    except OSError as exc:
        raise ToolStoreWriteError() from exc


def _private_directory(path: Path) -> None:
    try:
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        _directory_identity(path)
    except (OSError, ToolStoreRootChanged) as exc:
        raise ToolStoreRootChanged() from exc
    if os.name != "nt":
        try:
            path.chmod(0o700)
        except OSError as exc:
            raise ToolStoreRootChanged() from exc


def _directory_identity(path: Path) -> tuple[int, int]:
    try:
        info = path.lstat()
    except OSError as exc:
        raise ToolStoreRootChanged() from exc
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise ToolStoreRootChanged()
    return info.st_dev, info.st_ino


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except OSError as exc:
        return exc.errno == errno.EPERM
    return True


class StoreLock:
    def __init__(
        self,
        root: Path,
        *,
        timeout_sec: float = 5.0,
        stale_after_sec: float = 30.0,
    ) -> None:
        self.root = Path(root).expanduser().absolute()
        self.timeout_sec = max(0.0, float(timeout_sec))
        self.stale_after_sec = max(0.0, float(stale_after_sec))
        self.lock_dir = self.root / ".store-lock"
        self.owner_path = self.lock_dir / "owner.json"
        self.nonce = secrets.token_urlsafe(24)
        self._root_identity: tuple[int, int] | None = None
        self._lock_identity: tuple[int, int] | None = None
        self._acquired = False

    def _read_owner(self) -> dict[str, object] | None:
        if self.owner_path.is_symlink() or not self.owner_path.is_file():
            return None
        try:
            value = json.loads(self.owner_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            return None
        if not isinstance(value, dict):
            return None
        if set(value) != {"pid", "hostname", "createdAt", "nonce"}:
            return None
        if (
            isinstance(value["pid"], bool)
            or not isinstance(value["pid"], int)
            or not isinstance(value["hostname"], str)
            or isinstance(value["createdAt"], bool)
            or not isinstance(value["createdAt"], int)
            or not isinstance(value["nonce"], str)
            or not value["nonce"]
        ):
            return None
        return cast(dict[str, object], value)

    def _can_recover(self, owner: Mapping[str, object]) -> bool:
        age_ms = int(time.time() * 1000) - cast(int, owner["createdAt"])
        if age_ms <= int(self.stale_after_sec * 1000):
            return False
        owner_host = cast(str, owner["hostname"])
        return owner_host != socket.gethostname() or not _pid_alive(cast(int, owner["pid"]))

    def _recover_stale(self) -> bool:
        try:
            lock_identity = _directory_identity(self.lock_dir)
        except ToolStoreRootChanged:
            return False
        first = self._read_owner()
        if first is None or not self._can_recover(first):
            return False
        second = self._read_owner()
        if second is None or second.get("nonce") != first.get("nonce"):
            return False
        try:
            if _directory_identity(self.lock_dir) != lock_identity:
                return False
        except ToolStoreRootChanged:
            return False
        if _directory_identity(self.root) != self._root_identity:
            raise ToolStoreRootChanged()
        final = self._read_owner()
        if final is None or final.get("nonce") != first.get("nonce"):
            return False
        try:
            self.owner_path.unlink()
            self.lock_dir.rmdir()
            fsync_parent(self.root)
        except OSError:
            return False
        return True

    def __enter__(self) -> "StoreLock":
        _private_directory(self.root)
        self._root_identity = _directory_identity(self.root)
        deadline = time.monotonic() + self.timeout_sec
        while True:
            try:
                self.lock_dir.mkdir(mode=0o700)
            except FileExistsError:
                if self._recover_stale():
                    continue
                if time.monotonic() >= deadline:
                    raise ToolStoreLocked()
                time.sleep(min(0.05, max(0.0, deadline - time.monotonic())))
                continue
            except OSError as exc:
                raise ToolStoreLocked() from exc
            try:
                self._lock_identity = _directory_identity(self.lock_dir)
                self.assert_current(check_owner=False)
                atomic_write_json(
                    self.owner_path,
                    {
                        "pid": os.getpid(),
                        "hostname": socket.gethostname(),
                        "createdAt": int(time.time() * 1000),
                        "nonce": self.nonce,
                    },
                )
                self.assert_current()
                self._acquired = True
                fsync_parent(self.root)
                return self
            except Exception:
                try:
                    lock_current = (
                        self._root_identity is not None
                        and _directory_identity(self.root) == self._root_identity
                        and self._lock_identity is not None
                        and _directory_identity(self.lock_dir) == self._lock_identity
                    )
                    if lock_current:
                        owner = self._read_owner()
                        if owner is not None and owner.get("nonce") == self.nonce:
                            self.owner_path.unlink(missing_ok=True)
                            self.lock_dir.rmdir()
                except (OSError, ToolStoreError):
                    pass
                raise

    def assert_current(self, *, check_owner: bool = True) -> None:
        if self._root_identity is None or _directory_identity(self.root) != self._root_identity:
            raise ToolStoreRootChanged()
        if self._lock_identity is None or _directory_identity(self.lock_dir) != self._lock_identity:
            raise ToolStoreRootChanged()
        if check_owner:
            owner = self._read_owner()
            if owner is None or owner.get("nonce") != self.nonce:
                raise ToolStoreRootChanged()

    def _release(self) -> None:
        if not self._acquired:
            return
        try:
            self.assert_current()
        except ToolStoreRootChanged:
            self._acquired = False
            return
        try:
            self.owner_path.unlink()
            self.lock_dir.rmdir()
            fsync_parent(self.root)
        except OSError:
            pass
        self._acquired = False

    def __exit__(self, _type: object, _value: object, _traceback: object) -> None:
        self._release()


_INDEX_KEYS = frozenset({"schemaVersion", "revision", "artifacts"})
_ENTRY_KEYS = frozenset(
    {
        "id",
        "name",
        "description",
        "kind",
        "category",
        "tags",
        "status",
        "verified",
        "declaredRisk",
        "contentHash",
        "revision",
        "updatedAt",
        "lastUsedAt",
        "sourceType",
    }
)
_KINDS = frozenset({"jsx", "expression", "prompt-skill", "recipe", "diagnostic"})
_STATUSES = frozenset({"candidate", "saved", "pinned", "archived", "deprecated"})
_RISKS = frozenset({"read", "write", "destructive", "external"})
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


def _empty_index() -> dict[str, JsonValue]:
    return {"schemaVersion": 1, "revision": 0, "artifacts": []}


def _entry_from_artifact(artifact: ToolArtifact) -> dict[str, JsonValue]:
    return {
        "id": artifact.id,
        "name": artifact.name,
        "description": artifact.description,
        "kind": artifact.kind,
        "category": artifact.category,
        "tags": list(artifact.tags),
        "status": artifact.status,
        "verified": artifact.verified,
        "declaredRisk": artifact.declared_risk,
        "contentHash": artifact.content_hash,
        "revision": artifact.revision,
        "updatedAt": artifact.updated_at,
        "lastUsedAt": artifact.last_used_at,
        "sourceType": artifact.source.type,
    }


def _summary_from_entry(entry: Mapping[str, Any]) -> ToolSummary:
    if set(entry) != _ENTRY_KEYS:
        raise ToolStoreCorrupt()
    string_fields = ("id", "name", "description", "category", "sourceType")
    if any(not isinstance(entry.get(field), str) for field in string_fields):
        raise ToolStoreCorrupt()
    tags = entry.get("tags")
    if not isinstance(tags, list) or any(not isinstance(tag, str) for tag in tags):
        raise ToolStoreCorrupt()
    if entry.get("kind") not in _KINDS or entry.get("status") not in _STATUSES:
        raise ToolStoreCorrupt()
    if entry.get("declaredRisk") not in _RISKS or type(entry.get("verified")) is not bool:
        raise ToolStoreCorrupt()
    content_hash = entry.get("contentHash")
    if not isinstance(content_hash, str) or not _SHA256.fullmatch(content_hash):
        raise ToolStoreCorrupt()
    for field in ("revision", "updatedAt"):
        value = entry.get(field)
        minimum = 1 if field == "revision" else 0
        if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
            raise ToolStoreCorrupt()
    last_used = entry.get("lastUsedAt")
    if last_used is not None and (
        isinstance(last_used, bool) or not isinstance(last_used, int) or last_used < 0
    ):
        raise ToolStoreCorrupt()
    try:
        return ToolSummary(
            id=cast(str, entry["id"]),
            name=cast(str, entry["name"]),
            description=cast(str, entry["description"]),
            kind=cast(ArtifactKind, entry["kind"]),
            category=cast(str, entry["category"]),
            tags=tuple(cast(list[str], entry["tags"])),
            status=cast(ArtifactStatus, entry["status"]),
            verified=cast(bool, entry["verified"]),
            declared_risk=cast(ArtifactRisk, entry["declaredRisk"]),
            content_hash=cast(str, entry["contentHash"]),
            revision=cast(int, entry["revision"]),
            updated_at=cast(int, entry["updatedAt"]),
            last_used_at=cast(int | None, entry["lastUsedAt"]),
            source_type=cast(str, entry["sourceType"]),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise ToolStoreCorrupt() from exc


class ToolArtifactStore:
    def __init__(
        self,
        root: Path,
        *,
        scanner: SecretScanner | None = None,
        lock_timeout_sec: float = 5.0,
        stale_lock_after_sec: float = 30.0,
        now: Callable[[], int] | None = None,
        uuid_factory: Callable[[], UUID] = uuid4,
    ) -> None:
        self.root = Path(root).expanduser().absolute()
        self.artifacts_dir = self.root / "artifacts"
        self.index_path = self.root / "index.json"
        self.backups_dir = self.root / "backups"
        self.scanner = scanner or RegexSecretScanner()
        self.lock_timeout_sec = lock_timeout_sec
        self.stale_lock_after_sec = stale_lock_after_sec
        self._now = now or (lambda: int(time.time() * 1000))
        self._uuid_factory = uuid_factory
        self._subscribers: list[Callable[[StoreMutation], None]] = []
        _private_directory(self.root)
        _private_directory(self.artifacts_dir)
        _private_directory(self.backups_dir)
        self._artifacts_identity = _directory_identity(self.artifacts_dir)

    def _lock(self) -> StoreLock:
        return StoreLock(
            self.root,
            timeout_sec=self.lock_timeout_sec,
            stale_after_sec=self.stale_lock_after_sec,
        )

    def _assert_store_paths(self, lock: StoreLock) -> None:
        lock.assert_current()
        if _directory_identity(self.artifacts_dir) != self._artifacts_identity:
            raise ToolStoreRootChanged()

    def _read_scanned_json(self, path: Path, *, name: str) -> JsonValue:
        try:
            data = path.read_bytes()
            require_secret_free(self.scanner, name=name, data=data)
            value = cast(JsonValue, json.loads(data.decode("utf-8")))
            require_secret_free_json(self.scanner, name=name, value=value)
            canonical = canonical_json_bytes(value) + b"\n"
            require_secret_free(self.scanner, name=name, data=canonical)
            return value
        except (
            OSError,
            UnicodeError,
            json.JSONDecodeError,
            SecretScanError,
            TypeError,
            ValueError,
        ) as exc:
            raise ToolStoreCorrupt() from exc

    def _read_index(self) -> dict[str, JsonValue]:
        if not self.index_path.exists():
            return _empty_index()
        if self.index_path.is_symlink() or not self.index_path.is_file():
            raise ToolStoreCorrupt()
        value = self._read_scanned_json(self.index_path, name="index.json")
        if not isinstance(value, dict) or set(value) != _INDEX_KEYS:
            raise ToolStoreCorrupt()
        if value.get("schemaVersion") != 1:
            raise ToolStoreCorrupt()
        revision = value.get("revision")
        entries = value.get("artifacts")
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
            raise ToolStoreCorrupt()
        if not isinstance(entries, list):
            raise ToolStoreCorrupt()
        ids: set[str] = set()
        for entry in entries:
            if not isinstance(entry, dict):
                raise ToolStoreCorrupt()
            summary = _summary_from_entry(entry)
            if summary.id in ids:
                raise ToolStoreCorrupt()
            ids.add(summary.id)
        return cast(dict[str, JsonValue], value)

    def _artifact_path(self, artifact_id: str) -> Path:
        prefix = "user:"
        if not isinstance(artifact_id, str) or not artifact_id.startswith(prefix):
            raise ToolNotFound()
        try:
            value = UUID(artifact_id[len(prefix) :])
        except (ValueError, AttributeError) as exc:
            raise ToolNotFound() from exc
        if artifact_id != new_user_artifact_id(value):
            raise ToolNotFound()
        return self.artifacts_dir / f"{value}.json"

    def _entries(self, index: Mapping[str, JsonValue]) -> list[dict[str, JsonValue]]:
        return cast(list[dict[str, JsonValue]], index["artifacts"])

    def _entry_index(self, index: Mapping[str, JsonValue], artifact_id: str) -> int:
        for position, entry in enumerate(self._entries(index)):
            if entry.get("id") == artifact_id:
                return position
        raise ToolNotFound()

    def _load_artifact(self, artifact_id: str) -> ToolArtifact:
        path = self._artifact_path(artifact_id)
        if path.is_symlink() or not path.is_file():
            raise ToolStoreCorrupt()
        try:
            value = self._read_scanned_json(path, name="artifact.json")
            artifact = ToolArtifact.from_dict(value)
        except ToolNotFound:
            raise
        except ToolStoreCorrupt:
            raise
        except (ValueError, TypeError) as exc:
            raise ToolStoreCorrupt() from exc
        if artifact.id != artifact_id:
            raise ToolStoreCorrupt()
        return artifact

    def _scan_artifact(self, artifact: ToolArtifact) -> bytes:
        value = artifact.to_dict()
        require_secret_free_json(self.scanner, name="artifact.json", value=value)
        data = canonical_json_bytes(value) + b"\n"
        require_secret_free(self.scanner, name="artifact.json", data=data)
        return data

    def _replace_index(self, value: object) -> None:
        atomic_write_json(self.index_path, value)

    def _rollback_files(
        self,
        originals: Mapping[Path, bytes | None],
        index_before: Mapping[str, JsonValue],
        *,
        index_existed_before: bool,
    ) -> None:
        for path, data in originals.items():
            try:
                if data is None:
                    path.unlink(missing_ok=True)
                else:
                    atomic_replace_bytes(path, data, mode=0o600)
            except OSError:
                pass
        try:
            if index_existed_before:
                atomic_write_json(self.index_path, index_before)
            else:
                self.index_path.unlink(missing_ok=True)
                fsync_parent(self.root)
        except OSError:
            pass

    def _commit(
        self,
        lock: StoreLock,
        *,
        index_before: Mapping[str, JsonValue],
        index_after: Mapping[str, JsonValue],
        writes: Mapping[Path, bytes],
        deletes: Sequence[Path] = (),
    ) -> None:
        originals: dict[Path, bytes | None] = {}
        index_existed_before = self.index_path.exists()
        try:
            self._assert_store_paths(lock)
            for path, data in writes.items():
                self._assert_store_paths(lock)
                if path.is_symlink() or (path.exists() and not path.is_file()):
                    raise ToolStoreRootChanged()
                originals[path] = path.read_bytes() if path.exists() else None
                atomic_replace_bytes(path, data, mode=0o600)
            for path in deletes:
                self._assert_store_paths(lock)
                if path.is_symlink() or (path.exists() and not path.is_file()):
                    raise ToolStoreRootChanged()
                originals[path] = path.read_bytes() if path.exists() else None
                path.unlink(missing_ok=True)
                fsync_parent(path.parent)
            self._assert_store_paths(lock)
            self._replace_index(index_after)
            self._assert_store_paths(lock)
        except ToolStoreError:
            if _directory_identity(self.root) == lock._root_identity:
                self._rollback_files(
                    originals,
                    index_before,
                    index_existed_before=index_existed_before,
                )
            raise
        except Exception as exc:
            try:
                root_current = _directory_identity(self.root) == lock._root_identity
            except ToolStoreRootChanged:
                root_current = False
            if root_current:
                self._rollback_files(
                    originals,
                    index_before,
                    index_existed_before=index_existed_before,
                )
            raise ToolStoreWriteError() from exc

    def _publish(self, mutation: StoreMutation) -> None:
        for callback in tuple(self._subscribers):
            try:
                callback(mutation)
            except Exception:
                continue

    def _new_artifact(self, draft: ToolArtifactDraft, artifact_id: str, now: int) -> ToolArtifact:
        return ToolArtifact(
            id=artifact_id,
            name=draft.name,
            description=draft.description,
            kind=draft.kind,
            category=draft.category,
            tags=draft.tags,
            compatibility=draft.compatibility,
            declared_risk=draft.declared_risk,
            source=draft.source,
            status=draft.status,
            verified=False,
            verification=None,
            content=draft.content,
            args_schema=draft.args_schema,
            content_hash=compute_content_hash(draft.kind, draft.content, draft.args_schema),
            schema_version=1,
            revision=1,
            created_at=now,
            updated_at=now,
            last_used_at=None,
        )

    def list(
        self,
        *,
        kinds: AbstractSet[ArtifactKind] | None = None,
        statuses: AbstractSet[ArtifactStatus] | None = None,
        source_types: AbstractSet[str] | None = None,
        limit: int = 100,
    ) -> list[ToolSummary]:
        if isinstance(limit, bool) or not isinstance(limit, int) or not 0 <= limit <= 1000:
            raise ToolStoreValidationError()
        summaries = [_summary_from_entry(entry) for entry in self._entries(self._read_index())]
        filtered = [
            item
            for item in summaries
            if (kinds is None or item.kind in kinds)
            and (statuses is None or item.status in statuses)
            and (source_types is None or item.source_type in source_types)
        ]
        filtered.sort(key=lambda item: (-item.updated_at, item.id))
        return filtered[:limit]

    def search(
        self,
        query: str,
        *,
        kinds: AbstractSet[ArtifactKind] | None = None,
        categories: AbstractSet[str] | None = None,
        tags: AbstractSet[str] | None = None,
        risks: AbstractSet[ArtifactRisk] | None = None,
        statuses: AbstractSet[ArtifactStatus] | None = None,
        source_types: AbstractSet[str] | None = None,
        offset: int = 0,
        limit: int = 50,
    ) -> tuple[list[ToolSummary], int]:
        if not isinstance(query, str):
            raise ToolStoreValidationError()
        if (
            isinstance(offset, bool)
            or not isinstance(offset, int)
            or offset < 0
            or isinstance(limit, bool)
            or not isinstance(limit, int)
            or not 1 <= limit <= 1000
        ):
            raise ToolStoreValidationError()
        needle = query.casefold().strip()
        summaries = [
            _summary_from_entry(entry) for entry in self._entries(self._read_index())
        ]
        summaries.sort(key=lambda item: (-item.updated_at, item.id))
        matches: list[ToolSummary] = []
        for item in summaries:
            haystack = " ".join((item.name, item.description, item.category, *item.tags)).casefold()
            if needle and needle not in haystack:
                continue
            if kinds is not None and item.kind not in kinds:
                continue
            if categories is not None and item.category not in categories:
                continue
            if tags is not None and not tags.issubset(set(item.tags)):
                continue
            if risks is not None and item.declared_risk not in risks:
                continue
            if statuses is not None and item.status not in statuses:
                continue
            if source_types is not None and item.source_type not in source_types:
                continue
            matches.append(item)
        return matches[offset : offset + limit], len(matches)

    def find_by_content_hash(
        self,
        kind: ArtifactKind,
        content_hash: str,
        *,
        statuses: AbstractSet[ArtifactStatus] | None = None,
    ) -> list[ToolSummary]:
        matches = [
            item
            for item in (
                _summary_from_entry(entry)
                for entry in self._entries(self._read_index())
            )
            if item.kind == kind
            and item.content_hash == content_hash
            and (statuses is None or item.status in statuses)
        ]
        matches.sort(key=lambda item: (-item.updated_at, item.id))
        return matches

    def get(self, artifact_id: str, *, include_content: bool = True) -> ToolArtifact:
        del include_content
        with self._lock() as lock:
            index = self._read_index()
            position = self._entry_index(index, artifact_id)
            artifact = self._load_artifact(artifact_id)
            self._assert_store_paths(lock)
            if _entry_from_artifact(artifact) != self._entries(index)[position]:
                raise ToolStoreCorrupt()
            return artifact

    def store_revision(self) -> int:
        return cast(int, self._read_index()["revision"])

    def record_use(
        self,
        artifact_id: str,
        *,
        expected_content_hash: str,
        used_at: int,
    ) -> ToolArtifact:
        if isinstance(used_at, bool) or not isinstance(used_at, int) or used_at < 0:
            raise ToolStoreValidationError()
        with self._lock() as lock:
            index = self._read_index()
            position = self._entry_index(index, artifact_id)
            current = self._load_artifact(artifact_id)
            if current.content_hash != expected_content_hash:
                raise ToolRevisionConflict()
            value = current.to_dict()
            value["lastUsedAt"] = max(current.last_used_at or 0, used_at)
            updated = ToolArtifact.from_dict(value)
            entries = list(self._entries(index))
            entries[position] = _entry_from_artifact(updated)
            next_revision = cast(int, index["revision"]) + 1
            next_index: dict[str, JsonValue] = {
                "schemaVersion": 1,
                "revision": next_revision,
                "artifacts": entries,
            }
            self._commit(
                lock,
                index_before=index,
                index_after=next_index,
                writes={self._artifact_path(artifact_id): self._scan_artifact(updated)},
            )
        self._publish(StoreMutation("use", (artifact_id,), next_revision))
        return updated

    def create(
        self,
        draft: ToolArtifactDraft,
        *,
        expected_store_revision: int | None = None,
    ) -> ToolArtifact:
        if expected_store_revision is not None:
            return self.create_many_atomic(
                [draft], expected_store_revision=expected_store_revision
            )[0]
        while True:
            observed_revision = self.store_revision()
            try:
                return self.create_many_atomic(
                    [draft], expected_store_revision=observed_revision
                )[0]
            except ToolStoreRevisionConflict:
                continue

    def create_many_atomic(
        self,
        drafts: Sequence[ToolArtifactDraft],
        *,
        expected_store_revision: int,
    ) -> list[ToolArtifact]:
        if not isinstance(drafts, Sequence) or isinstance(drafts, (str, bytes)):
            raise ToolStoreValidationError()
        if any(not isinstance(draft, ToolArtifactDraft) for draft in drafts):
            raise ToolStoreValidationError()
        with self._lock() as lock:
            index = self._read_index()
            if index["revision"] != expected_store_revision:
                raise ToolStoreRevisionConflict()
            if not drafts:
                return []
            now = self._now()
            artifacts = [
                self._new_artifact(draft, new_user_artifact_id(self._uuid_factory()), now)
                for draft in drafts
            ]
            if len({artifact.id for artifact in artifacts}) != len(artifacts):
                raise ToolStoreValidationError()
            writes = {
                self._artifact_path(artifact.id): self._scan_artifact(artifact)
                for artifact in artifacts
            }
            entries = list(self._entries(index)) + [
                _entry_from_artifact(item) for item in artifacts
            ]
            entries.sort(key=lambda item: cast(str, item["id"]))
            next_revision = cast(int, index["revision"]) + 1
            next_index: dict[str, JsonValue] = {
                "schemaVersion": 1,
                "revision": next_revision,
                "artifacts": entries,
            }
            self._commit(
                lock,
                index_before=index,
                index_after=next_index,
                writes=writes,
            )
        self._publish(StoreMutation("create", tuple(item.id for item in artifacts), next_revision))
        return artifacts

    def _check_artifact_cas(
        self, artifact: ToolArtifact, expected_revision: int, expected_content_hash: str
    ) -> None:
        if artifact.revision != expected_revision or artifact.content_hash != expected_content_hash:
            raise ToolRevisionConflict()

    def edit(
        self,
        artifact_id: str,
        patch: Mapping[str, JsonValue],
        *,
        expected_revision: int,
        expected_content_hash: str,
        replace_artifact_id: str | None = None,
    ) -> ToolArtifact:
        if not isinstance(patch, Mapping) or replace_artifact_id == artifact_id:
            raise ToolStoreValidationError()
        aliases = {
            "declared_risk": "declaredRisk",
            "args_schema": "argsSchema",
            "verification_action": "verificationAction",
            "last_used_at": "lastUsedAt",
            "source_provenance": "sourceProvenance",
        }
        allowed = {
            "name",
            "description",
            "kind",
            "category",
            "tags",
            "compatibility",
            "declaredRisk",
            "status",
            "content",
            "argsSchema",
            "verificationAction",
            "lastUsedAt",
            "sourceProvenance",
        }
        normalized = {aliases.get(key, key): value for key, value in patch.items()}
        if not set(normalized).issubset(allowed):
            raise ToolStoreValidationError()
        history_keys = {"lastUsedAt", "sourceProvenance"}
        if set(normalized).intersection(history_keys) and not set(normalized).issubset(
            history_keys
        ):
            raise ToolStoreValidationError()
        with self._lock() as lock:
            index = self._read_index()
            self._entry_index(index, artifact_id)
            current = self._load_artifact(artifact_id)
            self._check_artifact_cas(current, expected_revision, expected_content_hash)
            history_touch = bool(set(normalized).intersection(history_keys))
            if history_touch and (
                current.status != "candidate"
                or current.source.type != "chat-tool-call"
                or "lastUsedAt" not in normalized
                or isinstance(normalized["lastUsedAt"], bool)
                or not isinstance(normalized["lastUsedAt"], int)
                or normalized["lastUsedAt"] < 0
                or not isinstance(normalized.get("sourceProvenance", {}), Mapping)
            ):
                raise ToolStoreValidationError()
            new_status = normalized.get("status", current.status)
            if not isinstance(new_status, str):
                raise ToolStoreValidationError()
            if new_status != current.status and (current.status, new_status) not in {
                ("candidate", "saved"),
                ("saved", "pinned"),
                ("pinned", "saved"),
            }:
                raise ToolStoreValidationError()
            replacement_path: Path | None = None
            if replace_artifact_id is not None:
                if current.status != "candidate" or new_status != "saved":
                    raise ToolStoreValidationError()
                self._entry_index(index, replace_artifact_id)
                self._load_artifact(replace_artifact_id)
                replacement_path = self._artifact_path(replace_artifact_id)
            verification_action = normalized.pop("verificationAction", None)
            if verification_action is not None and (
                not isinstance(verification_action, str)
                or verification_action not in {"mark-reviewed", "clear"}
            ):
                raise ToolStoreValidationError()
            content_changed = bool(
                {"content", "argsSchema", "kind"}.intersection(normalized)
            )
            if content_changed and verification_action == "mark-reviewed":
                raise ToolStoreValidationError()
            value = current.to_dict()
            history_last_used = normalized.pop("lastUsedAt", None)
            history_provenance = normalized.pop("sourceProvenance", None)
            value.update(normalized)
            if history_touch:
                value["lastUsedAt"] = cast(int, history_last_used)
                source = cast(dict[str, JsonValue], dict(cast(Mapping[str, JsonValue], value["source"])))
                provenance = dict(
                    cast(Mapping[str, JsonValue], source.get("provenance", {}))
                )
                if history_provenance is not None:
                    provenance.update(
                        cast(Mapping[str, JsonValue], history_provenance)
                    )
                source["provenance"] = provenance
                value["source"] = source
            now = self._now()
            value["revision"] = current.revision + 1
            value["updatedAt"] = now
            if content_changed:
                value["verified"] = False
                value["verification"] = None
                value["contentHash"] = compute_content_hash(
                    cast(ArtifactKind, value["kind"]),
                    cast(Any, value["content"]),
                    cast(Mapping[str, JsonValue], value["argsSchema"]),
                )
            if verification_action == "clear":
                value["verified"] = False
                value["verification"] = None
            elif verification_action == "mark-reviewed":
                value["verified"] = True
                value["verification"] = {
                    "method": "user-reviewed",
                    "verifiedAt": now,
                    "evidenceHash": value["contentHash"],
                }
            try:
                updated = ToolArtifact.from_dict(value)
            except (TypeError, ValueError) as exc:
                raise ToolStoreValidationError() from exc
            data = self._scan_artifact(updated)
            entries = [
                entry
                for entry in self._entries(index)
                if entry.get("id") != replace_artifact_id
            ]
            for position, entry in enumerate(entries):
                if entry.get("id") == artifact_id:
                    entries[position] = _entry_from_artifact(updated)
                    break
            else:
                raise ToolStoreCorrupt()
            next_revision = cast(int, index["revision"]) + 1
            next_index: dict[str, JsonValue] = {
                "schemaVersion": 1,
                "revision": next_revision,
                "artifacts": entries,
            }
            self._commit(
                lock,
                index_before=index,
                index_after=next_index,
                writes={self._artifact_path(artifact_id): data},
                deletes=(() if replacement_path is None else (replacement_path,)),
            )
        mutation_ids = (
            (artifact_id,)
            if replace_artifact_id is None
            else (artifact_id, replace_artifact_id)
        )
        self._publish(StoreMutation("edit", mutation_ids, next_revision))
        return updated

    def delete(
        self,
        artifact_id: str,
        *,
        expected_revision: int,
        expected_content_hash: str,
    ) -> None:
        with self._lock() as lock:
            index = self._read_index()
            position = self._entry_index(index, artifact_id)
            current = self._load_artifact(artifact_id)
            self._check_artifact_cas(current, expected_revision, expected_content_hash)
            entries = list(self._entries(index))
            del entries[position]
            next_revision = cast(int, index["revision"]) + 1
            next_index: dict[str, JsonValue] = {
                "schemaVersion": 1,
                "revision": next_revision,
                "artifacts": entries,
            }
            self._commit(
                lock,
                index_before=index,
                index_after=next_index,
                writes={},
                deletes=(self._artifact_path(artifact_id),),
            )
        self._publish(StoreMutation("delete", (artifact_id,), next_revision))

    def archive(
        self,
        artifact_id: str,
        *,
        expected_revision: int,
        expected_content_hash: str,
    ) -> ToolArtifact:
        with self._lock() as lock:
            index = self._read_index()
            position = self._entry_index(index, artifact_id)
            current = self._load_artifact(artifact_id)
            self._check_artifact_cas(current, expected_revision, expected_content_hash)
            value = current.to_dict()
            value["status"] = "archived"
            value["revision"] = current.revision + 1
            value["updatedAt"] = self._now()
            archived = ToolArtifact.from_dict(value)
            entries = list(self._entries(index))
            entries[position] = _entry_from_artifact(archived)
            next_revision = cast(int, index["revision"]) + 1
            next_index: dict[str, JsonValue] = {
                "schemaVersion": 1,
                "revision": next_revision,
                "artifacts": entries,
            }
            self._commit(
                lock,
                index_before=index,
                index_after=next_index,
                writes={self._artifact_path(artifact_id): self._scan_artifact(archived)},
            )
        self._publish(StoreMutation("archive", (artifact_id,), next_revision))
        return archived

    def duplicate(
        self, artifact_id: str, *, name: str, expected_content_hash: str
    ) -> ToolArtifact:
        with self._lock() as lock:
            index = self._read_index()
            self._entry_index(index, artifact_id)
            current = self._load_artifact(artifact_id)
            if current.content_hash != expected_content_hash:
                raise ToolRevisionConflict()
            duplicated = self._new_artifact(
                ToolArtifactDraft(
                    name=name,
                    description=current.description,
                    kind=current.kind,
                    category=current.category,
                    tags=current.tags,
                    compatibility=current.compatibility,
                    declared_risk=current.declared_risk,
                    source=ToolSource(
                        type="user",
                        ref="manual",
                        client=None,
                        product_version=current.source.product_version,
                        provenance={},
                    ),
                    status="saved",
                    content=current.content,
                    args_schema=current.args_schema,
                ),
                new_user_artifact_id(self._uuid_factory()),
                self._now(),
            )
            entries = list(self._entries(index)) + [_entry_from_artifact(duplicated)]
            entries.sort(key=lambda item: cast(str, item["id"]))
            next_revision = cast(int, index["revision"]) + 1
            next_index: dict[str, JsonValue] = {
                "schemaVersion": 1,
                "revision": next_revision,
                "artifacts": entries,
            }
            self._commit(
                lock,
                index_before=index,
                index_after=next_index,
                writes={self._artifact_path(duplicated.id): self._scan_artifact(duplicated)},
            )
        self._publish(StoreMutation("duplicate", (duplicated.id,), next_revision))
        return duplicated

    def promote_candidate(
        self,
        artifact_id: str,
        *,
        expected_revision: int,
        expected_content_hash: str,
    ) -> ToolArtifact:
        current = self.get(artifact_id)
        self._check_artifact_cas(current, expected_revision, expected_content_hash)
        if current.status != "candidate":
            raise ToolStoreValidationError()
        return self.edit(
            artifact_id,
            {"status": "saved"},
            expected_revision=expected_revision,
            expected_content_hash=expected_content_hash,
        )

    def subscribe(self, callback: Callable[[StoreMutation], None]) -> Callable[[], None]:
        if not callable(callback):
            raise ToolStoreValidationError()
        self._subscribers.append(callback)
        active = True

        def unsubscribe() -> None:
            nonlocal active
            if not active:
                return
            active = False
            try:
                self._subscribers.remove(callback)
            except ValueError:
                pass

        return unsubscribe


__all__ = [
    "StoreLock",
    "StoreMutation",
    "ToolArtifactStore",
    "ToolNotFound",
    "ToolRevisionConflict",
    "ToolStoreCorrupt",
    "ToolStoreError",
    "ToolStoreLocked",
    "ToolStoreRevisionConflict",
    "ToolStoreRootChanged",
    "ToolStoreValidationError",
    "ToolStoreWriteError",
    "atomic_write_json",
]
