// ae-mcp runtime helpers loaded by the panel at startup.
// Provides a JSON polyfill for AE's classic ExtendScript engine, which
// doesn't have native JSON. AE 2026's modern engine does, but CEP panels
// may run script in classic mode in some contexts.
if (typeof JSON === 'undefined') {
    JSON = {};
}
if (typeof JSON === 'undefined' || typeof JSON.stringify !== 'function') {
    JSON.stringify = function (v) {
        if (v === null) return 'null';
        if (typeof v === 'undefined') return 'null';
        if (typeof v === 'boolean') return v ? 'true' : 'false';
        if (typeof v === 'number') return isFinite(v) ? String(v) : 'null';
        if (typeof v === 'string') {
            return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
                         .replace(/\n/g, '\\n').replace(/\r/g, '\\r')
                         .replace(/\t/g, '\\t') + '"';
        }
        if (v instanceof Array) {
            var parts = [];
            for (var i = 0; i < v.length; i++) parts.push(JSON.stringify(v[i]));
            return '[' + parts.join(',') + ']';
        }
        if (typeof v === 'object') {
            var parts2 = [];
            for (var k in v) {
                if (v.hasOwnProperty(k)) {
                    parts2.push(JSON.stringify(k) + ':' + JSON.stringify(v[k]));
                }
            }
            return '{' + parts2.join(',') + '}';
        }
        return 'null';
    };
}
// JSON.parse polyfill for the classic engine. AE 2026's modern engine has a
// native JSON.parse, so this is guarded to a no-op there. Agent ae.exec code
// that calls JSON.parse would otherwise throw on the classic engine. #12
//
// eval-with-validation approach: the source is first vetted against the
// security regex from Crockford's json2.js (which rejects anything that isn't
// well-formed JSON) so eval can only ever produce a JSON value, never run
// arbitrary code. ES3-safe: var/function only.
if (typeof JSON === 'undefined' || typeof JSON.parse !== 'function') {
    JSON.parse = function (text) {
        var src = String(text);
        // The four-stage check is the standard json2.js guard:
        //   1. replace JSON escapes with '@'
        //   2. replace literals/numbers with ']'
        //   3. delete commas/brackets between those tokens
        //   4. what remains must be empty for the text to be valid JSON
        var cleaned = src
            .replace(/\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g, '@')
            .replace(/"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g, ']')
            .replace(/(?:^|:|,)(?:\s*\[)+/g, '');
        if (!(/^[\],:{}\s]*$/.test(cleaned))) {
            throw new SyntaxError('JSON.parse: invalid JSON');
        }
        return eval('(' + src + ')');
    };
}

// ---------------------------------------------------------------------------
// ES3 Array / Object polyfills.
//
// AE's classic ExtendScript engine is ECMAScript 3-era and lacks the Array
// iteration methods and Object.keys/values/entries that agent-authored JSX
// (sent through ae.exec / ae.readProps) routinely reaches for. Each polyfill
// is guarded with an if-not-present check so it is a no-op on AE 2026's modern
// engine and safe to re-run on panel re-init. Keep everything ES3: var only,
// function keyword, no arrow/const/let.
//
// Additions are installed NON-ENUMERABLE via Object.defineProperty so that
// third-party scripts doing `for (var k in arr)` don't suddenly see the
// polyfilled method names as keys (prototype-pollution hazard). Some ancient
// engines throw when defineProperty is used on native prototypes, so the
// helper wraps it in try/catch and falls back to a plain (enumerable)
// assignment only when defineProperty is unavailable or fails. #12
//
// This file loads ONCE into the persistent engine (manifest ScriptPath), so a
// syntax error here breaks EVERY verb. Edit with care.
// ---------------------------------------------------------------------------

// Define `name` on `proto` non-enumerably when possible; plain-assign otherwise.
function _definePoly(proto, name, fn) {
    var defined = false;
    if (typeof Object.defineProperty === 'function') {
        try {
            Object.defineProperty(proto, name, {
                value: fn, enumerable: false, writable: true, configurable: true
            });
            defined = true;
        } catch (e) { defined = false; }
    }
    if (!defined) { proto[name] = fn; }
}

if (!Array.prototype.indexOf) {
    _definePoly(Array.prototype, 'indexOf', function (needle, from) {
        var len = this.length >>> 0;
        var i = from ? Number(from) : 0;
        if (i < 0) i = Math.max(0, len + i);
        for (; i < len; i++) {
            if (i in this && this[i] === needle) return i;
        }
        return -1;
    });
}
if (!Array.prototype.forEach) {
    _definePoly(Array.prototype, 'forEach', function (fn, thisArg) {
        var len = this.length >>> 0;
        for (var i = 0; i < len; i++) {
            if (i in this) fn.call(thisArg, this[i], i, this);
        }
    });
}
if (!Array.prototype.map) {
    _definePoly(Array.prototype, 'map', function (fn, thisArg) {
        var len = this.length >>> 0;
        var out = new Array(len);
        for (var i = 0; i < len; i++) {
            if (i in this) out[i] = fn.call(thisArg, this[i], i, this);
        }
        return out;
    });
}
if (!Array.prototype.filter) {
    _definePoly(Array.prototype, 'filter', function (fn, thisArg) {
        var len = this.length >>> 0;
        var out = [];
        for (var i = 0; i < len; i++) {
            if (i in this && fn.call(thisArg, this[i], i, this)) out.push(this[i]);
        }
        return out;
    });
}
if (!Array.prototype.reduce) {
    _definePoly(Array.prototype, 'reduce', function (fn, init) {
        var len = this.length >>> 0;
        var i = 0, acc;
        if (arguments.length >= 2) {
            acc = init;
        } else {
            while (i < len && !(i in this)) i++;
            acc = this[i++];
        }
        for (; i < len; i++) {
            if (i in this) acc = fn(acc, this[i], i, this);
        }
        return acc;
    });
}
if (!Array.prototype.some) {
    _definePoly(Array.prototype, 'some', function (fn, thisArg) {
        var len = this.length >>> 0;
        for (var i = 0; i < len; i++) {
            if (i in this && fn.call(thisArg, this[i], i, this)) return true;
        }
        return false;
    });
}
if (!Array.prototype.every) {
    _definePoly(Array.prototype, 'every', function (fn, thisArg) {
        var len = this.length >>> 0;
        for (var i = 0; i < len; i++) {
            if (i in this && !fn.call(thisArg, this[i], i, this)) return false;
        }
        return true;
    });
}
if (!Array.prototype.includes) {
    _definePoly(Array.prototype, 'includes', function (needle) {
        return this.indexOf(needle) !== -1;
    });
}
if (!Array.isArray) {
    Array.isArray = function (o) {
        return Object.prototype.toString.call(o) === '[object Array]';
    };
}
if (!Object.keys) {
    Object.keys = function (obj) {
        var keys = [];
        for (var k in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, k)) keys.push(k);
        }
        return keys;
    };
}
if (!Object.values) {
    Object.values = function (obj) {
        var vals = [];
        for (var k in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, k)) vals.push(obj[k]);
        }
        return vals;
    };
}
if (!Object.entries) {
    Object.entries = function (obj) {
        var ents = [];
        for (var k in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, k)) ents.push([k, obj[k]]);
        }
        return ents;
    };
}

