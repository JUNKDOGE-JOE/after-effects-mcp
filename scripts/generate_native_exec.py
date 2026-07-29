#!/usr/bin/env python3
"""Validate the frozen metadata for the ae_exec / ae_nativeExec migration."""

from __future__ import annotations

import argparse
import hashlib
import json
import pprint
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
CORE = ROOT / "packages" / "core"
if str(CORE) not in sys.path:
    sys.path.insert(0, str(CORE))

MIGRATION_DISPOSITIONS = frozenset({"JSX_EQUIVALENT", "NATIVE_PRIMITIVE"})
PUBLIC_TOOL_DISPOSITIONS = frozenset(
    {"REMOVE_TO_AE_EXEC", "REMOVE_TO_AE_NATIVE_EXEC", "KEEP_CONTROL_PLANE"}
)
WRITE_EVIDENCE_KEYS = frozenset({"before", "after", "changed", "undo"})


@dataclass(frozen=True)
class MigrationRow:
    id: str
    disposition: str
    reason: str
    replacement: tuple[str, ...]
    source: str


@dataclass(frozen=True)
class PublicToolRow:
    id: str
    disposition: str


@dataclass(frozen=True)
class MigrationManifest:
    native_capabilities: dict[str, MigrationRow]
    public_tools: dict[str, PublicToolRow]


@dataclass(frozen=True)
class PrimitiveRow:
    id: str
    order: int
    mutability: str
    required_suite: str
    reference_arguments: tuple[tuple[str, str, bool], ...]
    input_schema: dict[str, Any]
    result_schema: dict[str, Any]
    executor: str
    summary: str
    example: dict[str, Any]
    exportable: bool


@dataclass(frozen=True)
class PrimitiveRegistry:
    rows: tuple[PrimitiveRow, ...]


def _json_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"{path}: expected a JSON object")
    return value


def _rows(value: Any, label: str) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not all(isinstance(row, dict) for row in value):
        raise ValueError(f"{label}: expected an array of objects")
    return value


def _required_string(row: dict[str, Any], key: str, label: str) -> str:
    value = row.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label}: missing {key}")
    return value


def _replacement(value: Any, label: str) -> tuple[str, ...]:
    if isinstance(value, str):
        return (value,)
    if value and isinstance(value, list) and all(
        isinstance(item, str) and item for item in value
    ):
        return tuple(value)
    raise ValueError(f"{label}: replacement must be a non-empty string or string array")


def _unique(rows: list[dict[str, Any]], key: str, label: str) -> None:
    values = [_required_string(row, key, label) for row in rows]
    if len(values) != len(set(values)):
        raise ValueError(f"{label}: duplicate {key}")


def _is_closed_schema(schema: dict[str, Any], catalog_path: Path) -> bool:
    """Accept a closed inline schema or a closed local AEGP definition ref."""
    if "x-contract" in schema:
        return False
    if set(schema) != {"$ref"}:
        properties = schema.get("properties")
        required = schema.get("required")
        has_object_contract = isinstance(properties, dict) or isinstance(required, list)
        has_composition = any(
            isinstance(schema.get(key), list) and bool(schema[key])
            for key in ("allOf", "anyOf", "oneOf")
        )
        return (
            schema.get("type") == "object"
            and schema.get("additionalProperties") is False
            and (has_object_contract or has_composition)
        )
    reference = schema["$ref"]
    if not isinstance(reference, str) or "#/$defs/" not in reference:
        return False
    filename, definition = reference.split("#/$defs/", 1)
    target_path = catalog_path.parent / filename
    if not target_path.is_file() or not definition:
        return False
    target = _json_object(target_path).get("$defs", {}).get(definition)
    if not isinstance(target, dict):
        return False
    if "const" in target:
        target = target["const"]
    return isinstance(target, dict) and target.get("type") == "object" and target.get(
        "additionalProperties"
    ) is False


