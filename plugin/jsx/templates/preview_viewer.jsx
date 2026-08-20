(function () {
  function fail(message) {
    return JSON.stringify({ ok: false, error: String(message) });
  }

  try {
    var comp = $comp_expr;
    if (!comp || !(comp instanceof CompItem)) {
      return fail("No active comp, or comp_id did not resolve to a CompItem.");
    }

    // Ensure target comp is the active viewer BEFORE we change its time —
    // a viewer that's already showing this comp will repaint the new time;
    // one that just got switched needs an extra paint cycle anyway.
    comp.openInViewer();

    var requestedTime = $time;
    if (requestedTime !== null) {
      comp.time = Number(requestedTime);
    }

    // Nudge AE's idle queue. scheduleTask returns immediately; it asks AE to
    // run a no-op as soon as it can, which has the side-effect of flushing
    // pending paint events for the active viewer. The MCP caller still
    // sleeps a few hundred ms before capture to be safe.
    try { app.scheduleTask("", 0, false); } catch (e) { /* AE < 17 lacks this */ }

    var outFile = new File($path);
    var fallbackReason = "";
    if (typeof comp.saveFrameToPng === "function") {
      try {
        comp.saveFrameToPng(comp.time, outFile);
        // No width/height here on purpose. saveFrameToPng honours the viewer's
        // Resolution setting, so the composition's own size describes a
        // different image than the one just written -- at Half it is exactly
        // twice as large. The caller reads the real size back off the file and
        // uses these two only to report that a preview was downsampled.
        return JSON.stringify({
          ok: true,
          compId: String(comp.id),
          compName: comp.name,
          time: comp.time,
          compWidth: comp.width,
          compHeight: comp.height,
          resolutionFactor: comp.resolutionFactor,
          path: outFile.fsName,
          source: "comp",
          method: "saveFrameToPng",
          existsImmediately: outFile.exists
        });
      } catch (renderErr) {
        fallbackReason = renderErr && renderErr.message ? renderErr.message : String(renderErr);
      }
    } else {
      fallbackReason = "saveFrameToPng unavailable.";
    }

    return JSON.stringify({
      ok: true,
      compId: String(comp.id),
      compName: comp.name,
      time: comp.time,
      compWidth: comp.width,
      compHeight: comp.height,
      resolutionFactor: comp.resolutionFactor,
      source: "viewer",
      method: "ViewerCapture",
      fallbackReason: fallbackReason
    });
  } catch (e) {
    return fail(e && e.message ? e.message : e);
  }
}());
