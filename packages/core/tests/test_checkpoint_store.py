"""Unit tests for checkpoint_store — pure filesystem, no AE dependency."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from ae_mcp.checkpoint_store import CheckpointStore


def _touch_aep(path: Path, size: int = 1024) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\x00" * size)


def _write_meta(path: Path, **fields) -> None:
    meta = {
        "id": fields["id"],
        "label": fields.get("label", ""),
        "ts": fields["ts"],
        "sourceProjectPath": fields.get("sourceProjectPath", "C:/p.aep"),
        "activeCompId": fields.get("activeCompId"),
        "currentTime": fields.get("currentTime", 0.0),
        "sizeBytes": fields.get("sizeBytes", 1024),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(meta), encoding="utf-8")


def test_store_root_per_full_path(tmp_path):
    store = CheckpointStore(root=tmp_path)
    p = store._dir_for("C:/projects/MyProject.aep")
    # Dir key keeps a human-readable stem prefix plus a path hash suffix.
    assert p.parent == tmp_path
    assert p.name.startswith("MyProject_")
    assert p.name != "MyProject"
    p2 = store._dir_for(None)
    assert p2 == tmp_path / "_untitled"


def test_same_basename_different_paths_get_different_dirs(tmp_path):
    # Same-basename projects in different directories must not collide.
    store = CheckpointStore(root=tmp_path)
    da = store._dir_for("C:/a/project.aep")
    db = store._dir_for("C:/b/project.aep")
    assert da != db
    # Both keep the readable stem prefix for debuggability.
    assert da.name.startswith("project_")
    assert db.name.startswith("project_")


def test_same_path_is_stable_key(tmp_path):
    # The same file (even with differing separators/case) hashes the same.
    store = CheckpointStore(root=tmp_path)
    d1 = store._dir_for("C:/projects/Same.aep")
    d2 = store._dir_for("C:\\projects\\Same.aep")
    assert d1 == d2


def test_checkpoints_isolated_across_same_basename_paths(tmp_path):
    # lookup_aep / list_checkpoints for path A never return path B's data.
    store = CheckpointStore(root=tmp_path)
    path_a = "C:/a/project.aep"
    path_b = "C:/b/project.aep"

    da = store._dir_for(path_a)
    _touch_aep(da / "aaa_1.aep")
    store.write_meta(source_project_path=path_a, cid="aaa_1", label="A",
                     active_comp_id=None, current_time=0.0, size_bytes=1024)

    db = store._dir_for(path_b)
    _touch_aep(db / "bbb_2.aep")
    store.write_meta(source_project_path=path_b, cid="bbb_2", label="B",
                     active_comp_id=None, current_time=0.0, size_bytes=1024)

    listed_a = store.list_checkpoints(path_a, limit=10)
    listed_b = store.list_checkpoints(path_b, limit=10)
    assert [c["id"] for c in listed_a] == ["aaa_1"]
    assert [c["id"] for c in listed_b] == ["bbb_2"]

    # lookup_aep must not cross over.
    assert store.lookup_aep(path_a, "aaa_1") == da / "aaa_1.aep"
    assert store.lookup_aep(path_a, "bbb_2") is None
    assert store.lookup_aep(path_b, "bbb_2") == db / "bbb_2.aep"
    assert store.lookup_aep(path_b, "aaa_1") is None


def test_list_filters_mismatched_source_path(tmp_path):
    # Belt-and-suspenders: a stray sidecar naming a different project that
    # somehow lands in this dir is filtered out of results.
    store = CheckpointStore(root=tmp_path)
    path_a = "C:/a/project.aep"
    d = store._dir_for(path_a)
    # Legit entry for A.
    _touch_aep(d / "good_1.aep")
    store.write_meta(source_project_path=path_a, cid="good_1", label="ok",
                     active_comp_id=None, current_time=0.0, size_bytes=1024)
    # Stray entry that claims a DIFFERENT project path.
    _touch_aep(d / "stray_2.aep")
    _write_meta(d / "stray_2.json", id="stray_2", ts="2026-04-27T11:00:00Z",
                sourceProjectPath="C:/somewhere/else.aep")

    listed = store.list_checkpoints(path_a, limit=10)
    assert [c["id"] for c in listed] == ["good_1"]


def test_prune_isolated_per_project(tmp_path):
    # prune for path A must not delete path B's checkpoints.
    store = CheckpointStore(root=tmp_path, keep=1)
    path_a = "C:/a/project.aep"
    path_b = "C:/b/project.aep"
    da = store._dir_for(path_a)
    db = store._dir_for(path_b)
    for i in range(3):
        ident = f"1714209600{i:03d}_a"
        _touch_aep(da / f"{ident}.aep")
        store.write_meta(source_project_path=path_a, cid=ident, label="A",
                         active_comp_id=None, current_time=0.0, size_bytes=1024)
    _touch_aep(db / "keepme_b.aep")
    store.write_meta(source_project_path=path_b, cid="keepme_b", label="B",
                     active_comp_id=None, current_time=0.0, size_bytes=1024)

    removed = store.prune(path_a)
    assert len(removed) == 2  # kept 1 of 3 for A
    # B is untouched.
    assert (db / "keepme_b.aep").exists()
    assert [c["id"] for c in store.list_checkpoints(path_b, limit=10)] == ["keepme_b"]


def test_store_root_per_basename(tmp_path):
    store = CheckpointStore(root=tmp_path)
    p2 = store._dir_for(None)
    assert p2 == tmp_path / "_untitled"


def test_make_id_unique_and_sortable(tmp_path):
    store = CheckpointStore(root=tmp_path)
    ids = [store.make_id() for _ in range(5)]
    assert len(set(ids)) == 5
    assert all("_" in i for i in ids)
    # First segment is unix-ms timestamp; sortable lexicographically.
    assert sorted(ids) == sorted(ids, key=lambda s: int(s.split("_")[0]))


def test_list_returns_descending_by_ts(tmp_path):
    store = CheckpointStore(root=tmp_path)
    base = "C:/p.aep"
    d = store._dir_for(base)
    for ts, ident in [
        ("2026-04-27T10:00:00Z", "1714209600000_a"),
        ("2026-04-27T11:00:00Z", "1714213200000_b"),
        ("2026-04-27T09:00:00Z", "1714206000000_c"),
    ]:
        _touch_aep(d / f"{ident}.aep")
        _write_meta(d / f"{ident}.json", id=ident, ts=ts)

    listed = store.list_checkpoints(base, limit=10)
    assert [c["id"] for c in listed] == [
        "1714213200000_b", "1714209600000_a", "1714206000000_c"
    ]


def test_list_clamps_limit(tmp_path):
    store = CheckpointStore(root=tmp_path)
    base = "C:/p.aep"
    d = store._dir_for(base)
    for i in range(15):
        ident = f"171420960{i:04d}_x"
        _touch_aep(d / f"{ident}.aep")
        _write_meta(d / f"{ident}.json", id=ident, ts=f"2026-04-27T10:00:{i:02d}Z")

    assert len(store.list_checkpoints(base, limit=5)) == 5


def test_list_skips_orphan_meta(tmp_path):
    store = CheckpointStore(root=tmp_path)
    base = "C:/p.aep"
    d = store._dir_for(base)
    # Orphan: meta but no .aep
    _write_meta(d / "orphan.json", id="orphan", ts="2026-04-27T10:00:00Z")
    listed = store.list_checkpoints(base, limit=10)
    assert listed == []
    # Orphan meta should also be cleaned up
    assert not (d / "orphan.json").exists()


def test_lookup_returns_path(tmp_path):
    store = CheckpointStore(root=tmp_path)
    base = "C:/p.aep"
    d = store._dir_for(base)
    _touch_aep(d / "abc_x.aep")
    _write_meta(d / "abc_x.json", id="abc_x", ts="2026-04-27T10:00:00Z")

    p = store.lookup_aep(base, "abc_x")
    assert p == d / "abc_x.aep"

    assert store.lookup_aep(base, "missing") is None


def test_list_from_checkpoint_file_uses_original_source(tmp_path):
    store = CheckpointStore(root=tmp_path)
    base = "C:/projects/p.aep"
    d = store._dir_for(base)
    cid = "abc_x"
    _touch_aep(d / f"{cid}.aep")
    store.write_meta(
        source_project_path=base,
        cid=cid,
        label="seed",
        active_comp_id=None,
        current_time=0.0,
        size_bytes=1024,
    )

    listed = store.list_checkpoints(str(d / f"{cid}.aep"), limit=10)
    assert [c["id"] for c in listed] == [cid]
    assert store.lookup_aep(str(d / f"{cid}.aep"), cid) == d / f"{cid}.aep"


def test_prune_keeps_n_newest(tmp_path):
    store = CheckpointStore(root=tmp_path, keep=3)
    base = "C:/p.aep"
    d = store._dir_for(base)
    for i in range(7):
        ident = f"17142096{i:05d}_x"
        _touch_aep(d / f"{ident}.aep")
        _write_meta(d / f"{ident}.json", id=ident, ts=f"2026-04-27T10:00:{i:02d}Z")

    removed = store.prune(base)
    assert len(removed) == 4
    remaining = sorted(p.stem for p in d.glob("*.aep"))
    assert len(remaining) == 3


def test_keep_env_override(monkeypatch, tmp_path):
    monkeypatch.setenv("AE_MCP_CHECKPOINT_KEEP", "2")
    store = CheckpointStore(root=tmp_path)
    assert store.keep == 2


def test_write_meta_roundtrip(tmp_path):
    store = CheckpointStore(root=tmp_path)
    base = "C:/p.aep"
    d = store._dir_for(base)
    d.mkdir(parents=True, exist_ok=True)
    aep = d / "id_x.aep"
    _touch_aep(aep, size=2048)

    store.write_meta(
        source_project_path=base,
        cid="id_x",
        label="hello",
        active_comp_id="12",
        current_time=1.5,
        size_bytes=2048,
    )
    meta = json.loads((d / "id_x.json").read_text(encoding="utf-8"))
    assert meta["label"] == "hello"
    assert meta["sizeBytes"] == 2048
    assert meta["activeCompId"] == "12"
    assert "ts" in meta and meta["ts"].endswith("Z")
