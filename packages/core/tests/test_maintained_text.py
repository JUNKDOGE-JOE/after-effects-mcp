from __future__ import annotations

import json
from copy import deepcopy
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from ae_mcp.backends import maintained_text
from ae_mcp.backends.maintained_text import (
    ResolvedCompositionAddress,
    ResolvedTextAddress,
    VALUE_MODELS,
    clear_replay_cache_for_tests,
    execute_text_tool,
    render_text_tool,
)
from ae_mcp.schemas_tsm import (
    AeCreateTextLayerArgs,
    AeGetTextDocumentArgs,
    AeListInstalledFontsArgs,
    AeSetTextCharacterStyleArgs,
    AeSetTextContentArgs,
    AeSetTextParagraphStyleArgs,
)


KEY = "text-tool-key-0001"
LAYER_LOCATOR = {
    "kind": "layer",
    "hostInstanceId": "11111111-1111-4111-8111-111111111111",
    "sessionId": "22222222-2222-4222-8222-222222222222",
    "projectId": "33333333-3333-4333-8333-333333333333",
    "generation": 1,
    "objectId": "44444444-4444-4444-8444-444444444444",
}
COMPOSITION_LOCATOR = {**LAYER_LOCATOR, "kind": "composition"}
COMPOSITION_ADDRESS = ResolvedCompositionAddress(
    project_item_index=2,
    expected_name="TSM Composition",
)
TEXT_ADDRESS = ResolvedTextAddress(
    project_item_index=2,
    expected_name="TSM Composition",
    layer_index=3,
    expected_layer_name="TSM \"Text\" 😀\n",
)


def snapshot(text: str = "A😀中 e\u0301") -> dict:
    return {
        "layerLocator": LAYER_LOCATOR,
        "text": text,
        "textKind": "box",
        "boxSize": {"widthPixels": "640", "heightPixels": "360"},
        "characterStyle": {
            "fontPostScriptName": "FixturePS-Bold",
            "fontSizePixels": "48",
            "fillColor": {"red": 1, "green": 2, "blue": 3, "alpha": 255},
            "strokeColor": {"red": 4, "green": 5, "blue": 6, "alpha": 255},
            "strokeWidthPixels": "2.5",
            "strokeOverFill": True,
            "tracking": 25,
            "autoLeading": False,
            "leadingPixels": "56",
            "fauxBold": True,
            "fauxItalic": False,
        },
        "paragraphStyle": {
            "justification": "full-last-center",
            "firstLineIndentPixels": "-12",
            "startIndentPixels": "3",
            "endIndentPixels": "4",
            "spaceBeforePixels": "5",
            "spaceAfterPixels": "6",
        },
        "resolvedFont": {
            "requestedPostScriptName": None,
            "selectedPostScriptName": "FixturePS-Bold",
            "usedFallback": False,
        },
    }


def internal_snapshot(text: str = "A😀中 e\u0301") -> dict:
    value = snapshot(text)
    value.pop("layerLocator")
    value["_address"] = TEXT_ADDRESS.model_dump(mode="json", by_alias=True)
    return value


class Backend:
    def __init__(self, result: dict):
        self.result = result
        self.calls: list[dict] = []

    async def exec(self, **kwargs):
        self.calls.append(kwargs)
        return json.dumps(self.result, ensure_ascii=False)


def request_literal(rendered: str) -> dict:
    marker = "var request = "
    start = rendered.index(marker) + len(marker)
    end = rendered.index(";\n", start)
    return json.loads(rendered[start:end])


def test_hostile_text_is_one_json_literal_and_never_changes_program_structure():
    hostile = "\"\\\n\u2028😀中 e\u0301); app.project.close(); //"
    args = AeCreateTextLayerArgs(
        composition_locator=COMPOSITION_LOCATOR,
        name=hostile,
        text=hostile,
        text_kind="point",
        idempotency_key=KEY,
    )
    rendered, metadata = render_text_tool(
        "ae.createTextLayer", args, resolved_address=COMPOSITION_ADDRESS
    )
    literal = request_literal(rendered)
    assert literal["name"] == hostile
    assert literal["text"] == hostile
    assert rendered.count("var request = ") == 1
    assert "\u2028" not in rendered
    assert "\\u2028" in rendered
    assert "\\ud83d\\ude00" in rendered
    assert metadata["templateId"] == "aemcp.text.layer.create.v1"
    assert len(metadata["templateDigest"]) == 64
    assert "composition_locator" not in literal
    assert literal["_resolved"] == {
        "project_item_index": 2,
        "expected_name": "TSM Composition",
    }
    assert "caller" not in literal
    assert all(
        key not in literal
        for key in ("code", "jsx", "script", "expression", "matchName", "propertyPath")
    )


