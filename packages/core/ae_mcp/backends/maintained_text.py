"""Typed maintained-JSX execution contract for frozen text authoring."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import subprocess
import time
import uuid
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Annotated, Any, Literal, Mapping

from pydantic import Field, StrictBool, StrictInt, StrictStr, model_validator

from ae_mcp import schemas_tsm
from ae_mcp.backends.native import DecimalString, NonNegativeInt, PositiveInt, _NativeModel
from ae_mcp.jsx_prelude import with_prelude
from ae_mcp.jsx_result import parse_jsx_result


TEMPLATES = Path(__file__).resolve().parent.parent / "jsx_templates"
COMMON_TEMPLATE = "text_common.jsx"
AUDIT_ENV = "AE_MCP_TEXT_AUDIT_PATH"
SOURCE_COMMIT_ENV = "AE_MCP_SOURCE_COMMIT_SHA"

TEXT_TOOLS = {
    "ae.listInstalledFonts": (
        "aemcp.text.fonts.list.v1",
        "text_fonts_list.jsx",
        False,
    ),
    "ae.createTextLayer": (
        "aemcp.text.layer.create.v1",
        "text_layer_create.jsx",
        True,
    ),
    "ae.getTextDocument": (
        "aemcp.text.document.read.v1",
        "text_document_read.jsx",
        False,
    ),
    "ae.setTextContent": (
        "aemcp.text.content.set.v1",
        "text_content_set.jsx",
        True,
    ),
    "ae.setTextCharacterStyle": (
        "aemcp.text.character-style.set.v1",
        "text_character_style_set.jsx",
        True,
    ),
    "ae.setTextParagraphStyle": (
        "aemcp.text.paragraph-style.set.v1",
        "text_paragraph_style_set.jsx",
        True,
    ),
}


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def digest(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def _source_commit() -> str:
    configured = os.environ.get(SOURCE_COMMIT_ENV, "")
    if len(configured) == 40 and all(character in "0123456789abcdef" for character in configured):
        return configured
    try:
        resolved = subprocess.run(
            ["git", "rev-parse", "--verify", "HEAD"],
            cwd=TEMPLATES,
            check=True,
            capture_output=True,
            text=True,
            timeout=2,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        resolved = ""
    if len(resolved) != 40 or any(character not in "0123456789abcdef" for character in resolved):
        raise RuntimeError(
            "maintained JSX provenance requires AE_MCP_SOURCE_COMMIT_SHA"
        )
    return resolved


def _core_version() -> str:
    try:
        return version("ae-mcp")
    except PackageNotFoundError:
        from ae_mcp import __version__

        return __version__


class Color8(_NativeModel):
    red: Annotated[StrictInt, Field(ge=0, le=255)]
    green: Annotated[StrictInt, Field(ge=0, le=255)]
    blue: Annotated[StrictInt, Field(ge=0, le=255)]
    alpha: Literal[255]


class FontRecord(_NativeModel):
    post_script_name: Annotated[StrictStr, Field(min_length=1, max_length=255)]
    family: Annotated[StrictStr, Field(min_length=1, max_length=255)]
    style: Annotated[StrictStr, Field(max_length=255)]


class FontPage(_NativeModel):
    total: NonNegativeInt
    offset: NonNegativeInt
    limit: Annotated[StrictInt, Field(ge=1, le=100)]
    returned: Annotated[StrictInt, Field(ge=0, le=100)]
    has_more: StrictBool
    next_offset: NonNegativeInt | None
    fonts: tuple[FontRecord, ...] = Field(max_length=100)

    @model_validator(mode="after")
    def valid_page(self) -> "FontPage":
        consumed = self.offset + self.returned
        expected_more = consumed < self.total
        if (
            self.returned != len(self.fonts)
            or self.returned > self.limit
            or consumed > self.total
            or self.has_more is not expected_more
            or self.next_offset != (consumed if expected_more else None)
        ):
            raise ValueError("font page metadata is inconsistent")
        keys = [
            (font.post_script_name, font.family, font.style) for font in self.fonts
        ]
        if keys != sorted(keys) or len({key[0] for key in keys}) != len(keys):
            raise ValueError("font page must be sorted with unique PostScript names")
        return self


class SnapshotTarget(_NativeModel):
    composition_id: Annotated[StrictStr, Field(pattern=r"^[1-9][0-9]*$")]
    layer_index: PositiveInt
    expected_name: Annotated[StrictStr, Field(min_length=1, max_length=255)]


class CharacterStyle(_NativeModel):
    font_post_script_name: Annotated[StrictStr, Field(min_length=1, max_length=255)]
    font_size_pixels: DecimalString
    fill_color: Color8
    stroke_color: Color8
    stroke_width_pixels: DecimalString
    stroke_over_fill: StrictBool
    tracking: Annotated[StrictInt, Field(ge=-10_000, le=10_000)]
    auto_leading: StrictBool
    leading_pixels: DecimalString | None
    faux_bold: StrictBool
    faux_italic: StrictBool

    @model_validator(mode="after")
    def leading_contract(self) -> "CharacterStyle":
        if self.auto_leading != (self.leading_pixels is None):
            raise ValueError("autoLeading and leadingPixels are inconsistent")
        for field, low, high, exclusive in (
            ("font_size_pixels", 0, 1296, True),
            ("stroke_width_pixels", 0, 1000, False),
        ):
            schemas_tsm.bounded_decimal(
                getattr(self, field),
                field=field,
                minimum=schemas_tsm.Decimal(low),
                maximum=schemas_tsm.Decimal(high),
                exclusive_minimum=exclusive,
            )
        if self.leading_pixels is not None:
            schemas_tsm.bounded_decimal(
                self.leading_pixels,
                field="leading_pixels",
                minimum=schemas_tsm.Decimal(0),
                maximum=schemas_tsm.Decimal(12_960),
                exclusive_minimum=True,
            )
        return self


class ParagraphStyle(_NativeModel):
    justification: Literal[
        "left",
        "right",
        "center",
        "full-last-left",
        "full-last-right",
        "full-last-center",
        "full-last-full",
    ]
    first_line_indent_pixels: DecimalString
    start_indent_pixels: DecimalString
    end_indent_pixels: DecimalString
    space_before_pixels: DecimalString
    space_after_pixels: DecimalString

    @model_validator(mode="after")
    def decimal_ranges(self) -> "ParagraphStyle":
        for field in (
            "first_line_indent_pixels",
            "start_indent_pixels",
            "end_indent_pixels",
            "space_before_pixels",
            "space_after_pixels",
        ):
            schemas_tsm.bounded_decimal(
                getattr(self, field),
                field=field,
                minimum=schemas_tsm.Decimal(-30_000),
                maximum=schemas_tsm.Decimal(30_000),
            )
        return self


class ResolvedFont(_NativeModel):
    requested_post_script_name: Annotated[
        StrictStr, Field(min_length=1, max_length=255)
    ] | None
    selected_post_script_name: Annotated[
        StrictStr, Field(min_length=1, max_length=255)
    ]
    used_fallback: StrictBool


class BoxSize(_NativeModel):
    width_pixels: DecimalString
    height_pixels: DecimalString


class TextDocumentSnapshot(_NativeModel):
    target: SnapshotTarget
    text: Annotated[StrictStr, Field(max_length=32_767)]
    text_kind: Literal["point", "box"]
    box_size: BoxSize | None
    character_style: CharacterStyle
    paragraph_style: ParagraphStyle
    resolved_font: ResolvedFont

    @model_validator(mode="after")
    def snapshot_contract(self) -> "TextDocumentSnapshot":
        schemas_tsm.unicode_scalars(self.text, field="text", maximum=32_767)
        if (self.text_kind == "box") != (self.box_size is not None):
            raise ValueError("textKind and boxSize are inconsistent")
        if (
            self.resolved_font.selected_post_script_name
            != self.character_style.font_post_script_name
        ):
            raise ValueError("resolvedFont does not match characterStyle font")
        if self.resolved_font.requested_post_script_name is None and self.resolved_font.used_fallback:
            raise ValueError("font fallback requires a requested PostScript name")
        return self


class TextCreateValue(_NativeModel):
    changed: Literal[True]
    layer_count_before: NonNegativeInt
    layer_count_after: PositiveInt
    before: None
    after: TextDocumentSnapshot

    @model_validator(mode="after")
    def count_contract(self) -> "TextCreateValue":
        if self.layer_count_after != self.layer_count_before + 1:
            raise ValueError("text layer count did not increase by one")
        return self


class TextSetValue(_NativeModel):
    changed: Literal[True]
    target: SnapshotTarget
    before: TextDocumentSnapshot
    after: TextDocumentSnapshot

    @model_validator(mode="after")
    def stable_target(self) -> "TextSetValue":
        if (
            self.target != self.before.target
            or self.target != self.after.target
        ):
            raise ValueError("text setter target changed")
        return self


VALUE_MODELS = {
    "ae.listInstalledFonts": FontPage,
    "ae.createTextLayer": TextCreateValue,
    "ae.getTextDocument": TextDocumentSnapshot,
    "ae.setTextContent": TextSetValue,
    "ae.setTextCharacterStyle": TextSetValue,
    "ae.setTextParagraphStyle": TextSetValue,
}


def _assert_setter_projection(tool: str, args: Any, value: TextSetValue) -> None:
    before = value.before.model_dump(mode="json", by_alias=True)
    after = value.after.model_dump(mode="json", by_alias=True)
    if tool == "ae.setTextContent":
        expected = json.loads(json.dumps(before))
        expected["text"] = args.text
    elif tool == "ae.setTextCharacterStyle":
        expected = json.loads(json.dumps(before))
        style = args.style.model_dump(mode="json", exclude_none=True)
        mapping = {
            "font_size_pixels": "fontSizePixels",
            "fill_color": "fillColor",
            "stroke_color": "strokeColor",
            "stroke_width_pixels": "strokeWidthPixels",
            "stroke_over_fill": "strokeOverFill",
            "tracking": "tracking",
            "auto_leading": "autoLeading",
            "leading_pixels": "leadingPixels",
            "faux_bold": "fauxBold",
            "faux_italic": "fauxItalic",
        }
        for source, target in mapping.items():
            if source in style:
                expected["characterStyle"][target] = style[source]
        font = style.get("font")
        if font is not None:
            attempted = [
                font["preferred_postscript_name"],
                *font["fallback_postscript_names"],
            ]
            selected = after["resolvedFont"]["selectedPostScriptName"]
            if selected not in attempted:
                raise ValueError("resolved font was not one of the requested choices")
            expected["characterStyle"]["fontPostScriptName"] = selected
            expected["resolvedFont"] = after["resolvedFont"]
    else:
        expected = json.loads(json.dumps(before))
        style = args.style.model_dump(mode="json", exclude_none=True)
        mapping = {
            "justification": "justification",
            "first_line_indent_pixels": "firstLineIndentPixels",
            "start_indent_pixels": "startIndentPixels",
            "end_indent_pixels": "endIndentPixels",
            "space_before_pixels": "spaceBeforePixels",
            "space_after_pixels": "spaceAfterPixels",
        }
        for source, target in mapping.items():
            if source in style:
                expected["paragraphStyle"][target] = style[source]
    if expected == before:
        raise ValueError("text write is a no-op")
    if expected != after:
        raise ValueError(
            "text write readback differs from the requested projection: "
            + json.dumps({"expected": expected, "actual": after}, ensure_ascii=False)
        )


def render_text_tool(tool: str, args: Any, *, undo_group: str | None = None) -> tuple[str, dict[str, str]]:
    if tool not in TEXT_TOOLS:
        raise ValueError(f"unknown maintained text tool: {tool}")
    template_id, operation_file, write = TEXT_TOOLS[tool]
    common = (TEMPLATES / COMMON_TEMPLATE).read_text(encoding="utf-8")
    operation = (TEMPLATES / operation_file).read_text(encoding="utf-8")
    request = args.model_dump(mode="json", by_alias=False)
    request["operation"] = tool
    if write:
        request["undo_group"] = undo_group or f"MCP {tool}"
    # ensure_ascii=True is deliberate: U+2028/U+2029 and astral scalars become
    # JSON escapes/surrogate pairs and can never terminate a JSX string literal.
    request_literal = json.dumps(
        request, ensure_ascii=True, separators=(",", ":"), sort_keys=True
    )
    body = common.replace("__AEMCP_TEXT_REQUEST__", request_literal).replace(
        "__AEMCP_TEXT_BODY__", operation
    )
    if "__AEMCP_TEXT_" in body:
        raise RuntimeError("maintained text template contains an unresolved placeholder")
    template_bytes = common.encode("utf-8") + b"\0" + operation.encode("utf-8")
    return with_prelude(body), {
        "templateId": template_id,
        "templateDigest": hashlib.sha256(template_bytes).hexdigest(),
    }


def _audit_path() -> Path:
    configured = os.environ.get(AUDIT_ENV)
    if configured:
        return Path(configured)
    return (
        Path.home()
        / "Library"
        / "Application Support"
        / "AfterEffectsMCP"
        / "text-authoring-v1"
        / "audit.jsonl"
    )


def _append_audit(record: Mapping[str, Any]) -> None:
    path = _audit_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    line = canonical_bytes(record) + b"\n"
    descriptor = os.open(path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
    try:
        os.write(descriptor, line)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


_REPLAY_LOCK = asyncio.Lock()
_REPLAY: dict[str, tuple[str, dict[str, Any]]] = {}
_KEY_LOCKS: dict[str, asyncio.Lock] = {}


async def _execute_text_tool_serialized(
    backend: Any,
    *,
    tool: str,
    args: Any,
) -> dict[str, Any]:
    template_id, _operation_file, write = TEXT_TOOLS[tool]
    request_payload = args.model_dump(mode="json", by_alias=False)
    request_digest = digest({"tool": tool, "arguments": request_payload})
    idempotency_key = getattr(args, "idempotency_key", None)
    if write:
        async with _REPLAY_LOCK:
            replay = _REPLAY.get(idempotency_key)
            if replay is not None:
                prior_digest, prior_response = replay
                if prior_digest != request_digest:
                    return {
                        "ok": False,
                        "error": {
                            "code": "DUPLICATE_REQUEST",
                            "message": "idempotency key is already bound to different arguments",
                            "retryable": False,
                            "sideEffect": "not-started",
                            "recovery": {
                                "action": "use-original-request",
                                "hint": "Reuse this key only for the original business intent.",
                            },
                            "details": {"idempotencyKey": idempotency_key},
                        },
                    }
                response = json.loads(json.dumps(prior_response))
                response["replayed"] = True
                response["audit"]["replayed"] = True
                return response

    request_id = f"mcp-{uuid.uuid4().hex}"
    group_id = f"text-{request_id}"
    source_commit = _source_commit()
    jsx, template = render_text_tool(tool, args, undo_group=group_id)
    input_schema = type(args).model_json_schema()
    value_schema = VALUE_MODELS[tool].model_json_schema(by_alias=True)
    contract_digest = digest(
        {"inputSchema": input_schema, "valueSchema": value_schema}
    )
    started = int(time.time() * 1000)
    raw = await backend.exec(code=jsx, timeout_sec=30.0)
    completed = int(time.time() * 1000)
    parsed = parse_jsx_result(raw)
    if not isinstance(parsed, dict) or parsed.get("ok") is not True:
        if isinstance(parsed, dict) and parsed.get("ok") is False:
            return parsed
        return {
            "ok": False,
            "error": {
                "code": "TEXT_CONTRACT_MISMATCH",
                "message": "maintained text template returned a malformed result",
                "retryable": False,
                "sideEffect": "may-have-occurred" if write else "not-started",
                "recovery": {
                    "action": "inspect-state" if write else "inspect-contract",
                    "hint": "Inspect AE text state and the maintained template result.",
                },
            },
        }
    value = VALUE_MODELS[tool].model_validate(parsed.get("value"))
    if tool.startswith("ae.setText"):
        _assert_setter_projection(tool, args, value)
    wire_value = value.model_dump(mode="json", by_alias=True)
    postcondition_digest = digest(
        {"tool": tool, "contractVersion": 1, "value": wire_value}
    )
    mutability = "mutating" if write else "read-only"
    audit = {
        "requestId": request_id,
        "contractId": template_id,
        "contractDigest": contract_digest,
        "effect": "committed" if write else "none",
        "requestDigest": request_digest,
        "postconditionAlgorithm": "sha256-rfc8785-jcs-v1",
        "postconditionDigest": postcondition_digest,
        "startedAtUnixMs": started,
        "completedAtUnixMs": completed,
    }
    if write:
        audit.update(
            {
                "idempotencyKey": idempotency_key,
                "replayed": False,
                "undoAvailable": True,
                "undoVerified": False,
            }
        )
    response: dict[str, Any] = {
        "ok": True,
        **({"replayed": False} if write else {}),
        "value": wire_value,
        "implementation": {
            "engine": "maintained-jsx",
            "contractId": template_id,
            "contractVersion": 1,
            "contractDigest": contract_digest,
            "templateId": template["templateId"],
            "templateDigest": template["templateDigest"],
            "mutability": mutability,
            **(
                {
                    "idempotency": "idempotency-key",
                    "undo": "ae-undo-group",
                }
                if write
                else {}
            ),
            "callerCodeAccepted": False,
        },
        "provenance": {
            "engine": "maintained-jsx",
            "sourceCommit": source_commit,
            "coreVersion": _core_version(),
            "templateId": template["templateId"],
            "templateDigest": template["templateDigest"],
            "callerCodeAccepted": False,
        },
        "audit": audit,
        "evidence": {
            "postcondition": {
                "verified": True,
                "kind": tool.removeprefix("ae.").replace(".", "-"),
                "algorithm": "sha256-rfc8785-jcs-v1",
                "digest": postcondition_digest,
            },
            **(
                {
                    "undo": {
                        "available": True,
                        "verified": False,
                        "groupId": group_id,
                    }
                }
                if write
                else {}
            ),
        },
    }
    _append_audit(
        {
            "requestId": request_id,
            "tool": tool,
            "requestDigest": request_digest,
            "contractDigest": contract_digest,
            "templateDigest": template["templateDigest"],
            "postconditionDigest": postcondition_digest,
            "effect": audit["effect"],
            "startedAtUnixMs": started,
            "completedAtUnixMs": completed,
        }
    )
    if write:
        async with _REPLAY_LOCK:
            existing = _REPLAY.get(idempotency_key)
            if existing is not None and existing[0] != request_digest:
                raise RuntimeError("idempotency key was concurrently rebound")
            _REPLAY[idempotency_key] = (request_digest, response)
    return response


async def execute_text_tool(
    backend: Any,
    *,
    tool: str,
    args: Any,
) -> dict[str, Any]:
    write = TEXT_TOOLS[tool][2]
    if not write:
        return await _execute_text_tool_serialized(backend, tool=tool, args=args)
    key = args.idempotency_key
    async with _REPLAY_LOCK:
        key_lock = _KEY_LOCKS.setdefault(key, asyncio.Lock())
    async with key_lock:
        return await _execute_text_tool_serialized(backend, tool=tool, args=args)


def clear_replay_cache_for_tests() -> None:
    _REPLAY.clear()
    _KEY_LOCKS.clear()


__all__ = [
    "TEXT_TOOLS",
    "VALUE_MODELS",
    "clear_replay_cache_for_tests",
    "execute_text_tool",
    "render_text_tool",
]
