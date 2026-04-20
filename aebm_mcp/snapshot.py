"""Windows viewer screenshot via ctypes. Python port of scripts/viewer_snapshot.ps1.

Skips the pwsh subprocess for the snapshot hot-path (LLM vision loop wants
millisecond responses). Directly wraps user32/gdi32 via ctypes.

Uses Pillow when available to write PNG; falls back to raw BMP dump with a
clear error if Pillow is not installed (we declare PIL as a soft dep).

Windows-only. Importing this module on non-Windows will `ImportError` — the
snapshot handler guards that case and returns a clean error.
"""

from __future__ import annotations

import ctypes
import logging
import sys
import time
from ctypes import wintypes
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import List, Optional

log = logging.getLogger("aebm_mcp.snapshot")

if sys.platform != "win32":
    raise ImportError("aebm_mcp.snapshot is Windows-only")


# ---------------------------------------------------------------------------
# Win32 P/Invoke
# ---------------------------------------------------------------------------

user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)

# Constants
PW_RENDERFULLCONTENT = 0x2
SRCCOPY = 0x00CC0020
CAPTUREBLT = 0x40000000
DIB_RGB_COLORS = 0
BI_RGB = 0


class RECT(ctypes.Structure):
    _fields_ = [
        ("left", ctypes.c_long),
        ("top", ctypes.c_long),
        ("right", ctypes.c_long),
        ("bottom", ctypes.c_long),
    ]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD),
        ("biWidth", ctypes.c_long),
        ("biHeight", ctypes.c_long),
        ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", ctypes.c_long),
        ("biYPelsPerMeter", ctypes.c_long),
        ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [
        ("bmiHeader", BITMAPINFOHEADER),
        ("bmiColors", wintypes.DWORD * 3),
    ]


# EnumChildProc callback type
EnumChildProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

# Function signatures
user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(RECT)]
user32.GetWindowRect.restype = wintypes.BOOL

user32.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(RECT)]
user32.GetClientRect.restype = wintypes.BOOL

user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetClassNameW.restype = ctypes.c_int

user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowTextW.restype = ctypes.c_int

user32.IsWindowVisible.argtypes = [wintypes.HWND]
user32.IsWindowVisible.restype = wintypes.BOOL

user32.EnumChildWindows.argtypes = [wintypes.HWND, EnumChildProc, wintypes.LPARAM]
user32.EnumChildWindows.restype = wintypes.BOOL

user32.GetDC.argtypes = [wintypes.HWND]
user32.GetDC.restype = wintypes.HDC

user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
user32.ReleaseDC.restype = ctypes.c_int

user32.PrintWindow.argtypes = [wintypes.HWND, wintypes.HDC, wintypes.UINT]
user32.PrintWindow.restype = wintypes.BOOL

user32.SetForegroundWindow.argtypes = [wintypes.HWND]
user32.SetForegroundWindow.restype = wintypes.BOOL

user32.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
user32.FindWindowW.restype = wintypes.HWND

user32.EnumWindows.argtypes = [EnumChildProc, wintypes.LPARAM]
user32.EnumWindows.restype = wintypes.BOOL

user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowThreadProcessId.restype = wintypes.DWORD

user32.GetForegroundWindow.argtypes = []
user32.GetForegroundWindow.restype = wintypes.HWND

user32.BringWindowToTop.argtypes = [wintypes.HWND]
user32.BringWindowToTop.restype = wintypes.BOOL

user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
user32.AttachThreadInput.restype = wintypes.BOOL

user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
user32.ShowWindow.restype = wintypes.BOOL

user32.IsIconic.argtypes = [wintypes.HWND]
user32.IsIconic.restype = wintypes.BOOL

_kernel32_fg = ctypes.WinDLL("kernel32", use_last_error=True)
_kernel32_fg.GetCurrentThreadId.argtypes = []
_kernel32_fg.GetCurrentThreadId.restype = wintypes.DWORD

SW_RESTORE = 9

gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
gdi32.CreateCompatibleDC.restype = wintypes.HDC

gdi32.CreateCompatibleBitmap.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int]
gdi32.CreateCompatibleBitmap.restype = wintypes.HBITMAP

gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
gdi32.SelectObject.restype = wintypes.HGDIOBJ

