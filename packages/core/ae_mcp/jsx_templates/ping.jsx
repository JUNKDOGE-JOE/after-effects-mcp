// ae.ping — return immediately so live tests can verify the bridge is up.
// Placeholders: expect.
(function() {
    var t0 = Date.now ? Date.now() : 0;
    var ver = "unknown";
    try { ver = String(app.version); } catch (e) { }
    return JSON.stringify({
        ok: true,
        pong: ${expect},
        aeVersion: ver,
        latencyMs: (Date.now ? (Date.now() - t0) : 0)
    });
})()
