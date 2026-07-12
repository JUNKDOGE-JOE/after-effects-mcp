'use strict';

const DEFAULT_MAX_MESSAGE_BYTES = 65536;
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;

const HELPER_METHODS = Object.freeze([
    'capabilities',
    'secret.get',
    'secret.set',
    'secret.delete',
    'window.find',
    'window.describe',
    'window.capture',
]);

const HELPER_METHOD_SET = new Set(HELPER_METHODS);
const HELPER_ERROR_CODES = new Set([
    'HELPER_UNAUTHORIZED',
    'HELPER_UNAVAILABLE',
    'PROTOCOL_VERSION_UNSUPPORTED',
    'INVALID_REQUEST',
    'INVALID_REFERENCE',
    'MESSAGE_TOO_LARGE',
    'SECRET_NOT_FOUND',
    'SECRET_CONFLICT',
    'SECRET_STORE_UNAVAILABLE',
    'SCREEN_RECORDING_PERMISSION_REQUIRED',
    'AE_WINDOW_NOT_FOUND',
    'AE_WINDOW_NOT_CAPTURABLE',
    'CAPTURE_FAILED',
]);
const TRANSPORT_ERROR_CODES = new Set([
    ...HELPER_ERROR_CODES,
    'HELPER_START_FAILED',
    'PLATFORM_HELPER_REPAIR_REQUIRED',
]);

const SECRET_REFERENCE_PATTERN = /^aemcp-secret:\/\/provider\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[a-z][a-z0-9_-]{0,31}\/v1$/;
const CAPTURE_METHODS = new Set(['auto', 'DesktopCopy', 'PrintWindow']);

function makeHelperError(code, message, retryable) {
    const error = new Error(message);
    error.code = code;
    error.retryable = Boolean(retryable);
    return error;
}

function safeHelperFailureMessage(code) {
    return 'platform helper request failed with ' + code;
}

function positiveIntegerOption(value, fallback, name) {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(name + ' must be a positive safe integer');
    }
    return value;
}

function exactKeys(value, expected) {
    return value !== null
        && typeof value === 'object'
        && !Array.isArray(value)
        && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected.slice().sort());
}

function requiredAndOptionalKeys(value, required, optional) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const allowed = new Set(required.concat(optional));
    return required.every(function (key) { return Object.hasOwn(value, key); })
        && Object.keys(value).every(function (key) { return allowed.has(key); });
}

function positiveSafeInteger(value) {
    return Number.isSafeInteger(value) && value > 0;
}

function finiteAtLeast(value, minimum) {
    return typeof value === 'number' && Number.isFinite(value) && value >= minimum;
}

function secretReference(value) {
    return typeof value === 'string' && SECRET_REFERENCE_PATTERN.test(value);
}

function invalidParams(code) {
    throw makeHelperError(code || 'INVALID_REQUEST', 'platform helper parameters are invalid', false);
}

function validateParams(method, params) {
    if (params === null || typeof params !== 'object' || Array.isArray(params)) invalidParams();
    if (method === 'capabilities') {
        if (!exactKeys(params, [])) invalidParams();
        return;
    }
    if (method === 'secret.get') {
        if (!exactKeys(params, ['reference']) || !secretReference(params.reference)) {
            invalidParams('INVALID_REFERENCE');
        }
        return;
    }
    if (method === 'secret.set') {
        if (!exactKeys(params, ['reference', 'value', 'expectedRevision'])) invalidParams();
        if (!secretReference(params.reference)) invalidParams('INVALID_REFERENCE');
        if (typeof params.value !== 'string'
            || (params.expectedRevision !== null && !positiveSafeInteger(params.expectedRevision))) {
            invalidParams();
        }
        return;
    }
    if (method === 'secret.delete') {
        if (!requiredAndOptionalKeys(params, ['reference'], ['expectedRevision'])) invalidParams();
        if (!secretReference(params.reference)) invalidParams('INVALID_REFERENCE');
        if (Object.hasOwn(params, 'expectedRevision') && !positiveSafeInteger(params.expectedRevision)) {
            invalidParams();
        }
        return;
    }
    if (method === 'window.find') {
        if (!requiredAndOptionalKeys(params, [], ['target'])
            || (Object.hasOwn(params, 'target') && params.target !== 'after-effects-main')) {
            invalidParams();
        }
        return;
    }
    if (method === 'window.describe') {
        if (!exactKeys(params, ['reference'])
            || typeof params.reference !== 'string'
            || params.reference.length === 0) invalidParams('INVALID_REFERENCE');
        return;
    }
    if (method === 'window.capture') {
        if (!requiredAndOptionalKeys(params, ['captureId'], ['reference', 'target', 'method'])
            || typeof params.captureId !== 'string'
            || params.captureId.length === 0
            || (!Object.hasOwn(params, 'reference') && !Object.hasOwn(params, 'target'))
            || (Object.hasOwn(params, 'reference')
                && (typeof params.reference !== 'string' || params.reference.length === 0))
            || (Object.hasOwn(params, 'target') && params.target !== 'after-effects-main')
            || (Object.hasOwn(params, 'method') && !CAPTURE_METHODS.has(params.method))) {
            invalidParams();
        }
    }
}

