const test = require('node:test');
const assert = require('node:assert');

const activity = require('./activity');

test('activity ring buffer truncates to MAX and keeps increasing ids', () => {
    activity._reset();
    for (let i = 0; i < activity.MAX + 10; i += 1) {
        activity.record({ ok: true, n: i });
    }
    const events = activity.list();
    assert.strictEqual(events.length, activity.MAX);
    assert.strictEqual(events[0].id, 11);
    assert.strictEqual(events[events.length - 1].id, activity.MAX + 10);
});

test('activity subscribers receive new events and can unsubscribe', () => {
    activity._reset();
    const seen = [];
    const unsubscribe = activity.subscribe((evt) => seen.push(evt));
    const first = activity.record({ ok: true });
    unsubscribe();
    activity.record({ ok: false });
    assert.deepStrictEqual(seen, [first]);
});

test('activity subscriber errors do not break record', () => {
    activity._reset();
    activity.subscribe(() => { throw new Error('boom'); });
    const evt = activity.record({ ok: true });
    assert.strictEqual(evt.ok, true);
    assert.strictEqual(activity.list().length, 1);
});

test('activity list filters by since id', () => {
    activity._reset();
    const a = activity.record({ ok: true, n: 1 });
    const b = activity.record({ ok: true, n: 2 });
    const c = activity.record({ ok: true, n: 3 });
    assert.deepStrictEqual(activity.list(a.id), [b, c]);
});

test('activity supplies attribution defaults and can enrich a recorded failure', () => {
    activity._reset();
    const event = activity.record({ ok: false, error: 'boom' });
    assert.deepEqual(
        { client: event.client, tool: event.tool, transport: event.transport },
        { client: 'internal', tool: 'internal', transport: 'internal' },
    );
    assert.equal(activity.update(event.id, { hinted: true, hintIndex: 3 }).hintIndex, 3);
    assert.equal(activity.list()[0].hinted, true);
});
