"""Schema validation: every verb rejects bad args and accepts good ones."""

from __future__ import annotations

import pytest
from pydantic import BaseModel
from pydantic import ValidationError

from ae_mcp import schemas as S
from ae_mcp import schemas_tsm as TSM


def test_registry_has_all_verbs():
    assert set(S.SCHEMAS) == {
        "ae.nativeExec",
        "ae.exec",
        "ae.checkpoint", "ae.revert", "ae.snapshot", "ae.previewFrame",
        "ae.ping", "ae.status", "ae.diagnose",
        "ae.validateExpressions",
        "ae.skillList", "ae.skillUse",
        "ae.toolIndex", "ae.toolSearch", "ae.toolInspect", "ae.toolUse",
    }


def test_public_args_exports_match_only_the_final_schema_registry():
    expected = {schema.__name__ for schema in S.SCHEMAS.values()}
    exported = {
        name
        for module in (S, TSM)
        for name, value in vars(module).items()
        if (
            not name.startswith("_")
            and name.endswith("Args")
            and isinstance(value, type)
            and issubclass(value, BaseModel)
        )
    }
    assert exported == expected

    removed_examples = (
        ("ae_mcp.schemas", "AeSetLayerVisibilityArgs"),
        ("ae_mcp.schemas", "AeProjectSummaryArgs"),
        ("ae_mcp.schemas_tsm", "AeCreateTextLayerArgs"),
    )
    for module_name, class_name in removed_examples:
        module = S if module_name == "ae_mcp.schemas" else TSM
        assert not hasattr(module, class_name)
        with pytest.raises(ImportError):
            exec(f"from {module_name} import {class_name}", {})


def test_public_basemodel_exports_match_only_the_final_schema_registry():
    expected = {
        ("ae_mcp.schemas", schema.__name__)
        for schema in S.SCHEMAS.values()
    }
    exported = {
        (module.__name__, name)
        for module in (S, TSM)
        for name, value in vars(module).items()
        if (
            not name.startswith("_")
            and isinstance(value, type)
            and issubclass(value, BaseModel)
        )
    }
    assert exported == expected


def _locator(kind: str = "project") -> dict[str, object]:
    return {
        "kind": kind,
        "hostInstanceId": "22222222-2222-4222-8222-222222222222",
        "sessionId": "11111111-1111-4111-8111-111111111111",
        "projectId": "33333333-3333-4333-8333-333333333333",
        "generation": 7,
        "objectId": "44444444-4444-4444-8444-444444444444",
    }


def test_exec_timeout_bounds():
    # Too low
    with pytest.raises(ValidationError):
        S.AeExecArgs(code="x", timeout_sec=0)
    # Too high
    with pytest.raises(ValidationError):
        S.AeExecArgs(code="x", timeout_sec=601)
    # Default
    assert S.AeExecArgs(code="x").timeout_sec == 30


def test_checkpoint_limit_positive():
    with pytest.raises(ValidationError):
        S.AeCheckpointArgs(limit=0)
    assert S.AeCheckpointArgs(limit=5).limit == 5


def test_revert_requires_id():
    with pytest.raises(ValidationError):
        S.AeRevertArgs()
    assert S.AeRevertArgs(checkpoint_id="abc").checkpoint_id == "abc"


def test_snapshot_method_enum():
    assert S.AeSnapshotArgs().method == "DesktopCopy"
    with pytest.raises(ValidationError):
        S.AeSnapshotArgs(method="Bogus")


def test_preview_frame_defaults():
    args = S.AePreviewFrameArgs()
    assert args.comp_id is None
    assert args.time is None
    assert args.times is None
    assert args.out_dir is None
    assert args.include_base64 is False
    assert args.scale == 1.0


def test_preview_frame_accepts_time_modes():
    single = S.AePreviewFrameArgs(time=0.5)
    multi = S.AePreviewFrameArgs(times=[0.0, 1.0])
    assert single.time == 0.5
    assert multi.times == [0.0, 1.0]


