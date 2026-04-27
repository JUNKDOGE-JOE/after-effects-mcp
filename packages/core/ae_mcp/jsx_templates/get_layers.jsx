// ae.layers — list layers in a comp
// Placeholders: comp_expr (resolves to CompItem or null)
(function() {
    var comp = ${comp_expr};
    if (!comp) return JSON.stringify({ok: false, error: "no comp"});
    var layers = [];
    for (var i = 1; i <= comp.numLayers; i++) {
        var l = comp.layer(i);
        layers.push({
            id: i,
            name: l.name,
            enabled: l.enabled,
            inPoint: l.inPoint,
            outPoint: l.outPoint,
            isThreeD: !!l.threeDLayer,
            hasParent: !!l.parent
        });
    }
    return JSON.stringify({ok: true, compId: String(comp.id), layers: layers});
})()
