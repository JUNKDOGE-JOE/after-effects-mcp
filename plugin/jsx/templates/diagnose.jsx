// ae.diagnose step — proves ExtendScript is responsive and reports the open
// project file (null when no project / unsaved project). No placeholders.
(function() {
    var projectFile = null;
    try {
        if (app.project) {
            projectFile = (app.project.file ? app.project.file.name : "unsaved");
        }
    } catch (e) { }
    return JSON.stringify({
        ok: true,
        pong: "pong",
        aeVersion: (function() { try { return String(app.version); } catch (e) { return "unknown"; } })(),
        projectFile: projectFile
    });
})()
