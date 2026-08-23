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
    assert.doesNotMatch(BASE, /use builtin:skill:/);
    assert.ok(EXPERT.length > 0);
    const enabled = buildInstructions({ expertGuidance: true, tools: ['ae_status', 'ae_checkpoint'] });
    const disabled = buildInstructions({ expertGuidance: false, tools: ['ae_status'] });
    assert.ok(enabled.includes(EXPERT.trim()));
    assert.ok(!disabled.includes('EXTENDSCRIPT EXPERT GUARDRAILS'));
    assert.match(enabled, /This CEP-hosted server currently exposes: ae_status, ae_checkpoint\.$/);
    assert.match(disabled, /currently exposes: ae_status\.$/);
});
