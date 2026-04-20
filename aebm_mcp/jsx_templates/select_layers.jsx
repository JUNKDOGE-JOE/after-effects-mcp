// Template for ae.selectLayers. Substitution: Python string.Template.
// Placeholders: comp_expr, selector_js (JS literal "'all'" / "'none'" / "[1,2,3]").
// Returns JSON: ok, selected:[...].
(function() {
    var comp = ${comp_expr};
    if (!comp) return JSON.stringify({ok:false,error:"no comp"});

    var sel = ${selector_js};
    var targets = [];
    if (sel === "all") {
        for (var i = 1; i <= comp.numLayers; i++) targets.push(i);
    } else if (sel === "none") {
        targets = [];
    } else if (sel && sel.length !== undefined) {
        for (var j = 0; j < sel.length; j++) targets.push(sel[j]);
    }

    for (var k = 1; k <= comp.numLayers; k++) {
        try { comp.layer(k).selected = false; } catch (e) {}
    }
    var applied = [];
    for (var m = 0; m < targets.length; m++) {
        var idx = targets[m];
        var L = null;
        try { L = comp.layer(idx); } catch (e) {}
        if (L) { L.selected = true; applied.push(idx); }
    }
    return JSON.stringify({ok:true, selected:applied});
})()
