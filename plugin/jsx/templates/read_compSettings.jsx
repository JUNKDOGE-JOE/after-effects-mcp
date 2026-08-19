(function() {
    var o = $options;
    var project = app.project;
    function resolveComp(selector) {
        var item = null;
        if (!selector) return AEMCP.activeComp();
        if (selector.id) { try { item = project.itemByID(parseInt(selector.id, 10)); } catch (eId) { item = null; } }
        else if (selector.index) { try { item = project.item(selector.index); } catch (eIndex) { item = null; } }
        else if (selector.name) {
            for (var i = 1; i <= project.numItems; i++) {
                var candidate = project.item(i);
                if (candidate instanceof CompItem && String(candidate.name) === selector.name) { item = candidate; break; }
            }
        }
        return item && item instanceof CompItem ? item : null;
    }
    var comp = resolveComp(o.comp);
    if (!comp) return JSON.stringify({ok: false, error: "Composition not found for " + (o.comp ? JSON.stringify(o.comp) : "active composition")});
    var background = {red: 0, green: 0, blue: 0, alpha: 255};
    try {
        background = {
            red: Math.round(comp.bgColor[0] * 255),
            green: Math.round(comp.bgColor[1] * 255),
            blue: Math.round(comp.bgColor[2] * 255),
            alpha: 255
        };
    } catch (eBg) {}
    return JSON.stringify({
        ok: true,
        compositionLocator: {locatorKind: "jsx", itemId: String(comp.id)},
        name: String(comp.name),
        width: comp.width,
        height: comp.height,
        duration: comp.duration,
        frameDuration: comp.frameDuration,
        frameRate: comp.frameRate,
        pixelAspectRatio: comp.pixelAspect,
        backgroundColor: background,
        workArea: {start: comp.workAreaStart, duration: comp.workAreaDuration},
        displayStartTime: comp.displayStartTime,
        layerCount: comp.numLayers
    });
})()
