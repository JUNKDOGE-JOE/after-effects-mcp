#!/usr/bin/env python3
"""Validate the frozen metadata for the ae_exec / ae_nativeExec migration."""

from __future__ import annotations

import argparse
import copy
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
    value = json.loads(path.read_text(encoding="utf-8"))
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
        has_program_write_value = isinstance(result_ref, str) and any(
            result_ref.endswith(f"#/$defs/{definition}")
            for definition in {
                "compositionTimeSetValue",
                "compositionSettingsChangedValue",
                "layerPropertySetValue",
                "keyframeMutationValue",
            }
        )
        has_embedded_evidence = isinstance(result_schema.get("properties"), dict) and (
            "evidence" in result_schema["properties"]
        )
        if (
            mutability == "write"
            and not WRITE_EVIDENCE_KEYS <= set(result_schema)
            and not has_invoke_evidence
            and not has_program_write_value
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
    from ae_mcp import schemas
    from ae_mcp.annotations import VERB_ANNOTATIONS
    from ae_mcp.backends.base import ALL_VERBS
    from ae_mcp.handlers import FINAL_PUBLIC_TOOLS, HANDLERS, load_all

    load_all()
    declared_tools = set(migration.public_tools)
    removed_tools = {
        tool_id
        for tool_id, row in migration.public_tools.items()
        if row.disposition.startswith("REMOVE_TO_")
    }
    if len(declared_tools) != 136 or declared_tools != removed_tools:
        raise ValueError(
            "migration publicTools must retain exactly 136 historical REMOVE rows"
        )
    leaked = removed_tools & set(HANDLERS)
    if leaked:
        raise ValueError(f"removed public tool registered again: {sorted(leaked)}")
    expected_public = set(FINAL_PUBLIC_TOOLS)
    public_surfaces = {
        "handlers": set(HANDLERS),
        "schemas": set(schemas.SCHEMAS),
        "annotations": set(VERB_ANNOTATIONS),
    }
    for source, actual in public_surfaces.items():
        if actual != expected_public:
            raise ValueError(
                f"{source} public surface drifted: "
                f"missing={sorted(expected_public - actual)} "
                f"unexpected={sorted(actual - expected_public)}"
            )
    expected_backend = expected_public - {
        "ae.diagnose",
        "ae.nativeExec",
        "ae.status",
    }
    if set(ALL_VERBS) != expected_backend:
        raise ValueError(
            "legacy JSX backend surface drifted: "
            f"missing={sorted(expected_backend - set(ALL_VERBS))} "
            f"unexpected={sorted(set(ALL_VERBS) - expected_backend)}"
        )


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _digest(value: Any) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _inline_schema(value: Any, root_definitions: dict[str, Any], trail: tuple[str, ...] = ()) -> Any:
    """Inline the local RPC definitions used by the portable admission plane.

    The native program decoder deliberately has no general JSON Schema engine.
    Its generated input literals must therefore be self-contained: a `$ref` left
    here would create a wire-only validation gap before dispatch.
    """
    if isinstance(value, list):
        return [_inline_schema(item, root_definitions, trail) for item in value]
    if not isinstance(value, dict):
        return value
    if set(value) == {"$ref"}:
        reference = value["$ref"]
        if isinstance(reference, str) and "#/$defs/" in reference:
            definition = reference.split("#/$defs/", 1)[1]
            if definition not in root_definitions:
                raise ValueError(f"unknown RPC definition {definition}")
            if definition in trail:
                raise ValueError(f"recursive RPC definition in native admission: {definition}")
            return _inline_schema(root_definitions[definition], root_definitions, trail + (definition,))
    return {key: _inline_schema(item, root_definitions, trail) for key, item in value.items()}


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
    # MSVC rejects string literals longer than 16380 characters (C2026);
    # adjacent literals concatenate, so chunking keeps bytes identical on
    # every compiler.
    chunk = 16000
    parts = [value[index:index + chunk] for index in range(0, len(value), chunk)] or [""]
    return "\n    ".join(f'R"{delimiter}({part}){delimiter}"' for part in parts)


def _model_input_schema(row: PrimitiveRow, root_definitions: dict[str, Any]) -> dict[str, Any]:
    """Merge generated typed references into the row's JSON-safe literals."""
    schema = _inline_schema(row.input_schema, root_definitions)
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


def _native_program_schema(registry: PrimitiveRegistry, root_definitions: dict[str, Any]) -> dict[str, Any]:
    """The one generated public wire shape and the C++ admission contract."""
    read_primitive_ids = [
        row.id for row in registry.rows if row.mutability == "read"
    ]
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["operations"],
        "allOf": [{
            "if": {
                "required": ["operations"],
                "properties": {
                    "operations": {
                        "items": {
                            "required": ["op"],
                            "properties": {
                                "op": {"enum": read_primitive_ids},
                            },
                        },
                    },
                },
            },
            "then": {
                "not": {
                    "anyOf": [
                        {"required": ["operationKey"]},
                        {"required": ["undoGroup"]},
                    ],
                },
            },
            "else": {"required": ["operationKey", "undoGroup"]},
        }],
        "properties": {
            "operationKey": _inline_schema({"$ref": "#/$defs/idempotencyKey"}, root_definitions),
            "undoGroup": {"type": "string", "minLength": 1, "maxLength": 128},
            "operations": {
                "type": "array", "minItems": 1, "maxItems": 64,
                "items": {"oneOf": [
                    {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["op", "args"],
                        "properties": {
                            "op": {"const": row.id},
                            "args": _model_input_schema(row, root_definitions),
                            "saveAs": {"type": "string", "minLength": 1, "maxLength": 64},
                            "returnAs": {"type": "string", "minLength": 1, "maxLength": 64},
                        },
                    }
                    for row in registry.rows
                ]},
            },
        },
    }


