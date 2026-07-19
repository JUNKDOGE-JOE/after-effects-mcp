"""Public MCP schema contract for the #155 layer timeline package."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from ae_mcp import schemas as S


HOST = "11111111-1111-4111-8111-111111111111"
SESSION = "22222222-2222-4222-8222-222222222222"
PROJECT = "33333333-3333-4333-8333-333333333333"


def locator(object_id: str = "44444444-4444-4444-8444-444444444444") -> dict:
    return {
        "kind": "layer",
        "hostInstanceId": HOST,
        "sessionId": SESSION,
        "projectId": PROJECT,
        "generation": 7,
        "objectId": object_id,
    }


def test_layer_read_and_name_write_are_closed_and_locator_bound():
    assert S.AeGetLayerDetailsArgs(layer_locator=locator()).layer_locator.kind == "layer"
    renamed = S.AeRenameLayerArgs(
        layer_locator=locator(),
        name="Subject Hero",
        idempotency_key="issue155.rename.01",
    )
    assert renamed.name == "Subject Hero"
    with pytest.raises(ValidationError):
        S.AeGetLayerDetailsArgs(layer_locator=locator(), guessed_name="Subject")
    with pytest.raises(ValidationError):
        S.AeRenameLayerArgs(
            layer_locator=locator(), name="\x00", idempotency_key="issue155.rename.02"
        )


def test_layer_exact_time_writes_require_positive_duration():
    value = S.AeSetLayerRangeArgs(
        layer_locator=locator(),
        in_point={"value": -12, "scale": 24},
        duration={"value": 120, "scale": 24},
        idempotency_key="issue155.range.01",
    )
    assert value.in_point.value == -12
    assert value.duration.value == 120
    with pytest.raises(ValidationError):
        S.AeSetLayerRangeArgs(
            layer_locator=locator(),
            in_point={"value": 0, "scale": 24},
            duration={"value": 0, "scale": 24},
            idempotency_key="issue155.range.02",
        )
    assert S.AeSetLayerStartTimeArgs(
        layer_locator=locator(),
        start_time={"value": -48, "scale": 24},
        idempotency_key="issue155.start.01",
    ).start_time.value == -48


@pytest.mark.parametrize("percent", ["100", "150.5", "-50", "9900", "-9900.000000"])
def test_layer_stretch_accepts_bounded_exact_decimal(percent: str):
    assert S.AeSetLayerStretchArgs(
        layer_locator=locator(),
        stretch_percent=percent,
        idempotency_key="issue155.stretch.01",
    ).stretch_percent == percent


@pytest.mark.parametrize("percent", ["0", "0.0", "9900.1", "-9901", "NaN", "1e2"])
def test_layer_stretch_rejects_zero_out_of_range_or_ambiguous_decimal(percent: str):
    with pytest.raises(ValidationError):
        S.AeSetLayerStretchArgs(
            layer_locator=locator(),
            stretch_percent=percent,
            idempotency_key="issue155.stretch.02",
        )


def test_layer_stretch_rejects_in_range_decimal_that_cannot_fit_aegp_ratio():
    with pytest.raises(ValidationError, match="signed 32-bit AEGP ratio"):
        S.AeSetLayerStretchArgs(
            layer_locator=locator(),
            stretch_percent="9899.999999",
            idempotency_key="issue155.stretch.03",
        )
    assert S.AeSetLayerStretchArgs(
        layer_locator=locator(),
        stretch_percent="2147.483647",
        idempotency_key="issue155.stretch.04",
    ).stretch_percent == "2147.483647"


def test_layer_parent_requires_same_fresh_context_and_not_self():
    parent_id = "55555555-5555-4555-8555-555555555555"
    request = S.AeSetLayerParentArgs(
        layer_locator=locator(),
        parent_layer_locator=locator(parent_id),
        idempotency_key="issue155.parent.01",
    )
    assert request.parent_layer_locator is not None
    assert S.AeSetLayerParentArgs(
        layer_locator=locator(),
        parent_layer_locator=None,
        idempotency_key="issue155.parent.02",
    ).parent_layer_locator is None
    with pytest.raises(ValidationError):
        S.AeSetLayerParentArgs(
            layer_locator=locator(),
            parent_layer_locator=locator(),
            idempotency_key="issue155.parent.03",
        )
    wrong = locator(parent_id)
    wrong["sessionId"] = "66666666-6666-4666-8666-666666666666"
    with pytest.raises(ValidationError):
        S.AeSetLayerParentArgs(
            layer_locator=locator(),
            parent_layer_locator=wrong,
            idempotency_key="issue155.parent.04",
        )


def test_layer_reorder_and_duplicate_require_explicit_intent():
    assert S.AeReorderLayerArgs(
        layer_locator=locator(),
        target_stack_index=2,
        idempotency_key="issue155.order.01",
    ).target_stack_index == 2
    duplicate = S.AeDuplicateLayerArgs(
        layer_locator=locator(),
        new_name="Subject Copy",
        idempotency_key="issue155.duplicate.01",
    )
    assert duplicate.new_name == "Subject Copy"
    with pytest.raises(ValidationError):
        S.AeDuplicateLayerArgs(
            layer_locator=locator(),
            idempotency_key="issue155.duplicate.02",
        )
