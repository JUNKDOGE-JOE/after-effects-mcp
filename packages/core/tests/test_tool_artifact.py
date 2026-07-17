from __future__ import annotations

from pathlib import Path
from uuid import UUID

import pytest

from ae_mcp.tool_artifact import (
    ToolArtifact,
    ToolArtifactDraft,
    ToolSource,
    ToolVerification,
    builtin_artifact_id,
    canonical_json_bytes,
    compute_content_hash,
    legacy_artifact_id,
    max_risk,
    new_user_artifact_id,
)


PROVIDER_ID = "12345678-1234-5678-9234-567812345678"


def _source(source_type: str = "user") -> ToolSource:
    return ToolSource(
        type=source_type,
        ref="manual",
        client=None,
        product_version=None,
        provenance={},
    )


def _artifact_wire(**overrides):
    content = overrides.pop("content", "return 1;")
    args_schema = overrides.pop("argsSchema", {})
    kind = overrides.pop("kind", "jsx")
    raw = {
        "schemaVersion": 1,
        "id": f"user:{PROVIDER_ID}",
        "name": "One",
        "description": "",
        "kind": kind,
        "category": "workflow",
        "tags": [],
        "compatibility": {},
        "declaredRisk": "read",
        "source": {
            "type": "user",
            "ref": "manual",
            "client": None,
            "productVersion": None,
            "provenance": {},
        },
        "status": "saved",
        "verified": False,
        "verification": None,
        "content": content,
        "argsSchema": args_schema,
        "contentHash": compute_content_hash(kind, content, args_schema),
        "revision": 1,
        "createdAt": 1,
        "updatedAt": 1,
        "lastUsedAt": None,
    }
    raw.update(overrides)
    return raw


def test_canonical_json_is_order_independent_and_rejects_non_finite_values():
    assert canonical_json_bytes({"b": 2, "a": 1}) == b'{"a":1,"b":2}'
    with pytest.raises(ValueError, match="finite"):
        canonical_json_bytes({"bad": float("nan")})
    with pytest.raises(ValueError, match="finite"):
        canonical_json_bytes({"bad": float("inf")})


def test_content_hash_binds_kind_content_and_args_schema():
    base = compute_content_hash("jsx", "return 1;", {"x": {"type": "number"}})
    assert base == compute_content_hash(
        "jsx", "return 1;", {"x": {"type": "number"}}
    )
    assert base != compute_content_hash(
        "jsx", "return 2;", {"x": {"type": "number"}}
    )
    assert base != compute_content_hash(
        "jsx", "return 1;", {"x": {"type": "string"}}
    )
    assert base != compute_content_hash(
        "expression", "return 1;", {"x": {"type": "number"}}
    )


def test_namespaced_ids_are_stable_and_non_overlapping(tmp_path: Path):
    source = tmp_path / "skills" / "same.json"
    assert new_user_artifact_id(
        UUID("12345678-1234-5678-1234-567812345678")
    ) == "user:12345678-1234-5678-1234-567812345678"
    assert legacy_artifact_id(source).startswith("legacy:")
    assert legacy_artifact_id(source) == legacy_artifact_id(source)
    assert len(legacy_artifact_id(source)) == len("legacy:") + 24
    assert builtin_artifact_id("same") == "builtin:skill:same"
    assert len({legacy_artifact_id(source), builtin_artifact_id("same")}) == 2


def test_imported_trust_fields_are_reset():
    raw = _artifact_wire(
        source={
            "type": "imported",
            "ref": "package:fixture",
            "client": None,
            "productVersion": None,
            "provenance": {},
        },
        status="pinned",
        verified=True,
        verification={
            "method": "user-reviewed",
            "verifiedAt": 1,
            "evidenceHash": None,
        },
    )
    artifact = ToolArtifact.from_dict(raw, imported=True)
    assert artifact.status == "candidate"
    assert artifact.verified is False
    assert artifact.verification is None


def test_risk_order_can_only_raise():
    assert max_risk("read", "write") == "write"
    assert max_risk("write", "destructive") == "destructive"
    assert max_risk("external", "read") == "external"
    with pytest.raises(ValueError, match="risk"):
        max_risk("read", "unknown")  # type: ignore[arg-type]


@pytest.mark.parametrize("kind", ["jsx", "expression", "prompt-skill"])
def test_text_kinds_require_string_content(kind: str):
    with pytest.raises(ValueError, match="content"):
        ToolArtifact.from_dict(_artifact_wire(kind=kind, content={"bad": True}))


def test_recipe_and_diagnostic_content_have_exact_shapes():
    recipe = {
        "steps": [
            {
                "refType": "tool",
                "ref": "ae.ping",
                "operation": "call",
                "args": {"expect": "pong"},
                "target": {},
            },
            {
                "refType": "artifact",
                "ref": f"user:{PROVIDER_ID}",
                "operation": "render",
                "args": {},
                "target": {},
            },
        ]
    }
    artifact = ToolArtifact.from_dict(_artifact_wire(kind="recipe", content=recipe))
    assert artifact.content == recipe

    diagnostic = {"capability": "project.read", "args": {"depth": 1}}
    artifact = ToolArtifact.from_dict(
        _artifact_wire(kind="diagnostic", content=diagnostic)
    )
    assert artifact.content == diagnostic

    with pytest.raises(ValueError, match="unknown"):
        ToolArtifact.from_dict(
            _artifact_wire(
                kind="diagnostic",
                content={**diagnostic, "unknown": True},
            )
        )


