// ae.revert — close current project (no save), open <checkpoint>.aep.
// Placeholders: aep_path (JSON-quoted absolute path).
(function() {
    var aepPath = ${aep_path};
    var f = new File(aepPath);
    if (!f.exists) {
        return JSON.stringify({ok: false, error: "checkpoint .aep missing: " + aepPath});
    }
    try {
        app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
    } catch (e) {
        return JSON.stringify({ok: false, error: "close() failed: " + String(e)});
    }
    try {
        app.open(f);
    } catch (e) {
        return JSON.stringify({ok: false, error: "open() failed: " + String(e)});
    }
    var openedPath = (app.project.file ? app.project.file.fsName : null);
    return JSON.stringify({ok: true, reverted: true, openedPath: openedPath});
})()
