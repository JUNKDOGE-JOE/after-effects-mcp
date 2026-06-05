"""Compact human-readable renderers for high-volume read verbs.

Token-efficient, terminal-friendly text (with a paging line) is much cheaper
than the equivalent JSON for large reads. Handlers call these ONLY when the
caller passes format='text'; the default stays 'json' so machine consumers and
the existing dict-asserting test-suite are unaffected.

Each renderer is a pure dict -> str over the JSON envelope a verb already
returns, so they unit-test with no AE/backend. This module is the home for the
remaining compact renderers (scan tree / properties / keyframes).
"""
from __future__ import annotations

from typing import Any, Callable, Dict


def _page_line(d: Dict[str, Any]) -> str:
    """Atom-style paging summary line for paginated verbs."""
    return (
        f"Page: offset={d.get('offset', 0)} limit={d.get('limit', 0)} "
        f"returned={d.get('returned', 0)} total={d.get('total', 0)} "
        f"hasMore={'Y' if d.get('hasMore') else 'N'}"
    )


def render_layers(d: Dict[str, Any]) -> str:
    """Render an ae.layers envelope as a compact table.

    Expected keys: compName/compId, total, offset/limit/returned/hasMore,
    layers[] of {id,name,type,enabled,isThreeD,parent}.
    """
    name = d.get("compName") or d.get("compId") or "?"
    total = d.get("total", len(d.get("layers", [])))
    lines = [f'Comp: "{name}" ({total} layers)']
    if "offset" in d:
        lines.append(_page_line(d))
    lines.append("id | name | type | state | parent")
    for layer in d.get("layers", []):
        state = []
        if not layer.get("enabled", True):
            state.append("off")
        if layer.get("isThreeD"):
            state.append("3D")
        state_s = ",".join(state) if state else "-"
        lines.append(
            f"{layer.get('id')} | {layer.get('name')} | "
            f"{layer.get('type', '?')} | {state_s} | {layer.get('parent') or '-'}"
        )
    return "\n".join(lines)


def maybe_render(
    parsed: Any, fmt: str, renderer: Callable[[Dict[str, Any]], str]
) -> Any:
    """Return a compact string when fmt=='text' and the verb succeeded.

    Errors and non-dict payloads pass through unchanged so failure shapes stay
    structured. A renderer bug degrades to the original dict rather than
    breaking the verb.
    """
    if fmt != "text":
        return parsed
    if not isinstance(parsed, dict) or not parsed.get("ok"):
        return parsed
    try:
        return renderer(parsed)
    except Exception:  # noqa: BLE001 — never let presentation break a read
        return parsed
