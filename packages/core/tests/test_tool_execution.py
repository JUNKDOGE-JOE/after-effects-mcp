from __future__ import annotations

import asyncio
import dataclasses
import re
from pathlib import Path
from types import SimpleNamespace

import pytest
from mcp.types import ToolAnnotations

from ae_mcp import tool_execution as execution_module
from ae_mcp.backends.native import NativeBackendError
from ae_mcp.handlers import HANDLERS, load_all
from ae_mcp.tool_artifact import (
    ToolArtifact,
    ToolSource,
    compute_content_hash,
)
from ae_mcp.tool_audit import ToolAuditLog
from ae_mcp.tool_execution import (
    GRANT_TTL_MS,
    PLAN_TTL_MS,
    ExecutionPlan,
    GrantStore,
    PreparedPlanStore,
    ToolExecutionEngine,
    ToolExecutionError,
    analyze_artifact_risk,
    analyze_jsx,
    compute_plan_hash,
    execution_capabilities,
    normalize_args,
    normalize_target,
)
from ae_mcp.tool_store import StoreMutation


def _source() -> ToolSource:
    return ToolSource(
        type="user",
        ref="manual",
        client=None,
        product_version=None,
        provenance={},
    )


def _artifact(
    artifact_id: str = "user:one",
    *,
    kind: str = "jsx",
    content="return 1;",
    args_schema=None,
    declared_risk: str = "read",
    status: str = "saved",
    compatibility=None,
) -> ToolArtifact:
    schema = {} if args_schema is None else args_schema
    return ToolArtifact(
        id=artifact_id,
        name=artifact_id,
        description="",
        kind=kind,
        category="workflow",
        tags=(),
        compatibility={} if compatibility is None else compatibility,
        declared_risk=declared_risk,
        source=_source(),
        status=status,
        verified=False,
        verification=None,
        content=content,
        args_schema=schema,
        content_hash=compute_content_hash(kind, content, schema),
        schema_version=1,
        revision=1,
        created_at=1,
        updated_at=1,
        last_used_at=None,
    )


class _Store:
    def __init__(self, *artifacts: ToolArtifact) -> None:
        self.artifacts = {artifact.id: artifact for artifact in artifacts}
        self.callbacks = []
        self.uses = []

    def get(self, artifact_id, *, include_content=True):
        return self.artifacts[artifact_id]

    def subscribe(self, callback):
        self.callbacks.append(callback)

        def unsubscribe():
            if callback in self.callbacks:
                self.callbacks.remove(callback)

        return unsubscribe

    def replace(self, artifact: ToolArtifact, *, publish: bool = False) -> None:
        self.artifacts[artifact.id] = artifact
        if publish:
            event = StoreMutation("edit", (artifact.id,), 2)
            for callback in tuple(self.callbacks):
                callback(event)

    def record_use(self, artifact_id, *, expected_content_hash, used_at):
        artifact = self.artifacts[artifact_id]
        if artifact.content_hash != expected_content_hash:
            raise RuntimeError("stale")
        self.uses.append((artifact_id, expected_content_hash, used_at))
        self.artifacts[artifact_id] = dataclasses.replace(
            artifact, last_used_at=used_at
        )
        return self.artifacts[artifact_id]


class _Backend:
    name = "audit-backend"

    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.calls = []

    async def exec(self, code, **kwargs):
        self.calls.append({"code": code, **kwargs})
        if self.error is not None:
            raise self.error
        return '{"ok":true}'


class _Factory:
    def __init__(self, backend: _Backend, before_return=None) -> None:
        self.backend = backend
        self.before_return = before_return
        self.calls = 0

    def __call__(self):
        self.calls += 1
        if self.before_return is not None:
            self.before_return()
        return self.backend


def _plan(
    *,
    artifact_id="user:one",
    content_hash="a" * 64,
    operation="execute",
    args=None,
    target=None,
    dependencies=(),
    risk="write",
    expires_at=999_999,
) -> ExecutionPlan:
    normalized_args = {} if args is None else args
    normalized_target = {} if target is None else target
    plan_hash = compute_plan_hash(
        artifact_id,
        content_hash,
        operation,
        normalized_args,
        normalized_target,
        dependencies,
        risk,
    )
    return ExecutionPlan(
        artifact_id=artifact_id,
        content_hash=content_hash,
        operation=operation,
        normalized_args=normalized_args,
        target=normalized_target,
        dependency_hashes=dependencies,
        plan_hash=plan_hash,
        risk=risk,
        expires_at=expires_at,
    )


