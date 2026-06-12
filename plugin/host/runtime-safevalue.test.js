const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadRuntime() {
    function TextDocument(t) {
        this.text = t;
    }

    const context = {
        AEMCP: undefined,
        JSON: JSON,
        Array: Array,
        Object: Object,
        String: String,
        Number: Number,
        Boolean: Boolean,
        TextDocument: TextDocument,
    };
    vm.createContext(context);
    const runtime = fs.readFileSync(
        path.join(__dirname, '..', 'jsx', 'runtime.jsx'),
        'utf8'
    );
    vm.runInContext(runtime, context, {filename: 'runtime.jsx'});
    return context;
}

function withThrowingGetter(obj) {
    Object.defineProperty(obj, 'boxTextOnly', {
        enumerable: true,
        get: function () {
            throw new Error('box-text-only getter');
        },
    });
    return obj;
}

test('safeValue serializes TextDocument as text despite throwing getters', () => {
    const context = loadRuntime();
    const td = withThrowingGetter(new context.TextDocument('hi'));

    assert.strictEqual(context.AEMCP.safeValue(td), 'hi');
    assert.doesNotThrow(function () {
        JSON.stringify({previous: context.AEMCP.safeValue(td)});
    });
});

test('safeValue degrades non-stringifiable ordinary objects without throwing', () => {
    const context = loadRuntime();
    const obj = withThrowingGetter({a: 1});

    assert.doesNotThrow(function () {
        assert.strictEqual(context.AEMCP.safeValue(obj), '[object Object]');
    });
});

test('safeValue passes primitives and nullish values through predictably', () => {
    const context = loadRuntime();

    assert.strictEqual(context.AEMCP.safeValue(7), 7);
    assert.strictEqual(context.AEMCP.safeValue(true), true);
    assert.strictEqual(context.AEMCP.safeValue('x'), 'x');
    assert.strictEqual(context.AEMCP.safeValue(null), null);
    assert.strictEqual(context.AEMCP.safeValue(undefined), null);
    // Spread into a host-realm array: safeValue builds its result inside the
    // vm context, whose Array.prototype fails deepStrictEqual's prototype check.
    assert.deepStrictEqual(
        [...context.AEMCP.safeValue([1, undefined, 'z'])],
        [1, null, 'z']
    );
});

test('safeValue keeps normally stringifiable objects on the probe path', () => {
    const context = loadRuntime();
    const obj = {a: 1};

    assert.strictEqual(context.AEMCP.safeValue(obj), obj);
});
