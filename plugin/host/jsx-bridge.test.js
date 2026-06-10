// Tests for the JSX bridge: sentinel rejection, normal resolve, serialization
// (mutex), and that a timeout releases the lock. Uses Node's built-in test
// runner (node --test) with a fake csInterface — no external deps.
const test = require('node:test');
const assert = require('node:assert');

// Fresh module per test so the internal queue state doesn't leak between cases.
function freshBridge() {
    delete require.cache[require.resolve('./jsx-bridge')];
    return require('./jsx-bridge');
}

test('normal result resolves', async () => {
    const bridge = freshBridge();
    bridge.setCSInterface({
        evalScript: function (jsx, cb) { cb('hello'); },
    });
    const r = await bridge.evalScript('1', 1000);
    assert.strictEqual(r, 'hello');
});

test('"EvalScript error." sentinel (with period) rejects', async () => {
    const bridge = freshBridge();
    bridge.setCSInterface({
        evalScript: function (jsx, cb) { cb('EvalScript error.'); },
    });
    await assert.rejects(
        () => bridge.evalScript('boom', 1000),
        /EvalScript error\./
    );
});

test('missing CSInterface rejects', async () => {
    const bridge = freshBridge();
    await assert.rejects(
        () => bridge.evalScript('1', 1000),
        /CSInterface not initialized/
    );
});

test('timeout rejects and releases the lock for the next call', async () => {
    const bridge = freshBridge();
    let firstCb = null;
    let secondCalled = false;
    bridge.setCSInterface({
        evalScript: function (jsx, cb) {
            if (firstCb === null) {
                // Never invoke the callback for the first call -> it times out.
                firstCb = cb;
            } else {
                secondCalled = true;
                cb('second-ok');
            }
        },
    });

    const first = bridge.evalScript('slow', 20);
    const second = bridge.evalScript('fast', 1000);

    await assert.rejects(() => first, /JSX timeout after 20ms/);
    // The lock must have been released so the second call can run and resolve.
    const r = await second;
    assert.strictEqual(r, 'second-ok');
    assert.strictEqual(secondCalled, true);
});

test('mutex serializes: two concurrent calls do not overlap', async () => {
    const bridge = freshBridge();
    let inFlight = 0;
    let maxConcurrent = 0;
    const order = [];

    bridge.setCSInterface({
        evalScript: function (jsx, cb) {
            inFlight++;
            maxConcurrent = Math.max(maxConcurrent, inFlight);
            order.push('start:' + jsx);
            // Simulate async AE work; the second call must not start until this
            // callback fires.
            setTimeout(function () {
                order.push('end:' + jsx);
                inFlight--;
                cb('done:' + jsx);
            }, 15);
        },
    });

    const a = bridge.evalScript('A', 1000);
    const b = bridge.evalScript('B', 1000);
    const [ra, rb] = await Promise.all([a, b]);

    assert.strictEqual(ra, 'done:A');
    assert.strictEqual(rb, 'done:B');
    // The critical invariant: never two evalScript bodies in flight at once.
    assert.strictEqual(maxConcurrent, 1, 'evalScript calls overlapped');
    // And they ran strictly in submission order, fully serialized.
    assert.deepStrictEqual(order, ['start:A', 'end:A', 'start:B', 'end:B']);
});

test('a rejected call does not poison the queue', async () => {
    const bridge = freshBridge();
    let n = 0;
    bridge.setCSInterface({
        evalScript: function (jsx, cb) {
            n++;
            if (n === 1) { cb('EvalScript error.'); }
            else { cb('ok'); }
        },
    });
    await assert.rejects(() => bridge.evalScript('bad', 1000));
    const r = await bridge.evalScript('good', 1000);
    assert.strictEqual(r, 'ok');
});