def load_migration_manifest(path: Path) -> MigrationManifest:
    data = _json_object(path)
    native_rows = _rows(data.get("nativeCapabilities"), "nativeCapabilities")
    public_rows = _rows(data.get("publicTools"), "publicTools")
    _unique(native_rows, "id", "nativeCapabilities")
    _unique(public_rows, "id", "publicTools")
    native: dict[str, MigrationRow] = {}
    for raw in native_rows:
        row_id = _required_string(raw, "id", "nativeCapabilities")
        disposition = _required_string(raw, "disposition", row_id)
        if disposition not in MIGRATION_DISPOSITIONS:
            raise ValueError(f"{row_id}: unknown disposition {disposition}")
        replacement = _replacement(raw.get("replacement"), row_id)
        if disposition == "JSX_EQUIVALENT" and replacement != ("ae_exec",):
            raise ValueError(f"{row_id}: JSX_EQUIVALENT must replace with ae_exec")
        native[row_id] = MigrationRow(
            id=row_id,
            disposition=disposition,
            reason=_required_string(raw, "reason", row_id),
            replacement=replacement,
            source=_required_string(raw, "source", row_id),
        )
    public: dict[str, PublicToolRow] = {}
    for raw in public_rows:
        row_id = _required_string(raw, "id", "publicTools")
        disposition = _required_string(raw, "disposition", row_id)
        if disposition not in PUBLIC_TOOL_DISPOSITIONS:
            raise ValueError(f"{row_id}: unknown public-tool disposition {disposition}")
        public[row_id] = PublicToolRow(row_id, disposition)
    return MigrationManifest(native, public)


def load_primitive_registry(path: Path) -> PrimitiveRegistry:
    data = _json_object(path)
    raw_rows = _rows(data.get("primitives"), "primitives")
    _unique(raw_rows, "id", "primitives")
    _unique(raw_rows, "executor", "primitives")
    rows: list[PrimitiveRow] = []
    for raw in raw_rows:
        row_id = _required_string(raw, "id", "primitives")
        order = raw.get("order")
        if not isinstance(order, int) or order < 1:
            raise ValueError(f"{row_id}: order must be a positive integer")
        mutability = _required_string(raw, "mutability", row_id)
        if mutability not in {"read", "write"}:
            raise ValueError(f"{row_id}: mutability must be read or write")
        raw_reference_arguments = raw.get("referenceArguments")
        if not isinstance(raw_reference_arguments, dict):
            raise ValueError(f"{row_id}: referenceArguments must be an object")
        value_kinds = {"CompositionHandle", "LayerHandle", "PropertyHandle"}
        normalized_reference_arguments: list[tuple[str, str, bool]] = []
        for name, raw_kind in raw_reference_arguments.items():
            required = True
            kind = raw_kind
            if isinstance(raw_kind, dict):
                kind = raw_kind.get("kind")
                required = raw_kind.get("required", True)
            if (not isinstance(name, str) or not name or not isinstance(kind, str)
                    or kind not in value_kinds or not isinstance(required, bool)):
                raise ValueError(
                    f"{row_id}: referenceArguments must map names to supported handle kinds")
            normalized_reference_arguments.append((name, kind, required))
        if len({name for name, _, _ in normalized_reference_arguments}) != len(
                normalized_reference_arguments):
            raise ValueError(f"{row_id}: referenceArguments must map names to supported handle kinds")
        input_schema = raw.get("inputSchema")
        result_schema = raw.get("resultSchema")
        example = raw.get("example")
        if not all(isinstance(value, dict) for value in (input_schema, result_schema, example)):
            raise ValueError(f"{row_id}: schemas and example must be objects")
        if not _is_closed_schema(input_schema, path) or not _is_closed_schema(
            result_schema, path
        ):
            raise ValueError(f"{row_id}: inputSchema and resultSchema must be closed schemas")
        exportable = raw.get("exportable", True)
        if not isinstance(exportable, bool):
            raise ValueError(f"{row_id}: exportable must be boolean")
        if row_id.endswith(".resolve") and exportable:
            raise ValueError(f"{row_id}: resolver handles must not be exportable")
        result_ref = result_schema.get("$ref")
        has_invoke_evidence = (
            isinstance(result_ref, str) and result_ref.endswith("InvokeResult")
        )
        has_embedded_evidence = isinstance(result_schema.get("properties"), dict) and (
            "evidence" in result_schema["properties"]
        )
        if (
            mutability == "write"
            and not WRITE_EVIDENCE_KEYS <= set(result_schema)
            and not has_invoke_evidence
            and not has_embedded_evidence
        ):
            raise ValueError(f"{row_id}: write result needs before/after/changed/undo evidence")
        rows.append(
            PrimitiveRow(
                id=row_id,
                order=order,
                mutability=mutability,
                required_suite=_required_string(raw, "requiredSuite", row_id),
                reference_arguments=tuple(sorted(normalized_reference_arguments)),
                input_schema=input_schema,
                result_schema=result_schema,
                executor=_required_string(raw, "executor", row_id),
                summary=_required_string(raw, "summary", row_id),
                example=example,
                exportable=exportable,
            )
        )
    if [row.order for row in rows] != list(range(1, len(rows) + 1)):
        raise ValueError("primitives: rows must use contiguous explicit order")
    return PrimitiveRegistry(tuple(rows))


