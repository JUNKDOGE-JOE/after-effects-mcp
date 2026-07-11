from __future__ import annotations

import json
import logging
from pathlib import Path
from types import SimpleNamespace

import pytest

from ae_mcp.handlers import HANDLERS, load_all
from ae_mcp.tool_history import (
    HistoryContext,
    capture_history_candidate,
    extract_history_draft,
)
from ae_mcp.tool_secrets import RegexSecretScanner
from ae_mcp.tool_store import ToolArtifactStore, ToolStoreError


@pytest.fixture
def store(tmp_path: Path) -> ToolArtifactStore:
    return ToolArtifactStore(root=tmp_path / "tools")


@pytest.fixture
def scanner() -> RegexSecretScanner:
    return RegexSecretScanner()


def context(request_id: str = "req-1", created_at: int = 1000) -> HistoryContext:
    return HistoryContext(
        client="panel-chat/0.9.0",
        request_id=request_id,
        created_at=created_at,
    )


def exec_arguments(code: str = "app.project.activeItem.layers.addNull();") -> dict[str, object]:
    return {
        "code": code,
        "undo_group_name": "Create control",
        "checkpoint_label": None,
        "timeout_sec": 30,
    }


def test_successful_exec_creates_non_executable_candidate(
    store: ToolArtifactStore, scanner: RegexSecretScanner
) -> None:
    artifact = capture_history_candidate(
        store=store,
        scanner=scanner,
        verb_name="ae.exec",
        arguments=exec_arguments(),
        result={"ok": True},
        context=context(),
    )

    assert artifact is not None
    assert artifact.status == "candidate"
    assert artifact.kind == "jsx"
    assert artifact.name == "Create control"
    assert artifact.source.type == "chat-tool-call"
    assert artifact.source.client == "panel-chat/0.9.0"
    assert artifact.source.ref == "req-1"
    assert artifact.source.provenance == {
        "verbName": "ae.exec",
        "requestId": "req-1",
        "capturedAt": 1000,
    }


def test_failed_exec_does_not_create_candidate(
    store: ToolArtifactStore, scanner: RegexSecretScanner
) -> None:
    result = capture_history_candidate(
        store=store,
        scanner=scanner,
        verb_name="ae.exec",
        arguments={"code": "return 1;"},
        result={"ok": False, "error": "AE failed"},
        context=context("req-2"),
    )

    assert result is None
    assert store.list(statuses={"candidate"}) == []


def test_secret_hit_does_not_persist_candidate(
    store: ToolArtifactStore, scanner: RegexSecretScanner
) -> None:
    result = capture_history_candidate(
        store=store,
        scanner=scanner,
        verb_name="ae.exec",
        arguments={"code": 'var token = "Authorization: Bearer secret";'},
        result={"ok": True},
        context=context("req-3"),
    )

    assert result is None
    assert store.list(statuses={"candidate"}) == []


@pytest.mark.parametrize("field", ["expression", "expression_text"])
def test_top_level_expression_string_creates_expression_draft(field: str) -> None:
    draft = extract_history_draft(
        "ae.setExpression",
        {field: "time * 2", "other": "ignored"},
        {"ok": True},
        context(),
    )

    assert draft is not None
    assert draft.kind == "expression"
    assert draft.content == "time * 2"
    assert draft.status == "candidate"


@pytest.mark.parametrize(
    ("verb_name", "arguments", "result"),
    [
        ("ae.skillCreate", {"expression": "time"}, {"ok": True}),
        ("ae.skillEdit", {"expression_text": "time"}, {"ok": True}),
        ("ae.toolCreate", {"expression": "time"}, {"ok": True}),
        ("ae.exec", {"code": "return 1;"}, {"ok": False}),
        ("ae.exec", {"code": "return 1;"}, {"status": "timed-out"}),
        ("ae.exec", {"code": 42}, {"ok": True}),
    ],
)
def test_conservative_extraction_rejects_canonical_copies_recursive_tools_and_failures(
    verb_name: str, arguments: dict[str, object], result: object
) -> None:
    assert extract_history_draft(verb_name, arguments, result, context()) is None


