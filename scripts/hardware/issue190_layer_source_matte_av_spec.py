"""Frozen 40-call Issue #190 non-candidate development-smoke contract."""

from __future__ import annotations

import dataclasses
from collections.abc import Mapping, Sequence
from typing import Any, Literal


SCENARIO_ID = "issue190-layer-source-matte-av@1"
CALL_HARD_LIMIT = 40
FIXTURE_COMPOSITION = "ISSUE190_MAIN"
CROSS_COMPOSITION_LAYER = "CROSS_COMP_MATTE"
INVALID_SOURCE_TARGET = "INVALID_SOURCE_TARGET"

FIXTURE_SPEC = {
    "lifecycle": "ephemeral-validation",
    "activeSlots": 1,
    "saveAsCopies": 0,
    "freshPerRun": True,
    "canonicalActiveRoot": (
        "$HOME/Library/Application Support/AfterEffectsMCP/fixtures/active"
    ),
    "ownershipManifest": "O_EXCL run-bound development-only JSON",
    "failureDisposition": "classified short-lived recovery or evidence snapshot",
    "roles": (
        "SOURCE_COMP_A",
        "SOURCE_COMP_B",
        "RELINK_TARGET",
        "MATTE_FILL",
        "MATTE_SOURCE",
        "MATTE_SPACER",
        "VIDEO_SWITCH",
        "AUDIO_SWITCH",
    ),
}

WAV_SPEC = {
    "channels": 1,
    "sampleWidthBytes": 2,
    "sampleRateHz": 8000,
    "frameCount": 2000,
    "personalData": False,
}

FIXTURE_RECIPE = (
    "Derive one fresh per-run ephemeral-validation path beneath the canonical active root outside the checkout and Adobe scan roots.",
    "Create an exclusive run-bound ownership manifest before generating the deterministic short PCM WAV.",
    "Run fail-closed harness-only ExtendScript: block every unowned saved or nonempty untitled project and never overwrite an existing target.",
    "All source, Track Matte, AV, reorder, and readback product operations use public MCP tools.",
    "After initial naming, save only in place and never use Save As.",
    "After success or failure, close only the owned project and archive the fixture, manifest, and WAV to classified recovery.",
)

SOURCE_OPERATION_KEY = "$operation_key:source-replace"
MATTE_ALPHA_OPERATION_KEY = "$operation_key:matte-alpha"
MATTE_LUMA_OPERATION_KEY = "$operation_key:matte-luma"
MATTE_CLEAR_OPERATION_KEY = "$operation_key:matte-clear"
AUDIO_OPERATION_KEY = "$operation_key:audio-disable"
VIDEO_OPERATION_KEY = "$operation_key:video-disable"
REORDER_OPERATION_KEY = "$operation_key:matte-reorder"


@dataclasses.dataclass(frozen=True)
class PlanCall:
    ordinal: int
    key: str
    case: str
    tool: str
    arguments: Mapping[str, Any]
    disposition: Literal["read", "write"]
    predicate: str
    expected_error: str | None = None
    undo_checkpoint: str | None = None


def _call(
    key: str,
    case: str,
    tool: str,
    arguments: Mapping[str, Any],
    disposition: Literal["read", "write"],
    predicate: str,
    *,
    expected_error: str | None = None,
    undo_checkpoint: str | None = None,
) -> PlanCall:
    return PlanCall(
        ordinal=0,
        key=key,
        case=case,
        tool=tool,
        arguments=arguments,
        disposition=disposition,
        predicate=predicate,
        expected_error=expected_error,
        undo_checkpoint=undo_checkpoint,
    )


