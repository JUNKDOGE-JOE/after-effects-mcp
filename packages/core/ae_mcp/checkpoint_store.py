"""Filesystem-backed checkpoint index.

Layout:
    %TEMP%/ae_mcp_checkpoints/
        <project_basename_or__untitled>/
            <id>.aep       # full project copy
            <id>.json      # metadata sidecar

ID format: <unix_ms>_<8-hex-chars>. The ms prefix sorts lexicographically.

Pruning: retain at most `keep` newest checkpoints per project basename.
Override default (50) via AE_MCP_CHECKPOINT_KEEP env var.

This module does NOT touch AE — it only manages the directory. Handlers
elsewhere call `make_id()`, write the .aep via JSX, then call
`write_meta()` and `prune()`.
"""
from __future__ import annotations

import json
import os
import secrets
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


_id_lock = threading.Lock()
_last_ms: int = 0


def _project_basename(source_path: Optional[str]) -> str:
    if not source_path:
        return "_untitled"
    stem = Path(source_path).stem
    # Make the basename safe for a directory: strip path separators just in case.
    safe = "".join(c if c.isalnum() or c in "._- " else "_" for c in stem)
    return safe or "_untitled"


class CheckpointStore:
    def __init__(self, root: Optional[Path] = None, keep: Optional[int] = None) -> None:
        if root is None:
            root = Path(tempfile.gettempdir()) / "ae_mcp_checkpoints"
        self.root: Path = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

        if keep is None:
            env = os.environ.get("AE_MCP_CHECKPOINT_KEEP")
            try:
                keep = int(env) if env else 50
            except ValueError:
                keep = 50
        self.keep: int = max(1, int(keep))

    # ------------------------------------------------------------------ paths

    def _dir_for(self, source_path: Optional[str]) -> Path:
        return self.root / _project_basename(source_path)

    def _canonical_source_path(self, source_path: Optional[str]) -> Optional[str]:
        if not source_path:
            return source_path
        p = Path(source_path)
        try:
            p.resolve().relative_to(self.root.resolve())
        except (OSError, ValueError):
            return source_path

        meta_path = p.with_suffix(".json")
        if not meta_path.exists():
            return source_path
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return source_path
        return meta.get("sourceProjectPath") or source_path

    def aep_path(self, source_path: Optional[str], cid: str) -> Path:
        return self._dir_for(source_path) / f"{cid}.aep"

    def meta_path(self, source_path: Optional[str], cid: str) -> Path:
        return self._dir_for(source_path) / f"{cid}.json"

    # ----------------------------------------------------------------- id gen

    def make_id(self) -> str:
        global _last_ms
        with _id_lock:
            ms = int(time.time() * 1000)
            if ms <= _last_ms:
                ms = _last_ms + 1
            _last_ms = ms
        return f"{ms}_{secrets.token_hex(4)}"

    # ------------------------------------------------------------------ write

    def write_meta(
        self,
        *,
        source_project_path: Optional[str],
        cid: str,
        label: str,
        active_comp_id: Optional[str],
        current_time: float,
        size_bytes: int,
    ) -> Path:
        d = self._dir_for(source_project_path)
        d.mkdir(parents=True, exist_ok=True)
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        meta = {
            "id": cid,
            "label": label,
            "ts": ts,
            "sourceProjectPath": source_project_path,
            "activeCompId": active_comp_id,
            "currentTime": current_time,
            "sizeBytes": size_bytes,
        }
        path = d / f"{cid}.json"
        path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        return path

    # ------------------------------------------------------------------- read

    def list_checkpoints(self, source_path: Optional[str], *, limit: int = 20) -> List[Dict[str, Any]]:
        source_path = self._canonical_source_path(source_path)
        d = self._dir_for(source_path)
        if not d.exists():
            return []
        entries: List[Dict[str, Any]] = []
        for meta_file in d.glob("*.json"):
            cid = meta_file.stem
            aep = d / f"{cid}.aep"
            if not aep.exists():
                # orphan meta — clean up
                try:
                    meta_file.unlink()
                except OSError:
                    pass
                continue
            try:
                meta = json.loads(meta_file.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            entries.append(meta)
        entries.sort(key=lambda m: m.get("ts", ""), reverse=True)
        return entries[:limit]

    def lookup_aep(self, source_path: Optional[str], cid: str) -> Optional[Path]:
        source_path = self._canonical_source_path(source_path)
        p = self.aep_path(source_path, cid)
        return p if p.exists() else None

    # ------------------------------------------------------------------ prune

    def prune(self, source_path: Optional[str]) -> List[str]:
        """Delete checkpoints beyond `self.keep` newest. Return removed ids."""
        source_path = self._canonical_source_path(source_path)
        d = self._dir_for(source_path)
        if not d.exists():
            return []
        entries = self.list_checkpoints(source_path, limit=10_000)
        keep_ids = {e["id"] for e in entries[: self.keep]}
        removed: List[str] = []
        for e in entries[self.keep:]:
            cid = e["id"]
            for ext in (".aep", ".json"):
                f = d / f"{cid}{ext}"
                try:
                    f.unlink()
                except OSError:
                    pass
            removed.append(cid)
        return removed
