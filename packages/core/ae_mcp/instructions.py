"""Static server-level guidance, surfaced to MCP clients at handshake.

This is the cheapest channel to teach an agent how to drive ae-mcp well — the
low-level `Server(instructions=...)` payload is delivered once at initialize,
at zero per-call cost. It mirrors the single biggest differentiator of mature
AE MCPs: front-loaded operating discipline (phased workflow, ExtendScript ES3
rules, matchName-path discipline, verification, and safety).

Dynamic, per-project state stays in `ae_init` / `ae_overview`; only durable
operating rules live here.
"""

from __future__ import annotations

import os

_BASE_INSTRUCTIONS = """\
Drive Adobe After Effects through two execution routes:
- Use ae_exec whenever the maintained AE scripting object model can perform the
  operation.
- Use ae_nativeExec only for curated AEGP primitives and exact native
  semantics.

For every AE execution route choice, use builtin:skill:ae-execution-guide,
including simple edits. It defines program composition, readback, Undo,
uncertain-write reconciliation, visual verification, and the generated native
primitive reference. Read state before writing and prove the result afterward.
"""

# Back-compat: existing imports/tests reference SERVER_INSTRUCTIONS as the
# always-present base. The expert addendum rides on top via build_server_instructions().
SERVER_INSTRUCTIONS = _BASE_INSTRUCTIONS

_EXPERT_ADDENDUM = """\

EXTENDSCRIPT EXPERT GUARDRAILS — high-frequency AE traps (toggle via AE_MCP_EXPERT_GUIDANCE):
  Text layers: add an empty one (comp.layers.addText("")), then READ the doc
    back from layer.property("ADBE Text Properties").property("ADBE Text Document").value,
    set font/fontSize/fillColor/justification on THAT doc, and setValue() it back.
    Setting fields on a fresh TextDocument before addText is unreliable.
  Fonts: use the PostScript name with NO spaces (e.g. "MicrosoftYaHei-Bold", not
    "Microsoft YaHei Bold"). fontSize hard-caps at 1296.
  addProperty() invalidates earlier property references. Two passes: first add
    every group/property, THEN re-acquire each via AEMCP.propByMatchPath, then
    setValue / add keyframes.
  New layers prepend at index 1. For a top->bottom stack, create bottom-up (or
    reorder afterward with moveBefore / moveToBeginning).
  Effect sub-properties: if access by display name returns null on this build,
    address them by index instead — effect.property(1) / property(2) / property(3).
"""


def _expert_guidance_enabled() -> bool:
    raw = os.environ.get("AE_MCP_EXPERT_GUIDANCE")
    if raw is None:
        return True  # default ON
    return raw.strip().lower() not in {"0", "off", "false", "lean", "none", ""}


def build_server_instructions() -> str:
    if _expert_guidance_enabled():
        return _BASE_INSTRUCTIONS + _EXPERT_ADDENDUM
    return _BASE_INSTRUCTIONS
