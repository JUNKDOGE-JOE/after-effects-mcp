#!/usr/bin/env python3
"""Validate the frozen metadata for the ae_exec / ae_nativeExec migration."""

from __future__ import annotations

import argparse
import json
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
        has_object_contract = isinstance(properties, dict) and bool(properties)
        has_object_contract = has_object_contract or (
            isinstance(required, list) and bool(required)
        )
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


def generate_all(root: Path, *, check: bool) -> None:
    validate_sources(root)
    if not check:
        return


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