@pytest.mark.parametrize(
    "source",
    [
        "File('/tmp/x')",
        "Folder('/tmp')",
        "new Socket()",
        "system.callSystem('whoami')",
        "app.open(project)",
        "app.project.importFile(options)",
    ],
)
def test_external_jsx_patterns_are_highest_risk(source):
    assert analyze_jsx(source) == "external"


@pytest.mark.parametrize(
    "source",
    [
        "layer.remove()",
        "app.purge(PurgeTarget.ALL_CACHES)",
        "app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES)",
        "eval(source)",
        "Function(source)()",
    ],
)
def test_destructive_jsx_patterns_are_detected(source):
    assert analyze_jsx(source) == "destructive"


def test_arbitrary_jsx_defaults_to_write_and_declared_risk_only_raises():
    safe = _artifact(content="return 1;", declared_risk="read")
    raised = _artifact(content="return 1;", declared_risk="destructive")
    external = _artifact(content="File('/tmp/x')", declared_risk="read")

    assert analyze_artifact_risk(safe, "execute", rendered="return 1;") == "write"
    assert analyze_artifact_risk(raised, "execute", rendered="return 1;") == "destructive"
    assert analyze_artifact_risk(external, "execute", rendered="File('/tmp/x')") == "external"


def test_expression_render_is_read_and_apply_is_write():
    artifact = _artifact(kind="expression", content="time * 2")

    assert analyze_artifact_risk(artifact, "render", rendered="time * 2") == "read"
    assert analyze_artifact_risk(artifact, "apply", rendered="time * 2") == "write"


def test_normalize_args_applies_defaults_bounds_and_closed_object_rules():
    schema = {
        "type": "object",
        "properties": {
            "count": {"type": "integer", "minimum": 1, "maximum": 3},
            "label": {
                "type": "string",
                "default": "ok",
                "minLength": 2,
                "maxLength": 4,
            },
        },
        "required": ["count"],
        "additionalProperties": False,
    }

    assert normalize_args(schema, {"count": 2}) == {"count": 2, "label": "ok"}
    with pytest.raises(ToolExecutionError) as unknown:
        normalize_args(schema, {"count": 2, "extra": True})
    with pytest.raises(ToolExecutionError) as out_of_range:
        normalize_args(schema, {"count": 4})
    assert unknown.value.code == "tool_invalid_args"
    assert out_of_range.value.code == "tool_invalid_args"


def test_normalize_target_enforces_each_kind_contract():
    assert normalize_target("jsx", "execute", {"b": 2, "a": 1}) == {"a": 1, "b": 2}
    assert normalize_target("expression", "render", {}) == {}
    assert normalize_target(
        "expression",
        "apply",
        {"compId": "7", "layerId": 1, "path": "Transform/Position"},
    )["layerId"] == 1
    assert normalize_target("prompt-skill", "render", {}) == {}
    assert normalize_target("diagnostic", "execute", {}) == {}

    with pytest.raises(ToolExecutionError):
        normalize_target(
            "expression",
            "apply",
            {"compId": "7", "layerId": 0, "path": "Transform/Position"},
        )
    with pytest.raises(ToolExecutionError):
        normalize_target("prompt-skill", "render", {"unexpected": True})


@pytest.mark.parametrize("status", ["candidate", "archived", "deprecated"])
def test_blocked_status_fails_before_backend_selection(status):
    artifact = _artifact(status=status)
    factory = _Factory(_Backend())
    engine = ToolExecutionEngine(_Store(artifact), factory)

    with pytest.raises(ToolExecutionError) as caught:
        engine.prepare(artifact.id, operation="execute", args={}, target={})

    assert caught.value.code == "tool_status_blocked"
    assert factory.calls == 0


