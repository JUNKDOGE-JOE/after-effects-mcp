from __future__ import annotations

import json
import os
import socket
import time
from pathlib import Path

import pytest

from ae_mcp.tool_artifact import ToolArtifactDraft, ToolSource
from ae_mcp.tool_store import (
    StoreLock,
    ToolArtifactStore,
    ToolNotFound,
    ToolRevisionConflict,
    ToolStoreLocked,
    ToolStoreCorrupt,
    ToolStoreRevisionConflict,
    ToolStoreRootChanged,
    ToolStoreWriteError,
)


def draft(
    name: str = "One", content: str = "return 1;", status: str = "saved"
) -> ToolArtifactDraft:
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
        status=status,
        content=content,
        args_schema={},
    )


def test_persists_artifacts_and_rejects_stale_artifact_and_store_revisions(tmp_path: Path) -> None:
    root = tmp_path / "tools"
    store = ToolArtifactStore(root=root)
    first = store.create(draft(), expected_store_revision=0)
    second = store.edit(
        first.id,
        {"description": "new"},
        expected_revision=first.revision,
        expected_content_hash=first.content_hash,
    )

    with pytest.raises(ToolRevisionConflict) as stale:
        store.edit(
            first.id,
            {"description": "stale"},
            expected_revision=first.revision,
            expected_content_hash=first.content_hash,
        )
    with pytest.raises(ToolStoreRevisionConflict) as stale_store:
        store.create(draft("Two"), expected_store_revision=0)

    reopened = ToolArtifactStore(root=root)
    assert reopened.get(first.id).description == second.description
    assert stale.value.code == "tool_revision_conflict"
    assert stale_store.value.code == "tool_store_revision_conflict"


def test_atomic_batch_failure_leaves_no_index_or_artifact_partial_commit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = ToolArtifactStore(root=tmp_path / "tools")
    before = store.store_revision()

    def fail_index(_value: object) -> None:
        raise OSError("private-path-and-content")

    monkeypatch.setattr(store, "_replace_index", fail_index)
    with pytest.raises(ToolStoreWriteError) as caught:
        store.create_many_atomic(
            [draft("One"), draft("Two")],
            expected_store_revision=before,
        )

    assert caught.value.code == "tool_store_write_failed"
    assert "private-path-and-content" not in str(caught.value)
    assert str(tmp_path) not in str(caught.value)
    assert store.store_revision() == before
    assert store.list() == []
    assert list((store.root / "artifacts").glob("*.json")) == []


def test_index_search_and_content_hash_lookup_never_return_content(tmp_path: Path) -> None:
    store = ToolArtifactStore(root=tmp_path / "tools")
    created = store.create(draft(content="TOP SECRET BODY"))

    summary = store.list()[0]
    searched, total = store.search("One", limit=50)
    by_hash = store.find_by_content_hash("jsx", created.content_hash)

    assert total == 1
    assert searched == [summary]
    assert by_hash == [summary]
    assert not hasattr(summary, "content")
    assert "TOP SECRET BODY" not in (store.root / "index.json").read_text("utf-8")


def test_reads_fail_closed_for_secret_bearing_legacy_index_and_artifact(
    tmp_path: Path,
) -> None:
    index_root = tmp_path / "index-tools"
    index_store = ToolArtifactStore(root=index_root)
    index_store.create(draft())
    index = json.loads(index_store.index_path.read_text("utf-8"))
    index["artifacts"][0]["description"] = "clientSecret=opaque-provider-value"
    index_store.index_path.write_text(json.dumps(index), encoding="utf-8")
    with pytest.raises(ToolStoreCorrupt):
        index_store.list()

    artifact_root = tmp_path / "artifact-tools"
    artifact_store = ToolArtifactStore(root=artifact_root)
    created = artifact_store.create(draft())
    artifact_path = next(artifact_store.artifacts_dir.glob("*.json"))
    artifact = json.loads(artifact_path.read_text("utf-8"))
    artifact["source"]["provenance"]["auth.token"] = "opaque-provider-value"
    artifact_path.write_text(json.dumps(artifact), encoding="utf-8")
    with pytest.raises(ToolStoreCorrupt):
        artifact_store.get(created.id)


class _ReplacingScanner:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.replaced = False

    def scan_bytes(self, _name: str, _data: bytes) -> tuple[()]:
        if not self.replaced:
            original = self.root.with_name("tools-original")
            self.root.rename(original)
            self.root.mkdir()
            self.replaced = True
        return ()

    def scan_json(self, _name: str, _value: object) -> tuple[()]:
        return ()


def test_mutation_fails_closed_when_tools_root_is_replaced_after_lock(tmp_path: Path) -> None:
    root = tmp_path / "tools"
    scanner = _ReplacingScanner(root)
    store = ToolArtifactStore(root=root, scanner=scanner)

    with pytest.raises(ToolStoreRootChanged) as caught:
        store.create(draft(content="replacement boundary"))

    assert caught.value.code == "tool_store_root_changed"
    assert not (root / "index.json").exists()
    assert list(root.rglob("*.json")) == []


