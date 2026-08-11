"""Frozen six-call contract for the Windows Native EXEC development HDEV."""

from __future__ import annotations

import copy
import dataclasses
from collections.abc import Mapping
from typing import Any


SCENARIO_ID = "issue86-windows-native-exec-hdev@1"
CALL_HARD_LIMIT = 6
FIXTURE_COMPOSITION_NAME = "Issue 86 Windows Native EXEC Fixture"
FIXTURE_LAYER_NAME = "Issue 86 Windows Native EXEC Layer"
FIXTURE_WIDTH = 640
FIXTURE_HEIGHT = 360
FIXTURE_FRAME_RATE = 24
READ_PRIMITIVES = frozenset({
    "project.items.list",
    "composition.resolve",
    "composition.settings.read",
    "composition.layers.list",
})


@dataclasses.dataclass(frozen=True)
class PlanCall:
    ordinal: int
    key: str
    phase: str
    tool: str
    request_disposition: str = "read-only"


CALL_PLAN = (
    PlanCall(1, "pre-status", "before-restart", "ae_status"),
    PlanCall(2, "pre-list", "before-restart", "ae_nativeExec"),
    PlanCall(3, "pre-read", "before-restart", "ae_nativeExec"),
    PlanCall(4, "post-status", "after-restart", "ae_status"),
    PlanCall(5, "post-list", "after-restart", "ae_nativeExec"),
    PlanCall(6, "post-read", "after-restart", "ae_nativeExec"),
)


def status_arguments() -> dict[str, Any]:
    return {}


def list_arguments() -> dict[str, Any]:
    return {
        "operations": [
            {
                "op": "project.items.list",
                "args": {"offset": 0, "limit": 50},
                "returnAs": "items",
            }
        ]
    }


def read_arguments(locator: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "operations": [
            {
                "op": "composition.resolve",
                "args": {"locator": copy.deepcopy(dict(locator))},
                "saveAs": "composition",
            },
            {
                "op": "composition.settings.read",
                "args": {"composition": {"ref": "composition"}},
                "returnAs": "settings",
            },
            {
                "op": "composition.layers.list",
                "args": {
                    "composition": {"ref": "composition"},
                    "offset": 0,
                    "limit": 25,
                },
                "returnAs": "layers",
            },
        ]
    }


assert len(CALL_PLAN) == CALL_HARD_LIMIT
assert tuple(row.ordinal for row in CALL_PLAN) == tuple(range(1, CALL_HARD_LIMIT + 1))
assert len({row.key for row in CALL_PLAN}) == CALL_HARD_LIMIT
assert {row.tool for row in CALL_PLAN} == {"ae_status", "ae_nativeExec"}
assert all(row.request_disposition == "read-only" for row in CALL_PLAN)
