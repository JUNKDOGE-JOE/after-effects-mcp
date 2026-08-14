"""Destination resolution shared by every snapshot backend (#243)."""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest

from ae_mcp.snapshot.base import SNAPSHOT_ROOT, Snapshotter, resolve_snapshot_path


def test_default_destination_is_absolute_and_not_the_working_directory(tmp_path):
    """The reported failure was a bare filename resolved against the CWD.

    Asserting "absolute" is not enough on its own -- a relative default would
    still look fine from a writable CWD, which is exactly why this shipped. The
    check that matters is that the result does not depend on where the process
    was started.
    """
    original = Path.cwd()
    os.chdir(tmp_path)
    try:
        first = resolve_snapshot_path(None)
    finally:
        os.chdir(original)

    assert first.is_absolute()
    assert tmp_path not in first.parents
    assert Path(tempfile.gettempdir()) in first.parents
    assert first.parent.is_dir()


def test_default_destinations_do_not_collide():
    """A millisecond timestamp is shared by two captures in the same tick."""
    names = {resolve_snapshot_path(None).name for _ in range(50)}
    assert len(names) == 50


def test_an_explicit_destination_is_honoured_and_its_parent_created(tmp_path):
    requested = tmp_path / "nested" / "shot.png"
    resolved = resolve_snapshot_path(requested)
    assert resolved == requested
    assert resolved.parent.is_dir()


def test_backends_inherit_the_resolver_rather_than_reimplementing_it(tmp_path):
    class _Backend(Snapshotter):
        name = "probe"

        def supports_platform(self) -> bool:
            return True

        async def capture(self, out_path, **kwargs) -> dict:
            return {"ok": True, "path": str(self.resolve_out_path(out_path))}

    resolved = Path(_Backend().resolve_out_path(None))
    assert resolved.is_absolute()
    assert resolved.parent == SNAPSHOT_ROOT
