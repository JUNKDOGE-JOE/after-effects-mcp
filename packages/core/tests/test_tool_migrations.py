from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from ae_mcp.tool_artifact import ToolArtifactDraft, ToolSource
from ae_mcp.tool_migrations import ToolDataMigrator, ToolMigrationError
from ae_mcp.tool_secrets import SecretDetectedError, SecretFinding
from ae_mcp.tool_store import ToolArtifactStore, atomic_write_json


def draft(name: str) -> ToolArtifactDraft:
    return ToolArtifactDraft(
        name=name,
        description="",
        kind="jsx",
        category="workflow",
        tags=(),
        compatibility={},
        declared_risk="write",
        source=ToolSource(
            type="user",
            ref="manual",
            client=None,
            product_version=None,
            provenance={},
        ),
        status="saved",
        content="return 1;",
        args_schema={},
    )


def write_legacy_skill(home: Path, name: str = "hello") -> Path:
    path = home / "skills" / f"{name}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"name": name, "template": "return 1;", "template_type": "jsx"}
    atomic_write_json(path, payload)
    return path


def test_empty_v09_root_creates_backup_primary_files_and_atomic_marker(tmp_path: Path) -> None:
    root = tmp_path / "home" / "tools"
    result = ToolDataMigrator(root=root, now=lambda: 1_700_000_000_000).migrate_from_v0_9()

    assert result.migrated is True
    assert result.backup_id
    assert json.loads((root / "index.json").read_text("utf-8")) == {
        "schemaVersion": 1,
        "revision": 0,
        "artifacts": [],
    }
    assert json.loads((root / "legacy-metadata.json").read_text("utf-8")) == {
        "schemaVersion": 1,
        "revision": 0,
        "entries": {},
    }
    marker = json.loads((root / "migration-v1.json").read_text("utf-8"))
    assert marker["backupId"] == result.backup_id
    assert marker["schemaVersion"] == 1
    assert list((root / "artifacts").glob("*.json")) == []
    assert (root / "backups" / result.backup_id / "manifest.json").exists()


def test_existing_legacy_skills_are_scanned_and_manifested_without_native_duplication(
    tmp_path: Path,
) -> None:
    home = tmp_path / "home"
    skill = write_legacy_skill(home)
    expected = hashlib.sha256(skill.read_bytes()).hexdigest()
    root = home / "tools"

    result = ToolDataMigrator(root=root).migrate_from_v0_9()
    manifest = json.loads(
        (root / "backups" / result.backup_id / "manifest.json").read_text("utf-8")
    )

    assert manifest["sources"] == [
        {"kind": "legacy", "name": "skills/hello.json", "sha256": expected}
    ]
    assert ToolArtifactStore(root=root).list() == []
    assert list((root / "artifacts").glob("*.json")) == []


class _FindingScanner:
    def scan_bytes(self, name: str, _data: bytes) -> tuple[SecretFinding, ...]:
        return (SecretFinding(kind="test-secret", file=name, line=1, column=1),)

    def scan_json(self, _name: str, _value: object) -> tuple[()]:
        return ()


def test_scanner_finding_aborts_before_backup_or_primary_commit(tmp_path: Path) -> None:
    home = tmp_path / "home"
    write_legacy_skill(home)
    root = home / "tools"

    with pytest.raises(SecretDetectedError):
        ToolDataMigrator(root=root, scanner=_FindingScanner()).migrate_from_v0_9()

    assert not (root / "index.json").exists()
    assert not (root / "legacy-metadata.json").exists()
    assert not (root / "migration-v1.json").exists()
    assert not (root / "backups").exists()


def test_existing_migration_marker_does_not_bypass_current_secret_scan(
    tmp_path: Path,
) -> None:
    root = tmp_path / "home" / "tools"
    store = ToolArtifactStore(root=root)
    store.create(draft("Before"))
    ToolDataMigrator(root=root).migrate_from_v0_9()
    artifact_path = next((root / "artifacts").glob("*.json"))
    artifact = json.loads(artifact_path.read_text("utf-8"))
    artifact["source"]["provenance"]["accessToken"] = "opaque-provider-value"
    artifact_path.write_text(json.dumps(artifact), encoding="utf-8")

    with pytest.raises(SecretDetectedError):
        ToolDataMigrator(root=root).migrate_from_v0_9()


