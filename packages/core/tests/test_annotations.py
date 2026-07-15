import pytest

from ae_mcp.annotations import VERB_ANNOTATIONS
from ae_mcp.handlers import HANDLERS, load_all
from ae_mcp.server import build_server


def test_every_registered_verb_has_an_annotation_entry():
    load_all()
    missing = set(HANDLERS) - set(VERB_ANNOTATIONS)
    extra = set(VERB_ANNOTATIONS) - set(HANDLERS)
    assert not missing, f"verbs lacking annotations: {sorted(missing)}"
    assert not extra, f"annotations for unregistered verbs: {sorted(extra)}"


def test_exec_is_destructive_and_reads_are_readonly():
    load_all()
    assert VERB_ANNOTATIONS["ae.exec"].destructiveHint is True
    assert VERB_ANNOTATIONS["ae.exec"].readOnlyHint is False
    assert VERB_ANNOTATIONS["ae.overview"].readOnlyHint is True
    assert VERB_ANNOTATIONS["ae.overview"].destructiveHint is False
    assert VERB_ANNOTATIONS["ae.projectSummary"].readOnlyHint is True
    assert VERB_ANNOTATIONS["ae.projectSummary"].destructiveHint is False
    assert VERB_ANNOTATIONS["ae.projectSummary"].idempotentHint is True
    assert VERB_ANNOTATIONS["ae.getProjectBitDepth"].readOnlyHint is True
    assert VERB_ANNOTATIONS["ae.getProjectBitDepth"].destructiveHint is False
    assert VERB_ANNOTATIONS["ae.setProjectBitDepth"].readOnlyHint is False
    assert VERB_ANNOTATIONS["ae.setProjectBitDepth"].destructiveHint is False
    assert VERB_ANNOTATIONS["ae.setProjectBitDepth"].idempotentHint is True
    for verb in ("ae.listProjectItems", "ae.listCompositionLayers"):
        assert VERB_ANNOTATIONS[verb].readOnlyHint is True
        assert VERB_ANNOTATIONS[verb].destructiveHint is False
        assert VERB_ANNOTATIONS[verb].idempotentHint is True


def test_no_verb_is_both_readonly_and_destructive():
    for verb, ann in VERB_ANNOTATIONS.items():
        assert not (ann.readOnlyHint and ann.destructiveHint), verb


def test_tool_library_annotations_express_worst_path_risk():
    for verb in ("ae.toolIndex", "ae.toolSearch", "ae.toolInspect"):
        assert VERB_ANNOTATIONS[verb].readOnlyHint is True
        assert VERB_ANNOTATIONS[verb].destructiveHint is False
    assert VERB_ANNOTATIONS["ae.toolUse"].destructiveHint is True
    assert VERB_ANNOTATIONS["ae.toolDelete"].destructiveHint is True
    assert VERB_ANNOTATIONS["ae.toolExport"].destructiveHint is True



@pytest.mark.asyncio
async def test_list_tools_carries_annotations(monkeypatch):
    from ae_mcp import server as srv

    load_all()
    monkeypatch.setattr(srv, "_filtered_tool_names", lambda: set(HANDLERS.keys()))
    server = build_server()
    tools = await server._ae_list_tools()
    by_name = {t.name: t for t in tools}
    assert by_name["ae_exec"].annotations.destructiveHint is True
    assert by_name["ae_overview"].annotations.readOnlyHint is True
    assert all(t.annotations is not None for t in tools)
