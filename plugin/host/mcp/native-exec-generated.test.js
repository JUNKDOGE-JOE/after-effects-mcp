'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const generated = require('./generated/native_exec.generated.json');

function projection(primitive) {
    return {
        id: primitive.id,
        mutability: primitive.mutability,
        referenceArguments: primitive.referenceArguments,
        inputSchema: primitive.inputSchema,
        resultSchema: primitive.resultSchema,
        resultKind: primitive.resultKind,
        exportable: primitive.exportable,
    };
}

test('CEP JSON projection stays field-for-field aligned with generated ESM exports', async () => {
    const source = await import('../../../native/ae-plugin/protocol/native_exec.generated.mjs');
    assert.deepEqual(generated.NATIVE_EXEC_INPUT_SCHEMA, source.NATIVE_EXEC_INPUT_SCHEMA);
    assert.equal(generated.NATIVE_EXEC_REGISTRY_DIGEST, source.NATIVE_EXEC_REGISTRY_DIGEST);
    assert.deepEqual(generated.PRIMITIVES, source.PRIMITIVES.map(projection));
});

test('the RPC schema copy under plugin/host/mcp/generated stays byte-identical to native/', () => {
    const shipped = fs.readFileSync(path.join(__dirname, 'generated', 'aegp-rpc.schema.json'));
    const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'native', 'ae-plugin', 'protocol', 'aegp-rpc.schema.json'));
    assert.ok(shipped.equals(source), 'run node native/ae-plugin/protocol/emit-native-exec-cjs.mjs to refresh plugin/host/mcp/generated');
});