def test_server_execution_capabilities_identify_native_recipes_and_compatibility():
    native = _artifact(
        kind="recipe",
        content={
            "steps": [
                {
                    "refType": "tool",
                    "ref": "ae.projectSummary",
                    "operation": "call",
                    "args": {},
                    "target": {},
                }
            ]
        },
    )
    described = execution_capabilities(native)
    assert described["runtime"] == "native-aegp"
    assert described["directRun"]["available"] is True
    assert described["directRun"]["operation"] == "execute"
    incompatible = dataclasses.replace(native, compatibility={"platforms": ["windows"]})
    if execution_module.sys.platform == "darwin":
        blocked = execution_capabilities(incompatible)
        assert blocked["directRun"]["available"] is False
        assert blocked["directRun"]["disabledReason"]["code"] == "tool_platform_incompatible"


def test_system_commands_are_never_plannable_or_directly_executable():
    command = _artifact(
        kind="system-command",
        content="Write-Output blocked",
        declared_risk="external",
    )
    described = execution_capabilities(command)
    assert described["operations"] == []
    assert described["directRun"]["available"] is False
    assert described["directRun"]["disabledReason"]["code"] == "tool_system_command_denied"
    engine = ToolExecutionEngine(_Store(command), _Factory(_Backend()))
    with pytest.raises(ToolExecutionError) as caught:
        engine.prepare(command.id, operation="execute", args={}, target={})
    assert caught.value.code == "tool_system_command_denied"


def test_prompt_render_returns_untrusted_context_without_backend():
    artifact = _artifact(
        kind="prompt-skill",
        content="Summarize ${topic}",
        args_schema={"topic": {"type": "string"}},
    )
    factory = _Factory(_Backend())
    engine = ToolExecutionEngine(_Store(artifact), factory)

    result = engine.render(artifact.id, {"topic": "layers"})

    assert result == {
        "ok": True,
        "artifactId": artifact.id,
        "contentHash": artifact.content_hash,
        "trust": "user-untrusted",
        "untrustedContext": {
            "kind": "prompt-skill",
            "content": "Summarize layers",
        },
    }
    assert factory.calls == 0


def test_diagnostic_rejects_capabilities_outside_exact_allowlist():
    artifact = _artifact(
        kind="diagnostic",
        content={"capability": "ae.status", "args": {}},
    )
    engine = ToolExecutionEngine(_Store(artifact), _Factory(_Backend()))

    with pytest.raises(ToolExecutionError) as caught:
        engine.prepare(artifact.id, operation="execute", args={}, target={})

    assert caught.value.code == "tool_diagnostic_forbidden"


def test_diagnostic_risk_tracks_current_handler_annotations(monkeypatch):
    artifact = _artifact(
        kind="diagnostic",
        content={"capability": "ae.ping", "args": {}},
    )
    engine = ToolExecutionEngine(_Store(artifact), _Factory(_Backend()))
    baseline = engine.prepare(artifact.id, operation="execute", args={}, target={})
    monkeypatch.setitem(
        execution_module.VERB_ANNOTATIONS,
        "ae.ping",
        ToolAnnotations(
            readOnlyHint=False,
            destructiveHint=True,
            idempotentHint=False,
        ),
    )

    raised = engine.prepare(artifact.id, operation="execute", args={}, target={})

    assert baseline.risk == "read"
    assert raised.risk == "destructive"
    assert baseline.plan_hash != raised.plan_hash
    assert baseline.dependency_hashes != raised.dependency_hashes


def test_recipe_child_hashes_and_current_handler_contract_enter_plan_hash(monkeypatch):
    child = _artifact("user:child", content="return 1;")
    root = _artifact(
        "user:root",
        kind="recipe",
        content={
            "steps": [
                {
                    "refType": "artifact",
                    "ref": child.id,
                    "operation": "execute",
                    "args": {},
                    "target": {},
                },
                {
                    "refType": "tool",
                    "ref": "ae.ping",
                    "operation": "call",
                    "args": {},
                    "target": {},
                },
            ]
        },
    )
    store = _Store(root, child)
    engine = ToolExecutionEngine(store, _Factory(_Backend()))
    first = engine.prepare(root.id, operation="execute", args={}, target={})
    changed_child = _artifact(child.id, content="return 2;")
    store.replace(changed_child)
    second = engine.prepare(root.id, operation="execute", args={}, target={})
    monkeypatch.setitem(
        execution_module.VERB_ANNOTATIONS,
        "ae.ping",
        ToolAnnotations(
            readOnlyHint=False,
            destructiveHint=True,
            idempotentHint=False,
        ),
    )
    third = engine.prepare(root.id, operation="execute", args={}, target={})

    assert (child.id, child.content_hash) in first.dependency_hashes
    assert first.plan_hash != second.plan_hash
    assert second.plan_hash != third.plan_hash
    assert third.risk == "destructive"


