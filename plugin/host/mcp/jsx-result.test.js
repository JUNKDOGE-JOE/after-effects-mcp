'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseJsxResult } = require('./jsx-result');

test('parseJsxResult returns parsed JSON objects and arrays', () => {
    assert.deepEqual(parseJsxResult('{"ok":true,"value":42}'), { ok: true, value: 42 });
    assert.deepEqual(parseJsxResult('  \n [1,2,3]'), [1, 2, 3]);
});

test('parseJsxResult rejects empty, undefined, and null outputs', () => {
    assert.deepEqual(parseJsxResult(''), {
        ok: false, error: 'jsx returned no value (empty output)', raw: '',
    });
    const whitespace = parseJsxResult('  \n ');
    assert.equal(whitespace.ok, false);
    assert.match(whitespace.error, /empty output/);
    ['undefined', 'null'].forEach(function (value) {
        const result = parseJsxResult(value);
        assert.equal(result.ok, false);
        assert.equal(result.raw, value);
        assert.ok(result.error.indexOf(value) !== -1);
    });
});

test('parseJsxResult rejects the exact EvalScript sentinel only', () => {
    assert.deepEqual(parseJsxResult('EvalScript error.'), {
        ok: false, error: 'EvalScript error.', raw: 'EvalScript error.',
    });
    const diagnostic = 'EvalScript error: ReferenceError foo is undefined';
    assert.deepEqual(parseJsxResult(diagnostic), { ok: true, content: diagnostic });
});

test('parseJsxResult rejects malformed JSON-shaped output', () => {
    const result = parseJsxResult('{"a":1');
    assert.equal(result.ok, false);
    assert.match(result.error, /JSON-like text that failed to parse/);
    assert.equal(result.raw, '{"a":1');
});

test('parseJsxResult wraps non-JSON strings and preserves parsed ok:false', () => {
    assert.deepEqual(parseJsxResult('hi'), { ok: true, content: 'hi' });
    assert.deepEqual(parseJsxResult('{"ok":false,"error":"no layer"}'), {
        ok: false, error: 'no layer',
    });
});
