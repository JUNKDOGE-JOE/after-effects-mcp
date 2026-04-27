// ae.checkpoint create — copy current saved .aep to checkpoint path.
// Placeholders: dst_path (JSON-quoted absolute path).
//
// Strategy: app.project.save() to the project's existing fsName (no
// side-effects), then File.copy() to the checkpoint location. Calling
// app.project.save(File(...)) would change the project's fsName — DON'T.
//
// Untitled projects (app.project.file === null) are SKIPPED silently:
//   {ok:true, skipped:true, reason:"untitled-project", id:null}
(function() {
    if (app.project.file === null) {
        return JSON.stringify({
            ok: true, skipped: true, reason: "untitled-project", id: null
        });
    }
    try {
        app.project.save();
    } catch (e) {
        return JSON.stringify({ok: false, error: "save() failed: " + String(e)});
    }
    var src = app.project.file;
    var dstPath = ${dst_path};
    var dst = new File(dstPath);
    var ok = src.copy(dst.fsName);
    if (!ok) {
        return JSON.stringify({ok: false, error: "File.copy() returned false"});
    }
    var size = -1;
    try { size = dst.length; } catch (e) { }

    var activeCompId = null;
    var currentTime = 0;
    var ai = app.project.activeItem;
    if (ai && ai instanceof CompItem) {
        activeCompId = String(ai.id);
        currentTime = ai.time;
    }

    return JSON.stringify({
        ok: true,
        sourceProjectPath: src.fsName,
        savedTo: dst.fsName,
        sizeBytes: size,
        activeCompId: activeCompId,
        currentTime: currentTime
    });
})()
