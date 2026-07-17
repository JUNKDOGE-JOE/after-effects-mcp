from __future__ import annotations

import json
import os
from types import SimpleNamespace

import pytest

from ae_mcp import approval_gate
from ae_mcp.approval_gate import (
    PlanAuthorizationDenied,
    authorize_plan,
    build_plan_elicitation_schema,
    current_tool_tier,
    gate_decision,
    plan_decision,
    read_tier,
)
from ae_mcp.server import build_server
from ae_mcp.tool_execution import ExecutionPlan


def test_read_tier_accepts_legal_values(tmp_path):
    tier_file = tmp_path / "tier.txt"

    for step, tier in enumerate(("readonly", "manual", "auto", "none")):
        tier_file.write_text(f"{tier}\n", encoding="utf-8")
        # NTFS mtime has 100ns granularity - keep steps at millisecond scale
        # so each iteration is a genuinely new mtime for the cache.
        os.utime(tier_file, ns=(1_000_000_000, 1_000_000_000 + (step + 1) * 1_000_000))

        assert read_tier(str(tier_file)) == tier


def test_read_tier_defaults_to_manual_for_invalid_or_missing_file(tmp_path):
    missing = tmp_path / "missing.txt"
    invalid = tmp_path / "invalid.txt"
    invalid.write_text("bogus\n", encoding="utf-8")

    assert read_tier(str(missing)) == "manual"
    assert read_tier(str(invalid)) == "manual"


def test_current_tool_tier_uses_only_tool_specific_env(monkeypatch, tmp_path):
    legacy = tmp_path / "legacy.txt"
    legacy.write_text("none\n", encoding="utf-8")
    monkeypatch.setenv("AE_MCP_APPROVAL_TIER_FILE", str(legacy))
    monkeypatch.delenv("AE_MCP_TOOL_APPROVAL_TIER_FILE", raising=False)

    assert current_tool_tier() == "manual"


@pytest.mark.parametrize(
    ("tier", "risk", "expected"),
    [
        ("readonly", "read", "allow"),
        ("readonly", "write", "deny"),
        ("readonly", "destructive", "deny"),
        ("readonly", "external", "deny"),
        ("manual", "read", "allow"),
        ("manual", "write", "elicit"),
        ("manual", "destructive", "elicit"),
        ("manual", "external", "elicit"),
        ("auto", "read", "allow"),
        ("auto", "write", "allow"),
        ("auto", "destructive", "elicit"),
        ("auto", "external", "elicit"),
        ("none", "read", "allow"),
        ("none", "write", "allow"),
        ("none", "destructive", "elicit"),
        ("none", "external", "elicit"),
    ],
)
def test_tool_plan_matrix(tier, risk, expected):
    assert plan_decision(tier, risk) == expected


def _plan(risk="write"):
    return ExecutionPlan(
        artifact_id="user:plan",
        content_hash="a" * 64,
        operation="execute",
        normalized_args={"amount": 2},
        target={"compId": "7"},
        dependency_hashes=(),
        plan_hash="b" * 64,
        risk=risk,
        expires_at=123,
    )


def test_plan_elicitation_schema_allows_session_only_for_write():
    write_schema = build_plan_elicitation_schema(_plan("write"))
    destructive_schema = build_plan_elicitation_schema(_plan("destructive"))
    direct_schema = build_plan_elicitation_schema(
        _plan("write"), requested_scope="once"
    )

    assert write_schema["properties"]["decision"]["enum"] == [
        "once",
        "session",
        "deny",
    ]
    assert destructive_schema["properties"]["decision"]["enum"] == [
        "once",
        "deny",
    ]
    assert direct_schema["properties"]["decision"]["enum"] == ["once", "deny"]
    assert write_schema["additionalProperties"] is False
    assert write_schema["x-ae-mcp-plan"] == _plan("write").public_dict()


class _PlanSession:
    def __init__(self, action, decision):
        self.action = action
        self.decision = decision

    async def elicit_form(self, **_kwargs):
        return SimpleNamespace(
            action=self.action,
            content={"decision": self.decision},
        )


@pytest.mark.asyncio
async def test_authorize_plan_maps_explicit_deny_to_structured_denial(
    monkeypatch, tmp_path
):
    tier_file = tmp_path / "tier.txt"
    tier_file.write_text("manual\n", encoding="utf-8")
    monkeypatch.setenv("AE_MCP_TOOL_APPROVAL_TIER_FILE", str(tier_file))
    ctx = SimpleNamespace(session=_PlanSession("accept", "deny"), request_id="req")

    with pytest.raises(PlanAuthorizationDenied) as caught:
        await authorize_plan(_plan("write"), ctx)

    assert caught.value.code == "tool_plan_denied"


@pytest.mark.asyncio
async def test_authorize_plan_without_elicitation_is_structured(monkeypatch, tmp_path):
    tier_file = tmp_path / "tier.txt"
    tier_file.write_text("manual\n", encoding="utf-8")
    monkeypatch.setenv("AE_MCP_TOOL_APPROVAL_TIER_FILE", str(tier_file))

    with pytest.raises(PlanAuthorizationDenied) as caught:
        await authorize_plan(_plan("external"), SimpleNamespace(session=object()))

    assert caught.value.public_dict()["error"] == "tool_plan_elicitation_unavailable"


def test_read_tier_uses_mtime_cache(tmp_path):
    tier_file = tmp_path / "tier.txt"
    tier_file.write_text("readonly\n", encoding="utf-8")
    os.utime(tier_file, ns=(1_000_000_000, 1_000_000_000))

    assert read_tier(str(tier_file)) == "readonly"
    tier_file.write_text("none\n", encoding="utf-8")
    os.utime(tier_file, ns=(1_000_000_000, 1_000_000_000))

    assert read_tier(str(tier_file)) == "readonly"
    os.utime(tier_file, ns=(2_000_000_000, 2_000_000_000))

    assert read_tier(str(tier_file)) == "none"


