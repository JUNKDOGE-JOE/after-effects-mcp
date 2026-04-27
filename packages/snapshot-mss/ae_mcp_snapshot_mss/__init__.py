"""mss-backed cross-platform ae.snapshot implementation."""
from __future__ import annotations

import time
from pathlib import Path
from typing import Optional

import mss
from PIL import Image

from ae_mcp.snapshot.base import Snapshotter
from ae_mcp_snapshot_mss._hwnd_rect import hwnd_to_rect, find_ae_main_hwnd


class MssSnapshotter(Snapshotter):
    name = "mss"

    def supports_platform(self) -> bool:
        # mss runs on Windows, macOS, Linux
        return True

    async def capture(
        self,
        out_path: Optional[Path],
        *,
        hwnd: Optional[str] = None,
        main_window: bool = False,
        method: str = "auto",
    ) -> dict:
        if out_path is None:
            ts = int(time.time() * 1000)
            out_path = Path(f"ae_viewer_{ts}.png")
        out_path = Path(out_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)

        # Resolve target rect
        target_hwnd: Optional[int] = None
        if hwnd:
            target_hwnd = int(hwnd, 16) if hwnd.lower().startswith("0x") else int(hwnd)
        elif main_window:
            target_hwnd = find_ae_main_hwnd()

        rect = hwnd_to_rect(target_hwnd) if target_hwnd else None

        with mss.mss() as sct:
            if rect is None:
                # fallback: capture primary monitor
                monitor = sct.monitors[1]
            else:
                left, top, right, bottom = rect
                width, height = right - left, bottom - top
                if width <= 0 or height <= 0:
                    return {"ok": False, "error":
                            f"target hwnd {target_hwnd:#x} has zero size ({width}x{height})"}
                monitor = {"left": left, "top": top, "width": width, "height": height}
            shot = sct.grab(monitor)
            img = Image.frombytes("RGB", shot.size, shot.rgb)
            img.save(out_path, "PNG")

        return {
            "ok": True,
            "path": str(out_path),
            "bytes": out_path.stat().st_size,
            "width": img.width,
            "height": img.height,
            "hwnd": f"0x{target_hwnd:X}" if target_hwnd else None,
            "method": method,
        }
