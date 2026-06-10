// Bridge between Node.js (CEP host process) and AE ExtendScript via CSInterface.
// CSInterface is loaded in the parent (panel) process; we accept it via setCSInterface.
let csInterface = null;

function setCSInterface(cs) {
    csInterface = cs;
}

function evalScript(jsx, timeoutMs) {
    return new Promise((resolve, reject) => {
        if (!csInterface) {
            reject(new Error('CSInterface not initialized'));
            return;
        }
        const timer = setTimeout(() => {
            reject(new Error('JSX timeout after ' + timeoutMs + 'ms'));
        }, timeoutMs);
        try {
            csInterface.evalScript(jsx, (result) => {
                clearTimeout(timer);
                if (typeof result === 'string' && result.indexOf('EvalScript error') === 0) {
                    reject(new Error(result));
                } else {
                    resolve(result);
                }
            });
        } catch (e) {
            clearTimeout(timer);
            reject(e);
        }
    });
}

module.exports = { setCSInterface, evalScript };