gdi32.BitBlt.argtypes = [
    wintypes.HDC, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
    wintypes.HDC, ctypes.c_int, ctypes.c_int, wintypes.DWORD,
]
gdi32.BitBlt.restype = wintypes.BOOL

gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
gdi32.DeleteObject.restype = wintypes.BOOL

gdi32.DeleteDC.argtypes = [wintypes.HDC]
gdi32.DeleteDC.restype = wintypes.BOOL

gdi32.GetDIBits.argtypes = [
    wintypes.HDC, wintypes.HBITMAP, wintypes.UINT, wintypes.UINT,
    ctypes.c_void_p, ctypes.POINTER(BITMAPINFO), wintypes.UINT,
]
gdi32.GetDIBits.restype = ctypes.c_int


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


@dataclass
class ChildWindow:
    hwnd: int
    cls: str
    text: str
    visible: bool
    width: int
    height: int
    left: int
    top: int

    @property
    def ratio(self) -> float:
        return (self.width / self.height) if self.height > 0 else 0.0


def _get_window_class(hwnd: int) -> str:
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buf, 256)
    return buf.value


def _get_window_text(hwnd: int) -> str:
    buf = ctypes.create_unicode_buffer(256)
    user32.GetWindowTextW(hwnd, buf, 256)
    return buf.value


def get_ae_main_hwnd() -> int:
    """Find AE's main window. Looks for visible top-level windows belonging to
    AfterFX.exe; returns the first match. Raises RuntimeError if none found.
    """
    # Try FindWindow on the DroverLord class first (faster path).
    # Fall back to EnumWindows for robustness.
    hwnd = user32.FindWindowW("DroverLord - Window Class", None)
    if hwnd:
        # Verify it's AE (owner process).
        pid = wintypes.DWORD(0)
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value and _pid_is_afterfx(pid.value):
            return int(hwnd)

    # Scan all top-level windows.
    found: List[int] = []

    @EnumChildProc
    def cb(h: int, _l: int) -> bool:
        if not user32.IsWindowVisible(h):
            return True
        pid = wintypes.DWORD(0)
        user32.GetWindowThreadProcessId(h, ctypes.byref(pid))
        if pid.value and _pid_is_afterfx(pid.value):
            # Only top-level windows with a title — main window has one.
            text = _get_window_text(h)
            if text:
                found.append(int(h))
        return True

    user32.EnumWindows(cb, 0)
    if not found:
        raise RuntimeError("AE not running (no AfterFX top-level window found).")
    return found[0]


def _pid_is_afterfx(pid: int) -> bool:
    """Return True if pid's image name is AfterFX.exe. Best-effort."""
    try:
        import ctypes.wintypes as wt  # local alias
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not h:
            return False
        try:
            buf = ctypes.create_unicode_buffer(512)
            size = wintypes.DWORD(len(buf))
            psapi = ctypes.WinDLL("psapi", use_last_error=True)
            psapi.GetModuleFileNameExW.argtypes = [
                wintypes.HANDLE, wintypes.HMODULE, wintypes.LPWSTR, wintypes.DWORD,
            ]
            psapi.GetModuleFileNameExW.restype = wintypes.DWORD
            n = psapi.GetModuleFileNameExW(h, None, buf, size)
            if n == 0:
                # Try QueryFullProcessImageNameW as fallback.
                kernel32.QueryFullProcessImageNameW.argtypes = [
                    wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR,
                    ctypes.POINTER(wintypes.DWORD),
                ]
                kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
                size2 = wintypes.DWORD(len(buf))
                ok = kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size2))
                if not ok:
                    return False
            path = buf.value
            return path.lower().endswith("afterfx.exe")
        finally:
            kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
            kernel32.CloseHandle(h)
    except Exception:  # noqa: BLE001
        return False


def enum_ae_child_windows(parent: int) -> List[ChildWindow]:
    """Enumerate (non-recursively) AE child windows with geometry + class/text.

    Note: EnumChildWindows WITH a parent enumerates *descendants* (not just
    direct children). That's what we want — the OS_ViewContainer we target
    sits several levels deep.
    """
    results: List[ChildWindow] = []

    @EnumChildProc
    def cb(h: int, _l: int) -> bool:
        cls = _get_window_class(h)
        txt = _get_window_text(h)
        vis = bool(user32.IsWindowVisible(h))
        rect = RECT()
        user32.GetWindowRect(h, ctypes.byref(rect))
        w = rect.right - rect.left
        ht = rect.bottom - rect.top
        results.append(
            ChildWindow(
                hwnd=int(h), cls=cls, text=txt, visible=vis,
                width=w, height=ht, left=rect.left, top=rect.top,
            )
        )
        return True

    user32.EnumChildWindows(parent, cb, 0)
    return results


