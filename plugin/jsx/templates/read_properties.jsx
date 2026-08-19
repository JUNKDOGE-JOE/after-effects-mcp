(function() {
    var o = $options;
    var project = app.project;
    function selectorText(selector) { return selector ? JSON.stringify(selector) : "active composition"; }
    function resolveComp(selector) {
        var item = null;
        if (!selector) return AEMCP.activeComp();
        if (selector.id) {
            try { item = project.itemByID(parseInt(selector.id, 10)); } catch (eId) { item = null; }
        } else if (selector.index) {
            try { item = project.item(selector.index); } catch (eIndex) { item = null; }
        } else if (selector.name) {
            for (var i = 1; i <= project.numItems; i++) {
                var candidate = project.item(i);
                if (candidate instanceof CompItem && String(candidate.name) === selector.name) { item = candidate; break; }
            }
        }
        return item && item instanceof CompItem ? item : null;
    }
    function layerId(layer) {
        try { return layer.id === undefined ? null : String(layer.id); } catch (e) { return null; }
    }
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
    function selectorDescription(selector) { return selector ? JSON.stringify(selector) : "missing"; }
    function childCount(property) { return AEMCP._numProps(property); }
    function groupingType(property, count) {
        if (count < 0) return "leaf";
        try {
            if (typeof PropertyType !== "undefined" && property.propertyType === PropertyType.INDEXED_GROUP) return "indexedGroup";
        } catch (eType) {}
        return "group";
    }
    function valueType(property) {
        var raw = "";
        try { raw = String(property.propertyValueType); } catch (eRaw) {}
        if (raw.indexOf("OneD") !== -1) return "one-d";
        if (raw.indexOf("TwoD_SPATIAL") !== -1) return "two-d-spatial";
        if (raw.indexOf("TwoD") !== -1) return "two-d";
        if (raw.indexOf("ThreeD_SPATIAL") !== -1) return "three-d-spatial";
        if (raw.indexOf("ThreeD") !== -1) return "three-d";
        if (raw.indexOf("COLOR") !== -1 || raw.indexOf("Color") !== -1) return "color";
        if (raw.indexOf("TEXT") !== -1 || raw.indexOf("Text") !== -1) return "text-document";
        if (raw.indexOf("NO_VALUE") !== -1) return "none";
        if (raw.indexOf("MARKER") !== -1) return "marker";
        return raw ? "arb" : "unknown";
    }
    function readValue(property, sampleTime, type) {
        var value;
        try { value = sampleTime === null ? property.value : property.valueAtTime(sampleTime, false); } catch (eValue) { return {status: "unsupported", value: null}; }
        if (type === "text-document") {
            try { return {status: "sampled", value: String(value.text)}; } catch (eText) { return {status: "unsupported", value: null}; }
        }
        if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
            return {status: "sampled", value: value};
        }
        if (value instanceof Array) {
            var out = [];
            for (var i = 0; i < value.length; i++) {
                if (typeof value[i] !== "number" && typeof value[i] !== "string") return {status: "unsupported", value: null};
                out.push(value[i]);
            }
            if (type === "color" && out.length >= 3) {
                return {status: "sampled", value: {red: out[0], green: out[1], blue: out[2], alpha: out.length > 3 ? out[3] : 1}};
            }
            return {status: "sampled", value: out};
        }
        return {status: "unsupported", value: null};
    }
    function pathSegment(property, parent, index) {
        var name = "property";
        try { name = String(property.matchName || property.name || name); } catch (eName) {}
        var ordinal = 0;
        for (var i = 1; i <= index; i++) {
            var sibling = parent.property(i);
            var siblingName = "";
            try { siblingName = String(sibling.matchName || sibling.name || "property"); } catch (eSibling) {}
            if (siblingName === name) ordinal++;
        }
        return name + (ordinal > 1 ? "#" + ordinal : "");
    }
    function makeEntry(property, index, matchPath) {
        var count = childCount(property);
        var type = groupingType(property, count);
        var vt = valueType(property);
        var sampled = type === "leaf" ? readValue(property, o.sampleTime, vt) : {status: "group", value: null};
        var canVary = null;
        var varying = null;
        try { canVary = typeof property.canVaryOverTime === "boolean" ? property.canVaryOverTime : null; } catch (eCan) {}
        try { varying = typeof property.isTimeVarying === "boolean" ? property.isTimeVarying : null; } catch (eVar) {}
        return {
            locatorKind: "jsx",
            propertyLocator: {locatorKind: "jsx", matchPath: matchPath},
            matchPath: matchPath,
            propertyIndex: index,
            name: String(property.name),
            matchName: String(property.matchName || ""),
            groupingType: type,
            childCount: count < 0 ? 0 : count,
            hidden: !!property.hidden,
            disabled: property.enabled === false,
            modified: !!property.isModified,
            canVaryOverTime: canVary,
            timeVarying: varying,
            valueType: vt,
            valueStatus: sampled.status,
            value: sampled.value
        };
    }
    function keep(entry, filter) {
        if (filter.nameContains && entry.name.indexOf(filter.nameContains) === -1) return false;
        if (filter.type && entry.valueType !== filter.type) return false;
        if (filter.matchNamePrefix && entry.matchName.indexOf(filter.matchNamePrefix) !== 0) return false;
        if (filter.timeVaryingOnly && entry.timeVarying !== true) return false;
        return true;
    }
    function compare(a, b, by) {
        var av = by === "propertyIndex" ? a.propertyIndex : String(a[by]);
        var bv = by === "propertyIndex" ? b.propertyIndex : String(b[by]);
        if (av < bv) return -1;
        if (av > bv) return 1;
        return 0;
    }

    var comp = resolveComp(o.comp);
    if (!comp) return JSON.stringify({ok: false, error: "Composition not found for " + selectorText(o.comp)});
    var layer = resolveLayer(comp, o.layer);
    if (!layer) return JSON.stringify({ok: false, error: "Layer not found for " + selectorDescription(o.layer) + " in composition " + String(comp.name)});
    if (o.sampleTime === null) o.sampleTime = comp.time;
    var root = layer;
    var parentPath = null;
    if (o.property && o.property.matchPath) {
        root = AEMCP.propByMatchPath(layer, o.property.matchPath);
        parentPath = o.property.matchPath;
        if (!root) return JSON.stringify({ok: false, error: "Property not found for matchPath " + o.property.matchPath + " on layer " + String(layer.name)});
    }
    var all = [];
    var depth = o.depth;
    function visit(group, prefix, level) {
        var count = childCount(group);
        if (count < 0) {
            var only = makeEntry(group, 1, prefix);
            if (keep(only, o.filter || {})) all.push(only);
            return;
        }
        if (level > depth) return;
        for (var i = 1; i <= count; i++) {
            var child = group.property(i);
            var segment = pathSegment(child, group, i);
            var childPath = prefix ? prefix + "/" + segment : segment;
            var entry = makeEntry(child, i, childPath);
            if (keep(entry, o.filter || {})) all.push(entry);
            if (childCount(child) >= 0 && level < depth) visit(child, childPath, level + 1);
        }
    }
    visit(root, parentPath, 1);
    if (o.sort && o.sort.by) {
        all.sort(function(a, b) {
            var result = compare(a, b, o.sort.by);
            return o.sort.order === "desc" ? -result : result;
        });
    }
    var offset = o.page.offset;
    var limit = o.page.limit;
    var total = all.length;
    var end = Math.min(total, offset + limit);
    var properties = [];
    for (var j = offset; j < end; j++) properties.push(all[j]);
    return JSON.stringify({
        ok: true,
        layerLocator: {locatorKind: "jsx", layerIndex: layer.index, layerId: layerId(layer)},
        parentPropertyLocator: parentPath ? {locatorKind: "jsx", matchPath: parentPath} : null,
        layerName: String(layer.name),
        sampleTime: o.sampleTime,
        total: total,
        offset: offset,
        limit: limit,
        returned: properties.length,
        hasMore: end < total,
        nextOffset: end < total ? end : null,
        properties: properties
    });
})()
