"""Public argument and metadata boundary for the #190 layer capability package."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import BaseModel, ValidationError

from ae_mcp import schemas
from ae_mcp.annotations import VERB_ANNOTATIONS


HOST = "22222222-2222-4222-8222-222222222222"
SESSION = "11111111-1111-4111-8111-111111111111"
PROJECT = "44444444-4444-4444-8444-444444444444"
GENERATION = 3
LAYER = "77777777-7777-4777-8777-777777777777"
MATTE_LAYER = "88888888-8888-4888-8888-888888888888"
ITEM = "99999999-9999-4999-8999-999999999999"


HANDLER_MODELS = {
    "ae.layer.source.read": "AeGetLayerSourceArgs",
    "ae.layer.source.set": "AeSetLayerSourceArgs",
    "ae.layer.track-matte.read": "AeGetLayerTrackMatteArgs",
    "ae.layer.track-matte.set": "AeSetLayerTrackMatteArgs",
    "ae.layer.track-matte.clear": "AeClearLayerTrackMatteArgs",
    "ae.layer.av-state.read": "AeGetLayerAVStateArgs",
    "ae.layer.audio-enabled.set": "AeSetLayerAudioEnabledArgs",
    "ae.layer.video-enabled.set": "AeSetLayerVideoEnabledArgs",
}

PUBLIC_VERBS = {
    "ae.layer.source.read": "ae.getLayerSource",
    "ae.layer.source.set": "ae.setLayerSource",
    "ae.layer.track-matte.read": "ae.getLayerTrackMatte",
    "ae.layer.track-matte.set": "ae.setLayerTrackMatte",
    "ae.layer.track-matte.clear": "ae.clearLayerTrackMatte",
    "ae.layer.av-state.read": "ae.getLayerAVState",
    "ae.layer.audio-enabled.set": "ae.setLayerAudioEnabled",
    "ae.layer.video-enabled.set": "ae.setLayerVideoEnabled",
}


def _layer(*, object_id: str = LAYER, session_id: str = SESSION) -> dict[str, Any]:
    return {
        "kind": "layer",
        "hostInstanceId": HOST,
        "sessionId": session_id,
        "projectId": PROJECT,
        "generation": GENERATION,
        "objectId": object_id,
    }


def _item(*, kind: str = "item", session_id: str = SESSION) -> dict[str, Any]:
    return {
        "kind": kind,
        "hostInstanceId": HOST,
        "sessionId": session_id,
        "projectId": PROJECT,
        "generation": GENERATION,
        "objectId": ITEM,
    }


def _valid_inputs() -> dict[type[BaseModel], dict[str, Any]]:
    return {
        schemas.AeGetLayerSourceArgs: {"layer_locator": _layer()},
        schemas.AeSetLayerSourceArgs: {
            "layer_locator": _layer(),
            "source_item_locator": _item(),
            "idempotency_key": "source-intent-0001",
        },
        schemas.AeGetLayerTrackMatteArgs: {"layer_locator": _layer()},
        schemas.AeSetLayerTrackMatteArgs: {
            "layer_locator": _layer(),
            "matte_layer_locator": _layer(object_id=MATTE_LAYER),
            "mode": "alpha",
            "idempotency_key": "matte-intent-0001",
        },
        schemas.AeClearLayerTrackMatteArgs: {
            "layer_locator": _layer(),
            "idempotency_key": "clear-matte-0001",
        },
        schemas.AeGetLayerAVStateArgs: {"layer_locator": _layer()},
        schemas.AeSetLayerAudioEnabledArgs: {
            "layer_locator": _layer(),
            "enabled": True,
            "idempotency_key": "audio-intent-0001",
        },
        schemas.AeSetLayerVideoEnabledArgs: {
            "layer_locator": _layer(),
            "enabled": False,
            "idempotency_key": "video-intent-0001",
        },
    }


def test_handler_schema_registry_exposes_the_eight_closed_capabilities():
    assert set(schemas.HANDLER_SCHEMAS) == set(HANDLER_MODELS)
    for handler_name, model_name in HANDLER_MODELS.items():
        assert schemas.HANDLER_SCHEMAS[handler_name] is getattr(schemas, model_name)


@pytest.mark.parametrize("model_name", HANDLER_MODELS.values())
def test_every_layer_locator_rejects_a_non_layer_locator(model_name: str):
    model = getattr(schemas, model_name)
    payload = _valid_inputs()[model]
    with pytest.raises(ValidationError):
        model.model_validate({**payload, "layer_locator": _item()})


def test_source_and_matte_writes_reject_obvious_locator_context_mismatches():
    with pytest.raises(ValidationError, match="source_item_locator must match layer_locator context"):
        schemas.AeSetLayerSourceArgs.model_validate({
            **_valid_inputs()[schemas.AeSetLayerSourceArgs],
            "source_item_locator": _item(session_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        })
    with pytest.raises(ValidationError, match="matte_layer_locator must match layer_locator context"):
        schemas.AeSetLayerTrackMatteArgs.model_validate({
            **_valid_inputs()[schemas.AeSetLayerTrackMatteArgs],
            "matte_layer_locator": _layer(
                object_id=MATTE_LAYER,
                session_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            ),
        })


@pytest.mark.parametrize("kind", ["item", "composition"])
def test_set_layer_source_accepts_only_project_item_or_composition_locators(kind: str):
    args = schemas.AeSetLayerSourceArgs.model_validate({
        **_valid_inputs()[schemas.AeSetLayerSourceArgs],
        "source_item_locator": _item(kind=kind),
    })
    assert args.source_item_locator.kind == kind


def test_set_layer_source_rejects_a_layer_as_its_source_item():
    with pytest.raises(ValidationError):
        schemas.AeSetLayerSourceArgs.model_validate({
            **_valid_inputs()[schemas.AeSetLayerSourceArgs],
            "source_item_locator": _layer(),
        })


@pytest.mark.parametrize("mode", ["alpha", "inverted-alpha", "luma", "inverted-luma"])
def test_set_track_matte_accepts_each_explicit_modern_mode(mode: str):
    args = schemas.AeSetLayerTrackMatteArgs.model_validate({
        **_valid_inputs()[schemas.AeSetLayerTrackMatteArgs],
        "mode": mode,
    })
    assert args.mode == mode


@pytest.mark.parametrize("mode", ["none", "alpha-inverted", "legacy"])
def test_set_track_matte_rejects_non_settable_modes(mode: str):
    with pytest.raises(ValidationError):
        schemas.AeSetLayerTrackMatteArgs.model_validate({
            **_valid_inputs()[schemas.AeSetLayerTrackMatteArgs],
            "mode": mode,
        })


def test_set_track_matte_rejects_the_fill_layer_as_its_own_matte():
    with pytest.raises(ValidationError, match="a layer cannot be its own track matte"):
        schemas.AeSetLayerTrackMatteArgs.model_validate({
            **_valid_inputs()[schemas.AeSetLayerTrackMatteArgs],
            "matte_layer_locator": _layer(),
        })


@pytest.mark.parametrize(
    "model",
    [schemas.AeSetLayerAudioEnabledArgs, schemas.AeSetLayerVideoEnabledArgs],
)
@pytest.mark.parametrize("enabled", [1, "true", 0])
def test_av_switch_writes_require_a_strict_boolean(model: type[BaseModel], enabled: object):
    with pytest.raises(ValidationError):
        model.model_validate({**_valid_inputs()[model], "enabled": enabled})


@pytest.mark.parametrize(
    "model",
    [schemas.AeSetLayerAudioEnabledArgs, schemas.AeSetLayerVideoEnabledArgs],
)
@pytest.mark.parametrize("idempotency_key", ["short", "invalid key with spaces"])
def test_av_switch_writes_require_a_stable_idempotency_key(
    model: type[BaseModel], idempotency_key: str,
):
    with pytest.raises(ValidationError):
        model.model_validate({**_valid_inputs()[model], "idempotency_key": idempotency_key})


@pytest.mark.parametrize("model", HANDLER_MODELS.values())
def test_every_layer_source_matte_av_model_forbids_unknown_fields(model: str):
    schema = getattr(schemas, model)
    with pytest.raises(ValidationError):
        schema.model_validate({**_valid_inputs()[schema], "unexpected": True})


def test_annotations_express_read_only_reads_and_idempotent_non_destructive_writes():
    read_handlers = {
        "ae.layer.source.read",
        "ae.layer.track-matte.read",
        "ae.layer.av-state.read",
    }
    for handler_name, verb in PUBLIC_VERBS.items():
        annotation = VERB_ANNOTATIONS[verb]
        assert annotation.idempotentHint is True
        assert annotation.destructiveHint is False
        assert annotation.readOnlyHint is (handler_name in read_handlers)
