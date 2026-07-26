var comp = resolveComp(request._resolved);
var countBefore = comp.numLayers;
beginWrite();
var layer = request.text_kind === "box" ?
    comp.layers.addBoxText([
        Number(request.box_size.width_pixels),
        Number(request.box_size.height_pixels)
    ]) : comp.layers.addText("");
markMutation();
layer.name = request.name;
var sourceText = layer.property("ADBE Text Properties")
    .property("ADBE Text Document");
var doc = sourceText.value;
doc.text = request.text;
sourceText.setValue(doc);
var address = {
    project_item_index: Number(request._resolved.project_item_index),
    expected_name: String(request._resolved.expected_name),
    layer_index: layer.index,
    expected_layer_name: request.name
};
var after = snapshot(address, layer);
app.endUndoGroup();
undoOpen = false;
return JSON.stringify({
    ok: true,
    value: {
        changed: true,
        layerCountBefore: countBefore,
        layerCountAfter: comp.numLayers,
        before: null,
        after: after
    }
});