def _native_program_invoke_params(registry: PrimitiveRegistry, root_definitions: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["capabilityId", "capabilityVersion", "arguments"],
        "properties": {
            "capabilityId": {"const": "ae.native.exec"},
            "capabilityVersion": {"const": 1},
            "arguments": _native_program_schema(registry, root_definitions),
        },
    }


def _native_exec_capability_descriptor(
    registry: PrimitiveRegistry,
    root_definitions: dict[str, Any],
    detail: str,
) -> dict[str, Any]:
    descriptor: dict[str, Any] = {
        "cancellation": "before-dispatch",
        "compatibility": {
            "intendedPlatforms": ["macos-arm64", "windows-x64"],
            "status": "unverified",
        },
        "detail": detail,
        "id": "ae.native.exec",
        "idempotency": "idempotency-key",
        "mutability": "mutating",
        "preconditions": [
            "Load builtin:skill:ae-execution-guide before composing a native program."
        ],
        "primitiveCount": len(registry.rows),
        "requiredSkill": "builtin:skill:ae-execution-guide",
        "requiredSuite": "generated-primitive-union",
        "risk": "write",
        "schemaVersion": 1,
        "sideEffectSummary": (
            "Runs one bounded native AEGP program; writes use one AE Undo group."
        ),
        "summary": (
            "Execute a bounded native AEGP program. Load the default execution "
            "guide before composing operations."
        ),
        "undo": "ae-undo-group",
        "valueKind": "Json",
        "version": 1,
    }
    if detail == "full":
        input_schema = _native_program_schema(registry, root_definitions)
        result_schema = {
            "$ref": "aegp-rpc.schema.json#/$defs/nativeProgramInvokeResult"
        }
        primitives = [
            _primitive_descriptor(row, "full") for row in registry.rows
        ]
        descriptor.update(
            {
                "contractDigest": _digest(
                    {
                        "inputSchema": input_schema,
                        "primitives": primitives,
                        "requiredSkill": descriptor["requiredSkill"],
                        "resultSchema": result_schema,
                    }
                ),
                "inputSchema": input_schema,
                "primitives": primitives,
                "resultSchema": result_schema,
            }
        )
    return descriptor