def test_preview_frame_rejects_invalid_ranges():
    with pytest.raises(ValidationError):
        S.AePreviewFrameArgs(time=-0.1)
    with pytest.raises(ValidationError):
        S.AePreviewFrameArgs(times=[0.0, -1.0])
    with pytest.raises(ValidationError):
        S.AePreviewFrameArgs(scale=0)


def test_every_schema_can_generate_json_schema():
    """MCP tools/list will call .model_json_schema() on every verb."""
    for name, cls in S.SCHEMAS.items():
        schema = cls.model_json_schema()
        assert schema["type"] == "object", name
        assert "properties" in schema, name


def test_ae_ping_default():
    a = S.AePingArgs()
    assert a.expect == "pong"


def test_ae_ping_custom_expect():
    a = S.AePingArgs(expect="hello")
    assert a.expect == "hello"


def test_ae_ping_extra_forbidden():
    with pytest.raises(ValidationError):
        S.AePingArgs(expect="x", junk=1)


def test_ae_ping_in_registry():
    assert "ae.ping" in S.SCHEMAS
    assert S.SCHEMAS["ae.ping"] is S.AePingArgs


def test_ae_checkpoint_default_action_is_list():
    a = S.AeCheckpointArgs()
    assert a.action == "list"
    assert a.label == ""
    assert a.limit == 20


def test_ae_checkpoint_create_with_label():
    a = S.AeCheckpointArgs(action="create", label="before risky write")
    assert a.action == "create"
    assert a.label == "before risky write"


def test_ae_checkpoint_invalid_action():
    with pytest.raises(ValidationError):
        S.AeCheckpointArgs(action="delete")


def test_validate_expressions_defaults():
    a = S.AeValidateExpressionsArgs(comp_id="12")
    assert a.comp_id == "12"
    assert a.layer_ids is None
    assert a.sample_times is None
    assert a.max_results == 500


def test_validate_expressions_sample_times_non_negative():
    with pytest.raises(ValidationError):
        S.AeValidateExpressionsArgs(comp_id="12", sample_times=[0, -1])


def test_skill_use_defaults():
    args = S.AeSkillUseArgs(name="wiggle-position")
    assert args.args == {}
    assert args.execute is False


def _jsx_save_artifact() -> dict[str, object]:
    return {
        "name": "Reusable JSX",
        "description": "",
        "kind": "jsx",
        "category": "workflow",
        "tags": [],
        "compatibility": {},
        "declared_risk": "write",
        "content": "JSON.stringify({ok:true});",
        "args_schema": {},
    }


@pytest.mark.parametrize(
    ("save", "mode", "intent", "status"),
    [
        (
            {
                "mode": "create",
                "intent": "user-requested",
                "status": "saved",
                "artifact": _jsx_save_artifact(),
            },
            "create",
            "user-requested",
            "saved",
        ),
        (
            {
                "mode": "create",
                "intent": "model-curated",
                "status": "candidate",
                "artifact": _jsx_save_artifact(),
            },
            "create",
            "model-curated",
            "candidate",
        ),
        (
            {
                "mode": "create",
                "intent": "user-requested",
                "status": "candidate",
                "artifact": _jsx_save_artifact(),
            },
            "create",
            "user-requested",
            "candidate",
        ),
        (
            {
                "mode": "promote",
                "intent": "user-requested",
                "status": "saved",
                "artifact_id": "chat-tool-call:candidate",
                "expected_revision": 1,
                "expected_content_hash": "a" * 64,
            },
            "promote",
            "user-requested",
            "saved",
        ),
    ],
)
def test_tool_use_accepts_strict_jsx_save_requests(
    save: dict[str, object],
    mode: str,
    intent: str,
    status: str,
):
    args = S.AeToolUseArgs(action="save", save=save)

    assert args.save is not None
    assert args.save.mode == mode
    assert args.save.intent == intent
    assert args.save.status == status


