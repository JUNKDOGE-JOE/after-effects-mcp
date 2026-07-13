from __future__ import annotations

import hashlib
import json
import threading
import time
from pathlib import Path

import pytest

from ae_mcp.skill_store import Skill, SkillStore
from ae_mcp.tool_artifact import (
    builtin_artifact_id,
    compute_content_hash,
    legacy_artifact_id,
)
from ae_mcp.tool_legacy import (
    LegacyMetadataStore,
    LegacySkillAdapter,
    ToolLegacyError,
    ToolReadOnly,
)
from ae_mcp.tool_store import ToolRevisionConflict, ToolStoreRevisionConflict


def _skill(
    name: str,
    *,
    template: str = "BODY",
    template_type: str = "prompt",
    description: str = "description",
) -> Skill:
    return Skill(
        name=name,
        description=description,
        template_type=template_type,
        template=template,
        args_schema={},
    )


def _write_skill(root: Path, skill: Skill) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    path = root / f"{skill.name}.json"
    path.write_text(
        json.dumps(skill.to_dict(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return path


def _manifest_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def _write_manifest(root: Path, *paths: Path) -> None:
    (root / "manifest.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "productVersion": "test",
                "artifacts": [
                    {"path": path.name, "sha256": _manifest_digest(path)}
                    for path in paths
                ],
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def _adapter(tmp_path: Path, *, user: Path, bundled: Path) -> LegacySkillAdapter:
    return LegacySkillAdapter(
        skill_store=SkillStore(root=user, bundled_root=bundled),
        metadata_store=LegacyMetadataStore(tmp_path / "tools" / "legacy-metadata.json"),
    )


def test_same_name_user_and_bundled_records_have_exact_distinct_ids(tmp_path):
    user = tmp_path / "user"
    bundled = tmp_path / "bundled"
    user_path = _write_skill(user, _skill("same", template="USER"))
    bundled_path = _write_skill(bundled, _skill("same", template="BUNDLED"))
    _write_manifest(bundled, bundled_path)

    artifacts = _adapter(tmp_path, user=user, bundled=bundled).list()
    by_source = {artifact.source.type: artifact for artifact in artifacts}
    assert by_source["legacy"].id == legacy_artifact_id(user_path.resolve())
    assert by_source["bundled"].id == builtin_artifact_id("same")
    assert by_source["legacy"].id != by_source["bundled"].id
    assert by_source["legacy"].content == "USER"
    assert by_source["bundled"].content == "BUNDLED"


def test_adapter_honors_ae_mcp_skill_dir(monkeypatch, tmp_path):
    user = tmp_path / "configured-skills"
    empty_bundled = tmp_path / "empty-bundled"
    empty_bundled.mkdir()
    path = _write_skill(user, _skill("configured"))
    monkeypatch.setenv("AE_MCP_SKILL_DIR", str(user))
    adapter = LegacySkillAdapter(
        skill_store=SkillStore(bundled_root=empty_bundled),
        metadata_store=LegacyMetadataStore(tmp_path / "tools" / "legacy-metadata.json"),
    )

    artifact = adapter.get(legacy_artifact_id(path.resolve()))
    assert artifact.name == "configured"
    assert artifact.source.ref == str(path.resolve())


def test_legacy_edit_writes_original_json_without_native_artifact_copy(tmp_path):
    user = tmp_path / "user"
    bundled = tmp_path / "bundled"
    bundled.mkdir()
    path = _write_skill(user, _skill("editable", template="OLD", template_type="jsx"))
    adapter = _adapter(tmp_path, user=user, bundled=bundled)
    before = adapter.get(legacy_artifact_id(path.resolve()))

    edited = adapter.edit(
        before.id,
        {"description": "updated", "content": "NEW"},
        expected_revision=before.revision,
        expected_content_hash=before.content_hash,
    )

    on_disk = Skill.from_dict(json.loads(path.read_text(encoding="utf-8")))
    assert on_disk.description == "updated"
    assert on_disk.template == "NEW"
    assert edited.id == before.id
    assert edited.content_hash != before.content_hash
    assert not (tmp_path / "tools" / "artifacts").exists()


def test_legacy_live_reads_and_edits_fail_closed_on_current_secret_rules(tmp_path):
    user = tmp_path / "user"
    bundled = tmp_path / "bundled"
    bundled.mkdir()
    unsafe_path = _write_skill(
        user,
        _skill("unsafe", template='const clientSecret = "opaque-provider-value";'),
    )
    adapter = _adapter(tmp_path, user=user, bundled=bundled)
    with pytest.raises(ToolLegacyError) as unsafe_read:
        adapter.get(legacy_artifact_id(unsafe_path.resolve()))
    assert unsafe_read.value.code == "tool_legacy_secret_detected"

    safe_path = _write_skill(user, _skill("safe", template="SAFE"))
    before = adapter.get(legacy_artifact_id(safe_path.resolve()))
    with pytest.raises(ToolLegacyError) as unsafe_edit:
        adapter.edit(
            before.id,
            {"content": 'auth.token = "opaque-provider-value";'},
            expected_revision=before.revision,
            expected_content_hash=before.content_hash,
        )
    assert unsafe_edit.value.code == "tool_legacy_secret_detected"
    assert Skill.from_dict(json.loads(safe_path.read_text("utf-8"))).template == "SAFE"


def test_pure_metadata_edit_uses_entry_revision_and_preserves_skill_file(tmp_path):
    user = tmp_path / "user"
    bundled = tmp_path / "bundled"
    bundled.mkdir()
    path = _write_skill(user, _skill("metadata", template="UNCHANGED"))
    adapter = _adapter(tmp_path, user=user, bundled=bundled)
    before_bytes = path.read_bytes()
    before = adapter.get(legacy_artifact_id(path.resolve()))

    edited = adapter.edit(
        before.id,
        {
            "category": "animation",
            "tags": ["timing"],
            "status": "pinned",
            "declared_risk": "write",
        },
        expected_revision=before.revision,
        expected_content_hash=before.content_hash,
    )

    assert path.read_bytes() == before_bytes
    assert edited.category == "animation"
    assert edited.tags == ("timing",)
    assert edited.status == "pinned"
    assert edited.declared_risk == "write"
    assert edited.revision == before.revision + 1
    with pytest.raises(ToolRevisionConflict):
        adapter.edit(
            edited.id,
            {"category": "stale"},
            expected_revision=before.revision,
            expected_content_hash=edited.content_hash,
        )
    with pytest.raises(ToolRevisionConflict):
        adapter.delete(
            edited.id,
            expected_revision=before.revision,
            expected_content_hash=edited.content_hash,
        )
    adapter.delete(
        edited.id,
        expected_revision=edited.revision,
        expected_content_hash=edited.content_hash,
    )
    assert not path.exists()


def test_mixed_content_and_metadata_edit_requires_separate_transactions(tmp_path):
    user = tmp_path / "user"
    bundled = tmp_path / "bundled"
    bundled.mkdir()
    path = _write_skill(user, _skill("mixed"))
    adapter = _adapter(tmp_path, user=user, bundled=bundled)
    artifact = adapter.get(legacy_artifact_id(path.resolve()))

    with pytest.raises(ToolLegacyError) as caught:
        adapter.edit(
            artifact.id,
            {"content": "NEW", "category": "animation"},
            expected_revision=artifact.revision,
            expected_content_hash=artifact.content_hash,
        )
    assert caught.value.code == "tool_legacy_transaction_required"
    assert path.read_text(encoding="utf-8").find("NEW") == -1


def test_legacy_edit_uses_native_status_transitions_and_archive_is_separate(tmp_path):
    user = tmp_path / "user"
    bundled = tmp_path / "bundled"
    bundled.mkdir()
    path = _write_skill(user, _skill("status"))
    adapter = _adapter(tmp_path, user=user, bundled=bundled)
    artifact = adapter.get(legacy_artifact_id(path.resolve()))

    with pytest.raises(ToolLegacyError) as direct_archive:
        adapter.edit(
            artifact.id,
            {"status": "archived"},
            expected_revision=artifact.revision,
            expected_content_hash=artifact.content_hash,
        )
    assert direct_archive.value.code == "tool_store_invalid_request"

    pinned = adapter.edit(
        artifact.id,
        {"status": "pinned"},
        expected_revision=artifact.revision,
        expected_content_hash=artifact.content_hash,
    )
    with pytest.raises(ToolLegacyError) as invalid:
        adapter.edit(
            pinned.id,
            {"status": "candidate"},
            expected_revision=pinned.revision,
            expected_content_hash=pinned.content_hash,
        )
    assert invalid.value.code == "tool_store_invalid_request"

    archived = adapter.archive(
        pinned.id,
        expected_revision=pinned.revision,
        expected_content_hash=pinned.content_hash,
    )
    assert archived.status == "archived"


def test_legacy_verification_actions_are_hash_bound_metadata_edits(tmp_path):
    user = tmp_path / "user"
    bundled = tmp_path / "bundled"
    bundled.mkdir()
    path = _write_skill(user, _skill("reviewed", template="BODY"))
    adapter = _adapter(tmp_path, user=user, bundled=bundled)
    before = adapter.get(legacy_artifact_id(path.resolve()))

    reviewed = adapter.edit(
        before.id,
        {"verification_action": "mark-reviewed"},
        expected_revision=before.revision,
        expected_content_hash=before.content_hash,
    )
    assert reviewed.verified is True
    assert reviewed.verification is not None
    assert reviewed.verification.method == "user-reviewed"
    assert reviewed.verification.evidence_hash == reviewed.content_hash

    cleared = adapter.edit(
        reviewed.id,
        {"verification_action": "clear"},
        expected_revision=reviewed.revision,
        expected_content_hash=reviewed.content_hash,
    )
    assert cleared.verified is False
    assert cleared.verification is None


def test_bundled_edit_and_delete_are_read_only(tmp_path):
    user = tmp_path / "user"
    bundled = tmp_path / "bundled"
    path = _write_skill(bundled, _skill("builtin"))
    _write_manifest(bundled, path)
    adapter = _adapter(tmp_path, user=user, bundled=bundled)
    artifact = adapter.get(builtin_artifact_id("builtin"))

    with pytest.raises(ToolReadOnly):
        adapter.edit(
            artifact.id,
            {"description": "no"},
            expected_revision=artifact.revision,
            expected_content_hash=artifact.content_hash,
        )
    with pytest.raises(ToolReadOnly):
        adapter.delete(
            artifact.id,
            expected_revision=artifact.revision,
            expected_content_hash=artifact.content_hash,
        )


def test_bundled_duplicate_returns_native_user_draft(tmp_path):
    user = tmp_path / "user"
    bundled = tmp_path / "bundled"
    path = _write_skill(bundled, _skill("builtin", template="KNOWLEDGE"))
    _write_manifest(bundled, path)
    adapter = _adapter(tmp_path, user=user, bundled=bundled)

    artifact = adapter.get(builtin_artifact_id("builtin"))
    draft = adapter.duplicate(
        artifact.id,
        name="My Copy",
        expected_content_hash=artifact.content_hash,
    )
    assert draft.name == "My Copy"
    assert draft.kind == "prompt-skill"
    assert draft.content == "KNOWLEDGE"
    assert draft.source.type == "user"
    assert draft.status == "saved"
    assert not user.exists()


def test_external_edit_changes_hash_drops_verified_and_fences_stale_edit(tmp_path):
    user = tmp_path / "user"
    bundled = tmp_path / "bundled"
    bundled.mkdir()
    path = _write_skill(user, _skill("external", template="ONE", template_type="jsx"))
    metadata = LegacyMetadataStore(tmp_path / "tools" / "legacy-metadata.json")
    adapter = LegacySkillAdapter(
        skill_store=SkillStore(root=user, bundled_root=bundled),
        metadata_store=metadata,
    )
    artifact_id = legacy_artifact_id(path.resolve())
    before = adapter.get(artifact_id)
    metadata.compare_and_set(
        path,
        before.content_hash,
        {
            "verified": True,
            "verification": {
                "method": "user-reviewed",
                "verifiedAt": 10,
                "evidenceHash": before.content_hash,
            },
        },
        expected_revision=metadata.store_revision(),
    )
    assert adapter.get(artifact_id).verified is True

    _write_skill(user, _skill("external", template="TWO", template_type="jsx"))
    after = adapter.get(artifact_id)
    assert after.content_hash == compute_content_hash("jsx", "TWO", {})
    assert after.content_hash != before.content_hash
    assert after.verified is False
    assert after.verification is None
    with pytest.raises(ToolRevisionConflict) as caught:
        adapter.edit(
            artifact_id,
            {"description": "stale"},
            expected_revision=before.revision,
            expected_content_hash=before.content_hash,
        )
    assert caught.value.code == "tool_revision_conflict"
    with pytest.raises(ToolRevisionConflict):
        adapter.duplicate(
            artifact_id,
            name="stale-copy",
            expected_content_hash=before.content_hash,
        )


def test_legacy_metadata_compare_and_set_rejects_stale_revision(tmp_path):
    path = _write_skill(tmp_path / "skills", _skill("one"))
    content_hash = compute_content_hash("prompt-skill", "BODY", {})
    store = LegacyMetadataStore(tmp_path / "tools" / "legacy-metadata.json")
    revision = store.store_revision()
    store.compare_and_set(
        path,
        content_hash,
        {"category": "workflow"},
        expected_revision=revision,
    )

    with pytest.raises(ToolStoreRevisionConflict) as caught:
        store.compare_and_set(
            path,
            content_hash,
            {"category": "animation"},
            expected_revision=revision,
        )
    assert caught.value.code == "tool_store_revision_conflict"


def test_legacy_metadata_compare_and_set_serializes_cross_instance_cas(tmp_path):
    path = _write_skill(tmp_path / "skills", _skill("concurrent"))
    content_hash = compute_content_hash("prompt-skill", "BODY", {})
    metadata_path = tmp_path / "tools" / "legacy-metadata.json"
    first = LegacyMetadataStore(metadata_path)
    second = LegacyMetadataStore(metadata_path)
    barrier = threading.Barrier(3)
    successes: list[int] = []
    failures: list[Exception] = []

    def slow_read(store):
        original = store._read

        def read():
            state = original()
            time.sleep(0.1)
            return state

        store._read = read

    slow_read(first)
    slow_read(second)

    def update(store, category):
        barrier.wait()
        try:
            successes.append(
                store.compare_and_set(
                    path,
                    content_hash,
                    {"category": category},
                    expected_revision=0,
                )
            )
        except Exception as exc:  # noqa: BLE001
            failures.append(exc)

    threads = [
        threading.Thread(target=update, args=(first, "one")),
        threading.Thread(target=update, args=(second, "two")),
    ]
    for thread in threads:
        thread.start()
    barrier.wait()
    for thread in threads:
        thread.join(timeout=3)

    assert all(not thread.is_alive() for thread in threads)
    assert successes == [1]
    assert len(failures) == 1
    assert isinstance(failures[0], ToolStoreRevisionConflict)
    assert LegacyMetadataStore(metadata_path).store_revision() == 1


def test_real_bundled_manifest_verifies_every_virtual_artifact(tmp_path):
    adapter = LegacySkillAdapter(
        skill_store=SkillStore(root=tmp_path / "user"),
        metadata_store=LegacyMetadataStore(tmp_path / "tools" / "legacy-metadata.json"),
    )
    bundled = [artifact for artifact in adapter.list() if artifact.source.type == "bundled"]
    assert bundled
    assert all(artifact.verified for artifact in bundled)
    assert all(
        artifact.verification and artifact.verification.method == "signed-manifest"
        for artifact in bundled
    )


def test_bundled_manifest_mismatch_fails_closed(tmp_path):
    user = tmp_path / "user"
    bundled = tmp_path / "bundled"
    path = _write_skill(bundled, _skill("builtin", template="ORIGINAL"))
    _write_manifest(bundled, path)
    path.write_text(path.read_text(encoding="utf-8") + " ", encoding="utf-8")
    adapter = _adapter(tmp_path, user=user, bundled=bundled)

    with pytest.raises(ToolLegacyError) as caught:
        adapter.get(builtin_artifact_id("builtin"))
    assert caught.value.code == "tool_bundled_integrity"


def test_legacy_adapter_preserves_old_skill_resolution_order(tmp_path):
    user = tmp_path / "user"
    bundled = tmp_path / "bundled"
    bundled_path = _write_skill(bundled, _skill("same", template="BUNDLED"))
    _write_manifest(bundled, bundled_path)
    _write_skill(user, _skill("same", template="USER"))
    store = SkillStore(root=user, bundled_root=bundled)
    adapter = LegacySkillAdapter(
        skill_store=store,
        metadata_store=LegacyMetadataStore(tmp_path / "tools" / "legacy-metadata.json"),
    )

    assert store.list()[0].template == "USER"
    assert store.load("same").template == "USER"
    assert store.resolve("same").source == "user"
    assert {artifact.source.type for artifact in adapter.list()} == {"legacy", "bundled"}
