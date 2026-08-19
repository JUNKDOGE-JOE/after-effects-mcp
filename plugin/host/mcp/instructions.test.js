'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { BASE, EXPERT, buildInstructions } = require('./instructions');
test('buildInstructions includes the Python base/addendum only when expert guidance is enabled and appends dynamic tools', function () {
    const python = fs.readFileSync(
        path.join(__dirname, '../../../packages/core/ae_mcp/instructions.py'),
        'utf8',
    );
    assert.ok(python.includes(EXPERT.trim()));
    assert.ok(python.includes(BASE.trim()));
    const enabled = buildInstructions({ expertGuidance: true, tools: ['ae_status', 'ae_checkpoint'] });
    const disabled = buildInstructions({ expertGuidance: false, tools: ['ae_status'] });
    assert.ok(enabled.includes(EXPERT.trim()));
    assert.ok(!disabled.includes('EXTENDSCRIPT EXPERT GUARDRAILS'));
    assert.match(enabled, /This CEP-hosted server currently exposes: ae_status, ae_checkpoint\.$/);
    assert.match(disabled, /currently exposes: ae_status\.$/);
});
