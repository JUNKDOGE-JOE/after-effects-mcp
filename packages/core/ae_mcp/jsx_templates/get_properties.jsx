// ae.getProperties — search property names across selected layers.
// Placeholders: comp_expr, layer_ids_js, query_js, offset, limit.
(function() {
    var comp = ${comp_expr};
    if (!comp) return JSON.stringify({ok:false,error:"no comp"});
    var layerIds = ${layer_ids_js};
    var query = ${query_js};
    var offset = ${offset};
    var limit = ${limit};

    var orGroups = query.toLowerCase().split("|");
    for (var oi = 0; oi < orGroups.length; oi++) {
        orGroups[oi] = orGroups[oi].split(/\s+/);
        var arr = orGroups[oi];
        var trimmed = [];
        for (var ai = 0; ai < arr.length; ai++) {
            if (arr[ai] && arr[ai].length > 0) trimmed.push(arr[ai]);
        }
        orGroups[oi] = trimmed;
    }

    function matches(name, matchName) {
        var hay = (name + " " + matchName).toLowerCase();
        for (var gi = 0; gi < orGroups.length; gi++) {
            var grp = orGroups[gi];
            if (grp.length === 0) continue;
            var ok = true;
            for (var ti = 0; ti < grp.length; ti++) {
                if (hay.indexOf(grp[ti]) === -1) { ok = false; break; }
            }
            if (ok) return true;
        }
        return false;
    }

    var hits = [];
    var missing = [];

    function visit(prop, layerId, pathSegs, matchSegs, depth) {
        if (depth > 6) return;
        if (prop.propertyType === PropertyType.PROPERTY) {
            if (matches(prop.name, prop.matchName)) {
                var val = null;
                try { val = prop.value; } catch (e) { }
                var score = 0;
                if (matchSegs[0] === "ADBE Transform Group") score += 10;
                if (prop.name.toLowerCase().indexOf(orGroups[0][0] || "") !== -1) score += 5;
                hits.push({
                    layerId: layerId,
                    propName: prop.name,
                    matchName: prop.matchName,
                    propPath: pathSegs.join("/"),
                    matchPath: matchSegs.join("/"),
                    propType: String(prop.propertyValueType),
                    value: val,
                    hasExpression: prop.canSetExpression && (prop.expression !== ""),
                    hasKeyframes: prop.numKeys > 0,
                    _score: score
                });
            }
        } else {
            for (var i = 1; i <= prop.numProperties; i++) {
                var child = prop.property(i);
                if (!child) continue;
                visit(
                    child, layerId,
                    pathSegs.concat([child.name]),
                    matchSegs.concat([child.matchName]),
                    depth + 1
                );
            }
        }
    }

    for (var li = 0; li < layerIds.length; li++) {
        var layer = AEMCP.layerById(comp, layerIds[li]);
        if (!layer) { missing.push(layerIds[li]); continue; }
        for (var pi = 1; pi <= layer.numProperties; pi++) {
            var top = layer.property(pi);
            if (!top) continue;
            visit(top, layerIds[li], [top.name], [top.matchName], 0);
        }
    }

    // Silent partial results are indistinguishable from "this layer had no matches"
    // unless missing layer ids are surfaced explicitly to the caller.
    if (missing.length === layerIds.length) {
        return JSON.stringify({ok:false, error:"no valid layers in layer_ids", missingLayerIds:missing});
    }

    hits.sort(function(a, b) { return b._score - a._score; });
    var total = hits.length;
    var paged = hits.slice(offset, offset + limit);
    for (var pi2 = 0; pi2 < paged.length; pi2++) delete paged[pi2]._score;

    return JSON.stringify({ok:true, total: total, results: paged, missingLayerIds:missing});
})()
