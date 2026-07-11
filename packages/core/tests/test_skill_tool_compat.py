from __future__ import annotations

from types import SimpleNamespace

import pytest

from ae_mcp import schemas as S
from ae_mcp.handlers.skills import _run_skill_use
from ae_mcp.skill_store import Skill, SkillStore
from ae_mcp.tool_service import reset_default_tool_service_for_tests


class FakeSession:
    def __init__(self, action: str) -> None:
        self.action = action
        self.calls: list[dict] = []

    async def elicit_form(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(action=self.action, content={"decision": "deny"})


@pytest.fixture(autouse=True)
def _reset_service():
    reset_default_tool_service_for_tests()
    yield
    reset_default_tool_service_for_tests()


@pytest.mark.asyncio
async def test_skill_use_execute_false_keeps_legacy_payload(monkeypatch, tmp_path):
    monkeypatch.setenv("AE_MCP_SKILL_DIR", str(tmp_path / "skills"))
    SkillStore().create(
        Skill(
            name="render-only",
            description="",
            template_type="jsx",
            template="return 1;",
            args_schema={},
        )
    )
    assert await _run_skill_use(
        S.AeSkillUseArgs(name="render-only", execute=False),
        None,
    ) == {
        "ok": True,
        "name": "render-only",
        "template_type": "jsx",
        "rendered": "return 1;",
    }


@pytest.mark.asyncio
async def test_skill_use_execute_true_none_still_elicits_destructive_jsx(
    monkeypatch, tmp_path, mock_backend
):
    monkeypatch.setenv("AE_MCP_SKILL_DIR", str(tmp_path / "skills"))
    monkeypatch.setenv("AE_MCP_TOOL_DIR", str(tmp_path / "tools"))
    tier = tmp_path / "tier"
    tier.write_text("none\n", encoding="utf-8")
    monkeypatch.setenv("AE_MCP_TOOL_APPROVAL_TIER_FILE", str(tier))
    SkillStore().create(
        Skill(
            name="remove-layer",
            description="",
            template_type="jsx",
            template="app.project.activeItem.layer(1).remove();",
            args_schema={},
        )
    )
    session = FakeSession(action="decline")
    result = await _run_skill_use(
        S.AeSkillUseArgs(name="remove-layer", execute=True),
        SimpleNamespace(session=session, request_id="req-1"),
    )

    assert result["ok"] is False
    assert len(session.calls) == 1
    assert mock_backend.calls == []
    plan = session.calls[0]["requestedSchema"]["x-ae-mcp-plan"]
    assert plan["artifactId"].startswith("legacy:")
    assert plan["risk"] == "destructive"
