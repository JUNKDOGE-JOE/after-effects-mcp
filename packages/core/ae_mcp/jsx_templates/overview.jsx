// ae.overview — high-level project summary
(function() {
    var comps = [];
    var n = app.project.numItems;
    for (var i = 1; i <= n; i++) {
        var it = app.project.item(i);
        if (it instanceof CompItem) {
            comps.push({
                id: String(it.id), name: it.name,
                width: it.width, height: it.height,
                duration: it.duration, frameRate: it.frameRate,
                numLayers: it.numLayers
            });
        }
    }
    return JSON.stringify({
        ok: true,
        projectFile: app.project.file ? app.project.file.fsName : null,
        numItems: n,
        comps: comps,
        activeItemId: (app.project.activeItem && app.project.activeItem instanceof CompItem)
            ? String(app.project.activeItem.id) : null
    });
})()
