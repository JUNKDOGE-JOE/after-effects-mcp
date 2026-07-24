"""Contracts for the grouped native media adapter and 22 public tool schemas."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from ae_mcp import schemas
from ae_mcp.backends.native import (
    NativeBackendError,
    NativeCapabilities,
    NativeCapabilityDescriptor,
    NativeInvokeBackend,
    NativeInvokeRequest,
    NativeInvokeResult,
    NativeNegotiation,
    _capabilities_query_digest,
    _invoke_request_digest,
    _sha256_closed_json,
)
from ae_mcp.backends.native_media import (
    CAPABILITY_CONTRACTS,
    NATIVE_MEDIA_READ_CAPABILITY_ID,
    NATIVE_MEDIA_WRITE_CAPABILITY_ID,
    NativeMediaArguments,
    invoke_native_media_read,
    invoke_native_media_write,
)
from ae_mcp.handlers import HANDLERS, load_all


REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "native" / "ae-plugin" / "protocol" / "fixtures"
HOST = "22222222-2222-4222-8222-222222222222"
SESSION = "11111111-1111-4111-8111-111111111111"
PROJECT = "44444444-4444-4444-8444-444444444444"
LAYER = {
    "kind": "layer",
    "hostInstanceId": HOST,
    "sessionId": SESSION,
    "projectId": PROJECT,
    "generation": 8,
    "objectId": "88888888-8888-4888-8888-888888888888",
}
ITEM = {
    "kind": "item",
    "hostInstanceId": HOST,
    "sessionId": SESSION,
    "projectId": PROJECT,
    "generation": 8,
    "objectId": "99999999-9999-4999-8999-999999999999",
}
KEY = "native-media-test-0001"


def _fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def _negotiation() -> NativeNegotiation:
    raw = _fixture("hello.json")["response"]["result"]
    return NativeNegotiation(
        selected_wire_version=raw["selectedWireVersion"],
        plugin_version=raw["pluginVersion"],
        compiled_sdk_version=raw["compiledSdk"]["version"],
        source_commit="0" * 40,
        host_instance_id=raw["host"]["instanceId"],
        host_platform=raw["host"]["platform"],
        session_id=raw["sessionId"],
        session_generation=raw["sessionGeneration"],
        capabilities_digest=raw["capabilitiesDigest"],
    )


def _capabilities() -> NativeCapabilities:
    raw = _fixture("capabilities.json")["response"]
    result = raw["result"]
    return NativeCapabilities(
        session_id=raw["sessionId"],
        detail=result["detail"],
        items=tuple(
            NativeCapabilityDescriptor.model_validate(item)
            for item in result["items"]
        ),
        next_cursor=None,
        query_digest=_capabilities_query_digest(
            session_id=raw["sessionId"],
            ids=None,
            detail="full",
            limit=100,
        ),
        capabilities_digest=result["capabilitiesDigest"],
    )


class MediaBackend(NativeInvokeBackend):
    name = "native-media-fixture"

    def __init__(self, value: dict[str, Any]) -> None:
        self.negotiation = _negotiation()
        self.page = _capabilities()
        self.value = value
        self.request: NativeInvokeRequest | None = None

    async def negotiate(self, **_: Any) -> NativeNegotiation:
        return self.negotiation

    async def capabilities(self, **_: Any) -> NativeCapabilities:
        return self.page

    async def invoke(self, request: NativeInvokeRequest, **_: Any) -> NativeInvokeResult:
        self.request = request
        write = request.capability_id == NATIVE_MEDIA_WRITE_CAPABILITY_ID
        postcondition = _sha256_closed_json({
            "capabilityId": request.capability_id,
            "capabilityVersion": 1,
            "value": self.value,
        })
        evidence: dict[str, Any] = {
            "engine": "native-aegp",
            "hostInstanceId": HOST,
            "sessionId": SESSION,
            "requestId": request.request_id,
            "capabilityId": request.capability_id,
            "capabilityVersion": 1,
            "startedAtUnixMs": 1_900_000_000_000,
            "completedAtUnixMs": 1_900_000_000_025,
            "effect": "committed" if write else "none",
            "requestDigest": _invoke_request_digest(request, self.negotiation),
            "postcondition": {
                "verified": True,
                "kind": "native-media-write" if write else "native-media-read",
                "algorithm": "sha256-rfc8785-jcs-v1",
                "digest": postcondition,
            },
        }
        if write:
            evidence["undo"] = {
                "available": True,
                "verified": False,
                "groupId": None,
            }
        return NativeInvokeResult(
            capability_id=request.capability_id,
            capability_version=1,
            engine="native-aegp",
            outcome="succeeded",
            replayed=False,
            value=self.value,
            evidence=evidence,
        )

    async def cancel(self, target_request_id: str, *, deadline_unix_ms: int) -> object:
        return {"targetRequestId": target_request_id, "deadlineUnixMs": deadline_unix_ms}


PUBLIC_CASES = (
    ("ae.listInstalledEffects", "effects-installed-list", {"offset": 0, "limit": 50}),
    ("ae.listLayerEffects", "effects-layer-list", {"layer_locator": LAYER, "offset": 0, "limit": 50}),
    ("ae.getLayerEffectDetails", "effect-details", {"layer_locator": LAYER, "effect_index": 1, "installed_effect_key": 1}),
    ("ae.setLayerEffectEnabled", "effect-enabled", {"layer_locator": LAYER, "effect_index": 1, "installed_effect_key": 1, "enabled": False, "idempotency_key": KEY}),
    ("ae.reorderLayerEffect", "effect-reorder", {"layer_locator": LAYER, "effect_index": 1, "installed_effect_key": 1, "target_index": 2, "idempotency_key": KEY}),
    ("ae.duplicateLayerEffect", "effect-duplicate", {"layer_locator": LAYER, "effect_index": 1, "installed_effect_key": 1, "idempotency_key": KEY}),
    ("ae.deleteLayerEffect", "effect-delete", {"layer_locator": LAYER, "effect_index": 1, "installed_effect_key": 1, "idempotency_key": KEY}),
    ("ae.listLayerMasks", "masks-list", {"layer_locator": LAYER, "offset": 0, "limit": 50}),
    ("ae.getLayerMaskDetails", "mask-details", {"layer_locator": LAYER, "mask_index": 1, "mask_id": 7}),
    ("ae.getLayerMaskPath", "mask-path", {"layer_locator": LAYER, "mask_index": 1, "mask_id": 7}),
    ("ae.createLayerMask", "mask-create", {"layer_locator": LAYER, "idempotency_key": KEY}),
    ("ae.setLayerMaskProperties", "mask-properties", {"layer_locator": LAYER, "mask_index": 1, "mask_id": 7, "properties": {"mode": "add"}, "idempotency_key": KEY}),
    ("ae.setLayerMaskPath", "mask-path", {"layer_locator": LAYER, "mask_index": 1, "mask_id": 7, "closed": False, "vertices": [
        {"position": ["0", "0"], "in_tangent": ["0", "0"], "out_tangent": ["0", "0"]},
        {"position": ["100", "100"], "in_tangent": ["0", "0"], "out_tangent": ["0", "0"]},
    ], "idempotency_key": KEY}),
    ("ae.duplicateLayerMask", "mask-duplicate", {"layer_locator": LAYER, "mask_index": 1, "mask_id": 7, "target_index": 2, "idempotency_key": KEY}),
    ("ae.deleteLayerMask", "mask-delete", {"layer_locator": LAYER, "mask_index": 1, "mask_id": 7, "idempotency_key": KEY}),
    ("ae.getFootageDetails", "footage-details", {"item_locator": ITEM}),
    ("ae.importFootage", "footage-import", {"source_path": "/tmp/a.mov", "idempotency_key": KEY}),
    ("ae.replaceFootage", "footage-replace", {"item_locator": ITEM, "source_path": "/tmp/b.mov", "idempotency_key": KEY}),
    ("ae.getFootageInterpretation", "footage-interpretation", {"item_locator": ITEM, "proxy": False}),
    ("ae.setFootageInterpretation", "footage-interpretation", {"item_locator": ITEM, "proxy": False, "interpretation": {"loop_count": 2}, "idempotency_key": KEY}),
    ("ae.setFootageProxy", "footage-proxy", {"item_locator": ITEM, "source_path": "/tmp/proxy.mov", "idempotency_key": KEY}),
    ("ae.setItemUseProxy", "item-use-proxy", {"item_locator": ITEM, "enabled": True, "idempotency_key": KEY}),
)


@pytest.mark.parametrize(("name", "operation", "arguments"), PUBLIC_CASES)
def test_public_media_schemas_are_closed_and_registered(
    name: str,
    operation: str,
    arguments: dict[str, Any],
) -> None:
    schema = schemas.SCHEMAS[name]
    parsed = schema.model_validate(arguments)
    assert parsed.model_dump(mode="json", exclude_none=True)
    grouped = NativeMediaArguments.model_validate({
        "operation": operation,
        **parsed.model_dump(mode="json", exclude_none=True),
    })
    assert grouped.operation == operation
    with pytest.raises(ValidationError):
        schema.model_validate({**arguments, "unknown": True})
    load_all()
    assert HANDLERS[name][0] is schema


@pytest.mark.parametrize(
    ("schema", "arguments"),
    (
        (
            schemas.AeSetLayerMaskPropertiesArgs,
            {
                "layer_locator": LAYER,
                "mask_index": 1,
                "mask_id": 7,
                "properties": {"mode": None},
                "idempotency_key": KEY,
            },
        ),
        (
            schemas.AeSetFootageInterpretationArgs,
            {
                "item_locator": ITEM,
                "proxy": False,
                "interpretation": {"loop_count": None},
                "idempotency_key": KEY,
            },
        ),
    ),
)
def test_public_media_patches_reject_null_only_payloads(
    schema: type,
    arguments: dict[str, Any],
) -> None:
    with pytest.raises(ValidationError):
        schema.model_validate(arguments)


def test_grouped_media_contract_rejects_present_but_null_required_fields() -> None:
    with pytest.raises(ValidationError):
        NativeMediaArguments.model_validate({
            "operation": "effect-enabled",
            "layerLocator": LAYER,
            "effectIndex": 1,
            "installedEffectKey": 9,
            "enabled": None,
            "idempotencyKey": KEY,
        })


@pytest.mark.asyncio
async def test_native_media_read_verifies_descriptor_request_and_postcondition() -> None:
    value = {
        "operation": "effects-installed-list",
        "effects": [],
        "total": 0,
        "offset": 0,
        "limit": 50,
        "returned": 0,
        "hasMore": False,
        "nextOffset": None,
    }
    backend = MediaBackend(value)
    execution = await invoke_native_media_read(
        backend,
        request_id="media-read-1",
        arguments={"operation": "effects-installed-list", "offset": 0, "limit": 50},
        deadline_unix_ms=2_000_000_000_000,
    )
    assert execution.value.wire_payload() == value
    assert execution.implementation.contract_digest == CAPABILITY_CONTRACTS[
        NATIVE_MEDIA_READ_CAPABILITY_ID
    ].contract_digest
    assert backend.request is not None
    assert backend.request.arguments == {
        "operation": "effects-installed-list",
        "offset": 0,
        "limit": 50,
    }


@pytest.mark.asyncio
async def test_native_media_write_verifies_readback_and_undo_boundary() -> None:
    value = {
        "operation": "effect-enabled",
        "beforeEnabled": True,
        "afterEnabled": False,
        "changed": True,
        "effectIndex": 1,
        "installedEffectKey": 9,
    }
    backend = MediaBackend(value)
    execution = await invoke_native_media_write(
        backend,
        request_id="media-write-1",
        arguments={
            "operation": "effect-enabled",
            "layerLocator": LAYER,
            "effectIndex": 1,
            "installedEffectKey": 9,
            "enabled": False,
            "idempotencyKey": KEY,
        },
        deadline_unix_ms=2_000_000_000_000,
    )
    assert execution.value.after_enabled is False
    assert execution.evidence.undo is not None
    assert execution.evidence.undo.available is True
    assert execution.evidence.undo.verified is False


@pytest.mark.asyncio
async def test_native_media_write_preserves_side_effect_uncertainty_on_tampered_readback() -> None:
    backend = MediaBackend({
        "operation": "effect-enabled",
        "beforeEnabled": True,
        "afterEnabled": True,
        "changed": True,
        "effectIndex": 1,
        "installedEffectKey": 9,
    })
    with pytest.raises(NativeBackendError) as captured:
        await invoke_native_media_write(
            backend,
            request_id="media-write-bad",
            arguments={
                "operation": "effect-enabled",
                "layerLocator": LAYER,
                "effectIndex": 1,
                "installedEffectKey": 9,
                "enabled": False,
                "idempotencyKey": KEY,
            },
            deadline_unix_ms=2_000_000_000_000,
        )
    assert captured.value.code == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert captured.value.side_effect == "may-have-occurred"
