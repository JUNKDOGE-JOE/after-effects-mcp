// ae.revert step 2 — open a project file by absolute path and confirm it.
// Placeholders: aep_path (JSON-quoted absolute path).
// Used both to open the restored ORIGINAL project and, on a failed
// restore, to reopen the (intact) original for recovery.
// Never throws — returns {ok:false,error:...} on failure.
(function() {
    var aepPath = ${aep_path};
    var f = new File(aepPath);
    if (!f.exists) {
        return JSON.stringify({ok: false, error: "project file missing: " + aepPath});
    }
    try {
        if (!app.open(f)) return JSON.stringify({ok: false, error: "project open was cancelled"});
    } catch (e) {
        return JSON.stringify({ok: false, error: "open() failed: " + String(e)});
    }
    var openedPath = (app.project.file ? app.project.file.fsName : null);
    if (openedPath !== f.fsName) return JSON.stringify({ok: false, error: "opened project does not match restore target", openedPath: openedPath});
    return JSON.stringify({ok: true, openedPath: openedPath});
})()
