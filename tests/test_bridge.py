"""Bridge encoding + subprocess spawn tests.

We don't actually run pwsh here; we verify the argument-encoding helpers and
that run_ps() assembles a sane script.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from aebm_mcp import bridge


def test_format_ps_value_basic():
    assert bridge._format_ps_value(None) == "$null"
    assert bridge._format_ps_value(True) == "$true"
    assert bridge._format_ps_value(False) == "$false"
    assert bridge._format_ps_value(42) == "42"
    assert bridge._format_ps_value(3.14) == "3.14"


def test_format_ps_value_string_escaping():
    assert bridge._format_ps_value("simple") == "'simple'"
    assert bridge._format_ps_value("it's") == "'it''s'"


def test_format_ps_value_list():
    assert bridge._format_ps_value([1, 2, 3]) == "@(1, 2, 3)"
    assert bridge._format_ps_value(["a", "b"]) == "@('a', 'b')"


def test_format_ps_value_rejects_dict():
    with pytest.raises(TypeError):
        bridge._format_ps_value({"foo": "bar"})


def test_format_ps_hashtable_simple():
    out = bridge.format_ps_hashtable({"a": 1, "b": "x"})
    assert out.startswith("@{ ")
    assert "a = 1" in out
    assert "b = 'x'" in out


def test_format_ps_hashtable_nested():
    out = bridge.format_ps_hashtable({"outer": {"inner": True}})
    assert "outer = @{" in out
    assert "inner = $true" in out


def test_format_ps_invocation_named_params():
    inv = bridge.format_ps_invocation("Invoke-AeLayers", {"CompId": "42"})
    assert inv == "Invoke-AeLayers -CompId '42'"


def test_format_ps_invocation_switch_true():
    inv = bridge.format_ps_invocation("Invoke-AeInit", {"RefreshOnly": True})
    assert inv == "Invoke-AeInit -RefreshOnly"


def test_format_ps_invocation_switch_false_omitted():
    inv = bridge.format_ps_invocation("Invoke-AeInit", {"RefreshOnly": False})
    assert inv == "Invoke-AeInit"


def test_format_ps_invocation_none_skipped():
    inv = bridge.format_ps_invocation("Invoke-AeLayers", {"CompId": None})
    assert inv == "Invoke-AeLayers"


def test_build_script_dot_sources_interface(tmp_path, monkeypatch):
    # Just verifies the preamble references the real interface path.
    script = bridge._build_powershell_script("Invoke-AeOverview")
    assert "Initialize-Backend" in script
    assert "backend_interface.ps1" in script
    assert "AE_BACKEND = 'aebm-file'" in script


def test_build_script_with_code_var():
    script = bridge._build_powershell_script(
        "Invoke-AeExec -Code $AEBM_Code -TimeoutSec 30",
        code_var="$AEBM_Code",
    )
    assert "$AEBM_Code = [System.IO.File]::ReadAllText" in script
    assert "$env:AEBM_CODE_FILE" in script


@pytest.mark.asyncio
async def test_run_ps_invokes_powershell(tmp_path, monkeypatch):
    """Mock asyncio.create_subprocess_exec; verify pwsh is invoked with the
    expected script text containing our invocation."""
    captured: dict = {}

    class FakeProc:
        returncode = 0

        async def communicate(self):
            return (b'{"ok":true}', b"")

        def kill(self):
            pass

    async def fake_exec(*args, **kwargs):
        captured["args"] = args
        captured["env"] = kwargs.get("env")
        return FakeProc()

    monkeypatch.setattr(
        "asyncio.create_subprocess_exec", fake_exec
    )

    out = await bridge.run_ps(
        "Invoke-AeOverview",
        {},
        timeout_sec=5.0,
    )
    assert out == '{"ok":true}'
    assert captured["args"][0] == "powershell"
    # Script is last arg after flags
    script = captured["args"][-1]
    assert "Invoke-AeOverview" in script


@pytest.mark.asyncio
async def test_run_ps_with_code_sets_env(tmp_path, monkeypatch):
    captured: dict = {}

    class FakeProc:
        returncode = 0
        async def communicate(self):
            return (b"OK", b"")
        def kill(self):
            pass

    async def fake_exec(*args, **kwargs):
        captured["env"] = kwargs.get("env")
        captured["args"] = args
        return FakeProc()

    monkeypatch.setattr("asyncio.create_subprocess_exec", fake_exec)

    out = await bridge.run_ps(
        "Invoke-AeExec",
        {"TimeoutSec": 30},
        code="$.writeln('hi')",
        timeout_sec=5.0,
    )
    assert out == "OK"
    assert "AEBM_CODE_FILE" in captured["env"]
    script = captured["args"][-1]
    assert "$AEBM_Code" in script


@pytest.mark.asyncio
async def test_run_ps_raises_on_nonzero(monkeypatch):
    class FakeProc:
        returncode = 1
        async def communicate(self):
            return (b"", b"boom")
        def kill(self):
            pass

    async def fake_exec(*args, **kwargs):
        return FakeProc()

    monkeypatch.setattr("asyncio.create_subprocess_exec", fake_exec)
    with pytest.raises(RuntimeError, match="boom"):
        await bridge.run_ps("Invoke-AeOverview", {}, timeout_sec=5.0)
