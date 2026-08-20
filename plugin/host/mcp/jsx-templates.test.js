'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

test('CEP JSX templates remain present as checked-in host templates', () => {
    ['diagnose.jsx', 'preview_viewer.jsx', 'revert_close.jsx', 'revert_open.jsx', 'validate_expressions.jsx'].forEach(function (name) {
        const template = fs.readFileSync(path.join(__dirname, '../../jsx/templates', name));
        assert.ok(template.length > 0, name);
    });
});