// AEMCP-HELPERS-BEGIN — verbatim copy lives in packages/core/ae_mcp/jsx_templates/_aemcp_prelude.jsx; keep both in sync (enforced by test_jsx_prelude.py)
// ---------------------------------------------------------------------------
// AEMCP helper namespace.
//
// A single source of truth for the targeting + property-resolution idioms
// every JSX template would otherwise re-implement. Loaded once into the
// persistent engine, so agent-authored ae.exec / ae.readProps scripts can
// call these directly. All helpers are defensive: they return null (never
// throw) on bad input, honouring the "JSX must never throw" invariant.
// ---------------------------------------------------------------------------
if (typeof AEMCP === 'undefined') { AEMCP = {}; }

AEMCP.version = '0.2.0';

// Map a property value to something JSON.stringify can serialize, never
// throwing. TextDocument flattens to its .text string BEFORE the generic
// object path (stringifying a TextDocument touches box-text-only getters that
// throw on point text, and point/box text should yield the same shape).
// Primitives pass through; arrays recurse; other host objects (Shape,
// KeyframeEase, ...) are kept as-is when a stringify probe succeeds, else
// degrade to String(v), else null. Uncaught throws must never escape a
// template: AE 2026 surfaces them as EMPTY evalScript output (not the
// "EvalScript error." sentinel), which callers see as "returned no value".
AEMCP.safeValue = function (v) {
    if (v === null || typeof v === 'undefined') return null;
    var t = typeof v;
    if (t === 'number' || t === 'boolean' || t === 'string') return v;
    try {
        if (typeof TextDocument !== 'undefined' && v instanceof TextDocument) {
            return String(v.text);
        }
    } catch (eTd) {}
    if (v instanceof Array) {
        var out = [];
        for (var i = 0; i < v.length; i++) {
            try { out.push(AEMCP.safeValue(v[i])); } catch (eEl) { out.push(null); }
        }
        return out;
    }
    if (t === 'object') {
        try { JSON.stringify(v); return v; } catch (eProbe) {}
        try { return String(v); } catch (eStr) {}
        return null;
    }
    try { return String(v); } catch (eOther) {}
    return null;
};

