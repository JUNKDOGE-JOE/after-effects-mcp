// ae-mcp runtime helpers loaded by the panel at startup.
// Provides a JSON polyfill for AE's classic ExtendScript engine, which
// doesn't have native JSON. AE 2026's modern engine does, but CEP panels
// may run script in classic mode in some contexts.
if (typeof JSON === 'undefined') {
    JSON = {};
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
