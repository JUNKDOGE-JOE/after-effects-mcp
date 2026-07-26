var resolved = resolveTextLayer(request.target);
return JSON.stringify({
    ok: true,
    value: snapshot(request.target, resolved.layer)
});
