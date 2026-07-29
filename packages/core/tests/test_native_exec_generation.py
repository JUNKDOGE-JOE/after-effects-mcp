"""Contract tests for the frozen native-exec migration metadata."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
CORE = ROOT / "packages" / "core"
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(CORE))

from scripts.generate_native_exec import (  # noqa: E402
    _inline_schema,
    _native_program_invoke_params,
    load_migration_manifest,
    load_primitive_registry,
    validate_sources,
)


LEGACY_FULL = ROOT / "native/ae-plugin/protocol/fixtures/capability-registry-full.json"
MIGRATION = ROOT / "native/ae-plugin/protocol/native-exec-migration.json"
PRIMITIVES = ROOT / "native/ae-plugin/protocol/native-primitives.json"
AEGP_SCHEMA = ROOT / "native/ae-plugin/protocol/aegp-rpc.schema.json"


def test_native_exec_migration_covers_legacy_registry_exactly():
    legacy = {
        item["id"]
        for item in json.loads(LEGACY_FULL.read_text())["items"]
    }

    migration = load_migration_manifest(MIGRATION)

    assert len(legacy) == 67
    assert set(migration.native_capabilities) == legacy
    assert all(
        row.disposition in {"JSX_EQUIVALENT", "NATIVE_PRIMITIVE"}
        for row in migration.native_capabilities.values()
    )


def test_migration_lists_every_operation_specific_public_tool_only():
    migration = load_migration_manifest(MIGRATION)

    assert migration.public_tools
    assert all(
        row.disposition
        in {
            "REMOVE_TO_AE_EXEC",
            "REMOVE_TO_AE_NATIVE_EXEC",
            "KEEP_CONTROL_PLANE",
        }
        for row in migration.public_tools.values()
    )
    assert {"ae.exec", "ae.nativeExec"}.isdisjoint(migration.public_tools)
    assert "ae.applyEffect" in migration.public_tools
    validate_sources(ROOT)
    assert all(
        token not in tool_id
        for tool_id in migration.public_tools
        for token in ("preview", "validation", "status", "tool-library", "skill-library")
    )


def test_native_migration_rejects_an_empty_primitive_replacement(tmp_path):
    manifest = json.loads(MIGRATION.read_text())
    row = next(
        row
        for row in manifest["nativeCapabilities"]
        if row["disposition"] == "NATIVE_PRIMITIVE"
    )
    row["replacement"] = []
    path = tmp_path / "migration.json"
    path.write_text(json.dumps(manifest))

    with pytest.raises(ValueError, match="replacement"):
        load_migration_manifest(path)


def test_catalog_uses_real_closed_contracts_and_typed_internal_handles():
    catalog = json.loads(PRIMITIVES.read_text())
    primitives = {row["id"]: row for row in catalog["primitives"]}
    aegp_defs = json.loads(AEGP_SCHEMA.read_text())["$defs"]

    keyframes = primitives["property.keyframes.list"]
    assert keyframes["inputSchema"] == {
        "type": "object",
        "additionalProperties": False,
        "required": ["offset", "limit"],
        "properties": {
            "offset": {"$ref": "aegp-rpc.schema.json#/$defs/pageOffset"},
            "limit": {"type": "integer", "minimum": 1, "maximum": 25},
        },
    }
    inlined = _inline_schema(keyframes["inputSchema"], aegp_defs)
    assert "$ref" not in json.dumps(inlined)
    generated = _native_program_invoke_params(load_primitive_registry(PRIMITIVES), aegp_defs)
    assert aegp_defs["nativeProgramInvokeParams"] == generated
    assert (
        generated["properties"]["arguments"]["properties"]["undoGroup"]["maxLength"]
        == 128
    )

    assert primitives["composition.resolve"]["resultSchema"] == {
        "type": "object",
        "additionalProperties": False,
        "required": ["handle", "exportable"],
        "properties": {
            "handle": {
                "type": "object",
                "additionalProperties": False,
                "required": ["kind", "value"],
                "properties": {
                    "kind": {"const": "composition"},
                    "value": {"type": "integer", "minimum": 1},
                },
            },
            "exportable": {"const": False},
        },
    }


def test_catalog_rejects_a_primitive_schema_that_is_not_closed(tmp_path):
    catalog = json.loads(PRIMITIVES.read_text())
    row = next(
        row for row in catalog["primitives"] if row["id"] == "property.keyframes.list"
    )
    row["inputSchema"] = {"type": "object"}
    path = tmp_path / "native-primitives.json"
    path.write_text(json.dumps(catalog))

    with pytest.raises(ValueError, match="closed schema"):
        load_primitive_registry(path)


def test_catalog_rejects_the_former_x_contract_placeholder(tmp_path):
    catalog = json.loads(PRIMITIVES.read_text())
    row = next(
        row for row in catalog["primitives"] if row["id"] == "property.keyframes.list"
    )
    row["inputSchema"] = {
        "type": "object",
        "additionalProperties": False,
        "x-contract": "legacy-native-closed-schema",
    }
    path = tmp_path / "native-primitives.json"
    path.write_text(json.dumps(catalog))
    (tmp_path / "aegp-rpc.schema.json").write_text(AEGP_SCHEMA.read_text())

    with pytest.raises(ValueError, match="closed schema"):
        load_primitive_registry(path)


def test_native_primitive_catalog_is_explicitly_ordered_and_valid():
    registry = load_primitive_registry(PRIMITIVES)

    assert [row.id for row in registry.rows] == [
        row.id for row in sorted(registry.rows, key=lambda row: row.order)
    ]
    assert len(registry.rows) == 23
    validate_sources(ROOT)
