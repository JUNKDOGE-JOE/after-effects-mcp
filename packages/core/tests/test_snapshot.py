"""Snapshot ctypes signatures. Actual BitBlt requires AE + a live display,
so the real capture is validated by E2E (see verification section in plan)."""

from __future__ import annotations

import sys

import pytest


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only")
def test_snapshot_module_loads():
    from ae_mcp import snapshot
    assert hasattr(snapshot, "capture_ae_viewer")
    assert hasattr(snapshot, "get_ae_main_hwnd")
    assert hasattr(snapshot, "enum_ae_child_windows")
    assert hasattr(snapshot, "pick_viewer_hwnd")


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only")
def test_constants():
    from ae_mcp import snapshot
    assert snapshot.SRCCOPY == 0x00CC0020
    assert snapshot.CAPTUREBLT == 0x40000000
    assert snapshot.PW_RENDERFULLCONTENT == 0x2


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only")
def test_rect_layout():
    from ae_mcp import snapshot
    import ctypes
    r = snapshot.RECT(1, 2, 3, 4)
    assert r.left == 1 and r.top == 2 and r.right == 3 and r.bottom == 4
    assert ctypes.sizeof(r) == 16  # 4x c_long


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only")
def test_capture_rejects_bad_method():
    from ae_mcp import snapshot
    with pytest.raises(ValueError):
        snapshot.capture_ae_viewer(method="BogusMethod")
