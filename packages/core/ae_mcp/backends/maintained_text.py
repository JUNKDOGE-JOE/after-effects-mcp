"""Typed maintained-JSX execution contract for frozen text authoring."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import stat
import subprocess
import time
import uuid
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Annotated, Any, Literal, Mapping

from pydantic import Field, StrictBool, StrictInt, StrictStr, model_validator

from ae_mcp import schemas_tsm
from ae_mcp.backends.native import (
    DecimalString,
    NativeCancellationToken,
    NativeInvokeBackend,
    NativeLocator,
    NonNegativeInt,
    PositiveInt,
    _NativeModel,
    invoke_composition_layers_list,
    invoke_project_items_list,
)
from ae_mcp.jsx_prelude import with_prelude
from ae_mcp.jsx_result import parse_jsx_result


TEMPLATES = Path(__file__).resolve().parent.parent / "jsx_templates"
COMMON_TEMPLATE = "text_common.jsx"
AUDIT_ENV = "AE_MCP_TEXT_AUDIT_PATH"
SOURCE_COMMIT_ENV = "AE_MCP_SOURCE_COMMIT_SHA"
RUNTIME_HOME_ENV = "AE_MCP_HOME"
SOURCE_SHA_LENGTH = 40
MAX_RUNTIME_POINTER_BYTES = 1024
MAX_INSTALL_RECORD_BYTES = 64 * 1024

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


def _valid_source_commit(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == SOURCE_SHA_LENGTH
        and all(character in "0123456789abcdef" for character in value)
    )


def _ordinary_bounded_file(path: Path, maximum_bytes: int) -> bytes | None:
    try:
        info = path.lstat()
    except OSError:
        return None
    if (
        path.is_symlink()
        or not stat.S_ISREG(info.st_mode)
        or info.st_size <= 0
        or info.st_size > maximum_bytes
    ):
        return None
    try:
        payload = path.read_bytes()
    except OSError:
        return None
    return payload if len(payload) == info.st_size else None


def _managed_source_commit() -> str | None:
    configured_home = os.environ.get(RUNTIME_HOME_ENV)
    base = Path(configured_home) if configured_home else Path.home() / ".ae-mcp"
    runtime_base = base / "runtime"
    pointer_bytes = _ordinary_bounded_file(
        runtime_base / "current", MAX_RUNTIME_POINTER_BYTES
    )
    if pointer_bytes is None:
        return None
    try:
        relative = pointer_bytes.decode("utf-8").strip()
    except UnicodeDecodeError:
        return None
    parts = relative.split("/")
    portable = (
        len(parts) == 2
        and all(part and part not in {".", ".."} for part in parts)
        and "\\" not in relative
        and "\x00" not in relative
    )
    generation_id = parts[1] if portable and parts[0] == "generations" else ""
    is_generation = (
        len(generation_id) == 18
        and generation_id.startswith("g-")
        and all(character in "0123456789abcdef" for character in generation_id[2:])
    )
    is_legacy = portable and parts[1] in {"macos-arm64", "windows-x64"}
    if not is_generation and not is_legacy:
        return None

    generation_root = (
        runtime_base / relative
        if is_generation
        else runtime_base / parts[0]
    )
    if (
        generation_root == runtime_base
        or not generation_root.is_relative_to(runtime_base)
    ):
        return None

    record_bytes = _ordinary_bounded_file(
        generation_root / "install-record.json", MAX_INSTALL_RECORD_BYTES
    )
    if record_bytes is None:
        return None
    try:
        record = json.loads(record_bytes)
    except (UnicodeDecodeError, ValueError):
        return None
    if (
        not isinstance(record, dict)
        or record.get("relative") != relative
        or not _valid_source_commit(record.get("sourceCommitSha"))
    ):
        return None
    schema_version = record.get("schemaVersion")
    if schema_version == 2:
        if (
            record.get("owner") != "ae-mcp-runtime-manager"
            or not is_generation
            or record.get("generationId") != generation_id
        ):
            return None
    elif schema_version != 1 or not is_legacy:
        return None

    selected_runtime = (
        generation_root / "runtime"
        if is_generation
        else runtime_base / relative
    )
    try:
        Path(__file__).resolve(strict=True).relative_to(
            selected_runtime.resolve(strict=True)
        )
    except (OSError, ValueError):
        return None
    return record["sourceCommitSha"]


def _source_commit() -> str:
    managed = _managed_source_commit()
    if managed is not None:
        return managed
    configured = os.environ.get(SOURCE_COMMIT_ENV, "")
    if _valid_source_commit(configured):
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
    if not _valid_source_commit(resolved):
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


class ResolvedCompositionAddress(_NativeModel):
    project_item_index: PositiveInt
    expected_name: Annotated[StrictStr, Field(min_length=1, max_length=1024)]


class ResolvedTextAddress(ResolvedCompositionAddress):
    layer_index: PositiveInt
    expected_layer_name: Annotated[StrictStr, Field(min_length=1, max_length=1024)]


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
    layer_locator: NativeLocator
    text: Annotated[StrictStr, Field(max_length=32_767)]
    text_kind: Literal["point", "box"]
    box_size: BoxSize | None
    character_style: CharacterStyle
    paragraph_style: ParagraphStyle
    resolved_font: ResolvedFont

    @model_validator(mode="after")
    def snapshot_contract(self) -> "TextDocumentSnapshot":
        if self.layer_locator.kind != "layer":
            raise ValueError("text snapshot must carry a layer locator")
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
    composition_locator: NativeLocator
    layer_count_before: NonNegativeInt
    layer_count_after: PositiveInt
    before: None
    after: TextDocumentSnapshot

    @model_validator(mode="after")
    def count_contract(self) -> "TextCreateValue":
        if (
            self.composition_locator.kind != "composition"
            or self.after.layer_locator.context()
            != self.composition_locator.context()
            or self.layer_count_after != self.layer_count_before + 1
        ):
            raise ValueError("text layer count did not increase by one")
        return self


class TextSetValue(_NativeModel):
    changed: Literal[True]
    layer_locator: NativeLocator
    before: TextDocumentSnapshot
    after: TextDocumentSnapshot

    @model_validator(mode="after")
    def stable_target(self) -> "TextSetValue":
        if (
            self.layer_locator.kind != "layer"
            or self.layer_locator != self.before.layer_locator
            or self.layer_locator != self.after.layer_locator
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


def _native_locator(value: Any) -> NativeLocator:
    if hasattr(value, "model_dump"):
        value = value.model_dump(mode="json", by_alias=True)
    return NativeLocator.model_validate(value)


async def _project_compositions(
    backend: NativeInvokeBackend,
    *,
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken,
) -> list[tuple[int, Any]]:
    """Resolve public composition locators to ExtendScript project-item slots."""

    offset = 0
    project_locator: NativeLocator | None = None
    compositions: list[tuple[int, Any]] = []
    while True:
        execution = await invoke_project_items_list(
            backend,
            request_id=f"text-resolve-items-{uuid.uuid4().hex}",
            project_locator=project_locator,
            offset=offset,
            limit=50,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )
        page = execution.value
        if project_locator is None:
            project_locator = page.project_locator
        for row_index, item in enumerate(page.items):
            if item.type == "composition":
                compositions.append((page.offset + row_index + 1, item))
        if not page.has_more:
            return compositions
        if page.next_offset is None:
            raise RuntimeError("native project-item resolver omitted nextOffset")
        offset = page.next_offset


async def resolve_composition_address(
    backend: NativeInvokeBackend,
    locator: Any,
    *,
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken,
) -> ResolvedCompositionAddress:
    parsed = _native_locator(locator)
    if parsed.kind != "composition":
        raise ValueError("text composition locator must have kind composition")
    matches = [
        (project_item_index, item)
        for project_item_index, item in await _project_compositions(
            backend,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )
        if item.locator == parsed
    ]
    if len(matches) != 1:
        raise ValueError("STALE_LOCATOR:text composition locator did not resolve exactly once")
    project_item_index, item = matches[0]
    return ResolvedCompositionAddress(
        project_item_index=project_item_index,
        expected_name=item.name,
    )


async def _composition_layer_rows(
    backend: NativeInvokeBackend,
    composition_locator: NativeLocator,
    *,
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken,
) -> list[Any]:
    offset = 0
    rows: list[Any] = []
    while True:
        execution = await invoke_composition_layers_list(
            backend,
            request_id=f"text-resolve-layers-{uuid.uuid4().hex}",
            composition_locator=composition_locator,
            offset=offset,
            limit=50,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )
        page = execution.value
        rows.extend(page.layers)
        if not page.has_more:
            return rows
        if page.next_offset is None:
            raise RuntimeError("native composition-layer resolver omitted nextOffset")
        offset = page.next_offset


async def resolve_text_address(
    backend: NativeInvokeBackend,
    locator: Any,
    *,
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken,
) -> ResolvedTextAddress:
    """Resolve one opaque public layer locator without exposing JSX coordinates."""

    parsed = _native_locator(locator)
    if parsed.kind != "layer":
        raise ValueError("text layer locator must have kind layer")
    matches: list[ResolvedTextAddress] = []
    for project_item_index, item in await _project_compositions(
        backend,
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    ):
        if item.locator.context() != parsed.context():
            continue
        for layer in await _composition_layer_rows(
            backend,
            item.locator,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        ):
            if layer.locator == parsed:
                matches.append(
                    ResolvedTextAddress(
                        project_item_index=project_item_index,
                        expected_name=item.name,
                        layer_index=layer.stack_index,
                        expected_layer_name=layer.name,
                    )
                )
    if len(matches) != 1:
        raise ValueError("STALE_LOCATOR:text layer locator did not resolve exactly once")
    return matches[0]


async def _reacquire_created_text_layer(
    backend: NativeInvokeBackend,
    address: ResolvedTextAddress,
    *,
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken,
) -> tuple[NativeLocator, NativeLocator]:
    compositions = await _project_compositions(
        backend,
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    matches = [
        item
        for project_item_index, item in compositions
        if project_item_index == address.project_item_index
        and item.name == address.expected_name
    ]
    if len(matches) != 1:
        raise RuntimeError("created text layer composition could not be reacquired")
    layer_matches = [
        layer.locator
        for layer in await _composition_layer_rows(
            backend,
            matches[0].locator,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )
        if layer.stack_index == address.layer_index
        and layer.name == address.expected_layer_name
        and layer.type == "text"
    ]
    if len(layer_matches) != 1:
        raise RuntimeError("created text layer could not be reacquired exactly once")
    return matches[0].locator, layer_matches[0]


def _translate_snapshot(
    value: Mapping[str, Any],
    *,
    address: ResolvedTextAddress,
    layer_locator: NativeLocator,
) -> dict[str, Any]:
    snapshot = dict(value)
    observed = ResolvedTextAddress.model_validate(snapshot.pop("_address", None))
    if observed != address:
        raise ValueError("maintained text result addressed a different layer")
    snapshot["layerLocator"] = layer_locator.model_dump(mode="json", by_alias=True)
    return snapshot


def _translate_text_value(
    tool: str,
    value: Mapping[str, Any],
    *,
    address: ResolvedTextAddress,
    layer_locator: NativeLocator,
    composition_locator: NativeLocator | None = None,
) -> dict[str, Any]:
    translated = dict(value)
    if tool == "ae.createTextLayer":
        if composition_locator is None or composition_locator.kind != "composition":
            raise ValueError("text create result omitted its composition locator")
        translated["compositionLocator"] = composition_locator.model_dump(
            mode="json", by_alias=True
        )
        translated["after"] = _translate_snapshot(
            translated["after"], address=address, layer_locator=layer_locator
        )
    elif tool == "ae.getTextDocument":
        translated = _translate_snapshot(
            translated, address=address, layer_locator=layer_locator
        )
    else:
        observed = ResolvedTextAddress.model_validate(translated.pop("_address", None))
        if observed != address:
            raise ValueError("maintained text setter changed its target")
        translated["layerLocator"] = layer_locator.model_dump(
            mode="json", by_alias=True
        )
        translated["before"] = _translate_snapshot(
            translated["before"], address=address, layer_locator=layer_locator
        )
        translated["after"] = _translate_snapshot(
            translated["after"], address=address, layer_locator=layer_locator
        )
    return translated


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


def render_text_tool(
    tool: str,
    args: Any,
    *,
    resolved_address: ResolvedCompositionAddress | ResolvedTextAddress | None = None,
    undo_group: str | None = None,
) -> tuple[str, dict[str, str]]:
    if tool not in TEXT_TOOLS:
        raise ValueError(f"unknown maintained text tool: {tool}")
    template_id, operation_file, write = TEXT_TOOLS[tool]
    common = (TEMPLATES / COMMON_TEMPLATE).read_text(encoding="utf-8")
    operation = (TEMPLATES / operation_file).read_text(encoding="utf-8")
    request = args.model_dump(mode="json", by_alias=False)
    if tool == "ae.createTextLayer":
        if not isinstance(resolved_address, ResolvedCompositionAddress):
            raise ValueError("createTextLayer requires an internally resolved composition")
        request.pop("composition_locator")
        request["_resolved"] = resolved_address.model_dump(
            mode="json", by_alias=False
        )
    elif tool != "ae.listInstalledFonts":
        if not isinstance(resolved_address, ResolvedTextAddress):
            raise ValueError(f"{tool} requires an internally resolved text layer")
        request.pop("layer_locator")
        request["_resolved"] = resolved_address.model_dump(
            mode="json", by_alias=False
        )
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
    native_backend: NativeInvokeBackend | None,
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
    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + 30_000
    resolved_address: ResolvedCompositionAddress | ResolvedTextAddress | None = None
    input_layer_locator: NativeLocator | None = None
    if tool == "ae.createTextLayer":
        if native_backend is None:
            raise RuntimeError("text locator resolution requires the native AEGP plane")
        resolved_address = await resolve_composition_address(
            native_backend,
            args.composition_locator,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )
    elif tool != "ae.listInstalledFonts":
        if native_backend is None:
            raise RuntimeError("text locator resolution requires the native AEGP plane")
        input_layer_locator = _native_locator(args.layer_locator)
        resolved_address = await resolve_text_address(
            native_backend,
            input_layer_locator,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )
    jsx, template = render_text_tool(
        tool,
        args,
        resolved_address=resolved_address,
        undo_group=group_id,
    )
    input_schema = type(args).model_json_schema()
    value_schema = VALUE_MODELS[tool].model_json_schema(by_alias=True)
    contract_digest = digest(
        {"inputSchema": input_schema, "valueSchema": value_schema}
    )
    started = int(time.time() * 1000)
    raw = await backend.exec(
        code=jsx,
        timeout_sec=30.0,
        native_project_graph_effect="invalidate" if write else "preserve",
    )
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
    raw_value = parsed.get("value")
    if tool == "ae.createTextLayer":
        if not isinstance(raw_value, Mapping) or not isinstance(
            raw_value.get("after"), Mapping
        ):
            raise ValueError("maintained text create omitted its after snapshot")
        internal_address = ResolvedTextAddress.model_validate(
            raw_value["after"].get("_address")
        )
        if not isinstance(resolved_address, ResolvedCompositionAddress) or (
            internal_address.project_item_index
            != resolved_address.project_item_index
            or internal_address.expected_name != resolved_address.expected_name
        ):
            raise ValueError("maintained text create escaped its composition")
        if native_backend is None:
            raise RuntimeError("text locator reacquisition requires the native AEGP plane")
        output_composition_locator, output_layer_locator = (
            await _reacquire_created_text_layer(
                native_backend,
                internal_address,
                deadline_unix_ms=deadline_unix_ms,
                cancellation=cancellation,
            )
        )
        raw_value = _translate_text_value(
            tool,
            raw_value,
            address=internal_address,
            layer_locator=output_layer_locator,
            composition_locator=output_composition_locator,
        )
    elif tool != "ae.listInstalledFonts":
        if (
            not isinstance(raw_value, Mapping)
            or not isinstance(resolved_address, ResolvedTextAddress)
            or input_layer_locator is None
        ):
            raise ValueError("maintained text result omitted its resolved target")
        output_layer_locator = input_layer_locator
        if write:
            if native_backend is None:
                raise RuntimeError(
                    "text locator reacquisition requires the native AEGP plane"
                )
            _output_composition_locator, output_layer_locator = (
                await _reacquire_created_text_layer(
                    native_backend,
                    resolved_address,
                    deadline_unix_ms=deadline_unix_ms,
                    cancellation=cancellation,
                )
            )
        raw_value = _translate_text_value(
            tool,
            raw_value,
            address=resolved_address,
            layer_locator=output_layer_locator,
        )
    value = VALUE_MODELS[tool].model_validate(raw_value)
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
    native_backend: NativeInvokeBackend | None = None,
    *,
    tool: str,
    args: Any,
) -> dict[str, Any]:
    write = TEXT_TOOLS[tool][2]
    if not write:
        return await _execute_text_tool_serialized(
            backend, native_backend, tool=tool, args=args
        )
    key = args.idempotency_key
    async with _REPLAY_LOCK:
        key_lock = _KEY_LOCKS.setdefault(key, asyncio.Lock())
    async with key_lock:
        return await _execute_text_tool_serialized(
            backend, native_backend, tool=tool, args=args
        )


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
