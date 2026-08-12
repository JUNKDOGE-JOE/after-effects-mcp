'use strict';

// Runtime polyfills for the CEP-embedded engines on AE 2023/2024.
// CEP 11 ships Node 15.x / V8 8.8 (Chromium 88): `require('node:x')` fails to
// resolve there (module-resolution class, guarded by cep-runtime-contract
// tests) and several newer runtime APIs simply do not exist. This shim closes
// the runtime-API class in one place. It must stay dependency-free, use only
// ES2020 syntax, and be loaded before any other host module:
//   - plugin/host/server.js requires it first (covers every CEP host module);
//   - the panel bundle injects it via esbuild (covers the CEP page context).
// Every definition is conditional, so on current Node/Chromium this is a no-op.

/* eslint-disable no-extend-native */

if (typeof Object.hasOwn !== 'function') {
    Object.defineProperty(Object, 'hasOwn', {
        value: function hasOwn(target, key) {
            return Object.prototype.hasOwnProperty.call(Object(target), key);
        },
        writable: true,
        configurable: true,
    });
}

function defineAt(proto) {
    if (!proto || typeof proto.at === 'function') return;
    Object.defineProperty(proto, 'at', {
        value: function at(index) {
            const length = this.length >>> 0;
            let position = Math.trunc(Number(index) || 0);
            if (position < 0) position += length;
            if (position < 0 || position >= length) return undefined;
            return this[position];
        },
        writable: true,
        configurable: true,
    });
}

defineAt(Array.prototype);
defineAt(typeof String !== 'undefined' ? String.prototype : null);

if (typeof globalThis.structuredClone !== 'function') {
    // Sufficient for JSON-shaped data, which is all the panel/host exchange.
    globalThis.structuredClone = function structuredClone(value) {
        if (value === undefined) return undefined;
        return JSON.parse(JSON.stringify(value));
    };
}

module.exports = {};
