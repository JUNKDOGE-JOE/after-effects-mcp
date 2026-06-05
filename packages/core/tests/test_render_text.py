"""Compact text renderers (format='text') for high-volume read verbs."""
from __future__ import annotations

from ae_mcp import render_text


def test_render_layers_table_and_paging():
    d = {
        "ok": True, "compName": "Hero", "compId": "1",
        "total": 3, "offset": 0, "limit": 100, "returned": 2, "hasMore": False,
        "layers": [
            {"id": 1, "name": "BG", "type": "solid",
             "enabled": True, "isThreeD": False, "parent": None},
            {"id": 2, "name": "Title", "type": "text",
             "enabled": False, "isThreeD": True, "parent": "Null 1"},
        ],
    }
    out = render_text.render_layers(d)
    assert isinstance(out, str)
    assert 'Comp: "Hero" (3 layers)' in out
    assert "Page: offset=0 limit=100 returned=2 total=3 hasMore=N" in out
    assert "id | name | type | state | parent" in out
    assert "1 | BG | solid | - | -" in out
    assert "2 | Title | text | off,3D | Null 1" in out


def test_render_layers_is_compact_vs_json():
    import json
    d = {
        "ok": True, "compName": "C", "compId": "1", "total": 20,
        "offset": 0, "limit": 100, "returned": 20, "hasMore": False,
        "layers": [
            {"id": i, "name": f"layer{i}", "type": "solid",
             "enabled": True, "inPoint": 0.0, "outPoint": 5.0,
             "isThreeD": False, "parent": None}
            for i in range(1, 21)
        ],
    }
    text_len = len(render_text.render_layers(d))
    json_len = len(json.dumps(d, ensure_ascii=False))
    assert text_len < json_len  # compact form is strictly smaller


def test_maybe_render_passes_json_through():
    d = {"ok": True, "layers": []}
    assert render_text.maybe_render(d, "json", render_text.render_layers) is d


def test_maybe_render_text_renders_string():
    d = {"ok": True, "compName": "C", "total": 0, "offset": 0,
         "limit": 10, "returned": 0, "hasMore": False, "layers": []}
    out = render_text.maybe_render(d, "text", render_text.render_layers)
    assert isinstance(out, str)
    assert 'Comp: "C"' in out


def test_maybe_render_passes_errors_through():
    err = {"ok": False, "error": "no comp"}
    assert render_text.maybe_render(err, "text", render_text.render_layers) is err


def test_maybe_render_renderer_failure_falls_back_to_dict():
    def boom(_d):
        raise ValueError("nope")

    d = {"ok": True}
    assert render_text.maybe_render(d, "text", boom) is d


def test_render_layers_limit_all_and_hasmore_yes():
    # limit=0 (the back-compat "return all" default) renders as limit=all,
    # and hasMore=True renders as Y.
    d = {
        "ok": True, "compName": "Big", "compId": "1",
        "total": 250, "offset": 0, "limit": 0, "returned": 250, "hasMore": True,
        "layers": [],
    }
    out = render_text.render_layers(d)
    assert "limit=all" in out
    assert "hasMore=Y" in out


def test_render_layers_name_fallback_when_unnamed():
    d = {"ok": True, "total": 0, "offset": 0, "limit": 0,
         "returned": 0, "hasMore": False, "layers": []}
    out = render_text.render_layers(d)
    assert 'Comp: "?"' in out


def test_render_layers_omits_page_line_when_not_paginated():
    # No 'offset' key -> the verb wasn't paginated, so no Page: line.
    d = {"ok": True, "compName": "C", "total": 1,
         "layers": [{"id": 1, "name": "X", "type": "solid",
                     "enabled": True, "isThreeD": False, "parent": None}]}
    out = render_text.render_layers(d)
    assert "Page:" not in out
    assert "1 | X | solid" in out
