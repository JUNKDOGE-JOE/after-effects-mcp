"""Process-scoped composition for the Tool Library."""

from __future__ import annotations

import os
import threading
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import AbstractSet, cast

from ae_mcp.backends import discovery
from ae_mcp.skill_store import SkillStore
from ae_mcp.tool_archive import ToolPackageManager
from ae_mcp.tool_artifact import (
    ArtifactKind,
    ArtifactRisk,
    ArtifactStatus,
    JsonValue,
    ToolArtifact,
    ToolArtifactDraft,
    ToolSummary,
)
from ae_mcp.tool_audit import ToolAuditLog
from ae_mcp.tool_execution import ToolExecutionEngine
from ae_mcp.tool_execution_history import ExecutionJobStore
from ae_mcp.tool_legacy import LegacyMetadataStore, LegacySkillAdapter
from ae_mcp.tool_migrations import ToolDataMigrator
from ae_mcp.tool_secrets import RegexSecretScanner
from ae_mcp.tool_store import (
    StoreMutation,
    ToolArtifactStore,
    ToolRevisionConflict,
    ToolStoreValidationError,
)


def _summary(artifact: ToolArtifact) -> ToolSummary:
    return ToolSummary(
        id=artifact.id,
        name=artifact.name,
        description=artifact.description,
        kind=artifact.kind,
        category=artifact.category,
        tags=artifact.tags,
        status=artifact.status,
        verified=artifact.verified,
        declared_risk=artifact.declared_risk,
        content_hash=artifact.content_hash,
        revision=artifact.revision,
        updated_at=artifact.updated_at,
        last_used_at=artifact.last_used_at,
        source_type=artifact.source.type,
    )


