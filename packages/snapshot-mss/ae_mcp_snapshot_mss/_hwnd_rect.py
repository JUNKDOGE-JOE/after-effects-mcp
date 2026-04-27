"""Translate a window handle to a screen rect across OSes."""
from __future__ import annotations

import sys
from typing import Optional, Tuple


def hwnd_to_rect(hwnd: Optional[int]) -> Optional[Tuple[int, int, int, int]]:
    """Return (left, top, right, bottom) screen coords for `hwnd`, or None.

    On Windows: uses ctypes user32.GetWindowRect.
    On macOS:   not yet implemented for arbitrary windowID; returns None.
                (Most common case — main_window=True — handled by caller via
                 mss's full-monitor grab fallback.)
    On Linux:   not yet implemented; returns None.

    Caller falls back to monitor-0 capture when this returns None.
    """
    if hwnd is None:
        return None
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        rect = wintypes.RECT()
        if user32.GetWindowRect(int(hwnd), ctypes.byref(rect)):
            return (rect.left, rect.top, rect.right, rect.bottom)
        return None
    return None


def find_ae_main_hwnd() -> Optional[int]:
    """Best-effort find AE main window. Windows-only; returns None elsewhere."""
    if sys.platform != "win32":
        return None
    import ctypes
    from ctypes import wintypes
    user32 = ctypes.WinDLL("user32", use_last_error=True)

    found: list[tuple[int, int]] = []
    EnumWindowsProc = ctypes.WINFUNCTYPE(
        wintypes.BOOL, wintypes.HWND, wintypes.LPARAM,
    )

    def callback(hwnd, lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length == 0:
            return True
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        title = buf.value
        if "After Effects" in title:
            if user32.IsIconic(hwnd):
                user32.ShowWindow(hwnd, 9)  # SW_RESTORE
            user32.SetForegroundWindow(hwnd)
            rect = wintypes.RECT()
            if user32.GetWindowRect(hwnd, ctypes.byref(rect)):
                width = max(0, rect.right - rect.left)
                height = max(0, rect.bottom - rect.top)
                area = width * height
                if area > 0 and rect.left > -30000 and rect.top > -30000:
                    found.append((area, int(hwnd)))
        return True

    user32.EnumWindows(EnumWindowsProc(callback), 0)
    if not found:
        return None
    found.sort(reverse=True)
    return found[0][1]
