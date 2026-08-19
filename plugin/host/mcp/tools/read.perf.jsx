// ae_read JSX-side performance fixture. Run this source through ae_exec in a
// disposable project, or paste it into the persistent ExtendScript engine.
(function() {
    var layerCount = 300;
    var effectsPerLayer = 16;
    var comp = app.project.items.addComp("ae_read_perf_" + new Date().getTime(), 1920, 1080, 1, 20, 24);
    var source = app.project.items.addSolid([0.2, 0.4, 0.8], "ae_read_perf_solid", 1920, 1080, 1);
    var i, j, layer, effects, effect, position;
    for (i = 1; i <= layerCount; i++) {
        layer = comp.layers.add(source);
        layer.name = "Perf Layer " + i;
        effects = layer.property("ADBE Effect Parade");
        for (j = 1; j <= effectsPerLayer; j++) {
            try {
                effect = effects.addProperty("ADBE Slider Control");
                effect.name = "Perf Slider " + j;
                effect.property(1).setValue(j);
            } catch (eEffect) {}
        }
        position = layer.property("ADBE Transform Group").property("ADBE Position");
        position.setValueAtTime(0, [i, i]);
        position.setValueAtTime(10, [i + 100, i + 100]);
    }

    function childCount(node) {
        try { return node.numProperties; } catch (e) { return 0; }
    }
    function walk(node, depth, level) {
        var count = childCount(node);
        var total = 0;
        if (level > depth) return 0;
        for (var k = 1; k <= count; k++) {
            total++;
            total += walk(node.property(k), depth, level + 1);
        }
        return total;
    }
    function measure(fn) {
        var start = $.hiresTimer;
        var count = fn();
        return {milliseconds: ($.hiresTimer - start) / 1000, count: count};
    }
    var layers = measure(function() { var count = 0; for (var n = 1; n <= comp.numLayers; n++) count++; return count; });
    var propertiesDepth2 = measure(function() { var count = 0; for (var n = 1; n <= comp.numLayers; n++) count += walk(comp.layer(n), 2, 1); return count; });
    var propertiesDepth4 = measure(function() { var count = 0; for (var n = 1; n <= comp.numLayers; n++) count += walk(comp.layer(n), 4, 1); return count; });
    var propertiesDepth8 = measure(function() { var count = 0; for (var n = 1; n <= comp.numLayers; n++) count += walk(comp.layer(n), 8, 1); return count; });
    var keyframes = measure(function() {
        var count = 0;
        for (var n = 1; n <= comp.numLayers; n++) {
            var prop = comp.layer(n).property("ADBE Transform Group").property("ADBE Position");
            for (var key = 1; key <= prop.numKeys; key++) { prop.keyTime(key); prop.keyValue(key); count++; }
        }
        return count;
    });
    return JSON.stringify({
        ok: true,
        fixture: {layers: layerCount, effectsPerLayer: effectsPerLayer, estimatedProperties: layerCount * effectsPerLayer + layerCount * 10},
        timings: {layers: layers, propertiesDepth2: propertiesDepth2, propertiesDepth4: propertiesDepth4, propertiesDepth8: propertiesDepth8, keyframes: keyframes}
    });
})()