class _ToolArtifactStoreView(ToolArtifactStore):
    def __init__(self, native: ToolArtifactStore, legacy: LegacySkillAdapter) -> None:
        self.native = native
        self.legacy = legacy
        self.root = native.root
        self._subscribers: list[Callable[[StoreMutation], None]] = []
        self._native_unsubscribe = native.subscribe(self._publish)

    @staticmethod
    def _is_native(artifact_id: str) -> bool:
        return artifact_id.startswith("user:")

    def _publish(self, mutation: StoreMutation) -> None:
        for callback in tuple(self._subscribers):
            try:
                callback(mutation)
            except Exception:
                continue

    def _legacy_summaries(self) -> list[ToolSummary]:
        return [_summary(artifact) for artifact in self.legacy.list()]

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
        rows = self.native.list(limit=1000) + self._legacy_summaries()
        rows = [
            row
            for row in rows
            if (kinds is None or row.kind in kinds)
            and (statuses is None or row.status in statuses)
            and (source_types is None or row.source_type in source_types)
        ]
        rows.sort(key=lambda row: (-row.updated_at, row.id))
        return rows[:limit]

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
        if (
            not isinstance(query, str)
            or isinstance(offset, bool)
            or not isinstance(offset, int)
            or offset < 0
            or isinstance(limit, bool)
            or not isinstance(limit, int)
            or not 1 <= limit <= 1000
        ):
            raise ToolStoreValidationError()
        needle = query.casefold().strip()
        matches: list[ToolSummary] = []
        native_offset = 0
        native_total = 1
        while native_offset < native_total:
            page, native_total = self.native.search(
                query,
                kinds=kinds,
                categories=categories,
                tags=tags,
                risks=risks,
                statuses=statuses,
                source_types=source_types,
                offset=native_offset,
                limit=1000,
            )
            if not page:
                break
            matches.extend(page)
            native_offset += len(page)
        for row in self._legacy_summaries():
            haystack = " ".join(
                (row.name, row.description, row.category, *row.tags)
            ).casefold()
            if needle and needle not in haystack:
                continue
            if kinds is not None and row.kind not in kinds:
                continue
            if categories is not None and row.category not in categories:
                continue
            if tags is not None and not tags.issubset(set(row.tags)):
                continue
            if risks is not None and row.declared_risk not in risks:
                continue
            if statuses is not None and row.status not in statuses:
                continue
            if source_types is not None and row.source_type not in source_types:
                continue
            matches.append(row)
        matches.sort(key=lambda row: (-row.updated_at, row.id))
        return matches[offset : offset + limit], len(matches)

    def find_by_content_hash(
        self,
        kind: ArtifactKind,
        content_hash: str,
        *,
        statuses: AbstractSet[ArtifactStatus] | None = None,
    ) -> list[ToolSummary]:
        rows = self.native.find_by_content_hash(
            kind, content_hash, statuses=statuses
        )
        rows.extend(
            _summary(artifact)
            for artifact in self.legacy.list()
            if artifact.kind == kind
            and artifact.content_hash == content_hash
            and (statuses is None or artifact.status in statuses)
        )
        rows.sort(key=lambda row: (-row.updated_at, row.id))
        return rows

    def get(self, artifact_id: str, *, include_content: bool = True) -> ToolArtifact:
        if self._is_native(artifact_id):
            return self.native.get(artifact_id, include_content=include_content)
        return self.legacy.get(artifact_id)

    def record_use(
        self,
        artifact_id: str,
        *,
        expected_content_hash: str,
        used_at: int,
    ) -> ToolArtifact:
        if self._is_native(artifact_id):
            return self.native.record_use(
                artifact_id,
                expected_content_hash=expected_content_hash,
                used_at=used_at,
            )
        updated = self.legacy.record_use(
            artifact_id,
            expected_content_hash=expected_content_hash,
            used_at=used_at,
        )
        self._publish(StoreMutation("use", (artifact_id,), self.store_revision()))
        return updated

    def create(
        self,
        draft: ToolArtifactDraft,
        *,
        expected_store_revision: int | None = None,
    ) -> ToolArtifact:
        return self.native.create(
            draft, expected_store_revision=expected_store_revision
        )

    def create_many_atomic(
        self,
        drafts: Sequence[ToolArtifactDraft],
        *,
        expected_store_revision: int,
    ) -> list[ToolArtifact]:
        return self.native.create_many_atomic(
            drafts, expected_store_revision=expected_store_revision
        )

    def store_revision(self) -> int:
        return self.native.store_revision()

    def edit(
        self,
        artifact_id: str,
        patch: Mapping[str, JsonValue],
        *,
        expected_revision: int,
        expected_content_hash: str,
        replace_artifact_id: str | None = None,
    ) -> ToolArtifact:
        if self._is_native(artifact_id):
            return self.native.edit(
                artifact_id,
                patch,
                expected_revision=expected_revision,
                expected_content_hash=expected_content_hash,
                replace_artifact_id=replace_artifact_id,
            )
        if replace_artifact_id is not None:
            raise ToolRevisionConflict()
        aliases = {
            "declaredRisk": "declared_risk",
            "argsSchema": "args_schema",
            "verificationAction": "verification_action",
        }
        normalized = {aliases.get(key, key): value for key, value in patch.items()}
        updated = self.legacy.edit(
            artifact_id,
            normalized,
            expected_revision=expected_revision,
            expected_content_hash=expected_content_hash,
        )
        self._publish(StoreMutation("edit", (artifact_id,), self.store_revision()))
        return updated

    def delete(
        self,
        artifact_id: str,
        *,
        expected_revision: int,
        expected_content_hash: str,
    ) -> None:
        if self._is_native(artifact_id):
            self.native.delete(
                artifact_id,
                expected_revision=expected_revision,
                expected_content_hash=expected_content_hash,
            )
            return
        self.legacy.delete(
            artifact_id,
            expected_revision=expected_revision,
            expected_content_hash=expected_content_hash,
        )
        self._publish(StoreMutation("delete", (artifact_id,), self.store_revision()))

    def archive(
        self,
        artifact_id: str,
        *,
        expected_revision: int,
        expected_content_hash: str,
    ) -> ToolArtifact:
        if self._is_native(artifact_id):
            return self.native.archive(
                artifact_id,
                expected_revision=expected_revision,
                expected_content_hash=expected_content_hash,
            )
        updated = self.legacy.archive(
            artifact_id,
            expected_revision=expected_revision,
            expected_content_hash=expected_content_hash,
        )
        self._publish(StoreMutation("archive", (artifact_id,), self.store_revision()))
        return updated

    def duplicate(
        self,
        artifact_id: str,
        *,
        name: str,
        expected_content_hash: str,
    ) -> ToolArtifact:
        if self._is_native(artifact_id):
            return self.native.duplicate(
                artifact_id, name=name, expected_content_hash=expected_content_hash
            )
        draft = self.legacy.duplicate(
            artifact_id, name=name, expected_content_hash=expected_content_hash
        )
        return self.native.create(draft)

    def promote_candidate(
        self,
        artifact_id: str,
        *,
        expected_revision: int,
        expected_content_hash: str,
    ) -> ToolArtifact:
        if self._is_native(artifact_id):
            return self.native.promote_candidate(
                artifact_id,
                expected_revision=expected_revision,
                expected_content_hash=expected_content_hash,
            )
        updated = self.legacy.edit(
            artifact_id,
            {"status": "saved"},
            expected_revision=expected_revision,
            expected_content_hash=expected_content_hash,
        )
        self._publish(StoreMutation("edit", (artifact_id,), self.store_revision()))
        return updated

    def subscribe(
        self, callback: Callable[[StoreMutation], None]
    ) -> Callable[[], None]:
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

    def close(self) -> None:
        self._native_unsubscribe()
        self._subscribers.clear()


