'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { renderTemplate } = require('./template');

test('renderTemplate follows Python string.Template placeholder forms', () => {
    assert.equal(
        renderTemplate('$plain ${braced} $$literal', { plain: 'one', braced: 2 }),
        'one 2 $literal',
    );
    assert.throws(function () { renderTemplate('$missing', {}); }, /missing template variable/);
});

test('checkpoint_create.jsx remains a byte-for-byte copy of the Python template', () => {
    const pluginTemplate = path.resolve(__dirname, '../../jsx/templates/checkpoint_create.jsx');
    const pythonTemplate = path.resolve(__dirname, '../../../packages/core/ae_mcp/jsx_templates/checkpoint_create.jsx');
    assert.deepEqual(fs.readFileSync(pluginTemplate), fs.readFileSync(pythonTemplate));
});
