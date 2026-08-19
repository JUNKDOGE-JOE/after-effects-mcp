'use strict';

const { appendHint } = require('./error-hints');

const NO_VALUE_SENTINELS = ['undefined', 'null'];
const EVALSCRIPT_ERR_SENTINEL = 'EvalScript error.';

function fail(error, raw) {
    return { ok: false, error: appendHint(error), raw };
}

function parseJsxResult(text) {
    if (!text || String(text).trim() === '') {
        return fail('jsx returned no value (empty output)', text);
    }
    const stripped = String(text).trim();
    if (NO_VALUE_SENTINELS.indexOf(stripped) !== -1) {
        return fail(
            'jsx evaluated to ' + stripped
                + '; ensure your code returns JSON.stringify(...) or a value',
            text,
        );
    }
    if (stripped === EVALSCRIPT_ERR_SENTINEL) return fail(stripped, text);
    if (stripped.slice(0, 1) === '{' || stripped.slice(0, 1) === '[') {
        try {
            return JSON.parse(stripped);
        } catch (error) {
            return fail(
                'jsx returned JSON-like text that failed to parse: '
                    + (error && error.message ? error.message : String(error)),
                text,
            );
        }
    }
    return { ok: true, content: text };
}

module.exports = { EVALSCRIPT_ERR_SENTINEL, parseJsxResult };