function validWindowDescription(value) {
    return exactKeys(value, [
        'reference',
        'application',
        'ownerBundleId',
        'ownerTeamId',
        'processId',
        'title',
        'frame',
        'scale',
        'capturable',
    ])
        && typeof value.reference === 'string'
        && value.reference.length > 0
        && value.application === 'after-effects'
        && value.ownerBundleId === 'com.adobe.AfterEffects.application'
        && value.ownerTeamId === 'JQ525L2MZD'
        && positiveSafeInteger(value.processId)
        && typeof value.title === 'string'
        && exactKeys(value.frame, ['x', 'y', 'width', 'height'])
        && finiteAtLeast(value.frame.x, -Number.MAX_VALUE)
        && finiteAtLeast(value.frame.y, -Number.MAX_VALUE)
        && finiteAtLeast(value.frame.width, 0)
        && finiteAtLeast(value.frame.height, 0)
        && finiteAtLeast(value.scale, 0)
        && typeof value.capturable === 'boolean';
}

function validCapabilities(value) {
    return exactKeys(value, [
        'protocolVersion',
        'platform',
        'helperVersion',
        'secretBackend',
        'captureBackend',
        'authenticatedCaller',
        'maxMessageBytes',
        'methods',
    ])
        && value.protocolVersion === 1
        && (value.platform === 'macos-arm64' || value.platform === 'windows-x64')
        && typeof value.helperVersion === 'string'
        && value.helperVersion.length > 0
        && (value.secretBackend === 'keychain' || value.secretBackend === 'credential-manager')
        && (value.captureBackend === 'screen-capture-kit'
            || value.captureBackend === 'windows-graphics-capture')
        && value.authenticatedCaller === true
        && value.maxMessageBytes === DEFAULT_MAX_MESSAGE_BYTES
        && Array.isArray(value.methods)
        && value.methods.length === HELPER_METHODS.length
        && new Set(value.methods).size === HELPER_METHODS.length
        && value.methods.every(function (method) { return HELPER_METHOD_SET.has(method); });
}

function validResult(method, value) {
    if (method === 'capabilities') return validCapabilities(value);
    if (method === 'secret.get') {
        return exactKeys(value, ['reference', 'value', 'revision'])
            && secretReference(value.reference)
            && typeof value.value === 'string'
            && positiveSafeInteger(value.revision);
    }
    if (method === 'secret.set') {
        return exactKeys(value, ['reference', 'revision'])
            && secretReference(value.reference)
            && positiveSafeInteger(value.revision);
    }
    if (method === 'secret.delete') {
        return exactKeys(value, ['reference', 'deleted', 'revision'])
            && secretReference(value.reference)
            && typeof value.deleted === 'boolean'
            && (value.revision === null || positiveSafeInteger(value.revision));
    }
    if (method === 'window.find') {
        return Array.isArray(value) && value.every(validWindowDescription);
    }
    if (method === 'window.describe') return validWindowDescription(value);
    return exactKeys(value, [
        'captureId', 'reference', 'spoolPath', 'width', 'height', 'scale', 'method', 'sha256',
    ])
        && typeof value.captureId === 'string'
        && value.captureId.length > 0
        && typeof value.reference === 'string'
        && value.reference.length > 0
        && typeof value.spoolPath === 'string'
        && value.spoolPath.length > 0
        && positiveSafeInteger(value.width)
        && positiveSafeInteger(value.height)
        && finiteAtLeast(value.scale, 0)
        && (value.method === 'ScreenCaptureKit' || value.method === 'WindowsGraphicsCapture')
        && typeof value.sha256 === 'string'
        && /^[0-9a-f]{64}$/.test(value.sha256);
}

