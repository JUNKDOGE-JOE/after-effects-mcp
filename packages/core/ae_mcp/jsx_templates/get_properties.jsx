// ae.getProperties — search property names across selected layers.
// Placeholders: comp_expr, layer_ids_js, query_js, offset, limit.
(function() {
    var ALIAS = {
        "ADBE Text Document": "source text",
        "ADBE Rotate X": "x rotation",
        "ADBE Rotate Y": "y rotation",
        "ADBE Rotate Z": "rotation",
        "ADBE Position_0": "x position",
        "ADBE Position_1": "y position",
        "ADBE Position_2": "z position",
        "ADBE Mask Shape": "mask path",
        "ADBE Mask Offset": "mask expansion",
        "ADBE Vector Shape": "path"
    };

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
        var hay = (name + " " + matchName + " " + (ALIAS[matchName] || "")).toLowerCase();
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
                try { val = AEMCP.safeValue(prop.value); } catch (e) { }
                var score = 0;
                if (matchSegs[0] === "ADBE Transform Group") score += 10;
                if ((prop.name + " " + (ALIAS[prop.matchName] || "")).toLowerCase().indexOf(orGroups[0][0] || "") !== -1) score += 5;
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

    var hint = null;
    if (total === 0) {
        var lang = "";
        try { lang = String(app.isoLanguage || ""); } catch (eLang) { }
        if (lang && lang.indexOf("en") !== 0 && /[a-z]/.test(query.toLowerCase())) {
            hint = "No matches. AE UI language is " + lang + ": property display names are localized, " +
                "so English display-name words may miss. Query matchName terms instead (e.g. " +
                "'text document' for Source Text, 'rotate' for Rotation) or run ae_scanPropertyTree " +
                "to list matchName paths.";
        }
    }
    var out = {ok:true, total: total, results: paged, missingLayerIds:missing};
    if (hint) out.hint = hint;
    return JSON.stringify(out);
})()
