'use strict';

const crypto = require('crypto');
const generated = require('./generated/native_exec.generated.json');
const rpcSchema = require('./generated/aegp-rpc.schema.json');
const { canonicalJson, isClosedNativeJson } = require('./canonical-json');
const { createValidator, isPlainObject } = require('./json-schema-lite');

const CAPABILITY_ID = 'ae.native.exec';
const CAPABILITY_VERSION = 1;
const NATIVE_EXEC_TIMEOUT_MS = 30000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const OPERATION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,63}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PLATFORMS = new Set(['macos-arm64', 'windows-x64']);
const CAPABILITY_DETAIL_ERROR_CODES = new Set([
    'NATIVE_UNSUPPORTED', 'PRECONDITION_FAILED', 'STALE_LOCATOR',
    'CAPABILITY_FAILED', 'POSSIBLY_SIDE_EFFECTING_FAILURE',
]);

const NATIVE_EXEC_INPUT_SCHEMA = generated.NATIVE_EXEC_INPUT_SCHEMA;
const PRIMITIVES = generated.PRIMITIVES;
const PRIMITIVE_BY_ID = new Map(PRIMITIVES.map(function (primitive) {
    return [primitive.id, primitive];
}));
const SCHEMA_DOCUMENTS = { 'aegp-rpc.schema.json': rpcSchema };
const INPUT_VALIDATOR = createValidator(NATIVE_EXEC_INPUT_SCHEMA, {
    documents: SCHEMA_DOCUMENTS,
});
const RESULT_VALIDATORS = new Map(PRIMITIVES.map(function (primitive) {
    return [primitive.id, createValidator(primitive.resultSchema, {
        documents: SCHEMA_DOCUMENTS,
    })];
}));

// Providers resend every advertised tool schema on every agent loop. The full
// generated native contract is intentionally strict, but advertising all 23
// per-operation argument schemas adds roughly 25 KB to every model request.
// Keep the wire-facing schema compact and let the unchanged generated
// validator below remain authoritative for the exact operation arguments.
// Models obtain those exact per-op contracts by calling ae_skillUse with
// ae-execution-guide only when they actually choose the native route.
const NATIVE_EXEC_ADVERTISED_INPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['operations'],
    properties: {
        operationKey: {
            type: 'string',
            minLength: 16,
            maxLength: 64,
            pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$',
            description: 'Stable idempotency key for a write program. Reuse it only when safely retrying the same server-issued operation.',
        },
        undoGroup: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
            description: 'One real After Effects Undo-group label. Required for writes and omitted for read-only programs.',
        },
        operations: {
            type: 'array',
            minItems: 1,
            maxItems: 64,
            description: 'Ordered native operations. Call ae_skillUse with name "ae-execution-guide" for the exact args contract before using this route.',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['op', 'args'],
                properties: {
                    op: {
                        type: 'string',
                        enum: PRIMITIVES.map(function (primitive) { return primitive.id; }),
                        description: 'Curated native primitive ID from the ae-execution-guide returned by ae_skillUse.',
                    },
                    args: {
                        type: 'object',
                        description: 'Operation-specific arguments copied from the ae-execution-guide returned by ae_skillUse. The server validates the full generated contract.',
                    },
                    saveAs: {
                        type: 'string', minLength: 1, maxLength: 64,
                        description: 'Request-local handle name for a later operation.',
                    },
                    returnAs: {
                        type: 'string', minLength: 1, maxLength: 64,
                        description: 'Name under which an exportable result is returned.',
                    },
                },
            },
        },
    },
};

