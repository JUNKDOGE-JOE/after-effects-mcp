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
EXECUTION_GUIDE = (
    ROOT / "packages/core/ae_mcp/skills_bundled/ae-execution-guide.json"
)
PRESSURE_FIXTURE = (
    ROOT / "packages/core/tests/fixtures/native-exec-skill-pressure.json"
)
NATIVE_ROOT = ROOT / "native/ae-plugin"


def _current_native_carrier_sources() -> dict[Path, str]:
    """Return text inputs that define the current native runtime/protocol.

    The migration manifest is intentionally closed historical evidence.  Task 9
    forbids those legacy IDs everywhere else in the current native product
    surface, including portable tests and protocol fixtures.
    """

    sources: dict[Path, str] = {}
    for path in NATIVE_ROOT.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(ROOT)
        if relative == Path(
            "native/ae-plugin/protocol/native-exec-migration.json"
        ):
            continue
        if path.suffix not in {
            ".cpp",
            ".hpp",
            ".inc",
            ".json",
            ".mjs",
            ".md",
        }:
            continue
        sources[relative] = path.read_text("utf-8")
    return sources


def test_native_exec_migration_covers_legacy_registry_exactly():
    migration = load_migration_manifest(MIGRATION)
    legacy = set(migration.native_capabilities)

    assert len(legacy) == 67
    assert set(migration.native_capabilities) == legacy
    assert all(
        row.disposition in {"JSX_EQUIVALENT", "NATIVE_PRIMITIVE"}
        for row in migration.native_capabilities.values()
    )


def test_legacy_native_carriers_are_absent_from_the_current_runtime():
    migration = load_migration_manifest(MIGRATION)
    sources = _current_native_carrier_sources()
    joined = "\n".join(sources.values())

    leaked_ids = sorted(
        capability_id
        for capability_id in migration.native_capabilities
        if capability_id in joined
    )
    assert leaked_ids == []

    forbidden_symbols = {
        "InvokeParams": "operation-specific public invoke carrier",
        "kAdvertisedNativeCapabilities": "legacy advertised capability array",
        "text_shape_marker_capabilities.generated": "old TSM generated carrier",
    }
    for symbol, label in forbidden_symbols.items():
        offenders = sorted(
            str(path)
            for path, source in sources.items()
            if symbol in source
            and (
                symbol != "InvokeParams"
                or path.suffix in {".cpp", ".hpp", ".inc"}
            )
        )
        assert offenders == [], f"{label}: {offenders}"

    member_offenders: list[str] = []
    for path, source in sources.items():
        if (
            "include_project_" in source
            or "include_layer_" in source
            or "_contract_digest" in source
        ):
            member_offenders.append(str(path))
    assert sorted(member_offenders) == []

    codec_header = sources[
        Path("native/ae-plugin/include/aemcp_native/rpc_codec.hpp")
    ]
    allowed_encoders = {
        "encode_hello_success",
        "encode_capabilities_success",
        "encode_progress_event",
        "encode_native_program_success",
        "encode_native_program_failure",
        "encode_cancel_success",
        "encode_project_graph_invalidate_success",
        "encode_error_response",
    }
    declared_encoders = {
        name
        for name in __import__("re").findall(
            r"\b(encode_[a-z0-9_]+)\s*\(", codec_header
        )
    }
    assert declared_encoders == allowed_encoders


def test_migration_is_closed_history_and_current_surface_is_exact():
    from ae_mcp.annotations import VERB_ANNOTATIONS
    from ae_mcp.backends.base import ALL_VERBS
    from ae_mcp.handlers import FINAL_PUBLIC_TOOLS, HANDLERS, load_all
    from ae_mcp import schemas

    migration = load_migration_manifest(MIGRATION)
    load_all()

    assert migration.public_tools
    assert len(migration.public_tools) == 136
    assert all(
        row.disposition
        in {
            "REMOVE_TO_AE_EXEC",
            "REMOVE_TO_AE_NATIVE_EXEC",
        }
        for row in migration.public_tools.values()
    )
    assert {"ae.exec", "ae.nativeExec"}.isdisjoint(migration.public_tools)
    assert "ae.applyEffect" in migration.public_tools
    removed = set(migration.public_tools)
    assert set(HANDLERS) == set(FINAL_PUBLIC_TOOLS)
    assert set(schemas.SCHEMAS) == set(FINAL_PUBLIC_TOOLS)
    assert set(VERB_ANNOTATIONS) == set(FINAL_PUBLIC_TOOLS)
    assert removed.isdisjoint(HANDLERS)
    assert set(ALL_VERBS) == set(FINAL_PUBLIC_TOOLS) - {
        "ae.diagnose",
        "ae.nativeExec",
        "ae.status",
    }
    validate_sources(ROOT)
    assert all(
        token not in tool_id
        for tool_id in migration.public_tools
        for token in ("preview", "validation", "status", "tool-library", "skill-library")
    )


def test_source_validation_rejects_a_removed_tool_reregistered_publicly(
    monkeypatch,
):
    from ae_mcp.handlers import HANDLERS, load_all

    load_all()
    monkeypatch.setitem(HANDLERS, "ae.applyEffect", HANDLERS["ae.exec"])

    with pytest.raises(ValueError, match="removed public tool"):
        validate_sources(ROOT)


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


def test_native_exec_skill_pressure_fixture_records_the_observed_red_baseline():
    fixture = json.loads(PRESSURE_FIXTURE.read_text())
    scenarios = {row["id"]: row for row in fixture["scenarios"]}
    assert fixture["schemaVersion"] == 1
    assert scenarios["disable-layer-and-verify"]["baseline"] == {
        "route": "legacy operation-specific typed tool",
        "choice": "ae_setLayerVisibility with typed pre/post reads",
        "rationale": "The current instructions say to prefer typed verbs.",
        "confidence": 0.98,
        "passed": False,
    }
    assert scenarios["read-exact-composition-rational-time"]["baseline"] == {
        "route": "legacy operation-specific native tools",
        "choice": "ae_listProjectItems followed by ae_getCompositionTime",
        "rationale": "The current surface presents the typed native graph route directly.",
        "confidence": 0.98,
        "passed": False,
    }
    timed_out = scenarios["timed-out-native-write"]["baseline"]
    assert timed_out["passed"] is True
    assert "Refuse a blind retry" in timed_out["choice"]
    assert "no public operationKey audit or outcome lookup" in timed_out["rationale"]
    assert {
        scenario_id: (row["postSkill"]["route"], row["postSkill"]["confidence"])
        for scenario_id, row in scenarios.items()
    } == {
        "disable-layer-and-verify": ("ae_exec", 0.99),
        "read-exact-composition-rational-time": ("ae_nativeExec", 0.99),
        "timed-out-native-write": ("read-only ae_nativeExec reconciliation", 0.98),
    }
    assert all(row["postSkill"]["passed"] for row in scenarios.values())
    assert "simple layer toggle" in scenarios[
        "disable-layer-and-verify"
    ]["postSkill"]["loophole"]
    assert "fresh server-issued composition locator" in scenarios[
        "read-exact-composition-rational-time"
    ]["postSkill"]["loophole"]
    assert "original operations, undoGroup, and program digest" in scenarios[
        "timed-out-native-write"
    ]["postSkill"]["loophole"]


def test_execution_guide_is_a_generated_projection():
    assert EXECUTION_GUIDE.is_file()
    before = EXECUTION_GUIDE.read_text(encoding="utf-8")
    from scripts.generate_native_exec import generate_all

    generate_all(ROOT, check=True)
    assert EXECUTION_GUIDE.read_text(encoding="utf-8") == before
