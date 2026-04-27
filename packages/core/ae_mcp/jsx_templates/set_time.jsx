// Template for ae.setTime. Substitution: Python string.Template.
// Placeholders: comp_expr, time.
// Returns JSON: ok, time.
(function() {
    var comp = ${comp_expr};
    if (!comp) return JSON.stringify({ok:false,error:"no comp"});
    comp.time = ${time};
    return JSON.stringify({ok:true, time: comp.time});
})()
