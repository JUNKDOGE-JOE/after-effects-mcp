'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseJsxResult, parseExecResult } = require('./jsx-result');

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

test('parseExecResult maps explicit transport types without sniffing JSON-like text', () => {
    assert.deepEqual(parseExecResult('text', '{"ok":true}'), {
        ok: false,
        error: 'ae_exec returned an invalid result type',
        raw: '{"ok":true}',
    });
    assert.deepEqual(parseExecResult('string', '{"ok":false,"error":"not an exec error"}'), {
        ok: true,
        content: '{"ok":false,"error":"not an exec error"}',
        contentType: 'text',
    });
    assert.deepEqual(parseExecResult('string', '[object Object]'), {
        ok: true,
        content: '[object Object]',
        contentType: 'text',
    });
    assert.deepEqual(parseExecResult('json', '{"ok":true,"n":42}'), {
        ok: true,
        content: '{"ok":true,"n":42}',
        contentType: 'json',
    });
});

test('parseExecResult preserves empty, undefined, and EvalScript sentinel errors', () => {
    const emptyResult = parseExecResult('string', '');
    assert.equal(emptyResult.ok, false);
    assert.match(emptyResult.error, /^jsx returned no value \(empty output\)/);
    assert.match(emptyResult.error, /uncaught ExtendScript throw/);
    assert.equal(emptyResult.raw, '');
    const undefinedResult = parseExecResult('string', 'undefined');
    assert.equal(undefinedResult.ok, false);
    assert.match(undefinedResult.error, /^jsx evaluated to undefined/);
    assert.match(undefinedResult.error, /last statement must be a bare expression/);
    const nullResult = parseExecResult('string', 'null');
    assert.equal(nullResult.ok, false);
    assert.match(nullResult.error, /^jsx evaluated to null/);
    assert.match(nullResult.error, /last statement must be a bare expression/);
    assert.deepEqual(parseExecResult('string', 'EvalScript error.'), {
        ok: false,
        error: 'EvalScript error.',
        raw: 'EvalScript error.',
    });
});
