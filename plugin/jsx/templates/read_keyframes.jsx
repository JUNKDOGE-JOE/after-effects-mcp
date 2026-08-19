(function() {
    var o = $options;
    var project = app.project;
    function selectorText(selector) { return selector ? JSON.stringify(selector) : "active composition"; }
    function resolveComp(selector) {
        var item = null;
        if (!selector) return AEMCP.activeComp();
        if (selector.id) { try { item = project.itemByID(parseInt(selector.id, 10)); } catch (eId) { item = null; } }
        else if (selector.index) { try { item = project.item(selector.index); } catch (eIndex) { item = null; } }
        else if (selector.name) {
            for (var i = 1; i <= project.numItems; i++) {
                var candidate = project.item(i);
                if (candidate instanceof CompItem && String(candidate.name) === selector.name) { item = candidate; break; }
            }
        }
        return item && item instanceof CompItem ? item : null;
    }
    function layerId(layer) { try { return layer.id === undefined ? null : String(layer.id); } catch (e) { return null; } }
    function resolveLayer(comp, selector) {
        if (!selector) return null;
        if (selector.index) return AEMCP.layerById(comp, selector.index);
        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = comp.layer(i);
            if (selector.id && layerId(layer) === String(selector.id)) return layer;
            if (selector.name && String(layer.name) === selector.name) return layer;
        }
        return null;
    }
    function propertyType(property) {
        var raw = "";
        try { raw = String(property.propertyValueType); } catch (eRaw) {}
        if (raw.indexOf("OneD") !== -1) return "one-d";
        if (raw.indexOf("TwoD_SPATIAL") !== -1) return "two-d-spatial";
        if (raw.indexOf("TwoD") !== -1) return "two-d";
        if (raw.indexOf("ThreeD_SPATIAL") !== -1) return "three-d-spatial";
        if (raw.indexOf("ThreeD") !== -1) return "three-d";
        if (raw.indexOf("COLOR") !== -1 || raw.indexOf("Color") !== -1) return "color";
        return "unknown";
    }
    function value(property, time) {
        var v;
        try { v = property.keyValue(time); } catch (eValue) { return null; }
        if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
        if (v instanceof Array) {
            var out = [];
            for (var i = 0; i < v.length; i++) {
                if (typeof v[i] !== "number" && typeof v[i] !== "string") return null;
                out.push(v[i]);
            }
            return out;
        }
        return null;
    }
    function interpolation(value) {
        var text = String(value);
        if (text.indexOf("HOLD") !== -1) return "hold";
        if (text.indexOf("BEZIER") !== -1) return "bezier";
        if (text.indexOf("LINEAR") !== -1) return "linear";
        return "none";
    }
    var comp = resolveComp(o.comp);
    if (!comp) return JSON.stringify({ok: false, error: "Composition not found for " + selectorText(o.comp)});
    var layer = resolveLayer(comp, o.layer);
    if (!layer) return JSON.stringify({ok: false, error: "Layer not found for " + JSON.stringify(o.layer) + " in composition " + String(comp.name)});
    var matchPath = o.property && o.property.matchPath;
    var property = AEMCP.propByMatchPath(layer, matchPath);
    if (!property) return JSON.stringify({ok: false, error: "Property not found for matchPath " + String(matchPath) + " on layer " + String(layer.name)});
    var keyCount = 0;
    try { keyCount = property.numKeys; } catch (eKeys) { keyCount = 0; }
    var type = propertyType(property);
    var all = [];
    for (var k = 1; k <= keyCount; k++) {
        var time = property.keyTime(k);
        var inType = "none";
        var outType = "none";
        try { inType = interpolation(property.keyInInterpolationType(k)); } catch (eIn) {}
        try { outType = interpolation(property.keyOutInterpolationType(k)); } catch (eOut) {}
        all.push({
            locatorKind: "jsx",
            keyframeIndex: k,
            time: time,
            value: value(property, k),
            inInterpolation: inType,
            outInterpolation: outType
        });
    }
    if (o.sort && o.sort.by === "time") {
        all.sort(function(a, b) {
            var result = a.time < b.time ? -1 : (a.time > b.time ? 1 : 0);
            return o.sort.order === "desc" ? -result : result;
        });
    }
    var offset = o.page.offset;
    var limit = o.page.limit;
    var total = all.length;
    var end = Math.min(total, offset + limit);
    var keyframes = [];
    for (var j = offset; j < end; j++) keyframes.push(all[j]);
    return JSON.stringify({
        ok: true,
        propertyLocator: {locatorKind: "jsx", matchPath: matchPath},
        matchPath: matchPath,
        valueType: type,
        total: total,
        offset: offset,
        limit: limit,
        returned: keyframes.length,
        hasMore: end < total,
        nextOffset: end < total ? end : null,
        keyframes: keyframes
    });
})()
