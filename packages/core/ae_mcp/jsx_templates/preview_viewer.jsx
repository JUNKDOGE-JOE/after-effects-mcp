(function () {
  function fail(message) {
    return JSON.stringify({ ok: false, error: String(message) });
  }

  try {
    var comp = $comp_expr;
    if (!comp || !(comp instanceof CompItem)) {
      return fail("No active comp, or comp_id did not resolve to a CompItem.");
    }

    var requestedTime = $time;
    if (requestedTime !== null) {
      comp.time = Number(requestedTime);
    }
    comp.openInViewer();

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
