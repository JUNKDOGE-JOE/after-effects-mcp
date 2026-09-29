(function () {
  var ticket = $bootstrap_json;
  var attempts = 0;
  var plug;

  function errorMessage(error) {
    try { if (error && typeof error.message === "string") return error.message; } catch (ignoreMessage) {}
    try { return String(error); } catch (ignoreString) { return "CEP bootstrap failed"; }
  }

  function status(state, detail) {
    var file = new File(ticket.bootstrapStatusPath);
    function quote(value) {
      return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n") + '"';
    }
    file.encoding = "UTF-8";
    if (file.open("w")) {
      file.write('{"instanceId":' + quote(ticket.instanceId) + ',"state":' + quote(state) + ',"detail":' + quote(detail || "") + '}');
      file.close();
    }
  }

  try {
    app.exitAfterLaunchAndEval = false;
    var project = new File(ticket.projectPath);
    if (!project.exists) throw new Error("The requested project file does not exist");
    if (!app.open(project)) throw new Error("Opening the requested project was cancelled");
    $.global.__aemcpOpenRequestedPanel = function () {
      try {
        var stateFile = new File(ticket.bootstrapStatusPath);
        if (stateFile.open("r")) {
          var previous = stateFile.read();
          stateFile.close();
          if (previous.indexOf('"state":"host-started"') >= 0 || previous.indexOf('"state":"panel-loading"') >= 0
              || previous.indexOf('"state":"intentional-disconnect"') >= 0) {
            delete $.global.__aemcpOpenRequestedPanel;
            return;
          }
        }
        if (attempts >= 30) {
          status("panel-unavailable", "The CEP startup event was not acknowledged");
          delete $.global.__aemcpOpenRequestedPanel;
          return;
        }
        if (!plug) plug = new ExternalObject("lib:PlugPlugExternalObject");
        var event = new CSXSEvent();
        event.type = "com.aemcp.panel.launch";
        event.data = ticket.instanceId;
        // A menu command can close an already restored panel. StartOn requests loading without that toggle.
        status("panel-requested", "Readiness requires host registration and a public MCP read");
        event.dispatch();
        attempts += 1;
        app.scheduleTask("$.global.__aemcpOpenRequestedPanel()", 500, false);
      } catch (error) {
        status("panel-failed", errorMessage(error));
        delete $.global.__aemcpOpenRequestedPanel;
      }
    };
    app.scheduleTask("$.global.__aemcpOpenRequestedPanel()", 500, false);
  } catch (error) {
    status("project-failed", errorMessage(error));
  }
}());
