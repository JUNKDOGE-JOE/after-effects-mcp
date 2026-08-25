'use strict';

const { appendHint } = require('./error-hints');

const NO_VALUE_SENTINELS = ['undefined', 'null'];
const EVALSCRIPT_ERR_SENTINEL = 'EvalScript error.';
const MISSING_COMPLETION_VALUE = "jsx evaluated to undefined: the script's last statement must be a bare expression, e.g. end with JSON.stringify(result); — a trailing var/if/for statement yields undefined, and a top-level return is invalid";

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

// ae_exec receives an explicit transport type. Unlike maintained JSX tools,
// arbitrary user code must never be interpreted by looking at its first byte.
function parseExecResult(resultType, text) {
    if (resultType === 'json') {
        if (typeof text !== 'string') return fail('ae_exec returned an invalid json result', text);
        return { ok: true, content: text, contentType: 'json' };
    }
    if (resultType !== 'string') {
        return fail('ae_exec returned an invalid result type', text);
    }
    if (!text || String(text).trim() === '') {
        return fail(
            'jsx returned no value (empty output); an uncaught ExtendScript throw can '
                + 'surface as empty evalScript output — wrap risky code in try/catch '
                + 'and return the error as JSON',
            text,
        );
    }
    const stripped = String(text).trim();
    if (NO_VALUE_SENTINELS.indexOf(stripped) !== -1) {
        return fail(
            MISSING_COMPLETION_VALUE.replace('jsx evaluated to undefined', 'jsx evaluated to ' + stripped),
            text,
        );
    }
    if (stripped === EVALSCRIPT_ERR_SENTINEL) return fail(stripped, text);
    return { ok: true, content: text, contentType: 'text' };
}

module.exports = { EVALSCRIPT_ERR_SENTINEL, parseJsxResult, parseExecResult };
