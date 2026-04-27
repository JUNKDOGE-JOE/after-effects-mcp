"""Tests for snapshotter discovery."""
import pytest
from unittest.mock import patch

from ae_mcp.snapshot.base import Snapshotter
from ae_mcp.snapshot.discovery import (
    select_snapshotter, list_installed_snapshotters, SnapshotSelectionError,
)


class FakeSnap(Snapshotter):
    name = "fake"
    async def capture(self, out_path, *, hwnd=None, main_window=False, method="auto"):
        return {"ok": True, "path": str(out_path), "bytes": 100, "width": 10, "height": 10}
    def supports_platform(self): return True


class FakeSnapBadOS(Snapshotter):
    name = "bados"
    async def capture(self, out_path, **kw): return {"ok": True}
    def supports_platform(self): return False


def _patch_installed(installed):
    return patch("ae_mcp.snapshot.discovery._scan_entry_points",
                 return_value=installed)


def test_no_snapshotter_returns_none():
    with _patch_installed({}):
        assert select_snapshotter() is None


def test_one_supported_returns_it():
    with _patch_installed({"fake": FakeSnap}):
        s = select_snapshotter()
        assert isinstance(s, FakeSnap)


def test_unsupported_platform_filtered_out():
    with _patch_installed({"bados": FakeSnapBadOS}):
        assert select_snapshotter() is None


def test_multiple_installed_picks_first_supported():
    with _patch_installed({"bados": FakeSnapBadOS, "fake": FakeSnap}):
        s = select_snapshotter()
        assert isinstance(s, FakeSnap)