def test_all_six_templates_are_closed_and_writes_have_one_undo_boundary():
    create = AeCreateTextLayerArgs(
        composition_locator=COMPOSITION_LOCATOR,
        name="Text",
        text="x",
        idempotency_key=KEY,
    )
    rendered, _ = render_text_tool(
        "ae.createTextLayer", create, resolved_address=COMPOSITION_ADDRESS
    )
    assert rendered.count("app.beginUndoGroup") == 1
    assert rendered.count("app.endUndoGroup") >= 1
    assert "sourceText.setValue(doc)" in rendered
    style = AeSetTextCharacterStyleArgs(
        layer_locator=LAYER_LOCATOR,
        style={
            "font": {
                "preferred_postscript_name": "MissingPS",
                "fallback_postscript_names": ["FirstPS", "SecondPS"],
                "on_missing": "use-first-installed-fallback",
            }
        },
        idempotency_key=KEY,
    )
    style_rendered, _ = render_text_tool(
        "ae.setTextCharacterStyle", style, resolved_address=TEXT_ADDRESS
    )
    style_literal = request_literal(style_rendered)
    assert "layer_locator" not in style_literal
    assert style_literal["_resolved"]["expected_layer_name"] == 'TSM "Text" 😀\n'
    assert "FONT_NOT_INSTALLED" in style_rendered
    assert "FONT_FALLBACK_EXHAUSTED" in style_rendered
    assert "selection.fallback_postscript_names" in style_rendered
    assert style_rendered.index("resolveFont(style.font)") < style_rendered.rindex("beginWrite();")
    cases = {
        "ae.listInstalledFonts": AeListInstalledFontsArgs(),
        "ae.createTextLayer": create,
        "ae.getTextDocument": AeGetTextDocumentArgs(
            layer_locator=LAYER_LOCATOR
        ),
        "ae.setTextContent": AeSetTextContentArgs(
            layer_locator=LAYER_LOCATOR,
            text="changed",
            idempotency_key=KEY,
        ),
        "ae.setTextCharacterStyle": style,
        "ae.setTextParagraphStyle": AeSetTextParagraphStyleArgs(
            layer_locator=LAYER_LOCATOR,
            style={"justification": "center"},
            idempotency_key=KEY,
        ),
    }
    for tool, args in cases.items():
        address = (
            None
            if tool == "ae.listInstalledFonts"
            else COMPOSITION_ADDRESS
            if tool == "ae.createTextLayer"
            else TEXT_ADDRESS
        )
        source, metadata = render_text_tool(
            tool, args, resolved_address=address
        )
        assert "__AEMCP_TEXT_" not in source
        assert source.count("var request = ") == 1
        assert metadata["templateId"].startswith("aemcp.text.")


def test_complete_text_document_style_and_unicode_round_trip():
    model = VALUE_MODELS["ae.getTextDocument"].model_validate(snapshot())
    wire = model.model_dump(mode="json", by_alias=True)
    assert wire == snapshot()
    for text in ("ASCII", "中文", "😀", "e\u0301"):
        value = snapshot(text)
        assert (
            VALUE_MODELS["ae.getTextDocument"]
            .model_validate(value)
            .model_dump(mode="json", by_alias=True)["text"]
            == text
        )
    mixed = snapshot()
    del mixed["characterStyle"]["tracking"]
    with pytest.raises(ValidationError, match="tracking"):
        VALUE_MODELS["ae.getTextDocument"].model_validate(mixed)


@pytest.mark.asyncio
async def test_locator_resolver_derives_only_private_extend_script_coordinates(
    monkeypatch,
):
    composition = maintained_text._native_locator(COMPOSITION_LOCATOR)
    layer = maintained_text._native_locator(LAYER_LOCATOR)
    item = SimpleNamespace(
        locator=composition,
        name="TSM Composition",
        type="composition",
    )
    row = SimpleNamespace(
        locator=layer,
        stack_index=3,
        name='TSM "Text" 😀\n',
        type="text",
    )

    async def project_rows(*_args, **_kwargs):
        return [(2, item)]

    async def layer_rows(*_args, **_kwargs):
        return [row]

    monkeypatch.setattr(maintained_text, "_project_compositions", project_rows)
    monkeypatch.setattr(
        maintained_text, "_composition_layer_rows", layer_rows
    )
    cancellation = maintained_text.NativeCancellationToken()
    resolved_comp = await maintained_text.resolve_composition_address(
        object(),
        COMPOSITION_LOCATOR,
        deadline_unix_ms=1,
        cancellation=cancellation,
    )
    resolved_layer = await maintained_text.resolve_text_address(
        object(),
        LAYER_LOCATOR,
        deadline_unix_ms=1,
        cancellation=cancellation,
    )
    assert resolved_comp == COMPOSITION_ADDRESS
    assert resolved_layer == TEXT_ADDRESS
    fresh_comp, fresh_layer = await maintained_text._reacquire_created_text_layer(
        object(),
        TEXT_ADDRESS,
        deadline_unix_ms=1,
        cancellation=cancellation,
    )
    assert fresh_comp == composition
    assert fresh_layer == layer