_ROWS = (
    _call(
        "fixture-project-items",
        "fixture",
        "ae_listProjectItems",
        {"offset": 0, "limit": 50},
        "read",
        "Acquire the one main composition and exact SOURCE_COMP_A/B project items.",
    ),
    _call(
        "fixture-main-layers",
        "fixture",
        "ae_listCompositionLayers",
        {"composition_locator": "$main_composition_locator", "offset": 0, "limit": 25},
        "read",
        "Acquire every exact main-composition role and record baseline stack order.",
    ),
    _call(
        "fixture-cross-composition-layers",
        "fixture",
        "ae_listCompositionLayers",
        {"composition_locator": "$source_comp_b_locator", "offset": 0, "limit": 25},
        "read",
        "Acquire CROSS_COMP_MATTE from SOURCE_COMP_B for the structured negative.",
    ),
    _call(
        "source-read-a",
        "source",
        "ae_getLayerSource",
        {"layer_locator": "$relink_target_locator"},
        "read",
        "RELINK_TARGET source is SOURCE_COMP_A.",
    ),
    _call(
        "source-transform-before",
        "source",
        "ae_getLayerTransform",
        {"layer_locator": "$relink_target_locator"},
        "read",
        "Capture the harness-created keyed Position witness at composition time zero.",
    ),
    _call(
        "source-replace-a-to-b",
        "source",
        "ae_setLayerSource",
        {
            "layer_locator": "$relink_target_locator",
            "source_item_locator": "$source_comp_b_locator",
            "idempotency_key": SOURCE_OPERATION_KEY,
        },
        "write",
        "Replace SOURCE_COMP_A with SOURCE_COMP_B and preserve the closed invariant snapshot.",
    ),
    _call(
        "source-replace-completed-replay",
        "source-replay",
        "ae_setLayerSource",
        {
            "layer_locator": "$source_original_layer_locator",
            "source_item_locator": "$source_original_b_locator",
            "idempotency_key": SOURCE_OPERATION_KEY,
        },
        "write",
        "Completed-key replay returns the recorded operation without another AE dispatch.",
    ),
    _call(
        "source-reacquire-project",
        "source",
        "ae_listProjectItems",
        {"offset": 0, "limit": 50},
        "read",
        "After maintained JSX invalidates the graph, reacquire project and composition locators.",
    ),
    _call(
        "source-reacquire-layers",
        "source",
        "ae_listCompositionLayers",
        {"composition_locator": "$main_composition_locator", "offset": 0, "limit": 25},
        "read",
        "After source replacement, reacquire every layer locator.",
    ),
    _call(
        "source-read-b",
        "source",
        "ae_getLayerSource",
        {"layer_locator": "$relink_target_locator"},
        "read",
        "Fresh source read returns SOURCE_COMP_B.",
    ),
    _call(
        "source-transform-after",
        "source",
        "ae_getLayerTransform",
        {"layer_locator": "$relink_target_locator"},
        "read",
        "The keyed Position witness equals its exact pre-replacement public projection.",
    ),
    _call(
        "source-undo-reacquire-project",
        "source",
        "ae_listProjectItems",
        {"offset": 0, "limit": 50},
        "read",
        "Execute one real source Undo, then reacquire project and composition locators.",
        undo_checkpoint="undo-source-replace",
    ),
    _call(
        "source-undo-reacquire-layers",
        "source",
        "ae_listCompositionLayers",
        {"composition_locator": "$main_composition_locator", "offset": 0, "limit": 25},
        "read",
        "After source Undo, reacquire every layer locator.",
    ),
    _call(
        "source-undo-read-a",
        "source",
        "ae_getLayerSource",
        {"layer_locator": "$relink_target_locator"},
        "read",
        "Real Undo restores SOURCE_COMP_A.",
    ),
    _call(
        "matte-read-empty",
        "matte-set",
        "ae_getLayerTrackMatte",
        {"layer_locator": "$matte_fill_locator"},
        "read",
        "MATTE_FILL begins without an active Track Matte relationship.",
    ),
    _call(
        "matte-set-alpha",
        "matte-set",
        "ae_setLayerTrackMatte",
        {
            "layer_locator": "$matte_fill_locator",
            "matte_layer_locator": "$matte_source_locator",
            "mode": "alpha",
            "idempotency_key": MATTE_ALPHA_OPERATION_KEY,
        },
        "write",
        "Set non-adjacent MATTE_SOURCE as Alpha Matte.",
    ),
    _call(
        "matte-read-alpha",
        "matte-set",
        "ae_getLayerTrackMatte",
        {"layer_locator": "$matte_fill_locator"},
        "read",
        "Independent read returns exact MATTE_SOURCE and alpha mode.",
    ),
    _call(
        "matte-reorder-source",
        "matte-reorder",
        "ae_reorderLayer",
        {
            "layer_locator": "$matte_source_locator",
            "target_stack_index": "$matte_reorder_target_index",
            "idempotency_key": REORDER_OPERATION_KEY,
        },
        "write",
        "Move MATTE_SOURCE across MATTE_SPACER without changing the relationship.",
    ),
    _call(
        "matte-read-after-reorder",
        "matte-reorder",
        "ae_getLayerTrackMatte",
        {"layer_locator": "$matte_fill_locator"},
        "read",
        "Track Matte remains MATTE_SOURCE alpha after stack-order change.",
    ),
    _call(
        "matte-set-undo-reacquire-layers",
        "matte-set",
        "ae_listCompositionLayers",
        {"composition_locator": "$main_composition_locator", "offset": 0, "limit": 25},
        "read",
        "Undo support reorder then Alpha set; reacquire all role locators and baseline order.",
        undo_checkpoint="undo-matte-reorder-and-set",
    ),
    _call(
        "matte-set-undo-read-empty",
        "matte-set",
        "ae_getLayerTrackMatte",
        {"layer_locator": "$matte_fill_locator"},
        "read",
        "Real Matte-set Undo restores no active relationship.",
    ),
    _call(
        "matte-set-luma",
        "matte-clear",
        "ae_setLayerTrackMatte",
        {
            "layer_locator": "$matte_fill_locator",
            "matte_layer_locator": "$matte_source_locator",
            "mode": "luma",
            "idempotency_key": MATTE_LUMA_OPERATION_KEY,
        },
        "write",
        "Prepare an exact Luma relationship for clear.",
    ),
    _call(
        "matte-read-luma",
        "matte-clear",
        "ae_getLayerTrackMatte",
        {"layer_locator": "$matte_fill_locator"},
        "read",
        "Independent read proves active MATTE_SOURCE luma before clear.",
    ),
    _call(
        "matte-clear",
        "matte-clear",
        "ae_clearLayerTrackMatte",
        {
            "layer_locator": "$matte_fill_locator",
            "idempotency_key": MATTE_CLEAR_OPERATION_KEY,
        },
        "write",
        "Clear the relationship while preserving stored luma mode.",
    ),
    _call(
        "matte-read-cleared-luma",
        "matte-clear",
        "ae_getLayerTrackMatte",
        {"layer_locator": "$matte_fill_locator"},
        "read",
        "Independent read is inactive with null Matte and stored luma mode.",
    ),
    _call(
        "matte-clear-undo-reacquire-layers",
        "matte-clear",
        "ae_listCompositionLayers",
        {"composition_locator": "$main_composition_locator", "offset": 0, "limit": 25},
        "read",
        "Execute one real clear Undo and reacquire all role locators.",
        undo_checkpoint="undo-matte-clear",
    ),
    _call(
        "matte-clear-undo-read-luma",
        "matte-clear",
        "ae_getLayerTrackMatte",
        {"layer_locator": "$matte_fill_locator"},
        "read",
        "Real clear Undo restores exact MATTE_SOURCE and luma mode.",
    ),
    _call(
        "audio-disable",
        "audio",
        "ae_setLayerAudioEnabled",
        {
            "layer_locator": "$audio_switch_locator",
            "enabled": False,
            "idempotency_key": AUDIO_OPERATION_KEY,
        },
        "write",
        "AUDIO_SWITCH reports hasAudio true and changes only audioEnabled true to false.",
    ),
    _call(
        "audio-disable-read",
        "audio",
        "ae_getLayerAVState",
        {"layer_locator": "$audio_switch_locator"},
        "read",
        "Independent AV read returns audioEnabled false.",
    ),
    _call(
        "audio-undo-reacquire-layers",
        "audio",
        "ae_listCompositionLayers",
        {"composition_locator": "$main_composition_locator", "offset": 0, "limit": 25},
        "read",
        "Execute one real audio Undo and reacquire all role locators.",
        undo_checkpoint="undo-audio-disable",
    ),
    _call(
        "audio-undo-read",
        "audio",
        "ae_getLayerAVState",
        {"layer_locator": "$audio_switch_locator"},
        "read",
        "Real audio Undo restores audioEnabled true.",
    ),
    _call(
        "video-disable",
        "video",
        "ae_setLayerVideoEnabled",
        {
            "layer_locator": "$video_switch_locator",
            "enabled": False,
            "idempotency_key": VIDEO_OPERATION_KEY,
        },
        "write",
        "VIDEO_SWITCH reports hasVideo true and changes only videoEnabled true to false.",
    ),
    _call(
        "video-disable-read",
        "video",
        "ae_getLayerAVState",
        {"layer_locator": "$video_switch_locator"},
        "read",
        "Independent AV read returns videoEnabled false.",
    ),
    _call(
        "video-undo-reacquire-layers",
        "video",
        "ae_listCompositionLayers",
        {"composition_locator": "$main_composition_locator", "offset": 0, "limit": 25},
        "read",
        "Execute one real video Undo and reacquire all role locators.",
        undo_checkpoint="undo-video-disable",
    ),
    _call(
        "video-undo-read",
        "video",
        "ae_getLayerAVState",
        {"layer_locator": "$video_switch_locator"},
        "read",
        "Real video Undo restores videoEnabled true.",
    ),
    _call(
        "negative-cross-composition-matte",
        "negative-cross-composition-matte",
        "ae_setLayerTrackMatte",
        {
            "layer_locator": "$matte_fill_locator",
            "matte_layer_locator": "$cross_comp_matte_locator",
            "mode": "alpha",
            "idempotency_key": "$operation_key:negative-cross-comp",
        },
        "write",
        "Different-composition Matte is rejected before Undo opens.",
        expected_error="TRACK_MATTE_COMPOSITION_MISMATCH",
    ),
    _call(
        "negative-self-matte",
        "negative-self-matte",
        "ae_setLayerTrackMatte",
        {
            "layer_locator": "$matte_fill_locator",
            "matte_layer_locator": "$matte_fill_locator",
            "mode": "alpha",
            "idempotency_key": "$operation_key:negative-self-matte",
        },
        "write",
        "Self Matte is rejected with zero write.",
        expected_error="INVALID_ARGUMENT",
    ),
    _call(
        "negative-invalid-source-target",
        "negative-invalid-source-target",
        "ae_setLayerSource",
        {
            "layer_locator": "$invalid_source_target_locator",
            "source_item_locator": "$source_comp_b_locator",
            "idempotency_key": "$operation_key:negative-invalid-source",
        },
        "write",
        "Text target is rejected before maintained /exec.",
        expected_error="LAYER_SOURCE_NOT_REPLACEABLE",
    ),
    _call(
        "negative-no-audio",
        "negative-no-audio",
        "ae_setLayerAudioEnabled",
        {
            "layer_locator": "$matte_fill_locator",
            "enabled": True,
            "idempotency_key": "$operation_key:negative-no-audio",
        },
        "write",
        "Solid source without audio rejects enable before native dispatch.",
        expected_error="LAYER_HAS_NO_AUDIO",
    ),
    _call(
        "negative-no-video",
        "negative-no-video",
        "ae_setLayerVideoEnabled",
        {
            "layer_locator": "$audio_switch_locator",
            "enabled": True,
            "idempotency_key": "$operation_key:negative-no-video",
        },
        "write",
        "Audio-only source rejects video enable before native dispatch.",
        expected_error="LAYER_HAS_NO_VIDEO",
    ),
)

