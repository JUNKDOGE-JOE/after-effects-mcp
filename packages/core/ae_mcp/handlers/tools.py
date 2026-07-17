"""Handlers for progressive Tool Library discovery and execution."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping, cast

from ae_mcp import client_identity, schemas
from ae_mcp.handlers import register
from ae_mcp.tool_archive import ImportConflict, ImportItemPreview, ImportPreview
from ae_mcp.tool_artifact import (
    ArtifactOperation,
    JsonValue,
    ToolArtifact,
    ToolArtifactDraft,
    ToolSource,
    ToolSummary,
)
from ae_mcp.tool_service import default_tool_service
from ae_mcp.tool_execution import execution_capabilities
from ae_mcp.tool_store import ToolNotFound, ToolRevisionConflict, ToolStoreValidationError


def _error(exc: Exception) -> dict[str, Any]:
    public = getattr(exc, "public_dict", None)
    if callable(public):
        return cast(dict[str, Any], public())
    code = getattr(exc, "code", None)
    if isinstance(code, str):
        return {"ok": False, "error": code, "message": str(exc)}
    return {
        "ok": False,
        "error": "tool_internal_error",
        "message": "Tool Library operation failed.",
    }


def _summary(
    value: ToolSummary,
    execution_capabilities: Mapping[str, JsonValue] | None = None,
) -> dict[str, JsonValue]:
    result: dict[str, JsonValue] = {
        "id": value.id,
        "name": value.name,
        "description": value.description,
        "kind": value.kind,
        "category": value.category,
        "tags": list(value.tags),
        "status": value.status,
        "verified": value.verified,
        "declaredRisk": value.declared_risk,
        "contentHash": value.content_hash,
        "revision": value.revision,
        "updatedAt": value.updated_at,
        "lastUsedAt": value.last_used_at,
        "sourceType": value.source_type,
    }
    if execution_capabilities is not None:
        result["executionCapabilities"] = cast(
            JsonValue, dict(execution_capabilities)
        )
    return result


def _artifact_summary(
    value: ToolArtifact,
    execution_capabilities: Mapping[str, JsonValue] | None = None,
) -> dict[str, JsonValue]:
    return _summary(
        ToolSummary(
            id=value.id,
            name=value.name,
            description=value.description,
            kind=value.kind,
            category=value.category,
            tags=value.tags,
            status=value.status,
            verified=value.verified,
            declared_risk=value.declared_risk,
            content_hash=value.content_hash,
            revision=value.revision,
            updated_at=value.updated_at,
            last_used_at=value.last_used_at,
            source_type=value.source.type,
        ),
        execution_capabilities,
    )


def _summary_with_execution(service: Any, value: ToolSummary) -> dict[str, JsonValue]:
    artifact = service.store.get(value.id, include_content=True)
    return _summary(value, execution_capabilities(artifact))


def _trusted_bundled(value: ToolArtifact) -> bool:
    if (
        value.source.type != "bundled"
        or not value.verified
        or value.verification is None
        or value.verification.method != "signed-manifest"
    ):
        return False
    digest = value.source.provenance.get("manifestSha256")
    return isinstance(digest, str) and digest == value.verification.evidence_hash


async def _run_tool_index(args: schemas.AeToolIndexArgs, ctx: Any) -> Any:
    del ctx
    try:
        statuses = set(args.statuses) if args.statuses is not None else {"saved", "pinned"}
        if args.include_candidates:
            statuses.add("candidate")
        service = default_tool_service()
        requested_kinds = None if args.kinds is None else set(args.kinds)
        if not args.developer_mode:
            allowed = {"jsx", "expression", "prompt-skill", "recipe", "diagnostic"}
            requested_kinds = allowed if requested_kinds is None else requested_kinds & allowed
        rows = service.store.list(
            kinds=cast(Any, requested_kinds),
            statuses=cast(Any, statuses),
            source_types=None if args.source_types is None else set(args.source_types),
            limit=args.limit,
        )
        if not args.developer_mode:
            rows = [row for row in rows if row.kind != "system-command"]
        return {
            "ok": True,
            "artifacts": [_summary_with_execution(service, row) for row in rows],
        }
    except Exception as exc:  # noqa: BLE001
        return _error(exc)


async def _run_tool_search(args: schemas.AeToolSearchArgs, ctx: Any) -> Any:
    del ctx
    try:
        statuses = (
            set(args.statuses) if args.statuses is not None else {"saved", "pinned"}
        )
        service = default_tool_service()
        requested_kinds = None if args.kinds is None else set(args.kinds)
        if not args.developer_mode:
            allowed = {"jsx", "expression", "prompt-skill", "recipe", "diagnostic"}
            requested_kinds = allowed if requested_kinds is None else requested_kinds & allowed
        rows, total = service.store.search(
            args.query,
            kinds=cast(Any, requested_kinds),
            categories=None if args.categories is None else set(args.categories),
            tags=None if args.tags is None else set(args.tags),
            risks=None if args.risks is None else set(args.risks),
            statuses=cast(Any, statuses),
            source_types=None if args.source_types is None else set(args.source_types),
            offset=args.offset,
            limit=args.limit,
        )
        if not args.developer_mode:
            hidden_count = sum(row.kind == "system-command" for row in rows)
            rows = [row for row in rows if row.kind != "system-command"]
            total = max(0, total - hidden_count)
        return {
            "ok": True,
            "artifacts": [_summary_with_execution(service, row) for row in rows],
            "total": total,
            "offset": args.offset,
            "limit": args.limit,
        }
    except Exception as exc:  # noqa: BLE001
        return _error(exc)


async def _run_tool_inspect(args: schemas.AeToolInspectArgs, ctx: Any) -> Any:
    del ctx
    try:
        service = default_tool_service()
        artifact = service.store.get(
            args.artifact_id, include_content=True
        )
        if artifact.kind == "system-command" and not args.developer_mode:
            raise ToolNotFound()
        wire = artifact.to_dict()
        wire["executionCapabilities"] = execution_capabilities(artifact)
        return {
            "ok": True,
            "artifact": wire,
            "trust": "signed-bundled" if _trusted_bundled(artifact) else "user-untrusted",
        }
    except Exception as exc:  # noqa: BLE001
        return _error(exc)


async def _run_tool_use(args: schemas.AeToolUseArgs, ctx: Any) -> Any:
    try:
        service = default_tool_service()
        if args.action == "render":
            return service.execution.render(cast(str, args.artifact_id), args.args)
        if args.action == "prepare":
            return service.execution.prepare(
                cast(str, args.artifact_id),
                operation=cast(ArtifactOperation, args.operation),
                args=args.args,
                target=args.target,
            ).public_dict()
        if args.action == "grant":
            grant = await service.execution.request_grant(
                cast(str, args.plan_hash),
                requested_scope=cast(Any, args.grant_scope),
                ctx=ctx,
            )
            return {
                "ok": True,
                "grantId": grant.grant_id,
                "planHash": grant.plan_hash,
                "scope": grant.scope,
                "expiresAt": grant.expires_at,
            }
        if args.action == "execute":
            return await service.execution.execute_tracked(
                cast(str, args.plan_hash),
                cast(str, args.grant_id),
                ctx=ctx,
                initiator=client_identity.get_client() or "mcp-client",
            )
        if args.action == "start":
            return await service.execution.start_job(
                cast(str, args.plan_hash),
                cast(str, args.grant_id),
                ctx=ctx,
                initiator=client_identity.get_client() or "panel-direct",
            )
        if args.action == "status":
            return service.execution.job_status(cast(str, args.execution_id))
        if args.action == "cancel":
            return service.execution.cancel_job(cast(str, args.execution_id))
        return service.execution.job_history(
            cast(str, args.artifact_id), limit=cast(int, args.limit)
        )
    except Exception as exc:  # noqa: BLE001
        return _error(exc)


async def _run_tool_create(args: schemas.AeToolCreateArgs, ctx: Any) -> Any:
    del ctx
    try:
        draft = ToolArtifactDraft(
            name=args.name,
            description=args.description,
            kind=args.kind,
            category=args.category,
            tags=tuple(args.tags),
            compatibility=cast(Mapping[str, JsonValue], args.compatibility),
            declared_risk=args.declared_risk,
            source=ToolSource(
                type="user",
                ref="manual",
                client=client_identity.get_client(),
                product_version=None,
                provenance={},
            ),
            status=args.status,
            content=cast(Any, args.content),
            args_schema=cast(Mapping[str, JsonValue], args.args_schema),
        )
        artifact = default_tool_service().store.create(
            draft, expected_store_revision=args.expected_store_revision
        )
        return {"ok": True, "artifact": artifact.to_dict()}
    except Exception as exc:  # noqa: BLE001
        return _error(exc)


async def _run_tool_edit(args: schemas.AeToolEditArgs, ctx: Any) -> Any:
    del ctx
    try:
        service = default_tool_service()
        current = service.store.get(args.artifact_id, include_content=True)
        if args.replace_artifact_id is not None and (
            current.status != "candidate" or args.changes.get("status") != "saved"
        ):
            raise ToolStoreValidationError()
        artifact = service.store.edit(
            args.artifact_id,
            cast(Mapping[str, JsonValue], args.changes),
            expected_revision=args.expected_revision,
            expected_content_hash=args.expected_content_hash,
            replace_artifact_id=args.replace_artifact_id,
        )
        return {"ok": True, "artifact": artifact.to_dict()}
    except Exception as exc:  # noqa: BLE001
        return _error(exc)


async def _run_tool_delete(args: schemas.AeToolDeleteArgs, ctx: Any) -> Any:
    del ctx
    try:
        default_tool_service().store.delete(
            args.artifact_id,
            expected_revision=args.expected_revision,
            expected_content_hash=args.expected_content_hash,
        )
        return {"ok": True, "deleted": args.artifact_id}
    except Exception as exc:  # noqa: BLE001
        return _error(exc)


async def _run_tool_archive(args: schemas.AeToolArchiveArgs, ctx: Any) -> Any:
    del ctx
    try:
        artifact = default_tool_service().store.archive(
            args.artifact_id,
            expected_revision=args.expected_revision,
            expected_content_hash=args.expected_content_hash,
        )
        return {"ok": True, "artifact": artifact.to_dict()}
    except Exception as exc:  # noqa: BLE001
        return _error(exc)


async def _run_tool_duplicate(args: schemas.AeToolDuplicateArgs, ctx: Any) -> Any:
    del ctx
    try:
        service = default_tool_service()
        current = service.store.get(args.artifact_id, include_content=False)
        if current.revision != args.expected_revision:
            raise ToolRevisionConflict()
        artifact = service.store.duplicate(
            args.artifact_id,
            name=args.name,
            expected_content_hash=args.expected_content_hash,
        )
        return {"ok": True, "artifact": artifact.to_dict()}
    except Exception as exc:  # noqa: BLE001
        return _error(exc)


async def _run_tool_promote(
    args: schemas.AeToolPromoteFromHistoryArgs, ctx: Any
) -> Any:
    del ctx
    try:
        service = default_tool_service()
        current = service.store.get(args.artifact_id, include_content=True)
        if current.status != "candidate" or current.source.type != "chat-tool-call":
            raise ToolStoreValidationError()
        if args.replace_artifact_id is None:
            artifact = service.store.promote_candidate(
                args.artifact_id,
                expected_revision=args.expected_revision,
                expected_content_hash=args.expected_content_hash,
            )
        else:
            artifact = service.store.edit(
                args.artifact_id,
                {"status": "saved"},
                expected_revision=args.expected_revision,
                expected_content_hash=args.expected_content_hash,
                replace_artifact_id=args.replace_artifact_id,
            )
        return {"ok": True, "artifact": artifact.to_dict()}
    except Exception as exc:  # noqa: BLE001
        return _error(exc)


def _conflict(value: ImportConflict) -> dict[str, JsonValue]:
    return {
        "conflictId": value.conflict_id,
        "incomingId": value.incoming_id,
        "incomingName": value.incoming_name,
        "existingId": value.existing_id,
        "incomingContentHash": value.incoming_content_hash,
        "existingContentHash": value.existing_content_hash,
    }


def _import_item(value: ImportItemPreview) -> dict[str, JsonValue]:
    return {
        "summary": _summary(value.summary),
        "existingId": value.existing_id,
        "metadataChanges": cast(JsonValue, dict(value.metadata_changes)),
        "contentChanged": value.content_changed,
        "calculatedRisk": value.calculated_risk,
    }


def _import_preview(value: ImportPreview) -> dict[str, JsonValue]:
    return {
        "ok": True,
        "importId": value.import_id,
        "packageSha256": value.package_sha256,
        "artifacts": [_import_item(item) for item in value.artifacts],
        "conflicts": [_conflict(item) for item in value.conflicts],
        "highestRisk": value.highest_risk,
        "expiresAt": value.expires_at,
    }


async def _run_tool_import(args: schemas.AeToolImportArgs, ctx: Any) -> Any:
    del ctx
    try:
        packages = default_tool_service().packages
        if args.action == "preview":
            return _import_preview(packages.preview_import(Path(cast(str, args.path))))
        if args.action == "commit":
            artifacts = packages.commit_import(
                cast(str, args.import_id), cast(Any, args.resolutions)
            )
            return {
                "ok": True,
                "artifacts": [_artifact_summary(artifact) for artifact in artifacts],
            }
        packages.discard_import(cast(str, args.import_id))
        return {"ok": True, "discarded": cast(str, args.import_id)}
    except Exception as exc:  # noqa: BLE001
        return _error(exc)


async def _run_tool_export(args: schemas.AeToolExportArgs, ctx: Any) -> Any:
    del ctx
    try:
        package = default_tool_service().packages.export(
            args.artifact_ids, Path(args.out_path)
        )
        return {
            "ok": True,
            "path": str(package.path),
            "packageSha256": package.package_sha256,
        }
    except Exception as exc:  # noqa: BLE001
        return _error(exc)


register("ae.toolIndex", schemas.AeToolIndexArgs, _run_tool_index)
register("ae.toolSearch", schemas.AeToolSearchArgs, _run_tool_search)
register("ae.toolInspect", schemas.AeToolInspectArgs, _run_tool_inspect)
register("ae.toolUse", schemas.AeToolUseArgs, _run_tool_use)
register("ae.toolCreate", schemas.AeToolCreateArgs, _run_tool_create)
register("ae.toolEdit", schemas.AeToolEditArgs, _run_tool_edit)
register("ae.toolDelete", schemas.AeToolDeleteArgs, _run_tool_delete)
register("ae.toolArchive", schemas.AeToolArchiveArgs, _run_tool_archive)
register("ae.toolDuplicate", schemas.AeToolDuplicateArgs, _run_tool_duplicate)
register(
    "ae.toolPromoteFromHistory",
    schemas.AeToolPromoteFromHistoryArgs,
    _run_tool_promote,
)
register("ae.toolImport", schemas.AeToolImportArgs, _run_tool_import)
register("ae.toolExport", schemas.AeToolExportArgs, _run_tool_export)


__all__ = [
    "_run_tool_archive",
    "_run_tool_create",
    "_run_tool_delete",
    "_run_tool_duplicate",
    "_run_tool_edit",
    "_run_tool_export",
    "_run_tool_import",
    "_run_tool_index",
    "_run_tool_inspect",
    "_run_tool_promote",
    "_run_tool_search",
    "_run_tool_use",
]
