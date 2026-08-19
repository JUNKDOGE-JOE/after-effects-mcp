// ae.revert step 1 — close the current project WITHOUT saving.
// Releases any OS file handle on the project so Python can atomically
// replace the original .aep on disk before reopening it.
// No placeholders. Never throws — returns {ok:false,error:...} on failure.
(function() {
    try {
        app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
    } catch (e) {
        return JSON.stringify({ok: false, error: "close() failed: " + String(e)});
    }
    return JSON.stringify({ok: true, closed: true});
})()