@dataclass(frozen=True)
class ToolLibraryService:
    store: ToolArtifactStore
    execution: ToolExecutionEngine
    packages: ToolPackageManager


_default_service: ToolLibraryService | None = None
_default_lock = threading.RLock()


def _configured_root() -> Path:
    configured = os.environ.get("AE_MCP_TOOL_DIR")
    return (
        Path(configured).expanduser()
        if configured
        else Path.home() / ".ae-mcp" / "tools"
    )


def default_tool_service() -> ToolLibraryService:
    global _default_service
    with _default_lock:
        if _default_service is not None:
            return _default_service
        root = _configured_root()
        scanner = RegexSecretScanner()
        skill_store = SkillStore()
        migrator = ToolDataMigrator(
            root=root,
            legacy_roots=(skill_store.root,),
            scanner=scanner,
        )
        migrator.migrate_from_v0_9()
        migrator.prune_backups()
        native = ToolArtifactStore(root=root, scanner=scanner)
        legacy = LegacySkillAdapter(
            skill_store=skill_store,
            metadata_store=LegacyMetadataStore(root / "legacy-metadata.json"),
            scanner=scanner,
        )
        store = _ToolArtifactStoreView(native, legacy)
        execution = ToolExecutionEngine(
            store,
            discovery.select_backend,
            scanner=scanner,
            audit_log=ToolAuditLog(root),
            job_store=ExecutionJobStore(root),
        )
        packages = ToolPackageManager(store, scanner)
        _default_service = ToolLibraryService(
            store=cast(ToolArtifactStore, store),
            execution=execution,
            packages=packages,
        )
        return _default_service


def reset_default_tool_service_for_tests() -> None:
    global _default_service
    with _default_lock:
        service = _default_service
        _default_service = None
    if service is None:
        return
    pending = tuple(getattr(service.packages, "_pending", {}))
    for import_id in pending:
        service.packages.discard_import(import_id)
    service.execution.close()
    close = getattr(service.store, "close", None)
    if callable(close):
        close()


__all__ = [
    "ToolLibraryService",
    "default_tool_service",
    "reset_default_tool_service_for_tests",
]
