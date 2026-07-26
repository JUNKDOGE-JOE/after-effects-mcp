var resolved = resolveTextLayer(request._resolved);
return JSON.stringify({
    ok: true,
    value: snapshot(request._resolved, resolved.layer)
});
