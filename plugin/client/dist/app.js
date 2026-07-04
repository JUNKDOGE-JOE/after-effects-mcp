(() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));

  // node_modules/react/cjs/react.production.min.js
  var require_react_production_min = __commonJS({
    "node_modules/react/cjs/react.production.min.js"(exports) {
      "use strict";
      var l = Symbol.for("react.element");
      var n = Symbol.for("react.portal");
      var p = Symbol.for("react.fragment");
      var q = Symbol.for("react.strict_mode");
      var r = Symbol.for("react.profiler");
      var t = Symbol.for("react.provider");
      var u = Symbol.for("react.context");
      var v = Symbol.for("react.forward_ref");
      var w = Symbol.for("react.suspense");
      var x = Symbol.for("react.memo");
      var y = Symbol.for("react.lazy");
      var z = Symbol.iterator;
      function A2(a) {
        if (null === a || "object" !== typeof a) return null;
        a = z && a[z] || a["@@iterator"];
        return "function" === typeof a ? a : null;
      }
      var B = { isMounted: function() {
        return false;
      }, enqueueForceUpdate: function() {
      }, enqueueReplaceState: function() {
      }, enqueueSetState: function() {
      } };
      var C2 = Object.assign;
      var D2 = {};
      function E(a, b, e) {
        this.props = a;
        this.context = b;
        this.refs = D2;
        this.updater = e || B;
      }
      E.prototype.isReactComponent = {};
      E.prototype.setState = function(a, b) {
        if ("object" !== typeof a && "function" !== typeof a && null != a) throw Error("setState(...): takes an object of state variables to update or a function which returns an object of state variables.");
        this.updater.enqueueSetState(this, a, b, "setState");
      };
      E.prototype.forceUpdate = function(a) {
        this.updater.enqueueForceUpdate(this, a, "forceUpdate");
      };
      function F() {
      }
      F.prototype = E.prototype;
      function G(a, b, e) {
        this.props = a;
        this.context = b;
        this.refs = D2;
        this.updater = e || B;
      }
      var H = G.prototype = new F();
      H.constructor = G;
      C2(H, E.prototype);
      H.isPureReactComponent = true;
      var I = Array.isArray;
      var J = Object.prototype.hasOwnProperty;
      var K = { current: null };
      var L3 = { key: true, ref: true, __self: true, __source: true };
      function M(a, b, e) {
        var d, c = {}, k = null, h = null;
        if (null != b) for (d in void 0 !== b.ref && (h = b.ref), void 0 !== b.key && (k = "" + b.key), b) J.call(b, d) && !L3.hasOwnProperty(d) && (c[d] = b[d]);
        var g = arguments.length - 2;
        if (1 === g) c.children = e;
        else if (1 < g) {
          for (var f = Array(g), m = 0; m < g; m++) f[m] = arguments[m + 2];
          c.children = f;
        }
        if (a && a.defaultProps) for (d in g = a.defaultProps, g) void 0 === c[d] && (c[d] = g[d]);
        return { $$typeof: l, type: a, key: k, ref: h, props: c, _owner: K.current };
      }
      function N(a, b) {
        return { $$typeof: l, type: a.type, key: b, ref: a.ref, props: a.props, _owner: a._owner };
      }
      function O(a) {
        return "object" === typeof a && null !== a && a.$$typeof === l;
      }
      function escape(a) {
        var b = { "=": "=0", ":": "=2" };
        return "$" + a.replace(/[=:]/g, function(a2) {
          return b[a2];
        });
      }
      var P = /\/+/g;
      function Q(a, b) {
        return "object" === typeof a && null !== a && null != a.key ? escape("" + a.key) : b.toString(36);
      }
      function R(a, b, e, d, c) {
        var k = typeof a;
        if ("undefined" === k || "boolean" === k) a = null;
        var h = false;
        if (null === a) h = true;
        else switch (k) {
          case "string":
          case "number":
            h = true;
            break;
          case "object":
            switch (a.$$typeof) {
              case l:
              case n:
                h = true;
            }
        }
        if (h) return h = a, c = c(h), a = "" === d ? "." + Q(h, 0) : d, I(c) ? (e = "", null != a && (e = a.replace(P, "$&/") + "/"), R(c, b, e, "", function(a2) {
          return a2;
        })) : null != c && (O(c) && (c = N(c, e + (!c.key || h && h.key === c.key ? "" : ("" + c.key).replace(P, "$&/") + "/") + a)), b.push(c)), 1;
        h = 0;
        d = "" === d ? "." : d + ":";
        if (I(a)) for (var g = 0; g < a.length; g++) {
          k = a[g];
          var f = d + Q(k, g);
          h += R(k, b, e, f, c);
        }
        else if (f = A2(a), "function" === typeof f) for (a = f.call(a), g = 0; !(k = a.next()).done; ) k = k.value, f = d + Q(k, g++), h += R(k, b, e, f, c);
        else if ("object" === k) throw b = String(a), Error("Objects are not valid as a React child (found: " + ("[object Object]" === b ? "object with keys {" + Object.keys(a).join(", ") + "}" : b) + "). If you meant to render a collection of children, use an array instead.");
        return h;
      }
      function S2(a, b, e) {
        if (null == a) return a;
        var d = [], c = 0;
        R(a, d, "", "", function(a2) {
          return b.call(e, a2, c++);
        });
        return d;
      }
      function T2(a) {
        if (-1 === a._status) {
          var b = a._result;
          b = b();
          b.then(function(b2) {
            if (0 === a._status || -1 === a._status) a._status = 1, a._result = b2;
          }, function(b2) {
            if (0 === a._status || -1 === a._status) a._status = 2, a._result = b2;
          });
          -1 === a._status && (a._status = 0, a._result = b);
        }
        if (1 === a._status) return a._result.default;
        throw a._result;
      }
      var U = { current: null };
      var V = { transition: null };
      var W2 = { ReactCurrentDispatcher: U, ReactCurrentBatchConfig: V, ReactCurrentOwner: K };
      function X2() {
        throw Error("act(...) is not supported in production builds of React.");
      }
      exports.Children = { map: S2, forEach: function(a, b, e) {
        S2(a, function() {
          b.apply(this, arguments);
        }, e);
      }, count: function(a) {
        var b = 0;
        S2(a, function() {
          b++;
        });
        return b;
      }, toArray: function(a) {
        return S2(a, function(a2) {
          return a2;
        }) || [];
      }, only: function(a) {
        if (!O(a)) throw Error("React.Children.only expected to receive a single React element child.");
        return a;
      } };
      exports.Component = E;
      exports.Fragment = p;
      exports.Profiler = r;
      exports.PureComponent = G;
      exports.StrictMode = q;
      exports.Suspense = w;
      exports.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED = W2;
      exports.act = X2;
      exports.cloneElement = function(a, b, e) {
        if (null === a || void 0 === a) throw Error("React.cloneElement(...): The argument must be a React element, but you passed " + a + ".");
        var d = C2({}, a.props), c = a.key, k = a.ref, h = a._owner;
        if (null != b) {
          void 0 !== b.ref && (k = b.ref, h = K.current);
          void 0 !== b.key && (c = "" + b.key);
          if (a.type && a.type.defaultProps) var g = a.type.defaultProps;
          for (f in b) J.call(b, f) && !L3.hasOwnProperty(f) && (d[f] = void 0 === b[f] && void 0 !== g ? g[f] : b[f]);
        }
        var f = arguments.length - 2;
        if (1 === f) d.children = e;
        else if (1 < f) {
          g = Array(f);
          for (var m = 0; m < f; m++) g[m] = arguments[m + 2];
          d.children = g;
        }
        return { $$typeof: l, type: a.type, key: c, ref: k, props: d, _owner: h };
      };
      exports.createContext = function(a) {
        a = { $$typeof: u, _currentValue: a, _currentValue2: a, _threadCount: 0, Provider: null, Consumer: null, _defaultValue: null, _globalName: null };
        a.Provider = { $$typeof: t, _context: a };
        return a.Consumer = a;
      };
      exports.createElement = M;
      exports.createFactory = function(a) {
        var b = M.bind(null, a);
        b.type = a;
        return b;
      };
      exports.createRef = function() {
        return { current: null };
      };
      exports.forwardRef = function(a) {
        return { $$typeof: v, render: a };
      };
      exports.isValidElement = O;
      exports.lazy = function(a) {
        return { $$typeof: y, _payload: { _status: -1, _result: a }, _init: T2 };
      };
      exports.memo = function(a, b) {
        return { $$typeof: x, type: a, compare: void 0 === b ? null : b };
      };
      exports.startTransition = function(a) {
        var b = V.transition;
        V.transition = {};
        try {
          a();
        } finally {
          V.transition = b;
        }
      };
      exports.unstable_act = X2;
      exports.useCallback = function(a, b) {
        return U.current.useCallback(a, b);
      };
      exports.useContext = function(a) {
        return U.current.useContext(a);
      };
      exports.useDebugValue = function() {
      };
      exports.useDeferredValue = function(a) {
        return U.current.useDeferredValue(a);
      };
      exports.useEffect = function(a, b) {
        return U.current.useEffect(a, b);
      };
      exports.useId = function() {
        return U.current.useId();
      };
      exports.useImperativeHandle = function(a, b, e) {
        return U.current.useImperativeHandle(a, b, e);
      };
      exports.useInsertionEffect = function(a, b) {
        return U.current.useInsertionEffect(a, b);
      };
      exports.useLayoutEffect = function(a, b) {
        return U.current.useLayoutEffect(a, b);
      };
      exports.useMemo = function(a, b) {
        return U.current.useMemo(a, b);
      };
      exports.useReducer = function(a, b, e) {
        return U.current.useReducer(a, b, e);
      };
      exports.useRef = function(a) {
        return U.current.useRef(a);
      };
      exports.useState = function(a) {
        return U.current.useState(a);
      };
      exports.useSyncExternalStore = function(a, b, e) {
        return U.current.useSyncExternalStore(a, b, e);
      };
      exports.useTransition = function() {
        return U.current.useTransition();
      };
      exports.version = "18.3.1";
    }
  });

  // node_modules/react/index.js
  var require_react = __commonJS({
    "node_modules/react/index.js"(exports, module) {
      "use strict";
      if (true) {
        module.exports = require_react_production_min();
      } else {
        module.exports = null;
      }
    }
  });

  // node_modules/scheduler/cjs/scheduler.production.min.js
  var require_scheduler_production_min = __commonJS({
    "node_modules/scheduler/cjs/scheduler.production.min.js"(exports) {
      "use strict";
      function f(a, b) {
        var c = a.length;
        a.push(b);
        a: for (; 0 < c; ) {
          var d = c - 1 >>> 1, e = a[d];
          if (0 < g(e, b)) a[d] = b, a[c] = e, c = d;
          else break a;
        }
      }
      function h(a) {
        return 0 === a.length ? null : a[0];
      }
      function k(a) {
        if (0 === a.length) return null;
        var b = a[0], c = a.pop();
        if (c !== b) {
          a[0] = c;
          a: for (var d = 0, e = a.length, w = e >>> 1; d < w; ) {
            var m = 2 * (d + 1) - 1, C2 = a[m], n = m + 1, x = a[n];
            if (0 > g(C2, c)) n < e && 0 > g(x, C2) ? (a[d] = x, a[n] = c, d = n) : (a[d] = C2, a[m] = c, d = m);
            else if (n < e && 0 > g(x, c)) a[d] = x, a[n] = c, d = n;
            else break a;
          }
        }
        return b;
      }
      function g(a, b) {
        var c = a.sortIndex - b.sortIndex;
        return 0 !== c ? c : a.id - b.id;
      }
      if ("object" === typeof performance && "function" === typeof performance.now) {
        l = performance;
        exports.unstable_now = function() {
          return l.now();
        };
      } else {
        p = Date, q = p.now();
        exports.unstable_now = function() {
          return p.now() - q;
        };
      }
      var l;
      var p;
      var q;
      var r = [];
      var t = [];
      var u = 1;
      var v = null;
      var y = 3;
      var z = false;
      var A2 = false;
      var B = false;
      var D2 = "function" === typeof setTimeout ? setTimeout : null;
      var E = "function" === typeof clearTimeout ? clearTimeout : null;
      var F = "undefined" !== typeof setImmediate ? setImmediate : null;
      "undefined" !== typeof navigator && void 0 !== navigator.scheduling && void 0 !== navigator.scheduling.isInputPending && navigator.scheduling.isInputPending.bind(navigator.scheduling);
      function G(a) {
        for (var b = h(t); null !== b; ) {
          if (null === b.callback) k(t);
          else if (b.startTime <= a) k(t), b.sortIndex = b.expirationTime, f(r, b);
          else break;
          b = h(t);
        }
      }
      function H(a) {
        B = false;
        G(a);
        if (!A2) if (null !== h(r)) A2 = true, I(J);
        else {
          var b = h(t);
          null !== b && K(H, b.startTime - a);
        }
      }
      function J(a, b) {
        A2 = false;
        B && (B = false, E(L3), L3 = -1);
        z = true;
        var c = y;
        try {
          G(b);
          for (v = h(r); null !== v && (!(v.expirationTime > b) || a && !M()); ) {
            var d = v.callback;
            if ("function" === typeof d) {
              v.callback = null;
              y = v.priorityLevel;
              var e = d(v.expirationTime <= b);
              b = exports.unstable_now();
              "function" === typeof e ? v.callback = e : v === h(r) && k(r);
              G(b);
            } else k(r);
            v = h(r);
          }
          if (null !== v) var w = true;
          else {
            var m = h(t);
            null !== m && K(H, m.startTime - b);
            w = false;
          }
          return w;
        } finally {
          v = null, y = c, z = false;
        }
      }
      var N = false;
      var O = null;
      var L3 = -1;
      var P = 5;
      var Q = -1;
      function M() {
        return exports.unstable_now() - Q < P ? false : true;
      }
      function R() {
        if (null !== O) {
          var a = exports.unstable_now();
          Q = a;
          var b = true;
          try {
            b = O(true, a);
          } finally {
            b ? S2() : (N = false, O = null);
          }
        } else N = false;
      }
      var S2;
      if ("function" === typeof F) S2 = function() {
        F(R);
      };
      else if ("undefined" !== typeof MessageChannel) {
        T2 = new MessageChannel(), U = T2.port2;
        T2.port1.onmessage = R;
        S2 = function() {
          U.postMessage(null);
        };
      } else S2 = function() {
        D2(R, 0);
      };
      var T2;
      var U;
      function I(a) {
        O = a;
        N || (N = true, S2());
      }
      function K(a, b) {
        L3 = D2(function() {
          a(exports.unstable_now());
        }, b);
      }
      exports.unstable_IdlePriority = 5;
      exports.unstable_ImmediatePriority = 1;
      exports.unstable_LowPriority = 4;
      exports.unstable_NormalPriority = 3;
      exports.unstable_Profiling = null;
      exports.unstable_UserBlockingPriority = 2;
      exports.unstable_cancelCallback = function(a) {
        a.callback = null;
      };
      exports.unstable_continueExecution = function() {
        A2 || z || (A2 = true, I(J));
      };
      exports.unstable_forceFrameRate = function(a) {
        0 > a || 125 < a ? console.error("forceFrameRate takes a positive int between 0 and 125, forcing frame rates higher than 125 fps is not supported") : P = 0 < a ? Math.floor(1e3 / a) : 5;
      };
      exports.unstable_getCurrentPriorityLevel = function() {
        return y;
      };
      exports.unstable_getFirstCallbackNode = function() {
        return h(r);
      };
      exports.unstable_next = function(a) {
        switch (y) {
          case 1:
          case 2:
          case 3:
            var b = 3;
            break;
          default:
            b = y;
        }
        var c = y;
        y = b;
        try {
          return a();
        } finally {
          y = c;
        }
      };
      exports.unstable_pauseExecution = function() {
      };
      exports.unstable_requestPaint = function() {
      };
      exports.unstable_runWithPriority = function(a, b) {
        switch (a) {
          case 1:
          case 2:
          case 3:
          case 4:
          case 5:
            break;
          default:
            a = 3;
        }
        var c = y;
        y = a;
        try {
          return b();
        } finally {
          y = c;
        }
      };
      exports.unstable_scheduleCallback = function(a, b, c) {
        var d = exports.unstable_now();
        "object" === typeof c && null !== c ? (c = c.delay, c = "number" === typeof c && 0 < c ? d + c : d) : c = d;
        switch (a) {
          case 1:
            var e = -1;
            break;
          case 2:
            e = 250;
            break;
          case 5:
            e = 1073741823;
            break;
          case 4:
            e = 1e4;
            break;
          default:
            e = 5e3;
        }
        e = c + e;
        a = { id: u++, callback: b, priorityLevel: a, startTime: c, expirationTime: e, sortIndex: -1 };
        c > d ? (a.sortIndex = c, f(t, a), null === h(r) && a === h(t) && (B ? (E(L3), L3 = -1) : B = true, K(H, c - d))) : (a.sortIndex = e, f(r, a), A2 || z || (A2 = true, I(J)));
        return a;
      };
      exports.unstable_shouldYield = M;
      exports.unstable_wrapCallback = function(a) {
        var b = y;
        return function() {
          var c = y;
          y = b;
          try {
            return a.apply(this, arguments);
          } finally {
            y = c;
          }
        };
      };
    }
  });

  // node_modules/scheduler/index.js
  var require_scheduler = __commonJS({
    "node_modules/scheduler/index.js"(exports, module) {
      "use strict";
      if (true) {
        module.exports = require_scheduler_production_min();
      } else {
        module.exports = null;
      }
    }
  });

  // node_modules/react-dom/cjs/react-dom.production.min.js
  var require_react_dom_production_min = __commonJS({
    "node_modules/react-dom/cjs/react-dom.production.min.js"(exports) {
      "use strict";
      var aa = require_react();
      var ca = require_scheduler();
      function p(a) {
        for (var b = "https://reactjs.org/docs/error-decoder.html?invariant=" + a, c = 1; c < arguments.length; c++) b += "&args[]=" + encodeURIComponent(arguments[c]);
        return "Minified React error #" + a + "; visit " + b + " for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";
      }
      var da = /* @__PURE__ */ new Set();
      var ea = {};
      function fa(a, b) {
        ha(a, b);
        ha(a + "Capture", b);
      }
      function ha(a, b) {
        ea[a] = b;
        for (a = 0; a < b.length; a++) da.add(b[a]);
      }
      var ia = !("undefined" === typeof window || "undefined" === typeof window.document || "undefined" === typeof window.document.createElement);
      var ja = Object.prototype.hasOwnProperty;
      var ka = /^[:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD][:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\-.0-9\u00B7\u0300-\u036F\u203F-\u2040]*$/;
      var la = {};
      var ma = {};
      function oa(a) {
        if (ja.call(ma, a)) return true;
        if (ja.call(la, a)) return false;
        if (ka.test(a)) return ma[a] = true;
        la[a] = true;
        return false;
      }
      function pa(a, b, c, d) {
        if (null !== c && 0 === c.type) return false;
        switch (typeof b) {
          case "function":
          case "symbol":
            return true;
          case "boolean":
            if (d) return false;
            if (null !== c) return !c.acceptsBooleans;
            a = a.toLowerCase().slice(0, 5);
            return "data-" !== a && "aria-" !== a;
          default:
            return false;
        }
      }
      function qa(a, b, c, d) {
        if (null === b || "undefined" === typeof b || pa(a, b, c, d)) return true;
        if (d) return false;
        if (null !== c) switch (c.type) {
          case 3:
            return !b;
          case 4:
            return false === b;
          case 5:
            return isNaN(b);
          case 6:
            return isNaN(b) || 1 > b;
        }
        return false;
      }
      function v(a, b, c, d, e, f, g) {
        this.acceptsBooleans = 2 === b || 3 === b || 4 === b;
        this.attributeName = d;
        this.attributeNamespace = e;
        this.mustUseProperty = c;
        this.propertyName = a;
        this.type = b;
        this.sanitizeURL = f;
        this.removeEmptyString = g;
      }
      var z = {};
      "children dangerouslySetInnerHTML defaultValue defaultChecked innerHTML suppressContentEditableWarning suppressHydrationWarning style".split(" ").forEach(function(a) {
        z[a] = new v(a, 0, false, a, null, false, false);
      });
      [["acceptCharset", "accept-charset"], ["className", "class"], ["htmlFor", "for"], ["httpEquiv", "http-equiv"]].forEach(function(a) {
        var b = a[0];
        z[b] = new v(b, 1, false, a[1], null, false, false);
      });
      ["contentEditable", "draggable", "spellCheck", "value"].forEach(function(a) {
        z[a] = new v(a, 2, false, a.toLowerCase(), null, false, false);
      });
      ["autoReverse", "externalResourcesRequired", "focusable", "preserveAlpha"].forEach(function(a) {
        z[a] = new v(a, 2, false, a, null, false, false);
      });
      "allowFullScreen async autoFocus autoPlay controls default defer disabled disablePictureInPicture disableRemotePlayback formNoValidate hidden loop noModule noValidate open playsInline readOnly required reversed scoped seamless itemScope".split(" ").forEach(function(a) {
        z[a] = new v(a, 3, false, a.toLowerCase(), null, false, false);
      });
      ["checked", "multiple", "muted", "selected"].forEach(function(a) {
        z[a] = new v(a, 3, true, a, null, false, false);
      });
      ["capture", "download"].forEach(function(a) {
        z[a] = new v(a, 4, false, a, null, false, false);
      });
      ["cols", "rows", "size", "span"].forEach(function(a) {
        z[a] = new v(a, 6, false, a, null, false, false);
      });
      ["rowSpan", "start"].forEach(function(a) {
        z[a] = new v(a, 5, false, a.toLowerCase(), null, false, false);
      });
      var ra = /[\-:]([a-z])/g;
      function sa(a) {
        return a[1].toUpperCase();
      }
      "accent-height alignment-baseline arabic-form baseline-shift cap-height clip-path clip-rule color-interpolation color-interpolation-filters color-profile color-rendering dominant-baseline enable-background fill-opacity fill-rule flood-color flood-opacity font-family font-size font-size-adjust font-stretch font-style font-variant font-weight glyph-name glyph-orientation-horizontal glyph-orientation-vertical horiz-adv-x horiz-origin-x image-rendering letter-spacing lighting-color marker-end marker-mid marker-start overline-position overline-thickness paint-order panose-1 pointer-events rendering-intent shape-rendering stop-color stop-opacity strikethrough-position strikethrough-thickness stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit stroke-opacity stroke-width text-anchor text-decoration text-rendering underline-position underline-thickness unicode-bidi unicode-range units-per-em v-alphabetic v-hanging v-ideographic v-mathematical vector-effect vert-adv-y vert-origin-x vert-origin-y word-spacing writing-mode xmlns:xlink x-height".split(" ").forEach(function(a) {
        var b = a.replace(
          ra,
          sa
        );
        z[b] = new v(b, 1, false, a, null, false, false);
      });
      "xlink:actuate xlink:arcrole xlink:role xlink:show xlink:title xlink:type".split(" ").forEach(function(a) {
        var b = a.replace(ra, sa);
        z[b] = new v(b, 1, false, a, "http://www.w3.org/1999/xlink", false, false);
      });
      ["xml:base", "xml:lang", "xml:space"].forEach(function(a) {
        var b = a.replace(ra, sa);
        z[b] = new v(b, 1, false, a, "http://www.w3.org/XML/1998/namespace", false, false);
      });
      ["tabIndex", "crossOrigin"].forEach(function(a) {
        z[a] = new v(a, 1, false, a.toLowerCase(), null, false, false);
      });
      z.xlinkHref = new v("xlinkHref", 1, false, "xlink:href", "http://www.w3.org/1999/xlink", true, false);
      ["src", "href", "action", "formAction"].forEach(function(a) {
        z[a] = new v(a, 1, false, a.toLowerCase(), null, true, true);
      });
      function ta(a, b, c, d) {
        var e = z.hasOwnProperty(b) ? z[b] : null;
        if (null !== e ? 0 !== e.type : d || !(2 < b.length) || "o" !== b[0] && "O" !== b[0] || "n" !== b[1] && "N" !== b[1]) qa(b, c, e, d) && (c = null), d || null === e ? oa(b) && (null === c ? a.removeAttribute(b) : a.setAttribute(b, "" + c)) : e.mustUseProperty ? a[e.propertyName] = null === c ? 3 === e.type ? false : "" : c : (b = e.attributeName, d = e.attributeNamespace, null === c ? a.removeAttribute(b) : (e = e.type, c = 3 === e || 4 === e && true === c ? "" : "" + c, d ? a.setAttributeNS(d, b, c) : a.setAttribute(b, c)));
      }
      var ua = aa.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
      var va = Symbol.for("react.element");
      var wa = Symbol.for("react.portal");
      var ya = Symbol.for("react.fragment");
      var za = Symbol.for("react.strict_mode");
      var Aa = Symbol.for("react.profiler");
      var Ba = Symbol.for("react.provider");
      var Ca = Symbol.for("react.context");
      var Da = Symbol.for("react.forward_ref");
      var Ea = Symbol.for("react.suspense");
      var Fa = Symbol.for("react.suspense_list");
      var Ga = Symbol.for("react.memo");
      var Ha = Symbol.for("react.lazy");
      Symbol.for("react.scope");
      Symbol.for("react.debug_trace_mode");
      var Ia = Symbol.for("react.offscreen");
      Symbol.for("react.legacy_hidden");
      Symbol.for("react.cache");
      Symbol.for("react.tracing_marker");
      var Ja = Symbol.iterator;
      function Ka(a) {
        if (null === a || "object" !== typeof a) return null;
        a = Ja && a[Ja] || a["@@iterator"];
        return "function" === typeof a ? a : null;
      }
      var A2 = Object.assign;
      var La;
      function Ma(a) {
        if (void 0 === La) try {
          throw Error();
        } catch (c) {
          var b = c.stack.trim().match(/\n( *(at )?)/);
          La = b && b[1] || "";
        }
        return "\n" + La + a;
      }
      var Na = false;
      function Oa(a, b) {
        if (!a || Na) return "";
        Na = true;
        var c = Error.prepareStackTrace;
        Error.prepareStackTrace = void 0;
        try {
          if (b) if (b = function() {
            throw Error();
          }, Object.defineProperty(b.prototype, "props", { set: function() {
            throw Error();
          } }), "object" === typeof Reflect && Reflect.construct) {
            try {
              Reflect.construct(b, []);
            } catch (l) {
              var d = l;
            }
            Reflect.construct(a, [], b);
          } else {
            try {
              b.call();
            } catch (l) {
              d = l;
            }
            a.call(b.prototype);
          }
          else {
            try {
              throw Error();
            } catch (l) {
              d = l;
            }
            a();
          }
        } catch (l) {
          if (l && d && "string" === typeof l.stack) {
            for (var e = l.stack.split("\n"), f = d.stack.split("\n"), g = e.length - 1, h = f.length - 1; 1 <= g && 0 <= h && e[g] !== f[h]; ) h--;
            for (; 1 <= g && 0 <= h; g--, h--) if (e[g] !== f[h]) {
              if (1 !== g || 1 !== h) {
                do
                  if (g--, h--, 0 > h || e[g] !== f[h]) {
                    var k = "\n" + e[g].replace(" at new ", " at ");
                    a.displayName && k.includes("<anonymous>") && (k = k.replace("<anonymous>", a.displayName));
                    return k;
                  }
                while (1 <= g && 0 <= h);
              }
              break;
            }
          }
        } finally {
          Na = false, Error.prepareStackTrace = c;
        }
        return (a = a ? a.displayName || a.name : "") ? Ma(a) : "";
      }
      function Pa(a) {
        switch (a.tag) {
          case 5:
            return Ma(a.type);
          case 16:
            return Ma("Lazy");
          case 13:
            return Ma("Suspense");
          case 19:
            return Ma("SuspenseList");
          case 0:
          case 2:
          case 15:
            return a = Oa(a.type, false), a;
          case 11:
            return a = Oa(a.type.render, false), a;
          case 1:
            return a = Oa(a.type, true), a;
          default:
            return "";
        }
      }
      function Qa(a) {
        if (null == a) return null;
        if ("function" === typeof a) return a.displayName || a.name || null;
        if ("string" === typeof a) return a;
        switch (a) {
          case ya:
            return "Fragment";
          case wa:
            return "Portal";
          case Aa:
            return "Profiler";
          case za:
            return "StrictMode";
          case Ea:
            return "Suspense";
          case Fa:
            return "SuspenseList";
        }
        if ("object" === typeof a) switch (a.$$typeof) {
          case Ca:
            return (a.displayName || "Context") + ".Consumer";
          case Ba:
            return (a._context.displayName || "Context") + ".Provider";
          case Da:
            var b = a.render;
            a = a.displayName;
            a || (a = b.displayName || b.name || "", a = "" !== a ? "ForwardRef(" + a + ")" : "ForwardRef");
            return a;
          case Ga:
            return b = a.displayName || null, null !== b ? b : Qa(a.type) || "Memo";
          case Ha:
            b = a._payload;
            a = a._init;
            try {
              return Qa(a(b));
            } catch (c) {
            }
        }
        return null;
      }
      function Ra(a) {
        var b = a.type;
        switch (a.tag) {
          case 24:
            return "Cache";
          case 9:
            return (b.displayName || "Context") + ".Consumer";
          case 10:
            return (b._context.displayName || "Context") + ".Provider";
          case 18:
            return "DehydratedFragment";
          case 11:
            return a = b.render, a = a.displayName || a.name || "", b.displayName || ("" !== a ? "ForwardRef(" + a + ")" : "ForwardRef");
          case 7:
            return "Fragment";
          case 5:
            return b;
          case 4:
            return "Portal";
          case 3:
            return "Root";
          case 6:
            return "Text";
          case 16:
            return Qa(b);
          case 8:
            return b === za ? "StrictMode" : "Mode";
          case 22:
            return "Offscreen";
          case 12:
            return "Profiler";
          case 21:
            return "Scope";
          case 13:
            return "Suspense";
          case 19:
            return "SuspenseList";
          case 25:
            return "TracingMarker";
          case 1:
          case 0:
          case 17:
          case 2:
          case 14:
          case 15:
            if ("function" === typeof b) return b.displayName || b.name || null;
            if ("string" === typeof b) return b;
        }
        return null;
      }
      function Sa(a) {
        switch (typeof a) {
          case "boolean":
          case "number":
          case "string":
          case "undefined":
            return a;
          case "object":
            return a;
          default:
            return "";
        }
      }
      function Ta(a) {
        var b = a.type;
        return (a = a.nodeName) && "input" === a.toLowerCase() && ("checkbox" === b || "radio" === b);
      }
      function Ua(a) {
        var b = Ta(a) ? "checked" : "value", c = Object.getOwnPropertyDescriptor(a.constructor.prototype, b), d = "" + a[b];
        if (!a.hasOwnProperty(b) && "undefined" !== typeof c && "function" === typeof c.get && "function" === typeof c.set) {
          var e = c.get, f = c.set;
          Object.defineProperty(a, b, { configurable: true, get: function() {
            return e.call(this);
          }, set: function(a2) {
            d = "" + a2;
            f.call(this, a2);
          } });
          Object.defineProperty(a, b, { enumerable: c.enumerable });
          return { getValue: function() {
            return d;
          }, setValue: function(a2) {
            d = "" + a2;
          }, stopTracking: function() {
            a._valueTracker = null;
            delete a[b];
          } };
        }
      }
      function Va(a) {
        a._valueTracker || (a._valueTracker = Ua(a));
      }
      function Wa(a) {
        if (!a) return false;
        var b = a._valueTracker;
        if (!b) return true;
        var c = b.getValue();
        var d = "";
        a && (d = Ta(a) ? a.checked ? "true" : "false" : a.value);
        a = d;
        return a !== c ? (b.setValue(a), true) : false;
      }
      function Xa(a) {
        a = a || ("undefined" !== typeof document ? document : void 0);
        if ("undefined" === typeof a) return null;
        try {
          return a.activeElement || a.body;
        } catch (b) {
          return a.body;
        }
      }
      function Ya(a, b) {
        var c = b.checked;
        return A2({}, b, { defaultChecked: void 0, defaultValue: void 0, value: void 0, checked: null != c ? c : a._wrapperState.initialChecked });
      }
      function Za(a, b) {
        var c = null == b.defaultValue ? "" : b.defaultValue, d = null != b.checked ? b.checked : b.defaultChecked;
        c = Sa(null != b.value ? b.value : c);
        a._wrapperState = { initialChecked: d, initialValue: c, controlled: "checkbox" === b.type || "radio" === b.type ? null != b.checked : null != b.value };
      }
      function ab(a, b) {
        b = b.checked;
        null != b && ta(a, "checked", b, false);
      }
      function bb(a, b) {
        ab(a, b);
        var c = Sa(b.value), d = b.type;
        if (null != c) if ("number" === d) {
          if (0 === c && "" === a.value || a.value != c) a.value = "" + c;
        } else a.value !== "" + c && (a.value = "" + c);
        else if ("submit" === d || "reset" === d) {
          a.removeAttribute("value");
          return;
        }
        b.hasOwnProperty("value") ? cb(a, b.type, c) : b.hasOwnProperty("defaultValue") && cb(a, b.type, Sa(b.defaultValue));
        null == b.checked && null != b.defaultChecked && (a.defaultChecked = !!b.defaultChecked);
      }
      function db(a, b, c) {
        if (b.hasOwnProperty("value") || b.hasOwnProperty("defaultValue")) {
          var d = b.type;
          if (!("submit" !== d && "reset" !== d || void 0 !== b.value && null !== b.value)) return;
          b = "" + a._wrapperState.initialValue;
          c || b === a.value || (a.value = b);
          a.defaultValue = b;
        }
        c = a.name;
        "" !== c && (a.name = "");
        a.defaultChecked = !!a._wrapperState.initialChecked;
        "" !== c && (a.name = c);
      }
      function cb(a, b, c) {
        if ("number" !== b || Xa(a.ownerDocument) !== a) null == c ? a.defaultValue = "" + a._wrapperState.initialValue : a.defaultValue !== "" + c && (a.defaultValue = "" + c);
      }
      var eb = Array.isArray;
      function fb(a, b, c, d) {
        a = a.options;
        if (b) {
          b = {};
          for (var e = 0; e < c.length; e++) b["$" + c[e]] = true;
          for (c = 0; c < a.length; c++) e = b.hasOwnProperty("$" + a[c].value), a[c].selected !== e && (a[c].selected = e), e && d && (a[c].defaultSelected = true);
        } else {
          c = "" + Sa(c);
          b = null;
          for (e = 0; e < a.length; e++) {
            if (a[e].value === c) {
              a[e].selected = true;
              d && (a[e].defaultSelected = true);
              return;
            }
            null !== b || a[e].disabled || (b = a[e]);
          }
          null !== b && (b.selected = true);
        }
      }
      function gb(a, b) {
        if (null != b.dangerouslySetInnerHTML) throw Error(p(91));
        return A2({}, b, { value: void 0, defaultValue: void 0, children: "" + a._wrapperState.initialValue });
      }
      function hb(a, b) {
        var c = b.value;
        if (null == c) {
          c = b.children;
          b = b.defaultValue;
          if (null != c) {
            if (null != b) throw Error(p(92));
            if (eb(c)) {
              if (1 < c.length) throw Error(p(93));
              c = c[0];
            }
            b = c;
          }
          null == b && (b = "");
          c = b;
        }
        a._wrapperState = { initialValue: Sa(c) };
      }
      function ib(a, b) {
        var c = Sa(b.value), d = Sa(b.defaultValue);
        null != c && (c = "" + c, c !== a.value && (a.value = c), null == b.defaultValue && a.defaultValue !== c && (a.defaultValue = c));
        null != d && (a.defaultValue = "" + d);
      }
      function jb(a) {
        var b = a.textContent;
        b === a._wrapperState.initialValue && "" !== b && null !== b && (a.value = b);
      }
      function kb(a) {
        switch (a) {
          case "svg":
            return "http://www.w3.org/2000/svg";
          case "math":
            return "http://www.w3.org/1998/Math/MathML";
          default:
            return "http://www.w3.org/1999/xhtml";
        }
      }
      function lb(a, b) {
        return null == a || "http://www.w3.org/1999/xhtml" === a ? kb(b) : "http://www.w3.org/2000/svg" === a && "foreignObject" === b ? "http://www.w3.org/1999/xhtml" : a;
      }
      var mb;
      var nb = function(a) {
        return "undefined" !== typeof MSApp && MSApp.execUnsafeLocalFunction ? function(b, c, d, e) {
          MSApp.execUnsafeLocalFunction(function() {
            return a(b, c, d, e);
          });
        } : a;
      }(function(a, b) {
        if ("http://www.w3.org/2000/svg" !== a.namespaceURI || "innerHTML" in a) a.innerHTML = b;
        else {
          mb = mb || document.createElement("div");
          mb.innerHTML = "<svg>" + b.valueOf().toString() + "</svg>";
          for (b = mb.firstChild; a.firstChild; ) a.removeChild(a.firstChild);
          for (; b.firstChild; ) a.appendChild(b.firstChild);
        }
      });
      function ob(a, b) {
        if (b) {
          var c = a.firstChild;
          if (c && c === a.lastChild && 3 === c.nodeType) {
            c.nodeValue = b;
            return;
          }
        }
        a.textContent = b;
      }
      var pb = {
        animationIterationCount: true,
        aspectRatio: true,
        borderImageOutset: true,
        borderImageSlice: true,
        borderImageWidth: true,
        boxFlex: true,
        boxFlexGroup: true,
        boxOrdinalGroup: true,
        columnCount: true,
        columns: true,
        flex: true,
        flexGrow: true,
        flexPositive: true,
        flexShrink: true,
        flexNegative: true,
        flexOrder: true,
        gridArea: true,
        gridRow: true,
        gridRowEnd: true,
        gridRowSpan: true,
        gridRowStart: true,
        gridColumn: true,
        gridColumnEnd: true,
        gridColumnSpan: true,
        gridColumnStart: true,
        fontWeight: true,
        lineClamp: true,
        lineHeight: true,
        opacity: true,
        order: true,
        orphans: true,
        tabSize: true,
        widows: true,
        zIndex: true,
        zoom: true,
        fillOpacity: true,
        floodOpacity: true,
        stopOpacity: true,
        strokeDasharray: true,
        strokeDashoffset: true,
        strokeMiterlimit: true,
        strokeOpacity: true,
        strokeWidth: true
      };
      var qb = ["Webkit", "ms", "Moz", "O"];
      Object.keys(pb).forEach(function(a) {
        qb.forEach(function(b) {
          b = b + a.charAt(0).toUpperCase() + a.substring(1);
          pb[b] = pb[a];
        });
      });
      function rb(a, b, c) {
        return null == b || "boolean" === typeof b || "" === b ? "" : c || "number" !== typeof b || 0 === b || pb.hasOwnProperty(a) && pb[a] ? ("" + b).trim() : b + "px";
      }
      function sb(a, b) {
        a = a.style;
        for (var c in b) if (b.hasOwnProperty(c)) {
          var d = 0 === c.indexOf("--"), e = rb(c, b[c], d);
          "float" === c && (c = "cssFloat");
          d ? a.setProperty(c, e) : a[c] = e;
        }
      }
      var tb = A2({ menuitem: true }, { area: true, base: true, br: true, col: true, embed: true, hr: true, img: true, input: true, keygen: true, link: true, meta: true, param: true, source: true, track: true, wbr: true });
      function ub(a, b) {
        if (b) {
          if (tb[a] && (null != b.children || null != b.dangerouslySetInnerHTML)) throw Error(p(137, a));
          if (null != b.dangerouslySetInnerHTML) {
            if (null != b.children) throw Error(p(60));
            if ("object" !== typeof b.dangerouslySetInnerHTML || !("__html" in b.dangerouslySetInnerHTML)) throw Error(p(61));
          }
          if (null != b.style && "object" !== typeof b.style) throw Error(p(62));
        }
      }
      function vb(a, b) {
        if (-1 === a.indexOf("-")) return "string" === typeof b.is;
        switch (a) {
          case "annotation-xml":
          case "color-profile":
          case "font-face":
          case "font-face-src":
          case "font-face-uri":
          case "font-face-format":
          case "font-face-name":
          case "missing-glyph":
            return false;
          default:
            return true;
        }
      }
      var wb = null;
      function xb(a) {
        a = a.target || a.srcElement || window;
        a.correspondingUseElement && (a = a.correspondingUseElement);
        return 3 === a.nodeType ? a.parentNode : a;
      }
      var yb = null;
      var zb = null;
      var Ab = null;
      function Bb(a) {
        if (a = Cb(a)) {
          if ("function" !== typeof yb) throw Error(p(280));
          var b = a.stateNode;
          b && (b = Db(b), yb(a.stateNode, a.type, b));
        }
      }
      function Eb(a) {
        zb ? Ab ? Ab.push(a) : Ab = [a] : zb = a;
      }
      function Fb() {
        if (zb) {
          var a = zb, b = Ab;
          Ab = zb = null;
          Bb(a);
          if (b) for (a = 0; a < b.length; a++) Bb(b[a]);
        }
      }
      function Gb(a, b) {
        return a(b);
      }
      function Hb() {
      }
      var Ib = false;
      function Jb(a, b, c) {
        if (Ib) return a(b, c);
        Ib = true;
        try {
          return Gb(a, b, c);
        } finally {
          if (Ib = false, null !== zb || null !== Ab) Hb(), Fb();
        }
      }
      function Kb(a, b) {
        var c = a.stateNode;
        if (null === c) return null;
        var d = Db(c);
        if (null === d) return null;
        c = d[b];
        a: switch (b) {
          case "onClick":
          case "onClickCapture":
          case "onDoubleClick":
          case "onDoubleClickCapture":
          case "onMouseDown":
          case "onMouseDownCapture":
          case "onMouseMove":
          case "onMouseMoveCapture":
          case "onMouseUp":
          case "onMouseUpCapture":
          case "onMouseEnter":
            (d = !d.disabled) || (a = a.type, d = !("button" === a || "input" === a || "select" === a || "textarea" === a));
            a = !d;
            break a;
          default:
            a = false;
        }
        if (a) return null;
        if (c && "function" !== typeof c) throw Error(p(231, b, typeof c));
        return c;
      }
      var Lb = false;
      if (ia) try {
        Mb = {};
        Object.defineProperty(Mb, "passive", { get: function() {
          Lb = true;
        } });
        window.addEventListener("test", Mb, Mb);
        window.removeEventListener("test", Mb, Mb);
      } catch (a) {
        Lb = false;
      }
      var Mb;
      function Nb(a, b, c, d, e, f, g, h, k) {
        var l = Array.prototype.slice.call(arguments, 3);
        try {
          b.apply(c, l);
        } catch (m) {
          this.onError(m);
        }
      }
      var Ob = false;
      var Pb = null;
      var Qb = false;
      var Rb = null;
      var Sb = { onError: function(a) {
        Ob = true;
        Pb = a;
      } };
      function Tb(a, b, c, d, e, f, g, h, k) {
        Ob = false;
        Pb = null;
        Nb.apply(Sb, arguments);
      }
      function Ub(a, b, c, d, e, f, g, h, k) {
        Tb.apply(this, arguments);
        if (Ob) {
          if (Ob) {
            var l = Pb;
            Ob = false;
            Pb = null;
          } else throw Error(p(198));
          Qb || (Qb = true, Rb = l);
        }
      }
      function Vb(a) {
        var b = a, c = a;
        if (a.alternate) for (; b.return; ) b = b.return;
        else {
          a = b;
          do
            b = a, 0 !== (b.flags & 4098) && (c = b.return), a = b.return;
          while (a);
        }
        return 3 === b.tag ? c : null;
      }
      function Wb(a) {
        if (13 === a.tag) {
          var b = a.memoizedState;
          null === b && (a = a.alternate, null !== a && (b = a.memoizedState));
          if (null !== b) return b.dehydrated;
        }
        return null;
      }
      function Xb(a) {
        if (Vb(a) !== a) throw Error(p(188));
      }
      function Yb(a) {
        var b = a.alternate;
        if (!b) {
          b = Vb(a);
          if (null === b) throw Error(p(188));
          return b !== a ? null : a;
        }
        for (var c = a, d = b; ; ) {
          var e = c.return;
          if (null === e) break;
          var f = e.alternate;
          if (null === f) {
            d = e.return;
            if (null !== d) {
              c = d;
              continue;
            }
            break;
          }
          if (e.child === f.child) {
            for (f = e.child; f; ) {
              if (f === c) return Xb(e), a;
              if (f === d) return Xb(e), b;
              f = f.sibling;
            }
            throw Error(p(188));
          }
          if (c.return !== d.return) c = e, d = f;
          else {
            for (var g = false, h = e.child; h; ) {
              if (h === c) {
                g = true;
                c = e;
                d = f;
                break;
              }
              if (h === d) {
                g = true;
                d = e;
                c = f;
                break;
              }
              h = h.sibling;
            }
            if (!g) {
              for (h = f.child; h; ) {
                if (h === c) {
                  g = true;
                  c = f;
                  d = e;
                  break;
                }
                if (h === d) {
                  g = true;
                  d = f;
                  c = e;
                  break;
                }
                h = h.sibling;
              }
              if (!g) throw Error(p(189));
            }
          }
          if (c.alternate !== d) throw Error(p(190));
        }
        if (3 !== c.tag) throw Error(p(188));
        return c.stateNode.current === c ? a : b;
      }
      function Zb(a) {
        a = Yb(a);
        return null !== a ? $b(a) : null;
      }
      function $b(a) {
        if (5 === a.tag || 6 === a.tag) return a;
        for (a = a.child; null !== a; ) {
          var b = $b(a);
          if (null !== b) return b;
          a = a.sibling;
        }
        return null;
      }
      var ac = ca.unstable_scheduleCallback;
      var bc = ca.unstable_cancelCallback;
      var cc = ca.unstable_shouldYield;
      var dc = ca.unstable_requestPaint;
      var B = ca.unstable_now;
      var ec = ca.unstable_getCurrentPriorityLevel;
      var fc = ca.unstable_ImmediatePriority;
      var gc = ca.unstable_UserBlockingPriority;
      var hc = ca.unstable_NormalPriority;
      var ic = ca.unstable_LowPriority;
      var jc = ca.unstable_IdlePriority;
      var kc = null;
      var lc = null;
      function mc(a) {
        if (lc && "function" === typeof lc.onCommitFiberRoot) try {
          lc.onCommitFiberRoot(kc, a, void 0, 128 === (a.current.flags & 128));
        } catch (b) {
        }
      }
      var oc = Math.clz32 ? Math.clz32 : nc;
      var pc = Math.log;
      var qc = Math.LN2;
      function nc(a) {
        a >>>= 0;
        return 0 === a ? 32 : 31 - (pc(a) / qc | 0) | 0;
      }
      var rc = 64;
      var sc = 4194304;
      function tc(a) {
        switch (a & -a) {
          case 1:
            return 1;
          case 2:
            return 2;
          case 4:
            return 4;
          case 8:
            return 8;
          case 16:
            return 16;
          case 32:
            return 32;
          case 64:
          case 128:
          case 256:
          case 512:
          case 1024:
          case 2048:
          case 4096:
          case 8192:
          case 16384:
          case 32768:
          case 65536:
          case 131072:
          case 262144:
          case 524288:
          case 1048576:
          case 2097152:
            return a & 4194240;
          case 4194304:
          case 8388608:
          case 16777216:
          case 33554432:
          case 67108864:
            return a & 130023424;
          case 134217728:
            return 134217728;
          case 268435456:
            return 268435456;
          case 536870912:
            return 536870912;
          case 1073741824:
            return 1073741824;
          default:
            return a;
        }
      }
      function uc(a, b) {
        var c = a.pendingLanes;
        if (0 === c) return 0;
        var d = 0, e = a.suspendedLanes, f = a.pingedLanes, g = c & 268435455;
        if (0 !== g) {
          var h = g & ~e;
          0 !== h ? d = tc(h) : (f &= g, 0 !== f && (d = tc(f)));
        } else g = c & ~e, 0 !== g ? d = tc(g) : 0 !== f && (d = tc(f));
        if (0 === d) return 0;
        if (0 !== b && b !== d && 0 === (b & e) && (e = d & -d, f = b & -b, e >= f || 16 === e && 0 !== (f & 4194240))) return b;
        0 !== (d & 4) && (d |= c & 16);
        b = a.entangledLanes;
        if (0 !== b) for (a = a.entanglements, b &= d; 0 < b; ) c = 31 - oc(b), e = 1 << c, d |= a[c], b &= ~e;
        return d;
      }
      function vc(a, b) {
        switch (a) {
          case 1:
          case 2:
          case 4:
            return b + 250;
          case 8:
          case 16:
          case 32:
          case 64:
          case 128:
          case 256:
          case 512:
          case 1024:
          case 2048:
          case 4096:
          case 8192:
          case 16384:
          case 32768:
          case 65536:
          case 131072:
          case 262144:
          case 524288:
          case 1048576:
          case 2097152:
            return b + 5e3;
          case 4194304:
          case 8388608:
          case 16777216:
          case 33554432:
          case 67108864:
            return -1;
          case 134217728:
          case 268435456:
          case 536870912:
          case 1073741824:
            return -1;
          default:
            return -1;
        }
      }
      function wc(a, b) {
        for (var c = a.suspendedLanes, d = a.pingedLanes, e = a.expirationTimes, f = a.pendingLanes; 0 < f; ) {
          var g = 31 - oc(f), h = 1 << g, k = e[g];
          if (-1 === k) {
            if (0 === (h & c) || 0 !== (h & d)) e[g] = vc(h, b);
          } else k <= b && (a.expiredLanes |= h);
          f &= ~h;
        }
      }
      function xc(a) {
        a = a.pendingLanes & -1073741825;
        return 0 !== a ? a : a & 1073741824 ? 1073741824 : 0;
      }
      function yc() {
        var a = rc;
        rc <<= 1;
        0 === (rc & 4194240) && (rc = 64);
        return a;
      }
      function zc(a) {
        for (var b = [], c = 0; 31 > c; c++) b.push(a);
        return b;
      }
      function Ac(a, b, c) {
        a.pendingLanes |= b;
        536870912 !== b && (a.suspendedLanes = 0, a.pingedLanes = 0);
        a = a.eventTimes;
        b = 31 - oc(b);
        a[b] = c;
      }
      function Bc(a, b) {
        var c = a.pendingLanes & ~b;
        a.pendingLanes = b;
        a.suspendedLanes = 0;
        a.pingedLanes = 0;
        a.expiredLanes &= b;
        a.mutableReadLanes &= b;
        a.entangledLanes &= b;
        b = a.entanglements;
        var d = a.eventTimes;
        for (a = a.expirationTimes; 0 < c; ) {
          var e = 31 - oc(c), f = 1 << e;
          b[e] = 0;
          d[e] = -1;
          a[e] = -1;
          c &= ~f;
        }
      }
      function Cc(a, b) {
        var c = a.entangledLanes |= b;
        for (a = a.entanglements; c; ) {
          var d = 31 - oc(c), e = 1 << d;
          e & b | a[d] & b && (a[d] |= b);
          c &= ~e;
        }
      }
      var C2 = 0;
      function Dc(a) {
        a &= -a;
        return 1 < a ? 4 < a ? 0 !== (a & 268435455) ? 16 : 536870912 : 4 : 1;
      }
      var Ec;
      var Fc;
      var Gc;
      var Hc;
      var Ic;
      var Jc = false;
      var Kc = [];
      var Lc = null;
      var Mc = null;
      var Nc = null;
      var Oc = /* @__PURE__ */ new Map();
      var Pc = /* @__PURE__ */ new Map();
      var Qc = [];
      var Rc = "mousedown mouseup touchcancel touchend touchstart auxclick dblclick pointercancel pointerdown pointerup dragend dragstart drop compositionend compositionstart keydown keypress keyup input textInput copy cut paste click change contextmenu reset submit".split(" ");
      function Sc(a, b) {
        switch (a) {
          case "focusin":
          case "focusout":
            Lc = null;
            break;
          case "dragenter":
          case "dragleave":
            Mc = null;
            break;
          case "mouseover":
          case "mouseout":
            Nc = null;
            break;
          case "pointerover":
          case "pointerout":
            Oc.delete(b.pointerId);
            break;
          case "gotpointercapture":
          case "lostpointercapture":
            Pc.delete(b.pointerId);
        }
      }
      function Tc(a, b, c, d, e, f) {
        if (null === a || a.nativeEvent !== f) return a = { blockedOn: b, domEventName: c, eventSystemFlags: d, nativeEvent: f, targetContainers: [e] }, null !== b && (b = Cb(b), null !== b && Fc(b)), a;
        a.eventSystemFlags |= d;
        b = a.targetContainers;
        null !== e && -1 === b.indexOf(e) && b.push(e);
        return a;
      }
      function Uc(a, b, c, d, e) {
        switch (b) {
          case "focusin":
            return Lc = Tc(Lc, a, b, c, d, e), true;
          case "dragenter":
            return Mc = Tc(Mc, a, b, c, d, e), true;
          case "mouseover":
            return Nc = Tc(Nc, a, b, c, d, e), true;
          case "pointerover":
            var f = e.pointerId;
            Oc.set(f, Tc(Oc.get(f) || null, a, b, c, d, e));
            return true;
          case "gotpointercapture":
            return f = e.pointerId, Pc.set(f, Tc(Pc.get(f) || null, a, b, c, d, e)), true;
        }
        return false;
      }
      function Vc(a) {
        var b = Wc(a.target);
        if (null !== b) {
          var c = Vb(b);
          if (null !== c) {
            if (b = c.tag, 13 === b) {
              if (b = Wb(c), null !== b) {
                a.blockedOn = b;
                Ic(a.priority, function() {
                  Gc(c);
                });
                return;
              }
            } else if (3 === b && c.stateNode.current.memoizedState.isDehydrated) {
              a.blockedOn = 3 === c.tag ? c.stateNode.containerInfo : null;
              return;
            }
          }
        }
        a.blockedOn = null;
      }
      function Xc(a) {
        if (null !== a.blockedOn) return false;
        for (var b = a.targetContainers; 0 < b.length; ) {
          var c = Yc(a.domEventName, a.eventSystemFlags, b[0], a.nativeEvent);
          if (null === c) {
            c = a.nativeEvent;
            var d = new c.constructor(c.type, c);
            wb = d;
            c.target.dispatchEvent(d);
            wb = null;
          } else return b = Cb(c), null !== b && Fc(b), a.blockedOn = c, false;
          b.shift();
        }
        return true;
      }
      function Zc(a, b, c) {
        Xc(a) && c.delete(b);
      }
      function $c() {
        Jc = false;
        null !== Lc && Xc(Lc) && (Lc = null);
        null !== Mc && Xc(Mc) && (Mc = null);
        null !== Nc && Xc(Nc) && (Nc = null);
        Oc.forEach(Zc);
        Pc.forEach(Zc);
      }
      function ad(a, b) {
        a.blockedOn === b && (a.blockedOn = null, Jc || (Jc = true, ca.unstable_scheduleCallback(ca.unstable_NormalPriority, $c)));
      }
      function bd(a) {
        function b(b2) {
          return ad(b2, a);
        }
        if (0 < Kc.length) {
          ad(Kc[0], a);
          for (var c = 1; c < Kc.length; c++) {
            var d = Kc[c];
            d.blockedOn === a && (d.blockedOn = null);
          }
        }
        null !== Lc && ad(Lc, a);
        null !== Mc && ad(Mc, a);
        null !== Nc && ad(Nc, a);
        Oc.forEach(b);
        Pc.forEach(b);
        for (c = 0; c < Qc.length; c++) d = Qc[c], d.blockedOn === a && (d.blockedOn = null);
        for (; 0 < Qc.length && (c = Qc[0], null === c.blockedOn); ) Vc(c), null === c.blockedOn && Qc.shift();
      }
      var cd = ua.ReactCurrentBatchConfig;
      var dd = true;
      function ed(a, b, c, d) {
        var e = C2, f = cd.transition;
        cd.transition = null;
        try {
          C2 = 1, fd(a, b, c, d);
        } finally {
          C2 = e, cd.transition = f;
        }
      }
      function gd(a, b, c, d) {
        var e = C2, f = cd.transition;
        cd.transition = null;
        try {
          C2 = 4, fd(a, b, c, d);
        } finally {
          C2 = e, cd.transition = f;
        }
      }
      function fd(a, b, c, d) {
        if (dd) {
          var e = Yc(a, b, c, d);
          if (null === e) hd(a, b, d, id, c), Sc(a, d);
          else if (Uc(e, a, b, c, d)) d.stopPropagation();
          else if (Sc(a, d), b & 4 && -1 < Rc.indexOf(a)) {
            for (; null !== e; ) {
              var f = Cb(e);
              null !== f && Ec(f);
              f = Yc(a, b, c, d);
              null === f && hd(a, b, d, id, c);
              if (f === e) break;
              e = f;
            }
            null !== e && d.stopPropagation();
          } else hd(a, b, d, null, c);
        }
      }
      var id = null;
      function Yc(a, b, c, d) {
        id = null;
        a = xb(d);
        a = Wc(a);
        if (null !== a) if (b = Vb(a), null === b) a = null;
        else if (c = b.tag, 13 === c) {
          a = Wb(b);
          if (null !== a) return a;
          a = null;
        } else if (3 === c) {
          if (b.stateNode.current.memoizedState.isDehydrated) return 3 === b.tag ? b.stateNode.containerInfo : null;
          a = null;
        } else b !== a && (a = null);
        id = a;
        return null;
      }
      function jd(a) {
        switch (a) {
          case "cancel":
          case "click":
          case "close":
          case "contextmenu":
          case "copy":
          case "cut":
          case "auxclick":
          case "dblclick":
          case "dragend":
          case "dragstart":
          case "drop":
          case "focusin":
          case "focusout":
          case "input":
          case "invalid":
          case "keydown":
          case "keypress":
          case "keyup":
          case "mousedown":
          case "mouseup":
          case "paste":
          case "pause":
          case "play":
          case "pointercancel":
          case "pointerdown":
          case "pointerup":
          case "ratechange":
          case "reset":
          case "resize":
          case "seeked":
          case "submit":
          case "touchcancel":
          case "touchend":
          case "touchstart":
          case "volumechange":
          case "change":
          case "selectionchange":
          case "textInput":
          case "compositionstart":
          case "compositionend":
          case "compositionupdate":
          case "beforeblur":
          case "afterblur":
          case "beforeinput":
          case "blur":
          case "fullscreenchange":
          case "focus":
          case "hashchange":
          case "popstate":
          case "select":
          case "selectstart":
            return 1;
          case "drag":
          case "dragenter":
          case "dragexit":
          case "dragleave":
          case "dragover":
          case "mousemove":
          case "mouseout":
          case "mouseover":
          case "pointermove":
          case "pointerout":
          case "pointerover":
          case "scroll":
          case "toggle":
          case "touchmove":
          case "wheel":
          case "mouseenter":
          case "mouseleave":
          case "pointerenter":
          case "pointerleave":
            return 4;
          case "message":
            switch (ec()) {
              case fc:
                return 1;
              case gc:
                return 4;
              case hc:
              case ic:
                return 16;
              case jc:
                return 536870912;
              default:
                return 16;
            }
          default:
            return 16;
        }
      }
      var kd = null;
      var ld = null;
      var md = null;
      function nd() {
        if (md) return md;
        var a, b = ld, c = b.length, d, e = "value" in kd ? kd.value : kd.textContent, f = e.length;
        for (a = 0; a < c && b[a] === e[a]; a++) ;
        var g = c - a;
        for (d = 1; d <= g && b[c - d] === e[f - d]; d++) ;
        return md = e.slice(a, 1 < d ? 1 - d : void 0);
      }
      function od(a) {
        var b = a.keyCode;
        "charCode" in a ? (a = a.charCode, 0 === a && 13 === b && (a = 13)) : a = b;
        10 === a && (a = 13);
        return 32 <= a || 13 === a ? a : 0;
      }
      function pd() {
        return true;
      }
      function qd() {
        return false;
      }
      function rd(a) {
        function b(b2, d, e, f, g) {
          this._reactName = b2;
          this._targetInst = e;
          this.type = d;
          this.nativeEvent = f;
          this.target = g;
          this.currentTarget = null;
          for (var c in a) a.hasOwnProperty(c) && (b2 = a[c], this[c] = b2 ? b2(f) : f[c]);
          this.isDefaultPrevented = (null != f.defaultPrevented ? f.defaultPrevented : false === f.returnValue) ? pd : qd;
          this.isPropagationStopped = qd;
          return this;
        }
        A2(b.prototype, { preventDefault: function() {
          this.defaultPrevented = true;
          var a2 = this.nativeEvent;
          a2 && (a2.preventDefault ? a2.preventDefault() : "unknown" !== typeof a2.returnValue && (a2.returnValue = false), this.isDefaultPrevented = pd);
        }, stopPropagation: function() {
          var a2 = this.nativeEvent;
          a2 && (a2.stopPropagation ? a2.stopPropagation() : "unknown" !== typeof a2.cancelBubble && (a2.cancelBubble = true), this.isPropagationStopped = pd);
        }, persist: function() {
        }, isPersistent: pd });
        return b;
      }
      var sd = { eventPhase: 0, bubbles: 0, cancelable: 0, timeStamp: function(a) {
        return a.timeStamp || Date.now();
      }, defaultPrevented: 0, isTrusted: 0 };
      var td = rd(sd);
      var ud = A2({}, sd, { view: 0, detail: 0 });
      var vd = rd(ud);
      var wd;
      var xd;
      var yd;
      var Ad = A2({}, ud, { screenX: 0, screenY: 0, clientX: 0, clientY: 0, pageX: 0, pageY: 0, ctrlKey: 0, shiftKey: 0, altKey: 0, metaKey: 0, getModifierState: zd, button: 0, buttons: 0, relatedTarget: function(a) {
        return void 0 === a.relatedTarget ? a.fromElement === a.srcElement ? a.toElement : a.fromElement : a.relatedTarget;
      }, movementX: function(a) {
        if ("movementX" in a) return a.movementX;
        a !== yd && (yd && "mousemove" === a.type ? (wd = a.screenX - yd.screenX, xd = a.screenY - yd.screenY) : xd = wd = 0, yd = a);
        return wd;
      }, movementY: function(a) {
        return "movementY" in a ? a.movementY : xd;
      } });
      var Bd = rd(Ad);
      var Cd = A2({}, Ad, { dataTransfer: 0 });
      var Dd = rd(Cd);
      var Ed = A2({}, ud, { relatedTarget: 0 });
      var Fd = rd(Ed);
      var Gd = A2({}, sd, { animationName: 0, elapsedTime: 0, pseudoElement: 0 });
      var Hd = rd(Gd);
      var Id = A2({}, sd, { clipboardData: function(a) {
        return "clipboardData" in a ? a.clipboardData : window.clipboardData;
      } });
      var Jd = rd(Id);
      var Kd = A2({}, sd, { data: 0 });
      var Ld = rd(Kd);
      var Md = {
        Esc: "Escape",
        Spacebar: " ",
        Left: "ArrowLeft",
        Up: "ArrowUp",
        Right: "ArrowRight",
        Down: "ArrowDown",
        Del: "Delete",
        Win: "OS",
        Menu: "ContextMenu",
        Apps: "ContextMenu",
        Scroll: "ScrollLock",
        MozPrintableKey: "Unidentified"
      };
      var Nd = {
        8: "Backspace",
        9: "Tab",
        12: "Clear",
        13: "Enter",
        16: "Shift",
        17: "Control",
        18: "Alt",
        19: "Pause",
        20: "CapsLock",
        27: "Escape",
        32: " ",
        33: "PageUp",
        34: "PageDown",
        35: "End",
        36: "Home",
        37: "ArrowLeft",
        38: "ArrowUp",
        39: "ArrowRight",
        40: "ArrowDown",
        45: "Insert",
        46: "Delete",
        112: "F1",
        113: "F2",
        114: "F3",
        115: "F4",
        116: "F5",
        117: "F6",
        118: "F7",
        119: "F8",
        120: "F9",
        121: "F10",
        122: "F11",
        123: "F12",
        144: "NumLock",
        145: "ScrollLock",
        224: "Meta"
      };
      var Od = { Alt: "altKey", Control: "ctrlKey", Meta: "metaKey", Shift: "shiftKey" };
      function Pd(a) {
        var b = this.nativeEvent;
        return b.getModifierState ? b.getModifierState(a) : (a = Od[a]) ? !!b[a] : false;
      }
      function zd() {
        return Pd;
      }
      var Qd = A2({}, ud, { key: function(a) {
        if (a.key) {
          var b = Md[a.key] || a.key;
          if ("Unidentified" !== b) return b;
        }
        return "keypress" === a.type ? (a = od(a), 13 === a ? "Enter" : String.fromCharCode(a)) : "keydown" === a.type || "keyup" === a.type ? Nd[a.keyCode] || "Unidentified" : "";
      }, code: 0, location: 0, ctrlKey: 0, shiftKey: 0, altKey: 0, metaKey: 0, repeat: 0, locale: 0, getModifierState: zd, charCode: function(a) {
        return "keypress" === a.type ? od(a) : 0;
      }, keyCode: function(a) {
        return "keydown" === a.type || "keyup" === a.type ? a.keyCode : 0;
      }, which: function(a) {
        return "keypress" === a.type ? od(a) : "keydown" === a.type || "keyup" === a.type ? a.keyCode : 0;
      } });
      var Rd = rd(Qd);
      var Sd = A2({}, Ad, { pointerId: 0, width: 0, height: 0, pressure: 0, tangentialPressure: 0, tiltX: 0, tiltY: 0, twist: 0, pointerType: 0, isPrimary: 0 });
      var Td = rd(Sd);
      var Ud = A2({}, ud, { touches: 0, targetTouches: 0, changedTouches: 0, altKey: 0, metaKey: 0, ctrlKey: 0, shiftKey: 0, getModifierState: zd });
      var Vd = rd(Ud);
      var Wd = A2({}, sd, { propertyName: 0, elapsedTime: 0, pseudoElement: 0 });
      var Xd = rd(Wd);
      var Yd = A2({}, Ad, {
        deltaX: function(a) {
          return "deltaX" in a ? a.deltaX : "wheelDeltaX" in a ? -a.wheelDeltaX : 0;
        },
        deltaY: function(a) {
          return "deltaY" in a ? a.deltaY : "wheelDeltaY" in a ? -a.wheelDeltaY : "wheelDelta" in a ? -a.wheelDelta : 0;
        },
        deltaZ: 0,
        deltaMode: 0
      });
      var Zd = rd(Yd);
      var $d = [9, 13, 27, 32];
      var ae = ia && "CompositionEvent" in window;
      var be = null;
      ia && "documentMode" in document && (be = document.documentMode);
      var ce = ia && "TextEvent" in window && !be;
      var de = ia && (!ae || be && 8 < be && 11 >= be);
      var ee = String.fromCharCode(32);
      var fe = false;
      function ge(a, b) {
        switch (a) {
          case "keyup":
            return -1 !== $d.indexOf(b.keyCode);
          case "keydown":
            return 229 !== b.keyCode;
          case "keypress":
          case "mousedown":
          case "focusout":
            return true;
          default:
            return false;
        }
      }
      function he(a) {
        a = a.detail;
        return "object" === typeof a && "data" in a ? a.data : null;
      }
      var ie = false;
      function je(a, b) {
        switch (a) {
          case "compositionend":
            return he(b);
          case "keypress":
            if (32 !== b.which) return null;
            fe = true;
            return ee;
          case "textInput":
            return a = b.data, a === ee && fe ? null : a;
          default:
            return null;
        }
      }
      function ke(a, b) {
        if (ie) return "compositionend" === a || !ae && ge(a, b) ? (a = nd(), md = ld = kd = null, ie = false, a) : null;
        switch (a) {
          case "paste":
            return null;
          case "keypress":
            if (!(b.ctrlKey || b.altKey || b.metaKey) || b.ctrlKey && b.altKey) {
              if (b.char && 1 < b.char.length) return b.char;
              if (b.which) return String.fromCharCode(b.which);
            }
            return null;
          case "compositionend":
            return de && "ko" !== b.locale ? null : b.data;
          default:
            return null;
        }
      }
      var le = { color: true, date: true, datetime: true, "datetime-local": true, email: true, month: true, number: true, password: true, range: true, search: true, tel: true, text: true, time: true, url: true, week: true };
      function me(a) {
        var b = a && a.nodeName && a.nodeName.toLowerCase();
        return "input" === b ? !!le[a.type] : "textarea" === b ? true : false;
      }
      function ne(a, b, c, d) {
        Eb(d);
        b = oe(b, "onChange");
        0 < b.length && (c = new td("onChange", "change", null, c, d), a.push({ event: c, listeners: b }));
      }
      var pe = null;
      var qe = null;
      function re(a) {
        se(a, 0);
      }
      function te(a) {
        var b = ue(a);
        if (Wa(b)) return a;
      }
      function ve(a, b) {
        if ("change" === a) return b;
      }
      var we = false;
      if (ia) {
        if (ia) {
          ye = "oninput" in document;
          if (!ye) {
            ze = document.createElement("div");
            ze.setAttribute("oninput", "return;");
            ye = "function" === typeof ze.oninput;
          }
          xe = ye;
        } else xe = false;
        we = xe && (!document.documentMode || 9 < document.documentMode);
      }
      var xe;
      var ye;
      var ze;
      function Ae() {
        pe && (pe.detachEvent("onpropertychange", Be), qe = pe = null);
      }
      function Be(a) {
        if ("value" === a.propertyName && te(qe)) {
          var b = [];
          ne(b, qe, a, xb(a));
          Jb(re, b);
        }
      }
      function Ce(a, b, c) {
        "focusin" === a ? (Ae(), pe = b, qe = c, pe.attachEvent("onpropertychange", Be)) : "focusout" === a && Ae();
      }
      function De(a) {
        if ("selectionchange" === a || "keyup" === a || "keydown" === a) return te(qe);
      }
      function Ee(a, b) {
        if ("click" === a) return te(b);
      }
      function Fe(a, b) {
        if ("input" === a || "change" === a) return te(b);
      }
      function Ge(a, b) {
        return a === b && (0 !== a || 1 / a === 1 / b) || a !== a && b !== b;
      }
      var He = "function" === typeof Object.is ? Object.is : Ge;
      function Ie(a, b) {
        if (He(a, b)) return true;
        if ("object" !== typeof a || null === a || "object" !== typeof b || null === b) return false;
        var c = Object.keys(a), d = Object.keys(b);
        if (c.length !== d.length) return false;
        for (d = 0; d < c.length; d++) {
          var e = c[d];
          if (!ja.call(b, e) || !He(a[e], b[e])) return false;
        }
        return true;
      }
      function Je(a) {
        for (; a && a.firstChild; ) a = a.firstChild;
        return a;
      }
      function Ke(a, b) {
        var c = Je(a);
        a = 0;
        for (var d; c; ) {
          if (3 === c.nodeType) {
            d = a + c.textContent.length;
            if (a <= b && d >= b) return { node: c, offset: b - a };
            a = d;
          }
          a: {
            for (; c; ) {
              if (c.nextSibling) {
                c = c.nextSibling;
                break a;
              }
              c = c.parentNode;
            }
            c = void 0;
          }
          c = Je(c);
        }
      }
      function Le(a, b) {
        return a && b ? a === b ? true : a && 3 === a.nodeType ? false : b && 3 === b.nodeType ? Le(a, b.parentNode) : "contains" in a ? a.contains(b) : a.compareDocumentPosition ? !!(a.compareDocumentPosition(b) & 16) : false : false;
      }
      function Me() {
        for (var a = window, b = Xa(); b instanceof a.HTMLIFrameElement; ) {
          try {
            var c = "string" === typeof b.contentWindow.location.href;
          } catch (d) {
            c = false;
          }
          if (c) a = b.contentWindow;
          else break;
          b = Xa(a.document);
        }
        return b;
      }
      function Ne(a) {
        var b = a && a.nodeName && a.nodeName.toLowerCase();
        return b && ("input" === b && ("text" === a.type || "search" === a.type || "tel" === a.type || "url" === a.type || "password" === a.type) || "textarea" === b || "true" === a.contentEditable);
      }
      function Oe(a) {
        var b = Me(), c = a.focusedElem, d = a.selectionRange;
        if (b !== c && c && c.ownerDocument && Le(c.ownerDocument.documentElement, c)) {
          if (null !== d && Ne(c)) {
            if (b = d.start, a = d.end, void 0 === a && (a = b), "selectionStart" in c) c.selectionStart = b, c.selectionEnd = Math.min(a, c.value.length);
            else if (a = (b = c.ownerDocument || document) && b.defaultView || window, a.getSelection) {
              a = a.getSelection();
              var e = c.textContent.length, f = Math.min(d.start, e);
              d = void 0 === d.end ? f : Math.min(d.end, e);
              !a.extend && f > d && (e = d, d = f, f = e);
              e = Ke(c, f);
              var g = Ke(
                c,
                d
              );
              e && g && (1 !== a.rangeCount || a.anchorNode !== e.node || a.anchorOffset !== e.offset || a.focusNode !== g.node || a.focusOffset !== g.offset) && (b = b.createRange(), b.setStart(e.node, e.offset), a.removeAllRanges(), f > d ? (a.addRange(b), a.extend(g.node, g.offset)) : (b.setEnd(g.node, g.offset), a.addRange(b)));
            }
          }
          b = [];
          for (a = c; a = a.parentNode; ) 1 === a.nodeType && b.push({ element: a, left: a.scrollLeft, top: a.scrollTop });
          "function" === typeof c.focus && c.focus();
          for (c = 0; c < b.length; c++) a = b[c], a.element.scrollLeft = a.left, a.element.scrollTop = a.top;
        }
      }
      var Pe = ia && "documentMode" in document && 11 >= document.documentMode;
      var Qe = null;
      var Re = null;
      var Se = null;
      var Te = false;
      function Ue(a, b, c) {
        var d = c.window === c ? c.document : 9 === c.nodeType ? c : c.ownerDocument;
        Te || null == Qe || Qe !== Xa(d) || (d = Qe, "selectionStart" in d && Ne(d) ? d = { start: d.selectionStart, end: d.selectionEnd } : (d = (d.ownerDocument && d.ownerDocument.defaultView || window).getSelection(), d = { anchorNode: d.anchorNode, anchorOffset: d.anchorOffset, focusNode: d.focusNode, focusOffset: d.focusOffset }), Se && Ie(Se, d) || (Se = d, d = oe(Re, "onSelect"), 0 < d.length && (b = new td("onSelect", "select", null, b, c), a.push({ event: b, listeners: d }), b.target = Qe)));
      }
      function Ve(a, b) {
        var c = {};
        c[a.toLowerCase()] = b.toLowerCase();
        c["Webkit" + a] = "webkit" + b;
        c["Moz" + a] = "moz" + b;
        return c;
      }
      var We = { animationend: Ve("Animation", "AnimationEnd"), animationiteration: Ve("Animation", "AnimationIteration"), animationstart: Ve("Animation", "AnimationStart"), transitionend: Ve("Transition", "TransitionEnd") };
      var Xe = {};
      var Ye = {};
      ia && (Ye = document.createElement("div").style, "AnimationEvent" in window || (delete We.animationend.animation, delete We.animationiteration.animation, delete We.animationstart.animation), "TransitionEvent" in window || delete We.transitionend.transition);
      function Ze(a) {
        if (Xe[a]) return Xe[a];
        if (!We[a]) return a;
        var b = We[a], c;
        for (c in b) if (b.hasOwnProperty(c) && c in Ye) return Xe[a] = b[c];
        return a;
      }
      var $e = Ze("animationend");
      var af = Ze("animationiteration");
      var bf = Ze("animationstart");
      var cf = Ze("transitionend");
      var df = /* @__PURE__ */ new Map();
      var ef = "abort auxClick cancel canPlay canPlayThrough click close contextMenu copy cut drag dragEnd dragEnter dragExit dragLeave dragOver dragStart drop durationChange emptied encrypted ended error gotPointerCapture input invalid keyDown keyPress keyUp load loadedData loadedMetadata loadStart lostPointerCapture mouseDown mouseMove mouseOut mouseOver mouseUp paste pause play playing pointerCancel pointerDown pointerMove pointerOut pointerOver pointerUp progress rateChange reset resize seeked seeking stalled submit suspend timeUpdate touchCancel touchEnd touchStart volumeChange scroll toggle touchMove waiting wheel".split(" ");
      function ff(a, b) {
        df.set(a, b);
        fa(b, [a]);
      }
      for (gf = 0; gf < ef.length; gf++) {
        hf = ef[gf], jf = hf.toLowerCase(), kf = hf[0].toUpperCase() + hf.slice(1);
        ff(jf, "on" + kf);
      }
      var hf;
      var jf;
      var kf;
      var gf;
      ff($e, "onAnimationEnd");
      ff(af, "onAnimationIteration");
      ff(bf, "onAnimationStart");
      ff("dblclick", "onDoubleClick");
      ff("focusin", "onFocus");
      ff("focusout", "onBlur");
      ff(cf, "onTransitionEnd");
      ha("onMouseEnter", ["mouseout", "mouseover"]);
      ha("onMouseLeave", ["mouseout", "mouseover"]);
      ha("onPointerEnter", ["pointerout", "pointerover"]);
      ha("onPointerLeave", ["pointerout", "pointerover"]);
      fa("onChange", "change click focusin focusout input keydown keyup selectionchange".split(" "));
      fa("onSelect", "focusout contextmenu dragend focusin keydown keyup mousedown mouseup selectionchange".split(" "));
      fa("onBeforeInput", ["compositionend", "keypress", "textInput", "paste"]);
      fa("onCompositionEnd", "compositionend focusout keydown keypress keyup mousedown".split(" "));
      fa("onCompositionStart", "compositionstart focusout keydown keypress keyup mousedown".split(" "));
      fa("onCompositionUpdate", "compositionupdate focusout keydown keypress keyup mousedown".split(" "));
      var lf = "abort canplay canplaythrough durationchange emptied encrypted ended error loadeddata loadedmetadata loadstart pause play playing progress ratechange resize seeked seeking stalled suspend timeupdate volumechange waiting".split(" ");
      var mf = new Set("cancel close invalid load scroll toggle".split(" ").concat(lf));
      function nf(a, b, c) {
        var d = a.type || "unknown-event";
        a.currentTarget = c;
        Ub(d, b, void 0, a);
        a.currentTarget = null;
      }
      function se(a, b) {
        b = 0 !== (b & 4);
        for (var c = 0; c < a.length; c++) {
          var d = a[c], e = d.event;
          d = d.listeners;
          a: {
            var f = void 0;
            if (b) for (var g = d.length - 1; 0 <= g; g--) {
              var h = d[g], k = h.instance, l = h.currentTarget;
              h = h.listener;
              if (k !== f && e.isPropagationStopped()) break a;
              nf(e, h, l);
              f = k;
            }
            else for (g = 0; g < d.length; g++) {
              h = d[g];
              k = h.instance;
              l = h.currentTarget;
              h = h.listener;
              if (k !== f && e.isPropagationStopped()) break a;
              nf(e, h, l);
              f = k;
            }
          }
        }
        if (Qb) throw a = Rb, Qb = false, Rb = null, a;
      }
      function D2(a, b) {
        var c = b[of];
        void 0 === c && (c = b[of] = /* @__PURE__ */ new Set());
        var d = a + "__bubble";
        c.has(d) || (pf(b, a, 2, false), c.add(d));
      }
      function qf(a, b, c) {
        var d = 0;
        b && (d |= 4);
        pf(c, a, d, b);
      }
      var rf = "_reactListening" + Math.random().toString(36).slice(2);
      function sf(a) {
        if (!a[rf]) {
          a[rf] = true;
          da.forEach(function(b2) {
            "selectionchange" !== b2 && (mf.has(b2) || qf(b2, false, a), qf(b2, true, a));
          });
          var b = 9 === a.nodeType ? a : a.ownerDocument;
          null === b || b[rf] || (b[rf] = true, qf("selectionchange", false, b));
        }
      }
      function pf(a, b, c, d) {
        switch (jd(b)) {
          case 1:
            var e = ed;
            break;
          case 4:
            e = gd;
            break;
          default:
            e = fd;
        }
        c = e.bind(null, b, c, a);
        e = void 0;
        !Lb || "touchstart" !== b && "touchmove" !== b && "wheel" !== b || (e = true);
        d ? void 0 !== e ? a.addEventListener(b, c, { capture: true, passive: e }) : a.addEventListener(b, c, true) : void 0 !== e ? a.addEventListener(b, c, { passive: e }) : a.addEventListener(b, c, false);
      }
      function hd(a, b, c, d, e) {
        var f = d;
        if (0 === (b & 1) && 0 === (b & 2) && null !== d) a: for (; ; ) {
          if (null === d) return;
          var g = d.tag;
          if (3 === g || 4 === g) {
            var h = d.stateNode.containerInfo;
            if (h === e || 8 === h.nodeType && h.parentNode === e) break;
            if (4 === g) for (g = d.return; null !== g; ) {
              var k = g.tag;
              if (3 === k || 4 === k) {
                if (k = g.stateNode.containerInfo, k === e || 8 === k.nodeType && k.parentNode === e) return;
              }
              g = g.return;
            }
            for (; null !== h; ) {
              g = Wc(h);
              if (null === g) return;
              k = g.tag;
              if (5 === k || 6 === k) {
                d = f = g;
                continue a;
              }
              h = h.parentNode;
            }
          }
          d = d.return;
        }
        Jb(function() {
          var d2 = f, e2 = xb(c), g2 = [];
          a: {
            var h2 = df.get(a);
            if (void 0 !== h2) {
              var k2 = td, n = a;
              switch (a) {
                case "keypress":
                  if (0 === od(c)) break a;
                case "keydown":
                case "keyup":
                  k2 = Rd;
                  break;
                case "focusin":
                  n = "focus";
                  k2 = Fd;
                  break;
                case "focusout":
                  n = "blur";
                  k2 = Fd;
                  break;
                case "beforeblur":
                case "afterblur":
                  k2 = Fd;
                  break;
                case "click":
                  if (2 === c.button) break a;
                case "auxclick":
                case "dblclick":
                case "mousedown":
                case "mousemove":
                case "mouseup":
                case "mouseout":
                case "mouseover":
                case "contextmenu":
                  k2 = Bd;
                  break;
                case "drag":
                case "dragend":
                case "dragenter":
                case "dragexit":
                case "dragleave":
                case "dragover":
                case "dragstart":
                case "drop":
                  k2 = Dd;
                  break;
                case "touchcancel":
                case "touchend":
                case "touchmove":
                case "touchstart":
                  k2 = Vd;
                  break;
                case $e:
                case af:
                case bf:
                  k2 = Hd;
                  break;
                case cf:
                  k2 = Xd;
                  break;
                case "scroll":
                  k2 = vd;
                  break;
                case "wheel":
                  k2 = Zd;
                  break;
                case "copy":
                case "cut":
                case "paste":
                  k2 = Jd;
                  break;
                case "gotpointercapture":
                case "lostpointercapture":
                case "pointercancel":
                case "pointerdown":
                case "pointermove":
                case "pointerout":
                case "pointerover":
                case "pointerup":
                  k2 = Td;
              }
              var t = 0 !== (b & 4), J = !t && "scroll" === a, x = t ? null !== h2 ? h2 + "Capture" : null : h2;
              t = [];
              for (var w = d2, u; null !== w; ) {
                u = w;
                var F = u.stateNode;
                5 === u.tag && null !== F && (u = F, null !== x && (F = Kb(w, x), null != F && t.push(tf(w, F, u))));
                if (J) break;
                w = w.return;
              }
              0 < t.length && (h2 = new k2(h2, n, null, c, e2), g2.push({ event: h2, listeners: t }));
            }
          }
          if (0 === (b & 7)) {
            a: {
              h2 = "mouseover" === a || "pointerover" === a;
              k2 = "mouseout" === a || "pointerout" === a;
              if (h2 && c !== wb && (n = c.relatedTarget || c.fromElement) && (Wc(n) || n[uf])) break a;
              if (k2 || h2) {
                h2 = e2.window === e2 ? e2 : (h2 = e2.ownerDocument) ? h2.defaultView || h2.parentWindow : window;
                if (k2) {
                  if (n = c.relatedTarget || c.toElement, k2 = d2, n = n ? Wc(n) : null, null !== n && (J = Vb(n), n !== J || 5 !== n.tag && 6 !== n.tag)) n = null;
                } else k2 = null, n = d2;
                if (k2 !== n) {
                  t = Bd;
                  F = "onMouseLeave";
                  x = "onMouseEnter";
                  w = "mouse";
                  if ("pointerout" === a || "pointerover" === a) t = Td, F = "onPointerLeave", x = "onPointerEnter", w = "pointer";
                  J = null == k2 ? h2 : ue(k2);
                  u = null == n ? h2 : ue(n);
                  h2 = new t(F, w + "leave", k2, c, e2);
                  h2.target = J;
                  h2.relatedTarget = u;
                  F = null;
                  Wc(e2) === d2 && (t = new t(x, w + "enter", n, c, e2), t.target = u, t.relatedTarget = J, F = t);
                  J = F;
                  if (k2 && n) b: {
                    t = k2;
                    x = n;
                    w = 0;
                    for (u = t; u; u = vf(u)) w++;
                    u = 0;
                    for (F = x; F; F = vf(F)) u++;
                    for (; 0 < w - u; ) t = vf(t), w--;
                    for (; 0 < u - w; ) x = vf(x), u--;
                    for (; w--; ) {
                      if (t === x || null !== x && t === x.alternate) break b;
                      t = vf(t);
                      x = vf(x);
                    }
                    t = null;
                  }
                  else t = null;
                  null !== k2 && wf(g2, h2, k2, t, false);
                  null !== n && null !== J && wf(g2, J, n, t, true);
                }
              }
            }
            a: {
              h2 = d2 ? ue(d2) : window;
              k2 = h2.nodeName && h2.nodeName.toLowerCase();
              if ("select" === k2 || "input" === k2 && "file" === h2.type) var na = ve;
              else if (me(h2)) if (we) na = Fe;
              else {
                na = De;
                var xa = Ce;
              }
              else (k2 = h2.nodeName) && "input" === k2.toLowerCase() && ("checkbox" === h2.type || "radio" === h2.type) && (na = Ee);
              if (na && (na = na(a, d2))) {
                ne(g2, na, c, e2);
                break a;
              }
              xa && xa(a, h2, d2);
              "focusout" === a && (xa = h2._wrapperState) && xa.controlled && "number" === h2.type && cb(h2, "number", h2.value);
            }
            xa = d2 ? ue(d2) : window;
            switch (a) {
              case "focusin":
                if (me(xa) || "true" === xa.contentEditable) Qe = xa, Re = d2, Se = null;
                break;
              case "focusout":
                Se = Re = Qe = null;
                break;
              case "mousedown":
                Te = true;
                break;
              case "contextmenu":
              case "mouseup":
              case "dragend":
                Te = false;
                Ue(g2, c, e2);
                break;
              case "selectionchange":
                if (Pe) break;
              case "keydown":
              case "keyup":
                Ue(g2, c, e2);
            }
            var $a;
            if (ae) b: {
              switch (a) {
                case "compositionstart":
                  var ba = "onCompositionStart";
                  break b;
                case "compositionend":
                  ba = "onCompositionEnd";
                  break b;
                case "compositionupdate":
                  ba = "onCompositionUpdate";
                  break b;
              }
              ba = void 0;
            }
            else ie ? ge(a, c) && (ba = "onCompositionEnd") : "keydown" === a && 229 === c.keyCode && (ba = "onCompositionStart");
            ba && (de && "ko" !== c.locale && (ie || "onCompositionStart" !== ba ? "onCompositionEnd" === ba && ie && ($a = nd()) : (kd = e2, ld = "value" in kd ? kd.value : kd.textContent, ie = true)), xa = oe(d2, ba), 0 < xa.length && (ba = new Ld(ba, a, null, c, e2), g2.push({ event: ba, listeners: xa }), $a ? ba.data = $a : ($a = he(c), null !== $a && (ba.data = $a))));
            if ($a = ce ? je(a, c) : ke(a, c)) d2 = oe(d2, "onBeforeInput"), 0 < d2.length && (e2 = new Ld("onBeforeInput", "beforeinput", null, c, e2), g2.push({ event: e2, listeners: d2 }), e2.data = $a);
          }
          se(g2, b);
        });
      }
      function tf(a, b, c) {
        return { instance: a, listener: b, currentTarget: c };
      }
      function oe(a, b) {
        for (var c = b + "Capture", d = []; null !== a; ) {
          var e = a, f = e.stateNode;
          5 === e.tag && null !== f && (e = f, f = Kb(a, c), null != f && d.unshift(tf(a, f, e)), f = Kb(a, b), null != f && d.push(tf(a, f, e)));
          a = a.return;
        }
        return d;
      }
      function vf(a) {
        if (null === a) return null;
        do
          a = a.return;
        while (a && 5 !== a.tag);
        return a ? a : null;
      }
      function wf(a, b, c, d, e) {
        for (var f = b._reactName, g = []; null !== c && c !== d; ) {
          var h = c, k = h.alternate, l = h.stateNode;
          if (null !== k && k === d) break;
          5 === h.tag && null !== l && (h = l, e ? (k = Kb(c, f), null != k && g.unshift(tf(c, k, h))) : e || (k = Kb(c, f), null != k && g.push(tf(c, k, h))));
          c = c.return;
        }
        0 !== g.length && a.push({ event: b, listeners: g });
      }
      var xf = /\r\n?/g;
      var yf = /\u0000|\uFFFD/g;
      function zf(a) {
        return ("string" === typeof a ? a : "" + a).replace(xf, "\n").replace(yf, "");
      }
      function Af(a, b, c) {
        b = zf(b);
        if (zf(a) !== b && c) throw Error(p(425));
      }
      function Bf() {
      }
      var Cf = null;
      var Df = null;
      function Ef(a, b) {
        return "textarea" === a || "noscript" === a || "string" === typeof b.children || "number" === typeof b.children || "object" === typeof b.dangerouslySetInnerHTML && null !== b.dangerouslySetInnerHTML && null != b.dangerouslySetInnerHTML.__html;
      }
      var Ff = "function" === typeof setTimeout ? setTimeout : void 0;
      var Gf = "function" === typeof clearTimeout ? clearTimeout : void 0;
      var Hf = "function" === typeof Promise ? Promise : void 0;
      var Jf = "function" === typeof queueMicrotask ? queueMicrotask : "undefined" !== typeof Hf ? function(a) {
        return Hf.resolve(null).then(a).catch(If);
      } : Ff;
      function If(a) {
        setTimeout(function() {
          throw a;
        });
      }
      function Kf(a, b) {
        var c = b, d = 0;
        do {
          var e = c.nextSibling;
          a.removeChild(c);
          if (e && 8 === e.nodeType) if (c = e.data, "/$" === c) {
            if (0 === d) {
              a.removeChild(e);
              bd(b);
              return;
            }
            d--;
          } else "$" !== c && "$?" !== c && "$!" !== c || d++;
          c = e;
        } while (c);
        bd(b);
      }
      function Lf(a) {
        for (; null != a; a = a.nextSibling) {
          var b = a.nodeType;
          if (1 === b || 3 === b) break;
          if (8 === b) {
            b = a.data;
            if ("$" === b || "$!" === b || "$?" === b) break;
            if ("/$" === b) return null;
          }
        }
        return a;
      }
      function Mf(a) {
        a = a.previousSibling;
        for (var b = 0; a; ) {
          if (8 === a.nodeType) {
            var c = a.data;
            if ("$" === c || "$!" === c || "$?" === c) {
              if (0 === b) return a;
              b--;
            } else "/$" === c && b++;
          }
          a = a.previousSibling;
        }
        return null;
      }
      var Nf = Math.random().toString(36).slice(2);
      var Of = "__reactFiber$" + Nf;
      var Pf = "__reactProps$" + Nf;
      var uf = "__reactContainer$" + Nf;
      var of = "__reactEvents$" + Nf;
      var Qf = "__reactListeners$" + Nf;
      var Rf = "__reactHandles$" + Nf;
      function Wc(a) {
        var b = a[Of];
        if (b) return b;
        for (var c = a.parentNode; c; ) {
          if (b = c[uf] || c[Of]) {
            c = b.alternate;
            if (null !== b.child || null !== c && null !== c.child) for (a = Mf(a); null !== a; ) {
              if (c = a[Of]) return c;
              a = Mf(a);
            }
            return b;
          }
          a = c;
          c = a.parentNode;
        }
        return null;
      }
      function Cb(a) {
        a = a[Of] || a[uf];
        return !a || 5 !== a.tag && 6 !== a.tag && 13 !== a.tag && 3 !== a.tag ? null : a;
      }
      function ue(a) {
        if (5 === a.tag || 6 === a.tag) return a.stateNode;
        throw Error(p(33));
      }
      function Db(a) {
        return a[Pf] || null;
      }
      var Sf = [];
      var Tf = -1;
      function Uf(a) {
        return { current: a };
      }
      function E(a) {
        0 > Tf || (a.current = Sf[Tf], Sf[Tf] = null, Tf--);
      }
      function G(a, b) {
        Tf++;
        Sf[Tf] = a.current;
        a.current = b;
      }
      var Vf = {};
      var H = Uf(Vf);
      var Wf = Uf(false);
      var Xf = Vf;
      function Yf(a, b) {
        var c = a.type.contextTypes;
        if (!c) return Vf;
        var d = a.stateNode;
        if (d && d.__reactInternalMemoizedUnmaskedChildContext === b) return d.__reactInternalMemoizedMaskedChildContext;
        var e = {}, f;
        for (f in c) e[f] = b[f];
        d && (a = a.stateNode, a.__reactInternalMemoizedUnmaskedChildContext = b, a.__reactInternalMemoizedMaskedChildContext = e);
        return e;
      }
      function Zf(a) {
        a = a.childContextTypes;
        return null !== a && void 0 !== a;
      }
      function $f() {
        E(Wf);
        E(H);
      }
      function ag(a, b, c) {
        if (H.current !== Vf) throw Error(p(168));
        G(H, b);
        G(Wf, c);
      }
      function bg(a, b, c) {
        var d = a.stateNode;
        b = b.childContextTypes;
        if ("function" !== typeof d.getChildContext) return c;
        d = d.getChildContext();
        for (var e in d) if (!(e in b)) throw Error(p(108, Ra(a) || "Unknown", e));
        return A2({}, c, d);
      }
      function cg(a) {
        a = (a = a.stateNode) && a.__reactInternalMemoizedMergedChildContext || Vf;
        Xf = H.current;
        G(H, a);
        G(Wf, Wf.current);
        return true;
      }
      function dg(a, b, c) {
        var d = a.stateNode;
        if (!d) throw Error(p(169));
        c ? (a = bg(a, b, Xf), d.__reactInternalMemoizedMergedChildContext = a, E(Wf), E(H), G(H, a)) : E(Wf);
        G(Wf, c);
      }
      var eg = null;
      var fg = false;
      var gg = false;
      function hg(a) {
        null === eg ? eg = [a] : eg.push(a);
      }
      function ig(a) {
        fg = true;
        hg(a);
      }
      function jg() {
        if (!gg && null !== eg) {
          gg = true;
          var a = 0, b = C2;
          try {
            var c = eg;
            for (C2 = 1; a < c.length; a++) {
              var d = c[a];
              do
                d = d(true);
              while (null !== d);
            }
            eg = null;
            fg = false;
          } catch (e) {
            throw null !== eg && (eg = eg.slice(a + 1)), ac(fc, jg), e;
          } finally {
            C2 = b, gg = false;
          }
        }
        return null;
      }
      var kg = [];
      var lg = 0;
      var mg = null;
      var ng = 0;
      var og = [];
      var pg = 0;
      var qg = null;
      var rg = 1;
      var sg = "";
      function tg(a, b) {
        kg[lg++] = ng;
        kg[lg++] = mg;
        mg = a;
        ng = b;
      }
      function ug(a, b, c) {
        og[pg++] = rg;
        og[pg++] = sg;
        og[pg++] = qg;
        qg = a;
        var d = rg;
        a = sg;
        var e = 32 - oc(d) - 1;
        d &= ~(1 << e);
        c += 1;
        var f = 32 - oc(b) + e;
        if (30 < f) {
          var g = e - e % 5;
          f = (d & (1 << g) - 1).toString(32);
          d >>= g;
          e -= g;
          rg = 1 << 32 - oc(b) + e | c << e | d;
          sg = f + a;
        } else rg = 1 << f | c << e | d, sg = a;
      }
      function vg(a) {
        null !== a.return && (tg(a, 1), ug(a, 1, 0));
      }
      function wg(a) {
        for (; a === mg; ) mg = kg[--lg], kg[lg] = null, ng = kg[--lg], kg[lg] = null;
        for (; a === qg; ) qg = og[--pg], og[pg] = null, sg = og[--pg], og[pg] = null, rg = og[--pg], og[pg] = null;
      }
      var xg = null;
      var yg = null;
      var I = false;
      var zg = null;
      function Ag(a, b) {
        var c = Bg(5, null, null, 0);
        c.elementType = "DELETED";
        c.stateNode = b;
        c.return = a;
        b = a.deletions;
        null === b ? (a.deletions = [c], a.flags |= 16) : b.push(c);
      }
      function Cg(a, b) {
        switch (a.tag) {
          case 5:
            var c = a.type;
            b = 1 !== b.nodeType || c.toLowerCase() !== b.nodeName.toLowerCase() ? null : b;
            return null !== b ? (a.stateNode = b, xg = a, yg = Lf(b.firstChild), true) : false;
          case 6:
            return b = "" === a.pendingProps || 3 !== b.nodeType ? null : b, null !== b ? (a.stateNode = b, xg = a, yg = null, true) : false;
          case 13:
            return b = 8 !== b.nodeType ? null : b, null !== b ? (c = null !== qg ? { id: rg, overflow: sg } : null, a.memoizedState = { dehydrated: b, treeContext: c, retryLane: 1073741824 }, c = Bg(18, null, null, 0), c.stateNode = b, c.return = a, a.child = c, xg = a, yg = null, true) : false;
          default:
            return false;
        }
      }
      function Dg(a) {
        return 0 !== (a.mode & 1) && 0 === (a.flags & 128);
      }
      function Eg(a) {
        if (I) {
          var b = yg;
          if (b) {
            var c = b;
            if (!Cg(a, b)) {
              if (Dg(a)) throw Error(p(418));
              b = Lf(c.nextSibling);
              var d = xg;
              b && Cg(a, b) ? Ag(d, c) : (a.flags = a.flags & -4097 | 2, I = false, xg = a);
            }
          } else {
            if (Dg(a)) throw Error(p(418));
            a.flags = a.flags & -4097 | 2;
            I = false;
            xg = a;
          }
        }
      }
      function Fg(a) {
        for (a = a.return; null !== a && 5 !== a.tag && 3 !== a.tag && 13 !== a.tag; ) a = a.return;
        xg = a;
      }
      function Gg(a) {
        if (a !== xg) return false;
        if (!I) return Fg(a), I = true, false;
        var b;
        (b = 3 !== a.tag) && !(b = 5 !== a.tag) && (b = a.type, b = "head" !== b && "body" !== b && !Ef(a.type, a.memoizedProps));
        if (b && (b = yg)) {
          if (Dg(a)) throw Hg(), Error(p(418));
          for (; b; ) Ag(a, b), b = Lf(b.nextSibling);
        }
        Fg(a);
        if (13 === a.tag) {
          a = a.memoizedState;
          a = null !== a ? a.dehydrated : null;
          if (!a) throw Error(p(317));
          a: {
            a = a.nextSibling;
            for (b = 0; a; ) {
              if (8 === a.nodeType) {
                var c = a.data;
                if ("/$" === c) {
                  if (0 === b) {
                    yg = Lf(a.nextSibling);
                    break a;
                  }
                  b--;
                } else "$" !== c && "$!" !== c && "$?" !== c || b++;
              }
              a = a.nextSibling;
            }
            yg = null;
          }
        } else yg = xg ? Lf(a.stateNode.nextSibling) : null;
        return true;
      }
      function Hg() {
        for (var a = yg; a; ) a = Lf(a.nextSibling);
      }
      function Ig() {
        yg = xg = null;
        I = false;
      }
      function Jg(a) {
        null === zg ? zg = [a] : zg.push(a);
      }
      var Kg = ua.ReactCurrentBatchConfig;
      function Lg(a, b, c) {
        a = c.ref;
        if (null !== a && "function" !== typeof a && "object" !== typeof a) {
          if (c._owner) {
            c = c._owner;
            if (c) {
              if (1 !== c.tag) throw Error(p(309));
              var d = c.stateNode;
            }
            if (!d) throw Error(p(147, a));
            var e = d, f = "" + a;
            if (null !== b && null !== b.ref && "function" === typeof b.ref && b.ref._stringRef === f) return b.ref;
            b = function(a2) {
              var b2 = e.refs;
              null === a2 ? delete b2[f] : b2[f] = a2;
            };
            b._stringRef = f;
            return b;
          }
          if ("string" !== typeof a) throw Error(p(284));
          if (!c._owner) throw Error(p(290, a));
        }
        return a;
      }
      function Mg(a, b) {
        a = Object.prototype.toString.call(b);
        throw Error(p(31, "[object Object]" === a ? "object with keys {" + Object.keys(b).join(", ") + "}" : a));
      }
      function Ng(a) {
        var b = a._init;
        return b(a._payload);
      }
      function Og(a) {
        function b(b2, c2) {
          if (a) {
            var d2 = b2.deletions;
            null === d2 ? (b2.deletions = [c2], b2.flags |= 16) : d2.push(c2);
          }
        }
        function c(c2, d2) {
          if (!a) return null;
          for (; null !== d2; ) b(c2, d2), d2 = d2.sibling;
          return null;
        }
        function d(a2, b2) {
          for (a2 = /* @__PURE__ */ new Map(); null !== b2; ) null !== b2.key ? a2.set(b2.key, b2) : a2.set(b2.index, b2), b2 = b2.sibling;
          return a2;
        }
        function e(a2, b2) {
          a2 = Pg(a2, b2);
          a2.index = 0;
          a2.sibling = null;
          return a2;
        }
        function f(b2, c2, d2) {
          b2.index = d2;
          if (!a) return b2.flags |= 1048576, c2;
          d2 = b2.alternate;
          if (null !== d2) return d2 = d2.index, d2 < c2 ? (b2.flags |= 2, c2) : d2;
          b2.flags |= 2;
          return c2;
        }
        function g(b2) {
          a && null === b2.alternate && (b2.flags |= 2);
          return b2;
        }
        function h(a2, b2, c2, d2) {
          if (null === b2 || 6 !== b2.tag) return b2 = Qg(c2, a2.mode, d2), b2.return = a2, b2;
          b2 = e(b2, c2);
          b2.return = a2;
          return b2;
        }
        function k(a2, b2, c2, d2) {
          var f2 = c2.type;
          if (f2 === ya) return m(a2, b2, c2.props.children, d2, c2.key);
          if (null !== b2 && (b2.elementType === f2 || "object" === typeof f2 && null !== f2 && f2.$$typeof === Ha && Ng(f2) === b2.type)) return d2 = e(b2, c2.props), d2.ref = Lg(a2, b2, c2), d2.return = a2, d2;
          d2 = Rg(c2.type, c2.key, c2.props, null, a2.mode, d2);
          d2.ref = Lg(a2, b2, c2);
          d2.return = a2;
          return d2;
        }
        function l(a2, b2, c2, d2) {
          if (null === b2 || 4 !== b2.tag || b2.stateNode.containerInfo !== c2.containerInfo || b2.stateNode.implementation !== c2.implementation) return b2 = Sg(c2, a2.mode, d2), b2.return = a2, b2;
          b2 = e(b2, c2.children || []);
          b2.return = a2;
          return b2;
        }
        function m(a2, b2, c2, d2, f2) {
          if (null === b2 || 7 !== b2.tag) return b2 = Tg(c2, a2.mode, d2, f2), b2.return = a2, b2;
          b2 = e(b2, c2);
          b2.return = a2;
          return b2;
        }
        function q(a2, b2, c2) {
          if ("string" === typeof b2 && "" !== b2 || "number" === typeof b2) return b2 = Qg("" + b2, a2.mode, c2), b2.return = a2, b2;
          if ("object" === typeof b2 && null !== b2) {
            switch (b2.$$typeof) {
              case va:
                return c2 = Rg(b2.type, b2.key, b2.props, null, a2.mode, c2), c2.ref = Lg(a2, null, b2), c2.return = a2, c2;
              case wa:
                return b2 = Sg(b2, a2.mode, c2), b2.return = a2, b2;
              case Ha:
                var d2 = b2._init;
                return q(a2, d2(b2._payload), c2);
            }
            if (eb(b2) || Ka(b2)) return b2 = Tg(b2, a2.mode, c2, null), b2.return = a2, b2;
            Mg(a2, b2);
          }
          return null;
        }
        function r(a2, b2, c2, d2) {
          var e2 = null !== b2 ? b2.key : null;
          if ("string" === typeof c2 && "" !== c2 || "number" === typeof c2) return null !== e2 ? null : h(a2, b2, "" + c2, d2);
          if ("object" === typeof c2 && null !== c2) {
            switch (c2.$$typeof) {
              case va:
                return c2.key === e2 ? k(a2, b2, c2, d2) : null;
              case wa:
                return c2.key === e2 ? l(a2, b2, c2, d2) : null;
              case Ha:
                return e2 = c2._init, r(
                  a2,
                  b2,
                  e2(c2._payload),
                  d2
                );
            }
            if (eb(c2) || Ka(c2)) return null !== e2 ? null : m(a2, b2, c2, d2, null);
            Mg(a2, c2);
          }
          return null;
        }
        function y(a2, b2, c2, d2, e2) {
          if ("string" === typeof d2 && "" !== d2 || "number" === typeof d2) return a2 = a2.get(c2) || null, h(b2, a2, "" + d2, e2);
          if ("object" === typeof d2 && null !== d2) {
            switch (d2.$$typeof) {
              case va:
                return a2 = a2.get(null === d2.key ? c2 : d2.key) || null, k(b2, a2, d2, e2);
              case wa:
                return a2 = a2.get(null === d2.key ? c2 : d2.key) || null, l(b2, a2, d2, e2);
              case Ha:
                var f2 = d2._init;
                return y(a2, b2, c2, f2(d2._payload), e2);
            }
            if (eb(d2) || Ka(d2)) return a2 = a2.get(c2) || null, m(b2, a2, d2, e2, null);
            Mg(b2, d2);
          }
          return null;
        }
        function n(e2, g2, h2, k2) {
          for (var l2 = null, m2 = null, u = g2, w = g2 = 0, x = null; null !== u && w < h2.length; w++) {
            u.index > w ? (x = u, u = null) : x = u.sibling;
            var n2 = r(e2, u, h2[w], k2);
            if (null === n2) {
              null === u && (u = x);
              break;
            }
            a && u && null === n2.alternate && b(e2, u);
            g2 = f(n2, g2, w);
            null === m2 ? l2 = n2 : m2.sibling = n2;
            m2 = n2;
            u = x;
          }
          if (w === h2.length) return c(e2, u), I && tg(e2, w), l2;
          if (null === u) {
            for (; w < h2.length; w++) u = q(e2, h2[w], k2), null !== u && (g2 = f(u, g2, w), null === m2 ? l2 = u : m2.sibling = u, m2 = u);
            I && tg(e2, w);
            return l2;
          }
          for (u = d(e2, u); w < h2.length; w++) x = y(u, e2, w, h2[w], k2), null !== x && (a && null !== x.alternate && u.delete(null === x.key ? w : x.key), g2 = f(x, g2, w), null === m2 ? l2 = x : m2.sibling = x, m2 = x);
          a && u.forEach(function(a2) {
            return b(e2, a2);
          });
          I && tg(e2, w);
          return l2;
        }
        function t(e2, g2, h2, k2) {
          var l2 = Ka(h2);
          if ("function" !== typeof l2) throw Error(p(150));
          h2 = l2.call(h2);
          if (null == h2) throw Error(p(151));
          for (var u = l2 = null, m2 = g2, w = g2 = 0, x = null, n2 = h2.next(); null !== m2 && !n2.done; w++, n2 = h2.next()) {
            m2.index > w ? (x = m2, m2 = null) : x = m2.sibling;
            var t2 = r(e2, m2, n2.value, k2);
            if (null === t2) {
              null === m2 && (m2 = x);
              break;
            }
            a && m2 && null === t2.alternate && b(e2, m2);
            g2 = f(t2, g2, w);
            null === u ? l2 = t2 : u.sibling = t2;
            u = t2;
            m2 = x;
          }
          if (n2.done) return c(
            e2,
            m2
          ), I && tg(e2, w), l2;
          if (null === m2) {
            for (; !n2.done; w++, n2 = h2.next()) n2 = q(e2, n2.value, k2), null !== n2 && (g2 = f(n2, g2, w), null === u ? l2 = n2 : u.sibling = n2, u = n2);
            I && tg(e2, w);
            return l2;
          }
          for (m2 = d(e2, m2); !n2.done; w++, n2 = h2.next()) n2 = y(m2, e2, w, n2.value, k2), null !== n2 && (a && null !== n2.alternate && m2.delete(null === n2.key ? w : n2.key), g2 = f(n2, g2, w), null === u ? l2 = n2 : u.sibling = n2, u = n2);
          a && m2.forEach(function(a2) {
            return b(e2, a2);
          });
          I && tg(e2, w);
          return l2;
        }
        function J(a2, d2, f2, h2) {
          "object" === typeof f2 && null !== f2 && f2.type === ya && null === f2.key && (f2 = f2.props.children);
          if ("object" === typeof f2 && null !== f2) {
            switch (f2.$$typeof) {
              case va:
                a: {
                  for (var k2 = f2.key, l2 = d2; null !== l2; ) {
                    if (l2.key === k2) {
                      k2 = f2.type;
                      if (k2 === ya) {
                        if (7 === l2.tag) {
                          c(a2, l2.sibling);
                          d2 = e(l2, f2.props.children);
                          d2.return = a2;
                          a2 = d2;
                          break a;
                        }
                      } else if (l2.elementType === k2 || "object" === typeof k2 && null !== k2 && k2.$$typeof === Ha && Ng(k2) === l2.type) {
                        c(a2, l2.sibling);
                        d2 = e(l2, f2.props);
                        d2.ref = Lg(a2, l2, f2);
                        d2.return = a2;
                        a2 = d2;
                        break a;
                      }
                      c(a2, l2);
                      break;
                    } else b(a2, l2);
                    l2 = l2.sibling;
                  }
                  f2.type === ya ? (d2 = Tg(f2.props.children, a2.mode, h2, f2.key), d2.return = a2, a2 = d2) : (h2 = Rg(f2.type, f2.key, f2.props, null, a2.mode, h2), h2.ref = Lg(a2, d2, f2), h2.return = a2, a2 = h2);
                }
                return g(a2);
              case wa:
                a: {
                  for (l2 = f2.key; null !== d2; ) {
                    if (d2.key === l2) if (4 === d2.tag && d2.stateNode.containerInfo === f2.containerInfo && d2.stateNode.implementation === f2.implementation) {
                      c(a2, d2.sibling);
                      d2 = e(d2, f2.children || []);
                      d2.return = a2;
                      a2 = d2;
                      break a;
                    } else {
                      c(a2, d2);
                      break;
                    }
                    else b(a2, d2);
                    d2 = d2.sibling;
                  }
                  d2 = Sg(f2, a2.mode, h2);
                  d2.return = a2;
                  a2 = d2;
                }
                return g(a2);
              case Ha:
                return l2 = f2._init, J(a2, d2, l2(f2._payload), h2);
            }
            if (eb(f2)) return n(a2, d2, f2, h2);
            if (Ka(f2)) return t(a2, d2, f2, h2);
            Mg(a2, f2);
          }
          return "string" === typeof f2 && "" !== f2 || "number" === typeof f2 ? (f2 = "" + f2, null !== d2 && 6 === d2.tag ? (c(a2, d2.sibling), d2 = e(d2, f2), d2.return = a2, a2 = d2) : (c(a2, d2), d2 = Qg(f2, a2.mode, h2), d2.return = a2, a2 = d2), g(a2)) : c(a2, d2);
        }
        return J;
      }
      var Ug = Og(true);
      var Vg = Og(false);
      var Wg = Uf(null);
      var Xg = null;
      var Yg = null;
      var Zg = null;
      function $g() {
        Zg = Yg = Xg = null;
      }
      function ah(a) {
        var b = Wg.current;
        E(Wg);
        a._currentValue = b;
      }
      function bh(a, b, c) {
        for (; null !== a; ) {
          var d = a.alternate;
          (a.childLanes & b) !== b ? (a.childLanes |= b, null !== d && (d.childLanes |= b)) : null !== d && (d.childLanes & b) !== b && (d.childLanes |= b);
          if (a === c) break;
          a = a.return;
        }
      }
      function ch(a, b) {
        Xg = a;
        Zg = Yg = null;
        a = a.dependencies;
        null !== a && null !== a.firstContext && (0 !== (a.lanes & b) && (dh = true), a.firstContext = null);
      }
      function eh(a) {
        var b = a._currentValue;
        if (Zg !== a) if (a = { context: a, memoizedValue: b, next: null }, null === Yg) {
          if (null === Xg) throw Error(p(308));
          Yg = a;
          Xg.dependencies = { lanes: 0, firstContext: a };
        } else Yg = Yg.next = a;
        return b;
      }
      var fh = null;
      function gh(a) {
        null === fh ? fh = [a] : fh.push(a);
      }
      function hh(a, b, c, d) {
        var e = b.interleaved;
        null === e ? (c.next = c, gh(b)) : (c.next = e.next, e.next = c);
        b.interleaved = c;
        return ih(a, d);
      }
      function ih(a, b) {
        a.lanes |= b;
        var c = a.alternate;
        null !== c && (c.lanes |= b);
        c = a;
        for (a = a.return; null !== a; ) a.childLanes |= b, c = a.alternate, null !== c && (c.childLanes |= b), c = a, a = a.return;
        return 3 === c.tag ? c.stateNode : null;
      }
      var jh = false;
      function kh(a) {
        a.updateQueue = { baseState: a.memoizedState, firstBaseUpdate: null, lastBaseUpdate: null, shared: { pending: null, interleaved: null, lanes: 0 }, effects: null };
      }
      function lh(a, b) {
        a = a.updateQueue;
        b.updateQueue === a && (b.updateQueue = { baseState: a.baseState, firstBaseUpdate: a.firstBaseUpdate, lastBaseUpdate: a.lastBaseUpdate, shared: a.shared, effects: a.effects });
      }
      function mh(a, b) {
        return { eventTime: a, lane: b, tag: 0, payload: null, callback: null, next: null };
      }
      function nh(a, b, c) {
        var d = a.updateQueue;
        if (null === d) return null;
        d = d.shared;
        if (0 !== (K & 2)) {
          var e = d.pending;
          null === e ? b.next = b : (b.next = e.next, e.next = b);
          d.pending = b;
          return ih(a, c);
        }
        e = d.interleaved;
        null === e ? (b.next = b, gh(d)) : (b.next = e.next, e.next = b);
        d.interleaved = b;
        return ih(a, c);
      }
      function oh(a, b, c) {
        b = b.updateQueue;
        if (null !== b && (b = b.shared, 0 !== (c & 4194240))) {
          var d = b.lanes;
          d &= a.pendingLanes;
          c |= d;
          b.lanes = c;
          Cc(a, c);
        }
      }
      function ph(a, b) {
        var c = a.updateQueue, d = a.alternate;
        if (null !== d && (d = d.updateQueue, c === d)) {
          var e = null, f = null;
          c = c.firstBaseUpdate;
          if (null !== c) {
            do {
              var g = { eventTime: c.eventTime, lane: c.lane, tag: c.tag, payload: c.payload, callback: c.callback, next: null };
              null === f ? e = f = g : f = f.next = g;
              c = c.next;
            } while (null !== c);
            null === f ? e = f = b : f = f.next = b;
          } else e = f = b;
          c = { baseState: d.baseState, firstBaseUpdate: e, lastBaseUpdate: f, shared: d.shared, effects: d.effects };
          a.updateQueue = c;
          return;
        }
        a = c.lastBaseUpdate;
        null === a ? c.firstBaseUpdate = b : a.next = b;
        c.lastBaseUpdate = b;
      }
      function qh(a, b, c, d) {
        var e = a.updateQueue;
        jh = false;
        var f = e.firstBaseUpdate, g = e.lastBaseUpdate, h = e.shared.pending;
        if (null !== h) {
          e.shared.pending = null;
          var k = h, l = k.next;
          k.next = null;
          null === g ? f = l : g.next = l;
          g = k;
          var m = a.alternate;
          null !== m && (m = m.updateQueue, h = m.lastBaseUpdate, h !== g && (null === h ? m.firstBaseUpdate = l : h.next = l, m.lastBaseUpdate = k));
        }
        if (null !== f) {
          var q = e.baseState;
          g = 0;
          m = l = k = null;
          h = f;
          do {
            var r = h.lane, y = h.eventTime;
            if ((d & r) === r) {
              null !== m && (m = m.next = {
                eventTime: y,
                lane: 0,
                tag: h.tag,
                payload: h.payload,
                callback: h.callback,
                next: null
              });
              a: {
                var n = a, t = h;
                r = b;
                y = c;
                switch (t.tag) {
                  case 1:
                    n = t.payload;
                    if ("function" === typeof n) {
                      q = n.call(y, q, r);
                      break a;
                    }
                    q = n;
                    break a;
                  case 3:
                    n.flags = n.flags & -65537 | 128;
                  case 0:
                    n = t.payload;
                    r = "function" === typeof n ? n.call(y, q, r) : n;
                    if (null === r || void 0 === r) break a;
                    q = A2({}, q, r);
                    break a;
                  case 2:
                    jh = true;
                }
              }
              null !== h.callback && 0 !== h.lane && (a.flags |= 64, r = e.effects, null === r ? e.effects = [h] : r.push(h));
            } else y = { eventTime: y, lane: r, tag: h.tag, payload: h.payload, callback: h.callback, next: null }, null === m ? (l = m = y, k = q) : m = m.next = y, g |= r;
            h = h.next;
            if (null === h) if (h = e.shared.pending, null === h) break;
            else r = h, h = r.next, r.next = null, e.lastBaseUpdate = r, e.shared.pending = null;
          } while (1);
          null === m && (k = q);
          e.baseState = k;
          e.firstBaseUpdate = l;
          e.lastBaseUpdate = m;
          b = e.shared.interleaved;
          if (null !== b) {
            e = b;
            do
              g |= e.lane, e = e.next;
            while (e !== b);
          } else null === f && (e.shared.lanes = 0);
          rh |= g;
          a.lanes = g;
          a.memoizedState = q;
        }
      }
      function sh(a, b, c) {
        a = b.effects;
        b.effects = null;
        if (null !== a) for (b = 0; b < a.length; b++) {
          var d = a[b], e = d.callback;
          if (null !== e) {
            d.callback = null;
            d = c;
            if ("function" !== typeof e) throw Error(p(191, e));
            e.call(d);
          }
        }
      }
      var th = {};
      var uh = Uf(th);
      var vh = Uf(th);
      var wh = Uf(th);
      function xh(a) {
        if (a === th) throw Error(p(174));
        return a;
      }
      function yh(a, b) {
        G(wh, b);
        G(vh, a);
        G(uh, th);
        a = b.nodeType;
        switch (a) {
          case 9:
          case 11:
            b = (b = b.documentElement) ? b.namespaceURI : lb(null, "");
            break;
          default:
            a = 8 === a ? b.parentNode : b, b = a.namespaceURI || null, a = a.tagName, b = lb(b, a);
        }
        E(uh);
        G(uh, b);
      }
      function zh() {
        E(uh);
        E(vh);
        E(wh);
      }
      function Ah(a) {
        xh(wh.current);
        var b = xh(uh.current);
        var c = lb(b, a.type);
        b !== c && (G(vh, a), G(uh, c));
      }
      function Bh(a) {
        vh.current === a && (E(uh), E(vh));
      }
      var L3 = Uf(0);
      function Ch(a) {
        for (var b = a; null !== b; ) {
          if (13 === b.tag) {
            var c = b.memoizedState;
            if (null !== c && (c = c.dehydrated, null === c || "$?" === c.data || "$!" === c.data)) return b;
          } else if (19 === b.tag && void 0 !== b.memoizedProps.revealOrder) {
            if (0 !== (b.flags & 128)) return b;
          } else if (null !== b.child) {
            b.child.return = b;
            b = b.child;
            continue;
          }
          if (b === a) break;
          for (; null === b.sibling; ) {
            if (null === b.return || b.return === a) return null;
            b = b.return;
          }
          b.sibling.return = b.return;
          b = b.sibling;
        }
        return null;
      }
      var Dh = [];
      function Eh() {
        for (var a = 0; a < Dh.length; a++) Dh[a]._workInProgressVersionPrimary = null;
        Dh.length = 0;
      }
      var Fh = ua.ReactCurrentDispatcher;
      var Gh = ua.ReactCurrentBatchConfig;
      var Hh = 0;
      var M = null;
      var N = null;
      var O = null;
      var Ih = false;
      var Jh = false;
      var Kh = 0;
      var Lh = 0;
      function P() {
        throw Error(p(321));
      }
      function Mh(a, b) {
        if (null === b) return false;
        for (var c = 0; c < b.length && c < a.length; c++) if (!He(a[c], b[c])) return false;
        return true;
      }
      function Nh(a, b, c, d, e, f) {
        Hh = f;
        M = b;
        b.memoizedState = null;
        b.updateQueue = null;
        b.lanes = 0;
        Fh.current = null === a || null === a.memoizedState ? Oh : Ph;
        a = c(d, e);
        if (Jh) {
          f = 0;
          do {
            Jh = false;
            Kh = 0;
            if (25 <= f) throw Error(p(301));
            f += 1;
            O = N = null;
            b.updateQueue = null;
            Fh.current = Qh;
            a = c(d, e);
          } while (Jh);
        }
        Fh.current = Rh;
        b = null !== N && null !== N.next;
        Hh = 0;
        O = N = M = null;
        Ih = false;
        if (b) throw Error(p(300));
        return a;
      }
      function Sh() {
        var a = 0 !== Kh;
        Kh = 0;
        return a;
      }
      function Th() {
        var a = { memoizedState: null, baseState: null, baseQueue: null, queue: null, next: null };
        null === O ? M.memoizedState = O = a : O = O.next = a;
        return O;
      }
      function Uh() {
        if (null === N) {
          var a = M.alternate;
          a = null !== a ? a.memoizedState : null;
        } else a = N.next;
        var b = null === O ? M.memoizedState : O.next;
        if (null !== b) O = b, N = a;
        else {
          if (null === a) throw Error(p(310));
          N = a;
          a = { memoizedState: N.memoizedState, baseState: N.baseState, baseQueue: N.baseQueue, queue: N.queue, next: null };
          null === O ? M.memoizedState = O = a : O = O.next = a;
        }
        return O;
      }
      function Vh(a, b) {
        return "function" === typeof b ? b(a) : b;
      }
      function Wh(a) {
        var b = Uh(), c = b.queue;
        if (null === c) throw Error(p(311));
        c.lastRenderedReducer = a;
        var d = N, e = d.baseQueue, f = c.pending;
        if (null !== f) {
          if (null !== e) {
            var g = e.next;
            e.next = f.next;
            f.next = g;
          }
          d.baseQueue = e = f;
          c.pending = null;
        }
        if (null !== e) {
          f = e.next;
          d = d.baseState;
          var h = g = null, k = null, l = f;
          do {
            var m = l.lane;
            if ((Hh & m) === m) null !== k && (k = k.next = { lane: 0, action: l.action, hasEagerState: l.hasEagerState, eagerState: l.eagerState, next: null }), d = l.hasEagerState ? l.eagerState : a(d, l.action);
            else {
              var q = {
                lane: m,
                action: l.action,
                hasEagerState: l.hasEagerState,
                eagerState: l.eagerState,
                next: null
              };
              null === k ? (h = k = q, g = d) : k = k.next = q;
              M.lanes |= m;
              rh |= m;
            }
            l = l.next;
          } while (null !== l && l !== f);
          null === k ? g = d : k.next = h;
          He(d, b.memoizedState) || (dh = true);
          b.memoizedState = d;
          b.baseState = g;
          b.baseQueue = k;
          c.lastRenderedState = d;
        }
        a = c.interleaved;
        if (null !== a) {
          e = a;
          do
            f = e.lane, M.lanes |= f, rh |= f, e = e.next;
          while (e !== a);
        } else null === e && (c.lanes = 0);
        return [b.memoizedState, c.dispatch];
      }
      function Xh(a) {
        var b = Uh(), c = b.queue;
        if (null === c) throw Error(p(311));
        c.lastRenderedReducer = a;
        var d = c.dispatch, e = c.pending, f = b.memoizedState;
        if (null !== e) {
          c.pending = null;
          var g = e = e.next;
          do
            f = a(f, g.action), g = g.next;
          while (g !== e);
          He(f, b.memoizedState) || (dh = true);
          b.memoizedState = f;
          null === b.baseQueue && (b.baseState = f);
          c.lastRenderedState = f;
        }
        return [f, d];
      }
      function Yh() {
      }
      function Zh(a, b) {
        var c = M, d = Uh(), e = b(), f = !He(d.memoizedState, e);
        f && (d.memoizedState = e, dh = true);
        d = d.queue;
        $h(ai.bind(null, c, d, a), [a]);
        if (d.getSnapshot !== b || f || null !== O && O.memoizedState.tag & 1) {
          c.flags |= 2048;
          bi(9, ci.bind(null, c, d, e, b), void 0, null);
          if (null === Q) throw Error(p(349));
          0 !== (Hh & 30) || di(c, b, e);
        }
        return e;
      }
      function di(a, b, c) {
        a.flags |= 16384;
        a = { getSnapshot: b, value: c };
        b = M.updateQueue;
        null === b ? (b = { lastEffect: null, stores: null }, M.updateQueue = b, b.stores = [a]) : (c = b.stores, null === c ? b.stores = [a] : c.push(a));
      }
      function ci(a, b, c, d) {
        b.value = c;
        b.getSnapshot = d;
        ei(b) && fi(a);
      }
      function ai(a, b, c) {
        return c(function() {
          ei(b) && fi(a);
        });
      }
      function ei(a) {
        var b = a.getSnapshot;
        a = a.value;
        try {
          var c = b();
          return !He(a, c);
        } catch (d) {
          return true;
        }
      }
      function fi(a) {
        var b = ih(a, 1);
        null !== b && gi(b, a, 1, -1);
      }
      function hi(a) {
        var b = Th();
        "function" === typeof a && (a = a());
        b.memoizedState = b.baseState = a;
        a = { pending: null, interleaved: null, lanes: 0, dispatch: null, lastRenderedReducer: Vh, lastRenderedState: a };
        b.queue = a;
        a = a.dispatch = ii.bind(null, M, a);
        return [b.memoizedState, a];
      }
      function bi(a, b, c, d) {
        a = { tag: a, create: b, destroy: c, deps: d, next: null };
        b = M.updateQueue;
        null === b ? (b = { lastEffect: null, stores: null }, M.updateQueue = b, b.lastEffect = a.next = a) : (c = b.lastEffect, null === c ? b.lastEffect = a.next = a : (d = c.next, c.next = a, a.next = d, b.lastEffect = a));
        return a;
      }
      function ji() {
        return Uh().memoizedState;
      }
      function ki(a, b, c, d) {
        var e = Th();
        M.flags |= a;
        e.memoizedState = bi(1 | b, c, void 0, void 0 === d ? null : d);
      }
      function li(a, b, c, d) {
        var e = Uh();
        d = void 0 === d ? null : d;
        var f = void 0;
        if (null !== N) {
          var g = N.memoizedState;
          f = g.destroy;
          if (null !== d && Mh(d, g.deps)) {
            e.memoizedState = bi(b, c, f, d);
            return;
          }
        }
        M.flags |= a;
        e.memoizedState = bi(1 | b, c, f, d);
      }
      function mi(a, b) {
        return ki(8390656, 8, a, b);
      }
      function $h(a, b) {
        return li(2048, 8, a, b);
      }
      function ni(a, b) {
        return li(4, 2, a, b);
      }
      function oi(a, b) {
        return li(4, 4, a, b);
      }
      function pi(a, b) {
        if ("function" === typeof b) return a = a(), b(a), function() {
          b(null);
        };
        if (null !== b && void 0 !== b) return a = a(), b.current = a, function() {
          b.current = null;
        };
      }
      function qi(a, b, c) {
        c = null !== c && void 0 !== c ? c.concat([a]) : null;
        return li(4, 4, pi.bind(null, b, a), c);
      }
      function ri() {
      }
      function si(a, b) {
        var c = Uh();
        b = void 0 === b ? null : b;
        var d = c.memoizedState;
        if (null !== d && null !== b && Mh(b, d[1])) return d[0];
        c.memoizedState = [a, b];
        return a;
      }
      function ti(a, b) {
        var c = Uh();
        b = void 0 === b ? null : b;
        var d = c.memoizedState;
        if (null !== d && null !== b && Mh(b, d[1])) return d[0];
        a = a();
        c.memoizedState = [a, b];
        return a;
      }
      function ui(a, b, c) {
        if (0 === (Hh & 21)) return a.baseState && (a.baseState = false, dh = true), a.memoizedState = c;
        He(c, b) || (c = yc(), M.lanes |= c, rh |= c, a.baseState = true);
        return b;
      }
      function vi(a, b) {
        var c = C2;
        C2 = 0 !== c && 4 > c ? c : 4;
        a(true);
        var d = Gh.transition;
        Gh.transition = {};
        try {
          a(false), b();
        } finally {
          C2 = c, Gh.transition = d;
        }
      }
      function wi() {
        return Uh().memoizedState;
      }
      function xi(a, b, c) {
        var d = yi(a);
        c = { lane: d, action: c, hasEagerState: false, eagerState: null, next: null };
        if (zi(a)) Ai(b, c);
        else if (c = hh(a, b, c, d), null !== c) {
          var e = R();
          gi(c, a, d, e);
          Bi(c, b, d);
        }
      }
      function ii(a, b, c) {
        var d = yi(a), e = { lane: d, action: c, hasEagerState: false, eagerState: null, next: null };
        if (zi(a)) Ai(b, e);
        else {
          var f = a.alternate;
          if (0 === a.lanes && (null === f || 0 === f.lanes) && (f = b.lastRenderedReducer, null !== f)) try {
            var g = b.lastRenderedState, h = f(g, c);
            e.hasEagerState = true;
            e.eagerState = h;
            if (He(h, g)) {
              var k = b.interleaved;
              null === k ? (e.next = e, gh(b)) : (e.next = k.next, k.next = e);
              b.interleaved = e;
              return;
            }
          } catch (l) {
          } finally {
          }
          c = hh(a, b, e, d);
          null !== c && (e = R(), gi(c, a, d, e), Bi(c, b, d));
        }
      }
      function zi(a) {
        var b = a.alternate;
        return a === M || null !== b && b === M;
      }
      function Ai(a, b) {
        Jh = Ih = true;
        var c = a.pending;
        null === c ? b.next = b : (b.next = c.next, c.next = b);
        a.pending = b;
      }
      function Bi(a, b, c) {
        if (0 !== (c & 4194240)) {
          var d = b.lanes;
          d &= a.pendingLanes;
          c |= d;
          b.lanes = c;
          Cc(a, c);
        }
      }
      var Rh = { readContext: eh, useCallback: P, useContext: P, useEffect: P, useImperativeHandle: P, useInsertionEffect: P, useLayoutEffect: P, useMemo: P, useReducer: P, useRef: P, useState: P, useDebugValue: P, useDeferredValue: P, useTransition: P, useMutableSource: P, useSyncExternalStore: P, useId: P, unstable_isNewReconciler: false };
      var Oh = { readContext: eh, useCallback: function(a, b) {
        Th().memoizedState = [a, void 0 === b ? null : b];
        return a;
      }, useContext: eh, useEffect: mi, useImperativeHandle: function(a, b, c) {
        c = null !== c && void 0 !== c ? c.concat([a]) : null;
        return ki(
          4194308,
          4,
          pi.bind(null, b, a),
          c
        );
      }, useLayoutEffect: function(a, b) {
        return ki(4194308, 4, a, b);
      }, useInsertionEffect: function(a, b) {
        return ki(4, 2, a, b);
      }, useMemo: function(a, b) {
        var c = Th();
        b = void 0 === b ? null : b;
        a = a();
        c.memoizedState = [a, b];
        return a;
      }, useReducer: function(a, b, c) {
        var d = Th();
        b = void 0 !== c ? c(b) : b;
        d.memoizedState = d.baseState = b;
        a = { pending: null, interleaved: null, lanes: 0, dispatch: null, lastRenderedReducer: a, lastRenderedState: b };
        d.queue = a;
        a = a.dispatch = xi.bind(null, M, a);
        return [d.memoizedState, a];
      }, useRef: function(a) {
        var b = Th();
        a = { current: a };
        return b.memoizedState = a;
      }, useState: hi, useDebugValue: ri, useDeferredValue: function(a) {
        return Th().memoizedState = a;
      }, useTransition: function() {
        var a = hi(false), b = a[0];
        a = vi.bind(null, a[1]);
        Th().memoizedState = a;
        return [b, a];
      }, useMutableSource: function() {
      }, useSyncExternalStore: function(a, b, c) {
        var d = M, e = Th();
        if (I) {
          if (void 0 === c) throw Error(p(407));
          c = c();
        } else {
          c = b();
          if (null === Q) throw Error(p(349));
          0 !== (Hh & 30) || di(d, b, c);
        }
        e.memoizedState = c;
        var f = { value: c, getSnapshot: b };
        e.queue = f;
        mi(ai.bind(
          null,
          d,
          f,
          a
        ), [a]);
        d.flags |= 2048;
        bi(9, ci.bind(null, d, f, c, b), void 0, null);
        return c;
      }, useId: function() {
        var a = Th(), b = Q.identifierPrefix;
        if (I) {
          var c = sg;
          var d = rg;
          c = (d & ~(1 << 32 - oc(d) - 1)).toString(32) + c;
          b = ":" + b + "R" + c;
          c = Kh++;
          0 < c && (b += "H" + c.toString(32));
          b += ":";
        } else c = Lh++, b = ":" + b + "r" + c.toString(32) + ":";
        return a.memoizedState = b;
      }, unstable_isNewReconciler: false };
      var Ph = {
        readContext: eh,
        useCallback: si,
        useContext: eh,
        useEffect: $h,
        useImperativeHandle: qi,
        useInsertionEffect: ni,
        useLayoutEffect: oi,
        useMemo: ti,
        useReducer: Wh,
        useRef: ji,
        useState: function() {
          return Wh(Vh);
        },
        useDebugValue: ri,
        useDeferredValue: function(a) {
          var b = Uh();
          return ui(b, N.memoizedState, a);
        },
        useTransition: function() {
          var a = Wh(Vh)[0], b = Uh().memoizedState;
          return [a, b];
        },
        useMutableSource: Yh,
        useSyncExternalStore: Zh,
        useId: wi,
        unstable_isNewReconciler: false
      };
      var Qh = { readContext: eh, useCallback: si, useContext: eh, useEffect: $h, useImperativeHandle: qi, useInsertionEffect: ni, useLayoutEffect: oi, useMemo: ti, useReducer: Xh, useRef: ji, useState: function() {
        return Xh(Vh);
      }, useDebugValue: ri, useDeferredValue: function(a) {
        var b = Uh();
        return null === N ? b.memoizedState = a : ui(b, N.memoizedState, a);
      }, useTransition: function() {
        var a = Xh(Vh)[0], b = Uh().memoizedState;
        return [a, b];
      }, useMutableSource: Yh, useSyncExternalStore: Zh, useId: wi, unstable_isNewReconciler: false };
      function Ci(a, b) {
        if (a && a.defaultProps) {
          b = A2({}, b);
          a = a.defaultProps;
          for (var c in a) void 0 === b[c] && (b[c] = a[c]);
          return b;
        }
        return b;
      }
      function Di(a, b, c, d) {
        b = a.memoizedState;
        c = c(d, b);
        c = null === c || void 0 === c ? b : A2({}, b, c);
        a.memoizedState = c;
        0 === a.lanes && (a.updateQueue.baseState = c);
      }
      var Ei = { isMounted: function(a) {
        return (a = a._reactInternals) ? Vb(a) === a : false;
      }, enqueueSetState: function(a, b, c) {
        a = a._reactInternals;
        var d = R(), e = yi(a), f = mh(d, e);
        f.payload = b;
        void 0 !== c && null !== c && (f.callback = c);
        b = nh(a, f, e);
        null !== b && (gi(b, a, e, d), oh(b, a, e));
      }, enqueueReplaceState: function(a, b, c) {
        a = a._reactInternals;
        var d = R(), e = yi(a), f = mh(d, e);
        f.tag = 1;
        f.payload = b;
        void 0 !== c && null !== c && (f.callback = c);
        b = nh(a, f, e);
        null !== b && (gi(b, a, e, d), oh(b, a, e));
      }, enqueueForceUpdate: function(a, b) {
        a = a._reactInternals;
        var c = R(), d = yi(a), e = mh(c, d);
        e.tag = 2;
        void 0 !== b && null !== b && (e.callback = b);
        b = nh(a, e, d);
        null !== b && (gi(b, a, d, c), oh(b, a, d));
      } };
      function Fi(a, b, c, d, e, f, g) {
        a = a.stateNode;
        return "function" === typeof a.shouldComponentUpdate ? a.shouldComponentUpdate(d, f, g) : b.prototype && b.prototype.isPureReactComponent ? !Ie(c, d) || !Ie(e, f) : true;
      }
      function Gi(a, b, c) {
        var d = false, e = Vf;
        var f = b.contextType;
        "object" === typeof f && null !== f ? f = eh(f) : (e = Zf(b) ? Xf : H.current, d = b.contextTypes, f = (d = null !== d && void 0 !== d) ? Yf(a, e) : Vf);
        b = new b(c, f);
        a.memoizedState = null !== b.state && void 0 !== b.state ? b.state : null;
        b.updater = Ei;
        a.stateNode = b;
        b._reactInternals = a;
        d && (a = a.stateNode, a.__reactInternalMemoizedUnmaskedChildContext = e, a.__reactInternalMemoizedMaskedChildContext = f);
        return b;
      }
      function Hi(a, b, c, d) {
        a = b.state;
        "function" === typeof b.componentWillReceiveProps && b.componentWillReceiveProps(c, d);
        "function" === typeof b.UNSAFE_componentWillReceiveProps && b.UNSAFE_componentWillReceiveProps(c, d);
        b.state !== a && Ei.enqueueReplaceState(b, b.state, null);
      }
      function Ii(a, b, c, d) {
        var e = a.stateNode;
        e.props = c;
        e.state = a.memoizedState;
        e.refs = {};
        kh(a);
        var f = b.contextType;
        "object" === typeof f && null !== f ? e.context = eh(f) : (f = Zf(b) ? Xf : H.current, e.context = Yf(a, f));
        e.state = a.memoizedState;
        f = b.getDerivedStateFromProps;
        "function" === typeof f && (Di(a, b, f, c), e.state = a.memoizedState);
        "function" === typeof b.getDerivedStateFromProps || "function" === typeof e.getSnapshotBeforeUpdate || "function" !== typeof e.UNSAFE_componentWillMount && "function" !== typeof e.componentWillMount || (b = e.state, "function" === typeof e.componentWillMount && e.componentWillMount(), "function" === typeof e.UNSAFE_componentWillMount && e.UNSAFE_componentWillMount(), b !== e.state && Ei.enqueueReplaceState(e, e.state, null), qh(a, c, e, d), e.state = a.memoizedState);
        "function" === typeof e.componentDidMount && (a.flags |= 4194308);
      }
      function Ji(a, b) {
        try {
          var c = "", d = b;
          do
            c += Pa(d), d = d.return;
          while (d);
          var e = c;
        } catch (f) {
          e = "\nError generating stack: " + f.message + "\n" + f.stack;
        }
        return { value: a, source: b, stack: e, digest: null };
      }
      function Ki(a, b, c) {
        return { value: a, source: null, stack: null != c ? c : null, digest: null != b ? b : null };
      }
      function Li(a, b) {
        try {
          console.error(b.value);
        } catch (c) {
          setTimeout(function() {
            throw c;
          });
        }
      }
      var Mi = "function" === typeof WeakMap ? WeakMap : Map;
      function Ni(a, b, c) {
        c = mh(-1, c);
        c.tag = 3;
        c.payload = { element: null };
        var d = b.value;
        c.callback = function() {
          Oi || (Oi = true, Pi = d);
          Li(a, b);
        };
        return c;
      }
      function Qi(a, b, c) {
        c = mh(-1, c);
        c.tag = 3;
        var d = a.type.getDerivedStateFromError;
        if ("function" === typeof d) {
          var e = b.value;
          c.payload = function() {
            return d(e);
          };
          c.callback = function() {
            Li(a, b);
          };
        }
        var f = a.stateNode;
        null !== f && "function" === typeof f.componentDidCatch && (c.callback = function() {
          Li(a, b);
          "function" !== typeof d && (null === Ri ? Ri = /* @__PURE__ */ new Set([this]) : Ri.add(this));
          var c2 = b.stack;
          this.componentDidCatch(b.value, { componentStack: null !== c2 ? c2 : "" });
        });
        return c;
      }
      function Si(a, b, c) {
        var d = a.pingCache;
        if (null === d) {
          d = a.pingCache = new Mi();
          var e = /* @__PURE__ */ new Set();
          d.set(b, e);
        } else e = d.get(b), void 0 === e && (e = /* @__PURE__ */ new Set(), d.set(b, e));
        e.has(c) || (e.add(c), a = Ti.bind(null, a, b, c), b.then(a, a));
      }
      function Ui(a) {
        do {
          var b;
          if (b = 13 === a.tag) b = a.memoizedState, b = null !== b ? null !== b.dehydrated ? true : false : true;
          if (b) return a;
          a = a.return;
        } while (null !== a);
        return null;
      }
      function Vi(a, b, c, d, e) {
        if (0 === (a.mode & 1)) return a === b ? a.flags |= 65536 : (a.flags |= 128, c.flags |= 131072, c.flags &= -52805, 1 === c.tag && (null === c.alternate ? c.tag = 17 : (b = mh(-1, 1), b.tag = 2, nh(c, b, 1))), c.lanes |= 1), a;
        a.flags |= 65536;
        a.lanes = e;
        return a;
      }
      var Wi = ua.ReactCurrentOwner;
      var dh = false;
      function Xi(a, b, c, d) {
        b.child = null === a ? Vg(b, null, c, d) : Ug(b, a.child, c, d);
      }
      function Yi(a, b, c, d, e) {
        c = c.render;
        var f = b.ref;
        ch(b, e);
        d = Nh(a, b, c, d, f, e);
        c = Sh();
        if (null !== a && !dh) return b.updateQueue = a.updateQueue, b.flags &= -2053, a.lanes &= ~e, Zi(a, b, e);
        I && c && vg(b);
        b.flags |= 1;
        Xi(a, b, d, e);
        return b.child;
      }
      function $i(a, b, c, d, e) {
        if (null === a) {
          var f = c.type;
          if ("function" === typeof f && !aj(f) && void 0 === f.defaultProps && null === c.compare && void 0 === c.defaultProps) return b.tag = 15, b.type = f, bj(a, b, f, d, e);
          a = Rg(c.type, null, d, b, b.mode, e);
          a.ref = b.ref;
          a.return = b;
          return b.child = a;
        }
        f = a.child;
        if (0 === (a.lanes & e)) {
          var g = f.memoizedProps;
          c = c.compare;
          c = null !== c ? c : Ie;
          if (c(g, d) && a.ref === b.ref) return Zi(a, b, e);
        }
        b.flags |= 1;
        a = Pg(f, d);
        a.ref = b.ref;
        a.return = b;
        return b.child = a;
      }
      function bj(a, b, c, d, e) {
        if (null !== a) {
          var f = a.memoizedProps;
          if (Ie(f, d) && a.ref === b.ref) if (dh = false, b.pendingProps = d = f, 0 !== (a.lanes & e)) 0 !== (a.flags & 131072) && (dh = true);
          else return b.lanes = a.lanes, Zi(a, b, e);
        }
        return cj(a, b, c, d, e);
      }
      function dj(a, b, c) {
        var d = b.pendingProps, e = d.children, f = null !== a ? a.memoizedState : null;
        if ("hidden" === d.mode) if (0 === (b.mode & 1)) b.memoizedState = { baseLanes: 0, cachePool: null, transitions: null }, G(ej, fj), fj |= c;
        else {
          if (0 === (c & 1073741824)) return a = null !== f ? f.baseLanes | c : c, b.lanes = b.childLanes = 1073741824, b.memoizedState = { baseLanes: a, cachePool: null, transitions: null }, b.updateQueue = null, G(ej, fj), fj |= a, null;
          b.memoizedState = { baseLanes: 0, cachePool: null, transitions: null };
          d = null !== f ? f.baseLanes : c;
          G(ej, fj);
          fj |= d;
        }
        else null !== f ? (d = f.baseLanes | c, b.memoizedState = null) : d = c, G(ej, fj), fj |= d;
        Xi(a, b, e, c);
        return b.child;
      }
      function gj(a, b) {
        var c = b.ref;
        if (null === a && null !== c || null !== a && a.ref !== c) b.flags |= 512, b.flags |= 2097152;
      }
      function cj(a, b, c, d, e) {
        var f = Zf(c) ? Xf : H.current;
        f = Yf(b, f);
        ch(b, e);
        c = Nh(a, b, c, d, f, e);
        d = Sh();
        if (null !== a && !dh) return b.updateQueue = a.updateQueue, b.flags &= -2053, a.lanes &= ~e, Zi(a, b, e);
        I && d && vg(b);
        b.flags |= 1;
        Xi(a, b, c, e);
        return b.child;
      }
      function hj(a, b, c, d, e) {
        if (Zf(c)) {
          var f = true;
          cg(b);
        } else f = false;
        ch(b, e);
        if (null === b.stateNode) ij(a, b), Gi(b, c, d), Ii(b, c, d, e), d = true;
        else if (null === a) {
          var g = b.stateNode, h = b.memoizedProps;
          g.props = h;
          var k = g.context, l = c.contextType;
          "object" === typeof l && null !== l ? l = eh(l) : (l = Zf(c) ? Xf : H.current, l = Yf(b, l));
          var m = c.getDerivedStateFromProps, q = "function" === typeof m || "function" === typeof g.getSnapshotBeforeUpdate;
          q || "function" !== typeof g.UNSAFE_componentWillReceiveProps && "function" !== typeof g.componentWillReceiveProps || (h !== d || k !== l) && Hi(b, g, d, l);
          jh = false;
          var r = b.memoizedState;
          g.state = r;
          qh(b, d, g, e);
          k = b.memoizedState;
          h !== d || r !== k || Wf.current || jh ? ("function" === typeof m && (Di(b, c, m, d), k = b.memoizedState), (h = jh || Fi(b, c, h, d, r, k, l)) ? (q || "function" !== typeof g.UNSAFE_componentWillMount && "function" !== typeof g.componentWillMount || ("function" === typeof g.componentWillMount && g.componentWillMount(), "function" === typeof g.UNSAFE_componentWillMount && g.UNSAFE_componentWillMount()), "function" === typeof g.componentDidMount && (b.flags |= 4194308)) : ("function" === typeof g.componentDidMount && (b.flags |= 4194308), b.memoizedProps = d, b.memoizedState = k), g.props = d, g.state = k, g.context = l, d = h) : ("function" === typeof g.componentDidMount && (b.flags |= 4194308), d = false);
        } else {
          g = b.stateNode;
          lh(a, b);
          h = b.memoizedProps;
          l = b.type === b.elementType ? h : Ci(b.type, h);
          g.props = l;
          q = b.pendingProps;
          r = g.context;
          k = c.contextType;
          "object" === typeof k && null !== k ? k = eh(k) : (k = Zf(c) ? Xf : H.current, k = Yf(b, k));
          var y = c.getDerivedStateFromProps;
          (m = "function" === typeof y || "function" === typeof g.getSnapshotBeforeUpdate) || "function" !== typeof g.UNSAFE_componentWillReceiveProps && "function" !== typeof g.componentWillReceiveProps || (h !== q || r !== k) && Hi(b, g, d, k);
          jh = false;
          r = b.memoizedState;
          g.state = r;
          qh(b, d, g, e);
          var n = b.memoizedState;
          h !== q || r !== n || Wf.current || jh ? ("function" === typeof y && (Di(b, c, y, d), n = b.memoizedState), (l = jh || Fi(b, c, l, d, r, n, k) || false) ? (m || "function" !== typeof g.UNSAFE_componentWillUpdate && "function" !== typeof g.componentWillUpdate || ("function" === typeof g.componentWillUpdate && g.componentWillUpdate(d, n, k), "function" === typeof g.UNSAFE_componentWillUpdate && g.UNSAFE_componentWillUpdate(d, n, k)), "function" === typeof g.componentDidUpdate && (b.flags |= 4), "function" === typeof g.getSnapshotBeforeUpdate && (b.flags |= 1024)) : ("function" !== typeof g.componentDidUpdate || h === a.memoizedProps && r === a.memoizedState || (b.flags |= 4), "function" !== typeof g.getSnapshotBeforeUpdate || h === a.memoizedProps && r === a.memoizedState || (b.flags |= 1024), b.memoizedProps = d, b.memoizedState = n), g.props = d, g.state = n, g.context = k, d = l) : ("function" !== typeof g.componentDidUpdate || h === a.memoizedProps && r === a.memoizedState || (b.flags |= 4), "function" !== typeof g.getSnapshotBeforeUpdate || h === a.memoizedProps && r === a.memoizedState || (b.flags |= 1024), d = false);
        }
        return jj(a, b, c, d, f, e);
      }
      function jj(a, b, c, d, e, f) {
        gj(a, b);
        var g = 0 !== (b.flags & 128);
        if (!d && !g) return e && dg(b, c, false), Zi(a, b, f);
        d = b.stateNode;
        Wi.current = b;
        var h = g && "function" !== typeof c.getDerivedStateFromError ? null : d.render();
        b.flags |= 1;
        null !== a && g ? (b.child = Ug(b, a.child, null, f), b.child = Ug(b, null, h, f)) : Xi(a, b, h, f);
        b.memoizedState = d.state;
        e && dg(b, c, true);
        return b.child;
      }
      function kj(a) {
        var b = a.stateNode;
        b.pendingContext ? ag(a, b.pendingContext, b.pendingContext !== b.context) : b.context && ag(a, b.context, false);
        yh(a, b.containerInfo);
      }
      function lj(a, b, c, d, e) {
        Ig();
        Jg(e);
        b.flags |= 256;
        Xi(a, b, c, d);
        return b.child;
      }
      var mj = { dehydrated: null, treeContext: null, retryLane: 0 };
      function nj(a) {
        return { baseLanes: a, cachePool: null, transitions: null };
      }
      function oj(a, b, c) {
        var d = b.pendingProps, e = L3.current, f = false, g = 0 !== (b.flags & 128), h;
        (h = g) || (h = null !== a && null === a.memoizedState ? false : 0 !== (e & 2));
        if (h) f = true, b.flags &= -129;
        else if (null === a || null !== a.memoizedState) e |= 1;
        G(L3, e & 1);
        if (null === a) {
          Eg(b);
          a = b.memoizedState;
          if (null !== a && (a = a.dehydrated, null !== a)) return 0 === (b.mode & 1) ? b.lanes = 1 : "$!" === a.data ? b.lanes = 8 : b.lanes = 1073741824, null;
          g = d.children;
          a = d.fallback;
          return f ? (d = b.mode, f = b.child, g = { mode: "hidden", children: g }, 0 === (d & 1) && null !== f ? (f.childLanes = 0, f.pendingProps = g) : f = pj(g, d, 0, null), a = Tg(a, d, c, null), f.return = b, a.return = b, f.sibling = a, b.child = f, b.child.memoizedState = nj(c), b.memoizedState = mj, a) : qj(b, g);
        }
        e = a.memoizedState;
        if (null !== e && (h = e.dehydrated, null !== h)) return rj(a, b, g, d, h, e, c);
        if (f) {
          f = d.fallback;
          g = b.mode;
          e = a.child;
          h = e.sibling;
          var k = { mode: "hidden", children: d.children };
          0 === (g & 1) && b.child !== e ? (d = b.child, d.childLanes = 0, d.pendingProps = k, b.deletions = null) : (d = Pg(e, k), d.subtreeFlags = e.subtreeFlags & 14680064);
          null !== h ? f = Pg(h, f) : (f = Tg(f, g, c, null), f.flags |= 2);
          f.return = b;
          d.return = b;
          d.sibling = f;
          b.child = d;
          d = f;
          f = b.child;
          g = a.child.memoizedState;
          g = null === g ? nj(c) : { baseLanes: g.baseLanes | c, cachePool: null, transitions: g.transitions };
          f.memoizedState = g;
          f.childLanes = a.childLanes & ~c;
          b.memoizedState = mj;
          return d;
        }
        f = a.child;
        a = f.sibling;
        d = Pg(f, { mode: "visible", children: d.children });
        0 === (b.mode & 1) && (d.lanes = c);
        d.return = b;
        d.sibling = null;
        null !== a && (c = b.deletions, null === c ? (b.deletions = [a], b.flags |= 16) : c.push(a));
        b.child = d;
        b.memoizedState = null;
        return d;
      }
      function qj(a, b) {
        b = pj({ mode: "visible", children: b }, a.mode, 0, null);
        b.return = a;
        return a.child = b;
      }
      function sj(a, b, c, d) {
        null !== d && Jg(d);
        Ug(b, a.child, null, c);
        a = qj(b, b.pendingProps.children);
        a.flags |= 2;
        b.memoizedState = null;
        return a;
      }
      function rj(a, b, c, d, e, f, g) {
        if (c) {
          if (b.flags & 256) return b.flags &= -257, d = Ki(Error(p(422))), sj(a, b, g, d);
          if (null !== b.memoizedState) return b.child = a.child, b.flags |= 128, null;
          f = d.fallback;
          e = b.mode;
          d = pj({ mode: "visible", children: d.children }, e, 0, null);
          f = Tg(f, e, g, null);
          f.flags |= 2;
          d.return = b;
          f.return = b;
          d.sibling = f;
          b.child = d;
          0 !== (b.mode & 1) && Ug(b, a.child, null, g);
          b.child.memoizedState = nj(g);
          b.memoizedState = mj;
          return f;
        }
        if (0 === (b.mode & 1)) return sj(a, b, g, null);
        if ("$!" === e.data) {
          d = e.nextSibling && e.nextSibling.dataset;
          if (d) var h = d.dgst;
          d = h;
          f = Error(p(419));
          d = Ki(f, d, void 0);
          return sj(a, b, g, d);
        }
        h = 0 !== (g & a.childLanes);
        if (dh || h) {
          d = Q;
          if (null !== d) {
            switch (g & -g) {
              case 4:
                e = 2;
                break;
              case 16:
                e = 8;
                break;
              case 64:
              case 128:
              case 256:
              case 512:
              case 1024:
              case 2048:
              case 4096:
              case 8192:
              case 16384:
              case 32768:
              case 65536:
              case 131072:
              case 262144:
              case 524288:
              case 1048576:
              case 2097152:
              case 4194304:
              case 8388608:
              case 16777216:
              case 33554432:
              case 67108864:
                e = 32;
                break;
              case 536870912:
                e = 268435456;
                break;
              default:
                e = 0;
            }
            e = 0 !== (e & (d.suspendedLanes | g)) ? 0 : e;
            0 !== e && e !== f.retryLane && (f.retryLane = e, ih(a, e), gi(d, a, e, -1));
          }
          tj();
          d = Ki(Error(p(421)));
          return sj(a, b, g, d);
        }
        if ("$?" === e.data) return b.flags |= 128, b.child = a.child, b = uj.bind(null, a), e._reactRetry = b, null;
        a = f.treeContext;
        yg = Lf(e.nextSibling);
        xg = b;
        I = true;
        zg = null;
        null !== a && (og[pg++] = rg, og[pg++] = sg, og[pg++] = qg, rg = a.id, sg = a.overflow, qg = b);
        b = qj(b, d.children);
        b.flags |= 4096;
        return b;
      }
      function vj(a, b, c) {
        a.lanes |= b;
        var d = a.alternate;
        null !== d && (d.lanes |= b);
        bh(a.return, b, c);
      }
      function wj(a, b, c, d, e) {
        var f = a.memoizedState;
        null === f ? a.memoizedState = { isBackwards: b, rendering: null, renderingStartTime: 0, last: d, tail: c, tailMode: e } : (f.isBackwards = b, f.rendering = null, f.renderingStartTime = 0, f.last = d, f.tail = c, f.tailMode = e);
      }
      function xj(a, b, c) {
        var d = b.pendingProps, e = d.revealOrder, f = d.tail;
        Xi(a, b, d.children, c);
        d = L3.current;
        if (0 !== (d & 2)) d = d & 1 | 2, b.flags |= 128;
        else {
          if (null !== a && 0 !== (a.flags & 128)) a: for (a = b.child; null !== a; ) {
            if (13 === a.tag) null !== a.memoizedState && vj(a, c, b);
            else if (19 === a.tag) vj(a, c, b);
            else if (null !== a.child) {
              a.child.return = a;
              a = a.child;
              continue;
            }
            if (a === b) break a;
            for (; null === a.sibling; ) {
              if (null === a.return || a.return === b) break a;
              a = a.return;
            }
            a.sibling.return = a.return;
            a = a.sibling;
          }
          d &= 1;
        }
        G(L3, d);
        if (0 === (b.mode & 1)) b.memoizedState = null;
        else switch (e) {
          case "forwards":
            c = b.child;
            for (e = null; null !== c; ) a = c.alternate, null !== a && null === Ch(a) && (e = c), c = c.sibling;
            c = e;
            null === c ? (e = b.child, b.child = null) : (e = c.sibling, c.sibling = null);
            wj(b, false, e, c, f);
            break;
          case "backwards":
            c = null;
            e = b.child;
            for (b.child = null; null !== e; ) {
              a = e.alternate;
              if (null !== a && null === Ch(a)) {
                b.child = e;
                break;
              }
              a = e.sibling;
              e.sibling = c;
              c = e;
              e = a;
            }
            wj(b, true, c, null, f);
            break;
          case "together":
            wj(b, false, null, null, void 0);
            break;
          default:
            b.memoizedState = null;
        }
        return b.child;
      }
      function ij(a, b) {
        0 === (b.mode & 1) && null !== a && (a.alternate = null, b.alternate = null, b.flags |= 2);
      }
      function Zi(a, b, c) {
        null !== a && (b.dependencies = a.dependencies);
        rh |= b.lanes;
        if (0 === (c & b.childLanes)) return null;
        if (null !== a && b.child !== a.child) throw Error(p(153));
        if (null !== b.child) {
          a = b.child;
          c = Pg(a, a.pendingProps);
          b.child = c;
          for (c.return = b; null !== a.sibling; ) a = a.sibling, c = c.sibling = Pg(a, a.pendingProps), c.return = b;
          c.sibling = null;
        }
        return b.child;
      }
      function yj(a, b, c) {
        switch (b.tag) {
          case 3:
            kj(b);
            Ig();
            break;
          case 5:
            Ah(b);
            break;
          case 1:
            Zf(b.type) && cg(b);
            break;
          case 4:
            yh(b, b.stateNode.containerInfo);
            break;
          case 10:
            var d = b.type._context, e = b.memoizedProps.value;
            G(Wg, d._currentValue);
            d._currentValue = e;
            break;
          case 13:
            d = b.memoizedState;
            if (null !== d) {
              if (null !== d.dehydrated) return G(L3, L3.current & 1), b.flags |= 128, null;
              if (0 !== (c & b.child.childLanes)) return oj(a, b, c);
              G(L3, L3.current & 1);
              a = Zi(a, b, c);
              return null !== a ? a.sibling : null;
            }
            G(L3, L3.current & 1);
            break;
          case 19:
            d = 0 !== (c & b.childLanes);
            if (0 !== (a.flags & 128)) {
              if (d) return xj(a, b, c);
              b.flags |= 128;
            }
            e = b.memoizedState;
            null !== e && (e.rendering = null, e.tail = null, e.lastEffect = null);
            G(L3, L3.current);
            if (d) break;
            else return null;
          case 22:
          case 23:
            return b.lanes = 0, dj(a, b, c);
        }
        return Zi(a, b, c);
      }
      var zj;
      var Aj;
      var Bj;
      var Cj;
      zj = function(a, b) {
        for (var c = b.child; null !== c; ) {
          if (5 === c.tag || 6 === c.tag) a.appendChild(c.stateNode);
          else if (4 !== c.tag && null !== c.child) {
            c.child.return = c;
            c = c.child;
            continue;
          }
          if (c === b) break;
          for (; null === c.sibling; ) {
            if (null === c.return || c.return === b) return;
            c = c.return;
          }
          c.sibling.return = c.return;
          c = c.sibling;
        }
      };
      Aj = function() {
      };
      Bj = function(a, b, c, d) {
        var e = a.memoizedProps;
        if (e !== d) {
          a = b.stateNode;
          xh(uh.current);
          var f = null;
          switch (c) {
            case "input":
              e = Ya(a, e);
              d = Ya(a, d);
              f = [];
              break;
            case "select":
              e = A2({}, e, { value: void 0 });
              d = A2({}, d, { value: void 0 });
              f = [];
              break;
            case "textarea":
              e = gb(a, e);
              d = gb(a, d);
              f = [];
              break;
            default:
              "function" !== typeof e.onClick && "function" === typeof d.onClick && (a.onclick = Bf);
          }
          ub(c, d);
          var g;
          c = null;
          for (l in e) if (!d.hasOwnProperty(l) && e.hasOwnProperty(l) && null != e[l]) if ("style" === l) {
            var h = e[l];
            for (g in h) h.hasOwnProperty(g) && (c || (c = {}), c[g] = "");
          } else "dangerouslySetInnerHTML" !== l && "children" !== l && "suppressContentEditableWarning" !== l && "suppressHydrationWarning" !== l && "autoFocus" !== l && (ea.hasOwnProperty(l) ? f || (f = []) : (f = f || []).push(l, null));
          for (l in d) {
            var k = d[l];
            h = null != e ? e[l] : void 0;
            if (d.hasOwnProperty(l) && k !== h && (null != k || null != h)) if ("style" === l) if (h) {
              for (g in h) !h.hasOwnProperty(g) || k && k.hasOwnProperty(g) || (c || (c = {}), c[g] = "");
              for (g in k) k.hasOwnProperty(g) && h[g] !== k[g] && (c || (c = {}), c[g] = k[g]);
            } else c || (f || (f = []), f.push(
              l,
              c
            )), c = k;
            else "dangerouslySetInnerHTML" === l ? (k = k ? k.__html : void 0, h = h ? h.__html : void 0, null != k && h !== k && (f = f || []).push(l, k)) : "children" === l ? "string" !== typeof k && "number" !== typeof k || (f = f || []).push(l, "" + k) : "suppressContentEditableWarning" !== l && "suppressHydrationWarning" !== l && (ea.hasOwnProperty(l) ? (null != k && "onScroll" === l && D2("scroll", a), f || h === k || (f = [])) : (f = f || []).push(l, k));
          }
          c && (f = f || []).push("style", c);
          var l = f;
          if (b.updateQueue = l) b.flags |= 4;
        }
      };
      Cj = function(a, b, c, d) {
        c !== d && (b.flags |= 4);
      };
      function Dj(a, b) {
        if (!I) switch (a.tailMode) {
          case "hidden":
            b = a.tail;
            for (var c = null; null !== b; ) null !== b.alternate && (c = b), b = b.sibling;
            null === c ? a.tail = null : c.sibling = null;
            break;
          case "collapsed":
            c = a.tail;
            for (var d = null; null !== c; ) null !== c.alternate && (d = c), c = c.sibling;
            null === d ? b || null === a.tail ? a.tail = null : a.tail.sibling = null : d.sibling = null;
        }
      }
      function S2(a) {
        var b = null !== a.alternate && a.alternate.child === a.child, c = 0, d = 0;
        if (b) for (var e = a.child; null !== e; ) c |= e.lanes | e.childLanes, d |= e.subtreeFlags & 14680064, d |= e.flags & 14680064, e.return = a, e = e.sibling;
        else for (e = a.child; null !== e; ) c |= e.lanes | e.childLanes, d |= e.subtreeFlags, d |= e.flags, e.return = a, e = e.sibling;
        a.subtreeFlags |= d;
        a.childLanes = c;
        return b;
      }
      function Ej(a, b, c) {
        var d = b.pendingProps;
        wg(b);
        switch (b.tag) {
          case 2:
          case 16:
          case 15:
          case 0:
          case 11:
          case 7:
          case 8:
          case 12:
          case 9:
          case 14:
            return S2(b), null;
          case 1:
            return Zf(b.type) && $f(), S2(b), null;
          case 3:
            d = b.stateNode;
            zh();
            E(Wf);
            E(H);
            Eh();
            d.pendingContext && (d.context = d.pendingContext, d.pendingContext = null);
            if (null === a || null === a.child) Gg(b) ? b.flags |= 4 : null === a || a.memoizedState.isDehydrated && 0 === (b.flags & 256) || (b.flags |= 1024, null !== zg && (Fj(zg), zg = null));
            Aj(a, b);
            S2(b);
            return null;
          case 5:
            Bh(b);
            var e = xh(wh.current);
            c = b.type;
            if (null !== a && null != b.stateNode) Bj(a, b, c, d, e), a.ref !== b.ref && (b.flags |= 512, b.flags |= 2097152);
            else {
              if (!d) {
                if (null === b.stateNode) throw Error(p(166));
                S2(b);
                return null;
              }
              a = xh(uh.current);
              if (Gg(b)) {
                d = b.stateNode;
                c = b.type;
                var f = b.memoizedProps;
                d[Of] = b;
                d[Pf] = f;
                a = 0 !== (b.mode & 1);
                switch (c) {
                  case "dialog":
                    D2("cancel", d);
                    D2("close", d);
                    break;
                  case "iframe":
                  case "object":
                  case "embed":
                    D2("load", d);
                    break;
                  case "video":
                  case "audio":
                    for (e = 0; e < lf.length; e++) D2(lf[e], d);
                    break;
                  case "source":
                    D2("error", d);
                    break;
                  case "img":
                  case "image":
                  case "link":
                    D2(
                      "error",
                      d
                    );
                    D2("load", d);
                    break;
                  case "details":
                    D2("toggle", d);
                    break;
                  case "input":
                    Za(d, f);
                    D2("invalid", d);
                    break;
                  case "select":
                    d._wrapperState = { wasMultiple: !!f.multiple };
                    D2("invalid", d);
                    break;
                  case "textarea":
                    hb(d, f), D2("invalid", d);
                }
                ub(c, f);
                e = null;
                for (var g in f) if (f.hasOwnProperty(g)) {
                  var h = f[g];
                  "children" === g ? "string" === typeof h ? d.textContent !== h && (true !== f.suppressHydrationWarning && Af(d.textContent, h, a), e = ["children", h]) : "number" === typeof h && d.textContent !== "" + h && (true !== f.suppressHydrationWarning && Af(
                    d.textContent,
                    h,
                    a
                  ), e = ["children", "" + h]) : ea.hasOwnProperty(g) && null != h && "onScroll" === g && D2("scroll", d);
                }
                switch (c) {
                  case "input":
                    Va(d);
                    db(d, f, true);
                    break;
                  case "textarea":
                    Va(d);
                    jb(d);
                    break;
                  case "select":
                  case "option":
                    break;
                  default:
                    "function" === typeof f.onClick && (d.onclick = Bf);
                }
                d = e;
                b.updateQueue = d;
                null !== d && (b.flags |= 4);
              } else {
                g = 9 === e.nodeType ? e : e.ownerDocument;
                "http://www.w3.org/1999/xhtml" === a && (a = kb(c));
                "http://www.w3.org/1999/xhtml" === a ? "script" === c ? (a = g.createElement("div"), a.innerHTML = "<script><\/script>", a = a.removeChild(a.firstChild)) : "string" === typeof d.is ? a = g.createElement(c, { is: d.is }) : (a = g.createElement(c), "select" === c && (g = a, d.multiple ? g.multiple = true : d.size && (g.size = d.size))) : a = g.createElementNS(a, c);
                a[Of] = b;
                a[Pf] = d;
                zj(a, b, false, false);
                b.stateNode = a;
                a: {
                  g = vb(c, d);
                  switch (c) {
                    case "dialog":
                      D2("cancel", a);
                      D2("close", a);
                      e = d;
                      break;
                    case "iframe":
                    case "object":
                    case "embed":
                      D2("load", a);
                      e = d;
                      break;
                    case "video":
                    case "audio":
                      for (e = 0; e < lf.length; e++) D2(lf[e], a);
                      e = d;
                      break;
                    case "source":
                      D2("error", a);
                      e = d;
                      break;
                    case "img":
                    case "image":
                    case "link":
                      D2(
                        "error",
                        a
                      );
                      D2("load", a);
                      e = d;
                      break;
                    case "details":
                      D2("toggle", a);
                      e = d;
                      break;
                    case "input":
                      Za(a, d);
                      e = Ya(a, d);
                      D2("invalid", a);
                      break;
                    case "option":
                      e = d;
                      break;
                    case "select":
                      a._wrapperState = { wasMultiple: !!d.multiple };
                      e = A2({}, d, { value: void 0 });
                      D2("invalid", a);
                      break;
                    case "textarea":
                      hb(a, d);
                      e = gb(a, d);
                      D2("invalid", a);
                      break;
                    default:
                      e = d;
                  }
                  ub(c, e);
                  h = e;
                  for (f in h) if (h.hasOwnProperty(f)) {
                    var k = h[f];
                    "style" === f ? sb(a, k) : "dangerouslySetInnerHTML" === f ? (k = k ? k.__html : void 0, null != k && nb(a, k)) : "children" === f ? "string" === typeof k ? ("textarea" !== c || "" !== k) && ob(a, k) : "number" === typeof k && ob(a, "" + k) : "suppressContentEditableWarning" !== f && "suppressHydrationWarning" !== f && "autoFocus" !== f && (ea.hasOwnProperty(f) ? null != k && "onScroll" === f && D2("scroll", a) : null != k && ta(a, f, k, g));
                  }
                  switch (c) {
                    case "input":
                      Va(a);
                      db(a, d, false);
                      break;
                    case "textarea":
                      Va(a);
                      jb(a);
                      break;
                    case "option":
                      null != d.value && a.setAttribute("value", "" + Sa(d.value));
                      break;
                    case "select":
                      a.multiple = !!d.multiple;
                      f = d.value;
                      null != f ? fb(a, !!d.multiple, f, false) : null != d.defaultValue && fb(
                        a,
                        !!d.multiple,
                        d.defaultValue,
                        true
                      );
                      break;
                    default:
                      "function" === typeof e.onClick && (a.onclick = Bf);
                  }
                  switch (c) {
                    case "button":
                    case "input":
                    case "select":
                    case "textarea":
                      d = !!d.autoFocus;
                      break a;
                    case "img":
                      d = true;
                      break a;
                    default:
                      d = false;
                  }
                }
                d && (b.flags |= 4);
              }
              null !== b.ref && (b.flags |= 512, b.flags |= 2097152);
            }
            S2(b);
            return null;
          case 6:
            if (a && null != b.stateNode) Cj(a, b, a.memoizedProps, d);
            else {
              if ("string" !== typeof d && null === b.stateNode) throw Error(p(166));
              c = xh(wh.current);
              xh(uh.current);
              if (Gg(b)) {
                d = b.stateNode;
                c = b.memoizedProps;
                d[Of] = b;
                if (f = d.nodeValue !== c) {
                  if (a = xg, null !== a) switch (a.tag) {
                    case 3:
                      Af(d.nodeValue, c, 0 !== (a.mode & 1));
                      break;
                    case 5:
                      true !== a.memoizedProps.suppressHydrationWarning && Af(d.nodeValue, c, 0 !== (a.mode & 1));
                  }
                }
                f && (b.flags |= 4);
              } else d = (9 === c.nodeType ? c : c.ownerDocument).createTextNode(d), d[Of] = b, b.stateNode = d;
            }
            S2(b);
            return null;
          case 13:
            E(L3);
            d = b.memoizedState;
            if (null === a || null !== a.memoizedState && null !== a.memoizedState.dehydrated) {
              if (I && null !== yg && 0 !== (b.mode & 1) && 0 === (b.flags & 128)) Hg(), Ig(), b.flags |= 98560, f = false;
              else if (f = Gg(b), null !== d && null !== d.dehydrated) {
                if (null === a) {
                  if (!f) throw Error(p(318));
                  f = b.memoizedState;
                  f = null !== f ? f.dehydrated : null;
                  if (!f) throw Error(p(317));
                  f[Of] = b;
                } else Ig(), 0 === (b.flags & 128) && (b.memoizedState = null), b.flags |= 4;
                S2(b);
                f = false;
              } else null !== zg && (Fj(zg), zg = null), f = true;
              if (!f) return b.flags & 65536 ? b : null;
            }
            if (0 !== (b.flags & 128)) return b.lanes = c, b;
            d = null !== d;
            d !== (null !== a && null !== a.memoizedState) && d && (b.child.flags |= 8192, 0 !== (b.mode & 1) && (null === a || 0 !== (L3.current & 1) ? 0 === T2 && (T2 = 3) : tj()));
            null !== b.updateQueue && (b.flags |= 4);
            S2(b);
            return null;
          case 4:
            return zh(), Aj(a, b), null === a && sf(b.stateNode.containerInfo), S2(b), null;
          case 10:
            return ah(b.type._context), S2(b), null;
          case 17:
            return Zf(b.type) && $f(), S2(b), null;
          case 19:
            E(L3);
            f = b.memoizedState;
            if (null === f) return S2(b), null;
            d = 0 !== (b.flags & 128);
            g = f.rendering;
            if (null === g) if (d) Dj(f, false);
            else {
              if (0 !== T2 || null !== a && 0 !== (a.flags & 128)) for (a = b.child; null !== a; ) {
                g = Ch(a);
                if (null !== g) {
                  b.flags |= 128;
                  Dj(f, false);
                  d = g.updateQueue;
                  null !== d && (b.updateQueue = d, b.flags |= 4);
                  b.subtreeFlags = 0;
                  d = c;
                  for (c = b.child; null !== c; ) f = c, a = d, f.flags &= 14680066, g = f.alternate, null === g ? (f.childLanes = 0, f.lanes = a, f.child = null, f.subtreeFlags = 0, f.memoizedProps = null, f.memoizedState = null, f.updateQueue = null, f.dependencies = null, f.stateNode = null) : (f.childLanes = g.childLanes, f.lanes = g.lanes, f.child = g.child, f.subtreeFlags = 0, f.deletions = null, f.memoizedProps = g.memoizedProps, f.memoizedState = g.memoizedState, f.updateQueue = g.updateQueue, f.type = g.type, a = g.dependencies, f.dependencies = null === a ? null : { lanes: a.lanes, firstContext: a.firstContext }), c = c.sibling;
                  G(L3, L3.current & 1 | 2);
                  return b.child;
                }
                a = a.sibling;
              }
              null !== f.tail && B() > Gj && (b.flags |= 128, d = true, Dj(f, false), b.lanes = 4194304);
            }
            else {
              if (!d) if (a = Ch(g), null !== a) {
                if (b.flags |= 128, d = true, c = a.updateQueue, null !== c && (b.updateQueue = c, b.flags |= 4), Dj(f, true), null === f.tail && "hidden" === f.tailMode && !g.alternate && !I) return S2(b), null;
              } else 2 * B() - f.renderingStartTime > Gj && 1073741824 !== c && (b.flags |= 128, d = true, Dj(f, false), b.lanes = 4194304);
              f.isBackwards ? (g.sibling = b.child, b.child = g) : (c = f.last, null !== c ? c.sibling = g : b.child = g, f.last = g);
            }
            if (null !== f.tail) return b = f.tail, f.rendering = b, f.tail = b.sibling, f.renderingStartTime = B(), b.sibling = null, c = L3.current, G(L3, d ? c & 1 | 2 : c & 1), b;
            S2(b);
            return null;
          case 22:
          case 23:
            return Hj(), d = null !== b.memoizedState, null !== a && null !== a.memoizedState !== d && (b.flags |= 8192), d && 0 !== (b.mode & 1) ? 0 !== (fj & 1073741824) && (S2(b), b.subtreeFlags & 6 && (b.flags |= 8192)) : S2(b), null;
          case 24:
            return null;
          case 25:
            return null;
        }
        throw Error(p(156, b.tag));
      }
      function Ij(a, b) {
        wg(b);
        switch (b.tag) {
          case 1:
            return Zf(b.type) && $f(), a = b.flags, a & 65536 ? (b.flags = a & -65537 | 128, b) : null;
          case 3:
            return zh(), E(Wf), E(H), Eh(), a = b.flags, 0 !== (a & 65536) && 0 === (a & 128) ? (b.flags = a & -65537 | 128, b) : null;
          case 5:
            return Bh(b), null;
          case 13:
            E(L3);
            a = b.memoizedState;
            if (null !== a && null !== a.dehydrated) {
              if (null === b.alternate) throw Error(p(340));
              Ig();
            }
            a = b.flags;
            return a & 65536 ? (b.flags = a & -65537 | 128, b) : null;
          case 19:
            return E(L3), null;
          case 4:
            return zh(), null;
          case 10:
            return ah(b.type._context), null;
          case 22:
          case 23:
            return Hj(), null;
          case 24:
            return null;
          default:
            return null;
        }
      }
      var Jj = false;
      var U = false;
      var Kj = "function" === typeof WeakSet ? WeakSet : Set;
      var V = null;
      function Lj(a, b) {
        var c = a.ref;
        if (null !== c) if ("function" === typeof c) try {
          c(null);
        } catch (d) {
          W2(a, b, d);
        }
        else c.current = null;
      }
      function Mj(a, b, c) {
        try {
          c();
        } catch (d) {
          W2(a, b, d);
        }
      }
      var Nj = false;
      function Oj(a, b) {
        Cf = dd;
        a = Me();
        if (Ne(a)) {
          if ("selectionStart" in a) var c = { start: a.selectionStart, end: a.selectionEnd };
          else a: {
            c = (c = a.ownerDocument) && c.defaultView || window;
            var d = c.getSelection && c.getSelection();
            if (d && 0 !== d.rangeCount) {
              c = d.anchorNode;
              var e = d.anchorOffset, f = d.focusNode;
              d = d.focusOffset;
              try {
                c.nodeType, f.nodeType;
              } catch (F) {
                c = null;
                break a;
              }
              var g = 0, h = -1, k = -1, l = 0, m = 0, q = a, r = null;
              b: for (; ; ) {
                for (var y; ; ) {
                  q !== c || 0 !== e && 3 !== q.nodeType || (h = g + e);
                  q !== f || 0 !== d && 3 !== q.nodeType || (k = g + d);
                  3 === q.nodeType && (g += q.nodeValue.length);
                  if (null === (y = q.firstChild)) break;
                  r = q;
                  q = y;
                }
                for (; ; ) {
                  if (q === a) break b;
                  r === c && ++l === e && (h = g);
                  r === f && ++m === d && (k = g);
                  if (null !== (y = q.nextSibling)) break;
                  q = r;
                  r = q.parentNode;
                }
                q = y;
              }
              c = -1 === h || -1 === k ? null : { start: h, end: k };
            } else c = null;
          }
          c = c || { start: 0, end: 0 };
        } else c = null;
        Df = { focusedElem: a, selectionRange: c };
        dd = false;
        for (V = b; null !== V; ) if (b = V, a = b.child, 0 !== (b.subtreeFlags & 1028) && null !== a) a.return = b, V = a;
        else for (; null !== V; ) {
          b = V;
          try {
            var n = b.alternate;
            if (0 !== (b.flags & 1024)) switch (b.tag) {
              case 0:
              case 11:
              case 15:
                break;
              case 1:
                if (null !== n) {
                  var t = n.memoizedProps, J = n.memoizedState, x = b.stateNode, w = x.getSnapshotBeforeUpdate(b.elementType === b.type ? t : Ci(b.type, t), J);
                  x.__reactInternalSnapshotBeforeUpdate = w;
                }
                break;
              case 3:
                var u = b.stateNode.containerInfo;
                1 === u.nodeType ? u.textContent = "" : 9 === u.nodeType && u.documentElement && u.removeChild(u.documentElement);
                break;
              case 5:
              case 6:
              case 4:
              case 17:
                break;
              default:
                throw Error(p(163));
            }
          } catch (F) {
            W2(b, b.return, F);
          }
          a = b.sibling;
          if (null !== a) {
            a.return = b.return;
            V = a;
            break;
          }
          V = b.return;
        }
        n = Nj;
        Nj = false;
        return n;
      }
      function Pj(a, b, c) {
        var d = b.updateQueue;
        d = null !== d ? d.lastEffect : null;
        if (null !== d) {
          var e = d = d.next;
          do {
            if ((e.tag & a) === a) {
              var f = e.destroy;
              e.destroy = void 0;
              void 0 !== f && Mj(b, c, f);
            }
            e = e.next;
          } while (e !== d);
        }
      }
      function Qj(a, b) {
        b = b.updateQueue;
        b = null !== b ? b.lastEffect : null;
        if (null !== b) {
          var c = b = b.next;
          do {
            if ((c.tag & a) === a) {
              var d = c.create;
              c.destroy = d();
            }
            c = c.next;
          } while (c !== b);
        }
      }
      function Rj(a) {
        var b = a.ref;
        if (null !== b) {
          var c = a.stateNode;
          switch (a.tag) {
            case 5:
              a = c;
              break;
            default:
              a = c;
          }
          "function" === typeof b ? b(a) : b.current = a;
        }
      }
      function Sj(a) {
        var b = a.alternate;
        null !== b && (a.alternate = null, Sj(b));
        a.child = null;
        a.deletions = null;
        a.sibling = null;
        5 === a.tag && (b = a.stateNode, null !== b && (delete b[Of], delete b[Pf], delete b[of], delete b[Qf], delete b[Rf]));
        a.stateNode = null;
        a.return = null;
        a.dependencies = null;
        a.memoizedProps = null;
        a.memoizedState = null;
        a.pendingProps = null;
        a.stateNode = null;
        a.updateQueue = null;
      }
      function Tj(a) {
        return 5 === a.tag || 3 === a.tag || 4 === a.tag;
      }
      function Uj(a) {
        a: for (; ; ) {
          for (; null === a.sibling; ) {
            if (null === a.return || Tj(a.return)) return null;
            a = a.return;
          }
          a.sibling.return = a.return;
          for (a = a.sibling; 5 !== a.tag && 6 !== a.tag && 18 !== a.tag; ) {
            if (a.flags & 2) continue a;
            if (null === a.child || 4 === a.tag) continue a;
            else a.child.return = a, a = a.child;
          }
          if (!(a.flags & 2)) return a.stateNode;
        }
      }
      function Vj(a, b, c) {
        var d = a.tag;
        if (5 === d || 6 === d) a = a.stateNode, b ? 8 === c.nodeType ? c.parentNode.insertBefore(a, b) : c.insertBefore(a, b) : (8 === c.nodeType ? (b = c.parentNode, b.insertBefore(a, c)) : (b = c, b.appendChild(a)), c = c._reactRootContainer, null !== c && void 0 !== c || null !== b.onclick || (b.onclick = Bf));
        else if (4 !== d && (a = a.child, null !== a)) for (Vj(a, b, c), a = a.sibling; null !== a; ) Vj(a, b, c), a = a.sibling;
      }
      function Wj(a, b, c) {
        var d = a.tag;
        if (5 === d || 6 === d) a = a.stateNode, b ? c.insertBefore(a, b) : c.appendChild(a);
        else if (4 !== d && (a = a.child, null !== a)) for (Wj(a, b, c), a = a.sibling; null !== a; ) Wj(a, b, c), a = a.sibling;
      }
      var X2 = null;
      var Xj = false;
      function Yj(a, b, c) {
        for (c = c.child; null !== c; ) Zj(a, b, c), c = c.sibling;
      }
      function Zj(a, b, c) {
        if (lc && "function" === typeof lc.onCommitFiberUnmount) try {
          lc.onCommitFiberUnmount(kc, c);
        } catch (h) {
        }
        switch (c.tag) {
          case 5:
            U || Lj(c, b);
          case 6:
            var d = X2, e = Xj;
            X2 = null;
            Yj(a, b, c);
            X2 = d;
            Xj = e;
            null !== X2 && (Xj ? (a = X2, c = c.stateNode, 8 === a.nodeType ? a.parentNode.removeChild(c) : a.removeChild(c)) : X2.removeChild(c.stateNode));
            break;
          case 18:
            null !== X2 && (Xj ? (a = X2, c = c.stateNode, 8 === a.nodeType ? Kf(a.parentNode, c) : 1 === a.nodeType && Kf(a, c), bd(a)) : Kf(X2, c.stateNode));
            break;
          case 4:
            d = X2;
            e = Xj;
            X2 = c.stateNode.containerInfo;
            Xj = true;
            Yj(a, b, c);
            X2 = d;
            Xj = e;
            break;
          case 0:
          case 11:
          case 14:
          case 15:
            if (!U && (d = c.updateQueue, null !== d && (d = d.lastEffect, null !== d))) {
              e = d = d.next;
              do {
                var f = e, g = f.destroy;
                f = f.tag;
                void 0 !== g && (0 !== (f & 2) ? Mj(c, b, g) : 0 !== (f & 4) && Mj(c, b, g));
                e = e.next;
              } while (e !== d);
            }
            Yj(a, b, c);
            break;
          case 1:
            if (!U && (Lj(c, b), d = c.stateNode, "function" === typeof d.componentWillUnmount)) try {
              d.props = c.memoizedProps, d.state = c.memoizedState, d.componentWillUnmount();
            } catch (h) {
              W2(c, b, h);
            }
            Yj(a, b, c);
            break;
          case 21:
            Yj(a, b, c);
            break;
          case 22:
            c.mode & 1 ? (U = (d = U) || null !== c.memoizedState, Yj(a, b, c), U = d) : Yj(a, b, c);
            break;
          default:
            Yj(a, b, c);
        }
      }
      function ak(a) {
        var b = a.updateQueue;
        if (null !== b) {
          a.updateQueue = null;
          var c = a.stateNode;
          null === c && (c = a.stateNode = new Kj());
          b.forEach(function(b2) {
            var d = bk.bind(null, a, b2);
            c.has(b2) || (c.add(b2), b2.then(d, d));
          });
        }
      }
      function ck(a, b) {
        var c = b.deletions;
        if (null !== c) for (var d = 0; d < c.length; d++) {
          var e = c[d];
          try {
            var f = a, g = b, h = g;
            a: for (; null !== h; ) {
              switch (h.tag) {
                case 5:
                  X2 = h.stateNode;
                  Xj = false;
                  break a;
                case 3:
                  X2 = h.stateNode.containerInfo;
                  Xj = true;
                  break a;
                case 4:
                  X2 = h.stateNode.containerInfo;
                  Xj = true;
                  break a;
              }
              h = h.return;
            }
            if (null === X2) throw Error(p(160));
            Zj(f, g, e);
            X2 = null;
            Xj = false;
            var k = e.alternate;
            null !== k && (k.return = null);
            e.return = null;
          } catch (l) {
            W2(e, b, l);
          }
        }
        if (b.subtreeFlags & 12854) for (b = b.child; null !== b; ) dk(b, a), b = b.sibling;
      }
      function dk(a, b) {
        var c = a.alternate, d = a.flags;
        switch (a.tag) {
          case 0:
          case 11:
          case 14:
          case 15:
            ck(b, a);
            ek(a);
            if (d & 4) {
              try {
                Pj(3, a, a.return), Qj(3, a);
              } catch (t) {
                W2(a, a.return, t);
              }
              try {
                Pj(5, a, a.return);
              } catch (t) {
                W2(a, a.return, t);
              }
            }
            break;
          case 1:
            ck(b, a);
            ek(a);
            d & 512 && null !== c && Lj(c, c.return);
            break;
          case 5:
            ck(b, a);
            ek(a);
            d & 512 && null !== c && Lj(c, c.return);
            if (a.flags & 32) {
              var e = a.stateNode;
              try {
                ob(e, "");
              } catch (t) {
                W2(a, a.return, t);
              }
            }
            if (d & 4 && (e = a.stateNode, null != e)) {
              var f = a.memoizedProps, g = null !== c ? c.memoizedProps : f, h = a.type, k = a.updateQueue;
              a.updateQueue = null;
              if (null !== k) try {
                "input" === h && "radio" === f.type && null != f.name && ab(e, f);
                vb(h, g);
                var l = vb(h, f);
                for (g = 0; g < k.length; g += 2) {
                  var m = k[g], q = k[g + 1];
                  "style" === m ? sb(e, q) : "dangerouslySetInnerHTML" === m ? nb(e, q) : "children" === m ? ob(e, q) : ta(e, m, q, l);
                }
                switch (h) {
                  case "input":
                    bb(e, f);
                    break;
                  case "textarea":
                    ib(e, f);
                    break;
                  case "select":
                    var r = e._wrapperState.wasMultiple;
                    e._wrapperState.wasMultiple = !!f.multiple;
                    var y = f.value;
                    null != y ? fb(e, !!f.multiple, y, false) : r !== !!f.multiple && (null != f.defaultValue ? fb(
                      e,
                      !!f.multiple,
                      f.defaultValue,
                      true
                    ) : fb(e, !!f.multiple, f.multiple ? [] : "", false));
                }
                e[Pf] = f;
              } catch (t) {
                W2(a, a.return, t);
              }
            }
            break;
          case 6:
            ck(b, a);
            ek(a);
            if (d & 4) {
              if (null === a.stateNode) throw Error(p(162));
              e = a.stateNode;
              f = a.memoizedProps;
              try {
                e.nodeValue = f;
              } catch (t) {
                W2(a, a.return, t);
              }
            }
            break;
          case 3:
            ck(b, a);
            ek(a);
            if (d & 4 && null !== c && c.memoizedState.isDehydrated) try {
              bd(b.containerInfo);
            } catch (t) {
              W2(a, a.return, t);
            }
            break;
          case 4:
            ck(b, a);
            ek(a);
            break;
          case 13:
            ck(b, a);
            ek(a);
            e = a.child;
            e.flags & 8192 && (f = null !== e.memoizedState, e.stateNode.isHidden = f, !f || null !== e.alternate && null !== e.alternate.memoizedState || (fk = B()));
            d & 4 && ak(a);
            break;
          case 22:
            m = null !== c && null !== c.memoizedState;
            a.mode & 1 ? (U = (l = U) || m, ck(b, a), U = l) : ck(b, a);
            ek(a);
            if (d & 8192) {
              l = null !== a.memoizedState;
              if ((a.stateNode.isHidden = l) && !m && 0 !== (a.mode & 1)) for (V = a, m = a.child; null !== m; ) {
                for (q = V = m; null !== V; ) {
                  r = V;
                  y = r.child;
                  switch (r.tag) {
                    case 0:
                    case 11:
                    case 14:
                    case 15:
                      Pj(4, r, r.return);
                      break;
                    case 1:
                      Lj(r, r.return);
                      var n = r.stateNode;
                      if ("function" === typeof n.componentWillUnmount) {
                        d = r;
                        c = r.return;
                        try {
                          b = d, n.props = b.memoizedProps, n.state = b.memoizedState, n.componentWillUnmount();
                        } catch (t) {
                          W2(d, c, t);
                        }
                      }
                      break;
                    case 5:
                      Lj(r, r.return);
                      break;
                    case 22:
                      if (null !== r.memoizedState) {
                        gk(q);
                        continue;
                      }
                  }
                  null !== y ? (y.return = r, V = y) : gk(q);
                }
                m = m.sibling;
              }
              a: for (m = null, q = a; ; ) {
                if (5 === q.tag) {
                  if (null === m) {
                    m = q;
                    try {
                      e = q.stateNode, l ? (f = e.style, "function" === typeof f.setProperty ? f.setProperty("display", "none", "important") : f.display = "none") : (h = q.stateNode, k = q.memoizedProps.style, g = void 0 !== k && null !== k && k.hasOwnProperty("display") ? k.display : null, h.style.display = rb("display", g));
                    } catch (t) {
                      W2(a, a.return, t);
                    }
                  }
                } else if (6 === q.tag) {
                  if (null === m) try {
                    q.stateNode.nodeValue = l ? "" : q.memoizedProps;
                  } catch (t) {
                    W2(a, a.return, t);
                  }
                } else if ((22 !== q.tag && 23 !== q.tag || null === q.memoizedState || q === a) && null !== q.child) {
                  q.child.return = q;
                  q = q.child;
                  continue;
                }
                if (q === a) break a;
                for (; null === q.sibling; ) {
                  if (null === q.return || q.return === a) break a;
                  m === q && (m = null);
                  q = q.return;
                }
                m === q && (m = null);
                q.sibling.return = q.return;
                q = q.sibling;
              }
            }
            break;
          case 19:
            ck(b, a);
            ek(a);
            d & 4 && ak(a);
            break;
          case 21:
            break;
          default:
            ck(
              b,
              a
            ), ek(a);
        }
      }
      function ek(a) {
        var b = a.flags;
        if (b & 2) {
          try {
            a: {
              for (var c = a.return; null !== c; ) {
                if (Tj(c)) {
                  var d = c;
                  break a;
                }
                c = c.return;
              }
              throw Error(p(160));
            }
            switch (d.tag) {
              case 5:
                var e = d.stateNode;
                d.flags & 32 && (ob(e, ""), d.flags &= -33);
                var f = Uj(a);
                Wj(a, f, e);
                break;
              case 3:
              case 4:
                var g = d.stateNode.containerInfo, h = Uj(a);
                Vj(a, h, g);
                break;
              default:
                throw Error(p(161));
            }
          } catch (k) {
            W2(a, a.return, k);
          }
          a.flags &= -3;
        }
        b & 4096 && (a.flags &= -4097);
      }
      function hk(a, b, c) {
        V = a;
        ik(a, b, c);
      }
      function ik(a, b, c) {
        for (var d = 0 !== (a.mode & 1); null !== V; ) {
          var e = V, f = e.child;
          if (22 === e.tag && d) {
            var g = null !== e.memoizedState || Jj;
            if (!g) {
              var h = e.alternate, k = null !== h && null !== h.memoizedState || U;
              h = Jj;
              var l = U;
              Jj = g;
              if ((U = k) && !l) for (V = e; null !== V; ) g = V, k = g.child, 22 === g.tag && null !== g.memoizedState ? jk(e) : null !== k ? (k.return = g, V = k) : jk(e);
              for (; null !== f; ) V = f, ik(f, b, c), f = f.sibling;
              V = e;
              Jj = h;
              U = l;
            }
            kk(a, b, c);
          } else 0 !== (e.subtreeFlags & 8772) && null !== f ? (f.return = e, V = f) : kk(a, b, c);
        }
      }
      function kk(a) {
        for (; null !== V; ) {
          var b = V;
          if (0 !== (b.flags & 8772)) {
            var c = b.alternate;
            try {
              if (0 !== (b.flags & 8772)) switch (b.tag) {
                case 0:
                case 11:
                case 15:
                  U || Qj(5, b);
                  break;
                case 1:
                  var d = b.stateNode;
                  if (b.flags & 4 && !U) if (null === c) d.componentDidMount();
                  else {
                    var e = b.elementType === b.type ? c.memoizedProps : Ci(b.type, c.memoizedProps);
                    d.componentDidUpdate(e, c.memoizedState, d.__reactInternalSnapshotBeforeUpdate);
                  }
                  var f = b.updateQueue;
                  null !== f && sh(b, f, d);
                  break;
                case 3:
                  var g = b.updateQueue;
                  if (null !== g) {
                    c = null;
                    if (null !== b.child) switch (b.child.tag) {
                      case 5:
                        c = b.child.stateNode;
                        break;
                      case 1:
                        c = b.child.stateNode;
                    }
                    sh(b, g, c);
                  }
                  break;
                case 5:
                  var h = b.stateNode;
                  if (null === c && b.flags & 4) {
                    c = h;
                    var k = b.memoizedProps;
                    switch (b.type) {
                      case "button":
                      case "input":
                      case "select":
                      case "textarea":
                        k.autoFocus && c.focus();
                        break;
                      case "img":
                        k.src && (c.src = k.src);
                    }
                  }
                  break;
                case 6:
                  break;
                case 4:
                  break;
                case 12:
                  break;
                case 13:
                  if (null === b.memoizedState) {
                    var l = b.alternate;
                    if (null !== l) {
                      var m = l.memoizedState;
                      if (null !== m) {
                        var q = m.dehydrated;
                        null !== q && bd(q);
                      }
                    }
                  }
                  break;
                case 19:
                case 17:
                case 21:
                case 22:
                case 23:
                case 25:
                  break;
                default:
                  throw Error(p(163));
              }
              U || b.flags & 512 && Rj(b);
            } catch (r) {
              W2(b, b.return, r);
            }
          }
          if (b === a) {
            V = null;
            break;
          }
          c = b.sibling;
          if (null !== c) {
            c.return = b.return;
            V = c;
            break;
          }
          V = b.return;
        }
      }
      function gk(a) {
        for (; null !== V; ) {
          var b = V;
          if (b === a) {
            V = null;
            break;
          }
          var c = b.sibling;
          if (null !== c) {
            c.return = b.return;
            V = c;
            break;
          }
          V = b.return;
        }
      }
      function jk(a) {
        for (; null !== V; ) {
          var b = V;
          try {
            switch (b.tag) {
              case 0:
              case 11:
              case 15:
                var c = b.return;
                try {
                  Qj(4, b);
                } catch (k) {
                  W2(b, c, k);
                }
                break;
              case 1:
                var d = b.stateNode;
                if ("function" === typeof d.componentDidMount) {
                  var e = b.return;
                  try {
                    d.componentDidMount();
                  } catch (k) {
                    W2(b, e, k);
                  }
                }
                var f = b.return;
                try {
                  Rj(b);
                } catch (k) {
                  W2(b, f, k);
                }
                break;
              case 5:
                var g = b.return;
                try {
                  Rj(b);
                } catch (k) {
                  W2(b, g, k);
                }
            }
          } catch (k) {
            W2(b, b.return, k);
          }
          if (b === a) {
            V = null;
            break;
          }
          var h = b.sibling;
          if (null !== h) {
            h.return = b.return;
            V = h;
            break;
          }
          V = b.return;
        }
      }
      var lk = Math.ceil;
      var mk = ua.ReactCurrentDispatcher;
      var nk = ua.ReactCurrentOwner;
      var ok = ua.ReactCurrentBatchConfig;
      var K = 0;
      var Q = null;
      var Y = null;
      var Z = 0;
      var fj = 0;
      var ej = Uf(0);
      var T2 = 0;
      var pk = null;
      var rh = 0;
      var qk = 0;
      var rk = 0;
      var sk = null;
      var tk = null;
      var fk = 0;
      var Gj = Infinity;
      var uk = null;
      var Oi = false;
      var Pi = null;
      var Ri = null;
      var vk = false;
      var wk = null;
      var xk = 0;
      var yk = 0;
      var zk = null;
      var Ak = -1;
      var Bk = 0;
      function R() {
        return 0 !== (K & 6) ? B() : -1 !== Ak ? Ak : Ak = B();
      }
      function yi(a) {
        if (0 === (a.mode & 1)) return 1;
        if (0 !== (K & 2) && 0 !== Z) return Z & -Z;
        if (null !== Kg.transition) return 0 === Bk && (Bk = yc()), Bk;
        a = C2;
        if (0 !== a) return a;
        a = window.event;
        a = void 0 === a ? 16 : jd(a.type);
        return a;
      }
      function gi(a, b, c, d) {
        if (50 < yk) throw yk = 0, zk = null, Error(p(185));
        Ac(a, c, d);
        if (0 === (K & 2) || a !== Q) a === Q && (0 === (K & 2) && (qk |= c), 4 === T2 && Ck(a, Z)), Dk(a, d), 1 === c && 0 === K && 0 === (b.mode & 1) && (Gj = B() + 500, fg && jg());
      }
      function Dk(a, b) {
        var c = a.callbackNode;
        wc(a, b);
        var d = uc(a, a === Q ? Z : 0);
        if (0 === d) null !== c && bc(c), a.callbackNode = null, a.callbackPriority = 0;
        else if (b = d & -d, a.callbackPriority !== b) {
          null != c && bc(c);
          if (1 === b) 0 === a.tag ? ig(Ek.bind(null, a)) : hg(Ek.bind(null, a)), Jf(function() {
            0 === (K & 6) && jg();
          }), c = null;
          else {
            switch (Dc(d)) {
              case 1:
                c = fc;
                break;
              case 4:
                c = gc;
                break;
              case 16:
                c = hc;
                break;
              case 536870912:
                c = jc;
                break;
              default:
                c = hc;
            }
            c = Fk(c, Gk.bind(null, a));
          }
          a.callbackPriority = b;
          a.callbackNode = c;
        }
      }
      function Gk(a, b) {
        Ak = -1;
        Bk = 0;
        if (0 !== (K & 6)) throw Error(p(327));
        var c = a.callbackNode;
        if (Hk() && a.callbackNode !== c) return null;
        var d = uc(a, a === Q ? Z : 0);
        if (0 === d) return null;
        if (0 !== (d & 30) || 0 !== (d & a.expiredLanes) || b) b = Ik(a, d);
        else {
          b = d;
          var e = K;
          K |= 2;
          var f = Jk();
          if (Q !== a || Z !== b) uk = null, Gj = B() + 500, Kk(a, b);
          do
            try {
              Lk();
              break;
            } catch (h) {
              Mk(a, h);
            }
          while (1);
          $g();
          mk.current = f;
          K = e;
          null !== Y ? b = 0 : (Q = null, Z = 0, b = T2);
        }
        if (0 !== b) {
          2 === b && (e = xc(a), 0 !== e && (d = e, b = Nk(a, e)));
          if (1 === b) throw c = pk, Kk(a, 0), Ck(a, d), Dk(a, B()), c;
          if (6 === b) Ck(a, d);
          else {
            e = a.current.alternate;
            if (0 === (d & 30) && !Ok(e) && (b = Ik(a, d), 2 === b && (f = xc(a), 0 !== f && (d = f, b = Nk(a, f))), 1 === b)) throw c = pk, Kk(a, 0), Ck(a, d), Dk(a, B()), c;
            a.finishedWork = e;
            a.finishedLanes = d;
            switch (b) {
              case 0:
              case 1:
                throw Error(p(345));
              case 2:
                Pk(a, tk, uk);
                break;
              case 3:
                Ck(a, d);
                if ((d & 130023424) === d && (b = fk + 500 - B(), 10 < b)) {
                  if (0 !== uc(a, 0)) break;
                  e = a.suspendedLanes;
                  if ((e & d) !== d) {
                    R();
                    a.pingedLanes |= a.suspendedLanes & e;
                    break;
                  }
                  a.timeoutHandle = Ff(Pk.bind(null, a, tk, uk), b);
                  break;
                }
                Pk(a, tk, uk);
                break;
              case 4:
                Ck(a, d);
                if ((d & 4194240) === d) break;
                b = a.eventTimes;
                for (e = -1; 0 < d; ) {
                  var g = 31 - oc(d);
                  f = 1 << g;
                  g = b[g];
                  g > e && (e = g);
                  d &= ~f;
                }
                d = e;
                d = B() - d;
                d = (120 > d ? 120 : 480 > d ? 480 : 1080 > d ? 1080 : 1920 > d ? 1920 : 3e3 > d ? 3e3 : 4320 > d ? 4320 : 1960 * lk(d / 1960)) - d;
                if (10 < d) {
                  a.timeoutHandle = Ff(Pk.bind(null, a, tk, uk), d);
                  break;
                }
                Pk(a, tk, uk);
                break;
              case 5:
                Pk(a, tk, uk);
                break;
              default:
                throw Error(p(329));
            }
          }
        }
        Dk(a, B());
        return a.callbackNode === c ? Gk.bind(null, a) : null;
      }
      function Nk(a, b) {
        var c = sk;
        a.current.memoizedState.isDehydrated && (Kk(a, b).flags |= 256);
        a = Ik(a, b);
        2 !== a && (b = tk, tk = c, null !== b && Fj(b));
        return a;
      }
      function Fj(a) {
        null === tk ? tk = a : tk.push.apply(tk, a);
      }
      function Ok(a) {
        for (var b = a; ; ) {
          if (b.flags & 16384) {
            var c = b.updateQueue;
            if (null !== c && (c = c.stores, null !== c)) for (var d = 0; d < c.length; d++) {
              var e = c[d], f = e.getSnapshot;
              e = e.value;
              try {
                if (!He(f(), e)) return false;
              } catch (g) {
                return false;
              }
            }
          }
          c = b.child;
          if (b.subtreeFlags & 16384 && null !== c) c.return = b, b = c;
          else {
            if (b === a) break;
            for (; null === b.sibling; ) {
              if (null === b.return || b.return === a) return true;
              b = b.return;
            }
            b.sibling.return = b.return;
            b = b.sibling;
          }
        }
        return true;
      }
      function Ck(a, b) {
        b &= ~rk;
        b &= ~qk;
        a.suspendedLanes |= b;
        a.pingedLanes &= ~b;
        for (a = a.expirationTimes; 0 < b; ) {
          var c = 31 - oc(b), d = 1 << c;
          a[c] = -1;
          b &= ~d;
        }
      }
      function Ek(a) {
        if (0 !== (K & 6)) throw Error(p(327));
        Hk();
        var b = uc(a, 0);
        if (0 === (b & 1)) return Dk(a, B()), null;
        var c = Ik(a, b);
        if (0 !== a.tag && 2 === c) {
          var d = xc(a);
          0 !== d && (b = d, c = Nk(a, d));
        }
        if (1 === c) throw c = pk, Kk(a, 0), Ck(a, b), Dk(a, B()), c;
        if (6 === c) throw Error(p(345));
        a.finishedWork = a.current.alternate;
        a.finishedLanes = b;
        Pk(a, tk, uk);
        Dk(a, B());
        return null;
      }
      function Qk(a, b) {
        var c = K;
        K |= 1;
        try {
          return a(b);
        } finally {
          K = c, 0 === K && (Gj = B() + 500, fg && jg());
        }
      }
      function Rk(a) {
        null !== wk && 0 === wk.tag && 0 === (K & 6) && Hk();
        var b = K;
        K |= 1;
        var c = ok.transition, d = C2;
        try {
          if (ok.transition = null, C2 = 1, a) return a();
        } finally {
          C2 = d, ok.transition = c, K = b, 0 === (K & 6) && jg();
        }
      }
      function Hj() {
        fj = ej.current;
        E(ej);
      }
      function Kk(a, b) {
        a.finishedWork = null;
        a.finishedLanes = 0;
        var c = a.timeoutHandle;
        -1 !== c && (a.timeoutHandle = -1, Gf(c));
        if (null !== Y) for (c = Y.return; null !== c; ) {
          var d = c;
          wg(d);
          switch (d.tag) {
            case 1:
              d = d.type.childContextTypes;
              null !== d && void 0 !== d && $f();
              break;
            case 3:
              zh();
              E(Wf);
              E(H);
              Eh();
              break;
            case 5:
              Bh(d);
              break;
            case 4:
              zh();
              break;
            case 13:
              E(L3);
              break;
            case 19:
              E(L3);
              break;
            case 10:
              ah(d.type._context);
              break;
            case 22:
            case 23:
              Hj();
          }
          c = c.return;
        }
        Q = a;
        Y = a = Pg(a.current, null);
        Z = fj = b;
        T2 = 0;
        pk = null;
        rk = qk = rh = 0;
        tk = sk = null;
        if (null !== fh) {
          for (b = 0; b < fh.length; b++) if (c = fh[b], d = c.interleaved, null !== d) {
            c.interleaved = null;
            var e = d.next, f = c.pending;
            if (null !== f) {
              var g = f.next;
              f.next = e;
              d.next = g;
            }
            c.pending = d;
          }
          fh = null;
        }
        return a;
      }
      function Mk(a, b) {
        do {
          var c = Y;
          try {
            $g();
            Fh.current = Rh;
            if (Ih) {
              for (var d = M.memoizedState; null !== d; ) {
                var e = d.queue;
                null !== e && (e.pending = null);
                d = d.next;
              }
              Ih = false;
            }
            Hh = 0;
            O = N = M = null;
            Jh = false;
            Kh = 0;
            nk.current = null;
            if (null === c || null === c.return) {
              T2 = 1;
              pk = b;
              Y = null;
              break;
            }
            a: {
              var f = a, g = c.return, h = c, k = b;
              b = Z;
              h.flags |= 32768;
              if (null !== k && "object" === typeof k && "function" === typeof k.then) {
                var l = k, m = h, q = m.tag;
                if (0 === (m.mode & 1) && (0 === q || 11 === q || 15 === q)) {
                  var r = m.alternate;
                  r ? (m.updateQueue = r.updateQueue, m.memoizedState = r.memoizedState, m.lanes = r.lanes) : (m.updateQueue = null, m.memoizedState = null);
                }
                var y = Ui(g);
                if (null !== y) {
                  y.flags &= -257;
                  Vi(y, g, h, f, b);
                  y.mode & 1 && Si(f, l, b);
                  b = y;
                  k = l;
                  var n = b.updateQueue;
                  if (null === n) {
                    var t = /* @__PURE__ */ new Set();
                    t.add(k);
                    b.updateQueue = t;
                  } else n.add(k);
                  break a;
                } else {
                  if (0 === (b & 1)) {
                    Si(f, l, b);
                    tj();
                    break a;
                  }
                  k = Error(p(426));
                }
              } else if (I && h.mode & 1) {
                var J = Ui(g);
                if (null !== J) {
                  0 === (J.flags & 65536) && (J.flags |= 256);
                  Vi(J, g, h, f, b);
                  Jg(Ji(k, h));
                  break a;
                }
              }
              f = k = Ji(k, h);
              4 !== T2 && (T2 = 2);
              null === sk ? sk = [f] : sk.push(f);
              f = g;
              do {
                switch (f.tag) {
                  case 3:
                    f.flags |= 65536;
                    b &= -b;
                    f.lanes |= b;
                    var x = Ni(f, k, b);
                    ph(f, x);
                    break a;
                  case 1:
                    h = k;
                    var w = f.type, u = f.stateNode;
                    if (0 === (f.flags & 128) && ("function" === typeof w.getDerivedStateFromError || null !== u && "function" === typeof u.componentDidCatch && (null === Ri || !Ri.has(u)))) {
                      f.flags |= 65536;
                      b &= -b;
                      f.lanes |= b;
                      var F = Qi(f, h, b);
                      ph(f, F);
                      break a;
                    }
                }
                f = f.return;
              } while (null !== f);
            }
            Sk(c);
          } catch (na) {
            b = na;
            Y === c && null !== c && (Y = c = c.return);
            continue;
          }
          break;
        } while (1);
      }
      function Jk() {
        var a = mk.current;
        mk.current = Rh;
        return null === a ? Rh : a;
      }
      function tj() {
        if (0 === T2 || 3 === T2 || 2 === T2) T2 = 4;
        null === Q || 0 === (rh & 268435455) && 0 === (qk & 268435455) || Ck(Q, Z);
      }
      function Ik(a, b) {
        var c = K;
        K |= 2;
        var d = Jk();
        if (Q !== a || Z !== b) uk = null, Kk(a, b);
        do
          try {
            Tk();
            break;
          } catch (e) {
            Mk(a, e);
          }
        while (1);
        $g();
        K = c;
        mk.current = d;
        if (null !== Y) throw Error(p(261));
        Q = null;
        Z = 0;
        return T2;
      }
      function Tk() {
        for (; null !== Y; ) Uk(Y);
      }
      function Lk() {
        for (; null !== Y && !cc(); ) Uk(Y);
      }
      function Uk(a) {
        var b = Vk(a.alternate, a, fj);
        a.memoizedProps = a.pendingProps;
        null === b ? Sk(a) : Y = b;
        nk.current = null;
      }
      function Sk(a) {
        var b = a;
        do {
          var c = b.alternate;
          a = b.return;
          if (0 === (b.flags & 32768)) {
            if (c = Ej(c, b, fj), null !== c) {
              Y = c;
              return;
            }
          } else {
            c = Ij(c, b);
            if (null !== c) {
              c.flags &= 32767;
              Y = c;
              return;
            }
            if (null !== a) a.flags |= 32768, a.subtreeFlags = 0, a.deletions = null;
            else {
              T2 = 6;
              Y = null;
              return;
            }
          }
          b = b.sibling;
          if (null !== b) {
            Y = b;
            return;
          }
          Y = b = a;
        } while (null !== b);
        0 === T2 && (T2 = 5);
      }
      function Pk(a, b, c) {
        var d = C2, e = ok.transition;
        try {
          ok.transition = null, C2 = 1, Wk(a, b, c, d);
        } finally {
          ok.transition = e, C2 = d;
        }
        return null;
      }
      function Wk(a, b, c, d) {
        do
          Hk();
        while (null !== wk);
        if (0 !== (K & 6)) throw Error(p(327));
        c = a.finishedWork;
        var e = a.finishedLanes;
        if (null === c) return null;
        a.finishedWork = null;
        a.finishedLanes = 0;
        if (c === a.current) throw Error(p(177));
        a.callbackNode = null;
        a.callbackPriority = 0;
        var f = c.lanes | c.childLanes;
        Bc(a, f);
        a === Q && (Y = Q = null, Z = 0);
        0 === (c.subtreeFlags & 2064) && 0 === (c.flags & 2064) || vk || (vk = true, Fk(hc, function() {
          Hk();
          return null;
        }));
        f = 0 !== (c.flags & 15990);
        if (0 !== (c.subtreeFlags & 15990) || f) {
          f = ok.transition;
          ok.transition = null;
          var g = C2;
          C2 = 1;
          var h = K;
          K |= 4;
          nk.current = null;
          Oj(a, c);
          dk(c, a);
          Oe(Df);
          dd = !!Cf;
          Df = Cf = null;
          a.current = c;
          hk(c, a, e);
          dc();
          K = h;
          C2 = g;
          ok.transition = f;
        } else a.current = c;
        vk && (vk = false, wk = a, xk = e);
        f = a.pendingLanes;
        0 === f && (Ri = null);
        mc(c.stateNode, d);
        Dk(a, B());
        if (null !== b) for (d = a.onRecoverableError, c = 0; c < b.length; c++) e = b[c], d(e.value, { componentStack: e.stack, digest: e.digest });
        if (Oi) throw Oi = false, a = Pi, Pi = null, a;
        0 !== (xk & 1) && 0 !== a.tag && Hk();
        f = a.pendingLanes;
        0 !== (f & 1) ? a === zk ? yk++ : (yk = 0, zk = a) : yk = 0;
        jg();
        return null;
      }
      function Hk() {
        if (null !== wk) {
          var a = Dc(xk), b = ok.transition, c = C2;
          try {
            ok.transition = null;
            C2 = 16 > a ? 16 : a;
            if (null === wk) var d = false;
            else {
              a = wk;
              wk = null;
              xk = 0;
              if (0 !== (K & 6)) throw Error(p(331));
              var e = K;
              K |= 4;
              for (V = a.current; null !== V; ) {
                var f = V, g = f.child;
                if (0 !== (V.flags & 16)) {
                  var h = f.deletions;
                  if (null !== h) {
                    for (var k = 0; k < h.length; k++) {
                      var l = h[k];
                      for (V = l; null !== V; ) {
                        var m = V;
                        switch (m.tag) {
                          case 0:
                          case 11:
                          case 15:
                            Pj(8, m, f);
                        }
                        var q = m.child;
                        if (null !== q) q.return = m, V = q;
                        else for (; null !== V; ) {
                          m = V;
                          var r = m.sibling, y = m.return;
                          Sj(m);
                          if (m === l) {
                            V = null;
                            break;
                          }
                          if (null !== r) {
                            r.return = y;
                            V = r;
                            break;
                          }
                          V = y;
                        }
                      }
                    }
                    var n = f.alternate;
                    if (null !== n) {
                      var t = n.child;
                      if (null !== t) {
                        n.child = null;
                        do {
                          var J = t.sibling;
                          t.sibling = null;
                          t = J;
                        } while (null !== t);
                      }
                    }
                    V = f;
                  }
                }
                if (0 !== (f.subtreeFlags & 2064) && null !== g) g.return = f, V = g;
                else b: for (; null !== V; ) {
                  f = V;
                  if (0 !== (f.flags & 2048)) switch (f.tag) {
                    case 0:
                    case 11:
                    case 15:
                      Pj(9, f, f.return);
                  }
                  var x = f.sibling;
                  if (null !== x) {
                    x.return = f.return;
                    V = x;
                    break b;
                  }
                  V = f.return;
                }
              }
              var w = a.current;
              for (V = w; null !== V; ) {
                g = V;
                var u = g.child;
                if (0 !== (g.subtreeFlags & 2064) && null !== u) u.return = g, V = u;
                else b: for (g = w; null !== V; ) {
                  h = V;
                  if (0 !== (h.flags & 2048)) try {
                    switch (h.tag) {
                      case 0:
                      case 11:
                      case 15:
                        Qj(9, h);
                    }
                  } catch (na) {
                    W2(h, h.return, na);
                  }
                  if (h === g) {
                    V = null;
                    break b;
                  }
                  var F = h.sibling;
                  if (null !== F) {
                    F.return = h.return;
                    V = F;
                    break b;
                  }
                  V = h.return;
                }
              }
              K = e;
              jg();
              if (lc && "function" === typeof lc.onPostCommitFiberRoot) try {
                lc.onPostCommitFiberRoot(kc, a);
              } catch (na) {
              }
              d = true;
            }
            return d;
          } finally {
            C2 = c, ok.transition = b;
          }
        }
        return false;
      }
      function Xk(a, b, c) {
        b = Ji(c, b);
        b = Ni(a, b, 1);
        a = nh(a, b, 1);
        b = R();
        null !== a && (Ac(a, 1, b), Dk(a, b));
      }
      function W2(a, b, c) {
        if (3 === a.tag) Xk(a, a, c);
        else for (; null !== b; ) {
          if (3 === b.tag) {
            Xk(b, a, c);
            break;
          } else if (1 === b.tag) {
            var d = b.stateNode;
            if ("function" === typeof b.type.getDerivedStateFromError || "function" === typeof d.componentDidCatch && (null === Ri || !Ri.has(d))) {
              a = Ji(c, a);
              a = Qi(b, a, 1);
              b = nh(b, a, 1);
              a = R();
              null !== b && (Ac(b, 1, a), Dk(b, a));
              break;
            }
          }
          b = b.return;
        }
      }
      function Ti(a, b, c) {
        var d = a.pingCache;
        null !== d && d.delete(b);
        b = R();
        a.pingedLanes |= a.suspendedLanes & c;
        Q === a && (Z & c) === c && (4 === T2 || 3 === T2 && (Z & 130023424) === Z && 500 > B() - fk ? Kk(a, 0) : rk |= c);
        Dk(a, b);
      }
      function Yk(a, b) {
        0 === b && (0 === (a.mode & 1) ? b = 1 : (b = sc, sc <<= 1, 0 === (sc & 130023424) && (sc = 4194304)));
        var c = R();
        a = ih(a, b);
        null !== a && (Ac(a, b, c), Dk(a, c));
      }
      function uj(a) {
        var b = a.memoizedState, c = 0;
        null !== b && (c = b.retryLane);
        Yk(a, c);
      }
      function bk(a, b) {
        var c = 0;
        switch (a.tag) {
          case 13:
            var d = a.stateNode;
            var e = a.memoizedState;
            null !== e && (c = e.retryLane);
            break;
          case 19:
            d = a.stateNode;
            break;
          default:
            throw Error(p(314));
        }
        null !== d && d.delete(b);
        Yk(a, c);
      }
      var Vk;
      Vk = function(a, b, c) {
        if (null !== a) if (a.memoizedProps !== b.pendingProps || Wf.current) dh = true;
        else {
          if (0 === (a.lanes & c) && 0 === (b.flags & 128)) return dh = false, yj(a, b, c);
          dh = 0 !== (a.flags & 131072) ? true : false;
        }
        else dh = false, I && 0 !== (b.flags & 1048576) && ug(b, ng, b.index);
        b.lanes = 0;
        switch (b.tag) {
          case 2:
            var d = b.type;
            ij(a, b);
            a = b.pendingProps;
            var e = Yf(b, H.current);
            ch(b, c);
            e = Nh(null, b, d, a, e, c);
            var f = Sh();
            b.flags |= 1;
            "object" === typeof e && null !== e && "function" === typeof e.render && void 0 === e.$$typeof ? (b.tag = 1, b.memoizedState = null, b.updateQueue = null, Zf(d) ? (f = true, cg(b)) : f = false, b.memoizedState = null !== e.state && void 0 !== e.state ? e.state : null, kh(b), e.updater = Ei, b.stateNode = e, e._reactInternals = b, Ii(b, d, a, c), b = jj(null, b, d, true, f, c)) : (b.tag = 0, I && f && vg(b), Xi(null, b, e, c), b = b.child);
            return b;
          case 16:
            d = b.elementType;
            a: {
              ij(a, b);
              a = b.pendingProps;
              e = d._init;
              d = e(d._payload);
              b.type = d;
              e = b.tag = Zk(d);
              a = Ci(d, a);
              switch (e) {
                case 0:
                  b = cj(null, b, d, a, c);
                  break a;
                case 1:
                  b = hj(null, b, d, a, c);
                  break a;
                case 11:
                  b = Yi(null, b, d, a, c);
                  break a;
                case 14:
                  b = $i(null, b, d, Ci(d.type, a), c);
                  break a;
              }
              throw Error(p(
                306,
                d,
                ""
              ));
            }
            return b;
          case 0:
            return d = b.type, e = b.pendingProps, e = b.elementType === d ? e : Ci(d, e), cj(a, b, d, e, c);
          case 1:
            return d = b.type, e = b.pendingProps, e = b.elementType === d ? e : Ci(d, e), hj(a, b, d, e, c);
          case 3:
            a: {
              kj(b);
              if (null === a) throw Error(p(387));
              d = b.pendingProps;
              f = b.memoizedState;
              e = f.element;
              lh(a, b);
              qh(b, d, null, c);
              var g = b.memoizedState;
              d = g.element;
              if (f.isDehydrated) if (f = { element: d, isDehydrated: false, cache: g.cache, pendingSuspenseBoundaries: g.pendingSuspenseBoundaries, transitions: g.transitions }, b.updateQueue.baseState = f, b.memoizedState = f, b.flags & 256) {
                e = Ji(Error(p(423)), b);
                b = lj(a, b, d, c, e);
                break a;
              } else if (d !== e) {
                e = Ji(Error(p(424)), b);
                b = lj(a, b, d, c, e);
                break a;
              } else for (yg = Lf(b.stateNode.containerInfo.firstChild), xg = b, I = true, zg = null, c = Vg(b, null, d, c), b.child = c; c; ) c.flags = c.flags & -3 | 4096, c = c.sibling;
              else {
                Ig();
                if (d === e) {
                  b = Zi(a, b, c);
                  break a;
                }
                Xi(a, b, d, c);
              }
              b = b.child;
            }
            return b;
          case 5:
            return Ah(b), null === a && Eg(b), d = b.type, e = b.pendingProps, f = null !== a ? a.memoizedProps : null, g = e.children, Ef(d, e) ? g = null : null !== f && Ef(d, f) && (b.flags |= 32), gj(a, b), Xi(a, b, g, c), b.child;
          case 6:
            return null === a && Eg(b), null;
          case 13:
            return oj(a, b, c);
          case 4:
            return yh(b, b.stateNode.containerInfo), d = b.pendingProps, null === a ? b.child = Ug(b, null, d, c) : Xi(a, b, d, c), b.child;
          case 11:
            return d = b.type, e = b.pendingProps, e = b.elementType === d ? e : Ci(d, e), Yi(a, b, d, e, c);
          case 7:
            return Xi(a, b, b.pendingProps, c), b.child;
          case 8:
            return Xi(a, b, b.pendingProps.children, c), b.child;
          case 12:
            return Xi(a, b, b.pendingProps.children, c), b.child;
          case 10:
            a: {
              d = b.type._context;
              e = b.pendingProps;
              f = b.memoizedProps;
              g = e.value;
              G(Wg, d._currentValue);
              d._currentValue = g;
              if (null !== f) if (He(f.value, g)) {
                if (f.children === e.children && !Wf.current) {
                  b = Zi(a, b, c);
                  break a;
                }
              } else for (f = b.child, null !== f && (f.return = b); null !== f; ) {
                var h = f.dependencies;
                if (null !== h) {
                  g = f.child;
                  for (var k = h.firstContext; null !== k; ) {
                    if (k.context === d) {
                      if (1 === f.tag) {
                        k = mh(-1, c & -c);
                        k.tag = 2;
                        var l = f.updateQueue;
                        if (null !== l) {
                          l = l.shared;
                          var m = l.pending;
                          null === m ? k.next = k : (k.next = m.next, m.next = k);
                          l.pending = k;
                        }
                      }
                      f.lanes |= c;
                      k = f.alternate;
                      null !== k && (k.lanes |= c);
                      bh(
                        f.return,
                        c,
                        b
                      );
                      h.lanes |= c;
                      break;
                    }
                    k = k.next;
                  }
                } else if (10 === f.tag) g = f.type === b.type ? null : f.child;
                else if (18 === f.tag) {
                  g = f.return;
                  if (null === g) throw Error(p(341));
                  g.lanes |= c;
                  h = g.alternate;
                  null !== h && (h.lanes |= c);
                  bh(g, c, b);
                  g = f.sibling;
                } else g = f.child;
                if (null !== g) g.return = f;
                else for (g = f; null !== g; ) {
                  if (g === b) {
                    g = null;
                    break;
                  }
                  f = g.sibling;
                  if (null !== f) {
                    f.return = g.return;
                    g = f;
                    break;
                  }
                  g = g.return;
                }
                f = g;
              }
              Xi(a, b, e.children, c);
              b = b.child;
            }
            return b;
          case 9:
            return e = b.type, d = b.pendingProps.children, ch(b, c), e = eh(e), d = d(e), b.flags |= 1, Xi(a, b, d, c), b.child;
          case 14:
            return d = b.type, e = Ci(d, b.pendingProps), e = Ci(d.type, e), $i(a, b, d, e, c);
          case 15:
            return bj(a, b, b.type, b.pendingProps, c);
          case 17:
            return d = b.type, e = b.pendingProps, e = b.elementType === d ? e : Ci(d, e), ij(a, b), b.tag = 1, Zf(d) ? (a = true, cg(b)) : a = false, ch(b, c), Gi(b, d, e), Ii(b, d, e, c), jj(null, b, d, true, a, c);
          case 19:
            return xj(a, b, c);
          case 22:
            return dj(a, b, c);
        }
        throw Error(p(156, b.tag));
      };
      function Fk(a, b) {
        return ac(a, b);
      }
      function $k(a, b, c, d) {
        this.tag = a;
        this.key = c;
        this.sibling = this.child = this.return = this.stateNode = this.type = this.elementType = null;
        this.index = 0;
        this.ref = null;
        this.pendingProps = b;
        this.dependencies = this.memoizedState = this.updateQueue = this.memoizedProps = null;
        this.mode = d;
        this.subtreeFlags = this.flags = 0;
        this.deletions = null;
        this.childLanes = this.lanes = 0;
        this.alternate = null;
      }
      function Bg(a, b, c, d) {
        return new $k(a, b, c, d);
      }
      function aj(a) {
        a = a.prototype;
        return !(!a || !a.isReactComponent);
      }
      function Zk(a) {
        if ("function" === typeof a) return aj(a) ? 1 : 0;
        if (void 0 !== a && null !== a) {
          a = a.$$typeof;
          if (a === Da) return 11;
          if (a === Ga) return 14;
        }
        return 2;
      }
      function Pg(a, b) {
        var c = a.alternate;
        null === c ? (c = Bg(a.tag, b, a.key, a.mode), c.elementType = a.elementType, c.type = a.type, c.stateNode = a.stateNode, c.alternate = a, a.alternate = c) : (c.pendingProps = b, c.type = a.type, c.flags = 0, c.subtreeFlags = 0, c.deletions = null);
        c.flags = a.flags & 14680064;
        c.childLanes = a.childLanes;
        c.lanes = a.lanes;
        c.child = a.child;
        c.memoizedProps = a.memoizedProps;
        c.memoizedState = a.memoizedState;
        c.updateQueue = a.updateQueue;
        b = a.dependencies;
        c.dependencies = null === b ? null : { lanes: b.lanes, firstContext: b.firstContext };
        c.sibling = a.sibling;
        c.index = a.index;
        c.ref = a.ref;
        return c;
      }
      function Rg(a, b, c, d, e, f) {
        var g = 2;
        d = a;
        if ("function" === typeof a) aj(a) && (g = 1);
        else if ("string" === typeof a) g = 5;
        else a: switch (a) {
          case ya:
            return Tg(c.children, e, f, b);
          case za:
            g = 8;
            e |= 8;
            break;
          case Aa:
            return a = Bg(12, c, b, e | 2), a.elementType = Aa, a.lanes = f, a;
          case Ea:
            return a = Bg(13, c, b, e), a.elementType = Ea, a.lanes = f, a;
          case Fa:
            return a = Bg(19, c, b, e), a.elementType = Fa, a.lanes = f, a;
          case Ia:
            return pj(c, e, f, b);
          default:
            if ("object" === typeof a && null !== a) switch (a.$$typeof) {
              case Ba:
                g = 10;
                break a;
              case Ca:
                g = 9;
                break a;
              case Da:
                g = 11;
                break a;
              case Ga:
                g = 14;
                break a;
              case Ha:
                g = 16;
                d = null;
                break a;
            }
            throw Error(p(130, null == a ? a : typeof a, ""));
        }
        b = Bg(g, c, b, e);
        b.elementType = a;
        b.type = d;
        b.lanes = f;
        return b;
      }
      function Tg(a, b, c, d) {
        a = Bg(7, a, d, b);
        a.lanes = c;
        return a;
      }
      function pj(a, b, c, d) {
        a = Bg(22, a, d, b);
        a.elementType = Ia;
        a.lanes = c;
        a.stateNode = { isHidden: false };
        return a;
      }
      function Qg(a, b, c) {
        a = Bg(6, a, null, b);
        a.lanes = c;
        return a;
      }
      function Sg(a, b, c) {
        b = Bg(4, null !== a.children ? a.children : [], a.key, b);
        b.lanes = c;
        b.stateNode = { containerInfo: a.containerInfo, pendingChildren: null, implementation: a.implementation };
        return b;
      }
      function al(a, b, c, d, e) {
        this.tag = b;
        this.containerInfo = a;
        this.finishedWork = this.pingCache = this.current = this.pendingChildren = null;
        this.timeoutHandle = -1;
        this.callbackNode = this.pendingContext = this.context = null;
        this.callbackPriority = 0;
        this.eventTimes = zc(0);
        this.expirationTimes = zc(-1);
        this.entangledLanes = this.finishedLanes = this.mutableReadLanes = this.expiredLanes = this.pingedLanes = this.suspendedLanes = this.pendingLanes = 0;
        this.entanglements = zc(0);
        this.identifierPrefix = d;
        this.onRecoverableError = e;
        this.mutableSourceEagerHydrationData = null;
      }
      function bl(a, b, c, d, e, f, g, h, k) {
        a = new al(a, b, c, h, k);
        1 === b ? (b = 1, true === f && (b |= 8)) : b = 0;
        f = Bg(3, null, null, b);
        a.current = f;
        f.stateNode = a;
        f.memoizedState = { element: d, isDehydrated: c, cache: null, transitions: null, pendingSuspenseBoundaries: null };
        kh(f);
        return a;
      }
      function cl(a, b, c) {
        var d = 3 < arguments.length && void 0 !== arguments[3] ? arguments[3] : null;
        return { $$typeof: wa, key: null == d ? null : "" + d, children: a, containerInfo: b, implementation: c };
      }
      function dl(a) {
        if (!a) return Vf;
        a = a._reactInternals;
        a: {
          if (Vb(a) !== a || 1 !== a.tag) throw Error(p(170));
          var b = a;
          do {
            switch (b.tag) {
              case 3:
                b = b.stateNode.context;
                break a;
              case 1:
                if (Zf(b.type)) {
                  b = b.stateNode.__reactInternalMemoizedMergedChildContext;
                  break a;
                }
            }
            b = b.return;
          } while (null !== b);
          throw Error(p(171));
        }
        if (1 === a.tag) {
          var c = a.type;
          if (Zf(c)) return bg(a, c, b);
        }
        return b;
      }
      function el(a, b, c, d, e, f, g, h, k) {
        a = bl(c, d, true, a, e, f, g, h, k);
        a.context = dl(null);
        c = a.current;
        d = R();
        e = yi(c);
        f = mh(d, e);
        f.callback = void 0 !== b && null !== b ? b : null;
        nh(c, f, e);
        a.current.lanes = e;
        Ac(a, e, d);
        Dk(a, d);
        return a;
      }
      function fl(a, b, c, d) {
        var e = b.current, f = R(), g = yi(e);
        c = dl(c);
        null === b.context ? b.context = c : b.pendingContext = c;
        b = mh(f, g);
        b.payload = { element: a };
        d = void 0 === d ? null : d;
        null !== d && (b.callback = d);
        a = nh(e, b, g);
        null !== a && (gi(a, e, g, f), oh(a, e, g));
        return g;
      }
      function gl(a) {
        a = a.current;
        if (!a.child) return null;
        switch (a.child.tag) {
          case 5:
            return a.child.stateNode;
          default:
            return a.child.stateNode;
        }
      }
      function hl(a, b) {
        a = a.memoizedState;
        if (null !== a && null !== a.dehydrated) {
          var c = a.retryLane;
          a.retryLane = 0 !== c && c < b ? c : b;
        }
      }
      function il(a, b) {
        hl(a, b);
        (a = a.alternate) && hl(a, b);
      }
      function jl() {
        return null;
      }
      var kl = "function" === typeof reportError ? reportError : function(a) {
        console.error(a);
      };
      function ll(a) {
        this._internalRoot = a;
      }
      ml.prototype.render = ll.prototype.render = function(a) {
        var b = this._internalRoot;
        if (null === b) throw Error(p(409));
        fl(a, b, null, null);
      };
      ml.prototype.unmount = ll.prototype.unmount = function() {
        var a = this._internalRoot;
        if (null !== a) {
          this._internalRoot = null;
          var b = a.containerInfo;
          Rk(function() {
            fl(null, a, null, null);
          });
          b[uf] = null;
        }
      };
      function ml(a) {
        this._internalRoot = a;
      }
      ml.prototype.unstable_scheduleHydration = function(a) {
        if (a) {
          var b = Hc();
          a = { blockedOn: null, target: a, priority: b };
          for (var c = 0; c < Qc.length && 0 !== b && b < Qc[c].priority; c++) ;
          Qc.splice(c, 0, a);
          0 === c && Vc(a);
        }
      };
      function nl(a) {
        return !(!a || 1 !== a.nodeType && 9 !== a.nodeType && 11 !== a.nodeType);
      }
      function ol(a) {
        return !(!a || 1 !== a.nodeType && 9 !== a.nodeType && 11 !== a.nodeType && (8 !== a.nodeType || " react-mount-point-unstable " !== a.nodeValue));
      }
      function pl() {
      }
      function ql(a, b, c, d, e) {
        if (e) {
          if ("function" === typeof d) {
            var f = d;
            d = function() {
              var a2 = gl(g);
              f.call(a2);
            };
          }
          var g = el(b, d, a, 0, null, false, false, "", pl);
          a._reactRootContainer = g;
          a[uf] = g.current;
          sf(8 === a.nodeType ? a.parentNode : a);
          Rk();
          return g;
        }
        for (; e = a.lastChild; ) a.removeChild(e);
        if ("function" === typeof d) {
          var h = d;
          d = function() {
            var a2 = gl(k);
            h.call(a2);
          };
        }
        var k = bl(a, 0, false, null, null, false, false, "", pl);
        a._reactRootContainer = k;
        a[uf] = k.current;
        sf(8 === a.nodeType ? a.parentNode : a);
        Rk(function() {
          fl(b, k, c, d);
        });
        return k;
      }
      function rl(a, b, c, d, e) {
        var f = c._reactRootContainer;
        if (f) {
          var g = f;
          if ("function" === typeof e) {
            var h = e;
            e = function() {
              var a2 = gl(g);
              h.call(a2);
            };
          }
          fl(b, g, a, e);
        } else g = ql(c, b, a, e, d);
        return gl(g);
      }
      Ec = function(a) {
        switch (a.tag) {
          case 3:
            var b = a.stateNode;
            if (b.current.memoizedState.isDehydrated) {
              var c = tc(b.pendingLanes);
              0 !== c && (Cc(b, c | 1), Dk(b, B()), 0 === (K & 6) && (Gj = B() + 500, jg()));
            }
            break;
          case 13:
            Rk(function() {
              var b2 = ih(a, 1);
              if (null !== b2) {
                var c2 = R();
                gi(b2, a, 1, c2);
              }
            }), il(a, 1);
        }
      };
      Fc = function(a) {
        if (13 === a.tag) {
          var b = ih(a, 134217728);
          if (null !== b) {
            var c = R();
            gi(b, a, 134217728, c);
          }
          il(a, 134217728);
        }
      };
      Gc = function(a) {
        if (13 === a.tag) {
          var b = yi(a), c = ih(a, b);
          if (null !== c) {
            var d = R();
            gi(c, a, b, d);
          }
          il(a, b);
        }
      };
      Hc = function() {
        return C2;
      };
      Ic = function(a, b) {
        var c = C2;
        try {
          return C2 = a, b();
        } finally {
          C2 = c;
        }
      };
      yb = function(a, b, c) {
        switch (b) {
          case "input":
            bb(a, c);
            b = c.name;
            if ("radio" === c.type && null != b) {
              for (c = a; c.parentNode; ) c = c.parentNode;
              c = c.querySelectorAll("input[name=" + JSON.stringify("" + b) + '][type="radio"]');
              for (b = 0; b < c.length; b++) {
                var d = c[b];
                if (d !== a && d.form === a.form) {
                  var e = Db(d);
                  if (!e) throw Error(p(90));
                  Wa(d);
                  bb(d, e);
                }
              }
            }
            break;
          case "textarea":
            ib(a, c);
            break;
          case "select":
            b = c.value, null != b && fb(a, !!c.multiple, b, false);
        }
      };
      Gb = Qk;
      Hb = Rk;
      var sl = { usingClientEntryPoint: false, Events: [Cb, ue, Db, Eb, Fb, Qk] };
      var tl = { findFiberByHostInstance: Wc, bundleType: 0, version: "18.3.1", rendererPackageName: "react-dom" };
      var ul = { bundleType: tl.bundleType, version: tl.version, rendererPackageName: tl.rendererPackageName, rendererConfig: tl.rendererConfig, overrideHookState: null, overrideHookStateDeletePath: null, overrideHookStateRenamePath: null, overrideProps: null, overridePropsDeletePath: null, overridePropsRenamePath: null, setErrorHandler: null, setSuspenseHandler: null, scheduleUpdate: null, currentDispatcherRef: ua.ReactCurrentDispatcher, findHostInstanceByFiber: function(a) {
        a = Zb(a);
        return null === a ? null : a.stateNode;
      }, findFiberByHostInstance: tl.findFiberByHostInstance || jl, findHostInstancesForRefresh: null, scheduleRefresh: null, scheduleRoot: null, setRefreshHandler: null, getCurrentFiber: null, reconcilerVersion: "18.3.1-next-f1338f8080-20240426" };
      if ("undefined" !== typeof __REACT_DEVTOOLS_GLOBAL_HOOK__) {
        vl = __REACT_DEVTOOLS_GLOBAL_HOOK__;
        if (!vl.isDisabled && vl.supportsFiber) try {
          kc = vl.inject(ul), lc = vl;
        } catch (a) {
        }
      }
      var vl;
      exports.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED = sl;
      exports.createPortal = function(a, b) {
        var c = 2 < arguments.length && void 0 !== arguments[2] ? arguments[2] : null;
        if (!nl(b)) throw Error(p(200));
        return cl(a, b, null, c);
      };
      exports.createRoot = function(a, b) {
        if (!nl(a)) throw Error(p(299));
        var c = false, d = "", e = kl;
        null !== b && void 0 !== b && (true === b.unstable_strictMode && (c = true), void 0 !== b.identifierPrefix && (d = b.identifierPrefix), void 0 !== b.onRecoverableError && (e = b.onRecoverableError));
        b = bl(a, 1, false, null, null, c, false, d, e);
        a[uf] = b.current;
        sf(8 === a.nodeType ? a.parentNode : a);
        return new ll(b);
      };
      exports.findDOMNode = function(a) {
        if (null == a) return null;
        if (1 === a.nodeType) return a;
        var b = a._reactInternals;
        if (void 0 === b) {
          if ("function" === typeof a.render) throw Error(p(188));
          a = Object.keys(a).join(",");
          throw Error(p(268, a));
        }
        a = Zb(b);
        a = null === a ? null : a.stateNode;
        return a;
      };
      exports.flushSync = function(a) {
        return Rk(a);
      };
      exports.hydrate = function(a, b, c) {
        if (!ol(b)) throw Error(p(200));
        return rl(null, a, b, true, c);
      };
      exports.hydrateRoot = function(a, b, c) {
        if (!nl(a)) throw Error(p(405));
        var d = null != c && c.hydratedSources || null, e = false, f = "", g = kl;
        null !== c && void 0 !== c && (true === c.unstable_strictMode && (e = true), void 0 !== c.identifierPrefix && (f = c.identifierPrefix), void 0 !== c.onRecoverableError && (g = c.onRecoverableError));
        b = el(b, null, a, 1, null != c ? c : null, e, false, f, g);
        a[uf] = b.current;
        sf(a);
        if (d) for (a = 0; a < d.length; a++) c = d[a], e = c._getVersion, e = e(c._source), null == b.mutableSourceEagerHydrationData ? b.mutableSourceEagerHydrationData = [c, e] : b.mutableSourceEagerHydrationData.push(
          c,
          e
        );
        return new ml(b);
      };
      exports.render = function(a, b, c) {
        if (!ol(b)) throw Error(p(200));
        return rl(null, a, b, false, c);
      };
      exports.unmountComponentAtNode = function(a) {
        if (!ol(a)) throw Error(p(40));
        return a._reactRootContainer ? (Rk(function() {
          rl(null, null, a, false, function() {
            a._reactRootContainer = null;
            a[uf] = null;
          });
        }), true) : false;
      };
      exports.unstable_batchedUpdates = Qk;
      exports.unstable_renderSubtreeIntoContainer = function(a, b, c, d) {
        if (!ol(c)) throw Error(p(200));
        if (null == a || void 0 === a._reactInternals) throw Error(p(38));
        return rl(a, b, c, false, d);
      };
      exports.version = "18.3.1-next-f1338f8080-20240426";
    }
  });

  // node_modules/react-dom/index.js
  var require_react_dom = __commonJS({
    "node_modules/react-dom/index.js"(exports, module) {
      "use strict";
      function checkDCE() {
        if (typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ === "undefined" || typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE !== "function") {
          return;
        }
        if (false) {
          throw new Error("^_^");
        }
        try {
          __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(checkDCE);
        } catch (err) {
          console.error(err);
        }
      }
      if (true) {
        checkDCE();
        module.exports = require_react_dom_production_min();
      } else {
        module.exports = null;
      }
    }
  });

  // node_modules/react-dom/client.js
  var require_client = __commonJS({
    "node_modules/react-dom/client.js"(exports) {
      "use strict";
      var m = require_react_dom();
      if (true) {
        exports.createRoot = m.createRoot;
        exports.hydrateRoot = m.hydrateRoot;
      } else {
        i = m.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
        exports.createRoot = function(c, o) {
          i.usingClientEntryPoint = true;
          try {
            return m.createRoot(c, o);
          } finally {
            i.usingClientEntryPoint = false;
          }
        };
        exports.hydrateRoot = function(c, h, o) {
          i.usingClientEntryPoint = true;
          try {
            return m.hydrateRoot(c, h, o);
          } finally {
            i.usingClientEntryPoint = false;
          }
        };
      }
      var i;
    }
  });

  // node_modules/react/cjs/react-jsx-runtime.production.min.js
  var require_react_jsx_runtime_production_min = __commonJS({
    "node_modules/react/cjs/react-jsx-runtime.production.min.js"(exports) {
      "use strict";
      var f = require_react();
      var k = Symbol.for("react.element");
      var l = Symbol.for("react.fragment");
      var m = Object.prototype.hasOwnProperty;
      var n = f.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentOwner;
      var p = { key: true, ref: true, __self: true, __source: true };
      function q(c, a, g) {
        var b, d = {}, e = null, h = null;
        void 0 !== g && (e = "" + g);
        void 0 !== a.key && (e = "" + a.key);
        void 0 !== a.ref && (h = a.ref);
        for (b in a) m.call(a, b) && !p.hasOwnProperty(b) && (d[b] = a[b]);
        if (c && c.defaultProps) for (b in a = c.defaultProps, a) void 0 === d[b] && (d[b] = a[b]);
        return { $$typeof: k, type: c, key: e, ref: h, props: d, _owner: n.current };
      }
      exports.Fragment = l;
      exports.jsx = q;
      exports.jsxs = q;
    }
  });

  // node_modules/react/jsx-runtime.js
  var require_jsx_runtime = __commonJS({
    "node_modules/react/jsx-runtime.js"(exports, module) {
      "use strict";
      if (true) {
        module.exports = require_react_jsx_runtime_production_min();
      } else {
        module.exports = null;
      }
    }
  });

  // src/main.jsx
  var import_react41 = __toESM(require_react(), 1);
  var import_client = __toESM(require_client(), 1);

  // src/app/App.jsx
  var import_react40 = __toESM(require_react(), 1);

  // src/app/i18n.jsx
  var import_react = __toESM(require_react(), 1);
  var import_jsx_runtime = __toESM(require_jsx_runtime(), 1);
  var LangCtx = import_react.default.createContext({ lang: "zh", setLang: () => {
  } });
  var KEY = "ae_mcp_panel_lang";
  function LangProvider({ children }) {
    const [lang, setLangState] = import_react.default.useState(() => {
      try {
        const v = window.localStorage.getItem(KEY);
        if (v === "zh" || v === "en") return v;
      } catch (e) {
      }
      return /^zh/i.test(navigator.language || "") ? "zh" : "en";
    });
    const setLang = (v) => {
      setLangState(v);
      try {
        window.localStorage.setItem(KEY, v);
      } catch (e) {
      }
    };
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(LangCtx.Provider, { value: { lang, setLang }, children });
  }
  var useLang = () => import_react.default.useContext(LangCtx);

  // src/components/shell/StatusBar.jsx
  var import_react7 = __toESM(require_react(), 1);

  // src/components/core/Icon.jsx
  var import_react4 = __toESM(require_react(), 1);

  // node_modules/lucide-react/dist/esm/createLucideIcon.js
  var import_react3 = __toESM(require_react());

  // node_modules/lucide-react/dist/esm/shared/src/utils.js
  var toKebabCase = (string) => string.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  var mergeClasses = (...classes) => classes.filter((className, index, array) => {
    return Boolean(className) && array.indexOf(className) === index;
  }).join(" ");

  // node_modules/lucide-react/dist/esm/Icon.js
  var import_react2 = __toESM(require_react());

  // node_modules/lucide-react/dist/esm/defaultAttributes.js
  var defaultAttributes = {
    xmlns: "http://www.w3.org/2000/svg",
    width: 24,
    height: 24,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round"
  };

  // node_modules/lucide-react/dist/esm/Icon.js
  var Icon = (0, import_react2.forwardRef)(
    ({
      color = "currentColor",
      size = 24,
      strokeWidth = 2,
      absoluteStrokeWidth,
      className = "",
      children,
      iconNode,
      ...rest
    }, ref) => {
      return (0, import_react2.createElement)(
        "svg",
        {
          ref,
          ...defaultAttributes,
          width: size,
          height: size,
          stroke: color,
          strokeWidth: absoluteStrokeWidth ? Number(strokeWidth) * 24 / Number(size) : strokeWidth,
          className: mergeClasses("lucide", className),
          ...rest
        },
        [
          ...iconNode.map(([tag, attrs]) => (0, import_react2.createElement)(tag, attrs)),
          ...Array.isArray(children) ? children : [children]
        ]
      );
    }
  );

  // node_modules/lucide-react/dist/esm/createLucideIcon.js
  var createLucideIcon = (iconName, iconNode) => {
    const Component = (0, import_react3.forwardRef)(
      ({ className, ...props }, ref) => (0, import_react3.createElement)(Icon, {
        ref,
        iconNode,
        className: mergeClasses(`lucide-${toKebabCase(iconName)}`, className),
        ...props
      })
    );
    Component.displayName = `${iconName}`;
    return Component;
  };

  // node_modules/lucide-react/dist/esm/icons/arrow-up.js
  var ArrowUp = createLucideIcon("ArrowUp", [
    ["path", { d: "m5 12 7-7 7 7", key: "hav0vg" }],
    ["path", { d: "M12 19V5", key: "x0mq9r" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/book-open.js
  var BookOpen = createLucideIcon("BookOpen", [
    ["path", { d: "M12 7v14", key: "1akyts" }],
    [
      "path",
      {
        d: "M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z",
        key: "ruj8y"
      }
    ]
  ]);

  // node_modules/lucide-react/dist/esm/icons/box.js
  var Box = createLucideIcon("Box", [
    [
      "path",
      {
        d: "M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z",
        key: "hh9hay"
      }
    ],
    ["path", { d: "m3.3 7 8.7 5 8.7-5", key: "g66t2b" }],
    ["path", { d: "M12 22V12", key: "d0xqtd" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/brain.js
  var Brain = createLucideIcon("Brain", [
    [
      "path",
      {
        d: "M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z",
        key: "l5xja"
      }
    ],
    [
      "path",
      {
        d: "M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z",
        key: "ep3f8r"
      }
    ],
    ["path", { d: "M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4", key: "1p4c4q" }],
    ["path", { d: "M17.599 6.5a3 3 0 0 0 .399-1.375", key: "tmeiqw" }],
    ["path", { d: "M6.003 5.125A3 3 0 0 0 6.401 6.5", key: "105sqy" }],
    ["path", { d: "M3.477 10.896a4 4 0 0 1 .585-.396", key: "ql3yin" }],
    ["path", { d: "M19.938 10.5a4 4 0 0 1 .585.396", key: "1qfode" }],
    ["path", { d: "M6 18a4 4 0 0 1-1.967-.516", key: "2e4loj" }],
    ["path", { d: "M19.967 17.484A4 4 0 0 1 18 18", key: "159ez6" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/check.js
  var Check = createLucideIcon("Check", [["path", { d: "M20 6 9 17l-5-5", key: "1gmf2c" }]]);

  // node_modules/lucide-react/dist/esm/icons/chevron-down.js
  var ChevronDown = createLucideIcon("ChevronDown", [
    ["path", { d: "m6 9 6 6 6-6", key: "qrunsl" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/chevron-right.js
  var ChevronRight = createLucideIcon("ChevronRight", [
    ["path", { d: "m9 18 6-6-6-6", key: "mthhwq" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/circle-alert.js
  var CircleAlert = createLucideIcon("CircleAlert", [
    ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
    ["line", { x1: "12", x2: "12", y1: "8", y2: "12", key: "1pkeuh" }],
    ["line", { x1: "12", x2: "12.01", y1: "16", y2: "16", key: "4dfq90" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/circle-slash.js
  var CircleSlash = createLucideIcon("CircleSlash", [
    ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
    ["line", { x1: "9", x2: "15", y1: "15", y2: "9", key: "1dfufj" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/circle.js
  var Circle = createLucideIcon("Circle", [
    ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/copy.js
  var Copy = createLucideIcon("Copy", [
    ["rect", { width: "14", height: "14", x: "8", y: "8", rx: "2", ry: "2", key: "17jyea" }],
    ["path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2", key: "zix9uf" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/download.js
  var Download = createLucideIcon("Download", [
    ["path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", key: "ih7n3h" }],
    ["polyline", { points: "7 10 12 15 17 10", key: "2ggqvy" }],
    ["line", { x1: "12", x2: "12", y1: "15", y2: "3", key: "1vk2je" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/external-link.js
  var ExternalLink = createLucideIcon("ExternalLink", [
    ["path", { d: "M15 3h6v6", key: "1q9fwt" }],
    ["path", { d: "M10 14 21 3", key: "gplh6r" }],
    ["path", { d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6", key: "a6xqqp" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/eye-off.js
  var EyeOff = createLucideIcon("EyeOff", [
    [
      "path",
      {
        d: "M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49",
        key: "ct8e1f"
      }
    ],
    ["path", { d: "M14.084 14.158a3 3 0 0 1-4.242-4.242", key: "151rxh" }],
    [
      "path",
      {
        d: "M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143",
        key: "13bj9a"
      }
    ],
    ["path", { d: "m2 2 20 20", key: "1ooewy" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/eye.js
  var Eye = createLucideIcon("Eye", [
    [
      "path",
      {
        d: "M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0",
        key: "1nclc0"
      }
    ],
    ["circle", { cx: "12", cy: "12", r: "3", key: "1v7zrd" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/file-text.js
  var FileText = createLucideIcon("FileText", [
    ["path", { d: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", key: "1rqfz7" }],
    ["path", { d: "M14 2v4a2 2 0 0 0 2 2h4", key: "tnqrlb" }],
    ["path", { d: "M10 9H8", key: "b1mrlr" }],
    ["path", { d: "M16 13H8", key: "t4e002" }],
    ["path", { d: "M16 17H8", key: "z1uh3a" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/github.js
  var Github = createLucideIcon("Github", [
    [
      "path",
      {
        d: "M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4",
        key: "tonef"
      }
    ],
    ["path", { d: "M9 18c-4.51 2-5-2-7-2", key: "9comsn" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/globe.js
  var Globe = createLucideIcon("Globe", [
    ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
    ["path", { d: "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20", key: "13o1zl" }],
    ["path", { d: "M2 12h20", key: "9i4pu4" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/history.js
  var History = createLucideIcon("History", [
    ["path", { d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", key: "1357e3" }],
    ["path", { d: "M3 3v5h5", key: "1xhq8a" }],
    ["path", { d: "M12 7v5l4 2", key: "1fdv2h" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/info.js
  var Info = createLucideIcon("Info", [
    ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
    ["path", { d: "M12 16v-4", key: "1dtifu" }],
    ["path", { d: "M12 8h.01", key: "e9boi3" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/list-checks.js
  var ListChecks = createLucideIcon("ListChecks", [
    ["path", { d: "m3 17 2 2 4-4", key: "1jhpwq" }],
    ["path", { d: "m3 7 2 2 4-4", key: "1obspn" }],
    ["path", { d: "M13 6h8", key: "15sg57" }],
    ["path", { d: "M13 12h8", key: "h98zly" }],
    ["path", { d: "M13 18h8", key: "oe0vm4" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/list.js
  var List = createLucideIcon("List", [
    ["path", { d: "M3 12h.01", key: "nlz23k" }],
    ["path", { d: "M3 18h.01", key: "1tta3j" }],
    ["path", { d: "M3 6h.01", key: "1rqtza" }],
    ["path", { d: "M8 12h13", key: "1za7za" }],
    ["path", { d: "M8 18h13", key: "1lx6n3" }],
    ["path", { d: "M8 6h13", key: "ik3vkj" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/message-square.js
  var MessageSquare = createLucideIcon("MessageSquare", [
    ["path", { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z", key: "1lielz" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/pause.js
  var Pause = createLucideIcon("Pause", [
    ["rect", { x: "14", y: "4", width: "4", height: "16", rx: "1", key: "zuxfzm" }],
    ["rect", { x: "6", y: "4", width: "4", height: "16", rx: "1", key: "1okwgv" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/play.js
  var Play = createLucideIcon("Play", [
    ["polygon", { points: "6 3 20 12 6 21 6 3", key: "1oa8hb" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/plug.js
  var Plug = createLucideIcon("Plug", [
    ["path", { d: "M12 22v-5", key: "1ega77" }],
    ["path", { d: "M9 8V2", key: "14iosj" }],
    ["path", { d: "M15 8V2", key: "18g5xt" }],
    ["path", { d: "M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z", key: "osxo6l" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/plus.js
  var Plus = createLucideIcon("Plus", [
    ["path", { d: "M5 12h14", key: "1ays0h" }],
    ["path", { d: "M12 5v14", key: "s699le" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/rotate-cw.js
  var RotateCw = createLucideIcon("RotateCw", [
    ["path", { d: "M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8", key: "1p45f6" }],
    ["path", { d: "M21 3v5h-5", key: "1q7to0" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/search.js
  var Search = createLucideIcon("Search", [
    ["circle", { cx: "11", cy: "11", r: "8", key: "4ej97u" }],
    ["path", { d: "m21 21-4.3-4.3", key: "1qie3q" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/send.js
  var Send = createLucideIcon("Send", [
    [
      "path",
      {
        d: "M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z",
        key: "1ffxy3"
      }
    ],
    ["path", { d: "m21.854 2.147-10.94 10.939", key: "12cjpa" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/settings.js
  var Settings = createLucideIcon("Settings", [
    [
      "path",
      {
        d: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
        key: "1qme2f"
      }
    ],
    ["circle", { cx: "12", cy: "12", r: "3", key: "1v7zrd" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/shield-alert.js
  var ShieldAlert = createLucideIcon("ShieldAlert", [
    [
      "path",
      {
        d: "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
        key: "oel41y"
      }
    ],
    ["path", { d: "M12 8v4", key: "1got3b" }],
    ["path", { d: "M12 16h.01", key: "1drbdi" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/shield.js
  var Shield = createLucideIcon("Shield", [
    [
      "path",
      {
        d: "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
        key: "oel41y"
      }
    ]
  ]);

  // node_modules/lucide-react/dist/esm/icons/sparkles.js
  var Sparkles = createLucideIcon("Sparkles", [
    [
      "path",
      {
        d: "M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z",
        key: "4pj2yx"
      }
    ],
    ["path", { d: "M20 3v4", key: "1olli1" }],
    ["path", { d: "M22 5h-4", key: "1gvqau" }],
    ["path", { d: "M4 17v2", key: "vumght" }],
    ["path", { d: "M5 18H3", key: "zchphs" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/square.js
  var Square = createLucideIcon("Square", [
    ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "afitv7" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/stethoscope.js
  var Stethoscope = createLucideIcon("Stethoscope", [
    ["path", { d: "M11 2v2", key: "1539x4" }],
    ["path", { d: "M5 2v2", key: "1yf1q8" }],
    ["path", { d: "M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1", key: "rb5t3r" }],
    ["path", { d: "M8 15a6 6 0 0 0 12 0v-3", key: "x18d4x" }],
    ["circle", { cx: "20", cy: "10", r: "2", key: "ts1r5v" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/trash-2.js
  var Trash2 = createLucideIcon("Trash2", [
    ["path", { d: "M3 6h18", key: "d0wm0j" }],
    ["path", { d: "M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6", key: "4alrt4" }],
    ["path", { d: "M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2", key: "v07s0e" }],
    ["line", { x1: "10", x2: "10", y1: "11", y2: "17", key: "1uufr5" }],
    ["line", { x1: "14", x2: "14", y1: "11", y2: "17", key: "xtxkd" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/triangle-alert.js
  var TriangleAlert = createLucideIcon("TriangleAlert", [
    [
      "path",
      {
        d: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3",
        key: "wmoenq"
      }
    ],
    ["path", { d: "M12 9v4", key: "juzpu7" }],
    ["path", { d: "M12 17h.01", key: "p32p05" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/undo-2.js
  var Undo2 = createLucideIcon("Undo2", [
    ["path", { d: "M9 14 4 9l5-5", key: "102s5s" }],
    ["path", { d: "M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11", key: "f3b9sd" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/x.js
  var X = createLucideIcon("X", [
    ["path", { d: "M18 6 6 18", key: "1bl5f8" }],
    ["path", { d: "m6 6 12 12", key: "d8bk6v" }]
  ]);

  // node_modules/lucide-react/dist/esm/icons/zap.js
  var Zap = createLucideIcon("Zap", [
    [
      "path",
      {
        d: "M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z",
        key: "1xq2db"
      }
    ]
  ]);

  // src/components/core/Icon.jsx
  var import_jsx_runtime2 = __toESM(require_jsx_runtime(), 1);
  var MAP = {
    sparkles: Sparkles,
    pause: Pause,
    play: Play,
    shield: Shield,
    "shield-alert": ShieldAlert,
    "undo-2": Undo2,
    plug: Plug,
    check: Check,
    x: X,
    "circle-slash": CircleSlash,
    stethoscope: Stethoscope,
    "chevron-down": ChevronDown,
    "chevron-right": ChevronRight,
    settings: Settings,
    copy: Copy,
    "rotate-cw": RotateCw,
    "triangle-alert": TriangleAlert,
    search: Search,
    send: Send,
    square: Square,
    plus: Plus,
    eye: Eye,
    "eye-off": EyeOff,
    "external-link": ExternalLink,
    "file-text": FileText,
    "trash-2": Trash2,
    history: History,
    "message-square": MessageSquare,
    "list-checks": ListChecks,
    globe: Globe,
    list: List,
    download: Download,
    "book-open": BookOpen,
    github: Github,
    "arrow-up": ArrowUp,
    "circle-alert": CircleAlert,
    info: Info,
    circle: Circle,
    box: Box,
    brain: Brain,
    zap: Zap
  };
  function Icon2({ name, size = 14, strokeWidth = 1.75, color = "currentColor", style }) {
    const C2 = MAP[name];
    if (!C2) return null;
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(C2, { size, strokeWidth, color, style, "aria-hidden": "true" });
  }

  // src/components/core/StatusDot.jsx
  var import_react5 = __toESM(require_react(), 1);
  var import_jsx_runtime3 = __toESM(require_jsx_runtime(), 1);
  var DOT_COLORS = {
    connected: "var(--ok)",
    waiting: "var(--neutral-status)",
    error: "var(--error)",
    paused: "var(--warn)"
  };
  function StatusDot({ status = "waiting", size = 8, style }) {
    if (status === "paused") {
      return /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(Icon2, { name: "pause", size: size + 4, strokeWidth: 2.5, color: DOT_COLORS.paused, style });
    }
    return /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
      "span",
      {
        style: {
          width: size,
          height: size,
          flex: "none",
          borderRadius: "50%",
          background: DOT_COLORS[status] || DOT_COLORS.waiting,
          animation: status === "waiting" ? "ds-pulse 1.6s var(--ease-in-out) infinite" : void 0,
          boxShadow: status === "error" ? "0 0 0 3px var(--error-bg)" : void 0,
          ...style
        }
      }
    );
  }

  // src/components/core/IconButton.jsx
  var import_react6 = __toESM(require_react(), 1);
  var import_jsx_runtime4 = __toESM(require_jsx_runtime(), 1);
  function IconButton({
    icon,
    title,
    size = "md",
    variant = "ghost",
    active = false,
    danger = false,
    disabled = false,
    onClick,
    style
  }) {
    const [hover, setHover] = import_react6.default.useState(false);
    const [press, setPress] = import_react6.default.useState(false);
    const px = size === "lg" ? 28 : 24;
    const color = danger ? "var(--error)" : active || hover && !disabled ? "var(--text-primary)" : "var(--text-secondary)";
    const bg = disabled ? "transparent" : press ? "var(--bg-active)" : active ? "var(--bg-active)" : hover ? "var(--bg-hover)" : "transparent";
    return /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      "button",
      {
        type: "button",
        className: "ds-focusable",
        title,
        "aria-label": title,
        "aria-pressed": active || void 0,
        disabled,
        onClick,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => {
          setHover(false);
          setPress(false);
        },
        onMouseDown: () => setPress(true),
        onMouseUp: () => setPress(false),
        style: {
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: px,
          height: px,
          flex: "none",
          padding: 0,
          background: bg,
          color,
          border: variant === "secondary" ? "1px solid var(--border-strong)" : "1px solid transparent",
          borderRadius: "var(--radius-md)",
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.45 : 1,
          transition: "background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)",
          ...style
        },
        children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Icon2, { name: icon, size: size === "lg" ? 16 : 14 })
      }
    );
  }

  // src/components/shell/StatusBar.jsx
  var import_jsx_runtime5 = __toESM(require_jsx_runtime(), 1);
  function StatusBar({
    status = "waiting",
    label,
    onStatusClick,
    onTogglePause,
    onSettings,
    pauseTitle = "\u6682\u505C\u6240\u6709 AI \u64CD\u4F5C Pause all AI actions",
    resumeTitle = "\u6062\u590D Resume",
    settingsTitle = "\u8BBE\u7F6E Settings",
    style
  }) {
    const [hover, setHover] = import_react7.default.useState(false);
    const paused = status === "paused";
    return /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)(
      "div",
      {
        style: {
          height: "var(--statusbar-h)",
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: "var(--space-1)",
          padding: "0 var(--space-15) 0 var(--space-1)",
          background: "var(--bg-panel)",
          borderBottom: `1px solid ${paused ? "var(--warn-border)" : "var(--border-default)"}`,
          ...style
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)(
            "button",
            {
              type: "button",
              className: "ds-focusable",
              onClick: onStatusClick,
              onMouseEnter: () => setHover(true),
              onMouseLeave: () => setHover(false),
              style: {
                display: "flex",
                alignItems: "center",
                gap: "var(--space-15)",
                height: 26,
                padding: "0 var(--space-2)",
                minWidth: 0,
                background: hover ? "var(--bg-hover)" : "transparent",
                border: "none",
                borderRadius: "var(--radius-md)",
                cursor: "pointer",
                transition: "background var(--dur-fast) var(--ease-out)"
              },
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(StatusDot, { status }),
                /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
                  "span",
                  {
                    style: {
                      font: `var(--weight-medium) var(--text-body)/1 var(--font-ui)`,
                      color: paused ? "var(--warn)" : "var(--text-primary)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis"
                    },
                    children: label
                  }
                ),
                /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(Icon2, { name: "chevron-down", size: 11, color: "var(--text-tertiary)" })
              ]
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { style: { flex: 1 } }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(PauseButton, { paused, title: paused ? resumeTitle : pauseTitle, onClick: onTogglePause }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(IconButton, { icon: "settings", title: settingsTitle, onClick: onSettings })
        ]
      }
    );
  }
  function PauseButton({ paused, title, onClick }) {
    const [hover, setHover] = import_react7.default.useState(false);
    return /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
      "button",
      {
        type: "button",
        className: "ds-focusable",
        title,
        "aria-label": title,
        "aria-pressed": paused,
        onClick,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          width: 24,
          height: 24,
          flex: "none",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          background: paused ? "var(--warn-bg)" : hover ? "var(--bg-hover)" : "transparent",
          color: paused ? "var(--warn)" : hover ? "var(--text-primary)" : "var(--text-secondary)",
          border: paused ? "1px solid var(--warn-border)" : "1px solid transparent",
          borderRadius: "var(--radius-md)",
          cursor: "pointer",
          transition: "background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)"
        },
        children: /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(Icon2, { name: paused ? "play" : "pause", size: 13, strokeWidth: 2.25 })
      }
    );
  }

  // src/components/shell/TabBar.jsx
  var import_react8 = __toESM(require_react(), 1);
  var import_jsx_runtime6 = __toESM(require_jsx_runtime(), 1);
  function TabBar({ tabs = [], active, onChange, style }) {
    return /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
      "div",
      {
        role: "tablist",
        style: {
          height: "var(--tabbar-h)",
          flex: "none",
          display: "grid",
          gridTemplateColumns: `repeat(${tabs.length || 1}, 1fr)`,
          background: "var(--bg-panel)",
          borderTop: "1px solid var(--border-default)",
          ...style
        },
        children: tabs.map((tab) => /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(Tab, { tab, selected: tab.id === active, onSelect: () => onChange && onChange(tab.id) }, tab.id))
      }
    );
  }
  function Tab({ tab, selected, onSelect }) {
    const [hover, setHover] = import_react8.default.useState(false);
    return /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)(
      "button",
      {
        type: "button",
        role: "tab",
        "aria-selected": selected,
        className: "ds-focusable",
        onClick: onSelect,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          position: "relative",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 2,
          padding: 0,
          background: hover && !selected ? "var(--bg-hover)" : "transparent",
          border: "none",
          color: selected ? "var(--text-primary)" : hover ? "var(--text-secondary)" : "var(--text-tertiary)",
          cursor: "pointer",
          transition: "background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)"
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
            "span",
            {
              style: {
                position: "absolute",
                top: -1,
                left: "25%",
                right: "25%",
                height: 2,
                background: selected ? "var(--gray-11)" : "transparent",
                transition: "background var(--dur-fast) var(--ease-out)"
              }
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("span", { style: { position: "relative" }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(Icon2, { name: tab.icon, size: 14 }),
            tab.dot ? /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("span", { style: { position: "absolute", top: -2, right: -4, width: 5, height: 5, borderRadius: "50%", background: "var(--warn)" } }) : null
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("span", { style: { font: `var(--weight-medium) var(--text-micro)/1 var(--font-ui)` }, children: tab.label })
        ]
      }
    );
  }

  // src/components/shell/EmptyState.jsx
  var import_react9 = __toESM(require_react(), 1);
  var import_jsx_runtime7 = __toESM(require_jsx_runtime(), 1);
  function EmptyState({ icon = "inbox", title, caption, action, compact = false, style }) {
    return /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(
      "div",
      {
        style: {
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "var(--space-2)",
          padding: compact ? "var(--space-4)" : "var(--space-6) var(--space-4)",
          textAlign: "center",
          ...style
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(
            "span",
            {
              style: {
                width: compact ? 36 : 48,
                height: compact ? 36 : 48,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                background: "var(--bg-well)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "50%"
              },
              children: /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Icon2, { name: icon, size: compact ? 16 : 20, strokeWidth: 1.5, color: "var(--text-tertiary)" })
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("div", { style: { font: `var(--weight-medium) var(--text-heading)/var(--leading-tight) var(--font-ui)`, color: "var(--text-secondary)" }, children: title }),
          caption ? /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("div", { style: { maxWidth: 240, font: `var(--weight-regular) var(--text-caption)/var(--leading-normal) var(--font-ui)`, color: "var(--text-tertiary)" }, children: caption }) : null,
          action ? /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("div", { style: { marginTop: "var(--space-1)" }, children: action }) : null
        ]
      }
    );
  }

  // src/components/shell/ConfirmDialog.jsx
  var import_react11 = __toESM(require_react(), 1);

  // src/components/core/Button.jsx
  var import_react10 = __toESM(require_react(), 1);
  var import_jsx_runtime8 = __toESM(require_jsx_runtime(), 1);
  var BTN_H = { sm: 20, md: 24, lg: 28 };
  var BTN_PAD = { sm: 8, md: 10, lg: 12 };
  var VARIANTS = {
    primary: {
      base: { background: "var(--gray-11)", color: "var(--text-on-solid)", border: "1px solid transparent" },
      hover: { background: "#ffffff" },
      press: { background: "var(--gray-10)" }
    },
    secondary: {
      base: { background: "transparent", color: "var(--text-primary)", border: "1px solid var(--border-strong)" },
      hover: { background: "var(--bg-hover)" },
      press: { background: "var(--bg-active)" }
    },
    ghost: {
      base: { background: "transparent", color: "var(--text-secondary)", border: "1px solid transparent" },
      hover: { background: "var(--bg-hover)", color: "var(--text-primary)" },
      press: { background: "var(--bg-active)", color: "var(--text-primary)" }
    },
    danger: {
      base: { background: "var(--error-bg)", color: "var(--error)", border: "1px solid var(--error-border)" },
      hover: { background: "rgba(248, 81, 73, 0.2)" },
      press: { background: "rgba(248, 81, 73, 0.26)" }
    },
    accent: {
      base: { background: "var(--accent)", color: "var(--text-on-solid)", border: "1px solid transparent" },
      hover: { background: "var(--accent-hover)" },
      press: { background: "var(--accent-press)" }
    }
  };
  function Button({
    variant = "secondary",
    size = "md",
    icon,
    children,
    disabled = false,
    full = false,
    onClick,
    title,
    style
  }) {
    const [hover, setHover] = import_react10.default.useState(false);
    const [press, setPress] = import_react10.default.useState(false);
    const v = VARIANTS[variant] || VARIANTS.secondary;
    const state = disabled ? {} : press ? { ...v.hover, ...v.press } : hover ? v.hover : {};
    return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)(
      "button",
      {
        type: "button",
        className: "ds-focusable",
        title,
        disabled,
        onClick,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => {
          setHover(false);
          setPress(false);
        },
        onMouseDown: () => setPress(true),
        onMouseUp: () => setPress(false),
        style: {
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          height: BTN_H[size] || BTN_H.md,
          minHeight: size === "sm" ? void 0 : "var(--hit-min)",
          padding: `0 ${BTN_PAD[size] || 10}px`,
          width: full ? "100%" : void 0,
          borderRadius: "var(--radius-md)",
          font: `var(--weight-medium) var(--text-body)/1 var(--font-ui)`,
          whiteSpace: "nowrap",
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.45 : 1,
          transition: "background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)",
          ...v.base,
          ...state,
          ...style
        },
        children: [
          icon ? /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Icon2, { name: icon, size: size === "sm" ? 12 : 14 }) : null,
          children
        ]
      }
    );
  }

  // src/components/shell/ConfirmDialog.jsx
  var import_jsx_runtime9 = __toESM(require_jsx_runtime(), 1);
  function ConfirmDialog({
    open = false,
    title,
    body,
    confirmLabel = "\u786E\u8BA4",
    cancelLabel = "\u53D6\u6D88",
    danger = false,
    onConfirm,
    onCancel,
    style
  }) {
    if (!open) return null;
    return /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)("div", { style: { position: "absolute", inset: 0, zIndex: 40, display: "flex", alignItems: "center", justifyContent: "center", padding: "var(--space-4)" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
        "div",
        {
          onClick: onCancel,
          style: { position: "absolute", inset: 0, background: "var(--scrim)", animation: "ds-fade var(--dur-slow) var(--ease-out)" }
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)(
        "div",
        {
          role: "alertdialog",
          "aria-label": typeof title === "string" ? title : void 0,
          style: {
            position: "relative",
            width: "100%",
            maxWidth: 280,
            padding: "var(--space-3)",
            background: "var(--bg-overlay)",
            border: "1px solid var(--border-strong)",
            borderRadius: "var(--radius-lg)",
            boxShadow: "var(--shadow-overlay)",
            animation: "ds-fade-up var(--dur-slow) var(--ease-out)",
            ...style
          },
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("div", { style: { font: `var(--weight-semibold) var(--text-heading)/var(--leading-tight) var(--font-ui)`, color: "var(--text-primary)" }, children: title }),
            body ? /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("div", { style: { marginTop: "var(--space-15)", font: `var(--weight-regular) var(--text-caption)/var(--leading-normal) var(--font-ui)`, color: "var(--text-secondary)" }, children: body }) : null,
            /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)("div", { style: { display: "flex", justifyContent: "flex-end", gap: "var(--space-15)", marginTop: "var(--space-3)" }, children: [
              /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Button, { variant: "ghost", onClick: onCancel, children: cancelLabel }),
              /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Button, { variant: danger ? "danger" : "primary", onClick: onConfirm, children: confirmLabel })
            ] })
          ]
        }
      )
    ] });
  }

  // src/screens/SettingsScreen.jsx
  var import_react19 = __toESM(require_react(), 1);

  // package.json
  var package_default = {
    name: "ae-mcp-panel",
    version: "0.9.0",
    private: true,
    type: "module",
    scripts: {
      build: "node build.mjs",
      watch: "node build.mjs --watch",
      test: "node --test"
    },
    dependencies: {
      "lucide-react": "0.453.0",
      react: "18.3.1",
      "react-dom": "18.3.1"
    },
    devDependencies: {
      esbuild: "0.24.2"
    }
  };

  // src/components/core/Badge.jsx
  var import_react12 = __toESM(require_react(), 1);
  var import_jsx_runtime10 = __toESM(require_jsx_runtime(), 1);
  var BADGE_COLORS = {
    ok: { color: "var(--ok)", background: "var(--ok-bg)", borderColor: "var(--ok-border)" },
    warn: { color: "var(--warn)", background: "var(--warn-bg)", borderColor: "var(--warn-border)" },
    error: { color: "var(--error)", background: "var(--error-bg)", borderColor: "var(--error-border)" },
    accent: { color: "var(--accent)", background: "var(--accent-bg)", borderColor: "var(--accent-border)" },
    neutral: { color: "var(--text-secondary)", background: "var(--bg-hover)", borderColor: "var(--border-strong)" }
  };
  function Badge({ status = "neutral", icon, dot = false, children, style }) {
    const c = BADGE_COLORS[status] || BADGE_COLORS.neutral;
    return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)(
      "span",
      {
        style: {
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          height: 16,
          padding: "0 6px",
          borderRadius: "var(--radius-sm)",
          border: `1px solid ${c.borderColor}`,
          background: c.background,
          color: c.color,
          font: `var(--weight-medium) var(--text-micro)/1 var(--font-ui)`,
          whiteSpace: "nowrap",
          ...style
        },
        children: [
          dot ? /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("span", { style: { width: 5, height: 5, borderRadius: "50%", background: "currentColor", flex: "none" } }) : null,
          icon ? /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Icon2, { name: icon, size: 10, strokeWidth: 2 }) : null,
          children
        ]
      }
    );
  }

  // src/components/core/Switch.jsx
  var import_react13 = __toESM(require_react(), 1);
  var import_jsx_runtime11 = __toESM(require_jsx_runtime(), 1);
  function Switch({ checked = false, onChange, disabled = false, title, style }) {
    const [hover, setHover] = import_react13.default.useState(false);
    return /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(
      "button",
      {
        type: "button",
        role: "switch",
        "aria-checked": checked,
        className: "ds-focusable",
        title,
        disabled,
        onClick: () => onChange && onChange(!checked),
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          display: "inline-flex",
          alignItems: "center",
          width: 28,
          height: 16,
          flex: "none",
          padding: 2,
          margin: "4px 0",
          /* pads the 16px control to a ≥24px hit area */
          background: checked ? hover && !disabled ? "#ffffff" : "var(--gray-11)" : hover && !disabled ? "var(--gray-8)" : "var(--gray-7)",
          border: "none",
          borderRadius: "var(--radius-full)",
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.45 : 1,
          transition: "background var(--dur-fast) var(--ease-out)",
          ...style
        },
        children: /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(
          "span",
          {
            style: {
              width: 12,
              height: 12,
              borderRadius: "var(--radius-full)",
              background: checked ? "var(--gray-3)" : "var(--gray-10)",
              transform: checked ? "translateX(12px)" : "translateX(0)",
              transition: "transform var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out)"
            }
          }
        )
      }
    );
  }

  // src/components/core/Segmented.jsx
  var import_react14 = __toESM(require_react(), 1);
  var import_jsx_runtime12 = __toESM(require_jsx_runtime(), 1);
  function Segmented({ options = [], value, onChange, full = false, style }) {
    return /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(
      "div",
      {
        role: "radiogroup",
        style: {
          display: full ? "flex" : "inline-flex",
          gap: 2,
          padding: 2,
          background: "var(--bg-well)",
          border: "1px solid var(--border-default)",
          borderRadius: "var(--radius-md)",
          ...style
        },
        children: options.map((opt) => {
          const selected = opt.value === value;
          return /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(SegmentedOption, { opt, selected, full, onSelect: () => onChange && onChange(opt.value) }, opt.value);
        })
      }
    );
  }
  function SegmentedOption({ opt, selected, full, onSelect }) {
    const [hover, setHover] = import_react14.default.useState(false);
    return /* @__PURE__ */ (0, import_jsx_runtime12.jsxs)(
      "button",
      {
        type: "button",
        role: "radio",
        "aria-checked": selected,
        className: "ds-focusable",
        onClick: onSelect,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          flex: full ? 1 : void 0,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 5,
          height: 20,
          padding: "0 8px",
          background: selected ? "var(--gray-5)" : hover ? "var(--bg-hover)" : "transparent",
          color: selected ? "var(--text-primary)" : hover ? "var(--text-secondary)" : "var(--text-tertiary)",
          border: selected ? "1px solid var(--border-strong)" : "1px solid transparent",
          borderRadius: "var(--radius-sm)",
          font: `var(--weight-medium) var(--text-caption)/1 var(--font-ui)`,
          whiteSpace: "nowrap",
          cursor: "pointer",
          transition: "background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)"
        },
        children: [
          opt.icon ? /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(Icon2, { name: opt.icon, size: 12 }) : null,
          opt.label
        ]
      }
    );
  }

  // src/components/settings/ChannelCard.jsx
  var import_react15 = __toESM(require_react(), 1);

  // src/lib/channelCard.js
  function channelDot(probe) {
    if (!probe || probe.checking) return "neutral";
    return probe.ok ? "ok" : "warn";
  }
  function channelTexts(probe, lang = "zh") {
    const pick = (obj) => obj ? obj[lang] || obj.zh || "" : "";
    return {
      source: pick(probe && probe.source),
      detail: probe && probe.detail || "",
      fixHint: probe && !probe.ok && !probe.checking ? pick(probe.fixHint) : ""
    };
  }
  var LOCK_TEXTS = {
    locked: { zh: "\u5DF2\u9501\u5B9A", en: "Locked" },
    unlocked: { zh: "\u9501\u5B9A", en: "Lock" }
  };
  function lockLabel(channel, lockedChannel, lang = "zh") {
    const texts = channel === lockedChannel ? LOCK_TEXTS.locked : LOCK_TEXTS.unlocked;
    return texts[lang] || texts.zh;
  }

  // src/components/settings/ChannelCard.jsx
  var import_jsx_runtime13 = __toESM(require_jsx_runtime(), 1);
  var DOT_COLOR = { ok: "var(--ok)", warn: "var(--warn)", neutral: "var(--text-tertiary)" };
  function ChannelDot({ token }) {
    return /* @__PURE__ */ (0, import_jsx_runtime13.jsx)("span", { style: { width: 8, height: 8, flex: "none", borderRadius: "50%", background: DOT_COLOR[token] || DOT_COLOR.neutral } });
  }
  function ChannelCard({
    lang = "zh",
    channels = [],
    activeChannel = "",
    lockedChannel = "",
    onLockChannel,
    onRecheck,
    recheckLabel,
    recheckDisabled = false,
    readOnly = false,
    renderChannelBody
  }) {
    return /* @__PURE__ */ (0, import_jsx_runtime13.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 6 }, children: [
      channels.map((probe) => {
        const texts = channelTexts(probe, lang);
        const isActive = probe.channel === activeChannel;
        return /* @__PURE__ */ (0, import_jsx_runtime13.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 6, padding: "8px 10px", border: `1px solid ${isActive ? "var(--border-strong)" : "var(--border-subtle)"}`, borderRadius: "var(--radius-md)", background: "var(--bg-well)" }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime13.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 8 }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime13.jsx)(ChannelDot, { token: channelDot(probe) }),
            /* @__PURE__ */ (0, import_jsx_runtime13.jsx)(Badge, { status: channelDot(probe), children: texts.source }),
            texts.detail ? /* @__PURE__ */ (0, import_jsx_runtime13.jsx)("span", { style: { flex: 1, minWidth: 0, font: "400 10px/1.35 var(--font-mono)", color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: texts.detail }) : /* @__PURE__ */ (0, import_jsx_runtime13.jsx)("span", { style: { flex: 1 } }),
            !readOnly && onLockChannel ? /* @__PURE__ */ (0, import_jsx_runtime13.jsx)(Button, { variant: "ghost", size: "sm", onClick: () => onLockChannel(probe.channel === lockedChannel ? "" : probe.channel), children: lockLabel(probe.channel, lockedChannel, lang) }) : null
          ] }),
          texts.fixHint ? /* @__PURE__ */ (0, import_jsx_runtime13.jsx)("div", { style: { font: "400 10px/1.5 var(--font-ui)", color: "var(--text-tertiary)", whiteSpace: "pre-wrap" }, children: texts.fixHint }) : null,
          !readOnly && renderChannelBody ? renderChannelBody(probe.channel) : null
        ] }, probe.channel);
      }),
      !readOnly && onRecheck ? /* @__PURE__ */ (0, import_jsx_runtime13.jsx)("div", { style: { display: "flex", justifyContent: "flex-end" }, children: /* @__PURE__ */ (0, import_jsx_runtime13.jsx)(Button, { variant: "secondary", icon: "rotate-cw", disabled: recheckDisabled, onClick: onRecheck, children: recheckLabel }) }) : null
    ] });
  }

  // src/components/forms/Input.jsx
  var import_react16 = __toESM(require_react(), 1);
  var import_jsx_runtime14 = __toESM(require_jsx_runtime(), 1);
  function Input({
    value,
    onChange,
    placeholder,
    type = "text",
    secret = false,
    mono = false,
    disabled = false,
    error = false,
    size = "md",
    suffix,
    full = true,
    style
  }) {
    const [focus, setFocus] = import_react16.default.useState(false);
    const [revealed, setRevealed] = import_react16.default.useState(false);
    const h = size === "lg" ? 28 : 24;
    return /* @__PURE__ */ (0, import_jsx_runtime14.jsxs)(
      "span",
      {
        style: {
          display: full ? "flex" : "inline-flex",
          alignItems: "center",
          gap: 4,
          height: h,
          padding: "0 2px 0 8px",
          background: "var(--bg-well)",
          border: `1px solid ${error ? "var(--error-border)" : focus ? "var(--border-strong)" : "var(--border-default)"}`,
          boxShadow: focus ? "0 0 0 1px var(--focus-ring)" : "none",
          borderRadius: "var(--radius-md)",
          opacity: disabled ? 0.45 : 1,
          transition: "border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)",
          ...style
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime14.jsx)(
            "input",
            {
              type: secret && !revealed ? "password" : type === "password" ? "text" : type,
              value,
              placeholder,
              disabled,
              onChange: (e) => onChange && onChange(e.target.value),
              onFocus: () => setFocus(true),
              onBlur: () => setFocus(false),
              style: {
                flex: 1,
                minWidth: 0,
                background: "transparent",
                border: "none",
                outline: "none",
                padding: 0,
                color: error ? "var(--error)" : "var(--text-primary)",
                font: `var(--weight-regular) ${mono || secret ? "var(--text-caption)" : "var(--text-body)"}/1 ${mono || secret ? "var(--font-mono)" : "var(--font-ui)"}`
              }
            }
          ),
          secret ? /* @__PURE__ */ (0, import_jsx_runtime14.jsx)(
            IconButton,
            {
              icon: revealed ? "eye-off" : "eye",
              title: revealed ? "Hide" : "Show",
              onClick: () => setRevealed(!revealed),
              style: { width: 20, height: 20 }
            }
          ) : null,
          suffix
        ]
      }
    );
  }

  // src/components/forms/Select.jsx
  var import_react17 = __toESM(require_react(), 1);
  var import_jsx_runtime15 = __toESM(require_jsx_runtime(), 1);
  function Select({ options = [], value, onChange, disabled = false, full = true, size = "md", style }) {
    const [focus, setFocus] = import_react17.default.useState(false);
    const h = size === "lg" ? 28 : 24;
    return /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)(
      "span",
      {
        style: {
          position: "relative",
          display: full ? "flex" : "inline-flex",
          alignItems: "center",
          height: h,
          background: "var(--bg-well)",
          border: `1px solid ${focus ? "var(--border-strong)" : "var(--border-default)"}`,
          boxShadow: focus ? "0 0 0 1px var(--focus-ring)" : "none",
          borderRadius: "var(--radius-md)",
          opacity: disabled ? 0.45 : 1,
          transition: "border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)",
          ...style
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime15.jsx)(
            "select",
            {
              value,
              disabled,
              onChange: (e) => onChange && onChange(e.target.value),
              onFocus: () => setFocus(true),
              onBlur: () => setFocus(false),
              style: {
                flex: 1,
                minWidth: 0,
                height: "100%",
                appearance: "none",
                WebkitAppearance: "none",
                background: "transparent",
                border: "none",
                outline: "none",
                padding: "0 22px 0 8px",
                color: "var(--text-primary)",
                font: `var(--weight-regular) var(--text-body)/1 var(--font-ui)`,
                cursor: disabled ? "default" : "pointer"
              },
              children: options.map((opt) => /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("option", { value: opt.value, style: { background: "var(--bg-overlay)", color: "var(--text-primary)" }, children: opt.label }, opt.value))
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime15.jsx)(
            Icon2,
            {
              name: "chevron-down",
              size: 12,
              color: "var(--text-tertiary)",
              style: { position: "absolute", right: 6, pointerEvents: "none" }
            }
          )
        ]
      }
    );
  }

  // src/components/forms/Field.jsx
  var import_react18 = __toESM(require_react(), 1);
  var import_jsx_runtime16 = __toESM(require_jsx_runtime(), 1);
  function Field({ label, hint, caption, layout = "stack", children, style }) {
    if (layout === "row") {
      return /* @__PURE__ */ (0, import_jsx_runtime16.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: "var(--space-2)", minHeight: "var(--hit-min)", ...style }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime16.jsxs)("div", { style: { flex: 1, minWidth: 0 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime16.jsx)("div", { style: { font: `var(--weight-regular) var(--text-body)/var(--leading-tight) var(--font-ui)`, color: "var(--text-primary)" }, children: label }),
          caption ? /* @__PURE__ */ (0, import_jsx_runtime16.jsx)("div", { style: { font: `var(--weight-regular) var(--text-caption)/var(--leading-tight) var(--font-ui)`, color: "var(--text-tertiary)", marginTop: 2 }, children: caption }) : null
        ] }),
        children
      ] });
    }
    return /* @__PURE__ */ (0, import_jsx_runtime16.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: "var(--space-1)", ...style }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime16.jsxs)("div", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "var(--space-2)" }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime16.jsx)("label", { style: { font: `var(--weight-medium) var(--text-caption)/var(--leading-tight) var(--font-ui)`, color: "var(--text-secondary)" }, children: label }),
        hint ? /* @__PURE__ */ (0, import_jsx_runtime16.jsx)("span", { style: { font: `var(--weight-regular) var(--text-caption)/var(--leading-tight) var(--font-ui)`, color: "var(--text-tertiary)" }, children: hint }) : null
      ] }),
      children,
      caption ? /* @__PURE__ */ (0, import_jsx_runtime16.jsx)("div", { style: { font: `var(--weight-regular) var(--text-caption)/var(--leading-normal) var(--font-ui)`, color: "var(--text-tertiary)" }, children: caption }) : null
    ] });
  }

  // src/cep/externalClients.js
  var EXTERNAL_CLIENTS = [
    {
      id: "claude-desktop",
      name: "Claude Desktop",
      kind: "mcp-stdio",
      installHint: "Install Claude Desktop and open its MCP server settings.",
      loginHint: "Sign in to Claude Desktop before starting the handshake.",
      docsUrl: "https://support.anthropic.com/en/articles/10949351-getting-started-with-model-context-protocol-mcp-on-claude-for-desktop"
    },
    {
      id: "claude-code",
      name: "Claude Code",
      kind: "mcp-stdio",
      installHint: "Install Claude Code and add ae-mcp as a local MCP server.",
      loginHint: "Run claude /login if Claude Code is not signed in.",
      docsUrl: "https://docs.anthropic.com/en/docs/claude-code/mcp"
    },
    {
      id: "cursor",
      name: "Cursor",
      kind: "mcp-stdio",
      installHint: "Open Cursor MCP settings and add this server config.",
      loginHint: "Restart Cursor after saving MCP settings.",
      docsUrl: "https://docs.cursor.com/context/model-context-protocol"
    },
    {
      id: "openclaw",
      name: "OpenClaw",
      kind: "mcp-doc",
      installHint: "Follow the OpenClaw integration docs for adding external tools.",
      loginHint: "Use the account and runtime required by your OpenClaw deployment.",
      docsUrl: "https://github.com/bestK/OpenClaw",
      networkNote: "OpenClaw is often long-running or Dockerized. Keep it on the same machine / \u540C\u673A as After Effects, or make sure it can reach 127.0.0.1:11488. MCP-client support is unverified; ae may need to be wrapped as an OpenClaw skill."
    },
    {
      id: "astrbot",
      name: "AstrBot",
      kind: "mcp-doc",
      installHint: "AstrBot v3.5.0+ can add multiple MCP servers from the panel.",
      loginHint: "Use the account and platform adapter required by your AstrBot deployment.",
      docsUrl: "https://docs.astrbot.app/",
      networkNote: "AstrBot is often long-running or Dockerized. Keep it on the same machine / \u540C\u673A as After Effects, or make sure it can reach 127.0.0.1:11488 before adding the MCP server in AstrBot v3.5.0+."
    },
    {
      id: "gemini-antigravity",
      name: "Gemini Antigravity",
      kind: "mcp-stdio",
      installHint: "Add ae-mcp as a local stdio MCP server in Gemini Antigravity.",
      loginHint: "Sign in to Gemini Antigravity before starting the handshake.",
      docsUrl: "https://ai.google.dev/gemini-api/docs"
    },
    {
      id: "opencode-external",
      name: "opencode",
      kind: "mcp-stdio",
      installHint: "Use this external opencode config when the embedded panel flow is blocked.",
      loginHint: "Sign in to opencode before starting the handshake.",
      docsUrl: "https://opencode.ai/docs"
    },
    {
      id: "zcode",
      name: "ZCode",
      kind: "mcp-stdio",
      installHint: "Add ae-mcp as a local MCP server in ~/.zcode/cli/config.json (mcp.servers).",
      loginHint: "Open ZCode and make sure its selected provider has an API key before starting.",
      docsUrl: "https://zcode.z.ai"
    }
  ];
  function expertGuidanceEnv(on) {
    return on ? {} : { AE_MCP_EXPERT_GUIDANCE: "0" };
  }
  function zcodeMcpConfig(port = 11488, expertGuidance = true) {
    return {
      mcp: {
        servers: {
          ae: {
            name: "ae",
            command: "ae-mcp",
            args: [],
            env: Object.assign(
              { AE_MCP_BACKEND: "ae-mcp" },
              expertGuidanceEnv(expertGuidance !== false),
              { AE_MCP_PLUGIN_URL: `http://127.0.0.1:${port}` }
            )
          }
        }
      }
    };
  }
  function mcpConfigFor(client, port = 11488, expertGuidance = true) {
    if (client && client.id === "zcode") return zcodeMcpConfig(port, expertGuidance);
    return {
      mcpServers: {
        ae: {
          command: "ae-mcp",
          env: {
            AE_MCP_BACKEND: "ae-mcp",
            ...expertGuidanceEnv(expertGuidance !== false),
            AE_MCP_PLUGIN_URL: `http://127.0.0.1:${port}`
          }
        }
      }
    };
  }

  // src/lib/clipboard.js
  function copyTextLegacy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (e) {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok ? Promise.resolve() : Promise.reject(new Error("execCommand copy failed"));
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(() => copyTextLegacy(text));
    }
    return copyTextLegacy(text);
  }

  // src/lib/settingsState.js
  function zcodeDefaultModelLocked({ backend, models }) {
    if (backend !== "zcode") return false;
    return !Array.isArray(models) || models.length <= 1;
  }
  function zcodeManagedModelLabel(lang, modelId) {
    const id = String(modelId || "").trim();
    if (!id) {
      return lang === "en" ? "Managed by the current ZCode session" : "\u7531 ZCode \u5F53\u524D\u4F1A\u8BDD\u7BA1\u7406";
    }
    return lang === "en" ? "Current model: " + id + " (managed by ZCode configuration)" : "\u5F53\u524D\u6A21\u578B\uFF1A" + id + "\uFF08\u7531 ZCode \u914D\u7F6E\u7BA1\u7406\uFF09";
  }

  // src/lib/settingsSections.js
  var KEY2 = "ae_mcp_settings_sections";
  var SECTION_IDS = ["ai", "conn", "externalClients", "sec", "gen", "about"];
  function defaultSectionState() {
    return { ai: true, conn: false, externalClients: false, sec: false, gen: false, about: false };
  }
  function loadSectionState(storage) {
    try {
      const raw = storage.getItem(KEY2);
      if (!raw) return defaultSectionState();
      const parsed = JSON.parse(raw);
      const state = defaultSectionState();
      for (const id of SECTION_IDS) {
        if (typeof parsed[id] === "boolean") state[id] = parsed[id];
      }
      return state;
    } catch (e) {
      return defaultSectionState();
    }
  }
  function saveSectionState(storage, state) {
    try {
      storage.setItem(KEY2, JSON.stringify(state));
    } catch (e) {
    }
  }
  function toggleSection(state, id) {
    return { ...state, [id]: !state[id] };
  }

  // src/screens/SettingsScreen.jsx
  var import_jsx_runtime17 = __toESM(require_jsx_runtime(), 1);
  var REPO_URL = "https://github.com/JUNKDOGE-JOE/after-effects-mcp";
  var DOCS_URL = "https://github.com/JUNKDOGE-JOE/after-effects-mcp#readme";
  function openExternal(url) {
    try {
      if (globalThis.window && window.cep && window.cep.util && window.cep.util.openURLInDefaultBrowser) {
        window.cep.util.openURLInDefaultBrowser(url);
        return;
      }
    } catch (e) {
    }
    try {
      window.open(url, "_blank");
    } catch (e) {
    }
  }
  var S = {
    zh: {
      ai: "AI \u670D\u52A1",
      conn: "\u8FDE\u63A5",
      externalClients: "\u5916\u63A5\u5BA2\u6237\u7AEF",
      externalClientsCap: "\u7ED9\u5E38\u89C1 MCP \u5BA2\u6237\u7AEF\u590D\u5236\u914D\u7F6E\uFF1B\u6587\u6863\u578B\u6846\u67B6\u6309\u5176\u63A5\u5165\u65B9\u5F0F\u914D\u7F6E\u3002",
      mcpStdio: "MCP stdio",
      mcpDoc: "\u6587\u6863\u63A5\u5165",
      openDocs: "\u6253\u5F00\u6587\u6863",
      sec: "\u5B89\u5168",
      gen: "\u901A\u7528",
      about: "\u5173\u4E8E",
      backend: "\u540E\u7AEF",
      backendSub: "Claude",
      backendCodex: "Codex",
      backendZcode: "ZCode",
      recheck: "\u91CD\u65B0\u68C0\u6D4B",
      providerNone: "\uFF08\u672A\u9009\u62E9 provider\uFF09",
      importClaudeSettings: "\u4ECE ~/.claude/settings.json \u5BFC\u5165",
      claude3pNote: "Claude-3p \u684C\u9762\u7248\u7684\u51ED\u636E\u65E0\u6CD5\u81EA\u52A8\u8BFB\u53D6\uFF1B\u8BF7\u5728 Provider \u7BA1\u7406\u91CC\u624B\u52A8\u586B\u5199\u4E00\u6B21 Base URL \u4E0E Token\u3002",
      zcodeKeyPlaceholder: "\u7C98\u8D34 provider API Key\uFF08\u5B58\u672C\u673A\uFF09",
      zcodeKeyStored: "\u5DF2\u4FDD\u5B58\u5230 ~/.ae-mcp/zcode-key\uFF0C\u53EF\u7C98\u8D34\u65B0\u503C\u8986\u76D6",
      save: "\u4FDD\u5B58",
      modelDefault: "\u9ED8\u8BA4\u6A21\u578B\uFF08\u6253\u5F00\u9762\u677F\u65F6\u4F7F\u7528\uFF09",
      customModel: "\u81EA\u5B9A\u4E49\u6A21\u578B ID",
      customModelCap: "\u53EF\u9009\uFF1B\u586B\u5199\u540E\u4F18\u5148\u7528\u4E8E Codex",
      zcodeModelManaged: "\u7531 ZCode \u5F53\u524D\u4F1A\u8BDD\u7BA1\u7406",
      port: "\u7AEF\u53E3",
      portHint: "\u9ED8\u8BA4 11488",
      apply: "\u5E94\u7528",
      token: "\u8BBF\u95EE Token",
      regen: "\u91CD\u65B0\u751F\u6210",
      tokenCap: "\u91CD\u65B0\u751F\u6210\u540E\u9700\u91CD\u542F\u4F60\u7684 AI \u5BA2\u6237\u7AEF",
      tokenMissing: "\u672A\u627E\u5230 ~/.ae-mcp/auth-token",
      clients: "\u5DF2\u8FDE\u63A5\u5BA2\u6237\u7AEF",
      lastActive: "\u6700\u540E\u6D3B\u8DC3",
      blocked: "\u5C4F\u853D",
      mins: (n) => `${n} \u5206\u949F\u524D`,
      hours: (n) => `${n} \u5C0F\u65F6\u524D`,
      language: "\u754C\u9762\u8BED\u8A00",
      expertGuidance: "AE \u4E13\u5BB6\u9632\u9519\u6307\u5BFC",
      expertGuidanceCap: "\u589E\u52A0\u6BCF\u4F1A\u8BDD\u4E00\u6B21\u6027\u63E1\u624B token\uFF0C\u6362\u66F4\u5C11\u7684 AE \u811A\u672C\u62A5\u9519",
      logLevel: "\u65E5\u5FD7\u7EA7\u522B",
      exportLog: "\u5BFC\u51FA\u65E5\u5FD7",
      mcp: "MCP \u914D\u7F6E",
      logs: "\u65E5\u5FD7",
      copy: "\u590D\u5236",
      copied: "\u5DF2\u590D\u5236",
      verPanel: "\u9762\u677F",
      verHost: "Host \u811A\u672C",
      verPy: "Python \u670D\u52A1",
      pending: "P3 \u63A5\u901A",
      docs: "\u6587\u6863",
      github: "GitHub",
      rerunWizard: "\u91CD\u65B0\u8FD0\u884C\u5411\u5BFC"
    },
    en: {
      ai: "AI service",
      conn: "Connection",
      externalClients: "External clients",
      externalClientsCap: "Copy config for common MCP clients; configure documentation-driven frameworks with their own flow.",
      mcpStdio: "MCP stdio",
      mcpDoc: "Docs",
      openDocs: "Open docs",
      sec: "Security",
      gen: "General",
      about: "About",
      backend: "Backend",
      backendSub: "Claude",
      backendCodex: "Codex",
      backendZcode: "ZCode",
      recheck: "Re-check",
      providerNone: "(no provider selected)",
      importClaudeSettings: "Import from ~/.claude/settings.json",
      claude3pNote: "Claude-3p desktop credentials cannot be read automatically; fill the base URL and token once in Provider Manager.",
      zcodeKeyPlaceholder: "Paste the provider API key (stored locally)",
      zcodeKeyStored: "Saved to ~/.ae-mcp/zcode-key; paste a new value to overwrite",
      save: "Save",
      modelDefault: "Default model (used when the panel opens)",
      customModel: "Custom model ID",
      customModelCap: "Optional; takes priority for Codex",
      zcodeModelManaged: "Managed by the current ZCode session",
      port: "Port",
      portHint: "Default 11488",
      apply: "Apply",
      token: "Access token",
      regen: "Regenerate",
      tokenCap: "Restart your AI client after regenerating.",
      tokenMissing: "~/.ae-mcp/auth-token not found",
      clients: "Connected clients",
      lastActive: "Last active",
      blocked: "Block",
      mins: (n) => `${n} min ago`,
      hours: (n) => `${n} h ago`,
      language: "Language",
      expertGuidance: "AE expert anti-error guidance",
      expertGuidanceCap: "Adds a one-time handshake token cost per session for fewer AE scripting errors",
      logLevel: "Log level",
      exportLog: "Export log",
      mcp: "MCP config",
      logs: "Logs",
      copy: "Copy",
      copied: "Copied",
      verPanel: "Panel",
      verHost: "Host script",
      verPy: "Python service",
      pending: "P3",
      docs: "Docs",
      github: "GitHub",
      rerunWizard: "Re-run setup wizard"
    }
  };
  function Section({ id, title, children, disabled, caption, expanded, onToggle }) {
    return /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: "var(--space-2)", opacity: disabled ? 0.45 : 1 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(
        "button",
        {
          type: "button",
          "aria-expanded": expanded,
          className: "ds-focusable",
          onClick: () => onToggle && onToggle(id),
          style: { display: "flex", alignItems: "center", gap: 6, width: "100%", background: "none", border: "none", padding: "0 0 2px", cursor: "pointer", borderBottom: "1px solid var(--border-subtle)", textAlign: "left" },
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Icon2, { name: expanded ? "chevron-down" : "chevron-right", size: 12, strokeWidth: 2, color: "var(--text-tertiary)" }),
            /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("span", { style: { font: "600 11px/1 var(--font-ui)", letterSpacing: "0.04em", color: "var(--text-tertiary)", textTransform: "uppercase" }, children: title })
          ]
        }
      ),
      expanded && caption ? /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("div", { style: { font: "400 10px/1.35 var(--font-ui)", color: "var(--text-tertiary)" }, children: caption }) : null,
      expanded ? children : null
    ] });
  }
  function ZcodeKeyFallback({ t, stored, onSave }) {
    const [draft, setDraft] = import_react19.default.useState("");
    return /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { style: { display: "flex", gap: 6, alignItems: "center" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Input, { secret: true, value: draft, onChange: setDraft, placeholder: stored ? t.zcodeKeyStored : t.zcodeKeyPlaceholder, style: { flex: 1 } }),
      /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Button, { variant: "primary", size: "sm", disabled: !draft.trim(), onClick: () => {
        if (onSave) onSave(draft.trim());
        setDraft("");
      }, children: t.save })
    ] });
  }
  function ClientRow({ name, lastActive, blocked, onBlock, blockLabel }) {
    return /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 8, minHeight: 32, padding: "2px 8px", background: "var(--bg-well)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-md)", opacity: blocked ? 0.55 : 1 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("span", { style: { flex: 1, minWidth: 0 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("span", { style: { display: "block", font: "500 12px/1.35 var(--font-ui)", color: "var(--text-primary)", textDecoration: blocked ? "line-through" : "none" }, children: name }),
        /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("span", { style: { display: "block", font: "400 10px/1.35 var(--font-ui)", color: "var(--text-tertiary)" }, children: lastActive })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("span", { style: { font: "400 10px/1 var(--font-ui)", color: "var(--text-tertiary)" }, children: blockLabel }),
      /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Switch, { checked: blocked, onChange: onBlock })
    ] });
  }
  function ExternalClientRow({ client, t, configText, copied, onCopy }) {
    const isStdio = client.kind === "mcp-stdio";
    return /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("details", { style: { border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-md)", background: "var(--bg-well)", padding: "7px 8px" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("summary", { style: { cursor: "pointer", listStyle: "none", display: "flex", alignItems: "center", gap: 8 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("span", { style: { flex: 1, minWidth: 0 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("span", { style: { display: "block", font: "500 12px/1.35 var(--font-ui)", color: "var(--text-primary)" }, children: client.name }),
          /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("span", { style: { display: "block", font: "400 10px/1.35 var(--font-ui)", color: "var(--text-tertiary)" }, children: isStdio ? t.mcpStdio : t.mcpDoc })
        ] }),
        isStdio ? /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Button, { variant: "secondary", size: "sm", icon: "copy", onClick: (e) => {
          e.preventDefault();
          onCopy();
        }, children: copied ? t.copied : t.copy }) : null
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }, children: [
        client.installHint ? /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("div", { style: { font: "400 10px/1.45 var(--font-ui)", color: "var(--text-secondary)" }, children: client.installHint }) : null,
        client.loginHint ? /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("div", { style: { font: "400 10px/1.45 var(--font-ui)", color: "var(--text-tertiary)" }, children: client.loginHint }) : null,
        isStdio ? /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("pre", { style: { margin: 0, maxHeight: 128, overflow: "auto", padding: 8, border: "1px solid var(--border-default)", borderRadius: "var(--radius-sm)", background: "var(--gray-0)", color: "var(--text-secondary)", font: "400 10px/1.4 var(--font-mono)", whiteSpace: "pre" }, children: configText }) : null,
        client.networkNote ? /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("div", { style: { font: "400 10px/1.45 var(--font-ui)", color: "var(--text-tertiary)" }, children: client.networkNote }) : null,
        /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("a", { href: client.docsUrl, target: "_blank", rel: "noreferrer", style: { font: "500 11px/1.35 var(--font-ui)", color: "var(--accent)" }, children: t.openDocs })
      ] })
    ] });
  }
  function VersionRow({ label, value, badge }) {
    return /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 8, minHeight: 24 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("span", { style: { flex: 1, font: "400 12px/1.35 var(--font-ui)", color: "var(--text-primary)" }, children: label }),
      badge,
      /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("span", { style: { font: "400 11px/1 var(--font-mono)", color: "var(--text-secondary)" }, children: value })
    ] });
  }
  function maskToken(value) {
    const v = String(value || "").trim();
    if (!v) return "";
    if (v.length <= 10) return "*".repeat(v.length);
    return v.slice(0, 7) + "*".repeat(Math.min(10, v.length - 11)) + v.slice(-4);
  }
  function cepRequire() {
    if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) return globalThis.window.cep_node.require;
    if (globalThis.window && globalThis.window.require) return globalThis.window.require;
    if (globalThis.require) return globalThis.require;
    return null;
  }
  function readTokenValue() {
    try {
      const req = cepRequire();
      if (!req) return "";
      const fs = req("fs");
      const path = req("path");
      const os = req("os");
      const tokenPath2 = path.join(os.homedir(), ".ae-mcp", "auth-token");
      return fs.readFileSync(tokenPath2, "utf8").trim();
    } catch (e) {
      return "";
    }
  }
  function formatLastSeen(ts, t) {
    if (!ts) return t.lastActive + " \xB7 -";
    const mins = Math.max(0, Math.round((Date.now() - ts) / 6e4));
    if (mins < 60) return `${t.lastActive} \xB7 ${t.mins(mins)}`;
    return `${t.lastActive} \xB7 ${t.hours(Math.round(mins / 60))}`;
  }
  function SettingsScreen({
    lang = "zh",
    onLangChange,
    port = 11488,
    onApplyPort,
    mcpConfig,
    logs = [],
    clients = [],
    onBlockClient,
    onRegenToken,
    hostVersion = "-",
    pythonVersion = "-",
    model = "claude-sonnet-4-6",
    modelOptions,
    modelSwitchable = true,
    onModelChange,
    customModel = "",
    onCustomModelChange,
    backend = "subscription",
    onBackendChange,
    expertGuidance = true,
    onExpertGuidance,
    channels = { claude: [], codex: [], zcode: [] },
    activeChannel = "",
    lockedChannel = "",
    onLockChannel,
    onRecheckBackend,
    recheckDisabled = false,
    providers = [],
    claudeProviderId = "",
    onClaudeProviderChange,
    codexProviderId = "",
    onCodexProviderChange,
    onImportClaudeSettings,
    claudeSettingsImportAvailable = false,
    onSaveZcodeKey,
    zcodeKeyStored = false,
    onSaveCodexKey,
    codexKeyStored = false,
    codexCliConfig = null,
    providerManager = null,
    logLevel = "info",
    onLogLevel,
    onExportLogs,
    onRerunWizard
  }) {
    const t = S[lang] || S.zh;
    const zcodeModelLocked = zcodeDefaultModelLocked({ backend, models: modelOptions });
    const [customModelDraft, setCustomModelDraft] = import_react19.default.useState(customModel);
    const [draftPort, setDraftPort] = import_react19.default.useState(String(port));
    const [tokenRaw, setTokenRaw] = import_react19.default.useState("");
    const [copied, setCopied] = import_react19.default.useState("");
    const [sections, setSections] = import_react19.default.useState(() => loadSectionState(window.localStorage));
    const onToggleSection = (id) => setSections((s) => {
      const next = toggleSection(s, id);
      saveSectionState(window.localStorage, next);
      return next;
    });
    import_react19.default.useEffect(() => setDraftPort(String(port)), [port]);
    import_react19.default.useEffect(() => setTokenRaw(readTokenValue()), []);
    import_react19.default.useEffect(() => setCustomModelDraft(customModel), [customModel]);
    const copy = (label, text) => {
      copyText(text).then(() => {
        setCopied(label);
        setTimeout(() => setCopied(""), 1200);
      }).catch(() => {
      });
    };
    const tokenDisplay = tokenRaw ? maskToken(tokenRaw) : t.tokenMissing;
    const regenerate = () => {
      if (!onRegenToken) return;
      const result = onRegenToken();
      if (result && typeof result.then === "function") {
        result.then((token) => setTokenRaw(token || readTokenValue())).catch(() => {
        });
      } else {
        setTokenRaw(result || readTokenValue());
      }
    };
    return /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { style: { flex: 1, minHeight: 0, overflow: "auto", padding: "var(--space-3)", display: "flex", flexDirection: "column", gap: "var(--space-5)" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(Section, { id: "ai", title: t.ai, expanded: sections.ai, onToggle: onToggleSection, children: [
        /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Field, { label: t.backend, children: /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Segmented, { full: true, value: backend, onChange: onBackendChange, options: [
          { value: "subscription", label: t.backendSub },
          { value: "codex", label: t.backendCodex },
          { value: "zcode", label: t.backendZcode }
        ] }) }),
        /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
          ChannelCard,
          {
            lang,
            channels: backend === "codex" ? channels.codex : backend === "zcode" ? channels.zcode : channels.claude,
            activeChannel,
            lockedChannel,
            onLockChannel,
            onRecheck: onRecheckBackend,
            recheckLabel: t.recheck,
            recheckDisabled,
            renderChannelBody: (channel) => {
              if (backend !== "codex" && backend !== "zcode" && channel === "api") {
                return /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 6 }, children: [
                  /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Select, { value: claudeProviderId, onChange: onClaudeProviderChange, options: [
                    { value: "", label: t.providerNone },
                    ...providers.filter((p) => p.protocol === "anthropic").map((p) => ({ value: p.id, label: p.name }))
                  ] }),
                  claudeSettingsImportAvailable ? /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Button, { variant: "secondary", size: "sm", icon: "download", onClick: onImportClaudeSettings, children: t.importClaudeSettings }) : null,
                  /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("div", { style: { font: "400 10px/1.5 var(--font-ui)", color: "var(--text-tertiary)" }, children: t.claude3pNote })
                ] });
              }
              if (backend === "codex" && channel === "custom") {
                return /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Select, { value: codexProviderId, onChange: onCodexProviderChange, options: [
                  { value: "", label: t.providerNone },
                  ...providers.filter((p) => p.protocol === "openai-compatible").map((p) => ({ value: p.id, label: p.name }))
                ] });
              }
              if (backend === "zcode" && channel === "cli-config") {
                return /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(ZcodeKeyFallback, { t, stored: zcodeKeyStored, onSave: onSaveZcodeKey });
              }
              if (backend === "codex" && channel === "cli-config") {
                return /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 6 }, children: [
                  codexCliConfig && codexCliConfig.provider ? /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("div", { style: { font: "400 10px/1.5 var(--font-ui)", color: "var(--text-tertiary)" }, children: [codexCliConfig.providerId, codexCliConfig.model, codexCliConfig.provider.baseUrl].filter(Boolean).join(" \xB7 ") }) : null,
                  /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(ZcodeKeyFallback, { t, stored: codexKeyStored, onSave: onSaveCodexKey })
                ] });
              }
              return null;
            }
          }
        ),
        providerManager,
        /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Field, { label: t.modelDefault, children: zcodeModelLocked ? /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("div", { style: { minHeight: 28, display: "flex", alignItems: "center", padding: "0 8px", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-md)", background: "var(--bg-well)", font: "400 11px/1.35 var(--font-ui)", color: "var(--text-secondary)" }, children: zcodeManagedModelLabel(lang, backend === "zcode" ? model : "") }) : /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Select, { value: model, onChange: onModelChange, options: modelOptions || [
          { value: "claude-sonnet-5", label: "Claude Sonnet 5" },
          { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
          { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" }
        ] }) }),
        backend === "codex" ? /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Field, { label: t.customModel, caption: t.customModelCap, children: /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Input, { mono: true, value: customModelDraft, onChange: (v) => {
          setCustomModelDraft(v);
          if (onCustomModelChange) onCustomModelChange(v);
        }, placeholder: backend === "codex" ? "provider/model" : "claude-custom" }) }) : null
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(Section, { id: "conn", title: t.conn, expanded: sections.conn, onToggle: onToggleSection, children: [
        /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Field, { label: t.port, hint: t.portHint, children: /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { style: { display: "flex", gap: 6 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Input, { mono: true, value: draftPort, onChange: setDraftPort, style: { flex: 1 } }),
          /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Button, { variant: "secondary", onClick: () => onApplyPort && onApplyPort(draftPort), children: t.apply })
        ] }) }),
        /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Field, { label: t.token, caption: t.tokenCap, children: /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { style: { display: "flex", gap: 6 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Input, { mono: true, value: tokenDisplay, style: { flex: 1 }, suffix: /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(IconButton, { icon: "copy", title: t.copy, disabled: !tokenRaw, onClick: () => copy("token", tokenRaw), style: { width: 20, height: 20 } }) }),
          /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Button, { variant: "secondary", icon: "rotate-cw", onClick: regenerate, children: t.regen })
        ] }) }),
        /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Field, { label: t.mcp, caption: copied === "mcp" ? t.copied : null, children: /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 6 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("pre", { style: { margin: 0, maxHeight: 160, overflow: "auto", padding: 8, border: "1px solid var(--border-default)", borderRadius: "var(--radius-md)", background: "var(--bg-well)", color: "var(--text-secondary)", font: "400 10px/1.4 var(--font-mono)" }, children: mcpConfig }),
          /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Button, { variant: "secondary", icon: "copy", onClick: () => copy("mcp", mcpConfig), children: t.copy })
        ] }) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Section, { id: "externalClients", title: t.externalClients, caption: t.externalClientsCap, expanded: sections.externalClients, onToggle: onToggleSection, children: EXTERNAL_CLIENTS.map((externalClient) => {
        const configText = JSON.stringify(mcpConfigFor(externalClient, Number(draftPort) || port || 11488, expertGuidance), null, 2);
        return /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
          ExternalClientRow,
          {
            client: externalClient,
            t,
            configText,
            copied: copied === externalClient.id,
            onCopy: () => copy(externalClient.id, configText)
          },
          externalClient.id
        );
      }) }),
      /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(Section, { id: "sec", title: t.sec, expanded: sections.sec, onToggle: onToggleSection, children: [
        /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("div", { style: { font: "500 11px/1.35 var(--font-ui)", color: "var(--text-secondary)", marginTop: 2 }, children: t.clients }),
        clients.map((client) => /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
          ClientRow,
          {
            name: client.label,
            lastActive: formatLastSeen(client.lastSeen, t),
            blocked: !!client.blocked,
            onBlock: (v) => onBlockClient && onBlockClient(client.label, v),
            blockLabel: t.blocked
          },
          client.label
        ))
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(Section, { id: "gen", title: t.gen, expanded: sections.gen, onToggle: onToggleSection, children: [
        /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Field, { layout: "row", label: t.expertGuidance, caption: t.expertGuidanceCap, children: /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Switch, { checked: expertGuidance, onChange: (v) => onExpertGuidance && onExpertGuidance(v) }) }),
        /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Field, { label: t.language, children: /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Segmented, { full: true, value: lang, onChange: onLangChange, options: [{ value: "zh", label: "\u4E2D\u6587" }, { value: "en", label: "English" }] }) }),
        /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Field, { label: t.logLevel, children: /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { style: { display: "flex", gap: 6 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Select, { value: logLevel, onChange: onLogLevel, style: { flex: 1 }, options: [
            { value: "error", label: "Error" },
            { value: "info", label: "Info" },
            { value: "debug", label: "Debug" }
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Button, { variant: "secondary", icon: "download", onClick: onExportLogs, children: t.exportLog })
        ] }) }),
        /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Field, { label: t.logs, children: /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("details", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("summary", { style: { cursor: "pointer", color: "var(--text-secondary)", font: "500 11px/1.35 var(--font-ui)" }, children: t.logs }),
          /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("pre", { style: { margin: "6px 0 0", maxHeight: 128, overflow: "auto", padding: 8, border: "1px solid var(--border-default)", borderRadius: "var(--radius-md)", background: "var(--bg-well)", color: "var(--text-tertiary)", font: "400 10px/1.4 var(--font-mono)" }, children: logs.join("\n") })
        ] }) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(Section, { id: "about", title: t.about, expanded: sections.about, onToggle: onToggleSection, children: [
        /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(VersionRow, { label: t.verPanel, value: `v${package_default.version}` }),
        /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(VersionRow, { label: t.verHost, value: hostVersion, badge: hostVersion === "-" ? /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Badge, { status: "neutral", children: t.pending }) : null }),
        /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(VersionRow, { label: t.verPy, value: pythonVersion, badge: pythonVersion === "-" ? /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Badge, { status: "neutral", children: t.pending }) : null }),
        /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { style: { display: "flex", gap: 6 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Button, { variant: "ghost", size: "sm", icon: "book-open", onClick: () => openExternal(DOCS_URL), children: t.docs }),
          /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Button, { variant: "ghost", size: "sm", icon: "github", onClick: () => openExternal(REPO_URL), children: t.github }),
          /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("span", { style: { flex: 1 } }),
          /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Button, { variant: "ghost", size: "sm", icon: "rotate-cw", onClick: onRerunWizard, children: t.rerunWizard })
        ] })
      ] })
    ] });
  }

  // src/screens/ActivityScreen.jsx
  var import_react22 = __toESM(require_react(), 1);

  // src/components/activity/FilterBar.jsx
  var import_react20 = __toESM(require_react(), 1);
  var import_jsx_runtime18 = __toESM(require_jsx_runtime(), 1);
  function FilterBar({
    query = "",
    onQuery,
    searchPlaceholder = "\u641C\u7D22\u64CD\u4F5C\u2026",
    filters = [],
    style
  }) {
    return /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)("div", { style: { display: "flex", gap: "var(--space-15)", padding: "var(--space-2)", borderBottom: "1px solid var(--border-subtle)", ...style }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(
        Input,
        {
          value: query,
          onChange: onQuery,
          placeholder: searchPlaceholder,
          style: { flex: 1 },
          suffix: null
        }
      ),
      filters.map((f, i) => /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(Select, { full: false, value: f.value, onChange: f.onChange, options: f.options, style: { flex: "none", width: f.width || 96 } }, i))
    ] });
  }

  // src/components/activity/ActivityRow.jsx
  var import_react21 = __toESM(require_react(), 1);
  var import_jsx_runtime19 = __toESM(require_jsx_runtime(), 1);
  var RESULT = {
    success: { icon: "check", color: "var(--ok)" },
    error: { icon: "x", color: "var(--error)" },
    denied: { icon: "circle-slash", color: "var(--text-tertiary)" },
    empty: { icon: "triangle-alert", color: "var(--warn)" }
  };
  function ActivityRow({
    time,
    source,
    verb,
    target,
    result = "success",
    resultTitle,
    params,
    undoLabel = "\u64A4\u9500\u5230\u6B64\u524D",
    onUndo,
    expandable = true,
    style
  }) {
    const [expanded, setExpanded] = import_react21.default.useState(false);
    const [hover, setHover] = import_react21.default.useState(false);
    const r = RESULT[result] || RESULT.success;
    return /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)("div", { style: { borderBottom: "1px solid var(--border-subtle)", ...style }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(
        "div",
        {
          role: expandable ? "button" : void 0,
          onClick: expandable ? () => setExpanded(!expanded) : void 0,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            display: "flex",
            alignItems: "center",
            gap: "var(--space-15)",
            minHeight: "var(--hit-min)",
            padding: "2px var(--space-2)",
            cursor: expandable ? "pointer" : "default",
            background: hover && expandable ? "var(--bg-hover)" : "transparent",
            transition: "background var(--dur-fast) var(--ease-out)"
          },
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime19.jsx)("span", { title: resultTitle, style: { display: "inline-flex", flex: "none" }, children: /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(Icon2, { name: r.icon, size: 12, strokeWidth: 2.5, color: r.color }) }),
            /* @__PURE__ */ (0, import_jsx_runtime19.jsx)("span", { style: { flex: "none", font: `var(--weight-regular) var(--text-micro)/1 var(--font-mono)`, color: "var(--text-tertiary)" }, children: time }),
            /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(Badge, { status: "neutral", style: { flex: "none", maxWidth: 84, overflow: "hidden" }, children: source }),
            /* @__PURE__ */ (0, import_jsx_runtime19.jsx)("span", { style: { flex: "none", font: `var(--weight-medium) var(--text-caption)/1 var(--font-ui)`, color: "var(--text-primary)", whiteSpace: "nowrap" }, children: verb }),
            /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
              "span",
              {
                style: {
                  flex: 1,
                  minWidth: 0,
                  font: `var(--weight-regular) var(--text-caption)/1 var(--font-ui)`,
                  color: "var(--text-tertiary)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis"
                },
                children: target
              }
            ),
            expandable ? /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
              Icon2,
              {
                name: "chevron-down",
                size: 11,
                color: "var(--text-tertiary)",
                style: { transform: expanded ? "rotate(180deg)" : "none", transition: "transform var(--dur-base) var(--ease-out)" }
              }
            ) : null
          ]
        }
      ),
      expanded ? /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)("div", { style: { padding: "0 var(--space-2) var(--space-2) 26px", display: "flex", flexDirection: "column", gap: "var(--space-15)" }, children: [
        params != null ? /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
          "pre",
          {
            style: {
              margin: 0,
              padding: "var(--space-2)",
              background: "var(--gray-0)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-sm)",
              font: `var(--weight-regular) var(--text-micro)/1.6 var(--font-mono)`,
              color: "var(--text-secondary)",
              maxHeight: 120,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all"
            },
            children: typeof params === "string" ? params : JSON.stringify(params, null, 2)
          }
        ) : null,
        onUndo ? /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(Button, { size: "sm", variant: "secondary", icon: "undo-2", onClick: onUndo, style: { alignSelf: "flex-start" }, children: undoLabel }) : null
      ] }) : null
    ] });
  }

  // src/lib/activityModel.js
  function eventTitle(evt, lang) {
    const raw = evt.undoGroup || "";
    const m = /^MCP\s+([^:]+):?\s*(.*)$/.exec(raw);
    if (m) return m[2] ? `${m[1].trim()} \xB7 ${m[2].trim()}` : m[1].trim();
    if (raw) return raw;
    return lang === "zh" ? "\u539F\u59CB\u811A\u672C" : "Raw script";
  }
  function eventOutcome(evt) {
    if (evt.denied === "paused") return "denied-paused";
    if (evt.denied === "blocked") return "denied-blocked";
    if (evt.denied) return "denied";
    if (evt.ok && evt.emptyResult) return "empty";
    return evt.ok ? "ok" : "error";
  }
  function parseToolPayload(result) {
    if (result && Array.isArray(result.content) && result.content[0] && typeof result.content[0].text === "string") {
      try {
        return JSON.parse(result.content[0].text);
      } catch (e) {
        return result;
      }
    }
    return result;
  }
  async function revertToPreviousCheckpoint(mcp, { branchBeforeRevert = true } = {}) {
    if (!mcp || typeof mcp.callTool !== "function") {
      throw new Error("MCP client is unavailable");
    }
    const listResult = await mcp.callTool("ae.checkpoint", { action: "list", limit: 1 });
    const listed = parseToolPayload(listResult);
    if (listResult && listResult.isError || listed && listed.ok === false) {
      throw new Error(listed && listed.error || "Checkpoint list failed");
    }
    const checkpoints = listed && Array.isArray(listed.checkpoints) ? listed.checkpoints : [];
    const checkpoint = checkpoints[0] || null;
    const checkpointId = checkpoint && (checkpoint.id || checkpoint.checkpoint_id);
    if (!checkpointId) {
      throw new Error("No checkpoint available to revert");
    }
    const revertResult = await mcp.callTool("ae.revert", {
      checkpoint_id: checkpointId,
      branch_before_revert: branchBeforeRevert
    });
    const reverted = parseToolPayload(revertResult);
    if (revertResult && revertResult.isError || reverted && reverted.ok === false) {
      throw new Error(reverted && reverted.error || "Checkpoint revert failed");
    }
    return reverted;
  }
  function filterEvents(events, { mode, query }) {
    let out = events;
    if (mode === "failed") out = out.filter((e) => eventOutcome(e) !== "ok");
    const q = (query || "").trim().toLowerCase();
    if (q) {
      out = out.filter((e) => [e.undoGroup, e.client, e.error].some((s) => s && String(s).toLowerCase().includes(q)));
    }
    return out;
  }

  // src/screens/ActivityScreen.jsx
  var import_jsx_runtime20 = __toESM(require_jsx_runtime(), 1);
  var A = {
    zh: {
      search: "\u641C\u7D22\u64CD\u4F5C\u2026",
      allResults: "\u5168\u90E8",
      errF: "\u5931\u8D25",
      empty: "\u6682\u65E0\u6D3B\u52A8",
      emptyCap: "\u6240\u6709\u5BA2\u6237\u7AEF\u5BF9\u5DE5\u7A0B\u7684\u6BCF\u4E00\u6B21\u64CD\u4F5C\u90FD\u4F1A\u8BB0\u5F55\u5728\u8FD9\u91CC\u3002",
      clear: "\u6E05\u7A7A",
      undoCheckpoint: "\u64A4\u9500\u5230\u4E0A\u4E00\u68C0\u67E5\u70B9",
      undoingCheckpoint: "\u64A4\u9500\u4E2D\u2026",
      undoCheckpointTitle: "\u6062\u590D\u6700\u8FD1\u4E00\u6B21\u4FDD\u5B58\u7684 MCP \u68C0\u67E5\u70B9",
      emptyResult: "\u65E0\u8FD4\u56DE\u503C"
    },
    en: {
      search: "Search actions\u2026",
      allResults: "All",
      errF: "Failed",
      empty: "No activity yet",
      emptyCap: "Every operation from every client is logged here.",
      clear: "Clear",
      undoCheckpoint: "Undo to previous checkpoint",
      undoingCheckpoint: "Undoing\u2026",
      undoCheckpointTitle: "Restore the most recent saved MCP checkpoint",
      emptyResult: "No return value"
    }
  };
  function rowResult(evt) {
    const outcome = eventOutcome(evt);
    if (outcome === "ok") return "success";
    if (outcome === "empty") return "empty";
    if (outcome.indexOf("denied") === 0) return "denied";
    return "error";
  }
  function eventDetails(evt) {
    return {
      client: evt.client,
      undoGroup: evt.undoGroup,
      durationMs: evt.durationMs,
      emptyResult: evt.emptyResult,
      error: evt.error
    };
  }
  function ActivityScreen({
    events = [],
    lang = "zh",
    onClear,
    onUndoCheckpoint,
    emptyTitle,
    emptyCaption
  }) {
    const t = A[lang] || A.zh;
    const [q, setQ] = import_react22.default.useState("");
    const [res, setRes] = import_react22.default.useState("all");
    const [undoing, setUndoing] = import_react22.default.useState(false);
    const rows = filterEvents(events, { mode: res, query: q });
    const empty = events.length === 0;
    const undoCheckpoint = async () => {
      if (!onUndoCheckpoint || undoing) return;
      setUndoing(true);
      try {
        await onUndoCheckpoint();
      } finally {
        setUndoing(false);
      }
    };
    return /* @__PURE__ */ (0, import_jsx_runtime20.jsx)("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }, children: empty ? /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(EmptyState, { icon: "list", title: emptyTitle || t.empty, caption: emptyCaption || t.emptyCap, style: { flex: 1 } }) : /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)(import_react22.default.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)("div", { style: { display: "flex", borderBottom: "1px solid var(--border-subtle)" }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(
          FilterBar,
          {
            query: q,
            onQuery: setQ,
            searchPlaceholder: t.search,
            style: { flex: 1, borderBottom: 0 },
            filters: [
              {
                value: res,
                onChange: setRes,
                width: 76,
                options: [
                  { value: "all", label: t.allResults },
                  { value: "failed", label: t.errF }
                ]
              }
            ]
          }
        ),
        onClear ? /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: "var(--space-1)", padding: "var(--space-2) var(--space-2) var(--space-2) 0" }, children: [
          onUndoCheckpoint ? /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Button, { size: "sm", variant: "secondary", icon: "undo-2", onClick: undoCheckpoint, disabled: undoing, title: t.undoCheckpointTitle, children: undoing ? t.undoingCheckpoint : t.undoCheckpoint }) : null,
          /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Button, { size: "sm", variant: "ghost", icon: "trash-2", onClick: onClear, title: t.clear, children: t.clear })
        ] }) : null
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime20.jsx)("div", { style: { flex: 1, minHeight: 0, overflow: "auto" }, children: rows.length ? rows.map((evt) => /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(
        ActivityRow,
        {
          time: new Date(evt.ts).toLocaleTimeString(),
          source: evt.client,
          verb: eventTitle(evt, lang),
          target: eventOutcome(evt) === "empty" ? t.emptyResult : evt.error || "",
          result: rowResult(evt),
          resultTitle: eventOutcome(evt) === "empty" ? t.emptyResult : void 0,
          params: eventDetails(evt)
        },
        evt.id
      )) : /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(EmptyState, { icon: "list", title: emptyTitle || t.empty, caption: emptyCaption || t.emptyCap, style: { flex: 1 } }) })
    ] }) });
  }

  // src/screens/WizardScreen.jsx
  var import_react25 = __toESM(require_react(), 1);

  // src/components/core/Spinner.jsx
  var import_react23 = __toESM(require_react(), 1);
  var import_jsx_runtime21 = __toESM(require_jsx_runtime(), 1);
  function Spinner({ size = 12, style }) {
    return /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(
      "span",
      {
        role: "progressbar",
        "aria-label": "loading",
        style: {
          width: size,
          height: size,
          flex: "none",
          display: "inline-block",
          border: "1.5px solid var(--gray-7)",
          borderTopColor: "var(--text-secondary)",
          borderRadius: "50%",
          animation: "ds-spin 0.8s linear infinite",
          ...style
        }
      }
    );
  }

  // src/components/chat/AIAvatar.jsx
  var import_react24 = __toESM(require_react(), 1);
  var import_jsx_runtime22 = __toESM(require_jsx_runtime(), 1);
  function AIAvatar({ size = 20, style }) {
    return /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(
      "span",
      {
        "aria-label": "AI",
        style: {
          width: size,
          height: size,
          flex: "none",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--accent-bg)",
          border: "1px solid var(--accent-border)",
          borderRadius: "var(--radius-md)",
          ...style
        },
        children: /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Icon2, { name: "sparkles", size: Math.round(size * 0.6), color: "var(--accent)", strokeWidth: 2 })
      }
    );
  }

  // src/lib/wizardSteps.js
  var LOCAL_STEPS = ["uv", "aeMcp"];
  var SUBSCRIPTION_STEPS = ["node", "claude", "login"];
  var LOG_TAIL = 4096;
  var ALL_STEPS = [...LOCAL_STEPS, ...SUBSCRIPTION_STEPS];
  function emptyState() {
    return { status: "idle", version: "", logTail: "" };
  }
  function initialStepStates() {
    return ALL_STEPS.reduce((acc, id) => {
      acc[id] = emptyState();
      return acc;
    }, {});
  }
  function appendTail(current, text) {
    return (String(current || "") + String(text || "")).slice(-LOG_TAIL);
  }
  function patchStep(state, id, patch) {
    return {
      ...state,
      [id]: {
        ...state[id] || emptyState(),
        ...patch
      }
    };
  }
  function stepReducer(state, action) {
    if (!action || !action.id) return state;
    const current = state[action.id] || emptyState();
    switch (action.type) {
      case "detect-start":
        return patchStep(state, action.id, { status: "checking" });
      case "detect-result":
        return patchStep(state, action.id, {
          status: action.ok ? "ok" : "missing",
          version: action.ok ? action.version || "" : ""
        });
      case "run-start":
        return patchStep(state, action.id, { status: "running", logTail: "" });
      case "run-chunk":
        return patchStep(state, action.id, { logTail: appendTail(current.logTail, action.text) });
      case "run-done":
        return patchStep(state, action.id, {
          status: action.ok ? "checking" : "fail",
          logTail: appendTail(current.logTail, action.output)
        });
      default:
        return state;
    }
  }

  // src/screens/WizardScreen.jsx
  var import_jsx_runtime23 = __toESM(require_jsx_runtime(), 1);
  var W = {
    zh: {
      stepOf: (n) => `\u7B2C ${n} \u6B65 / \u5171 3 \u6B65`,
      back: "\u4E0A\u4E00\u6B65",
      next: "\u4E0B\u4E00\u6B65",
      start: "\u5F00\u59CB\u4F7F\u7528",
      skip: "\u8DF3\u8FC7\u5411\u5BFC",
      t1: "\u6B22\u8FCE\u4F7F\u7528 ae-mcp",
      b1: "\u8BA9 AI \u52A9\u624B\u5B89\u5168\u5730\u64CD\u4F5C\u4F60\u7684 After Effects \u5DE5\u7A0B \u2014 \u6BCF\u4E00\u6B65\u53EF\u89C1\u3001\u53EF\u6279\u51C6\u3001\u53EF\u64A4\u9500\u3002",
      langLabel: "\u754C\u9762\u8BED\u8A00 \xB7 Language",
      t2: "\u5B89\u88C5\u672C\u5730\u670D\u52A1",
      b2: "\u9762\u677F\u53EF\u4EE5\u66FF\u4F60\u5B8C\u6210\u5B89\u88C5\u2014\u2014\u9010\u9879\u68C0\u6D4B\uFF0C\u7F3A\u4EC0\u4E48\u88C5\u4EC0\u4E48\uFF1A",
      copy: "\u590D\u5236",
      copied: "\u5DF2\u590D\u5236",
      install: "\u4E00\u952E\u5B89\u88C5",
      recheck: "\u590D\u68C0",
      openLogin: "\u6253\u5F00\u767B\u5F55\u7A97\u53E3",
      loginHint: "\u767B\u5F55\u5B8C\u6210\u540E\u56DE\u6765\u70B9\u590D\u68C0",
      copyLog: "\u590D\u5236\u65E5\u5FD7",
      uacNote: "Node \u5B89\u88C5\u4F1A\u5F39\u4E00\u6B21\u7CFB\u7EDF\u6388\u6743\uFF08UAC\uFF09",
      t3: "\u8FDE\u63A5 AI \u5BA2\u6237\u7AEF",
      b3: "\u9009\u62E9\u4F60\u7684\u5BA2\u6237\u7AEF\uFF0C\u628A\u914D\u7F6E\u7C98\u8D34\u8FDB\u5B83\u7684 MCP \u8BBE\u7F6E\uFF1A",
      builtin: "\u9762\u677F\u5185\u7F6E\u5BF9\u8BDD",
      builtinNote: "\u65E0\u9700\u914D\u7F6E\uFF0C\u5F00\u7BB1\u5373\u7528",
      docClient: "\u67E5\u770B\u63A5\u5165\u6587\u6863",
      docOnly: "\u6309\u6587\u6863\u63A5\u5165"
    },
    en: {
      stepOf: (n) => `Step ${n} of 3`,
      back: "Back",
      next: "Next",
      start: "Start using",
      skip: "Skip setup",
      t1: "Welcome to ae-mcp",
      b1: "Let AI assistants operate your After Effects project safely \u2014 every step visible, approvable, undoable.",
      langLabel: "\u754C\u9762\u8BED\u8A00 \xB7 Language",
      t2: "Install the local service",
      b2: "The panel installs these for you \u2014 detect each item, install what's missing:",
      copy: "Copy",
      copied: "Copied",
      install: "Install",
      recheck: "Re-check",
      openLogin: "Open login window",
      loginHint: "After login, return here and re-check",
      copyLog: "Copy log",
      uacNote: "Node install triggers one UAC prompt",
      t3: "Connect an AI client",
      b3: "Pick your client and paste the config into its MCP settings:",
      builtin: "Built-in chat",
      builtinNote: "No config needed \u2014 works out of the box",
      docClient: "Open integration docs",
      docOnly: "Use docs"
    }
  };
  var EMPTY_STEPS = initialStepStates();
  var STEP_LABELS = {
    uv: "uv",
    aeMcp: "ae-mcp",
    node: "Node.js LTS",
    claude: "Claude Code",
    login: "Claude login"
  };
  function copyText2(text) {
    if (globalThis.navigator && globalThis.navigator.clipboard && globalThis.navigator.clipboard.writeText) {
      globalThis.navigator.clipboard.writeText(text || "").catch(() => {
      });
    }
  }
  function CodeBlock({ code, copyLabel, onCopy, maxHeight }) {
    return /* @__PURE__ */ (0, import_jsx_runtime23.jsxs)("div", { style: { position: "relative", background: "var(--gray-0)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-md)" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime23.jsx)("pre", { style: { margin: 0, padding: "10px 36px 10px 12px", font: "400 11px/1.7 var(--font-mono)", color: "var(--text-primary)", overflow: "auto", maxHeight: maxHeight || 180, whiteSpace: "pre" }, children: code }),
      /* @__PURE__ */ (0, import_jsx_runtime23.jsx)(IconButton, { icon: "copy", title: copyLabel, variant: "secondary", onClick: onCopy, style: { position: "absolute", top: 6, right: 6, background: "var(--bg-panel)" } })
    ] });
  }
  function ClientRow2({ name, note, selected, onSelect }) {
    const [hover, setHover] = import_react25.default.useState(false);
    return /* @__PURE__ */ (0, import_jsx_runtime23.jsxs)(
      "button",
      {
        type: "button",
        className: "ds-focusable",
        onClick: onSelect,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          minHeight: 32,
          padding: "0 10px",
          textAlign: "left",
          background: selected ? "var(--bg-selected)" : hover ? "var(--bg-hover)" : "transparent",
          border: `1px solid ${selected ? "var(--border-strong)" : "var(--border-default)"}`,
          borderRadius: "var(--radius-md)",
          cursor: "pointer",
          transition: "background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)"
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime23.jsxs)("span", { style: { flex: 1, minWidth: 0 }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime23.jsx)("span", { style: { display: "block", font: "500 12px/1.35 var(--font-ui)", color: "var(--text-primary)" }, children: name }),
            note ? /* @__PURE__ */ (0, import_jsx_runtime23.jsx)("span", { style: { display: "block", font: "400 10px/1.35 var(--font-ui)", color: "var(--text-tertiary)" }, children: note }) : null
          ] }),
          selected ? /* @__PURE__ */ (0, import_jsx_runtime23.jsx)(Icon2, { name: "check", size: 13, strokeWidth: 2.5, color: "var(--text-primary)" }) : null
        ]
      }
    );
  }
  function InstallStepRow({ label, state, commandPreview: commandPreview2, t, onDetect, onInstall, login = false, hint }) {
    const status = state && state.status ? state.status : "idle";
    const isBusy = status === "checking" || status === "running";
    const isProblem = status === "missing" || status === "fail";
    const icon = status === "ok" ? "check" : isProblem ? "triangle-alert" : status === "idle" ? "circle" : null;
    const tail = String(state && state.logTail || "").split(/\r?\n/).slice(-6).join("\n");
    return /* @__PURE__ */ (0, import_jsx_runtime23.jsxs)("div", { style: { display: "flex", gap: 8, padding: "9px 10px", border: "1px solid var(--border-default)", borderRadius: "var(--radius-md)", background: "var(--bg-panel)" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime23.jsx)("span", { style: { width: 18, height: 18, display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none", color: status === "ok" ? "var(--ok)" : isProblem ? "var(--warn)" : "var(--text-tertiary)" }, children: isBusy ? /* @__PURE__ */ (0, import_jsx_runtime23.jsx)(Spinner, { size: 14 }) : /* @__PURE__ */ (0, import_jsx_runtime23.jsx)(Icon2, { name: icon, size: 15, strokeWidth: 2 }) }),
      /* @__PURE__ */ (0, import_jsx_runtime23.jsxs)("div", { style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime23.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 6, minHeight: 18 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime23.jsx)("span", { style: { font: "500 12px/1.35 var(--font-ui)", color: "var(--text-primary)" }, children: label }),
          status === "ok" && state.version ? /* @__PURE__ */ (0, import_jsx_runtime23.jsx)("span", { style: { font: "400 10px/1.35 var(--font-mono)", color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: state.version }) : null,
          /* @__PURE__ */ (0, import_jsx_runtime23.jsx)("span", { style: { flex: 1 } }),
          /* @__PURE__ */ (0, import_jsx_runtime23.jsx)(IconButton, { icon: "rotate-cw", title: t.recheck, variant: "secondary", size: "sm", disabled: isBusy, onClick: onDetect })
        ] }),
        hint ? /* @__PURE__ */ (0, import_jsx_runtime23.jsx)("div", { style: { font: "400 10px/1.45 var(--font-ui)", color: "var(--text-tertiary)" }, children: hint }) : null,
        isProblem ? /* @__PURE__ */ (0, import_jsx_runtime23.jsxs)(import_react25.default.Fragment, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime23.jsx)("code", { style: { display: "block", padding: "6px 8px", background: "var(--gray-0)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-sm)", font: "400 10px/1.55 var(--font-mono)", color: "var(--text-primary)", overflow: "auto", whiteSpace: "pre" }, children: commandPreview2 }),
          login ? /* @__PURE__ */ (0, import_jsx_runtime23.jsx)("div", { style: { font: "400 10px/1.45 var(--font-ui)", color: "var(--text-tertiary)" }, children: t.loginHint }) : null,
          /* @__PURE__ */ (0, import_jsx_runtime23.jsxs)("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime23.jsx)(Button, { variant: "secondary", size: "sm", onClick: onInstall, children: login ? t.openLogin : t.install }),
            status === "fail" ? /* @__PURE__ */ (0, import_jsx_runtime23.jsx)(Button, { variant: "ghost", size: "sm", onClick: () => copyText2(state.logTail), children: t.copyLog }) : null
          ] })
        ] }) : null,
        status === "running" ? /* @__PURE__ */ (0, import_jsx_runtime23.jsx)("pre", { style: { margin: 0, maxHeight: 96, overflow: "auto", padding: 8, background: "var(--gray-0)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-sm)", font: "400 10px/1.45 var(--font-mono)", color: "var(--text-secondary)", whiteSpace: "pre-wrap" }, children: tail }) : null
      ] })
    ] });
  }
  function WizardScreen({
    step = 1,
    lang = "zh",
    onLangChange,
    client = "claude-desktop",
    onClient,
    clientName = "Claude Desktop",
    mcpConfig = "",
    port = 11488,
    expertGuidance = true,
    onNext,
    onBack,
    onCopy,
    onDone,
    onSkip,
    stepStates = EMPTY_STEPS,
    onDetect,
    onInstall,
    onOpenLogin,
    commandPreviews = {},
    channels = { claude: [], codex: [], zcode: [] },
    activeChannel = ""
  }) {
    const t = W[lang] || W.zh;
    const clientOptions = [{ id: "builtin", name: "builtin" }, ...EXTERNAL_CLIENTS];
    const selectedExternalClient = EXTERNAL_CLIENTS.find((item) => item.id === client);
    const selectedMcpConfig = selectedExternalClient && selectedExternalClient.kind === "mcp-stdio" ? JSON.stringify(mcpConfigFor(selectedExternalClient, port, expertGuidance), null, 2) : "";
    return /* @__PURE__ */ (0, import_jsx_runtime23.jsxs)("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: "var(--space-6) var(--space-5) var(--space-5)" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime23.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 8 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime23.jsx)("div", { style: { display: "flex", gap: 5 }, children: [1, 2, 3].map((n) => /* @__PURE__ */ (0, import_jsx_runtime23.jsx)("span", { style: { width: n === step ? 14 : 5, height: 5, borderRadius: 3, background: n === step ? "var(--gray-11)" : n < step ? "var(--gray-9)" : "var(--gray-6)", transition: "width var(--dur-base) var(--ease-out)" } }, n)) }),
        /* @__PURE__ */ (0, import_jsx_runtime23.jsx)("span", { style: { font: "400 10px/1 var(--font-mono)", color: "var(--text-tertiary)" }, children: t.stepOf(step) }),
        /* @__PURE__ */ (0, import_jsx_runtime23.jsx)("span", { style: { flex: 1 } }),
        onSkip && step < 3 ? /* @__PURE__ */ (0, import_jsx_runtime23.jsx)(Button, { variant: "ghost", size: "sm", onClick: onSkip, style: { color: "var(--text-tertiary)" }, children: t.skip }) : null
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime23.jsxs)("div", { style: { flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column", gap: "var(--space-3)", paddingTop: "var(--space-6)" }, children: [
        step === 1 ? /* @__PURE__ */ (0, import_jsx_runtime23.jsxs)(import_react25.default.Fragment, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime23.jsx)(AIAvatar, { size: 44 }),
          /* @__PURE__ */ (0, import_jsx_runtime23.jsx)("div", { style: { font: "600 20px/1.35 var(--font-ui)", color: "var(--text-primary)" }, children: t.t1 }),
          /* @__PURE__ */ (0, import_jsx_runtime23.jsx)("div", { style: { font: "400 12px/1.55 var(--font-ui)", color: "var(--text-secondary)" }, children: t.b1 }),
          /* @__PURE__ */ (0, import_jsx_runtime23.jsxs)("div", { style: { marginTop: "var(--space-2)" }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime23.jsx)("div", { style: { font: "500 11px/1.35 var(--font-ui)", color: "var(--text-secondary)", marginBottom: 6 }, children: t.langLabel }),
            /* @__PURE__ */ (0, import_jsx_runtime23.jsx)(Segmented, { full: true, value: lang, onChange: onLangChange, options: [{ value: "zh", label: "\u4E2D\u6587" }, { value: "en", label: "English" }] })
          ] })
        ] }) : null,
        step === 2 ? /* @__PURE__ */ (0, import_jsx_runtime23.jsxs)(import_react25.default.Fragment, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime23.jsx)("div", { style: { font: "600 20px/1.35 var(--font-ui)", color: "var(--text-primary)" }, children: t.t2 }),
          /* @__PURE__ */ (0, import_jsx_runtime23.jsx)("div", { style: { font: "400 12px/1.55 var(--font-ui)", color: "var(--text-secondary)" }, children: t.b2 }),
          /* @__PURE__ */ (0, import_jsx_runtime23.jsx)("div", { style: { display: "flex", flexDirection: "column", gap: 8 }, children: LOCAL_STEPS.map((id) => /* @__PURE__ */ (0, import_jsx_runtime23.jsx)(
            InstallStepRow,
            {
              label: STEP_LABELS[id],
              state: stepStates[id] || EMPTY_STEPS[id],
              commandPreview: commandPreviews[id] || "",
              t,
              onDetect: () => onDetect && onDetect(id),
              onInstall: () => onInstall && onInstall(id)
            },
            id
          )) })
        ] }) : null,
        step === 3 ? /* @__PURE__ */ (0, import_jsx_runtime23.jsxs)(import_react25.default.Fragment, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime23.jsx)("div", { style: { font: "600 20px/1.35 var(--font-ui)", color: "var(--text-primary)" }, children: t.t3 }),
          /* @__PURE__ */ (0, import_jsx_runtime23.jsx)("div", { style: { font: "400 12px/1.55 var(--font-ui)", color: "var(--text-secondary)" }, children: t.b3 }),
          /* @__PURE__ */ (0, import_jsx_runtime23.jsx)("div", { style: { display: "flex", flexDirection: "column", gap: 6 }, children: clientOptions.map((c) => /* @__PURE__ */ (0, import_jsx_runtime23.jsx)(
            ClientRow2,
            {
              name: c.id === "builtin" ? t.builtin : c.name,
              note: c.id === "builtin" ? t.builtinNote : c.kind === "mcp-doc" ? t.docOnly : null,
              selected: client === c.id,
              onSelect: () => onClient && onClient(c.id)
            },
            c.id
          )) }),
          selectedExternalClient && selectedExternalClient.kind === "mcp-stdio" ? /* @__PURE__ */ (0, import_jsx_runtime23.jsx)(CodeBlock, { code: selectedMcpConfig, copyLabel: t.copy, onCopy: () => onCopy ? onCopy(selectedMcpConfig) : copyText2(selectedMcpConfig), maxHeight: 150 }) : null,
          selectedExternalClient && selectedExternalClient.kind === "mcp-doc" ? /* @__PURE__ */ (0, import_jsx_runtime23.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 8, padding: 10, border: "1px solid var(--border-default)", borderRadius: "var(--radius-md)", background: "var(--bg-panel)" }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime23.jsx)("a", { href: selectedExternalClient.docsUrl, target: "_blank", rel: "noreferrer", style: { font: "500 12px/1.35 var(--font-ui)", color: "var(--accent)" }, children: t.docClient }),
            selectedExternalClient.networkNote ? /* @__PURE__ */ (0, import_jsx_runtime23.jsx)("div", { style: { font: "400 10px/1.45 var(--font-ui)", color: "var(--text-tertiary)" }, children: selectedExternalClient.networkNote }) : null
          ] }) : null,
          client === "builtin" ? /* @__PURE__ */ (0, import_jsx_runtime23.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 8 }, children: [
            SUBSCRIPTION_STEPS.map((id) => /* @__PURE__ */ (0, import_jsx_runtime23.jsx)(
              InstallStepRow,
              {
                label: STEP_LABELS[id],
                state: stepStates[id] || EMPTY_STEPS[id],
                commandPreview: commandPreviews[id] || (id === "login" ? "claude" : ""),
                t,
                login: id === "login",
                hint: id === "node" ? t.uacNote : null,
                onDetect: () => onDetect && onDetect(id),
                onInstall: () => id === "login" ? onOpenLogin && onOpenLogin() : onInstall && onInstall(id)
              },
              id
            )),
            /* @__PURE__ */ (0, import_jsx_runtime23.jsx)(ChannelCard, { lang, channels: channels.claude, activeChannel, readOnly: true })
          ] }) : null
        ] }) : null
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime23.jsxs)("div", { style: { display: "flex", gap: "var(--space-15)", paddingTop: "var(--space-3)" }, children: [
        step > 1 ? /* @__PURE__ */ (0, import_jsx_runtime23.jsx)(Button, { variant: "ghost", size: "lg", onClick: onBack, children: t.back }) : null,
        /* @__PURE__ */ (0, import_jsx_runtime23.jsx)("span", { style: { flex: 1 } }),
        step < 3 ? /* @__PURE__ */ (0, import_jsx_runtime23.jsx)(Button, { variant: "primary", size: "lg", onClick: onNext, children: t.next }) : /* @__PURE__ */ (0, import_jsx_runtime23.jsx)(Button, { variant: "primary", size: "lg", onClick: onDone, children: t.start })
      ] })
    ] });
  }

  // src/screens/ConnectionDrawer.jsx
  var import_react28 = __toESM(require_react(), 1);

  // src/components/shell/DiagnosticItem.jsx
  var import_react26 = __toESM(require_react(), 1);
  var import_jsx_runtime24 = __toESM(require_jsx_runtime(), 1);
  var GLYPHS = {
    pass: { icon: "check", color: "var(--ok)" },
    fail: { icon: "x", color: "var(--error)" },
    pending: { icon: "circle", color: "var(--text-disabled)" }
  };
  function DiagnosticItem({ label, status = "pending", detail, actionLabel, onAction, style }) {
    const g = GLYPHS[status];
    return /* @__PURE__ */ (0, import_jsx_runtime24.jsxs)("div", { style: { padding: "var(--space-1) 0", ...style }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime24.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: "var(--space-2)", minHeight: 22 }, children: [
        status === "running" ? /* @__PURE__ */ (0, import_jsx_runtime24.jsx)(Spinner, { size: 12 }) : /* @__PURE__ */ (0, import_jsx_runtime24.jsx)(Icon2, { name: g.icon, size: 12, strokeWidth: 2.5, color: g.color }),
        /* @__PURE__ */ (0, import_jsx_runtime24.jsx)(
          "span",
          {
            style: {
              flex: 1,
              minWidth: 0,
              font: `var(--weight-regular) var(--text-body)/var(--leading-tight) var(--font-ui)`,
              color: status === "pending" ? "var(--text-tertiary)" : "var(--text-primary)"
            },
            children: label
          }
        )
      ] }),
      status === "fail" && detail ? /* @__PURE__ */ (0, import_jsx_runtime24.jsxs)(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "flex-start",
            gap: "var(--space-2)",
            margin: "2px 0 2px 20px",
            padding: "var(--space-15) var(--space-2)",
            background: "var(--error-bg)",
            border: "1px solid var(--error-border)",
            borderRadius: "var(--radius-sm)"
          },
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime24.jsx)("span", { style: { flex: 1, minWidth: 0, font: `var(--weight-regular) var(--text-caption)/var(--leading-normal) var(--font-ui)`, color: "var(--text-secondary)" }, children: detail }),
            actionLabel ? /* @__PURE__ */ (0, import_jsx_runtime24.jsx)(Button, { size: "sm", variant: "secondary", onClick: onAction, style: { flex: "none" }, children: actionLabel }) : null
          ]
        }
      ) : null
    ] });
  }

  // src/components/shell/Drawer.jsx
  var import_react27 = __toESM(require_react(), 1);
  var import_jsx_runtime25 = __toESM(require_jsx_runtime(), 1);
  function Drawer({ open = false, title, onClose, children, closeTitle = "\u5173\u95ED Close", style }) {
    if (!open) return null;
    return /* @__PURE__ */ (0, import_jsx_runtime25.jsxs)("div", { style: { position: "absolute", inset: 0, zIndex: 30 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime25.jsx)(
        "div",
        {
          onClick: onClose,
          style: { position: "absolute", inset: 0, background: "var(--scrim)", animation: "ds-fade var(--dur-slow) var(--ease-out)" }
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime25.jsxs)(
        "div",
        {
          role: "dialog",
          "aria-label": typeof title === "string" ? title : void 0,
          style: {
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            maxHeight: "85%",
            display: "flex",
            flexDirection: "column",
            background: "var(--bg-overlay)",
            borderBottom: "1px solid var(--border-strong)",
            borderRadius: "0 0 var(--radius-lg) var(--radius-lg)",
            boxShadow: "var(--shadow-overlay)",
            animation: "ds-fade-down var(--dur-slow) var(--ease-out)",
            ...style
          },
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime25.jsxs)(
              "div",
              {
                style: {
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-2)",
                  padding: "var(--space-2) var(--space-2) var(--space-2) var(--space-3)",
                  borderBottom: "1px solid var(--border-subtle)"
                },
                children: [
                  /* @__PURE__ */ (0, import_jsx_runtime25.jsx)("span", { style: { flex: 1, minWidth: 0, font: `var(--weight-semibold) var(--text-heading)/1 var(--font-ui)`, color: "var(--text-primary)" }, children: title }),
                  /* @__PURE__ */ (0, import_jsx_runtime25.jsx)(IconButton, { icon: "x", title: closeTitle, onClick: onClose })
                ]
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime25.jsx)("div", { style: { overflow: "auto", padding: "var(--space-3)" }, children })
          ]
        }
      )
    ] });
  }

  // src/screens/ConnectionDrawer.jsx
  var import_jsx_runtime26 = __toESM(require_jsx_runtime(), 1);
  var D = {
    zh: {
      title: "\u8FDE\u63A5",
      status: "\u72B6\u6001",
      connected: "\u5DF2\u8FDE\u63A5",
      waiting: "\u7B49\u5F85\u5BA2\u6237\u7AEF",
      port: "\u7AEF\u53E3",
      token: "Token",
      ver: "\u7248\u672C",
      recent: "\u6700\u8FD1\u6D3B\u52A8",
      copyConfig: "\u590D\u5236\u914D\u7F6E",
      restart: "\u91CD\u542F\u670D\u52A1",
      diagnose: "\u8FD0\u884C\u8BCA\u65AD",
      regen: "\u91CD\u65B0\u751F\u6210 Token",
      rerun: "\u91CD\u65B0\u8FD0\u884C",
      close: "\u5173\u95ED",
      copyReport: "\u590D\u5236\u8BCA\u65AD\u62A5\u544A",
      mismatch: "\u7248\u672C\u4E0D\u4E00\u81F4",
      tokenLocal: "\u672C\u673A\u6587\u4EF6",
      noRecent: "\u6682\u65E0\u5BA2\u6237\u7AEF\u6D3B\u52A8",
      checks: {
        "host-listening": "Host \u76D1\u542C",
        "token-file": "Token \u6587\u4EF6",
        "python-seen": "Python \u63E1\u624B",
        "ae-project": "AE \u5DE5\u7A0B",
        "extendscript-ping": "ExtendScript Ping"
      }
    },
    en: {
      title: "Connection",
      status: "Status",
      connected: "Connected",
      waiting: "Waiting for client",
      port: "Port",
      token: "Token",
      ver: "Version",
      recent: "Recent activity",
      copyConfig: "Copy config",
      restart: "Restart service",
      diagnose: "Run diagnostics",
      regen: "Regenerate token",
      rerun: "Run again",
      close: "Close",
      copyReport: "Copy diagnostic report",
      mismatch: "Version mismatch",
      tokenLocal: "Local file",
      noRecent: "No client activity yet",
      checks: {
        "host-listening": "Host listening",
        "token-file": "Token file",
        "python-seen": "Python handshake",
        "ae-project": "AE project",
        "extendscript-ping": "ExtendScript ping"
      }
    }
  };
  function KV({ k, children }) {
    return /* @__PURE__ */ (0, import_jsx_runtime26.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 8, minHeight: 24 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime26.jsx)("span", { style: { width: 72, flex: "none", font: "400 11px/1.35 var(--font-ui)", color: "var(--text-tertiary)" }, children: k }),
      /* @__PURE__ */ (0, import_jsx_runtime26.jsx)("span", { style: { flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 6, font: "400 11px/1.35 var(--font-mono)", color: "var(--text-primary)" }, children })
    ] });
  }
  function formatTime(ts) {
    if (!ts) return "-";
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  function callCopy(handler) {
    if (!handler) return;
    const value = handler();
    if (typeof value === "string") copyText(value).catch(() => {
    });
    else if (value && typeof value.then === "function") value.then((text) => {
      if (typeof text === "string") copyText(text).catch(() => {
      });
    }).catch(() => {
    });
  }
  function ConnectionDrawerBody({ lang = "zh", info = {}, panelVersion = package_default.version, statusLabel, onCopyConfig, onRestart, onDiagnose }) {
    const t = D[lang] || D.zh;
    const connected = !!info.lastClientSeenAt || !!info.lastHealthAt;
    const pythonVersion = info.pythonVersion || "-";
    const hostVersion = info.hostVersion || "-";
    const mismatch = info.pythonVersion && info.pythonVersion !== panelVersion;
    const recent = info.lastClientSeenAt ? [{ time: formatTime(info.lastClientSeenAt), text: lang === "zh" ? "\u5916\u90E8 MCP \u5BA2\u6237\u7AEF" : "External MCP client" }] : [];
    return /* @__PURE__ */ (0, import_jsx_runtime26.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: "var(--space-2)" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime26.jsxs)(KV, { k: t.status, children: [
        /* @__PURE__ */ (0, import_jsx_runtime26.jsx)(StatusDot, { status: connected ? "connected" : "waiting", size: 7 }),
        /* @__PURE__ */ (0, import_jsx_runtime26.jsx)("span", { style: { fontFamily: "var(--font-ui)" }, children: statusLabel || (connected ? t.connected : t.waiting) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime26.jsxs)(KV, { k: t.port, children: [
        info.port || "-",
        " ",
        /* @__PURE__ */ (0, import_jsx_runtime26.jsx)(IconButton, { icon: "copy", title: t.copyConfig, onClick: () => callCopy(onCopyConfig), style: { width: 20, height: 20 } })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime26.jsx)(KV, { k: t.token, children: info.tokenLabel || t.tokenLocal }),
      /* @__PURE__ */ (0, import_jsx_runtime26.jsxs)(KV, { k: t.ver, children: [
        "v",
        panelVersion,
        " \xB7 host ",
        hostVersion,
        " \xB7 py ",
        pythonVersion,
        mismatch ? /* @__PURE__ */ (0, import_jsx_runtime26.jsx)(Badge, { status: "warn", children: t.mismatch }) : null
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime26.jsx)("div", { style: { font: "500 11px/1.35 var(--font-ui)", color: "var(--text-secondary)", marginTop: 4 }, children: t.recent }),
      /* @__PURE__ */ (0, import_jsx_runtime26.jsx)("div", { style: { background: "var(--bg-well)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-md)", padding: "2px 8px" }, children: (recent.length ? recent : [{ time: "-", text: t.noRecent }]).map((r, i) => /* @__PURE__ */ (0, import_jsx_runtime26.jsxs)("div", { style: { display: "flex", gap: 8, alignItems: "center", minHeight: 22, font: "400 10px/1.35 var(--font-ui)", color: "var(--text-secondary)" }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime26.jsx)("span", { style: { fontFamily: "var(--font-mono)", color: "var(--text-tertiary)" }, children: r.time }),
        /* @__PURE__ */ (0, import_jsx_runtime26.jsx)("span", { style: { flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, children: r.text })
      ] }, i)) }),
      /* @__PURE__ */ (0, import_jsx_runtime26.jsxs)("div", { style: { display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime26.jsx)(Button, { variant: "secondary", size: "sm", icon: "copy", onClick: () => callCopy(onCopyConfig), children: t.copyConfig }),
        /* @__PURE__ */ (0, import_jsx_runtime26.jsx)(Button, { variant: "secondary", size: "sm", icon: "rotate-cw", onClick: onRestart, children: t.restart }),
        /* @__PURE__ */ (0, import_jsx_runtime26.jsx)(Button, { variant: "secondary", size: "sm", icon: "stethoscope", onClick: onDiagnose, children: t.diagnose })
      ] })
    ] });
  }
  function DiagnosticsBody({ lang = "zh", diagnostics = [], onRerun }) {
    const t = D[lang] || D.zh;
    return /* @__PURE__ */ (0, import_jsx_runtime26.jsxs)("div", { style: { display: "flex", flexDirection: "column" }, children: [
      diagnostics.map((c) => /* @__PURE__ */ (0, import_jsx_runtime26.jsx)(
        DiagnosticItem,
        {
          label: t.checks[c.id] || c.id,
          status: c.ok ? "pass" : "fail",
          detail: c.ok ? c.detail : [c.detail, c.fixHint && c.fixHint[lang]].filter(Boolean).join(" \xB7 ")
        },
        c.id
      )),
      /* @__PURE__ */ (0, import_jsx_runtime26.jsxs)("div", { style: { display: "flex", justifyContent: "flex-end", gap: 6, paddingTop: "var(--space-2)" }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime26.jsx)(Button, { variant: "secondary", size: "sm", icon: "copy", onClick: () => copyText(JSON.stringify(diagnostics, null, 2)).catch(() => {
        }), children: t.copyReport }),
        /* @__PURE__ */ (0, import_jsx_runtime26.jsx)(Button, { variant: "secondary", size: "sm", icon: "rotate-cw", onClick: onRerun, children: t.rerun })
      ] })
    ] });
  }
  function ConnectionDrawer({ open = false, onClose, info = {}, onCopyConfig, onRestart, onDiagnose, diagnostics = [], lang = "zh" }) {
    const diagList = Array.isArray(diagnostics) ? diagnostics : [];
    const t = D[lang] || D.zh;
    const panelVersion = info.panelVersion || package_default.version;
    return /* @__PURE__ */ (0, import_jsx_runtime26.jsxs)(Drawer, { open, title: t.title, onClose, closeTitle: t.close, children: [
      /* @__PURE__ */ (0, import_jsx_runtime26.jsx)(
        ConnectionDrawerBody,
        {
          lang,
          info,
          panelVersion,
          onCopyConfig,
          onRestart,
          onDiagnose
        }
      ),
      diagList.length ? /* @__PURE__ */ (0, import_jsx_runtime26.jsx)("div", { style: { marginTop: "var(--space-3)", paddingTop: "var(--space-2)", borderTop: "1px solid var(--border-subtle)" }, children: /* @__PURE__ */ (0, import_jsx_runtime26.jsx)(DiagnosticsBody, { lang, diagnostics: diagList, onRerun: onDiagnose }) }) : null
    ] });
  }

  // src/screens/ChatScreen.jsx
  var import_react36 = __toESM(require_react(), 1);

  // src/components/chat/ChatBubble.jsx
  var import_react29 = __toESM(require_react(), 1);
  var import_jsx_runtime27 = __toESM(require_jsx_runtime(), 1);
  function ChatBubble({ role = "ai", children, streaming = false, avatar = true, style }) {
    if (role === "user") {
      return /* @__PURE__ */ (0, import_jsx_runtime27.jsx)("div", { style: { display: "flex", justifyContent: "flex-end", ...style }, children: /* @__PURE__ */ (0, import_jsx_runtime27.jsx)(
        "div",
        {
          style: {
            maxWidth: "85%",
            padding: "5px 10px",
            background: "var(--bg-raised)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-lg)",
            borderBottomRightRadius: "var(--radius-sm)",
            font: `var(--weight-regular) var(--text-body)/var(--leading-normal) var(--font-ui)`,
            color: "var(--text-primary)",
            overflowWrap: "break-word"
          },
          children
        }
      ) });
    }
    return /* @__PURE__ */ (0, import_jsx_runtime27.jsxs)("div", { style: { display: "flex", gap: "var(--space-2)", alignItems: "flex-start", ...style }, children: [
      avatar ? /* @__PURE__ */ (0, import_jsx_runtime27.jsx)(AIAvatar, { style: { marginTop: 1 } }) : /* @__PURE__ */ (0, import_jsx_runtime27.jsx)("span", { style: { width: 20, flex: "none" } }),
      /* @__PURE__ */ (0, import_jsx_runtime27.jsxs)(
        "div",
        {
          style: {
            flex: 1,
            minWidth: 0,
            font: `var(--weight-regular) var(--text-body)/var(--leading-normal) var(--font-ui)`,
            color: "var(--text-primary)",
            overflowWrap: "break-word"
          },
          children: [
            children,
            streaming ? /* @__PURE__ */ (0, import_jsx_runtime27.jsx)(
              "span",
              {
                style: {
                  display: "inline-block",
                  width: 6,
                  height: 12,
                  marginLeft: 3,
                  verticalAlign: "-1px",
                  background: "var(--accent)",
                  borderRadius: 1,
                  animation: "ds-pulse 1s var(--ease-in-out) infinite"
                }
              }
            ) : null
          ]
        }
      )
    ] });
  }

  // src/components/chat/ToolCallCard.jsx
  var import_react30 = __toESM(require_react(), 1);
  var import_jsx_runtime28 = __toESM(require_jsx_runtime(), 1);
  function StatusGlyph({ status }) {
    if (status === "running") return /* @__PURE__ */ (0, import_jsx_runtime28.jsx)(Spinner, { size: 12 });
    if (status === "error") return /* @__PURE__ */ (0, import_jsx_runtime28.jsx)(Icon2, { name: "x", size: 12, strokeWidth: 2.5, color: "var(--error)" });
    return /* @__PURE__ */ (0, import_jsx_runtime28.jsx)(Icon2, { name: "check", size: 12, strokeWidth: 2.5, color: "var(--ok)" });
  }
  function ParamsBlock({ params }) {
    return /* @__PURE__ */ (0, import_jsx_runtime28.jsx)(
      "pre",
      {
        style: {
          margin: 0,
          padding: "var(--space-2)",
          background: "var(--gray-0)",
          borderTop: "1px solid var(--border-subtle)",
          font: `var(--weight-regular) var(--text-micro)/1.6 var(--font-mono)`,
          color: "var(--text-secondary)",
          maxHeight: 140,
          overflow: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all"
        },
        children: typeof params === "string" ? params : JSON.stringify(params, null, 2)
      }
    );
  }
  function HeaderRow({ status, verb, target, expandable, expanded, onToggle }) {
    const [hover, setHover] = import_react30.default.useState(false);
    return /* @__PURE__ */ (0, import_jsx_runtime28.jsxs)(
      "div",
      {
        role: expandable ? "button" : void 0,
        onClick: expandable ? onToggle : void 0,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          display: "flex",
          alignItems: "center",
          gap: "var(--space-15)",
          minHeight: "var(--hit-min)",
          padding: "0 var(--space-2)",
          cursor: expandable ? "pointer" : "default",
          background: expandable && hover ? "var(--bg-hover)" : "transparent",
          transition: "background var(--dur-fast) var(--ease-out)"
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime28.jsx)(StatusGlyph, { status }),
          /* @__PURE__ */ (0, import_jsx_runtime28.jsx)("span", { style: { font: `var(--weight-medium) var(--text-body)/1 var(--font-ui)`, color: "var(--text-primary)", whiteSpace: "nowrap" }, children: verb }),
          /* @__PURE__ */ (0, import_jsx_runtime28.jsx)(
            "span",
            {
              style: {
                flex: 1,
                minWidth: 0,
                font: `var(--weight-regular) var(--text-caption)/1 var(--font-ui)`,
                color: "var(--text-tertiary)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis"
              },
              children: target
            }
          ),
          expandable ? /* @__PURE__ */ (0, import_jsx_runtime28.jsx)(
            Icon2,
            {
              name: "chevron-down",
              size: 12,
              color: "var(--text-tertiary)",
              style: { transform: expanded ? "rotate(180deg)" : "none", transition: "transform var(--dur-base) var(--ease-out)" }
            }
          ) : null
        ]
      }
    );
  }
  function ToolCallCard({
    verb,
    target,
    status = "success",
    params,
    errorMessage: errorMessage2,
    onRetry,
    steps,
    groupLabel,
    defaultExpanded = false,
    retryLabel = "\u91CD\u8BD5",
    style
  }) {
    const [expanded, setExpanded] = import_react30.default.useState(defaultExpanded);
    const isGroup = Array.isArray(steps) && steps.length > 0;
    const expandable = isGroup || params != null;
    return /* @__PURE__ */ (0, import_jsx_runtime28.jsxs)(
      "div",
      {
        style: {
          background: "var(--bg-well)",
          border: "1px solid var(--border-default)",
          borderLeft: "2px solid var(--accent)",
          borderRadius: "var(--radius-md)",
          overflow: "hidden",
          ...style
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime28.jsx)(
            HeaderRow,
            {
              status,
              verb,
              target: isGroup ? groupLabel || `${steps.length} steps` : target,
              expandable,
              expanded,
              onToggle: () => setExpanded(!expanded)
            }
          ),
          expanded && isGroup ? /* @__PURE__ */ (0, import_jsx_runtime28.jsx)("div", { style: { borderTop: "1px solid var(--border-subtle)", padding: "var(--space-1) 0" }, children: steps.map((s, i) => /* @__PURE__ */ (0, import_jsx_runtime28.jsxs)(
            "div",
            {
              style: { display: "flex", alignItems: "center", gap: "var(--space-15)", minHeight: 22, padding: "0 var(--space-2) 0 var(--space-5)" },
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime28.jsx)(StatusGlyph, { status: s.status || "success" }),
                /* @__PURE__ */ (0, import_jsx_runtime28.jsx)("span", { style: { font: `var(--weight-regular) var(--text-caption)/1 var(--font-ui)`, color: "var(--text-secondary)", whiteSpace: "nowrap" }, children: s.verb }),
                /* @__PURE__ */ (0, import_jsx_runtime28.jsx)(
                  "span",
                  {
                    style: {
                      flex: 1,
                      minWidth: 0,
                      font: `var(--weight-regular) var(--text-caption)/1 var(--font-ui)`,
                      color: "var(--text-tertiary)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis"
                    },
                    children: s.target
                  }
                )
              ]
            },
            i
          )) }) : null,
          expanded && !isGroup && params != null ? /* @__PURE__ */ (0, import_jsx_runtime28.jsx)(ParamsBlock, { params }) : null,
          status === "error" && errorMessage2 ? /* @__PURE__ */ (0, import_jsx_runtime28.jsxs)(
            "div",
            {
              style: {
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
                padding: "var(--space-15) var(--space-2)",
                borderTop: "1px solid var(--border-subtle)",
                background: "var(--error-bg)"
              },
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime28.jsx)("span", { style: { flex: 1, minWidth: 0, font: `var(--weight-regular) var(--text-caption)/var(--leading-tight) var(--font-ui)`, color: "var(--error)" }, children: errorMessage2 }),
                onRetry ? /* @__PURE__ */ (0, import_jsx_runtime28.jsx)(Button, { size: "sm", variant: "secondary", icon: "rotate-cw", onClick: onRetry, children: retryLabel }) : null
              ]
            }
          ) : null
        ]
      }
    );
  }

  // src/components/chat/ApprovalCard.jsx
  var import_react31 = __toESM(require_react(), 1);
  var import_jsx_runtime29 = __toESM(require_jsx_runtime(), 1);
  var L = {
    zh: {
      needs: "\u9700\u8981\u6279\u51C6",
      high: "\u9AD8\u98CE\u9669",
      params: "\u67E5\u770B\u53C2\u6570",
      allow: "\u5141\u8BB8",
      deny: "\u62D2\u7EDD",
      session: "\u672C\u4F1A\u8BDD\u6B64\u7C7B\u64CD\u4F5C\u514D\u6279",
      allowed: "\u5DF2\u5141\u8BB8",
      denied: "\u5DF2\u62D2\u7EDD"
    },
    en: {
      needs: "Approval required",
      high: "High risk",
      params: "View parameters",
      allow: "Allow",
      deny: "Deny",
      session: "Don't ask again this session",
      allowed: "Allowed",
      denied: "Denied"
    }
  };
  function ApprovalCard({
    risk = "normal",
    title,
    description,
    params,
    lang = "zh",
    state = "pending",
    onAllow,
    onDeny,
    onAllowSession,
    style
  }) {
    const [expanded, setExpanded] = import_react31.default.useState(false);
    const t = L[lang] || L.zh;
    const high = risk === "high";
    return /* @__PURE__ */ (0, import_jsx_runtime29.jsxs)(
      "div",
      {
        style: {
          background: "var(--bg-raised)",
          border: `1px solid ${high ? "var(--error-border)" : "var(--border-strong)"}`,
          borderLeft: `2px solid ${high ? "var(--error)" : "var(--accent)"}`,
          borderRadius: "var(--radius-md)",
          overflow: "hidden",
          ...style
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime29.jsxs)("div", { style: { padding: "var(--space-2)", display: "flex", flexDirection: "column", gap: "var(--space-15)" }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime29.jsx)("div", { style: { display: "flex", alignItems: "center", gap: "var(--space-15)" }, children: high ? /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(Badge, { status: "error", icon: "shield-alert", children: t.high }) : /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(Badge, { status: "warn", icon: "shield", children: t.needs }) }),
            /* @__PURE__ */ (0, import_jsx_runtime29.jsx)("div", { style: { font: `var(--weight-semibold) var(--text-body)/var(--leading-tight) var(--font-ui)`, color: "var(--text-primary)" }, children: title }),
            description ? /* @__PURE__ */ (0, import_jsx_runtime29.jsx)("div", { style: { font: `var(--weight-regular) var(--text-caption)/var(--leading-normal) var(--font-ui)`, color: "var(--text-secondary)" }, children: description }) : null,
            params != null ? /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(ApprovalParams, { t, expanded, onToggle: () => setExpanded(!expanded), params }) : null
          ] }),
          state === "pending" ? /* @__PURE__ */ (0, import_jsx_runtime29.jsxs)("div", { style: { padding: "0 var(--space-2) var(--space-2)", display: "flex", flexDirection: "column", gap: "var(--space-15)" }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime29.jsxs)("div", { style: { display: "flex", gap: "var(--space-15)" }, children: [
              /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(Button, { variant: high ? "danger" : "primary", full: true, onClick: onAllow, children: t.allow }),
              /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(Button, { variant: "secondary", full: true, onClick: onDeny, children: t.deny })
            ] }),
            onAllowSession && !high ? /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(Button, { variant: "ghost", size: "sm", onClick: onAllowSession, style: { alignSelf: "flex-start", color: "var(--text-tertiary)" }, children: t.session }) : null
          ] }) : /* @__PURE__ */ (0, import_jsx_runtime29.jsxs)(
            "div",
            {
              style: {
                display: "flex",
                alignItems: "center",
                gap: "var(--space-15)",
                padding: "var(--space-15) var(--space-2)",
                borderTop: "1px solid var(--border-subtle)",
                font: `var(--weight-medium) var(--text-caption)/1 var(--font-ui)`,
                color: state === "allowed" ? "var(--ok)" : "var(--text-tertiary)"
              },
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(Icon2, { name: state === "allowed" ? "check" : "x", size: 12, strokeWidth: 2.5 }),
                state === "allowed" ? t.allowed : t.denied
              ]
            }
          )
        ]
      }
    );
  }
  function ApprovalParams({ t, expanded, onToggle, params }) {
    const [hover, setHover] = import_react31.default.useState(false);
    return /* @__PURE__ */ (0, import_jsx_runtime29.jsxs)("div", { children: [
      /* @__PURE__ */ (0, import_jsx_runtime29.jsxs)(
        "button",
        {
          type: "button",
          className: "ds-focusable",
          onClick: onToggle,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            minHeight: 20,
            padding: 0,
            background: "transparent",
            border: "none",
            cursor: "pointer",
            font: `var(--weight-regular) var(--text-caption)/1 var(--font-ui)`,
            color: hover ? "var(--text-secondary)" : "var(--text-tertiary)"
          },
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(Icon2, { name: "chevron-right", size: 11, style: { transform: expanded ? "rotate(90deg)" : "none", transition: "transform var(--dur-base) var(--ease-out)" } }),
            t.params
          ]
        }
      ),
      expanded ? /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(
        "pre",
        {
          style: {
            margin: "4px 0 0",
            padding: "var(--space-2)",
            background: "var(--gray-0)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-sm)",
            font: `var(--weight-regular) var(--text-micro)/1.6 var(--font-mono)`,
            color: "var(--text-secondary)",
            maxHeight: 120,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all"
          },
          children: typeof params === "string" ? params : JSON.stringify(params, null, 2)
        }
      ) : null
    ] });
  }

  // src/components/chat/PromptCard.jsx
  var import_react32 = __toESM(require_react(), 1);
  var import_jsx_runtime30 = __toESM(require_jsx_runtime(), 1);
  function PromptCard({ icon = "wand-2", title, caption, onClick, style }) {
    const [hover, setHover] = import_react32.default.useState(false);
    return /* @__PURE__ */ (0, import_jsx_runtime30.jsxs)(
      "button",
      {
        type: "button",
        className: "ds-focusable",
        onClick,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          display: "flex",
          alignItems: "flex-start",
          gap: "var(--space-2)",
          width: "100%",
          textAlign: "left",
          padding: "var(--space-2)",
          background: hover ? "var(--bg-hover)" : "var(--bg-raised)",
          border: `1px solid ${hover ? "var(--border-strong)" : "var(--border-default)"}`,
          borderRadius: "var(--radius-md)",
          cursor: "pointer",
          transition: "background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)",
          ...style
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime30.jsx)(Icon2, { name: icon, size: 14, color: "var(--text-tertiary)", style: { marginTop: 1 } }),
          /* @__PURE__ */ (0, import_jsx_runtime30.jsxs)("span", { style: { flex: 1, minWidth: 0 }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime30.jsx)("span", { style: { display: "block", font: `var(--weight-medium) var(--text-body)/var(--leading-tight) var(--font-ui)`, color: "var(--text-primary)" }, children: title }),
            caption ? /* @__PURE__ */ (0, import_jsx_runtime30.jsx)("span", { style: { display: "block", marginTop: 2, font: `var(--weight-regular) var(--text-caption)/var(--leading-tight) var(--font-ui)`, color: "var(--text-tertiary)" }, children: caption }) : null
          ] })
        ]
      }
    );
  }

  // src/components/chat/Composer.jsx
  var import_react33 = __toESM(require_react(), 1);
  var import_jsx_runtime31 = __toESM(require_jsx_runtime(), 1);
  function Composer({
    value = "",
    onChange,
    onSend,
    onStop,
    streaming = false,
    disabled = false,
    notice,
    options,
    placeholder,
    style
  }) {
    const [focus, setFocus] = import_react33.default.useState(false);
    const canSend = !disabled && !streaming && value.trim().length > 0;
    const handleKey = (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (canSend && onSend) onSend();
      }
    };
    return /* @__PURE__ */ (0, import_jsx_runtime31.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: "var(--space-15)", ...style }, children: [
      notice,
      /* @__PURE__ */ (0, import_jsx_runtime31.jsxs)(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: options ? "column" : "row",
            alignItems: options ? "stretch" : "flex-end",
            gap: options ? 2 : "var(--space-15)",
            padding: "var(--space-15)",
            background: "var(--bg-well)",
            border: `1px solid ${focus && !disabled ? "var(--border-strong)" : "var(--border-default)"}`,
            boxShadow: focus && !disabled ? "0 0 0 1px var(--focus-ring)" : "none",
            borderRadius: "var(--radius-lg)",
            opacity: disabled ? 0.5 : 1,
            transition: "border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)"
          },
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(
              "textarea",
              {
                rows: 1,
                value,
                placeholder,
                disabled,
                onChange: (e) => onChange && onChange(e.target.value),
                onFocus: () => setFocus(true),
                onBlur: () => setFocus(false),
                onKeyDown: handleKey,
                style: {
                  flex: 1,
                  minWidth: 0,
                  maxHeight: 72,
                  resize: "none",
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  padding: "4px 2px 4px 4px",
                  color: "var(--text-primary)",
                  font: `var(--weight-regular) var(--text-body)/var(--leading-normal) var(--font-ui)`
                }
              }
            ),
            options ? /* @__PURE__ */ (0, import_jsx_runtime31.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 2, minWidth: 0 }, children: [
              /* @__PURE__ */ (0, import_jsx_runtime31.jsx)("div", { style: { flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 2 }, children: options }),
              streaming ? /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(SendButton, { icon: "square", title: "\u505C\u6B62 Stop", kind: "stop", onClick: onStop }) : /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(SendButton, { icon: "arrow-up", title: "\u53D1\u9001 Send", kind: "send", disabled: !canSend, onClick: canSend ? onSend : void 0 })
            ] }) : streaming ? /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(SendButton, { icon: "square", title: "\u505C\u6B62 Stop", kind: "stop", onClick: onStop }) : /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(SendButton, { icon: "arrow-up", title: "\u53D1\u9001 Send", kind: "send", disabled: !canSend, onClick: canSend ? onSend : void 0 })
          ]
        }
      )
    ] });
  }
  function SendButton({ icon, title, kind, disabled = false, onClick }) {
    const [hover, setHover] = import_react33.default.useState(false);
    const active = kind === "send" && !disabled;
    return /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(
      "button",
      {
        type: "button",
        className: "ds-focusable",
        title,
        "aria-label": title,
        disabled,
        onClick,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          width: 24,
          height: 24,
          flex: "none",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          background: active ? hover ? "var(--accent-hover)" : "var(--accent)" : kind === "stop" ? hover ? "#ffffff" : "var(--gray-11)" : "var(--gray-6)",
          color: active || kind === "stop" ? "var(--text-on-solid)" : "var(--gray-8)",
          border: "none",
          borderRadius: "var(--radius-md)",
          cursor: disabled ? "default" : "pointer",
          transition: "background var(--dur-fast) var(--ease-out)"
        },
        children: /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(Icon2, { name: icon, size: 13, strokeWidth: 2.25 })
      }
    );
  }

  // src/components/chat/ComposerChip.jsx
  var import_react35 = __toESM(require_react(), 1);

  // src/components/core/Menu.jsx
  var import_react34 = __toESM(require_react(), 1);
  var import_jsx_runtime32 = __toESM(require_jsx_runtime(), 1);
  function Keycap({ children }) {
    return /* @__PURE__ */ (0, import_jsx_runtime32.jsx)(
      "span",
      {
        style: {
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          minWidth: 16,
          height: 16,
          padding: "0 3px",
          background: "var(--bg-raised)",
          border: "1px solid var(--border-default)",
          borderRadius: "var(--radius-sm)",
          font: "400 var(--text-micro)/1 var(--font-ui)",
          color: "var(--text-tertiary)"
        },
        children
      }
    );
  }
  function MenuRow({ item, onClose }) {
    const [hover, setHover] = import_react34.default.useState(false);
    const disabled = !!item.disabled;
    return /* @__PURE__ */ (0, import_jsx_runtime32.jsxs)(
      "button",
      {
        type: "button",
        className: "ds-focusable",
        disabled,
        onClick: () => {
          if (item.onSelect) item.onSelect();
          if (onClose) onClose();
        },
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          width: "100%",
          minHeight: "var(--hit-min)",
          padding: "2px var(--space-2)",
          background: hover && !disabled ? "var(--bg-hover)" : "transparent",
          border: "none",
          borderRadius: "var(--radius-sm)",
          font: "400 var(--text-body)/var(--leading-tight) var(--font-ui)",
          color: disabled ? "var(--text-disabled)" : item.danger ? "var(--error)" : "var(--text-primary)",
          textAlign: "left",
          cursor: disabled ? "default" : "pointer",
          transition: "background var(--dur-fast) var(--ease-out)"
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime32.jsx)("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: item.label }),
          item.checked ? /* @__PURE__ */ (0, import_jsx_runtime32.jsx)(Icon2, { name: "check", size: 12, strokeWidth: 2.25, color: "var(--text-primary)" }) : null,
          item.hint ? /* @__PURE__ */ (0, import_jsx_runtime32.jsx)("span", { style: { flex: "none", font: "400 var(--text-caption)/1 var(--font-ui)", color: "var(--text-tertiary)" }, children: item.hint }) : null
        ]
      }
    );
  }
  function Menu({ header, items = [], footer, onClose, minWidth = 184, style }) {
    return /* @__PURE__ */ (0, import_jsx_runtime32.jsxs)(
      "div",
      {
        role: "menu",
        style: {
          minWidth,
          padding: "var(--space-1)",
          background: "var(--bg-overlay)",
          border: "1px solid var(--border-default)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-overlay)",
          ...style
        },
        children: [
          header ? /* @__PURE__ */ (0, import_jsx_runtime32.jsxs)(
            "div",
            {
              style: {
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "var(--space-2)",
                padding: "4px var(--space-2) 6px",
                borderBottom: "1px solid var(--border-subtle)",
                marginBottom: "var(--space-1)"
              },
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime32.jsx)("span", { style: { font: "400 var(--text-caption)/1 var(--font-ui)", color: "var(--text-tertiary)" }, children: header.label }),
                header.keys && header.keys.length ? /* @__PURE__ */ (0, import_jsx_runtime32.jsx)("span", { style: { display: "inline-flex", gap: 3 }, children: header.keys.map((k, i) => /* @__PURE__ */ (0, import_jsx_runtime32.jsx)(Keycap, { children: k }, i)) }) : null
              ]
            }
          ) : null,
          /* @__PURE__ */ (0, import_jsx_runtime32.jsx)("div", { style: { display: "flex", flexDirection: "column" }, children: items.map(
            (item, i) => item.divider ? /* @__PURE__ */ (0, import_jsx_runtime32.jsx)("div", { style: { height: 1, background: "var(--border-subtle)", margin: "4px 0" } }, i) : /* @__PURE__ */ (0, import_jsx_runtime32.jsx)(MenuRow, { item, onClose }, i)
          ) }),
          footer ? /* @__PURE__ */ (0, import_jsx_runtime32.jsx)(
            "div",
            {
              style: {
                padding: "6px var(--space-2) 4px",
                borderTop: "1px solid var(--border-subtle)",
                marginTop: "var(--space-1)",
                font: "400 var(--text-caption)/var(--leading-tight) var(--font-ui)",
                color: "var(--text-tertiary)"
              },
              children: footer
            }
          ) : null
        ]
      }
    );
  }

  // src/components/chat/ComposerChip.jsx
  var import_jsx_runtime33 = __toESM(require_jsx_runtime(), 1);
  function ComposerChip({
    icon,
    label,
    active = false,
    disabled = false,
    items,
    menuHeader,
    menuFooter,
    menuAlign = "left",
    onToggle,
    title,
    style
  }) {
    const [hover, setHover] = import_react35.default.useState(false);
    const [open, setOpen] = import_react35.default.useState(false);
    const rootRef = import_react35.default.useRef(null);
    const isMenu = Array.isArray(items) && items.length > 0;
    import_react35.default.useEffect(() => {
      if (!open) return void 0;
      const onDoc = (e) => {
        if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
      };
      const onKey = (e) => {
        if (e.key === "Escape") setOpen(false);
      };
      document.addEventListener("mousedown", onDoc);
      document.addEventListener("keydown", onKey);
      return () => {
        document.removeEventListener("mousedown", onDoc);
        document.removeEventListener("keydown", onKey);
      };
    }, [open]);
    const lit = active || open;
    return /* @__PURE__ */ (0, import_jsx_runtime33.jsxs)("div", { ref: rootRef, style: { position: "relative", flex: "none", ...style }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime33.jsxs)(
        "button",
        {
          type: "button",
          className: "ds-focusable",
          disabled,
          title,
          "aria-haspopup": isMenu ? "menu" : void 0,
          "aria-expanded": isMenu ? open : void 0,
          "aria-pressed": !isMenu && onToggle ? active : void 0,
          onClick: () => {
            if (disabled) return;
            if (isMenu) setOpen((v) => !v);
            else if (onToggle) onToggle(!active);
          },
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            height: "var(--hit-min)",
            padding: "0 var(--space-15)",
            background: lit ? "var(--bg-selected)" : hover && !disabled ? "var(--bg-hover)" : "transparent",
            border: "none",
            borderRadius: "var(--radius-md)",
            font: "400 var(--text-caption)/1 var(--font-ui)",
            color: disabled ? "var(--text-disabled)" : lit ? "var(--text-primary)" : "var(--text-tertiary)",
            cursor: disabled ? "default" : "pointer",
            transition: "background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)",
            whiteSpace: "nowrap"
          },
          children: [
            icon ? /* @__PURE__ */ (0, import_jsx_runtime33.jsx)(Icon2, { name: icon, size: 12 }) : null,
            label ? /* @__PURE__ */ (0, import_jsx_runtime33.jsx)("span", { style: { overflow: "hidden", textOverflow: "ellipsis", maxWidth: 96 }, children: label }) : null,
            !isMenu && onToggle && active ? /* @__PURE__ */ (0, import_jsx_runtime33.jsx)(Icon2, { name: "check", size: 10, strokeWidth: 2.5 }) : null,
            isMenu ? /* @__PURE__ */ (0, import_jsx_runtime33.jsx)(Icon2, { name: "chevron-down", size: 10, strokeWidth: 2, style: { opacity: 0.7 } }) : null
          ]
        }
      ),
      isMenu && open ? /* @__PURE__ */ (0, import_jsx_runtime33.jsx)(
        "div",
        {
          style: {
            position: "absolute",
            bottom: "calc(100% + 4px)",
            [menuAlign === "right" ? "right" : "left"]: 0,
            zIndex: 30,
            animation: "ds-fade-up var(--dur-base) var(--ease-out)"
          },
          children: /* @__PURE__ */ (0, import_jsx_runtime33.jsx)(Menu, { header: menuHeader, items, footer: menuFooter, onClose: () => setOpen(false) })
        }
      ) : null
    ] });
  }

  // src/lib/composerOptions.js
  function costBadge(tier) {
    const n = Math.max(1, Math.min(4, Number(tier) || 2));
    return "$".repeat(n);
  }
  function byLang(item, lang, zhKey, enKey) {
    return lang === "en" ? item[enKey] : item[zhKey];
  }
  function buildComposerChips({
    descriptor,
    modelId,
    effort,
    fast,
    permissionMode,
    lang = "zh"
  }) {
    const models = descriptor.models || [];
    const currentModel = models.find((m) => m.id === modelId) || models[0] || {};
    const effortLevels = Array.isArray(currentModel.effortLevels) ? currentModel.effortLevels : [];
    const approvals = descriptor.approvalModes || [];
    const currentApproval = approvals.find((m) => m.id === permissionMode) || approvals[0] || {};
    const modelSwitchable = descriptor.perTurnModelSwitch !== false;
    return {
      model: modelSwitchable ? {
        current: currentModel.label || currentModel.id || "",
        items: models.map((m) => ({ id: m.id, label: m.label || m.id, caption: costBadge(m.cost) }))
      } : null,
      effort: effortLevels.length ? {
        current: effort,
        items: effortLevels.map((id) => ({ id, label: id, caption: "" }))
      } : null,
      fast: descriptor.supportsFast && descriptor.supportsFast(currentModel.id) ? { active: Boolean(fast) } : null,
      approval: {
        current: byLang(currentApproval, lang, "zh", "en") || currentApproval.id || "",
        items: approvals.map((m) => ({
          id: m.id,
          label: byLang(m, lang, "zh", "en") || m.id,
          caption: byLang(m, lang, "anchorZh", "anchorEn") || ""
        }))
      }
    };
  }

  // src/screens/ChatScreen.jsx
  var import_jsx_runtime34 = __toESM(require_jsx_runtime(), 1);
  var C = {
    zh: {
      hello: "\u4F60\u597D\uFF01\u6211\u53EF\u4EE5\u76F4\u63A5\u64CD\u4F5C\u5F53\u524D\u6253\u5F00\u7684 AE \u5DE5\u7A0B\u3002\u8BD5\u8BD5\u8FD9\u4E9B\uFF1A",
      keyTitle: "\u5728\u8BBE\u7F6E\u91CC\u7C98\u8D34 Anthropic API Key",
      keyCaption: "\u4FDD\u5B58\u5E76\u9A8C\u8BC1\u540E\uFF0C\u5C31\u53EF\u4EE5\u5728\u8FD9\u91CC\u8BA9 AI \u64CD\u4F5C\u4F60\u7684\u5DE5\u7A0B\u3002",
      newSession: "\u65B0\u4F1A\u8BDD",
      placeholder: "\u63CF\u8FF0\u4F60\u60F3\u5728 AE \u91CC\u505A\u4EC0\u4E48\u2026",
      noticeAction: "\u65B0\u4F1A\u8BDD",
      modelChip: "\u6A21\u578B",
      effortChip: "\u601D\u8003",
      fastChip: "\u5FEB\u901F",
      approvalChip: "\u6743\u9650",
      errorTitle: "\u5BF9\u8BDD\u51FA\u9519",
      modelErrorTitle: "\u6A21\u578B\u4E0D\u53EF\u7528\u2014\u2014\u6362\u4E00\u4E2A\u8BD5\u8BD5",
      denied: "\u5DF2\u62D2\u7EDD",
      running: "\u6267\u884C\u4E2D",
      ok: "\u5B8C\u6210",
      failed: "\u5931\u8D25",
      awaiting: "\u7B49\u5F85\u6279\u51C6",
      thinking: "\u601D\u8003\u4E2D\u2026"
    },
    en: {
      hello: "Hi! I can operate the open AE project directly. Try one of these:",
      keyTitle: "Paste an Anthropic API Key in Settings",
      keyCaption: "After saving and validating it, AI can operate your project here.",
      newSession: "New session",
      placeholder: "Describe what to do in AE\u2026",
      noticeAction: "New session",
      modelChip: "Model",
      effortChip: "Effort",
      fastChip: "Fast",
      approvalChip: "Approval",
      errorTitle: "Chat error",
      modelErrorTitle: "Model unavailable \u2014 pick another",
      denied: "Denied",
      running: "Running",
      ok: "Done",
      failed: "Failed",
      awaiting: "Awaiting approval",
      thinking: "Thinking\u2026"
    }
  };
  var DEFAULT_PROMPTS = {
    zh: [
      { icon: "type", title: "\u521B\u5EFA\u4E00\u4E2A\u6807\u9898\u52A8\u753B", caption: "\u65B0\u5EFA\u6587\u672C\u56FE\u5C42\u5E76\u52A0\u5165\u4F4D\u7F6E\u5173\u952E\u5E27" },
      { icon: "layers", title: "\u6574\u7406\u5DE5\u7A0B\u7D20\u6750", caption: "\u6309\u7C7B\u578B\u628A\u7D20\u6750\u5F52\u8FDB\u6587\u4EF6\u5939" },
      { icon: "clapperboard", title: "\u7ED9\u753B\u9762\u52A0\u7535\u5F71\u611F\u8C03\u8272", caption: "\u6DFB\u52A0\u8C03\u6574\u56FE\u5C42\u4E0E Lumetri \u9884\u8BBE" }
    ],
    en: [
      { icon: "type", title: "Create a title animation", caption: "New text layer with position keyframes" },
      { icon: "layers", title: "Organize project assets", caption: "Sort footage into folders by type" },
      { icon: "clapperboard", title: "Cinematic color grade", caption: "Adjustment layer + Lumetri preset" }
    ]
  };
  function Notice({ text, actionLabel, onAction }) {
    return /* @__PURE__ */ (0, import_jsx_runtime34.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", background: "var(--bg-well)", border: "1px solid var(--border-default)", borderRadius: "var(--radius-md)" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime34.jsx)(Icon2, { name: "plug", size: 12, color: "var(--text-tertiary)" }),
      /* @__PURE__ */ (0, import_jsx_runtime34.jsx)("span", { style: { flex: 1, minWidth: 0, font: "400 11px/1.35 var(--font-ui)", color: "var(--text-secondary)" }, children: text }),
      onAction ? /* @__PURE__ */ (0, import_jsx_runtime34.jsx)(Button, { size: "sm", variant: "secondary", onClick: onAction, children: actionLabel }) : null
    ] });
  }
  function statusForTool(state) {
    if (state === "running" || state === "awaiting-approval") return "running";
    if (state === "error" || state === "denied") return "error";
    return "success";
  }
  function toolTarget(entry, t) {
    if (entry.state === "awaiting-approval") return t.awaiting;
    if (entry.state === "running") return t.running;
    if (entry.state === "denied") return t.denied;
    if (entry.state === "error") return t.failed;
    return t.ok;
  }
  function titleForTool(entry, lang) {
    return eventTitle({ undoGroup: `MCP ${entry.name || ""}` }, lang);
  }
  function Entry({ entry, lang, onApprove }) {
    const t = C[lang] || C.zh;
    if (entry.type === "user-text") {
      return /* @__PURE__ */ (0, import_jsx_runtime34.jsx)(ChatBubble, { role: "user", children: entry.text });
    }
    if (entry.type === "ai-text") {
      return /* @__PURE__ */ (0, import_jsx_runtime34.jsx)(ChatBubble, { role: "ai", children: entry.text });
    }
    if (entry.type === "tool-call") {
      const highRisk = entry.risk === "destructive";
      return /* @__PURE__ */ (0, import_jsx_runtime34.jsxs)("div", { style: { paddingLeft: 28, display: "flex", flexDirection: "column", gap: 6 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime34.jsx)(
          ToolCallCard,
          {
            verb: titleForTool(entry, lang),
            target: toolTarget(entry, t),
            status: statusForTool(entry.state),
            params: entry.input,
            errorMessage: entry.state === "error" ? entry.text : null
          }
        ),
        entry.state === "awaiting-approval" ? /* @__PURE__ */ (0, import_jsx_runtime34.jsx)(
          ApprovalCard,
          {
            risk: highRisk ? "high" : "normal",
            lang,
            title: titleForTool(entry, lang),
            description: entry.name,
            params: entry.input,
            onAllow: () => onApprove && onApprove(entry.toolUseId, "allow"),
            onDeny: () => onApprove && onApprove(entry.toolUseId, "deny"),
            onAllowSession: highRisk ? null : () => onApprove && onApprove(entry.toolUseId, "allow-session")
          }
        ) : null
      ] });
    }
    if (entry.type === "error") {
      return /* @__PURE__ */ (0, import_jsx_runtime34.jsx)("div", { style: { paddingLeft: 28 }, children: /* @__PURE__ */ (0, import_jsx_runtime34.jsx)(ToolCallCard, { verb: entry.kind === "model" ? t.modelErrorTitle : t.errorTitle, target: entry.kind, status: "error", errorMessage: entry.message }) });
    }
    return null;
  }
  function menuItems(items, currentId, onSelect) {
    return (items || []).map((item) => ({
      label: item.label,
      hint: item.caption,
      checked: item.id === currentId,
      onSelect: () => onSelect && onSelect(item.id)
    }));
  }
  function ChatScreen({
    lang = "zh",
    entries = [],
    streaming = false,
    thinking = false,
    composerDisabled = false,
    disabledHint = "",
    onSend,
    onStop,
    onApprove,
    onNewSession,
    promptCards,
    noticeActionLabel,
    onNoticeAction,
    chipState,
    onChipModel,
    onChipEffort,
    onChipFast,
    onChipApproval
  }) {
    const t = C[lang] || C.zh;
    const [draft, setDraft] = import_react36.default.useState("");
    const logRef = import_react36.default.useRef(null);
    const hasEntries = entries.length > 0;
    const prompts = promptCards || DEFAULT_PROMPTS[lang] || DEFAULT_PROMPTS.zh;
    const chips = chipState && chipState.descriptor ? buildComposerChips({ ...chipState, lang }) : null;
    const composerOptions = chips ? /* @__PURE__ */ (0, import_jsx_runtime34.jsxs)(import_react36.default.Fragment, { children: [
      chips.model ? /* @__PURE__ */ (0, import_jsx_runtime34.jsx)(
        ComposerChip,
        {
          icon: "box",
          label: chips.model.current,
          title: t.modelChip,
          menuHeader: { label: t.modelChip },
          items: menuItems(chips.model.items, chipState.modelId, onChipModel)
        }
      ) : null,
      chips.effort ? /* @__PURE__ */ (0, import_jsx_runtime34.jsx)(
        ComposerChip,
        {
          icon: "brain",
          label: chips.effort.current,
          title: t.effortChip,
          menuHeader: { label: t.effortChip },
          items: menuItems(chips.effort.items, chipState.effort, onChipEffort)
        }
      ) : null,
      chips.fast ? /* @__PURE__ */ (0, import_jsx_runtime34.jsx)(
        ComposerChip,
        {
          icon: "zap",
          label: t.fastChip,
          title: t.fastChip,
          active: chips.fast.active,
          onToggle: (next) => onChipFast && onChipFast(next)
        }
      ) : null,
      /* @__PURE__ */ (0, import_jsx_runtime34.jsx)(
        ComposerChip,
        {
          icon: "shield",
          label: chips.approval.current,
          title: t.approvalChip,
          menuHeader: { label: t.approvalChip },
          items: menuItems(chips.approval.items, chipState.permissionMode, onChipApproval)
        }
      )
    ] }) : null;
    import_react36.default.useEffect(() => {
      const el = logRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }, [entries, streaming, thinking]);
    const send = () => {
      const text = draft.trim();
      if (!text || composerDisabled || streaming) return;
      if (onSend) onSend(text);
      setDraft("");
    };
    return /* @__PURE__ */ (0, import_jsx_runtime34.jsxs)("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime34.jsxs)("div", { ref: logRef, style: { flex: 1, minHeight: 0, overflow: "auto", padding: "var(--space-3)", display: "flex", flexDirection: "column", gap: "var(--space-3)" }, children: [
        !hasEntries && composerDisabled ? /* @__PURE__ */ (0, import_jsx_runtime34.jsx)(import_react36.default.Fragment, { children: /* @__PURE__ */ (0, import_jsx_runtime34.jsxs)("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "var(--space-5) 0 var(--space-2)", textAlign: "center" }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime34.jsx)(AIAvatar, { size: 32 }),
          /* @__PURE__ */ (0, import_jsx_runtime34.jsx)("div", { style: { font: "600 12px/1.35 var(--font-ui)", color: "var(--text-primary)", maxWidth: 240 }, children: disabledHint || t.keyTitle }),
          /* @__PURE__ */ (0, import_jsx_runtime34.jsx)("div", { style: { font: "400 11px/1.45 var(--font-ui)", color: "var(--text-tertiary)", maxWidth: 250 }, children: t.keyCaption })
        ] }) }) : null,
        !hasEntries && !composerDisabled ? /* @__PURE__ */ (0, import_jsx_runtime34.jsxs)(import_react36.default.Fragment, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime34.jsxs)("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "var(--space-5) 0 var(--space-2)", textAlign: "center" }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime34.jsx)(AIAvatar, { size: 32 }),
            /* @__PURE__ */ (0, import_jsx_runtime34.jsx)("div", { style: { font: "400 12px/1.55 var(--font-ui)", color: "var(--text-secondary)", maxWidth: 240 }, children: t.hello })
          ] }),
          prompts.map((card) => /* @__PURE__ */ (0, import_jsx_runtime34.jsx)(
            PromptCard,
            {
              icon: card.icon,
              title: card.title,
              caption: card.caption,
              onClick: () => {
                if (card.onClick) card.onClick(card);
                else if (onSend) onSend(card.prompt || card.title);
              }
            },
            card.id || card.title
          ))
        ] }) : null,
        entries.map((entry) => /* @__PURE__ */ (0, import_jsx_runtime34.jsx)(Entry, { entry, lang, onApprove }, entry.id)),
        streaming && thinking ? /* @__PURE__ */ (0, import_jsx_runtime34.jsxs)("div", { style: { paddingLeft: 28, display: "flex", alignItems: "center", gap: 6, font: "400 11px/1.4 var(--font-ui)", color: "var(--text-tertiary)" }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime34.jsx)(Spinner, { size: 12 }),
          /* @__PURE__ */ (0, import_jsx_runtime34.jsx)("span", { children: t.thinking })
        ] }) : null
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime34.jsx)("div", { style: { flex: "none", padding: "var(--space-2) var(--space-3) var(--space-3)", borderTop: "1px solid var(--border-subtle)" }, children: /* @__PURE__ */ (0, import_jsx_runtime34.jsx)(
        Composer,
        {
          value: draft,
          onChange: setDraft,
          onSend: send,
          onStop,
          streaming,
          disabled: composerDisabled,
          placeholder: t.placeholder,
          options: composerOptions,
          notice: disabledHint ? /* @__PURE__ */ (0, import_jsx_runtime34.jsx)(Notice, { text: disabledHint, actionLabel: noticeActionLabel || t.noticeAction, onAction: onNoticeAction || onNewSession }) : null
        }
      ) })
    ] });
  }

  // src/lib/sse.js
  function createSseParser(onEvent) {
    let buffer = "";
    function parseFrame(frame) {
      let event = "";
      let data = "";
      const lines = frame.replace(/\r\n/g, "\n").split("\n");
      for (const line of lines) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          data += line.slice(5).trimStart();
        }
      }
      const trimmed = data.trim();
      if (!trimmed || trimmed === "[DONE]") return;
      try {
        onEvent({ event, data: JSON.parse(trimmed) });
      } catch (e) {
      }
    }
    function feed(chunkText) {
      buffer += String(chunkText || "");
      buffer = buffer.replace(/\r\n/g, "\n");
      let splitAt = buffer.indexOf("\n\n");
      while (splitAt !== -1) {
        const frame = buffer.slice(0, splitAt);
        buffer = buffer.slice(splitAt + 2);
        parseFrame(frame);
        splitAt = buffer.indexOf("\n\n");
      }
    }
    return { feed };
  }

  // src/lib/providerProfile.js
  var DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
  var DEFAULT_CODEX_PROVIDER_ID = "ae_mcp_custom";
  var DEFAULT_CODEX_WIRE_API = "responses";
  var RESERVED_CODEX_PROVIDER_IDS = /* @__PURE__ */ new Set(["openai", "amazon-bedrock", "ollama", "lmstudio"]);
  function firstValue(...values) {
    for (const value of values) {
      const text = String(value || "").trim();
      if (text) return text;
    }
    return "";
  }
  function normalizeBaseUrl(value) {
    return String(value || "").trim().replace(/\/+$/, "");
  }
  function normalizeProviderId(value) {
    const raw = String(value || "").trim() || DEFAULT_CODEX_PROVIDER_ID;
    const safe = raw.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || DEFAULT_CODEX_PROVIDER_ID;
    return RESERVED_CODEX_PROVIDER_IDS.has(safe) ? safe + "-custom" : safe;
  }
  function normalizeCodexWireApi() {
    return DEFAULT_CODEX_WIRE_API;
  }
  function tomlString(value) {
    return JSON.stringify(String(value || ""));
  }
  function normalizeProviderProfile(input = {}, env = {}) {
    const codexBaseUrl = normalizeBaseUrl(firstValue(input.codexBaseUrl, env.AE_MCP_CODEX_BASE_URL));
    const anthropicBaseUrl = normalizeBaseUrl(firstValue(input.anthropicBaseUrl, env.AE_MCP_ANTHROPIC_BASE_URL));
    return {
      codexApiKey: firstValue(input.codexApiKey, env.AE_MCP_CODEX_API_KEY),
      codexBaseUrl,
      codexProviderId: normalizeProviderId(firstValue(input.codexProviderId, env.AE_MCP_CODEX_PROVIDER_ID)),
      codexWireApi: normalizeCodexWireApi(),
      anthropicBaseUrl
    };
  }
  function codexAppServerArgs(profile = {}) {
    const normalized = normalizeProviderProfile(profile);
    if (!normalized.codexBaseUrl) return ["app-server"];
    const provider = normalized.codexProviderId;
    return [
      "app-server",
      "-c",
      `model_provider=${tomlString(provider)}`,
      "-c",
      `model_providers.${provider}.name="AE MCP Custom"`,
      "-c",
      `model_providers.${provider}.base_url=${tomlString(normalized.codexBaseUrl)}`,
      "-c",
      `model_providers.${provider}.env_key="AE_MCP_CODEX_API_KEY"`,
      "-c",
      `model_providers.${provider}.wire_api=${tomlString(normalized.codexWireApi)}`,
      "-c",
      `model_providers.${provider}.requires_openai_auth=false`
    ];
  }
  function codexSpawnEnv(profile = {}, baseEnv = {}) {
    const normalized = normalizeProviderProfile(profile, baseEnv);
    const env = { ...baseEnv || {} };
    if (normalized.codexApiKey) env.AE_MCP_CODEX_API_KEY = normalized.codexApiKey;
    return env;
  }
  function anthropicEndpoint(baseUrl, apiPath) {
    const base = normalizeBaseUrl(baseUrl) || DEFAULT_ANTHROPIC_BASE_URL;
    const url = new URL(base);
    const prefix = url.pathname.replace(/\/+$/, "");
    const rawPath = String(apiPath || "");
    const queryIndex = rawPath.indexOf("?");
    const pathPart = queryIndex === -1 ? rawPath : rawPath.slice(0, queryIndex);
    const searchPart = queryIndex === -1 ? "" : rawPath.slice(queryIndex);
    const suffix = pathPart.startsWith("/") ? pathPart : "/" + pathPart;
    url.pathname = (prefix === "/" ? "" : prefix) + suffix;
    url.search = searchPart;
    url.hash = "";
    return url.toString();
  }
  function ensureUserEnv(env = {}, { homedir = "", appData = "" } = {}) {
    const next = { ...env };
    const anchor = String(next.USERPROFILE || next.HOME || homedir || "").replace(/[\\/]+$/, "");
    if (!anchor) return next;
    if (!next.USERPROFILE) next.USERPROFILE = anchor;
    if (!next.HOME) next.HOME = anchor;
    if (!next.APPDATA) next.APPDATA = appData || anchor + "\\AppData\\Roaming";
    return next;
  }

  // src/lib/anthropic.js
  var DEFAULT_MODEL = "claude-sonnet-4-6";
  function buildSystemPrompt(lang = "zh") {
    if (lang === "en") {
      return [
        "You are a concise After Effects assistant inside the AE MCP panel.",
        "Understand the user goal, then choose appropriate MCP tools before operating.",
        "Name target comps, layers, properties, or files in quotes before changing them.",
        "Prefer read-only inspection before edits when context is missing.",
        "Summarize tool results plainly and ask only when a required detail is missing.",
        "",
        "Working mode:",
        "- Prefer typed tools (ae_createLayer / ae_setProperty / ae_readProps, etc.); use ae_exec scripts only when no typed tool fits.",
        "- Before scripting, inspect with read tools (ae_overview / ae_layers / ae_readProps) to confirm structure instead of guessing project contents.",
        "- ae_exec accepts only code and undoGroup; it has no comp_id or other targeting parameters. Put target lookup inside the script.",
        "- If the MCP/panel path is unavailable, Do not switch to OS screenshots, desktop automation, or ad-hoc external scripts; report the MCP failure to the user.",
        "- Keep generated files and temporary files in the project workspace or a user-approved output directory; do not scatter files outside it.",
        "",
        "ExtendScript scripting pitfalls (must follow):",
        "- setTemporalEaseAtKey ease arrays must match the property dimension (1D like Opacity=1; Scale 3D=3; spatial properties like Position=1). Use AEMCP.easeKeys(prop) to size them automatically.",
        '- Any byName / index lookup may return null; check before use, or call AEMCP.mustFind(value, "name") so the error names the missing target.',
        "- Do not invent APIs that do not exist (for example items.byName); if unsure, use read tools or iterate.",
        "- AE may be localized (Chinese): display names are translated, so prefer matchName for property matching.",
        "- AEMCP helpers (safeValue / easeKeys / mustFind / compById / layerById) are injected and available; layerById and similar helpers expect numeric ids."
      ].join(" ");
    }
    return [
      "\u4F60\u662F AE MCP \u9762\u677F\u5185\u7684\u7B80\u6D01 After Effects \u52A9\u624B\u3002",
      "\u5148\u7406\u89E3\u7528\u6237\u76EE\u6807\uFF0C\u518D\u9009\u62E9\u5408\u9002\u7684 MCP \u5DE5\u5177\u64CD\u4F5C AE\u3002",
      "\u4FEE\u6539\u524D\u7528\u5F15\u53F7\u660E\u793A\u76EE\u6807\u5408\u6210\u3001\u56FE\u5C42\u3001\u5C5E\u6027\u6216\u6587\u4EF6\u3002",
      "\u7F3A\u5C11\u4E0A\u4E0B\u6587\u65F6\u4F18\u5148\u7528\u53EA\u8BFB\u5DE5\u5177\u68C0\u67E5\u3002",
      "\u7528\u7B80\u660E\u8BED\u8A00\u603B\u7ED3\u5DE5\u5177\u7ED3\u679C\uFF0C\u53EA\u5728\u7F3A\u5C11\u5FC5\u8981\u4FE1\u606F\u65F6\u8FFD\u95EE\u3002",
      "",
      "\u5DE5\u4F5C\u65B9\u5F0F\uFF1A",
      "- \u4F18\u5148\u4F7F\u7528 typed \u5DE5\u5177\uFF08ae_createLayer / ae_setProperty / ae_readProps \u7B49\uFF09\uFF1B\u53EA\u6709\u6CA1\u6709\u5BF9\u5E94\u5DE5\u5177\u65F6\u624D\u7528 ae_exec \u5199\u811A\u672C\u3002",
      "- \u5199\u811A\u672C\u524D\u5148\u7528\u8BFB\u5DE5\u5177\uFF08ae_overview / ae_layers / ae_readProps\uFF09\u786E\u8BA4\u7ED3\u6784\uFF0C\u4E0D\u8981\u51ED\u8BB0\u5FC6\u731C\u6D4B\u5DE5\u7A0B\u5185\u5BB9\u3002",
      "- ae_exec \u53EA\u63A5\u53D7 code \u4E0E undoGroup \u4E24\u4E2A\u53C2\u6570\uFF0C\u6CA1\u6709 comp_id \u7B49\u5B9A\u4F4D\u53C2\u6570\u2014\u2014\u76EE\u6807\u5B9A\u4F4D\u5199\u5728\u811A\u672C\u91CC\u3002",
      "- MCP/\u9762\u677F\u901A\u9053\u4E0D\u53EF\u7528\u65F6\uFF0CDo not switch to OS screenshots\u3001\u684C\u9762\u81EA\u52A8\u5316\u6216\u5916\u90E8\u4E34\u65F6\u811A\u672C\uFF1Breport the MCP failure \u7ED9\u7528\u6237\u3002",
      "- \u751F\u6210\u6587\u4EF6\u548C temporary files \u653E\u5728 project workspace \u6216\u7528\u6237\u660E\u786E\u540C\u610F\u7684\u8F93\u51FA\u76EE\u5F55\uFF0C\u4E0D\u8981\u6563\u843D\u5230\u5DE5\u4F5C\u533A\u5916\u3002",
      "",
      "ExtendScript \u9AD8\u9891\u9677\u9631\uFF08\u52A1\u5FC5\u9075\u5B88\uFF09\uFF1A",
      "- setTemporalEaseAtKey \u7684\u7F13\u52A8\u6570\u7EC4\u957F\u5EA6\u5FC5\u987B\u7B49\u4E8E\u5C5E\u6027\u7EF4\u5EA6\uFF08\u4E00\u7EF4\u5982 Opacity=1\uFF1BScale \u4E09\u7EF4=3\uFF1B\u7A7A\u95F4\u5C5E\u6027\u5982 Position=1\uFF09\u3002\u76F4\u63A5\u7528 AEMCP.easeKeys(prop) \u81EA\u52A8\u5904\u7406\u3002",
      '- \u4EFB\u4F55 byName / \u7D22\u5F15\u67E5\u627E\u90FD\u53EF\u80FD\u8FD4\u56DE null\uFF0C\u4F7F\u7528\u524D\u5FC5\u987B\u5224\u7A7A\uFF1B\u6216\u7528 AEMCP.mustFind(value, "\u540D\u5B57") \u8BA9\u9519\u8BEF\u81EA\u5E26\u540D\u5B57\u3002',
      "- \u4E0D\u5B58\u5728\u7684 API \u4E0D\u8981\u81C6\u9020\uFF08\u5982 items.byName \u4E0D\u5B58\u5728\uFF09\uFF1B\u4E0D\u786E\u5B9A\u5C31\u5148\u7528\u8BFB\u5DE5\u5177\u6216\u904D\u5386\u3002",
      "- \u672C\u673A\u53EF\u80FD\u662F\u672C\u5730\u5316\uFF08\u4E2D\u6587\uFF09AE\uFF1A\u663E\u793A\u540D\u662F\u7FFB\u8BD1\u8FC7\u7684\uFF0C\u5339\u914D\u5C5E\u6027\u4F18\u5148\u7528 matchName\u3002",
      "- AEMCP \u52A9\u624B\uFF08safeValue / easeKeys / mustFind / compById / layerById\uFF09\u5DF2\u6CE8\u5165\uFF0C\u53EF\u76F4\u63A5\u8C03\u7528\uFF1BlayerById \u7B49\u7528\u6570\u5B57 id\u3002"
    ].join(" ");
  }
  function mapMcpToolsToAnthropic(tools = []) {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description || "",
      input_schema: tool.inputSchema || tool.input_schema || {}
    }));
  }
  function classifyHttpError(status, fallbackMessage) {
    if (status === 401 || status === 403) return { kind: "auth", message: "Anthropic authentication failed." };
    if (status === 404) return { kind: "model", message: "Model unavailable for this API key." };
    if (status === 429) return { kind: "rate_limit", message: "Anthropic rate limit reached." };
    if (status === 529 || status >= 500) return { kind: "overloaded", message: "Anthropic service is overloaded." };
    return { kind: "network", message: fallbackMessage || "Anthropic request failed." };
  }
  function toError(kind, message) {
    const error = new Error(message);
    error.kind = kind;
    return error;
  }
  function parseAnthropicEvent(data, state, onTextDelta) {
    if (data.type === "content_block_start") {
      const block = data.content_block || {};
      if (block.type === "text") {
        state.blocks.set(data.index, { type: "text", text: block.text || "" });
      } else if (block.type === "tool_use") {
        state.blocks.set(data.index, {
          type: "tool_use",
          id: block.id,
          name: block.name,
          inputJson: "",
          startInput: block.input || {}
        });
      }
    } else if (data.type === "content_block_delta") {
      const block = state.blocks.get(data.index);
      if (!block || !data.delta) return;
      if (data.delta.type === "text_delta") {
        const text = data.delta.text || "";
        block.text += text;
        if (text) onTextDelta(text);
      } else if (data.delta.type === "input_json_delta") {
        block.inputJson += data.delta.partial_json || "";
      }
    } else if (data.type === "message_delta" && data.delta) {
      state.stopReason = data.delta.stop_reason || state.stopReason;
    }
  }
  function finishBlocks(blocks) {
    return Array.from(blocks.values()).map((block) => {
      if (block.type === "tool_use") {
        let input = block.startInput || {};
        if (block.inputJson) input = JSON.parse(block.inputJson);
        return { type: "tool_use", id: block.id, name: block.name, input };
      }
      return block;
    });
  }
  async function sendAnthropicMessage({
    apiKey,
    baseUrl = "",
    model = DEFAULT_MODEL,
    system = buildSystemPrompt("zh"),
    messages,
    tools,
    signal,
    effort = null,
    fast = false,
    fetchImpl = globalThis.fetch,
    onTextDelta = () => {
    }
  } = {}) {
    if (!apiKey) throw toError("auth", "Anthropic API key is missing.");
    if (!fetchImpl) throw toError("network", "fetch is unavailable in this runtime.");
    let response;
    try {
      const url = anthropicEndpoint(baseUrl, "/v1/messages");
      const headers = {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
        "content-type": "application/json"
      };
      if (fast) headers["anthropic-beta"] = "fast-mode-2026-02-01";
      const body = {
        model,
        max_tokens: 8192,
        system,
        messages,
        tools: mapMcpToolsToAnthropic(tools),
        stream: true
      };
      if (effort) body.output_config = { effort };
      if (fast) body.speed = "fast";
      response = await fetchImpl(url, {
        method: "POST",
        signal,
        headers,
        body: JSON.stringify(body)
      });
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      throw toError("network", e && e.message ? e.message : "Anthropic network request failed.");
    }
    if (!response.ok) {
      let detail = "";
      try {
        detail = await response.text();
      } catch (e) {
      }
      const classified = classifyHttpError(response.status, detail);
      throw toError(classified.kind, classified.message);
    }
    const reader = response.body && response.body.getReader ? response.body.getReader() : null;
    if (!reader) throw toError("network", "Anthropic response body is not streamable.");
    const decoder = new TextDecoder();
    const state = { blocks: /* @__PURE__ */ new Map(), stopReason: "end_turn" };
    const parser = createSseParser(({ data }) => parseAnthropicEvent(data, state, onTextDelta));
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      parser.feed(decoder.decode(chunk.value, { stream: true }));
    }
    parser.feed(decoder.decode());
    return {
      assistantMessage: { role: "assistant", content: finishBlocks(state.blocks) },
      stopReason: state.stopReason
    };
  }

  // src/lib/agentLoop.js
  var MAX_TOOL_ROUNDS = 25;
  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }
  function toolText(result) {
    const content = result && Array.isArray(result.content) ? result.content : [];
    const text = content.filter((item) => item && item.type === "text").map((item) => item.text || "").join("\n");
    if (text) return text;
    if (result === void 0) return "";
    try {
      return JSON.stringify(result);
    } catch (e) {
      return String(result);
    }
  }
  function normalizeErrorKind(error) {
    if (error && error.name === "AbortError") return "aborted";
    return error && error.kind || "network";
  }
  function shouldBypassApproval({ mode, tool, sessionAllowed }) {
    if (sessionAllowed) return true;
    if (mode === "none") return true;
    const annotations = tool && tool.annotations || {};
    if (mode === "readonly") return annotations.readOnlyHint === true;
    if (mode === "manual") return annotations.readOnlyHint === true;
    if (mode === "auto") return annotations.destructiveHint !== true;
    return false;
  }
  function approvalRisk(tool) {
    const annotations = tool && tool.annotations || {};
    return annotations.destructiveHint === true ? "destructive" : "write";
  }
  function getToolUses(message) {
    return (message && message.content || []).filter((block) => block && block.type === "tool_use");
  }
  function makeToolResult(toolUseId, text, isError) {
    return { type: "tool_result", tool_use_id: toolUseId, content: text, is_error: Boolean(isError) };
  }
  function createAgentLoop({
    getApiKey,
    getApiBaseUrl,
    getModel,
    mcp,
    getPermissionMode,
    getEffort,
    getFast,
    onEvent,
    anthropic = sendAnthropicMessage,
    maxToolRounds = MAX_TOOL_ROUNDS,
    lang = "zh"
  }) {
    let messages = [];
    let activeController = null;
    let activeRun = null;
    const pendingApprovals = /* @__PURE__ */ new Map();
    const sessionAllowedTools = /* @__PURE__ */ new Set();
    function emit(evt) {
      if (onEvent) onEvent(evt);
    }
    function resetPendingApprovals() {
      for (const [id, pending] of pendingApprovals) {
        pendingApprovals.delete(id);
        emit({ type: "tool-denied", toolUseId: id });
        pending.resolve({ decision: "abort" });
      }
    }
    async function waitForApproval(toolUse) {
      return await new Promise((resolve) => {
        pendingApprovals.set(toolUse.id, { name: toolUse.name, resolve });
      });
    }
    async function executeTool(toolUse) {
      const start = Date.now();
      try {
        const result = await mcp.callTool(toolUse.name, toolUse.input || {});
        const text = toolText(result);
        const isError = Boolean(result && result.isError);
        emit({ type: "tool-result", toolUseId: toolUse.id, ok: !isError, text, durationMs: Date.now() - start });
        return makeToolResult(toolUse.id, text, isError);
      } catch (e) {
        const text = e && e.message ? e.message : "MCP tool call failed.";
        emit({ type: "tool-result", toolUseId: toolUse.id, ok: false, text, durationMs: Date.now() - start });
        return makeToolResult(toolUse.id, text, true);
      }
    }
    async function handleToolUse(toolUse, toolByName) {
      emit({ type: "tool-start", toolUseId: toolUse.id, name: toolUse.name, input: clone(toolUse.input || {}) });
      const tool = toolByName.get(toolUse.name) || {};
      const mode = getPermissionMode && getPermissionMode() || "manual";
      if (mode === "readonly" && !(tool.annotations && tool.annotations.readOnlyHint === true)) {
        emit({ type: "tool-denied", toolUseId: toolUse.id });
        return makeToolResult(toolUse.id, "Blocked: read-only mode allows only read tools.", true);
      }
      const sessionAllowed = sessionAllowedTools.has(toolUse.name);
      if (!shouldBypassApproval({ mode, tool, sessionAllowed })) {
        emit({
          type: "approval-required",
          toolUseId: toolUse.id,
          name: toolUse.name,
          input: clone(toolUse.input || {}),
          risk: approvalRisk(tool)
        });
        const approved = await waitForApproval(toolUse);
        pendingApprovals.delete(toolUse.id);
        if (approved.decision === "abort") throw Object.assign(new Error("aborted"), { name: "AbortError" });
        if (approved.decision === "deny") {
          emit({ type: "tool-denied", toolUseId: toolUse.id });
          return makeToolResult(toolUse.id, "User denied this action.", true);
        }
        if (approved.decision === "allow-session") sessionAllowedTools.add(toolUse.name);
      }
      return await executeTool(toolUse);
    }
    async function sendUser(text) {
      if (activeRun) return activeRun;
      const userMessage = { role: "user", content: String(text || "") };
      messages.push(userMessage);
      emit({ type: "turn-start" });
      const controller = new AbortController();
      activeController = controller;
      activeRun = (async () => {
        try {
          const tools = await mcp.listTools();
          const toolByName = new Map((tools || []).map((tool) => [tool.name, tool]));
          const serverInstr = mcp.getServerInstructions && mcp.getServerInstructions() || "";
          const system = serverInstr ? buildSystemPrompt(lang) + "\n\n" + serverInstr : buildSystemPrompt(lang);
          let toolRounds = 0;
          while (true) {
            if (toolRounds >= maxToolRounds) {
              emit({ type: "error", kind: "mcp", message: "Stopped after 25 consecutive tool rounds." });
              return;
            }
            const result = await anthropic({
              apiKey: getApiKey && getApiKey(),
              baseUrl: getApiBaseUrl && getApiBaseUrl(),
              model: getModel && getModel() || DEFAULT_MODEL,
              system,
              messages: clone(messages),
              tools,
              signal: controller.signal,
              effort: getEffort && getEffort() || null,
              fast: Boolean(getFast && getFast()),
              onTextDelta: (delta) => emit({ type: "text-delta", text: delta })
            });
            const assistantMessage = result.assistantMessage || { role: "assistant", content: [] };
            messages.push(assistantMessage);
            const toolUses = getToolUses(assistantMessage);
            if (result.stopReason !== "tool_use" || toolUses.length === 0) {
              emit({ type: "turn-end", stopReason: result.stopReason || "end_turn" });
              return;
            }
            toolRounds += 1;
            const toolResults = [];
            for (const toolUse of toolUses) {
              toolResults.push(await handleToolUse(toolUse, toolByName));
            }
            messages.push({ role: "user", content: toolResults });
          }
        } catch (e) {
          const kind = normalizeErrorKind(e);
          repairDanglingToolUses();
          emit({ type: "error", kind, message: e && e.message ? e.message : "Agent loop failed." });
        } finally {
          activeController = null;
          activeRun = null;
        }
      })();
      return await activeRun;
    }
    function repairDanglingToolUses() {
      const last = messages[messages.length - 1];
      if (!last || last.role !== "assistant") return;
      const uses = getToolUses(last);
      if (!uses.length) return;
      messages.push({
        role: "user",
        content: uses.map((use) => makeToolResult(use.id, "Cancelled by user.", true))
      });
    }
    function approve(toolUseId, decision) {
      const pending = pendingApprovals.get(toolUseId);
      if (!pending) return;
      pending.resolve({ decision });
    }
    function stop() {
      if (activeController) activeController.abort();
      resetPendingApprovals();
    }
    function reset() {
      stop();
      messages = [];
      sessionAllowedTools.clear();
    }
    return {
      sendUser,
      approve,
      stop,
      reset,
      getMessages: () => clone(messages)
    };
  }

  // src/lib/ndjson.js
  function createLineSplitter(onLine) {
    let buffer = "";
    return function push(chunk) {
      buffer += String(chunk || "");
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) onLine(line);
        index = buffer.indexOf("\n");
      }
    };
  }
  function createNdjsonReader(onMessage) {
    return createLineSplitter((line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch (e) {
        return;
      }
      onMessage(message);
    });
  }

  // src/lib/claudeChannel.js
  function claudeChannelEnv(baseEnv = {}, { channel = "subscription", provider = null } = {}) {
    const env = { ...baseEnv };
    delete env.ANTHROPIC_API_KEY;
    if (channel === "api" && provider && provider.baseUrl) {
      env.ANTHROPIC_BASE_URL = String(provider.baseUrl);
      if (provider.apiKey) env.ANTHROPIC_AUTH_TOKEN = String(provider.apiKey);
      else delete env.ANTHROPIC_AUTH_TOKEN;
      return env;
    }
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_AUTH_TOKEN;
    return env;
  }

  // src/cep/claudeAgentBackend.js
  var READY_TIMEOUT_MS = 15e3;
  var STDERR_TAIL_LIMIT = 4096;
  var FIXED_NODE_CANDIDATE = "C:\\Program Files\\nodejs\\node.exe";
  function getCepRequire() {
    if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) {
      return globalThis.window.cep_node.require;
    }
    if (globalThis.window && globalThis.window.require) return globalThis.window.require;
    if (globalThis.require) return globalThis.require;
    throw new Error("CEP Node require is unavailable");
  }
  function getCepEnv() {
    return globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.process && globalThis.window.cep_node.process.env || {};
  }
  function execFileAsync(execFileImpl, file, args, env) {
    return new Promise((resolve) => {
      execFileImpl(file, args, { windowsHide: true, env }, (err, stdout, stderr) => {
        resolve({ err, stdout: String(stdout || ""), stderr: String(stderr || "") });
      });
    });
  }
  function nodeCandidates(stdout) {
    const seen = /* @__PURE__ */ new Set();
    const candidates = String(stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    candidates.push(FIXED_NODE_CANDIDATE);
    return candidates.filter((candidate) => {
      if (seen.has(candidate)) return false;
      seen.add(candidate);
      return true;
    });
  }
  function parseMajor(version) {
    const match = String(version || "").trim().match(/^v(\d+)/);
    return match ? Number(match[1]) : 0;
  }
  async function resolveSystemNode({ execFileImpl, env } = {}) {
    const execFile = execFileImpl || getCepRequire()("child_process").execFile;
    const processEnv = env || getCepEnv();
    const where = await execFileAsync(execFile, "where", ["node"], processEnv);
    const candidates = nodeCandidates(where.err ? "" : where.stdout);
    for (const candidate of candidates) {
      const checked = await execFileAsync(execFile, candidate, ["--version"], processEnv);
      if (checked.err) continue;
      const version = String(checked.stdout || checked.stderr || "").trim();
      if (parseMajor(version) >= 18) return { ok: true, nodePath: candidate, version };
    }
    return { ok: false, detail: "No system Node 18+ found." };
  }
  function clone2(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }
  function nodeMissingMessage(lang) {
    if (lang === "zh") return "\u5185\u5D4C\u5BF9\u8BDD\u9700\u8981\u7CFB\u7EDF Node 18+\uFF08\u672A\u68C0\u6D4B\u5230\uFF09\u3002\u5B89\u88C5 Node.js LTS \u540E\u91CD\u8BD5\u3002";
    return "Embedded chat needs system Node 18+. Install Node.js LTS and retry.";
  }
  function appendTail2(tail, chunk) {
    const next = tail + String(chunk || "");
    return next.length > STDERR_TAIL_LIMIT ? next.slice(next.length - STDERR_TAIL_LIMIT) : next;
  }
  function createClaudeAgentBackend({
    resolveNode = resolveSystemNode,
    sidecarPath,
    getMcpSpec,
    getToolMeta,
    getModel,
    getPermissionMode,
    getEffort,
    getThinking,
    getChannel = () => "subscription",
    getApiProvider = () => null,
    onEvent,
    lang = "zh",
    spawnImpl,
    env
  }) {
    let proc = null;
    let startPromise = null;
    let pendingReadyReject = null;
    let pendingReadyTimer = null;
    let ready = false;
    let stopping = false;
    let stderrTail = "";
    let transcript = [];
    let activeRun = null;
    let activeResolve = null;
    let activeAssistantText = "";
    function emit(evt) {
      if (onEvent) onEvent(evt);
    }
    function getSpawn() {
      if (spawnImpl) return spawnImpl;
      return getCepRequire()("child_process").spawn;
    }
    function writeMessage(message) {
      if (!proc || !proc.stdin || !proc.stdin.write) return;
      proc.stdin.write(JSON.stringify(message) + "\n");
    }
    function finishActive() {
      if (!activeResolve) {
        activeRun = null;
        activeAssistantText = "";
        return;
      }
      const resolve = activeResolve;
      activeResolve = null;
      activeRun = null;
      activeAssistantText = "";
      resolve();
    }
    function handleSidecarMessage(message) {
      if (!message || message.t === "ready") return;
      if (message.t !== "event") return;
      const event = message.event;
      if (!event) return;
      if (event.type === "text-delta") activeAssistantText += String(event.text || "");
      emit(event);
      if (event.type === "turn-end") {
        transcript.push({ role: "assistant", text: activeAssistantText });
        finishActive();
      }
      if (event.type === "error") finishActive();
    }
    function exitDetail(code, signal) {
      const suffix = signal ? String(code) + " " + signal : String(code);
      return stderrTail ? suffix + " " + stderrTail : suffix;
    }
    function clearReadyWait() {
      if (pendingReadyTimer) clearTimeout(pendingReadyTimer);
      pendingReadyTimer = null;
      pendingReadyReject = null;
    }
    function handleExit(code, signal) {
      const wasStopping = stopping;
      const wasReady = ready;
      const detail = exitDetail(code, signal);
      const rejectReady = pendingReadyReject;
      proc = null;
      ready = false;
      startPromise = null;
      stopping = false;
      if (wasStopping) return;
      if (!wasReady && rejectReady) {
        clearReadyWait();
        rejectReady(new Error("sidecar exited: " + detail));
        return;
      }
      if (activeRun) {
        emit({ type: "error", kind: "mcp", message: "sidecar exited: " + detail });
        finishActive();
      }
    }
    function handleProcError(error) {
      const rejectReady = pendingReadyReject;
      proc = null;
      ready = false;
      startPromise = null;
      if (rejectReady) {
        clearReadyWait();
        rejectReady(error instanceof Error ? error : new Error("sidecar error"));
        return;
      }
      if (activeRun) {
        emit({ type: "error", kind: "mcp", message: error && error.message ? error.message : "sidecar error" });
        finishActive();
      }
    }
    async function startSidecar() {
      if (proc && ready) return true;
      if (startPromise) return startPromise;
      startPromise = (async () => {
        const node = await resolveNode();
        if (!node || !node.ok) {
          emit({ type: "error", kind: "mcp", message: nodeMissingMessage(lang) });
          return false;
        }
        const mcpSpec = await getMcpSpec();
        const meta = await getToolMeta();
        const spawn = getSpawn();
        const channel = getChannel ? getChannel() : "subscription";
        const spawnEnv = claudeChannelEnv(env || getCepEnv(), { channel, provider: getApiProvider ? getApiProvider() : null });
        stderrTail = "";
        stopping = false;
        ready = false;
        let readyResolve;
        let readyReject;
        const readyPromise = new Promise((resolve, reject) => {
          readyResolve = resolve;
          readyReject = reject;
        });
        pendingReadyReject = readyReject;
        pendingReadyTimer = setTimeout(() => {
          pendingReadyTimer = null;
          pendingReadyReject = null;
          try {
            stopping = true;
            if (proc) proc.kill();
          } catch (e) {
          }
          readyReject(new Error("sidecar ready timed out"));
        }, READY_TIMEOUT_MS);
        try {
          proc = spawn(node.nodePath, [
            sidecarPath,
            "--mcp",
            JSON.stringify(mcpSpec),
            "--allowed-tools",
            JSON.stringify(meta.allowedTools),
            "--annotations",
            JSON.stringify(meta.annotations),
            "--model",
            getModel(),
            "--lang",
            lang,
            "--channel",
            channel
          ], {
            stdio: "pipe",
            windowsHide: true,
            env: spawnEnv
          });
        } catch (e) {
          clearReadyWait();
          throw e;
        }
        const reader = createNdjsonReader((message) => {
          if (message && message.t === "ready") {
            ready = true;
            clearReadyWait();
            readyResolve(true);
            return;
          }
          handleSidecarMessage(message);
        });
        if (proc.stdout && proc.stdout.on) proc.stdout.on("data", reader);
        if (proc.stderr && proc.stderr.on) proc.stderr.on("data", (chunk) => {
          stderrTail = appendTail2(stderrTail, chunk);
        });
        proc.on("exit", (code, signal) => handleExit(code, signal));
        proc.on("error", (error) => {
          handleProcError(error);
        });
        await readyPromise;
        return true;
      })();
      try {
        return await startPromise;
      } catch (e) {
        emit({ type: "error", kind: "mcp", message: e && e.message ? e.message : "Failed to start sidecar." });
        return false;
      } finally {
        startPromise = null;
      }
    }
    async function sendUser(text) {
      if (activeRun) return activeRun;
      activeAssistantText = "";
      activeRun = new Promise((resolve) => {
        activeResolve = resolve;
      });
      const ok = await startSidecar();
      if (!ok) {
        finishActive();
        return activeRun;
      }
      const userText = String(text || "");
      transcript.push({ role: "user", text: userText });
      writeMessage({
        t: "user",
        text: userText,
        permissionMode: getPermissionMode(),
        model: getModel(),
        effort: getEffort ? getEffort() : void 0,
        thinking: getThinking ? getThinking() : void 0
      });
      return activeRun;
    }
    function approve(toolUseId, decision) {
      writeMessage({ t: "approve", id: toolUseId, decision });
    }
    function stop() {
      writeMessage({ t: "stop" });
    }
    function reset() {
      stopping = true;
      if (proc) {
        try {
          proc.kill();
        } catch (e) {
        }
      }
      proc = null;
      ready = false;
      startPromise = null;
      transcript = [];
      finishActive();
      stderrTail = "";
      stopping = false;
    }
    return {
      sendUser,
      approve,
      stop,
      reset,
      getMessages: () => clone2(transcript),
      getStderrTail: () => stderrTail
    };
  }

  // src/cep/apiKey.js
  var KEY_FILES = {
    anthropic: "anthropic-key",
    codex: "codex-key",
    zcode: "zcode-key"
  };
  function cepRequire2() {
    if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) return globalThis.window.cep_node.require;
    if (globalThis.window && globalThis.window.require) return globalThis.window.require;
    if (globalThis.require) return globalThis.require;
    return null;
  }
  function defaultDeps() {
    const req = cepRequire2();
    if (!req) throw new Error("CEP Node require is unavailable");
    return {
      fs: req("fs"),
      os: req("os"),
      path: req("path"),
      pid: req("process") && req("process").pid
    };
  }
  function createApiKeyStore(deps = defaultDeps()) {
    const fs = deps.fs;
    const os = deps.os;
    const path = deps.path;
    function keyDir() {
      return path.join(os.homedir(), ".ae-mcp");
    }
    function keyFile(name = "anthropic") {
      const file = KEY_FILES[String(name || "anthropic")];
      if (!file) throw new Error("Unsupported API key name: " + name);
      return file;
    }
    function keyPath(name = "anthropic") {
      return path.join(keyDir(), keyFile(name));
    }
    function readKey(name = "anthropic") {
      try {
        return fs.readFileSync(keyPath(name), "utf8").trim();
      } catch (e) {
        if (e && e.code === "ENOENT") return "";
        throw e;
      }
    }
    function writeKey(key, name = "anthropic") {
      const value = String(key || "").trim();
      const dir = keyDir();
      const fileName = keyFile(name);
      const file = keyPath(name);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const pid = deps.pid || 0;
      const tmp = path.join(dir, `${fileName}.${pid}.${Date.now()}.tmp`);
      fs.writeFileSync(tmp, value, "utf8");
      try {
        fs.chmodSync(tmp, 384);
      } catch (e) {
      }
      fs.renameSync(tmp, file);
      return value;
    }
    function clearKey(name = "anthropic") {
      try {
        fs.unlinkSync(keyPath(name));
      } catch (e) {
        if (!e || e.code !== "ENOENT") throw e;
      }
    }
    return { keyDir, keyPath, readKey, writeKey, clearKey };
  }

  // src/lib/zcodeErrors.js
  var ZH_RULES = [
    {
      // Provider ids may contain dots (e.g. "mediastorm_glm/glm-5.2"): capture the
      // whole non-space run, then drop one trailing sentence terminator if present.
      re: /Model provider is missing an API key:\s*([^\s]+?)[.。]?(?=\s|$)/i,
      hint: (m) => "ZCode provider\u300C" + m[1] + "\u300D\u7F3A\u5C11 API Key \u2014\u2014 \u5230 \u8BBE\u7F6E \u2192 AI \u670D\u52A1 \u2192 ZCode \u901A\u9053 \u7C98\u8D34\u4E00\u6B21 Key\uFF08\u4FDD\u5B58\u5728\u672C\u673A ~/.ae-mcp/zcode-key\uFF09\uFF0C\u6216\u5728 ~/.zcode/cli/config.json \u91CC\u914D\u7F6E\u3002"
    },
    {
      re: /Model config is missing/i,
      hint: () => "\u672A\u627E\u5230 ZCode \u6A21\u578B\u914D\u7F6E \u2014\u2014 \u6253\u5F00 ZCode \u9009\u62E9 provider/model\uFF0C\u6216\u521B\u5EFA ~/.zcode/cli/config.json \u6307\u5B9A provider \u4E0E\u9ED8\u8BA4\u6A21\u578B\u3002"
    },
    {
      re: /Provider authentication failed/i,
      hint: () => "ZCode provider \u9274\u6743\u5931\u8D25 \u2014\u2014 \u68C0\u67E5 API Key \u662F\u5426\u6709\u6548\uFF1B\u82E5\u662F\u5B98\u65B9\u6258\u7BA1\u8BA1\u5212\uFF08start-plan\uFF09\uFF0C\u9762\u677F\u5C1A\u4E0D\u652F\u6301\u5176\u684C\u9762\u9A8C\u8BC1\u7801\u6865\u63A5\uFF0C\u8BF7\u6539\u7528 CLI \u914D\u7F6E\u901A\u9053\u3002"
    }
  ];
  function localizeZcodeError(message, lang = "en") {
    const text = String(message || "");
    if (lang !== "zh" || !text) return text;
    for (const rule of ZH_RULES) {
      const m = rule.re.exec(text);
      if (m) {
        const hint = rule.hint(m);
        if (text.startsWith(hint)) return text;
        return hint + "\n" + text;
      }
    }
    return text;
  }

  // src/cep/zcodeBackend.js
  var RPC_TIMEOUT_MS = 3e4;
  var STDERR_TAIL_LIMIT2 = 4096;
  var DELIVERY_KIND = "desktop-continuous";
  var ZCODE_BUILTIN_DEFAULT_MODEL = "builtin:bigmodel-start-plan/GLM-5.2";
  var LEGACY_ZCODE_MODEL_REFS = /* @__PURE__ */ new Set(["mediastorm_glm/glm-5.2"]);
  var ZCODE_THOUGHT_LEVELS = /* @__PURE__ */ new Set(["nothink", "high", "max", "low", "medium"]);
  var ZCODE_CREDENTIAL_PREFIX = "enc:v1:";
  var ZCODE_API_KEY_NAME = "zcode-api-key";
  var BIGMODEL_API_ORIGIN = "https://bigmodel.cn";
  var ZAI_BIZ_API_ORIGIN = "https://api.z.ai";
  var JSON_CONTENT_TYPE = "application/json";
  var MODE_BY_TIER = {
    readonly: "plan",
    manual: "build",
    auto: "edit",
    none: "yolo"
  };
  function getCepRequire2() {
    if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) {
      return globalThis.window.cep_node.require;
    }
    if (globalThis.window && globalThis.window.require) return globalThis.window.require;
    if (globalThis.require) return globalThis.require;
    throw new Error("CEP Node require is unavailable");
  }
  function getCepEnv2() {
    return globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.process && globalThis.window.cep_node.process.env || {};
  }
  function appendTail3(tail, chunk) {
    const next = tail + String(chunk || "");
    return next.length > STDERR_TAIL_LIMIT2 ? next.slice(next.length - STDERR_TAIL_LIMIT2) : next;
  }
  function clone3(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }
  async function resolveZcodeCli({ env, execFileImpl }) {
    const override = env && env.AE_MCP_ZCODE_CLI;
    if (override) return { ok: true, cliPath: override };
    const localAppData = env && (env.LOCALAPPDATA || env.LocalAppData);
    if (localAppData) {
      const path = localAppData + "\\Programs\\ZCode\\resources\\glm\\zcode.cjs";
      try {
        await statFile(path);
        return { ok: true, cliPath: path };
      } catch (e) {
      }
    }
    const execFile = execFileImpl || getCepRequire2()("child_process").execFile;
    try {
      const where = await execFileAsync2(execFile, "where", ["zcode"], env || {});
      if (!where.err && where.stdout) {
        const exe = String(where.stdout).split(/\r?\n/)[0].trim();
        if (exe) return { ok: true, cliPath: exe, isExe: true };
      }
    } catch (e) {
    }
    return { ok: false, detail: "ZCode CLI not found. Install ZCode or set AE_MCP_ZCODE_CLI to the zcode.cjs path." };
  }
  function statFile(path) {
    const fs = getCepRequire2()("fs");
    return new Promise((resolve, reject) => fs.stat(path, (err) => err ? reject(err) : resolve()));
  }
  function execFileAsync2(execFile, cmd, args, env) {
    return new Promise((resolve) => {
      execFile(cmd, args, { env, windowsHide: true }, (err, stdout, stderr) => {
        resolve({ err, stdout: String(stdout || ""), stderr: String(stderr || "") });
      });
    });
  }
  function createRpc({ writeLine, onNotification, onRequest, timeoutMs = RPC_TIMEOUT_MS }) {
    let nextId2 = 1;
    const pending = /* @__PURE__ */ new Map();
    function writeMessage(message) {
      writeLine(JSON.stringify(message) + "\n");
    }
    function rejectPending(id, error) {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    function handleMessage(message) {
      if (!message || typeof message !== "object") return;
      const hasId = message.id !== void 0 && message.id !== null;
      if (hasId && !message.method) {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) {
          const error = new Error(message.error.message || "ZCode request failed");
          error.code = message.error.code;
          error.data = message.error.data;
          entry.reject(error);
        } else {
          entry.resolve(message.result);
        }
        return;
      }
      if (message.method && hasId) {
        if (onRequest) onRequest(message);
        return;
      }
      if (message.method && onNotification) onNotification(message);
    }
    function request(method, params, timeoutOverrideMs) {
      const id = nextId2++;
      const message = { id, method };
      if (params !== void 0) message.params = params;
      const limit = timeoutOverrideMs || timeoutMs;
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => rejectPending(id, new Error(method + " timed out after " + limit + "ms")), limit);
        pending.set(id, { resolve, reject, timer });
      });
      writeMessage(message);
      return promise;
    }
    function fireRequest(method, params) {
      const id = nextId2++;
      const message = { id, method };
      if (params !== void 0) message.params = params;
      writeMessage(message);
      return id;
    }
    function respond(id, result) {
      writeMessage({ id, result });
    }
    function respondError(id, code, message) {
      writeMessage({ id, error: { code, message } });
    }
    function close(reason = new Error("ZCode app-server closed")) {
      for (const id of Array.from(pending.keys())) rejectPending(id, reason);
    }
    return { request, fireRequest, respond, respondError, close, handleMessage };
  }
  function mcpToolName(name) {
    const text = String(name || "");
    return text.startsWith("mcp__") ? text : "mcp__ae__" + text;
  }
  function zcodeProviderId(modelRef) {
    const text = String(modelRef || "").trim();
    const slash = text.indexOf("/");
    return slash > 0 ? text.slice(0, slash).trim() : "";
  }
  function zcodeProviderApiKeyEnv(providerId) {
    const text = String(providerId || "").trim().replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
    return text ? text + "_API_KEY" : "";
  }
  function zcodeModelIds(provider) {
    const models = provider && provider.models;
    if (Array.isArray(models)) return models.map((m) => m && (m.id || m.modelID || m.modelId || m.name)).filter(Boolean).map(String);
    if (models && typeof models === "object") return Object.keys(models);
    return [];
  }
  function zcodePreferredModelId(provider) {
    const ids = zcodeModelIds(provider);
    if (!ids.length) return "";
    return ids.find((id) => id === "GLM-5.2") || ids.find((id) => /GLM-5\.2/i.test(id)) || ids[0];
  }
  function hasZcodeProviderCredential(provider, env = {}) {
    const options = provider && provider.options && typeof provider.options === "object" ? provider.options : {};
    if (options.apiKey || provider && provider.apiKey) return true;
    const keyEnv = String(options.apiKeyEnv || "").trim();
    return Boolean(keyEnv && env[keyEnv]);
  }
  function zcodeProviderScore(providerId, provider, family, env = {}, { allowEmptyModels = false } = {}) {
    if (!provider || typeof provider !== "object") return -1;
    if (provider.enabled === false || provider.systemDisabledReason) return -1;
    if (!zcodeModelIds(provider).length && !allowEmptyModels) return -1;
    const id = String(providerId || "");
    let score = 0;
    if (provider.enabled === true) score += 100;
    if (family && id === "builtin:" + family + "-start-plan") score += 80;
    if (family && id === "builtin:" + family + "-coding-plan") score += 70;
    if (family && id === "builtin:" + family) score += 40;
    if (/-start-plan$/.test(id)) score += 30;
    if (/-coding-plan$/.test(id)) score += 20;
    if (hasZcodeProviderCredential(provider, env)) score += 300;
    return score;
  }
  function zcodeDesktopProviderEntry({ config, setting, modelRef, env = {} }) {
    const providers = config && config.provider && typeof config.provider === "object" ? config.provider : {};
    const entries = Object.entries(providers);
    if (!entries.length) return null;
    const family = String(setting && setting.providerFamilyDomain || "").trim();
    const requested = zcodeProtocolModelFromRef(modelRef);
    if (requested && providers[requested.providerId]) {
      const provider = providers[requested.providerId];
      const score = zcodeProviderScore(requested.providerId, provider, family, env, { allowEmptyModels: true });
      if (score >= 0) return { providerId: requested.providerId, provider, modelId: requested.modelId, score };
    }
    let best = null;
    for (const [providerId, provider] of entries) {
      const score = zcodeProviderScore(providerId, provider, family, env);
      if (score < 0) continue;
      if (!best || score > best.score) best = { providerId, provider, score };
    }
    if (!best) return null;
    const modelId = zcodePreferredModelId(best.provider);
    return modelId ? { ...best, modelId } : null;
  }
  function zcodeModelFromDesktopConfig({ config, setting, env = {} }) {
    const entry = zcodeDesktopProviderEntry({ config, setting, env });
    return entry ? entry.providerId + "/" + entry.modelId : "";
  }
  function zcodeProtocolProviderKind(kind) {
    const text = String(kind || "").trim();
    if (text === "openai" || text === "openai-compatible") return text;
    return "anthropic";
  }
  function zcodeProtocolApiFormat(provider, kind) {
    const direct = provider && (provider.apiFormat || provider.api_format);
    if (direct) return direct;
    if (kind === "openai") return "openai-responses";
    if (kind === "openai-compatible") return "openai-chat-completions";
    return "anthropic-messages";
  }
  function positiveNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
  }
  function zcodeProtocolModelEntry(modelId, raw) {
    const model = raw && typeof raw === "object" ? raw : {};
    const limit = model.limit && typeof model.limit === "object" ? model.limit : {};
    return {
      modelId,
      ...model.label || model.name ? { label: model.label || model.name } : {},
      ...positiveNumber(model.contextWindow || limit.contextWindow) ? { contextWindow: positiveNumber(model.contextWindow || limit.contextWindow) } : {},
      ...positiveNumber(model.maxOutputTokens || limit.maxOutputTokens) ? { maxOutputTokens: positiveNumber(model.maxOutputTokens || limit.maxOutputTokens) } : {}
    };
  }
  function zcodeProtocolModels(provider, selectedModelId) {
    const models = provider && provider.models;
    const result = [];
    if (Array.isArray(models)) {
      for (const raw of models) {
        const id = raw && (raw.id || raw.modelID || raw.modelId || raw.name);
        if (id) result.push(zcodeProtocolModelEntry(String(id), raw));
      }
    } else if (models && typeof models === "object") {
      for (const [id, raw] of Object.entries(models)) result.push(zcodeProtocolModelEntry(String(id), raw));
    }
    if (selectedModelId && !result.some((m) => m.modelId === selectedModelId)) {
      result.unshift({ modelId: selectedModelId });
    }
    return result;
  }
  function resolveZcodeProviderApiKey({ provider, env = {}, storedKey = "" } = {}) {
    const options = provider && provider.options && typeof provider.options === "object" ? provider.options : {};
    const inline = options.apiKey || provider && provider.apiKey;
    if (inline) return { key: String(inline), source: "config" };
    const keyEnv = String(options.apiKeyEnv || "").trim();
    if (keyEnv && env[keyEnv]) return { key: String(env[keyEnv]), source: "env" };
    if (storedKey) return { key: String(storedKey), source: "panel" };
    return { key: "", source: "" };
  }
  function zcodeRuntimeModelFromDesktopConfig({ config, setting, modelRef, thoughtLevel, env = {}, storedKey = "" } = {}) {
    var _a;
    const entry = zcodeDesktopProviderEntry({ config, setting, modelRef, env });
    if (!entry) return null;
    const provider = entry.provider || {};
    const options = provider.options && typeof provider.options === "object" ? provider.options : {};
    const kind = zcodeProtocolProviderKind(provider.kind);
    const apiKey = resolveZcodeProviderApiKey({ provider, env, storedKey }).key;
    const protocolProvider = {
      providerId: entry.providerId,
      kind,
      apiFormat: zcodeProtocolApiFormat(provider, kind),
      ...provider.name || provider.label ? { label: provider.name || provider.label } : {},
      source: provider.source || "custom",
      ...options.baseURL || provider.baseURL || provider.endpoints && provider.endpoints.baseURL ? { baseURL: options.baseURL || provider.baseURL || provider.endpoints.baseURL } : {},
      ...apiKey ? { apiKey: { source: "inline", value: String(apiKey) } } : {},
      ...typeof options.apiKeyRequired === "boolean" || typeof provider.apiKeyRequired === "boolean" ? { apiKeyRequired: (_a = options.apiKeyRequired) != null ? _a : provider.apiKeyRequired } : {},
      models: zcodeProtocolModels(provider, entry.modelId)
    };
    return {
      revision: "desktop-v2:" + entry.providerId,
      generatedAt: Date.now(),
      model: { providerId: entry.providerId, modelId: entry.modelId },
      provider: protocolProvider,
      ...thoughtLevel ? { thoughtLevel } : {}
    };
  }
  function zcodeDesktopBasePath(env) {
    const home = env && (env.USERPROFILE || env.HOME || (env.HOMEDRIVE && env.HOMEPATH ? env.HOMEDRIVE + env.HOMEPATH : ""));
    return home ? String(home).replace(/[\\/]+$/, "") + "\\.zcode\\v2" : "";
  }
  function readJsonFile(fsImpl, path) {
    try {
      return JSON.parse(fsImpl.readFileSync(path, "utf8"));
    } catch (e) {
      return null;
    }
  }
  function zcodeCliBasePath(env) {
    const home = env && (env.USERPROFILE || env.HOME || (env.HOMEDRIVE && env.HOMEPATH ? env.HOMEDRIVE + env.HOMEPATH : ""));
    return home ? String(home).replace(/[\\/]+$/, "") + "\\.zcode\\cli" : "";
  }
  function mergeZcodeConfigs({ cliConfig, desktopConfig } = {}) {
    const desktopProviders = desktopConfig && desktopConfig.provider && typeof desktopConfig.provider === "object" ? desktopConfig.provider : {};
    const cliProviders = cliConfig && cliConfig.provider && typeof cliConfig.provider === "object" ? cliConfig.provider : {};
    const provider = Object.assign({}, desktopProviders, cliProviders);
    return Object.keys(provider).length ? { provider } : null;
  }
  function readZcodeConfigs({ env, fsImpl } = {}) {
    const fs = fsImpl || getCepRequire2()("fs");
    const desktopBase = zcodeDesktopBasePath(env || {});
    const cliBase = zcodeCliBasePath(env || {});
    const desktopConfig = desktopBase ? readJsonFile(fs, desktopBase + "\\config.json") : null;
    const setting = desktopBase ? readJsonFile(fs, desktopBase + "\\setting.json") : null;
    const cliConfig = cliBase ? readJsonFile(fs, cliBase + "\\config.json") : null;
    const cliModel = cliConfig && typeof cliConfig.model === "string" ? cliConfig.model.trim() : "";
    return { config: mergeZcodeConfigs({ cliConfig, desktopConfig }), setting, cliModel, cliConfig, desktopConfig };
  }
  function readZcodeDesktopModel({ env, fsImpl } = {}) {
    const { config, setting, cliModel } = readZcodeConfigs({ env, fsImpl });
    if (cliModel) {
      const requested = zcodeProtocolModelFromRef(cliModel);
      if (requested && config && config.provider && config.provider[requested.providerId]) return cliModel;
    }
    return zcodeModelFromDesktopConfig({ config, setting, env: env || {} });
  }
  function readZcodeDesktopRuntimeModel({ env, fsImpl, modelRef, thoughtLevel, storedKey = "" } = {}) {
    const { config, setting, cliModel } = readZcodeConfigs({ env, fsImpl });
    const ref = modelRef || cliModel || "";
    return zcodeRuntimeModelFromDesktopConfig({ config, setting, modelRef: ref, thoughtLevel, env: env || {}, storedKey });
  }
  function summarizeZcodeConfig({ env = {}, fsImpl, storedKey = "" } = {}) {
    const { cliConfig, desktopConfig, cliModel } = readZcodeConfigs({ env, fsImpl });
    const cliProviders = cliConfig && cliConfig.provider || {};
    const cliProviderId = zcodeProviderId(cliModel) || Object.keys(cliProviders)[0] || "";
    const cliProvider = cliProviderId ? cliProviders[cliProviderId] : null;
    const cliResolved = cliProvider ? resolveZcodeProviderApiKey({ provider: cliProvider, env, storedKey }) : { key: "", source: "" };
    const desktopIds = Object.keys(desktopConfig && desktopConfig.provider || {});
    const startPlanId = desktopIds.find((id) => /-start-plan$/.test(id)) || "";
    const startPlanProvider = startPlanId ? desktopConfig.provider[startPlanId] : null;
    return {
      cli: cliProvider ? {
        providerId: cliProviderId,
        model: cliModel,
        apiKeyEnv: String(cliProvider.options && cliProvider.options.apiKeyEnv || ""),
        hasCredential: Boolean(cliResolved.key),
        keySource: cliResolved.source,
        // Probe-driven model discovery (spec A2 applied to zcode): baseUrl +
        // protocol let the panel call probeProviderModels against /v1/models
        // when session/create's settings.model.available comes back empty.
        baseUrl: String(cliProvider.options && cliProvider.options.baseURL || cliProvider.baseURL || ""),
        protocol: zcodeProtocolProviderKind(cliProvider.kind)
      } : null,
      desktop: desktopIds.length ? { providerId: desktopIds[0] } : null,
      startPlan: startPlanId ? {
        providerId: startPlanId,
        hasCredential: hasZcodeProviderCredential(startPlanProvider, env)
      } : null
    };
  }
  function zcodeProviderFamily(providerId) {
    const text = String(providerId || "").trim();
    const id = text.startsWith("builtin:") ? text.slice("builtin:".length) : text;
    return id.replace(/-(?:start|coding)-plan$/i, "").split(/[/:]/)[0];
  }
  function getNodeBuffer() {
    return globalThis.Buffer || getCepRequire2()("buffer").Buffer;
  }
  function zcodeCredentialSecret(env, osImpl) {
    const explicit = env && env.ZCODE_CREDENTIAL_SECRET && String(env.ZCODE_CREDENTIAL_SECRET).trim();
    if (explicit) return explicit;
    const os = osImpl || getCepRequire2()("os");
    let username = "unknown";
    try {
      username = os.userInfo().username;
    } catch (e) {
    }
    return "zcode-credential-fallback:" + os.platform() + ":" + os.homedir() + ":" + username;
  }
  function decryptZcodeCredentialValue(value, { env, cryptoImpl, osImpl } = {}) {
    const text = String(value || "");
    if (!text.startsWith(ZCODE_CREDENTIAL_PREFIX)) return text;
    const crypto = cryptoImpl || getCepRequire2()("crypto");
    const BufferImpl = getNodeBuffer();
    const parts = text.slice(ZCODE_CREDENTIAL_PREFIX.length).split(".");
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
      throw new Error("Credential decrypt failed: invalid ciphertext format");
    }
    const key = crypto.createHash("sha256").update(zcodeCredentialSecret(env || {}, osImpl)).digest();
    const iv = BufferImpl.from(parts[0], "base64url");
    const authTag = BufferImpl.from(parts[1], "base64url");
    const cipherText = BufferImpl.from(parts[2], "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    return BufferImpl.concat([decipher.update(cipherText), decipher.final()]).toString("utf8");
  }
  function readZcodeOAuthAccessToken({ env, fsImpl, providerId } = {}) {
    const base = zcodeDesktopBasePath(env || {});
    if (!base) return "";
    const fs = fsImpl || getCepRequire2()("fs");
    const credentials = readJsonFile(fs, base + "\\credentials.json");
    if (!credentials || typeof credentials !== "object") return "";
    const providers = [];
    const family = zcodeProviderFamily(providerId);
    if (family) providers.push(family);
    const active = credentials["oauth:active_provider"];
    if (active) {
      try {
        const activeProvider = decryptZcodeCredentialValue(active, { env });
        if (activeProvider && !providers.includes(activeProvider)) providers.push(activeProvider);
      } catch (e) {
      }
    }
    for (const provider of providers) {
      const raw = credentials["oauth:" + provider + ":access_token"];
      if (!raw) continue;
      return decryptZcodeCredentialValue(raw, { env });
    }
    return "";
  }
  function resolveBigModelApiOrigin(env = {}) {
    const explicit = env.BIGMODEL_API_BASE_URL || env.BIGMODEL_PRODUCTION_API_BASE_URL;
    return String(explicit || BIGMODEL_API_ORIGIN).replace(/\/+$/, "");
  }
  function remoteCodeOk(code) {
    return code === void 0 || code === null || code === 0 || code === 200 || code === "0" || code === "200";
  }
  async function defaultHttpRequestJson({ url, method = "GET", headers = {}, body }) {
    const target = new URL(url);
    const moduleName = target.protocol === "http:" ? "http" : "https";
    const http = getCepRequire2()(moduleName);
    const BufferImpl = getNodeBuffer();
    const payload = body === void 0 ? null : typeof body === "string" ? body : JSON.stringify(body);
    const requestHeaders = Object.assign({}, headers);
    if (payload !== null && requestHeaders["Content-Length"] === void 0) {
      requestHeaders["Content-Length"] = String(BufferImpl.byteLength(payload));
    }
    return new Promise((resolve, reject) => {
      const req = http.request(target, { method, headers: requestHeaders }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = BufferImpl.concat(chunks).toString("utf8");
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error("ZCode OAuth request failed with HTTP " + res.statusCode + ": " + text.slice(0, 300)));
            return;
          }
          try {
            resolve(text ? JSON.parse(text) : {});
          } catch (e) {
            reject(new Error("ZCode OAuth response was not valid JSON"));
          }
        });
      });
      req.on("error", reject);
      if (payload !== null) req.write(payload);
      req.end();
    });
  }
  async function requestRemoteData(requestJson, options) {
    var _a;
    const json = await requestJson(options);
    if (!json || typeof json !== "object") throw new Error("ZCode OAuth response was empty");
    if (!remoteCodeOk(json.code)) throw new Error(json.msg || "Remote business error " + json.code);
    return (_a = json.data) != null ? _a : null;
  }
  function pickOrgAndProject(customerInfo) {
    const organizations = customerInfo && Array.isArray(customerInfo.organizations) ? customerInfo.organizations : [];
    const org = organizations.find((item) => String(item.organizationName || "").includes("\u9ED8\u8BA4\u673A\u6784")) || organizations[0];
    const projects = org && Array.isArray(org.projects) ? org.projects : [];
    const project = projects.find((item) => String(item.projectName || "").includes("\u9ED8\u8BA4\u9879\u76EE")) || projects[0];
    if (!org || !project || !org.organizationId || !project.projectId) return null;
    return { organizationId: org.organizationId, projectId: project.projectId };
  }
  async function resolveBizApiKey({ authorization, host, requestJson, requireSecretKey = false }) {
    const headers = { Authorization: authorization, "Content-Type": JSON_CONTENT_TYPE };
    const customer = await requestRemoteData(requestJson, {
      method: "GET",
      url: host + "/api/biz/customer/getCustomerInfo",
      headers
    });
    const orgProject = pickOrgAndProject(customer);
    if (!orgProject) throw new Error("Unable to resolve ZCode OAuth organization and project.");
    const apiKeysUrl = host + "/api/biz/v1/organization/" + encodeURIComponent(orgProject.organizationId) + "/projects/" + encodeURIComponent(orgProject.projectId) + "/api_keys";
    const apiKeys = await requestRemoteData(requestJson, { method: "GET", url: apiKeysUrl, headers });
    const existing = Array.isArray(apiKeys) ? apiKeys.find((item) => item && item.name === ZCODE_API_KEY_NAME) : null;
    const created = existing || await requestRemoteData(requestJson, {
      method: "POST",
      url: apiKeysUrl,
      headers,
      body: { name: ZCODE_API_KEY_NAME }
    });
    const apiKey = String(created && (created.apiKey || created.api_key) || "").trim();
    if (!apiKey) throw new Error("ZCode OAuth API key response is missing apiKey.");
    const copied = await requestRemoteData(requestJson, {
      method: "GET",
      url: apiKeysUrl + "/copy/" + encodeURIComponent(apiKey),
      headers
    });
    const secretKey = String(copied && (copied.secretKey || copied.secret_key) || "").trim();
    if (!secretKey && requireSecretKey) throw new Error("ZCode OAuth API key copy response is missing secretKey.");
    return secretKey ? apiKey + "." + secretKey : apiKey;
  }
  async function resolveZcodeCodingPlanApiKey({ accessToken, providerId, env, requestJson = defaultHttpRequestJson } = {}) {
    const token = String(accessToken || "").trim();
    if (!token) throw new Error("ZCode desktop OAuth token is unavailable.");
    const family = zcodeProviderFamily(providerId);
    if (family === "zai") {
      const data = await requestRemoteData(requestJson, {
        method: "POST",
        url: ZAI_BIZ_API_ORIGIN + "/api/auth/z/login",
        headers: { "Content-Type": JSON_CONTENT_TYPE },
        body: { token }
      });
      const bizToken = String(data && (data.access_token || data.accessToken) || "").trim();
      if (!bizToken) throw new Error("ZCode OAuth biz token response is missing access_token.");
      return resolveBizApiKey({ authorization: "Bearer " + bizToken, host: ZAI_BIZ_API_ORIGIN, requestJson, requireSecretKey: true });
    }
    return resolveBizApiKey({ authorization: token, host: resolveBigModelApiOrigin(env || {}), requestJson });
  }
  function runtimeModelWithApiKey(runtimeModel, apiKey) {
    const next = clone3(runtimeModel);
    next.revision = (runtimeModel.revision || "runtime-model") + ":oauth:" + Date.now();
    next.generatedAt = Date.now();
    next.provider = Object.assign({}, next.provider || {}, {
      apiKey: { source: "inline", value: String(apiKey) }
    });
    return next;
  }
  function isZcodePlanRuntimeModel(runtimeModel, providerId) {
    const provider = runtimeModel && runtimeModel.provider ? runtimeModel.provider : {};
    const id = String(providerId || provider.providerId || "").trim();
    const baseURL = String(provider.baseURL || "").replace(/\/+$/, "").toLowerCase();
    return /-start-plan$/i.test(id) || baseURL.endsWith("/zcode-plan") || baseURL.endsWith("/zcode-plan/anthropic");
  }
  function zcodePlanRuntimeHeadersMessage() {
    return "ZCode desktop OAuth plan providers require ZCode desktop captcha/runtime headers before model requests. The AE panel can read the desktop provider config, but the current app-server bridge cannot generate or apply those headers yet. Use ZCode Desktop chat or configure an API-key provider in ZCode for now.";
  }
  function isLegacyZcodeModelRef(modelRef) {
    return LEGACY_ZCODE_MODEL_REFS.has(String(modelRef || "").trim());
  }
  function zcodeProtocolModelFromRef(modelRef) {
    const text = String(modelRef || "").trim();
    const slash = text.indexOf("/");
    if (slash <= 0 || slash === text.length - 1) return null;
    return {
      providerId: text.slice(0, slash),
      modelId: text.slice(slash + 1)
    };
  }
  function zcodeMissingApiKeyHint(message) {
    const text = String(message || "");
    const match = /Model provider is missing an API key:\s*([^\s.]+)/i.exec(text);
    if (!match || /AE_MCP_ZCODE_API_KEY|ZCODE_API_KEY/.test(text)) return text;
    const providerEnv = zcodeProviderApiKeyEnv(match[1]);
    const vars = ["AE_MCP_ZCODE_API_KEY"];
    if (providerEnv) vars.push(providerEnv);
    vars.push("ZCODE_API_KEY");
    return (text.endsWith(".") ? text : text + ".") + " Set " + vars.join(", ") + " before launching AE.";
  }
  function zcodeMissingModelConfigHint(message) {
    const text = String(message || "");
    if (!/Model config is missing/i.test(text) || /Open ZCode/.test(text)) return text;
    return (text.endsWith(".") ? text : text + ".") + " Open ZCode and select a provider/model, or create ~/.zcode/cli/config.json with an explicit provider/model before launching AE.";
  }
  function zcodeProviderAuthenticationHint(message) {
    const text = String(message || "");
    if (!/Provider authentication failed/i.test(text) || /runtime headers/i.test(text)) return text;
    return (text.endsWith(".") ? text : text + ".") + " If this is a ZCode desktop OAuth plan provider, the AE panel cannot yet bridge ZCode desktop captcha/runtime headers.";
  }
  function zcodePlanRuntimeFailureHint(message, runtimeModel) {
    const text = String(message || "");
    if (!/Provider authentication failed|Model request failed/i.test(text)) return text;
    if (/runtime headers/i.test(text) || !isZcodePlanRuntimeModel(runtimeModel)) return text;
    return (text.endsWith(".") ? text : text + ".") + " " + zcodePlanRuntimeHeadersMessage();
  }
  function zcodeRepairHint(message) {
    return zcodeProviderAuthenticationHint(zcodeMissingModelConfigHint(zcodeMissingApiKeyHint(message)));
  }
  function zcodeErrorMessage(value, fallback = "ZCode turn failed", lang = "en") {
    if (!value) return localizeZcodeError(zcodeRepairHint(fallback), lang);
    if (typeof value === "string") return localizeZcodeError(zcodeRepairHint(value), lang);
    if (typeof value === "object") {
      const direct = value.message || value.detail || value.reason || value.error;
      if (direct && direct !== value) return zcodeErrorMessage(direct, fallback, lang);
      try {
        const text = JSON.stringify(value);
        return localizeZcodeError(zcodeRepairHint(text && text !== "{}" ? text : fallback), lang);
      } catch (e) {
        return localizeZcodeError(zcodeRepairHint(fallback), lang);
      }
    }
    return localizeZcodeError(zcodeRepairHint(String(value)), lang);
  }
  function zcodeErrorKind(message) {
    return /\b(model|provider|api[-\s_]*key|credential|auth)\b/i.test(String(message || "")) ? "model" : "mcp";
  }
  function defaultReadStoredZcodeKey() {
    try {
      return createApiKeyStore().readKey("zcode");
    } catch (e) {
      return "";
    }
  }
  function createZcodeBackend({
    spawnImpl,
    getModel,
    getPermissionMode,
    getEffort = () => null,
    getMcpSpec,
    getToolMeta,
    getExpertGuidance = () => true,
    getServerInstructions = () => "",
    onEvent,
    lang = "zh",
    env,
    readDesktopModel = readZcodeDesktopModel,
    readDesktopRuntimeModel = readZcodeDesktopRuntimeModel,
    readOAuthAccessToken = readZcodeOAuthAccessToken,
    resolveCodingPlanApiKey = resolveZcodeCodingPlanApiKey,
    resolveCli = resolveZcodeCli,
    resolveNode = resolveSystemNode,
    readStoredZcodeKey = defaultReadStoredZcodeKey
  }) {
    let proc = null;
    let rpc = null;
    let startPromise = null;
    let sessionPromise = null;
    let sessionId = null;
    let sessionModelRef = null;
    let subscribed = false;
    let activeRuntimeModel = null;
    let stopping = false;
    let stderrTail = "";
    let transcript = [];
    let activeRun = null;
    let activeResolve = null;
    let activeAssistantText = "";
    let toolMeta = { allowedTools: [], annotations: {} };
    const pendingApprovals = /* @__PURE__ */ new Map();
    const pendingElicitations = /* @__PURE__ */ new Map();
    const pendingUserInputs = /* @__PURE__ */ new Map();
    const sessionAllowedTools = /* @__PURE__ */ new Set();
    function emit(evt) {
      if (onEvent) onEvent(evt);
    }
    function getSpawn() {
      if (spawnImpl) return spawnImpl;
      return getCepRequire2()("child_process").spawn;
    }
    function currentEnv() {
      const next = Object.assign({}, getCepEnv2(), env || {});
      const panelModel = next.AE_MCP_ZCODE_MODEL && String(next.AE_MCP_ZCODE_MODEL).trim();
      if (!next.ZCODE_MODEL && panelModel) next.ZCODE_MODEL = panelModel;
      const panelApiKey = next.AE_MCP_ZCODE_API_KEY && String(next.AE_MCP_ZCODE_API_KEY).trim() || String(readStoredZcodeKey() || "").trim();
      if (panelApiKey) {
        if (!next.ZCODE_API_KEY) next.ZCODE_API_KEY = panelApiKey;
        const providerEnv = zcodeProviderApiKeyEnv(zcodeProviderId(next.ZCODE_MODEL));
        if (providerEnv && !next[providerEnv]) next[providerEnv] = panelApiKey;
      }
      return next;
    }
    function currentModelRef(spawnEnv) {
      const explicitEnvModel = spawnEnv && spawnEnv.ZCODE_MODEL && String(spawnEnv.ZCODE_MODEL).trim();
      if (explicitEnvModel) return explicitEnvModel;
      const selectedModel = getModel ? String(getModel() || "").trim() : "";
      if (selectedModel.includes("/") && !isLegacyZcodeModelRef(selectedModel)) return selectedModel;
      let desktopModel = "";
      try {
        desktopModel = readDesktopModel ? String(readDesktopModel({ env: spawnEnv }) || "").trim() : "";
      } catch (e) {
      }
      if (desktopModel) return desktopModel;
      if (selectedModel.includes("/")) return selectedModel;
      return ZCODE_BUILTIN_DEFAULT_MODEL;
    }
    function currentRuntimeModel(spawnEnv, modelRef, thoughtLevel) {
      if (!readDesktopRuntimeModel) return null;
      try {
        return readDesktopRuntimeModel({ env: spawnEnv, modelRef, thoughtLevel, storedKey: String(readStoredZcodeKey() || "").trim() }) || null;
      } catch (e) {
        return null;
      }
    }
    function finishActive() {
      if (!activeResolve) {
        activeRun = null;
        activeAssistantText = "";
        return;
      }
      const resolve = activeResolve;
      activeResolve = null;
      activeRun = null;
      activeAssistantText = "";
      resolve();
    }
    function drainApprovals() {
      for (const [toolUseId, approval] of Array.from(pendingApprovals.entries())) {
        if (rpc) rpc.respond(approval.rpcId, { decision: "decline" });
        pendingApprovals.delete(toolUseId);
        emit({ type: "tool-denied", toolUseId });
      }
      for (const [toolUseId, elicit] of Array.from(pendingElicitations.entries())) {
        if (rpc && elicit.rpcId) rpc.respond(elicit.rpcId, { action: "decline" });
        pendingElicitations.delete(toolUseId);
        emit({ type: "tool-denied", toolUseId });
      }
      for (const [toolUseId, ui] of Array.from(pendingUserInputs.entries())) {
        if (rpc && ui.rpcId) rpc.respond(ui.rpcId, { decision: "decline", answers: {} });
        pendingUserInputs.delete(toolUseId);
        emit({ type: "tool-denied", toolUseId });
      }
    }
    function handleRequest(message) {
      const method = message.method;
      const params = message.params || {};
      if (method === "interaction/requestUserInput") {
        handleUserInput(params, message.id);
        return;
      }
      if (method === "interaction/requestProviderRuntimeHeaders") {
        handleProviderRuntimeHeaders(params, message.id);
        return;
      }
      if (method === "elicitation/create") {
        handleElicitation(params, message.id);
        return;
      }
      if (method === "permission.requested" || method === "session/permission" || method === "interaction/requestPermission") {
        handlePermissionRequest(params, message.id);
        return;
      }
      if (rpc) rpc.respondError(message.id, -32601, "Method not found: " + method);
    }
    async function handleProviderRuntimeHeaders(params, rpcId) {
      try {
        const spawnEnv = currentEnv();
        const providerId = String(params.providerId || params.modelRef && params.modelRef.providerId || activeRuntimeModel && activeRuntimeModel.model && activeRuntimeModel.model.providerId || "").trim();
        const modelId = String(params.modelRef && params.modelRef.modelId || activeRuntimeModel && activeRuntimeModel.model && activeRuntimeModel.model.modelId || "").trim();
        const modelRef = providerId && modelId ? providerId + "/" + modelId : currentModelRef(spawnEnv);
        const runtimeModel = activeRuntimeModel || currentRuntimeModel(spawnEnv, modelRef, thoughtLevelFromEffort());
        if (!providerId || !runtimeModel) throw new Error("ZCode runtime model is unavailable for OAuth header refresh.");
        if (isZcodePlanRuntimeModel(runtimeModel, providerId)) {
          if (rpcId && rpc) rpc.respond(rpcId, { headersApplied: false, errorMessage: zcodePlanRuntimeHeadersMessage() });
          return;
        }
        const accessToken = await readOAuthAccessToken({ env: spawnEnv, providerId, modelRef });
        if (!accessToken) throw new Error("ZCode desktop OAuth token is unavailable. Open ZCode, sign in again, then retry from the panel.");
        const apiKey = await resolveCodingPlanApiKey({ accessToken, providerId, env: spawnEnv });
        const refreshedRuntimeModel = runtimeModelWithApiKey(runtimeModel, apiKey);
        await rpc.request("session/updateRuntimeModelConfig", {
          sessionId: params.sessionId || sessionId,
          runtimeModel: refreshedRuntimeModel
        }, RPC_TIMEOUT_MS);
        activeRuntimeModel = refreshedRuntimeModel;
        if (rpcId && rpc) rpc.respond(rpcId, { headersApplied: true, providerRevision: refreshedRuntimeModel.revision });
      } catch (e) {
        const message = zcodeErrorMessage(e, "ZCode desktop OAuth header refresh failed.", lang);
        if (rpcId && rpc) rpc.respond(rpcId, { headersApplied: false, errorMessage: message });
      }
    }
    function handleUserInput(params, rpcId) {
      const input = params.input || params;
      const questions = input.questions || [];
      const tier = getPermissionMode ? getPermissionMode() : "manual";
      if (!questions.length || tier === "none" || tier === "auto") {
        const answers = {};
        for (const q2 of questions) {
          const opts = q2.options || [];
          answers[q2.question || q2.header || "question"] = opts.length ? opts[0].label : "";
        }
        if (rpcId && rpc) rpc.respond(rpcId, { decision: "allow", answers });
        return;
      }
      const q = questions[0];
      const choices = (q.options || []).map((o) => o.label);
      const toolUseId = "ask_" + rpcId;
      pendingUserInputs.set(toolUseId, { rpcId, questions });
      emit({
        type: "approval-required",
        toolUseId,
        name: "AskUserQuestion",
        input: {
          question: q.question || q.header || "",
          header: q.header,
          choices,
          fields: questions.map((qq) => qq.question || qq.header || "")
        },
        risk: "write"
      });
    }
    function handleElicitation(params, rpcId) {
      const message = params.message || "";
      const schema = params.requestedSchema || {};
      const props = schema.properties || {};
      const required = schema.required || [];
      const fieldNames = Object.keys(props);
      if (!fieldNames.length) {
        if (rpcId && rpc) rpc.respond(rpcId, { action: "accept", content: {} });
        return;
      }
      const tier = getPermissionMode ? getPermissionMode() : "manual";
      if (tier === "none" || tier === "auto") {
        const autoContent = {};
        for (const fn of fieldNames) {
          const opts = props[fn] && props[fn].enum;
          autoContent[fn] = opts && opts.length ? opts[0] : "";
        }
        if (rpcId && rpc) rpc.respond(rpcId, { action: "accept", content: autoContent });
        return;
      }
      const primaryField = fieldNames[0];
      const primaryProp = props[primaryField] || {};
      const choices = Array.isArray(primaryProp.enum) ? primaryProp.enum : [];
      const toolUseId = "elicit_" + rpcId;
      pendingElicitations.set(toolUseId, { rpcId, fieldNames, props, required });
      emit({
        type: "approval-required",
        toolUseId,
        name: "AskUserQuestion",
        input: { question: message, field: primaryField, choices, fields: fieldNames },
        risk: "write"
      });
    }
    function handleNotification(message) {
      const params = message.params || {};
      const type = params.type || message.method;
      if (type === "state.updated") {
        const patch = params.patch || params.payload || {};
        if (patch.status === "idle" && activeRun) {
          drainApprovals();
          emit({ type: "turn-end", stopReason: "end_turn" });
          transcript.push({ role: "assistant", text: activeAssistantText });
          finishActive();
        }
        return;
      }
      if (type === "turn.started") {
        emit({ type: "turn-start" });
        return;
      }
      if (type === "model.streaming") {
        const payload = params.payload || {};
        if (payload.kind === "text_delta" && payload.delta) {
          activeAssistantText += String(payload.delta);
          emit({ type: "text-delta", text: String(payload.delta) });
        }
        return;
      }
      if (type === "tool.updated" || type === "part.started" || type === "part.upserted") {
        const payload = params.payload || {};
        if (payload.toolName || payload.tool) {
          emit({
            type: "tool-start",
            toolUseId: String(payload.toolCallId || payload.id || ""),
            name: mcpToolName(payload.toolName || payload.tool),
            input: payload.input || payload.arguments
          });
        }
        return;
      }
      if (type === "permission.requested") {
        handlePermissionRequest(params, null);
        return;
      }
      if (type === "turn.completed") {
        drainApprovals();
        const payload = params.payload || {};
        emit({ type: "turn-end", stopReason: "end_turn" });
        transcript.push({ role: "assistant", text: activeAssistantText || payload.response || "" });
        finishActive();
        return;
      }
      if (type === "turn.failed") {
        const payload = params.payload || {};
        const message2 = zcodePlanRuntimeFailureHint(zcodeErrorMessage(payload.error || payload.message, "ZCode turn failed", lang), activeRuntimeModel);
        emit({ type: "error", kind: zcodeErrorKind(message2), message: message2 });
        finishActive();
        return;
      }
    }
    function handlePermissionRequest(params, rpcId) {
      const payload = params.payload || params;
      const toolUseId = String(payload.toolCallId || payload.requestId || rpcId || "");
      const name = mcpToolName(payload.toolName || payload.tool || "");
      const input = payload.input || payload.arguments || {};
      const riskLevel = payload.riskLevel || "medium";
      const annotations = toolMeta && toolMeta.annotations || {};
      const ann = annotations[name] || {};
      const tier = getPermissionMode ? getPermissionMode() : "manual";
      const replyId = rpcId || payload.requestId || null;
      if (sessionAllowedTools.has(name) || ann.readOnly || tier === "none" || tier === "auto" && !ann.destructive && riskLevel === "low") {
        if (replyId && rpc) rpc.respond(replyId, { decision: "allow" });
        emit({ type: "tool-allowed", toolUseId });
        return;
      }
      if (tier === "readonly") {
        if (replyId && rpc) rpc.respond(replyId, { decision: "decline" });
        emit({ type: "tool-denied", toolUseId });
        return;
      }
      pendingApprovals.set(toolUseId, { rpcId: replyId, name, input });
      emit({
        type: "approval-required",
        toolUseId,
        name,
        input,
        risk: ann.destructive ? "destructive" : "write"
      });
    }
    function handleExit(code, signal) {
      const wasStopping = stopping;
      const detail = stderrTail ? String(code) + (signal ? " " + signal : "") + " " + stderrTail : String(code) + (signal ? " " + signal : "");
      if (rpc) rpc.close(new Error("ZCode app-server exited: " + detail));
      proc = null;
      rpc = null;
      startPromise = null;
      sessionPromise = null;
      sessionId = null;
      sessionModelRef = null;
      subscribed = false;
      if (wasStopping) return;
      if (activeRun) {
        emit({ type: "error", kind: "mcp", message: "ZCode app-server exited: " + detail });
        finishActive();
      }
    }
    function handleError(error) {
      const err = error instanceof Error ? error : new Error("ZCode app-server error");
      if (rpc) rpc.close(err);
      proc = null;
      rpc = null;
      startPromise = null;
      sessionPromise = null;
      sessionId = null;
      sessionModelRef = null;
      subscribed = false;
      if (activeRun) {
        emit({ type: "error", kind: "mcp", message: err.message });
        finishActive();
      }
    }
    async function startProcess() {
      if (proc && rpc) return true;
      if (startPromise) return startPromise;
      startPromise = (async () => {
        let execFileImpl = null;
        try {
          execFileImpl = getCepRequire2()("child_process").execFile;
        } catch (e) {
        }
        const cli = await resolveCli({ env: currentEnv(), execFileImpl });
        if (!cli.ok) throw new Error(cli.detail);
        const spawn = getSpawn();
        const spawnEnv = currentEnv();
        stderrTail = "";
        stopping = false;
        let cmd;
        let cmdArgs;
        if (cli.isExe) {
          cmd = cli.cliPath;
          cmdArgs = ["app-server"];
        } else {
          const node = await resolveNode({ env: spawnEnv });
          if (!node.ok) throw new Error(node.detail);
          cmd = node.nodePath;
          cmdArgs = [cli.cliPath, "app-server"];
        }
        proc = spawn(cmd, cmdArgs, {
          stdio: "pipe",
          windowsHide: true,
          env: spawnEnv
        });
        rpc = createRpc({
          writeLine: (line) => proc.stdin.write(line),
          onNotification: handleNotification,
          onRequest: handleRequest
        });
        const reader = createNdjsonReader((message) => rpc && rpc.handleMessage(message));
        if (proc.stdout && proc.stdout.on) proc.stdout.on("data", reader);
        if (proc.stderr && proc.stderr.on) proc.stderr.on("data", (chunk) => {
          stderrTail = appendTail3(stderrTail, chunk);
        });
        proc.on("exit", (code, signal) => handleExit(code, signal));
        proc.on("error", (error) => handleError(error));
        return true;
      })();
      try {
        return await startPromise;
      } finally {
        startPromise = null;
      }
    }
    function workspaceFromEnv(spawnEnv) {
      const extRoot = spawnEnv && (spawnEnv.AE_MCP_PANEL_EXT_ROOT || spawnEnv.EXTENSION_ROOT);
      const path = extRoot ? String(extRoot).replace(/\//g, "\\").replace(/\\+$/, "") : spawnEnv && (spawnEnv.TEMP || spawnEnv.TMP) || ".";
      const key = path.replace(/\\/g, "\\");
      return { workspacePath: path, workspaceKey: key };
    }
    function modeFromTier() {
      const tier = getPermissionMode ? getPermissionMode() : "manual";
      return MODE_BY_TIER[tier] || "build";
    }
    function thoughtLevelFromEffort() {
      const effort = getEffort ? getEffort() : null;
      if (!effort) return void 0;
      return ZCODE_THOUGHT_LEVELS.has(effort) ? effort : void 0;
    }
    async function ensureSession() {
      if (sessionId && !sessionPromise) {
        const desiredModelRef = currentModelRef(currentEnv());
        if (desiredModelRef && sessionModelRef && desiredModelRef !== sessionModelRef) {
          if (rpc && sessionId) {
            try {
              rpc.fireRequest("session/stop", { sessionId });
            } catch (e) {
            }
          }
          sessionId = null;
          sessionModelRef = null;
          subscribed = false;
        }
      }
      if (sessionId) return sessionId;
      if (sessionPromise) return sessionPromise;
      sessionPromise = (async () => {
        await startProcess();
        toolMeta = getToolMeta ? await getToolMeta() : { allowedTools: [], annotations: {} };
        const spawnEnv = currentEnv();
        const createParams = {
          workspace: workspaceFromEnv(spawnEnv),
          mode: modeFromTier()
        };
        const thoughtLevel = thoughtLevelFromEffort();
        const modelRef = currentModelRef(spawnEnv);
        const runtimeModel = currentRuntimeModel(spawnEnv, modelRef, thoughtLevel);
        if (runtimeModel) createParams.runtimeModel = runtimeModel;
        activeRuntimeModel = runtimeModel || null;
        const model = runtimeModel && runtimeModel.model || zcodeProtocolModelFromRef(modelRef);
        if (model) createParams.model = model;
        if (thoughtLevel) createParams.thoughtLevel = thoughtLevel;
        if (getMcpSpec) {
          const spec = await getMcpSpec();
          if (spec && spec.command) {
            const envObj = Object.assign({}, spec.env || {}, {
              AE_MCP_BACKEND: "ae-mcp",
              ...expertGuidanceEnv(getExpertGuidance())
            });
            createParams.mcpServers = [{
              name: "ae",
              command: spec.command,
              args: spec.args || [],
              env: Object.entries(envObj).map(([name, value]) => ({ name, value: String(value) }))
            }];
          }
        }
        const result = await rpc.request("session/create", createParams);
        const nextSessionId = result && result.session && result.session.sessionId || null;
        if (!nextSessionId) throw new Error("ZCode session/create returned no sessionId");
        emit({ type: "zcode-session-created", result });
        if (!subscribed) {
          await rpc.request("session/subscribe", { sessionId: nextSessionId, deliveryKind: DELIVERY_KIND }, 1e4);
          subscribed = true;
        }
        sessionId = nextSessionId;
        sessionModelRef = modelRef;
        return sessionId;
      })();
      try {
        return await sessionPromise;
      } finally {
        sessionPromise = null;
      }
    }
    async function sendUser(text) {
      if (activeRun) return activeRun;
      activeAssistantText = "";
      activeRun = new Promise((resolve) => {
        activeResolve = resolve;
      });
      try {
        await ensureSession();
        const userText = String(text || "");
        transcript.push({ role: "user", text: userText });
        let turnText = userText;
        if (transcript.filter((m) => m.role === "user").length === 1) {
          const instr = (getServerInstructions() || "").trim();
          if (instr) turnText = instr + "\n\n---\n\n" + userText;
        }
        rpc.request("session/send", { sessionId, content: turnText }, 18e4).catch((e) => {
          const message = zcodeErrorMessage(e, "Failed to start ZCode turn.", lang);
          emit({ type: "error", kind: zcodeErrorKind(message), message });
          finishActive();
        });
      } catch (e) {
        const message = zcodeErrorMessage(e, "Failed to start ZCode turn.", lang);
        emit({ type: "error", kind: zcodeErrorKind(message), message });
        finishActive();
      }
      return activeRun;
    }
    function approve(toolUseId, decision) {
      const id = String(toolUseId);
      const userInput = pendingUserInputs.get(id);
      if (userInput) {
        pendingUserInputs.delete(id);
        if (decision === "deny") {
          if (userInput.rpcId && rpc) rpc.respond(userInput.rpcId, { decision: "decline", answers: {} });
          emit({ type: "tool-denied", toolUseId: id });
        } else {
          const answers = {};
          const chosen = typeof decision === "string" && decision !== "allow" && decision !== "allow-session" ? decision : "";
          for (const q of userInput.questions) {
            const key = q.question || q.header || "question";
            answers[key] = chosen || q.options && q.options[0] && q.options[0].label || "";
          }
          if (userInput.rpcId && rpc) rpc.respond(userInput.rpcId, { decision: "allow", answers });
          emit({ type: "tool-allowed", toolUseId: id });
        }
        return;
      }
      const elicit = pendingElicitations.get(id);
      if (elicit) {
        pendingElicitations.delete(id);
        if (decision === "deny") {
          if (elicit.rpcId && rpc) rpc.respond(elicit.rpcId, { action: "decline" });
          emit({ type: "tool-denied", toolUseId: id });
        } else {
          const content = {};
          const fn = elicit.fieldNames[0];
          content[fn] = typeof decision === "string" && decision !== "allow" && decision !== "allow-session" ? decision : elicit.props[fn] && elicit.props[fn].enum && elicit.props[fn].enum[0] || "";
          if (elicit.rpcId && rpc) rpc.respond(elicit.rpcId, { action: "accept", content });
          emit({ type: "tool-allowed", toolUseId: id });
        }
        return;
      }
      const approval = pendingApprovals.get(id);
      if (!approval) return;
      pendingApprovals.delete(id);
      const allow = decision !== "deny";
      if (allow && decision === "allow-session") sessionAllowedTools.add(approval.name);
      if (approval.rpcId && rpc) rpc.respond(approval.rpcId, { decision: allow ? "allow" : "decline" });
      emit({ type: allow ? "tool-allowed" : "tool-denied", toolUseId: id });
    }
    function stop() {
      if (rpc && sessionId) {
        rpc.fireRequest("session/stop", { sessionId });
      }
      drainApprovals();
      if (activeRun) {
        emit({ type: "error", kind: "aborted", message: "Turn aborted." });
        finishActive();
      }
    }
    function reset() {
      stopping = true;
      drainApprovals();
      if (rpc) rpc.close(new Error("ZCode backend reset"));
      if (proc) {
        try {
          proc.kill();
        } catch (e) {
        }
      }
      proc = null;
      rpc = null;
      startPromise = null;
      sessionPromise = null;
      sessionId = null;
      sessionModelRef = null;
      subscribed = false;
      activeRuntimeModel = null;
      transcript = [];
      pendingApprovals.clear();
      pendingElicitations.clear();
      pendingUserInputs.clear();
      sessionAllowedTools.clear();
      toolMeta = { allowedTools: [], annotations: {} };
      finishActive();
      stderrTail = "";
      stopping = false;
    }
    async function setThoughtLevel(level) {
      if (!sessionId || !rpc) return false;
      if (!ZCODE_THOUGHT_LEVELS.has(level)) return false;
      try {
        await rpc.request("session/setThoughtLevel", { sessionId, thoughtLevel: level });
        return true;
      } catch (e) {
        return false;
      }
    }
    async function probeAccount() {
      try {
        await ensureSession();
        return { loggedIn: true, runtimeOk: true, provider: "zcode" };
      } catch (e) {
        return {
          loggedIn: true,
          runtimeOk: false,
          provider: "zcode",
          detail: zcodeErrorMessage(e, "ZCode runtime unavailable.", lang)
        };
      }
    }
    return {
      sendUser,
      approve,
      stop,
      reset,
      setThoughtLevel,
      getMessages: () => clone3(transcript),
      probeAccount
    };
  }

  // src/lib/backendCapabilities.js
  var CLAUDE_PRICE_USD_PER_MTOK = {
    "claude-fable-5": { input: 10, output: 50 },
    "claude-opus-4-8": { input: 5, output: 25 },
    "claude-sonnet-5": { input: 3, output: 15 },
    "claude-sonnet-4-6": { input: 3, output: 15 },
    "claude-haiku-4-5-20251001": { input: 1, output: 5 }
  };
  var CLAUDE_MODELS = [
    { id: "claude-fable-5", label: "Fable 5", effortLevels: ["low", "medium", "high", "xhigh", "max"], adaptive: true },
    { id: "claude-opus-4-8", label: "Opus 4.8", effortLevels: ["low", "medium", "high", "xhigh", "max"], adaptive: true },
    { id: "claude-sonnet-5", label: "Sonnet 5", effortLevels: ["low", "medium", "high", "xhigh"], adaptive: true },
    { id: "claude-sonnet-4-6", label: "Sonnet 4.6", effortLevels: ["low", "medium", "high", "max"], adaptive: true },
    { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", effortLevels: ["low", "medium", "high"], adaptive: false }
  ];
  var APPROVAL_MODES = [
    { id: "readonly", zh: "\u53EA\u8BFB", en: "Read-only", anchorZh: "\u4EC5\u653E\u884C\u53EA\u8BFB\u5DE5\u5177 \xB7 dontAsk", anchorEn: "read-only allowlist \xB7 dontAsk" },
    { id: "manual", zh: "\u624B\u52A8", en: "Manual", anchorZh: "\u6BCF\u4E2A\u5199\u64CD\u4F5C\u5F39\u5361 \xB7 canUseTool", anchorEn: "every write asks \xB7 canUseTool" },
    { id: "auto", zh: "\u81EA\u52A8", en: "Auto", anchorZh: "\u4EC5\u7834\u574F\u6027\u5F39\u5361 \xB7 \u6CE8\u89E3\u5206\u7EA7", anchorEn: "destructive asks \xB7 annotations" },
    { id: "none", zh: "\u514D\u5BA1", en: "Bypass", anchorZh: "\u5168\u653E\uFF08\u4EC5 ae \u5DE5\u5177\uFF09\xB7 dontAsk", anchorEn: "allow all ae tools \xB7 dontAsk" }
  ];
  var TIER_ORDER = [1, 3, 5, 10];
  function costTier(modelId) {
    const price = CLAUDE_PRICE_USD_PER_MTOK[modelId];
    if (!price) return 2;
    const idx = TIER_ORDER.indexOf(price.input);
    return idx === -1 ? 2 : idx + 1;
  }
  function withCost(models) {
    return models.map((m) => ({ ...m, cost: costTier(m.id) }));
  }
  function claudeSubDescriptor() {
    return {
      id: "claude-sub",
      label: "\u8BA2\u9605",
      models: withCost(CLAUDE_MODELS),
      defaultModelId: "claude-sonnet-5",
      defaultEffort: "high",
      supportsFast: () => false,
      approvalModes: APPROVAL_MODES,
      perTurnModelSwitch: true
    };
  }
  function byokStaticDescriptor() {
    return {
      ...claudeSubDescriptor(),
      id: "byok",
      label: "BYOK",
      supportsFast: (modelId) => /claude-opus-4-(6|7|8)/.test(String(modelId || ""))
    };
  }
  function mergeByokModels(descriptor, apiModels) {
    if (!apiModels) return descriptor;
    const curated = new Map(descriptor.models.map((m) => [m.id, m]));
    const models = apiModels.map((m) => {
      const known = curated.get(m.id);
      if (known) return known;
      return { id: m.id, label: m.display_name || m.id, effortLevels: [], cost: costTier(m.id) };
    });
    return { ...descriptor, models };
  }
  function descriptorWithCustomModel(descriptor, modelId) {
    const id = String(modelId || "").trim();
    if (!id) return descriptor;
    const existing = descriptor.models.find((m) => m.id === id);
    const custom = existing || { id, label: id, effortLevels: [], cost: 2, adaptive: false };
    const rest = descriptor.models.filter((m) => m.id !== id);
    return {
      ...descriptor,
      models: [custom, ...rest],
      defaultModelId: id
    };
  }
  function codexStaticDescriptor() {
    const models = [
      { id: "gpt-5.5", label: "GPT-5.5", effortLevels: ["low", "medium", "high", "xhigh"], cost: 2, adaptive: false },
      { id: "gpt-5.4", label: "GPT-5.4", effortLevels: ["low", "medium", "high", "xhigh"], cost: 2, adaptive: false },
      { id: "gpt-5.4-mini", label: "GPT-5.4 mini", effortLevels: ["low", "medium", "high", "xhigh"], cost: 1, adaptive: false }
    ];
    return {
      id: "codex",
      label: "Codex",
      models,
      defaultModelId: "gpt-5.5",
      defaultEffort: "medium",
      supportsFast: (modelId) => modelId === "gpt-5.5",
      approvalModes: APPROVAL_MODES,
      perTurnModelSwitch: true
    };
  }
  function modelListArray(modelListResult) {
    if (Array.isArray(modelListResult)) return modelListResult;
    if (modelListResult && Array.isArray(modelListResult.models)) return modelListResult.models;
    return [];
  }
  function codexDescriptorFromModels(modelListResult) {
    var _a;
    const rawModels = modelListArray(modelListResult).filter((m) => m && m.hidden !== true);
    if (!rawModels.length) return codexStaticDescriptor();
    const fastModels = /* @__PURE__ */ new Set();
    const models = rawModels.map((m) => {
      const id = String(m.id || "");
      if (Array.isArray(m.additionalSpeedTiers) && m.additionalSpeedTiers.includes("fast")) fastModels.add(id);
      return {
        id,
        label: m.displayName || m.display_name || id,
        effortLevels: Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts.map((e) => e && e.reasoningEffort).filter(Boolean) : [],
        cost: 2,
        adaptive: false
      };
    }).filter((m) => m.id);
    if (!models.length) return codexStaticDescriptor();
    const defaultRaw = rawModels.find((m) => m && m.hidden !== true && m.isDefault === true) || rawModels[0];
    const defaultModelId = defaultRaw && defaultRaw.id ? String(defaultRaw.id) : models[0].id;
    const defaultEffort = defaultRaw && defaultRaw.defaultReasoningEffort ? defaultRaw.defaultReasoningEffort : ((_a = models.find((m) => m.id === defaultModelId)) == null ? void 0 : _a.effortLevels[0]) || "medium";
    return {
      id: "codex",
      label: "Codex",
      models,
      defaultModelId,
      defaultEffort,
      supportsFast: (modelId) => fastModels.has(String(modelId || "")),
      approvalModes: APPROVAL_MODES,
      perTurnModelSwitch: true
    };
  }
  function openCodeStaticDescriptor() {
    const models = [
      { id: "north-mini-code-free", label: "North Mini Code Free", effortLevels: [], cost: 1, adaptive: false }
    ];
    return {
      id: "opencode",
      label: "OpenCode",
      models,
      defaultModelId: "north-mini-code-free",
      defaultEffort: null,
      supportsFast: () => false,
      approvalModes: APPROVAL_MODES,
      perTurnModelSwitch: true
    };
  }
  var ZCODE_EFFORT_LEVELS = ["nothink", "high", "max"];
  function zcodeStaticDescriptor() {
    const models = [
      { id: "builtin:bigmodel-start-plan/GLM-5.2", label: "GLM-5.2", effortLevels: ZCODE_EFFORT_LEVELS, cost: 2, adaptive: false },
      { id: "builtin:bigmodel-start-plan/GLM-5-Turbo", label: "GLM-5 Turbo", effortLevels: ZCODE_EFFORT_LEVELS, cost: 2, adaptive: false }
    ];
    return {
      id: "zcode",
      label: "ZCode",
      models,
      defaultModelId: "builtin:bigmodel-start-plan/GLM-5.2",
      defaultEffort: "high",
      supportsFast: () => false,
      approvalModes: APPROVAL_MODES,
      perTurnModelSwitch: false
    };
  }
  function zcodeDynamicDescriptor({ env, fsImpl } = {}) {
    let cliModel = "";
    try {
      cliModel = String(readZcodeDesktopModel({ env, fsImpl }) || "").trim();
    } catch (e) {
    }
    if (!cliModel) return zcodeStaticDescriptor();
    const label = cliModel.includes("/") ? cliModel.slice(cliModel.indexOf("/") + 1) : cliModel;
    return {
      id: "zcode",
      label: "ZCode",
      models: [{ id: cliModel, label, effortLevels: ZCODE_EFFORT_LEVELS, cost: 2, adaptive: false }],
      defaultModelId: cliModel,
      defaultEffort: "high",
      supportsFast: () => false,
      approvalModes: APPROVAL_MODES,
      perTurnModelSwitch: false
    };
  }
  function zcodeDescriptorFromModels(sessionCreateResult) {
    const available = sessionCreateResult && sessionCreateResult.settings && sessionCreateResult.settings.model && Array.isArray(sessionCreateResult.settings.model.available) ? sessionCreateResult.settings.model.available : [];
    const current = sessionCreateResult && sessionCreateResult.settings && sessionCreateResult.settings.model && sessionCreateResult.settings.model.current;
    const models = available.map((m) => {
      const ref = m.ref || {};
      const id = ref.modelId || m.label || "";
      const providerId = ref.providerId || "";
      return {
        id: providerId ? providerId + "/" + id : id,
        label: m.label || id,
        effortLevels: ZCODE_EFFORT_LEVELS,
        cost: 2,
        adaptive: false
      };
    }).filter((m) => m.id);
    if (!models.length) return zcodeStaticDescriptor();
    const defaultId = current ? current.providerId ? current.providerId + "/" + current.modelId : current.modelId : models[0].id;
    return {
      id: "zcode",
      label: "ZCode",
      models,
      defaultModelId: models.some((m) => m.id === defaultId) ? defaultId : models[0].id,
      defaultEffort: "medium",
      supportsFast: () => false,
      approvalModes: APPROVAL_MODES,
      perTurnModelSwitch: false
    };
  }
  function zcodeDescriptorFromProbedModels({ cliModel, providerId, probedModels } = {}) {
    const cli = String(cliModel || "").trim();
    if (!cli || !Array.isArray(probedModels) || !probedModels.length) return null;
    const pid = String(providerId || "").trim();
    const cliLabel = cli.includes("/") ? cli.slice(cli.indexOf("/") + 1) : cli;
    const rest = probedModels.map((m) => {
      const rawId = String(m && m.id || "").trim();
      if (!rawId) return null;
      const id = pid ? pid + "/" + rawId : rawId;
      if (id === cli) return null;
      return { id, label: m && m.label || rawId, effortLevels: ZCODE_EFFORT_LEVELS, cost: 2, adaptive: false };
    }).filter(Boolean);
    const models = [
      { id: cli, label: cliLabel, effortLevels: ZCODE_EFFORT_LEVELS, cost: 2, adaptive: false },
      ...rest
    ];
    return {
      id: "zcode",
      label: "ZCode",
      models,
      defaultModelId: cli,
      defaultEffort: "high",
      supportsFast: () => false,
      approvalModes: APPROVAL_MODES,
      perTurnModelSwitch: false
    };
  }
  function descriptorFromProbedModels(descriptor, probedModels) {
    if (!Array.isArray(probedModels) || !probedModels.length) return descriptor;
    const curated = new Map(descriptor.models.map((m) => [m.id, m]));
    const models = probedModels.map((m) => {
      const known = curated.get(m.id);
      if (known) return known;
      return { id: m.id, label: m.label || m.id, effortLevels: [], cost: costTier(m.id), adaptive: false };
    });
    return { ...descriptor, models, defaultModelId: models[0].id };
  }

  // src/cep/backends/index.js
  var BACKENDS = {
    subscription: { id: "subscription", baseDescriptor: claudeSubDescriptor },
    byok: { id: "byok", baseDescriptor: byokStaticDescriptor },
    "claude-api": { id: "claude-api", baseDescriptor: byokStaticDescriptor },
    codex: { id: "codex", baseDescriptor: codexStaticDescriptor },
    opencode: { id: "opencode", baseDescriptor: openCodeStaticDescriptor },
    // zcode's baseDescriptor is intentionally NOT zcodeStaticDescriptor here:
    // baseDescriptorFor() special-cases 'zcode' below to build a live,
    // CLI-config-aware descriptor. zcodeStaticDescriptor remains the ultimate
    // fallback (used by zcodeDynamicDescriptor itself, and by
    // zcodeDescriptorFromModels once a session exists) when no CLI config is
    // readable at all.
    zcode: { id: "zcode", baseDescriptor: zcodeStaticDescriptor }
  };
  var REAL_BACKENDS = Object.keys(BACKENDS);
  function baseDescriptorFor(backendId, env) {
    if (backendId === "zcode") return zcodeDynamicDescriptor({ env });
    const entry = BACKENDS[backendId];
    return entry ? entry.baseDescriptor() : claudeSubDescriptor();
  }

  // src/lib/channels.js
  function claudeChannels({ probe, apiProvider } = {}) {
    const sub = {
      channel: "subscription",
      source: { zh: "\u8BA2\u9605\u767B\u5F55", en: "Subscription login" },
      checking: probe === null,
      ok: Boolean(probe && probe.nodeOk !== false && probe.loggedIn),
      detail: probe && probe.detail || "",
      fixHint: probe && probe.nodeOk === false ? { zh: "\u5185\u5D4C\u5BF9\u8BDD\u9700\u8981\u7CFB\u7EDF Node 18+\uFF1A\u5B89\u88C5 Node.js LTS \u540E\u91CD\u65B0\u68C0\u6D4B\uFF1B\u6216\u4F7F\u7528\u4E0B\u65B9\u300CAPI \u76F4\u8FDE\u300D\u901A\u9053\uFF08\u65E0 Node \u65F6\u81EA\u52A8\u964D\u7EA7\u4E3A\u76F4\u8FDE HTTP\uFF09\u3002", en: "Embedded chat needs system Node 18+: install Node.js LTS and re-check, or use the API direct channel below (falls back to direct HTTP without Node)." } : { zh: "\u8BA2\u9605\u672A\u767B\u5F55\uFF1A\u5728\u7EC8\u7AEF\u8FD0\u884C claude /login \u5B8C\u6210\u767B\u5F55\u540E\u91CD\u65B0\u68C0\u6D4B\uFF1B\u6216\u6539\u7528\u4E0B\u65B9\u300CAPI \u76F4\u8FDE\u300D\u901A\u9053\u3002", en: "Not logged in: run claude /login in a terminal and re-check, or switch to the API direct channel below." }
    };
    const api = {
      channel: "api",
      source: { zh: "\u9762\u677F\u914D\u7F6E \xB7 API \u76F4\u8FDE", en: "Panel config \xB7 API direct" },
      checking: false,
      ok: Boolean(apiProvider && apiProvider.baseUrl && apiProvider.apiKey),
      detail: apiProvider && apiProvider.baseUrl ? apiProvider.baseUrl : "",
      fixHint: { zh: "\u5728\u300CProvider \u7BA1\u7406\u300D\u65B0\u589E/\u9009\u62E9\u4E00\u4E2A Anthropic \u534F\u8BAE provider\uFF08Base URL + Key/Token\uFF09\uFF0C\u6216\u4E00\u952E\u5BFC\u5165 ~/.claude/settings.json\u3002Claude-3p \u684C\u9762\u7248\u51ED\u636E\u65E0\u6CD5\u81EA\u52A8\u8BFB\u53D6\uFF0C\u8BF7\u624B\u52A8\u586B\u4E00\u6B21\u3002", en: "Add or pick an Anthropic-protocol provider (base URL + key/token) in Provider Manager, or import from ~/.claude/settings.json. Claude-3p desktop credentials cannot be read automatically; paste them once." }
    };
    return [sub, api];
  }
  function codexChannels({ codexProbe, customProvider, cliConfig, cliConfigApiKey } = {}) {
    const cli = {
      channel: "cli",
      source: { zh: "Codex CLI \u767B\u5F55\u6001", en: "Codex CLI login" },
      checking: codexProbe === null,
      ok: Boolean(codexProbe && codexProbe.loggedIn),
      detail: codexProbe ? [codexProbe.email, codexProbe.planType, codexProbe.cliPath, codexProbe.cliVersion].filter(Boolean).join(" \xB7 ") : "",
      fixHint: { zh: "\u5728\u7EC8\u7AEF\u5B8C\u6210 codex \u767B\u5F55\u540E\u91CD\u65B0\u68C0\u6D4B\uFF1B\u82E5 codex \u4E0D\u5728\u9762\u677F PATH \u4E0A\uFF0C\u8BBE\u7F6E\u73AF\u5883\u53D8\u91CF AE_MCP_CODEX_CLI \u6307\u5411 codex \u53EF\u6267\u884C\u6587\u4EF6\u540E\u91CD\u542F AE\u3002", en: "Sign in with codex in a terminal and re-check; if codex is not on the panel PATH, set AE_MCP_CODEX_CLI to the codex executable and restart AE." }
    };
    const runtimeOk = Boolean(!codexProbe || codexProbe.runtimeOk !== false);
    const hasProvider = Boolean(cliConfig && cliConfig.provider);
    const hasKey = Boolean(cliConfigApiKey);
    const cliConfigChannel = {
      channel: "cli-config",
      source: { zh: "\u7EE7\u627F\u81EA Codex CLI \u914D\u7F6E", en: "Inherited from Codex CLI config" },
      checking: false,
      ok: hasProvider && hasKey && runtimeOk,
      detail: hasProvider ? [cliConfig.providerId, cliConfig.model, cliConfig.provider.baseUrl].filter(Boolean).join(" \xB7 ") : "",
      fixHint: !hasProvider ? { zh: "\u672A\u627E\u5230 ~/.codex/config.toml \u7684\u53EF\u7528 provider\uFF1A\u5148\u5728 Codex CLI \u91CC\u914D\u7F6E model_provider\u3002", en: "No usable provider in ~/.codex/config.toml: configure model_provider in the Codex CLI first." } : !hasKey ? { zh: "\u68C0\u6D4B\u5230 Codex CLI provider\u300C" + cliConfig.providerId + "\u300D\uFF0C\u4F46\u5176 API Key \u73AF\u5883\u53D8\u91CF\uFF08" + (cliConfig.provider.envKey || "-") + "\uFF09\u6CA1\u6709\u88AB\u9762\u677F\u7EE7\u627F\u3002\u5728\u4E0B\u65B9\u7C98\u8D34\u4E00\u6B21 Key\uFF08\u4FDD\u5B58\u5230\u672C\u673A ~/.ae-mcp/codex-key\uFF09\u5373\u53EF\u4F7F\u7528\u3002", en: 'Found Codex CLI provider "' + cliConfig.providerId + '", but its API key env (' + (cliConfig.provider.envKey || "-") + ") is not inherited by the panel. Paste the key once below (stored at ~/.ae-mcp/codex-key)." } : { zh: "Codex \u8FD0\u884C\u65F6\u4E0D\u53EF\u7528\uFF1A\u8BF7\u68C0\u67E5 Codex CLI \u5B89\u88C5\u540E\u91CD\u65B0\u68C0\u6D4B\u3002", en: "Codex runtime unavailable: check the Codex CLI install and re-check." }
    };
    const custom = {
      channel: "custom",
      source: { zh: "\u81EA\u5B9A\u4E49 provider", en: "Custom provider" },
      checking: false,
      ok: Boolean(customProvider && customProvider.baseUrl && customProvider.apiKey && (!codexProbe || codexProbe.runtimeOk !== false)),
      detail: customProvider && customProvider.baseUrl ? customProvider.baseUrl : "",
      fixHint: { zh: "\u5728\u300CProvider \u7BA1\u7406\u300D\u65B0\u589E/\u9009\u62E9\u4E00\u4E2A OpenAI \u517C\u5BB9 provider\uFF08Base URL + Key\uFF09\u3002", en: "Add or pick an OpenAI-compatible provider (base URL + key) in Provider Manager." }
    };
    return custom.ok ? [cli, custom, cliConfigChannel] : [cli, cliConfigChannel, custom];
  }
  function zcodeChannels({ zcodeProbe, configSummary } = {}) {
    const summary = configSummary || {};
    const runtimeOk = Boolean(zcodeProbe && zcodeProbe.runtimeOk !== false);
    const runtimeHint = { zh: "ZCode \u8FD0\u884C\u65F6\u4E0D\u53EF\u7528\uFF1A\u5B89\u88C5 ZCode\u3001\u786E\u8BA4\u7CFB\u7EDF Node \u53EF\u7528\uFF0C\u6216\u8BBE\u7F6E AE_MCP_ZCODE_CLI \u540E\u91CD\u65B0\u68C0\u6D4B\u3002", en: "ZCode runtime unavailable: install ZCode, confirm system Node, or set AE_MCP_ZCODE_CLI, then re-check." };
    const cli = {
      channel: "cli-config",
      source: { zh: "\u7EE7\u627F\u81EA ZCode CLI", en: "Inherited from ZCode CLI" },
      checking: zcodeProbe === null,
      ok: Boolean(summary.cli && summary.cli.hasCredential && runtimeOk),
      detail: summary.cli ? summary.cli.model || summary.cli.providerId : "",
      fixHint: !runtimeOk && summary.cli ? runtimeHint : summary.cli && !summary.cli.hasCredential ? { zh: "\u68C0\u6D4B\u5230 ZCode CLI provider\u300C" + summary.cli.providerId + "\u300D\uFF0C\u4F46\u5176 API Key \u73AF\u5883\u53D8\u91CF\uFF08" + (summary.cli.apiKeyEnv || "-") + "\uFF09\u6CA1\u6709\u88AB\u9762\u677F\u7EE7\u627F\u3002\u5728\u4E0B\u65B9\u7C98\u8D34\u4E00\u6B21 Key\uFF08\u4FDD\u5B58\u5230\u672C\u673A ~/.ae-mcp/zcode-key\uFF09\u5373\u53EF\u4F7F\u7528\u3002", en: 'Found ZCode CLI provider "' + summary.cli.providerId + '", but its API key env (' + (summary.cli.apiKeyEnv || "-") + ") is not inherited by the panel. Paste the key once below (stored at ~/.ae-mcp/zcode-key)." } : { zh: "\u672A\u627E\u5230 ~/.zcode/cli/config.json \u7684\u53EF\u7528 provider\uFF1A\u5148\u5728 ZCode CLI \u91CC\u914D\u7F6E provider \u4E0E\u9ED8\u8BA4\u6A21\u578B\u3002", en: "No usable provider in ~/.zcode/cli/config.json: configure a provider and default model in the ZCode CLI first." }
    };
    const desktop = {
      channel: "desktop",
      source: { zh: "\u7EE7\u627F\u81EA ZCode \u684C\u9762\u7248", en: "Inherited from ZCode desktop" },
      checking: zcodeProbe === null,
      ok: Boolean(summary.desktop && runtimeOk),
      detail: summary.desktop ? summary.desktop.providerId : "",
      fixHint: !runtimeOk && summary.desktop ? runtimeHint : { zh: "\u6253\u5F00 ZCode \u684C\u9762\u7248\u5E76\u9009\u62E9\u4E00\u4E2A provider/model\uFF0C\u7136\u540E\u91CD\u65B0\u68C0\u6D4B\u3002", en: "Open ZCode desktop, pick a provider/model, then re-check." }
    };
    const startPlan = {
      channel: "start-plan",
      source: { zh: "\u5B98\u65B9\u6258\u7BA1\u8BA1\u5212", en: "Official hosted plan" },
      checking: false,
      ok: Boolean(summary.startPlan && summary.startPlan.hasCredential && runtimeOk),
      detail: summary.startPlan ? summary.startPlan.providerId : "",
      fixHint: { zh: "\u5B98\u65B9\u6258\u7BA1\u8BA1\u5212\u9700\u8981 ZCode \u684C\u9762\u9A8C\u8BC1\u7801\u6865\u63A5\uFF08\u9762\u677F\u5C1A\u672A\u5B9E\u73B0\uFF09\uFF1A\u68C0\u6D4B\u5230\u6709\u6548\u51ED\u636E\u524D\u4E0D\u53EF\u9009\u3002\u8BF7\u4F7F\u7528 CLI \u914D\u7F6E\u6216\u684C\u9762\u7248\u901A\u9053\u3002", en: "The hosted plan needs the ZCode desktop captcha bridge (not implemented in the panel yet) and stays unavailable until valid credentials are detected. Use the CLI-config or desktop channel instead." }
    };
    return [cli, desktop, startPlan];
  }
  function pickChannel(channels, lockedChannel = "") {
    const list = Array.isArray(channels) ? channels : [];
    if (lockedChannel) {
      const locked = list.find((c) => c && c.channel === lockedChannel);
      if (locked) return locked;
    }
    return list.find((c) => c && c.ok) || null;
  }
  function migrateBackendPref(storage) {
    let pref = "subscription";
    let lockedChannel = "";
    try {
      const raw = storage.getItem("ae_mcp_backend") || "subscription";
      lockedChannel = storage.getItem("ae_mcp_channel_lock") || "";
      if (raw === "byok") {
        pref = "subscription";
        lockedChannel = "api";
        storage.setItem("ae_mcp_backend", pref);
        storage.setItem("ae_mcp_channel_lock", lockedChannel);
      } else if (raw === "opencode") {
        pref = "subscription";
        storage.setItem("ae_mcp_backend", pref);
      } else if (raw === "codex" || raw === "zcode" || raw === "subscription") {
        pref = raw;
      }
    } catch (e) {
    }
    return { pref, lockedChannel };
  }

  // src/lib/backendSelect.js
  function pickBackend({ pref, channels = {}, lockedChannel = "", nodeOk = true }) {
    const group = pref === "codex" || pref === "zcode" ? pref : "claude";
    const list = channels[group] || [];
    if (list.some((c) => c && c.checking)) {
      return { backend: "none", reason: group + "-probing", channel: null, fixHint: null };
    }
    const chosen = pickChannel(list, lockedChannel);
    if (!chosen || !chosen.ok) {
      const hintSource = chosen || list.find((c) => c && !c.ok) || list[0] || null;
      return {
        backend: "none",
        reason: group + "-no-channel",
        channel: chosen ? chosen.channel : null,
        fixHint: hintSource ? hintSource.fixHint || null : null
      };
    }
    if (group === "claude") {
      if (chosen.channel === "api") {
        return { backend: nodeOk ? "claude-api" : "byok", reason: "ok", channel: "api", fixHint: null };
      }
      return { backend: "subscription", reason: "ok", channel: "subscription", fixHint: null };
    }
    return { backend: group, reason: "ok", channel: chosen.channel, fixHint: null };
  }
  function deriveToolMeta(tools) {
    const allowedTools = [];
    const annotations = {};
    for (const tool of tools || []) {
      const name = "mcp__ae__" + tool.name;
      const ann = tool && tool.annotations || {};
      const readOnly = ann.readOnlyHint === true;
      const destructive = ann.destructiveHint === true;
      if (readOnly) allowedTools.push(name);
      annotations[name] = { readOnly, destructive };
    }
    return { allowedTools, annotations };
  }
  function shouldResetOnBackendChange(prevReal, next) {
    if (!REAL_BACKENDS.includes(next)) return { reset: false, nextReal: prevReal || null };
    if (!prevReal) return { reset: false, nextReal: next };
    if (prevReal === next) return { reset: false, nextReal: prevReal };
    return { reset: true, nextReal: next };
  }

  // src/cep/mcpClient.js
  var DEFAULT_TIMEOUT_MS = 3e4;
  var MCP_PROTOCOL_VERSION = "2025-06-18";
  var PANEL_VERSION = "0.9.0";
  function getCepRequire3() {
    if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) {
      return globalThis.window.cep_node.require;
    }
    if (globalThis.window && globalThis.window.require) return globalThis.window.require;
    if (globalThis.require) return globalThis.require;
    throw new Error("CEP Node require is unavailable");
  }
  function getCepEnv3() {
    return globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.process && globalThis.window.cep_node.process.env || {};
  }
  function normalizeFsPath(value) {
    let text = String(value || "").replace(/\//g, "\\");
    text = text.replace(/\\+$/, "");
    return text;
  }
  function dirname(value) {
    const normalized = normalizeFsPath(value);
    const index = normalized.lastIndexOf("\\");
    if (index <= 0) return "";
    return normalized.slice(0, index);
  }
  function joinPath(base, leaf) {
    return normalizeFsPath(base) + "\\" + leaf;
  }
  function firstWhereHit(stdout) {
    return String(stdout || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
  }
  function defaultWhereImpl() {
    const childProcess = getCepRequire3()("child_process");
    return new Promise((resolve) => {
      childProcess.execFile("where", ["ae-mcp"], { windowsHide: true }, (err, stdout) => {
        resolve(err ? "" : stdout);
      });
    });
  }
  function defaultFs() {
    return getCepRequire3()("fs");
  }
  function findProjectRoot({ extRoot, repoRoot, fsImpl }) {
    if (repoRoot && fsImpl.existsSync(joinPath(repoRoot, "pyproject.toml"))) return normalizeFsPath(repoRoot);
    let current = normalizeFsPath(extRoot);
    while (current) {
      if (fsImpl.existsSync(joinPath(current, "pyproject.toml"))) return current;
      const parent = dirname(current);
      if (!parent || parent === current) break;
      current = parent;
    }
    return "";
  }
  async function resolveMcpCommand({
    explicitPath,
    whereImpl = defaultWhereImpl,
    fsImpl,
    envImpl = null,
    extRoot = "",
    repoRoot = ""
  } = {}) {
    const configured = String(explicitPath || "").trim();
    if (configured) return { command: configured, args: [], source: "explicit" };
    const found = firstWhereHit(await whereImpl("ae-mcp"));
    if (found) return { command: found, args: [], source: "where" };
    const fs = fsImpl || defaultFs();
    const profile = (envImpl || getCepEnv3()).USERPROFILE || "";
    if (profile) {
      const shim = joinPath(joinPath(joinPath(normalizeFsPath(profile), ".local"), "bin"), "ae-mcp.exe");
      if (fs.existsSync(shim)) return { command: shim, args: [], source: "uv-tool" };
    }
    const projectRoot = findProjectRoot({ extRoot, repoRoot, fsImpl: fs });
    if (projectRoot) {
      return { command: "uv", args: ["run", "--project", projectRoot, "ae-mcp"], source: "uv" };
    }
    throw new Error("Unable to find ae-mcp. Configure the ae-mcp executable path, add ae-mcp to PATH, or run from a checkout containing pyproject.toml for uv run --project.");
  }
  function _createRpc(stdinWrite, onLine, options = {}) {
    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    let nextId2 = 1;
    const pending = /* @__PURE__ */ new Map();
    function rejectPending(id, error) {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    function handleMessage(message) {
      if (!message || message.id === void 0 || message.id === null) return;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        const error = new Error(message.error.message || "JSON-RPC request failed");
        error.code = message.error.code;
        error.data = message.error.data;
        entry.reject(error);
      } else {
        entry.resolve(message.result);
      }
    }
    const handleChunk = createNdjsonReader(handleMessage);
    if (onLine) onLine(handleChunk);
    function writeMessage(message) {
      stdinWrite(JSON.stringify(message) + "\n");
    }
    function request(method, params) {
      const id = nextId2++;
      const message = { jsonrpc: "2.0", id, method };
      if (params !== void 0) message.params = params;
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => rejectPending(id, new Error(method + " timed out after " + timeoutMs + "ms")), timeoutMs);
        pending.set(id, { resolve, reject, timer });
      });
      writeMessage(message);
      return promise;
    }
    function notify(method, params) {
      const message = { jsonrpc: "2.0", method };
      if (params !== void 0) message.params = params;
      writeMessage(message);
    }
    function close(reason = new Error("MCP process closed")) {
      for (const id of Array.from(pending.keys())) rejectPending(id, reason);
    }
    return { request, notify, handleChunk, close };
  }
  function createMcpClient({
    spawnImpl,
    resolveCommand = resolveMcpCommand,
    env,
    onCrash,
    extRoot,
    repoRoot,
    getExpertGuidance = () => true,
    packageVersion = PANEL_VERSION,
    retryDelays = [1e3, 2e3, 4e3]
  } = {}) {
    let proc = null;
    let rpc = null;
    let tools = null;
    let serverInstructions = "";
    let status = "idle";
    let startPromise = null;
    let retryCount = 0;
    let lastError = null;
    let stopped = false;
    let restartTimer = null;
    function currentState() {
      return { status, retryCount, error: lastError, tools };
    }
    function getSpawn() {
      if (spawnImpl) return spawnImpl;
      return getCepRequire3()("child_process").spawn;
    }
    function attachBeforeUnload() {
      if (globalThis.window && globalThis.window.addEventListener) {
        globalThis.window.addEventListener("beforeunload", () => stop());
      }
    }
    async function start() {
      if (status === "ready") return currentState();
      if (startPromise) return startPromise;
      stopped = false;
      status = "starting";
      startPromise = (async () => {
        const commandSpec = await resolveCommand({ extRoot, repoRoot });
        const spawn = getSpawn();
        const spawnEnv = Object.assign({}, getCepEnv3(), env || {}, {
          AE_MCP_BACKEND: "ae-mcp",
          ...expertGuidanceEnv(getExpertGuidance())
        });
        proc = spawn(commandSpec.command, commandSpec.args || [], {
          stdio: "pipe",
          windowsHide: true,
          env: spawnEnv
        });
        rpc = _createRpc(
          (line) => proc.stdin.write(line),
          (handler) => proc.stdout.on("data", handler)
        );
        proc.on("exit", (code, signal) => handleExit(code, signal));
        proc.on("error", (err) => handleCrash(err));
        if (proc.stderr && proc.stderr.on) proc.stderr.on("data", () => {
        });
        const initResult = await rpc.request("initialize", {
          protocolVersion: MCP_PROTOCOL_VERSION,
          clientInfo: { name: "panel-chat", version: packageVersion },
          capabilities: {}
        });
        serverInstructions = initResult && initResult.instructions || "";
        rpc.notify("notifications/initialized");
        const listed = await rpc.request("tools/list", {});
        tools = listed && Array.isArray(listed.tools) ? listed.tools : [];
        status = "ready";
        retryCount = 0;
        lastError = null;
        attachBeforeUnload();
        return currentState();
      })();
      try {
        return await startPromise;
      } catch (e) {
        status = "error";
        lastError = e;
        throw e;
      } finally {
        startPromise = null;
      }
    }
    function handleCrash(error) {
      if (stopped) return;
      status = "crashed";
      lastError = error;
      if (rpc) rpc.close(error instanceof Error ? error : new Error("MCP process crashed"));
      if (onCrash) onCrash(error);
      scheduleRestart();
    }
    function handleExit(code, signal) {
      if (stopped) return;
      handleCrash(new Error("MCP process exited: " + code + (signal ? " " + signal : "")));
    }
    function scheduleRestart() {
      if (retryCount >= retryDelays.length) {
        status = "error";
        return;
      }
      const delay = retryDelays[retryCount++];
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        start().catch((err) => {
          lastError = err;
          scheduleRestart();
        });
      }, delay);
    }
    async function listTools() {
      await start();
      return tools || [];
    }
    async function callTool(name, args = {}) {
      await start();
      return rpc.request("tools/call", { name, arguments: args });
    }
    function stop() {
      stopped = true;
      clearTimeout(restartTimer);
      restartTimer = null;
      status = "stopped";
      if (rpc) rpc.close(new Error("MCP client stopped"));
      if (proc) {
        try {
          proc.kill();
        } catch (e) {
        }
      }
      proc = null;
      rpc = null;
      startPromise = null;
    }
    return { start, listTools, callTool, stop, state: currentState, getServerInstructions: () => serverInstructions };
  }

  // src/cep/claudeAuth.js
  function getCepRequire4() {
    if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) {
      return globalThis.window.cep_node.require;
    }
    if (globalThis.window && globalThis.window.require) return globalThis.window.require;
    if (globalThis.require) return globalThis.require;
    throw new Error("CEP Node require is unavailable");
  }
  function getCepEnv4() {
    return globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.process && globalThis.window.cep_node.process.env || {};
  }
  function normalizeFsPath2(value) {
    let text = String(value || "").replace(/\//g, "\\");
    text = text.replace(/\\+$/, "");
    return text;
  }
  function defaultFs2() {
    return getCepRequire4()("fs");
  }
  function defaultSpawn() {
    return getCepRequire4()("child_process").spawn;
  }
  function joinPath2(base, leaf) {
    return normalizeFsPath2(base) + "\\" + leaf;
  }
  function resolveSidecarPath({ extRoot, fsImpl } = {}) {
    const root = normalizeFsPath2(extRoot || "");
    const deployed = joinPath2(root, "sidecar\\agent-sidecar.mjs");
    const repo = joinPath2(root, "..\\sidecar\\agent-sidecar.mjs");
    const fs = fsImpl || defaultFs2();
    if (fs.existsSync(deployed)) return deployed;
    if (fs.existsSync(repo)) return repo;
    return deployed;
  }
  async function probeClaudeLogin({
    resolveNode,
    sidecarPath,
    spawnImpl,
    env,
    timeoutMs = 3e4
  } = {}) {
    const resolved = await resolveNode();
    if (!resolved || resolved.ok === false) {
      return { loggedIn: false, nodeOk: false, detail: resolved && resolved.detail || "node unavailable" };
    }
    return await new Promise((resolve) => {
      let settled = false;
      let stderr = "";
      let proc = null;
      const spawn = spawnImpl || defaultSpawn();
      const spawnEnv = claudeChannelEnv(Object.assign({}, getCepEnv4(), env || {}), { channel: "subscription" });
      function finish(result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      }
      const timer = setTimeout(() => {
        if (proc && proc.kill) {
          try {
            proc.kill();
          } catch (e) {
          }
        }
        finish({ loggedIn: false, nodeOk: true, nodeVersion: resolved.version, detail: "probe timeout" });
      }, timeoutMs);
      try {
        proc = spawn(resolved.nodePath, [sidecarPath, "--probe"], {
          stdio: "pipe",
          windowsHide: true,
          env: spawnEnv
        });
      } catch (e) {
        finish({ loggedIn: false, nodeOk: true, nodeVersion: resolved.version, detail: e && e.message ? e.message : String(e) });
        return;
      }
      const onMessage = createNdjsonReader((message) => {
        if (!message || message.t !== "probe-result") return;
        finish({
          loggedIn: !!message.loggedIn,
          nodeOk: true,
          nodeVersion: resolved.version,
          detail: message.detail || message.reason || ""
        });
      });
      if (proc.stdout && proc.stdout.on) proc.stdout.on("data", onMessage);
      if (proc.stderr && proc.stderr.on) {
        proc.stderr.on("data", (chunk) => {
          stderr += String(chunk || "");
          if (stderr.length > 4e3) stderr = stderr.slice(-4e3);
        });
      }
      if (proc.on) {
        proc.on("error", (err) => {
          finish({ loggedIn: false, nodeOk: true, nodeVersion: resolved.version, detail: err && err.message ? err.message : String(err) });
        });
        proc.on("exit", () => {
          finish({ loggedIn: false, nodeOk: true, nodeVersion: resolved.version, detail: stderr.trim() || "probe exited without result" });
        });
      }
    });
  }

  // src/cep/codexBackend.js
  var RPC_TIMEOUT_MS2 = 3e4;
  var STDERR_TAIL_LIMIT3 = 4096;
  var APPROVAL_POLICY = {
    granular: { mcp_elicitations: true, rules: false, sandbox_approval: false }
  };
  var SANDBOX_POLICY = { type: "readOnly" };
  function getCepRequire5() {
    if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) {
      return globalThis.window.cep_node.require;
    }
    if (globalThis.window && globalThis.window.require) return globalThis.window.require;
    if (globalThis.require) return globalThis.require;
    throw new Error("CEP Node require is unavailable");
  }
  function getCepEnv5() {
    return globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.process && globalThis.window.cep_node.process.env || {};
  }
  function appendTail4(tail, chunk) {
    const next = tail + String(chunk || "");
    return next.length > STDERR_TAIL_LIMIT3 ? next.slice(next.length - STDERR_TAIL_LIMIT3) : next;
  }
  function clone4(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }
  function normalizeFsPath3(value) {
    return String(value || "").replace(/\//g, "\\").replace(/\\+$/, "");
  }
  function dirname2(value) {
    const normalized = normalizeFsPath3(value);
    const index = normalized.lastIndexOf("\\");
    if (index <= 0) return "";
    return normalized.slice(0, index);
  }
  function defaultCwd(env) {
    const extRoot = env && (env.AE_MCP_PANEL_EXT_ROOT || env.EXTENSION_ROOT);
    const parent = extRoot ? dirname2(extRoot) : "";
    if (parent) return parent;
    if (env && (env.TEMP || env.TMP)) return env.TEMP || env.TMP;
    try {
      return getCepRequire5()("os").tmpdir();
    } catch (e) {
      return ".";
    }
  }
  function responseMessage(id, result) {
    return { jsonrpc: "2.0", id, result };
  }
  function errorMessage(id, code, message) {
    return { jsonrpc: "2.0", id, error: { code, message } };
  }
  function isTransientReconnectError(error) {
    const message = error && error.message !== void 0 ? String(error.message) : "";
    return /^reconnecting\.\.\.\s*\d+\/\d+$/i.test(message);
  }
  function createRpc2({ writeLine, onNotification, onRequest, timeoutMs = RPC_TIMEOUT_MS2 }) {
    let nextId2 = 1;
    const pending = /* @__PURE__ */ new Map();
    function writeMessage(message) {
      writeLine(JSON.stringify(message) + "\n");
    }
    function rejectPending(id, error) {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    function handleMessage(message) {
      if (!message || typeof message !== "object") return;
      const hasId = message.id !== void 0 && message.id !== null;
      if (hasId && !message.method) {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) {
          const error = new Error(message.error.message || "JSON-RPC request failed");
          error.code = message.error.code;
          error.data = message.error.data;
          entry.reject(error);
        } else {
          entry.resolve(message.result);
        }
        return;
      }
      if (message.method && hasId) {
        if (onRequest) onRequest(message);
        return;
      }
      if (message.method && onNotification) onNotification(message);
    }
    function request(method, params, timeoutOverrideMs) {
      const id = nextId2++;
      const message = { jsonrpc: "2.0", id, method };
      if (params !== void 0) message.params = params;
      const limit = timeoutOverrideMs || timeoutMs;
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => rejectPending(id, new Error(method + " timed out after " + limit + "ms")), limit);
        pending.set(id, { resolve, reject, timer });
      });
      writeMessage(message);
      return promise;
    }
    function fireRequest(method, params) {
      const id = nextId2++;
      const message = { jsonrpc: "2.0", id, method };
      if (params !== void 0) message.params = params;
      writeMessage(message);
      return id;
    }
    function respond(id, result) {
      writeMessage(responseMessage(id, result));
    }
    function respondError(id, code, message) {
      writeMessage(errorMessage(id, code, message));
    }
    function close(reason = new Error("Codex app-server closed")) {
      for (const id of Array.from(pending.keys())) rejectPending(id, reason);
    }
    return { request, fireRequest, respond, respondError, close, handleMessage };
  }
  function prefixedToolName(params) {
    const raw = elicitationToolName(params);
    if (!raw) return "";
    const text = String(raw);
    return text.startsWith("mcp__") ? text : "mcp__ae__" + text;
  }
  function elicitationToolName(params) {
    if (!params || typeof params !== "object") return "";
    const match = String(params.message || "").match(/run tool "([^"]+)"/);
    if (match) return match[1];
    const description = params._meta && params._meta.tool_description;
    if (description) return String(description).split("\u2014")[0].trim();
    return params.name || params.tool || params.toolName || params.request && params.request.tool || "";
  }
  function elicitationInput(params) {
    if (!params || typeof params !== "object") return params;
    if (params._meta && params._meta.tool_params !== void 0) return params._meta.tool_params;
    if (params.arguments !== void 0) return params.arguments;
    if (params.input !== void 0) return params.input;
    if (params.request && params.request.arguments !== void 0) return params.request.arguments;
    return params;
  }
  function itemFromParams(params) {
    return params && params.item || params || {};
  }
  function mcpToolName2(item) {
    const tool = item && (item.tool || item.name);
    return tool ? "mcp__ae__" + String(tool).replace(/^mcp__ae__/, "") : "";
  }
  function toolResultText(result) {
    const content = result && Array.isArray(result.content) ? result.content : [];
    return content.filter((part) => part && part.type === "text").map((part) => String(part.text || "")).join("");
  }
  function threadIdFromResult(result) {
    return result && (result.threadId || result.id || result.thread && result.thread.id) || null;
  }
  function execFileAsync3(execFile, cmd, args, env) {
    return new Promise((resolve) => {
      execFile(cmd, args, { env, windowsHide: true }, (err, stdout, stderr) => {
        resolve({ err, stdout: String(stdout || ""), stderr: String(stderr || "") });
      });
    });
  }
  function getHomedir() {
    try {
      return getCepRequire5()("os").homedir();
    } catch (e) {
      return "";
    }
  }
  async function resolveCodexCli({ env, execFileImpl } = {}) {
    const override = env && env.AE_MCP_CODEX_CLI;
    if (override) return { ok: true, cliPath: String(override), version: "" };
    let execFile = execFileImpl;
    if (!execFile) {
      try {
        execFile = getCepRequire5()("child_process").execFile;
      } catch (e) {
        return { ok: false, cliPath: "", version: "", detail: "child_process unavailable" };
      }
    }
    const where = await execFileAsync3(execFile, "where", ["codex"], env || {});
    if (!where.err && where.stdout) {
      const exe = String(where.stdout).split(/\r?\n/)[0].trim();
      if (exe) {
        const v = await execFileAsync3(execFile, exe, ["--version"], env || {});
        return { ok: true, cliPath: exe, version: v.err ? "" : String(v.stdout || v.stderr || "").trim() };
      }
    }
    return { ok: false, cliPath: "", version: "", detail: "codex CLI not found on PATH. Sign in with codex in a terminal, or set AE_MCP_CODEX_CLI to the executable." };
  }
  function createCodexBackend({
    spawnImpl,
    getModel,
    getEffort,
    getFast,
    getPermissionMode,
    getMcpSpec,
    getToolMeta,
    getExpertGuidance = () => true,
    getServerInstructions = () => "",
    getProviderProfile = () => ({}),
    // Spec A extension: when the panel has no explicit custom provider
    // configured, inherit a model_provider already declared in
    // ~/.codex/config.toml. config.toml owns model_provider selection; the
    // panel only supplies the missing API key env var the provider needs (no
    // `-c model_provider=...` override).
    getCliConfigProvider = () => null,
    resolveCli = resolveCodexCli,
    onEvent,
    lang = "zh",
    env
  }) {
    let proc = null;
    let rpc = null;
    let startPromise = null;
    let initializePromise = null;
    let initialized = false;
    let threadId = null;
    let preambleSent = false;
    let currentTurnId = null;
    let stopping = false;
    let stderrTail = "";
    let transcript = [];
    let activeRun = null;
    let activeResolve = null;
    let activeAssistantText = "";
    let toolMeta = { allowedTools: [], annotations: {} };
    let lastCliInfo = null;
    const pendingApprovals = /* @__PURE__ */ new Map();
    const sessionAllowedTools = /* @__PURE__ */ new Set();
    function emit(evt) {
      if (onEvent) onEvent(evt);
    }
    function getSpawn() {
      if (spawnImpl) return spawnImpl;
      return getCepRequire5()("child_process").spawn;
    }
    function currentEnv() {
      return Object.assign({}, getCepEnv5(), env || {});
    }
    function finishActive() {
      if (!activeResolve) {
        activeRun = null;
        activeAssistantText = "";
        return;
      }
      const resolve = activeResolve;
      activeResolve = null;
      activeRun = null;
      activeAssistantText = "";
      resolve();
    }
    function drainApprovals() {
      for (const [toolUseId, approval] of Array.from(pendingApprovals.entries())) {
        if (rpc) rpc.respond(approval.rpcId, { action: "decline", content: {} });
        pendingApprovals.delete(toolUseId);
        emit({ type: "tool-denied", toolUseId });
      }
    }
    function handleNotification(message) {
      const params = message.params || {};
      if (message.method === "turn/started") {
        currentTurnId = params.turn && params.turn.id || params.turnId || null;
        emit({ type: "turn-start" });
        return;
      }
      if (message.method === "item/agentMessage/delta") {
        emit({ type: "thinking", active: false });
        const text = params.delta !== void 0 ? params.delta : params.text;
        if (text) {
          activeAssistantText += String(text);
          emit({ type: "text-delta", text: String(text), phase: params.phase });
        }
        return;
      }
      if (message.method === "item/started") {
        const item = itemFromParams(params);
        if (item.type === "reasoning") {
          emit({ type: "thinking", active: true });
          return;
        }
        if (item.type !== "mcpToolCall") return;
        emit({
          type: "tool-start",
          toolUseId: String(item.id || ""),
          name: mcpToolName2(item),
          input: item.arguments
        });
        return;
      }
      if (message.method === "item/completed") {
        const item = itemFromParams(params);
        if (item.type === "reasoning") {
          emit({ type: "thinking", active: false });
          return;
        }
        if (item.type !== "mcpToolCall") return;
        emit({
          type: "tool-result",
          toolUseId: String(item.id || ""),
          name: mcpToolName2(item),
          ok: !item.error && item.status === "completed",
          text: toolResultText(item.result),
          durationMs: item.durationMs
        });
        return;
      }
      if (message.method === "turn/completed") {
        currentTurnId = null;
        drainApprovals();
        emit({ type: "turn-end", stopReason: "end_turn" });
        transcript.push({ role: "assistant", text: activeAssistantText });
        finishActive();
        return;
      }
      if (message.method === "error") {
        const error = params.error || params;
        if (isTransientReconnectError(error)) return;
        emit({ type: "error", kind: error.kind || "mcp", message: error.message || String(error || "Codex app-server error") });
        finishActive();
      }
    }
    function acceptElicitation(rpcId) {
      if (rpc) rpc.respond(rpcId, { action: "accept", content: {} });
    }
    function declineElicitation(rpcId, toolUseId) {
      if (rpc) rpc.respond(rpcId, { action: "decline", content: {} });
      emit({ type: "tool-denied", toolUseId });
    }
    function handleRequest(message) {
      if (message.method !== "mcpServer/elicitation/request") {
        if (rpc) rpc.respondError(message.id, -32601, "Method not found");
        return;
      }
      const toolUseId = String(message.id);
      const params = message.params || {};
      const name = prefixedToolName(params);
      const input = elicitationInput(params) || {};
      const annotations = toolMeta && toolMeta.annotations || {};
      const ann = annotations[name] || {};
      const tier = getPermissionMode ? getPermissionMode() : "manual";
      if (sessionAllowedTools.has(name) || ann.readOnly || tier === "none" || tier === "auto" && !ann.destructive) {
        acceptElicitation(message.id);
        return;
      }
      if (tier === "readonly") {
        declineElicitation(message.id, toolUseId);
        return;
      }
      const approval = {
        rpcId: message.id,
        name,
        input
      };
      pendingApprovals.set(toolUseId, approval);
      emit({
        type: "approval-required",
        toolUseId,
        name: approval.name,
        input: approval.input,
        risk: ann.destructive ? "destructive" : "write"
      });
    }
    function handleExit(code, signal) {
      const wasStopping = stopping;
      const detail = stderrTail ? String(code) + (signal ? " " + signal : "") + " " + stderrTail : String(code) + (signal ? " " + signal : "");
      if (rpc) rpc.close(new Error("codex app-server exited: " + detail));
      proc = null;
      rpc = null;
      startPromise = null;
      initializePromise = null;
      initialized = false;
      threadId = null;
      preambleSent = false;
      if (wasStopping) return;
      if (activeRun) {
        emit({ type: "error", kind: "mcp", message: "codex app-server exited: " + detail });
        finishActive();
      }
    }
    function handleError(error) {
      const err = error instanceof Error ? error : new Error("codex app-server error");
      if (rpc) rpc.close(err);
      proc = null;
      rpc = null;
      startPromise = null;
      initializePromise = null;
      initialized = false;
      threadId = null;
      preambleSent = false;
      if (activeRun) {
        emit({ type: "error", kind: "mcp", message: err.message });
        finishActive();
      }
    }
    async function startProcess() {
      if (proc && rpc) return true;
      if (startPromise) return startPromise;
      startPromise = (async () => {
        const spawn = getSpawn();
        const spawnEnv = ensureUserEnv(currentEnv(), { homedir: getHomedir() });
        const providerProfile = normalizeProviderProfile(getProviderProfile ? getProviderProfile() : {}, spawnEnv);
        stderrTail = "";
        stopping = false;
        const cliOverride = spawnEnv.AE_MCP_CODEX_CLI ? { ok: true, cliPath: String(spawnEnv.AE_MCP_CODEX_CLI), version: "" } : null;
        lastCliInfo = cliOverride || lastCliInfo;
        const command = cliOverride ? cliOverride.cliPath : "codex";
        let spawnEnvWithCreds = codexSpawnEnv(providerProfile, spawnEnv);
        if (!providerProfile.codexBaseUrl) {
          const cliConfig = getCliConfigProvider ? getCliConfigProvider() : null;
          const envKey = cliConfig && cliConfig.provider && String(cliConfig.provider.envKey || "").trim();
          if (envKey && cliConfig.apiKey) {
            spawnEnvWithCreds = Object.assign({}, spawnEnvWithCreds, { [envKey]: cliConfig.apiKey });
          }
        }
        proc = spawn(command, codexAppServerArgs(providerProfile), {
          stdio: "pipe",
          windowsHide: true,
          shell: true,
          env: spawnEnvWithCreds
        });
        rpc = createRpc2({
          writeLine: (line) => proc.stdin.write(line),
          onNotification: handleNotification,
          onRequest: handleRequest
        });
        const reader = createNdjsonReader((message) => rpc && rpc.handleMessage(message));
        if (proc.stdout && proc.stdout.on) proc.stdout.on("data", reader);
        if (proc.stderr && proc.stderr.on) proc.stderr.on("data", (chunk) => {
          stderrTail = appendTail4(stderrTail, chunk);
        });
        proc.on("exit", (code, signal) => handleExit(code, signal));
        proc.on("error", (error) => handleError(error));
        return true;
      })();
      try {
        return await startPromise;
      } finally {
        startPromise = null;
      }
    }
    async function initialize() {
      if (initialized) return true;
      if (initializePromise) return initializePromise;
      initializePromise = (async () => {
        await startProcess();
        await rpc.request("initialize", {
          clientInfo: { name: "ae-mcp-panel", version: PANEL_VERSION },
          // granular askForApproval (our four-tier mapping) is gated behind
          // the experimental API surface (live error without it).
          capabilities: { experimentalApi: true }
        });
        initialized = true;
        return true;
      })();
      try {
        return await initializePromise;
      } finally {
        initializePromise = null;
      }
    }
    async function ensureThread() {
      if (threadId) return threadId;
      await initialize();
      const mcpSpec = await getMcpSpec();
      toolMeta = getToolMeta ? await getToolMeta() : { allowedTools: [], annotations: {} };
      const spawnEnv = currentEnv();
      const result = await rpc.request("thread/start", {
        ephemeral: true,
        cwd: defaultCwd(spawnEnv),
        model: getModel(),
        approvalPolicy: APPROVAL_POLICY,
        approvalsReviewer: "user",
        sandboxPolicy: SANDBOX_POLICY,
        config: {
          mcp_servers: {
            ae: {
              command: mcpSpec.command,
              args: mcpSpec.args || [],
              env: Object.assign({}, mcpSpec.env || {}, {
                AE_MCP_BACKEND: "ae-mcp",
                ...expertGuidanceEnv(getExpertGuidance())
              })
            }
          }
        }
      });
      threadId = threadIdFromResult(result);
      return threadId;
    }
    function turnParams(text) {
      const params = {
        threadId,
        input: [{ type: "text", text }],
        model: getModel(),
        effort: getEffort ? getEffort() : void 0,
        approvalPolicy: APPROVAL_POLICY,
        sandboxPolicy: SANDBOX_POLICY
      };
      if (getFast && getFast()) params.serviceTier = "priority";
      if (params.effort === void 0 || params.effort === null) delete params.effort;
      return params;
    }
    async function sendUser(text) {
      if (activeRun) return activeRun;
      activeAssistantText = "";
      activeRun = new Promise((resolve) => {
        activeResolve = resolve;
      });
      try {
        await ensureThread();
        const userText = String(text || "");
        transcript.push({ role: "user", text: userText });
        let turnText = userText;
        if (!preambleSent) {
          const instr = (getServerInstructions() || "").trim();
          if (instr) turnText = instr + "\n\n---\n\n" + userText;
          preambleSent = true;
        }
        rpc.request("turn/start", turnParams(turnText), 18e4).catch((e) => {
          const message = e && e.message ? e.message : "Failed to start Codex turn.";
          emit({ type: "error", kind: /model/i.test(message) ? "model" : "mcp", message });
          finishActive();
        });
      } catch (e) {
        emit({ type: "error", kind: "mcp", message: e && e.message ? e.message : "Failed to start Codex turn." });
        finishActive();
      }
      return activeRun;
    }
    function approve(toolUseId, decision) {
      const id = String(toolUseId);
      const approval = pendingApprovals.get(id);
      if (!approval || !rpc) return;
      pendingApprovals.delete(id);
      const action = decision === "deny" ? "decline" : "accept";
      if (action === "accept" && decision === "allow-session") sessionAllowedTools.add(approval.name);
      rpc.respond(approval.rpcId, { action, content: {} });
      if (action === "decline") emit({ type: "tool-denied", toolUseId: id });
      else emit({ type: "tool-allowed", toolUseId: id });
    }
    function stop() {
      if (rpc && threadId && currentTurnId) {
        rpc.fireRequest("turn/interrupt", { threadId, turnId: currentTurnId });
      }
      drainApprovals();
      if (activeRun) {
        emit({ type: "error", kind: "aborted", message: "Turn aborted." });
        finishActive();
      }
    }
    function reset() {
      stopping = true;
      drainApprovals();
      if (rpc) rpc.close(new Error("Codex backend reset"));
      if (proc) {
        try {
          proc.kill();
        } catch (e) {
        }
      }
      proc = null;
      rpc = null;
      startPromise = null;
      initializePromise = null;
      initialized = false;
      threadId = null;
      preambleSent = false;
      currentTurnId = null;
      transcript = [];
      pendingApprovals.clear();
      sessionAllowedTools.clear();
      toolMeta = { allowedTools: [], annotations: {} };
      finishActive();
      stderrTail = "";
      stopping = false;
    }
    const PROBE_INITIALIZE_TIMEOUT_MS = 1e4;
    const PROBE_ACCOUNT_READ_TIMEOUT_MS = 1e4;
    const PROBE_MODEL_LIST_TIMEOUT_MS = 4e3;
    function withTimeout(promise, ms, label) {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("probe timeout: " + label), { probeTimeout: label })), ms);
      });
      return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    }
    async function probeAccount() {
      const spawnEnv = ensureUserEnv(currentEnv(), { homedir: getHomedir() });
      let cliInfo = { ok: false, cliPath: "", version: "" };
      try {
        let execFileImpl = null;
        try {
          execFileImpl = getCepRequire5()("child_process").execFile;
        } catch (e) {
        }
        cliInfo = await resolveCli({ env: spawnEnv, execFileImpl });
        lastCliInfo = cliInfo;
      } catch (e) {
      }
      const diag = { cliPath: cliInfo.cliPath || "", cliVersion: cliInfo.version || "" };
      let probedProc = null;
      try {
        await withTimeout(initialize(), PROBE_INITIALIZE_TIMEOUT_MS, "initialize");
        probedProc = proc;
        const accountResult = await withTimeout(rpc.request("account/read", {}), PROBE_ACCOUNT_READ_TIMEOUT_MS, "account/read");
        let models = null;
        try {
          const listed = await withTimeout(rpc.request("model/list", {}), PROBE_MODEL_LIST_TIMEOUT_MS, "model/list");
          models = Array.isArray(listed) ? listed : listed && listed.models;
        } catch (e) {
          models = null;
        }
        const account = accountResult && accountResult.account;
        if (!account) return { loggedIn: false, runtimeOk: true, detail: accountResult && accountResult.requiresOpenaiAuth ? "OpenAI auth required" : void 0, models, ...diag };
        return {
          loggedIn: true,
          runtimeOk: true,
          email: account.email,
          planType: account.planType,
          models,
          ...diag
        };
      } catch (e) {
        const detail = [e && e.message ? e.message : String(e), cliInfo.ok ? "" : cliInfo.detail].filter(Boolean).join(" | ");
        if (e && e.probeTimeout) {
          if (probedProc) {
            try {
              probedProc.kill();
            } catch (killErr) {
            }
          }
          reset();
          return { loggedIn: false, runtimeOk: false, detail: "probe timeout: " + e.probeTimeout + (detail ? " | " + detail : ""), ...diag };
        }
        return { loggedIn: false, runtimeOk: false, detail, ...diag };
      }
    }
    return {
      sendUser,
      approve,
      stop,
      reset,
      getMessages: () => clone4(transcript),
      probeAccount
    };
  }

  // src/cep/openCodeBackend.js
  var MCP_TIMEOUT_MS = 12e4;
  var READY_TIMEOUT_MS2 = 3e4;
  var READY_POLL_MS = 250;
  var DEFAULT_PROVIDER_ID = "opencode";
  var DEFAULT_MODEL_ID = "north-mini-code-free";
  function getCepRequire6() {
    if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) {
      return globalThis.window.cep_node.require;
    }
    if (globalThis.window && globalThis.window.require) return globalThis.window.require;
    if (globalThis.require) return globalThis.require;
    throw new Error("CEP Node require is unavailable");
  }
  function getCepEnv6() {
    return globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.process && globalThis.window.cep_node.process.env || {};
  }
  function defaultFetch() {
    if (globalThis.window && globalThis.window.fetch) return globalThis.window.fetch.bind(globalThis.window);
    if (globalThis.fetch) return globalThis.fetch.bind(globalThis);
    throw new Error("fetch is unavailable");
  }
  function defaultFs3() {
    return getCepRequire6()("fs");
  }
  function defaultOs() {
    return getCepRequire6()("os");
  }
  function defaultPath() {
    return getCepRequire6()("path");
  }
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  function appendTail5(tail, chunk) {
    const next = tail + String(chunk || "");
    return next.length > 4096 ? next.slice(next.length - 4096) : next;
  }
  function decodeChunk(value) {
    if (typeof value === "string") return value;
    return new TextDecoder().decode(value);
  }
  function randomTempName() {
    return "ae-opencode-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  }
  async function defaultGetPort() {
    const net = getCepRequire6()("net");
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = address && typeof address === "object" ? address.port : 0;
        server.close(() => resolve(port));
      });
    });
  }
  function asCommandArray(mcpSpec) {
    const command = mcpSpec && mcpSpec.command ? String(mcpSpec.command) : "ae-mcp";
    const args = mcpSpec && Array.isArray(mcpSpec.args) ? mcpSpec.args.map(String) : [];
    return [command].concat(args);
  }
  function prefixedToolName2(raw) {
    const text = String(raw || "");
    if (!text) return "";
    if (text.startsWith("mcp__")) return text;
    return "mcp__ae__" + text.replace(/^ae_/, "");
  }
  function eventType(evt) {
    return evt && (evt.type || evt.event || evt.kind || evt.name);
  }
  function eventToolId(evt) {
    return String(evt && (evt.callID || evt.callId || evt.toolCallID || evt.toolCallId || evt.id || evt.call && evt.call.id) || "");
  }
  function eventPermissionId(evt) {
    return String(evt && (evt.permissionID || evt.permissionId || evt.id || evt.requestID || evt.requestId) || eventToolId(evt));
  }
  function eventToolName(evt) {
    return prefixedToolName2(evt && (evt.tool || evt.toolName || evt.name || evt.call && (evt.call.tool || evt.call.name) || evt.permission && (evt.permission.tool || evt.permission.name)));
  }
  function eventInput(evt) {
    if (!evt || typeof evt !== "object") return {};
    if (evt.input !== void 0) return evt.input;
    if (evt.arguments !== void 0) return evt.arguments;
    if (evt.args !== void 0) return evt.args;
    if (evt.call && evt.call.input !== void 0) return evt.call.input;
    if (evt.permission && evt.permission.input !== void 0) return evt.permission.input;
    return {};
  }
  function eventOutputText(evt) {
    const value = evt && (evt.output !== void 0 ? evt.output : evt.result !== void 0 ? evt.result : evt.error);
    if (value === void 0 || value === null) return "";
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch (e) {
      return String(value);
    }
  }
  function parseModel(value) {
    const raw = String(value || DEFAULT_MODEL_ID);
    if (raw.includes("/")) {
      const [providerID, ...rest] = raw.split("/");
      return { id: rest.join("/") || DEFAULT_MODEL_ID, providerID: providerID || DEFAULT_PROVIDER_ID };
    }
    if (raw.includes(":")) {
      const [providerID, ...rest] = raw.split(":");
      return { id: rest.join(":") || DEFAULT_MODEL_ID, providerID: providerID || DEFAULT_PROVIDER_ID };
    }
    return { id: raw, providerID: DEFAULT_PROVIDER_ID };
  }
  function permissionRuleset(mode) {
    if (mode === "none") return { type: "allow" };
    return { type: "ask" };
  }
  function permissionReplyBody(decision) {
    if (decision === "deny") return { action: "deny", remember: false };
    return { action: "allow", remember: decision === "allow-session" };
  }
  function permissionReplyPath(sessionId, permissionId) {
    return "/session/" + encodeURIComponent(sessionId) + "/permission/" + encodeURIComponent(permissionId);
  }
  function createOpenCodeBackend({
    spawnImpl,
    fetchImpl,
    getPort = defaultGetPort,
    fsImpl,
    osImpl,
    pathImpl,
    tempDirName = randomTempName,
    getModel,
    getPermissionMode,
    getMcpSpec,
    getToolMeta,
    getExpertGuidance = () => true,
    onEvent,
    env
  } = {}) {
    let proc = null;
    let port = null;
    let baseUrl = "";
    let configHome = "";
    let sessionId = null;
    let serverPromise = null;
    let sessionPromise = null;
    let sseStarted = false;
    let sseClosed = false;
    let stopping = false;
    let stderrTail = "";
    let activeRun = null;
    let activeResolve = null;
    let activeAssistantText = "";
    let turnStarted = false;
    let toolMeta = { annotations: {} };
    const pendingApprovals = /* @__PURE__ */ new Map();
    const sessionAllowedTools = /* @__PURE__ */ new Set();
    const startedTools = /* @__PURE__ */ new Set();
    const transcript = [];
    function emit(evt) {
      if (onEvent) onEvent(evt);
    }
    function fetcher() {
      return fetchImpl || defaultFetch();
    }
    function currentEnv() {
      return Object.assign({}, getCepEnv6(), env || {});
    }
    function finishActive() {
      if (!activeResolve) {
        activeRun = null;
        activeAssistantText = "";
        turnStarted = false;
        startedTools.clear();
        return;
      }
      const resolve = activeResolve;
      activeResolve = null;
      activeRun = null;
      activeAssistantText = "";
      turnStarted = false;
      startedTools.clear();
      resolve();
    }
    async function request(path, options = {}) {
      const response = await fetcher()(baseUrl + path, options);
      if (!response || !response.ok) {
        const text = response && response.text ? await response.text().catch(() => "") : "";
        throw new Error("OpenCode HTTP " + (response ? response.status : "error") + (text ? ": " + text : ""));
      }
      return response;
    }
    async function requestJson(path, options = {}) {
      const response = await request(path, options);
      return response.json ? response.json() : {};
    }
    async function postJson(path, body) {
      return requestJson(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {})
      });
    }
    async function waitForMcp() {
      const deadline = Date.now() + READY_TIMEOUT_MS2;
      let lastError = null;
      while (Date.now() < deadline) {
        try {
          const status = await requestJson("/mcp");
          if (status && status.ae && status.ae.status === "connected") return true;
        } catch (e) {
          lastError = e;
        }
        await sleep(READY_POLL_MS);
      }
      throw lastError || new Error("OpenCode MCP server did not become ready.");
    }
    function writeConfig(mcpSpec) {
      const fs = fsImpl || defaultFs3();
      const os = osImpl || defaultOs();
      const path = pathImpl || defaultPath();
      configHome = path.join(os.tmpdir(), tempDirName());
      const configDir = path.join(configHome, "opencode");
      fs.mkdirSync(configDir, { recursive: true });
      const config = {
        $schema: "https://opencode.ai/config.json",
        mcp: {
          ae: {
            type: "local",
            command: asCommandArray(mcpSpec),
            enabled: true,
            timeout: MCP_TIMEOUT_MS,
            environment: Object.assign({}, mcpSpec && mcpSpec.env || {}, {
              AE_MCP_BACKEND: "ae-mcp",
              ...expertGuidanceEnv(getExpertGuidance())
            })
          }
        }
      };
      fs.writeFileSync(path.join(configDir, "opencode.json"), JSON.stringify(config, null, 2));
    }
    function handleExit(code, signal) {
      const wasStopping = stopping;
      proc = null;
      serverPromise = null;
      sessionPromise = null;
      sessionId = null;
      sseClosed = true;
      sseStarted = false;
      if (wasStopping) return;
      if (activeRun) {
        const detail = stderrTail ? String(code) + (signal ? " " + signal : "") + " " + stderrTail : String(code) + (signal ? " " + signal : "");
        emit({ type: "error", kind: "mcp", message: "opencode serve exited: " + detail });
        finishActive();
      }
    }
    function handleError(error) {
      proc = null;
      serverPromise = null;
      sessionPromise = null;
      sessionId = null;
      sseClosed = true;
      sseStarted = false;
      if (activeRun) {
        emit({ type: "error", kind: "mcp", message: error && error.message ? error.message : "opencode serve error" });
        finishActive();
      }
    }
    async function startServer() {
      if (proc && baseUrl) return true;
      if (serverPromise) return serverPromise;
      serverPromise = (async () => {
        const mcpSpec = getMcpSpec ? await getMcpSpec() : { command: "ae-mcp", args: [] };
        writeConfig(mcpSpec);
        port = await getPort();
        baseUrl = "http://127.0.0.1:" + port;
        const spawn = spawnImpl || getCepRequire6()("child_process").spawn;
        const spawnEnv = Object.assign({}, currentEnv(), { XDG_CONFIG_HOME: configHome });
        stderrTail = "";
        stopping = false;
        sseClosed = false;
        proc = spawn("opencode", ["serve", "--port", String(port)], {
          stdio: "pipe",
          windowsHide: true,
          shell: true,
          env: spawnEnv
        });
        if (proc.stderr && proc.stderr.on) proc.stderr.on("data", (chunk) => {
          stderrTail = appendTail5(stderrTail, chunk);
        });
        if (proc.on) {
          proc.on("exit", (code, signal) => handleExit(code, signal));
          proc.on("error", (error) => handleError(error));
        }
        await waitForMcp();
        startSse();
        return true;
      })();
      try {
        return await serverPromise;
      } finally {
        serverPromise = null;
      }
    }
    async function readSseBody(body, parser) {
      if (!body) return;
      if (body.getReader) {
        const reader = body.getReader();
        while (!sseClosed) {
          const next = await reader.read();
          if (!next || next.done) break;
          parser.feed(decodeChunk(next.value));
        }
        return;
      }
      if (body[Symbol.asyncIterator]) {
        for await (const chunk of body) {
          if (sseClosed) break;
          parser.feed(decodeChunk(chunk));
        }
      }
    }
    function startSse() {
      if (sseStarted) return;
      sseStarted = true;
      const parser = createSseParser(({ data }) => handleOpenCodeEvent(data));
      request("/event").then((response) => readSseBody(response.body, parser)).catch((e) => {
        if (!sseClosed && activeRun) {
          emit({ type: "error", kind: "mcp", message: e && e.message ? e.message : "OpenCode event stream failed." });
          finishActive();
        }
      });
    }
    async function ensureSession() {
      if (sessionId) return sessionId;
      if (sessionPromise) return sessionPromise;
      sessionPromise = (async () => {
        await startServer();
        toolMeta = getToolMeta ? await getToolMeta() : { annotations: {} };
        const result = await postJson("/session", {
          title: "After Effects MCP",
          model: parseModel(getModel ? getModel() : DEFAULT_MODEL_ID),
          permission: permissionRuleset(getPermissionMode ? getPermissionMode() : "manual")
        });
        sessionId = String(result && (result.id || result.sessionID || result.sessionId) || "");
        if (!sessionId) throw new Error("OpenCode did not return a session id.");
        return sessionId;
      })();
      try {
        return await sessionPromise;
      } finally {
        sessionPromise = null;
      }
    }
    function annFor(name) {
      const annotations = toolMeta && toolMeta.annotations || {};
      return annotations[name] || {};
    }
    async function replyPermission(permissionId, decision) {
      if (!sessionId || !permissionId) return;
      await postJson(permissionReplyPath(sessionId, permissionId), permissionReplyBody(decision));
    }
    async function autoReply(permissionId, decision) {
      try {
        await replyPermission(permissionId, decision);
      } catch (e) {
        emit({ type: "error", kind: "mcp", message: e && e.message ? e.message : "Failed to reply to OpenCode permission request." });
      }
    }
    function handlePermission(evt) {
      const permissionId = eventPermissionId(evt);
      const name = eventToolName(evt);
      const input = eventInput(evt) || {};
      const ann = annFor(name);
      const tier = getPermissionMode ? getPermissionMode() : "manual";
      if (sessionAllowedTools.has(name) || ann.readOnly || tier === "none" || tier === "auto" && !ann.destructive) {
        autoReply(permissionId, "allow");
        return;
      }
      if (tier === "readonly") {
        autoReply(permissionId, "deny");
        emit({ type: "tool-denied", toolUseId: permissionId });
        return;
      }
      pendingApprovals.set(permissionId, { name, input });
      emit({
        type: "approval-required",
        toolUseId: permissionId,
        name,
        input,
        risk: ann.destructive ? "destructive" : "write"
      });
    }
    function handleToolPart(part) {
      const toolUseId = String(part.callID || part.id || "");
      if (!toolUseId) return;
      const name = prefixedToolName2(part.tool || part.name);
      const state = part.state || {};
      const status = state.status;
      if (status === "completed" || status === "error") {
        const ms = state.time && Number.isFinite(state.time.start) && Number.isFinite(state.time.end) ? state.time.end - state.time.start : void 0;
        emit({
          type: "tool-result",
          toolUseId,
          name,
          ok: status === "completed",
          text: typeof state.output === "string" ? state.output : eventOutputText(state),
          durationMs: ms
        });
        return;
      }
      if (startedTools.has(toolUseId)) return;
      startedTools.add(toolUseId);
      emit({ type: "tool-start", toolUseId, name, input: state.input || {} });
    }
    function handleOpenCodeEvent(evt) {
      const type = eventType(evt);
      if (!type) return;
      const p = evt && evt.properties || {};
      if (sessionId && p.sessionID && p.sessionID !== sessionId) return;
      if (type === "session.status") {
        const st = p.status && p.status.type || "";
        if (st === "busy") {
          if (!turnStarted) {
            turnStarted = true;
            emit({ type: "turn-start" });
          }
        } else if (st === "idle") {
          drainApprovals();
          emit({ type: "turn-end", stopReason: "end_turn" });
          transcript.push({ role: "assistant", text: activeAssistantText });
          finishActive();
        }
        return;
      }
      if (type === "message.part.delta") {
        if (p.field === "text") {
          emit({ type: "thinking", active: false });
          const text = p.delta;
          if (text) {
            activeAssistantText += String(text);
            emit({ type: "text-delta", text: String(text) });
          }
        } else if (p.field === "reasoning") {
          emit({ type: "thinking", active: true });
        }
        return;
      }
      if (type === "message.part.updated") {
        const part = p.part || {};
        if (part.type === "tool") handleToolPart(part);
        else if (part.type === "reasoning") emit({ type: "thinking", active: true });
        return;
      }
      if (type === "session.error") {
        const error = p.error || p;
        emit({ type: "error", kind: error.kind || "mcp", message: error.message || String(error || "OpenCode session error") });
        finishActive();
        return;
      }
      if (/permission/i.test(String(type)) && /ask/i.test(String(type))) {
        handlePermission({ ...p, properties: p });
      }
    }
    function drainApprovals() {
      const replies = [];
      for (const [permissionId] of Array.from(pendingApprovals.entries())) {
        pendingApprovals.delete(permissionId);
        replies.push(autoReply(permissionId, "deny"));
        emit({ type: "tool-denied", toolUseId: permissionId });
      }
      return Promise.allSettled(replies);
    }
    async function sendUser(text) {
      if (activeRun) return activeRun;
      activeAssistantText = "";
      activeRun = new Promise((resolve) => {
        activeResolve = resolve;
      });
      try {
        const id = await ensureSession();
        const userText = String(text || "");
        transcript.push({ role: "user", text: userText });
        await postJson("/session/" + encodeURIComponent(id) + "/message", {
          parts: [{ type: "text", text: userText }]
        });
      } catch (e) {
        emit({ type: "error", kind: "mcp", message: e && e.message ? e.message : "Failed to start OpenCode turn." });
        finishActive();
      }
      return activeRun;
    }
    async function approve(toolUseId, decision) {
      const id = String(toolUseId);
      const approval = pendingApprovals.get(id);
      if (!approval) return;
      pendingApprovals.delete(id);
      if (decision === "allow-session") sessionAllowedTools.add(approval.name);
      await replyPermission(id, decision);
      if (decision === "deny") emit({ type: "tool-denied", toolUseId: id });
      else emit({ type: "tool-allowed", toolUseId: id });
    }
    async function stop() {
      if (sessionId) {
        await postJson("/session/" + encodeURIComponent(sessionId) + "/interrupt", {}).catch(() => {
        });
      }
      await drainApprovals();
      if (activeRun) {
        emit({ type: "error", kind: "aborted", message: "Turn aborted." });
        finishActive();
      }
    }
    function reset() {
      stopping = true;
      sseClosed = true;
      sseStarted = false;
      pendingApprovals.clear();
      sessionAllowedTools.clear();
      sessionId = null;
      sessionPromise = null;
      activeResolve = null;
      activeRun = null;
      activeAssistantText = "";
      turnStarted = false;
      startedTools.clear();
      transcript.length = 0;
      if (proc && proc.kill) proc.kill();
      proc = null;
      serverPromise = null;
      try {
        if (configHome) {
          const fs = fsImpl || defaultFs3();
          fs.rmSync(configHome, { recursive: true, force: true });
        }
      } catch (e) {
      }
    }
    async function probeAccount() {
      try {
        await startServer();
        const providers = await requestJson("/config/providers").catch(() => requestJson("/provider"));
        return { loggedIn: true, models: providers };
      } catch (e) {
        return { loggedIn: false, detail: e && e.message ? e.message : String(e) };
      }
    }
    function getMessages() {
      return transcript.slice();
    }
    return { sendUser, approve, stop, reset, getMessages, probeAccount };
  }

  // src/cep/providerStore.js
  var PROTOCOLS = /* @__PURE__ */ new Set(["anthropic", "openai-compatible"]);
  var FILE_NAME = "providers.json";
  function cepRequire3() {
    if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) return globalThis.window.cep_node.require;
    if (globalThis.window && globalThis.window.require) return globalThis.window.require;
    if (globalThis.require) return globalThis.require;
    return null;
  }
  function defaultDeps2() {
    const req = cepRequire3();
    if (!req) throw new Error("CEP Node require is unavailable");
    return {
      fs: req("fs"),
      os: req("os"),
      path: req("path"),
      pid: req("process") && req("process").pid
    };
  }
  function normalizeProviderEntry(input = {}) {
    const id = String(input.id || "").trim();
    if (!id) throw new Error("Provider entry needs an id");
    const protocol = String(input.protocol || "openai-compatible");
    if (!PROTOCOLS.has(protocol)) throw new Error("Unsupported provider protocol: " + protocol);
    return {
      id,
      name: String(input.name || "").trim() || id,
      protocol,
      baseUrl: String(input.baseUrl || "").trim().replace(/\/+$/, ""),
      apiKey: String(input.apiKey || "").trim(),
      probedModels: Array.isArray(input.probedModels) ? input.probedModels : [],
      probedAt: Number(input.probedAt) || 0
    };
  }
  function createProviderStore(deps = defaultDeps2()) {
    const { fs, os, path } = deps;
    function dir() {
      return path.join(os.homedir(), ".ae-mcp");
    }
    function filePath() {
      return path.join(dir(), FILE_NAME);
    }
    function readState() {
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath(), "utf8"));
        if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.providers)) {
          return { version: 1, migratedLegacy: false, providers: [] };
        }
        return { version: 1, migratedLegacy: parsed.migratedLegacy === true, providers: parsed.providers };
      } catch (e) {
        return { version: 1, migratedLegacy: false, providers: [] };
      }
    }
    function writeState(state) {
      const d = dir();
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
      const pid = deps.pid || 0;
      const tmp = path.join(d, FILE_NAME + "." + pid + "." + Date.now() + ".tmp");
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
      try {
        fs.chmodSync(tmp, 384);
      } catch (e) {
      }
      fs.renameSync(tmp, filePath());
      return state;
    }
    function list() {
      return readState().providers.map((p) => normalizeProviderEntry(p));
    }
    function get(id) {
      return list().find((p) => p.id === String(id || "").trim()) || null;
    }
    function upsert(entry) {
      const next = normalizeProviderEntry(entry);
      const state = readState();
      const idx = state.providers.findIndex((p) => p && p.id === next.id);
      if (idx === -1) state.providers.push(next);
      else state.providers[idx] = next;
      writeState(state);
      return next;
    }
    function remove(id) {
      const state = readState();
      state.providers = state.providers.filter((p) => p && p.id !== String(id || "").trim());
      writeState(state);
    }
    function migrateLegacy({ readKey, readPref: readPref2, markDone = true } = {}) {
      const state = readState();
      if (state.migratedLegacy) return { migrated: [] };
      const migrated = [];
      const anthropicKey = readKey ? String(readKey("anthropic") || "") : "";
      const anthropicBase = readPref2 ? String(readPref2("ae_mcp_anthropic_base_url") || "") : "";
      if (anthropicKey || anthropicBase) {
        migrated.push(upsert({
          id: "legacy-anthropic",
          name: "Claude API (migrated)",
          protocol: "anthropic",
          baseUrl: anthropicBase || "https://api.anthropic.com",
          apiKey: anthropicKey
        }));
      }
      const codexKey = readKey ? String(readKey("codex") || "") : "";
      const codexBase = readPref2 ? String(readPref2("ae_mcp_codex_base_url") || "") : "";
      if (codexKey || codexBase) {
        migrated.push(upsert({
          id: "legacy-codex",
          name: "Codex custom (migrated)",
          protocol: "openai-compatible",
          baseUrl: codexBase,
          apiKey: codexKey
        }));
      }
      if (markDone) {
        const after = readState();
        after.migratedLegacy = true;
        writeState(after);
      }
      return { migrated };
    }
    return { filePath, list, get, upsert, remove, migrateLegacy };
  }

  // src/components/settings/ProviderManagerSection.jsx
  var import_react37 = __toESM(require_react(), 1);

  // src/lib/providerManagerState.js
  function emptyDraft() {
    return { id: "", name: "", protocol: "openai-compatible", baseUrl: "", apiKey: "" };
  }
  function draftFromEntry(entry) {
    return {
      id: entry.id,
      name: entry.name,
      protocol: entry.protocol,
      baseUrl: entry.baseUrl,
      apiKey: entry.apiKey
    };
  }
  function validateDraft(draft) {
    if (!String(draft.name || "").trim() && !String(draft.id || "").trim()) return "\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A / name is required";
    if (!/^https?:\/\//i.test(String(draft.baseUrl || "").trim())) return "Base URL \u5FC5\u987B\u4EE5 http(s):// \u5F00\u5934 / must start with http(s)://";
    return "";
  }
  function draftToEntry(draft) {
    const name = String(draft.name || draft.id || "").trim();
    const id = String(draft.id || "").trim() || name.replace(/[^A-Za-z0-9_-]+/g, "-").toLowerCase();
    return { id, name, protocol: draft.protocol, baseUrl: draft.baseUrl, apiKey: draft.apiKey };
  }

  // src/components/settings/ProviderManagerSection.jsx
  var import_jsx_runtime35 = __toESM(require_jsx_runtime(), 1);
  var L2 = {
    zh: { title: "Provider \u7BA1\u7406", add: "\u65B0\u589E", edit: "\u7F16\u8F91", del: "\u5220\u9664", probe: "\u63A2\u6D4B\u6A21\u578B", probing: "\u63A2\u6D4B\u4E2D\u2026", save: "\u4FDD\u5B58", cancel: "\u53D6\u6D88", name: "\u540D\u79F0", protocol: "\u534F\u8BAE", baseUrl: "Base URL", apiKey: "API Key", keyCap: "\u4EC5\u4FDD\u5B58\u5728\u672C\u673A ~/.ae-mcp/providers.json", models: (n) => `${n} \u4E2A\u6A21\u578B`, probeFailed: "\u63A2\u6D4B\u5931\u8D25\uFF08\u53EF\u624B\u586B\u6A21\u578B ID \u7EE7\u7EED\u4F7F\u7528\uFF09\uFF1A", importCc: "\u4ECE cc-switch \u5BFC\u5165" },
    en: { title: "Provider manager", add: "Add", edit: "Edit", del: "Delete", probe: "Probe models", probing: "Probing\u2026", save: "Save", cancel: "Cancel", name: "Name", protocol: "Protocol", baseUrl: "Base URL", apiKey: "API Key", keyCap: "Stored locally in ~/.ae-mcp/providers.json", models: (n) => `${n} models`, probeFailed: "Probe failed (manual model id still works): ", importCc: "Import from cc-switch" }
  };
  function ProviderManagerSection({ lang = "zh", providers = [], onUpsert, onRemove, onProbe, probing = "", probeErrors = {}, ccSwitch = null, onImportCcSwitch }) {
    const t = L2[lang] || L2.zh;
    const [draft, setDraft] = import_react37.default.useState(null);
    const [error, setError] = import_react37.default.useState("");
    const save = () => {
      const message = validateDraft(draft);
      if (message) {
        setError(message);
        return;
      }
      onUpsert(draftToEntry(draft));
      setDraft(null);
      setError("");
    };
    return /* @__PURE__ */ (0, import_jsx_runtime35.jsxs)("details", { style: { border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-md)", background: "var(--bg-well)", padding: "7px 8px" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime35.jsxs)("summary", { style: { cursor: "pointer", listStyle: "none", display: "flex", alignItems: "center", gap: 8 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime35.jsx)("span", { style: { flex: 1, font: "500 12px/1.35 var(--font-ui)", color: "var(--text-primary)" }, children: t.title }),
        /* @__PURE__ */ (0, import_jsx_runtime35.jsx)(Button, { variant: "secondary", size: "sm", icon: "plus", onClick: (e) => {
          e.preventDefault();
          setDraft(emptyDraft());
        }, children: t.add })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime35.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }, children: [
        ccSwitch && onImportCcSwitch ? /* @__PURE__ */ (0, import_jsx_runtime35.jsx)(Button, { variant: "secondary", size: "sm", icon: "download", onClick: onImportCcSwitch, children: t.importCc }) : null,
        providers.map((p) => /* @__PURE__ */ (0, import_jsx_runtime35.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 4, padding: "6px 8px", border: "1px solid var(--border-default)", borderRadius: "var(--radius-sm)", background: "var(--bg-panel)" }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime35.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 8 }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime35.jsx)("span", { style: { flex: 1, minWidth: 0, font: "500 12px/1.35 var(--font-ui)", color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: p.name }),
            /* @__PURE__ */ (0, import_jsx_runtime35.jsx)(Badge, { status: "neutral", children: p.protocol }),
            p.probedModels.length ? /* @__PURE__ */ (0, import_jsx_runtime35.jsx)(Badge, { status: "ok", children: t.models(p.probedModels.length) }) : null,
            /* @__PURE__ */ (0, import_jsx_runtime35.jsx)(Button, { variant: "ghost", size: "sm", disabled: probing === p.id, onClick: () => onProbe(p), children: probing === p.id ? t.probing : t.probe }),
            /* @__PURE__ */ (0, import_jsx_runtime35.jsx)(Button, { variant: "ghost", size: "sm", onClick: () => {
              setDraft(draftFromEntry(p));
              setError("");
            }, children: t.edit }),
            /* @__PURE__ */ (0, import_jsx_runtime35.jsx)(Button, { variant: "ghost", size: "sm", onClick: () => onRemove(p.id), children: t.del })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime35.jsx)("div", { style: { font: "400 10px/1.35 var(--font-mono)", color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: p.baseUrl }),
          probeErrors[p.id] ? /* @__PURE__ */ (0, import_jsx_runtime35.jsxs)("div", { style: { font: "400 10px/1.4 var(--font-ui)", color: "var(--warn)" }, children: [
            t.probeFailed,
            probeErrors[p.id]
          ] }) : null
        ] }, p.id)),
        draft ? /* @__PURE__ */ (0, import_jsx_runtime35.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 6, padding: "8px", border: "1px solid var(--border-strong)", borderRadius: "var(--radius-sm)", background: "var(--bg-panel)" }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime35.jsx)(Field, { label: t.name, children: /* @__PURE__ */ (0, import_jsx_runtime35.jsx)(Input, { value: draft.name, onChange: (v) => setDraft({ ...draft, name: v }) }) }),
          /* @__PURE__ */ (0, import_jsx_runtime35.jsx)(Field, { label: t.protocol, children: /* @__PURE__ */ (0, import_jsx_runtime35.jsx)(Select, { value: draft.protocol, onChange: (v) => setDraft({ ...draft, protocol: v }), options: [
            { value: "openai-compatible", label: "OpenAI compatible" },
            { value: "anthropic", label: "Anthropic" }
          ] }) }),
          /* @__PURE__ */ (0, import_jsx_runtime35.jsx)(Field, { label: t.baseUrl, children: /* @__PURE__ */ (0, import_jsx_runtime35.jsx)(Input, { mono: true, value: draft.baseUrl, onChange: (v) => setDraft({ ...draft, baseUrl: v }), placeholder: "https://token.mediastorm.studio/v1" }) }),
          /* @__PURE__ */ (0, import_jsx_runtime35.jsx)(Field, { label: t.apiKey, caption: t.keyCap, children: /* @__PURE__ */ (0, import_jsx_runtime35.jsx)(Input, { secret: true, value: draft.apiKey, onChange: (v) => setDraft({ ...draft, apiKey: v }) }) }),
          error ? /* @__PURE__ */ (0, import_jsx_runtime35.jsx)("div", { style: { font: "400 10px/1.4 var(--font-ui)", color: "var(--warn)" }, children: error }) : null,
          /* @__PURE__ */ (0, import_jsx_runtime35.jsxs)("div", { style: { display: "flex", gap: 6, justifyContent: "flex-end" }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime35.jsx)(Button, { variant: "ghost", size: "sm", onClick: () => {
              setDraft(null);
              setError("");
            }, children: t.cancel }),
            /* @__PURE__ */ (0, import_jsx_runtime35.jsx)(Button, { variant: "primary", size: "sm", onClick: save, children: t.save })
          ] })
        ] }) : null
      ] })
    ] });
  }

  // src/cep/modelProbe.js
  function getCepRequire7() {
    if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) {
      return globalThis.window.cep_node.require;
    }
    if (globalThis.window && globalThis.window.require) return globalThis.window.require;
    if (globalThis.require) return globalThis.require;
    throw new Error("CEP Node require is unavailable");
  }
  function probeHeaders(protocol, apiKey) {
    if (protocol === "anthropic") {
      return { "x-api-key": String(apiKey || ""), "anthropic-version": "2023-06-01" };
    }
    return { Authorization: "Bearer " + String(apiKey || "") };
  }
  function parseModelsList(json) {
    const list = Array.isArray(json) ? json : json && Array.isArray(json.data) ? json.data : json && Array.isArray(json.models) ? json.models : [];
    return list.map((m) => {
      const id = m && (m.id || m.model || m.name);
      if (!id) return null;
      return { id: String(id), label: String(m.display_name || m.displayName || id) };
    }).filter(Boolean);
  }
  function probeProviderModels({ baseUrl, apiKey, protocol = "openai-compatible", httpsImpl, timeoutMs = 8e3 } = {}) {
    let endpoint;
    try {
      const root = String(baseUrl || "").replace(/\/+$/, "").replace(/\/v1$/, "");
      endpoint = new URL(root + "/v1/models");
    } catch (e) {
      return Promise.resolve({ ok: false, status: 0, models: [], detail: "Invalid base URL" });
    }
    let https;
    try {
      https = httpsImpl || getCepRequire7()(endpoint.protocol === "http:" ? "http" : "https");
    } catch (e) {
      return Promise.resolve({ ok: false, status: 0, models: [], detail: e.message });
    }
    return new Promise((resolve) => {
      const req = https.request({
        hostname: endpoint.hostname,
        port: endpoint.port || void 0,
        protocol: endpoint.protocol,
        path: endpoint.pathname + endpoint.search,
        method: "GET",
        headers: probeHeaders(protocol, apiKey)
      }, (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            resolve({ ok: false, status: res.statusCode, models: [], detail: "HTTP " + res.statusCode + " from provider" });
            return;
          }
          try {
            const models = parseModelsList(JSON.parse(body));
            resolve(models.length ? { ok: true, status: 200, models, detail: "" } : { ok: false, status: 200, models: [], detail: "Empty model list" });
          } catch (e) {
            resolve({ ok: false, status: 200, models: [], detail: "Response was not valid JSON" });
          }
        });
      });
      req.on("error", (err) => resolve({ ok: false, status: 0, models: [], detail: err && err.message ? err.message : "request failed" }));
      if (req.setTimeout) req.setTimeout(timeoutMs, () => {
        try {
          req.destroy();
        } catch (e) {
        }
        resolve({ ok: false, status: 0, models: [], detail: "timeout" });
      });
      req.end();
    });
  }

  // src/cep/ccSwitch.js
  var CONFIG_NAMES = ["config.json", "providers.json"];
  function getCepRequire8() {
    if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) {
      return globalThis.window.cep_node.require;
    }
    if (globalThis.window && globalThis.window.require) return globalThis.window.require;
    if (globalThis.require) return globalThis.require;
    throw new Error("CEP Node require is unavailable");
  }
  function candidateDirs(env = {}) {
    const home = String(env.USERPROFILE || env.HOME || "").replace(/[\/]+$/, "");
    const appData = String(env.APPDATA || (home ? home + "\\AppData\\Roaming" : "")).replace(/[\/]+$/, "");
    const dirs = [];
    if (home) {
      dirs.push(home + "\\.cc-switch");
      dirs.push(home + "\\.config\\cc-switch");
    }
    if (appData) dirs.push(appData + "\\cc-switch");
    return dirs;
  }
  function rawProviders(parsed) {
    if (!parsed || typeof parsed !== "object") return [];
    if (Array.isArray(parsed.providers)) return parsed.providers;
    if (Array.isArray(parsed.profiles)) return parsed.profiles;
    if (parsed.providers && typeof parsed.providers === "object") return Object.values(parsed.providers);
    return [];
  }
  function ccSwitchProviderEntries(list) {
    return (Array.isArray(list) ? list : []).map((p) => {
      if (!p || typeof p !== "object") return null;
      const name = String(p.name || p.title || p.id || "").trim();
      const baseUrl = String(p.baseUrl || p.base_url || p.url || "").trim();
      const apiKey = String(p.apiKey || p.api_key || p.key || p.token || "").trim();
      if (!name || !baseUrl) return null;
      const protocol = /anthropic/i.test(String(p.type || p.protocol || p.kind || "")) ? "anthropic" : "openai-compatible";
      return { id: "ccswitch-" + name.replace(/[^A-Za-z0-9_-]+/g, "-").toLowerCase(), name, protocol, baseUrl, apiKey };
    }).filter(Boolean);
  }
  function detectCcSwitch({ env = {}, fsImpl } = {}) {
    let fs;
    try {
      fs = fsImpl || getCepRequire8()("fs");
    } catch (e) {
      return null;
    }
    for (const dir of candidateDirs(env)) {
      for (const name of CONFIG_NAMES) {
        const file = dir + "\\" + name;
        try {
          if (!fs.existsSync(file)) continue;
          const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
          const providers = ccSwitchProviderEntries(rawProviders(parsed));
          if (providers.length) return { dir, file, providers };
        } catch (e) {
        }
      }
    }
    return null;
  }

  // src/cep/claudeSettingsImport.js
  function getCepRequire9() {
    if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) {
      return globalThis.window.cep_node.require;
    }
    if (globalThis.window && globalThis.window.require) return globalThis.window.require;
    if (globalThis.require) return globalThis.require;
    throw new Error("CEP Node require is unavailable");
  }
  function readClaudeSettingsEnv({ env = {}, fsImpl } = {}) {
    const home = env.USERPROFILE || env.HOME || (env.HOMEDRIVE && env.HOMEPATH ? env.HOMEDRIVE + env.HOMEPATH : "");
    if (!home) return null;
    let fs;
    try {
      fs = fsImpl || getCepRequire9()("fs");
    } catch (e) {
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(String(home).replace(/[\\/]+$/, "") + "\\.claude\\settings.json", "utf8"));
    } catch (e) {
      return null;
    }
    const settingsEnv = parsed && parsed.env && typeof parsed.env === "object" ? parsed.env : {};
    const baseUrl = String(settingsEnv.ANTHROPIC_BASE_URL || "").trim();
    const authToken = String(settingsEnv.ANTHROPIC_AUTH_TOKEN || "").trim();
    if (!baseUrl && !authToken) return null;
    return { baseUrl, authToken };
  }

  // src/cep/codexConfig.js
  function getCepRequire10() {
    if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) {
      return globalThis.window.cep_node.require;
    }
    if (globalThis.window && globalThis.window.require) return globalThis.window.require;
    if (globalThis.require) return globalThis.require;
    throw new Error("CEP Node require is unavailable");
  }
  function stripInlineComment(line) {
    let inString = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && line[i - 1] !== "\\") inString = !inString;
      else if (ch === "#" && !inString) return line.slice(0, i);
    }
    return line;
  }
  function unquote(value) {
    const trimmed = String(value || "").trim();
    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return trimmed.slice(1, -1);
    }
    if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  }
  function parseToml(text) {
    const root = {};
    const sections = {};
    let current = root;
    const lines = String(text || "").split(/\r?\n/);
    for (const rawLine of lines) {
      const noComment = stripInlineComment(rawLine).trim();
      if (!noComment) continue;
      const sectionMatch = noComment.match(/^\[([^\]]+)\]$/);
      if (sectionMatch) {
        const name = sectionMatch[1].trim();
        sections[name] = sections[name] || {};
        current = sections[name];
        continue;
      }
      const kvMatch = noComment.match(/^([^=]+)=(.*)$/);
      if (!kvMatch) continue;
      const key = kvMatch[1].trim();
      if (!key) continue;
      current[key] = unquote(kvMatch[2]);
    }
    return { root, sections };
  }
  function readCodexCliConfig({ env = {}, fsImpl } = {}) {
    const home = env.USERPROFILE || env.HOME || (env.HOMEDRIVE && env.HOMEPATH ? env.HOMEDRIVE + env.HOMEPATH : "");
    if (!home) return null;
    let fs;
    try {
      fs = fsImpl || getCepRequire10()("fs");
    } catch (e) {
      return null;
    }
    let text;
    try {
      text = fs.readFileSync(String(home).replace(/[\\/]+$/, "") + "\\.codex\\config.toml", "utf8");
    } catch (e) {
      return null;
    }
    let parsed;
    try {
      parsed = parseToml(text);
    } catch (e) {
      return null;
    }
    const model = String(parsed.root.model || "").trim();
    const providerId = String(parsed.root.model_provider || "").trim();
    if (!model && !providerId) return null;
    const result = { model, providerId, provider: null };
    if (providerId) {
      const section = parsed.sections["model_providers." + providerId];
      if (section) {
        result.provider = {
          name: String(section.name || "").trim(),
          baseUrl: String(section.base_url || "").trim(),
          envKey: String(section.env_key || "").trim(),
          wireApi: String(section.wire_api || "").trim()
        };
      }
    }
    return result;
  }
  function resolveCodexProviderApiKey({ provider, env = {}, storedKey = "" } = {}) {
    const envKey = provider && String(provider.envKey || "").trim();
    if (envKey && env[envKey]) return String(env[envKey]);
    if (storedKey) return String(storedKey);
    return "";
  }

  // src/lib/chatEntries.js
  function nextId(entries, prefix) {
    return `${prefix}-${entries.length + 1}`;
  }
  function updateTool(entries, toolUseId, updater) {
    return entries.map((entry) => {
      if (entry.type !== "tool-call" || entry.toolUseId !== toolUseId) return entry;
      return updater(entry);
    });
  }
  function reduceEvent(entries, evt) {
    const current = Array.isArray(entries) ? entries : [];
    if (!evt || !evt.type) return current;
    switch (evt.type) {
      case "turn-start":
        return current;
      case "text-delta": {
        const text = String(evt.text || "");
        if (!text) return current;
        const last = current[current.length - 1];
        if (last && last.type === "ai-text") {
          return current.slice(0, -1).concat({ ...last, text: `${last.text || ""}${text}` });
        }
        return current.concat({ id: nextId(current, "ai"), type: "ai-text", text });
      }
      case "tool-start":
        return current.concat({
          id: evt.toolUseId || nextId(current, "tool"),
          type: "tool-call",
          toolUseId: evt.toolUseId,
          name: evt.name || "",
          input: evt.input,
          state: "running"
        });
      case "approval-required":
        if (!current.some((entry) => entry.type === "tool-call" && entry.toolUseId === evt.toolUseId)) {
          return current.concat({
            id: evt.toolUseId || nextId(current, "tool"),
            type: "tool-call",
            toolUseId: evt.toolUseId,
            name: evt.name || "",
            input: evt.input,
            risk: evt.risk,
            state: "awaiting-approval"
          });
        }
        return updateTool(current, evt.toolUseId, (entry) => ({
          ...entry,
          name: evt.name || entry.name,
          input: evt.input === void 0 ? entry.input : evt.input,
          risk: evt.risk,
          state: "awaiting-approval"
        }));
      case "tool-result":
        if (!current.some((entry) => entry.type === "tool-call" && entry.toolUseId === evt.toolUseId)) {
          return current.concat({
            id: evt.toolUseId || nextId(current, "tool"),
            type: "tool-call",
            toolUseId: evt.toolUseId,
            name: evt.name || "",
            state: evt.ok ? "ok" : "error",
            ok: !!evt.ok,
            text: evt.text || "",
            durationMs: evt.durationMs
          });
        }
        return updateTool(current, evt.toolUseId, (entry) => ({
          ...entry,
          state: evt.ok ? "ok" : "error",
          ok: !!evt.ok,
          text: evt.text || "",
          durationMs: evt.durationMs
        }));
      case "tool-denied":
        return updateTool(current, evt.toolUseId, (entry) => ({
          ...entry,
          state: "denied"
        }));
      case "tool-allowed":
        return updateTool(current, evt.toolUseId, (entry) => ({
          ...entry,
          state: "running"
        }));
      case "turn-end":
        return current;
      case "error":
        return current.concat({
          id: nextId(current, "error"),
          type: "error",
          kind: evt.kind,
          message: evt.message || ""
        });
      default:
        return current;
    }
  }

  // src/lib/descriptorSelect.js
  function isClaudeApiBackend(effectiveBackend) {
    return effectiveBackend === "claude-api" || effectiveBackend === "byok";
  }
  function selectDescriptor({
    effectiveBackend = "none",
    backendPref = "subscription",
    baseDescriptor,
    customModel = "",
    claudeApiProvider = null,
    codexCustomProvider = null,
    byokApiModels = null,
    codexCachedModels = null,
    zcodeSessionModels = null,
    zcodeProbedModels = null
  }) {
    const claudeApi = isClaudeApiBackend(effectiveBackend);
    const customId = claudeApi || backendPref === "codex" ? String(customModel || "").trim() : "";
    if (claudeApi) {
      if (claudeApiProvider && claudeApiProvider.probedModels && claudeApiProvider.probedModels.length) {
        return descriptorWithCustomModel(descriptorFromProbedModels(byokStaticDescriptor(), claudeApiProvider.probedModels), customId);
      }
      if (byokApiModels) {
        return descriptorWithCustomModel(mergeByokModels(byokStaticDescriptor(), byokApiModels), customId);
      }
      return baseDescriptor;
    }
    if (backendPref === "codex") {
      if (codexCustomProvider && codexCustomProvider.probedModels && codexCustomProvider.probedModels.length) {
        return descriptorWithCustomModel(descriptorFromProbedModels(codexStaticDescriptor(), codexCustomProvider.probedModels), customId);
      }
      if (codexCachedModels) {
        return descriptorWithCustomModel(codexDescriptorFromModels({ models: codexCachedModels }), customId);
      }
      return baseDescriptor;
    }
    if (backendPref === "zcode" || effectiveBackend === "zcode") {
      const available = zcodeSessionModels && zcodeSessionModels.settings && zcodeSessionModels.settings.model && Array.isArray(zcodeSessionModels.settings.model.available) ? zcodeSessionModels.settings.model.available : [];
      if (available.length > 1) return zcodeDescriptorFromModels(zcodeSessionModels);
      if (zcodeProbedModels) {
        const probed = zcodeDescriptorFromProbedModels(zcodeProbedModels);
        if (probed) return probed;
      }
      if (zcodeSessionModels) return zcodeDescriptorFromModels(zcodeSessionModels);
      return baseDescriptor;
    }
    return baseDescriptor;
  }
  function reconcileModelPref(model, descriptor, { isCustom = false } = {}) {
    if (isCustom) return model;
    const models = descriptor && Array.isArray(descriptor.models) ? descriptor.models : [];
    if (!models.length) return model;
    const trimmed = String(model || "").trim();
    if (trimmed && models.some((m) => m.id === trimmed)) return trimmed;
    return descriptor.defaultModelId;
  }

  // src/lib/zcodeModelCache.js
  var ZCODE_PROBED_MODELS_CACHE_KEY = "ae_mcp_zcode_probed_models";
  var ZCODE_PROBED_MODELS_CACHE_MS = 60 * 60 * 1e3;
  function readCachedZcodeProbedModels(storage) {
    try {
      const raw = storage.getItem(ZCODE_PROBED_MODELS_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      if (!Array.isArray(parsed.probedModels)) return null;
      if (Date.now() - Number(parsed.probedAt || 0) > ZCODE_PROBED_MODELS_CACHE_MS) return null;
      return { cliModel: String(parsed.cliModel || ""), providerId: String(parsed.providerId || ""), probedModels: parsed.probedModels };
    } catch (e) {
      return null;
    }
  }
  function writeCachedZcodeProbedModels(storage, { cliModel, providerId, probedModels } = {}) {
    try {
      storage.setItem(ZCODE_PROBED_MODELS_CACHE_KEY, JSON.stringify({
        cliModel: String(cliModel || ""),
        providerId: String(providerId || ""),
        probedModels: Array.isArray(probedModels) ? probedModels : [],
        probedAt: Date.now()
      }));
    } catch (e) {
    }
  }

  // src/cep/modelsApi.js
  var CACHE_KEY = "ae_mcp_byok_models";
  var TTL_MS = 24 * 60 * 60 * 1e3;
  function getCepRequire11() {
    if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) {
      return globalThis.window.cep_node.require;
    }
    if (globalThis.window && globalThis.window.require) return globalThis.window.require;
    if (globalThis.require) return globalThis.require;
    throw new Error("CEP Node require is unavailable");
  }
  function fetchAnthropicModels({ apiKey, baseUrl = "", httpsImpl, timeoutMs = 8e3 } = {}) {
    const https = httpsImpl || getCepRequire11()("https");
    return new Promise((resolve) => {
      let endpoint;
      try {
        endpoint = new URL(anthropicEndpoint(baseUrl, "/v1/models?limit=100"));
      } catch (e) {
        resolve(null);
        return;
      }
      const req = https.request({
        hostname: endpoint.hostname,
        port: endpoint.port || void 0,
        protocol: endpoint.protocol,
        path: endpoint.pathname + endpoint.search,
        method: "GET",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
      }, (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode !== 200) return resolve(null);
          try {
            const parsed = JSON.parse(body);
            const list = Array.isArray(parsed.data) ? parsed.data : [];
            resolve(list.filter((m) => String(m.id || "").startsWith("claude-")));
          } catch (e) {
            resolve(null);
          }
        });
      });
      req.on("error", () => resolve(null));
      if (req.setTimeout) req.setTimeout(timeoutMs, () => resolve(null));
      req.end();
    });
  }
  async function cachedByokModels({ apiKey, baseUrl = "", fetcher, storage, now = Date.now } = {}) {
    const store = storage || globalThis.localStorage;
    const keyTag = String(apiKey || "").slice(-6) + "|" + normalizeBaseUrl(baseUrl);
    try {
      const raw = store.getItem(CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw);
        if (cached.keyTag === keyTag && now() - cached.at < TTL_MS) return cached.models;
      }
    } catch (e) {
    }
    const run = fetcher || (() => fetchAnthropicModels({ apiKey, baseUrl }));
    const models = await run();
    if (models) {
      try {
        store.setItem(CACHE_KEY, JSON.stringify({ keyTag, at: now(), models }));
      } catch (e) {
      }
    }
    return models;
  }

  // src/cep/useActivity.js
  var import_react38 = __toESM(require_react(), 1);
  function useActivity(getHost) {
    const [events, setEvents] = import_react38.default.useState([]);
    import_react38.default.useEffect(() => {
      let unsub = null;
      let retry = null;
      let disposed = false;
      const attach = () => {
        if (disposed) return;
        const host = getHost && getHost();
        const act = host && host.activity;
        if (!act) {
          retry = setTimeout(attach, 2e3);
          return;
        }
        setEvents(act.list());
        unsub = act.subscribe((e) => setEvents((xs) => [...xs.slice(-499), e]));
      };
      attach();
      return () => {
        disposed = true;
        if (unsub) unsub();
        if (retry) clearTimeout(retry);
      };
    }, [getHost]);
    const clear = import_react38.default.useCallback(() => setEvents([]), []);
    return { events, clear };
  }

  // src/cep/firstRun.js
  var WIZARD_DONE_KEY = "ae_mcp_wizard_done";
  function isWizardDone(storage) {
    try {
      return storage.getItem(WIZARD_DONE_KEY) === "1";
    } catch (e) {
      return false;
    }
  }
  function markWizardDone(storage) {
    try {
      storage.setItem(WIZARD_DONE_KEY, "1");
    } catch (e) {
    }
  }
  function clearWizardDone(storage) {
    try {
      storage.removeItem(WIZARD_DONE_KEY);
    } catch (e) {
    }
  }

  // src/app/wizardWiring.js
  var import_react39 = __toESM(require_react(), 1);

  // src/cep/wizardActions.js
  var OUTPUT_TAIL = 8192;
  function getCepRequire12() {
    if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) {
      return globalThis.window.cep_node.require;
    }
    if (globalThis.window && globalThis.window.require) return globalThis.window.require;
    if (globalThis.require) return globalThis.require;
    throw new Error("CEP Node require is unavailable");
  }
  var DETECT = {
    uv: { file: "uv", args: ["--version"] },
    node: { file: "node", args: ["--version"] },
    claude: { file: "claude", args: ["--version"], shell: true }
  };
  function execVersion(execFile, file, args, env, shell) {
    return new Promise((resolve) => {
      execFile(file, args, { windowsHide: true, env, shell: shell === true }, (err, stdout, stderr) => {
        if (err) return resolve({ ok: false });
        resolve({ ok: true, version: String(stdout || stderr || "").trim() });
      });
    });
  }
  function getCepEnvSafe() {
    return globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.process && globalThis.window.cep_node.process.env || {};
  }
  async function detectAeMcp({ execFileImpl, env, fsImpl }) {
    const execFile = execFileImpl || getCepRequire12()("child_process").execFile;
    const whereHit = await new Promise((resolve) => {
      execFile("where", ["ae-mcp"], { windowsHide: true, env }, (err, stdout) => {
        resolve(err ? "" : String(stdout || "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "");
      });
    });
    if (whereHit) return { ok: true, version: whereHit };
    const profile = (env || getCepEnvSafe()).USERPROFILE || "";
    if (profile) {
      const shim = profile.replace(/[\\/]+$/, "") + "\\.local\\bin\\ae-mcp.exe";
      const fs = fsImpl || getCepRequire12()("fs");
      if (fs.existsSync(shim)) return { ok: true, version: shim };
    }
    return { ok: false };
  }
  async function detectTool(id, { execFileImpl, env, fsImpl } = {}) {
    if (id === "aeMcp") return detectAeMcp({ execFileImpl, env, fsImpl });
    const spec = DETECT[id];
    const execFile = execFileImpl || getCepRequire12()("child_process").execFile;
    return execVersion(execFile, spec.file, spec.args, env, spec.shell);
  }
  var REPO = "https://github.com/JUNKDOGE-JOE/after-effects-mcp";
  function buildInstallCommands({ panelVersion, repoRoot }) {
    const src = (sub) => repoRoot ? `${repoRoot}\\packages\\${sub}` : `git+${REPO}@v${panelVersion}#subdirectory=packages/${sub}`;
    return {
      uv: { file: "winget", args: ["install", "--id", "astral-sh.uv", "-e", "--accept-source-agreements", "--accept-package-agreements"] },
      uvFallback: { file: "powershell", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://astral.sh/uv/install.ps1 | iex"] },
      node: { file: "winget", args: ["install", "--id", "OpenJS.NodeJS.LTS", "-e", "--accept-source-agreements", "--accept-package-agreements"] },
      claude: { file: "npm", args: ["install", "-g", "@anthropic-ai/claude-code"] },
      aeMcp: { file: "uv", args: ["tool", "install", "--force", "--from", src("core"), "ae-mcp", "--with", src("bridge"), "--with", src("snapshot-mss")] }
    };
  }
  function runAction({ file, args, spawnImpl, env, onChunk }) {
    const spawn = spawnImpl || getCepRequire12()("child_process").spawn;
    return new Promise((resolve) => {
      let output = "";
      const push = (chunk) => {
        const text = String(chunk || "");
        output = (output + text).slice(-OUTPUT_TAIL);
        if (onChunk) onChunk(text);
      };
      let child;
      try {
        child = spawn(file, args, { windowsHide: true, env, shell: false });
      } catch (e) {
        return resolve({ ok: false, code: -1, output: String(e && e.message || e) });
      }
      if (child.stdout && child.stdout.on) child.stdout.on("data", push);
      if (child.stderr && child.stderr.on) child.stderr.on("data", push);
      child.on("error", (e) => resolve({ ok: false, code: -1, output: output + String(e && e.message || e) }));
      child.on("exit", (code) => resolve({ ok: code === 0, code, output }));
    });
  }
  function commandPreview({ file, args }) {
    return [file, ...args.map((a) => /\s/.test(a) ? `"${a}"` : a)].join(" ");
  }
  function detectRepoRoot({ extRoot, fsImpl }) {
    return findProjectRoot({ extRoot, repoRoot: "", fsImpl: fsImpl || getCepRequire12()("fs") });
  }
  var LOGIN_COMMANDS = { claude: "claude", codex: "codex login" };
  function openLoginTerminal({ tool, spawnImpl } = {}) {
    const spawn = spawnImpl || getCepRequire12()("child_process").spawn;
    const command = LOGIN_COMMANDS[tool] || LOGIN_COMMANDS.claude;
    const child = spawn("cmd", ["/c", "start", "ae-mcp login", "pwsh", "-NoExit", "-Command", command], {
      detached: true,
      windowsHide: false
    });
    if (child && child.unref) child.unref();
    return true;
  }

  // src/app/wizardWiring.js
  function isLoginOk(claudeStatus) {
    return Boolean(claudeStatus && claudeStatus.state === "ready");
  }
  function versionFrom(status) {
    if (!status) return "";
    if (status.nodeVersion) return "Node " + String(status.nodeVersion).replace(/^v?/, "v");
    return String(status.detail || "").trim();
  }
  function wingetMissing(output) {
    const text = String(output || "").toLowerCase();
    return text.includes("winget") && (text.includes("not recognized") || text.includes("not found") || text.includes("enoent") || text.includes("cannot find"));
  }
  function useWizardWiring({ extRoot, lang, claudeStatus, recheckLogin } = {}) {
    const [stepStates, dispatch] = import_react39.default.useReducer(stepReducer, null, initialStepStates);
    const [useUvFallback, setUseUvFallback] = import_react39.default.useState(false);
    const repoRoot = import_react39.default.useMemo(() => {
      try {
        return detectRepoRoot({ extRoot });
      } catch (e) {
        return "";
      }
    }, [extRoot]);
    const cmds = import_react39.default.useMemo(() => buildInstallCommands({
      panelVersion: PANEL_VERSION,
      repoRoot
    }), [repoRoot]);
    const activeCmds = import_react39.default.useMemo(() => ({
      ...cmds,
      uv: useUvFallback ? cmds.uvFallback : cmds.uv
    }), [cmds, useUvFallback]);
    const commandPreviews = import_react39.default.useMemo(() => ({
      uv: commandPreview(activeCmds.uv),
      aeMcp: commandPreview(activeCmds.aeMcp),
      node: commandPreview(activeCmds.node),
      claude: commandPreview(activeCmds.claude),
      login: "claude"
    }), [activeCmds]);
    const detect = import_react39.default.useCallback(async (id) => {
      dispatch({ type: "detect-start", id });
      if (id === "login") {
        if (recheckLogin) {
          recheckLogin();
          return { ok: false, pending: true };
        }
        const ok = isLoginOk(claudeStatus);
        dispatch({ type: "detect-result", id, ok, version: ok ? versionFrom(claudeStatus) : "" });
        return { ok, version: versionFrom(claudeStatus) };
      }
      const result = await detectTool(id);
      dispatch({ type: "detect-result", id, ok: result.ok, version: result.version || "" });
      return result;
    }, [claudeStatus, recheckLogin]);
    const install = import_react39.default.useCallback(async (id) => {
      const cmd = activeCmds[id];
      if (!cmd) return { ok: false, output: "No command configured for " + id };
      if (id === "uv" && useUvFallback) {
        const msg = lang === "zh" ? "winget \u4E0D\u53EF\u7528\u3002\u662F\u5426\u6539\u7528 astral \u5B98\u65B9 PowerShell \u5B89\u88C5\u811A\u672C\uFF1F" : "winget is unavailable. Use the official astral PowerShell installer instead?";
        if (globalThis.window && globalThis.window.confirm && !globalThis.window.confirm(msg)) {
          return { ok: false, output: "uv fallback cancelled" };
        }
      }
      dispatch({ type: "run-start", id });
      const result = await runAction({
        ...cmd,
        onChunk: (text) => dispatch({ type: "run-chunk", id, text })
      });
      if (id === "uv" && !result.ok && !useUvFallback && wingetMissing(result.output)) {
        setUseUvFallback(true);
        dispatch({
          type: "run-done",
          id,
          ok: false,
          output: result.output + "\nwinget was not found. Re-run Install to use the official astral PowerShell installer."
        });
        return result;
      }
      dispatch({ type: "run-done", id, ok: result.ok, output: result.output });
      await detect(id);
      return result;
    }, [activeCmds, detect, lang, useUvFallback]);
    const openLogin = import_react39.default.useCallback(() => {
      openLoginTerminal({ tool: "claude" });
      dispatch({ type: "detect-result", id: "login", ok: false });
    }, []);
    const bootDetectRef = import_react39.default.useRef(false);
    import_react39.default.useEffect(() => {
      if (bootDetectRef.current) return;
      bootDetectRef.current = true;
      ["uv", "aeMcp", "node", "claude"].forEach((id) => {
        detect(id);
      });
    }, [detect]);
    import_react39.default.useEffect(() => {
      if (!claudeStatus) return;
      if (claudeStatus.state === "checking") {
        dispatch({ type: "detect-start", id: "login" });
        return;
      }
      const ok = isLoginOk(claudeStatus);
      dispatch({ type: "detect-result", id: "login", ok, version: ok ? versionFrom(claudeStatus) : "" });
    }, [claudeStatus]);
    return {
      stepStates,
      props: {
        stepStates,
        commandPreviews,
        onDetect: detect,
        onInstall: install,
        onOpenLogin: openLogin
      }
    };
  }

  // src/cep/diagnostics.js
  var HINTS = {
    "host-listening": {
      zh: "\u786E\u8BA4 ae-mcp \u9762\u677F\u5DF2\u6253\u5F00\uFF1B\u5982\u7AEF\u53E3\u88AB\u5360\u7528\uFF0C\u8BF7\u5728\u8BBE\u7F6E\u91CC\u6362\u4E00\u4E2A\u7AEF\u53E3\u5E76\u91CD\u542F\u670D\u52A1\u3002",
      en: "Make sure the ae-mcp panel is open. If the port is busy, choose another port in Settings and restart the service."
    },
    "token-file": {
      zh: "\u91CD\u542F After Effects \u9762\u677F\u4EE5\u91CD\u65B0\u751F\u6210 ~/.ae-mcp/auth-token\uFF0C\u7136\u540E\u91CD\u542F\u4F60\u7684 AI \u5BA2\u6237\u7AEF\u3002",
      en: "Restart the After Effects panel to regenerate ~/.ae-mcp/auth-token, then restart your AI client."
    },
    "python-seen": {
      zh: "\u8FD0\u884C\u4F60\u7684 AI \u5BA2\u6237\u7AEF\u53D1\u8D77\u4E00\u6B21\u5BF9\u8BDD\uFF0C\u6216\u68C0\u67E5\u5176 MCP \u914D\u7F6E\u3002",
      en: "Start a conversation in your AI client, or check its MCP configuration."
    },
    "ae-project": {
      zh: "\u786E\u8BA4 After Effects \u5141\u8BB8\u811A\u672C\u8BBF\u95EE\uFF0C\u5E76\u4FDD\u6301\u9762\u677F\u670D\u52A1\u8FD0\u884C\u3002",
      en: "Confirm After Effects allows script access and keep the panel service running."
    },
    "extendscript-ping": {
      zh: "\u91CD\u542F\u9762\u677F\u670D\u52A1\uFF1B\u5982\u679C\u4ECD\u5931\u8D25\uFF0C\u8BF7\u91CD\u542F After Effects \u540E\u518D\u8BD5\u3002",
      en: "Restart the panel service. If it still fails, restart After Effects and try again."
    },
    uv: {
      zh: "\u5B89\u88C5 uv\uFF1A\u4F18\u5148\u4F7F\u7528 winget install --id astral-sh.uv -e\u3002",
      en: "Install uv: prefer winget install --id astral-sh.uv -e."
    },
    node: {
      zh: "\u5B89\u88C5 Node.js LTS\uFF1Awinget install --id OpenJS.NodeJS.LTS -e\u3002",
      en: "Install Node.js LTS: winget install --id OpenJS.NodeJS.LTS -e."
    },
    claude: {
      zh: "\u5B89\u88C5 Claude Code\uFF1Anpm install -g @anthropic-ai/claude-code\u3002",
      en: "Install Claude Code: npm install -g @anthropic-ai/claude-code."
    }
  };
  function tokenPath(os) {
    const home = os && os.homedir ? os.homedir() : "";
    return home.replace(/[\\/]$/, "") + "/.ae-mcp/auth-token";
  }
  async function readJson(response) {
    if (response && response.json) return response.json();
    return {};
  }
  function tokenHeaders(token) {
    return {
      "content-type": "application/json",
      "x-ae-mcp-token": token,
      // Must match INTERNAL_CLIENT in plugin/host/server.js: panel-origin
      // probes are kept out of the client registry (and therefore out of
      // lastClientSeenAt) so running diagnostics can never green-light the
      // python-seen check or list a phantom client in Settings.
      "x-ae-mcp-client": "panel-diagnostics/internal"
    };
  }
  async function execCode(fetchImpl, port, token, code) {
    const response = await fetchImpl("http://127.0.0.1:" + port + "/exec", {
      method: "POST",
      headers: tokenHeaders(token),
      body: JSON.stringify({ code })
    });
    return { response, body: await readJson(response) };
  }
  async function runDiagnostics({ getHost, port, fs, os, fetchImpl, execFileImpl }) {
    const fetcher = fetchImpl || globalThis.fetch;
    const items = [];
    let token = "";
    try {
      const response = await fetcher("http://127.0.0.1:" + port + "/health");
      const body = await readJson(response);
      const ok = response && response.ok !== false && body.ok === true;
      items.push({
        id: "host-listening",
        ok,
        detail: ok ? "Host v" + (body.pluginVersion || "unknown") + " on port " + (body.port || port) : "Host did not return ok",
        fixHint: HINTS["host-listening"]
      });
    } catch (e) {
      items.push({ id: "host-listening", ok: false, detail: e.message, fixHint: HINTS["host-listening"] });
    }
    try {
      const file = tokenPath(os);
      const exists = fs && fs.existsSync && fs.existsSync(file);
      token = exists && fs.readFileSync ? String(fs.readFileSync(file, "utf8")).trim() : "";
      items.push({
        id: "token-file",
        ok: exists && token.length === 64,
        detail: exists ? "Token length " + token.length : "Token file missing",
        fixHint: HINTS["token-file"]
      });
    } catch (e) {
      items.push({ id: "token-file", ok: false, detail: e.message, fixHint: HINTS["token-file"] });
    }
    try {
      const host = getHost && getHost();
      const info = host && host.getConnectionInfo && host.getConnectionInfo();
      const lastPythonSeenAt = info ? Math.max(info.lastHealthAt || 0, info.lastClientSeenAt || 0) : 0;
      const age = lastPythonSeenAt ? Date.now() - lastPythonSeenAt : Infinity;
      const ok = age < 10 * 60 * 1e3;
      items.push({
        id: "python-seen",
        ok,
        detail: ok ? "Last Python signal " + Math.round(age / 1e3) + "s ago" : "No recent Python signal",
        fixHint: HINTS["python-seen"]
      });
    } catch (e) {
      items.push({ id: "python-seen", ok: false, detail: e.message, fixHint: HINTS["python-seen"] });
    }
    try {
      const code = 'app.project && app.project.file ? app.project.file.name : (app.project ? "unsaved" : "none")';
      const { response, body } = await execCode(fetcher, port, token, code);
      const ok = response && response.ok !== false && body.ok !== false;
      const project = body.result || "none";
      items.push({
        id: "ae-project",
        ok,
        detail: project === "unsaved" ? "Project unsaved" : "Project " + project,
        fixHint: HINTS["ae-project"]
      });
    } catch (e) {
      items.push({ id: "ae-project", ok: false, detail: e.message, fixHint: HINTS["ae-project"] });
    }
    try {
      const { response, body } = await execCode(fetcher, port, token, '"pong"');
      const ok = response && response.ok !== false && body.ok !== false && body.result === "pong";
      items.push({
        id: "extendscript-ping",
        ok,
        detail: ok ? "pong" : "Unexpected result: " + String(body.result || body.error || ""),
        fixHint: HINTS["extendscript-ping"]
      });
    } catch (e) {
      items.push({ id: "extendscript-ping", ok: false, detail: e.message, fixHint: HINTS["extendscript-ping"] });
    }
    for (const id of ["uv", "node", "claude"]) {
      const result = await detectTool(id, { execFileImpl });
      items.push({
        id,
        ok: result.ok,
        detail: result.ok ? result.version : HINTS[id].en,
        fixHint: HINTS[id]
      });
    }
    return items;
  }

  // src/lib/wizardCopy.js
  function copyWizardConfig(copyText3, fallbackConfig, selectedConfig) {
    const text = selectedConfig || fallbackConfig || "";
    return copyText3 ? copyText3(text) : void 0;
  }

  // src/cep/hostBridge.js
  function normalizeCepPath(value) {
    var normalized = String(value || "");
    normalized = normalized.replace(/^file:\\+/i, "");
    normalized = normalized.replace(/^file:\/\/\//i, "");
    normalized = normalized.replace(/^file:\/\//i, "");
    normalized = decodeURIComponent(normalized);
    if (/^\/[A-Za-z]:/.test(normalized)) normalized = normalized.slice(1);
    return normalized;
  }
  function isValidPort(p) {
    return isFinite(p) && p >= 1024 && p <= 65535;
  }
  var DEFAULT_PORT = 11488;
  var PORT_STORAGE_KEY = "ae_mcp_panel_port";
  function loadSavedPort(storage) {
    try {
      const p = parseInt(storage.getItem(PORT_STORAGE_KEY), 10);
      if (isValidPort(p)) return p;
    } catch (e) {
    }
    return null;
  }
  function savePort(storage, port) {
    try {
      storage.setItem(PORT_STORAGE_KEY, String(port));
    } catch (e) {
    }
  }
  function buildMcpConfig(port, expertGuidance = true) {
    return {
      mcpServers: {
        ae: {
          command: "ae-mcp",
          env: Object.assign(
            { AE_MCP_BACKEND: "ae-mcp" },
            expertGuidanceEnv(expertGuidance !== false),
            { AE_MCP_PLUGIN_URL: "http://127.0.0.1:" + port }
          )
        }
      }
    };
  }
  function getCepRequire13() {
    if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) {
      return globalThis.window.cep_node.require;
    }
    if (globalThis.window && globalThis.window.require) return globalThis.window.require;
    if (globalThis.require) return globalThis.require;
    throw new Error("CEP Node require is unavailable");
  }
  function createHostController({ cs: cs2, onStatus, onLog }) {
    let host = null;
    function start(port) {
      onStatus("starting", port);
      try {
        const cepRequire5 = getCepRequire13();
        const path = cepRequire5("path");
        const extRoot = normalizeCepPath(cs2.getSystemPath("extension"));
        const hostPath = path.join(extRoot, "host", "server.js");
        onLog("host: " + hostPath);
        host = cepRequire5(hostPath);
        host.setCSInterface(cs2);
        window.addEventListener("beforeunload", () => {
          try {
            host.stop();
          } catch (e) {
          }
        });
        host.start(port, (err) => err ? onStatus("error", port, err.message) : onStatus("ok", port));
      } catch (e) {
        onStatus("error", port, e.message);
      }
    }
    function restart(port) {
      if (host && host.restart) {
        onStatus("starting", port);
        host.restart(port, (err) => err ? onStatus("error", port, err.message) : onStatus("ok", port));
      }
    }
    return { start, restart, getHost: () => host };
  }

  // src/lib/expertGuidance.js
  var EXPERT_GUIDANCE_KEY = "ae-mcp.expertGuidance";
  function loadExpertGuidance(storage) {
    try {
      return storage.getItem(EXPERT_GUIDANCE_KEY) !== "0";
    } catch (e) {
      return true;
    }
  }
  function saveExpertGuidance(storage, on) {
    try {
      storage.setItem(EXPERT_GUIDANCE_KEY, on ? "1" : "0");
    } catch (e) {
    }
  }

  // src/lib/logExport.js
  function redactSecrets(text) {
    var s = String(text == null ? "" : text);
    var mask = function(v) {
      return v.slice(0, 6) + "...[redacted]";
    };
    s = s.replace(/((?:ANTHROPIC_AUTH_TOKEN|[A-Z_]*API_KEY)\s*[=:]\s*)(\S+)/g, function(m, pre, v) {
      return pre + mask(v);
    });
    s = s.replace(/((?:Authorization|x-api-key)\s*[:=]\s*(?:Bearer\s+)?)(\S+)/gi, function(m, pre, v) {
      return pre + mask(v);
    });
    s = s.replace(/sk-[A-Za-z0-9_-]{8,}/g, function(m) {
      return mask(m);
    });
    return s;
  }
  function buildLogExport({ panelLogs = [], hostInfo = {}, sidecarTail = "", version = "", now = /* @__PURE__ */ new Date() } = {}) {
    const lines = [];
    lines.push("# ae-mcp panel log export");
    lines.push("exported-at: " + now.toISOString());
    lines.push("panel-version: " + (version || "-"));
    lines.push("host-version: " + (hostInfo.hostVersion || "-"));
    lines.push("python-version: " + (hostInfo.pythonVersion || "-"));
    lines.push("");
    lines.push("## panel logs (" + panelLogs.length + ")");
    for (const line of panelLogs) lines.push(redactSecrets(line));
    lines.push("");
    lines.push("## sidecar stderr tail");
    lines.push(sidecarTail ? redactSecrets(sidecarTail) : "(empty)");
    return lines.join("\n") + "\n";
  }
  function exportFileName(now = /* @__PURE__ */ new Date()) {
    return "export-" + now.toISOString().replace(/[:.]/g, "-") + ".txt";
  }
  function keepLogLine(level, message) {
    if (level !== "error") return true;
    return /error|failed|exception/i.test(String(message || ""));
  }

  // src/cep/logExportFs.js
  function getCepRequire14() {
    if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) {
      return globalThis.window.cep_node.require;
    }
    if (globalThis.window && globalThis.window.require) return globalThis.window.require;
    if (globalThis.require) return globalThis.require;
    throw new Error("CEP Node require is unavailable");
  }
  function writeLogExport({ text, fileName, deps }) {
    const req = deps ? null : getCepRequire14();
    const fs = deps ? deps.fs : req("fs");
    const os = deps ? deps.os : req("os");
    const path = deps ? deps.path : req("path");
    const dir = path.join(os.homedir(), ".ae-mcp", "logs");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, fileName);
    fs.writeFileSync(file, text, "utf8");
    return file;
  }
  function revealInExplorer(filePath, execImpl, onError) {
    const exec = execImpl || getCepRequire14()("child_process").exec;
    const winPath = String(filePath).replace(/\//g, "\\");
    exec('explorer.exe /select,"' + winPath + '"', { windowsHide: true }, (err) => {
      if (err && onError) onError(err);
    });
  }

  // src/lib/stableValue.js
  function reconcileStableJsonValue(previous, value) {
    const json = JSON.stringify(value);
    if (previous && previous.json === json) return previous;
    return { json, value };
  }

  // src/app/App.jsx
  var import_jsx_runtime36 = __toESM(require_jsx_runtime(), 1);
  var T = {
    zh: {
      connected: "\u670D\u52A1\u8FD0\u884C\u4E2D",
      starting: "\u6B63\u5728\u542F\u52A8...",
      error: "\u670D\u52A1\u6545\u969C",
      paused: "\u5DF2\u6682\u505C \u2014 AI \u64CD\u4F5C\u5DF2\u88AB\u62E6\u622A",
      pauseAll: "\u6682\u505C\u6240\u6709 AI \u64CD\u4F5C",
      resume: "\u6062\u590D",
      chat: "\u5BF9\u8BDD",
      activity: "\u6D3B\u52A8",
      settings: "\u8BBE\u7F6E",
      chatEmptyT: "\u5185\u5D4C\u5BF9\u8BDD\u5373\u5C06\u5F00\u653E",
      chatEmptyB: "P5 \u4E0A\u7EBF\u3002\u73B0\u5728\u53EF\u901A\u8FC7 Claude Desktop \u7B49\u5BA2\u6237\u7AEF\u8FDE\u63A5\u4F7F\u7528\u3002",
      actEmptyT: "\u8FD8\u6CA1\u6709\u64CD\u4F5C\u8BB0\u5F55",
      actEmptyB: "AI \u5BA2\u6237\u7AEF\u6267\u884C\u7684\u6BCF\u4E2A AE \u64CD\u4F5C\u90FD\u4F1A\u51FA\u73B0\u5728\u8FD9\u91CC\u3002",
      regenTitle: "\u91CD\u65B0\u751F\u6210\u8BBF\u95EE Token\uFF1F",
      regenBody: "\u6240\u6709\u5DF2\u8FDE\u63A5\u7684 AI \u5BA2\u6237\u7AEF\u4F1A\u7ACB\u5373\u5931\u53BB\u8BBF\u95EE\u6743\u9650\uFF0C\u9700\u8981\u91CD\u542F\u5B83\u4EEC\u624D\u80FD\u91CD\u65B0\u8FDE\u63A5\u3002",
      regenConfirm: "\u91CD\u65B0\u751F\u6210",
      cancel: "\u53D6\u6D88",
      pausedHint: "\u5DF2\u6682\u505C \u2014 \u6062\u590D\u540E\u624D\u80FD\u53D1\u9001",
      goSettings: "\u53BB\u8BBE\u7F6E"
    },
    en: {
      connected: "Service running",
      starting: "Starting...",
      error: "Service error",
      paused: "Paused \u2014 AI actions are blocked",
      pauseAll: "Pause all AI actions",
      resume: "Resume",
      chat: "Chat",
      activity: "Activity",
      settings: "Settings",
      chatEmptyT: "Built-in chat coming soon",
      chatEmptyB: "Lands in P5. Connect via Claude Desktop etc. for now.",
      actEmptyT: "No activity yet",
      actEmptyB: "Every AE operation by an AI client will appear here.",
      regenTitle: "Regenerate access token?",
      regenBody: "Every connected AI client loses access immediately and must be restarted to reconnect.",
      regenConfirm: "Regenerate",
      cancel: "Cancel",
      pausedHint: "Paused \u2014 resume to send",
      goSettings: "Open Settings"
    }
  };
  var pkgVersion = package_default.version;
  function readPref(key, fallback) {
    try {
      const v = window.localStorage.getItem(key);
      return v || fallback;
    } catch (e) {
      return fallback;
    }
  }
  function writePref(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (e) {
    }
  }
  var CODEX_MODELS_CACHE_KEY = "ae_mcp_codex_models";
  var CODEX_MODELS_CACHE_MS = 24 * 60 * 60 * 1e3;
  function readCachedCodexModels(storage) {
    try {
      const raw = storage.getItem(CODEX_MODELS_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.models)) return null;
      if (Date.now() - Number(parsed.ts || 0) > CODEX_MODELS_CACHE_MS) return null;
      return parsed.models;
    } catch (e) {
      return null;
    }
  }
  function writeCachedCodexModels(storage, models) {
    try {
      storage.setItem(CODEX_MODELS_CACHE_KEY, JSON.stringify({ ts: Date.now(), models }));
    } catch (e) {
    }
  }
  var CLIENT_NAMES = {
    builtin: { zh: "\u9762\u677F\u5185\u7F6E\u5BF9\u8BDD", en: "Built-in chat" },
    "claude-desktop": { zh: "Claude Desktop", en: "Claude Desktop" },
    "claude-code": { zh: "Claude Code", en: "Claude Code" },
    cursor: { zh: "Cursor", en: "Cursor" }
  };
  function cepRequire4(mod) {
    if (window.cep_node && window.cep_node.require) return window.cep_node.require(mod);
    if (window.require) return window.require(mod);
    return null;
  }
  function Shell({ cs: cs2 }) {
    const { lang, setLang } = useLang();
    const t = T[lang];
    const [tab, setTab] = import_react40.default.useState("chat");
    const [status, setStatus] = import_react40.default.useState({ state: "starting", port: DEFAULT_PORT, error: null });
    const [paused, setPaused] = import_react40.default.useState(false);
    const [logs, setLogs] = import_react40.default.useState([]);
    const ctrl = import_react40.default.useRef(null);
    const getHost = import_react40.default.useCallback(() => ctrl.current ? ctrl.current.getHost() : null, []);
    const [wizardDone, setWizardDone] = import_react40.default.useState(() => isWizardDone(window.localStorage));
    const [wizStep, setWizStep] = import_react40.default.useState(1);
    const [wizClient, setWizClient] = import_react40.default.useState("claude-desktop");
    const [drawerOpen, setDrawerOpen] = import_react40.default.useState(false);
    const [connInfo, setConnInfo] = import_react40.default.useState(null);
    const [diagnostics, setDiagnostics] = import_react40.default.useState(null);
    const { events, clear } = useActivity(getHost);
    const [clients, setClients] = import_react40.default.useState([]);
    const [confirmRegen, setConfirmRegen] = import_react40.default.useState(false);
    const [tokenEpoch, setTokenEpoch] = import_react40.default.useState(0);
    const keyStore = import_react40.default.useMemo(() => {
      try {
        return createApiKeyStore();
      } catch (e) {
        return null;
      }
    }, []);
    const [apiKey, setApiKey] = import_react40.default.useState(() => {
      try {
        return keyStore ? keyStore.readKey() : "";
      } catch (e) {
        return "";
      }
    });
    const [anthropicBaseUrl, setAnthropicBaseUrl] = import_react40.default.useState(() => readPref("ae_mcp_anthropic_base_url", ""));
    const [codexApiKey, setCodexApiKey] = import_react40.default.useState(() => {
      try {
        return keyStore ? keyStore.readKey("codex") : "";
      } catch (e) {
        return "";
      }
    });
    const [codexBaseUrl, setCodexBaseUrl] = import_react40.default.useState(() => readPref("ae_mcp_codex_base_url", ""));
    const [customModel, setCustomModel] = import_react40.default.useState(() => readPref("ae_mcp_custom_model", ""));
    const [model, setModel] = import_react40.default.useState(() => readPref("ae_mcp_model", DEFAULT_MODEL));
    const [logLevel, setLogLevel] = import_react40.default.useState(() => readPref("ae_mcp_log_level", "info"));
    const logLevelRef = import_react40.default.useRef(logLevel);
    logLevelRef.current = logLevel;
    const [sessionModel, setSessionModel] = import_react40.default.useState(null);
    const [sessionEffort, setSessionEffort] = import_react40.default.useState(null);
    const [sessionFast, setSessionFast] = import_react40.default.useState(null);
    const [permissionMode, setPermissionMode] = import_react40.default.useState(() => readPref("ae_mcp_perm_mode", "manual"));
    const backendMigration = import_react40.default.useMemo(() => migrateBackendPref(window.localStorage), []);
    const [backendPref, setBackendPref] = import_react40.default.useState(() => backendMigration.pref);
    const [channelLock, setChannelLock] = import_react40.default.useState(() => backendMigration.lockedChannel);
    const providerStore = import_react40.default.useMemo(() => {
      try {
        const store = createProviderStore();
        store.migrateLegacy({
          readKey: (name) => {
            try {
              return keyStore ? keyStore.readKey(name) : "";
            } catch (e) {
              return "";
            }
          },
          readPref: (key) => readPref(key, "")
        });
        return store;
      } catch (e) {
        return null;
      }
    }, [keyStore]);
    const [providers, setProviders] = import_react40.default.useState(() => providerStore ? providerStore.list() : []);
    const [claudeProviderId, setClaudeProviderId] = import_react40.default.useState(() => readPref("ae_mcp_claude_provider", ""));
    const [codexProviderId, setCodexProviderId] = import_react40.default.useState(() => readPref("ae_mcp_codex_provider", ""));
    const [expertGuidance, setExpertGuidance] = import_react40.default.useState(() => loadExpertGuidance(window.localStorage));
    const [probe, setProbe] = import_react40.default.useState(null);
    const [codexProbe, setCodexProbe] = import_react40.default.useState(null);
    const [codexModels, setCodexModels] = import_react40.default.useState(() => readCachedCodexModels(window.localStorage));
    const [zcodeProbe, setZcodeProbe] = import_react40.default.useState(null);
    const [zcodeSessionModels, setZcodeSessionModels] = import_react40.default.useState(null);
    const [zcodeProbedModels, setZcodeProbedModels] = import_react40.default.useState(() => readCachedZcodeProbedModels(window.localStorage));
    const [chatEntries, setChatEntries] = import_react40.default.useState([]);
    const [chatStreaming, setChatStreaming] = import_react40.default.useState(false);
    const [thinkingActive, setThinkingActive] = import_react40.default.useState(false);
    const customModelForBackend = backendPref === "codex" ? customModel : "";
    const baseDescriptor = import_react40.default.useMemo(() => descriptorWithCustomModel(baseDescriptorFor(backendPref, window.cep_node && window.cep_node.process && window.cep_node.process.env || {}), customModelForBackend), [backendPref, customModelForBackend]);
    const [descriptor, setDescriptor] = import_react40.default.useState(() => baseDescriptor);
    const requestedModel = sessionModel || model;
    const effectiveModel = descriptor.models.some((m) => m.id === requestedModel) ? requestedModel : descriptor.defaultModelId || descriptor.models[0] && descriptor.models[0].id || requestedModel;
    const modelMeta = descriptor.models.find((m) => m.id === effectiveModel) || descriptor.models[0] || {};
    const effectiveEffort = sessionEffort || (modelMeta.effortLevels && modelMeta.effortLevels.length ? descriptor.defaultEffort : null);
    const effectiveFast = Boolean(sessionFast && descriptor.supportsFast(effectiveModel));
    const claudeApiProvider = import_react40.default.useMemo(() => {
      const fromStore = providers.find((p) => p.id === claudeProviderId) || null;
      if (fromStore && fromStore.baseUrl && fromStore.apiKey) return fromStore;
      if (apiKey) return { id: "legacy-anthropic", name: "Claude API", protocol: "anthropic", baseUrl: anthropicBaseUrl || "https://api.anthropic.com", apiKey, probedModels: [], probedAt: 0 };
      return fromStore;
    }, [providers, claudeProviderId, apiKey, anthropicBaseUrl]);
    const codexCustomProvider = import_react40.default.useMemo(() => {
      const fromStore = providers.find((p) => p.id === codexProviderId) || null;
      if (fromStore && fromStore.baseUrl && fromStore.apiKey) return fromStore;
      if (codexBaseUrl) return { id: "legacy-codex", name: "Codex custom", protocol: "openai-compatible", baseUrl: codexBaseUrl, apiKey: codexApiKey, probedModels: [], probedAt: 0 };
      return fromStore;
    }, [providers, codexProviderId, codexBaseUrl, codexApiKey]);
    const [providerProbing, setProviderProbing] = import_react40.default.useState("");
    const [providerProbeErrors, setProviderProbeErrors] = import_react40.default.useState({});
    const ccSwitchFound = import_react40.default.useMemo(() => {
      try {
        return detectCcSwitch({ env: window.cep_node && window.cep_node.process && window.cep_node.process.env || {} });
      } catch (e) {
        return null;
      }
    }, []);
    const providerManager = /* @__PURE__ */ (0, import_jsx_runtime36.jsx)(
      ProviderManagerSection,
      {
        lang,
        providers,
        probing: providerProbing,
        probeErrors: providerProbeErrors,
        ccSwitch: ccSwitchFound,
        onImportCcSwitch: () => {
          if (!ccSwitchFound || !providerStore) return;
          for (const entry of ccSwitchFound.providers) providerStore.upsert(entry);
          setProviders(providerStore.list());
        },
        onUpsert: (entry) => {
          if (!providerStore) return;
          const existing = providerStore.get(entry.id);
          providerStore.upsert({ ...entry, probedModels: existing ? existing.probedModels : [], probedAt: existing ? existing.probedAt : 0 });
          setProviders(providerStore.list());
        },
        onRemove: (id) => {
          if (!providerStore) return;
          providerStore.remove(id);
          setProviders(providerStore.list());
          if (claudeProviderId === id) {
            setClaudeProviderId("");
            writePref("ae_mcp_claude_provider", "");
          }
          if (codexProviderId === id) {
            setCodexProviderId("");
            writePref("ae_mcp_codex_provider", "");
          }
        },
        onProbe: async (p) => {
          setProviderProbing(p.id);
          const result = await probeProviderModels({ baseUrl: p.baseUrl, apiKey: p.apiKey, protocol: p.protocol });
          setProviderProbing("");
          if (result.ok && providerStore) {
            providerStore.upsert({ ...p, probedModels: result.models, probedAt: Date.now() });
            setProviders(providerStore.list());
            setProviderProbeErrors((errs) => ({ ...errs, [p.id]: "" }));
          } else {
            setProviderProbeErrors((errs) => ({ ...errs, [p.id]: result.detail || "HTTP " + result.status }));
          }
        }
      }
    );
    const zcodeConfigSummary = import_react40.default.useMemo(() => {
      try {
        return summarizeZcodeConfig({ env: window.cep_node && window.cep_node.process && window.cep_node.process.env || {}, storedKey: (() => {
          try {
            return keyStore ? keyStore.readKey("zcode") : "";
          } catch (e) {
            return "";
          }
        })() });
      } catch (e) {
        return null;
      }
    }, [keyStore, zcodeProbe]);
    const codexCliConfigStableRef = import_react40.default.useRef(null);
    const codexCliConfig = import_react40.default.useMemo(() => {
      let next;
      try {
        next = readCodexCliConfig({ env: window.cep_node && window.cep_node.process && window.cep_node.process.env || {} });
      } catch (e) {
        next = null;
      }
      codexCliConfigStableRef.current = reconcileStableJsonValue(codexCliConfigStableRef.current, next);
      return codexCliConfigStableRef.current.value;
    }, [codexProbe]);
    const codexCliConfigApiKey = import_react40.default.useMemo(() => {
      const env = window.cep_node && window.cep_node.process && window.cep_node.process.env || {};
      const storedKey = (() => {
        try {
          return keyStore ? keyStore.readKey("codex") : "";
        } catch (e) {
          return "";
        }
      })();
      return resolveCodexProviderApiKey({ provider: codexCliConfig && codexCliConfig.provider, env, storedKey });
    }, [codexCliConfig, keyStore, codexApiKey]);
    const channels = import_react40.default.useMemo(() => ({
      claude: claudeChannels({ probe, apiProvider: claudeApiProvider }),
      codex: codexChannels({ codexProbe, customProvider: codexCustomProvider, cliConfig: codexCliConfig, cliConfigApiKey: codexCliConfigApiKey }),
      zcode: zcodeChannels({ zcodeProbe, configSummary: zcodeConfigSummary })
    }), [probe, claudeApiProvider, codexProbe, codexCustomProvider, zcodeProbe, zcodeConfigSummary, codexCliConfig, codexCliConfigApiKey]);
    const claudeSettingsHint = import_react40.default.useMemo(() => {
      try {
        return readClaudeSettingsEnv({ env: window.cep_node && window.cep_node.process && window.cep_node.process.env || {} });
      } catch (e) {
        return null;
      }
    }, []);
    const providerProfile = import_react40.default.useMemo(() => normalizeProviderProfile({
      anthropicBaseUrl: claudeApiProvider ? claudeApiProvider.baseUrl : anthropicBaseUrl,
      codexApiKey: codexCustomProvider ? codexCustomProvider.apiKey : codexApiKey,
      codexBaseUrl: codexCustomProvider ? codexCustomProvider.baseUrl : codexBaseUrl
    }), [claudeApiProvider, anthropicBaseUrl, codexCustomProvider, codexApiKey, codexBaseUrl]);
    const runtimeRef = import_react40.default.useRef({ apiKey, apiBaseUrl: providerProfile.anthropicBaseUrl, providerProfile, model: effectiveModel, permissionMode, effort: effectiveEffort, thinking: null, fast: effectiveFast, claudeChannel: "subscription", claudeApiProvider: null, codexCliConfigProvider: null });
    const extRoot = cs2 && cs2.getSystemPath ? cs2.getSystemPath("extension") : "";
    const sidecarPath = import_react40.default.useMemo(() => resolveSidecarPath({ extRoot }), [extRoot]);
    const mcp = import_react40.default.useMemo(() => createMcpClient({
      extRoot,
      getExpertGuidance: () => loadExpertGuidance(window.localStorage)
    }), [extRoot]);
    const handleChatEvent = import_react40.default.useCallback((evt) => {
      if (evt.type === "turn-start") setChatStreaming(true);
      if (evt.type === "thinking") setThinkingActive(!!evt.active);
      if (evt.type === "turn-end" || evt.type === "error") {
        setChatStreaming(false);
        setThinkingActive(false);
      }
      if (evt.type === "zcode-session-created") setZcodeSessionModels(evt.result || null);
      setChatEntries((entries) => reduceEvent(entries, evt));
    }, []);
    const byokLoop = import_react40.default.useMemo(() => {
      return createAgentLoop({
        getApiKey: () => runtimeRef.current.apiKey,
        getApiBaseUrl: () => runtimeRef.current.apiBaseUrl,
        getModel: () => runtimeRef.current.model,
        getPermissionMode: () => runtimeRef.current.permissionMode,
        getEffort: () => runtimeRef.current.effort,
        getFast: () => runtimeRef.current.fast,
        mcp,
        lang,
        onEvent: handleChatEvent
      });
    }, [mcp, handleChatEvent]);
    const claudeBackend = import_react40.default.useMemo(() => createClaudeAgentBackend({
      resolveNode: resolveSystemNode,
      sidecarPath,
      getMcpSpec: () => resolveMcpCommand({ extRoot }),
      getToolMeta: async () => deriveToolMeta(await mcp.listTools()),
      getModel: () => runtimeRef.current.model,
      getPermissionMode: () => runtimeRef.current.permissionMode,
      getEffort: () => runtimeRef.current.effort,
      getThinking: () => runtimeRef.current.thinking,
      getChannel: () => runtimeRef.current.claudeChannel || "subscription",
      getApiProvider: () => runtimeRef.current.claudeApiProvider || null,
      lang,
      onEvent: handleChatEvent
    }), [extRoot, sidecarPath, mcp, handleChatEvent]);
    const codexBackend = import_react40.default.useMemo(() => createCodexBackend({
      getMcpSpec: () => resolveMcpCommand({ extRoot }),
      getModel: () => runtimeRef.current.model,
      getPermissionMode: () => runtimeRef.current.permissionMode,
      getEffort: () => runtimeRef.current.effort,
      getFast: () => runtimeRef.current.fast,
      getToolMeta: async () => deriveToolMeta(await mcp.listTools()),
      getExpertGuidance: () => loadExpertGuidance(window.localStorage),
      getServerInstructions: () => mcp.getServerInstructions(),
      getProviderProfile: () => runtimeRef.current.providerProfile,
      getCliConfigProvider: () => runtimeRef.current.codexCliConfigProvider,
      lang,
      env: { AE_MCP_PANEL_EXT_ROOT: extRoot },
      onEvent: handleChatEvent
    }), [extRoot, mcp, handleChatEvent]);
    import_react40.default.useEffect(() => () => {
      codexBackend.reset();
    }, [codexBackend]);
    const openCodeBackend = import_react40.default.useMemo(() => createOpenCodeBackend({
      getMcpSpec: () => resolveMcpCommand({ extRoot }),
      getModel: () => runtimeRef.current.model,
      getPermissionMode: () => runtimeRef.current.permissionMode,
      getToolMeta: async () => deriveToolMeta(await mcp.listTools()),
      getExpertGuidance: () => loadExpertGuidance(window.localStorage),
      env: { AE_MCP_PANEL_EXT_ROOT: extRoot },
      onEvent: handleChatEvent
    }), [extRoot, mcp, handleChatEvent]);
    const zcodeBackend = import_react40.default.useMemo(() => createZcodeBackend({
      getMcpSpec: () => resolveMcpCommand({ extRoot }),
      getModel: () => runtimeRef.current.model,
      getPermissionMode: () => runtimeRef.current.permissionMode,
      getEffort: () => runtimeRef.current.effort,
      getToolMeta: async () => deriveToolMeta(await mcp.listTools()),
      getExpertGuidance: () => loadExpertGuidance(window.localStorage),
      getServerInstructions: () => mcp.getServerInstructions(),
      env: { AE_MCP_PANEL_EXT_ROOT: extRoot },
      onEvent: handleChatEvent
    }), [extRoot, mcp, handleChatEvent]);
    import_react40.default.useEffect(() => () => {
      zcodeBackend.reset();
    }, [zcodeBackend]);
    const nodeOk = !(probe && probe.nodeOk === false);
    const effective = pickBackend({ pref: backendPref, channels, lockedChannel: channelLock, nodeOk });
    runtimeRef.current = {
      apiKey: claudeApiProvider ? claudeApiProvider.apiKey : apiKey,
      apiBaseUrl: providerProfile.anthropicBaseUrl,
      providerProfile,
      model: effectiveModel,
      permissionMode,
      effort: effectiveEffort,
      thinking: modelMeta.adaptive === true ? "adaptive" : null,
      fast: effectiveFast,
      claudeChannel: effective.backend === "claude-api" ? "api" : "subscription",
      claudeApiProvider,
      codexCliConfigProvider: codexCliConfig && codexCliConfig.provider ? { provider: codexCliConfig.provider, apiKey: codexCliConfigApiKey } : null
    };
    const backendInstances = { subscription: claudeBackend, "claude-api": claudeBackend, byok: byokLoop, codex: codexBackend, opencode: openCodeBackend, zcode: zcodeBackend };
    const activeBackend = backendInstances[effective.backend] || byokLoop;
    import_react40.default.useEffect(() => {
      let alive = true;
      const facts = {
        effectiveBackend: effective.backend,
        backendPref,
        baseDescriptor,
        customModel,
        claudeApiProvider,
        codexCustomProvider,
        byokApiModels: null,
        codexCachedModels: codexModels || readCachedCodexModels(window.localStorage),
        zcodeSessionModels,
        zcodeProbedModels
      };
      const nextDescriptor = selectDescriptor(facts);
      setDescriptor(nextDescriptor);
      const isCustomModelPath = backendPref === "codex" && customModelForBackend && model === customModelForBackend;
      const reconciled = reconcileModelPref(model, nextDescriptor, { isCustom: isCustomModelPath });
      if (reconciled !== model) {
        setModel(reconciled);
        writePref("ae_mcp_model", reconciled);
      }
      const hasProbed = Boolean(claudeApiProvider && claudeApiProvider.probedModels && claudeApiProvider.probedModels.length);
      const claudeKey = claudeApiProvider ? claudeApiProvider.apiKey : apiKey;
      if (isClaudeApiBackend(effective.backend) && claudeKey && !hasProbed) {
        cachedByokModels({ apiKey: claudeKey, baseUrl: claudeApiProvider ? claudeApiProvider.baseUrl : anthropicBaseUrl }).then((list) => {
          if (alive) setDescriptor(selectDescriptor({ ...facts, byokApiModels: list }));
        }).catch(() => {
        });
      }
      return () => {
        alive = false;
      };
    }, [effective.backend, backendPref, baseDescriptor, customModel, claudeApiProvider, codexCustomProvider, codexModels, apiKey, anthropicBaseUrl, zcodeSessionModels, zcodeProbedModels]);
    const activeBackendRef = import_react40.default.useRef(null);
    import_react40.default.useEffect(() => {
      if (backendPref !== "zcode") return void 0;
      const sessionAvailable = zcodeSessionModels && zcodeSessionModels.settings && zcodeSessionModels.settings.model && Array.isArray(zcodeSessionModels.settings.model.available) ? zcodeSessionModels.settings.model.available : [];
      if (sessionAvailable.length > 1) return void 0;
      const cli = zcodeConfigSummary && zcodeConfigSummary.cli;
      if (!cli || !cli.model || !cli.baseUrl || !cli.hasCredential) return void 0;
      const cached = readCachedZcodeProbedModels(window.localStorage);
      if (cached && cached.cliModel === cli.model) {
        const same = zcodeProbedModels && zcodeProbedModels.cliModel === cached.cliModel && Array.isArray(zcodeProbedModels.probedModels) && zcodeProbedModels.probedModels.length === cached.probedModels.length;
        if (!same) setZcodeProbedModels(cached);
        return void 0;
      }
      let alive = true;
      const providerId = cli.providerId || "";
      const apiKeyValue = (() => {
        try {
          return keyStore ? keyStore.readKey("zcode") : "";
        } catch (e) {
          return "";
        }
      })();
      probeProviderModels({ baseUrl: cli.baseUrl, apiKey: apiKeyValue, protocol: cli.protocol }).then((result) => {
        if (!alive) return;
        if (result.ok && result.models && result.models.length) {
          const entry = { cliModel: cli.model, providerId, probedModels: result.models };
          writeCachedZcodeProbedModels(window.localStorage, entry);
          setZcodeProbedModels(entry);
        }
      }).catch(() => {
      });
      return () => {
        alive = false;
      };
    }, [backendPref, zcodeSessionModels, zcodeConfigSummary, keyStore]);
    const runClaudeProbe = import_react40.default.useCallback(() => {
      let alive = true;
      setProbe(null);
      probeClaudeLogin({
        resolveNode: resolveSystemNode,
        sidecarPath
      }).then((result) => {
        if (alive) setProbe(result);
      }).catch((e) => {
        if (alive) setProbe({ loggedIn: false, nodeOk: false, detail: e && e.message ? e.message : String(e) });
      });
      return () => {
        alive = false;
      };
    }, [sidecarPath]);
    import_react40.default.useEffect(() => {
      if (backendPref !== "subscription") return void 0;
      return runClaudeProbe();
    }, [backendPref, runClaudeProbe]);
    const runCodexProbe = import_react40.default.useCallback(() => {
      let alive = true;
      setCodexProbe(null);
      codexBackend.probeAccount().then((result) => {
        if (!alive) return;
        setCodexProbe(result);
        if (result && Array.isArray(result.models)) {
          setCodexModels(result.models);
          writeCachedCodexModels(window.localStorage, result.models);
        }
      }).catch((e) => {
        if (alive) setCodexProbe({ loggedIn: false, detail: e && e.message ? e.message : String(e) });
      });
      return () => {
        alive = false;
      };
    }, [codexBackend]);
    import_react40.default.useEffect(() => {
      if (backendPref !== "codex") return void 0;
      return runCodexProbe();
    }, [backendPref, runCodexProbe]);
    import_react40.default.useEffect(() => {
      if (backendPref !== "codex") return void 0;
      if (!codexCliConfig || !codexCliConfig.provider || !codexCliConfigApiKey) return void 0;
      if (codexCustomProvider && codexCustomProvider.baseUrl) return void 0;
      if (codexModels && codexModels.length > 1) return void 0;
      let alive = true;
      probeProviderModels({ baseUrl: codexCliConfig.provider.baseUrl, apiKey: codexCliConfigApiKey, protocol: "openai-compatible" }).then((result) => {
        if (!alive) return;
        if (result.ok && result.models && result.models.length) {
          setCodexModels(result.models);
          writeCachedCodexModels(window.localStorage, result.models);
        }
      }).catch(() => {
      });
      return () => {
        alive = false;
      };
    }, [backendPref, codexCliConfig, codexCliConfigApiKey, codexCustomProvider, codexModels]);
    const runZcodeProbe = import_react40.default.useCallback(() => {
      let alive = true;
      setZcodeProbe(null);
      zcodeBackend.probeAccount().then((result) => {
        if (alive) setZcodeProbe(result);
      }).catch((e) => {
        if (alive) setZcodeProbe({ loggedIn: false, detail: e && e.message ? e.message : String(e) });
      });
      return () => {
        alive = false;
      };
    }, [zcodeBackend]);
    import_react40.default.useEffect(() => {
      if (backendPref !== "zcode") return void 0;
      return runZcodeProbe();
    }, [backendPref, runZcodeProbe]);
    import_react40.default.useEffect(() => {
      if (effective.backend !== "zcode" || !effectiveEffort) return;
      zcodeBackend.setThoughtLevel(effectiveEffort);
    }, [effective.backend, effectiveEffort, zcodeBackend]);
    import_react40.default.useEffect(() => {
      const decision = shouldResetOnBackendChange(activeBackendRef.current, effective.backend);
      activeBackendRef.current = decision.nextReal;
      if (!decision.reset) return;
      byokLoop.reset();
      claudeBackend.reset();
      codexBackend.reset();
      openCodeBackend.reset();
      zcodeBackend.reset();
      setChatEntries([]);
      setChatStreaming(false);
      setSessionModel(null);
      setSessionEffort(null);
      setSessionFast(null);
      if (decision.nextReal !== "zcode") setZcodeSessionModels(null);
    }, [effective.backend, byokLoop, claudeBackend, codexBackend, openCodeBackend, zcodeBackend]);
    const sendChat = (text) => {
      const trimmed = String(text || "").trim();
      if (!trimmed) return;
      setChatEntries((entries) => entries.concat({ id: `user-${Date.now()}`, type: "user-text", text: trimmed }));
      activeBackend.sendUser(trimmed);
    };
    const newChatSession = () => {
      activeBackend.reset();
      setChatStreaming(false);
      setChatEntries([]);
    };
    const pushLog = import_react40.default.useCallback((m) => {
      if (!keepLogLine(logLevelRef.current, m)) return;
      setLogs((xs) => [...xs.slice(-199), `[${(/* @__PURE__ */ new Date()).toLocaleTimeString()}] ${m}`]);
    }, []);
    const exportLogs = import_react40.default.useCallback(() => {
      try {
        const text = buildLogExport({
          panelLogs: logs,
          hostInfo: { hostVersion: connInfo && connInfo.hostVersion || "-", pythonVersion: connInfo && connInfo.pythonVersion || "-" },
          sidecarTail: claudeBackend.getStderrTail ? claudeBackend.getStderrTail() : "",
          version: pkgVersion
        });
        const file = writeLogExport({ text, fileName: exportFileName() });
        revealInExplorer(file, void 0, (err) => pushLog("Log export reveal failed: " + (err && err.message ? err.message : String(err))));
        pushLog("Log exported: " + file);
      } catch (e) {
        pushLog("Log export failed: " + (e && e.message ? e.message : String(e)));
      }
    }, [logs, connInfo, claudeBackend, pushLog]);
    const undoToPreviousCheckpoint = import_react40.default.useCallback(async () => {
      try {
        await revertToPreviousCheckpoint(mcp);
        pushLog("Reverted to previous checkpoint");
      } catch (e) {
        pushLog("Checkpoint revert failed: " + (e && e.message ? e.message : String(e)));
      }
    }, [mcp, pushLog]);
    import_react40.default.useEffect(() => {
      const port = loadSavedPort(window.localStorage) || DEFAULT_PORT;
      ctrl.current = createHostController({
        cs: cs2,
        onStatus: (state, p, error) => {
          setStatus({ state, port: p, error: error || null });
          if (state === "ok") {
            savePort(window.localStorage, p);
            pushLog("Host ready on 127.0.0.1:" + p);
          }
          if (state === "error") pushLog("Error: " + (error || "unknown"));
        },
        onLog: pushLog
      });
      ctrl.current.start(port);
    }, [cs2, pushLog]);
    import_react40.default.useEffect(() => {
      if (!drawerOpen) return void 0;
      const update = () => {
        const h = getHost();
        if (h && h.getConnectionInfo) setConnInfo(h.getConnectionInfo());
      };
      update();
      const i = setInterval(update, 3e3);
      return () => clearInterval(i);
    }, [drawerOpen, getHost]);
    import_react40.default.useEffect(() => {
      if (tab !== "settings") return void 0;
      const update = () => {
        const h = getHost();
        if (h && h.getClients) setClients(h.getClients());
        if (h && h.getConnectionInfo) setConnInfo(h.getConnectionInfo());
      };
      update();
      const i = setInterval(update, 4e3);
      return () => clearInterval(i);
    }, [tab, getHost]);
    const runDiag = import_react40.default.useCallback(async () => {
      setDiagnostics("running");
      try {
        const items = await runDiagnostics({
          getHost,
          port: status.port,
          fs: cepRequire4("fs"),
          os: cepRequire4("os"),
          fetchImpl: window.fetch.bind(window)
        });
        setDiagnostics(items);
      } catch (e) {
        setDiagnostics([{ id: "host-listening", ok: false, detail: String(e && e.message), fixHint: { zh: "\u8BCA\u65AD\u6267\u884C\u5931\u8D25\uFF0C\u91CD\u542F\u9762\u677F\u540E\u91CD\u8BD5\u3002", en: "Diagnostics failed to run; reload the panel and retry." } }]);
      }
    }, [getHost, status.port]);
    const togglePause = () => {
      const host = getHost();
      if (!host || typeof host.setPaused !== "function") {
        pushLog("Pause unavailable: host not running");
        return;
      }
      const next = !paused;
      host.setPaused(next);
      setPaused(next);
      pushLog(next ? "Paused: /exec is blocked" : "Resumed");
    };
    const applyPort = (p) => {
      const port = parseInt(p, 10);
      if (!isValidPort(port)) {
        setStatus((s) => ({ ...s, state: "error", error: "Invalid port" }));
        pushLog("Invalid port");
        return;
      }
      if (ctrl.current) ctrl.current.restart(port);
    };
    const finishWizard = () => {
      markWizardDone(window.localStorage);
      setWizardDone(true);
    };
    const mcpConfigStr = JSON.stringify(buildMcpConfig(status.port, expertGuidance), null, 2);
    const claudeStatus = probe === null ? { state: "checking" } : probe.nodeOk === false ? { state: "no-node", detail: probe.detail } : probe.loggedIn === false ? { state: "not-logged-in", detail: probe.detail } : { state: "ready", nodeVersion: probe.nodeVersion };
    const wizard = useWizardWiring({ extRoot, lang, claudeStatus, recheckLogin: runClaudeProbe });
    if (!wizardDone) {
      return /* @__PURE__ */ (0, import_jsx_runtime36.jsx)(
        WizardScreen,
        {
          step: wizStep,
          lang,
          onLangChange: setLang,
          client: wizClient,
          onClient: setWizClient,
          clientName: (CLIENT_NAMES[wizClient] || CLIENT_NAMES["claude-desktop"])[lang],
          mcpConfig: mcpConfigStr,
          port: status.port,
          expertGuidance,
          channels,
          activeChannel: effective.channel || "",
          onNext: () => setWizStep((s) => Math.min(3, s + 1)),
          onBack: () => setWizStep((s) => Math.max(1, s - 1)),
          onCopy: (text) => copyWizardConfig(copyText, mcpConfigStr, text),
          onDone: finishWizard,
          onSkip: finishWizard,
          ...wizard.props
        }
      );
    }
    const statusForBar = paused ? "paused" : status.state === "ok" ? "connected" : status.state === "starting" ? "waiting" : "error";
    const tabs = [
      { id: "chat", icon: "message-square", label: t.chat },
      { id: "activity", icon: "list-checks", label: t.activity },
      { id: "settings", icon: "settings", label: t.settings }
    ];
    const backendDisabledHint = effective.fixHint && (effective.fixHint[lang] || effective.fixHint.zh) || (effective.reason && effective.reason.endsWith("-probing") ? lang === "zh" ? "\u6B63\u5728\u68C0\u6D4B\u51ED\u636E\u901A\u9053\u2026" : "Checking credential channels\u2026" : "");
    const composerDisabled = paused || effective.backend === "none";
    const modelOptions = descriptor.models.map((m) => ({ value: m.id, label: `${m.label} ${costBadge(m.cost)}` }));
    return /* @__PURE__ */ (0, import_jsx_runtime36.jsxs)(import_react40.default.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime36.jsx)(
        StatusBar,
        {
          status: statusForBar,
          label: paused ? t.paused : status.state === "ok" ? `${t.connected} \xB7 127.0.0.1:${status.port}` : status.state === "error" ? `${t.error} \xB7 ${status.error || ""}` : t.starting,
          onStatusClick: () => {
            setDrawerOpen(true);
          },
          onTogglePause: togglePause,
          onSettings: () => setTab("settings"),
          pauseTitle: t.pauseAll,
          resumeTitle: t.resume,
          settingsTitle: t.settings
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime36.jsxs)("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }, children: [
        tab === "chat" ? /* @__PURE__ */ (0, import_jsx_runtime36.jsx)(
          ChatScreen,
          {
            lang,
            entries: chatEntries,
            streaming: chatStreaming,
            thinking: thinkingActive,
            composerDisabled,
            disabledHint: paused ? t.pausedHint : composerDisabled ? backendDisabledHint : "",
            noticeActionLabel: paused ? t.resume : t.goSettings,
            onNoticeAction: () => paused ? togglePause() : setTab("settings"),
            onSend: sendChat,
            onStop: () => activeBackend.stop(),
            onApprove: (id, decision) => activeBackend.approve(id, decision),
            onNewSession: newChatSession,
            chipState: {
              descriptor,
              modelId: effectiveModel,
              effort: effectiveEffort,
              fast: effectiveFast,
              permissionMode
            },
            onChipModel: setSessionModel,
            onChipEffort: setSessionEffort,
            onChipFast: (v) => setSessionFast(Boolean(v)),
            onChipApproval: (m) => {
              setPermissionMode(m);
              writePref("ae_mcp_perm_mode", m);
            }
          }
        ) : null,
        tab === "activity" ? /* @__PURE__ */ (0, import_jsx_runtime36.jsx)(
          ActivityScreen,
          {
            events,
            lang,
            onClear: clear,
            onUndoCheckpoint: undoToPreviousCheckpoint,
            emptyTitle: t.actEmptyT,
            emptyCaption: t.actEmptyB
          }
        ) : null,
        tab === "settings" ? /* @__PURE__ */ (0, import_jsx_runtime36.jsx)(
          SettingsScreen,
          {
            lang,
            onLangChange: setLang,
            port: status.port,
            onApplyPort: applyPort,
            mcpConfig: mcpConfigStr,
            logs,
            clients,
            onBlockClient: (label, v) => {
              const h = getHost();
              if (h && h.setClientBlocked) {
                h.setClientBlocked(label, v);
                if (h.getClients) setClients(h.getClients());
                pushLog((v ? "Blocked client: " : "Unblocked client: ") + label);
              }
            },
            onRegenToken: () => setConfirmRegen(true),
            hostVersion: connInfo && connInfo.hostVersion || "-",
            pythonVersion: connInfo && connInfo.pythonVersion || "-",
            channels,
            activeChannel: effective.channel || "",
            lockedChannel: channelLock,
            onLockChannel: (c) => {
              setChannelLock(c);
              writePref("ae_mcp_channel_lock", c);
            },
            onRecheckBackend: () => {
              if (backendPref === "codex") runCodexProbe();
              else if (backendPref === "zcode") runZcodeProbe();
              else runClaudeProbe();
            },
            recheckDisabled: backendPref === "codex" ? codexProbe === null : backendPref === "zcode" ? zcodeProbe === null : probe === null,
            providers,
            providerManager,
            claudeProviderId,
            onClaudeProviderChange: (id) => {
              setClaudeProviderId(id);
              writePref("ae_mcp_claude_provider", id);
            },
            codexProviderId,
            onCodexProviderChange: (id) => {
              setCodexProviderId(id);
              writePref("ae_mcp_codex_provider", id);
              setCodexProbe(null);
              codexBackend.reset();
            },
            claudeSettingsImportAvailable: Boolean(claudeSettingsHint),
            onImportClaudeSettings: () => {
              if (!claudeSettingsHint || !providerStore) return;
              const entry = providerStore.upsert({ id: "claude-settings-import", name: "Claude Code \u914D\u7F6E", protocol: "anthropic", baseUrl: claudeSettingsHint.baseUrl, apiKey: claudeSettingsHint.authToken });
              setProviders(providerStore.list());
              setClaudeProviderId(entry.id);
              writePref("ae_mcp_claude_provider", entry.id);
            },
            onSaveZcodeKey: (k) => {
              if (keyStore) keyStore.writeKey(k, "zcode");
              setZcodeProbe(null);
              zcodeBackend.reset();
              runZcodeProbe();
            },
            zcodeKeyStored: (() => {
              try {
                return Boolean(keyStore && keyStore.readKey("zcode"));
              } catch (e) {
                return false;
              }
            })(),
            onSaveCodexKey: (k) => {
              if (keyStore) keyStore.writeKey(k, "codex");
              setCodexApiKey(k);
              setCodexProbe(null);
              codexBackend.reset();
              runCodexProbe();
            },
            codexKeyStored: Boolean(codexApiKey),
            codexCliConfig,
            model: effectiveModel,
            modelOptions,
            modelSwitchable: descriptor.perTurnModelSwitch !== false,
            onModelChange: (m) => {
              setModel(m);
              writePref("ae_mcp_model", m);
            },
            customModel,
            onCustomModelChange: (m) => {
              setCustomModel(m);
              writePref("ae_mcp_custom_model", m);
              if (String(m || "").trim()) {
                setModel(String(m || "").trim());
                writePref("ae_mcp_model", String(m || "").trim());
              }
            },
            backend: backendPref,
            onBackendChange: (m) => {
              setBackendPref(m);
              writePref("ae_mcp_backend", m);
            },
            expertGuidance,
            onExpertGuidance: (v) => {
              setExpertGuidance(v);
              saveExpertGuidance(window.localStorage, v);
            },
            logLevel,
            onLogLevel: (v) => {
              setLogLevel(v);
              writePref("ae_mcp_log_level", v);
            },
            onExportLogs: exportLogs,
            onRerunWizard: () => {
              clearWizardDone(window.localStorage);
              setWizStep(1);
              setWizardDone(false);
            }
          },
          tokenEpoch
        ) : null
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime36.jsx)(TabBar, { tabs, active: tab, onChange: setTab }),
      /* @__PURE__ */ (0, import_jsx_runtime36.jsx)(
        ConnectionDrawer,
        {
          open: drawerOpen,
          onClose: () => setDrawerOpen(false),
          lang,
          info: connInfo || {},
          diagnostics: Array.isArray(diagnostics) ? diagnostics : [],
          onDiagnose: runDiag,
          onCopyConfig: () => copyText(mcpConfigStr),
          onRestart: () => applyPort(status.port)
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime36.jsx)(
        ConfirmDialog,
        {
          open: confirmRegen,
          danger: true,
          title: t.regenTitle,
          body: t.regenBody,
          confirmLabel: t.regenConfirm,
          cancelLabel: t.cancel,
          onCancel: () => setConfirmRegen(false),
          onConfirm: () => {
            const h = getHost();
            if (h && h.regenerateToken) {
              h.regenerateToken((err) => {
                pushLog(err ? "Token regeneration failed: " + err.message : "Token regenerated");
              });
            }
            setConfirmRegen(false);
            setTokenEpoch((n) => n + 1);
          }
        }
      )
    ] });
  }
  function App({ cs: cs2 }) {
    return /* @__PURE__ */ (0, import_jsx_runtime36.jsx)(LangProvider, { children: /* @__PURE__ */ (0, import_jsx_runtime36.jsx)(Shell, { cs: cs2 }) });
  }

  // src/main.jsx
  var import_jsx_runtime37 = __toESM(require_jsx_runtime(), 1);
  var cs = new window.CSInterface();
  (0, import_client.createRoot)(document.getElementById("root")).render(/* @__PURE__ */ (0, import_jsx_runtime37.jsx)(App, { cs }));
})();
/*! Bundled license information:

react/cjs/react.production.min.js:
  (**
   * @license React
   * react.production.min.js
   *
   * Copyright (c) Facebook, Inc. and its affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)

scheduler/cjs/scheduler.production.min.js:
  (**
   * @license React
   * scheduler.production.min.js
   *
   * Copyright (c) Facebook, Inc. and its affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)

react-dom/cjs/react-dom.production.min.js:
  (**
   * @license React
   * react-dom.production.min.js
   *
   * Copyright (c) Facebook, Inc. and its affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)

react/cjs/react-jsx-runtime.production.min.js:
  (**
   * @license React
   * react-jsx-runtime.production.min.js
   *
   * Copyright (c) Facebook, Inc. and its affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/shared/src/utils.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/defaultAttributes.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/Icon.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/createLucideIcon.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/arrow-up.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/book-open.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/box.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/brain.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/check.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/chevron-down.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/chevron-right.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/circle-alert.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/circle-slash.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/circle.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/copy.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/download.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/external-link.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/eye-off.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/eye.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/file-text.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/github.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/globe.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/history.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/info.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/list-checks.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/list.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/message-square.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/pause.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/play.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/plug.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/plus.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/rotate-cw.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/search.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/send.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/settings.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/shield-alert.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/shield.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/sparkles.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/square.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/stethoscope.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/trash-2.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/triangle-alert.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/undo-2.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/x.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/icons/zap.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)

lucide-react/dist/esm/lucide-react.js:
  (**
   * @license lucide-react v0.453.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)
*/
