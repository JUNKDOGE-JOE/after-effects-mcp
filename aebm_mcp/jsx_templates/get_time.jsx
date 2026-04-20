// Template for ae.getTime. Substitution: Python string.Template.
// Placeholders: comp_expr.
// Returns JSON: ok, time, duration, numLayers, compId.
(function() {
    var comp = ${comp_expr};
    if (!comp) return JSON.stringify({ok:false,error:"no comp"});
    return JSON.stringify({
        ok: true,
        time: comp.time,
        duration: comp.duration,
        numLayers: comp.numLayers,
        compId: comp.id
    });
})()
