from __future__ import annotations

from pathlib import Path
from string import Template

import pytest
from pydantic import ValidationError

from ae_mcp.schemas import AeGetPropertiesArgs


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


@pytest.mark.parametrize("layer_ids", ([0], [-1], []))
def test_get_properties_schema_rejects_invalid_layer_ids(layer_ids: list[int]):
    with pytest.raises(ValidationError):
        AeGetPropertiesArgs(layer_ids=layer_ids, query="position")


def test_get_properties_schema_accepts_positive_layer_ids():
    args = AeGetPropertiesArgs(layer_ids=[1, 2], query="position")
    assert args.layer_ids == [1, 2]
