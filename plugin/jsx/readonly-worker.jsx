(function () {
    app.exitAfterLaunchAndEval = false;
    var config = $.global.__aemcpWorkerConfig;
    if (!config) throw new Error("Missing worker configuration");
    $.evalFile(new File(config.runtimePath));
    function message(error) {
        try {
            if (typeof error === "string") return error;
            if (error && typeof error.message === "string") return error.message;
        } catch (ignored) {}
        return "AE worker operation failed";
    }
    function file(name) { return new File(config.root + "/" + name); }
    function ownerClosed() { return config.ownerClosedPath && new File(config.ownerClosedPath).exists; }
    function read(name) {
        var input = file(name);
        if (!input.exists) return null;
        input.encoding = "UTF-8";
        if (!input.open("r")) throw new Error("Cannot read worker request");
        var text;
        try { text = input.read(); } finally { input.close(); }
        return JSON.parse(text);
    }
    function write(name, value) {
        var output = file(name + ".tmp");
        output.encoding = "UTF-8";
        if (!output.open("w")) throw new Error("Cannot write worker result");
        try { output.write(JSON.stringify(value)); } finally { output.close(); }
        if (!output.rename(name)) throw new Error("Cannot publish worker result");
    }
    var target = new File(config.snapshotPath);
    if (target.fsName !== file("snapshot.aep").fsName) {
        write("ready.json", {ok:false, error:"Worker snapshot is outside its dedicated path", code:"WORKER_SNAPSHOT_INVALID"});
        return;
    }
    var taskId = null;
    var lastActivityAt = new Date().getTime();
    var nextOwnerProbeAt = lastActivityAt + 5000;
    // CEP may exit without an unload event; a failed probe must not close the worker.
    function ownerState() {
        var pid = config.ownerProcessId;
        var now = new Date().getTime();
        if (typeof pid !== "number" || pid <= 1 || pid !== Math.floor(pid) || pid > 2147483647
            || now < nextOwnerProbeAt) return "UNKNOWN";
        nextOwnerProbeAt = now + 5000;
        try {
            var powershell = ($.getenv("SystemRoot") || "C:\\Windows") + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
            var command = '"' + powershell + '" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command "'
                + "try{$aeWorkerOwner=[System.Diagnostics.Process]::GetProcessById(" + pid
                + ");$aeWorkerOwner.Dispose();[Console]::Write('ALIVE')}catch [System.ArgumentException]{[Console]::Write('GONE')}catch{[Console]::Write('UNKNOWN')}\"";
            var state = String(system.callSystem(command)).replace(/^\s+|\s+$/g, "");
            return state === "ALIVE" || state === "GONE" ? state : "UNKNOWN";
        } catch (ignored) { return "UNKNOWN"; }
    }
    function stop(reason, allowEmpty) {
        if (taskId !== null) app.cancelTask(taskId);
        var project = app.project;
        var ownsSnapshot = project && project.file && project.file.fsName === target.fsName;
        var empty = allowEmpty && (!project || (!project.file && project.numItems === 0 && !project.dirty));
        if (!ownsSnapshot && !empty) {
            write("closed.json", {ok:false, error:"Worker project changed; leaving it open"});
            return;
        }
        if (ownsSnapshot) project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
        if (app.project && app.project.file && app.project.file.fsName === target.fsName) {
            write("closed.json", {ok:false, error:"Worker snapshot is still open"});
            return;
        }
        // The CEP owner may already be gone, so cleanup cannot depend on its Node callbacks.
        var snapshotRemoved = !target.exists || target.remove();
        write("closed.json", {ok:true, reason:reason, snapshotRemoved:snapshotRemoved});
        app.quit();
    }
    if (app.project && ((app.project.file && app.project.file.fsName !== target.fsName)
        || (!app.project.file && (app.project.numItems > 0 || app.project.dirty)))) {
        write("ready.json", {ok:false, error:"Worker started with another project", code:"WORKER_PROJECT_CHANGED"});
        return;
    }
    if (ownerClosed()) {
        write("ready.json", {ok:false, error:"Owner panel closed", code:"OWNER_CLOSED"});
        stop("owner-closed", true);
        return;
    }
    try {
        app.open(target);
        if (!app.project.file || app.project.file.fsName !== target.fsName) {
            write("ready.json", {ok:false, error:"Snapshot open did not select the expected project", code:"WORKER_PROJECT_CHANGED"});
            return;
        }
        write("ready.json", {ok:true, projectPath:app.project.file.fsName});
    } catch (error) {
        write("ready.json", {ok:false, error:message(error)});
        return;
    }
    $.global.__aemcpReadonlyWorkerTick = function () {
        if (ownerClosed() || file("stop.json").exists) {
            stop(ownerClosed() ? "owner-closed" : "requested", false);
            return;
        }
        if (ownerState() === "GONE") { stop("owner-exited", false); return; }
        var request = read("request.json");
        if (!request) {
            if (new Date().getTime() - lastActivityAt >= 120000) stop("idle-timeout", false);
            return;
        }
        file("request.json").remove();
        var result;
        try {
            if (!/^[a-f0-9]{24}$/.test(request.id) || typeof request.code !== "string") throw new Error("Invalid internal worker request");
            if (!app.project.file || app.project.file.fsName !== target.fsName) throw new Error("Worker snapshot changed");
            result = {ok:true, result:String(eval(request.code))};
        } catch (error) {
            result = {ok:false, error:message(error), disposition:"failed"};
        }
        write(request.id + ".json", result);
        lastActivityAt = new Date().getTime();
    };
    taskId = app.scheduleTask("$.global.__aemcpReadonlyWorkerTick()", 100, true);
    $.global.__aemcpReadonlyWorkerTask = taskId;
}());