def force_foreground(hwnd: int) -> bool:
    """Bring `hwnd` to the foreground, bypassing Windows' focus-stealing
    prevention via the AttachThreadInput trick.

    Pattern (same as scripts/_sendenter.ps1 + scripts/_clear_dialogs.ps1):
      1. Record the current foreground window's thread id.
      2. Attach our thread's input to that thread (this is the key step --
         while attached, SetForegroundWindow is allowed because Windows
         treats us as "the same input context" as the current foreground).
      3. Un-minimize + BringWindowToTop + SetForegroundWindow.
      4. Always detach (in finally).

    Returns True if the target hwnd is the foreground window after the
    dance, False otherwise. Never raises.
    """
    if not hwnd:
        return False
    try:
        fg = user32.GetForegroundWindow()
        if int(fg or 0) == int(hwnd):
            return True

        fg_tid = user32.GetWindowThreadProcessId(fg, None) if fg else 0
        my_tid = _kernel32_fg.GetCurrentThreadId()
        attached = False
        if fg_tid and fg_tid != my_tid:
            attached = bool(user32.AttachThreadInput(my_tid, fg_tid, True))
        try:
            # Un-minimize if needed; BringWindowToTop raises the z-order;
            # SetForegroundWindow is the real "take focus" call.
            if user32.IsIconic(hwnd):
                user32.ShowWindow(hwnd, SW_RESTORE)
            user32.BringWindowToTop(hwnd)
            user32.SetForegroundWindow(hwnd)
        finally:
            if attached:
                user32.AttachThreadInput(my_tid, fg_tid, False)

        # Verify.
        return int(user32.GetForegroundWindow() or 0) == int(hwnd)
    except Exception:  # noqa: BLE001
        return False


def pick_viewer_hwnd(parent: int) -> int:
    """Closest-to-16:9 visible OS_ViewContainer wider than 800px. 0 if none."""
    kids = enum_ae_child_windows(parent)
    candidates = [
        c for c in kids
        if c.visible and c.text == "OS_ViewContainer" and c.width > 800 and c.height > 400
    ]
    if not candidates:
        return 0
    target = 16.0 / 9.0
    candidates.sort(key=lambda c: abs(c.ratio - target))
    return candidates[0].hwnd


# ---------------------------------------------------------------------------
# Capture + save
# ---------------------------------------------------------------------------


def _bitmap_to_png(hbm: int, width: int, height: int, hdc_src: int, out_path: Path) -> None:
    """Read pixels from an HBITMAP via GetDIBits and write a PNG via Pillow.

    Pillow is required. We declare it as a dependency in pyproject.toml when
    Pillow install is acceptable; otherwise we fall back to writing BMP.
    """
    # Build BITMAPINFO requesting 32bpp top-down.
    bmi = BITMAPINFO()
    bmi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bmi.bmiHeader.biWidth = width
    bmi.bmiHeader.biHeight = -height  # negative: top-down
    bmi.bmiHeader.biPlanes = 1
    bmi.bmiHeader.biBitCount = 32
    bmi.bmiHeader.biCompression = BI_RGB
    bmi.bmiHeader.biSizeImage = 0

    buf_size = width * height * 4
    buf = (ctypes.c_ubyte * buf_size)()
    got = gdi32.GetDIBits(
        hdc_src, hbm, 0, height, buf, ctypes.byref(bmi), DIB_RGB_COLORS
    )
    if got == 0:
        raise RuntimeError("GetDIBits failed")

    # Pixels are BGRA, top-down. Convert to RGBA and write via Pillow.
    try:
        from PIL import Image  # type: ignore
    except ImportError as e:  # pragma: no cover
        raise RuntimeError(
            "Pillow is required for PNG output. Add 'pillow' to pyproject.toml dependencies."
        ) from e

    raw = bytes(buf)
    img = Image.frombuffer("RGBA", (width, height), raw, "raw", "BGRA", 0, 1)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(str(out_path), format="PNG")


