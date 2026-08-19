'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const generated = require('../../../native/ae-plugin/protocol/native_exec.generated.json');
const rpcSchema = require('../../../native/ae-plugin/protocol/aegp-rpc.schema.json');
const {
    SCHEMA_KEYWORDS,
    createValidator,
} = require('./json-schema-lite');
const { validateNativeProgramArguments } = require('./native-program');

const locator = {
    kind: 'composition',
    hostInstanceId: '22222222-2222-4222-8222-222222222222',
    sessionId: '11111111-1111-4111-8111-111111111111',
    projectId: '33333333-3333-4333-8333-333333333333',
    generation: 1,
    objectId: '44444444-4444-4444-8444-444444444444',
};

function references(schema, documents, root, seen) {
    if (schema === true || schema === false || !schema || typeof schema !== 'object') return [];
    const visited = seen || new Set();
    if (visited.has(schema)) return [];
    visited.add(schema);
    const output = [];
    Object.keys(schema).forEach(function (key) {
        if (key.indexOf('x-') === 0) output.push('x-*');
        else if (key !== '$defs') output.push(key);
    });
    if (schema.$ref) {
        const marker = '#/$defs/';
        const index = schema.$ref.indexOf(marker);
        const document = schema.$ref.indexOf('aegp-rpc.schema.json#') === 0
            ? documents['aegp-rpc.schema.json'] : root;
        const name = index >= 0 ? schema.$ref.slice(index + marker.length) : null;
        if (name && document && document.$defs && document.$defs[name]) {
            output.push(...references(document.$defs[name], documents, root, visited));
        }
    }
    if (schema.properties) Object.keys(schema.properties).forEach(function (key) {
        output.push(...references(schema.properties[key], documents, root, visited));
    });
    if (schema.items) output.push(...references(schema.items, documents, root, visited));
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        output.push(...references(schema.additionalProperties, documents, root, visited));
    }
    ['allOf', 'anyOf', 'oneOf'].forEach(function (key) {
        if (Array.isArray(schema[key])) schema[key].forEach(function (item) {
            output.push(...references(item, documents, root, visited));
        });
    });
    ['if', 'then', 'else', 'not'].forEach(function (key) {
        if (schema[key]) output.push(...references(schema[key], documents, root, visited));
    });
    return output;
}

test('generated native schemas use exactly the supported keyword set', () => {
    const actual = new Set();
    const documents = { 'aegp-rpc.schema.json': rpcSchema };
    [generated.NATIVE_EXEC_INPUT_SCHEMA].concat(generated.PRIMITIVES.flatMap(function (primitive) {
        return [primitive.inputSchema, primitive.resultSchema];
    })).forEach(function (schema) {
        references(schema, documents, schema).forEach(function (key) { actual.add(key); });
    });
    const expected = new Set(SCHEMA_KEYWORDS.concat(['x-*']));
    assert.deepEqual(Array.from(actual).sort(), Array.from(expected).sort());
});