def test_json_escaped_secret_key_aborts_before_backup_or_marker(tmp_path: Path) -> None:
    root = tmp_path / "home" / "tools"
    legacy = tmp_path / "home" / "skills"
    legacy.mkdir(parents=True)
    (legacy / "unsafe.json").write_text(
        r'{"name":"unsafe","template":"safe","template_type":"jsx","client\u0053ecret":[{"value":"opaque-provider-value"}]}',
        encoding="utf-8",
    )

    with pytest.raises(SecretDetectedError):
        ToolDataMigrator(root=root, legacy_roots=(legacy,)).migrate_from_v0_9()

    assert not (root / "backups").exists()
    assert not (root / "migration-v1.json").exists()


def test_existing_marker_rescans_json_decoded_secret_keys_without_new_backup(
    tmp_path: Path,
) -> None:
    root = tmp_path / "home" / "tools"
    legacy = tmp_path / "home" / "skills"
    legacy.mkdir(parents=True)
    first = ToolDataMigrator(root=root, legacy_roots=(legacy,)).migrate_from_v0_9()
    backups_before = sorted((root / "backups").glob("*/manifest.json"))
    marker_before = (root / "migration-v1.json").read_bytes()
    (legacy / "unsafe.json").write_text(
        r'{"name":"unsafe","template":"safe","template_type":"jsx","auth\u002etoken":{"nested":["opaque-provider-value"]}}',
        encoding="utf-8",
    )

    with pytest.raises(SecretDetectedError):
        ToolDataMigrator(root=root, legacy_roots=(legacy,)).migrate_from_v0_9()

    assert first.backup_id
    assert sorted((root / "backups").glob("*/manifest.json")) == backups_before
    assert (root / "migration-v1.json").read_bytes() == marker_before


@pytest.mark.parametrize("stage", ["after-backup", "after-index", "before-marker"])
def test_injected_crashes_resume_idempotently_without_duplicate_backups(
    tmp_path: Path, stage: str
) -> None:
    root = tmp_path / stage / "tools"

    def crash(point: str) -> None:
        if point == stage:
            raise RuntimeError("injected crash")

    with pytest.raises(RuntimeError, match="injected crash"):
        ToolDataMigrator(root=root, fault_hook=crash).migrate_from_v0_9()

    first_backups = sorted((root / "backups").glob("*/manifest.json"))
    assert len(first_backups) == 1
    resumed = ToolDataMigrator(root=root).migrate_from_v0_9()
    repeated = ToolDataMigrator(root=root).migrate_from_v0_9()

    assert resumed.migrated is True
    assert repeated.migrated is False
    assert repeated.backup_id == resumed.backup_id
    assert len(list((root / "backups").glob("*/manifest.json"))) == 1


def test_rollback_restores_pre_migration_index_and_artifacts(tmp_path: Path) -> None:
    root = tmp_path / "home" / "tools"
    store = ToolArtifactStore(root=root)
    before = store.create(draft("Before"))
    result = ToolDataMigrator(root=root).migrate_from_v0_9()
    current = ToolArtifactStore(root=root)
    current.create(draft("After"))

    ToolDataMigrator(root=root).rollback(result.backup_id)
    restored = ToolArtifactStore(root=root)

    assert [item.id for item in restored.list()] == [before.id]
    assert restored.get(before.id).content == before.content
    assert not (root / "migration-v1.json").exists()


def test_prune_backups_enforces_three_copy_and_thirty_day_retention(tmp_path: Path) -> None:
    root = tmp_path / "tools"
    now = 2_000_000_000_000
    backups = root / "backups"
    day = 24 * 60 * 60 * 1000
    for index, age_days in enumerate((60, 4, 3, 2, 1)):
        target = backups / f"backup-{index}"
        target.mkdir(parents=True)
        atomic_write_json(
            target / "manifest.json",
            {
                "schemaVersion": 1,
                "backupId": target.name,
                "createdAt": now - age_days * day,
                "hadIndex": False,
                "hadLegacyMetadata": False,
                "artifacts": [],
                "sources": [],
            },
        )

    ToolDataMigrator(root=root, now=lambda: now).prune_backups(
        retain_count=3, retain_days=30
    )

    assert sorted(path.name for path in backups.iterdir()) == [
        "backup-2",
        "backup-3",
        "backup-4",
    ]


def test_migration_errors_have_stable_codes_and_hide_paths(tmp_path: Path) -> None:
    root = tmp_path / "tools"
    with pytest.raises(ToolMigrationError) as caught:
        ToolDataMigrator(root=root).rollback("../private-path")

    assert caught.value.code == "tool_migration_invalid_backup"
    assert str(tmp_path) not in str(caught.value)
    assert "private-path" not in str(caught.value)