def validate_sources(root: Path) -> None:
    migration = load_migration_manifest(
        root / "native/ae-plugin/protocol/native-exec-migration.json"
    )
    registry = load_primitive_registry(
        root / "native/ae-plugin/protocol/native-primitives.json"
    )
    primitive_ids = {row.id for row in registry.rows}
    for row in migration.native_capabilities.values():
        if row.disposition == "NATIVE_PRIMITIVE":
            unknown = set(row.replacement) - primitive_ids
            if unknown:
                raise ValueError(f"{row.id}: unknown replacement primitives {sorted(unknown)}")
    legacy = _json_object(root / "native/ae-plugin/protocol/fixtures/capability-registry-full.json")
    legacy_ids = {row["id"] for row in _rows(legacy.get("items"), "legacy items")}
    if legacy_ids != set(migration.native_capabilities):
        raise ValueError("migration manifest must cover the legacy registry exactly")
    from ae_mcp.handlers import HANDLERS, load_all

    load_all()
    excluded = {
        "ae.exec", "ae.checkpoint", "ae.revert", "ae.snapshot",
        "ae.previewFrame", "ae.validateExpressions", "ae.ping", "ae.status",
        "ae.diagnose", "ae.skillList", "ae.skillUse", "ae.toolIndex",
        "ae.toolSearch", "ae.toolInspect", "ae.toolUse",
    }
    operation_tools = set(HANDLERS) - excluded
    declared_tools = set(migration.public_tools)
    if declared_tools != operation_tools:
        missing = operation_tools - declared_tools
        unexpected = declared_tools - operation_tools
        raise ValueError(
            "publicTools must enumerate operation-specific tools exactly: "
            f"missing={sorted(missing)} unexpected={sorted(unexpected)}"
        )


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _digest(value: Any) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _primitive_value_kind(row: PrimitiveRow) -> str:
    handle = row.result_schema.get("properties", {}).get("handle")
    if handle is None:
        return "kJson"
    if not isinstance(handle, dict):
        raise ValueError(f"{row.id}: handle result must be an object schema")
    kind = handle.get("properties", {}).get("kind", {}).get("const")
    value_kinds = {
        "composition": "kCompositionHandle",
        "layer": "kLayerHandle",
        "property": "kPropertyHandle",
    }
    if kind not in value_kinds:
        raise ValueError(f"{row.id}: handle result must declare a supported kind")
    return value_kinds[kind]


