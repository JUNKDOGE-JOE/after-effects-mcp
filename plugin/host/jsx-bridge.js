// Bridge between Node.js (CEP host process) and AE ExtendScript via CSInterface.
// CSInterface is loaded in the parent (panel) process; we accept it via setCSInterface.
// Must equal EvalScript_ErrMessage in plugin/client/CSInterface.js:33 (vendored
// Adobe constant). CEP returns it VERBATIM on uncaught ExtendScript errors -
// no detail suffix - so exact equality is the correct check (a bare prefix
// match false-positives legitimate strings like "EvalScript errors found: 0").
// The host and client use the same transport sentinel.
const EVALSCRIPT_ERR_SENTINEL = 'EvalScript error.';

const SENTINEL_TIMEOUT_MS = 60000;
const SENTINEL_RETRY_DELAY_MS = 1000;
const DRAIN_SENTINEL_JSX = 'try{app.endUndoGroup()}catch(e){};1+1';

let csInterface = null;
let queue = Promise.resolve();
let state = 'ok';
let degradedSinceMs = null;
let lastTimeoutAt = null;
let pendingCalls = 0;
let sentinelInFlight = false;
let activeDrain = null;
const waitingCalls = new Set();

let timing = {
    now: function () { return Date.now(); },
    setTimeout: function (fn, ms) { return setTimeout(fn, ms); },
    clearTimeout: function (timer) { clearTimeout(timer); },
    sentinelTimeoutMs: SENTINEL_TIMEOUT_MS,
    sentinelRetryDelayMs: SENTINEL_RETRY_DELAY_MS,
};

function setCSInterface(cs) {
    csInterface = cs;
}

function getState() {
    return {
        state,
        degradedSinceMs,
        lastTimeoutAt,
        pendingCalls,
        sentinelInFlight,
    };
}

function withDisposition(error, disposition) {
    const tagged = error instanceof Error ? error : new Error(String(error));
    tagged.disposition = disposition;
    return tagged;
}

function settleCaller(call, fn, value) {
    if (call.settled) return;
    call.settled = true;
    waitingCalls.delete(call);
    if (call.waitTimer !== null) {
        timing.clearTimeout(call.waitTimer);
        call.waitTimer = null;
    }
    pendingCalls -= 1;
    fn(value);
}

function rejectNotDispatched(call) {
    if (call.settled || call.dispatched) return;
    const error = new Error('JSX not dispatched: engine still draining a timed-out script');
    error.disposition = 'not_dispatched';
    settleCaller(call, call.reject, error);
}

function recoverDrain(drain) {
    if (activeDrain !== drain) return;
    if (drain.sentinelTimer !== null) timing.clearTimeout(drain.sentinelTimer);
    if (drain.retryTimer !== null) timing.clearTimeout(drain.retryTimer);
    drain.sentinelTimer = null;
    drain.retryTimer = null;
    activeDrain = null;
    sentinelInFlight = false;
    state = 'ok';
    degradedSinceMs = null;
    drain.release();
}

function scheduleSentinelRetry(drain) {
    if (activeDrain !== drain || drain.retryTimer !== null) return;
    drain.retryTimer = timing.setTimeout(function () {
        drain.retryTimer = null;
        sendDrainSentinel(drain);
    }, timing.sentinelRetryDelayMs);
}

function sendDrainSentinel(drain) {
    if (activeDrain !== drain || sentinelInFlight) return;
    if (!csInterface) {
        scheduleSentinelRetry(drain);
        return;
    }

    sentinelInFlight = true;
    const attempt = ++drain.sentinelAttempt;
    drain.sentinelTimer = timing.setTimeout(function () {
        if (activeDrain !== drain || attempt !== drain.sentinelAttempt) return;
        drain.sentinelTimer = null;
        sentinelInFlight = false;
        scheduleSentinelRetry(drain);
    }, timing.sentinelTimeoutMs);

    try {
        csInterface.evalScript(DRAIN_SENTINEL_JSX, function () {
            // The result is deliberately ignored. A callback proves all JSX
            // submitted before this sentinel has left the persistent engine.
            recoverDrain(drain);
        });
    } catch (error) {
        if (activeDrain !== drain || attempt !== drain.sentinelAttempt) return;
        if (drain.sentinelTimer !== null) timing.clearTimeout(drain.sentinelTimer);
        drain.sentinelTimer = null;
        sentinelInFlight = false;
        scheduleSentinelRetry(drain);
    }
}

