"""Abstract Snapshotter — capture AE viewer/main window pixels."""
from __future__ import annotations

import tempfile
import uuid
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Optional


SNAPSHOT_ROOT = Path(tempfile.gettempdir()) / "ae_mcp_snapshots"


def resolve_snapshot_path(out_path: Optional[Path]) -> Path:
    """Turn a caller's optional out_path into a real, writable, unique file.

    The default has to be absolute. A bare filename resolves against the MCP
    server process's working directory -- whatever launched it, often somewhere
    the process cannot write. That produces `[Errno 13] Permission denied:
    'ae_viewer_....png'`, with no directory in the message because there was
    never a directory in the path. It works on a developer machine for exactly
    the reason it fails on a user's: where the process happened to start.

    The name is a UUID rather than a millisecond timestamp, which two
    concurrent captures can collide on.

    This lives on the base class so every backend inherits it. The macOS
    ScreenCaptureKit backend does not exist yet; when it does, it should not be
    able to reintroduce this by writing the same three lines.
    """
    resolved = (
        Path(out_path)
        if out_path is not None
        else SNAPSHOT_ROOT / f"ae_viewer_{uuid.uuid4().hex}.png"
    )
    resolved.parent.mkdir(parents=True, exist_ok=True)
    return resolved


class Snapshotter(ABC):
    name: str

    def resolve_out_path(self, out_path: Optional[Path]) -> Path:
        """Resolve and prepare the destination. Backends must call this."""
        return resolve_snapshot_path(out_path)

    @abstractmethod
    async def capture(
        self,
        out_path: Optional[Path],
        *,
        hwnd: Optional[str] = None,
        main_window: bool = False,
        method: str = "auto",
    ) -> dict:
        """Capture a PNG. Returns {ok, path, bytes, width, height, hwnd?, method}."""

    @abstractmethod
    def supports_platform(self) -> bool:
        """Return True if this snapshotter can run on the current OS."""
