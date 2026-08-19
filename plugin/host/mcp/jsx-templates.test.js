'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

test('CEP JSX templates remain byte-identical to the Python migration sources', () => {
    ['diagnose.jsx', 'preview_viewer.jsx'].forEach(function (name) {
        const migrated = fs.readFileSync(path.join(__dirname, '../../jsx/templates', name));
        const source = fs.readFileSync(path.join(__dirname, '../../../packages/core/ae_mcp/jsx_templates', name));
        assert.deepEqual(migrated, source, name);
    });
});
