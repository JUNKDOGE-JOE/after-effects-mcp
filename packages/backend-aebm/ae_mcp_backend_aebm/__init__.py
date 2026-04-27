"""AEBMethod file-bridge backend.

Wraps the existing pwsh subprocess + file-queue protocol used by
the AEBMethod After Effects plugin. Reads AE_BRIDGE_ROOT env var
to locate scripts/backend_interface.ps1.
"""
from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional

from ae_mcp.backends.base import Backend, BackendError

log = logging.getLogger("ae_mcp_backend_aebm")


class AEBMBackend(Backend):
    name = "aebm"
    manages_undo = False
    manages_checkpoints = False

    def __init__(self, bridge_root: Path) -> None:
        self.bridge_root = bridge_root
        self._interface_ps1 = bridge_root / "scripts" / "backend_interface.ps1"
        if not self._interface_ps1.is_file():
            raise EnvironmentError(
                f"AEBMBackend: scripts/backend_interface.ps1 not found under {bridge_root}"
            )

    @classmethod
    def from_env(cls) -> "AEBMBackend":
        env = os.environ.get("AE_BRIDGE_ROOT")
        if not env:
            raise EnvironmentError(
                "AEBMBackend requires AE_BRIDGE_ROOT env var pointing at "
                "the AEBMethod plugin checkout (which contains "
                "scripts/backend_interface.ps1)."
            )
        p = Path(env).resolve()
        return cls(bridge_root=p)

    async def health_check(self, timeout_sec: float = 5.0) -> bool:
        try:
            out = await self.exec(
                code='JSON.stringify({ok:true,ping:"pong"})',
                timeout_sec=timeout_sec,
            )
            return "pong" in out
        except Exception:  # noqa: BLE001
            return False

    async def exec(
        self,
        code: str,
        *,
        undo_group: Optional[str] = None,
        checkpoint_label: Optional[str] = None,
        timeout_sec: float = 30.0,
    ) -> str:
        """Run JSX via pwsh -> AEBMethod backend_interface.ps1 -> file queue."""
        named_args: Dict[str, Any] = {"TimeoutSec": int(timeout_sec)}
        if undo_group:
            named_args["UndoGroupName"] = undo_group
        if checkpoint_label:
            named_args["CheckpointLabel"] = checkpoint_label

        return await self._run_ps(
            "Invoke-AeExec",
            named_args,
            code=code,
            code_param="Code",
            timeout_sec=timeout_sec + 5.0,
        )

    # ---- internals (lifted from old bridge.py, unchanged in spirit) ----

    async def _run_ps(
        self,
        function: str,
        named_args: Dict[str, Any],
        *,
        code: Optional[str] = None,
        code_param: str = "Code",
        timeout_sec: float = 30.0,
    ) -> str:
        tmp_path: Optional[str] = None
        env = os.environ.copy()

        if code is not None:
            tmp = tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", suffix=".jsx", delete=False, newline="\n"
            )
            try:
                tmp.write(code)
                tmp.flush()
                tmp_path = tmp.name
            finally:
                tmp.close()
            env["AEBM_CODE_FILE"] = tmp_path

        invocation_parts = [function]
        for k, v in named_args.items():
            if v is None:
                continue
            if isinstance(v, bool):
                if v:
                    invocation_parts.append(f"-{k}")
                continue
            invocation_parts.append(f"-{k}")
            invocation_parts.append(self._render_ps_value(v))
        if code is not None:
            invocation_parts.append(f"-{code_param}")
            invocation_parts.append("$AEBM_Code")

        invocation = " ".join(invocation_parts)
        script_parts = [
            "$ErrorActionPreference = 'Stop'",
            "$env:AE_BACKEND = 'aebm-file'",
            f". '{str(self._interface_ps1).replace(chr(39), chr(39)*2)}'",
            "Initialize-Backend | Out-Null",
        ]
        if code is not None:
            script_parts.append(
                "$AEBM_Code = [System.IO.File]::ReadAllText("
                "$env:AEBM_CODE_FILE, [System.Text.Encoding]::UTF8)"
            )
        script_parts.append(invocation)
        script = "\n".join(script_parts)

        try:
            proc = await asyncio.create_subprocess_exec(
                "powershell", "-NoProfile", "-NonInteractive", "-Command", script,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
            )
            try:
                stdout_b, stderr_b = await asyncio.wait_for(
                    proc.communicate(), timeout=timeout_sec
                )
            except asyncio.TimeoutError:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
                raise BackendError(
                    f"AEBMBackend: pwsh {function} timed out after {timeout_sec}s"
                )
        finally:
            if tmp_path:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass

        stdout = stdout_b.decode("utf-8", errors="replace")
        stderr = stderr_b.decode("utf-8", errors="replace")
        if proc.returncode != 0:
            raise BackendError(
                f"AEBMBackend: pwsh {function} failed (exit {proc.returncode}): "
                f"{stderr.strip() or stdout.strip()}"
            )
        return stdout.strip()

    @staticmethod
    def _render_ps_value(v: Any) -> str:
        if v is None:
            return "$null"
        if isinstance(v, bool):
            return "$true" if v else "$false"
        if isinstance(v, (int, float)):
            return str(v)
        if isinstance(v, str):
            return "'" + v.replace("'", "''") + "'"
        if isinstance(v, (list, tuple)):
            inner = ", ".join(AEBMBackend._render_ps_value(x) for x in v)
            return f"@({inner})"
        raise TypeError(f"unsupported PS value type: {type(v).__name__}")
