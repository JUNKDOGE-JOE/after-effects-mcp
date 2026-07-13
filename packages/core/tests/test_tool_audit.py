from __future__ import annotations

import json
import os
import stat
from pathlib import Path

import pytest

from ae_mcp.tool_audit import AuditRecord, ToolAuditLog, redact_audit_value


def _record(index: int, **overrides) -> AuditRecord:
    values = {
        "artifact_id": f"user:{index}",
        "content_hash": f"{index:064x}",
        "plan_hash": f"{index + 1:064x}",
        "args_hash": f"{index + 2:064x}",
        "target_hash": f"{index + 3:064x}",
        "redacted_args": {"count": index},
        "redacted_target": {"compId": str(index)},
        "grant_id": f"grant-{index}",
        "grant_scope": "once",
        "backend": "mock",
        "outcome": "success",
        "started_at": index,
        "finished_at": index + 1,
        "error_code": None,
    }
    values.update(overrides)
    return AuditRecord(**values)


def test_audit_round_trip_contains_required_fields_and_no_rendered_content(
    tmp_path: Path,
) -> None:
    log = ToolAuditLog(tmp_path)
    log.append(_record(1))

    [loaded] = log.list()
    wire = loaded.public_dict()

    assert wire["artifactId"] == "user:1"
    assert wire["contentHash"] == f"{1:064x}"
    assert wire["planHash"] == f"{2:064x}"
    assert wire["argsHash"] == f"{3:064x}"
    assert wire["targetHash"] == f"{4:064x}"
    assert wire["grantId"] == "grant-1"
    assert wire["grantScope"] == "once"
    assert wire["backend"] == "mock"
    assert wire["outcome"] == "success"
    assert "rendered" not in wire
    assert "content" not in wire


def test_audit_redacts_sensitive_values_and_secret_shaped_keys(tmp_path: Path) -> None:
    secret_key = "sk-abcdefghijk"
    secret_value = "Bearer private-value"
    redacted = redact_audit_value(
        {
            secret_key: 1,
            "authorization": secret_value,
            "nested": [secret_value],
        },
        all_strings=True,
    )
    encoded = json.dumps(redacted, sort_keys=True)

    assert secret_key not in encoded
    assert secret_value not in encoded
    assert secret_key not in json.dumps(redact_audit_value({secret_key: 1}))

    log = ToolAuditLog(tmp_path)
    log.append(
        _record(
            1,
            redacted_args={"authorization": secret_value},
            redacted_target={"path": secret_value},
        )
    )
    persisted = (tmp_path / "audit.jsonl").read_text(encoding="utf-8")
    assert secret_value not in persisted


def test_audit_rotation_retains_at_most_three_generations(tmp_path: Path) -> None:
    probe = _record(0)
    line_size = len(json.dumps(probe.public_dict(), separators=(",", ":"))) + 1
    log = ToolAuditLog(tmp_path, max_bytes=line_size * 2 + 20, generations=3)

    for index in range(10):
        log.append(_record(index))

    files = sorted(tmp_path.glob("audit.jsonl*"))
    assert len(files) <= 3
    assert not (tmp_path / "audit.jsonl.3").exists()
    assert [item.artifact_id for item in log.list(limit=100)][-1] == "user:9"
    assert len(log.list(limit=100)) < 10


@pytest.mark.skipif(os.name == "nt", reason="POSIX mode bits are not authoritative on Windows")
def test_audit_generations_are_owner_only(tmp_path: Path) -> None:
    log = ToolAuditLog(tmp_path, max_bytes=500, generations=3)
    for index in range(8):
        log.append(_record(index))

    for path in tmp_path.glob("audit.jsonl*"):
        assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_audit_rejects_a_record_larger_than_a_generation(tmp_path: Path) -> None:
    log = ToolAuditLog(tmp_path, max_bytes=32)

    with pytest.raises(ValueError, match="generation size"):
        log.append(_record(1))


def test_audit_list_skips_malformed_lines_and_filters_artifact(tmp_path: Path) -> None:
    log = ToolAuditLog(tmp_path)
    log.append(_record(1))
    with (tmp_path / "audit.jsonl").open("a", encoding="utf-8") as handle:
        handle.write("not-json\n")
    log.append(_record(2))

    records = log.list(artifact_id="user:2")

    assert [item.artifact_id for item in records] == ["user:2"]
