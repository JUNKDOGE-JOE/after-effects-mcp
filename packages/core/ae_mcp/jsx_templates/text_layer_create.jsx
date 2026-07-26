var comp = resolveComp(Number(request.composition_id));
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
var target = {
    composition_id: String(request.composition_id),
    layer_index: layer.index,
    expected_name: request.name
};
var after = snapshot(target, layer);
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
