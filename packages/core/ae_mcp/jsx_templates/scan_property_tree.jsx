// ae.scanPropertyTree — DFS dump of a single layer's property tree.
// Placeholders: comp_expr, layer_id, max_depth, include_values (true/false).
(function() {
    var comp = ${comp_expr};
    if (!comp) return JSON.stringify({ok:false,error:"no comp"});
    var layer = AEMCP.layerById(comp, ${layer_id});
    if (!layer) return JSON.stringify({ok:false,error:"no layer"});
    var maxDepth = ${max_depth};
    var includeValues = ${include_values};
    var truncated = null;

    // Wall-clock budget so deep/wide trees return partial results instead of
    // blowing the 30s evalScript timeout with zero output.
    var BUDGET_MS = ${time_budget_ms};
    var START_MS = new Date().getTime();
    var budgetHit = false;
    function overBudget() { return (new Date().getTime() - START_MS) >= BUDGET_MS; }

    function nodeFor(prop, depth) {
        var n = {
            name: prop.name,
            matchName: prop.matchName,
            kind: (prop.propertyType === PropertyType.PROPERTY) ? "Property" : "PropertyGroup",
            propType: null,
            value: null,
            hasExpression: false,
            numKeyframes: 0,
            children: []
        };
        if (prop.propertyType === PropertyType.PROPERTY) {
            n.propType = String(prop.propertyValueType);
            n.numKeyframes = prop.numKeys || 0;
            n.hasExpression = prop.canSetExpression && (prop.expression !== "");
            if (includeValues) {
                try { n.value = AEMCP.safeValue(prop.value); } catch (e) { }
            }
        } else {
            if (depth >= maxDepth) {
                truncated = depth;
                return n;
            }
            for (var i = 1; i <= prop.numProperties; i++) {
                if (budgetHit || overBudget()) { budgetHit = true; break; }
                var child = prop.property(i);
                if (!child) continue;
                n.children.push(nodeFor(child, depth + 1));
            }
        }
        return n;
    }

    var rootChildren = [];
    for (var pi = 1; pi <= layer.numProperties; pi++) {
        if (budgetHit || overBudget()) { budgetHit = true; break; }
        var top = layer.property(pi);
        if (!top) continue;
        rootChildren.push(nodeFor(top, 1));
    }

    return JSON.stringify({
        ok: true,
        layerId: ${layer_id},
        layerName: layer.name,
        tree: { name: "(root)", matchName: "", kind: "PropertyGroup",
                propType: null, value: null, hasExpression: false,
                numKeyframes: 0, children: rootChildren },
        truncatedAt: truncated,
        truncated: budgetHit,
        reason: budgetHit ? "time budget exceeded" : null
    });
})()