def test_repeated_candidate_updates_usage_and_provenance_under_artifact_cas(
    store: ToolArtifactStore, scanner: RegexSecretScanner
) -> None:
    first = capture_history_candidate(
        store=store,
        scanner=scanner,
        verb_name="ae.exec",
        arguments=exec_arguments(),
        result={"ok": True},
        context=context("req-first", 1000),
    )
    second = capture_history_candidate(
        store=store,
        scanner=scanner,
        verb_name="ae.exec",
        arguments=exec_arguments(),
        result={"ok": True},
        context=HistoryContext("second-client/1", "req-second", 2000),
    )

    assert first is not None and second is not None
    assert second.id == first.id
    assert second.revision == first.revision + 1
    assert second.last_used_at == 2000
    assert second.source.type == "chat-tool-call"
    assert second.source.ref == "req-first"
    assert second.source.provenance == {
        "verbName": "ae.exec",
        "requestId": "req-first",
        "capturedAt": 2000,
        "lastRequestId": "req-second",
        "lastClient": "second-client/1",
    }
    assert len(store.find_by_content_hash("jsx", first.content_hash, statuses={"candidate"})) == 1


async def test_server_captures_only_success_and_capture_failure_preserves_result(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    from ae_mcp import server as server_module

    load_all()
    schema_cls, original_run = HANDLERS["ae.exec"]
    results = iter(({"ok": True, "value": "first"}, {"ok": False, "error": "failed"}))
    captured: list[tuple[str, dict[str, object], object]] = []

    async def fake_run(_validated: object, _ctx: object) -> object:
        return next(results)

    async def allow(_verb_name: str, _ctx: object) -> None:
        return None

    def fake_capture(**kwargs: object) -> None:
        captured.append(
            (
                str(kwargs["verb_name"]),
                dict(kwargs["arguments"]),
                kwargs["result"],
            )
        )
        raise ToolStoreError("capture-secret-must-not-be-logged")

    monkeypatch.setitem(HANDLERS, "ae.exec", (schema_cls, fake_run))
    monkeypatch.setattr(server_module.approval_gate, "enforce", allow)
    monkeypatch.setattr(server_module, "capture_history_candidate", fake_capture)
    monkeypatch.setattr(
        server_module,
        "default_tool_service",
        lambda: SimpleNamespace(store=object()),
    )
    monkeypatch.setattr(server_module.client_identity, "get_client", lambda: "test-client/1")
    server = server_module.build_server()

    with caplog.at_level(logging.WARNING, logger="ae_mcp.server"):
        success = await server._ae_call_tool("ae_exec", exec_arguments("return 'first';"))
        failure = await server._ae_call_tool("ae_exec", exec_arguments("return 'second';"))

    monkeypatch.setitem(HANDLERS, "ae.exec", (schema_cls, original_run))
    assert json.loads(success.content[0].text) == {"ok": True, "value": "first"}
    assert json.loads(failure.content[0].text) == {"ok": False, "error": "failed"}
    assert len(captured) == 1
    assert captured[0][0] == "ae.exec"
    assert captured[0][1] == exec_arguments("return 'first';")
    assert captured[0][2] == {"ok": True, "value": "first"}
    assert any("ToolStoreError" in record.getMessage() for record in caplog.records)
    assert all("capture-secret" not in record.getMessage() for record in caplog.records)


async def test_non_candidate_success_does_not_initialize_tool_service(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from ae_mcp import server as server_module

    load_all()
    schema_cls, original_run = HANDLERS["ae.ping"]

    async def fake_run(_validated: object, _ctx: object) -> object:
        return {"ok": True, "pong": "safe"}

    async def allow(_verb_name: str, _ctx: object) -> None:
        return None

    monkeypatch.setitem(HANDLERS, "ae.ping", (schema_cls, fake_run))
    monkeypatch.setattr(server_module.approval_gate, "enforce", allow)
    monkeypatch.setattr(
        server_module,
        "default_tool_service",
        lambda: pytest.fail("non-candidate call initialized Tool Library"),
    )
    server = server_module.build_server()
    result = await server._ae_call_tool("ae_ping", {"expect": "safe"})

    monkeypatch.setitem(HANDLERS, "ae.ping", (schema_cls, original_run))
    assert json.loads(result.content[0].text) == {"ok": True, "pong": "safe"}
