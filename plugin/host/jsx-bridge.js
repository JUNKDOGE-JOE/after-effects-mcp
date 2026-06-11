// Bridge between Node.js (CEP host process) and AE ExtendScript via CSInterface.
// CSInterface is loaded in the parent (panel) process; we accept it via setCSInterface.
// Must equal EvalScript_ErrMessage in plugin/client/CSInterface.js:33 (vendored
// Adobe constant). CEP returns it VERBATIM on uncaught ExtendScript errors -
// no detail suffix - so exact equality is the correct check (a bare prefix
// match false-positives legitimate strings like "EvalScript errors found: 0").
// Python backstop with the same constant: packages/core/ae_mcp/jsx_result.py.
const EVALSCRIPT_ERR_SENTINEL = 'EvalScript error.';

let csInterface = null;

function setCSInterface(cs) {
    csInterface = cs;
}

// There is a single persistent ExtendScript engine with shared globals behind
// csInterface.evalScript. Two overlapping evalScript calls would interleave and
// half-apply edits, so we serialize: each call chains off the previous one and
// only runs once its predecessor has resolved/rejected/timed out. The tail of
// the chain is `queue`; we deliberately swallow its rejection in the chain so a
// failed call never poisons the queue for the next caller.
let queue = Promise.resolve();

function evalScriptInner(jsx, timeoutMs) {
    return new Promise((resolve, reject) => {
        if (!csInterface) {
            reject(new Error('CSInterface not initialized'));
            return;
        }
        let settled = false;
        const finish = (fn, arg) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn(arg);
        };
        const timer = setTimeout(() => {
            finish(reject, new Error('JSX timeout after ' + timeoutMs + 'ms'));
        }, timeoutMs);
        try {
            csInterface.evalScript(jsx, (result) => {
                if (typeof result === 'string' && result === EVALSCRIPT_ERR_SENTINEL) {
                    finish(reject, new Error(result));
                } else {
                    finish(resolve, result);
                }
            });
        } catch (e) {
            finish(reject, e);
        }
    });
}

function evalScript(jsx, timeoutMs) {
    // Chain this call after whatever is currently in flight. Whether the prior
    // call resolved or rejected, we proceed (the `.catch` keeps the chain
    // alive) so a timed-out/rejected call still releases the lock.
    const run = queue.then(
        () => evalScriptInner(jsx, timeoutMs),
        () => evalScriptInner(jsx, timeoutMs)
    );
    // Advance the queue tail to this call's completion, swallowing its result so
    // the next caller's `.then` always fires regardless of success/failure.
    queue = run.then(function () {}, function () {});
    return run;
}

module.exports = { setCSInterface, evalScript };
