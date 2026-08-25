// In-process activity ring buffer. The panel require()s this module directly
// in the same CEP Node process as server.js, so there is no new network surface.
const MAX = 500;
let buf = [];
let seq = 0;
const subscribers = new Set();

function record(evt) {
    const e = Object.assign({ id: ++seq, ts: Date.now() }, evt || {});
    e.transport = e.transport || 'internal';
    e.tool = e.tool || (e.transport === 'http' ? 'http' : 'internal');
    if (!e.client || e.client === 'unknown') {
        e.client = e.transport === 'http'
            ? 'http-direct'
            : (e.transport === 'mcp' ? 'mcp-session' : 'internal');
    }
    buf.push(e);
    if (buf.length > MAX) buf = buf.slice(-MAX);
    subscribers.forEach((fn) => {
        try {
            fn(e);
        } catch (err) {
            // Subscriber errors must not break /exec.
        }
    });
    return e;
}

function update(id, patch) {
    const event = buf.find((item) => item.id === id);
    if (!event || !patch || typeof patch !== 'object') return null;
    Object.assign(event, patch);
    subscribers.forEach((fn) => {
        try {
            fn(event);
        } catch (err) {
            // Subscriber errors must not break /exec.
        }
    });
    return event;
}

function list(sinceId) {
    return sinceId ? buf.filter((e) => e.id > sinceId) : buf.slice();
}

function subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
}

function _reset() {
    buf = [];
    seq = 0;
    subscribers.clear();
}

module.exports = { record, update, list, subscribe, _reset, MAX };
