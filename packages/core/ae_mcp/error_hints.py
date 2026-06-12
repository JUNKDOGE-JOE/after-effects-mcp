"""Append actionable hints to known ExtendScript error patterns.

The embedded agent self-corrects faster when the error text carries the
fix. Patterns target messages from BOTH localized (zh) and English AE
builds. Hints are English (the model reads both) and appended once.
"""
from __future__ import annotations

import re

_HINTS: list[tuple[re.Pattern[str], str]] = [
    (
        re.compile(r"setTemporalEaseAtKey.*(元素|element)", re.I),
        "ease arrays need one KeyframeEase per property dimension "
        "(1D like Opacity=1, Scale=value dimensions, spatial Position=1); "
        "use AEMCP.easeKeys(prop) to size them automatically",
    ),
    (
        re.compile(
            r"null 不是对象|null is not an object|undefined 不是对象|undefined is not an object",
            re.I,
        ),
        "a lookup returned null/undefined - check comp/layer/property lookups "
        "(byName/index) before use, or wrap with AEMCP.mustFind(value, name)",
    ),
    (
        re.compile(r"函数.*未定义|is not a function", re.I),
        "that API does not exist on this object - verify with a read tool "
        "first instead of guessing method names",
    ),
]

_HINT_MARK = "[hint]"


def append_hint(error: str) -> str:
    text = str(error or "")
    if _HINT_MARK in text:
        return text
    for pattern, hint in _HINTS:
        if pattern.search(text):
            return f"{text}\n{_HINT_MARK} {hint}"
    return text