def _native_exec_capability_descriptor_schema(
    primitive_count: int,
) -> dict[str, Any]:
    common_required = [
        "detail",
        "id",
        "version",
        "schemaVersion",
        "summary",
        "risk",
        "mutability",
        "idempotency",
        "cancellation",
        "undo",
        "sideEffectSummary",
        "preconditions",
        "compatibility",
        "requiredSuite",
        "valueKind",
        "requiredSkill",
        "primitiveCount",
    ]
    return {
        "type": "object",
        "additionalProperties": False,
        "required": common_required,
        "properties": {
            "detail": {"enum": ["summary", "full"]},
            "id": {"const": "ae.native.exec"},
            "version": {"const": 1},
            "schemaVersion": {"const": 1},
            "summary": {"type": "string", "minLength": 1, "maxLength": 160},
            "risk": {"const": "write"},
            "mutability": {"const": "mutating"},
            "idempotency": {"const": "idempotency-key"},
            "cancellation": {"const": "before-dispatch"},
            "undo": {"const": "ae-undo-group"},
            "sideEffectSummary": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
            },
            "preconditions": {
                "type": "array",
                "minItems": 1,
                "maxItems": 16,
                "items": {"type": "string", "minLength": 1, "maxLength": 128},
            },
            "compatibility": {"$ref": "#/$defs/compatibility"},
            "requiredSuite": {
                "const": "generated-primitive-union",
            },
            "valueKind": {"const": "Json"},
            "requiredSkill": {
                "const": "builtin:skill:ae-execution-guide",
            },
            "primitiveCount": {"const": primitive_count},
            "contractDigest": {"$ref": "#/$defs/sha256"},
            "inputSchema": {"type": "object"},
            "resultSchema": {"type": "object"},
            "primitives": {
                "type": "array",
                "minItems": primitive_count,
                "maxItems": primitive_count,
                "items": {"type": "object"},
            },
        },
        "allOf": [
            {
                "if": {"properties": {"detail": {"const": "full"}}},
                "then": {
                    "required": [
                        "contractDigest",
                        "inputSchema",
                        "resultSchema",
                        "primitives",
                    ]
                },
                "else": {
                    "not": {
                        "anyOf": [
                            {"required": ["contractDigest"]},
                            {"required": ["inputSchema"]},
                            {"required": ["resultSchema"]},
                            {"required": ["primitives"]},
                        ]
                    }
                },
            }
        ],
    }


def _replace_root_definition(path: Path, definition: str, expected: dict[str, Any], *, check: bool) -> None:
    document = _json_object(path)
    actual = document.get("$defs", {}).get(definition)
    if actual == expected:
        return
    if check:
        raise ValueError(f"generated output drift: {path.relative_to(ROOT)} $defs.{definition}")
    text = path.read_text(encoding="utf-8")
    needle = f'    "{definition}": '
    start = text.find(needle)
    if start < 0:
        raise ValueError(f"missing generated definition {definition}")
    value_start = start + len(needle)
    if value_start >= len(text) or text[value_start] != "{":
        raise ValueError(f"generated definition {definition} is not an object")
    depth = 0
    in_string = False
    escaped = False
    end = value_start
    for end in range(value_start, len(text)):
        character = text[end]
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            continue
        if character == '"':
            in_string = True
        elif character == "{":
            depth += 1
        elif character == "}":
            depth -= 1
            if depth == 0:
                break
    else:
        raise ValueError(f"unterminated generated definition {definition}")
    replacement = json.dumps(expected, ensure_ascii=False, indent=6, sort_keys=True)
    text = text[:value_start] + replacement + text[end + 1:]
    path.write_text(text, encoding="utf-8")


def _write(path: Path, text: str, *, check: bool) -> None:
    # Generated artifacts are byte-identical across platforms: force LF
    # instead of the platform default (write_text translates to CRLF on
    # Windows) and compare bytes in drift checks.
    if check:
        if not path.is_file() or path.read_bytes() != text.encode("utf-8"):
            raise ValueError(f"generated output drift: {path.relative_to(ROOT)}")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)


def _local_definition_references(value: Any) -> set[str]:
    references: set[str] = set()
    if isinstance(value, dict):
        reference = value.get("$ref")
        if isinstance(reference, str) and "#/$defs/" in reference:
            name = reference.split("#/$defs/", 1)[1].split("/", 1)[0]
            references.add(name.replace("~1", "/").replace("~0", "~"))
        for member in value.values():
            references.update(_local_definition_references(member))
    elif isinstance(value, list):
        for member in value:
            references.update(_local_definition_references(member))
    return references


