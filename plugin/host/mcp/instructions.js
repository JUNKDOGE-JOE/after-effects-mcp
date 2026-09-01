'use strict';

const BASE = `Drive Adobe After Effects through two execution routes:
- Use ae_exec whenever the maintained AE scripting object model can perform the
  operation.
- Use ae_nativeExec only for curated AEGP primitives and exact native
  semantics.

For every AE execution route choice, call ae_skillUse with name
"ae-execution-guide", including simple edits. It defines program composition, readback, Undo,
uncertain-write reconciliation, visual verification, and the generated native
primitive reference. Read state before writing and prove the result afterward.
Use ae_exec only for a new script. A dispatched failure may return a recoveryId
and editable scriptPath. Never invent or guess that id; edit the file or supply
corrected code, then call ae_execRecover with the exact returned id.
checkpoint_label is required for a restore point.
Every ae_exec script must evaluate to a value. A bare script may end with
JSON.stringify(result); but an IIFE must use return JSON.stringify(result);
inside the function. Merely calling JSON.stringify inside an IIFE evaluates
the outer script to undefined after AE may already have changed.
`;
const EXPERT = `
EXTENDSCRIPT EXPERT GUARDRAILS — high-frequency AE traps (panel conversations can switch this block off in Settings; external clients always receive it):
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

TOOL LIBRARY WORKFLOW:
  For a repeated operation, call ae_toolSearch first, then replay a match by id
  with ae_toolUse instead of rewriting the script. When a useful script or
  candidate is worth retaining, call ae_toolSave to save or promote it.
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
