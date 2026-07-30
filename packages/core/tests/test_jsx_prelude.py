from __future__ import annotations

import pytest

from ae_mcp import schemas as S
from ae_mcp.handlers import HANDLERS, load_all
from ae_mcp.handlers import core as C
from ae_mcp.handlers import typed as T


BEGIN = "AEMCP-HELPERS-BEGIN"
END = "AEMCP-HELPERS-END"


def _helper_body(path):
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines(keepends=True)
    begin = next((i for i, line in enumerate(lines) if BEGIN in line), None)
    end = next((i for i, line in enumerate(lines) if END in line), None)
    assert begin is not None and end is not None and begin < end, (
        f"{path} must contain {BEGIN}/{END} markers; "
        "the runtime helper block and Python prelude copy must stay in sync."
    )
    return "".join(lines[begin + 1:end])


def _body_after_prelude(jsx: str) -> str:
    assert BEGIN in jsx
    assert END in jsx
    return jsx.split(END, 1)[1]


def test_aemcp_prelude_is_verbatim_runtime_helper_copy():
    from pathlib import Path

    root = Path(__file__).resolve().parents[3]
    runtime = root / "plugin" / "jsx" / "runtime.jsx"
    prelude = (
        root
        / "packages"
        / "core"
        / "ae_mcp"
        / "jsx_templates"
        / "_aemcp_prelude.jsx"
    )

    assert _helper_body(prelude) == _helper_body(runtime)


def test_aemcp_prelude_defines_safe_value():
    from pathlib import Path

    root = Path(__file__).resolve().parents[3]
    prelude = (
        root
        / "packages"
        / "core"
        / "ae_mcp"
        / "jsx_templates"
        / "_aemcp_prelude.jsx"
    )

    assert "AEMCP.safeValue = function" in _helper_body(prelude)


@pytest.mark.asyncio
async def test_exec_user_code_is_not_prefixed_with_aemcp_prelude(mock_backend):
    load_all()

    mock_backend.set_response('{"ok":true}')
    _, run_fn = HANDLERS["ae.exec"]
    await run_fn(S.AeExecArgs(code="JSON.stringify({ok:true})"), None)

    assert mock_backend.calls[-1]["code"] == "JSON.stringify({ok:true})"
    assert BEGIN not in mock_backend.calls[-1]["code"]
