"""Unit tests for MssSnapshotter (mss + PIL mocked where needed)."""
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch
import pytest

from ae_mcp_snapshot_mss import MssSnapshotter


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

    with patch("mss.mss") as mss_factory:
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