def _native_exec_rpc_schema(
    document: dict[str, Any],
    registry: PrimitiveRegistry,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Replace the retired direct-invoke graph and retain shared value defs."""

    generated = copy.deepcopy(document)
    definitions = generated.get("$defs")
    if not isinstance(definitions, dict):
        raise ValueError("aegp-rpc.schema.json: missing $defs")

    definitions["nativeProgramInvokeParams"] = _native_program_invoke_params(
        registry, definitions
    )
    definitions["nativePrimitiveDescriptor"] = (
        _native_exec_capability_descriptor_schema(len(registry.rows))
    )
    definitions["compositionSettingsChangedValue"] = {
        "type": "object",
        "additionalProperties": False,
        "required": ["changed", "compositionLocator", "before", "after"],
        "properties": {
            "changed": {"const": True},
            "compositionLocator": {
                "$ref": "#/$defs/compositionLocator",
            },
            "before": {
                "$ref": "#/$defs/compositionSettingsReadValue",
            },
            "after": {
                "$ref": "#/$defs/compositionSettingsReadValue",
            },
        },
    }
    definitions["invokeParams"] = {
        "$ref": "#/$defs/nativeProgramInvokeParams"
    }
    definitions["invokeResult"] = {
        "$ref": "#/$defs/nativeProgramInvokeResult"
    }
    definitions["capabilityId"] = {"const": "ae.native.exec"}
    definitions["capabilitySummaryItem"] = {
        "allOf": [
            {"$ref": "#/$defs/nativePrimitiveDescriptor"},
            {"properties": {"detail": {"const": "summary"}}},
        ]
    }
    definitions["capabilityFullItem"] = {
        "allOf": [
            {"$ref": "#/$defs/nativePrimitiveDescriptor"},
            {"properties": {"detail": {"const": "full"}}},
        ]
    }
    invoke_success = definitions.get("invokeSuccess")
    if not isinstance(invoke_success, dict):
        raise ValueError("aegp-rpc.schema.json: missing invokeSuccess")
    invoke_success.pop("allOf", None)

    root = {key: value for key, value in generated.items() if key != "$defs"}
    pending = list(_local_definition_references(root))
    for row in registry.rows:
        pending.extend(_local_definition_references(row.input_schema))
        pending.extend(_local_definition_references(row.result_schema))
    retained: set[str] = set()
    while pending:
        name = pending.pop()
        if name in retained:
            continue
        definition = definitions.get(name)
        if definition is None:
            raise ValueError(
                f"aegp-rpc.schema.json: unresolved $defs reference {name}"
            )
        retained.add(name)
        pending.extend(_local_definition_references(definition) - retained)
    generated["$defs"] = {
        name: definitions[name] for name in sorted(retained)
    }
    return generated, definitions


def _generate_cpp_header(registry: PrimitiveRegistry, root_definitions: dict[str, Any]) -> str:
    rows = registry.rows
    summaries = [_primitive_descriptor(row, "summary") for row in rows]
    full = [_primitive_descriptor(row, "full") for row in rows]
    capability_summary = _native_exec_capability_descriptor(
        registry, root_definitions, "summary"
    )
    capability_full = _native_exec_capability_descriptor(
        registry, root_definitions, "full"
    )
    registry_digest = _digest([capability_full])
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
        "inline constexpr std::string_view kNativeExecSummaryJson =",
        f"    {_cpp_raw(_canonical_json(capability_summary))};",
        "inline constexpr std::string_view kNativeExecFullJson =",
        f"    {_cpp_raw(_canonical_json(capability_full))};",
        "inline constexpr std::string_view kNativeExecInputSchemaJson =",
        f"    {_cpp_raw(_canonical_json(_native_program_schema(registry, root_definitions)))};",
        "",
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
            f"        {_cpp_raw(_canonical_json(_model_input_schema(row, root_definitions)))},",
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


def _generate_mjs(registry: PrimitiveRegistry, root_definitions: dict[str, Any]) -> str:
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
            "modelInputSchema": _model_input_schema(row, root_definitions),
            "resultSchema": row.result_schema,
            "summary": row.summary,
            "executor": row.executor,
            "resultKind": _primitive_value_kind(row).removeprefix("k"),
            "exportable": row.exportable,
            "contractDigest": _digest({"inputSchema": row.input_schema, "resultSchema": row.result_schema}),
        }
        for row in registry.rows
    ]
    input_schema = _native_program_schema(registry, root_definitions)
    payload = _canonical_json(rows)
    descriptors = {
        detail: [
            _native_exec_capability_descriptor(
                registry, root_definitions, detail
            )
        ]
        for detail in ("summary", "full")
    }
    return "\n".join([
        "// Generated by scripts/generate_native_exec.py. Do not edit by hand.",
        f"export const PRIMITIVES = Object.freeze({payload});",
        f"export const CAPABILITY_DESCRIPTORS = Object.freeze({_canonical_json(descriptors)});",
        f"export const NATIVE_EXEC_INPUT_SCHEMA = Object.freeze({_canonical_json(input_schema)});",
        f"export const NATIVE_EXEC_REGISTRY_DIGEST = \"{_digest(descriptors['full'])}\";",
        "",
    ])


def _generate_python(registry: PrimitiveRegistry, root_definitions: dict[str, Any]) -> str:
    model_result_definitions: dict[str, Any] = {}

    def localize_result_refs(value: Any) -> Any:
        if isinstance(value, list):
            return [localize_result_refs(item) for item in value]
        if not isinstance(value, dict):
            return value
        if set(value) == {"$ref"}:
            reference = value["$ref"]
            if isinstance(reference, str) and "#/$defs/" in reference:
                definition = reference.split("#/$defs/", 1)[1]
                if definition not in root_definitions:
                    raise ValueError(f"unknown RPC definition {definition}")
                if definition not in model_result_definitions:
                    model_result_definitions[definition] = {}
                    model_result_definitions[definition] = localize_result_refs(
                        root_definitions[definition]
                    )
                return {"$ref": f"#/$defs/{definition}"}
        return {
            key: localize_result_refs(item)
            for key, item in value.items()
        }

    model_result_schemas: list[dict[str, Any]] = []
    model_result_schema_indexes: dict[str, int] = {}
    result_schema_indexes: dict[str, int] = {}
    for row in registry.rows:
        key = _canonical_json(row.result_schema)
        index = result_schema_indexes.get(key)
        if index is None:
            index = len(model_result_schemas)
            result_schema_indexes[key] = index
            model_result_schemas.append(localize_result_refs(row.result_schema))
        model_result_schema_indexes[row.id] = index
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
            "model_input_schema": _model_input_schema(row, root_definitions),
            "result_schema": row.result_schema,
            "summary": row.summary,
            "executor": row.executor,
            "result_kind": _primitive_value_kind(row).removeprefix("k"),
            "exportable": row.exportable,
            "contract_digest": _digest({"inputSchema": row.input_schema, "resultSchema": row.result_schema}),
        }
        for row in registry.rows
    ]
    input_schema = _native_program_schema(registry, root_definitions)
    descriptors = {
        detail: [
            _native_exec_capability_descriptor(
                registry, root_definitions, detail
            )
        ]
        for detail in ("summary", "full")
    }
    return "\n".join([
        "# Generated by scripts/generate_native_exec.py. Do not edit by hand.",
        "from __future__ import annotations",
        "",
        f"PRIMITIVES = {pprint.pformat(rows, sort_dicts=True, width=100)}",
        f"MODEL_RESULT_DEFINITIONS = {pprint.pformat(model_result_definitions, sort_dicts=True, width=100)}",
        f"MODEL_RESULT_SCHEMAS = {pprint.pformat(model_result_schemas, sort_dicts=True, width=100)}",
        f"MODEL_RESULT_SCHEMA_INDEXES = {pprint.pformat(model_result_schema_indexes, sort_dicts=True, width=100)}",
        f"NATIVE_EXEC_INPUT_SCHEMA = {pprint.pformat(input_schema, sort_dicts=True, width=100)}",
        f"CAPABILITY_DESCRIPTORS = {pprint.pformat(descriptors, sort_dicts=True, width=100)}",
        f"NATIVE_EXEC_REGISTRY_DIGEST = \"{_digest(descriptors['full'])}\"",
        "",
    ])


def _generate_protocol_fixtures(
    root: Path,
    registry: PrimitiveRegistry,
    root_definitions: dict[str, Any],
    *,
    check: bool,
) -> None:
    summary = _native_exec_capability_descriptor(
        registry, root_definitions, "summary"
    )
    full = _native_exec_capability_descriptor(
        registry, root_definitions, "full"
    )
    digest = _digest([full])
    fixture_meta = {
        "classification": "synthetic-contract-vector",
        "runtimeEvidence": False,
        "compatibilityEvidence": False,
    }
    session_id = "11111111-1111-4111-8111-111111111111"
    query_digest = _digest(
        {
            "detail": "summary",
            "ids": None,
            "limit": 50,
            "sessionId": session_id,
        }
    )
    capabilities = {
        "_fixture": fixture_meta,
        "request": {
            "wireVersion": 1,
            "kind": "request",
            "sessionId": session_id,
            "requestId": "capabilities-1",
            "method": "capabilities",
            "params": {"detail": "summary", "limit": 50},
        },
        "response": {
            "wireVersion": 1,
            "kind": "response",
            "sessionId": session_id,
            "requestId": "capabilities-1",
            "method": "capabilities",
            "ok": True,
            "replayed": False,
            "result": {
                "detail": "summary",
                "items": [summary],
                "nextCursor": None,
                "queryDigest": query_digest,
                "capabilitiesDigest": digest,
            },
        },
    }
    full_fixture = {
        "_fixture": fixture_meta,
        "capabilitiesDigest": digest,
        "items": [full],
    }
    for name, document in (
        ("capabilities.json", capabilities),
        ("capability-registry-full.json", full_fixture),
    ):
        _write(
            root / "native/ae-plugin/protocol/fixtures" / name,
            json.dumps(document, ensure_ascii=False, indent=2) + "\n",
            check=check,
        )
    hello_path = root / "native/ae-plugin/protocol/fixtures/hello.json"
    hello = _json_object(hello_path)
    hello["response"]["result"]["capabilitiesDigest"] = digest
    _write(
        hello_path,
        json.dumps(hello, ensure_ascii=False, indent=2) + "\n",
        check=check,
    )


def _require_primitive(registry: PrimitiveRegistry, primitive_id: str) -> PrimitiveRow:
    for row in registry.rows:
        if row.id == primitive_id:
            return row
    raise ValueError(f"default execution guide requires primitive {primitive_id}")


def _primitive_contract_line(row: PrimitiveRow) -> str:
    """One per-op contract line: refs (with required marks) and literals."""
    parts = ["- `{}` — {}".format(row.id, row.mutability)]
    if row.reference_arguments:
        refs = ", ".join(
            "{}{}:{}".format(name, "" if required else "?", kind)
            for name, kind, required in row.reference_arguments
        )
        parts.append("refs `{}`".format(refs))
    required = set(row.input_schema.get("required") or [])
    properties = row.input_schema.get("properties") or {}
    if properties:
        literals = []
        for name, schema in properties.items():
            optional = "" if name in required else "?"
            if name == "limit" and isinstance(schema.get("maximum"), int):
                literals.append(
                    "limit{}(1..{})".format(optional, schema["maximum"])
                )
            elif name == "offset":
                literals.append("offset{}(>=0)".format(optional))
            else:
                literals.append("{}{}".format(name, optional))
        parts.append("literals `{}`".format(", ".join(literals)))
    parts.append("suite `{}`".format(row.required_suite))
    parts.append("result {}".format(_primitive_value_kind(row).removeprefix("k")))
    parts.append("exportable" if row.exportable else "request-local only")
    return "; ".join(parts) + "."


def _generate_execution_guide(registry: PrimitiveRegistry) -> str:
    """Render stable route guidance plus the generated primitive reference."""
    composition_resolve = _require_primitive(registry, "composition.resolve")
    time_read = _require_primitive(registry, "composition.time.read")
    time_set = _require_primitive(registry, "composition.time.set")
    locator = {
        "kind": "composition",
        "hostInstanceId": "22222222-2222-4222-8222-222222222222",
        "sessionId": "11111111-1111-4111-8111-111111111111",
        "projectId": "33333333-3333-4333-8333-333333333333",
        "generation": 1,
        "objectId": "44444444-4444-4444-8444-444444444444",
    }
    jsx_example = {
        "code": (
            "var comp = AEMCP.activeComp();\n"
            "var layer = comp ? comp.layer(1) : null;\n"
            "var result;\n"
            "if (!layer) { result = {ok:false,error:\"layer not found\"}; }\n"
            "else { layer.enabled = false; "
            "result = {ok:true,enabled:layer.enabled}; }\n"
            "JSON.stringify(result);"
        ),
        "undo_group_name": "Disable layer",
    }
    native_read_example = {
        "operations": [
            {
                "op": composition_resolve.id,
                "args": {"locator": locator},
                "saveAs": "composition",
            },
            {
                "op": time_read.id,
                "args": {"composition": {"ref": "composition"}},
                "returnAs": "time",
            },
        ]
    }
    native_write_example = {
        "operationKey": "native-time-write-0001",
        "undoGroup": "Set exact composition time",
        "operations": [
            {
                "op": composition_resolve.id,
                "args": {"locator": locator},
                "saveAs": "composition",
            },
            {
                "op": time_set.id,
                "args": {
                    "composition": {"ref": "composition"},
                    "targetTime": {"value": 5, "scale": 24},
                },
                "returnAs": "time",
            },
        ],
    }
    reference = "\n".join(_primitive_contract_line(row) for row in registry.rows)
    template = """\
# AE Execution Guide

## Route choice

Use `ae_exec` when maintained AE scripting can do the job; do not seek convenience verbs. Use `ae_nativeExec` only for listed AEGP-only primitives.

## Program composition

`operations` is bounded. Use `saveAs`/`{{"ref":"name"}}` for local handles and `returnAs` for JSON values. Reads omit `operationKey`/`undoGroup`; writes require both. Never invent locators: run `project.items.list`, copy its returned locator verbatim, then walk `composition.resolve` → `composition.layers.list` → `layer.resolve` → `layer.properties.list` (groups need `parentProperty`) → `property.resolve` with `locator` and refs. Lists need `offset`/`limit`; keyframe reads use only the `property` ref, while keyframe mutations use both `layer` and `property` refs; times are `{{"value","scale"}}` rationals. Per-op contracts: below.

Exact rational-time read (`AeNativeExecArgs`):
<!-- AE_NATIVE_EXEC_EXAMPLE -->
```json
{native_read}
```

Exact rational-time write (`AeNativeExecArgs`):
<!-- AE_NATIVE_EXEC_EXAMPLE -->
```json
{native_write}
```

## JSX persistence

`ae_exec` is ephemeral. Persistence needs a separate `ae_toolUse` call with `action="save"`. A user-requested save chooses `status="saved"` or `status="candidate"`; model-judged reuse sets `intent="model-curated"` and candidate only. Never auto-save. Candidates are excluded from default discovery and cannot be rendered or executed. User-requested exact `expected_revision`/`expected_content_hash` promotion or explicit panel deletion ends retention; no automatic expiration or cleanup.

## Readback

Read state before and after each write. Re-resolve locators after graph-changing writes or Undo. Treat terminal, returned state, postcondition, and audit evidence as one result.

## Undo

One native write program opens one real AE Undo group; programs are not atomic and never roll back silently. `undo.available=true` means available, not executed or verified. After an explicit Undo, read state again. JSX writes: supply `undo_group_name`.

## Uncertain native write

A timeout or disconnect after dispatch may have changed AE. Freeze the request and run a fresh read-only `ae_nativeExec` reconciliation program. Only after conclusive no-effect reconciliation may you submit a canonical-identical replay with the same `operationKey`, `undoGroup`, operations, and program digest. Otherwise stop. Never invent an outcome.

## Visual verification

State readback proves data, not appearance. Use `ae_previewFrame` after visual changes; sample twice for motion, once for static changes. After writing expressions, run `ae_validateExpressions` before preview.

## ExtendScript essentials

AE uses ECMAScript 3: `var`, `function`, traditional loops. End reads with `JSON.stringify(...)`; guard fallible lookups for structured errors. Prefer `matchName` paths; use effect-property indices when localized names fail; reacquire references after `addProperty`.

Disable and read back a layer (`AeExecArgs`):
<!-- AE_EXEC_EXAMPLE -->
```json
{jsx}
```

## Native primitive reference

Format: op — mutability; refs (`?` = optional); literals (bounds); suite; result; exportability.

<!-- GENERATED NATIVE REFERENCE -->
{reference}
""".format(
        native_read=json.dumps(native_read_example, ensure_ascii=False, indent=2),
        native_write=json.dumps(native_write_example, ensure_ascii=False, indent=2),
        jsx=json.dumps(jsx_example, ensure_ascii=False, indent=2),
        reference=reference,
    )
    skill = {
        "name": "ae-execution-guide",
        "description": (
            "Use when choosing an AE execution route, composing a native AEGP "
            "program, or verifying writes, Undo, uncertain results, and visual output."
        ),
        "template_type": "prompt",
        "args_schema": {},
        "template": template,
    }
    return json.dumps(skill, ensure_ascii=False, indent=2) + "\n"


def _generate_bundled_manifest(root: Path, guide_text: str) -> str:
    path = root / "packages/core/ae_mcp/skills_bundled/manifest.json"
    manifest = _json_object(path)
    artifacts = _rows(manifest.get("artifacts"), "bundled skill artifacts")
    by_path = {
        _required_string(row, "path", "bundled skill artifacts"): dict(row)
        for row in artifacts
    }
    by_path["ae-execution-guide.json"] = {
        "path": "ae-execution-guide.json",
        "sha256": hashlib.sha256(guide_text.encode("utf-8")).hexdigest(),
    }
    manifest["artifacts"] = [by_path[name] for name in sorted(by_path)]
    return json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"


def generate_execution_guide(
    root: Path, registry: PrimitiveRegistry, *, check: bool
) -> None:
    guide_text = _generate_execution_guide(registry)
    _write(
        root / "packages/core/ae_mcp/skills_bundled/ae-execution-guide.json",
        guide_text,
        check=check,
    )
    _write(
        root / "packages/core/ae_mcp/skills_bundled/manifest.json",
        _generate_bundled_manifest(root, guide_text),
        check=check,
    )


def generate_projections(
    root: Path, registry: PrimitiveRegistry, root_definitions: dict[str, Any], *, check: bool
) -> None:
    _write(
        root / "native/ae-plugin/include/aemcp_native/native_primitive_registry.generated.hpp",
        _generate_cpp_header(registry, root_definitions), check=check)
    _write(
        root / "native/ae-plugin/src/aegp/native_primitive_bindings.generated.inc",
        _generate_bindings(registry), check=check)
    _write(
        root / "native/ae-plugin/protocol/native_exec.generated.mjs",
        _generate_mjs(registry, root_definitions), check=check)
    _write(
        root / "packages/core/ae_mcp/native_exec_generated.py",
        _generate_python(registry, root_definitions), check=check)


def generate_all(root: Path, *, check: bool) -> None:
    validate_sources(root)
    registry = load_primitive_registry(root / "native/ae-plugin/protocol/native-primitives.json")
    rpc_schema_path = root / "native/ae-plugin/protocol/aegp-rpc.schema.json"
    rpc_schema, rpc_definitions = _native_exec_rpc_schema(
        _json_object(rpc_schema_path), registry
    )
    generate_projections(root, registry, rpc_definitions, check=check)
    generate_execution_guide(root, registry, check=check)
    _generate_protocol_fixtures(
        root, registry, rpc_definitions, check=check
    )
    _write(
        rpc_schema_path,
        json.dumps(rpc_schema, ensure_ascii=False, indent=2) + "\n",
        check=check,
    )


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
