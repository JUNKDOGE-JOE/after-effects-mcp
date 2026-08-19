import logging

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


def test_run_writes_startup_info_to_append_only_file(monkeypatch, tmp_path):
    log_dir = tmp_path / "logs"
    monkeypatch.setenv("AE_MCP_LOG_DIR", str(log_dir))
    monkeypatch.setenv("AE_MCP_BACKEND", "maintained-jsx")
    monkeypatch.setenv("AE_MCP_PLUGIN_URL", "http://127.0.0.1:11488")

    async def _no_server():
        return None

    monkeypatch.setattr(server, "_run_async", _no_server)
    server.run()
    files = list(log_dir.glob("server-*.log"))
    assert len(files) == 1
    first_line = files[0].read_text(encoding="utf-8").splitlines()[0]
    assert "ae-mcp startup" in first_line
    assert "backend=maintained-jsx" in first_line
    assert "pluginUrl=http://127.0.0.1:11488" in first_line

    handler = server._FILE_LOG_HANDLER
    if handler is not None:
        logging.getLogger().removeHandler(handler)
        handler.close()
        server._FILE_LOG_HANDLER = None


def test_file_logging_failure_does_not_raise(monkeypatch, tmp_path):
    bad_path = tmp_path / "not-a-directory"
    bad_path.write_text("occupied", encoding="utf-8")
    assert server._configure_file_logging(bad_path) is None