def test_recipe_cycle_and_step_limit_are_rejected():
    cyclic = _artifact(
        "user:cycle",
        kind="recipe",
        content={
            "steps": [
                {
                    "refType": "artifact",
                    "ref": "user:cycle",
                    "operation": "execute",
                    "args": {},
                    "target": {},
                }
            ]
        },
    )
    steps = [
        {
            "refType": "tool",
            "ref": "ae.ping",
            "operation": "call",
            "args": {},
            "target": {},
        }
        for _index in range(65)
    ]
    oversized = _artifact("user:steps", kind="recipe", content={"steps": steps})

    with pytest.raises(ToolExecutionError) as cycle_error:
        ToolExecutionEngine(_Store(cyclic), _Factory(_Backend())).prepare(
            cyclic.id, operation="execute", args={}, target={}
        )
    with pytest.raises(ToolExecutionError) as step_error:
        ToolExecutionEngine(_Store(oversized), _Factory(_Backend())).prepare(
            oversized.id, operation="execute", args={}, target={}
        )

    assert cycle_error.value.code == "tool_recipe_cycle"
    assert step_error.value.code == "tool_recipe_steps"


def test_recipe_depth_limit_is_eight():
    artifacts = []
    leaf = _artifact("user:depth-8")
    artifacts.append(leaf)
    child_id = leaf.id
    for depth in range(7, 0, -1):
        artifact = _artifact(
            f"user:depth-{depth}",
            kind="recipe",
            content={
                "steps": [
                    {
                        "refType": "artifact",
                        "ref": child_id,
                        "operation": "execute",
                        "args": {},
                        "target": {},
                    }
                ]
            },
        )
        artifacts.append(artifact)
        child_id = artifact.id
    store = _Store(*artifacts)
    engine = ToolExecutionEngine(store, _Factory(_Backend()))

    engine.prepare("user:depth-1", operation="execute", args={}, target={})

    ninth = _artifact("user:depth-9")
    store.replace(ninth)
    eighth = store.artifacts["user:depth-8"]
    store.replace(
        _artifact(
            eighth.id,
            kind="recipe",
            content={
                "steps": [
                    {
                        "refType": "artifact",
                        "ref": ninth.id,
                        "operation": "execute",
                        "args": {},
                        "target": {},
                    }
                ]
            },
        )
    )
    with pytest.raises(ToolExecutionError) as caught:
        engine.prepare("user:depth-1", operation="execute", args={}, target={})
    assert caught.value.code == "tool_recipe_depth"


def test_plan_hash_binds_args_target_content_schema_and_dependencies():
    base_content = compute_content_hash("jsx", "return 1;", {})
    schema_content = compute_content_hash(
        "jsx", "return 1;", {"count": {"type": "integer"}}
    )
    base = _plan(content_hash=base_content)

    variants = [
        _plan(content_hash=base_content, args={"count": 1}),
        _plan(content_hash=base_content, target={"compId": "7"}),
        _plan(content_hash="f" * 64),
        _plan(content_hash=schema_content),
        _plan(content_hash=base_content, dependencies=(("user:child", "e" * 64),)),
    ]

    assert all(item.plan_hash != base.plan_hash for item in variants)


def test_prepared_plan_and_grant_ttls_are_enforced():
    now = [10]
    prepared = PreparedPlanStore(now=lambda: now[0])
    grants = GrantStore(now=lambda: now[0], random_bytes=lambda size: b"x" * size)
    plan = dataclasses.replace(_plan(), expires_at=10 + PLAN_TTL_MS)
    prepared.put(plan)
    grant = grants.issue_once(plan)

    assert grant.expires_at == 10 + GRANT_TTL_MS
    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", grant.grant_id)
    now[0] = grant.expires_at
    with pytest.raises(ToolExecutionError) as grant_error:
        grants.consume(grant.grant_id, plan)
    assert grant_error.value.code == "tool_grant_expired"
    now[0] = plan.expires_at
    with pytest.raises(ToolExecutionError) as plan_error:
        prepared.get(plan.plan_hash)
    assert plan_error.value.code == "tool_plan_expired"


