'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { VERB_ANNOTATIONS } = require('./annotations');
const { TOOL_MODULES } = require('./tools');

test('target MCP annotation table contains the twelve direction tools', () => {
    assert.deepEqual(Object.keys(VERB_ANNOTATIONS), [
        'ae_exec', 'ae_execRecover', 'ae_status', 'ae_previewFrame', 'ae_read', 'ae_checkpoint',
        'ae_revert', 'ae_validateExpressions', 'ae_nativeExec', 'ae_toolUse',
        'ae_toolSearch', 'ae_skillUse',
    ]);
    assert.deepEqual(VERB_ANNOTATIONS.ae_read, {
        readOnlyHint: true, destructiveHint: false, idempotentHint: true,
    });
    assert.deepEqual(VERB_ANNOTATIONS.ae_execRecover, VERB_ANNOTATIONS.ae_exec);
});

test('every registered tool has matching central annotation hints', () => {
    TOOL_MODULES.forEach(function (mod) {
        const expected = VERB_ANNOTATIONS[mod.definition.name];
        assert.ok(expected, 'missing annotations for ' + mod.definition.name);
        Object.keys(mod.definition.annotations).forEach(function (hint) {
            if (Object.prototype.hasOwnProperty.call(expected, hint)) {
                assert.equal(mod.definition.annotations[hint], expected[hint], mod.definition.name + ' ' + hint);
            }
        });
        assert.equal(mod.definition.annotations.readOnlyHint, expected.readOnlyHint);
        assert.equal(mod.definition.annotations.destructiveHint, expected.destructiveHint);
        if (mod.definition.name !== 'ae_status') {
            assert.equal(mod.definition.annotations.idempotentHint, expected.idempotentHint);
        }
    });
});
