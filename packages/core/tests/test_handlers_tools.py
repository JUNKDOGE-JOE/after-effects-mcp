from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from ae_mcp import schemas as S
from ae_mcp.handlers import HANDLERS, load_all
from ae_mcp.handlers import tools as handlers
from ae_mcp.skill_store import Skill, SkillStore
from ae_mcp.tool_archive import (
    ImportConflict,
    ImportItemPreview,
    ImportPreview,
    PackageExport,
)
from ae_mcp.tool_artifact import (
    ToolArtifact,
    ToolSource,
    ToolSummary,
    ToolVerification,
    compute_content_hash,
)
from ae_mcp.tool_service import (
    _ToolArtifactStoreView,
    default_tool_service,
    reset_default_tool_service_for_tests,
)


TOOL_VERBS = {
    "ae.toolIndex",
    "ae.toolSearch",
    "ae.toolInspect",
    "ae.toolUse",
    "ae.toolCreate",
    "ae.toolEdit",
    "ae.toolDelete",
    "ae.toolArchive",
    "ae.toolDuplicate",
    "ae.toolPromoteFromHistory",
    "ae.toolImport",
    "ae.toolExport",
}


def _summary(artifact_id: str = "user:00000000-0000-4000-8000-000000000001") -> ToolSummary:
    return ToolSummary(
        id=artifact_id,
        name="Wiggle",
        description="Adds motion",
        kind="jsx",
        category="animation",
        tags=("motion",),
        status="saved",
        verified=False,
        declared_risk="write",
        content_hash="a" * 64,
        revision=2,
        updated_at=30,
        last_used_at=None,
        source_type="user",
    )


def _artifact(*, bundled: bool = False) -> ToolArtifact:
    content = "return 1;"
    digest = compute_content_hash("jsx", content, {})
    verification = (
        ToolVerification("signed-manifest", 0, "b" * 64) if bundled else None
    )
    return ToolArtifact(
        id="builtin:wiggle" if bundled else "user:00000000-0000-4000-8000-000000000001",
        name="Wiggle",
        description="Adds motion",
        kind="jsx",
        category="animation",
        tags=("motion",),
        compatibility={},
        declared_risk="write",
        source=ToolSource(
            "bundled" if bundled else "user",
            "wiggle.json",
            None,
            "0.9.2" if bundled else None,
            {"manifestSha256": "b" * 64} if bundled else {},
        ),
        status="saved",
        verified=bundled,
        verification=verification,
        content=content,
        args_schema={},
        content_hash=digest,
        schema_version=1,
        revision=1,
        created_at=10,
        updated_at=20,
        last_used_at=None,
    )


class _Store:
    def __init__(self) -> None:
        self.summary = _summary()
        self.artifact = _artifact()
        self.calls: list[tuple] = []

    def list(self, **kwargs):
        self.calls.append(("list", kwargs))
        return [self.summary]

    def search(self, query, **kwargs):
        self.calls.append(("search", query, kwargs))
        return [self.summary], 1

    def get(self, artifact_id, **kwargs):
        self.calls.append(("get", artifact_id, kwargs))
        return self.artifact

    def create(self, draft, **kwargs):
        self.calls.append(("create", draft, kwargs))
        return self.artifact

    def edit(self, artifact_id, changes, **kwargs):
        self.calls.append(("edit", artifact_id, changes, kwargs))
        return self.artifact

    def delete(self, artifact_id, **kwargs):
        self.calls.append(("delete", artifact_id, kwargs))

    def archive(self, artifact_id, **kwargs):
        self.calls.append(("archive", artifact_id, kwargs))
        return replace(self.artifact, status="archived")

    def duplicate(self, artifact_id, **kwargs):
        self.calls.append(("duplicate", artifact_id, kwargs))
        return self.artifact

    def promote_candidate(self, artifact_id, **kwargs):
        self.calls.append(("promote", artifact_id, kwargs))
        return self.artifact


