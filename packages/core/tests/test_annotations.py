from collections.abc import Mapping
from typing import Any, Literal, get_args, get_origin

import pytest
from mcp.types import ToolAnnotations
from pydantic import BaseModel

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
    assert VERB_ANNOTATIONS["ae.nativeExec"].destructiveHint is True
    assert VERB_ANNOTATIONS["ae.nativeExec"].readOnlyHint is False
    assert VERB_ANNOTATIONS["ae.nativeExec"].idempotentHint is True
    for verb in (
        "ae.diagnose",
        "ae.ping",
        "ae.previewFrame",
        "ae.skillList",
        "ae.snapshot",
        "ae.status",
        "ae.toolIndex",
        "ae.toolInspect",
        "ae.toolSearch",
        "ae.validateExpressions",
    ):
        assert VERB_ANNOTATIONS[verb].readOnlyHint is True
        assert VERB_ANNOTATIONS[verb].destructiveHint is False
        assert VERB_ANNOTATIONS[verb].idempotentHint is True


def test_no_verb_is_both_readonly_and_destructive():
    for verb, ann in VERB_ANNOTATIONS.items():
        assert not (ann.readOnlyHint and ann.destructiveHint), verb


_EXECUTABLE_INPUT_FIELDS = {"code", "expression", "execute"}
_EXECUTABLE_ACTION_LITERALS = {"execute", "start"}


def _literal_strings(annotation: Any) -> set[str]:
    if get_origin(annotation) is Literal:
        return {value for value in get_args(annotation) if isinstance(value, str)}
    values: set[str] = set()
    for argument in get_args(annotation):
        values.update(_literal_strings(argument))
    return values


def _assert_executable_input_tools_are_destructive(
    handlers: Mapping[str, tuple[type[BaseModel], Any]],
    annotations: Mapping[str, ToolAnnotations],
) -> None:
    for verb, (schema, _run) in handlers.items():
        fields = schema.model_fields
        action_values = (
            _literal_strings(fields["action"].annotation)
            if "action" in fields
            else set()
        )
        accepts_executable_input = (
            bool(_EXECUTABLE_INPUT_FIELDS & fields.keys())
            or bool(_EXECUTABLE_ACTION_LITERALS & action_values)
        )
        if accepts_executable_input:
            assert annotations[verb].destructiveHint is True, verb


def test_tools_accepting_executable_caller_input_are_destructive():
    load_all()
    _assert_executable_input_tools_are_destructive(HANDLERS, VERB_ANNOTATIONS)


def test_tool_library_annotations_express_worst_path_risk():
    for verb in ("ae.toolIndex", "ae.toolSearch", "ae.toolInspect"):
        assert VERB_ANNOTATIONS[verb].readOnlyHint is True
        assert VERB_ANNOTATIONS[verb].destructiveHint is False
    assert VERB_ANNOTATIONS["ae.toolUse"].destructiveHint is True



@pytest.mark.asyncio
async def test_list_tools_carries_annotations(monkeypatch):
    from ae_mcp import server as srv

    load_all()
    monkeypatch.setattr(srv, "_filtered_tool_names", lambda: set(HANDLERS.keys()))
    server = build_server()
    tools = await server._ae_list_tools()
    by_name = {t.name: t for t in tools}
    assert by_name["ae_exec"].annotations.destructiveHint is True
    assert by_name["ae_nativeExec"].annotations.destructiveHint is True
    assert by_name["ae_previewFrame"].annotations.readOnlyHint is True
    assert all(t.annotations is not None for t in tools)