def _primitive_descriptor(row: PrimitiveRow, detail: str) -> dict[str, Any]:
    write = row.mutability == "write"
    descriptor: dict[str, Any] = {
        "cancellation": "before-dispatch",
        "compatibility": {
            "intendedPlatforms": ["macos-arm64", "windows-x64"],
            "status": "unverified",
        },
        "detail": detail,
        "id": row.id,
        "idempotency": "idempotency-key" if write else "idempotent",
        "mutability": "mutating" if write else "read-only",
        "preconditions": [f"{row.required_suite} must be available."],
        "requiredSuite": row.required_suite,
        "risk": row.mutability,
        "schemaVersion": 1,
        "sideEffectSummary": (
            "Changes After Effects state within one native program Undo group."
            if write else "Reads After Effects state without changing it."
        ),
        "summary": row.summary,
        "undo": "ae-undo-group" if write else "not-applicable",
        "valueKind": _primitive_value_kind(row).removeprefix("k"),
        "version": 1,
    }
    if detail == "full":
        descriptor.update({
            "contractDigest": _digest({
                "inputSchema": row.input_schema,
                "resultSchema": row.result_schema,
            }),
            "inputSchema": row.input_schema,
            "resultSchema": row.result_schema,
        })
    return descriptor


def _cpp_raw(value: str) -> str:
    delimiter = "NATIVEEXEC"
    if f"){delimiter}\"" in value:
        raise ValueError("generated primitive JSON conflicts with C++ raw delimiter")
    return f'R"{delimiter}({value}){delimiter}"'


def _model_input_schema(row: PrimitiveRow) -> dict[str, Any]:
    """Merge generated typed references into the row's JSON-safe literals."""
    schema = json.loads(json.dumps(row.input_schema))
    if schema.get("type") != "object" or schema.get("additionalProperties") is not False:
        raise ValueError(f"{row.id}: literal input schema must be a closed object")
    properties = schema.setdefault("properties", {})
    required = schema.setdefault("required", [])
    for name, _kind, reference_required in row.reference_arguments:
        if name in properties:
            raise ValueError(f"{row.id}: literal schema retains reference argument {name}")
        properties[name] = {
            "type": "object",
            "additionalProperties": False,
            "required": ["ref"],
            "properties": {"ref": {"type": "string", "minLength": 1}},
        }
        if reference_required:
            required.append(name)
    schema["required"] = sorted(set(required))
    return schema


