from __future__ import annotations

import json
from copy import deepcopy

import pytest
from pydantic import ValidationError

from ae_mcp.backends.maintained_text import (
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
TARGET = {
    "composition_id": "42",
    "layer_index": 3,
    "expected_name": "TSM \"Text\" 😀\n",
}


def snapshot(text: str = "A😀中 e\u0301") -> dict:
    return {
        "target": {
            "compositionId": "42",
            "layerIndex": 3,
            "expectedName": TARGET["expected_name"],
        },
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
        composition_id="42",
        name=hostile,
        text=hostile,
        text_kind="point",
        idempotency_key=KEY,
    )
    rendered, metadata = render_text_tool("ae.createTextLayer", args)
    literal = request_literal(rendered)
    assert literal["name"] == hostile
    assert literal["text"] == hostile
    assert rendered.count("var request = ") == 1
    assert "\u2028" not in rendered
    assert "\\u2028" in rendered
    assert "\\ud83d\\ude00" in rendered
    assert metadata["templateId"] == "aemcp.text.layer.create.v1"
    assert len(metadata["templateDigest"]) == 64
    assert "caller" not in literal
    assert all(
        key not in literal
        for key in ("code", "jsx", "script", "expression", "matchName", "propertyPath")
    )


def test_all_six_templates_are_closed_and_writes_have_one_undo_boundary():
    create = AeCreateTextLayerArgs(
        composition_id="42",
        name="Text",
        text="x",
        idempotency_key=KEY,
    )
    rendered, _ = render_text_tool("ae.createTextLayer", create)
    assert rendered.count("app.beginUndoGroup") == 1
    assert rendered.count("app.endUndoGroup") >= 1
    assert "sourceText.setValue(doc)" in rendered
    style = AeSetTextCharacterStyleArgs(
        target={"composition_id": "42", "layer_index": 3, "expected_name": "Text"},
        style={
            "font": {
                "preferred_postscript_name": "MissingPS",
                "fallback_postscript_names": ["FirstPS", "SecondPS"],
                "on_missing": "use-first-installed-fallback",
            }
        },
        idempotency_key=KEY,
    )
    style_rendered, _ = render_text_tool("ae.setTextCharacterStyle", style)
    assert "FONT_NOT_INSTALLED" in style_rendered
    assert "FONT_FALLBACK_EXHAUSTED" in style_rendered
    assert "selection.fallback_postscript_names" in style_rendered
    assert style_rendered.index("resolveFont(style.font)") < style_rendered.rindex("beginWrite();")
    cases = {
        "ae.listInstalledFonts": AeListInstalledFontsArgs(),
        "ae.createTextLayer": create,
        "ae.getTextDocument": AeGetTextDocumentArgs(
            target={"composition_id": "42", "layer_index": 3, "expected_name": "Text"}
        ),
        "ae.setTextContent": AeSetTextContentArgs(
            target={"composition_id": "42", "layer_index": 3, "expected_name": "Text"},
            text="changed",
            idempotency_key=KEY,
        ),
        "ae.setTextCharacterStyle": style,
        "ae.setTextParagraphStyle": AeSetTextParagraphStyleArgs(
            target={"composition_id": "42", "layer_index": 3, "expected_name": "Text"},
            style={"justification": "center"},
            idempotency_key=KEY,
        ),
    }
    for tool, args in cases.items():
        source, metadata = render_text_tool(tool, args)
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
async def test_typed_execution_binds_template_audit_postcondition_and_replay(
    monkeypatch, tmp_path
):
    clear_replay_cache_for_tests()
    monkeypatch.setenv("AE_MCP_TEXT_AUDIT_PATH", str(tmp_path / "audit.jsonl"))
    monkeypatch.setenv("AE_MCP_SOURCE_COMMIT_SHA", "a" * 40)
    before = snapshot("before 😀")
    after = snapshot("after 中")
    result = {
        "ok": True,
        "value": {
            "changed": True,
            "target": before["target"],
            "before": before,
            "after": after,
        },
    }
    backend = Backend(result)
    args = AeSetTextContentArgs(
        target=TARGET,
        text="after 中",
        idempotency_key=KEY,
    )
    response = await execute_text_tool(
        backend, tool="ae.setTextContent", args=args
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
        backend, tool="ae.setTextContent", args=args
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
    before = snapshot("before")
    after = snapshot("one")
    backend = Backend(
        {
            "ok": True,
            "value": {
                "changed": True,
                "target": before["target"],
                "before": before,
                "after": after,
            },
        }
    )
    first = AeSetTextContentArgs(target=TARGET, text="one", idempotency_key=KEY)
    assert (await execute_text_tool(
        backend, tool="ae.setTextContent", args=first
    ))["ok"]
    second = AeSetTextContentArgs(target=TARGET, text="two", idempotency_key=KEY)
    rejected = await execute_text_tool(
        backend, tool="ae.setTextContent", args=second
    )
    assert rejected["error"]["code"] == "DUPLICATE_REQUEST"
    assert rejected["error"]["sideEffect"] == "not-started"
    assert len(backend.calls) == 1
