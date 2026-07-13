(function () {
    var comp = AEMCP.mustFind(${comp_expr}, "composition");
    var layer = AEMCP.mustFind(AEMCP.layerById(comp, ${layer_id}), "layer");
    var path = ${path};
    var prop = AEMCP.mustFind(AEMCP.propByPath(layer, path), "property");
    prop.expression = ${expression};
    return JSON.stringify({
        ok: true,
        compId: String(comp.id),
        layerId: layer.index,
        path: path
    });
}())
