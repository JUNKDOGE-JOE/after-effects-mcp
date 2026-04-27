"""Unit tests for the Backend abstract base class."""
import pytest
from ae_mcp.backends.base import Backend, ALL_VERBS


def test_all_verbs_constant_has_30_entries():
    assert len(ALL_VERBS) == 30
    assert "ae.exec" in ALL_VERBS
    assert "ae.ping" in ALL_VERBS
    assert "ae.previewFrame" in ALL_VERBS
    assert "ae.skillUse" in ALL_VERBS
    assert "ae.createRig" in ALL_VERBS
    assert "ae.validateExpressions" in ALL_VERBS
    assert "ae.searchProject" in ALL_VERBS
    assert "ae.isolateToggle" not in ALL_VERBS
    assert "ae.toastQuery" not in ALL_VERBS


def test_cannot_instantiate_backend_directly():
    with pytest.raises(TypeError):
        Backend()


def test_backend_subclass_must_define_exec_health_from_env():
    class Incomplete(Backend):
        name = "incomplete"
    with pytest.raises(TypeError):
        Incomplete()


def test_default_supported_verbs_returns_all_known_verbs():
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


import pytest
from ae_mcp.backends.mock import MockBackend


@pytest.mark.asyncio
async def test_mock_backend_records_calls():
    mb = MockBackend()
    mb.set_response('JSON.stringify({ok:true})')
    out = await mb.exec("foo")
    assert out == 'JSON.stringify({ok:true})'
    assert len(mb.calls) == 1
    assert mb.calls[0]["code"] == "foo"


@pytest.mark.asyncio
async def test_mock_backend_health_check_default_true():
    mb = MockBackend()
    assert await mb.health_check() is True


@pytest.mark.asyncio
async def test_mock_backend_can_simulate_failure():
    mb = MockBackend()
    mb.set_health(False)
    assert await mb.health_check() is False
