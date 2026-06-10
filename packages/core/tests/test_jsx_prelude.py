from __future__ import annotations

import pytest

from ae_mcp import schemas as S
from ae_mcp.handlers import HANDLERS, load_all
from ae_mcp.handlers import core as C
from ae_mcp.handlers import typed as T
from ae_mcp.handlers.rig import _run_create_rig


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


def test_rendered_templates_are_prefixed_with_aemcp_prelude():
    set_property = T.render_set_property(
        S.AeSetPropertyArgs(layer_id=2, path="Transform/Position", value=[1, 2])
    )
    apply_effect = C._apply_effect_jsx("12", 3, "ADBE Gaussian Blur 2")

    assert BEGIN in set_property
    assert "AEMCP.activeComp()" in _body_after_prelude(set_property)
    assert "AEMCP.layerById(comp, 2)" in _body_after_prelude(set_property)

    assert BEGIN in apply_effect
    assert "AEMCP.compById(12)" in _body_after_prelude(apply_effect)
    assert "AEMCP.layerById(comp, 3)" in _body_after_prelude(apply_effect)


@pytest.mark.asyncio
async def test_create_rig_and_init_are_prefixed_with_aemcp_prelude(mock_backend):
    load_all()

    mock_backend.set_response('{"ok":true}')
    await _run_create_rig(
        S.AeCreateRigArgs(
            target_layer_id=4,
            rig_type="effect_controls",
            name="Controls",
        ),
        ctx=None,
    )
    create_rig = mock_backend.calls[-1]["code"]
    assert BEGIN in create_rig
    assert "AEMCP.activeComp()" in _body_after_prelude(create_rig)
    assert "AEMCP.layerById(comp, 4)" in _body_after_prelude(create_rig)

    mock_backend.set_response('{"pluginVersion":"test-stub"}')
    _, run_fn = HANDLERS["ae.init"]
    await run_fn(S.AeInitArgs(refresh_only=True), None)
    init_jsx = mock_backend.calls[-1]["code"]
    assert BEGIN in init_jsx


@pytest.mark.asyncio
async def test_exec_user_code_is_not_prefixed_with_aemcp_prelude(mock_backend):
    load_all()

    mock_backend.set_response('{"ok":true}')
    _, run_fn = HANDLERS["ae.exec"]
    await run_fn(S.AeExecArgs(code="JSON.stringify({ok:true})"), None)

    assert mock_backend.calls[-1]["code"] == "JSON.stringify({ok:true})"
    assert BEGIN not in mock_backend.calls[-1]["code"]