def test_one_time_grant_is_consumed_once_only():
    grants = GrantStore(random_bytes=lambda size: b"y" * size)
    plan = _plan(expires_at=10**15)
    grant = grants.issue_once(plan)

    assert grants.consume(grant.grant_id, plan) == grant
    with pytest.raises(ToolExecutionError) as caught:
        grants.consume(grant.grant_id, plan)
    assert caught.value.code == "tool_grant_invalid"


def test_session_allowance_binds_identity_content_operation_and_target_not_args():
    grants = GrantStore()
    original = _plan(args={"count": 1}, target={"compId": "7"}, expires_at=10**15)
    grants.allow_session(original)

    same_scope_new_args = _plan(
        args={"count": 2}, target={"compId": "7"}, expires_at=10**15
    )
    assert grants.issue_from_session(same_scope_new_args) is not None
    assert grants.issue_from_session(
        _plan(
            artifact_id="user:other",
            args={"count": 2},
            target={"compId": "7"},
            expires_at=10**15,
        )
    ) is None
    assert grants.issue_from_session(
        _plan(content_hash="b" * 64, target={"compId": "7"}, expires_at=10**15)
    ) is None
    assert grants.issue_from_session(
        _plan(operation="apply", target={"compId": "7"}, expires_at=10**15)
    ) is None
    assert grants.issue_from_session(
        _plan(target={"compId": "8"}, expires_at=10**15)
    ) is None


@pytest.mark.parametrize("risk", ["read", "destructive", "external"])
def test_session_allowance_is_for_write_risk_only(risk):
    with pytest.raises(ToolExecutionError) as caught:
        GrantStore().allow_session(_plan(risk=risk, expires_at=10**15))
    assert caught.value.code == "tool_session_forbidden"


def test_store_mutation_revokes_plans_grants_allowances_and_dependents():
    child = _artifact("user:child")
    root = _artifact(
        "user:root",
        kind="recipe",
        content={
            "steps": [
                {
                    "refType": "artifact",
                    "ref": child.id,
                    "operation": "execute",
                    "args": {},
                    "target": {},
                }
            ]
        },
    )
    store = _Store(root, child)
    engine = ToolExecutionEngine(store, _Factory(_Backend()))
    plan = engine.prepare(root.id, operation="execute", args={}, target={})
    grant = engine.grants.allow_session(plan)
    store.replace(_artifact(child.id, content="return 2;"), publish=True)

    with pytest.raises(ToolExecutionError):
        engine.prepared_plans.get(plan.plan_hash)
    with pytest.raises(ToolExecutionError):
        engine.grants.consume(grant.grant_id, plan)
    assert engine.grants.issue_from_session(plan) is None


@pytest.mark.asyncio
async def test_render_plan_never_selects_or_calls_backend():
    expression = _artifact("user:expression", kind="expression", content="time * 2")
    factory = _Factory(_Backend())
    engine = ToolExecutionEngine(_Store(expression), factory)
    plan = engine.prepare(expression.id, operation="render", args={}, target={})
    grant = engine.grants.issue_once(plan)

    result = await engine.execute(plan.plan_hash, grant.grant_id, ctx=None)

    assert result["rendered"] == "time * 2"
    assert result["trust"] == "user-untrusted"
    assert factory.calls == 0


@pytest.mark.asyncio
async def test_recipe_child_render_never_executes_rendered_jsx():
    child = _artifact("user:child", content="app.project.close()")
    root = _artifact(
        "user:root",
        kind="recipe",
        content={
            "steps": [
                {
                    "refType": "artifact",
                    "ref": child.id,
                    "operation": "render",
                    "args": {},
                    "target": {},
                }
            ]
        },
    )
    factory = _Factory(_Backend())
    engine = ToolExecutionEngine(_Store(root, child), factory)
    plan = engine.prepare(root.id, operation="execute", args={}, target={})
    grant = engine.grants.issue_once(plan)

    result = await engine.execute(plan.plan_hash, grant.grant_id, ctx=None)

    assert result["results"][0]["rendered"] == "app.project.close()"
    assert factory.calls == 0