def _default_out_path() -> Path:
    # REPO_ROOT is mcp/aebm_mcp/snapshot.py -> mcp/aebm_mcp/ -> mcp/ -> repo
    repo_root = Path(__file__).resolve().parents[2]
    out_dir = repo_root / "release" / "logs" / "integration_runs"
    out_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:-3]
    return out_dir / f"ae_viewer_{ts}.png"


def capture_ae_viewer(
    out_path: Optional[str] = None,
    hwnd: Optional[str] = None,
    main_window: bool = False,
    method: str = "DesktopCopy",
) -> dict:
    """Capture the AE viewer (or explicit HWND, or main window) to a PNG.

    Returns a dict shape-compatible with Invoke-AebmSnapshot:
      { ok, path, bytes, width, height, hwnd, method }.
    """
    if method not in ("DesktopCopy", "PrintWindow"):
        raise ValueError(f"method must be DesktopCopy or PrintWindow, got {method!r}")

    out_path_p = Path(out_path) if out_path else _default_out_path()

    main_hwnd = get_ae_main_hwnd()

    # Resolve target hwnd.
    if main_window:
        target = main_hwnd
    elif hwnd:
        if hwnd.lower().startswith("0x"):
            target = int(hwnd, 16)
        else:
            target = int(hwnd)
    else:
        target = pick_viewer_hwnd(main_hwnd) or main_hwnd

    rect = RECT()
    if not user32.GetWindowRect(target, ctypes.byref(rect)):
        raise RuntimeError(f"GetWindowRect failed for hwnd 0x{target:X}")
    W = rect.right - rect.left
    H = rect.bottom - rect.top
    if W <= 0 or H <= 0:
        raise RuntimeError(f"Target hwnd 0x{target:X} has zero size ({W}x{H}).")

    hdc_screen = user32.GetDC(0)
    try:
        hdc_mem = gdi32.CreateCompatibleDC(hdc_screen)
        hbm = gdi32.CreateCompatibleBitmap(hdc_screen, W, H)
        try:
            old = gdi32.SelectObject(hdc_mem, hbm)

            if method == "PrintWindow":
                user32.PrintWindow(target, hdc_mem, PW_RENDERFULLCONTENT)
            else:
                # Force AE to the foreground via the AttachThreadInput trick
                # (plain SetForegroundWindow is blocked by Windows' focus-
                # stealing prevention when the caller is not the current
                # foreground). Settle, re-read the target rect in case the
                # window moved when restored from minimized state, then BitBlt
                # the desktop DC at those screen coordinates.
                force_foreground(main_hwnd)
                time.sleep(0.15)
                user32.GetWindowRect(target, ctypes.byref(rect))
                W2 = rect.right - rect.left
                H2 = rect.bottom - rect.top
                if W2 != W or H2 != H:
                    # Rect changed (e.g. un-minimized). Re-create the bitmap
                    # at the new size by updating W/H; the existing hbm was
                    # sized off the pre-foreground rect but BitBlt clamps to
                    # bitmap dims anyway, so worst case we only get the
                    # top-left corner. Log + continue.
                    log.info(
                        "snapshot: target rect changed after foreground "
                        "(%dx%d -> %dx%d); clamping to original bitmap size.",
                        W, H, W2, H2,
                    )
                rop = SRCCOPY | CAPTUREBLT
                ok = gdi32.BitBlt(
                    hdc_mem, 0, 0, W, H, hdc_screen, rect.left, rect.top, rop
                )
                if not ok:
                    raise RuntimeError("BitBlt failed")

            _bitmap_to_png(hbm, W, H, hdc_mem, out_path_p)
            gdi32.SelectObject(hdc_mem, old)
        finally:
            gdi32.DeleteObject(hbm)
            gdi32.DeleteDC(hdc_mem)
    finally:
        user32.ReleaseDC(0, hdc_screen)

    st = out_path_p.stat()
    return {
        "ok": st.st_size > 0,
        "path": str(out_path_p),
        "bytes": st.st_size,
        "width": W,
        "height": H,
        "hwnd": f"0x{target:X}",
        "method": method,
    }