def _write(path: Path, text: str, *, check: bool) -> None:
    if check:
        if not path.is_file() or path.read_text() != text:
            raise ValueError(f"generated output drift: {path.relative_to(ROOT)}")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def _generate_cpp_header(registry: PrimitiveRegistry) -> str:
    rows = registry.rows
    summaries = [_primitive_descriptor(row, "summary") for row in rows]
    full = [_primitive_descriptor(row, "full") for row in rows]
    registry_digest = _digest(full)
    lines = [
        "// Generated by scripts/generate_native_exec.py. Do not edit by hand.",
        "#pragma once",
        "",
        "#include <array>",
        "#include <cstddef>",
        "#include <span>",
        "#include <string_view>",
        "",
        "namespace aemcp::native {",
        "",
        "enum class PrimitiveMutability { kRead, kWrite };",
        "enum class PrimitiveValueKind { kJson, kCompositionHandle, kLayerHandle, kPropertyHandle };",
        "",
        "struct NativeReferenceArgument {",
        "  std::string_view name;",
        "  PrimitiveValueKind kind;",
        "  bool required;",
        "};",
        "",
        "struct NativePrimitiveDescriptor {",
        "  std::string_view id;",
        "  PrimitiveMutability mutability;",
        "  std::string_view required_suite;",
        "  std::string_view input_schema_json;",
        "  std::span<const NativeReferenceArgument> reference_arguments;",
        "  std::string_view result_schema_json;",
        "  std::string_view summary;",
        "  std::string_view executor_symbol;",
        "  PrimitiveValueKind result_kind;",
        "  bool exportable;",
        "};",
        "",
        f"inline constexpr std::size_t kNativePrimitiveCount = {len(rows)};",
        f'inline constexpr std::string_view kNativeExecRegistryDigest = "{registry_digest}";',
    ]
    for index, row in enumerate(rows):
        lines.extend([
            f"inline constexpr std::array<NativeReferenceArgument, {len(row.reference_arguments)}> "
            f"kNativePrimitiveReferenceArguments{index}{{{{",
        ])
        lines.extend(
            f'    NativeReferenceArgument{{"{name}", PrimitiveValueKind::k{kind}, '
            f"{'true' if required else 'false'}}},"
            for name, kind, required in row.reference_arguments
        )
        lines.extend(["}};", ""])
    lines.extend([
        "inline constexpr std::array<NativePrimitiveDescriptor, kNativePrimitiveCount>",
        "    kNativePrimitiveRegistry{{",
    ])
    for row in rows:
        lines.extend([
            "    NativePrimitiveDescriptor{",
            f'        "{row.id}",',
            "        PrimitiveMutability::kWrite,"
            if row.mutability == "write" else "        PrimitiveMutability::kRead,",
            f'        "{row.required_suite}",',
            f"        {_cpp_raw(_canonical_json(row.input_schema))},",
            f"        std::span<const NativeReferenceArgument>{{kNativePrimitiveReferenceArguments{rows.index(row)}}},",
            f"        {_cpp_raw(_canonical_json(row.result_schema))},",
            f"        {_cpp_raw(row.summary)},",
            f'        "{row.executor}",',
            f"        PrimitiveValueKind::{_primitive_value_kind(row)},",
            f"        {'true' if row.exportable else 'false'},",
            "    },",
        ])
    lines.extend(["}};", ""])
    for label, values in (("Summary", summaries), ("Full", full)):
        lines.extend([
            f"inline constexpr std::array<std::string_view, kNativePrimitiveCount> kNativePrimitive{label}Json{{{{",
        ])
        lines.extend(f"    {_cpp_raw(_canonical_json(value))}," for value in values)
        lines.extend(["}};", ""])
    lines.extend([
        "inline std::span<const NativePrimitiveDescriptor> native_primitive_registry() {",
        "  return kNativePrimitiveRegistry;",
        "}",
        "",
        "inline const NativePrimitiveDescriptor* find_native_primitive(std::string_view id) {",
        "  for (const auto& descriptor : kNativePrimitiveRegistry) {",
        "    if (descriptor.id == id) return &descriptor;",
        "  }",
        "  return nullptr;",
        "}",
        "",
        "}  // namespace aemcp::native",
        "",
    ])
    return "\n".join(lines)


def _generate_bindings(registry: PrimitiveRegistry) -> str:
    lines = ["// Generated by scripts/generate_native_exec.py. Do not edit by hand."]
    for row in registry.rows:
        lines.extend([
            "AEMCP_NATIVE_PRIMITIVE(",
            f'    "{row.id}",',
            f"    {row.executor})",
        ])
    return "\n".join(lines) + "\n"


