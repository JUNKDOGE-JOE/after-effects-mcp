'use strict';

function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validId(value) {
    return value === null || typeof value === 'string'
        || (typeof value === 'number' && Number.isFinite(value));
}

function validateMessage(message) {
    if (!isObject(message)) return 'message must be an object';
    if (message.jsonrpc !== '2.0') return 'jsonrpc must equal "2.0"';
    if (typeof message.method !== 'string' || message.method.length === 0) {
        return 'method must be a non-empty string';
    }
    if (hasOwn(message, 'id') && !validId(message.id)) return 'id must be string, number, or null';
    if (hasOwn(message, 'params') && !isObject(message.params) && !Array.isArray(message.params)) {
        return 'params must be an object or array';
    }
    return null;
}

function requestId(message) {
    return hasOwn(message, 'id') ? message.id : null;
}

function isNotification(message) {
    return !hasOwn(message, 'id');
}

function isResponse(message) {
    if (!isObject(message) || message.jsonrpc !== '2.0' || !hasOwn(message, 'id') || !validId(message.id)) {
        return false;
    }
    const hasResult = hasOwn(message, 'result');
    const hasError = hasOwn(message, 'error');
    return !hasOwn(message, 'method') && hasResult !== hasError;
}

function result(message, value) {
    if (isNotification(message)) return null;
    return { jsonrpc: '2.0', id: requestId(message), result: value };
}

function error(id, code, message, data) {
    const body = { code, message };
    if (data !== undefined) body.data = data;
    return { jsonrpc: '2.0', id: id === undefined ? null : id, error: body };
}

function invalidRequest(message, detail) {
    return error(requestId(message || {}), -32600, 'Invalid Request', detail);
}

function invalidParams(message, detail) {
    return error(requestId(message), -32602, 'Invalid params', detail);
}

function methodNotFound(message) {
    return error(requestId(message), -32601, 'Method not found');
}

module.exports = {
    hasOwn,
    isObject,
    validateMessage,
    requestId,
    isNotification,
    isResponse,
    result,
    error,
    invalidRequest,
    invalidParams,
    methodNotFound,
};