class _Execution:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    def render(self, artifact_id, args):
        self.calls.append(("render", artifact_id, args))
        return {"ok": True, "rendered": "x"}

    def prepare(self, artifact_id, *, operation, args, target):
        self.calls.append(("prepare", artifact_id, operation, args, target))
        return SimpleNamespace(public_dict=lambda: {"planHash": "p", "risk": "write"})

    async def request_grant(self, plan_hash, *, requested_scope, ctx):
        self.calls.append(("grant", plan_hash, requested_scope, ctx))
        return SimpleNamespace(
            grant_id="g", plan_hash=plan_hash, scope="once", expires_at=123
        )

    async def execute_tracked(self, plan_hash, grant_id, *, ctx, initiator):
        self.calls.append(("execute", plan_hash, grant_id, ctx, initiator))
        return {"ok": True, "result": 1}

    async def start_job(self, plan_hash, grant_id, *, ctx, initiator):
        self.calls.append(("start", plan_hash, grant_id, ctx, initiator))
        return {"ok": True, "executionId": "e", "status": "queued"}

    def job_status(self, execution_id):
        self.calls.append(("status", execution_id))
        return {"ok": True, "executionId": execution_id, "status": "running"}

    def cancel_job(self, execution_id):
        self.calls.append(("cancel", execution_id))
        return {"ok": True, "executionId": execution_id, "cancelRequested": True}

    def job_history(self, artifact_id, *, limit):
        self.calls.append(("history", artifact_id, limit))
        return {"ok": True, "artifactId": artifact_id, "executions": []}


class _Packages:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    def preview_import(self, path):
        self.calls.append(("preview", path))
        return ImportPreview(
            import_id="imp",
            package_sha256="c" * 64,
            artifacts=(
                ImportItemPreview(
                    summary=_summary(),
                    existing_id=None,
                    metadata_changes={},
                    content_changed=False,
                    calculated_risk="write",
                ),
            ),
            conflicts=(
                ImportConflict("conf", "incoming", "Wiggle", "existing", "a" * 64, "b" * 64),
            ),
            highest_risk="write",
            expires_at=99,
        )

    def commit_import(self, import_id, resolutions):
        self.calls.append(("commit", import_id, resolutions))
        return [_artifact()]

    def discard_import(self, import_id):
        self.calls.append(("discard", import_id))

    def export(self, artifact_ids, path):
        self.calls.append(("export", artifact_ids, path))
        return PackageExport(path=path, package_sha256="d" * 64)


@pytest.fixture
def service(monkeypatch):
    value = SimpleNamespace(store=_Store(), execution=_Execution(), packages=_Packages())
    monkeypatch.setattr(handlers, "default_tool_service", lambda: value)
    return value


def test_exact_tool_handlers_are_registered():
    load_all()
    assert TOOL_VERBS <= set(HANDLERS)


def test_content_hash_lookup_uses_unbounded_native_finder():
    native_row = _summary()

    class Native:
        root = Path("tools")

        def subscribe(self, callback):
            return lambda: None

        def find_by_content_hash(self, kind, content_hash, *, statuses=None):
            assert (kind, content_hash, statuses) == ("jsx", "a" * 64, {"candidate"})
            return [native_row]

        def list(self, **_kwargs):
            raise AssertionError("content-hash lookup must not use a bounded index page")

    class Legacy:
        def list(self):
            return []

    view = _ToolArtifactStoreView(Native(), Legacy())
    assert view.find_by_content_hash(
        "jsx", "a" * 64, statuses={"candidate"}
    ) == [native_row]


def test_composite_search_pages_all_native_matches_before_offset_and_total():
    rows = [replace(_summary(f"user:{index}"), updated_at=index) for index in range(1001)]

    class Native:
        root = Path("tools")

        def subscribe(self, callback):
            return lambda: None

        def search(self, query, *, offset, limit, **_filters):
            assert query == "wiggle"
            return rows[offset : offset + limit], len(rows)

        def list(self, **_kwargs):
            raise AssertionError("search must not use a bounded index page")

    class Legacy:
        def list(self):
            return []

    page, total = _ToolArtifactStoreView(Native(), Legacy()).search(
        "wiggle", offset=1000, limit=1
    )
    assert total == 1001
    assert page == [rows[0]]


