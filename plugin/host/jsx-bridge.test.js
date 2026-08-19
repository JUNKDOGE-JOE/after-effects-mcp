// Tests for the JSX bridge: sentinel rejection, normal resolve, serialization,
// and timeout drain recovery. Uses Node's built-in test runner (node --test)
// with a fake csInterface and injectable timers — no external deps.
const test = require('node:test');
const assert = require('node:assert');

// Fresh module per test so the internal queue state doesn't leak between cases.
function freshBridge() {
    delete require.cache[require.resolve('./jsx-bridge')];
    return require('./jsx-bridge');
}

function fakeClock() {
    let now = 0;
    let nextId = 1;
    const tasks = new Map();
    return {
        now: function () { return now; },
        setTimeout: function (fn, delay) {
            const id = nextId++;
            tasks.set(id, { at: now + delay, fn });
            return id;
        },
        clearTimeout: function (id) { tasks.delete(id); },
        flush: async function () {
            await Promise.resolve();
            await Promise.resolve();
        },
        advance: async function (delta) {
            const target = now + delta;
            while (true) {
                let selectedId = null;
                let selected = null;
                tasks.forEach(function (task, id) {
                    if (task.at <= target && (!selected || task.at < selected.at)) {
                        selectedId = id;
                        selected = task;
                    }
                });
                if (!selected) break;
                now = selected.at;
                tasks.delete(selectedId);
                selected.fn();
                await this.flush();
            }
            now = target;
            await this.flush();
        },
    };
}

function useFakeClock(bridge) {
    const clock = fakeClock();
    bridge._setTimingForTest({
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        sentinelTimeoutMs: 1000,
        sentinelRetryDelayMs: 10,
    });
    return clock;
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
    await assert.rejects(() => bridge.evalScript('boom', 1000), function (error) {
        assert.match(error.message, /EvalScript error\./);
        assert.strictEqual(error.disposition, 'failed');
        return true;
    });
});

test('legitimate string beginning with EvalScript errors resolves', async () => {
    const bridge = freshBridge();
    bridge.setCSInterface({
        evalScript: function (jsx, cb) { cb('EvalScript errors found: 0'); },
    });
    const r = await bridge.evalScript('diagnostics', 1000);
    assert.strictEqual(r, 'EvalScript errors found: 0');
});

test('EvalScript error colon variant resolves because only the exact sentinel rejects', async () => {
    const bridge = freshBridge();
    bridge.setCSInterface({
        evalScript: function (jsx, cb) { cb('EvalScript error: ReferenceError x is undefined'); },
    });
    const r = await bridge.evalScript('diagnostics', 1000);
    assert.strictEqual(r, 'EvalScript error: ReferenceError x is undefined');
});

test('missing CSInterface rejects', async () => {
    const bridge = freshBridge();
    await assert.rejects(() => bridge.evalScript('1', 1000), function (error) {
        assert.match(error.message, /CSInterface not initialized/);
        assert.strictEqual(error.disposition, 'not_dispatched');
        return true;
    });
});

test('timeout keeps the lock and a queued call expires as not_dispatched', async () => {
    const bridge = freshBridge();
    const clock = useFakeClock(bridge);
    const calls = [];
    bridge.setCSInterface({
        evalScript: function (jsx, cb) {
            calls.push({ jsx, cb });
            // Neither the real callback nor the sentinel callback returns.
        },
    });

    const first = bridge.evalScript('slow', 20);
    const second = bridge.evalScript('fast', 50);
    const firstRejected = assert.rejects(first, function (error) {
        assert.match(error.message, /^JSX timeout after 20ms/);
        assert.strictEqual(error.disposition, 'uncertain');
        return true;
    });
    const secondRejected = assert.rejects(second, function (error) {
        assert.strictEqual(
            error.message,
            'JSX not dispatched: engine still draining a timed-out script'
        );
        assert.strictEqual(error.disposition, 'not_dispatched');
        return true;
    });

    await clock.flush();
    assert.deepStrictEqual(calls.map(function (call) { return call.jsx; }), ['slow']);
    await clock.advance(20);
    await firstRejected;
    assert.strictEqual(calls.length, 2, 'one drain sentinel should be sent');
    assert.doesNotMatch(calls[1].jsx, /beginUndoGroup/);
    await clock.advance(30);
    await secondRejected;
    assert.strictEqual(calls.length, 2, 'the queued real script must not be dispatched');
    assert.strictEqual(bridge.getState().state, 'degraded');
    assert.strictEqual(bridge.getState().pendingCalls, 0);
    assert.strictEqual(bridge.getState().sentinelInFlight, true);
});

test('a late real callback drains the engine and releases the next call', async () => {
    const bridge = freshBridge();
    const clock = useFakeClock(bridge);
    const calls = [];
    bridge.setCSInterface({
        evalScript: function (jsx, cb) {
            calls.push({ jsx, cb });
            if (jsx === 'fast') cb('second-ok');
        },
    });

    const first = bridge.evalScript('slow', 20);
    const second = bridge.evalScript('fast', 100);
    const firstRejected = assert.rejects(first, function (error) {
        return error.disposition === 'uncertain';
    });
    await clock.flush();
    await clock.advance(20);
    await firstRejected;
    assert.strictEqual(bridge.getState().state, 'degraded');

    calls[0].cb('late-result');
    await clock.flush();
    assert.strictEqual(await second, 'second-ok');
    assert.deepStrictEqual(
        calls.map(function (call) { return call.jsx === 'fast' ? 'fast' : call.jsx === 'slow' ? 'slow' : 'sentinel'; }),
        ['slow', 'sentinel', 'fast']
    );
    assert.strictEqual(bridge.getState().state, 'ok');
    assert.strictEqual(bridge.getState().degradedSinceMs, null);
});

test('a sentinel callback drains the engine when the real callback never arrives', async () => {
    const bridge = freshBridge();
    const clock = useFakeClock(bridge);
    const calls = [];
    bridge.setCSInterface({
        evalScript: function (jsx, cb) {
            calls.push({ jsx, cb });
            if (jsx === 'fast') cb('second-ok');
        },
    });

    const first = bridge.evalScript('slow', 20);
    const second = bridge.evalScript('fast', 100);
    const firstRejected = assert.rejects(first, function (error) {
        return error.disposition === 'uncertain';
    });
    await clock.flush();
    await clock.advance(20);
    await firstRejected;
    assert.strictEqual(calls.length, 2);
    assert.doesNotMatch(calls[1].jsx, /beginUndoGroup/);
    assert.match(calls[1].jsx, /endUndoGroup/);

    calls[1].cb('ignored-sentinel-result');
    await clock.flush();
    assert.strictEqual(await second, 'second-ok');
    assert.strictEqual(bridge.getState().state, 'ok');
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
