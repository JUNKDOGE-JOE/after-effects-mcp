// ae.searchProject — fuzzy search across project items / comps / layers / effects / expressions.
// Placeholders: query_js, scope_js (array), limit.
(function() {
    var query = ${query_js};
    var scope = ${scope_js};
    var limit = ${limit};

    // Wall-clock budget so large projects return partial results instead of
    // blowing the 30s evalScript timeout with zero output.
    var BUDGET_MS = ${time_budget_ms};
    var START_MS = new Date().getTime();
    function overBudget() { return (new Date().getTime() - START_MS) >= BUDGET_MS; }

    var orGroups = query.toLowerCase().split("|");
    for (var oi = 0; oi < orGroups.length; oi++) {
        var raw = orGroups[oi].split(/\s+/);
        var trimmed = [];
        for (var ai = 0; ai < raw.length; ai++) if (raw[ai].length > 0) trimmed.push(raw[ai]);
        orGroups[oi] = trimmed;
    }

    function matches(text) {
        var hay = String(text).toLowerCase();
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

    function inScope(s) {
        for (var i = 0; i < scope.length; i++) if (scope[i] === s) return true;
        return false;
    }

    var hits = [];
    var truncated = false;
    var budgetHit = false;
    function add(h) {
        if (truncated) return;
        if (hits.length >= limit) { truncated = true; return; }
        hits.push(h);
    }

    var n = app.project.numItems;
    for (var i = 1; i <= n; i++) {
        if (truncated) break;
        if (overBudget()) { truncated = true; budgetHit = true; break; }
        var it = app.project.item(i);
        if (!it) continue;

        if (it instanceof CompItem) {
            if (inScope("comps") && matches(it.name)) {
                add({kind:"comp", compId:String(it.id), name:it.name,
                     snippet:it.name, score:0.95});
            }
            if (inScope("layers") || inScope("expressions") || inScope("effects")) {
                for (var li = 1; li <= it.numLayers; li++) {
                    if (truncated) break;
                    if (overBudget()) { truncated = true; budgetHit = true; break; }
                    var layer = it.layer(li);
                    if (inScope("layers") && matches(layer.name)) {
                        add({kind:"layer", compId:String(it.id), layerId:li,
                             name:layer.name, snippet:layer.name, score:0.85});
                    }
                    if (inScope("effects")) {
                        var fx = layer.property("ADBE Effect Parade");
                        if (fx) {
                            for (var ei = 1; ei <= fx.numProperties; ei++) {
                                var e = fx.property(ei);
                                if (e && (matches(e.name) || matches(e.matchName))) {
                                    add({kind:"effect", compId:String(it.id), layerId:li,
                                         name:e.name, matchName:e.matchName,
                                         snippet:e.name, score:0.7});
                                }
                            }
                        }
                    }
                    if (inScope("expressions")) {
                        // shallow scan: only Transform group expressions to keep cost bounded
                        var xf = layer.property("ADBE Transform Group");
                        if (xf) {
                            for (var xi = 1; xi <= xf.numProperties; xi++) {
                                var xp = xf.property(xi);
                                if (xp && xp.canSetExpression && xp.expression !== "") {
                                    if (matches(xp.expression)) {
                                        var snip = xp.expression.length > 80 ?
                                            xp.expression.slice(0, 80) + "..." :
                                            xp.expression;
                                        add({kind:"expression",
                                             compId:String(it.id), layerId:li,
                                             propPath:"Transform/" + xp.name,
                                             snippet:snip, score:0.5});
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } else if (inScope("items") && matches(it.name)) {
            add({kind:"item", itemId:String(it.id), name:it.name,
                 snippet:it.name, score:0.6});
        }
    }

    hits.sort(function(a,b){return b.score - a.score;});
    return JSON.stringify({ok:true, hits:hits, truncated:truncated,
        reason: budgetHit ? "time budget exceeded" : (truncated ? "limit reached" : null)});
})()