def test_default_service_indexes_shadowed_user_and_bundled_skills(monkeypatch, tmp_path):
    reset_default_tool_service_for_tests()
    monkeypatch.setenv("AE_MCP_TOOL_DIR", str(tmp_path / "tools"))
    monkeypatch.setenv("AE_MCP_SKILL_DIR", str(tmp_path / "skills"))
    SkillStore().create(
        Skill(
            name="extendscript-cookbook",
            description="user copy",
            template_type="prompt",
            template="USER",
            args_schema={},
        )
    )
    try:
        rows = default_tool_service().store.list(limit=1000)
        matches = [row for row in rows if row.name == "extendscript-cookbook"]
        assert {row.source_type for row in matches} == {"legacy", "bundled"}
        assert len({row.id for row in matches}) == 2
    finally:
        reset_default_tool_service_for_tests()


def test_default_service_runs_first_upgrade_migration_before_opening_store(
    monkeypatch, tmp_path
):
    reset_default_tool_service_for_tests()
    tool_root = tmp_path / "custom-tools"
    skill_root = tmp_path / "custom-skills"
    monkeypatch.setenv("AE_MCP_TOOL_DIR", str(tool_root))
    monkeypatch.setenv("AE_MCP_SKILL_DIR", str(skill_root))
    SkillStore().create(
        Skill(
            name="legacy-copy",
            description="",
            template_type="prompt",
            template="LEGACY",
            args_schema={},
        )
    )
    try:
        service = default_tool_service()
        marker = json.loads((tool_root / "migration-v1.json").read_text("utf-8"))
        manifest = json.loads(
            (
                tool_root
                / "backups"
                / marker["backupId"]
                / "manifest.json"
            ).read_text("utf-8")
        )

        assert marker["schemaVersion"] == 1
        assert any(
            source["kind"] == "legacy"
            and source["name"] == "custom-skills/legacy-copy.json"
            for source in manifest["sources"]
        )
        assert (
            service.store.list(source_types={"legacy"}, limit=1000)[0].name
            == "legacy-copy"
        )
        assert not list((tool_root / "artifacts").glob("*.json"))
    finally:
        reset_default_tool_service_for_tests()


@pytest.mark.asyncio
async def test_index_and_search_return_summaries_without_content(service):
    index = await handlers._run_tool_index(S.AeToolIndexArgs(), None)
    search = await handlers._run_tool_search(S.AeToolSearchArgs(query="wiggle"), None)

    assert index["ok"] is True
    assert index["artifacts"][0]["id"] == service.store.summary.id
    assert "content" not in index["artifacts"][0]
    assert index["artifacts"][0]["executionCapabilities"]["runtime"] == "jsx"
    assert index["artifacts"][0]["executionCapabilities"]["directRun"]["available"] is True
    assert search["total"] == 1
    assert "content" not in search["artifacts"][0]


@pytest.mark.asyncio
async def test_inspect_only_marks_manifest_verified_bundled_content_as_signed(service):
    service.store.artifact = _artifact(bundled=True)
    trusted = await handlers._run_tool_inspect(
        S.AeToolInspectArgs(artifact_id=service.store.artifact.id), None
    )
    service.store.artifact = replace(
        service.store.artifact,
        verified=False,
        verification=None,
    )
    untrusted = await handlers._run_tool_inspect(
        S.AeToolInspectArgs(artifact_id=service.store.artifact.id), None
    )

    assert trusted["trust"] == "signed-bundled"
    assert trusted["artifact"]["content"] == "return 1;"
    assert trusted["artifact"]["executionCapabilities"]["runtime"] == "jsx"
    assert untrusted["trust"] == "user-untrusted"


