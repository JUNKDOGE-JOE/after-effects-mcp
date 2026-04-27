// ae.getExpressions — collect all non-empty expressions.
// Placeholders: comp_expr (resolves a comp), layer_ids_js (array | null),
// prop_filter_js (string | null), max_results.
(function() {
    var comp = ${comp_expr};
    if (!comp) return JSON.stringify({ok:false,error:"no comp"});
    var layerIds = ${layer_ids_js};
    var propFilter = ${prop_filter_js};
    var maxResults = ${max_results};

    function shortHash(s) {
        var h = 0;
        for (var i = 0; i < s.length; i++) {
            h = ((h << 5) - h + s.charCodeAt(i)) | 0;
        }
        return ("00000000" + (h >>> 0).toString(16)).slice(-8);
    }

    var hits = [];
    var truncated = false;

    function visit(prop, layerId, pathSegs, depth) {
        if (truncated) return;
        if (depth > 6) return;
        if (prop.propertyType === PropertyType.PROPERTY) {
            if (prop.canSetExpression && prop.expression !== "") {
                if (propFilter && (prop.matchName.indexOf(propFilter) === -1)) return;
                if (hits.length >= maxResults) { truncated = true; return; }
                var src = String(prop.expression);
                hits.push({
                    layerId: layerId,
                    propPath: pathSegs.join("/"),
                    expression: src,
                    enabled: !prop.expressionEnabled ? false : true,
                    hash: shortHash(src)
                });
            }
        } else {
            for (var i = 1; i <= prop.numProperties; i++) {
                var child = prop.property(i);
                if (!child) continue;
                visit(child, layerId, pathSegs.concat([child.name]), depth + 1);
            }
        }
    }

    var n = comp.numLayers;
    for (var li = 1; li <= n; li++) {
        if (layerIds) {
            var keep = false;
            for (var ki = 0; ki < layerIds.length; ki++) {
                if (layerIds[ki] === li) { keep = true; break; }
            }
            if (!keep) continue;
        }
        var layer = comp.layer(li);
        for (var pi = 1; pi <= layer.numProperties; pi++) {
            var top = layer.property(pi);
            if (!top) continue;
            visit(top, li, [top.name], 0);
        }
    }

    var grouped = {};
    for (var hi = 0; hi < hits.length; hi++) {
        var h = hits[hi];
        if (!grouped[h.hash]) grouped[h.hash] = [];
        grouped[h.hash].push({layerId: h.layerId, propPath: h.propPath});
    }

    return JSON.stringify({
        ok: true,
        expressions: hits,
        grouped: grouped,
        truncated: truncated
    });
})()
