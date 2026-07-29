"""Contract tests for the frozen native-exec migration metadata."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CORE = ROOT / "packages" / "core"
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(CORE))

from scripts.generate_native_exec import (  # noqa: E402
    load_migration_manifest,
    load_primitive_registry,
    validate_sources,
)


LEGACY_FULL = ROOT / "native/ae-plugin/protocol/fixtures/capability-registry-full.json"
MIGRATION = ROOT / "native/ae-plugin/protocol/native-exec-migration.json"
PRIMITIVES = ROOT / "native/ae-plugin/protocol/native-primitives.json"


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
    assert "ae.exec" not in migration.public_tools
    assert all(
        token not in tool_id
        for tool_id in migration.public_tools
        for token in ("preview", "validation", "status", "tool-library", "skill-library")
    )


def test_native_primitive_catalog_is_explicitly_ordered_and_valid():
    registry = load_primitive_registry(PRIMITIVES)

    assert [row.id for row in registry.rows] == [
        row.id for row in sorted(registry.rows, key=lambda row: row.order)
    ]
    assert len(registry.rows) == 23
    validate_sources(ROOT)
