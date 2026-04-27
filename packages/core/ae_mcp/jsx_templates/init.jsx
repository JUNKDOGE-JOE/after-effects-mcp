// ae.init — refresh project snapshot
// Placeholders: refresh_only ("true" | "false")
(function() {
    var refreshOnly = ${refresh_only};
    var summary = {
        ok: true,
        projectFile: app.project.file ? app.project.file.fsName : null,
        numItems: app.project.numItems,
        activeItemId: (app.project.activeItem && app.project.activeItem instanceof CompItem)
            ? String(app.project.activeItem.id) : null,
        appVersion: String(app.version),
        refreshOnly: refreshOnly
    };
    return JSON.stringify(summary);
})()
