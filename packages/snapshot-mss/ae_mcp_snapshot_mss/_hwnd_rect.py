"""Translate a window handle to a screen rect across OSes."""
from __future__ import annotations

import os
import sys
from typing import Optional, Tuple

# Executable that owns genuine After Effects windows. Matching on the owning
# process (rather than a title substring like "After Effects") avoids grabbing
# unrelated windows such as a browser tab titled
# "After Effects tutorial - YouTube".
AE_PROCESS_NAME = "AfterFX.exe"


def hwnd_to_rect(hwnd: Optional[int]) -> Optional[Tuple[int, int, int, int]]:
    """Return (left, top, right, bottom) screen coords for `hwnd`, or None.

    On Windows: uses ctypes user32.GetWindowRect.
    On macOS:   not yet implemented for arbitrary windowID; returns None.
    On Linux:   not yet implemented; returns None.

    Returns None when the rect cannot be resolved; the caller decides how to
    handle that (the mss snapshotter surfaces an error rather than silently
    grabbing the desktop).
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


def _process_name_for_pid(pid: int) -> Optional[str]:
    """Best-effort executable basename for a Windows process id, or None."""
    import ctypes
    from ctypes import wintypes

    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    handle = kernel32.OpenProcess(
        PROCESS_QUERY_LIMITED_INFORMATION, False, pid
    )
    if not handle:
        return None
    try:
        buf = ctypes.create_unicode_buffer(32768)
        size = wintypes.DWORD(len(buf))
        # QueryFullProcessImageNameW(hProcess, dwFlags=0, lpExeName, lpdwSize)
        ok = kernel32.QueryFullProcessImageNameW(
            handle, 0, buf, ctypes.byref(size)
        )
        if not ok:
            return None
        return os.path.basename(buf.value)
    finally:
        kernel32.CloseHandle(handle)


def _hwnd_process_name(user32, hwnd) -> Optional[str]:
    """Executable basename of the process that owns `hwnd`, or None."""
    import ctypes
    from ctypes import wintypes

    pid = wintypes.DWORD(0)
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    if not pid.value:
        return None
    return _process_name_for_pid(pid.value)


def _is_ae_window(exe: Optional[str]) -> bool:
    """True when `exe` (a process executable basename) is After Effects."""
    return bool(exe) and exe.lower() == AE_PROCESS_NAME.lower()


def _select_largest_ae_window(windows) -> Optional[int]:
    """Pure selection: pick the largest-area AfterFX.exe window.

    `windows` is an iterable of dicts with keys:
      hwnd (int), visible (bool), exe (str|None), rect (l,t,r,b)|None
    Returns the chosen hwnd, or None when no qualifying window exists.

    Kept free of win32 calls so the matching policy is unit-testable: the
    real enumeration in find_ae_main_hwnd builds these records from ctypes.
    """
    found: list[tuple[int, int]] = []
    for w in windows:
        if not w.get("visible"):
            continue
        if not _is_ae_window(w.get("exe")):
            continue
        rect = w.get("rect")
        if not rect:
            continue
        left, top, right, bottom = rect
        width = max(0, right - left)
        height = max(0, bottom - top)
        area = width * height
        if area > 0 and left > -30000 and top > -30000:
            found.append((area, int(w["hwnd"])))
    if not found:
        return None
    found.sort(reverse=True)
    return found[0][1]


def find_ae_main_hwnd() -> Optional[int]:
    """Best-effort find the AfterFX.exe main window. Windows-only; returns
    None elsewhere or when no After Effects window is present.

    Selection is by owning PROCESS (executable ``AfterFX.exe``), not by window
    title, so unrelated windows (e.g. a browser tab named "After Effects
    tutorial") are never matched. Of the qualifying visible top-level windows
    the largest by area is chosen and brought to the foreground.
    """
    if sys.platform != "win32":
        return None
    import ctypes
    from ctypes import wintypes
    user32 = ctypes.WinDLL("user32", use_last_error=True)

    records: list[dict] = []
    EnumWindowsProc = ctypes.WINFUNCTYPE(
        wintypes.BOOL, wintypes.HWND, wintypes.LPARAM,
    )

    def callback(hwnd, lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        exe = _hwnd_process_name(user32, hwnd)
        if not _is_ae_window(exe):
            return True
        # Bring the genuine AE window forward before measuring/capturing.
        if user32.IsIconic(hwnd):
            user32.ShowWindow(hwnd, 9)  # SW_RESTORE
        user32.SetForegroundWindow(hwnd)
        rect = wintypes.RECT()
        if user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            records.append({
                "hwnd": int(hwnd),
                "visible": True,
                "exe": exe,
                "rect": (rect.left, rect.top, rect.right, rect.bottom),
            })
        return True

    user32.EnumWindows(EnumWindowsProc(callback), 0)
    return _select_largest_ae_window(records)