@pytest.mark.asyncio
async def test_typed_execution_binds_template_audit_postcondition_and_replay(
    monkeypatch, tmp_path
):
    clear_replay_cache_for_tests()
    monkeypatch.setenv("AE_MCP_TEXT_AUDIT_PATH", str(tmp_path / "audit.jsonl"))
    monkeypatch.setenv("AE_MCP_SOURCE_COMMIT_SHA", "a" * 40)
    before = internal_snapshot("before 😀")
    after = internal_snapshot("after 中")
    result = {
        "ok": True,
        "value": {
            "changed": True,
            "_address": TEXT_ADDRESS.model_dump(mode="json", by_alias=True),
            "before": before,
            "after": after,
        },
    }
    backend = Backend(result)

    async def resolve(*_args, **_kwargs):
        return TEXT_ADDRESS

    async def reacquire(*_args, **_kwargs):
        return (
            maintained_text._native_locator(COMPOSITION_LOCATOR),
            maintained_text._native_locator(LAYER_LOCATOR),
        )

    monkeypatch.setattr(maintained_text, "resolve_text_address", resolve)
    monkeypatch.setattr(
        maintained_text, "_reacquire_created_text_layer", reacquire
    )
    args = AeSetTextContentArgs(
        layer_locator=LAYER_LOCATOR,
        text="after 中",
        idempotency_key=KEY,
    )
    response = await execute_text_tool(
        backend, object(), tool="ae.setTextContent", args=args
    )
    assert response["ok"] is True
    assert response["implementation"]["engine"] == "maintained-jsx"
    assert response["implementation"]["callerCodeAccepted"] is False
    assert response["provenance"]["sourceCommit"] == "a" * 40
    assert response["audit"]["undoAvailable"] is True
    assert response["audit"]["undoVerified"] is False
    assert response["evidence"]["undo"]["available"] is True
    assert response["evidence"]["undo"]["verified"] is False
    assert response["evidence"]["postcondition"]["verified"] is True
    assert len(backend.calls) == 1
    replay = await execute_text_tool(
        backend, object(), tool="ae.setTextContent", args=args
    )
    assert replay["replayed"] is True
    assert replay["audit"]["replayed"] is True
    assert len(backend.calls) == 1
    audit = [
        json.loads(line)
        for line in (tmp_path / "audit.jsonl").read_text().splitlines()
    ]
    assert len(audit) == 1
    assert "arguments" not in audit[0]
    assert audit[0]["requestDigest"] == response["audit"]["requestDigest"]


@pytest.mark.asyncio
async def test_idempotency_key_rebinding_fails_before_dispatch(monkeypatch, tmp_path):
    clear_replay_cache_for_tests()
    monkeypatch.setenv("AE_MCP_TEXT_AUDIT_PATH", str(tmp_path / "audit.jsonl"))
    monkeypatch.setenv("AE_MCP_SOURCE_COMMIT_SHA", "b" * 40)
    before = internal_snapshot("before")
    after = internal_snapshot("one")
    backend = Backend(
        {
            "ok": True,
            "value": {
                "changed": True,
                "_address": TEXT_ADDRESS.model_dump(mode="json", by_alias=True),
                "before": before,
                "after": after,
            },
        }
    )
    async def resolve(*_args, **_kwargs):
        return TEXT_ADDRESS

    async def reacquire(*_args, **_kwargs):
        return (
            maintained_text._native_locator(COMPOSITION_LOCATOR),
            maintained_text._native_locator(LAYER_LOCATOR),
        )

    monkeypatch.setattr(maintained_text, "resolve_text_address", resolve)
    monkeypatch.setattr(
        maintained_text, "_reacquire_created_text_layer", reacquire
    )
    first = AeSetTextContentArgs(
        layer_locator=LAYER_LOCATOR, text="one", idempotency_key=KEY
    )
    assert (await execute_text_tool(
        backend, object(), tool="ae.setTextContent", args=first
    ))["ok"]
    second = AeSetTextContentArgs(
        layer_locator=LAYER_LOCATOR, text="two", idempotency_key=KEY
    )
    rejected = await execute_text_tool(
        backend, object(), tool="ae.setTextContent", args=second
    )
    assert rejected["error"]["code"] == "DUPLICATE_REQUEST"
    assert rejected["error"]["sideEffect"] == "not-started"
    assert len(backend.calls) == 1