def test_stale_lock_recovery_re_reads_nonce_before_removal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "tools"
    lock_dir = root / ".store-lock"
    lock_dir.mkdir(parents=True)
    first = {
        "pid": 999_999_999,
        "hostname": socket.gethostname(),
        "createdAt": int((time.time() - 120) * 1000),
        "nonce": "first",
    }
    second = {**first, "nonce": "replacement"}
    (lock_dir / "owner.json").write_text(json.dumps(first), encoding="utf-8")
    real_read = StoreLock._read_owner
    reads = 0

    def changing_read(self: StoreLock) -> dict[str, object] | None:
        nonlocal reads
        reads += 1
        if reads == 2:
            (lock_dir / "owner.json").write_text(json.dumps(second), encoding="utf-8")
        return real_read(self)

    monkeypatch.setattr(StoreLock, "_read_owner", changing_read)
    with pytest.raises(ToolStoreLocked) as caught:
        with StoreLock(root, timeout_sec=0.0, stale_after_sec=30.0):
            pytest.fail("changed lock nonce must not be acquired")

    assert caught.value.code == "tool_store_locked"
    assert lock_dir.exists()
    assert json.loads((lock_dir / "owner.json").read_text("utf-8"))["nonce"] == "replacement"


def test_public_store_errors_have_stable_codes_and_hide_paths_and_content(tmp_path: Path) -> None:
    store = ToolArtifactStore(root=tmp_path / "tools")
    secret = "content-that-must-not-appear"
    created = store.create(draft(content=secret))
    errors: list[Exception] = []

    for operation in (
        lambda: store.get("user:00000000-0000-0000-0000-000000000000"),
        lambda: store.delete(
            created.id,
            expected_revision=created.revision + 1,
            expected_content_hash=created.content_hash,
        ),
    ):
        try:
            operation()
        except (ToolNotFound, ToolRevisionConflict) as error:
            errors.append(error)

    assert [getattr(error, "code", None) for error in errors] == [
        "tool_not_found",
        "tool_revision_conflict",
    ]
    for error in errors:
        assert str(tmp_path) not in str(error)
        assert secret not in str(error)


def test_committed_mutations_publish_after_disk_state_is_visible(tmp_path: Path) -> None:
    store = ToolArtifactStore(root=tmp_path / "tools")
    observed: list[tuple[str, int, int]] = []
    unsubscribe = store.subscribe(
        lambda mutation: observed.append(
            (
                mutation.kind,
                mutation.store_revision,
                ToolArtifactStore(root=store.root).store_revision(),
            )
        )
    )
    created = store.create(draft())
    unsubscribe()
    store.archive(
        created.id,
        expected_revision=created.revision,
        expected_content_hash=created.content_hash,
    )

    assert observed == [("create", 1, 1)]


def test_candidate_promotion_can_atomically_replace_and_verification_clears_on_content_edit(
    tmp_path: Path,
) -> None:
    store = ToolArtifactStore(root=tmp_path / "tools")
    existing = store.create(draft("Existing"))
    candidate = store.create(draft("Candidate", status="candidate"))
    observed = []
    unsubscribe = store.subscribe(observed.append)

    promoted = store.edit(
        candidate.id,
        {"status": "saved", "verification_action": "mark-reviewed"},
        expected_revision=candidate.revision,
        expected_content_hash=candidate.content_hash,
        replace_artifact_id=existing.id,
    )
    unsubscribe()

    assert promoted.status == "saved"
    assert promoted.verified is True
    assert promoted.verification is not None
    assert promoted.verification.evidence_hash == promoted.content_hash
    with pytest.raises(ToolNotFound):
        store.get(existing.id)
    assert observed[-1].kind == "edit"
    assert observed[-1].artifact_ids == (candidate.id, existing.id)

    changed = store.edit(
        promoted.id,
        {"content": "return 2;"},
        expected_revision=promoted.revision,
        expected_content_hash=promoted.content_hash,
    )
    assert changed.verified is False
    assert changed.verification is None


def test_edit_rejects_status_transitions_reserved_for_archive(tmp_path: Path) -> None:
    store = ToolArtifactStore(root=tmp_path / "tools")
    candidate = store.create(draft(status="candidate"))
    with pytest.raises(Exception) as caught:
        store.edit(
            candidate.id,
            {"status": "pinned"},
            expected_revision=candidate.revision,
            expected_content_hash=candidate.content_hash,
        )
    assert getattr(caught.value, "code", None) == "tool_store_invalid_request"


@pytest.mark.skipif(os.name == "nt", reason="POSIX permissions only")
def test_store_files_are_private_on_posix(tmp_path: Path) -> None:
    store = ToolArtifactStore(root=tmp_path / "tools")
    artifact = store.create(draft())
    artifact_path = store.root / "artifacts" / f"{artifact.id.removeprefix('user:')}.json"
    assert artifact_path.stat().st_mode & 0o777 == 0o600
    assert (store.root / "index.json").stat().st_mode & 0o777 == 0o600