CALL_PLAN = tuple(
    dataclasses.replace(row, ordinal=index)
    for index, row in enumerate(_ROWS, 1)
)

REQUIRED_PUBLIC_TOOLS = frozenset(row.tool for row in CALL_PLAN)

PUBLIC_READBACK_PREDICATES = {
    row.key: {"assertion": row.predicate}
    for row in CALL_PLAN
    if row.disposition == "read"
}
PUBLIC_READBACK_PREDICATES.update(
    {
        "source-read-a": {"sourceName": "SOURCE_COMP_A"},
        "source-replace-a-to-b": {"invariantsEqual": True},
        "source-read-b": {"sourceName": "SOURCE_COMP_B"},
        "source-transform-after": {"equals": "source-transform-before"},
        "source-undo-read-a": {"sourceName": "SOURCE_COMP_A"},
        "matte-read-empty": {"active": False, "matteRole": None},
        "matte-read-alpha": {
            "active": True,
            "matteRole": "MATTE_SOURCE",
            "mode": "alpha",
        },
        "matte-read-after-reorder": {
            "active": True,
            "matteRole": "MATTE_SOURCE",
            "mode": "alpha",
            "stackOrderChanged": True,
        },
        "matte-set-undo-read-empty": {"active": False, "matteRole": None},
        "matte-read-luma": {
            "active": True,
            "matteRole": "MATTE_SOURCE",
            "mode": "luma",
        },
        "matte-read-cleared-luma": {
            "active": False,
            "matteRole": None,
            "mode": "luma",
        },
        "matte-clear-undo-read-luma": {
            "active": True,
            "matteRole": "MATTE_SOURCE",
            "mode": "luma",
        },
        "audio-disable-read": {"hasAudio": True, "audioEnabled": False},
        "audio-undo-read": {"hasAudio": True, "audioEnabled": True},
        "video-disable-read": {"hasVideo": True, "videoEnabled": False},
        "video-undo-read": {"hasVideo": True, "videoEnabled": True},
    }
)