function own(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function exactKeys(value, required, optional) {
    if (!isPlainObject(value)) return false;
    const allowed = new Set(required.concat(optional || []));
    return required.every(function (key) { return own(value, key); })
        && Object.keys(value).every(function (key) { return allowed.has(key); });
}

function sha256ClosedJson(value) {
    return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function compactTopLevel(value) {
    const output = {};
    Object.keys(value).forEach(function (key) {
        if (value[key] !== undefined && value[key] !== null) output[key] = value[key];
    });
    return output;
}

function validateNativeProgramArguments(value) {
    const errors = INPUT_VALIDATOR.errors(value);
    if (errors.length === 0 && !isClosedNativeJson(value)) {
        errors.push({ path: '$', message: 'must contain only closed native JSON values' });
    }
    if (errors.length > 0 || !isPlainObject(value) || !Array.isArray(value.operations)) return errors;

    const savedKinds = new Map();
    const publicNames = new Set();
    value.operations.forEach(function (operation, index) {
        const primitive = PRIMITIVE_BY_ID.get(operation.op);
        if (!primitive) return;
        const argumentsValue = operation.args;
        Object.keys(primitive.referenceArguments).forEach(function (field) {
            const reference = primitive.referenceArguments[field];
            if (!own(argumentsValue, field)) {
                if (reference.required) errors.push({
                    path: 'operations[' + index + '].args.' + field,
                    message: 'is required',
                });
                return;
            }
            const referencedName = argumentsValue[field].ref;
            const actualKind = savedKinds.get(referencedName);
            if (actualKind === undefined) {
                errors.push({
                    path: 'operations[' + index + '].args.' + field,
                    message: 'must reference an earlier saved value',
                });
                return;
            }
            if (actualKind !== reference.kind) {
                errors.push({
                    path: 'operations[' + index + '].args.' + field,
                    message: 'expects ' + reference.kind + ', got ' + actualKind,
                });
            }
        });
        [['saveAs', operation.saveAs], ['returnAs', operation.returnAs]].forEach(function (entry) {
            const field = entry[0];
            const name = entry[1];
            if (name === undefined) return;
            if (publicNames.has(name)) {
                errors.push({
                    path: 'operations[' + index + '].' + field,
                    message: 'duplicates named value ' + name,
                });
            }
            publicNames.add(name);
        });
        if (operation.returnAs !== undefined && primitive.exportable !== true) {
            errors.push({
                path: 'operations[' + index + '].returnAs',
                message: 'cannot export ' + primitive.resultKind,
            });
        }
        if (operation.saveAs !== undefined) savedKinds.set(operation.saveAs, primitive.resultKind);
    });
    return errors;
}

function structuredError(code, message, options) {
    const input = options || {};
    const error = new Error(message);
    error.code = code;
    error.retryable = input.retryable === true;
    error.sideEffect = input.sideEffect || 'not-started';
    error.recovery = input.recovery || { action: 'refresh-capabilities', hint: 'Refresh negotiated native capabilities before retrying.' };
    if (input.details !== undefined) error.details = input.details;
    return error;
}

function nativeProgramResultError(request, message, afterDispatch) {
    const operationKey = request.arguments.operationKey;
    if (afterDispatch && operationKey !== undefined) {
        return structuredError('POSSIBLY_SIDE_EFFECTING_FAILURE', message, {
            retryable: false,
            sideEffect: 'may-have-occurred',
            recovery: {
                action: 'inspect-state',
                hint: 'Run a read-only native program and inspect audit evidence before deciding whether to retry.',
            },
            details: { capabilityId: CAPABILITY_ID, operationKey },
        });
    }
    return structuredError('NATIVE_CONTRACT_MISMATCH', message, {
        retryable: false,
        sideEffect: 'not-started',
        recovery: {
            action: 'refresh-capabilities',
            hint: 'Refresh the authenticated native contract before retrying.',
        },
    });
}

function makeRequestId() {
    function word() {
        return ('00000000' + Math.floor(Math.random() * 0x100000000).toString(16)).slice(-8);
    }
    return 'mcp-' + ('00000000' + Date.now().toString(16)).slice(-8) + word() + word() + word();
}

function buildNativeProgramRequest(options) {
    const input = options || {};
    const errors = validateNativeProgramArguments(input.args);
    if (errors.length > 0) {
        const error = structuredError('INVALID_ARGUMENT', 'native program arguments failed the generated contract', {
            retryable: false,
            sideEffect: 'not-started',
            recovery: { action: 'change-arguments', hint: 'Correct the rejected native program arguments before retrying.' },
            details: { field: 'arguments.' + errors[0].path, capabilityId: CAPABILITY_ID },
        });
        error.validationErrors = errors;
        throw error;
    }
    if (typeof input.requestId !== 'string' || !REQUEST_ID_PATTERN.test(input.requestId)
        || !Number.isSafeInteger(input.deadlineUnixMs) || input.deadlineUnixMs <= 0) {
        throw structuredError('INVALID_ARGUMENT', 'native program request identity is invalid', {
            retryable: false,
            sideEffect: 'not-started',
            recovery: { action: 'change-arguments', hint: 'Issue the native program with a valid request identity and deadline.' },
        });
    }
    const argumentsValue = compactTopLevel(input.args);
    const request = {
        requestId: input.requestId,
        capabilityId: CAPABILITY_ID,
        capabilityVersion: CAPABILITY_VERSION,
        arguments: argumentsValue,
        deadlineUnixMs: input.deadlineUnixMs,
    };
    // Python's programDigest is a computed model property, not a wire field;
    // keep the same distinction for the in-process client.
    Object.defineProperty(request, 'programDigest', {
        value: sha256ClosedJson(argumentsValue),
        enumerable: false,
        writable: false,
    });
    return request;
}

function invokeRequestDigest(request, negotiation) {
    return sha256ClosedJson({
        wireVersion: negotiation.selectedWireVersion,
        kind: 'request',
        sessionId: negotiation.sessionId,
        requestId: request.requestId,
        method: 'invoke',
        deadlineUnixMs: request.deadlineUnixMs,
        params: {
            capabilityId: request.capabilityId,
            capabilityVersion: request.capabilityVersion,
            arguments: request.arguments,
        },
    });
}

function nativeProgramPostconditionDigest(outputs, operations) {
    return sha256ClosedJson({ operations, outputs });
}

function validNegotiation(value) {
    return exactKeys(value, [
        'selectedWireVersion', 'pluginVersion', 'compiledSdkVersion', 'sourceCommit',
        'hostInstanceId', 'hostPlatform', 'sessionId', 'sessionGeneration', 'capabilitiesDigest',
    ])
        && value.selectedWireVersion === 1
        && typeof value.pluginVersion === 'string' && value.pluginVersion.length >= 1 && value.pluginVersion.length <= 64
        && typeof value.compiledSdkVersion === 'string' && value.compiledSdkVersion.length >= 1 && value.compiledSdkVersion.length <= 64
        && typeof value.sourceCommit === 'string' && /^[0-9a-f]{40}$/.test(value.sourceCommit)
        && UUID_PATTERN.test(value.hostInstanceId) && PLATFORMS.has(value.hostPlatform)
        && UUID_PATTERN.test(value.sessionId)
        && Number.isSafeInteger(value.sessionGeneration) && value.sessionGeneration > 0
        && SHA256_PATTERN.test(value.capabilitiesDigest);
}

function validOperationSummary(value, status) {
    return exactKeys(value, ['index', 'op', 'status'])
        && Number.isSafeInteger(value.index) && value.index >= 0
        && typeof value.op === 'string' && PRIMITIVE_BY_ID.has(value.op)
        && value.status === status;
}

function validEvidence(value, postconditionVerified) {
    return exactKeys(value, [
        'engine', 'hostInstanceId', 'sessionId', 'requestId', 'capabilityId',
        'capabilityVersion', 'startedAtUnixMs', 'completedAtUnixMs', 'effect',
        'postcondition', 'requestDigest',
    ])
        && value.engine === 'native-aegp'
        && UUID_PATTERN.test(value.hostInstanceId) && UUID_PATTERN.test(value.sessionId)
        && typeof value.requestId === 'string' && REQUEST_ID_PATTERN.test(value.requestId)
        && value.capabilityId === CAPABILITY_ID && value.capabilityVersion === 1
        && Number.isSafeInteger(value.startedAtUnixMs) && value.startedAtUnixMs > 0
        && Number.isSafeInteger(value.completedAtUnixMs) && value.completedAtUnixMs >= value.startedAtUnixMs
        && ['none', 'committed', 'may-have-occurred'].indexOf(value.effect) !== -1
        && SHA256_PATTERN.test(value.requestDigest)
        && exactKeys(value.postcondition, ['verified', 'kind', 'algorithm', 'digest'])
        && typeof value.postcondition.verified === 'boolean'
        && value.postcondition.verified === postconditionVerified
        && value.postcondition.kind === 'native-program'
        && value.postcondition.algorithm === 'sha256-rfc8785-jcs-v1'
        && SHA256_PATTERN.test(value.postcondition.digest);
}

function validUndo(value) {
    return exactKeys(value, ['available', 'verified'], ['groupLabel'])
        && typeof value.available === 'boolean'
        && value.verified === false
        && (value.available
            ? typeof value.groupLabel === 'string' && value.groupLabel.length >= 1 && value.groupLabel.length <= 128
            : !own(value, 'groupLabel'));
}

function outputsMatchGeneratedContract(argumentsValue, outputs, completedCount) {
    if (!isPlainObject(outputs) || Object.keys(outputs).length > 64) return false;
    const expected = new Map();
    for (let index = 0; index < completedCount; index += 1) {
        const operation = argumentsValue.operations[index];
        if (!operation) return false;
        if (operation.returnAs === undefined) continue;
        const validator = RESULT_VALIDATORS.get(operation.op);
        if (typeof operation.returnAs !== 'string' || !validator) return false;
        expected.set(operation.returnAs, validator);
    }
    const outputKeys = Object.keys(outputs);
    if (outputKeys.length !== expected.size || outputKeys.some(function (key) { return !expected.has(key); })) return false;
    return outputKeys.every(function (key) {
        return validatorResult(expected.get(key), outputs[key]);
    });
}

function validatorResult(validator, value) {
    return validator.errors(value).length === 0;
}

function validSuccessShape(result) {
    if (!exactKeys(result, ['capabilityId', 'outputs', 'operations', 'evidence', 'undo', 'replayed'], ['operationKey'])) return false;
    if (result.capabilityId !== CAPABILITY_ID || typeof result.replayed !== 'boolean') return false;
    if (own(result, 'operationKey') && (!OperationKey(result.operationKey))) return false;
    if (!isPlainObject(result.outputs) || Object.keys(result.outputs).length > 64 || !isClosedNativeJson(result.outputs)) return false;
    if (!Array.isArray(result.operations) || result.operations.length > 64
        || result.operations.some(function (item) { return !validOperationSummary(item, 'completed'); })) return false;
    return validEvidence(result.evidence, true) && validUndo(result.undo);
}

function OperationKey(value) {
    return typeof value === 'string' && OPERATION_KEY_PATTERN.test(value);
}

function validateNativeProgramFailureDetails(details, request, negotiation) {
    if (!isPlainObject(details)
        || (!own(details, 'completedOperations') && !own(details, 'disposition'))) return;
    const valid = exactKeys(details, [
        'capabilityId', 'disposition', 'completedOperations', 'outputs', 'evidence', 'undo',
    ], ['operationKey', 'failedOperation'])
        && details.capabilityId === request.capabilityId
        && (!own(details, 'operationKey') || OperationKey(details.operationKey))
        && details.operationKey === request.arguments.operationKey
        && ['not-started', 'completed', 'possibly-side-effecting'].indexOf(details.disposition) !== -1
        && Array.isArray(details.completedOperations)
        && details.completedOperations.length <= 64
        && details.completedOperations.every(function (item) { return validOperationSummary(item, 'completed'); })
        && (details.failedOperation === undefined || validOperationSummary(details.failedOperation, 'failed'))
        && isPlainObject(details.outputs) && isClosedNativeJson(details.outputs)
        && validEvidence(details.evidence, false)
        && validUndo(details.undo)
        && (details.disposition !== 'possibly-side-effecting' || own(details, 'operationKey'))
        && (details.disposition !== 'not-started'
            || (details.completedOperations.length === 0
                && details.failedOperation === undefined
                && Object.keys(details.outputs).length === 0
                && details.undo.available === false))
        && details.evidence.effect === (details.disposition === 'possibly-side-effecting'
            ? 'may-have-occurred' : 'none');
    if (!valid) throw nativeProgramResultError(request, 'Native program failure did not match its negotiated request.', true);

    const requested = request.arguments.operations;
    const completedPrefix = details.completedOperations.every(function (operation, index) {
        return requested[index] !== undefined
            && operation.index === index && operation.op === requested[index].op;
    });
    let failedMatches = details.failedOperation === undefined;
    if (details.failedOperation !== undefined && details.completedOperations.length < requested.length) {
        const next = details.completedOperations.length;
        failedMatches = details.failedOperation.index === next
            && details.failedOperation.op === requested[next].op;
    }
    const expectedPostcondition = nativeProgramPostconditionDigest(details.outputs, details.completedOperations);
    const binding = details.evidence.requestId === request.requestId
        && details.evidence.hostInstanceId === negotiation.hostInstanceId
        && details.evidence.sessionId === negotiation.sessionId
        && details.evidence.requestDigest === invokeRequestDigest(request, negotiation)
        && completedPrefix && failedMatches
        && outputsMatchGeneratedContract(request.arguments, details.outputs, details.completedOperations.length)
        && details.evidence.postcondition.digest === expectedPostcondition
        && (!details.undo.available || details.undo.groupLabel === request.arguments.undoGroup);
    if (!binding) throw nativeProgramResultError(request, 'Native program failure did not match its negotiated request.', true);
}

function unwrapNativeError(error) {
    if (error && isPlainObject(error.error) && typeof error.error.code === 'string') return error.error;
    return error || new Error('native AEGP request failed');
}

function validateInvokeErrorBinding(error, request) {
    const source = unwrapNativeError(error);
    const details = isPlainObject(source.details) ? source.details : {};
    const capabilityId = details.capabilityId;
    if (!CAPABILITY_DETAIL_ERROR_CODES.has(source.code) && capabilityId !== CAPABILITY_ID) return;
    const keyMatches = details.operationKey === request.arguments.operationKey;
    if (capabilityId === request.capabilityId && keyMatches) return;
    throw nativeProgramResultError(request, 'Native program failure was not bound to its requested operation.', true);
}

function cancellationActive(cancellation) {
    if (!cancellation) return false;
    if (cancellation.isCancelled === true || cancellation.cancelled === true) return true;
    if (typeof cancellation.isCancelled === 'function' && cancellation.isCancelled()) return true;
    if (typeof cancellation.isCanceled === 'function' && cancellation.isCanceled()) return true;
    return false;
}

function ensureActive(deadlineUnixMs, cancellation) {
    if (cancellationActive(cancellation)) throw structuredError('CANCELLED', 'Native request was cancelled before dispatch.', {
        retryable: false, sideEffect: 'not-started', recovery: { action: 'none', hint: 'Issue a new request only if the result is still needed.' },
    });
    if (deadlineUnixMs <= Date.now()) throw structuredError('DEADLINE_EXCEEDED', 'Native request deadline elapsed before dispatch.', {
        retryable: true, sideEffect: 'not-started', recovery: { action: 'retry', hint: 'Retry the native request before its deadline elapses.' },
    });
}

async function invokeNativeProgram(options) {
    const input = options || {};
    const request = buildNativeProgramRequest(input);
    ensureActive(request.deadlineUnixMs, input.cancellation);
    if (typeof input.nativeNegotiate !== 'function' || typeof input.nativeInvoke !== 'function') {
        throw structuredError('NATIVE_UNAVAILABLE', 'The host does not expose the native AEGP execution plane.', {
            retryable: true, sideEffect: 'not-started', recovery: { action: 'reconnect', hint: 'Reconnect the native AEGP execution plane, then retry.' },
        });
    }
    const negotiation = await input.nativeNegotiate(request.deadlineUnixMs);
    if (!validNegotiation(negotiation)) {
        throw nativeProgramResultError(request, 'Native negotiation did not match its contract.', false);
    }
    ensureActive(request.deadlineUnixMs, input.cancellation);
    let result;
    try {
        result = await input.nativeInvoke(request);
    } catch (error) {
        validateInvokeErrorBinding(error, request);
        validateNativeProgramFailureDetails(unwrapNativeError(error).details, request, negotiation);
        throw error;
    }
    if (result && result.ok === true && result.result !== undefined) result = result.result;
    if (!validSuccessShape(result)) throw nativeProgramResultError(request, 'Native program result did not use the common program contract.', true);
    const operationKey = request.arguments.operationKey;
    const expectedOperations = request.arguments.operations.map(function (operation, index) {
        return [index, operation.op];
    });
    const actualOperations = result.operations.map(function (operation) {
        return [operation.index, operation.op];
    });
    const expectedPostcondition = nativeProgramPostconditionDigest(result.outputs, result.operations);
    const valid = result.capabilityId === request.capabilityId
        && (!operationKey ? !own(result, 'operationKey') : result.operationKey === operationKey)
        && result.evidence.requestId === request.requestId
        && result.evidence.hostInstanceId === negotiation.hostInstanceId
        && result.evidence.sessionId === negotiation.sessionId
        && result.evidence.requestDigest === invokeRequestDigest(request, negotiation)
        && result.evidence.completedAtUnixMs <= request.deadlineUnixMs
        && JSON.stringify(actualOperations) === JSON.stringify(expectedOperations)
        && outputsMatchGeneratedContract(request.arguments, result.outputs, result.operations.length)
        && result.evidence.postcondition.digest === expectedPostcondition
        && result.evidence.postcondition.verified === true
        && result.evidence.effect === (operationKey ? 'committed' : 'none')
        && result.undo.available === (operationKey !== undefined)
        && result.undo.groupLabel === request.arguments.undoGroup
        && (operationKey !== undefined || result.replayed === false);
    if (!valid) throw nativeProgramResultError(request, 'Native program result did not match its negotiated request.', true);
    return { negotiation, request, result, engine: 'native-aegp' };
}

function nativeProgramResponse(execution) {
    const result = execution.result;
    const negotiation = execution.negotiation;
    const request = execution.request;
    const response = Object.assign({ ok: true }, result);
    response.undo = { available: result.undo.available };
    if (result.undo.groupLabel !== undefined) response.undo.groupLabel = result.undo.groupLabel;
    response.provenance = {
        engine: result.evidence.engine,
        selectedWireVersion: negotiation.selectedWireVersion,
        pluginVersion: negotiation.pluginVersion,
        compiledSdkVersion: negotiation.compiledSdkVersion,
        sourceCommit: negotiation.sourceCommit,
        hostInstanceId: negotiation.hostInstanceId,
        sessionId: negotiation.sessionId,
        sessionGeneration: negotiation.sessionGeneration,
        capabilitiesDigest: negotiation.capabilitiesDigest,
    };
    response.audit = {
        requestId: request.requestId,
        capabilityId: result.capabilityId,
        operationKey: result.operationKey,
        programDigest: request.programDigest,
        requestDigest: result.evidence.requestDigest,
        postconditionAlgorithm: result.evidence.postcondition.algorithm,
        postconditionDigest: result.evidence.postcondition.digest,
        effect: result.evidence.effect,
        undoAvailable: result.undo.available,
        replayed: result.replayed,
        startedAtUnixMs: result.evidence.startedAtUnixMs,
        completedAtUnixMs: result.evidence.completedAtUnixMs,
    };
    if (result.operationKey === undefined) delete response.audit.operationKey;
    return response;
}

function nativeErrorPayload(error) {
    const source = unwrapNativeError(error);
    const code = typeof source.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(source.code)
        ? source.code : 'NATIVE_UNAVAILABLE';
    const policy = {
        NATIVE_UNAVAILABLE: [true, 'not-started', 'reconnect'],
        NATIVE_UNSUPPORTED: [false, 'not-started', 'refresh-capabilities'],
        NATIVE_CONTRACT_MISMATCH: [false, 'not-started', 'refresh-capabilities'],
        WIRE_VERSION_MISMATCH: [false, 'not-started', 'reconnect'],
        INVALID_REQUEST: [false, 'not-started', 'none'],
        INVALID_ARGUMENT: [false, 'not-started', 'change-arguments'],
        TRACK_MATTE_COMPOSITION_MISMATCH: [false, 'not-started', 'change-arguments'],
        LAYER_HAS_NO_AUDIO: [false, 'not-started', 'change-arguments'],
        LAYER_HAS_NO_VIDEO: [false, 'not-started', 'change-arguments'],
        DUPLICATE_REQUEST: [false, 'not-started', 'inspect-state'],
        PRECONDITION_FAILED: [false, 'not-started', 'open-project'],
        STALE_LOCATOR: [true, 'not-started', 'refresh-locator'],
        DEADLINE_EXCEEDED: [true, 'not-started', 'retry'],
        CANCELLED: [false, 'not-started', 'none'],
        QUEUE_FULL: [true, 'not-started', 'retry'],
        AE_SHUTTING_DOWN: [true, 'not-started', 'reconnect'],
        SESSION_STALE: [true, 'not-started', 'reconnect'],
        CAPABILITY_FAILED: [false, 'not-started', 'inspect-state'],
        POSSIBLY_SIDE_EFFECTING_FAILURE: [false, 'may-have-occurred', 'inspect-state'],
    }[code] || [true, 'not-started', 'reconnect'];
    const fixed = code === 'NATIVE_CONTRACT_MISMATCH';
    const recovery = !fixed && source.recovery && isPlainObject(source.recovery)
        ? Object.assign({}, source.recovery)
        : { action: policy[2], hint: fixed ? 'Refresh the authenticated native contract before retrying.' : 'Follow the recovery action before retrying the native request.' };
    const sideEffect = fixed
        ? 'not-started'
        : ['not-started', 'may-have-occurred', 'completed'].indexOf(source.sideEffect) >= 0
            ? source.sideEffect : policy[1];
    const payload = {
        ok: false,
        error: typeof source.message === 'string' && source.message ? source.message : 'Native AEGP request failed with ' + code + '.',
        code,
        retryable: fixed ? false : typeof source.retryable === 'boolean' ? source.retryable : policy[0],
        sideEffect,
        recovery,
    };
    if (isPlainObject(source.details)) payload.details = Object.assign({}, source.details);
    return payload;
}

module.exports = {
    CAPABILITY_ID,
    CAPABILITY_VERSION,
    NATIVE_EXEC_TIMEOUT_MS,
    NATIVE_EXEC_INPUT_SCHEMA,
    NATIVE_EXEC_ADVERTISED_INPUT_SCHEMA,
    PRIMITIVES,
    canonicalJson,
    sha256ClosedJson,
    validateNativeProgramArguments,
    buildNativeProgramRequest,
    makeRequestId,
    invokeRequestDigest,
    nativeProgramPostconditionDigest,
    outputsMatchGeneratedContract,
    invokeNativeProgram,
    nativeProgramResponse,
    nativeErrorPayload,
    nativeProgramResultError,
    validateInvokeErrorBinding,
    validateNativeProgramFailureDetails,
    ensureActive,
};
