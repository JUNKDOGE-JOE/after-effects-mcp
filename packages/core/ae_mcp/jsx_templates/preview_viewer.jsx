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
    // pending paint events for the active viewer. The Python caller still
    // sleeps a few hundred ms before capture to be safe.
    try { app.scheduleTask("", 0, false); } catch (e) { /* AE < 17 lacks this */ }

    return JSON.stringify({
      ok: true,
      compId: String(comp.id),
      compName: comp.name,
      time: comp.time,
      width: comp.width,
      height: comp.height
    });
  } catch (e) {
    return fail(e && e.message ? e.message : e);
  }
}());
