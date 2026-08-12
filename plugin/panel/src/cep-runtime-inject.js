// Injected first into the panel bundle (see build-options.mjs `inject`).
// CEP 11 on AE 2023/2024 runs Chromium 88 / V8 8.8: `target: es2019` already
// lowers syntax, but esbuild does not polyfill runtime APIs — this file closes
// that class for the page context. Keep it dependency-free, ES2019-syntax
// only, and side-effect only. The CEP *host* process gets the same polyfills
// from plugin/host/cep-runtime-compat.js.

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
defineAt(String.prototype);

if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = function structuredClone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  };
}
