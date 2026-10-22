'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { BASE, EXPERT, buildInstructions } = require('./instructions');
test(
  'buildInstructions includes the base/addendum only when expert guidance is enabled '
    + 'and appends dynamic tools',
  function () {
    assert.ok(BASE.length > 0);
    assert.match(BASE, /Never invent or guess that id/);
    assert.match(BASE, /call ae_execRecover with the exact returned id/);
    assert.match(BASE, /checkpoint_label is required for a restore point/);
    assert.match(BASE, /IIFE must use return JSON\.stringify/);
    assert.match(BASE, /outer script to undefined/);
    assert.match(BASE, /call ae_skillUse with name/);
    assert.match(BASE, /internal chat agent is not a required intermediary/);
    assert.match(BASE, /ae_instances action=list[\s\S]*ae_workspace action=bind[\s\S]*context_id/);
    assert.match(BASE, /Computer Use as a fallback/);
    assert.match(BASE, /read-only refusal requires an[\s\S]*authorized write binding/);
    assert.match(BASE, /no tool for sending it a chat message/);
    assert.match(BASE, /agent-managed reopening with ae_instances action=start/);
    assert.match(BASE, /diagnosis-only requests, offer it without launching/);
    assert.match(BASE, /alive AE with a closed panel[\s\S]*do not start a competing/);
    assert.doesNotMatch(BASE, /use builtin:skill:/);
    assert.ok(EXPERT.length > 0);
    const enabled = buildInstructions({ expertGuidance: true, tools: ['ae_status', 'ae_checkpoint'] });
    const disabled = buildInstructions({ expertGuidance: false, tools: ['ae_status'] });
    assert.ok(enabled.includes(EXPERT.trim()));
    assert.ok(!disabled.includes('EXTENDSCRIPT EXPERT GUARDRAILS'));
    assert.match(enabled, /TOOL LIBRARY WORKFLOW:[\s\S]*ae_toolSearch[\s\S]*ae_toolUse[\s\S]*ae_toolSave/);
    assert.doesNotMatch(disabled, /TOOL LIBRARY WORKFLOW/);
    assert.match(enabled, /This CEP-hosted server currently exposes: ae_status, ae_checkpoint\.$/);
    assert.match(disabled, /currently exposes: ae_status\.$/);
});
