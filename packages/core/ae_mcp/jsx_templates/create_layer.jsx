// Template for ae.createLayer. Substitution: Python string.Template.
// Placeholders (dollar-brace) are replaced before the JSX runs:
//   comp_expr, type_str, name, color, size_w, size_h, duration, position.
// Returns JSON: ok, layerId, name, index (or ok:false + error).
(function() {
    var comp = ${comp_expr};
    if (!comp) return JSON.stringify({ok: false, error: "no comp"});

    var kind = ${type_str};
    var name = ${name};
    var color = ${color};
    var sizeW = ${size_w};
    var sizeH = ${size_h};
    var duration = ${duration};
    var position = ${position};

    if (sizeW < 0) sizeW = comp.width;
    if (sizeH < 0) sizeH = comp.height;
    if (duration < 0) duration = comp.duration;

    var layer = null;
    try {
        switch (kind) {
            case "solid":
                layer = comp.layers.addSolid(
                    color || [1, 1, 1], name, sizeW, sizeH,
                    comp.pixelAspect, duration
                );
                break;
            case "text":
                layer = comp.layers.addText(name);
                break;
            case "shape":
                layer = comp.layers.addShape();
                layer.name = name;
                break;
            case "null":
                layer = comp.layers.addNull(duration);
                layer.name = name;
                break;
            case "adjustment":
                layer = comp.layers.addSolid([1,1,1], name, sizeW, sizeH,
                                             comp.pixelAspect, duration);
                layer.adjustmentLayer = true;
                break;
            case "camera":
                layer = comp.layers.addCamera(name, [comp.width/2, comp.height/2]);
                break;
            case "light":
                layer = comp.layers.addLight(name, [comp.width/2, comp.height/2]);
                break;
            default:
                return JSON.stringify({ok: false, error: "unknown layer type"});
        }
    } catch (e) {
        return JSON.stringify({ok: false, error: String(e)});
    }

    if (position) {
        try {
            // Address Transform/Position by matchName so it resolves on
            // non-English AE (display-name "Transform"/"Position" is null on
            // JP/DE/etc., which would silently drop the position).
            var posProp = AEMCP.propByMatchPath(
                layer, "ADBE Transform Group#1/ADBE Position#1"
            );
            if (posProp) posProp.setValue(position);
        } catch (e) { /* shape layers may lack Transform.Position; ignore */ }
    }

    return JSON.stringify({
        ok: true,
        layerId: layer.index,
        name: layer.name,
        index: layer.index
    });
})()