@pytest.mark.parametrize(
    ("step", "message"),
    [
        (
            {
                "refType": "tool",
                "ref": "ae.exec",
                "operation": "call",
                "args": {"code": "1"},
                "target": {},
            },
            "recursive",
        ),
        (
            {
                "refType": "tool",
                "ref": "ae.unknown",
                "operation": "call",
                "args": {},
                "target": {},
            },
            "unknown",
        ),
        (
            {
                "refType": "artifact",
                "ref": f"user:{PROVIDER_ID}",
                "operation": "call",
                "args": {},
                "target": {},
            },
            "operation",
        ),
        (
            {
                "refType": "tool",
                "ref": "ae.ping",
                "operation": "execute",
                "args": {},
                "target": {},
            },
            "operation",
        ),
        (
            {
                "refType": "tool",
                "ref": "ae.ping",
                "operation": "call",
                "args": {"unexpected": True},
                "target": {},
            },
            "args",
        ),
    ],
)
def test_recipe_rejects_recursive_unknown_or_invalid_steps(step, message):
    with pytest.raises(ValueError, match=message):
        ToolArtifact.from_dict(
            _artifact_wire(kind="recipe", content={"steps": [step]})
        )


def test_artifact_rejects_unknown_keys_hash_drift_and_invalid_trust():
    with pytest.raises(ValueError, match="unknown"):
        ToolArtifact.from_dict(_artifact_wire(extra=True))
    with pytest.raises(ValueError, match="contentHash"):
        ToolArtifact.from_dict(_artifact_wire(contentHash="0" * 64))
    with pytest.raises(ValueError, match="verification"):
        ToolArtifact.from_dict(_artifact_wire(verified=True, verification=None))


def test_artifact_enforces_metadata_limits_and_exact_values():
    with pytest.raises(ValueError, match="name"):
        ToolArtifact.from_dict(_artifact_wire(name="x" * 129))
    with pytest.raises(ValueError, match="description"):
        ToolArtifact.from_dict(_artifact_wire(description="x" * 4097))
    with pytest.raises(ValueError, match="tags"):
        ToolArtifact.from_dict(_artifact_wire(tags=[str(i) for i in range(33)]))
    with pytest.raises(ValueError, match="tag"):
        ToolArtifact.from_dict(_artifact_wire(tags=["x" * 65]))
    with pytest.raises(ValueError, match="status"):
        ToolArtifact.from_dict(_artifact_wire(status="trusted"))
    with pytest.raises(ValueError, match="declaredRisk"):
        ToolArtifact.from_dict(_artifact_wire(declaredRisk="safe"))
    with pytest.raises(ValueError, match="source"):
        ToolArtifact.from_dict(
            _artifact_wire(
                source={
                    "type": "remote",
                    "ref": "x",
                    "client": None,
                    "productVersion": None,
                    "provenance": {},
                }
            )
        )


def test_wire_round_trip_and_summary_contract_omit_content_when_requested():
    original = ToolArtifact.from_dict(_artifact_wire(tags=["one", "two"]))
    wire = original.to_dict(include_content=False)
    assert "content" not in wire
    assert wire["contentHash"] == original.content_hash
    assert original.to_dict()["content"] == "return 1;"

    draft = ToolArtifactDraft(
        name="Draft",
        description="",
        kind="jsx",
        category="workflow",
        tags=(),
        compatibility={},
        declared_risk="write",
        source=_source(),
        status="saved",
        content="return 1;",
        args_schema={},
    )
    assert draft.status == "saved"
    verification = ToolVerification(
        method="content-hash", verified_at=1, evidence_hash=None
    )
    assert verification.method == "content-hash"


def test_export_safe_source_omits_client_paths_and_arbitrary_provenance():
    raw = _artifact_wire(
        source={
            "type": "chat-tool-call",
            "ref": "/Users/person/private/provider-config.json",
            "client": "private-client-identity",
            "productVersion": "0.9.2",
            "provenance": {
                "provider": "private-provider-shape",
                "Authorization": "Bearer do-not-export",
            },
        }
    )
    artifact = ToolArtifact.from_dict(raw)
    exported = artifact.to_dict(export_safe=True)
    rendered = canonical_json_bytes(exported).decode("utf-8")
    assert exported["source"] == {
        "type": "chat-tool-call",
        "ref": artifact.id,
        "client": None,
        "productVersion": "0.9.2",
        "provenance": {"contentHash": artifact.content_hash},
    }
    for forbidden in (
        "/Users/person/private/provider-config.json",
        "private-client-identity",
        "private-provider-shape",
        "do-not-export",
    ):
        assert forbidden not in rendered


def test_system_command_kind_requires_external_risk_and_round_trips_as_text():
    with pytest.raises(ValueError, match="external risk"):
        ToolArtifact.from_dict(
            _artifact_wire(kind="system-command", content="echo blocked")
        )
    command = ToolArtifact.from_dict(
        _artifact_wire(
            kind="system-command",
            content="echo blocked",
            declaredRisk="external",
        )
    )
    assert command.kind == "system-command"
    assert command.declared_risk == "external"
    assert command.to_dict()["content"] == "echo blocked"
