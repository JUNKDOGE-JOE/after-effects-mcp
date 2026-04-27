"""Abstract Snapshotter — capture AE viewer/main window pixels."""
from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path
from typing import Optional


class Snapshotter(ABC):
    name: str

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
