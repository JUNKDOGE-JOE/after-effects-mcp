'use strict';

// ae_nativeExec — execute the frozen native AEGP primitive program contract
// directly from the CEP host process.

const { textResult } = require('../tool-result');
const { VERB_ANNOTATIONS } = require('../annotations');
const { enforce } = require('../approval-gate');
const {
    NATIVE_EXEC_TIMEOUT_MS,
    NATIVE_EXEC_ADVERTISED_INPUT_SCHEMA,
    validateNativeProgramArguments,
    makeRequestId,
    invokeNativeProgram,
    nativeProgramResponse,
    nativeErrorPayload,
} = require('../native-program');

const VALIDATION_MESSAGE = 'ae_nativeExec arguments did not match the generated native program schema.';

const definition = {
    name: 'ae_nativeExec',
    description: 'ae.nativeExec — execute one bounded linear program of curated AEGP primitives.\n\nUse ae.exec for operations supported by the maintained AE scripting object model. Native programs allow at most 64 ordered operations and may reference only earlier request-local values. Programs containing writes require one stable operationKey and one real AE undoGroup; read-only programs must omit both fields.',
    inputSchema: NATIVE_EXEC_ADVERTISED_INPUT_SCHEMA,
    annotations: Object.assign({}, VERB_ANNOTATIONS.ae_nativeExec, { openWorldHint: false }),
};

function validationResult(errors) {
    return {
        ok: false,
        error: VALIDATION_MESSAGE,
        errors,
    };
}

async function call(args, context, deps) {
    const input = args || {};
    const errors = validateNativeProgramArguments(input);
    if (errors.length > 0) return { result: textResult(validationResult(errors), true) };
    try {
        const denied = await enforce(
            'ae_nativeExec',
            Object.assign({}, context || {}, { arguments: input }),
            deps,
        );
        if (denied) return { result: textResult(denied, true) };
        const deadlineUnixMs = Date.now() + NATIVE_EXEC_TIMEOUT_MS;
        const status = deps && deps.getStatus;
        const execution = await invokeNativeProgram({
            requestId: makeRequestId(),
            args: input,
            deadlineUnixMs,
            nativeNegotiate: deps && deps.nativeNegotiate
                || status && status.nativeNegotiate,
            nativeInvoke: deps && deps.nativeInvoke
                || status && status.nativeInvoke,
        });
        return { result: textResult(nativeProgramResponse(execution), false) };
    } catch (error) {
        return { result: textResult(nativeErrorPayload(error), true) };
    }
}

module.exports = { definition, call, VALIDATION_MESSAGE, validationResult };
