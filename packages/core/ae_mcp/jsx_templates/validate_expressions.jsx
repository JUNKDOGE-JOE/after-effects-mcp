// ae.validateExpressions — force expression evaluation and collect errors.
// Placeholders: comp_expr, layer_ids_js, prop_filter_js, sample_times_js, max_results.
(function() {
    var comp = ${comp_expr};
    if (!comp) return JSON.stringify({ok:false,error:"no comp"});
    var layerIds = ${layer_ids_js};
    var propFilter = ${prop_filter_js};
    var sampleTimes = ${sample_times_js};
    var maxResults = ${max_results};
    if (!sampleTimes) sampleTimes = [comp.time];

    function containsLayer(id) {
        if (!layerIds) return true;
        for (var i = 0; i < layerIds.length; i++) {
            if (layerIds[i] === id) return true;
        }
        return false;
    }

    function shouldCheck(prop) {
        if (!prop.canSetExpression || prop.expression === "") return false;
        if (!propFilter) return true;
        return String(prop.matchName).indexOf(propFilter) !== -1 ||
            String(prop.name).indexOf(propFilter) !== -1;
    }

    function previewValue(value) {
        try {
            if (value && value.text !== undefined) return String(value.text);
            if (value instanceof Array) return "[" + value.join(",") + "]";
            return String(value);
        } catch (_e) {
            return "<unprintable>";
        }
    }

    var checked = [];
    var errors = [];
    var truncated = false;

    function visit(prop, layer, pathSegs, matchSegs, depth) {
        if (truncated) return;
        if (depth > 8) return;

        if (prop.propertyType === PropertyType.PROPERTY) {
            if (!shouldCheck(prop)) return;
            if (checked.length >= maxResults) {
                truncated = true;
                return;
            }

            var samples = [];
            for (var ti = 0; ti < sampleTimes.length; ti++) {
                var t = Number(sampleTimes[ti]);
                var sample = {time: t};
                try {
                    var value = prop.valueAtTime(t, false);
                    sample.valuePreview = previewValue(value);
                } catch (e) {
                    sample.evalError = e && e.message ? e.message : String(e);
                }
                samples.push(sample);
            }

            var expressionError = "";
            try {
                expressionError = String(prop.expressionError || "");
            } catch (_err) {
                expressionError = "";
            }

            var item = {
                layerId: layer.index,
                layerName: layer.name,
                propPath: pathSegs.join("/"),
                matchPath: matchSegs.join("/"),
                expressionEnabled: !!prop.expressionEnabled,
                expressionError: expressionError,
                samples: samples
            };
            checked.push(item);

            var sampleFailed = false;
            for (var si = 0; si < samples.length; si++) {
                if (samples[si].evalError) sampleFailed = true;
            }
            if (expressionError || sampleFailed || !prop.expressionEnabled) {
                errors.push(item);
            }
            return;
        }

        for (var i = 1; i <= prop.numProperties; i++) {
            var child = prop.property(i);
            if (!child) continue;
            visit(
                child,
                layer,
                pathSegs.concat([child.name]),
                matchSegs.concat([child.matchName || child.name]),
                depth + 1
            );
        }
    }

    for (var li = 1; li <= comp.numLayers; li++) {
        if (!containsLayer(li)) continue;
        var layer = comp.layer(li);
        for (var pi = 1; pi <= layer.numProperties; pi++) {
            var top = layer.property(pi);
            if (!top) continue;
            visit(top, layer, [top.name], [top.matchName || top.name], 0);
        }
    }

    return JSON.stringify({
        ok: true,
        valid: errors.length === 0,
        compId: String(comp.id),
        compName: comp.name,
        checked: checked.length,
        errors: errors,
        expressions: checked,
        truncated: truncated
    });
})()
