"""Snapshot subsystem — pluggable PNG capture for AE viewer/main window."""
from ae_mcp.snapshot.base import Snapshotter
from ae_mcp.snapshot.discovery import select_snapshotter, SnapshotSelectionError

__all__ = ["Snapshotter", "select_snapshotter", "SnapshotSelectionError"]
