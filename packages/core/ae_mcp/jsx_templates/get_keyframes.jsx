// ae.getKeyframes — list keyframes for one property.
// Placeholders: comp_expr, layer_id, path.
(function() {
    var comp = ${comp_expr};
    if (!comp) return JSON.stringify({ok:false,error:"no comp"});
    var layer = AEMCP.layerById(comp, ${layer_id});
    if (!layer) return JSON.stringify({ok:false,error:"no layer"});
    var segs = (${path}).split("/");
    var prop = layer;
    for (var i = 0; i < segs.length; i++) {
        try {
            prop = prop.property(segs[i]);
            if (!prop) return JSON.stringify({ok:false,
                error:"path segment not found: " + segs[i]});
        } catch (e) {
            return JSON.stringify({ok:false, error:"property() threw: " + String(e)});
        }
    }
    if (prop.propertyType !== PropertyType.PROPERTY) {
        return JSON.stringify({ok:false, error:"path resolves to a group, not a property"});
    }
    function interpName(t) {
        if (t === KeyframeInterpolationType.LINEAR) return "LINEAR";
        if (t === KeyframeInterpolationType.BEZIER) return "BEZIER";
        if (t === KeyframeInterpolationType.HOLD) return "HOLD";
        return "UNKNOWN";
    }
    var n = prop.numKeys || 0;
    var keyframes = [];
    for (var k = 1; k <= n; k++) {
        var entry = {
            index: k,
            time: prop.keyTime(k),
            interpIn: interpName(prop.keyInInterpolationType(k)),
            interpOut: interpName(prop.keyOutInterpolationType(k))
        };
        try { entry.value = AEMCP.safeValue(prop.keyValue(k)); } catch (e) { entry.value = null; }
        try { entry.easeIn = AEMCP.safeValue(prop.keyInTemporalEase(k)); } catch (e) { entry.easeIn = null; }
        try { entry.easeOut = AEMCP.safeValue(prop.keyOutTemporalEase(k)); } catch (e) { entry.easeOut = null; }
        try { entry.spatialIn = AEMCP.safeValue(prop.keyInSpatialTangent(k)); } catch (e) { entry.spatialIn = null; }
        try { entry.spatialOut = AEMCP.safeValue(prop.keyOutSpatialTangent(k)); } catch (e) { entry.spatialOut = null; }
        keyframes.push(entry);
    }
    return JSON.stringify({ok:true, numKeyframes:n, keyframes:keyframes});
})()
