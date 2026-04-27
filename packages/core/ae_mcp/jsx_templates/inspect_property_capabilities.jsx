// ae.inspectPropertyCapabilities — describe what can be done with a property.
// Placeholders: comp_expr, layer_id, path.
(function() {
    var comp = ${comp_expr};
    if (!comp) return JSON.stringify({ok:false,error:"no comp"});
    var layer = comp.layer(${layer_id});
    if (!layer) return JSON.stringify({ok:false,error:"no layer"});

    var segs = (${path}).split("/");
    var prop = layer;
    for (var i = 0; i < segs.length; i++) {
        try {
            prop = prop.property(segs[i]);
            if (!prop) return JSON.stringify({
                ok: true, exists: false,
                error: "path segment not found: " + segs[i]
            });
        } catch (e) {
            return JSON.stringify({ok:false, exists: false,
                error: "property() threw: " + String(e)});
        }
    }

    if (prop.propertyType !== PropertyType.PROPERTY) {
        return JSON.stringify({
            ok: true, exists: true, isGroup: true,
            canSetValue: false, canSetExpression: false,
            canAddKeyframe: false, propType: null,
            valueDimension: 0, hasMin: false, hasMax: false,
            minValue: null, maxValue: null, unitsText: null,
            numKeyframes: 0, hasExpression: false
        });
    }

    var dim = 1;
    try {
        var v = prop.value;
        if (v && v.length !== undefined) dim = v.length;
    } catch (e) { }

    return JSON.stringify({
        ok: true, exists: true, isGroup: false,
        canSetValue: true,
        canSetExpression: prop.canSetExpression,
        canAddKeyframe: prop.canVaryOverTime,
        propType: String(prop.propertyValueType),
        valueDimension: dim,
        hasMin: !!prop.hasMin,
        hasMax: !!prop.hasMax,
        minValue: prop.hasMin ? prop.minValue : null,
        maxValue: prop.hasMax ? prop.maxValue : null,
        unitsText: prop.unitsText || null,
        numKeyframes: prop.numKeys || 0,
        hasExpression: (prop.canSetExpression && prop.expression !== "")
    });
})()
