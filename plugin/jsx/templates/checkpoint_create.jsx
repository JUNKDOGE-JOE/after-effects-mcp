// ae.checkpoint create — copy current saved .aep to checkpoint path.
// Placeholders: dst_path and expected_path (JSON-quoted absolute paths).
//
// Save current edits to the existing fsName, then copy the checkpoint. Calling
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
    var expectedPath = new File($expected_path).fsName;
    if (app.project.file.fsName !== expectedPath) {
        return JSON.stringify({ok:false,error:"source-project-changed"});
    }
    try {
        app.project.save();
    } catch (e) {
        return JSON.stringify({ok:false, error:"save() failed: " + String(e), code:"CHECKPOINT_SAVE_FAILED", stage:"save", disposition:"uncertain"});
    }
    var src = app.project.file;
    var dstPath = ${dst_path};
    var dst = new File(dstPath);
    var ok = false;
    try { ok = src.copy(dst.fsName); } catch (copyError) {
        return JSON.stringify({ok:false, error:String(copyError), code:"CHECKPOINT_COPY_FAILED", stage:"copy", disposition:"not_dispatched", saveCompleted:true});
    }
    if (!ok) {
        return JSON.stringify({ok:false, error:"File.copy() returned false", code:"CHECKPOINT_COPY_FAILED", stage:"copy", disposition:"not_dispatched", saveCompleted:true});
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
