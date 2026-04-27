// Template for ae.setProperty. Substitution: Python string.Template.
// Placeholders: comp_expr, layer_id, path, value, at_time.
// Returns JSON: ok, previous, current (or ok:false + error).
(function() {
    var comp = ${comp_expr};
    if (!comp) return JSON.stringify({ok:false,error:"no comp"});
    var layer = comp.layer(${layer_id});
    if (!layer) return JSON.stringify({ok:false,error:"no layer"});

    var path = ${path};
    var segs = path.split("/");
    var prop = layer;
    for (var i = 0; i < segs.length; i++) {
        try {
            prop = prop.property(segs[i]);
            if (!prop) return JSON.stringify({ok:false,error:"path segment not found: "+segs[i]});
        } catch (e) {
            return JSON.stringify({ok:false,error:"property() threw at segment '"+segs[i]+"': "+String(e)});
        }
    }

    var value = ${value};
    var atTime = ${at_time};
    var prev = null;
    try { prev = prop.value; } catch (e) { /* may lack .value */ }

    try {
        if (atTime >= 0) {
            prop.setValueAtTime(atTime, value);
        } else {
            prop.setValue(value);
        }
    } catch (e) {
        return JSON.stringify({ok:false,error:"setValue threw: "+String(e)});
    }

    var cur = null;
    try { cur = prop.value; } catch (e) { }

    return JSON.stringify({ok:true, previous:prev, current:cur});
})()
