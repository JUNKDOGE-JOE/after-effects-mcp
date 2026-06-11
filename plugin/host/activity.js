// In-process activity ring buffer. The panel require()s this module directly
// in the same CEP Node process as server.js, so there is no new network surface.
const MAX = 500;
let buf = [];
let seq = 0;
const subscribers = new Set();

function record(evt) {
    const e = Object.assign({ id: ++seq, ts: Date.now() }, evt);
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

module.exports = { record, list, subscribe, _reset, MAX };
