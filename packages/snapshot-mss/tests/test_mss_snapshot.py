"""Unit tests for MssSnapshotter (mss + PIL mocked where needed)."""
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch
import pytest

from ae_mcp_snapshot_mss import MssSnapshotter
from ae_mcp_snapshot_mss._hwnd_rect import _select_largest_ae_window, _is_ae_window


def test_supports_platform_always_true():
    assert MssSnapshotter().supports_platform() is True


def test_name_is_mss():
    assert MssSnapshotter.name == "mss"


@pytest.mark.asyncio
async def test_capture_writes_png(tmp_path):
    out = tmp_path / "smoke.png"
    s = MssSnapshotter()

    fake_shot = MagicMock()
    fake_shot.size = (10, 10)
    fake_shot.rgb = b"\xff" * (10 * 10 * 3)

    with patch("ae_mcp_snapshot_mss.find_ae_main_hwnd", return_value=0x1234), \
         patch("ae_mcp_snapshot_mss.hwnd_to_rect", return_value=(0, 0, 10, 10)), \
         patch("mss.mss") as mss_factory:
        mss_inst = MagicMock()
        mss_inst.__enter__ = MagicMock(return_value=mss_inst)
        mss_inst.__exit__ = MagicMock(return_value=False)
        mss_inst.monitors = [None, {"left": 0, "top": 0, "width": 10, "height": 10}]
        mss_inst.grab = MagicMock(return_value=fake_shot)
        mss_factory.return_value = mss_inst

        result = await s.capture(out)

    assert result["ok"] is True
    assert out.exists()
    assert result["path"] == str(out)
    assert result["width"] == 10
    assert result["height"] == 10


@pytest.mark.asyncio
async def test_capture_zero_size_returns_error():
    s = MssSnapshotter()
    with patch("ae_mcp_snapshot_mss.hwnd_to_rect", return_value=(0, 0, 0, 0)):
        r = await s.capture(Path("/tmp/x.png"), hwnd="0x1234")
    assert r["ok"] is False
    assert "zero size" in r["error"]


@pytest.mark.asyncio
async def test_capture_no_ae_window_returns_error_not_desktop(tmp_path):
    """When no AfterFX.exe window is found, capture must surface a clear error
    instead of silently grabbing the whole primary monitor."""
    out = tmp_path / "should_not_exist.png"
    s = MssSnapshotter()

    with patch("ae_mcp_snapshot_mss.find_ae_main_hwnd", return_value=None), \
         patch("mss.mss") as mss_factory:
        result = await s.capture(out)

    assert result["ok"] is False
    assert "After Effects window not found" in result["error"]
    # The desktop must NOT have been captured.
    mss_factory.assert_not_called()
    assert not out.exists()


# --- window selection policy (process-name based, title-independent) --------


def test_is_ae_window_matches_only_afterfx_exe():
    assert _is_ae_window("AfterFX.exe") is True
    assert _is_ae_window("afterfx.exe") is True  # case-insensitive
    assert _is_ae_window("chrome.exe") is False
    assert _is_ae_window(None) is False
    assert _is_ae_window("") is False


def test_select_picks_afterfx_not_browser_tab():
    """A browser tab titled 'After Effects tutorial' (chrome.exe) must be
    ignored; the real AfterFX.exe window is chosen even when smaller."""
    windows = [
        # Big chrome window with an "After Effects" title — must be skipped.
        {"hwnd": 1, "visible": True, "exe": "chrome.exe",
         "rect": (0, 0, 1920, 1080)},
        # Smaller genuine AE window on a second monitor.
        {"hwnd": 2, "visible": True, "exe": "AfterFX.exe",
         "rect": (1920, 0, 1920 + 1280, 720)},
    ]
    assert _select_largest_ae_window(windows) == 2


def test_select_picks_largest_when_multiple_ae_windows():
    windows = [
        {"hwnd": 10, "visible": True, "exe": "AfterFX.exe",
         "rect": (0, 0, 400, 300)},          # area 120000
        {"hwnd": 11, "visible": True, "exe": "AfterFX.exe",
         "rect": (0, 0, 1280, 720)},         # area 921600 -> winner
    ]
    assert _select_largest_ae_window(windows) == 11


def test_select_returns_none_when_no_ae_window():
    windows = [
        {"hwnd": 1, "visible": True, "exe": "chrome.exe",
         "rect": (0, 0, 800, 600)},
        {"hwnd": 2, "visible": False, "exe": "AfterFX.exe",
         "rect": (0, 0, 800, 600)},   # AE but not visible
    ]
    assert _select_largest_ae_window(windows) is None


