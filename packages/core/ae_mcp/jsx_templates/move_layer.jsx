// Template for ae.moveLayer. Substitution: Python string.Template.
// Placeholders: comp_expr, layer_id, to_index.
// Returns JSON: ok, fromIndex, toIndex (or ok:false + error).
(function() {
    var comp = ${comp_expr};
    if (!comp) return JSON.stringify({ok:false,error:"no comp"});
    var layer = AEMCP.layerById(comp, ${layer_id});
    if (!layer) return JSON.stringify({ok:false,error:"no layer"});

    var from = layer.index;
    var to = ${to_index};
    if (to < 1) to = 1;
    if (to > comp.numLayers) to = comp.numLayers;

    try {
        if (to === from) { /* no-op */ }
        else if (to === 1) {
            layer.moveToBeginning();
        } else if (to === comp.numLayers) {
            layer.moveToEnd();
        } else if (to < from) {
            layer.moveBefore(comp.layer(to));
        } else {
            layer.moveAfter(comp.layer(to));
        }
    } catch (e) {
        return JSON.stringify({ok:false,error:String(e)});
    }

    return JSON.stringify({ok:true, fromIndex:from, toIndex:layer.index});
})()
