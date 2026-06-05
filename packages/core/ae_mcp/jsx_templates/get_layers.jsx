// ae.layers — list layers in a comp (paginated).
// Placeholders: comp_expr (resolves to CompItem or null), offset, limit.
(function() {
    var comp = ${comp_expr};
    if (!comp) return JSON.stringify({ok: false, error: "no comp"});

    function layerType(l) {
        if (l instanceof CameraLayer) return "camera";
        if (l instanceof LightLayer) return "light";
        if (l instanceof TextLayer) return "text";
        if (l instanceof ShapeLayer) return "shape";
        if (l.nullLayer) return "null";
        if (l.adjustmentLayer) return "adjustment";
        var src = l.source;
        if (src && src.mainSource && (src.mainSource instanceof SolidSource)) return "solid";
        if (src) return "footage";
        return "av";
    }

    var offset = ${offset};
    var limit = ${limit};
    var total = comp.numLayers;
    var start = offset + 1;                       // AE layers are 1-based
    // limit <= 0 means "all": preserves the historical full-enumeration
    // default so an existing caller that omits limit never silently loses
    // layers on comps with more than the page size.
    var end = (limit > 0) ? Math.min(total, offset + limit) : total;
    var layers = [];
    for (var i = start; i <= end; i++) {
        var l = comp.layer(i);
        layers.push({
            id: i,
            name: l.name,
            type: layerType(l),
            enabled: l.enabled,
            inPoint: l.inPoint,
            outPoint: l.outPoint,
            isThreeD: !!l.threeDLayer,
            hasParent: !!l.parent,
            parent: l.parent ? l.parent.name : null
        });
    }
    return JSON.stringify({
        ok: true,
        compId: String(comp.id),
        compName: comp.name,
        total: total,
        offset: offset,
        limit: limit,
        returned: layers.length,
        hasMore: (offset + layers.length) < total,
        layers: layers
    });
})()
