'use strict';

const BASE = `Drive Adobe After Effects through two execution routes:
- Use ae_exec whenever the maintained AE scripting object model can perform the
  operation.
- Use ae_nativeExec only for curated AEGP primitives and exact native
  semantics.

For every AE execution route choice, use builtin:skill:ae-execution-guide,
including simple edits. It defines program composition, readback, Undo,
uncertain-write reconciliation, visual verification, and the generated native
primitive reference. Read state before writing and prove the result afterward.
`;
const EXPERT = `
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
`;
function buildInstructions(options) {
    const names = options && Array.isArray(options.tools) ? options.tools : [];
    return (
        BASE +
        (options && options.expertGuidance === false ? '' : EXPERT) +
        'This CEP-hosted server currently exposes: ' +
        names.join(', ') +
        '.'
    );
}
module.exports = { BASE, EXPERT, buildInstructions };
