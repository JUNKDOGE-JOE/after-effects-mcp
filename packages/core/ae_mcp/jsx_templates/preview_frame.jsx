(function () {
  function fail(message) {
    return JSON.stringify({ ok: false, error: String(message) });
  }

  function ensureParent(file) {
    var parent = file.parent;
    if (parent && !parent.exists) {
      parent.create();
    }
  }

  function renderWithSaveFrameToPng(comp, timeValue, file) {
    if (typeof comp.saveFrameToPng !== "function") {
      return false;
    }
    comp.saveFrameToPng(timeValue, file);
    return file.exists && file.length > 0;
  }

  try {
    var comp = $comp_expr;
    if (!comp || !(comp instanceof CompItem)) {
      return fail("No active comp, or comp_id did not resolve to a CompItem.");
    }

    var requests = $frame_requests;
    var scale = $scale;
    var frames = [];

    for (var i = 0; i < requests.length; i += 1) {
      var request = requests[i];
      var frameTime = request.time === null ? comp.time : Number(request.time);
      var file = new File(request.path);
      ensureParent(file);
      if (file.exists) {
        file.remove();
      }

      if (typeof comp.saveFrameToPng !== "function") {
        return fail("CompItem.saveFrameToPng is unavailable in this After Effects version.");
      }
      var rendered = renderWithSaveFrameToPng(comp, frameTime, file);
      var method = "saveFrameToPng";
      if (!rendered) {
        return fail("Failed to render preview frame at " + frameTime + "s.");
      }

      frames.push({
        time: frameTime,
        path: file.fsName,
        width: comp.width,
        height: comp.height,
        sizeBytes: file.length,
        method: method,
        scale: scale
      });
    }

    return JSON.stringify({
      ok: true,
      compId: String(comp.id),
      compName: comp.name,
      frames: frames
    });
  } catch (e) {
    return fail(e && e.message ? e.message : e);
  }
}());
