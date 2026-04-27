"""Unit tests for the Backend abstract base class."""
import pytest
from ae_mcp.backends.base import Backend, ALL_VERBS


def test_all_verbs_constant_has_24_entries():
    assert len(ALL_VERBS) == 24
    assert "ae.exec" in ALL_VERBS
    assert "ae.ping" in ALL_VERBS
    assert "ae.searchProject" in ALL_VERBS


def test_cannot_instantiate_backend_directly():
    with pytest.raises(TypeError):
        Backend()


def test_backend_subclass_must_define_exec_health_from_env():
    class Incomplete(Backend):
        name = "incomplete"
    with pytest.raises(TypeError):
        Incomplete()


def test_default_supported_verbs_returns_all_24():
    class Minimal(Backend):
        name = "min"
        async def exec(self, code, **kw): return ""
        async def health_check(self, timeout_sec=5.0): return True
        @classmethod
        def from_env(cls): return cls()
    b = Minimal()
    assert b.supported_verbs() == ALL_VERBS


def test_default_capability_flags_are_false():
    class Minimal(Backend):
        name = "min"
        async def exec(self, code, **kw): return ""
        async def health_check(self, timeout_sec=5.0): return True
        @classmethod
        def from_env(cls): return cls()
    b = Minimal()
    assert b.manages_undo is False
    assert b.manages_checkpoints is False