# Dependencies are deliberately narrow. A source failure blocks only source
# verification/replay; Matte failures block only their dependent cleanup.
# Independent AV and negative cases remain eligible while the fixture baseline
# is trustworthy.
CASE_DEPENDENCIES = {
    "source": ("source-replay",),
    "matte-set": ("matte-reorder", "matte-clear"),
    "audio": (),
    "video": (),
}

IMMEDIATE_STOP_REASONS = frozenset(
    {
        "unreconciled-possible-write",
        "uncertain-negative-write",
        "fixture-baseline-lost",
        "incompatible-component-or-protocol",
        "after-effects-crash-or-corruption",
    }
)


def locator_reacquisition_violations(
    plan: Sequence[PlanCall],
) -> tuple[str, ...]:
    """Return missing public locator fences after graph invalidation and Undo."""

    keys = [row.key for row in plan]
    positions = {key: index for index, key in enumerate(keys)}
    violations: list[str] = []
    source_chain = (
        "source-replace-a-to-b",
        "source-replace-completed-replay",
        "source-reacquire-project",
        "source-reacquire-layers",
        "source-read-b",
    )
    if not all(key in positions for key in source_chain) or not all(
        positions[left] < positions[right]
        for left, right in zip(source_chain, source_chain[1:])
    ):
        violations.append("source-replacement-public-reacquisition")
    undo_fences = {
        "source-undo-reacquire-project": "source-undo-read-a",
        "matte-set-undo-reacquire-layers": "matte-set-undo-read-empty",
        "matte-clear-undo-reacquire-layers": "matte-clear-undo-read-luma",
        "audio-undo-reacquire-layers": "audio-undo-read",
        "video-undo-reacquire-layers": "video-undo-read",
    }
    for fence, verification in undo_fences.items():
        if (
            fence not in positions
            or verification not in positions
            or positions[fence] >= positions[verification]
        ):
            violations.append(f"{fence}-before-{verification}")
    return tuple(violations)


assert len(CALL_PLAN) == CALL_HARD_LIMIT
assert len({row.key for row in CALL_PLAN}) == CALL_HARD_LIMIT
assert locator_reacquisition_violations(CALL_PLAN) == ()
