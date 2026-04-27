"""Unit tests for AEBMBackend (subprocess mocked)."""
import os
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch
import pytest

from ae_mcp_backend_aebm import AEBMBackend


def test_render_ps_value_none():
    assert AEBMBackend._render_ps_value(None) == "$null"


def test_render_ps_value_bool():
    assert AEBMBackend._render_ps_value(True) == "$true"
    assert AEBMBackend._render_ps_value(False) == "$false"


def test_render_ps_value_int_float_str():
    assert AEBMBackend._render_ps_value(42) == "42"
    assert AEBMBackend._render_ps_value(3.14) == "3.14"
    assert AEBMBackend._render_ps_value("hi") == "'hi'"
    assert AEBMBackend._render_ps_value("it's") == "'it''s'"


def test_render_ps_value_list():
    assert AEBMBackend._render_ps_value([1, 2, 3]) == "@(1, 2, 3)"


def test_from_env_missing_raises(monkeypatch):
    monkeypatch.delenv("AE_BRIDGE_ROOT", raising=False)
    with pytest.raises(EnvironmentError) as ei:
        AEBMBackend.from_env()
    assert "AE_BRIDGE_ROOT" in str(ei.value)


def test_from_env_invalid_path_raises(monkeypatch, tmp_path):
    monkeypatch.setenv("AE_BRIDGE_ROOT", str(tmp_path))
    with pytest.raises(EnvironmentError):
        AEBMBackend.from_env()


def test_from_env_valid_path(monkeypatch, tmp_path):
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    (scripts / "backend_interface.ps1").write_text("# stub")
    monkeypatch.setenv("AE_BRIDGE_ROOT", str(tmp_path))
    b = AEBMBackend.from_env()
    assert b.bridge_root == tmp_path.resolve()


@pytest.mark.asyncio
async def test_exec_calls_subprocess(tmp_path, monkeypatch):
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    (scripts / "backend_interface.ps1").write_text("# stub")

    backend = AEBMBackend(bridge_root=tmp_path)

    async def fake_create(*a, **kw):
        proc = MagicMock()
        proc.returncode = 0
        proc.communicate = AsyncMock(return_value=(b'{"ok":true}', b''))
        return proc

    monkeypatch.setattr("asyncio.create_subprocess_exec", fake_create)

    out = await backend.exec(code="42", timeout_sec=5.0)
    assert out == '{"ok":true}'