@pytest.mark.parametrize(
    "save",
    [
        {
            "mode": "create",
            "intent": "model-curated",
            "status": "saved",
            "artifact": _jsx_save_artifact(),
        },
        {
            "mode": "promote",
            "intent": "model-curated",
            "status": "saved",
            "artifact_id": "chat-tool-call:candidate",
            "expected_revision": 1,
            "expected_content_hash": "a" * 64,
        },
        {
            "mode": "promote",
            "intent": "user-requested",
            "status": "candidate",
            "artifact_id": "chat-tool-call:candidate",
            "expected_revision": 1,
            "expected_content_hash": "a" * 64,
        },
        {
            "mode": "create",
            "intent": "user-requested",
            "status": "saved",
            "artifact": {**_jsx_save_artifact(), "kind": "expression"},
        },
        {
            "mode": "create",
            "intent": "user-requested",
            "status": "saved",
            "artifact": _jsx_save_artifact(),
            "artifact_id": "chat-tool-call:candidate",
        },
        {
            "mode": "promote",
            "intent": "user-requested",
            "status": "saved",
            "artifact_id": "chat-tool-call:candidate",
            "expected_revision": 1,
            "expected_content_hash": "a" * 64,
            "artifact": _jsx_save_artifact(),
        },
    ],
)
def test_tool_use_rejects_unsupported_jsx_save_shapes(save: dict[str, object]):
    with pytest.raises(ValidationError):
        S.AeToolUseArgs(action="save", save=save)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("artifact_id", "user:existing"),
        ("operation", "execute"),
        ("args", {"value": 1}),
        ("target", {"comp_id": "1"}),
        ("plan_hash", "plan"),
        ("grant_id", "grant"),
        ("grant_scope", "once"),
        ("execution_id", "execution"),
        ("operation_id", "operation-schema-save"),
        ("limit", 1),
    ],
)
def test_tool_use_save_forbids_staged_execution_fields(field: str, value: object):
    request = {
        "action": "save",
        "save": {
            "mode": "create",
            "intent": "user-requested",
            "status": "saved",
            "artifact": _jsx_save_artifact(),
        },
        field: value,
    }

    with pytest.raises(ValidationError):
        S.AeToolUseArgs(**request)


def test_tool_use_save_payload_is_exclusive_to_save_action():
    save = {
        "mode": "create",
        "intent": "user-requested",
        "status": "saved",
        "artifact": _jsx_save_artifact(),
    }

    with pytest.raises(ValidationError):
        S.AeToolUseArgs(action="render", artifact_id="user:1", save=save)
    with pytest.raises(ValidationError):
        S.AeToolUseArgs(action="save")


def test_tool_use_enforces_the_staged_protocol():
    assert S.AeToolUseArgs(action="render", artifact_id="user:1").operation == "render"
    S.AeToolUseArgs(
        action="prepare", artifact_id="user:1", operation="execute"
    )
    S.AeToolUseArgs(action="grant", plan_hash="p", grant_scope="once")
    S.AeToolUseArgs(
        action="execute",
        plan_hash="p",
        grant_id="g",
        operation_id="operation-schema-execute",
    )
    S.AeToolUseArgs(
        action="start",
        plan_hash="p",
        grant_id="g",
        operation_id="operation-schema-0001",
    )

    invalid = [
        {"action": "render"},
        {"action": "prepare", "artifact_id": "user:1"},
        {"action": "grant", "plan_hash": "p"},
        {"action": "execute", "plan_hash": "p"},
        {"action": "execute", "plan_hash": "p", "grant_id": "g"},
        {"action": "start", "plan_hash": "p", "grant_id": "g"},
        {"action": "execute", "plan_hash": "p", "grant_id": "g", "artifact_id": "user:1"},
    ]
    for value in invalid:
        with pytest.raises(ValidationError):
            S.AeToolUseArgs(**value)


def test_public_tool_discovery_schema_cannot_unlock_developer_commands():
    for schema in (S.AeToolIndexArgs, S.AeToolSearchArgs, S.AeToolInspectArgs):
        assert "developer_mode" not in schema.model_json_schema()["properties"]
    public_kinds = S.AeToolIndexArgs.model_json_schema()["properties"]["kinds"]["anyOf"][0]["items"]["enum"]
    assert "system-command" not in public_kinds
    panel_kinds = S._AePanelToolIndexArgs.model_json_schema()["properties"]["kinds"]["anyOf"][0]["items"]["enum"]
    assert "system-command" in panel_kinds
