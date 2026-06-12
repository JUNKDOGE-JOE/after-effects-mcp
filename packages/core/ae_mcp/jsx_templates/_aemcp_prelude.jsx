// AEMCP-HELPERS-BEGIN — source of truth lives in plugin/jsx/runtime.jsx; keep both in sync (enforced by test_jsx_prelude.py)
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