@pytest.mark.parametrize(
    ("tier", "read_decision", "write_decision", "destructive_decision"),
    [
        ("readonly", "allow", "deny-readonly", "deny-readonly"),
        ("manual", "allow", "elicit", "elicit"),
        ("auto", "allow", "allow", "elicit"),
        ("none", "allow", "allow", "allow"),
    ],
)
def test_gate_decision_matrix(
    tier, read_decision, write_decision, destructive_decision
):
    assert gate_decision(tier, "ae.overview") == read_decision
    assert gate_decision(tier, "ae.setProperty") == write_decision
    assert gate_decision(tier, "ae.exec") == destructive_decision


@pytest.mark.asyncio
async def test_enforce_bypasses_when_env_is_unset(monkeypatch):
    monkeypatch.delenv("AE_MCP_APPROVAL_TIER_FILE", raising=False)

    assert await approval_gate.enforce("ae.exec", None) is None


@pytest.mark.asyncio
async def test_enforce_blocks_writes_in_readonly_tier(monkeypatch, tmp_path):
    tier_file = tmp_path / "tier.txt"
    tier_file.write_text("readonly\n", encoding="utf-8")
    monkeypatch.setenv("AE_MCP_APPROVAL_TIER_FILE", str(tier_file))

    result = await approval_gate.enforce("ae.setProperty", None)

    assert result == {
        "ok": False,
        "error": (
            "blocked by read-only approval tier "
            "(switch the panel approval chip to allow writes)"
        ),
    }


class _FakeSession:
    def __init__(self, action: str):
        self.action = action
        self.calls = []

    async def elicit_form(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(action=self.action, content={})


@pytest.mark.asyncio
async def test_enforce_allows_when_elicitation_is_accepted(monkeypatch, tmp_path):
    tier_file = tmp_path / "tier.txt"
    tier_file.write_text("manual\n", encoding="utf-8")
    monkeypatch.setenv("AE_MCP_APPROVAL_TIER_FILE", str(tier_file))
    session = _FakeSession("accept")
    ctx = SimpleNamespace(session=session, request_id="req-1")

    result = await approval_gate.enforce("ae.setProperty", ctx)

    assert result is None
    assert session.calls
    assert "ae.setProperty" in session.calls[0]["message"]
    assert "non-destructive write" in session.calls[0]["message"]
    assert session.calls[0]["related_request_id"] == "req-1"


@pytest.mark.asyncio
async def test_enforce_denies_when_elicitation_is_declined(monkeypatch, tmp_path):
    tier_file = tmp_path / "tier.txt"
    tier_file.write_text("manual\n", encoding="utf-8")
    monkeypatch.setenv("AE_MCP_APPROVAL_TIER_FILE", str(tier_file))
    ctx = SimpleNamespace(session=_FakeSession("decline"), request_id="req-1")

    result = await approval_gate.enforce("ae.setProperty", ctx)

    assert result == {"ok": False, "error": "User denied this action."}


@pytest.mark.asyncio
async def test_enforce_denies_when_elicitation_api_is_missing(monkeypatch, tmp_path):
    tier_file = tmp_path / "tier.txt"
    tier_file.write_text("manual\n", encoding="utf-8")
    monkeypatch.setenv("AE_MCP_APPROVAL_TIER_FILE", str(tier_file))
    ctx = SimpleNamespace(session=object(), request_id="req-1")

    result = await approval_gate.enforce("ae.setProperty", ctx)

    assert result == {
        "ok": False,
        "error": (
            "approval required but this client cannot prompt; "
            "switch the approval tier or use the panel chat"
        ),
    }


@pytest.mark.asyncio
async def test_server_gate_blocks_write_in_readonly_tier(monkeypatch, tmp_path):
    from ae_mcp import server as server_module

    class Args:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

        @classmethod
        def model_json_schema(cls):
            return {"type": "object", "properties": {}}

    async def run(_args, _ctx):
        return {"ok": True, "ran": True}

    tier_file = tmp_path / "tier.txt"
    tier_file.write_text("readonly\n", encoding="utf-8")
    monkeypatch.setenv("AE_MCP_APPROVAL_TIER_FILE", str(tier_file))
    monkeypatch.setattr(server_module, "HANDLERS", {"ae.setProperty": (Args, run)})

    server = build_server()
    result = await server._ae_call_tool("ae_setProperty", {})
    payload = json.loads(result.content[0].text)

    assert result.isError is True
    assert payload["ok"] is False
    assert "blocked by read-only approval tier" in payload["error"]


@pytest.mark.asyncio
async def test_server_gate_allows_execution_in_none_tier(monkeypatch, tmp_path):
    from ae_mcp import server as server_module

    class Args:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

        @classmethod
        def model_json_schema(cls):
            return {"type": "object", "properties": {}}

    async def run(_args, _ctx):
        return {"ok": True, "ran": True}

    tier_file = tmp_path / "tier.txt"
    tier_file.write_text("none\n", encoding="utf-8")
    monkeypatch.setenv("AE_MCP_APPROVAL_TIER_FILE", str(tier_file))
    monkeypatch.setattr(server_module, "HANDLERS", {"ae.exec": (Args, run)})

    server = build_server()
    result = await server._ae_call_tool("ae_exec", {})

    assert result.isError is False
    assert json.loads(result.content[0].text) == {"ok": True, "ran": True}
