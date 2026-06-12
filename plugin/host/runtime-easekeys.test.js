const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadRuntime() {
    function KeyframeEase(speed, influence) {
        this.speed = speed;
        this.influence = influence;
    }

    const context = {
        AEMCP: undefined,
        JSON: JSON,
        Array: Array,
        Object: Object,
        String: String,
        Number: Number,
        Boolean: Boolean,
        KeyframeEase: KeyframeEase,
    };
    vm.createContext(context);
    const runtime = fs.readFileSync(
        path.join(__dirname, '..', 'jsx', 'runtime.jsx'),
        'utf8'
    );
    vm.runInContext(runtime, context, {filename: 'runtime.jsx'});
    return context;
}

function mockProp(options) {
    const calls = [];
    return {
        prop: {
            isSpatial: options.isSpatial,
            value: options.value,
            numKeys: options.numKeys,
            setTemporalEaseAtKey: function (key, inEase, outEase) {
                calls.push({key: key, inEase: inEase, outEase: outEase});
            },
        },
        calls: calls,
    };
}

test('easeKeys sizes ease arrays to non-spatial value dimensions', () => {
    const context = loadRuntime();
    const mocked = mockProp({isSpatial: false, value: [1, 2, 3], numKeys: 2});

    assert.strictEqual(context.AEMCP.easeKeys(mocked.prop), 2);

    assert.strictEqual(mocked.calls.length, 2);
    assert.deepStrictEqual(mocked.calls.map((call) => call.key), [1, 2]);
    for (const call of mocked.calls) {
        assert.strictEqual(call.inEase.length, 3);
        assert.strictEqual(call.outEase.length, 3);
        assert.strictEqual(call.inEase[0].speed, 0);
        assert.strictEqual(call.inEase[0].influence, 33.33);
    }
});

test('easeKeys uses one ease element for spatial properties', () => {
    const context = loadRuntime();
    const mocked = mockProp({isSpatial: true, value: [10, 20, 30], numKeys: 1});

    assert.strictEqual(context.AEMCP.easeKeys(mocked.prop), 1);

    assert.strictEqual(mocked.calls.length, 1);
    assert.strictEqual(mocked.calls[0].inEase.length, 1);
    assert.strictEqual(mocked.calls[0].outEase.length, 1);
});

test('easeKeys respects explicit key indices and influence', () => {
    const context = loadRuntime();
    const mocked = mockProp({isSpatial: false, value: 50, numKeys: 3});

    assert.strictEqual(context.AEMCP.easeKeys(mocked.prop, [2], 70), 1);

    assert.strictEqual(mocked.calls.length, 1);
    assert.strictEqual(mocked.calls[0].key, 2);
    assert.strictEqual(mocked.calls[0].inEase.length, 1);
    assert.strictEqual(mocked.calls[0].inEase[0].influence, 70);
});

test('mustFind throws named errors for nullish values and passes values through', () => {
    const context = loadRuntime();
    const value = {ok: true};

    assert.strictEqual(context.AEMCP.mustFind(value, 'Layer 1'), value);
    assert.throws(
        function () {
            context.AEMCP.mustFind(null, 'Layer 1');
        },
        /Not found: Layer 1/
    );
    assert.throws(
        function () {
            context.AEMCP.mustFind(undefined, 'Comp A');
        },
        /Not found: Comp A/
    );
});
