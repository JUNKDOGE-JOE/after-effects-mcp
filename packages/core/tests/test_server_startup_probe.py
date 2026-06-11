import pytest

from ae_mcp import server


class ProbeBackend:
    def __init__(self, fail=False):
        self.fail = fail
        self.calls = []

    async def health_check(self, timeout_sec=5.0):
        self.calls.append(timeout_sec)
        if self.fail:
            raise RuntimeError("probe failed")
        return True


@pytest.mark.asyncio
async def test_startup_probe_calls_backend_health_check_once():
    backend = ProbeBackend()

    await server._startup_probe(lambda: backend)

    assert backend.calls == [5.0]


@pytest.mark.asyncio
async def test_startup_probe_swallows_health_check_errors():
    backend = ProbeBackend(fail=True)

    await server._startup_probe(lambda: backend)

    assert backend.calls == [5.0]
