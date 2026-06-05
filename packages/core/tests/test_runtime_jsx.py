"""runtime.jsx ships ES3 polyfills + the AEMCP helper namespace.

These are text/token assertions: runtime.jsx is loaded into AE's persistent
ExtendScript engine at panel startup, so there is no Python import to exercise.
We assert the additions are present and (for polyfills) guarded — the guard is
what keeps them safe on AE 2026's modern engine and on panel re-init.
"""
from __future__ import annotations

from pathlib import Path

import pytest

RUNTIME = Path(__file__).resolve().parents[3] / "plugin" / "jsx" / "runtime.jsx"


@pytest.fixture(scope="module")
def src() -> str:
    return RUNTIME.read_text(encoding="utf-8")


def test_runtime_file_exists():
    assert RUNTIME.exists(), f"runtime.jsx missing at {RUNTIME}"


@pytest.mark.parametrize(
    "method",
    ["indexOf", "forEach", "map", "filter", "reduce", "some", "every", "includes"],
)
def test_array_polyfill_present_and_guarded(src, method):
    assert f"if (!Array.prototype.{method})" in src
    assert f"Array.prototype.{method} = function" in src


def test_array_isarray_guarded(src):
    assert "if (!Array.isArray)" in src
    assert "Array.isArray = function" in src


@pytest.mark.parametrize("fn", ["keys", "values", "entries"])
def test_object_polyfill_present_and_guarded(src, fn):
    assert f"if (!Object.{fn})" in src
    assert f"Object.{fn} = function" in src


@pytest.mark.parametrize(
    "helper",
    [
        "AEMCP.compById",
        "AEMCP.activeComp",
        "AEMCP.layerById",
        "AEMCP.propByPath",
        "AEMCP.propByMatchPath",
    ],
)
def test_aemcp_namespace_helpers_present(src, helper):
    assert f"{helper} = function" in src


def test_aemcp_namespace_guarded_for_reinit(src):
    # Re-running runtime.jsx must not clobber an existing namespace.
    assert "if (typeof AEMCP === 'undefined')" in src


def test_json_polyfill_retained(src):
    assert "if (typeof JSON === 'undefined')" in src


def _strip_line_comments(src: str) -> str:
    # runtime.jsx uses only `//` line comments and no `//` inside string
    # literals, so cutting at the first `//` per line yields the code.
    out = []
    for line in src.splitlines():
        idx = line.find("//")
        out.append(line[:idx] if idx != -1 else line)
    return "\n".join(out)


def test_runtime_is_es3_no_modern_syntax(src):
    # The persistent-engine blast radius means modern syntax is forbidden in
    # code (comments may use normal punctuation).
    code = _strip_line_comments(src)
    assert "=>" not in code, "arrow functions are not ES3-safe"
    assert "`" not in code, "template literals are not ES3-safe"
    assert "const " not in code, "const is not ES3-safe"
    assert "let " not in code, "let is not ES3-safe"