def _generate_mjs(registry: PrimitiveRegistry) -> str:
    rows = [
        {
            "id": row.id,
            "mutability": row.mutability,
            "requiredSuite": row.required_suite,
            "referenceArguments": {
                name: {"kind": kind, "required": required}
                for name, kind, required in row.reference_arguments
            },
            "inputSchema": row.input_schema,
            "modelInputSchema": _model_input_schema(row),
            "resultSchema": row.result_schema,
            "summary": row.summary,
            "executor": row.executor,
            "resultKind": _primitive_value_kind(row).removeprefix("k"),
            "exportable": row.exportable,
            "contractDigest": _digest({"inputSchema": row.input_schema, "resultSchema": row.result_schema}),
        }
        for row in registry.rows
    ]
    input_schema = {
        "type": "object",
        "additionalProperties": False,
        "required": ["operations"],
        "properties": {
            "operations": {
                "type": "array", "minItems": 1, "maxItems": 64,
                "items": {"oneOf": [
                    {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["op", "args"],
                        "properties": {
                            "op": {"const": row.id},
                            "args": _model_input_schema(row),
                            "saveAs": {"type": "string", "minLength": 1},
                            "returnAs": {"type": "string", "minLength": 1},
                        },
                    }
                    for row in registry.rows
                ]},
            },
        },
    }
    payload = _canonical_json(rows)
    descriptors = {
        "summary": [_primitive_descriptor(row, "summary") for row in registry.rows],
        "full": [_primitive_descriptor(row, "full") for row in registry.rows],
    }
    return "\n".join([
        "// Generated by scripts/generate_native_exec.py. Do not edit by hand.",
        f"export const PRIMITIVES = Object.freeze({payload});",
        f"export const CAPABILITY_DESCRIPTORS = Object.freeze({_canonical_json(descriptors)});",
        f"export const NATIVE_EXEC_INPUT_SCHEMA = Object.freeze({_canonical_json(input_schema)});",
        f"export const NATIVE_EXEC_REGISTRY_DIGEST = \"{_digest([_primitive_descriptor(row, 'full') for row in registry.rows])}\";",
        "",
    ])


def _generate_python(registry: PrimitiveRegistry) -> str:
    rows = [
        {
            "id": row.id,
            "mutability": row.mutability,
            "required_suite": row.required_suite,
            "reference_arguments": {
                name: {"kind": kind, "required": required}
                for name, kind, required in row.reference_arguments
            },
            "input_schema": row.input_schema,
            "model_input_schema": _model_input_schema(row),
            "result_schema": row.result_schema,
            "summary": row.summary,
            "executor": row.executor,
            "result_kind": _primitive_value_kind(row).removeprefix("k"),
            "exportable": row.exportable,
            "contract_digest": _digest({"inputSchema": row.input_schema, "resultSchema": row.result_schema}),
        }
        for row in registry.rows
    ]
    input_schema = {
        "type": "object", "additionalProperties": False, "required": ["operations"],
        "properties": {"operations": {"type": "array", "minItems": 1}},
    }
    return "\n".join([
        "# Generated by scripts/generate_native_exec.py. Do not edit by hand.",
        "from __future__ import annotations",
        "",
        f"PRIMITIVES = {pprint.pformat(rows, sort_dicts=True, width=100)}",
        f"NATIVE_EXEC_INPUT_SCHEMA = {pprint.pformat(input_schema, sort_dicts=True, width=100)}",
        f"NATIVE_EXEC_REGISTRY_DIGEST = \"{_digest([_primitive_descriptor(row, 'full') for row in registry.rows])}\"",
        "",
    ])


def generate_projections(root: Path, registry: PrimitiveRegistry, *, check: bool) -> None:
    _write(
        root / "native/ae-plugin/include/aemcp_native/native_primitive_registry.generated.hpp",
        _generate_cpp_header(registry), check=check)
    _write(
        root / "native/ae-plugin/src/aegp/native_primitive_bindings.generated.inc",
        _generate_bindings(registry), check=check)
    _write(
        root / "native/ae-plugin/protocol/native_exec.generated.mjs",
        _generate_mjs(registry), check=check)
    _write(
        root / "packages/core/ae_mcp/native_exec_generated.py",
        _generate_python(registry), check=check)


def generate_all(root: Path, *, check: bool) -> None:
    validate_sources(root)
    registry = load_primitive_registry(root / "native/ae-plugin/protocol/native-primitives.json")
    generate_projections(root, registry, check=check)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--validate", action="store_true")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    generate_all(ROOT, check=args.check)
    if args.validate or args.check:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
