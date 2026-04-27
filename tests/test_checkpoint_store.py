"""Unit tests for checkpoint_store — pure filesystem, no AE dependency."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from after_effects_mcp.checkpoint_store import CheckpointStore


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


def test_store_root_per_basename(tmp_path):
    store = CheckpointStore(root=tmp_path)
    p = store._dir_for("C:/projects/MyProject.aep")
    assert p == tmp_path / "MyProject"
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
    monkeypatch.setenv("AEBM_CHECKPOINT_KEEP", "2")
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
