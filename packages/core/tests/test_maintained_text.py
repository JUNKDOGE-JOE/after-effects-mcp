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


def test_source_commit_uses_selected_managed_runtime_without_git_or_env(
    monkeypatch, tmp_path
):
    managed_home = tmp_path / ".ae-mcp"
    relative = "generations/g-0123456789abcdef"
    generation = managed_home / "runtime" / relative
    runtime = generation / "runtime"
    module = (
        runtime
        / "python/lib/python3.13/site-packages/ae_mcp/backends/maintained_text.py"
    )
    module.parent.mkdir(parents=True)
    module.write_text("# installed fixture\n", encoding="utf-8")
    (managed_home / "runtime/current").write_text(
        f"{relative}\n", encoding="utf-8"
    )
    (generation / "install-record.json").write_text(
        json.dumps(
            {
                "schemaVersion": 2,
                "owner": "ae-mcp-runtime-manager",
                "generationId": "g-0123456789abcdef",
                "relative": relative,
                "sourceCommitSha": "c" * 40,
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("AE_MCP_HOME", str(managed_home))
    monkeypatch.delenv("AE_MCP_SOURCE_COMMIT_SHA", raising=False)
    monkeypatch.setattr(maintained_text, "__file__", str(module))

    def unexpected_git(*_args, **_kwargs):
        raise AssertionError("managed runtime provenance must not consult Git")

    monkeypatch.setattr(maintained_text.subprocess, "run", unexpected_git)

    assert maintained_text._source_commit() == "c" * 40


def test_source_commit_rejects_receipt_for_a_different_runtime(
    monkeypatch, tmp_path
):
    managed_home = tmp_path / ".ae-mcp"
    relative = "generations/g-0123456789abcdef"
    generation = managed_home / "runtime" / relative
    (generation / "runtime").mkdir(parents=True)
    (managed_home / "runtime/current").write_text(
        f"{relative}\n", encoding="utf-8"
    )
    (generation / "install-record.json").write_text(
        json.dumps(
            {
                "schemaVersion": 2,
                "owner": "ae-mcp-runtime-manager",
                "generationId": "g-0123456789abcdef",
                "relative": relative,
                "sourceCommitSha": "c" * 40,
            }
        ),
        encoding="utf-8",
    )
    outside_module = tmp_path / "other/ae_mcp/backends/maintained_text.py"
    outside_module.parent.mkdir(parents=True)
    outside_module.write_text("# wrong runtime\n", encoding="utf-8")
    monkeypatch.setenv("AE_MCP_HOME", str(managed_home))
    monkeypatch.delenv("AE_MCP_SOURCE_COMMIT_SHA", raising=False)
    monkeypatch.setattr(maintained_text, "__file__", str(outside_module))

    def missing_git(*_args, **_kwargs):
        raise OSError("git unavailable")

    monkeypatch.setattr(maintained_text.subprocess, "run", missing_git)

    with pytest.raises(
        RuntimeError, match="requires AE_MCP_SOURCE_COMMIT_SHA"
    ):
        maintained_text._source_commit()


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