function parseResponse(raw, requestId, method, maxMessageBytes) {
    if (typeof raw !== 'string') {
        throw makeHelperError('INVALID_REQUEST', 'helper response must be a UTF-8 JSON string', false);
    }
    if (Buffer.byteLength(raw, 'utf8') > maxMessageBytes) {
        throw makeHelperError('MESSAGE_TOO_LARGE', 'helper response exceeds the message limit', false);
    }

    let response;
    try {
        response = JSON.parse(raw);
    } catch {
        throw makeHelperError('INVALID_REQUEST', 'helper returned malformed JSON', false);
    }
    if (response === null || typeof response !== 'object' || Array.isArray(response)) {
        throw makeHelperError('INVALID_REQUEST', 'helper returned an invalid response envelope', false);
    }
    if (response.protocolVersion !== 1) {
        throw makeHelperError(
            'PROTOCOL_VERSION_UNSUPPORTED',
            'helper response protocolVersion must be 1',
            false,
        );
    }
    if (!Number.isSafeInteger(response.id) || response.id <= 0 || response.id !== requestId) {
        throw makeHelperError('INVALID_REQUEST', 'helper response ID does not match the request', false);
    }

    if (response.ok === true) {
        if (!exactKeys(response, ['protocolVersion', 'id', 'ok', 'result'])) {
            throw makeHelperError('INVALID_REQUEST', 'helper success envelope is malformed', false);
        }
        if (!validResult(method, response.result)) {
            throw makeHelperError('INVALID_REQUEST', 'helper success result is malformed', false);
        }
        return response.result;
    }
    if (response.ok !== false
        || !exactKeys(response, ['protocolVersion', 'id', 'ok', 'error'])
        || !exactKeys(response.error, ['code', 'message', 'retryable'])
        || !HELPER_ERROR_CODES.has(response.error.code)
        || typeof response.error.message !== 'string'
        || response.error.message.length < 1
        || response.error.message.length > 4096
        || typeof response.error.retryable !== 'boolean') {
        throw makeHelperError('INVALID_REQUEST', 'helper failure envelope is malformed', false);
    }
    throw makeHelperError(
        response.error.code,
        safeHelperFailureMessage(response.error.code),
        response.error.retryable,
    );
}

function createPlatformHelperClient(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new TypeError('platform helper client input is required');
    }
    const transport = input.transport;
    if (!transport
        || typeof transport.request !== 'function'
        || typeof transport.close !== 'function') {
        throw new TypeError('transport must provide request and close functions');
    }
    const maxMessageBytes = positiveIntegerOption(
        input.maxMessageBytes,
        DEFAULT_MAX_MESSAGE_BYTES,
        'maxMessageBytes',
    );
    const requestTimeoutMs = positiveIntegerOption(
        input.requestTimeoutMs,
        DEFAULT_REQUEST_TIMEOUT_MS,
        'requestTimeoutMs',
    );

    let nextId = 1;
    let closed = false;
    let closePromise = null;

    async function transportRequest(jsonUtf8) {
        let timer;
        const timeout = new Promise(function (_resolve, reject) {
            timer = setTimeout(function () {
                reject(makeHelperError(
                    'HELPER_UNAVAILABLE',
                    'platform helper request timed out after ' + requestTimeoutMs + 'ms',
                    true,
                ));
            }, requestTimeoutMs);
        });
        try {
            return await Promise.race([
                Promise.resolve().then(function () { return transport.request(jsonUtf8); }),
                timeout,
            ]);
        } catch (error) {
            if (error && TRANSPORT_ERROR_CODES.has(error.code)) {
                throw makeHelperError(
                    error.code,
                    safeHelperFailureMessage(error.code),
                    error.retryable,
                );
            }
            throw makeHelperError(
                'HELPER_UNAVAILABLE',
                'platform helper transport failed',
                true,
            );
        } finally {
            clearTimeout(timer);
        }
    }

    async function send(method, params) {
        if (closed) {
            throw makeHelperError('HELPER_UNAVAILABLE', 'platform helper client is closed', false);
        }
        if (!HELPER_METHOD_SET.has(method)) {
            throw makeHelperError('INVALID_REQUEST', 'unknown platform helper method', false);
        }
        validateParams(method, params);
        if (nextId > Number.MAX_SAFE_INTEGER) {
            throw makeHelperError('INVALID_REQUEST', 'platform helper request ID space exhausted', false);
        }
        const id = nextId;
        nextId += 1;
        const request = { protocolVersion: 1, id, method, params };
        let jsonUtf8;
        try {
            jsonUtf8 = JSON.stringify(request);
        } catch {
            throw makeHelperError('INVALID_REQUEST', 'helper request is not serializable', false);
        }
        if (Buffer.byteLength(jsonUtf8, 'utf8') > maxMessageBytes) {
            throw makeHelperError('MESSAGE_TOO_LARGE', 'helper request exceeds the message limit', false);
        }
        return parseResponse(await transportRequest(jsonUtf8), id, method, maxMessageBytes);
    }

    function close() {
        if (closePromise) return closePromise;
        closed = true;
        closePromise = Promise.resolve().then(function () { return transport.close(); });
        return closePromise;
    }

    return Object.freeze({
        capabilities: function () { return send('capabilities', {}); },
        secretGet: function (reference) { return send('secret.get', { reference }); },
        secretSet: function (value) { return send('secret.set', value); },
        secretDelete: function (value) { return send('secret.delete', value); },
        windowFind: function (value) { return send('window.find', value === undefined ? {} : value); },
        windowDescribe: function (reference) { return send('window.describe', { reference }); },
        windowCapture: function (value) { return send('window.capture', value); },
        close,
    });
}

module.exports = {
    DEFAULT_MAX_MESSAGE_BYTES,
    DEFAULT_REQUEST_TIMEOUT_MS,
    HELPER_METHODS,
    createPlatformHelperClient,
};
