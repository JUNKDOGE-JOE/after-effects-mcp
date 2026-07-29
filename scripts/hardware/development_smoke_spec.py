"""Frozen executable contract for the bounded development real-AE smoke."""

from __future__ import annotations

SCENARIO_ID = "native-exec-ir@1"
CALL_HARD_LIMIT = 9
CALLS = (
    ("readiness", "ae_status"),
    ("fixture-create", "ae_exec"),
    ("locator-discovery", "ae_nativeExec"),
    ("baseline-native-state", "ae_nativeExec"),
    ("native-write", "ae_nativeExec"),
    ("changed-native-read", "ae_nativeExec"),
    ("undo-discovery", "ae_nativeExec"),
    ("undo-native-read", "ae_nativeExec"),
    ("invalid-native-program", "ae_nativeExec"),
)

FIXTURE_COMPOSITION_NAME = "HDEV Native EXEC Fixture"
FIXTURE_LAYER_NAME = "HDEV Native EXEC Layer"
BASELINE_TIME = {"value": 0, "scale": 1}
CHANGED_TIME = {"value": 5, "scale": 24}

assert len(CALLS) == CALL_HARD_LIMIT
assert len({key for key, _ in CALLS}) == CALL_HARD_LIMIT
assert {tool for _, tool in CALLS} == {"ae_status", "ae_exec", "ae_nativeExec"}