// Count of a node's child properties, or -1 when `node` is a leaf Property /
// not a group. try/catch shields against leaf nodes that lack numProperties.
AEMCP._numProps = function (node) {
    var n;
    try { n = node.numProperties; } catch (e) { return -1; }
    return (typeof n === 'number') ? n : -1;
};

// Resolve a CompItem by AE item id, or null when the id isn't a comp.
// itemByID throws "Item Not Found" on an unknown id (AE 26.2+) rather than
// returning null, so guard it to honour the never-throw invariant.
AEMCP.compById = function (id) {
    var it;
    try { it = app.project.itemByID(id); } catch (e) { return null; }
    return (it && it instanceof CompItem) ? it : null;
};

// The active comp, or null when the foreground item isn't a comp.
AEMCP.activeComp = function () {
    var it = app.project.activeItem;
    return (it && it instanceof CompItem) ? it : null;
};

// A layer by 1-based index within a comp, or null.
AEMCP.layerById = function (comp, idx) {
    if (!comp) return null;
    try { return comp.layer(idx); } catch (e) { return null; }
};

// Resolve a property by display-name path, e.g. "Transform/Position" or
// "Effects/Gaussian Blur/Blurriness". Returns the Property/PropertyGroup or
// null. .property() accepts names, matchNames, or indices.
AEMCP.propByPath = function (root, path) {
    if (!root || !path) return null;
    var segs = String(path).split('/');
    var cur = root;
    for (var i = 0; i < segs.length; i++) {
        if (segs[i] === '') continue;
        var next = null;
        try { next = cur.property(segs[i]); } catch (e) { return null; }
        if (!next) return null;
        cur = next;
    }
    return cur;
};

// Resolve a property by matchName path with optional #ordinals, e.g.
// "ADBE Transform Group#1/ADBE Position#1". Ordinals count siblings sharing a
// matchName (default 1) so duplicate-matchName effects stay addressable.
// Returns the Property/PropertyGroup or null.
AEMCP.propByMatchPath = function (root, path) {
    if (!root || !path) return null;
    var segs = String(path).split('/');
    var cur = root;
    for (var i = 0; i < segs.length; i++) {
        var seg = segs[i];
        if (seg === '') continue;
        var mn = seg, ord = 1;
        var h = seg.lastIndexOf('#');
        if (h > 0) {
            var parsed = parseInt(seg.substring(h + 1), 10);
            if (!isNaN(parsed) && parsed >= 1) {
                mn = seg.substring(0, h);
                ord = parsed;
            }
        }
        var n = AEMCP._numProps(cur);
        if (n < 0) return null;
        var found = null, count = 0;
        for (var j = 1; j <= n; j++) {
            var child = cur.property(j);
            if (child && child.matchName === mn) {
                count++;
                if (count === ord) { found = child; break; }
            }
        }
        if (!found) return null;
        cur = found;
    }
    return cur;
};
// AEMCP-HELPERS-END