@pytest.mark.asyncio
async def test_backend_selection_cannot_open_a_toctou_window():
    original = _artifact(content="return 'approved';")
    store = _Store(original)
    backend = _Backend()
    factory = _Factory(
        backend,
        before_return=lambda: store.replace(
            _artifact(original.id, content="File('/tmp/unapproved')")
        ),
    )
    engine = ToolExecutionEngine(store, factory)
    plan = engine.prepare(original.id, operation="execute", args={}, target={})
    grant = engine.grants.issue_once(plan)

    with pytest.raises(ToolExecutionError) as caught:
        await engine.execute(plan.plan_hash, grant.grant_id, ctx=None)

    assert caught.value.code == "tool_plan_stale"
    assert backend.calls == []


@pytest.mark.asyncio
async def test_execute_rejects_a_stale_artifact_before_backend_selection():
    original = _artifact(content="return 'approved';")
    store = _Store(original)
    factory = _Factory(_Backend())
    engine = ToolExecutionEngine(store, factory)
    plan = engine.prepare(original.id, operation="execute", args={}, target={})
    grant = engine.grants.issue_once(plan)
    store.replace(_artifact(original.id, content="return 'changed';"))

    with pytest.raises(ToolExecutionError) as caught:
        await engine.execute(plan.plan_hash, grant.grant_id, ctx=None)

    assert caught.value.code == "tool_plan_stale"
    assert factory.calls == 0


@pytest.mark.asyncio
async def test_secret_denial_audit_never_persists_the_matched_key(
    tmp_path: Path,
) -> None:
    artifact = _artifact(args_schema={})
    backend = _Backend()
    audit = ToolAuditLog(tmp_path)
    engine = ToolExecutionEngine(_Store(artifact), backend, audit_log=audit)
    secret_key = "sk-abcdefghijk"
    plan = engine.prepare(
        artifact.id,
        operation="execute",
        args={secret_key: 1},
        target={},
    )
    grant = engine.grants.issue_once(plan)

    with pytest.raises(ToolExecutionError) as caught:
        await engine.execute(plan.plan_hash, grant.grant_id, ctx=None)

    persisted = (tmp_path / "audit.jsonl").read_text(encoding="utf-8")
    assert caught.value.code == "tool_secret_detected"
    assert secret_key not in persisted
    assert backend.calls == []
    assert audit.list()[-1].outcome == "denied"


@pytest.mark.asyncio
async def test_execution_rejects_nested_credential_named_values(
    tmp_path: Path,
) -> None:
    artifact = _artifact(args_schema={})
    backend = _Backend()
    audit = ToolAuditLog(tmp_path)
    engine = ToolExecutionEngine(_Store(artifact), backend, audit_log=audit)
    secret = "opaque-value-without-known-prefix"
    plan = engine.prepare(
        artifact.id,
        operation="execute",
        args={"nested": {"client_secret": secret}},
        target={},
    )
    grant = engine.grants.issue_once(plan)
    with pytest.raises(ToolExecutionError) as caught:
        await engine.execute(plan.plan_hash, grant.grant_id, ctx=None)
    persisted = (tmp_path / "audit.jsonl").read_text(encoding="utf-8")
    assert caught.value.code == "tool_secret_detected"
    assert secret not in persisted
    assert backend.calls == []


