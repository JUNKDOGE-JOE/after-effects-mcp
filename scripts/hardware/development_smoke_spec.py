"""Frozen executable contract for the bounded development real-AE smoke."""

from __future__ import annotations

SCENARIO_ID = "core-native-write-undo@1"
CALL_HARD_LIMIT = 7
CALLS = (
    ("readiness", "ae_projectSummary"),
    ("composition-create", "ae_createComposition"),
    ("baseline-settings", "ae_getCompositionSettings"),
    ("background-set", "ae_setCompositionBackgroundColor"),
    ("changed-settings", "ae_getCompositionSettings"),
    ("undo-reacquire", "ae_listProjectItems"),
    ("undo-settings", "ae_getCompositionSettings"),
)

# AEGP_CreateComp exposes no background-colour input. Its deterministic new-comp
# background is opaque black; the first typed settings read is the independent
# proof before the bounded setter changes it.
BASELINE_COLOR = {"red": 0, "green": 0, "blue": 0, "alpha": 255}
CHANGED_COLOR = {"red": 64, "green": 96, "blue": 128, "alpha": 255}

assert len(CALLS) == CALL_HARD_LIMIT
assert len({key for key, _ in CALLS}) == CALL_HARD_LIMIT
assert len({tool for _, tool in CALLS}) == 5
