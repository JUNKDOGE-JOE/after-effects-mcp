"""PowerShell bridge: dispatches Invoke-Ae* verbs via pwsh subprocess.

Design:
- Each call spawns a one-shot `powershell -NoProfile -Command` process,
  dot-sources scripts/backend_interface.ps1, runs Initialize-Backend with
  AE_BACKEND=aebm-file, then invokes the requested function.
- The pwsh cold-start cost (~150-300ms) is absorbed per call. For the MCP
  MVP we prefer statelessness over a long-lived pwsh REPL.
- JSX code (the `-Code` parameter of Invoke-AeExec / Invoke-AeReadProps) is
  passed via a UTF-8 no-BOM temp file rather than interpolated into the
  command string — keeps quoting sane and matches the wire format the plugin
  expects (see backend_aebm_file.ps1 atomic-write comment).
- stdout is returned verbatim; stderr is surfaced on non-zero exit.

The bridge has NO knowledge of AE verbs — callers supply the function name
and args. This keeps the bridge easy to unit-test with a mocked subprocess.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional

log = logging.getLogger("ae_mcp.bridge")


# ---------------------------------------------------------------------------
# Bridge root resolution
# ---------------------------------------------------------------------------
# The MCP server wraps an AE plugin that implements the aebm file-polling
# protocol. The plugin ships PowerShell scripts (backend_interface.ps1 +
# backend_aebm_file.ps1) that this server shells out to.
#
# The AE_BRIDGE_ROOT env var must point at a checkout of such a plugin.
# No sibling-path autodetection -- explicit wins over implicit.


def _resolve_bridge_root() -> Path:
    """Locate the AE plugin checkout that implements the aebm file-polling bridge.

    Requires the AE_BRIDGE_ROOT environment variable to point at a directory
    containing scripts/backend_interface.ps1. Raises RuntimeError with an
    actionable message if not set or the path is invalid.
    """
    env = os.environ.get("AE_BRIDGE_ROOT")
    if env:
        p = Path(env).resolve()
        script = p / "scripts" / "backend_interface.ps1"
        if script.is_file():
            return p
        raise RuntimeError(
            f"AE_BRIDGE_ROOT={env} does not contain scripts/backend_interface.ps1. "
            "Expected a checkout of an AE plugin that implements the aebm "
            "file-polling protocol."
        )
    raise RuntimeError(
        "AE_BRIDGE_ROOT environment variable is not set. "
        "Set it to the checkout path of an AE plugin that implements the aebm "
        "file-polling protocol. See README.md 'Environment Setup'."
    )


# Lazy resolution: do NOT validate at import time. Tests mock subprocess
# at a higher layer and should be able to `from ae_mcp import
# bridge` without AE_BRIDGE_ROOT set.
#
# First call to any bridge-reading function (run_ps / invoke_ae_*) triggers
# resolution + caches the result. Absent env var -> RuntimeError only at
# first use, not at import.

_cached_bridge_root: Optional[Path] = None


def bridge_root() -> Path:
    """Return (and cache) the resolved BRIDGE_ROOT. Raises RuntimeError if
    AE_BRIDGE_ROOT is unset or invalid. Safe to call multiple times."""
    global _cached_bridge_root
    if _cached_bridge_root is None:
        _cached_bridge_root = _resolve_bridge_root()
    return _cached_bridge_root


def backend_interface_ps1() -> Path:
    return bridge_root() / "scripts" / "backend_interface.ps1"


def scripts_dir() -> Path:
    return bridge_root() / "scripts"


def _ensure_interface_exists() -> None:
    ps1 = backend_interface_ps1()
    if not ps1.exists():
        raise FileNotFoundError(
            f"backend_interface.ps1 not found at {ps1}. "
            f"Check AE_BRIDGE_ROOT env var points at a valid plugin checkout."
        )


# ---------------------------------------------------------------------------
# Argument encoding: convert a Python dict into PS named-param syntax.
# ---------------------------------------------------------------------------


def _ps_escape_single(s: str) -> str:
    """Escape a string for a PS single-quoted literal (doubles single quotes)."""
    return s.replace("'", "''")


def _format_ps_value(value: Any) -> str:
    """Render a Python value as a PS literal suitable for param binding.

    Supports: None (as $null), bool (-> $true/$false), int, float, str,
    and lists (as comma-separated arrays). Dicts are NOT supported here —
    hashtable args go through a different path (format_ps_hashtable).
    """
    if value is None:
        return "$null"
    if isinstance(value, bool):
        return "$true" if value else "$false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        return "'" + _ps_escape_single(value) + "'"
    if isinstance(value, (list, tuple)):
        parts = [_format_ps_value(v) for v in value]
        return "@(" + ", ".join(parts) + ")"
    raise TypeError(f"cannot encode {type(value).__name__} as PS literal: {value!r}")


def format_ps_hashtable(d: Dict[str, Any]) -> str:
    """Render a Python dict as a PS hashtable literal: @{ key = value; ... }.

    Nested dicts are allowed and recurse. Keys must be str.
    """
    parts = []
    for k, v in d.items():
        if not isinstance(k, str):
            raise TypeError(f"hashtable key must be str, got {type(k).__name__}")
        if isinstance(v, dict):
            rendered = format_ps_hashtable(v)
        else:
            rendered = _format_ps_value(v)
        parts.append(f"{k} = {rendered}")
    return "@{ " + "; ".join(parts) + " }"


def format_ps_invocation(function: str, named_args: Dict[str, Any]) -> str:
    """Build a PS command string: `Invoke-AeX -Foo 'bar' -Baz 42`.

    For switch-style flags (bool True) we emit `-Foo` without a value.
    """
    tokens = [function]
    for key, val in named_args.items():
        if val is None:
            continue
        if isinstance(val, bool):
            if val:
                tokens.append(f"-{key}")
            # False switches: just omit
            continue
        tokens.append(f"-{key}")
        tokens.append(_format_ps_value(val))
    return " ".join(tokens)


# ---------------------------------------------------------------------------
# Subprocess runner
# ---------------------------------------------------------------------------


def _build_powershell_script(invocation: str, code_var: Optional[str] = None) -> str:
    """Assemble the full pwsh script: preamble + optional code-var load + invocation.

    code_var is the PS variable name (e.g. '$AEBM_Code') already wired into the
    invocation; its contents are loaded from the caller-prepared temp file path
    found in $env:AEBM_CODE_FILE.
    """
    _ensure_interface_exists()
    parts = [
        "$ErrorActionPreference = 'Stop'",
        "$env:AE_BACKEND = 'aebm-file'",
        # Dot-source the interface. PSScriptRoot is the caller's PSScriptRoot
        # fallback; use the absolute path we resolved in Python.
        f". '{_ps_escape_single(str(backend_interface_ps1()))}'",
        "Initialize-Backend | Out-Null",
    ]
    if code_var:
        # Variable is populated from the temp file path in $env:AEBM_CODE_FILE.
        parts.append(
            f"{code_var} = [System.IO.File]::ReadAllText($env:AEBM_CODE_FILE, "
            f"[System.Text.Encoding]::UTF8)"
        )
    parts.append(invocation)
    return "\n".join(parts)


async def run_ps(
    function: str,
    named_args: Optional[Dict[str, Any]] = None,
    *,
    code: Optional[str] = None,
    code_param: str = "Code",
    timeout_sec: float = 30.0,
) -> str:
    """Invoke `function` in pwsh with keyword args; return stdout as str.

    When `code` is provided it is materialised into a UTF-8 no-BOM temp file
    and loaded into $AEBM_Code inside the PS script, then passed as
    `-<code_param> $AEBM_Code`. This avoids command-line quoting of JSX.

    Raises RuntimeError on non-zero exit; raises asyncio.TimeoutError on timeout.
    """
    named_args = dict(named_args or {})

    tmp_path: Optional[str] = None
    env = os.environ.copy()
    code_var = None

    if code is not None:
        tmp = tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            suffix=".jsx",
            delete=False,
            newline="\n",
        )
        try:
            tmp.write(code)
            tmp.flush()
            tmp_path = tmp.name
        finally:
            tmp.close()
        env["AEBM_CODE_FILE"] = tmp_path
        code_var = "$AEBM_Code"
        # Splice the code var as a *raw* token (not quoted); it refers to the
        # PS variable holding the JSX source.
        named_args[code_param] = _RawPsToken(code_var)

    invocation = _format_ps_invocation_with_raw(function, named_args)
    script = _build_powershell_script(invocation, code_var=code_var)

    log.debug("pwsh script:\n%s", script)

    try:
        proc = await asyncio.create_subprocess_exec(
            "powershell",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
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
            raise
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    stdout = stdout_b.decode("utf-8", errors="replace")
    stderr = stderr_b.decode("utf-8", errors="replace")

    if proc.returncode != 0:
        raise RuntimeError(
            f"pwsh {function} failed (exit {proc.returncode}): {stderr.strip() or stdout.strip()}"
        )

    # Even on success PS may print warnings to stderr; log and ignore.
    if stderr.strip():
        log.debug("pwsh %s stderr: %s", function, stderr.strip())

    return stdout.strip()


# ---------------------------------------------------------------------------
# Raw PS token (used to inject a variable reference into the invocation)
# ---------------------------------------------------------------------------


class _RawPsToken:
    """Marker wrapping a PS literal that should be emitted verbatim (no quoting)."""

    __slots__ = ("text",)

    def __init__(self, text: str) -> None:
        self.text = text

    def __repr__(self) -> str:  # pragma: no cover
        return f"_RawPsToken({self.text!r})"


def _format_ps_invocation_with_raw(function: str, named_args: Dict[str, Any]) -> str:
    """Variant of format_ps_invocation that understands _RawPsToken values."""
    tokens = [function]
    for key, val in named_args.items():
        if val is None:
            continue
        if isinstance(val, _RawPsToken):
            tokens.append(f"-{key}")
            tokens.append(val.text)
            continue
        if isinstance(val, bool):
            if val:
                tokens.append(f"-{key}")
            continue
        tokens.append(f"-{key}")
        tokens.append(_format_ps_value(val))
    return " ".join(tokens)


# ---------------------------------------------------------------------------
# Convenience wrappers for each PS verb. Handlers call these.
# ---------------------------------------------------------------------------


async def invoke_ae_init(*, refresh_only: bool = False, timeout_sec: float = 20.0) -> str:
    return await run_ps(
        "Invoke-AeInit",
        {"RefreshOnly": refresh_only},
        timeout_sec=timeout_sec,
    )


async def invoke_ae_overview(*, timeout_sec: float = 10.0) -> str:
    return await run_ps("Invoke-AeOverview", timeout_sec=timeout_sec)


async def invoke_ae_layers(*, comp_id: Optional[str] = None, timeout_sec: float = 10.0) -> str:
    return await run_ps(
        "Invoke-AeLayers",
        {"CompId": comp_id} if comp_id else {},
        timeout_sec=timeout_sec,
    )


async def invoke_ae_exec(
    code: str,
    *,
    undo_group_name: Optional[str] = None,
    checkpoint_label: Optional[str] = None,
    timeout_sec: float = 30.0,
) -> str:
    args: Dict[str, Any] = {}
    if undo_group_name:
        args["UndoGroupName"] = undo_group_name
    if checkpoint_label:
        args["CheckpointLabel"] = checkpoint_label
    args["TimeoutSec"] = int(timeout_sec)
    return await run_ps(
        "Invoke-AeExec",
        args,
        code=code,
        code_param="Code",
        timeout_sec=timeout_sec + 5.0,  # PS internal timeout is lower; add slack
    )


async def invoke_ae_read_props(code: str, *, timeout_sec: float = 10.0) -> str:
    """aebm-file get_properties requires explicit JSX (see backend_aebm_file.ps1)."""
    return await run_ps(
        "Invoke-AeReadProps",
        {},  # CompId/LayerId/Paths all left empty; scenario-style body carries the code
        code=code,
        code_param="Code",
        timeout_sec=timeout_sec + 5.0,
    )


async def invoke_ae_checkpoint(*, limit: int = 20, timeout_sec: float = 10.0) -> str:
    return await run_ps(
        "Invoke-AeCheckpoint",
        {"Limit": int(limit)},
        timeout_sec=timeout_sec,
    )


async def invoke_ae_revert(
    checkpoint_id: str,
    *,
    branch_before_revert: bool = False,
    timeout_sec: float = 20.0,
) -> str:
    return await run_ps(
        "Invoke-AeRevert",
        {
            "CheckpointId": checkpoint_id,
            "BranchBeforeRevert": branch_before_revert,
        },
        timeout_sec=timeout_sec,
    )


# Note: Invoke-AeReadProps wrapping above differs from the PS signature. Since
# aebm-file demands an explicit `code` kwarg on get_properties, the simplest
# path is to NOT call Invoke-AeReadProps at all and instead issue an ae.exec
# with the supplied JSX. That's what handlers/core.py does. We keep the
# wrapper for completeness / atom-http fallback.
