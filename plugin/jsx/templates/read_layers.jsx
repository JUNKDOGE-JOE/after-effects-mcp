(function() {
    var o = $options;
    var project = app.project;
    function selectorText(selector) {
        if (!selector) return "active composition";
        return JSON.stringify(selector);
    }
    function resolveComp(selector) {
        var item = null;
        if (!selector) return AEMCP.activeComp();
        if (selector.id) {
            try { item = project.itemByID(parseInt(selector.id, 10)); } catch (eId) { item = null; }
        } else if (selector.index) {
            try { item = project.item(selector.index); } catch (eIndex) { item = null; }
        } else if (selector.name) {
            for (var n = 1; n <= project.numItems; n++) {
                var candidate = project.item(n);
                if (candidate instanceof CompItem && String(candidate.name) === selector.name) { item = candidate; break; }
            }
        }
        return item && item instanceof CompItem ? item : null;
    }
    function layerType(layer) {
        if (typeof CameraLayer !== "undefined" && layer instanceof CameraLayer) return "camera";
        if (typeof LightLayer !== "undefined" && layer instanceof LightLayer) return "light";
        if (typeof TextLayer !== "undefined" && layer instanceof TextLayer) return "text";
        if (typeof ShapeLayer !== "undefined" && layer instanceof ShapeLayer) return "shape";
        if (layer.nullLayer) return "null";
        if (layer.adjustmentLayer) return "adjustment";
        return layer.source ? "av" : "unknown";
    }
    function layerId(layer) {
        try { return layer.id === undefined ? null : String(layer.id); } catch (e) { return null; }
    }
    function match(layer, entry, filter) {
        if (filter.nameContains && String(layer.name).indexOf(filter.nameContains) === -1) return false;
        if (filter.type && entry.type !== filter.type) return false;
        if (filter.enabledOnly && !entry.videoEnabled) return false;
        return true;
    }
    function compare(a, b, by) {
        var av = a[by];
        var bv = b[by];
        if (by === "name") { av = String(av); bv = String(bv); }
        if (av < bv) return -1;
        if (av > bv) return 1;
        return 0;
    }

    var comp = resolveComp(o.comp);
    if (!comp) return JSON.stringify({ok: false, error: "Composition not found for " + selectorText(o.comp)});
    var filter = o.filter || {};
    var all = [];
    for (var i = 1; i <= comp.numLayers; i++) {
        var layer = comp.layer(i);
        var id = layerId(layer);
        var entry = {
            locatorKind: "jsx",
            locator: {locatorKind: "jsx", layerIndex: i, layerId: id},
            layerIndex: i,
            layerId: id,
            stackIndex: i,
            name: String(layer.name),
            type: layerType(layer),
            videoEnabled: !!layer.enabled,
            isThreeD: !!layer.threeDLayer,
            locked: !!layer.locked,
            parentLocator: layer.parent ? {locatorKind: "jsx", layerIndex: layer.parent.index, layerId: layerId(layer.parent)} : null,
            sourceItemLocator: layer.source ? {locatorKind: "jsx", itemId: String(layer.source.id)} : null,
            inPoint: layer.inPoint,
            outPoint: layer.outPoint
        };
        if (match(layer, entry, filter)) all.push(entry);
    }
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
    var layers = [];
    for (var j = offset; j < end; j++) layers.push(all[j]);
    return JSON.stringify({
        ok: true,
        compositionLocator: {locatorKind: "jsx", itemId: String(comp.id)},
        compositionName: String(comp.name),
        total: total,
        offset: offset,
        limit: limit,
        returned: layers.length,
        hasMore: end < total,
        nextOffset: end < total ? end : null,
        layers: layers
    });
})()