@pytest.mark.asyncio
async def test_system_commands_are_hidden_by_default_and_visible_only_as_developer_metadata(service):
    content = "Write-Output blocked"
    digest = compute_content_hash("system-command", content, {})
    service.store.artifact = replace(
        service.store.artifact,
        kind="system-command",
        content=content,
        declared_risk="external",
        content_hash=digest,
    )
    service.store.summary = replace(
        service.store.summary,
        kind="system-command",
        declared_risk="external",
        content_hash=digest,
    )

    ordinary = await handlers._run_tool_index(S.AeToolIndexArgs(), None)
    ordinary_search = await handlers._run_tool_search(
        S.AeToolSearchArgs(query="blocked"), None
    )
    ordinary_inspect = await handlers._run_tool_inspect(
        S.AeToolInspectArgs(artifact_id=service.store.artifact.id), None
    )
    developer = await handlers._run_tool_index(
        S.AeToolIndexArgs(developer_mode=True), None
    )
    developer_inspect = await handlers._run_tool_inspect(
        S.AeToolInspectArgs(
            artifact_id=service.store.artifact.id, developer_mode=True
        ),
        None,
    )

    assert ordinary["artifacts"] == []
    assert ordinary_search["artifacts"] == []
    assert ordinary_inspect["ok"] is False
    assert ordinary_inspect["error"] == "tool_not_found"
    [row] = developer["artifacts"]
    assert row["kind"] == "system-command"
    assert row["executionCapabilities"]["directRun"]["available"] is False
    assert developer_inspect["artifact"]["content"] == content
    assert developer_inspect["artifact"]["executionCapabilities"]["directRun"][
        "disabledReason"
    ]["code"] == "tool_system_command_denied"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "action", ["render", "prepare", "grant", "execute", "start", "status", "cancel", "history"]
)
async def test_tool_use_dispatches_staged_protocol_exactly(service, action):
    ctx = object()
    values = {
        "render": dict(action="render", artifact_id="user:1", args={"x": 1}),
        "prepare": dict(
            action="prepare",
            artifact_id="user:1",
            operation="execute",
            args={"x": 1},
            target={},
        ),
        "grant": dict(action="grant", plan_hash="p", grant_scope="once"),
        "execute": dict(action="execute", plan_hash="p", grant_id="g"),
        "start": dict(action="start", plan_hash="p", grant_id="g"),
        "status": dict(action="status", execution_id="e"),
        "cancel": dict(action="cancel", execution_id="e"),
        "history": dict(action="history", artifact_id="user:1", limit=10),
    }[action]

    result = await handlers._run_tool_use(S.AeToolUseArgs(**values), ctx)

    if action == "prepare":
        assert result == {"planHash": "p", "risk": "write"}
    else:
        assert result["ok"] is True
    assert service.execution.calls[0][0] == action


@pytest.mark.asyncio
async def test_import_and_export_wire_payloads_exclude_source_paths(service, tmp_path):
    preview = await handlers._run_tool_import(
        S.AeToolImportArgs(action="preview", path=str(tmp_path / "in.aemcptools")),
        None,
    )
    exported = await handlers._run_tool_export(
        S.AeToolExportArgs(
            artifact_ids=["user:1"], out_path=str(tmp_path / "out.aemcptools")
        ),
        None,
    )

    assert preview["importId"] == "imp"
    assert preview["artifacts"][0]["contentChanged"] is False
    assert exported == {
        "ok": True,
        "path": str(tmp_path / "out.aemcptools"),
        "packageSha256": "d" * 64,
    }


@pytest.mark.asyncio
async def test_promote_from_history_rejects_imported_candidates(service):
    artifact = service.store.artifact
    service.store.artifact = replace(
        artifact,
        status="candidate",
        source=ToolSource(
            "imported",
            "package:test",
            None,
            None,
            {"contentHash": artifact.content_hash},
        ),
    )
    result = await handlers._run_tool_promote(
        S.AeToolPromoteFromHistoryArgs(
            artifact_id=artifact.id,
            expected_revision=artifact.revision,
            expected_content_hash=artifact.content_hash,
        ),
        None,
    )

    assert result["ok"] is False
    assert result["error"] == "tool_store_invalid_request"
    assert not any(call[0] == "promote" for call in service.store.calls)