@pytest.mark.asyncio
async def test_grant_denial_audit_redacts_secret_shaped_keys_before_scan(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.delenv("AE_MCP_TOOL_APPROVAL_TIER_FILE", raising=False)
    artifact = _artifact(args_schema={})
    secret_key = "sk-abcdefghijk"
    audit = ToolAuditLog(tmp_path)
    engine = ToolExecutionEngine(_Store(artifact), _Backend(), audit_log=audit)
    plan = engine.prepare(
        artifact.id,
        operation="execute",
        args={secret_key: 1},
        target={},
    )

    with pytest.raises(ToolExecutionError) as caught:
        await engine.request_grant(
            plan.plan_hash,
            requested_scope="once",
            ctx=SimpleNamespace(session=object()),
        )

    persisted = (tmp_path / "audit.jsonl").read_text(encoding="utf-8")
    assert caught.value.code == "tool_plan_elicitation_unavailable"
    assert secret_key not in persisted
    assert audit.list()[-1].outcome == "denied"


@pytest.mark.asyncio
async def test_backend_failure_audit_keeps_backend_name_and_no_exception_text(
    tmp_path: Path,
) -> None:
    artifact = _artifact()
    private_error = "private backend path and token"
    backend = _Backend(RuntimeError(private_error))
    audit = ToolAuditLog(tmp_path)
    engine = ToolExecutionEngine(_Store(artifact), backend, audit_log=audit)
    plan = engine.prepare(artifact.id, operation="execute", args={}, target={})
    grant = engine.grants.issue_once(plan)

    with pytest.raises(ToolExecutionError) as caught:
        await engine.execute(plan.plan_hash, grant.grant_id, ctx=SimpleNamespace())

    [record] = audit.list()
    persisted = (tmp_path / "audit.jsonl").read_text(encoding="utf-8")
    assert caught.value.code == "tool_backend_failed"
    assert record.backend == "audit-backend"
    assert record.engine == "maintained-jsx"
    assert record.outcome == "backend-error"
    assert private_error not in persisted


@pytest.mark.asyncio
async def test_execution_jobs_dedupe_report_history_audit_and_usage(tmp_path: Path):
    artifact = _artifact()
    store = _Store(artifact)
    audit = ToolAuditLog(tmp_path)
    engine = ToolExecutionEngine(store, _Backend(), audit_log=audit)
    plan = engine.prepare(artifact.id, operation="execute", args={}, target={})
    grant = engine.grants.issue_once(plan)

    first = await engine.start_job(
        plan.plan_hash,
        grant.grant_id,
        operation_id="operation-dedupe-0001",
        ctx=None,
        initiator="panel-direct",
    )
    duplicate = await engine.start_job(
        plan.plan_hash,
        grant.grant_id,
        operation_id="operation-dedupe-0001",
        ctx=None,
        initiator="panel-direct",
    )
    assert duplicate["executionId"] == first["executionId"]
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    status = engine.job_status(first["executionId"])
    assert status["status"] == "succeeded"
    assert status["terminal"] is True
    assert status["audit"]["planHash"] == plan.plan_hash
    assert status["audit"]["outcome"] == "success"
    assert store.uses and store.uses[0][0] == artifact.id
    replacement_grant = engine.grants.issue_once(plan)
    late_duplicate = await engine.start_job(
        plan.plan_hash,
        replacement_grant.grant_id,
        operation_id="operation-dedupe-0001",
        ctx=None,
        initiator="panel-direct",
    )
    assert late_duplicate["executionId"] == first["executionId"]
    history = engine.job_history(artifact.id)
    assert [row["executionId"] for row in history["executions"]] == [
        first["executionId"]
    ]


class _BlockingBackend(_Backend):
    def __init__(self) -> None:
        super().__init__()
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def exec(self, code, **kwargs):
        self.calls.append({"code": code, **kwargs})
        self.started.set()
        await self.release.wait()
        return '{"ok":true}'


@pytest.mark.asyncio
async def test_running_cancel_never_claims_ae_stopped_and_late_success_wins():
    artifact = _artifact()
    backend = _BlockingBackend()
    engine = ToolExecutionEngine(_Store(artifact), backend)
    plan = engine.prepare(artifact.id, operation="execute", args={}, target={})
    grant = engine.grants.issue_once(plan)
    started = await engine.start_job(
        plan.plan_hash,
        grant.grant_id,
        operation_id="operation-cancel-running",
        ctx=None,
        initiator="panel-direct",
    )
    await backend.started.wait()

    cancellation = engine.cancel_job(started["executionId"])
    assert cancellation["cancelDisposition"] == "not-cancellable-after-dispatch"
    assert cancellation["terminal"] is False
    assert cancellation["cancelRequested"] is True
    backend.release.set()
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    completed = engine.job_status(started["executionId"])
    assert completed["status"] == "succeeded"
    assert completed["cancelRequested"] is True


@pytest.mark.asyncio
async def test_queued_cancel_prevents_dispatch_and_consumes_the_grant():
    artifact = _artifact()
    backend = _Backend()
    engine = ToolExecutionEngine(_Store(artifact), backend)
    plan = engine.prepare(artifact.id, operation="execute", args={}, target={})
    grant = engine.grants.issue_once(plan)
    started = await engine.start_job(
        plan.plan_hash,
        grant.grant_id,
        operation_id="operation-cancel-queued",
        ctx=None,
        initiator="panel-direct",
    )
    cancellation = engine.cancel_job(started["executionId"])
    assert cancellation["cancelDisposition"] == "cancelled-before-dispatch"
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert engine.job_status(started["executionId"])["status"] == "cancelled"
    assert backend.calls == []
    with pytest.raises(ToolExecutionError) as caught:
        engine.grants.peek(grant.grant_id, plan)
    assert caught.value.code == "tool_grant_invalid"


@pytest.mark.asyncio
async def test_job_timeout_is_reported_as_outcome_unknown_not_stopped():
    artifact = _artifact()
    backend = _Backend(asyncio.TimeoutError())
    engine = ToolExecutionEngine(_Store(artifact), backend)
    plan = engine.prepare(artifact.id, operation="execute", args={}, target={})
    grant = engine.grants.issue_once(plan)
    started = await engine.start_job(
        plan.plan_hash,
        grant.grant_id,
        operation_id="operation-timeout-unknown",
        ctx=None,
        initiator="panel-direct",
    )
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    status = engine.job_status(started["executionId"])
    assert status["status"] == "outcome-unknown"
    assert status["outcomeUnknown"] is True
    assert status["error"]["code"] == "tool_backend_timeout"


@pytest.mark.asyncio
async def test_native_uncertain_write_keeps_recovery_and_is_never_blindly_retried(
    tmp_path: Path,
    monkeypatch,
):
    load_all()
    schema, _original = HANDLERS["ae.ping"]
    calls = 0

    async def uncertain_native(_args, _ctx):
        nonlocal calls
        calls += 1
        raise NativeBackendError(
            "POSSIBLY_SIDE_EFFECTING_FAILURE",
            "The native write may have completed.",
            retryable=False,
            side_effect="may-have-occurred",
            recovery={
                "action": "inspect-state",
                "hint": "Inspect AE state and audit evidence before retrying.",
            },
        )

    monkeypatch.setitem(HANDLERS, "ae.ping", (schema, uncertain_native))
    artifact = _artifact(
        kind="recipe",
        content={
            "steps": [
                {
                    "refType": "tool",
                    "ref": "ae.ping",
                    "operation": "call",
                    "args": {},
                    "target": {},
                }
            ]
        },
    )
    engine = ToolExecutionEngine(
        _Store(artifact),
        _Backend(),
        audit_log=ToolAuditLog(tmp_path),
    )
    plan = engine.prepare(artifact.id, operation="execute", args={}, target={})
    grant = engine.grants.issue_once(plan)
    with pytest.raises(ToolExecutionError) as first:
        await engine.execute_tracked(
            plan.plan_hash,
            grant.grant_id,
            operation_id="operation-native-uncertain",
            ctx=None,
            initiator="agent",
        )

    public = first.value.public_dict()
    assert public["error"] == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert public["operationId"] == "operation-native-uncertain"
    assert public["outcomeUnknown"] is True
    assert public["sideEffect"] == "may-have-occurred"
    assert public["recovery"]["action"] == "inspect-state"
    assert public["audit"]["outcome"] == "outcome-unknown"
    assert public["audit"]["backend"] == "native-aegp"

    status = engine.job_status(public["executionId"])
    assert status["status"] == "outcome-unknown"
    assert status["error"]["code"] == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert status["error"]["sideEffect"] == "may-have-occurred"
    assert status["error"]["recovery"]["action"] == "inspect-state"
    assert status["audit"]["outcome"] == "outcome-unknown"
    assert status["audit"]["backend"] == "native-aegp"

    # A lost agent response can be retried only with the same operation id.
    # The server returns the existing terminal job and never dispatches again.
    retry_grant = engine.grants.issue_once(plan)
    with pytest.raises(ToolExecutionError) as second:
        await engine.execute_tracked(
            plan.plan_hash,
            retry_grant.grant_id,
            operation_id="operation-native-uncertain",
            ctx=None,
            initiator="agent",
        )
    assert second.value.public_dict()["executionId"] == public["executionId"]
    assert calls == 1
