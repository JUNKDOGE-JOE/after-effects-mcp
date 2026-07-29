from __future__ import annotations

from pathlib import Path
from string import Template

ROOT = Path(__file__).resolve().parents[1]


def _render_template(name: str, **substitutions: str) -> str:
    path = ROOT / "ae_mcp" / "jsx_templates" / name
    return Template(path.read_text(encoding="utf-8")).substitute(**substitutions)


def test_inspect_property_capabilities_reports_missing_segment_as_failure():
    rendered = _render_template(
        "inspect_property_capabilities.jsx",
        comp_expr="app.project.activeItem",
        layer_id="1",
        path='"Transform/Position"',
    )
    assert "ok:false, exists: false" in rendered
    assert "ok: true, exists: false" not in rendered


def test_get_properties_template_reports_missing_layers_explicitly():
    rendered = _render_template(
        "get_properties.jsx",
        comp_expr="app.project.activeItem",
        layer_ids_js="[1,2]",
        query_js='"position"',
        offset="0",
        limit="50",
    )
    assert "missingLayerIds" in rendered
    assert "no valid layers" in rendered
