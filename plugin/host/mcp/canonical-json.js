'use strict';

// Shared Python-compatible canonical JSON for the native protocol and Tool
// Library hashes. Keep numeric/Unicode rejection identical across both users.

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function codePointCompare(left, right) {
    const a = Array.from(left);
    const b = Array.from(right);
    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
        const ac = a[index].codePointAt(0);
        const bc = b[index].codePointAt(0);
        if (ac !== bc) return ac - bc;
    }
    return a.length - b.length;
}

function hasUnpairedSurrogate(value) {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code >= 0xD800 && code <= 0xDBFF) {
            const next = value.charCodeAt(index + 1);
            if (next >= 0xDC00 && next <= 0xDFFF) {
                index += 1;
                continue;
            }
            return true;
        }
        if (code >= 0xDC00 && code <= 0xDFFF) return true;
    }
    return false;
}

function assertCanonicalValue(value, depth) {
    const level = depth || 0;
    if (level > 16) throw new TypeError('native JSON exceeds the maximum nesting depth');
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'string') {
        if (hasUnpairedSurrogate(value)) {
            throw new TypeError('native JSON contains an invalid Unicode scalar');
        }
        return;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || Object.is(value, -0)) {
            throw new TypeError('native JSON requires finite non-negative-zero numbers');
        }
        if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
            throw new TypeError('native JSON integer exceeds the safe range');
        }
        return;
    }
    if (Array.isArray(value)) {
        value.forEach(function (item) { assertCanonicalValue(item, level + 1); });
        return;
    }
    if (!isPlainObject(value)) throw new TypeError('native JSON contains an unsupported value');
    Object.keys(value).forEach(function (key) {
        assertCanonicalValue(key, level + 1);
        assertCanonicalValue(value[key], level + 1);
    });
}

function canonicalNumber(value) {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
        throw new TypeError('native JSON requires finite non-negative-zero numbers');
    }
    if (Number.isInteger(value)) {
        if (!Number.isSafeInteger(value)) throw new TypeError('native JSON integer exceeds the safe range');
        return String(value);
    }
    const serialized = JSON.stringify(value);
    if (!serialized || /[eE]/.test(serialized) || Math.abs(value) < 0.0001) {
        throw new TypeError('native JSON number has no cross-runtime spelling');
    }
    return serialized;
}

function canonicalJson(value) {
    assertCanonicalValue(value);
    if (value === null) return 'null';
    if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number') return canonicalNumber(value);
    if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
    return '{' + Object.keys(value).sort(codePointCompare).map(function (key) {
        return JSON.stringify(key) + ':' + canonicalJson(value[key]);
    }).join(',') + '}';
}

function isClosedNativeJson(value, depth) {
    const level = depth || 0;
    if (level > 16) return false;
    if (value === null || typeof value === 'boolean') return true;
    if (typeof value === 'string') return !hasUnpairedSurrogate(value);
    if (typeof value === 'number') return Number.isSafeInteger(value);
    if (Array.isArray(value)) return value.every(function (item) {
        return isClosedNativeJson(item, level + 1);
    });
    if (!isPlainObject(value)) return false;
    return Object.keys(value).every(function (key) {
        return typeof key === 'string' && isClosedNativeJson(value[key], level + 1);
    });
}

module.exports = { canonicalJson, isClosedNativeJson };
