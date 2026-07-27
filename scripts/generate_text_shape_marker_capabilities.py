#!/usr/bin/env python3
"""Generate the native Text/Shape/Marker capability registry projections.

The frozen Core contracts are the source of truth.  This generator keeps the
native C++ descriptors, protocol conformance registry, JSON Schema admission,
and synthetic golden exchange byte-for-byte aligned with those contracts.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import re
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
CORE = ROOT / "packages" / "core"
sys.path.insert(0, str(CORE))

from ae_mcp.backends import native_text_shape_marker as tsm  # noqa: E402
from ae_mcp.backends import native_project_composition as composition  # noqa: E402


PROTOCOL = ROOT / "native" / "ae-plugin" / "protocol"
GENERATED_MJS = PROTOCOL / "text_shape_marker_capabilities.generated.mjs"
GENERATED_HPP = (
    ROOT
    / "native"
    / "ae-plugin"
    / "include"
    / "aemcp_native"
    / "text_shape_marker_capabilities.generated.hpp"
)
SCHEMA = PROTOCOL / "aegp-rpc.schema.json"
CAPABILITIES_FIXTURE = PROTOCOL / "fixtures" / "capabilities.json"
HELLO_FIXTURE = PROTOCOL / "fixtures" / "hello.json"
MATRIX_FIXTURES = (
    PROTOCOL / "fixtures" / "layer-compositing-matrix.json",
    PROTOCOL / "fixtures" / "keyframe-authoring-matrix.json",
)
COMPOSITION_SNAPSHOT_INVOKE_FIXTURES = {
    composition.COMPOSITION_SETTINGS_READ_CAPABILITY_ID: (
        PROTOCOL / "fixtures" / "invoke-composition-settings-read.json"
    ),
    composition.COMPOSITION_DUPLICATE_CAPABILITY_ID: (
        PROTOCOL / "fixtures" / "invoke-composition-duplicate.json"
    ),
}
GENERATED_PREFIX = "tsmGenerated"
FULL_ONLY_FIELDS = {
    "inputContractId",
    "resultContractId",
    "contractDigest",
    "inputSchema",
    "resultSchema",
    "requirements",
    "examples",
}
COMPOSITION_SETTING_CAPABILITY_IDS = (
    composition.COMPOSITION_DIMENSIONS_SET_CAPABILITY_ID,
    composition.COMPOSITION_DURATION_SET_CAPABILITY_ID,
    composition.COMPOSITION_FRAME_RATE_SET_CAPABILITY_ID,
    composition.COMPOSITION_PIXEL_ASPECT_RATIO_SET_CAPABILITY_ID,
    composition.COMPOSITION_BACKGROUND_COLOR_SET_CAPABILITY_ID,
    composition.COMPOSITION_DISPLAY_START_TIME_SET_CAPABILITY_ID,
)
COMPOSITION_SNAPSHOT_CAPABILITY_IDS = (
    composition.COMPOSITION_SETTINGS_READ_CAPABILITY_ID,
    composition.COMPOSITION_DUPLICATE_CAPABILITY_ID,
)
COMPOSITION_SNAPSHOT_SCHEMA_DEFINITIONS = {
    composition.COMPOSITION_SETTINGS_READ_CAPABILITY_ID: (
        "compositionSettingsReadInputSchemaContract",
        "compositionSettingsReadResultSchemaContract",
        "compositionSettingsReadValue",
    ),
    composition.COMPOSITION_DUPLICATE_CAPABILITY_ID: (
        "compositionDuplicateInputSchemaContract",
        "compositionDuplicateResultSchemaContract",
        "compositionDuplicateValue",
    ),
}


def _canonical(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def _digest(value: Any) -> str:
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def _locator(kind: str, object_id: str) -> dict[str, Any]:
    return {
        "kind": kind,
        "hostInstanceId": "22222222-2222-4222-8222-222222222222",
        "sessionId": "11111111-1111-4111-8111-111111111111",
        "projectId": "44444444-4444-4444-8444-444444444444",
        "generation": 8,
        "objectId": object_id,
    }


COMPOSITION = _locator("composition", "77777777-7777-4777-8777-777777777777")
NEW_COMPOSITION = _locator(
    "composition", "99999999-9999-4999-8999-999999999999"
)
LAYER = _locator("layer", "88888888-8888-4888-8888-888888888888")
FRESH_LAYER = {
    **_locator("layer", "99999999-9999-4999-8999-999999999999"),
    "projectId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "generation": 9,
}
GROUP_REF = {"layerLocator": LAYER, "groupIndex": 1, "streamId": 101}
FRESH_GROUP_REF = {
    "layerLocator": FRESH_LAYER,
    "groupIndex": 1,
    "streamId": 101,
}
PATH_A = {
    "closed": False,
    "vertices": [
        {
            "position": ["0", "0"],
            "inTangent": ["0", "0"],
            "outTangent": ["25", "25"],
        },
        {
            "position": ["100", "100"],
            "inTangent": ["-25", "-25"],
            "outTangent": ["0", "0"],
        },
    ],
}
PATH_B = {
    "closed": False,
    "vertices": [
        {
            "position": ["0", "0"],
            "inTangent": ["0", "0"],
            "outTangent": ["30", "20"],
        },
        {
            "position": ["120", "80"],
            "inTangent": ["-30", "-20"],
            "outTangent": ["0", "0"],
        },
    ],
}
FILL_A = {
    "enabled": True,
    "color": {"red": 20, "green": 40, "blue": 60, "alpha": 255},
    "opacityPercent": "100",
}
FILL_B = {
    "enabled": True,
    "color": {"red": 80, "green": 100, "blue": 120, "alpha": 255},
    "opacityPercent": "75",
}
STROKE_A = {
    "enabled": True,
    "color": {"red": 220, "green": 200, "blue": 180, "alpha": 255},
    "opacityPercent": "100",
    "widthPixels": "8",
    "strokeOverFill": False,
}
STROKE_B = {
    "enabled": True,
    "color": {"red": 250, "green": 240, "blue": 230, "alpha": 255},
    "opacityPercent": "88",
    "widthPixels": "12.5",
    "strokeOverFill": True,
}
GROUP = {
    "ref": GROUP_REF,
    "name": "Synthetic Shape",
    "path": PATH_A,
    "fill": FILL_A,
    "stroke": STROKE_A,
}
FRESH_GROUP = {**GROUP, "ref": FRESH_GROUP_REF}
MARKER_TARGET = {"kind": "layer", "layerLocator": LAYER}
MARKER_REF_INPUT = {"target": MARKER_TARGET, "time": {"value": 1, "scale": 1}}
MARKER_REF = {
    "target": MARKER_TARGET,
    "time": {"value": 1, "scale": 1, "secondsRational": "1"},
}
MARKER_INPUT = {
    "duration": {"value": 0, "scale": 1},
    "comment": "Synthetic marker",
    "chapter": "chapter",
    "url": "https://example.invalid/marker",
    "frameTarget": "frame",
    "cuePointName": "cue",
    "cuePointParameters": [{"key": "owner", "value": "text-shape-marker"}],
    "navigation": True,
    "protectedRegion": False,
    "labelId": 3,
}
MARKER_STATE = {
    "ref": MARKER_REF,
    "markerIndex": 1,
    "duration": {"value": 0, "scale": 1, "secondsRational": "0"},
    **{key: value for key, value in MARKER_INPUT.items() if key != "duration"},
}
IDEMPOTENCY_KEY = "synthetic-tsm-operation-0001"


def _examples() -> dict[str, tuple[dict[str, Any], dict[str, Any]]]:
    marker_after = copy.deepcopy(MARKER_STATE)
    marker_after["comment"] = "Synthetic marker edited"
    return {
        "ae.shape.layer.create": (
            {
                "compositionLocator": COMPOSITION,
                "name": "Synthetic Shape",
                "idempotencyKey": IDEMPOTENCY_KEY,
            },
            {
                "changed": True,
                "compositionLocator": COMPOSITION,
                "layerLocator": LAYER,
                "name": "Synthetic Shape",
                "stackIndex": 1,
                "layerCountBefore": 0,
                "layerCountAfter": 1,
            },
        ),
        "ae.shape.groups.list": (
            {"layerLocator": LAYER, "offset": 0, "limit": 25},
            {
                "layerLocator": LAYER,
                "total": 0,
                "offset": 0,
                "limit": 25,
                "returned": 0,
                "hasMore": False,
                "nextOffset": None,
                "groups": [],
            },
        ),
        "ae.shape.group.create": (
            {
                "layerLocator": LAYER,
                "name": "Synthetic Shape",
                "path": PATH_A,
                "fill": FILL_A,
                "stroke": STROKE_A,
                "idempotencyKey": IDEMPOTENCY_KEY,
            },
            {
                "changed": True,
                "layerLocator": FRESH_LAYER,
                "groupCountBefore": 0,
                "groupCountAfter": 1,
                "group": FRESH_GROUP,
            },
        ),
        "ae.shape.path.set": (
            {
                "groupRef": GROUP_REF,
                "path": PATH_B,
                "idempotencyKey": IDEMPOTENCY_KEY,
            },
            {
                "changed": True,
                "groupRef": GROUP_REF,
                "beforePath": PATH_A,
                "afterPath": PATH_B,
            },
        ),
        "ae.shape.fill-style.set": (
            {
                "groupRef": GROUP_REF,
                "fill": FILL_B,
                "idempotencyKey": IDEMPOTENCY_KEY,
            },
            {
                "changed": True,
                "groupRef": GROUP_REF,
                "beforeFill": FILL_A,
                "afterFill": FILL_B,
            },
        ),
        "ae.shape.stroke-style.set": (
            {
                "groupRef": GROUP_REF,
                "stroke": STROKE_B,
                "idempotencyKey": IDEMPOTENCY_KEY,
            },
            {
                "changed": True,
                "groupRef": GROUP_REF,
                "beforeStroke": STROKE_A,
                "afterStroke": STROKE_B,
            },
        ),
        "ae.shape.group.reorder": (
            {
                "groupRef": GROUP_REF,
                "targetIndex": 2,
                "idempotencyKey": IDEMPOTENCY_KEY,
            },
            {
                "changed": True,
                "layerLocator": LAYER,
                "streamId": 101,
                "beforeIndex": 1,
                "afterIndex": 2,
                "groups": [
                    {"groupIndex": 1, "streamId": 202, "name": "Other"},
                    {"groupIndex": 2, "streamId": 101, "name": "Synthetic Shape"},
                ],
            },
        ),
        "ae.marker.list": (
            {"target": MARKER_TARGET, "offset": 0, "limit": 25},
            {
                "target": MARKER_TARGET,
                "total": 0,
                "offset": 0,
                "limit": 25,
                "returned": 0,
                "hasMore": False,
                "nextOffset": None,
                "markers": [],
            },
        ),
        "ae.marker.create": (
            {
                "target": MARKER_TARGET,
                "time": {"value": 1, "scale": 1},
                "marker": MARKER_INPUT,
                "idempotencyKey": IDEMPOTENCY_KEY,
            },
            {"changed": True, "before": None, "after": MARKER_STATE},
        ),
        "ae.marker.set": (
            {
                "markerRef": MARKER_REF_INPUT,
                "patch": {"comment": "Synthetic marker edited"},
                "idempotencyKey": IDEMPOTENCY_KEY,
            },
            {"changed": True, "before": MARKER_STATE, "after": marker_after},
        ),
        "ae.marker.delete": (
            {
                "markerRef": MARKER_REF_INPUT,
                "idempotencyKey": IDEMPOTENCY_KEY,
            },
            {"changed": True, "before": MARKER_STATE, "after": None},
        ),
    }


def _descriptors() -> list[dict[str, Any]]:
    examples = _examples()
    descriptors: list[dict[str, Any]] = []
    for capability_id, contract in tsm.CAPABILITY_CONTRACTS.items():
        arguments, value = examples[capability_id]
        arguments = tsm.ARGUMENT_MODELS[capability_id].model_validate(
            arguments
        ).model_dump(mode="json", by_alias=True)
        value = tsm.VALUE_MODELS[capability_id].model_validate(value).model_dump(
            mode="json", by_alias=True
        )
        slug = capability_id.removeprefix("ae.").replace(".", "-")
        descriptors.append(
            {
                "detail": "full",
                "id": capability_id,
                "version": 1,
                "schemaVersion": 1,
                "summary": contract.summary,
                "risk": contract.risk,
                "mutability": (
                    "read-only" if contract.risk == "read" else "mutating"
                ),
                "idempotency": contract.idempotency,
                "cancellation": "before-dispatch",
                "undo": (
                    "not-applicable"
                    if contract.risk == "read"
                    else "ae-undo-group"
                ),
                "sideEffectSummary": contract.side_effect_summary,
                "preconditions": list(contract.preconditions),
                "compatibility": {
                    "status": "unverified",
                    "intendedPlatforms": ["macos-arm64", "windows-x64"],
                },
                "inputContractId": contract.input_contract_id,
                "resultContractId": contract.result_contract_id,
                "contractDigest": contract.contract_digest,
                "inputSchema": contract.input_schema,
                "resultSchema": contract.result_schema,
                "requirements": [
                    {"id": contract.requirement_id, "contractVersion": 1}
                ],
                "examples": [
                    {
                        "id": f"aemcp-example-{slug}",
                        "kind": "positive",
                        "summary": (
                            "Synthetic success demonstrates the frozen typed "
                            "result contract."
                        ),
                        "arguments": arguments,
                        "expected": {"outcome": "succeeded", "value": value},
                    },
                    {
                        "id": f"aemcp-example-{slug}-stale",
                        "kind": "negative",
                        "summary": (
                            "A stale locator is rejected before host mutation."
                        ),
                        "arguments": arguments,
                        "expected": {
                            "errorCode": "STALE_LOCATOR",
                            "recoveryAction": "refresh-locator",
                        },
                    },
                ],
            }
        )
    return descriptors


def _exact_time(value: int, scale: int) -> dict[str, Any]:
    divisor = abs(math.gcd(value, scale))
    numerator = value // divisor
    denominator = scale // divisor
    rational = (
        str(numerator)
        if denominator == 1
        else f"{numerator}/{denominator}"
    )
    return {"value": value, "scale": scale, "secondsRational": rational}


def _exact_ratio(numerator: int, denominator: int) -> dict[str, Any]:
    divisor = math.gcd(numerator, denominator)
    reduced_numerator = numerator // divisor
    reduced_denominator = denominator // divisor
    rational = (
        str(reduced_numerator)
        if reduced_denominator == 1
        else f"{reduced_numerator}/{reduced_denominator}"
    )
    return {
        "numerator": numerator,
        "denominator": denominator,
        "rational": rational,
    }


def _composition_settings_baseline() -> dict[str, Any]:
    return {
        "name": "SYNTHETIC_COMPOSITION",
        "width": 1920,
        "height": 1080,
        "duration": _exact_time(240, 24),
        "frameDuration": _exact_time(1, 24),
        "frameRate": _exact_ratio(24, 1),
        "pixelAspectRatio": _exact_ratio(1, 1),
        "backgroundColor": {
            "red": 0,
            "green": 0,
            "blue": 0,
            "alpha": 255,
        },
        "workArea": {
            "start": _exact_time(0, 24),
            "duration": _exact_time(240, 24),
        },
        "displayStartTime": _exact_time(0, 24),
        "layerCount": 0,
    }


def _composition_setting_examples() -> dict[str, tuple[dict[str, Any], dict[str, Any]]]:
    baseline = _composition_settings_baseline()
    operation_key = "synthetic-comp-setting-0001"
    changes: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {
        composition.COMPOSITION_DIMENSIONS_SET_CAPABILITY_ID: (
            {
                "compositionLocator": COMPOSITION,
                "width": 1280,
                "height": 720,
                "idempotencyKey": operation_key,
            },
            {"width": 1280, "height": 720},
        ),
        composition.COMPOSITION_DURATION_SET_CAPABILITY_ID: (
            {
                "compositionLocator": COMPOSITION,
                "duration": {"value": 288, "scale": 24},
                "idempotencyKey": operation_key,
            },
            {"duration": _exact_time(288, 24)},
        ),
        composition.COMPOSITION_FRAME_RATE_SET_CAPABILITY_ID: (
            {
                "compositionLocator": COMPOSITION,
                "frameRate": {"numerator": 30, "denominator": 1},
                "idempotencyKey": operation_key,
            },
            {
                "frameDuration": _exact_time(1, 30),
                "frameRate": _exact_ratio(30, 1),
            },
        ),
        composition.COMPOSITION_PIXEL_ASPECT_RATIO_SET_CAPABILITY_ID: (
            {
                "compositionLocator": COMPOSITION,
                "pixelAspectRatio": {"numerator": 4, "denominator": 3},
                "idempotencyKey": operation_key,
            },
            {"pixelAspectRatio": _exact_ratio(4, 3)},
        ),
        composition.COMPOSITION_BACKGROUND_COLOR_SET_CAPABILITY_ID: (
            {
                "compositionLocator": COMPOSITION,
                "backgroundColor": {
                    "red": 10,
                    "green": 20,
                    "blue": 30,
                    "alpha": 255,
                },
                "idempotencyKey": operation_key,
            },
            {
                "backgroundColor": {
                    "red": 10,
                    "green": 20,
                    "blue": 30,
                    "alpha": 255,
                },
            },
        ),
        composition.COMPOSITION_DISPLAY_START_TIME_SET_CAPABILITY_ID: (
            {
                "compositionLocator": COMPOSITION,
                "displayStartTime": {"value": -24, "scale": 24},
                "idempotencyKey": operation_key,
            },
            {"displayStartTime": _exact_time(-24, 24)},
        ),
    }
    examples: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {}
    for capability_id, (arguments, after_patch) in changes.items():
        validated_arguments = composition._COMPOSITION_SETTING_ARGUMENT_MODELS[
            capability_id
        ].model_validate(arguments).model_dump(mode="json", by_alias=True)
        value = composition.CompositionSettingsSetValue.model_validate(
            {
                "changed": True,
                "compositionLocator": COMPOSITION,
                "before": baseline,
                "after": {**baseline, **after_patch},
            }
        ).model_dump(mode="json", by_alias=True)
        examples[capability_id] = (validated_arguments, value)
    return examples


def _composition_snapshot_examples() -> dict[
    str, tuple[dict[str, Any], dict[str, Any]]
]:
    baseline = _composition_settings_baseline()
    settings_arguments = composition.CompositionSettingsArguments.model_validate(
        {"compositionLocator": COMPOSITION}
    ).model_dump(mode="json", by_alias=True)
    settings_value = composition.CompositionSettingsValue.model_validate(
        {**baseline, "compositionLocator": COMPOSITION}
    ).model_dump(mode="json", by_alias=True)

    duplicate_arguments = composition.CompositionDuplicateArguments.model_validate(
        {
            "compositionLocator": COMPOSITION,
            "newName": "SYNTHETIC_COPY",
            "idempotencyKey": "synthetic-composition-duplicate-0001",
        }
    ).model_dump(mode="json", by_alias=True)
    duplicate_value = composition.CompositionDuplicateValue.model_validate(
        {
            "changed": True,
            "sourceCompositionLocator": COMPOSITION,
            "newCompositionLocator": NEW_COMPOSITION,
            "projectItemCountBefore": 1,
            "projectItemCountAfter": 2,
            "sourceSettings": baseline,
            "newSettings": {**baseline, "name": "SYNTHETIC_COPY"},
        }
    ).model_dump(mode="json", by_alias=True)
    return {
        composition.COMPOSITION_SETTINGS_READ_CAPABILITY_ID: (
            settings_arguments,
            settings_value,
        ),
        composition.COMPOSITION_DUPLICATE_CAPABILITY_ID: (
            duplicate_arguments,
            duplicate_value,
        ),
    }


def _composition_snapshot_descriptors(
    fixture: dict[str, Any],
) -> list[dict[str, Any]]:
    existing = {
        item["id"]: item for item in fixture["response"]["result"]["items"]
    }
    examples = _composition_snapshot_examples()
    descriptors: list[dict[str, Any]] = []
    for capability_id in COMPOSITION_SNAPSHOT_CAPABILITY_IDS:
        contract = composition.CAPABILITY_CONTRACTS[capability_id]
        descriptor = copy.deepcopy(existing[capability_id])
        arguments, value = examples[capability_id]
        descriptor.update(
            {
                "summary": contract.summary,
                "risk": contract.risk,
                "mutability": (
                    "read-only" if contract.risk == "read" else "mutating"
                ),
                "idempotency": contract.idempotency,
                "undo": (
                    "not-applicable"
                    if contract.risk == "read"
                    else "ae-undo-group"
                ),
                "sideEffectSummary": contract.side_effect_summary,
                "preconditions": list(contract.preconditions),
                "inputContractId": contract.input_contract_id,
                "resultContractId": contract.result_contract_id,
                "contractDigest": contract.contract_digest,
                "inputSchema": contract.input_schema,
                "resultSchema": contract.result_schema,
                "requirements": [
                    {"id": contract.requirement_id, "contractVersion": 1}
                ],
            }
        )
        positive = next(
            example
            for example in descriptor["examples"]
            if example["kind"] == "positive"
        )
        positive["arguments"] = arguments
        positive["expected"] = {"outcome": "succeeded", "value": value}
        descriptors.append(descriptor)
    return descriptors


def _composition_setting_descriptors() -> list[dict[str, Any]]:
    examples = _composition_setting_examples()
    descriptors: list[dict[str, Any]] = []
    for capability_id in COMPOSITION_SETTING_CAPABILITY_IDS:
        contract = composition.CAPABILITY_CONTRACTS[capability_id]
        arguments, value = examples[capability_id]
        slug = capability_id.removeprefix("ae.").replace(".", "-")
        descriptors.append(
            {
                "detail": "full",
                "id": capability_id,
                "version": 1,
                "schemaVersion": 1,
                "summary": contract.summary,
                "risk": contract.risk,
                "mutability": "mutating",
                "idempotency": contract.idempotency,
                "cancellation": "before-dispatch",
                "undo": (
                    "none"
                    if capability_id
                    == composition.COMPOSITION_DISPLAY_START_TIME_SET_CAPABILITY_ID
                    else "ae-undo-group"
                ),
                "sideEffectSummary": contract.side_effect_summary,
                "preconditions": list(contract.preconditions),
                "compatibility": {
                    "status": "unverified",
                    "intendedPlatforms": ["macos-arm64", "windows-x64"],
                },
                "inputContractId": contract.input_contract_id,
                "resultContractId": contract.result_contract_id,
                "contractDigest": contract.contract_digest,
                "inputSchema": contract.input_schema,
                "resultSchema": contract.result_schema,
                "requirements": [
                    {"id": contract.requirement_id, "contractVersion": 1}
                ],
                "examples": [
                    {
                        "id": f"aemcp-example-{slug}",
                        "kind": "positive",
                        "summary": (
                            "Synthetic success demonstrates the frozen typed "
                            "result contract."
                        ),
                        "arguments": arguments,
                        "expected": {"outcome": "succeeded", "value": value},
                    },
                    {
                        "id": f"aemcp-example-{slug}-stale",
                        "kind": "negative",
                        "summary": (
                            "A stale locator is rejected before host mutation."
                        ),
                        "arguments": arguments,
                        "expected": {
                            "errorCode": "STALE_LOCATOR",
                            "recoveryAction": "refresh-locator",
                        },
                    },
                ],
            }
        )
    return descriptors


def _summary(descriptor: dict[str, Any]) -> dict[str, Any]:
    result = {
        key: copy.deepcopy(value)
        for key, value in descriptor.items()
        if key not in FULL_ONLY_FIELDS
    }
    result["detail"] = "summary"
    return result


def _cpp_rows(descriptors: list[dict[str, Any]]) -> str:
    rows = []
    for descriptor in descriptors:
        rows.append(
            "    TextShapeMarkerCapabilityDescriptor{\n"
            f'        "{descriptor["id"]}",\n'
            f'        "{descriptor["contractDigest"]}",\n'
            f'        R"TSMCAP({_canonical(descriptor)})TSMCAP",\n'
            f'        R"TSMCAP({_canonical(_summary(descriptor))})TSMCAP",\n'
            "    },"
        )
    return "\n".join(rows)


def _cpp_projection_rows(descriptors: list[dict[str, Any]]) -> str:
    rows = []
    for descriptor in descriptors:
        rows.append(
            "    CoreCapabilityContractProjection{\n"
            f'        "{descriptor["id"]}",\n'
            f'        "{descriptor["contractDigest"]}",\n'
            f'        R"TSMCAP({_canonical(descriptor)})TSMCAP",\n'
            f'        R"TSMCAP({_canonical(_summary(descriptor))})TSMCAP",\n'
            "    },"
        )
    return "\n".join(rows)


def _cpp_header(
    descriptors: list[dict[str, Any]],
    composition_descriptors: list[dict[str, Any]],
    composition_snapshot_descriptors: list[dict[str, Any]],
    registry_digest: str,
) -> str:
    return (
        "// Generated by scripts/generate_text_shape_marker_capabilities.py.\n"
        "// Do not edit by hand.\n"
        "#pragma once\n\n"
        "#include <array>\n"
        "#include <string_view>\n\n"
        "namespace aemcp::native::rpc {\n\n"
        "struct TextShapeMarkerCapabilityDescriptor {\n"
        "  std::string_view id;\n"
        "  std::string_view contract_digest;\n"
        "  std::string_view full_json;\n"
        "  std::string_view summary_json;\n"
        "};\n\n"
        "struct CoreCapabilityContractProjection {\n"
        "  std::string_view id;\n"
        "  std::string_view contract_digest;\n"
        "  std::string_view full_json;\n"
        "  std::string_view summary_json;\n"
        "};\n\n"
        "inline constexpr std::size_t kTextShapeMarkerCapabilityCount = "
        f"{len(descriptors)};\n"
        "inline constexpr std::size_t kCompositionSettingCapabilityCount = "
        f"{len(composition_descriptors)};\n"
        "inline constexpr std::size_t kCompositionSnapshotCapabilityCount = "
        f"{len(composition_snapshot_descriptors)};\n"
        "inline constexpr std::string_view kCapabilitiesRegistryDigest =\n"
        f'    "{registry_digest}";\n'
        "inline constexpr std::array<TextShapeMarkerCapabilityDescriptor,\n"
        "    kTextShapeMarkerCapabilityCount> kTextShapeMarkerCapabilities{{\n"
        + _cpp_rows(descriptors)
        + "\n}};\n\n"
        "inline constexpr std::array<TextShapeMarkerCapabilityDescriptor,\n"
        "    kCompositionSettingCapabilityCount> kCompositionSettingCapabilities{{\n"
        + _cpp_rows(composition_descriptors)
        + "\n}};\n\n"
        "inline constexpr std::array<CoreCapabilityContractProjection,\n"
        "    kCompositionSnapshotCapabilityCount> "
        "kCompositionSnapshotCapabilities{{\n"
        + _cpp_projection_rows(composition_snapshot_descriptors)
        + "\n}};\n\n"
        "}  // namespace aemcp::native::rpc\n"
    )


def _generated_mjs(
    descriptors: list[dict[str, Any]],
    composition_descriptors: list[dict[str, Any]],
    composition_snapshot_descriptors: list[dict[str, Any]],
) -> str:
    return (
        "// Generated by scripts/generate_text_shape_marker_capabilities.py.\n"
        "// Do not edit by hand.\n"
        "export const TEXT_SHAPE_MARKER_CAPABILITIES = Object.freeze("
        + json.dumps(descriptors, ensure_ascii=False, indent=2)
        + ");\n"
        "export const TEXT_SHAPE_MARKER_CAPABILITY_IDS = Object.freeze(\n"
        "  TEXT_SHAPE_MARKER_CAPABILITIES.map((item) => item.id),\n"
        ");\n"
        "export const COMPOSITION_SETTING_CAPABILITIES = Object.freeze("
        + json.dumps(composition_descriptors, ensure_ascii=False, indent=2)
        + ");\n"
        "export const COMPOSITION_SETTING_CAPABILITY_IDS = Object.freeze(\n"
        "  COMPOSITION_SETTING_CAPABILITIES.map((item) => item.id),\n"
        ");\n"
        "export const COMPOSITION_SNAPSHOT_CAPABILITIES = Object.freeze("
        + json.dumps(composition_snapshot_descriptors, ensure_ascii=False, indent=2)
        + ");\n"
    )


def _pascal(capability_id: str, role: str) -> str:
    words = re.split(r"[^A-Za-z0-9]+", capability_id)
    return GENERATED_PREFIX + "".join(word.title() for word in words) + role


def _rewrite_refs(value: Any, mapping: dict[str, str]) -> Any:
    if isinstance(value, dict):
        rewritten: dict[str, Any] = {}
        for key, item in value.items():
            if key == "$ref" and isinstance(item, str) and item.startswith(
                "#/$defs/"
            ):
                old = item.removeprefix("#/$defs/")
                rewritten[key] = f"#/$defs/{mapping[old]}"
            else:
                rewritten[key] = _rewrite_refs(item, mapping)
        return rewritten
    if isinstance(value, list):
        return [_rewrite_refs(item, mapping) for item in value]
    return value


def _install_value_schema(
    definitions: dict[str, Any],
    schema: dict[str, Any],
    root_name: str,
) -> None:
    nested = schema.get("$defs", {})
    mapping = {
        name: f"{GENERATED_PREFIX}{name}"
        for name in nested
    }
    root = {key: value for key, value in schema.items() if key != "$defs"}
    definitions[root_name] = _rewrite_refs(root, mapping)
    for name, value in nested.items():
        generated = _rewrite_refs(value, mapping)
        existing = definitions.get(mapping[name])
        if existing is not None and existing != generated:
            raise RuntimeError(
                f"generated schema definition collision for {mapping[name]}"
            )
        definitions[mapping[name]] = generated


def _generated_ref(item: Any) -> bool:
    return (
        isinstance(item, dict)
        and isinstance(item.get("$ref"), str)
        and item["$ref"].startswith(f"#/$defs/{GENERATED_PREFIX}")
    )


def _schema_with_tsm(
    original: dict[str, Any], descriptors: list[dict[str, Any]]
) -> dict[str, Any]:
    schema = copy.deepcopy(original)
    definitions = schema["$defs"]
    for key in tuple(definitions):
        if key.startswith(GENERATED_PREFIX):
            del definitions[key]
    for union_name, keyword in (
        ("invokeParams", "oneOf"),
        ("capabilityArguments", "anyOf"),
        ("capabilityValue", "oneOf"),
        ("capabilityInputSchemaContract", "oneOf"),
        ("capabilityResultSchemaContract", "oneOf"),
    ):
        definitions[union_name][keyword] = [
            item
            for item in definitions[union_name][keyword]
            if not _generated_ref(item)
        ]

    def append_contract_ref_if_new(
        union_name: str, definition_name: str, contract_schema: dict[str, Any]
    ) -> None:
        union = definitions[union_name]["oneOf"]
        for item in union:
            reference = item.get("$ref") if isinstance(item, dict) else None
            if not isinstance(reference, str) or not reference.startswith("#/$defs/"):
                continue
            existing = definitions.get(reference.removeprefix("#/$defs/"))
            if isinstance(existing, dict) and existing.get("const") == contract_schema:
                return
        union.append({"$ref": f"#/$defs/{definition_name}"})

    generated_input_schemas: set[str] = set()
    generated_result_schemas: set[str] = set()
    for descriptor in descriptors:
        capability_id = descriptor["id"]
        input_root = _pascal(capability_id, "Arguments")
        value_root = _pascal(capability_id, "Value")
        invoke_root = _pascal(capability_id, "InvokeParams")
        input_contract = _pascal(capability_id, "InputSchemaContract")
        result_contract = _pascal(capability_id, "ResultSchemaContract")
        _install_value_schema(
            definitions, descriptor["inputSchema"], input_root
        )
        _install_value_schema(
            definitions, descriptor["resultSchema"], value_root
        )
        definitions[invoke_root] = {
            "type": "object",
            "additionalProperties": False,
            "required": ["capabilityId", "capabilityVersion", "arguments"],
            "properties": {
                "capabilityId": {"const": capability_id},
                "capabilityVersion": {"const": 1},
                "arguments": {"$ref": f"#/$defs/{input_root}"},
            },
        }
        definitions[input_contract] = {
            "const": descriptor["inputSchema"]
        }
        definitions[result_contract] = {
            "const": descriptor["resultSchema"]
        }
        definitions["invokeParams"]["oneOf"].append(
            {"$ref": f"#/$defs/{invoke_root}"}
        )
        input_fingerprint = _canonical(descriptor["inputSchema"])
        if input_fingerprint not in generated_input_schemas:
            definitions["capabilityArguments"]["anyOf"].append(
                {"$ref": f"#/$defs/{input_root}"}
            )
            generated_input_schemas.add(input_fingerprint)
        result_fingerprint = _canonical(descriptor["resultSchema"])
        if result_fingerprint not in generated_result_schemas:
            definitions["capabilityValue"]["oneOf"].append(
                {"$ref": f"#/$defs/{value_root}"}
            )
            generated_result_schemas.add(result_fingerprint)
        append_contract_ref_if_new(
            "capabilityInputSchemaContract",
            input_contract,
            descriptor["inputSchema"],
        )
        append_contract_ref_if_new(
            "capabilityResultSchemaContract",
            result_contract,
            descriptor["resultSchema"],
        )
    return schema


def _fixture_with_tsm(
    fixture: dict[str, Any], descriptors: list[dict[str, Any]]
) -> tuple[dict[str, Any], str]:
    updated = copy.deepcopy(fixture)
    replacements = {item["id"]: item for item in descriptors}
    items = []
    replaced = set()
    for item in updated["response"]["result"]["items"]:
        capability_id = item["id"]
        if capability_id in replacements:
            items.append(copy.deepcopy(replacements[capability_id]))
            replaced.add(capability_id)
        else:
            items.append(item)
    items.extend(
        copy.deepcopy(descriptor)
        for descriptor in descriptors
        if descriptor["id"] not in replaced
    )
    digest = _digest(items)
    updated["response"]["result"]["items"] = items
    updated["response"]["result"]["capabilitiesDigest"] = digest
    return updated, digest


def _schema_with_composition_snapshots(
    schema: dict[str, Any], descriptors: list[dict[str, Any]]
) -> dict[str, Any]:
    updated = copy.deepcopy(schema)
    definitions = updated["$defs"]
    for descriptor in descriptors:
        (
            input_name,
            result_name,
            value_name,
        ) = COMPOSITION_SNAPSHOT_SCHEMA_DEFINITIONS[descriptor["id"]]
        definitions[input_name]["const"] = copy.deepcopy(
            descriptor["inputSchema"]
        )
        definitions[result_name]["const"] = copy.deepcopy(
            descriptor["resultSchema"]
        )
        _install_value_schema(
            definitions,
            descriptor["resultSchema"],
            value_name,
        )
    return updated


def _invoke_fixture_with_composition_snapshot(
    fixture: dict[str, Any], capability_id: str
) -> dict[str, Any]:
    updated = copy.deepcopy(fixture)
    result = updated["response"]["result"]
    if result["capabilityId"] != capability_id:
        raise ValueError(
            f"{capability_id} invoke fixture has the wrong capabilityId"
        )
    value = result["value"]
    background_color = copy.deepcopy(
        _composition_settings_baseline()["backgroundColor"]
    )
    if capability_id == composition.COMPOSITION_SETTINGS_READ_CAPABILITY_ID:
        value["backgroundColor"] = background_color
        value = composition.CompositionSettingsValue.model_validate(
            value
        ).model_dump(mode="json", by_alias=True)
    else:
        value["sourceSettings"]["backgroundColor"] = copy.deepcopy(
            background_color
        )
        value["newSettings"]["backgroundColor"] = copy.deepcopy(
            background_color
        )
        value = composition.CompositionDuplicateValue.model_validate(
            value
        ).model_dump(mode="json", by_alias=True)
    result["value"] = value
    result["evidence"]["postcondition"]["digest"] = _digest(
        {
            "capabilityId": capability_id,
            "capabilityVersion": result["capabilityVersion"],
            "value": value,
        }
    )
    return updated


def _json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def _outputs() -> dict[Path, str]:
    base_fixture = json.loads(CAPABILITIES_FIXTURE.read_text())
    descriptors = _descriptors()
    composition_descriptors = _composition_setting_descriptors()
    composition_snapshot_descriptors = _composition_snapshot_descriptors(
        base_fixture
    )
    generated_descriptors = [*descriptors, *composition_descriptors]
    all_descriptors = [
        *generated_descriptors,
        *composition_snapshot_descriptors,
    ]
    fixture, registry_digest = _fixture_with_tsm(
        base_fixture, all_descriptors
    )
    schema = _schema_with_tsm(
        json.loads(SCHEMA.read_text()), generated_descriptors
    )
    schema = _schema_with_composition_snapshots(
        schema, composition_snapshot_descriptors
    )
    hello = json.loads(HELLO_FIXTURE.read_text())
    hello["response"]["result"]["capabilitiesDigest"] = registry_digest
    outputs = {
        GENERATED_MJS: _generated_mjs(
            descriptors,
            composition_descriptors,
            composition_snapshot_descriptors,
        ),
        GENERATED_HPP: _cpp_header(
            descriptors,
            composition_descriptors,
            composition_snapshot_descriptors,
            registry_digest,
        ),
        SCHEMA: _json_text(schema),
        CAPABILITIES_FIXTURE: _json_text(fixture),
        HELLO_FIXTURE: _json_text(hello),
    }
    for path in MATRIX_FIXTURES:
        matrix = json.loads(path.read_text())
        matrix["expectedRegistryDigest"] = registry_digest
        outputs[path] = _json_text(matrix)
    for capability_id, path in COMPOSITION_SNAPSHOT_INVOKE_FIXTURES.items():
        outputs[path] = _json_text(
            _invoke_fixture_with_composition_snapshot(
                json.loads(path.read_text()), capability_id
            )
        )
    return outputs


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--check",
        action="store_true",
        help="fail when a generated projection is missing or stale",
    )
    args = parser.parse_args()
    outputs = _outputs()
    stale = [
        path
        for path, content in outputs.items()
        if not path.exists() or path.read_text() != content
    ]
    if args.check:
        if stale:
            for path in stale:
                print(path.relative_to(ROOT))
            return 1
        return 0
    for path, content in outputs.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