function enterDegraded(release) {
    const now = timing.now();
    state = 'degraded';
    degradedSinceMs = now;
    lastTimeoutAt = now;
    const drain = {
        release,
        sentinelAttempt: 0,
        sentinelTimer: null,
        retryTimer: null,
    };
    activeDrain = drain;

    waitingCalls.forEach(function (call) {
        if (call.deadlineReached) rejectNotDispatched(call);
    });
    sendDrainSentinel(drain);
    return drain;
}

// Dispatch one real script. Its returned Promise is the queue gate: unlike the
// caller-facing Promise, it remains pending after a timeout until AE proves the
// persistent engine has drained.
function dispatchCall(call) {
    call.dispatched = true;
    waitingCalls.delete(call);
    if (call.waitTimer !== null) {
        timing.clearTimeout(call.waitTimer);
        call.waitTimer = null;
    }

    return new Promise(function (release) {
        if (!csInterface) {
            settleCaller(
                call,
                call.reject,
                withDisposition(new Error('CSInterface not initialized'), 'not_dispatched')
            );
            release();
            return;
        }

        let callbackSeen = false;
        let timedOut = false;
        let drain = null;
        let released = false;
        const releaseOnce = function () {
            if (released) return;
            released = true;
            release();
        };
        const timer = timing.setTimeout(function () {
            timedOut = true;
            const error = new Error('JSX timeout after ' + call.timeoutMs + 'ms');
            error.disposition = 'uncertain';
            settleCaller(call, call.reject, error);
            drain = enterDegraded(releaseOnce);
        }, call.timeoutMs);

        try {
            csInterface.evalScript(call.jsx, function (result) {
                if (callbackSeen) return;
                callbackSeen = true;
                timing.clearTimeout(timer);
                if (timedOut) {
                    recoverDrain(drain);
                    return;
                }
                if (typeof result === 'string' && result === EVALSCRIPT_ERR_SENTINEL) {
                    settleCaller(call, call.reject, withDisposition(new Error(result), 'failed'));
                } else {
                    settleCaller(call, call.resolve, result);
                }
                releaseOnce();
            });
        } catch (error) {
            timing.clearTimeout(timer);
            settleCaller(call, call.reject, withDisposition(error, 'not_dispatched'));
            releaseOnce();
        }
    });
}

// There is a single persistent ExtendScript engine with shared globals behind
// csInterface.evalScript. Calls chain on an engine-drain gate, not on the
// caller-facing result Promise. This keeps a timed-out script serialized even
// though its caller has already received a rejection.
function evalScript(jsx, timeoutMs) {
    pendingCalls += 1;
    let resolveCaller;
    let rejectCaller;
    const callerPromise = new Promise(function (resolve, reject) {
        resolveCaller = resolve;
        rejectCaller = reject;
    });
    const call = {
        jsx,
        timeoutMs,
        resolve: resolveCaller,
        reject: rejectCaller,
        settled: false,
        dispatched: false,
        deadlineReached: false,
        waitTimer: null,
    };

    waitingCalls.add(call);
    call.waitTimer = timing.setTimeout(function () {
        call.waitTimer = null;
        call.deadlineReached = true;
        if (state === 'degraded') rejectNotDispatched(call);
    }, timeoutMs);

    const run = queue.then(function () {
        if (call.settled) return undefined;
        return dispatchCall(call);
    }, function () {
        if (call.settled) return undefined;
        return dispatchCall(call);
    });
    queue = run.then(function () {}, function () {});
    return callerPromise;
}

function _setTimingForTest(overrides) {
    timing = Object.assign({}, timing, overrides || {});
}

module.exports = { setCSInterface, evalScript, getState, _setTimingForTest };