test('every generated schema keyword has a falsifying and accepting example', () => {
    const cases = {
        '$ref': {
            schema: { $ref: '#/$defs/value' }, root: { $defs: { value: { const: 'yes' } } },
            valid: 'yes', invalid: 'no',
        },
        additionalProperties: { schema: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false }, valid: { a: 'x' }, invalid: { b: 1 } },
        allOf: { schema: { allOf: [{ type: 'string' }, { minLength: 2 }] }, valid: 'ab', invalid: 'a' },
        anyOf: { schema: { anyOf: [{ type: 'string' }, { type: 'integer' }] }, valid: 1, invalid: true },
        const: { schema: { const: 3 }, valid: 3, invalid: 4 },
        default: { schema: { type: 'string', default: 'fallback' }, valid: 'x', invalid: 1 },
        else: { schema: { if: { properties: { kind: { const: 'a' } }, required: ['kind'] }, then: { required: ['value'] }, else: { required: ['other'] }, type: 'object' }, valid: { kind: 'b', other: true }, invalid: { kind: 'b' } },
        enum: { schema: { enum: ['a', 'b'] }, valid: 'a', invalid: 'c' },
        if: { schema: { if: { properties: { kind: { const: 'a' } }, required: ['kind'] }, then: { required: ['value'] }, type: 'object' }, valid: { kind: 'a', value: 1 }, invalid: { kind: 'a' } },
        items: { schema: { type: 'array', items: { type: 'integer' } }, valid: [1, 2], invalid: [1, '2'] },
        maxItems: { schema: { type: 'array', maxItems: 1 }, valid: [1], invalid: [1, 2] },
        maxLength: { schema: { type: 'string', maxLength: 2 }, valid: 'ab', invalid: 'abc' },
        maximum: { schema: { type: 'integer', maximum: 2 }, valid: 2, invalid: 3 },
        minItems: { schema: { type: 'array', minItems: 1 }, valid: [1], invalid: [] },
        minLength: { schema: { type: 'string', minLength: 2 }, valid: 'ab', invalid: 'a' },
        minimum: { schema: { type: 'integer', minimum: 2 }, valid: 2, invalid: 1 },
        not: { schema: { not: { const: 'bad' } }, valid: 'ok', invalid: 'bad' },
        oneOf: { schema: { oneOf: [{ type: 'string' }, { type: 'integer' }] }, valid: 1, invalid: true },
        pattern: { schema: { type: 'string', pattern: '^[0-9a-f]{4}$' }, valid: 'cafe', invalid: 'CAFE' },
        properties: { schema: { type: 'object', properties: { a: { type: 'string' } } }, valid: { a: 'x' }, invalid: { a: 1 } },
        required: { schema: { type: 'object', required: ['a'] }, valid: { a: 1 }, invalid: {} },
        then: { schema: { if: { properties: { kind: { const: 'a' } }, required: ['kind'] }, then: { properties: { value: { const: 1 } }, required: ['value'] }, type: 'object' }, valid: { kind: 'a', value: 1 }, invalid: { kind: 'a', value: 2 } },
        type: { schema: { type: 'string' }, valid: 'x', invalid: 1 },
    };
    SCHEMA_KEYWORDS.forEach(function (keyword) {
        const item = cases[keyword];
        assert.ok(item, 'missing keyword test for ' + keyword);
        const validator = createValidator(item.schema, item.root ? { rootSchema: item.root } : undefined);
        assert.equal(validator.isValid(item.valid), true, keyword + ' valid');
        assert.equal(validator.isValid(item.invalid), false, keyword + ' invalid');
    });
    const extension = createValidator({ type: 'string', 'x-invariant': 'ignored' });
    assert.equal(extension.isValid('ok'), true);
});

test('local and external generated-schema refs resolve, and unknown keywords fail closed', () => {
    const local = createValidator({ $ref: '#/$defs/value' }, {
        rootSchema: { $defs: { value: { type: 'integer', minimum: 1 } } },
    });
    assert.equal(local.isValid(1), true);
    assert.equal(local.isValid(0), false);
    const external = createValidator({ $ref: 'aegp-rpc.schema.json#/$defs/uuid' }, {
        documents: { 'aegp-rpc.schema.json': rpcSchema },
    });
    assert.equal(external.isValid('11111111-1111-4111-8111-111111111111'), true);
    assert.equal(external.isValid('not-a-uuid'), false);
    assert.throws(function () { createValidator({ type: 'string', format: 'uuid' }); }, /unsupported JSON Schema keyword: format/);
});

test('generated primitive examples and bounded-program invalid cases are checked by the host validator', () => {
    const primitives = require('../../../native/ae-plugin/protocol/native-primitives.json').primitives;
    primitives.forEach(function (primitive) {
        if (Object.keys(primitive.example || {}).length === 0) return;
        const operation = { op: primitive.id, args: primitive.example };
        const program = { operations: [operation] };
        if (primitive.mutability === 'write') {
            program.operationKey = 'example-operation-key-0001';
            program.undoGroup = 'Example';
        }
        assert.deepEqual(validateNativeProgramArguments(program), [], primitive.id);
    });

    const simpleRead = { op: 'project.items.list', args: { offset: 0, limit: 1 } };
    assert.ok(validateNativeProgramArguments({ operations: Array(65).fill(simpleRead) }).some(function (item) {
        return item.path === 'operations';
    }));
    const futureReference = validateNativeProgramArguments({ operations: [
        { op: 'composition.time.read', args: { composition: { ref: 'composition' } } },
        { op: 'composition.resolve', args: { locator }, saveAs: 'composition' },
    ] });
    assert.ok(futureReference.some(function (item) { return item.path === 'operations[0].args.composition'; }));
    const write = [
        { op: 'composition.resolve', args: { locator }, saveAs: 'composition' },
        { op: 'composition.time.set', args: { composition: { ref: 'composition' }, targetTime: { value: 0, scale: 24 } } },
    ];
    assert.ok(validateNativeProgramArguments({ operations: write }).length > 0);
    assert.ok(validateNativeProgramArguments({ undoGroup: 'read is not writable', operations: [simpleRead] }).length > 0);
    assert.ok(validateNativeProgramArguments({ operations: [{ op: 'unknown.op', args: {} }] }).some(function (item) {
        return item.path === 'operations[0]';
    }));
});
